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
 * Codex I2 (Phase 7.A.1 review fix): `code` is typed as `KnownErrorCode`,
 * NOT `string`. A typo at a throw site (`AppErrors.notFound('person')`
 * when `person.not_found` is unregistered) is now a TS error at compile
 * time, not a 500 mystery at runtime. The `buildBody` runtime fail-closed
 * check stays as defence-in-depth for codes that arrive via
 * HttpException payloads (which TypeScript can't see).
 */

import type { KnownErrorCode } from '@prequest/shared';

/**
 * Entity prefixes that have a `<entity>.not_found` code registered.
 * Wrapped in a generic to make the conditional distributive over the
 * `KnownErrorCode` union (without the wrapper, the conditional matches
 * the whole union as one and the prefix-extract evaluates to `never`).
 */
type ExtractNotFoundEntity<T> = T extends `${infer E}.not_found` ? E : never;
type NotFoundEntity = ExtractNotFoundEntity<KnownErrorCode>;

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
  readonly code: KnownErrorCode;
  readonly status: number;
  readonly detail?: string;
  readonly fields?: AppErrorField[];
  override readonly cause?: unknown;
  readonly docsUrl?: string;
  readonly retryAfter?: number;
  readonly serverVersion?: string;
  readonly clientVersion?: string;

  constructor(code: KnownErrorCode, status: number, opts?: AppErrorOptions) {
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
   * Resource not found. Code is `<entity>.not_found`. The entity union is
   * derived from `KnownErrorCode` — adding a new not-found code in the
   * registry automatically extends the accepted entity values here.
   *
   * The `id` is included in `detail` for ops/log readability — never user-
   * visible (the renderer ignores `detail` in favour of the messages.en
   * lookup). If a resource type needs custom copy, register
   * `<entity>.not_found` in messages.en.ts; this factory still produces it.
   */
  notFound: (entity: NotFoundEntity, id?: string): AppError =>
    new AppError(`${entity}.not_found` as KnownErrorCode, 404, {
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
    code: KnownErrorCode,
    opts?: { detail?: string; fields?: AppErrorField[] },
  ): AppError => new AppError(code, 400, opts),

  /** 409 conflict — pass `serverVersion`/`clientVersion` for stale-write conflicts. */
  conflict: (
    code: KnownErrorCode,
    opts?: { detail?: string; serverVersion?: string; clientVersion?: string },
  ): AppError => new AppError(code, 409, opts),

  /** 429 rate-limit — `retryAfter` is mandatory for the renderer's countdown UI. */
  rateLimited: (retryAfter: number, opts?: { detail?: string }): AppError =>
    new AppError('rate_limit.exceeded', 429, { ...opts, retryAfter }),

  /** 500 server error — pick a domain code (`booking.compensation_failed`, etc). */
  server: (
    code: KnownErrorCode,
    opts?: { detail?: string; cause?: unknown },
  ): AppError => new AppError(code, 500, opts),

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
  badRequest: (code: KnownErrorCode, detail?: string): AppError =>
    new AppError(code, 400, { detail }),

  /**
   * 403 forbidden with a domain-specific code (e.g. `ticket.write_forbidden`,
   * `ticket.visibility_trace_forbidden`). Prefer `permissionDenied` when the
   * site is the canonical "missing permission X" case. Use this when the
   * forbidden state is feature-specific and a targeted code yields better
   * client copy + audit signal than the catch-all `permission.denied`.
   */
  forbidden: (code: KnownErrorCode, detail?: string): AppError =>
    new AppError(code, 403, { detail }),

  /**
   * 404 not-found with a domain-specific code (e.g.
   * `reclassify.target_not_found`). Prefer `notFound(entity, id)` for the
   * standard `<entity>.not_found` case. Use this when the not-found surface
   * has a more specific reason that the client renderer should disambiguate.
   */
  notFoundWithCode: (code: KnownErrorCode, detail?: string): AppError =>
    new AppError(code, 404, { detail }),
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
