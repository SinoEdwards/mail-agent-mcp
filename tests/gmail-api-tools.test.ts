import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gmailApiTools } from '../src/tools/gmail-api-tools.js';

function setup(provider: 'gmail' | 'qq' = 'gmail', downloadDir?: string) {
  const handlers = new Map<string, (input: any) => Promise<any>>();
  const server = {
    registerTool: vi.fn((name: string, _schema: unknown, handler: (input: any) => Promise<any>) => {
      handlers.set(name, handler);
    }),
  };
  const account = provider === 'gmail'
    ? { id: 'account-1', auth: { kind: 'oauth2', provider: 'gmail' } }
    : { id: 'account-1', auth: { kind: 'credential', provider: 'qq' } };
  const accounts = {
    resolveAccountId: vi.fn().mockReturnValue('account-1'),
    getAccount: vi.fn().mockReturnValue(account),
  };
  const gmailApi = {
    listLabels: vi.fn().mockResolvedValue([{ id: 'INBOX', name: 'Inbox' }]),
    searchMessages: vi.fn().mockResolvedValue({ messages: [{ id: 'abc123', threadId: 'thread123' }] }),
    getMessage: vi.fn().mockResolvedValue({ id: 'abc123', threadId: 'thread123', labelIds: [] }),
    listAttachments: vi.fn().mockResolvedValue([{ partId: '2', filename: 'safe.txt', mimeType: 'text/plain', size: 4 }]),
    getAttachment: vi.fn().mockResolvedValue({ partId: '2', filename: 'safe.txt', mimeType: 'text/plain', size: 4, content: Buffer.from('safe') }),
  };
  gmailApiTools(server as any, accounts as any, gmailApi as any, { downloadDir });
  return { handlers, gmailApi, account };
}

describe('Gmail API MCP tools', () => {
  it('registers only the explicit Gmail API read and bounded download tools', () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([
      'gmail_api_list_labels',
      'gmail_api_search_messages',
      'gmail_api_get_message',
      'gmail_api_list_attachments',
      'gmail_api_download_attachment',
    ]);
  });

  it('lists metadata and saves a bounded attachment only inside the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mailagent-gmail-tool-'));
    try {
      const { handlers, gmailApi, account } = setup('gmail', root);
      const listed = await handlers.get('gmail_api_list_attachments')!({ accountId: 'account-1', messageId: 'abc123' });
      expect(JSON.parse(listed.content[0].text).attachments).toHaveLength(1);
      expect(gmailApi.listAttachments).toHaveBeenCalledWith(account, 'abc123');
      const saved = await handlers.get('gmail_api_download_attachment')!({
        accountId: 'account-1', messageId: 'abc123', partId: '2',
      });
      expect(JSON.parse(saved.content[0].text)).toMatchObject({ saved: true, savedAs: 'safe.txt', size: 4 });
      expect(await readFile(join(root, 'safe.txt'), 'utf8')).toBe('safe');
      await expect(handlers.get('gmail_api_download_attachment')!({
        accountId: 'account-1', messageId: 'abc123', partId: '2',
      })).rejects.toThrow();
      await expect(handlers.get('gmail_api_download_attachment')!({
        accountId: 'account-1', messageId: 'abc123', partId: '2', savePath: '../outside.txt',
      })).rejects.toThrow('Attachment path must stay inside');
    } finally {
      if (!resolve(root).startsWith(resolve(tmpdir()) + '\\') && !resolve(root).startsWith(resolve(tmpdir()) + '/')) {
        throw new Error('Refusing to remove a directory outside the temporary root');
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes account and Gmail ID to the right service without an IMAP UID', async () => {
    const { handlers, gmailApi, account } = setup();
    const search = await handlers.get('gmail_api_search_messages')!({
      accountId: 'account-1', query: 'is:unread', maxResults: 5,
    });
    expect(gmailApi.searchMessages).toHaveBeenCalledWith(account, {
      query: 'is:unread', labelId: undefined, maxResults: 5, pageToken: undefined,
    });
    expect(JSON.parse(search.content[0].text).messages[0].id).toBe('abc123');
    await handlers.get('gmail_api_get_message')!({
      accountId: 'account-1', messageId: 'abc123', includeBody: false, maxBodyChars: 10000,
    });
    expect(gmailApi.getMessage).toHaveBeenCalledWith(account, 'abc123', {
      includeBody: false, maxBodyChars: 10000,
    });
  });

  it('rejects a QQ account before any Gmail API call', async () => {
    const { handlers, gmailApi } = setup('qq');
    await expect(handlers.get('gmail_api_list_labels')!({ accountId: 'account-1' }))
      .rejects.toThrow('Select an enrolled Gmail OAuth account');
    expect(gmailApi.listLabels).not.toHaveBeenCalled();
  });
});
