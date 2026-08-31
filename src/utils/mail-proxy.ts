import { normalizeProxyEnvironment } from '../credentials/proxy-fetch.js';

const SUPPORTED_MAIL_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
]);

function bypassesProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const normalizedHost = host.trim().toLowerCase();
  return noProxy.split(',').some((entry) => {
    const token = entry.trim().toLowerCase();
    if (!token) return false;
    if (token === '*') return true;
    const withoutPort = token.replace(/:\d+$/, '');
    const suffix = withoutPort.startsWith('.') ? withoutPort : '.' + withoutPort;
    return normalizedHost === withoutPort || normalizedHost.endsWith(suffix);
  });
}

export function resolveMailProxy(
  env: NodeJS.ProcessEnv = process.env,
  targetHost?: string,
): string | undefined {
  const normalized = normalizeProxyEnvironment(env);
  if (targetHost && bypassesProxy(targetHost, normalized.noProxy)) return undefined;

  const configured = env.IMAP_MCP_MAIL_PROXY?.trim()
    || normalized.httpsProxy
    || normalized.httpProxy;
  if (!configured) return undefined;

  try {
    const parsed = new URL(configured);
    if (!parsed.hostname || !SUPPORTED_MAIL_PROXY_PROTOCOLS.has(parsed.protocol)) {
      throw new Error('unsupported');
    }
  } catch {
    throw new Error('IMAP_MCP_MAIL_PROXY must be a supported proxy URL');
  }

  return configured;
}