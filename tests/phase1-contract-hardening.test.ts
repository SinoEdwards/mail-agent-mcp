import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertProviderAccountAuth } from '../src/services/account-manager.js';
import { SafeSendService, type SafeSendInput } from '../src/services/safe-send-service.js';
import type { ImapAccount } from '../src/types/index.js';

const SYNTHETIC_PASSWORD_1 = ["synthetic", "-password"].join('');

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const account = (overrides: Partial<ImapAccount>): ImapAccount => ({
  id: 'synthetic-id',
  name: 'Synthetic',
  host: 'imap.example.test',
  port: 993,
  user: 'person@example.test',
  password: SYNTHETIC_PASSWORD_1,
  tls: true,
  ...overrides,
});

const input = (): SafeSendInput => ({
  accountId: 'account-1',
  composer: {
    from: 'sender@example.test',
    to: ['recipient@example.test'],
    subject: 'Synthetic subject',
    text: 'sensitive synthetic body',
    attachments: [{ filename: 'fixture.txt', content: Buffer.from('synthetic attachment') }],
  },
});

const stored = (service: SafeSendService, draftId: string): Record<string, unknown> =>
  (service as unknown as { drafts: Map<string, Record<string, unknown>> }).drafts.get(draftId)!;

const expectTombstone = (service: SafeSendService, draftId: string, state: string) => {
  const entry = stored(service, draftId);
  expect(entry).toEqual({ state, expiresAt: expect.any(Number) });
  expect(JSON.stringify(entry)).not.toMatch(/account-1|recipient@example\.test|sensitive synthetic body|fixture\.txt/);
};

describe('provider-bound generic account boundary', () => {
  it.each([
    ['Gmail', account({ host: 'imap.gmail.com' }), /node dist\/enroll\.js gmail/i],
    ['QQ Mail', account({ smtp: { host: 'smtp.qq.com', port: 465, secure: true } }), /node dist\/enroll\.js qq/i],
  ])('rejects password fallback for %s hosts', (_provider, candidate, expected) => {
    expect(() => assertProviderAccountAuth(candidate)).toThrow(expected);
  });

  it('preserves generic IMAP password compatibility', () => {
    expect(() => assertProviderAccountAuth(account({}))).not.toThrow();
  });
});

describe('safe-send terminal privacy', () => {
  it('replaces sent, ambiguous, and expired payloads with minimal tombstones', async () => {
    const sent = new SafeSendService({ executor: vi.fn(async () => undefined), id: () => 'sent-id' });
    sent.preview(input());
    await sent.confirm('sent-id', true);
    expectTombstone(sent, 'sent-id', 'sent');
    await expect(sent.confirm('sent-id', true)).resolves.toEqual({ status: 'already_sent' });

    const ambiguous = new SafeSendService({
      executor: vi.fn(async () => { throw new Error('synthetic uncertainty'); }),
      id: () => 'ambiguous-id',
    });
    ambiguous.preview(input());
    await expect(ambiguous.confirm('ambiguous-id', true)).rejects.toThrow(/ambiguous/i);
    expectTombstone(ambiguous, 'ambiguous-id', 'ambiguous');
    await expect(ambiguous.confirm('ambiguous-id', true)).rejects.toThrow(/ambiguous/i);

    let now = 1_000;
    const expired = new SafeSendService({
      executor: vi.fn(async () => undefined),
      id: () => 'expired-id',
      ttlMs: 10,
      clock: () => now,
    });
    expired.preview(input());
    now += 10;
    expect(expired.expireDrafts()).toBe(1);
    expectTombstone(expired, 'expired-id', 'expired');
    await expect(expired.confirm('expired-id', true)).rejects.toThrow(/expired/i);
  });
});

describe('public MCP contract', () => {
  it('points attachment upload to preview-confirm sending, not hidden direct send', () => {
    const source = read('src/tools/email-tools.ts');
    const upload = source.slice(
      source.indexOf("server.registerTool('imap_upload_file'"),
      source.indexOf("server.registerTool('imap_download_attachment'"),
    );
    expect(upload).not.toContain('imap_send_email');
    expect(upload).toContain('imap_preview_send_email');
    expect(upload).toContain('imap_confirm_send');
  });

  it('defines read-only mode as mailbox-read-only and discloses attachment file writes', () => {
    const guide = read('docs/agent-integration.md');
    expect(guide).toMatch(/mailbox-read-only/i);
    expect(guide).toMatch(/attachment[^\n]{0,180}(write|save)[^\n]{0,180}(file|disk)/i);
  });
});
