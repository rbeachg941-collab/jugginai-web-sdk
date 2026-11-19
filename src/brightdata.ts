import { fetch as undiciFetch, ProxyAgent } from "undici";
import { chromium, type Browser } from "playwright-core";
import { BrightDataError, MissingCredentialError } from "./errors.js";

export type { Browser };

export const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

export type IspProxyOptions = {
  country?: string;
  session?: string;
  timeoutMs?: number;
  fetch?: typeof undiciFetch;
  createDispatcher?: (proxyUrl: string) => unknown;
};

export type IspProxyResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

export type BrowserConnectFn = (wsEndpoint: string) => Promise<Browser>;

export type WithBrowserOptions = {
  connect?: BrowserConnectFn;
  wsEndpoint?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new MissingCredentialError(name);
  }
  return value;
}

function readIspProxyEnv(): { host: string; port: string; user: string; pass: string } {
  return {
    host: requiredEnv("BRD_ISP_PROXY_HOST"),
    port: requiredEnv("BRD_ISP_PROXY_PORT"),
    user: requiredEnv("BRD_ISP_PROXY_USER"),
    pass: requiredEnv("BRD_ISP_PROXY_PASS"),
  };
}

function appendUsernameFlags(user: string, options?: { country?: string; session?: string }): string {
  let username = user;
  if (options?.country) {
    username += `-country-${options.country}`;
  }
  if (options?.session) {
    username += `-session-${options.session}`;
  }
  return username;
}

/** Build an HTTP proxy URL. Do not log the return value; it contains credentials. */
export function buildIspProxyUrl(options?: { country?: string; session?: string }): string {
  const { host, port, user, pass } = readIspProxyEnv();
  const username = appendUsernameFlags(user, options);
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

function headerRecord(headers: { forEach: (cb: (value: string, key: string) => void) => void }): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Bright Data request failed";
}

export async function fetchViaIspProxy(url: string, options: IspProxyOptions = {}): Promise<IspProxyResponse> {
  const proxyUrl = buildIspProxyUrl({ country: options.country, session: options.session });
  const createDispatcher = options.createDispatcher ?? ((endpoint: string) => new ProxyAgent(endpoint));
  const dispatcher = createDispatcher(proxyUrl);
  const fetchFn = options.fetch ?? undiciFetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;

  try {
    const response = await fetchFn(url, {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    } as Parameters<typeof undiciFetch>[1]);
    return {
      status: response.status,
      body: await response.text(),
      headers: headerRecord(response.headers),
    };
  } catch (error) {
    if (error instanceof MissingCredentialError || error instanceof BrightDataError) {
      throw error;
    }
    throw new BrightDataError(`ISP proxy request failed: ${asMessage(error)}`, "ISP_PROXY_REQUEST_FAILED", {
      cause: error,
    });
  }
}

export async function withBrowser<T>(fn: (browser: Browser) => Promise<T>, options: WithBrowserOptions = {}): Promise<T> {
  const wsEndpoint = options.wsEndpoint ?? requiredEnv("BRD_BROWSER_WS");
  const connect =
    options.connect ??
    (async (endpoint: string) => chromium.connectOverCDP(endpoint));

  let browser: Browser | undefined;
  try {
    browser = await connect(wsEndpoint);
    return await fn(browser);
  } catch (error) {
    if (error instanceof MissingCredentialError || error instanceof BrightDataError) {
      throw error;
    }
    throw new BrightDataError(`Browser API session failed: ${asMessage(error)}`, "BROWSER_API_FAILED", {
      cause: error,
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
