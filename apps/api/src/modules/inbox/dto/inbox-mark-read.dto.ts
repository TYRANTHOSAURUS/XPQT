/**
 * Inbox mark-read DTOs.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step E.
 *
 * POST /me/inbox/:id/read and POST /me/inbox/read-all both have empty
 * request bodies — `:id` is the path param, the actor is the JWT.
 * The DTOs here are response-only.
 */

/** POST /me/inbox/:id/read response. */
export interface InboxMarkReadResponse {
  /** Row id (uuid) — echoed for client-side cache reconciliation. */
  id: string;
  /**
   * Read timestamp (ISO-8601 UTC). On idempotent re-mark, this is the
   * EXISTING read_at (never bumped) — the row's `read_at` is set on
   * first transition and locked thereafter, so the client's cached
   * timestamp stays stable across retries.
   */
  readAt: string;
}

/** POST /me/inbox/read-all response. */
export interface InboxMarkAllReadResponse {
  /**
   * Number of rows transitioned from read_at IS NULL to read_at = now()
   * by this call. Already-read rows are not counted (idempotency);
   * `marked === 0` is a valid response.
   */
  marked: number;
}
