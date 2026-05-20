/**
 * wrapPgError — wrap a Supabase/Postgres error in an `AppError` while
 * preserving the wire-code precision the global filter already gives us
 * for well-known pg / PostgREST surface codes.
 *
 * Why this exists: the R2 AppError sweep (2026-05-20) replaced raw
 * `if (error) throw error;` rethrows with `AppErrors.server('<module>.<op>_failed', ...)`.
 * The naive `AppErrors.server(...)` fold is a 500-only constructor — every
 * site post-PR is `unknown.server_error` 500 on the wire (well, `<module>.<op>_failed`
 * 500 — same wire shape, different code). Pre-PR, the SAME `if (error) throw error;`
 * was rethrowing the raw PostgrestError / pg-native error, which the global filter
 * (`apps/api/src/common/errors/normalize.ts:316-435`) normalised as:
 *   - `PGRST116` (no rows from `.single()`) → 404 `generic.not_found`
 *   - `23505` (unique violation) → 409 `db.unique_violation`
 *   - `23503` (FK violation) → 409 `db.fk_violation`
 *   - PostgrestError default → 500 `db.constraint`
 *   - pg-native 22xxx / 23xxx → 4xx / 409 with `db.*` codes
 *
 * Folding everything to 500 was a wire-code regression: `GET /api/assets/<bogus>`
 * went from 404 → 500, `POST /api/teams` with a duplicate name went from
 * 409 → 500. R2's three-reviewer convergent finding (plan + code +
 * codex tertiary). This helper restores the pre-PR shape while keeping
 * the new domain codes — best of both: 404/409 wire precision via the
 * existing db.* / generic.* / `<module>.not_found` codes when applicable,
 * and a specific `<module>.<op>_failed` 500 for everything else (so the
 * client sees `asset.lookup_failed` rather than `unknown.server_error`).
 *
 * Use at every supabase call site that previously was `if (error) throw error;`
 * — the wrap is the safe migration that doesn't regress wire-code precision.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md §3.4
 * Triage: docs/follow-ups/r2-apperror-sweep-triage-2026-05-20.md
 */

import type { KnownErrorCode } from '@prequest/shared';

import { AppError, AppErrors } from './app-error';

export interface WrapPgErrorOptions {
  /** Operator-only detail string — never user-visible. */
  detail: string;
  /**
   * Optional module-specific `<entity>.not_found` code to use when the
   * underlying error is `PGRST116` (no rows from `.single()` /
   * `.maybeSingle()` lookup). Falls back to `generic.not_found` when not
   * supplied — both render the user-visible "We can't find that …" copy
   * via messages.en, but the module-specific code lets the client toast
   * disambiguate per-entity if it wants to.
   */
  notFoundCode?: KnownErrorCode;
}

/**
 * Duck-typed shape for the errors we map. PostgrestError + pg-native both
 * expose a `code` string; we ignore everything else (severity / message)
 * because messaging is owned by messages.en / messages.nl — the wire body
 * never echoes the underlying error string.
 */
type PgLikeError = { code?: string; message?: string };

export function wrapPgError(
  error: unknown,
  fallbackCode: KnownErrorCode,
  opts: WrapPgErrorOptions,
): AppError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as PgLikeError;
  const code = e.code;

  // PGRST116 — no rows from `.single()`. The pre-PR raw rethrow path
  // mapped this to 404 generic.not_found via fromPostgrestError; keep the
  // 404 wire shape but prefer a module-specific code when the caller
  // supplied one (gives the client more disambiguation than the catch-all).
  if (code === 'PGRST116') {
    return new AppError(opts.notFoundCode ?? 'generic.not_found', 404, {
      detail: opts.detail,
      cause: error,
    });
  }
  // 23505 — unique_violation. Pre-PR: 409 db.unique_violation via
  // fromPgNativeError. Mirror exactly — the wire code already maps to
  // "Conflict — that name/identifier is already in use" copy via
  // messages.en.
  if (code === '23505') {
    return new AppError('db.unique_violation', 409, {
      detail: opts.detail,
      cause: error,
    });
  }
  // 23503 — foreign_key_violation. Pre-PR: 409 db.fk_violation.
  if (code === '23503') {
    return new AppError('db.fk_violation', 409, {
      detail: opts.detail,
      cause: error,
    });
  }
  // Everything else — fall through to the module-specific 500. This
  // includes the post-R1 motivating case: PostgrestError without a
  // `code.startsWith('PGRST')` and without `severity`, which used to
  // surface as `unknown.server_error` 500 (R1 bug class).
  return AppErrors.server(fallbackCode, {
    detail: opts.detail,
    cause: error,
  });
}
