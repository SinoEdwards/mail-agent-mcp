import { describe, expect, it, vi } from 'vitest';
import {
  credentialTarget,
  gmailClientSecretTarget,
  legacyCredentialTarget,
  type CredentialBackend,
  type SecretHandle,
} from '../src/credentials/credential-backend.js';
import {
  AccountAuthResolver,
  accountForPersistence,
} from '../src/credentials/account-auth.js';
import type { ImapAccount } from '../src/types/index.js';

class FakeHandle implements SecretHandle {
  disposed = false;
  constructor(private secret: unknown) {}
  read(): unknown {
    if (this.disposed) throw new Error('secret handle disposed');
    return this.secret;
  }
  dispose(): void {
    this.secret = undefined;
    this.disposed = true;
  }
}

class FakeBackend implements CredentialBackend {
  values = new Map<string, unknown>();
  handles: FakeHandle[] = [];
  reads: string[] = [];
  read(target: string): SecretHandle | undefined {
    this.reads.push(target);
    if (!this.values.has(target)) return undefined;
    const handle = new FakeHandle(this.values.get(target));
    this.handles.push(handle);
    return handle;
  }
  write(target: string, secret: string): void {
    this.values.set(target, secret);
  }
  delete(target: string): boolean {
    return this.values.delete(target);
  }
}

const base = (overrides: Partial<ImapAccount> = {}): ImapAccount => ({
  id: 'one', name: 'Personal', host: 'imap.qq.com', port: 993,
  user: 'person@qq.com', password: '', tls: true,
  smtp: { host: 'smtp.qq.com', port: 465, secure: true, user: 'person@qq.com' },
  ...overrides,
});

describe('credential backend contract', () => {
  it('uses exact validated QQ and Gmail target names', () => {
    expect(credentialTarget('qq', 'person@qq.com'))
      .toBe('MailAgentMCP:qq:person@qq.com:authorization_code');
    expect(credentialTarget('gmail', 'person@gmail.com'))
      .toBe('MailAgentMCP:gmail:person@gmail.com:refresh_token');
    expect(gmailClientSecretTarget('person@gmail.com'))
      .toBe('MailAgentMCP:gmail:person@gmail.com:client_secret');
    expect(() => credentialTarget('qq', 'bad:account')).toThrow(/invalid account/i);
    expect(() => credentialTarget('gmail', '  ')).toThrow(/invalid account/i);
  });

  it('supports write/read/delete and always cleans a resolved secret handle', async () => {
    const backend = new FakeBackend();
    const target = credentialTarget('qq', 'person@qq.com');
    backend.write(target, 'qq-authorization-code');
    const resolver = new AccountAuthResolver(backend);
    await expect(resolver.resolve(base({ auth: { kind: 'credential', provider: 'qq', credentialTarget: target } })))
      .resolves.toEqual({ kind: 'password', user: 'person@qq.com', password: 'qq-authorization-code' });
    expect(backend.handles).toHaveLength(1);
    expect(backend.handles[0].disposed).toBe(true);
    expect(backend.delete(target)).toBe(true);
  });

  it('reads an exact legacy target without treating arbitrary targets as compatible', async () => {
    const backend = new FakeBackend();
    const target = legacyCredentialTarget('qq', 'person@qq.com');
    backend.write(target, 'legacy-dummy-authorization-code');
    const resolver = new AccountAuthResolver(backend);
    await expect(resolver.resolve(base({
      auth: { kind: 'credential', provider: 'qq', credentialTarget: target },
    }))).resolves.toEqual({
      kind: 'password',
      user: 'person@qq.com',
      password: 'legacy-dummy-authorization-code',
    });
    expect(backend.reads).toEqual([target]);
  });

  it('reports missing and malformed credentials and still cleans malformed handles', async () => {
    const backend = new FakeBackend();
    const target = credentialTarget('qq', 'person@qq.com');
    const resolver = new AccountAuthResolver(backend);
    const account = base({ auth: { kind: 'credential', provider: 'qq', credentialTarget: target } });
    await expect(resolver.resolve(account)).rejects.toThrow(/credential.*not found/i);
    backend.values.set(target, { not: 'a string' });
    await expect(resolver.resolve(account)).rejects.toThrow(/malformed credential/i);
    expect(backend.handles.at(-1)?.disposed).toBe(true);
  });

  it('does not expose account addresses or credential targets in resolver errors', async () => {
    const target = credentialTarget('qq', 'person@qq.com');
    const missingBackend = new AccountAuthResolver();
    const malformedBackend = new FakeBackend();
    malformedBackend.values.set(target, { not: 'a string' });
    const account = base({
      auth: { kind: 'credential', provider: 'qq', credentialTarget: target },
    });

    for (const operation of [
      () => missingBackend.resolve(account),
      () => new AccountAuthResolver(new FakeBackend()).resolve(account),
      () => new AccountAuthResolver(malformedBackend).resolve(account),
      () => new AccountAuthResolver(new FakeBackend()).resolve(base({
        auth: {
          kind: 'credential',
          provider: 'qq',
          credentialTarget: credentialTarget('qq', 'other@qq.com'),
        },
      })),
    ]) {
      let caught: unknown;
      try { await operation(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain('person@qq.com');
      expect((caught as Error).message).not.toContain('other@qq.com');
      expect((caught as Error).message).not.toContain('CodexLab:');
    }
  });

  it('resolves Gmail through an injected refresh exchange with no password fallback', async () => {
    const backend = new FakeBackend();
    const target = credentialTarget('gmail', 'person@gmail.com');
    backend.write(target, 'gmail-refresh-token');
    const exchange = vi.fn(() => 'gmail-access-token');
    const resolver = new AccountAuthResolver(backend, exchange);
    const account = base({
      host: 'imap.gmail.com', user: 'person@gmail.com', password: 'must-not-be-used',
      auth: { kind: 'oauth2', provider: 'gmail', credentialTarget: target, clientId: 'client-id' },
    });
    await expect(resolver.resolve(account)).resolves.toEqual({
      kind: 'oauth2', user: 'person@gmail.com', accessToken: 'gmail-access-token',
    });
    expect(exchange).toHaveBeenCalledWith('gmail-refresh-token', account);
    expect(backend.handles[0].disposed).toBe(true);
  });

  it('fails explicitly when credential metadata has no production backend', async () => {
    const target = credentialTarget('qq', 'person@qq.com');
    const resolver = new AccountAuthResolver();
    await expect(resolver.resolve(base({ auth: { kind: 'credential', provider: 'qq', credentialTarget: target } })))
      .rejects.toThrow(/credential backend.*not configured/i);
  });

  it.each([
    ['QQ metadata pointing at a Gmail target', base({
      auth: { kind: 'credential', provider: 'qq', credentialTarget: credentialTarget('gmail', 'person@qq.com') },
    })],
    ['Gmail metadata pointing at a QQ target', base({
      host: 'imap.gmail.com', user: 'person@gmail.com',
      auth: { kind: 'oauth2', provider: 'gmail', credentialTarget: credentialTarget('qq', 'person@gmail.com') },
    })],
    ['account A metadata pointing at account B', base({
      auth: { kind: 'credential', provider: 'qq', credentialTarget: credentialTarget('qq', 'other@qq.com') },
    })],
    ['QQ metadata with a refresh-token suffix', base({
      auth: { kind: 'credential', provider: 'qq', credentialTarget: 'CodexLab:QQMail:person@qq.com:refresh_token' },
    })],
    ['Gmail client-secret metadata pointing at account B', base({
      host: 'imap.gmail.com', user: 'person@gmail.com',
      auth: {
        kind: 'oauth2',
        provider: 'gmail',
        credentialTarget: credentialTarget('gmail', 'person@gmail.com'),
        clientSecretTarget: gmailClientSecretTarget('other@gmail.com'),
      },
    })],
  ])('rejects %s before reading the credential backend', async (_case, account) => {
    const backend = new FakeBackend();
    const resolver = new AccountAuthResolver(backend);
    await expect(resolver.resolve(account)).rejects.toThrow(/credential target.*mismatch/i);
    expect(backend.reads).toEqual([]);
  });

  it('uses the SMTP-specific user with a credential-backed account', async () => {
    const backend = new FakeBackend();
    const target = credentialTarget('qq', 'person@qq.com');
    backend.write(target, 'qq-authorization-code');
    const resolver = new AccountAuthResolver(backend);
    const account = base({
      auth: { kind: 'credential', provider: 'qq', credentialTarget: target },
      smtp: { host: 'smtp.qq.com', port: 465, secure: true, user: 'smtp-login@qq.com' },
    });
    await expect(resolver.resolve(account, 'smtp')).resolves.toEqual({
      kind: 'password', user: 'smtp-login@qq.com', password: 'qq-authorization-code',
    });
  });

  it('persists only non-secret account metadata for credential-backed accounts', () => {
    const target = credentialTarget('qq', 'person@qq.com');
    const stored = accountForPersistence(base({
      password: 'qq-authorization-code',
      smtp: { host: 'smtp.qq.com', port: 465, secure: true, password: 'qq-authorization-code' },
      auth: { kind: 'credential', provider: 'qq', credentialTarget: target },
    }));
    const json = JSON.stringify(stored);
    expect(json).not.toContain('qq-authorization-code');
    expect(stored.password).toBe('');
    expect(stored.smtp?.password).toBeUndefined();
    expect(stored.auth).toEqual({ kind: 'credential', provider: 'qq', credentialTarget: target });
  });
});
