/**
 * normalize() — pure function turning any thrown value into a wire-shaped
 * error response.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md
 *   §3.1 (wire shape), §3.2 (filter behaviour), §5 (registry).
 *
 * Order of branches (matches `normalize()` body — keep this comment in sync):
 *   1. AppError                          → passthrough
 *   2. ZodError                          → 422 + fields[]
 *   3. HttpException w/ {code,...}       → preserve code (Phase 1 legacy)
 *   3b. HttpException w/ string          → map status → generic.<class>;
 *                                          string detail is DROPPED (no leak)
 *   4. AbortError                        → 499 request.cancelled, no log
 *   5. PostgrestError (PGRST*)           → must come BEFORE pg-native because
 *                                          PostgREST forwards `severity` from
 *                                          diagnostic context — duck-type on
 *                                          the `PGRST*` prefix.
 *   6. pg native error                   → 23xxx / 22xxx / 40xxx mapped;
 *                                          never leak SQL
 *   7. fallback                          → 500 unknown.server_error, log full
 *
 * The renderer (Phase 7.B) reads from `code` only; `detail` is a fallback
 * for support tooling. Vendor names (Resend, Supabase, Stripe, Postgres) and
 * SQL fragments NEVER leak into `detail` — decision #13.
 *
 * Fail-closed registry (Phase 7.A.1 self-review fix): unregistered codes
 * are coerced to `unknown.server_error` at body-build time, so a producer
 * that throws an inflight code never reaches the wire.
 *
 * Legacy `body.message` synthesis (one-release shim): set `body.message =
 * body.detail ?? body.title` so existing frontend `apiFetch` toast logic
 * (`apps/web/src/lib/api.ts:163-167`) keeps producing user-visible copy
 * during the Phase 7.A → 7.B migration window. Remove in Phase 7.B once
 * the renderer reads `code` end-to-end.
 */

import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';

import { isKnownErrorCode } from '@prequest/shared';

import { AppError, isAppError } from './app-error';
import { resolveMessageEn } from './messages.en';

/** Wire-shape body — every non-2xx response uses this. */
export type WireShape = {
  code: string;
  title: string;
  status: number;
  traceId: string;
  /** One-release compat alias of `detail ?? title`. Removed in Phase 7.B. */
  message?: string;
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

// ─── Vendor / pg leakage scrub ──────────────────────────────────────────────
// Only scrubs fields/details on a small set of indicators that survive the
// Phase 7.A.1 hardening (Fix 3 dropped HttpException-string details
// outright). Kept as a defence-in-depth for AppError detail overrides
// authored by humans who pasted a vendor message.

const VENDOR_NAME_RE =
  /\b(resend|supabase|stripe|postgres|postgresql|sendgrid|twilio|aws|azure)\b/i;
// SQLSTATE-shaped tokens (`23505`, `40P01`) and `pg_*` system schema names
// almost always indicate a leaked pg / postgrest error string.
const SQLSTATE_RE = /\b\d{2}[0-9A-P]\d{2}\b|\bpg_[a-z_]+/i;

function looksLikeLeak(text: string | undefined): boolean {
  if (!text) return false;
  return VENDOR_NAME_RE.test(text) || SQLSTATE_RE.test(text);
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
}): { body: WireShape; status: number } {
  // Fail-closed: if the producer threw an unregistered code, replace
  // before any user-visible copy resolves. The original code is preserved
  // on the AppError / cause for the logger; the wire body never echoes
  // it. Spec §3.4 + CLAUDE.md error-handling guidance.
  let safeArgs = args;
  let safeStatus = args.status;
  if (!isKnownErrorCode(safeArgs.code)) {
    if (process.env.NODE_ENV !== 'production') {
      // Surface during dev/test so authors notice. Production swallows.
      // Fix 13 also logs scrub triggers via console.warn.
      // eslint-disable-next-line no-console
      console.warn('errors:fail-closed', {
        unregistered: safeArgs.code,
        replaced: 'unknown.server_error',
      });
    }
    safeArgs = { ...safeArgs, code: 'unknown.server_error', detailOverride: undefined };
    safeStatus = 500;
  }

  const message = resolveMessageEn(safeArgs.code);
  const body: WireShape = {
    code: safeArgs.code,
    title: message.title,
    status: safeStatus,
    traceId: safeArgs.traceId,
  };
  // Detail precedence: explicit override > messages.en > omit.
  // Override is dropped if it looks like a leak (vendor name / SQLSTATE).
  let safeOverride: string | undefined;
  if (safeArgs.detailOverride && !looksLikeLeak(safeArgs.detailOverride)) {
    safeOverride = safeArgs.detailOverride;
  } else if (safeArgs.detailOverride) {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('errors:detail-scrubbed', { code: safeArgs.code });
    }
  }
  const detail = safeOverride ?? message.detail;
  if (detail !== undefined) body.detail = detail;
  if (safeArgs.fields !== undefined) body.fields = safeArgs.fields;
  if (safeArgs.docsUrl !== undefined) body.docsUrl = safeArgs.docsUrl;
  if (safeArgs.retryAfter !== undefined) body.retryAfter = safeArgs.retryAfter;
  if (safeArgs.serverVersion !== undefined) body.serverVersion = safeArgs.serverVersion;
  if (safeArgs.clientVersion !== undefined) body.clientVersion = safeArgs.clientVersion;
  // Phase 7.A → 7.B compat shim: synthesise `message` from `detail`/`title`
  // so legacy `apiFetch` toast logic (apps/web/src/lib/api.ts:163-167)
  // keeps producing user-visible copy. Remove once Phase 7.B renderer
  // reads `code` directly.
  body.message = body.detail ?? body.title;
  return { body, status: safeStatus };
}

function fromAppError(error: AppError, traceId: string): NormalizedError {
  const built = buildBody({
    code: error.code,
    status: error.status,
    traceId,
    detailOverride: error.detail,
    fields: error.fields,
    docsUrl: error.docsUrl,
    retryAfter: error.retryAfter,
    serverVersion: error.serverVersion,
    clientVersion: error.clientVersion,
  });
  return { status: built.status, body: built.body, cause: error };
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

  // 3: Legacy Phase 1 throw — { code, message, ... } payload.
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
    const built = buildBody({ code, status, traceId, detailOverride: detail, fields });
    return { status: built.status, body: built.body, cause: error };
  }

  // 3b: HttpException with string OR `{message: string}` response.
  // Fix 3 (Phase 7.A.1 self-review): DROP the string detail entirely.
  // The string can be a Postgres `duplicate key value …`, a JWT
  // `malformed`, or any number of fail-OPEN shapes our regex misses.
  // Map status → `generic.<class>` and let messages.en supply the
  // user-visible copy. The original string is logged via the filter
  // (filter logs `cause` from `normalized.cause`), never wire-bound.
  const code = statusToGenericCode(status);
  const built = buildBody({ code, status, traceId });
  return { status: built.status, body: built.body, cause: error };
}

function fromZodError(error: ZodError, traceId: string): NormalizedError {
  const fields = error.issues.map((issue) => ({
    field: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  const built = buildBody({ code: 'validation.failed', status: 422, traceId, fields });
  return { status: built.status, body: built.body, cause: error };
}

// ─── PostgrestError detection ────────────────────────────────────────────────
// Supabase's PostgrestError isn't a class we can `instanceof` against; it's a
// plain object with `{ code: 'PGRSTxxx' | string, message: string, details?,
// hint? }` — see @supabase/postgrest-js. RLS denials surface as PGRST301
// (Bearer auth invalid for the row), 42501 from postgres ("permission
// denied for table foo"), and similar.
//
// Fix 5 (Phase 7.A.1 self-review): detect by `code.startsWith('PGRST')`
// FIRST, regardless of `severity`. PostgREST forwards the postgres
// diagnostic `severity` field on errors raised inside RPCs, which used
// to bounce PGRST301 into the pg-native branch and emit
// `db.constraint 500` instead of `permission.denied 403`.

function isPostgrestErrorLike(error: unknown): error is {
  code: string;
  message?: string;
  details?: string;
  hint?: string;
} {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  // PGRST*** (PostgREST) — always a postgrest error.
  if (code.startsWith('PGRST')) return true;
  // 42501 (postgres permission denied) — postgrest forwards this when
  // the row-level policy rejects. Treat as postgrest if there's no
  // `severity`, otherwise let the pg-native branch handle (which also
  // maps 42501 → permission.denied for symmetry).
  if (code === '42501' && !('severity' in (error as object))) return true;
  return false;
}

function fromPostgrestError(
  error: { code: string; message?: string; details?: string },
  traceId: string,
): NormalizedError {
  const code = error.code;
  // RLS / permission denial surfaces.
  if (code === 'PGRST301' || code === '42501' || code === 'PGRST302') {
    const built = buildBody({ code: 'permission.denied', status: 403, traceId });
    return { status: built.status, body: built.body, cause: error };
  }
  // PGRST116 = no rows.
  if (code === 'PGRST116') {
    const built = buildBody({ code: 'generic.not_found', status: 404, traceId });
    return { status: built.status, body: built.body, cause: error };
  }
  // Default — surface as a db.constraint without leaking the message.
  const built = buildBody({ code: 'db.constraint', status: 500, traceId });
  return { status: built.status, body: built.body, cause: error };
}

// ─── pg native error detection ───────────────────────────────────────────────
// node-postgres errors have `severity` and a sqlstate `code`. We never echo
// the pg `message` — the renderer's messages.en lookup is the only path to
// user-visible copy.
//
// Fix 4 (Phase 7.A.1 self-review): added 22xxx (string truncation, numeric
// out-of-range, invalid text rep) + 23502 (not_null_violation) +
// 40001 (serialization_failure) so user-input issues surface as 4xx rather
// than 500.

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
    // 22xxx — data exception family (user input → 400).
    case '22001': // string_data_right_truncation
    case '22003': // numeric_value_out_of_range
    case '22023': // invalid_parameter_value
    case '22P02': {
      // invalid_text_representation (e.g. uuid format error)
      const built = buildBody({ code: 'db.constraint', status: 400, traceId });
      return { status: built.status, body: built.body, cause: error };
    }
    // 23xxx — integrity constraint family.
    case '23502': {
      // not_null_violation
      const built = buildBody({ code: 'db.constraint', status: 400, traceId });
      return { status: built.status, body: built.body, cause: error };
    }
    case '23505': {
      const built = buildBody({ code: 'db.unique_violation', status: 409, traceId });
      return { status: built.status, body: built.body, cause: error };
    }
    case '23503': {
      const built = buildBody({ code: 'db.fk_violation', status: 409, traceId });
      return { status: built.status, body: built.body, cause: error };
    }
    case '23P01': {
      const built = buildBody({ code: 'db.constraint', status: 409, traceId });
      return { status: built.status, body: built.body, cause: error };
    }
    case '23514': {
      const built = buildBody({ code: 'db.constraint', status: 400, traceId });
      return { status: built.status, body: built.body, cause: error };
    }
    // 40xxx — transaction rollback (deadlock / serialization → retry).
    case '40001': // serialization_failure
    case '40P01': {
      // deadlock_detected
      const built = buildBody({ code: 'db.deadlock', status: 409, traceId });
      return { status: built.status, body: built.body, cause: error };
    }
    // 42501 — permission denied (postgres). Falls through here only when
    // `severity` was set; postgrest path also maps this code.
    case '42501': {
      const built = buildBody({ code: 'permission.denied', status: 403, traceId });
      return { status: built.status, body: built.body, cause: error };
    }
    default: {
      const built = buildBody({ code: 'db.constraint', status: 500, traceId });
      return { status: built.status, body: built.body, cause: error };
    }
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

  // 2. Zod errors (caught explicitly even though they might propagate
  // through HttpException in some controllers).
  if (error instanceof ZodError) {
    return fromZodError(error, traceId);
  }

  // 3 / 3b. NestJS HttpException — covers Bad/NotFound/Forbidden/Conflict/
  // Unauthorized/InternalServerError plus custom subclasses.
  if (error instanceof HttpException) {
    return fromHttpException(error, traceId);
  }

  // 4. AbortError — caller cancelled. Don't log.
  if (isAbortError(error)) {
    const built = buildBody({ code: 'request.cancelled', status: 499, traceId });
    return {
      status: built.status,
      body: built.body,
      silent: true,
      cause: error,
    };
  }

  // 5. PostgrestError — must run BEFORE pg-native because PostgREST forwards
  // postgres `severity` on errors raised inside RPC calls, which would
  // otherwise bounce PGRST301 into the pg-native default branch.
  if (isPostgrestErrorLike(error)) {
    return fromPostgrestError(error, traceId);
  }

  // 6. pg native error.
  if (isPgNativeErrorLike(error)) {
    return fromPgNativeError(error, traceId);
  }

  // 7. Fallback — unknown.
  const built = buildBody({ code: 'unknown.server_error', status: 500, traceId });
  return { status: built.status, body: built.body, cause: error };
}
