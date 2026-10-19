import { describe, expect, it, vi } from 'vitest';
import type { ImapAccount } from '../src/types/index.js';
import { GmailApiService } from '../src/services/gmail-api-service.js';

const gmail = {
  id: 'gmail-test',
  name: 'Gmail test',
  user: 'owner@example.test',
  auth: { kind: 'oauth2', provider: 'gmail', credentialTarget: 'synthetic-target' },
} as ImapAccount;
const SYNTHETIC_ACCESS_TOKEN = ['synthetic', 'token'].join('-');

function setup(reply: (url: URL) => Response) {
  const authResolver = { resolve: vi.fn().mockResolvedValue({ kind: 'oauth2', accessToken: SYNTHETIC_ACCESS_TOKEN }) };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.headers).toEqual({ authorization: 'Bearer ' + SYNTHETIC_ACCESS_TOKEN });
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    return reply(new URL(input.toString()));
  });
  const close = vi.fn().mockResolvedValue(undefined);
  const service = new GmailApiService(authResolver as any, {
    transport: () => ({ fetch: fetchMock as typeof fetch, close, usingProxy: false }),
  });
  return { service, fetchMock, close, authResolver };
}

describe('GmailApiService', () => {
  it('lists labels through a bounded read-only request', async () => {
    const { service, fetchMock, close } = setup(url => {
      expect(url.pathname).toBe('/gmail/v1/users/me/labels');
      return Response.json({ labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }] });
    });
    await expect(service.listLabels(gmail)).resolves.toEqual([
      { id: 'INBOX', name: 'Inbox', type: 'system' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns Gmail string IDs and pagination without inventing IMAP UIDs', async () => {
    const { service } = setup(url => {
      expect(url.searchParams.get('q')).toBe('subject:receipt');
      expect(url.searchParams.get('labelIds')).toBe('INBOX');
      expect(url.searchParams.get('maxResults')).toBe('2');
      return Response.json({ messages: [{ id: 'abc123', threadId: 'thread123' }], nextPageToken: 'next' });
    });
    await expect(service.searchMessages(gmail, { query: 'subject:receipt', labelId: 'INBOX', maxResults: 2 }))
      .resolves.toEqual({ messages: [{ id: 'abc123', threadId: 'thread123' }], nextPageToken: 'next' });
  });

  it('reads metadata without requesting or returning a body', async () => {
    const { service } = setup(url => {
      expect(url.searchParams.get('format')).toBe('metadata');
      return Response.json({
        id: 'abc123', threadId: 'thread123', labelIds: ['INBOX'],
        payload: { headers: [{ name: 'Subject', value: 'Synthetic subject' }] },
      });
    });
    const result = await service.getMessage(gmail, 'abc123');
    expect(result).toMatchObject({ id: 'abc123', subject: 'Synthetic subject', labelIds: ['INBOX'] });
    expect(result).not.toHaveProperty('body');
    expect(result).not.toHaveProperty('uid');
  });

  it('decodes a plain-text body and caps output length', async () => {
    const body = Buffer.from('Synthetic message text', 'utf8').toString('base64url');
    const { service } = setup(url => {
      expect(url.searchParams.get('format')).toBe('full');
      return Response.json({
        id: 'abc123', threadId: 'thread123', payload: {
          headers: [], parts: [{ mimeType: 'text/plain', body: { data: body } }],
        },
      });
    });
    await expect(service.getMessage(gmail, 'abc123', { includeBody: true, maxBodyChars: 9 }))
      .resolves.toMatchObject({ body: 'Synthetic', bodyFormat: 'text', bodyTruncated: true });
  });

  it('converts HTML-only mail to Markdown and never returns raw HTML', async () => {
    const body = Buffer.from('<p>Hello <strong>friend</strong></p>', 'utf8').toString('base64url');
    const { service } = setup(() => Response.json({
      id: 'abc123', threadId: 'thread123', payload: {
        headers: [], parts: [{ mimeType: 'text/html', body: { data: body } }],
      },
    }));
    const result = await service.getMessage(gmail, 'abc123', { includeBody: true });
    expect(result.body).toContain('Hello');
    expect(result.body).not.toContain('<p>');
    expect(result.bodyFormat).toBe('markdown');
  });

  it('decodes a declared non-UTF-8 text charset', async () => {
    const data = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url');
    const { service } = setup(() => Response.json({
      id: 'abc123', threadId: 'thread123', payload: {
        headers: [], parts: [{
          mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }],
          body: { data },
        }],
      },
    }));
    await expect(service.getMessage(gmail, 'abc123', { includeBody: true }))
      .resolves.toMatchObject({ body: 'café', bodyFormat: 'text' });
  });

  it('rejects non-Gmail accounts before authentication or transport', async () => {
    const { service, fetchMock, authResolver } = setup(() => Response.json({}));
    await expect(service.listLabels({ ...gmail, auth: { kind: 'credential', provider: 'qq', credentialTarget: 'qq' } }))
      .rejects.toThrow('Gmail API requires a Gmail OAuth account');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(authResolver.resolve).not.toHaveBeenCalled();
  });

  it('does not leak a provider error body or bearer token', async () => {
    const { service } = setup(() => Response.json({ error: 'sensitive provider detail' }, { status: 403 }));
    await expect(service.listLabels(gmail)).rejects.toThrow('Gmail API request failed with status 403');
  });

  it('rejects malformed schema, invalid message IDs, and oversized responses', async () => {
    const { service } = setup(() => Response.json({ labels: [{ unexpected: 'value' }] }));
    await expect(service.listLabels(gmail)).rejects.toThrow('Gmail API returned invalid labels');
    await expect(service.getMessage(gmail, '../other')).rejects.toThrow('Invalid Gmail message ID');
    const large = setup(() => new Response('x'.repeat(200), { status: 200 }));
    const limited = new GmailApiService(large.authResolver as any, {
      transport: () => ({ fetch: large.fetchMock as typeof fetch, close: large.close, usingProxy: false }),
      maxResponseBytes: 100,
    });
    await expect(limited.listLabels(gmail)).rejects.toThrow('Gmail API response too large');
  });
});
