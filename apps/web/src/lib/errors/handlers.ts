/**
 * Error handlers — Phase 7.B-2 foundation.
 *
 * Three composable helpers per spec §3.5:
 *
 *   1. `withErrorHandling(opts)` — spread into useMutation options. Returns
 *      `{ onError }`. The simplest call site (no rollback, no optimistic
 *      cache).
 *
 *   2. `handleMutationError(error, opts)` — call from inside your own
 *      `onError` when you also need rollback / cache invalidation. Composes
 *      with React Query's contract (caller owns onError; this is a delegate).
 *
 *   3. `handleQueryError(error, opts)` — call from a useEffect for
 *      sidebar / autocomplete query errors. Page-primary queries use
 *      `usePageQuery` (separate module) which auto-throws to the error
 *      boundary instead of toasting.
 *
 * The surface decision (toast vs. throw-to-boundary vs. inline) is made per
 * spec §3.4 matrix:
 *
 *     class       | route_load     | mutation/query
 *     ────────────┼────────────────┼────────────────
 *     transport   | toast (banner is layered separately)
 *     auth        | silent (host app handles redirect)
 *     permission  | throw          | toast
 *     not_found   | throw          | toast
 *     validation  | inline (RHF setError) — never toast
 *     conflict    | toast
 *     rate_limit  | toast
 *     server      | throw          | toast (with traceId)
 *     unknown     | throw          | toast
 *
 * `withErrorHandling` and `handleMutationError` default to callSite='mutation'.
 * `handleQueryError` requires an explicit callSite.
 *
 * Voice: callers pass `actionTitle` written in the toast voice
 * ("Couldn't save webhook"). The renderer never invents the title — failing
 * to pass one for a user-visible mutation is a bug caught in code review.
 */

import type { FieldError } from 'react-hook-form';
import { toastError } from '@/lib/toast';
import { classify, type CallSite, type ClassifiedField, type ClassifiedError } from './classify';
import { resolveMessage } from './messages.en';

type SetFormError = (field: string, error: FieldError) => void;

// ─── Common surface decision ────────────────────────────────────────────────

/** Page-class errors that replace the page rather than toasting over it. */
const PAGE_CLASSES = new Set(['not_found', 'permission', 'server', 'unknown']);

function shouldThrowToBoundary(
  classified: ClassifiedError,
  callSite: CallSite,
): boolean {
  return callSite === 'route_load' && PAGE_CLASSES.has(classified.class);
}

function applyValidation(
  fields: ClassifiedField[] | undefined,
  setFormError: SetFormError | undefined,
): boolean {
  // Returns true when the validation surfaces to the form (so the caller
  // shouldn't also fire a toast for the same error).
  if (!fields || fields.length === 0 || !setFormError) return false;
  for (const f of fields) {
    setFormError(f.field, { type: f.code, message: f.message });
  }
  return true;
}

function fireToast(
  classified: ClassifiedError,
  actionTitle: string,
  retry: (() => void) | undefined,
): void {
  const resolved = resolveMessage(classified.code, 'toast');
  // The actionTitle is the canonical toast title (voice rule); the
  // code-resolved detail is the description. Server's raw `detail` /
  // `error.message` is intentionally NOT surfaced.
  toastError(actionTitle, {
    description: resolved.detail,
    retry,
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface HandleMutationErrorOptions {
  actionTitle: string;
  retry?: () => void;
  setFormError?: SetFormError;
  /** Override the call site. Default: 'mutation'. */
  callSite?: CallSite;
}

/**
 * Call this from inside your own `onError` when you also need rollback /
 * cache invalidation:
 *
 * ```ts
 * useMutation({
 *   onMutate: async (vars) => { ... },
 *   onError: (err, vars, ctx) => {
 *     rollback(ctx);
 *     handleMutationError(err, { actionTitle: "Couldn't save webhook" });
 *   },
 * });
 * ```
 */
export function handleMutationError(
  error: unknown,
  opts: HandleMutationErrorOptions,
): void {
  const callSite = opts.callSite ?? 'mutation';
  const classified = classify(error, { callSite, retry: opts.retry });

  // Validation: route fields[] to RHF. If we surfaced fields, suppress the
  // generic toast — the form is the surface. If no setFormError was given
  // we fall back to a single generic toast describing the validation failure.
  if (classified.class === 'validation') {
    const handled = applyValidation(classified.fields, opts.setFormError);
    if (!handled) {
      fireToast(classified, opts.actionTitle, undefined);
    }
    return;
  }

  // Transport (network) on a mutation surfaces as a toast — the offline
  // banner (§3.4) is a separate layer that handles ambient state.
  // Auth: silent — host app's session-expiry handler deals with redirect.
  if (classified.class === 'auth') return;

  // Page-class on route_load → boundary. (Mutations don't throw; only
  // queries pass route_load, but keep the branch general.)
  if (shouldThrowToBoundary(classified, callSite)) {
    throw classified.raw;
  }

  fireToast(classified, opts.actionTitle, opts.retry);
}

/**
 * Spread into useMutation options when you don't already have an onError:
 *
 * ```ts
 * useMutation({
 *   mutationFn: api.saveWebhook,
 *   ...withErrorHandling({ actionTitle: "Couldn't save webhook" }),
 * });
 * ```
 */
export function withErrorHandling(
  opts: HandleMutationErrorOptions,
): { onError: (error: unknown) => void } {
  return {
    onError: (error: unknown) => handleMutationError(error, opts),
  };
}

export interface HandleQueryErrorOptions {
  /** 'query' for sidebar/autocomplete; 'route_load' for page-primary (use `usePageQuery` instead, normally). */
  callSite: CallSite;
  /** Toast title in the voice "Couldn't load <thing>". Required for toast surfaces. */
  actionTitle?: string;
  retry?: () => void;
}

/**
 * For sidebar / autocomplete / prefetch queries. Call from a useEffect
 * watching `result.error`. Page-primary queries should use `usePageQuery`
 * — that helper escalates page-class errors to RouteErrorBoundary.
 *
 * ```ts
 * const { data, error } = useQuery(...);
 * useEffect(() => {
 *   if (error) handleQueryError(error, { callSite: 'query', actionTitle: "Couldn't load workflows" });
 * }, [error]);
 * ```
 */
export function handleQueryError(error: unknown, opts: HandleQueryErrorOptions): void {
  const classified = classify(error, { callSite: opts.callSite, retry: opts.retry });

  // Validation isn't a query failure mode in practice (queries don't have
  // form fields), but the matrix says "never toast"; bail.
  if (classified.class === 'validation') return;
  if (classified.class === 'auth') return;
  // Cancellation: user's intent. Suppress.
  if (classified.code === 'request.cancelled') return;

  if (shouldThrowToBoundary(classified, opts.callSite)) {
    throw classified.raw;
  }

  // Toast surface. Sidebar errors fall back to a generic title if the call
  // site didn't pass one — better a generic toast than a swallow.
  const actionTitle = opts.actionTitle ?? "Couldn't load that";
  fireToast(classified, actionTitle, opts.retry);
}
