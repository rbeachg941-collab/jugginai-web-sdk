import ContextDev from "context.dev";
import {
  ContextDevApiError,
  ContextDevNotFoundError,
  ContextDevUsageExceededError,
  MissingCredentialError,
} from "./errors.js";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 2;

const NOT_FOUND_CODES = new Set(["NOT_FOUND", "WEBSITE_NOT_FOUND", "PROFILE_NOT_FOUND"]);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_CODES = new Set([
  "NOT_FOUND",
  "WEBSITE_NOT_FOUND",
  "PROFILE_NOT_FOUND",
  "INPUT_VALIDATION_ERROR",
  "USAGE_EXCEEDED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "ACCESS_POLICY_DENIED",
  "DISABLED",
  "PAID_PLAN_REQUIRED",
  "INSUFFICIENT_PERMISSIONS",
  "TIMEOUT_EXCEEDS_MAXIMUM",
  "TIMEOUT_TOO_SHORT_FOR_WAIT",
]);

export type ContextDevDeps = {
  web: {
    scrape: (body: unknown, options?: unknown) => CallResult<ScrapeRaw>;
    search: (body: unknown, options?: unknown) => CallResult<SearchRaw>;
  };
  brand: {
    retrieve: (body: unknown, options?: unknown) => CallResult<BrandRaw>;
  };
};

type CallResult<T> = Promise<T> & {
  withResponse?: () => Promise<{ data: T; response: { headers: { get(name: string): string | null } } }>;
};

type Credits = {
  creditsUsed: number | undefined;
  creditsRemaining: number | undefined;
};

type ScrapeRaw = {
  url?: string;
  request_id?: string;
  markdown?: { data?: string | null; success?: boolean | null; error_code?: string; message?: string };
  key_metadata?: { credits_consumed?: number; credits_remaining?: number };
  cache_metadata?: { status?: string };
};

type SearchRaw = {
  query?: string;
  request_id?: string;
  results?: Array<{ title?: string; url?: string; description?: string; relevance?: string }>;
  key_metadata?: { credits_consumed?: number; credits_remaining?: number };
};

type BrandRaw = {
  request_id?: string;
  brand?: { title?: string | null; domain?: string | null; description?: string | null };
  key_metadata?: { credits_consumed?: number; credits_remaining?: number };
};

export type ScrapeMarkdownResult = Credits & {
  markdown: string;
  url: string;
  requestId: string | undefined;
  cached: boolean;
};

export type SearchWebResult = Credits & {
  query: string;
  requestId: string | undefined;
  results: Array<{ title: string; url: string; description: string; relevance?: string }>;
};

export type RetrieveBrandResult = Credits & {
  requestId: string | undefined;
  brand: { title?: string | null; domain?: string | null; description?: string | null } | undefined;
};

export type ClientOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  client?: ContextDevDeps;
};

function requireApiKey(): string {
  const apiKey = process.env.CONTEXT_DEV_API_KEY;
  if (!apiKey) {
    throw new MissingCredentialError("CONTEXT_DEV_API_KEY");
  }
  return apiKey;
}

function silentLogger() {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {},
  };
}

export function createContextDevClient(options: Omit<ClientOptions, "client"> = {}): ContextDevDeps {
  const apiKey = requireApiKey();
  return new ContextDev({
    apiKey,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // Retries are owned by this wrapper so validation / NOT_FOUND are never retried.
    maxRetries: 0,
    logLevel: "off",
    logger: silentLogger(),
  }) as unknown as ContextDevDeps;
}

function payloadOf(error: unknown): { error_code?: string; message?: string; request_id?: string } {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const err = error as { error?: unknown; message?: string };
  const body = err.error;
  if (typeof body === "object" && body !== null) {
    const rec = body as Record<string, unknown>;
    return {
      error_code: typeof rec.error_code === "string" ? rec.error_code : undefined,
      message: typeof rec.message === "string" ? rec.message : err.message,
      request_id: typeof rec.request_id === "string" ? rec.request_id : undefined,
    };
  }
  return { message: err.message };
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

function headerOf(error: unknown, name: string): string | undefined {
  if (typeof error !== "object" || error === null || !("headers" in error)) {
    return undefined;
  }
  const headers = (error as { headers?: { get?: (key: string) => string | null } }).headers;
  const value = headers?.get?.(name);
  return value ?? undefined;
}

export function mapContextDevError(error: unknown): ContextDevApiError | MissingCredentialError {
  if (error instanceof MissingCredentialError || error instanceof ContextDevApiError) {
    return error;
  }

  const payload = payloadOf(error);
  const status = statusOf(error);
  const requestId = payload.request_id;
  const errorCode = payload.error_code;
  const message = payload.message ?? (error instanceof Error ? error.message : "Context.dev request failed");

  if (errorCode && NOT_FOUND_CODES.has(errorCode)) {
    return new ContextDevNotFoundError(message, { status: status ?? 400, errorCode, requestId, cause: error });
  }
  if (errorCode === "USAGE_EXCEEDED" || status === 402) {
    return new ContextDevUsageExceededError(message, { status: status ?? 402, requestId, cause: error });
  }
  return new ContextDevApiError(message, { status, errorCode, requestId, cause: error });
}

function isRetryable(error: unknown, mapped: ContextDevApiError | MissingCredentialError): boolean {
  if (mapped instanceof ContextDevNotFoundError || mapped instanceof ContextDevUsageExceededError) {
    return false;
  }
  if (mapped instanceof MissingCredentialError) {
    return false;
  }
  if (mapped.errorCode && NON_RETRYABLE_CODES.has(mapped.errorCode)) {
    return false;
  }
  const status = mapped.status ?? statusOf(error);
  if (status !== undefined && RETRYABLE_STATUS.has(status)) {
    return true;
  }
  if (error instanceof Error && error.name === "APIConnectionTimeoutError") {
    return true;
  }
  if (error instanceof Error && error.name === "APIConnectionError") {
    return true;
  }
  return false;
}

function retryDelayMs(error: unknown, attempt: number): number {
  const retryAfter = headerOf(error, "retry-after") ?? headerOf(error, "Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000);
    }
  }
  return Math.min(250 * 2 ** attempt, 4_000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withBoundedRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const wait = options.sleep ?? sleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const mapped = mapContextDevError(error);
      if (!isRetryable(error, mapped) || attempt >= maxRetries) {
        throw mapped;
      }
      await wait(retryDelayMs(error, attempt));
      attempt += 1;
    }
  }
}

async function settleCall<T extends { key_metadata?: { credits_consumed?: number; credits_remaining?: number } }>(
  call: CallResult<T>,
): Promise<{ data: T; credits: Credits }> {
  let data: T;
  let headerCredits: number | undefined;
  if (typeof call.withResponse === "function") {
    const settled = await call.withResponse();
    data = settled.data;
    const raw = settled.response.headers.get("x-credits-used") ?? settled.response.headers.get("X-Credits-Used");
    if (raw !== null && raw !== undefined && raw !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        headerCredits = parsed;
      }
    }
  } else {
    data = await call;
  }
  return {
    data,
    credits: {
      creditsUsed: data.key_metadata?.credits_consumed ?? headerCredits,
      creditsRemaining: data.key_metadata?.credits_remaining,
    },
  };
}

function clientOf(options: ClientOptions = {}): ContextDevDeps {
  return options.client ?? createContextDevClient(options);
}

export async function scrapeMarkdown(url: string, options: ClientOptions & { mainContentOnly?: boolean } = {}): Promise<ScrapeMarkdownResult> {
  const client = clientOf(options);
  const { data, credits } = await withBoundedRetry(
    () =>
      settleCall(
        client.web.scrape({
          url,
          formats: { markdown: true },
          sharedParams: { mainContentOnly: options.mainContentOnly ?? true },
        }),
      ),
    { maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES },
  );

  if (data.markdown?.success === false) {
    const code = data.markdown.error_code;
    const message = data.markdown.message ?? "Context.dev markdown output failed";
    if (code && NOT_FOUND_CODES.has(code)) {
      throw new ContextDevNotFoundError(message, { errorCode: code, requestId: data.request_id });
    }
    throw new ContextDevApiError(message, { errorCode: code, requestId: data.request_id });
  }

  const markdown = data.markdown?.data;
  if (!markdown) {
    throw new ContextDevApiError("Context.dev scrape returned no markdown", { requestId: data.request_id });
  }

  return {
    markdown,
    url: data.url ?? url,
    requestId: data.request_id,
    cached: data.cache_metadata?.status === "hit",
    ...credits,
  };
}

export async function searchWeb(
  query: string,
  options: ClientOptions & { numResults?: number } = {},
): Promise<SearchWebResult> {
  const client = clientOf(options);
  const { data, credits } = await withBoundedRetry(
    () =>
      settleCall(
        client.web.search({
          query,
          numResults: options.numResults ?? 10,
        }),
      ),
    { maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES },
  );

  return {
    query: data.query ?? query,
    requestId: data.request_id,
    results: (data.results ?? []).map((item) => ({
      title: item.title ?? "",
      url: item.url ?? "",
      description: item.description ?? "",
      relevance: item.relevance,
    })),
    ...credits,
  };
}

export type BrandLookup =
  | { type: "by_domain"; domain: string }
  | { type: "by_name"; name: string };

export async function retrieveBrand(
  input: BrandLookup,
  options: ClientOptions = {},
): Promise<RetrieveBrandResult> {
  const client = clientOf(options);
  const { data, credits } = await withBoundedRetry(
    () => settleCall(client.brand.retrieve(input)),
    { maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES },
  );

  return {
    requestId: data.request_id,
    brand: data.brand,
    ...credits,
  };
}
