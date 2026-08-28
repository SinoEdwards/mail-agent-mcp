import { describe, expect, it, vi } from 'vitest';
import type { ImapAccount } from '../src/types/index.js';
import type { CredentialBackend, SecretHandle } from '../src/credentials/credential-backend.js';
import {
  createGmailAccessTokenExchange,
  type TokenFetch,
} from '../src/credentials/gmail-token-exchange.js';

const gmailAccount = (clientId: string | null = 'client-id'): ImapAccount =>
  ({
    user: 'test@example.com',
    auth: {
      kind: 'oauth2',
      provider: 'gmail',
      credentialTarget: 'CodexLab:Gmail:test@example.com:refresh_token',
      ...(clientId === null ? {} : { clientId }),
    },
  }) as ImapAccount;

const response = (status: number, body: unknown): Awaited<ReturnType<TokenFetch>> => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn().mockResolvedValue(body),
});

const credentials = (values: Record<string, string>): CredentialBackend => ({
  read: (target: string): SecretHandle | undefined => {
    const value = values[target];
    return value === undefined ? undefined : { read: () => value, dispose: vi.fn() };
  },
  write: vi.fn(),
  delete: vi.fn(),
});

describe('createGmailAccessTokenExchange', () => {
  it('posts the refresh-token grant and returns the access token', async () => {
    const tokenFetch = vi.fn<TokenFetch>().mockResolvedValue(response(200, { access_token: 'access-token' }));
    const exchange = createGmailAccessTokenExchange({ fetch: tokenFetch });

    await expect(exchange('refresh-token', gmailAccount())).resolves.toBe('access-token');
    const [url, init] = tokenFetch.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(init.body.get('client_id')).toBe('client-id');
    expect(init.body.get('refresh_token')).toBe('refresh-token');
    expect(init.body.get('grant_type')).toBe('refresh_token');
  });

  it('does not probe a stale client-secret target for a legacy public-client account', async () => {
    const tokenFetch = vi.fn<TokenFetch>().mockResolvedValue(response(200, { access_token: 'access-token' }));
    const backend = credentials({
      'CodexLab:Gmail:test@example.com:client_secret': 'stale-secret',
    });
    const read = vi.spyOn(backend, 'read');
    const exchange = createGmailAccessTokenExchange({ fetch: tokenFetch, credentials: backend });

    await exchange('refresh-token', gmailAccount());
    expect(read).not.toHaveBeenCalled();
    expect(tokenFetch.mock.calls[0]![1].body.has('client_secret')).toBe(false);
  });

  it('adds the bound client secret to the refresh grant', async () => {
    const target = 'CodexLab:Gmail:test@example.com:client_secret';
    const account = gmailAccount();
    if (account.auth?.kind === 'oauth2') account.auth.clientSecretTarget = target;
    const tokenFetch = vi.fn<TokenFetch>().mockResolvedValue(response(200, { access_token: 'access-token' }));
    const exchange = createGmailAccessTokenExchange({
      fetch: tokenFetch,
      credentials: credentials({ [target]: 'client+/=&secret' }),
    });

    await exchange('refresh-token', account);
    expect(tokenFetch.mock.calls[0]![1].body.get('client_secret')).toBe('client+/=&secret');
  });

  it('fails before fetch when a configured client secret is missing', async () => {
    const target = 'CodexLab:Gmail:test@example.com:client_secret';
    const account = gmailAccount();
    if (account.auth?.kind === 'oauth2') account.auth.clientSecretTarget = target;
    const tokenFetch = vi.fn<TokenFetch>();
    const exchange = createGmailAccessTokenExchange({ fetch: tokenFetch, credentials: credentials({}) });

    await expect(exchange('refresh-token', account)).rejects.toThrow(/client secret/i);
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it('reports only the HTTP status for provider errors', async () => {
    const tokenFetch = vi.fn<TokenFetch>().mockResolvedValue(response(400, { error: 'sensitive provider body' }));
    const exchange = createGmailAccessTokenExchange({ fetch: tokenFetch });
    await expect(exchange('secret-refresh-token', gmailAccount())).rejects.toThrow(
      'Gmail token exchange failed with status 400',
    );
  });

  it('uses a generic message when fetch rejects', async () => {
    const tokenFetch = vi.fn<TokenFetch>().mockRejectedValue(new Error('secret-bearing network detail'));
    const exchange = createGmailAccessTokenExchange({ fetch: tokenFetch });
    let error: unknown;
    try {
      await exchange('secret-refresh-token', gmailAccount());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Gmail token exchange request failed');
    expect((error as Error).message).not.toMatch(/secret-refresh-token|secret-bearing/);
  });

  it('rejects malformed JSON', async () => {
    const tokenFetch = vi.fn<TokenFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('malformed')),
    });
    const exchange = createGmailAccessTokenExchange({ fetch: tokenFetch });
    await expect(exchange('refresh-token', gmailAccount())).rejects.toThrow(
      'Gmail token exchange returned invalid JSON',
    );
  });

  it.each([{}, { access_token: '' }, { access_token: 42 }])(
    'rejects a missing or empty access token: %j',
    async (body) => {
      const tokenFetch = vi.fn<TokenFetch>().mockResolvedValue(response(200, body));
      const exchange = createGmailAccessTokenExchange({ fetch: tokenFetch });
      await expect(exchange('refresh-token', gmailAccount())).rejects.toThrow(
        'Gmail token exchange returned no access token',
      );
    },
  );

  it('rejects missing clientId without making a request', async () => {
    const tokenFetch = vi.fn<TokenFetch>();
    const exchange = createGmailAccessTokenExchange({ fetch: tokenFetch });
    await expect(exchange('refresh-token', gmailAccount(null))).rejects.toThrow(
      'Gmail OAuth clientId is missing',
    );
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it('aborts a token request after the configured timeout', async () => {
    const tokenFetch: TokenFetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));
    const exchange = createGmailAccessTokenExchange({ fetch: tokenFetch, timeoutMs: 5 });
    await expect(exchange('refresh-token', gmailAccount())).rejects.toThrow(
      'Gmail token exchange timed out',
    );
  });
});
