import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMailProxy } from '../src/utils/mail-proxy.js';

const transportMocks = vi.hoisted(() => ({
  imapOptions: [] as Array<Record<string, unknown>>,
  smtpOptions: [] as Array<Record<string, unknown>>,
  verify: vi.fn(async () => true),
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    usable = true;
    constructor(options: Record<string, unknown>) {
      transportMocks.imapOptions.push(options);
    }
    on() {}
    async connect() {}
    async logout() {}
    async list() { return []; }
    async status() { return { messages: 0 }; }
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      transportMocks.smtpOptions.push(options);
      return { verify: transportMocks.verify, close: vi.fn() };
    },
  },
}));

import { ImapService } from '../src/services/imap-service.js';
import { SmtpService } from '../src/services/smtp-service.js';

const account = {
  id: 'proxy-account',
  name: 'Proxy account',
  host: 'imap.example.test',
  port: 993,
  user: 'person@example.test',
  password: 'fixture-password',
  tls: true,
  smtp: {
    host: 'smtp.example.test',
    port: 465,
    secure: true,
    user: 'person@example.test',
    password: 'fixture-password',
  },
};

describe('resolveMailProxy', () => {
  it('returns undefined when the setting is absent or blank', () => {
    expect(resolveMailProxy({})).toBeUndefined();
    expect(resolveMailProxy({ IMAP_MCP_MAIL_PROXY: '  ' })).toBeUndefined();
  });

  it.each([
    'http://proxy.example.test:8080',
    'https://proxy.example.test:8443',
    'socks://proxy.example.test:1080',
    'socks4://proxy.example.test:1080',
    'socks4a://proxy.example.test:1080',
    'socks5://proxy.example.test:1080',
  ])('accepts the documented proxy protocol: %s', (proxy) => {
    expect(resolveMailProxy({ IMAP_MCP_MAIL_PROXY: proxy })).toBe(proxy);
  });

  it.each(['not a URL', 'ftp://proxy.example.test'])('rejects invalid settings without reflecting them', (proxy) => {
    let caught: unknown;
    try {
      resolveMailProxy({ IMAP_MCP_MAIL_PROXY: proxy });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('IMAP_MCP_MAIL_PROXY must be a supported proxy URL');
    expect((caught as Error).message).not.toContain(proxy);
  });
});

describe('mail transport proxy wiring', () => {
  beforeEach(() => {
    process.env.IMAP_MCP_MAIL_PROXY = 'http://proxy.example.test:8080';
    transportMocks.imapOptions.length = 0;
    transportMocks.smtpOptions.length = 0;
    transportMocks.verify.mockClear();
  });

  afterEach(() => {
    delete process.env.IMAP_MCP_MAIL_PROXY;
  });

  it('passes the proxy to connect, authenticateOnly, and testConnection', async () => {
    const service = new ImapService();
    await service.connect(account);
    await service.authenticateOnly({ ...account, id: 'auth-only' });
    await service.testConnection({ ...account, id: 'test-connection' });
    expect(transportMocks.imapOptions).toHaveLength(3);
    expect(transportMocks.imapOptions.every((options) =>
      options.proxy === 'http://proxy.example.test:8080')).toBe(true);
  });

  it('passes the same proxy to Nodemailer SMTP transport', async () => {
    await new SmtpService().createTransporter(account);
    expect(transportMocks.smtpOptions).toHaveLength(1);
    expect(transportMocks.smtpOptions[0]?.proxy).toBe('http://proxy.example.test:8080');
  });

  it('omits proxy options when the setting is absent', async () => {
    delete process.env.IMAP_MCP_MAIL_PROXY;
    await new ImapService().connect(account);
    await new SmtpService().createTransporter(account);
    expect(transportMocks.imapOptions[0]).not.toHaveProperty('proxy');
    expect(transportMocks.smtpOptions[0]).not.toHaveProperty('proxy');
  });
});
