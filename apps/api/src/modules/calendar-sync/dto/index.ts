/**
 * DTOs for the calendar-sync module. Kept lightweight — most validation is in
 * the service layer because the surface is narrow (admin + per-user endpoints).
 */

export interface CalendarSyncLinkView {
  id: string;
  user_id: string;
  provider: 'outlook';
  external_calendar_id: string;
  sync_status: 'active' | 'error' | 'disabled';
  last_synced_at: string | null;
  last_error: string | null;
  expires_at: string | null;
  webhook_subscription_id: string | null;
  webhook_expires_at: string | null;
}

export interface ConnectStartResponse {
  authUrl: string;
  state: string;
}

export interface OAuthCallbackBody {
  code: string;
  state: string;
}

export interface SyncHealthRoom {
  space_id: string;
  space_name: string;
  calendar_sync_mode: 'pattern_a' | 'pattern_b';
  external_calendar_id: string | null;
  external_calendar_subscription_id: string | null;
  external_calendar_subscription_expires_at: string | null;
  external_calendar_last_full_sync_at: string | null;
  open_conflicts: number;
  last_30d: {
    intercepted: number;
    accepted: number;
    denied: number;
    unresolved: number;
  };
}

export interface ConflictView {
  id: string;
  space_id: string;
  space_name: string | null;
  detected_at: string;
  conflict_type:
    | 'etag_mismatch'
    | 'recurrence_drift'
    | 'orphan_external'
    | 'orphan_internal'
    | 'webhook_miss_recovered';
  reservation_id: string | null;
  external_event_id: string | null;
  external_event_payload: Record<string, unknown> | null;
  resolution_status: 'open' | 'auto_resolved' | 'admin_resolved' | 'wont_fix';
  resolution_action: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface ResolveConflictBody {
  /**
   * `keep_internal`  – cancel the external event, keep the Prequest reservation.
   * `keep_external`  – cancel the Prequest reservation, adopt the external event.
   * `wont_fix`       – mark as wont_fix without changes.
   * `recreate`       – re-run the inbound webhook intercept against the external event payload.
   */
  action: 'keep_internal' | 'keep_external' | 'wont_fix' | 'recreate';
  note?: string;
}
