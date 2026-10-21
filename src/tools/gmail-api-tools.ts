import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { AccountManager } from '../services/account-manager.js';
import { GmailApiService } from '../services/gmail-api-service.js';
import type { ImapAccount } from '../types/index.js';
import { normalizeAttachmentRoot, resolveAttachmentOutputPath } from '../utils/attachment-root.js';

const DOWNLOAD_DIR = process.env.IMAP_DOWNLOAD_DIR || join(homedir(), 'Downloads', 'imap-attachments');

const accountSelector = {
  accountId: z.string().optional().describe('Gmail account ID from imap_list_accounts.'),
  accountName: z.string().optional().describe('Gmail account name; use when accountId is omitted.'),
};

function selectedGmailAccount(
  accounts: AccountManager,
  accountId?: string,
  accountName?: string,
): ImapAccount {
  let account: ImapAccount | undefined;
  try {
    account = accounts.getAccount(accounts.resolveAccountId(accountId, accountName));
  } catch {
    throw new Error('Gmail API account selection failed');
  }
  if (!account || account.auth?.kind !== 'oauth2' || account.auth.provider !== 'gmail') {
    throw new Error('Select an enrolled Gmail OAuth account');
  }
  return account;
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function gmailApiTools(
  server: McpServer,
  accounts: AccountManager,
  gmailApi: GmailApiService,
  options: { downloadDir?: string } = {},
): void {
  const downloadDir = options.downloadDir ?? DOWNLOAD_DIR;
  server.registerTool('gmail_api_list_labels', {
    description: 'Read Gmail labels through the Gmail HTTPS API. Uses Gmail label IDs, not IMAP folder names. Does not change mailbox state.',
    inputSchema: accountSelector,
  }, async ({ accountId, accountName }) => {
    const account = selectedGmailAccount(accounts, accountId, accountName);
    return result({ labels: await gmailApi.listLabels(account) });
  });

  server.registerTool('gmail_api_search_messages', {
    description: 'Search or list Gmail messages through the Gmail HTTPS API. Returns opaque Gmail string IDs and an optional page token; use these IDs with Gmail API tools, never IMAP UID tools. No message body is returned.',
    inputSchema: {
      ...accountSelector,
      query: z.string().max(512).optional().describe('Gmail search syntax, such as "is:unread"; omit to list recent messages.'),
      labelId: z.string().max(128).optional().describe('Optional Gmail label ID from gmail_api_list_labels.'),
      maxResults: z.number().int().min(1).max(100).default(20).describe('Maximum returned references, 1–100.'),
      pageToken: z.string().max(2048).optional().describe('Token from a prior result for the next page.'),
    },
  }, async ({ accountId, accountName, query, labelId, maxResults, pageToken }) => {
    const account = selectedGmailAccount(accounts, accountId, accountName);
    return result(await gmailApi.searchMessages(account, { query, labelId, maxResults, pageToken }));
  });

  server.registerTool('gmail_api_get_message', {
    description: 'Read one Gmail message by its opaque Gmail API string ID. Metadata is returned by default. Set includeBody=true to read a bounded text or Markdown body; raw HTML and attachments are not returned. This tool never accepts an IMAP UID or marks a message read.',
    inputSchema: {
      ...accountSelector,
      messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).describe('Gmail API message ID returned by gmail_api_search_messages.'),
      includeBody: z.boolean().default(false).describe('Read the message body; false returns metadata only.'),
      maxBodyChars: z.number().int().min(1).max(20000).default(10000).describe('Maximum body characters when includeBody=true.'),
    },
  }, async ({ accountId, accountName, messageId, includeBody, maxBodyChars }) => {
    const account = selectedGmailAccount(accounts, accountId, accountName);
    return result(await gmailApi.getMessage(account, messageId, { includeBody, maxBodyChars }));
  });

  server.registerTool('gmail_api_list_attachments', {
    description: 'List Gmail attachment metadata by Gmail API message ID. Returns part IDs and filenames without attachment bytes or IMAP UIDs.',
    inputSchema: {
      ...accountSelector,
      messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    },
  }, async ({ accountId, accountName, messageId }) => {
    const account = selectedGmailAccount(accounts, accountId, accountName);
    return result({ attachments: await gmailApi.listAttachments(account, messageId) });
  });

  server.registerTool('gmail_api_download_attachment', {
    description: 'Download one bounded Gmail attachment into the configured attachment root. Use a part ID from gmail_api_list_attachments. Existing files are never overwritten.',
    inputSchema: {
      ...accountSelector,
      messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      partId: z.string().min(1).max(128),
      savePath: z.string().max(1024).optional().describe('Optional path inside IMAP_DOWNLOAD_DIR; outside paths are rejected.'),
    },
  }, async ({ accountId, accountName, messageId, partId, savePath }) => {
    const account = selectedGmailAccount(accounts, accountId, accountName);
    const attachment = await gmailApi.getAttachment(account, messageId, partId);
    const target = resolveAttachmentOutputPath(downloadDir, savePath, attachment.filename);
    await writeFile(target, attachment.content, { flag: 'wx' });
    return result({
      saved: true,
      savedAs: relative(normalizeAttachmentRoot(downloadDir), target),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.content.length,
    });
  });
}
