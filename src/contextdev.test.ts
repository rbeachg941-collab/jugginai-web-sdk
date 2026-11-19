import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createContextDevClient,
  mapContextDevError,
  retrieveBrand,
  scrapeMarkdown,
  searchWeb,
  withBoundedRetry,
} from "./contextdev.js";
import {
  ContextDevApiError,
  ContextDevNotFoundError,
  ContextDevUsageExceededError,
  MissingCredentialError,
} from "./errors.js";

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.CONTEXT_DEV_API_KEY;
});

function withResponse<T>(data: T, headers: Record<string, string> = {}) {
  const promise = Promise.resolve(data) as Promise<T> & {
    withResponse: () => Promise<{ data: T; response: { headers: { get(name: string): string | null } } }>;
  };
  promise.withResponse = async () => ({
    data,
    response: {
      headers: {
        get(name: string) {
          return headers[name] ?? headers[name.toLowerCase()] ?? null;
        },
      },
    },
  });
  return promise;
}

function apiError(status: number, errorCode: string, message = errorCode, headers: Record<string, string> = {}) {
  const error = new Error(message) as Error & {
    status: number;
    error: { error_code: string; message: string; request_id: string };
    headers: { get(name: string): string | null };
  };
  error.name = "APIError";
  error.status = status;
  error.error = { error_code: errorCode, message, request_id: "req_test" };
  error.headers = {
    get(name: string) {
      return headers[name] ?? headers[name.toLowerCase()] ?? null;
    },
  };
  return error;
}

describe("createContextDevClient", () => {
  it("throws when CONTEXT_DEV_API_KEY is missing", () => {
    expect(() => createContextDevClient()).toThrow(MissingCredentialError);
  });
});

describe("mapContextDevError", () => {
  it("maps HTTP 400 NOT_FOUND to ContextDevNotFoundError", () => {
    const mapped = mapContextDevError(apiError(400, "NOT_FOUND", "Page not found"));
    expect(mapped).toBeInstanceOf(ContextDevNotFoundError);
    expect(mapped.status).toBe(400);
    expect(mapped.errorCode).toBe("NOT_FOUND");
    expect(mapped.requestId).toBe("req_test");
  });

  it("maps WEBSITE_NOT_FOUND to ContextDevNotFoundError", () => {
    const mapped = mapContextDevError(apiError(400, "WEBSITE_NOT_FOUND"));
    expect(mapped).toBeInstanceOf(ContextDevNotFoundError);
    expect(mapped.errorCode).toBe("WEBSITE_NOT_FOUND");
  });

  it("maps USAGE_EXCEEDED to ContextDevUsageExceededError", () => {
    const mapped = mapContextDevError(apiError(402, "USAGE_EXCEEDED"));
    expect(mapped).toBeInstanceOf(ContextDevUsageExceededError);
    expect(mapped.status).toBe(402);
  });
});

describe("withBoundedRetry", () => {
  it("retries 429 and honors Retry-After, then succeeds", async () => {
    const sleeper = vi.fn(async () => undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(429, "RATE_LIMITED", "slow down", { "retry-after": "1" }))
      .mockResolvedValueOnce("ok");

    await expect(withBoundedRetry(fn, { maxRetries: 2, sleep: sleeper })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleeper).toHaveBeenCalledWith(1000);
  });

  it("retries 408 and 5xx with bounded backoff", async () => {
    const sleeper = vi.fn(async () => undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(apiError(408, "REQUEST_TIMEOUT"))
      .mockRejectedValueOnce(apiError(503, "INTERNAL_ERROR"))
      .mockResolvedValueOnce("ok");

    await expect(withBoundedRetry(fn, { maxRetries: 2, sleep: sleeper })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeper).toHaveBeenNthCalledWith(1, 250);
    expect(sleeper).toHaveBeenNthCalledWith(2, 500);
  });

  it("does not retry 400 NOT_FOUND or validation errors", async () => {
    const sleeper = vi.fn(async () => undefined);
    const notFound = vi.fn().mockRejectedValue(apiError(400, "NOT_FOUND"));
    await expect(withBoundedRetry(notFound, { maxRetries: 2, sleep: sleeper })).rejects.toBeInstanceOf(
      ContextDevNotFoundError,
    );
    expect(notFound).toHaveBeenCalledTimes(1);

    const validation = vi.fn().mockRejectedValue(apiError(400, "INPUT_VALIDATION_ERROR", "bad url"));
    await expect(withBoundedRetry(validation, { maxRetries: 2, sleep: sleeper })).rejects.toBeInstanceOf(
      ContextDevApiError,
    );
    expect(validation).toHaveBeenCalledTimes(1);
    expect(sleeper).not.toHaveBeenCalled();
  });
});

describe("scrapeMarkdown", () => {
  it("returns markdown and credits from a successful scrape", async () => {
    const scrape = vi.fn().mockReturnValue(
      withResponse(
        {
          url: "https://example.com",
          request_id: "req_1",
          markdown: { data: "# Example Domain\n\nThis domain is for use in documentation examples.", success: true },
          key_metadata: { credits_consumed: 1, credits_remaining: 998 },
          cache_metadata: { status: "miss" },
        },
        { "x-credits-used": "1" },
      ),
    );

    const result = await scrapeMarkdown("https://example.com", {
      client: { web: { scrape, search: vi.fn() }, brand: { retrieve: vi.fn() } },
    });

    expect(result.markdown).toContain("Example Domain");
    expect(result.creditsUsed).toBe(1);
    expect(result.creditsRemaining).toBe(998);
    expect(result.requestId).toBe("req_1");
    expect(result.cached).toBe(false);
    expect(scrape).toHaveBeenCalledWith({
      url: "https://example.com",
      formats: { markdown: true },
      sharedParams: { mainContentOnly: true },
    });
  });

  it("throws ContextDevNotFoundError when markdown output reports NOT_FOUND", async () => {
    const scrape = vi.fn().mockReturnValue(
      withResponse({
        request_id: "req_missing",
        markdown: { data: null, success: false, error_code: "NOT_FOUND", message: "not found" },
      }),
    );

    await expect(
      scrapeMarkdown("https://example.com/missing", {
        client: { web: { scrape, search: vi.fn() }, brand: { retrieve: vi.fn() } },
      }),
    ).rejects.toMatchObject({ name: "ContextDevNotFoundError", errorCode: "NOT_FOUND" });
  });
});

describe("searchWeb and retrieveBrand", () => {
  it("maps search results", async () => {
    const search = vi.fn().mockReturnValue(
      withResponse({
        query: "example",
        request_id: "req_s",
        results: [{ title: "Example", url: "https://example.com", description: "Example site", relevance: "high" }],
        key_metadata: { credits_consumed: 1, credits_remaining: 997 },
      }),
    );

    const result = await searchWeb("example", {
      client: { web: { scrape: vi.fn(), search }, brand: { retrieve: vi.fn() } },
    });

    expect(result.results).toEqual([
      { title: "Example", url: "https://example.com", description: "Example site", relevance: "high" },
    ]);
    expect(result.creditsUsed).toBe(1);
    expect(search).toHaveBeenCalledWith({ query: "example", numResults: 10 });
  });

  it("retrieves a brand by domain", async () => {
    const retrieve = vi.fn().mockReturnValue(
      withResponse({
        request_id: "req_b",
        brand: { title: "Example", domain: "example.com", description: "Example org" },
        key_metadata: { credits_consumed: 10, credits_remaining: 987 },
      }),
    );

    const result = await retrieveBrand(
      { type: "by_domain", domain: "example.com" },
      { client: { web: { scrape: vi.fn(), search: vi.fn() }, brand: { retrieve } } },
    );

    expect(result.brand?.title).toBe("Example");
    expect(result.creditsUsed).toBe(10);
    expect(retrieve).toHaveBeenCalledWith({ type: "by_domain", domain: "example.com" });
  });
});
