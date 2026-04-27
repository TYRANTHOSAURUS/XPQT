/**
 * Toast helpers — thin wrapper around Sonner that bakes in the app's UX rules so
 * call sites stay short and consistent. See docs/toast-conventions if/when we
 * write one; the rules in short:
 *
 * 1. Title = outcome, description = detail. Never concatenate `Failed to X: ${err.message}`.
 * 2. Errors offer a Retry when the failing call is a re-runnable mutation.
 * 3. Successful creates offer a "View" action that navigates to the new entity.
 * 4. Reversible removes offer "Undo" (with longer duration so the user can react).
 * 5. Voice: errors say "Couldn't <verb> <thing>"; successes say "<Thing> <past-verb>".
 *
 * For one-offs that don't fit these helpers, import `toast` from this module
 * (re-exported from sonner) — don't add a new helper for a single call site.
 */

import { toast as sonner, type ExternalToast } from 'sonner';

export { toast } from 'sonner';

type RemovedVerb = 'removed' | 'deleted' | 'detached' | 'revoked' | 'archived' | 'deactivated' | 'unpublished' | 'cancelled';

function describeError(error: unknown): string | undefined {
  if (error == null) return undefined;
  if (error instanceof Error) return error.message || undefined;
  if (typeof error === 'string') return error || undefined;
  if (typeof error === 'object' && 'message' in error) {
    const msg = (error as { message?: unknown }).message;
    return typeof msg === 'string' && msg.length > 0 ? msg : undefined;
  }
  return undefined;
}

export type ToastErrorOptions = Omit<ExternalToast, 'description'> & {
  /** The error object to derive the description from. Mutually exclusive with `description`. */
  error?: unknown;
  /** Override the description. Use this when the server message is unhelpful and you have a clearer one. */
  description?: string;
  /** Re-runs the failing mutation. Adds a "Retry" action button. */
  retry?: () => void;
  /** Custom action label if "Retry" doesn't fit. Requires `retry`. */
  retryLabel?: string;
};

/**
 * Errors. Title is the human outcome ("Couldn't save webhook"); description is the
 * server message; action is a Retry. Pass `error` and we'll pull the message;
 * pass `description` to override.
 */
export function toastError(title: string, options?: ToastErrorOptions) {
  const { error, description, retry, retryLabel = 'Retry', ...rest } = options ?? {};
  return sonner.error(title, {
    ...rest,
    description: description ?? describeError(error),
    ...(retry ? { action: { label: retryLabel, onClick: retry } } : {}),
  });
}

export type ToastSuccessOptions = ExternalToast;

/**
 * Generic success. Use when there's no clear entity (e.g. "Reply sent", "API key copied").
 * For "X created" / "X removed" / "X saved", use the dedicated helpers below — they
 * enforce voice and prompt you to wire the right secondary action.
 */
export function toastSuccess(title: string, options?: ToastSuccessOptions) {
  return sonner.success(title, options);
}

export type ToastCreatedOptions = ExternalToast & {
  /** Navigates to the new entity. Adds a "View" action button. */
  onView?: () => void;
  /** Custom action label if "View" doesn't fit (e.g. "Open"). */
  viewLabel?: string;
};

/**
 * "X created". Almost always wants `onView` — the user just made the thing,
 * they're 90% likely to want to see it.
 */
export function toastCreated(entity: string, options?: ToastCreatedOptions) {
  const { onView, viewLabel = 'View', ...rest } = options ?? {};
  return sonner.success(`${entity} created`, {
    ...rest,
    ...(onView ? { action: { label: viewLabel, onClick: onView } } : {}),
  });
}

export type ToastSavedOptions = ExternalToast & {
  /** Suppress the toast entirely — used by debounced auto-save flows. */
  silent?: boolean;
};

/**
 * "X saved". Pass `{ silent: true }` from auto-save flows; the toast is then a
 * no-op. Cleaner than wrapping every call site in `if (!opts.silent)`.
 */
export function toastSaved(entity: string, options?: ToastSavedOptions) {
  if (options?.silent) return;
  const { silent: _silent, ...rest } = options ?? {};
  return sonner.success(`${entity} saved`, rest);
}

/**
 * "X updated". Same as `toastSaved` but past-tense for non-incremental writes
 * (e.g. role membership change). Most form-style writes should use `toastSaved`.
 */
export function toastUpdated(entity: string, options?: ExternalToast) {
  return sonner.success(`${entity} updated`, options);
}

export type ToastRemovedOptions = ExternalToast & {
  /** The verb to use. Default "removed". Pick the closest one — never invent. */
  verb?: RemovedVerb;
  /** Re-creates the deleted entity. Adds an "Undo" action button. */
  onUndo?: () => void;
};

/**
 * "X removed". Default duration is doubled (8s) so users can catch the Undo.
 * Pass a `verb` to switch the past tense — see `RemovedVerb`. Skip `onUndo`
 * only when the side-effects truly can't be reversed (audit emitted, webhook
 * fired, etc).
 */
export function toastRemoved(entity: string, options?: ToastRemovedOptions) {
  const { verb = 'removed', onUndo, duration = 8000, ...rest } = options ?? {};
  return sonner.success(`${entity} ${verb}`, {
    duration,
    ...rest,
    ...(onUndo ? { action: { label: 'Undo', onClick: onUndo } } : {}),
  });
}
