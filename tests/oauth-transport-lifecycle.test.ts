import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImapAccount } from '../src/types/index.js';

const proxyMocks = vi.hoisted(() => ({
  createProxyAwareFetch: vi.fn(),
}));

vi.mock('../src/credentials/proxy-fetch.js', () => ({
  createProxyAwareFetch: proxyMocks.createProxyAwareFetch,
}));

import { createGmailAccessTokenExchange } from '../src/credentials/gmail-token-exchange.js';
import { runGmailOAuthLoopback } from '../src/credentials/gmail-oauth-loopback.js';

const account = {
  user: 'test@example.com',
  auth: {
    kind: 'oauth2',
    provider: 'gmail',
    clientId: 'client-id',
    credentialTarget: 'fixture-refresh-target',
  },
} as ImapAccount;

function installTransport(fetchImpl: typeof globalThis.fetch) {
  const close = vi.fn(async () => undefined);
  proxyMocks.createProxyAwareFetch.mockReturnValue({ fetch: fetchImpl, close, usingProxy: true });
  return close;
}

async function completeAuthorization(authorizationUrl: string): Promise<void> {
  const auth = new URL(authorizationUrl);
  const callback = new URL(auth.searchParams.get('redirect_uri')!);
  callback.searchParams.set('code', 'fixture-authorization-code');
  callback.searchParams.set('state', auth.searchParams.get('state')!);
  await fetch(callback);
}

function abortingFetch(): typeof globalThis.fetch {
  return vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }));
}

beforeEach(() => {
  proxyMocks.createProxyAwareFetch.mockReset();
});

describe('OAuth proxy transport lifecycle', () => {
  it.each([
    ['success', async () => new Response(JSON.stringify({ access_token: 'fixture-access-token' }), { status: 200 })],
    ['provider failure', async () => new Response('{}', { status: 400 })],
    ['request failure', async () => { throw new Error('fixture network failure'); }],
  ])('closes the Gmail refresh transport exactly once after %s', async (_case, fetchImpl) => {
    const close = installTransport(vi.fn(fetchImpl) as typeof globalThis.fetch);
    const exchange = createGmailAccessTokenExchange();
    await exchange('fixture-refresh-token', account).catch(() => undefined);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the Gmail refresh transport exactly once after timeout', async () => {
    const close = installTransport(abortingFetch());
    const exchange = createGmailAccessTokenExchange({ timeoutMs: 5 });
    await expect(exchange('fixture-refresh-token', account)).rejects.toThrow(/timed out/i);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['success', async () => new Response(JSON.stringify({ refresh_token: 'fixture-refresh-token' }), { status: 200 })],
    ['provider failure', async () => new Response('{}', { status: 400 })],
    ['request failure', async () => { throw new Error('fixture network failure'); }],
    ['invalid JSON', async () => new Response('{', { status: 200 })],
    ['missing refresh token', async () => new Response('{}', { status: 200 })],
  ])('closes the Gmail enrollment transport exactly once after %s', async (_case, fetchImpl) => {
    const close = installTransport(vi.fn(fetchImpl) as typeof globalThis.fetch);
    await runGmailOAuthLoopback({
      clientId: 'client-id',
      timeoutMs: 2_000,
      openBrowser: completeAuthorization,
    }).catch(() => undefined);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the Gmail enrollment transport exactly once after token timeout', async () => {
    const close = installTransport(abortingFetch());
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      timeoutMs: 10,
      openBrowser: completeAuthorization,
    })).rejects.toThrow(/token exchange timed out/i);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the Gmail enrollment transport exactly once after authorization timeout', async () => {
    const close = installTransport(vi.fn() as typeof globalThis.fetch);
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id', timeoutMs: 10, openBrowser: () => undefined,
    })).rejects.toThrow(/authorization timed out/i);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the Gmail enrollment transport exactly once after browser failure', async () => {
    const close = installTransport(vi.fn() as typeof globalThis.fetch);
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      openBrowser: () => { throw new Error('fixture browser failure'); },
    })).rejects.toThrow(/could not open/i);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the Gmail enrollment transport exactly once after bind failure', async () => {
    const close = installTransport(vi.fn() as typeof globalThis.fetch);
    await expect(runGmailOAuthLoopback({
      clientId: 'client-id',
      openBrowser: () => undefined,
      listen: async () => { throw new Error('fixture bind failure'); },
    })).rejects.toThrow(/loopback server failed/i);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
