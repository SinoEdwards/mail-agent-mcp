import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { simpleParser } from 'mailparser';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../services/account-manager.js';
import type { ImapService } from '../services/imap-service.js';
import { SafeSendService, type SafeSendExecutionResult, type SafeSendServiceOptions } from '../services/safe-send-service.js';
import type { SmtpService } from '../services/smtp-service.js';
import type { GmailApiService } from '../services/gmail-api-service.js';
import type { Attachment, EmailAttachment, EmailComposer, EmailContent, ImapAccount } from '../types/index.js';
import { resolveAttachmentInputPath } from '../utils/attachment-root.js';

const DOWNLOAD_DIR = process.env.IMAP_DOWNLOAD_DIR || join(homedir(), 'Downloads', 'imap-attachments');
const addressList = z.union([z.string(), z.array(z.string())]);
const attachmentSchema = z.object({
  filename: z.string().describe('Attachment filename shown to the recipient'),
  content: z.string().optional().describe('Base64-encoded attachment content; provide exactly one of content or path'),
  path: z.string().optional().describe('Existing file inside the configured attachment root; materialized before preview'),
  contentType: z.string().optional().describe('Optional MIME content type'),
  contentDisposition: z.enum(['attachment', 'inline']).optional().describe('Attachment disposition; use inline with cid for embedded content'),
  cid: z.string().optional().describe('Optional Content-ID referenced by HTML cid links'),
});
type AttachmentInput = z.infer<typeof attachmentSchema>;

function list(value: string | string[] | undefined): string[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function mergeBcc(defaults: string | string[] | undefined, explicit: string | string[] | undefined): string[] | undefined {
  const merged = [...list(defaults), ...list(explicit)];
  return merged.length ? [...new Set(merged)] : undefined;
}

async function materializeAttachments(inputs?: AttachmentInput[]): Promise<EmailAttachment[] | undefined> {
  if (!inputs) return undefined;
  return Promise.all(inputs.map(async (input) => {
    if ((input.content === undefined) === (input.path === undefined)) throw new Error('Each attachment must provide exactly one of content or path');
    const content = input.path ? await readFile(resolveAttachmentInputPath(DOWNLOAD_DIR, input.path)) : Buffer.from(input.content!, 'base64');
    return { filename: input.filename, content, contentType: input.contentType, contentDisposition: input.contentDisposition, cid: input.cid };
  }));
}

async function materializeOriginalAttachments(
  imapService: ImapService,
  accountId: string,
  folder: string,
  uid: number,
  attachments: readonly Attachment[],
): Promise<EmailAttachment[]> {
  return Promise.all(attachments.map(async (attachment) => {
    const downloaded = await imapService.getAttachmentContent(
      accountId,
      folder,
      uid,
      attachment.contentId ?? attachment.filename,
    );
    return {
      filename: downloaded.filename,
      content: Buffer.from(downloaded.content),
      contentType: downloaded.contentType,
      contentDisposition: attachment.contentId ? 'inline' : 'attachment',
      cid: attachment.contentId,
    };
  }));
}

function extractEmail(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return (match ? match[1] : address).trim().toLowerCase();
}

function replyRecipients(originalEmail: Pick<EmailContent, 'from' | 'to'>, account: ImapAccount, replyAll: boolean): string[] {
  const recipients = [originalEmail.from];
  if (!replyAll) return recipients;
  const seen = new Set<string>([
    extractEmail(account.email || account.user),
    ...recipients.map(extractEmail),
  ]);
  for (const address of originalEmail.to) {
    const normalized = extractEmail(address);
    if (!seen.has(normalized)) {
      recipients.push(address);
      seen.add(normalized);
    }
  }
  return recipients;
}

async function parseHeaderAddresses(header: string | undefined): Promise<string[]> {
  if (!header) return [];
  const parsed = await simpleParser('To: ' + header.replace(/[\r\n]+/gu, ' ') + '\r\n\r\n', {
    skipHtmlToText: true,
  });
  const values = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : [];
  return values.flatMap(value => value.value.map(address => address.address).filter((address): address is string => !!address));
}

const DEFAULT_SENT_COPY_TIMEOUT_MS = 10_000;

interface SafeSendToolOptions extends Pick<SafeSendServiceOptions, 'clock' | 'id' | 'ttlMs'> {
  sentCopyTimeoutMs?: number;
  gmailApiService?: GmailApiService;
}

async function saveSentBestEffort(
  imapService: ImapService,
  accountId: string,
  account: ImapAccount,
  rawMessage: Buffer | string | undefined,
  timeoutMs: number,
): Promise<SafeSendExecutionResult> {
  // Gmail saves messages submitted through its SMTP server in Sent itself.
  // Avoid a second IMAP append by default, especially when its IMAP route is
  // unavailable. An explicit saveToSent=true keeps the opt-in override.
  if (!rawMessage || account.saveToSent === false
    || (account.auth?.provider === 'gmail' && account.saveToSent !== true)) return {};

  try {
    const result = await imapService.appendToSentFolder(
      accountId,
      rawMessage,
      account.sentFolder,
      timeoutMs,
    );
    if (result.saved) return {};
    const timedOut = result.errorCategory === 'timeout';
    return {
      warnings: [{
        code: timedOut ? 'sent_copy_timeout' : 'sent_copy_failed',
        message: timedOut
          ? 'Message sent, but saving a Sent-folder copy timed out'
          : 'Message sent, but saving a Sent-folder copy failed',
      }],
    };
  } catch {
    return {
      warnings: [{
        code: 'sent_copy_failed',
        message: 'Message sent, but saving a Sent-folder copy failed',
      }],
    };
  }
}
function previewResponse(preview: ReturnType<SafeSendService['preview']>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(preview, null, 2) }] };
}

export function safeSendTools(server: McpServer, imapService: ImapService, accountManager: AccountManager, smtpService: SmtpService, options: SafeSendToolOptions = {}): void {
  const sentCopyTimeoutMs = options.sentCopyTimeoutMs ?? DEFAULT_SENT_COPY_TIMEOUT_MS;
  if (!Number.isFinite(sentCopyTimeoutMs) || sentCopyTimeoutMs <= 0) {
    throw new Error('Sent-copy timeout must be a positive finite number');
  }
  const safeSend = new SafeSendService({ ...options, executor: async ({ accountId, composer }) => {
    const account = await accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const { rawMessage } = await smtpService.sendEmail(accountId, account, composer as EmailComposer);
    return { secondary: saveSentBestEffort(imapService, accountId, account, rawMessage, sentCopyTimeoutMs) };
  } });

  server.registerTool('imap_preview_send_email', {
    description: 'Preview and freeze a new email without sending it. Confirm the returned draftId with imap_confirm_send.',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID to send from; optional when accountName is supplied or only one account exists'),
      accountName: z.string().optional().describe('Account name alternative to accountId'),
      to: addressList.describe('Recipient address or addresses to freeze in the preview'),
      subject: z.string().describe('Email subject to freeze in the preview'),
      text: z.string().optional().describe('Optional plain-text body'),
      html: z.string().optional().describe('Optional HTML body'),
      body: z.string().optional().describe('Backward-compatible alias for text'),
      cc: addressList.optional().describe('Optional CC recipients'),
      bcc: addressList.optional().describe('Optional BCC recipients merged with account defaults'),
      replyTo: z.string().optional().describe('Optional Reply-To address'),
      attachments: z.array(attachmentSchema).optional().describe('Attachments to materialize and freeze before confirmation'),
    },
  }, async ({ accountId: rawAccountId, accountName, to, subject, text, html, body, cc, bcc, replyTo, attachments }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const composer: EmailComposer = { from: account.email || account.user, to, subject, text: text ?? body, html, cc, bcc: mergeBcc(account.defaultBcc, bcc), replyTo, attachments: await materializeAttachments(attachments) };
    return previewResponse(safeSend.preview({ accountId, composer }));
  });

  server.registerTool('imap_preview_reply_to_email', {
    description: 'Preview and freeze a threaded reply without sending it. Confirm the returned draftId with imap_confirm_send.',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID containing the original email'),
      accountName: z.string().optional().describe('Account name alternative to accountId'),
      folder: z.string().default('INBOX').describe('Folder containing the original email'),
      uid: z.coerce.number().describe('UID of the original email'),
      text: z.string().optional().describe('Optional plain-text reply body'),
      html: z.string().optional().describe('Optional HTML reply body'),
      body: z.string().optional().describe('Backward-compatible alias for text'),
      replyAll: z.boolean().default(false).describe('Include original recipients except the sending account'),
      bcc: addressList.optional().describe('Optional BCC recipients merged with account defaults'),
      attachments: z.array(attachmentSchema).optional().describe('New reply attachments to materialize and freeze'),
    },
  }, async ({ accountId: rawAccountId, accountName, folder, uid, text, html, body, replyAll, bcc, attachments }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const originalEmail = await imapService.getEmailContent(accountId, folder, uid, { bodyFormat: 'text' });
    const composer: EmailComposer = {
      from: account.email || account.user,
      to: replyRecipients(originalEmail, account, replyAll),
      subject: originalEmail.subject.startsWith('Re: ') ? originalEmail.subject : `Re: ${originalEmail.subject}`,
      text: text ?? body,
      html,
      bcc: mergeBcc(account.defaultBcc, bcc),
      inReplyTo: originalEmail.messageId,
      references: originalEmail.messageId,
      attachments: await materializeAttachments(attachments),
    };
    return previewResponse(safeSend.preview({ accountId, composer }));
  });

  server.registerTool('imap_preview_forward_email', {
    description: 'Preview and freeze a forward without sending it. Confirm the returned draftId with imap_confirm_send.',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID containing the original email'),
      accountName: z.string().optional().describe('Account name alternative to accountId'),
      folder: z.string().default('INBOX').describe('Folder containing the original email'),
      uid: z.coerce.number().describe('UID of the original email'),
      to: addressList.describe('Forward recipient address or addresses'),
      text: z.string().optional().describe('Optional text placed before the forwarded message'),
      body: z.string().optional().describe('Backward-compatible alias for text'),
      bcc: addressList.optional().describe('Optional BCC recipients merged with account defaults'),
      includeAttachments: z.boolean().default(true).describe('Materialize and freeze original attachments in the preview'),
    },
  }, async ({ accountId: rawAccountId, accountName, folder, uid, to, text, body, bcc, includeAttachments }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const originalEmail = await imapService.getEmailContent(accountId, folder, uid, { bodyFormat: 'html' });
    const forwardHeader = `\n\n---------- Forwarded message ----------\nFrom: ${originalEmail.from}\nDate: ${originalEmail.date.toLocaleString()}\nSubject: ${originalEmail.subject}\nTo: ${originalEmail.to.join(', ')}\n\n`;
    const composer: EmailComposer = {
      from: account.email || account.user,
      to,
      subject: originalEmail.subject.startsWith('Fwd: ') ? originalEmail.subject : `Fwd: ${originalEmail.subject}`,
      text: (text ?? body ?? '') + forwardHeader + (originalEmail.textContent || ''),
      html: originalEmail.htmlContent,
      bcc: mergeBcc(account.defaultBcc, bcc),
      references: originalEmail.messageId,
      attachments: includeAttachments
        ? await materializeOriginalAttachments(imapService, accountId, folder, uid, originalEmail.attachments)
        : undefined,
    };
    return previewResponse(safeSend.preview({ accountId, composer }));
  });

  if (options.gmailApiService) {
    const gmailApi = options.gmailApiService;
    async function selectedGmail(rawAccountId?: string, accountName?: string): Promise<{ accountId: string; account: ImapAccount }> {
      const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
      const account = await accountManager.getAccount(accountId);
      if (!account || account.auth?.kind !== 'oauth2' || account.auth.provider !== 'gmail') {
        throw new Error('Select an enrolled Gmail OAuth account');
      }
      return { accountId, account };
    }

    server.registerTool('gmail_api_preview_reply_to_message', {
      description: 'Preview and freeze a Gmail reply by Gmail API message ID without IMAP. This does not send; use imap_confirm_send with the returned draft ID after explicit approval.',
      inputSchema: {
        accountId: z.string().optional(),
        accountName: z.string().optional(),
        messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        text: z.string().optional(),
        html: z.string().optional(),
        replyAll: z.boolean().default(false),
        bcc: addressList.optional(),
        attachments: z.array(attachmentSchema).optional(),
      },
    }, async ({ accountId: rawAccountId, accountName, messageId, text, html, replyAll, bcc, attachments }) => {
      const { accountId, account } = await selectedGmail(rawAccountId, accountName);
      const original = await gmailApi.getMessage(account, messageId);
      if (!original.from || !original.messageIdHeader) throw new Error('Gmail message lacks reply headers');
      const replyTargets = await parseHeaderAddresses(original.replyTo || original.from);
      if (replyTargets.length === 0) throw new Error('Gmail message lacks a valid reply address');
      const recipients = replyRecipients({
        from: replyTargets[0],
        to: await parseHeaderAddresses(original.to),
      }, account, replyAll);
      const composer: EmailComposer = {
        from: account.email || account.user,
        to: recipients,
        subject: /^Re:/iu.test(original.subject || '') ? original.subject! : 'Re: ' + (original.subject || ''),
        text,
        html,
        bcc: mergeBcc(account.defaultBcc, bcc),
        inReplyTo: original.messageIdHeader,
        references: [original.references, original.messageIdHeader].filter(Boolean).join(' '),
        attachments: await materializeAttachments(attachments),
      };
      return previewResponse(safeSend.preview({ accountId, composer }));
    });

    server.registerTool('gmail_api_preview_forward_message', {
      description: 'Preview and freeze a Gmail forward by Gmail API message ID without IMAP. Bounded original content and attachments are materialized before preview; confirmation is a separate tool call.',
      inputSchema: {
        accountId: z.string().optional(),
        accountName: z.string().optional(),
        messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        to: addressList,
        text: z.string().optional(),
        bcc: addressList.optional(),
        includeAttachments: z.boolean().default(true),
      },
    }, async ({ accountId: rawAccountId, accountName, messageId, to, text, bcc, includeAttachments }) => {
      const { accountId, account } = await selectedGmail(rawAccountId, accountName);
      const original = await gmailApi.getMessage(account, messageId, { includeBody: true, maxBodyChars: 20_000 });
      if (original.bodyTruncated) throw new Error('Gmail message body exceeds safe forward limit');
      const metadata = includeAttachments ? await gmailApi.listAttachments(account, messageId) : [];
      if (metadata.length > 10 || metadata.reduce((size, item) => size + item.size, 0) > 20 * 1024 * 1024) {
        throw new Error('Gmail original attachments exceed safe forward limit');
      }
      const originalAttachments = await Promise.all(metadata.map(async item => {
        const attachment = await gmailApi.getAttachment(account, messageId, item.partId);
        return {
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.mimeType,
          contentDisposition: attachment.contentId ? 'inline' as const : 'attachment' as const,
          cid: attachment.contentId,
        };
      }));
      const forwardHeader = '\n\n---------- Forwarded message ----------\n'
        + `From: ${original.from || ''}\nDate: ${original.date || ''}\n`
        + `Subject: ${original.subject || ''}\nTo: ${original.to || ''}\n\n`;
      const composer: EmailComposer = {
        from: account.email || account.user,
        to,
        subject: /^Fwd:/iu.test(original.subject || '') ? original.subject! : 'Fwd: ' + (original.subject || ''),
        text: (text || '') + forwardHeader + (original.body || ''),
        bcc: mergeBcc(account.defaultBcc, bcc),
        references: original.messageIdHeader,
        attachments: originalAttachments,
      };
      return previewResponse(safeSend.preview({ accountId, composer }));
    });
  }

  server.registerTool('imap_confirm_send', {
    description: 'Send a previously frozen safe-send draft exactly once.',
    inputSchema: {
      draftId: z.string().describe('Opaque draft identifier returned by a safe-send preview tool'),
      confirmed: z.literal(true).describe('Explicit confirmation; only the literal value true is accepted'),
    },
  }, async ({ draftId, confirmed }) => {
    const result = await safeSend.confirm(draftId, confirmed);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });
}
