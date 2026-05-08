/**
 * normalize() — pure function turning any thrown value into a wire-shaped
 * error response.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md
 *   §3.1 (wire shape), §3.2 (filter behaviour), §5 (registry).
 *
 * Order of branches matters:
 *   1. AppError              → passthrough
 *   2. HttpException w/ {code,...} payload (legacy Phase 1) → preserve code
 *   3. HttpException w/ string → map status → generic.<class>
 *   4. ZodError              → 422 + fields[]
 *   5. PostgrestError        → RLS → permission.denied; else db.constraint
 *   6. pg native error       → 23505/23503/23P01/23514 mapped; never leak SQL
 *   7. AbortError            → 499/400 request.cancelled, no log
 *   8. fallback              → 500 unknown.server_error, log full stack
 *
 * The renderer (Phase 7.B) reads from `code` only; `detail` is a fallback
 * for support tooling. Vendor names (Resend, Supabase, Stripe, Postgres) and
 * SQL fragments NEVER leak into `detail` — decision #13.
 */

import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';

import { AppError, isAppError } from './app-error';
import { resolveMessageEn } from './messages.en';

/** Wire-shape body — every non-2xx response uses this. */
export type WireShape = {
  code: string;
  title: string;
  status: number;
  traceId: string;
  detail?: string;
  fields?: Array<{ field: string; code: string; message: string }>;
  docsUrl?: string;
  retryAfter?: number;
  serverVersion?: string;
  clientVersion?: string;
};

export type NormalizedError = {
  status: number;
  body: WireShape;
  /** True for `request.cancelled` — the filter skips logging. */
  silent?: boolean;
  /** Original error preserved for the filter's logger. */
  cause?: unknown;
};

/** Generate a trace id. ULID-style not strictly required; uuid is fine for now. */
export function randomTraceId(): string {
  return `req_${randomUUID()}`;
}

// ─── Vendor / SQL leakage scrub ──────────────────────────────────────────────
// Any error message that touches a third-party vendor name, SQL keyword, or
// stack frame fragment must NOT reach the wire body. We replace `detail` with
// neutral copy resolved from messages.en. The original message is preserved
// only on `cause` for the logger.

const VENDOR_NAME_RE = /\b(resend|supabase|stripe|postgres|postgresql|sendgrid|twilio|aws|azure)\b/i;
const SQL_KEYWORD_RE =
  /\b(select|insert|update|delete|from|where|join|values|returning|create|drop|alter)\b/i;

function looksLikeLeak(text: string | undefined): boolean {
  if (!text) return false;
  return VENDOR_NAME_RE.test(text) || SQL_KEYWORD_RE.test(text);
}

// ─── Branch helpers ──────────────────────────────────────────────────────────

function buildBody(args: {
  code: string;
  status: number;
  traceId: string;
  detailOverride?: string;
  fields?: WireShape['fields'];
  docsUrl?: string;
  retryAfter?: number;
  serverVersion?: string;
  clientVersion?: string;
}): WireShape {
  const message = resolveMessageEn(args.code);
  const body: WireShape = {
    code: args.code,
    title: message.title,
    status: args.status,
    traceId: args.traceId,
  };
  // Detail precedence: explicit override > messages.en > omit.
  // Override is dropped if it looks like a leak (vendor name / SQL fragment).
  const safeOverride = args.detailOverride && !looksLikeLeak(args.detailOverride)
    ? args.detailOverride
    : undefined;
  const detail = safeOverride ?? message.detail;
  if (detail !== undefined) body.detail = detail;
  if (args.fields !== undefined) body.fields = args.fields;
  if (args.docsUrl !== undefined) body.docsUrl = args.docsUrl;
  if (args.retryAfter !== undefined) body.retryAfter = args.retryAfter;
  if (args.serverVersion !== undefined) body.serverVersion = args.serverVersion;
  if (args.clientVersion !== undefined) body.clientVersion = args.clientVersion;
  return body;
}

function fromAppError(error: AppError, traceId: string): NormalizedError {
  return {
    status: error.status,
    body: buildBody({
      code: error.code,
      status: error.status,
      traceId,
      detailOverride: error.detail,
      fields: error.fields,
      docsUrl: error.docsUrl,
      retryAfter: error.retryAfter,
      serverVersion: error.serverVersion,
      clientVersion: error.clientVersion,
    }),
    cause: error,
  };
}

function statusToGenericCode(status: number): string {
  switch (status) {
    case 400:
      return 'generic.bad_request';
    case 401:
      return 'generic.unauthorized';
    case 403:
      return 'generic.forbidden';
    case 404:
      return 'generic.not_found';
    case 409:
      return 'generic.conflict';
    case 422:
      return 'validation.failed';
    case 429:
      return 'rate_limit.exceeded';
    default:
      return status >= 500 ? 'unknown.server_error' : 'generic.bad_request';
  }
}

function fromHttpException(error: HttpException, traceId: string): NormalizedError {
  const status = error.getStatus();
  const response = error.getResponse();

  // 2: Legacy Phase 1 throw — { code, message, ... } payload.
  if (
    typeof response === 'object' &&
    response !== null &&
    typeof (response as { code?: unknown }).code === 'string'
  ) {
    const payload = response as Record<string, unknown>;
    const code = payload.code as string;
    const detail =
      typeof payload.message === 'string'
        ? payload.message
        : typeof payload.detail === 'string'
          ? (payload.detail as string)
          : undefined;
    const fields = Array.isArray(payload.fields)
      ? (payload.fields as WireShape['fields'])
      : undefined;
    return {
      status,
      body: buildBody({ code, status, traceId, detailOverride: detail, fields }),
      cause: error,
    };
  }

  // 3: HttpException with string response — map status → generic.<class>.
  let detail: string | undefined;
  if (typeof response === 'string') {
    detail = response;
  } else if (
    typeof response === 'object' &&
    response !== null &&
    typeof (response as { message?: unknown }).message === 'string'
  ) {
    detail = (response as { message: string }).message;
  }
  const code = statusToGenericCode(status);
  return {
    status,
    body: buildBody({ code, status, traceId, detailOverride: detail }),
    cause: error,
  };
}

function fromZodError(error: ZodError, traceId: string): NormalizedError {
  const fields = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  return {
    status: 422,
    body: buildBody({ code: 'validation.failed', status: 422, traceId, fields }),
    cause: error,
  };
}

// ─── PostgrestError detection ────────────────────────────────────────────────
// Supabase's PostgrestError isn't a class we can `instanceof` against; it's a
// plain object with `{ code: 'PGRSTxxx' | string, message: string, details?,
// hint? }` — see @supabase/postgrest-js. RLS denials surface as PGRST301
// (Bearer auth invalid for the row), 42501 from postgres ("permission
// denied for table foo"), and similar. We map any of those to
// permission.denied per spec §3.1.

function isPostgrestErrorLike(error: unknown): error is {
  code: string;
  message?: string;
  details?: string;
  hint?: string;
} {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    !('severity' in (error as object))
  );
}

function fromPostgrestError(
  error: { code: string; message?: string; details?: string },
  traceId: string,
): NormalizedError {
  const code = error.code;
  // RLS / permission denial surfaces.
  if (code === 'PGRST301' || code === '42501' || code === 'PGRST302') {
    return {
      status: 403,
      body: buildBody({ code: 'permission.denied', status: 403, traceId }),
      cause: error,
    };
  }
  // PGRST116 = no rows.
  if (code === 'PGRST116') {
    return {
      status: 404,
      body: buildBody({ code: 'generic.not_found', status: 404, traceId }),
      cause: error,
    };
  }
  // Default — surface as a db.constraint without leaking the message.
  return {
    status: 500,
    body: buildBody({ code: 'db.constraint', status: 500, traceId }),
    cause: error,
  };
}

// ─── pg native error detection ───────────────────────────────────────────────
// node-postgres errors have `severity` and a sqlstate `code` — see pg's error
// class. Codes:
//   23505 unique_violation
//   23503 foreign_key_violation
//   23P01 exclusion_violation (GiST overlap, etc.)
//   23514 check_violation
// We never echo the pg `message` (contains SQL fragments + table names) —
// the renderer's messages.en lookup is the only path to user-visible copy.

function isPgNativeErrorLike(error: unknown): error is {
  severity: string;
  code: string;
  message?: string;
  detail?: string;
  schema?: string;
  table?: string;
} {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { severity?: unknown }).severity === 'string' &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

function fromPgNativeError(
  error: { code: string; message?: string },
  traceId: string,
): NormalizedError {
  switch (error.code) {
    case '23505':
      return {
        status: 409,
        body: buildBody({ code: 'db.unique_violation', status: 409, traceId }),
        cause: error,
      };
    case '23503':
      return {
        status: 409,
        body: buildBody({ code: 'db.fk_violation', status: 409, traceId }),
        cause: error,
      };
    case '23P01':
      return {
        status: 409,
        body: buildBody({ code: 'db.constraint', status: 409, traceId }),
        cause: error,
      };
    case '23514':
      return {
        status: 400,
        body: buildBody({ code: 'db.constraint', status: 400, traceId }),
        cause: error,
      };
    case '40P01':
      return {
        status: 409,
        body: buildBody({ code: 'db.deadlock', status: 409, traceId }),
        cause: error,
      };
    default:
      return {
        status: 500,
        body: buildBody({ code: 'db.constraint', status: 500, traceId }),
        cause: error,
      };
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  ) {
    return true;
  }
  return false;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function normalize(error: unknown, traceId: string): NormalizedError {
  // 1. AppError passthrough.
  if (isAppError(error)) {
    return fromAppError(error as AppError, traceId);
  }

  // 4. Zod errors (caught explicitly even though they might propagate
  // through HttpException in some controllers).
  if (error instanceof ZodError) {
    return fromZodError(error, traceId);
  }

  // 2 + 3. NestJS HttpException — covers Bad/NotFound/Forbidden/Conflict/
  // Unauthorized/InternalServerError plus custom subclasses.
  if (error instanceof HttpException) {
    return fromHttpException(error, traceId);
  }

  // 7. AbortError — caller cancelled. Don't log.
  if (isAbortError(error)) {
    return {
      status: 499,
      body: buildBody({ code: 'request.cancelled', status: 499, traceId }),
      silent: true,
      cause: error,
    };
  }

  // 6. pg native error — must check BEFORE PostgrestError because both have
  // a `code` field but pg native also has `severity`.
  if (isPgNativeErrorLike(error)) {
    return fromPgNativeError(error, traceId);
  }

  // 5. PostgrestError — duck-typed (no class to instanceof against).
  if (isPostgrestErrorLike(error)) {
    return fromPostgrestError(error, traceId);
  }

  // 8. Fallback — unknown.
  return {
    status: 500,
    body: buildBody({ code: 'unknown.server_error', status: 500, traceId }),
    cause: error,
  };
}
