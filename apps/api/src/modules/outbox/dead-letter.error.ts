/**
 * Sentinel error for handler-driven dead-letters.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §4.5.
 *
 * When a handler determines an event is unrecoverable and SHOULD bypass the
 * normal retry/backoff schedule (e.g. tenant mismatch detected at handler
 * dispatch — a structural defense not covered by RLS in the worker because
 * service-role bypasses RLS), it throws `DeadLetterError`. The worker
 * recognises this exact class and goes straight to the §4.2.3 dead-letter
 * transition with `dead_letter_reason = 'dead_letter_error'`.
 *
 * Any other error (including subclasses of `Error`) is treated as transient
 * and retried per §4.4.
 */
export class DeadLetterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadLetterError';
    // Recover prototype chain across transpilation targets so
    // `err instanceof DeadLetterError` works reliably in the worker.
    Object.setPrototypeOf(this, DeadLetterError.prototype);
  }
}
