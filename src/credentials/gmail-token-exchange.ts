import type { ImapAccount } from '../types/index.js';
import type { CredentialBackend } from './credential-backend.js';
import { gmailClientSecretTargetsForAccount } from './credential-backend.js';
import { createProxyAwareFetch, type ProxyEnvironment, type ProxyFetchDependencies } from './proxy-fetch.js';
import { classifyNetworkError } from './network-error.js';

const GMAIL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_TIMEOUT_MS = 15_000;
const SAFE_OAUTH_ERRORS = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
]);

function safeOAuthError(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const error = (payload as { error?: unknown }).error;
  return typeof error === 'string' && SAFE_OAUTH_ERRORS.has(error) ? error : undefined;
}

interface TokenResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type TokenFetch = (
  input: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: URLSearchParams;
    signal: AbortSignal;
  },
) => Promise<TokenResponse>;

export interface GmailTokenExchangeOptions {
  fetch?: TokenFetch;
  timeoutMs?: number;
  credentials?: CredentialBackend;
  proxyEnvironment?: ProxyEnvironment;
  proxyFetchDependencies?: ProxyFetchDependencies;
}

function readClientSecret(backend: CredentialBackend, target: string): string {
  const handle = backend.read(target);
  if (!handle) throw new Error('Gmail OAuth client secret is missing');
  try {
    const value = handle.read();
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error('Gmail OAuth client secret is invalid');
    }
    return value.trim();
  } finally {
    handle.dispose();
  }
}

/**
 * Exchanges a stored refresh token for a short-lived Gmail access token.
 *
 * Google OAuth installed-app and loopback guidance:
 * https://developers.google.com/identity/protocols/oauth2/native-app
 * Gmail XOAUTH2:
 * https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
 */
export function createGmailAccessTokenExchange(
  options: GmailTokenExchangeOptions = {},
): (refreshToken: string, account: ImapAccount) => Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (refreshToken: string, account: ImapAccount): Promise<string> => {
    const auth = account.auth;
    if (auth?.kind !== 'oauth2' || auth.provider !== 'gmail' || !auth.clientId?.trim()) {
      throw new Error('Gmail OAuth clientId is missing');
    }
    let clientSecret: string | undefined;
    if (auth.clientSecretTarget !== undefined) {
      if (!gmailClientSecretTargetsForAccount(account.user).includes(auth.clientSecretTarget)) {
        throw new Error('Gmail OAuth client secret target mismatch');
      }
      if (!options.credentials) {
        throw new Error('Gmail OAuth client secret backend is not configured');
      }
      clientSecret = readClientSecret(options.credentials, auth.clientSecretTarget);
    }

    const transport = options.fetch
      ? undefined
      : createProxyAwareFetch(options.proxyEnvironment, options.proxyFetchDependencies);
    const tokenFetch: TokenFetch = options.fetch
      ?? ((input, init) => transport!.fetch(input, init) as Promise<TokenResponse>);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: TokenResponse;
      try {
        const body = new URLSearchParams({
          client_id: auth.clientId,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        });
        if (clientSecret) body.set('client_secret', clientSecret);
        response = await tokenFetch(GMAIL_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        const category = classifyNetworkError(error);
        if (category === 'timeout' && error instanceof Error && error.name === 'AbortError') {
          throw new Error('Gmail token exchange timed out');
        }
        throw new Error('Gmail token exchange request failed (' + category + ')');
      }

      if (!response.ok) {
        let oauthError: string | undefined;
        try {
          oauthError = safeOAuthError(await response.json());
        } catch {
          // A malformed provider body must not hide the safe HTTP status.
        }
        const suffix = oauthError ? ' (' + oauthError + ')' : '';
        throw new Error('Gmail token exchange failed with status ' + response.status + suffix);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('Gmail token exchange returned invalid JSON');
      }

      if (
        typeof payload !== 'object'
        || payload === null
        || !('access_token' in payload)
        || typeof payload.access_token !== 'string'
        || payload.access_token.trim() === ''
      ) {
        throw new Error('Gmail token exchange returned no access token');
      }

      return payload.access_token;
    } finally {
      clearTimeout(timer);
      await transport?.close();
    }
  };
}
