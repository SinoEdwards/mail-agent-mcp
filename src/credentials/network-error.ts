export type NetworkErrorCategory = 'dns' | 'tcp' | 'tls' | 'timeout' | 'unknown';

export function classifyNetworkError(error: unknown): NetworkErrorCategory {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as { name?: unknown; code?: unknown; cause?: unknown };
    const name = typeof record.name === 'string' ? record.name : '';
    const code = typeof record.code === 'string' ? record.code.toUpperCase() : '';

    if (
      name === 'AbortError'
      || name === 'TimeoutError'
      || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)
    ) return 'timeout';
    if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(code)) return 'dns';
    if (
      code.startsWith('ERR_TLS_')
      || code.startsWith('CERT_')
      || ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)
    ) return 'tls';
    if (
      ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)
    ) return 'tcp';
    current = record.cause;
  }
  return 'unknown';
}
