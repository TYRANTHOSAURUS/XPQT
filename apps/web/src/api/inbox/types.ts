/**
 * Wire-shape types for the `/me/inbox` API surface.
 *
 * Source of truth: apps/api/src/modules/inbox/dto/inbox-list.dto.ts +
 * apps/api/src/modules/inbox/dto/inbox-mark-read.dto.ts. The shapes here
 * MUST mirror those DTOs — the inbox API is brand-new (sub-step E) and
 * uses camelCase wire keys per docs/react-query-guidelines.md §10.2.
 *
 * If an upstream DTO field changes, change it here in the same PR.
 */

/** One inbox row as returned by GET /me/inbox. */
export interface InboxItemDto {
  /** Row id (uuid). */
  id: string;
  /** Event family that produced the notification (e.g. `booking.approval_required`). */
  eventKind: string;
  /** Pass-through payload from the producing RPC / handler. */
  payload: Record<string, unknown>;
  /** Null = unread. ISO-8601 UTC when flipped. */
  readAt: string | null;
  /** ISO-8601 UTC creation timestamp. */
  createdAt: string;
  /** Pre-rendered single-line summary, always present. */
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
  /** Rows where read_at IS NULL. */
  unread: number;
  /** All rows for the current (tenant_id, user_id) — bounded by retention. */
  total: number;
}

/** POST /me/inbox/:id/read response. */
export interface InboxMarkReadResponse {
  id: string;
  readAt: string;
}

/** POST /me/inbox/read-all response. */
export interface InboxMarkAllReadResponse {
  marked: number;
}

/** Default page size — mirrors INBOX_DEFAULT_LIMIT in the API. */
export const INBOX_DEFAULT_LIMIT = 20;
