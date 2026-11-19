import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIspProxyUrl, fetchViaIspProxy, withBrowser } from "./brightdata.js";
import { BrightDataError, MissingCredentialError } from "./errors.js";
import type { Browser } from "playwright-core";

const ENV = {
  BRD_ISP_PROXY_HOST: "proxy.test.example",
  BRD_ISP_PROXY_PORT: "22225",
  BRD_ISP_PROXY_USER: "brd-customer-test-zone-isp",
  BRD_ISP_PROXY_PASS: "test-pass",
  BRD_BROWSER_WS: "wss://brd-customer-test:test-pass@browser.test.example:9222",
};

function stubIspEnv() {
  vi.stubEnv("BRD_ISP_PROXY_HOST", ENV.BRD_ISP_PROXY_HOST);
  vi.stubEnv("BRD_ISP_PROXY_PORT", ENV.BRD_ISP_PROXY_PORT);
  vi.stubEnv("BRD_ISP_PROXY_USER", ENV.BRD_ISP_PROXY_USER);
  vi.stubEnv("BRD_ISP_PROXY_PASS", ENV.BRD_ISP_PROXY_PASS);
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of Object.keys(ENV)) {
    delete process.env[key];
  }
});

describe("buildIspProxyUrl", () => {
  it("throws when proxy env vars are missing", () => {
    expect(() => buildIspProxyUrl()).toThrow(MissingCredentialError);
  });

  it("appends country and session flags to the username", () => {
    stubIspEnv();
    const url = buildIspProxyUrl({ country: "us", session: "job1" });
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("proxy.test.example");
    expect(parsed.port).toBe("22225");
    expect(decodeURIComponent(parsed.username)).toBe("brd-customer-test-zone-isp-country-us-session-job1");
    expect(decodeURIComponent(parsed.password)).toBe("test-pass");
  });
});

describe("fetchViaIspProxy", () => {
  it("fetches through an injected dispatcher built from the proxy URL", async () => {
    stubIspEnv();
    const dispatcher = { id: "dispatcher" };
    const createDispatcher = vi.fn().mockReturnValue(dispatcher);
    const fetch = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => "ok",
      headers: {
        forEach(cb: (value: string, key: string) => void) {
          cb("text/plain", "content-type");
        },
      },
    });

    const result = await fetchViaIspProxy("https://example.com", {
      country: "ee",
      session: "s1",
      fetch: fetch as never,
      createDispatcher,
    });

    expect(result).toEqual({
      status: 200,
      body: "ok",
      headers: { "content-type": "text/plain" },
    });
    expect(createDispatcher).toHaveBeenCalledTimes(1);
    const proxyUrl = createDispatcher.mock.calls[0][0] as string;
    expect(decodeURIComponent(new URL(proxyUrl).username)).toContain("-country-ee-session-s1");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://example.com");
    expect(fetch.mock.calls[0][1]).toMatchObject({ dispatcher });
  });

  it("wraps transport failures without leaking the proxy URL", async () => {
    stubIspEnv();
    const fetch = vi.fn().mockRejectedValue(new Error("connect failed"));
    await expect(
      fetchViaIspProxy("https://example.com", {
        fetch: fetch as never,
        createDispatcher: () => ({}),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(BrightDataError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("ISP proxy request failed");
      expect(message).not.toContain("test-pass");
      expect(message).not.toContain("brd-customer-test");
      return true;
    });
  });
});

describe("withBrowser", () => {
  it("throws when BRD_BROWSER_WS is missing", async () => {
    await expect(withBrowser(async () => undefined)).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it("connects, runs the callback, and closes the browser", async () => {
    vi.stubEnv("BRD_BROWSER_WS", ENV.BRD_BROWSER_WS);
    const close = vi.fn().mockResolvedValue(undefined);
    const browser = { close } as unknown as Browser;
    const connect = vi.fn().mockResolvedValue(browser);
    const fn = vi.fn().mockResolvedValue("home");

    await expect(withBrowser(fn, { connect })).resolves.toBe("home");
    expect(connect).toHaveBeenCalledWith(ENV.BRD_BROWSER_WS);
    expect(fn).toHaveBeenCalledWith(browser);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the browser when the callback throws", async () => {
    vi.stubEnv("BRD_BROWSER_WS", ENV.BRD_BROWSER_WS);
    const close = vi.fn().mockResolvedValue(undefined);
    const browser = { close } as unknown as Browser;
    const connect = vi.fn().mockResolvedValue(browser);

    await expect(
      withBrowser(async () => {
        throw new Error("page failed");
      }, { connect }),
    ).rejects.toBeInstanceOf(BrightDataError);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
