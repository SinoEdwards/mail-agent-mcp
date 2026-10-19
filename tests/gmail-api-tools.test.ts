import { describe, expect, it, vi } from 'vitest';
import { gmailApiTools } from '../src/tools/gmail-api-tools.js';

function setup(provider: 'gmail' | 'qq' = 'gmail') {
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
  };
  gmailApiTools(server as any, accounts as any, gmailApi as any);
  return { handlers, gmailApi, account };
}

describe('Gmail API MCP tools', () => {
  it('registers only the three explicit Gmail API read tools', () => {
    const { handlers } = setup();
    expect([...handlers.keys()]).toEqual([
      'gmail_api_list_labels',
      'gmail_api_search_messages',
      'gmail_api_get_message',
    ]);
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
