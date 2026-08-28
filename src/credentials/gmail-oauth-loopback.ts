import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createProxyAwareFetch } from './proxy-fetch.js';

export const GMAIL_OAUTH_SUCCESS_TEXT =
  'Authorization complete. You can close this window.';
export const GMAIL_OAUTH_FAILURE_TEXT =
  'Authorization failed. You can close this window and return to the terminal.';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPE = 'https://mail.google.com/';
const DEFAULT_TIMEOUT_MS = 180_000;
const CALLBACK_PATH = '/oauth2/callback';
const SAFE_TOKEN_ERROR_CODES = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
]);

export interface GmailOAuthLoopbackOptions {
  clientId: string;
  clientSecret?: string;
  loginHint?: string;
  openBrowser: (authorizationUrl: string) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** Test seam for loopback bind failures; production uses 127.0.0.1:0. */
  listen?: (server: Server) => Promise<number>;
}

export interface GmailOAuthLoopbackResult {
  refreshToken: string;
  redirectUri: string;
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

function writeBrowserResponse(
  response: ServerResponse,
  statusCode: number,
  text: string,
): void {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
  });
  response.end(text);
}

interface SafeTokenError {
  code: string;
  category?: string;
}

function classifyInvalidRequestDescription(
  description: unknown,
): string | undefined {
  if (typeof description !== 'string' || description.length > 512) {
    return undefined;
  }
  const value = description.toLowerCase();
  const reason = /\b(missing|required|invalid|mismatch|unsupported|malformed)\b/;
  if (!reason.test(value)) return undefined;

  const candidates = [
    [/\bclient_secret\b/, 'client_secret_required'],
    [/\bredirect_uri\b/, 'redirect_uri_rejected'],
    [/\b(code_verifier|code_challenge|pkce)\b/, 'pkce_rejected'],
    [/(\bauthorization[_ ]code\b|\bparameter\s*:?\s*code\b)/, 'code_rejected'],
    [/\bgrant_type\b/, 'grant_type_rejected'],
    [/\bclient_id\b/, 'client_id_rejected'],
  ] as const;
  const matches = candidates.filter(([pattern]) => pattern.test(value));
  return matches.length === 1 ? matches[0]![1] : undefined;
}

async function readSafeTokenError(
  response: Response,
): Promise<SafeTokenError | undefined> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return undefined;
  }
  if (
    typeof payload !== 'object'
    || payload === null
    || Array.isArray(payload)
    || !('error' in payload)
    || typeof payload.error !== 'string'
  ) {
    return undefined;
  }
  if (!SAFE_TOKEN_ERROR_CODES.has(payload.error)) return undefined;
  const category = payload.error === 'invalid_request'
    && 'error_description' in payload
    ? classifyInvalidRequestDescription(payload.error_description)
    : undefined;
  return { code: payload.error, ...(category ? { category } : {}) };
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: '127.0.0.1', port: 0 });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Gmail OAuth loopback server has no TCP address');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Runs Google's installed-app authorization-code flow with PKCE and a
 * random-port 127.0.0.1 callback.
 *
 * https://developers.google.com/identity/protocols/oauth2/native-app
 * https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
 */
export async function runGmailOAuthLoopback(
  options: GmailOAuthLoopbackOptions,
): Promise<GmailOAuthLoopbackResult> {
  const clientId = options.clientId.trim();
  if (!clientId) throw new Error('Gmail OAuth client ID is required');

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Gmail OAuth timeout must be greater than zero');
  }

  const transport = options.fetch ? undefined : createProxyAwareFetch();
  const fetchImpl = options.fetch ?? transport!.fetch;
  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(
    createHash('sha256').update(verifier, 'ascii').digest(),
  );

  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const callback = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void callback.catch(() => undefined);

  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectCode(error);
  };
  const succeed = (code: string): void => {
    if (settled) return;
    settled = true;
    resolveCode(code);
  };

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || requestUrl.pathname !== CALLBACK_PATH) {
        writeBrowserResponse(response, 404, GMAIL_OAUTH_FAILURE_TEXT);
        return;
      }
      if (requestUrl.searchParams.get('state') !== state) {
        writeBrowserResponse(response, 400, GMAIL_OAUTH_FAILURE_TEXT);
        fail(new Error('Gmail OAuth state validation failed'));
        return;
      }
      if (requestUrl.searchParams.has('error')) {
        writeBrowserResponse(response, 400, GMAIL_OAUTH_FAILURE_TEXT);
        fail(new Error('Gmail authorization was not completed'));
        return;
      }
      const code = requestUrl.searchParams.get('code');
      if (!code) {
        writeBrowserResponse(response, 400, GMAIL_OAUTH_FAILURE_TEXT);
        fail(new Error('Gmail OAuth callback contained no authorization code'));
        return;
      }
      writeBrowserResponse(response, 200, GMAIL_OAUTH_SUCCESS_TEXT);
      succeed(code);
    } catch {
      writeBrowserResponse(response, 400, GMAIL_OAUTH_FAILURE_TEXT);
      fail(new Error('Gmail OAuth callback was invalid'));
    }
  });
  server.on('error', () => fail(new Error('Gmail OAuth loopback server failed')));

  let callbackTimer: NodeJS.Timeout | undefined;
  try {
    let port: number;
    try {
      port = await (options.listen ?? listenOnLoopback)(server);
    } catch {
      throw new Error('Gmail OAuth loopback server failed');
    }
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const authorizationUrl = new URL(
      options.authorizationEndpoint ?? AUTHORIZATION_ENDPOINT,
    );
    authorizationUrl.searchParams.set('client_id', clientId);
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', GMAIL_SCOPE);
    authorizationUrl.searchParams.set('access_type', 'offline');
    authorizationUrl.searchParams.set('prompt', 'consent');
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    if (options.loginHint?.trim()) {
      authorizationUrl.searchParams.set('login_hint', options.loginHint.trim());
    }

    callbackTimer = setTimeout(
      () => fail(new Error('Gmail OAuth authorization timed out')),
      timeoutMs,
    );

    try {
      await options.openBrowser(authorizationUrl.toString());
    } catch {
      throw new Error('Could not open the Gmail authorization page');
    }
    const code = await callback;

    const controller = new AbortController();
    const tokenTimer = setTimeout(() => controller.abort(), timeoutMs);
    let tokenResponse: Response;
    try {
      try {
        const tokenBody = new URLSearchParams({
          client_id: clientId,
          code,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        });
        const clientSecret = options.clientSecret?.trim();
        if (clientSecret) tokenBody.set('client_secret', clientSecret);
        tokenResponse = await fetchImpl(
          options.tokenEndpoint ?? TOKEN_ENDPOINT,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              accept: 'application/json',
            },
            body: tokenBody,
            signal: controller.signal,
            redirect: 'error',
          },
        );
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('Gmail OAuth token exchange timed out');
        }
        throw new Error('Gmail OAuth token exchange request failed');
      }
    } finally {
      clearTimeout(tokenTimer);
    }

    if (!tokenResponse.ok) {
      const safeError = await readSafeTokenError(tokenResponse);
      const errorSuffix = safeError
        ? ` (${safeError.code}${safeError.category ? `: ${safeError.category}` : ''})`
        : '';
      throw new Error(
        `Gmail OAuth token exchange failed with status ${tokenResponse.status}`
        + errorSuffix,
      );
    }

    let payload: unknown;
    try {
      payload = await tokenResponse.json();
    } catch {
      throw new Error('Gmail OAuth token exchange returned invalid JSON');
    }
    const refreshToken =
      typeof payload === 'object'
      && payload !== null
      && 'refresh_token' in payload
      && typeof payload.refresh_token === 'string'
        ? payload.refresh_token.trim()
        : '';
    if (!refreshToken) {
      throw new Error('Gmail OAuth token exchange returned no refresh token');
    }
    return { refreshToken, redirectUri };
  } finally {
    if (callbackTimer) clearTimeout(callbackTimer);
    try {
      await closeServer(server);
    } finally {
      await transport?.close();
    }
  }
}
