import { describe, expect, it, vi } from 'vitest';
import {
  SafeSendService,
  type SafeSendExecutor,
  type SafeSendInput,
} from '../src/services/safe-send-service.js';

const makeInput = (): SafeSendInput => ({
  accountId: 'account-1',
  composer: {
    from: 'sender@example.test',
    to: ['alice@example.test'],
    cc: ['copy@example.test'],
    bcc: [],
    subject: 'Quarterly update',
    text: 'private plain-text body',
    html: '<p>private HTML body</p>',
    replyTo: 'reply@example.test',
    inReplyTo: '<parent@example.test>',
    references: ['<root@example.test>', '<parent@example.test>'],
    attachments: [{
      filename: 'note.txt',
      contentType: 'text/plain',
      contentDisposition: 'inline',
      cid: 'note-1',
      content: Buffer.from('attachment-fixture'),
    }],
  },
});

const harness = (executor: SafeSendExecutor, ttlMs = 1_000) => {
  let now = 10_000;
  let sequence = 0;
  const service = new SafeSendService({
    executor,
    ttlMs,
    clock: () => now,
    id: () => `opaque-${++sequence}`,
  });
  return { service, advance: (ms: number) => { now += ms; } };
};

describe('SafeSendService', () => {
  it('previews a copied immutable composer snapshot without exposing either body', async () => {
    const executor = vi.fn<SafeSendExecutor>(async (payload) => {
      expect(Object.isFrozen(payload)).toBe(true);
      expect(Object.isFrozen(payload.composer)).toBe(true);
      expect(Object.isFrozen(payload.composer.to)).toBe(true);
      expect(Object.isFrozen(payload.composer.cc)).toBe(true);
      expect(Object.isFrozen(payload.composer.bcc)).toBe(true);
      expect(Object.isFrozen(payload.composer.references)).toBe(true);
      expect(Object.isFrozen(payload.composer.attachments)).toBe(true);
      expect(Object.isFrozen(payload.composer.attachments![0])).toBe(true);
      expect(payload).toMatchObject({
        accountId: 'account-1',
        composer: {
          from: 'sender@example.test',
          to: ['alice@example.test'],
          cc: ['copy@example.test'],
          bcc: [],
          subject: 'Quarterly update',
          text: 'private plain-text body',
          html: '<p>private HTML body</p>',
          replyTo: 'reply@example.test',
          inReplyTo: '<parent@example.test>',
          references: ['<root@example.test>', '<parent@example.test>'],
          attachments: [{
            filename: 'note.txt',
            contentType: 'text/plain',
            contentDisposition: 'inline',
            cid: 'note-1',
          }],
        },
      });
      expect((payload.composer.attachments![0].content as Buffer).toString()).toBe('attachment-fixture');
    });
    const { service } = harness(executor);
    const input = makeInput();

    const preview = service.preview(input);
    input.accountId = 'tampered-account';
    input.composer.from = 'tampered@example.test';
    (input.composer.to as string[])[0] = 'tampered@example.test';
    (input.composer.cc as string[])[0] = 'tampered-copy@example.test';
    input.composer.subject = 'tampered';
    input.composer.text = 'tampered';
    input.composer.html = '<p>tampered</p>';
    input.composer.replyTo = 'tampered-reply@example.test';
    (input.composer.references as string[])[0] = '<tampered@example.test>';
    input.composer.attachments![0].filename = 'tampered.txt';
    input.composer.attachments![0].contentType = 'application/octet-stream';
    input.composer.attachments![0].cid = 'tampered-cid';
    (input.composer.attachments![0].content as Buffer).fill(0);
    input.composer.attachments!.push({ filename: 'added.txt', content: 'added' });

    expect(preview).toEqual({
      draftId: 'opaque-1',
      expiresAt: 11_000,
      summary: {
        accountId: 'account-1',
        from: 'sender@example.test',
        to: ['alice@example.test'],
        cc: ['copy@example.test'],
        bccCount: 0,
        subject: 'Quarterly update',
        attachmentNames: ['note.txt'],
      },
    });
    expect(JSON.stringify(preview)).not.toContain('private plain-text body');
    expect(JSON.stringify(preview)).not.toContain('private HTML body');
    expect(service.getState(preview.draftId)).toBe('pending');

    await expect(service.confirm(preview.draftId, true)).resolves.toEqual({ status: 'sent' });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('requires explicit true confirmation and rejects unknown/tampered ids', async () => {
    const executor = vi.fn<SafeSendExecutor>(async () => undefined);
    const { service } = harness(executor);
    const { draftId } = service.preview(makeInput());

    await expect(service.confirm(draftId, false)).rejects.toThrow(/confirmed.*true/i);
    await expect(service.confirm(`${draftId}-tampered`, true)).rejects.toThrow(/unknown.*draft/i);
    expect(service.getState(draftId)).toBe('pending');
    expect(executor).not.toHaveBeenCalled();
  });

  it('rejects path-backed attachments before creating a preview', () => {
    const executor = vi.fn<SafeSendExecutor>(async () => undefined);
    const { service } = harness(executor);
    const input = makeInput();
    input.composer.attachments![0].path = 'uploads/note.txt';

    expect(() => service.preview(input)).toThrow(/attachment path.*materialized.*buffer/i);
    expect(executor).not.toHaveBeenCalled();
  });

  it('sends exactly once under concurrent confirmation and makes retries idempotent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executor = vi.fn<SafeSendExecutor>(async (payload) => {
      expect(payload.accountId).toBe('account-1');
      expect(payload.composer.text).toBe('private plain-text body');
      expect((payload.composer.attachments![0].content as Buffer).toString()).toBe('attachment-fixture');
      await gate;
    });
    const { service } = harness(executor);
    const { draftId } = service.preview(makeInput());

    const first = service.confirm(draftId, true);
    const concurrent = service.confirm(draftId, true);
    expect(service.getState(draftId)).toBe('sending');
    expect(executor).toHaveBeenCalledTimes(1);
    release();

    await expect(first).resolves.toEqual({ status: 'sent' });
    await expect(concurrent).resolves.toEqual({ status: 'already_sent' });
    await expect(service.confirm(draftId, true)).resolves.toEqual({ status: 'already_sent' });
    expect(service.getState(draftId)).toBe('sent');
    expect(executor).toHaveBeenCalledTimes(1);
    expect((executor.mock.calls[0][0].composer.attachments![0].content as Buffer).every((byte) => byte === 0)).toBe(true);
  });

  it('marks executor failures ambiguous, zeroizes buffers, and blocks retries', async () => {
    const executor = vi.fn<SafeSendExecutor>(async () => { throw new Error('provider outcome unknown'); });
    const { service } = harness(executor);
    const { draftId } = service.preview(makeInput());

    await expect(service.confirm(draftId, true)).rejects.toThrow(/ambiguous/i);
    expect(service.getState(draftId)).toBe('ambiguous');
    expect((executor.mock.calls[0][0].composer.attachments![0].content as Buffer).every((byte) => byte === 0)).toBe(true);
    await expect(service.confirm(draftId, true)).rejects.toThrow(/ambiguous/i);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('expires pending drafts, zeroizes buffers, and never invokes the executor', async () => {
    const executor = vi.fn<SafeSendExecutor>(async () => undefined);
    const { service, advance } = harness(executor, 50);
    const { draftId } = service.preview(makeInput());
    advance(50);

    expect(service.expireDrafts()).toBe(1);
    expect(service.getState(draftId)).toBe('expired');
    await expect(service.confirm(draftId, true)).rejects.toThrow(/expired/i);
    expect(executor).not.toHaveBeenCalled();
  });
});
