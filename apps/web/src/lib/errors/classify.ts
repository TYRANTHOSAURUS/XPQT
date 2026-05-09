/**
 * Error classification — Phase 7.B-2 foundation.
 *
 * `classify(error, ctx)` is a pure function that maps any thrown value into
 * the canonical {@link ClassifiedError} shape per spec §3.3:
 *   docs/superpowers/specs/2026-05-02-error-handling-system-design.md
 *
 * The classifier is the single boundary between "something failed" and the
 * renderer / handler layer. It never reads from React, never toasts, never
 * mutates global state.
 *
 * Invariants:
 *   - Every classified error carries `recoveries.length >= 1`. Zero would
 *     leave the UI without a way out — caught by classify.test.ts.
 *   - The `class` is one of the eleven literals in `ErrorClass` (server
 *     side: `realtime` and `render` are emitted by other layers, not here).
 *   - `code` is always a non-empty string. When the wire body lacks a code
 *     we synthesize one (`network.offline`, `network.timeout`,
 *     `request.cancelled`, `unknown.server_error`).
 *
 * Notes on accessor shape — `ApiError` exposes `body`, `traceId`, `status`,
 * and `isNetworkError()` (a method, not a flag). The `code` lives on
 * `body.code` per the wire shape; `fields[]` lives on `body.fields`. We read
 * defensively from `body` because pre-Phase-7 callers may still receive
 * partial bodies.
 */

import type { ErrorClass } from '@prequest/shared';
import { ApiError } from '@/lib/api';

/** Caller hint passed by the helper that's invoking the classifier. */
export type CallSite = 'route_load' | 'mutation' | 'query';

export interface ClassifyContext {
  /** Where the error came from. Drives surface choice (page vs toast). */
  callSite?: CallSite;
  /** Re-run the failing operation. Recoveries reference this; classifier never invokes it. */
  retry?: () => void;
  /** Hard sign-out + sign-in. Auth-class recoveries use it. */
  signOutAndIn?: () => void;
  /** Support email surfaced on `contactSupport` recoveries. */
  supportEmail?: string;
}

/** Discriminated union of recovery affordances per spec §3.3. */
export type Recovery =
  | { kind: 'retry'; run: () => void }
  | { kind: 'wait'; until: number; run: () => void }
  | { kind: 'signIn'; next: string }
  | { kind: 'reload' }
  | { kind: 'goBack' }
  | { kind: 'pickAlternative'; alternatives: unknown[]; pick: (alt: unknown) => void }
  | { kind: 'askAdmin'; permission?: string; admins?: Array<{ id: string; name: string }> }
  | { kind: 'contactSupport'; traceId: string; supportEmail: string; supportPhone?: string }
  | { kind: 'copyDraft'; serialize: () => string }
  | { kind: 'dismiss' };

export interface ClassifiedField {
  field: string;
  code: string;
  message: string;
}

export interface ClassifiedError {
  /** Coarse class — drives surface + recovery selection per spec §3.3/§3.4. */
  class: ErrorClass;
  /** Wire `code` if present; else a synthesized client code. */
  code: string;
  /** Server-supplied title. Renderer prefers code-resolved copy. */
  title?: string;
  /** Server-supplied detail. Renderer uses as fallback only. */
  detail?: string;
  /** RFC 9457-style structured field issues (validation only). */
  fields?: ClassifiedField[];
  /** Server-emitted X-Request-Id, surfaced on server-class toasts + support flow. */
  traceId?: string;
  /** Optional doc URL the server may emit (rare). */
  docsUrl?: string;
  /** Seconds until rate-limit retry succeeds. */
  retryAfter?: number;
  /** Conflict-class versions (ETag / row version). */
  serverVersion?: string;
  clientVersion?: string;
  /** Ordered: most-likely-helpful first. Always >= 1 entry. */
  recoveries: Recovery[];
  /** Original error for logging. */
  raw: unknown;
}

// ─── Body accessors ─────────────────────────────────────────────────────────

interface WireBody {
  code?: string;
  title?: string;
  detail?: string;
  fields?: ClassifiedField[];
  docsUrl?: string;
  retryAfter?: number;
  serverVersion?: string;
  clientVersion?: string;
  message?: string;
}

function readBody(error: ApiError): WireBody {
  const b = error.body;
  if (!b || typeof b !== 'object') return {};
  return b as WireBody;
}

function readFields(body: WireBody): ClassifiedField[] | undefined {
  if (!Array.isArray(body.fields)) return undefined;
  // Defensive copy — caller shouldn't need to worry about server array reuse.
  return body.fields
    .filter(
      (f): f is ClassifiedField =>
        f != null &&
        typeof f === 'object' &&
        typeof (f as ClassifiedField).field === 'string' &&
        typeof (f as ClassifiedField).code === 'string' &&
        typeof (f as ClassifiedField).message === 'string',
    )
    .slice();
}

function isOffline(): boolean {
  if (typeof navigator === 'undefined') return false;
  // navigator.onLine is the closest thing browsers expose; combine with
  // explicit network errors below for confidence.
  return navigator.onLine === false;
}

// ─── classify ───────────────────────────────────────────────────────────────

export function classify(error: unknown, ctx: ClassifyContext = {}): ClassifiedError {
  const supportEmail = ctx.supportEmail ?? 'support@prequest.app';
  const recoveries: Recovery[] = [];
  // callSite is part of ClassifyContext for symmetry with the spec; the
  // surface decision lives in the handler/renderer (§3.4), not here.
  void ctx.callSite;

  // ── AbortError / signal cancellation ─────────────────────────────────────
  if (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      (error as { aborted?: boolean }).aborted === true)
  ) {
    return {
      class: 'transport',
      code: 'request.cancelled',
      recoveries: [{ kind: 'dismiss' }],
      raw: error,
    };
  }

  // ── ApiError branches ────────────────────────────────────────────────────
  if (error instanceof ApiError) {
    const body = readBody(error);
    const status = error.status;
    const traceId = error.traceId;
    const fields = readFields(body);

    const baseProps: Pick<
      ClassifiedError,
      'title' | 'detail' | 'docsUrl' | 'serverVersion' | 'clientVersion' | 'traceId' | 'raw'
    > = {
      title: body.title,
      detail: body.detail,
      docsUrl: body.docsUrl,
      serverVersion: body.serverVersion,
      clientVersion: body.clientVersion,
      traceId,
      raw: error,
    };

    // Network errors (apiFetch raised ApiError with status === 0).
    if (status === 0 || error.isNetworkError()) {
      const code = isOffline() ? 'network.offline' : body.code ?? 'network.timeout';
      if (ctx.retry) recoveries.push({ kind: 'retry', run: ctx.retry });
      recoveries.push({ kind: 'reload' });
      if (recoveries.length === 0) recoveries.push({ kind: 'dismiss' });
      return {
        ...baseProps,
        class: 'transport',
        code,
        recoveries,
      };
    }

    // 401 — auth.
    if (status === 401) {
      const next =
        typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';
      // signOutAndIn (if provided) is the app's imperative redirect; we
      // surface the signIn recovery descriptor either way so the UI layer
      // decides how to render.
      recoveries.push({ kind: 'signIn', next });
      recoveries.push({ kind: 'dismiss' });
      return {
        ...baseProps,
        class: 'auth',
        code: body.code ?? 'auth.unauthorized',
        recoveries,
      };
    }

    // 403 — permission.
    if (status === 403) {
      // askAdmin permission key is unknown unless server emitted it on body;
      // we omit `permission` rather than guess.
      recoveries.push({ kind: 'askAdmin' });
      recoveries.push({ kind: 'goBack' });
      recoveries.push({ kind: 'dismiss' });
      return {
        ...baseProps,
        class: 'permission',
        code: body.code ?? 'permission.denied',
        recoveries,
      };
    }

    // 404 / 410 — not_found.
    if (status === 404 || status === 410) {
      recoveries.push({ kind: 'goBack' });
      recoveries.push({ kind: 'dismiss' });
      return {
        ...baseProps,
        class: 'not_found',
        code: body.code ?? 'generic.not_found',
        recoveries,
      };
    }

    // 422 — validation. Form layer handles re-submission; classifier just
    // surfaces fields[] so the helper can route them to RHF setError.
    if (status === 422) {
      recoveries.push({ kind: 'dismiss' });
      return {
        ...baseProps,
        class: 'validation',
        code: body.code ?? 'validation.failed',
        fields,
        recoveries,
      };
    }

    // 409 — conflict.
    if (status === 409) {
      if (ctx.retry) recoveries.push({ kind: 'retry', run: ctx.retry });
      recoveries.push({ kind: 'reload' });
      recoveries.push({ kind: 'dismiss' });
      return {
        ...baseProps,
        class: 'conflict',
        code: body.code ?? 'generic.conflict',
        recoveries,
      };
    }

    // 429 — rate_limit.
    if (status === 429) {
      const retryAfter = typeof body.retryAfter === 'number' ? body.retryAfter : 30;
      const until = Date.now() + retryAfter * 1000;
      const run = ctx.retry ?? (() => {});
      recoveries.push({ kind: 'wait', until, run });
      recoveries.push({ kind: 'dismiss' });
      return {
        ...baseProps,
        class: 'rate_limit',
        code: body.code ?? 'rate_limit.exceeded',
        retryAfter,
        recoveries,
      };
    }

    // 5xx — server.
    if (status >= 500) {
      if (ctx.retry) recoveries.push({ kind: 'retry', run: ctx.retry });
      recoveries.push({
        kind: 'contactSupport',
        traceId: traceId ?? 'unknown',
        supportEmail,
      });
      // Always at least one recovery — contactSupport is unconditional.
      return {
        ...baseProps,
        class: 'server',
        code: body.code ?? 'unknown.server_error',
        recoveries,
      };
    }

    // Other 4xx — surface as validation-like miscellaneous; recovery is dismiss.
    recoveries.push({ kind: 'dismiss' });
    return {
      ...baseProps,
      class: 'validation',
      code: body.code ?? 'generic.bad_request',
      fields,
      recoveries,
    };
  }

  // ── Anything else (true unknown) ─────────────────────────────────────────
  recoveries.push({ kind: 'reload' });
  recoveries.push({
    kind: 'contactSupport',
    traceId: 'unknown',
    supportEmail,
  });
  return {
    class: 'unknown',
    code: 'unknown.server_error',
    recoveries,
    raw: error,
  };
}

export type { ErrorClass };
