import type { ImapAccount } from '../types/index.js';
import { AccountAuthResolver } from '../credentials/account-auth.js';
import { classifyNetworkError } from '../credentials/network-error.js';
import { createProxyAwareFetch, type ProxyAwareFetch } from '../credentials/proxy-fetch.js';
import { htmlToMarkdown, normalizeWhitespace } from './html-to-markdown.js';

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BODY_CHARS = 10_000;
const MAX_BODY_CHARS = 20_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Gmail API returned an empty response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('Gmail API response too large');
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new Error('Gmail API returned invalid JSON');
    }
  } finally {
    reader.releaseLock();
  }
}

export interface GmailApiLabel {
  id: string;
  name: string;
  type?: string;
}

export interface GmailApiMessageReference {
  /** Opaque Gmail API ID; never an IMAP UID. */
  id: string;
  threadId: string;
}

export interface GmailApiSearchResult {
  messages: GmailApiMessageReference[];
  nextPageToken?: string;
}

export interface GmailApiMessage extends GmailApiMessageReference {
  labelIds: string[];
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  cc?: string;
  replyTo?: string;
  messageIdHeader?: string;
  references?: string;
  body?: string;
  bodyFormat?: 'text' | 'markdown';
  bodyTruncated?: boolean;
}

export interface GmailApiAttachment {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
}

export interface GmailApiAttachmentContent extends GmailApiAttachment {
  content: Buffer;
}

export interface GmailApiServiceOptions {
  transport?: () => ProxyAwareFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function headersOf(payload: JsonRecord): Record<string, string> {
  if (!Array.isArray(payload.headers)) throw new Error('Gmail API returned invalid message headers');
  const headers: Record<string, string> = {};
  for (const item of payload.headers) {
    if (!record(item) || typeof item.name !== 'string' || typeof item.value !== 'string') {
      throw new Error('Gmail API returned invalid message headers');
    }
    const name = item.name.toLowerCase();
    if (['from', 'to', 'subject', 'date', 'cc', 'reply-to', 'message-id', 'references'].includes(name)
      && headers[name] === undefined) {
      headers[name] = item.value;
    }
  }
  return headers;
}

function attachmentParts(payload: JsonRecord): Array<{ metadata: GmailApiAttachment; body: JsonRecord }> {
  const found: Array<{ metadata: GmailApiAttachment; body: JsonRecord }> = [];
  function visit(part: JsonRecord, depth: number): void {
    if (depth > 30) throw new Error('Gmail API message nesting too deep');
    if (requiredString(part.filename)) {
      if (!requiredString(part.partId) || !record(part.body)
        || !Number.isSafeInteger(part.body.size) || (part.body.size as number) < 0) {
        throw new Error('Gmail API returned invalid attachment metadata');
      }
      const headers = Array.isArray(part.headers) ? part.headers : [];
      const cid = headers.find((header: unknown) => record(header)
        && typeof header.name === 'string' && header.name.toLowerCase() === 'content-id');
      found.push({
        metadata: {
          partId: part.partId,
          filename: part.filename,
          mimeType: typeof part.mimeType === 'string' ? part.mimeType : 'application/octet-stream',
          size: part.body.size as number,
          ...(record(cid) && requiredString(cid.value) ? { contentId: cid.value.replace(/^<|>$/g, '') } : {}),
        },
        body: part.body,
      });
    }
    if (part.parts !== undefined) {
      if (!Array.isArray(part.parts)) throw new Error('Gmail API returned invalid message parts');
      for (const child of part.parts) {
        if (!record(child)) throw new Error('Gmail API returned invalid message parts');
        visit(child, depth + 1);
      }
    }
  }
  visit(payload, 0);
  return found;
}

function decodeAttachment(data: unknown, maxBytes: number): Buffer {
  if (typeof data !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)
    || data.length % 4 === 1) throw new Error('Gmail API returned invalid attachment encoding');
  const content = Buffer.from(data, 'base64url');
  if (content.length > maxBytes) throw new Error('Gmail API attachment exceeds size limit');
  if (content.toString('base64url') !== data.replace(/=+$/u, '')) {
    throw new Error('Gmail API returned invalid attachment encoding');
  }
  return content;
}

function collectBodyParts(part: JsonRecord, plain: string[], html: string[], depth = 0): void {
  if (depth > 30) throw new Error('Gmail API message nesting too deep');
  if (!part.filename && (part.mimeType === 'text/plain' || part.mimeType === 'text/html')
    && record(part.body) && requiredString(part.body.data)) {
    const encoded = part.body.data;
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) {
      throw new Error('Gmail API returned invalid body encoding');
    }
    const bytes = Buffer.from(encoded, 'base64url');
    const contentType = Array.isArray(part.headers)
      ? part.headers.find((header: unknown) => record(header)
        && typeof header.name === 'string' && header.name.toLowerCase() === 'content-type')
      : undefined;
    const charset = record(contentType) && typeof contentType.value === 'string'
      ? /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType.value)?.[1]
      : undefined;
    let decoded: string;
    try {
      decoded = new TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
      decoded = bytes.toString('utf8');
    }
    if (part.mimeType === 'text/plain') plain.push(decoded);
    if (part.mimeType === 'text/html') html.push(decoded);
  }
  if (part.parts !== undefined) {
    if (!Array.isArray(part.parts)) throw new Error('Gmail API returned invalid message parts');
    for (const child of part.parts) {
      if (!record(child)) throw new Error('Gmail API returned invalid message parts');
      collectBodyParts(child, plain, html, depth + 1);
    }
  }
}

export class GmailApiService {
  constructor(
    private readonly authResolver: AccountAuthResolver = new AccountAuthResolver(),
    private readonly options: GmailApiServiceOptions = {},
  ) {}

  private async request(account: ImapAccount, path: string): Promise<unknown> {
    if (account.auth?.kind !== 'oauth2' || account.auth.provider !== 'gmail') {
      throw new Error('Gmail API requires a Gmail OAuth account');
    }
    let token: string;
    try {
      const auth = await this.authResolver.resolve(account, 'imap');
      if (auth.kind !== 'oauth2' || !auth.accessToken) throw new Error('OAuth required');
      token = auth.accessToken;
    } catch {
      throw new Error('Gmail API OAuth authentication unavailable');
    }

    const transport = (this.options.transport ?? createProxyAwareFetch)();
    try {
      let response: Response;
      try {
        response = await transport.fetch(BASE_URL + path, {
          method: 'GET',
          headers: { authorization: 'Bearer ' + token },
          redirect: 'error',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error('Gmail API request failed (' + classifyNetworkError(error) + ')');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Gmail API request failed with status ' + response.status);
      }
      return await readBoundedJson(response, this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
    } finally {
      await transport.close().catch(() => undefined);
    }
  }

  async listLabels(account: ImapAccount): Promise<GmailApiLabel[]> {
    const data = await this.request(account, 'labels');
    if (!record(data) || !Array.isArray(data.labels)) throw new Error('Gmail API returned invalid labels');
    return data.labels.map((item): GmailApiLabel => {
      if (!record(item) || !requiredString(item.id) || !requiredString(item.name)
        || (item.type !== undefined && typeof item.type !== 'string')) {
        throw new Error('Gmail API returned invalid labels');
      }
      return { id: item.id, name: item.name, ...(item.type ? { type: item.type } : {}) };
    });
  }

  async searchMessages(
    account: ImapAccount,
    options: { query?: string; labelId?: string; maxResults?: number; pageToken?: string } = {},
  ): Promise<GmailApiSearchResult> {
    const maxResults = options.maxResults ?? 20;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw new Error('Gmail API maxResults must be between 1 and 100');
    }
    if (options.query !== undefined && options.query.length > 512) throw new Error('Gmail API query too long');
    if (options.labelId !== undefined && options.labelId.length > 128) throw new Error('Gmail API label ID too long');
    if (options.pageToken !== undefined && options.pageToken.length > 2048) throw new Error('Gmail API page token too long');
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (options.query) params.set('q', options.query);
    if (options.labelId) params.set('labelIds', options.labelId);
    if (options.pageToken) params.set('pageToken', options.pageToken);
    const data = await this.request(account, 'messages?' + params.toString());
    if (!record(data) || (data.messages !== undefined && !Array.isArray(data.messages))
      || (data.nextPageToken !== undefined && typeof data.nextPageToken !== 'string')) {
      throw new Error('Gmail API returned invalid message list');
    }
    const messages = (data.messages ?? []).map((item: unknown): GmailApiMessageReference => {
      if (!record(item) || !requiredString(item.id) || !requiredString(item.threadId)) {
        throw new Error('Gmail API returned invalid message list');
      }
      return { id: item.id, threadId: item.threadId };
    });
    return { messages, ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
  }

  async getMessage(
    account: ImapAccount,
    messageId: string,
    options: { includeBody?: boolean; maxBodyChars?: number } = {},
  ): Promise<GmailApiMessage> {
    if (!MESSAGE_ID.test(messageId)) throw new Error('Invalid Gmail message ID');
    const maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS;
    if (!Number.isInteger(maxBodyChars) || maxBodyChars < 1 || maxBodyChars > MAX_BODY_CHARS) {
      throw new Error('Gmail API maxBodyChars must be between 1 and 20000');
    }
    const params = new URLSearchParams({ format: options.includeBody ? 'full' : 'metadata' });
    if (!options.includeBody) {
      for (const header of ['From', 'To', 'Cc', 'Subject', 'Date', 'Reply-To', 'Message-ID', 'References']) {
        params.append('metadataHeaders', header);
      }
    }
    const data = await this.request(account, 'messages/' + encodeURIComponent(messageId) + '?' + params);
    if (!record(data) || !requiredString(data.id) || !requiredString(data.threadId)
      || data.id !== messageId || !record(data.payload)
      || (data.labelIds !== undefined && (!Array.isArray(data.labelIds)
        || !data.labelIds.every((label: unknown) => typeof label === 'string')))) {
      throw new Error('Gmail API returned invalid message');
    }
    const headers = headersOf(data.payload);
    const result: GmailApiMessage = {
      id: data.id,
      threadId: data.threadId,
      labelIds: (data.labelIds as string[] | undefined) ?? [],
      ...(headers.from ? { from: headers.from } : {}),
      ...(headers.to ? { to: headers.to } : {}),
      ...(headers.subject ? { subject: headers.subject } : {}),
      ...(headers.date ? { date: headers.date } : {}),
      ...(headers.cc ? { cc: headers.cc } : {}),
      ...(headers['reply-to'] ? { replyTo: headers['reply-to'] } : {}),
      ...(headers['message-id'] ? { messageIdHeader: headers['message-id'] } : {}),
      ...(headers.references ? { references: headers.references } : {}),
    };
    if (options.includeBody) {
      const plain: string[] = [];
      const html: string[] = [];
      collectBodyParts(data.payload, plain, html);
      const text = normalizeWhitespace(plain.join('\n\n'));
      const body = text || htmlToMarkdown(html.join('\n\n'));
      result.body = body.slice(0, maxBodyChars);
      result.bodyFormat = text ? 'text' : 'markdown';
      result.bodyTruncated = body.length > maxBodyChars;
    }
    return result;
  }

  private async fullPayload(account: ImapAccount, messageId: string): Promise<JsonRecord> {
    if (!MESSAGE_ID.test(messageId)) throw new Error('Invalid Gmail message ID');
    const data = await this.request(account, 'messages/' + encodeURIComponent(messageId) + '?format=full');
    if (!record(data) || data.id !== messageId || !record(data.payload)) {
      throw new Error('Gmail API returned invalid message');
    }
    return data.payload;
  }

  async listAttachments(account: ImapAccount, messageId: string): Promise<GmailApiAttachment[]> {
    return attachmentParts(await this.fullPayload(account, messageId)).map(part => part.metadata);
  }

  async getAttachment(
    account: ImapAccount,
    messageId: string,
    partId: string,
    maxBytes = MAX_ATTACHMENT_BYTES,
  ): Promise<GmailApiAttachmentContent> {
    if (!partId || partId.length > 128 || /[\u0000-\u001f\u007f]/u.test(partId)) {
      throw new Error('Invalid Gmail attachment part ID');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error('Gmail API attachment size limit must be between 1 and 5242880 bytes');
    }
    const part = attachmentParts(await this.fullPayload(account, messageId))
      .find(item => item.metadata.partId === partId);
    if (!part) throw new Error('Gmail API attachment part not found');
    if (part.metadata.size > maxBytes) throw new Error('Gmail API attachment exceeds size limit');
    let body = part.body;
    if (requiredString(body.attachmentId)) {
      if (body.attachmentId.length > 2048 || /[\u0000-\u001f\u007f]/u.test(body.attachmentId)) {
        throw new Error('Gmail API returned invalid attachment ID');
      }
      const data = await this.request(account, 'messages/' + encodeURIComponent(messageId)
        + '/attachments/' + encodeURIComponent(body.attachmentId));
      if (!record(data)) throw new Error('Gmail API returned invalid attachment');
      body = data;
    }
    const content = decodeAttachment(body.data, maxBytes);
    if (content.length !== part.metadata.size) {
      throw new Error('Gmail API attachment size does not match message metadata');
    }
    return { ...part.metadata, content };
  }
}
