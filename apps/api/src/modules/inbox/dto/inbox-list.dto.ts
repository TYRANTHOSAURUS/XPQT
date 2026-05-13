/**
 * Inbox list DTOs — request + response shapes for GET /me/inbox + /count.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step E.
 *
 * Wire-shape contract for the React Query factory in sub-step F. Camel-case
 * keys per docs/react-query-guidelines.md §10.2 (`nextCursor`, not
 * `next_cursor`) — the inbox surface is brand-new and has no legacy
 * snake_case consumers to preserve.
 *
 * Cursor format: base64url(`${created_atISO}:${id}`). Opaque to callers;
 * callers round-trip the value verbatim. Order is `created_at DESC, id DESC`
 * — the cursor encodes the LAST-emitted row's tuple so the next page filters
 * `(created_at, id) < (cursor.created_at, cursor.id)` lexicographically.
 *
 * Citations:
 *   - apps/api/src/modules/notifications/templates/types.ts:64-85
 *       BookingApprovalRequiredPayload — typed payload for the
 *       `booking.approval_required` event kind. The summary helper below
 *       narrows on `eventKind === 'booking.approval_required'` and reads
 *       these fields with safe fallbacks.
 *   - supabase/migrations/00391_inbox_notifications.sql:34-42
 *       inbox_notifications table columns — id / tenant_id / user_id /
 *       event_kind / payload / read_at / created_at.
 */

/** One inbox row as returned by GET /me/inbox. */
export interface InboxItemDto {
  /** Row id (uuid). */
  id: string;
  /** Event family that produced the notification (e.g. `booking.approval_required`). */
  eventKind: string;
  /**
   * Pass-through payload from the producing RPC / handler. Frontend renders
   * per-kind UI from this — the bell-popover preview falls back to `summary`.
   */
  payload: Record<string, unknown>;
  /** Null = unread. ISO-8601 UTC when flipped. */
  readAt: string | null;
  /** ISO-8601 UTC creation timestamp. */
  createdAt: string;
  /**
   * Pre-rendered single-line summary suitable for the bell-popover preview
   * (subject-line voice, no HTML). For known event kinds the summary uses
   * typed payload fields; for unknown kinds it falls back to the eventKind
   * string. Always present (never empty) so the frontend never has to
   * re-parse `payload` for a list-view render.
   */
  summary: string;
}

/** GET /me/inbox response envelope. */
export interface InboxListResponse {
  items: InboxItemDto[];
  /** Opaque cursor for the next page; `null` when this page is the last. */
  nextCursor: string | null;
}

/** GET /me/inbox/count response envelope. */
export interface InboxCountResponse {
  /** Rows where read_at IS NULL within (tenant_id, user_id). */
  unread: number;
  /** All rows for the current (tenant_id, user_id) — bounded by retention. */
  total: number;
}

/** Default page size when the caller doesn't pass `limit`. */
export const INBOX_DEFAULT_LIMIT = 20;

/** Hard cap on `limit` per page. */
export const INBOX_MAX_LIMIT = 100;
