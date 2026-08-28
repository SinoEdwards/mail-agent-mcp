const SUPPORTED_MAIL_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
]);

export function resolveMailProxy(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.IMAP_MCP_MAIL_PROXY?.trim();
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
