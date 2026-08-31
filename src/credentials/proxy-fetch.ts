import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';

export interface ProxyEnvironment {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY?: string;
  http_proxy?: string;
  https_proxy?: string;
  no_proxy?: string;
}

export interface ProxyFetchDependencies {
  createAgent?: (options: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
  }) => Dispatcher;
  request?: typeof undiciFetch;
}

export interface ProxyAwareFetch {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
  usingProxy: boolean;
}

function value(primary: string | undefined, fallback: string | undefined): string | undefined {
  const result = primary?.trim() || fallback?.trim();
  return result || undefined;
}

export interface NormalizedProxyEnvironment {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

export function normalizeProxyEnvironment(
  env: ProxyEnvironment = process.env,
): NormalizedProxyEnvironment {
  const httpProxy = value(env.HTTP_PROXY, env.http_proxy);
  const httpsProxy = value(env.HTTPS_PROXY, env.https_proxy);
  const noProxy = value(env.NO_PROXY, env.no_proxy);
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  };
}

export function createProxyAwareFetch(
  env: ProxyEnvironment = process.env,
  dependencies: ProxyFetchDependencies = {},
): ProxyAwareFetch {
  const { httpProxy, httpsProxy, noProxy } = normalizeProxyEnvironment(env);
  if (!httpProxy && !httpsProxy) {
    return {
      fetch: (...args) => globalThis.fetch(...args),
      close: async () => undefined,
      usingProxy: false,
    };
  }

  const dispatcher = (dependencies.createAgent ?? ((options) => new EnvHttpProxyAgent(options)))({
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  });
  const request = dependencies.request ?? undiciFetch;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const response = await request(input as string | URL, {
      ...(init as UndiciRequestInit | undefined),
      dispatcher,
    });
    return response as unknown as Response;
  };

  return {
    fetch: fetchImpl,
    close: async () => { await dispatcher.close(); },
    usingProxy: true,
  };
}
