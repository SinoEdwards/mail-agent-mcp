import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../services/account-manager.js';
import type { ImapService } from '../services/imap-service.js';
import { SafeSendService, type SafeSendServiceOptions } from '../services/safe-send-service.js';
import type { SmtpService } from '../services/smtp-service.js';
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

function replyRecipients(originalEmail: EmailContent, account: ImapAccount, replyAll: boolean): string[] {
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

async function saveSentBestEffort(imapService: ImapService, accountId: string, account: ImapAccount, rawMessage: Buffer | string | undefined): Promise<void> {
  if (!rawMessage || account.saveToSent === false) return;
  try { await imapService.appendToSentFolder(accountId, rawMessage, account.sentFolder); } catch { /* SMTP is final; never resend due to Sent-copy failure. */ }
}

function previewResponse(preview: ReturnType<SafeSendService['preview']>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(preview, null, 2) }] };
}

export function safeSendTools(server: McpServer, imapService: ImapService, accountManager: AccountManager, smtpService: SmtpService, options: Pick<SafeSendServiceOptions, 'clock' | 'id' | 'ttlMs'> = {}): void {
  const safeSend = new SafeSendService({ ...options, executor: async ({ accountId, composer }) => {
    const account = await accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const { rawMessage } = await smtpService.sendEmail(accountId, account, composer as EmailComposer);
    await saveSentBestEffort(imapService, accountId, account, rawMessage);
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
