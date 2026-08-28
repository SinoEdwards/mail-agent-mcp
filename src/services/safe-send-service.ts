import { randomUUID } from 'node:crypto';
import type { EmailAttachment, EmailComposer } from '../types/index.js';

export type SafeSendState = 'pending' | 'sending' | 'sent' | 'ambiguous' | 'expired';

export interface SafeSendInput {
  accountId: string;
  composer: EmailComposer;
}

export interface SafeSendPayload {
  readonly accountId: string;
  readonly composer: Readonly<EmailComposer>;
}

export type SafeSendExecutor = (payload: SafeSendPayload) => void | Promise<void>;

export interface SafeSendPreview {
  readonly draftId: string;
  readonly expiresAt: number;
  readonly summary: {
    readonly accountId: string;
    readonly from: string;
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly bccCount: number;
    readonly subject: string;
    readonly attachmentNames: readonly string[];
  };
}

export type SafeSendConfirmation = { status: 'sent' } | { status: 'already_sent' };

export interface SafeSendServiceOptions {
  executor: SafeSendExecutor;
  ttlMs?: number;
  clock?: () => number;
  id?: () => string;
}

interface DraftEntry {
  state: SafeSendState;
  expiresAt: number;
  payload?: SafeSendPayload;
  inFlight?: Promise<SafeSendConfirmation>;
}

function copyList(value: string | string[] | undefined): string | string[] | undefined {
  return Array.isArray(value) ? Object.freeze([...value]) as unknown as string[] : value;
}

function summaryList(value: string | string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  return Object.freeze(Array.isArray(value) ? [...value] : [value]);
}

function copyAttachment(attachment: EmailAttachment): EmailAttachment {
  if (attachment.path !== undefined) {
    throw new Error('Safe-send attachment path must be materialized to Buffer content before preview');
  }
  const content = Buffer.isBuffer(attachment.content)
    ? Buffer.from(attachment.content)
    : attachment.content;
  return Object.freeze({
    filename: attachment.filename,
    content,
    contentType: attachment.contentType,
    contentDisposition: attachment.contentDisposition,
    cid: attachment.cid,
  });
}

function freezeComposer(composer: Readonly<EmailComposer>): Readonly<EmailComposer> {
  const attachments = composer.attachments
    ? Object.freeze(composer.attachments.map(copyAttachment)) as unknown as EmailAttachment[]
    : undefined;
  return Object.freeze({
    from: composer.from,
    to: copyList(composer.to)!,
    cc: copyList(composer.cc),
    bcc: copyList(composer.bcc),
    subject: composer.subject,
    text: composer.text,
    html: composer.html,
    attachments,
    replyTo: composer.replyTo,
    inReplyTo: composer.inReplyTo,
    references: copyList(composer.references),
  });
}

function freezePayload(input: SafeSendInput | SafeSendPayload): SafeSendPayload {
  return Object.freeze({ accountId: input.accountId, composer: freezeComposer(input.composer) });
}

function zeroizeAttachments(payload: SafeSendPayload): void {
  for (const attachment of payload.composer.attachments ?? []) {
    if (Buffer.isBuffer(attachment.content)) attachment.content.fill(0);
  }
}

export class SafeSendService {
  private readonly executor: SafeSendExecutor;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly id: () => string;
  private readonly drafts = new Map<string, DraftEntry>();

  constructor(options: SafeSendServiceOptions) {
    if (!Number.isFinite(options.ttlMs ?? 300_000) || (options.ttlMs ?? 300_000) <= 0) {
      throw new Error('Safe-send TTL must be a positive finite number');
    }
    this.executor = options.executor;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.clock = options.clock ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  preview(input: SafeSendInput): SafeSendPreview {
    const draftId = this.id();
    if (!draftId || this.drafts.has(draftId)) throw new Error('Safe-send draft id collision');
    const payload = freezePayload(input);
    const expiresAt = this.clock() + this.ttlMs;
    this.drafts.set(draftId, { state: 'pending', expiresAt, payload });
    const summary = Object.freeze({
      accountId: payload.accountId,
      from: payload.composer.from,
      to: summaryList(payload.composer.to),
      cc: summaryList(payload.composer.cc),
      bccCount: summaryList(payload.composer.bcc).length,
      subject: payload.composer.subject,
      attachmentNames: Object.freeze((payload.composer.attachments ?? []).map((a) => a.filename)),
    });
    return Object.freeze({ draftId, expiresAt, summary });
  }

  getState(draftId: string): SafeSendState {
    const entry = this.getDraft(draftId);
    this.expireIfNeeded(draftId, entry);
    return entry.state;
  }

  expireDrafts(): number {
    let expired = 0;
    for (const [draftId, entry] of this.drafts) {
      if (this.expireIfNeeded(draftId, entry)) expired += 1;
    }
    return expired;
  }

  async confirm(draftId: string, confirmed: boolean): Promise<SafeSendConfirmation> {
    if (confirmed !== true) throw new Error('Safe-send confirmation requires confirmed === true');
    const entry = this.getDraft(draftId);
    this.expireIfNeeded(draftId, entry);
    if (entry.state === 'sent') return { status: 'already_sent' };
    if (entry.state === 'expired') throw new Error('Safe-send draft has expired');
    if (entry.state === 'ambiguous') throw new Error('Safe-send outcome is ambiguous; retry is blocked');
    if (entry.state === 'sending') {
      if (!entry.inFlight) throw new Error('Safe-send invariant violation: missing in-flight operation');
      await entry.inFlight;
      return { status: 'already_sent' };
    }

    entry.state = 'sending';
    if (!entry.payload) throw new Error('Safe-send invariant violation: missing draft payload');
    const executionPayload = freezePayload(entry.payload);
    const operation = (async (): Promise<SafeSendConfirmation> => {
      try {
        await this.executor(executionPayload);
        this.finish(draftId, entry, 'sent');
        return { status: 'sent' };
      } catch (error) {
        this.finish(draftId, entry, 'ambiguous');
        throw new Error('Safe-send outcome is ambiguous; retry is blocked', { cause: error });
      } finally {
        zeroizeAttachments(executionPayload);
      }
    })();
    entry.inFlight = operation;
    return operation;
  }

  private getDraft(draftId: string): DraftEntry {
    const entry = this.drafts.get(draftId);
    if (!entry) throw new Error('Unknown or tampered safe-send draft id');
    return entry;
  }

  private expireIfNeeded(draftId: string, entry: DraftEntry): boolean {
    if (entry.state !== 'pending' || this.clock() < entry.expiresAt) return false;
    this.finish(draftId, entry, 'expired');
    return true;
  }

  private finish(
    draftId: string,
    entry: DraftEntry,
    state: Extract<SafeSendState, 'sent' | 'ambiguous' | 'expired'>,
  ): void {
    if (entry.payload) zeroizeAttachments(entry.payload);
    entry.state = state;
    entry.payload = undefined;
    entry.inFlight = undefined;
    this.drafts.set(draftId, { state, expiresAt: entry.expiresAt });
  }
}
