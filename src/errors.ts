export class WebSdkError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "WebSdkError";
    this.code = code;
  }
}

export class MissingCredentialError extends WebSdkError {
  readonly envVar: string;

  constructor(envVar: string) {
    super(`Missing required environment variable: ${envVar}`, "MISSING_CREDENTIAL");
    this.name = "MissingCredentialError";
    this.envVar = envVar;
  }
}

export class ContextDevApiError extends WebSdkError {
  readonly status: number | undefined;
  readonly errorCode: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options: {
      status?: number;
      errorCode?: string;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.errorCode ?? "CONTEXT_DEV_API_ERROR", { cause: options.cause });
    this.name = "ContextDevApiError";
    this.status = options.status;
    this.errorCode = options.errorCode;
    this.requestId = options.requestId;
  }
}

export class ContextDevNotFoundError extends ContextDevApiError {
  constructor(
    message: string,
    options: { status?: number; errorCode?: string; requestId?: string; cause?: unknown } = {},
  ) {
    super(message, {
      status: options.status ?? 400,
      errorCode: options.errorCode ?? "NOT_FOUND",
      requestId: options.requestId,
      cause: options.cause,
    });
    this.name = "ContextDevNotFoundError";
  }
}

export class ContextDevUsageExceededError extends ContextDevApiError {
  constructor(
    message: string,
    options: { status?: number; requestId?: string; cause?: unknown } = {},
  ) {
    super(message, {
      status: options.status ?? 402,
      errorCode: "USAGE_EXCEEDED",
      requestId: options.requestId,
      cause: options.cause,
    });
    this.name = "ContextDevUsageExceededError";
  }
}

export class BrightDataError extends WebSdkError {
  constructor(message: string, code = "BRIGHT_DATA_ERROR", options?: { cause?: unknown }) {
    super(message, code, options);
    this.name = "BrightDataError";
  }
}
