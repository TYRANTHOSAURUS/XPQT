/**
 * AppError — server-side error class with stable wire-shape semantics.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md §3.2
 *
 * Throw `AppError` (or one of the `AppErrors.*` factories) at every new
 * server-side error site. The global `AllExceptionsFilter` normalises
 * `AppError` straight to the wire shape — no message rewriting, no status
 * inference, the AppError is the contract.
 *
 * Legacy NestJS `HttpException` throws are still supported by the filter
 * (mapped to `generic.<class>` codes) but will be migrated in Phase 7.A.2.
 *
 * NOTE: this module intentionally exports a *string* `code` rather than the
 * `KnownErrorCode` union from `@prequest/shared`. Reason: the filter accepts
 * registered codes from anywhere — Phase 1 inline `throw new
 * BadRequestException({ code: 'booking.slot_conflict' })` payloads pass
 * through the same passthrough path, and the registry enforces validity at
 * the messages-lookup boundary, not the throw site. (CI-level enforcement
 * is Phase 7.A.3.)
 */

export type AppErrorField = {
  field: string;
  code: string;
  message: string;
};

export type AppErrorOptions = {
  detail?: string;
  fields?: AppErrorField[];
  cause?: unknown;
  docsUrl?: string;
  retryAfter?: number;
  serverVersion?: string;
  clientVersion?: string;
};

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;
  readonly fields?: AppErrorField[];
  override readonly cause?: unknown;
  readonly docsUrl?: string;
  readonly retryAfter?: number;
  readonly serverVersion?: string;
  readonly clientVersion?: string;

  constructor(code: string, status: number, opts?: AppErrorOptions) {
    super(opts?.detail ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    if (opts?.detail !== undefined) this.detail = opts.detail;
    if (opts?.fields !== undefined) this.fields = opts.fields;
    if (opts?.cause !== undefined) this.cause = opts.cause;
    if (opts?.docsUrl !== undefined) this.docsUrl = opts.docsUrl;
    if (opts?.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
    if (opts?.serverVersion !== undefined) this.serverVersion = opts.serverVersion;
    if (opts?.clientVersion !== undefined) this.clientVersion = opts.clientVersion;
  }
}

/**
 * Sanctioned factories. Throw via `AppErrors.<class>(...)` for new sites.
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md §3.2
 *
 * The `unauthorized`, `permissionDenied`, `notFound`, `validation`,
 * `conflict`, `rateLimited`, `server`, `badRequest`, `validationFailed`
 * factories are the closed set the filter is tested against. New error
 * shapes either fit one of these or get added here in the same PR.
 */
export const AppErrors = {
  /**
   * Resource not found. Code defaults to `<entity>.not_found`.
   *
   * The `id` is included in `detail` for ops/log readability — never user-
   * visible (the renderer ignores `detail` in favour of the messages.en
   * lookup). If a resource type needs custom copy, register
   * `<entity>.not_found` in messages.en.ts; this factory still produces it.
   */
  notFound: (entity: string, id?: string): AppError =>
    new AppError(`${entity}.not_found`, 404, {
      detail: id ? `${entity} ${id} not found` : `${entity} not found`,
    }),

  /**
   * Same-tenant permission denial. For cross-tenant rows that should not
   * leak existence, return `notFound(...)` per spec decision #6.1.
   */
  permissionDenied: (permission?: string): AppError =>
    new AppError('permission.denied', 403, {
      detail: permission ? `Missing permission: ${permission}` : 'Missing permission',
    }),

  /** 422 with structured `fields[]` — preferred over `validationFailed` for Zod-shaped problems. */
  validation: (fields: AppErrorField[]): AppError =>
    new AppError('validation.failed', 422, { fields }),

  /**
   * 400 with a custom validation code (e.g. `booking.invalid_window`,
   * `reference.invalid_uuid`). Use when there's no `fields[]` payload but
   * the code is more specific than `validation.failed`.
   */
  validationFailed: (
    code: string,
    opts?: { detail?: string; fields?: AppErrorField[] },
  ): AppError => new AppError(code, 400, opts),

  /** 409 conflict — pass `serverVersion`/`clientVersion` for stale-write conflicts. */
  conflict: (
    code: string,
    opts?: { detail?: string; serverVersion?: string; clientVersion?: string },
  ): AppError => new AppError(code, 409, opts),

  /** 429 rate-limit — `retryAfter` is mandatory for the renderer's countdown UI. */
  rateLimited: (retryAfter: number, opts?: { detail?: string }): AppError =>
    new AppError('rate_limit.exceeded', 429, { ...opts, retryAfter }),

  /** 500 server error — pick a domain code (`booking.compensation_failed`, etc). */
  server: (code: string, opts?: { detail?: string; cause?: unknown }): AppError =>
    new AppError(code, 500, opts),

  /** 401 unauthenticated. Reason is logged, not user-visible. */
  unauthorized: (reason?: string): AppError =>
    new AppError('auth.unauthorized', 401, {
      detail: reason ?? 'Authentication required',
    }),

  /**
   * 400 generic bad-request. Use ONLY when the call site is not a validation
   * problem (those go through `validation` / `validationFailed`). E.g. a
   * client used the wrong endpoint, a feature flag is off, etc.
   */
  badRequest: (code: string, detail?: string): AppError =>
    new AppError(code, 400, { detail }),
} as const;

/**
 * Type-guard: narrow `unknown` to `AppError`. Cheap structural check —
 * avoids cross-realm `instanceof` traps when the error survives a
 * serialisation boundary.
 */
export function isAppError(error: unknown): error is AppError {
  return (
    error instanceof AppError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AppError' &&
      typeof (error as { code?: unknown }).code === 'string' &&
      typeof (error as { status?: unknown }).status === 'number')
  );
}
