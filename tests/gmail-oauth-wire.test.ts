import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runGmailOAuthLoopback } from '../src/credentials/gmail-oauth-loopback.js';

const SYNTHETIC_CLIENT_SECRET_1 = ["client+/", "=&secret"].join('');

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe('Gmail OAuth token request wire format', () => {
  it('sends the exact form fields and preserves redirect URI and PKCE verifier', async () => {
    let method = '';
    let contentType = '';
    let rawBody = '';
    const tokenServer = createServer(async (request, response) => {
      method = request.method ?? '';
      contentType = String(request.headers['content-type'] ?? '');
      for await (const chunk of request) rawBody += chunk.toString();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ refresh_token: 'fixture-refresh-token' }));
    });
    servers.push(tokenServer);
    await new Promise<void>((resolve) => {
      tokenServer.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = tokenServer.address();
    if (!address || typeof address === 'string') throw new Error('no token server port');

    let authorizationUrl: URL | undefined;
    await runGmailOAuthLoopback({
      clientId: 'desktop-client-id',
      clientSecret: SYNTHETIC_CLIENT_SECRET_1,
      tokenEndpoint: 'http://127.0.0.1:' + address.port + '/token',
      timeoutMs: 2_000,
      openBrowser: async (value) => {
        authorizationUrl = new URL(value);
        const callback = new URL(
          authorizationUrl.searchParams.get('redirect_uri')!,
        );
        callback.searchParams.set('code', 'fixture-authorization-code');
        callback.searchParams.set(
          'state',
          authorizationUrl.searchParams.get('state')!,
        );
        await fetch(callback);
      },
    });

    const form = new URLSearchParams(rawBody);
    const redirectUri = authorizationUrl!.searchParams.get('redirect_uri')!;
    const verifier = form.get('code_verifier')!;
    const expectedChallenge = createHash('sha256')
      .update(verifier, 'ascii')
      .digest('base64url');

    expect(method).toBe('POST');
    expect(contentType).toBe('application/x-www-form-urlencoded');
    expect([...form.keys()].sort()).toEqual([
      'client_id',
      'client_secret',
      'code',
      'code_verifier',
      'grant_type',
      'redirect_uri',
    ]);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_id')).toBe('desktop-client-id');
    expect(form.get('client_secret')).toBe('client+/=&secret');
    expect(authorizationUrl!.searchParams.has('client_secret')).toBe(false);
    expect(form.get('code')).toBe('fixture-authorization-code');
    expect(form.get('redirect_uri')).toBe(redirectUri);
    expect(form.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/,
    );
    expect(rawBody).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A');
    expect(authorizationUrl!.searchParams.get('code_challenge')).toBe(
      expectedChallenge,
    );
    expect(authorizationUrl!.searchParams.get('code_challenge_method')).toBe('S256');
  });
});
