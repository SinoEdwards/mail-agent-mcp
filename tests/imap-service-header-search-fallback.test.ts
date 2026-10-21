import { describe, expect, it, vi } from 'vitest';
import { ImapService } from '../src/services/imap-service.js';

function harness(exists = 2) {
  const messages = [
    { uid: 11, internalDate: new Date('2026-01-01'), flags: new Set(), envelope: {
      subject: 'Delivery check', from: [{ address: 'sender@example.test' }],
      to: [{ address: 'one@example.test' }],
    } },
    { uid: 12, internalDate: new Date('2026-01-02'), flags: new Set(), envelope: {
      subject: 'Other message', from: [{ address: 'other@example.test' }],
      to: [{ address: 'two@example.test' }],
    } },
  ];
  const release = vi.fn();
  const client = {
    mailbox: { exists },
    getMailboxLock: vi.fn(async () => ({ release })),
    search: vi.fn(async () => [] as number[]),
    fetch: vi.fn(async function* () { yield* messages; }),
  };
  const service = new ImapService({} as any);
  (service as any).ensureConnected = vi.fn(async () => client);
  return { service, client, release };
}

describe('bounded header search verification', () => {
  it('finds a subject match when server SEARCH falsely returns empty', async () => {
    const { service, client, release } = harness();
    const found = await service.searchEmails('acct', 'Sent', { subject: 'delivery CHECK' });
    expect(found.map(message => message.uid)).toEqual([11]);
    expect(client.fetch).toHaveBeenCalledWith('1:2', expect.objectContaining({ envelope: true }), {});
    expect(client.fetch.mock.calls[0][1]).not.toHaveProperty('source');
    expect(release).toHaveBeenCalledOnce();
  });

  it('matches combined sender and recipient metadata without returning unrelated mail', async () => {
    const { service } = harness();
    const found = await service.searchEmails('acct', 'Sent', {
      from: 'sender@example.test', to: 'one@example.test',
    });
    expect(found.map(message => message.uid)).toEqual([11]);
  });

  it('does not scan large folders or use the fallback for body searches', async () => {
    const large = harness(501);
    expect(await large.service.searchEmails('acct', 'Sent', { subject: 'Delivery' })).toEqual([]);
    expect(large.client.fetch).not.toHaveBeenCalled();

    const body = harness();
    expect(await body.service.searchEmails('acct', 'Sent', { body: 'Delivery' })).toEqual([]);
    expect(body.client.fetch).not.toHaveBeenCalled();
  });

  it('avoids scanning message bodies when the caller requested includeBody', async () => {
    const { service, client } = harness();
    expect(await service.searchEmails('acct', 'Sent', { subject: 'Delivery' }, { includeBody: true }))
      .toEqual([]);
    expect(client.fetch).not.toHaveBeenCalled();
  });
});
