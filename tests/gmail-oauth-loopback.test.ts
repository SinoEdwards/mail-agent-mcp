import { describe, expect, it, vi } from 'vitest';
import {
  GMAIL_OAUTH_FAILURE_TEXT,
  GMAIL_OAUTH_SUCCESS_TEXT,
  runGmailOAuthLoopback,
} from '../src/credentials/gmail-oauth-loopback.js';

const SYNTHETIC_REFRESH_TOKEN_1 = ["refres", "h-token"].join('');

describe('runGmailOAuthLoopback', () => {
  it('uses 127.0.0.1, PKCE, state and the same redirect URI for exchange', async () => {
    let authorizationUrl: URL | undefined;
    let tokenBody: URLSearchParams | undefined;
    const tokenFetch = vi.fn<typeof fetch>(async (_input, init) => {
      tokenBody = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({ refresh_token: 'refresh-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await runGmailOAuthLoopback({
      clientId: 'client-id',
      loginHint: 'person@gmail.com',
      fetch: tokenFetch,
      timeoutMs: 2_000,
      openBrowser: async (value) => {
        authorizationUrl = new URL(value);
        const callback = new URL(
          authorizationUrl.searchParams.get('redirect_uri')!,
        );
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set(
          'state',
          authorizationUrl.searchParams.get('state')!,
        );
        const response = await fetch(callback);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(GMAIL_OAUTH_SUCCESS_TEXT);
      },
    });

    const redirectUri = authorizationUrl!.searchParams.get('redirect_uri')!;
    const redirect = new URL(redirectUri);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(authorizationUrl!.searchParams.get('scope')).toBe(
      'https://mail.google.com/',
    );
    expect(authorizationUrl!.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl!.searchParams.get('code_challenge')).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect(authorizationUrl!.searchParams.get('login_hint')).toBe(
      'person@gmail.com',
    );
    expect(result).toEqual({ refreshToken: SYNTHETIC_REFRESH_TOKEN_1, redirectUri });
    expect(tokenBody!.get('client_id')).toBe('client-id');
    expect(tokenBody!.get('client_secret')).toBeNull();
    expect(tokenBody!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenBody!.get('redirect_uri')).toBe(redirectUri);
  });

  it('rejects a mismatched state without exchanging a token', async () => {
    const tokenFetch = vi.fn<typeof fetch>();
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      fetch: tokenFetch,
      timeoutMs: 2_000,
      openBrowser: async (value) => {
        const auth = new URL(value);
        const callback = new URL(auth.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set('state', 'wrong');
        const response = await fetch(callback);
        expect(response.status).toBe(400);
        expect(await response.text()).toBe(GMAIL_OAUTH_FAILURE_TEXT);
      },
    })).rejects.toThrow(/state validation failed/i);
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it('rejects an OAuth error callback without exposing its value', async () => {
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      timeoutMs: 2_000,
      openBrowser: async (value) => {
        const auth = new URL(value);
        const callback = new URL(auth.searchParams.get('redirect_uri')!);
        callback.searchParams.set('error', 'secret-provider-detail');
        callback.searchParams.set('state', auth.searchParams.get('state')!);
        await fetch(callback);
      },
    })).rejects.toThrow('Gmail authorization was not completed');
  });

  it('requires a refresh token from a successful exchange', async () => {
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      timeoutMs: 2_000,
      fetch: async () => new Response(
        JSON.stringify({ access_token: 'access-only' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
      openBrowser: async (value) => {
        const auth = new URL(value);
        const callback = new URL(auth.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set('state', auth.searchParams.get('state')!);
        await fetch(callback);
      },
    })).rejects.toThrow(/no refresh token/i);
  });

  it('reports only status for token endpoint errors', async () => {
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      timeoutMs: 2_000,
      fetch: async () => new Response('sensitive body', { status: 400 }),
      openBrowser: async (value) => {
        const auth = new URL(value);
        const callback = new URL(auth.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set('state', auth.searchParams.get('state')!);
        await fetch(callback);
      },
    })).rejects.toThrow('Gmail OAuth token exchange failed with status 400');
  });

  it('reports an allowlisted OAuth error code without exposing its description', async () => {
    let error: unknown;
    try {
      await runGmailOAuthLoopback({
        clientId: 'client-id',
        timeoutMs: 2_000,
        fetch: async () => new Response(JSON.stringify({
          error: 'invalid_grant',
          error_description: 'authorization-code refresh-token secret-detail',
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
        openBrowser: async (value) => {
          const auth = new URL(value);
          const callback = new URL(auth.searchParams.get('redirect_uri')!);
          callback.searchParams.set('code', 'authorization-code');
          callback.searchParams.set('state', auth.searchParams.get('state')!);
          await fetch(callback);
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Gmail OAuth token exchange failed with status 400 (invalid_grant)',
    );
    expect((error as Error).message).not.toMatch(
      /authorization-code|refresh-token|secret-detail/,
    );
  });

  it('maps a known invalid_request description to a fixed safe category', async () => {
    let error: unknown;
    try {
      await runGmailOAuthLoopback({
        clientId: 'client-id',
        timeoutMs: 2_000,
        fetch: async () => new Response(JSON.stringify({
          error: 'invalid_request',
          error_description: 'Missing required parameter: client_secret secret-detail',
        }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
        openBrowser: async (value) => {
          const auth = new URL(value);
          const callback = new URL(auth.searchParams.get('redirect_uri')!);
          callback.searchParams.set('code', 'authorization-code');
          callback.searchParams.set('state', auth.searchParams.get('state')!);
          await fetch(callback);
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Gmail OAuth token exchange failed with status 400 '
      + '(invalid_request: client_secret_required)',
    );
    expect((error as Error).message).not.toContain('secret-detail');
  });

  it('does not expose unknown or malformed provider error values', async () => {
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      timeoutMs: 2_000,
      fetch: async () => new Response(JSON.stringify({
        error: 'invalid_grant secret-token',
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
      openBrowser: async (value) => {
        const auth = new URL(value);
        const callback = new URL(auth.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set('state', auth.searchParams.get('state')!);
        await fetch(callback);
      },
    })).rejects.toThrow('Gmail OAuth token exchange failed with status 400');
  });

  it('closes the listener when the browser cannot open', async () => {
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      timeoutMs: 2_000,
      openBrowser: async () => { throw new Error('sensitive shell detail'); },
    })).rejects.toThrow('Could not open the Gmail authorization page');
  });

  it('fails closed before opening the browser when loopback binding fails', async () => {
    const openBrowser = vi.fn();
    const tokenFetch = vi.fn<typeof fetch>();
    let error: unknown;
    try {
      await runGmailOAuthLoopback({
        clientId: 'client-id',
        fetch: tokenFetch,
        openBrowser,
        listen: async () => {
          throw new Error('EADDRINUSE secret-local-detail');
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Gmail OAuth loopback server failed');
    expect((error as Error).message).not.toContain('secret-local-detail');
    expect(openBrowser).not.toHaveBeenCalled();
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it('does not expose authorization or token secrets from a rejected exchange', async () => {
    let error: unknown;
    try {
      await runGmailOAuthLoopback({
        clientId: 'client-id',
        timeoutMs: 2_000,
        fetch: async () => {
          throw new Error('authorization-code refresh-token access-token client-secret');
        },
        openBrowser: async (value) => {
          const auth = new URL(value);
          const callback = new URL(auth.searchParams.get('redirect_uri')!);
          callback.searchParams.set('code', 'authorization-code');
          callback.searchParams.set('state', auth.searchParams.get('state')!);
          await fetch(callback);
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Gmail OAuth token exchange request failed (unknown)');
    expect((error as Error).message).not.toMatch(
      /authorization-code|refresh-token|access-token|client-secret/,
    );
  });

  it.each([
    ['dns', 'ENOTFOUND'],
    ['tcp', 'ECONNRESET'],
    ['tls', 'ERR_TLS_CERT_ALTNAME_INVALID'],
    ['timeout', 'ETIMEDOUT'],
  ])('classifies %s token request errors without exposing secrets', async (category, code) => {
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      timeoutMs: 2_000,
      fetch: async () => {
        throw Object.assign(new Error('secret provider detail'), { cause: { code } });
      },
      openBrowser: async (value) => {
        const auth = new URL(value);
        const callback = new URL(auth.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'authorization-code');
        callback.searchParams.set('state', auth.searchParams.get('state')!);
        await fetch(callback);
      },
    })).rejects.toThrow('Gmail OAuth token exchange request failed (' + category + ')');
  });

  it('times out while waiting for authorization', async () => {
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      timeoutMs: 20,
      openBrowser: () => undefined,
    })).rejects.toThrow(/authorization timed out/i);
  });
});
