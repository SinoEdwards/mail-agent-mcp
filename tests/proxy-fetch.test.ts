import { describe, expect, it, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import { createProxyAwareFetch } from '../src/credentials/proxy-fetch.js';

describe('createProxyAwareFetch', () => {
  it('passes standard proxy environment values to a request dispatcher and closes it', async () => {
    const close = vi.fn(async () => undefined);
    const dispatcher = { close } as unknown as Dispatcher;
    const createAgent = vi.fn(() => dispatcher);
    const request = vi.fn(async (_input: unknown, init: Record<string, unknown>) => {
      expect(init.dispatcher).toBe(dispatcher);
      return new Response('{}');
    });
    const transport = createProxyAwareFetch({
      HTTP_PROXY: 'http://proxy.example:8080',
      HTTPS_PROXY: 'http://secure-proxy.example:8443',
      NO_PROXY: '127.0.0.1,localhost',
    }, { createAgent, request: request as never });

    expect(transport.usingProxy).toBe(true);
    expect(createAgent).toHaveBeenCalledWith({
      httpProxy: 'http://proxy.example:8080',
      httpsProxy: 'http://secure-proxy.example:8443',
      noProxy: '127.0.0.1,localhost',
    });
    await transport.fetch('https://oauth2.googleapis.com/token');
    await transport.close();
    expect(request).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('uses global fetch and creates no dispatcher when no proxy is configured', async () => {
    const createAgent = vi.fn();
    const original = globalThis.fetch;
    const fetch = vi.fn(async () => new Response('{}'));
    globalThis.fetch = fetch;
    try {
      const transport = createProxyAwareFetch({}, { createAgent });
      expect(transport.usingProxy).toBe(false);
      await transport.fetch('http://127.0.0.1/fixture');
      await transport.close();
      expect(fetch).toHaveBeenCalledOnce();
      expect(createAgent).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
