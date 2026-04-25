import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

// ─── Types ──────────────────────────────────────────────────────────────

export interface CalendarSyncLink {
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

export interface SyncHealthResponse {
  rooms: SyncHealthRoom[];
  counters: {
    intercepted_30d: number;
    accepted_30d: number;
    denied_30d: number;
    unresolved_open: number;
  };
}

export interface ConflictRow {
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
  action: 'keep_internal' | 'keep_external' | 'wont_fix' | 'recreate';
  note?: string;
}

// ─── Keys ────────────────────────────────────────────────────────────────

export const calendarSyncKeys = {
  all: ['calendar-sync'] as const,
  me: () => [...calendarSyncKeys.all, 'me'] as const,
  admin: () => [...calendarSyncKeys.all, 'admin'] as const,
  health: () => [...calendarSyncKeys.admin(), 'health'] as const,
  conflicts: (status?: string) => [...calendarSyncKeys.admin(), 'conflicts', status ?? 'all'] as const,
} as const;

// ─── User-side ──────────────────────────────────────────────────────────

export function calendarSyncMeOptions() {
  return queryOptions({
    queryKey: calendarSyncKeys.me(),
    queryFn: ({ signal }) => apiFetch<CalendarSyncLink | null>('/calendar-sync/me', { signal }),
    staleTime: 30_000,
  });
}

export function useCalendarSyncMe() {
  return useQuery(calendarSyncMeOptions());
}

export function useStartConnect() {
  return useMutation<ConnectStartResponse, Error, void>({
    mutationFn: () => apiFetch<ConnectStartResponse>('/calendar-sync/connect', { method: 'POST' }),
  });
}

export function useFinishConnect() {
  const qc = useQueryClient();
  return useMutation<CalendarSyncLink, Error, OAuthCallbackBody>({
    mutationFn: (body) =>
      apiFetch<CalendarSyncLink>('/calendar-sync/callback', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: calendarSyncKeys.me() }),
  });
}

export function useDisconnectCalendar() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, void>({
    mutationFn: () => apiFetch<{ ok: true }>('/calendar-sync/outlook', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: calendarSyncKeys.me() }),
  });
}

export function useForceResync() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; events_seen: number }, Error, void>({
    mutationFn: () =>
      apiFetch<{ ok: true; events_seen: number }>('/calendar-sync/outlook/resync', {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: calendarSyncKeys.me() }),
  });
}

// ─── Admin ───────────────────────────────────────────────────────────────

export function calendarSyncHealthOptions() {
  return queryOptions({
    queryKey: calendarSyncKeys.health(),
    queryFn: ({ signal }) => apiFetch<SyncHealthResponse>('/admin/calendar-sync/health', { signal }),
    staleTime: 30_000,
  });
}

export function useCalendarSyncHealth() {
  return useQuery(calendarSyncHealthOptions());
}

export function calendarSyncConflictsOptions(status?: string) {
  return queryOptions({
    queryKey: calendarSyncKeys.conflicts(status),
    queryFn: ({ signal }) =>
      apiFetch<ConflictRow[]>('/admin/calendar-sync/conflicts', {
        query: { status, limit: 200 },
        signal,
      }),
    staleTime: 15_000,
  });
}

export function useCalendarSyncConflicts(status?: string) {
  return useQuery(calendarSyncConflictsOptions(status));
}

export function useResolveConflict() {
  const qc = useQueryClient();
  return useMutation<ConflictRow, Error, { id: string; body: ResolveConflictBody }>({
    mutationFn: ({ id, body }) =>
      apiFetch<ConflictRow>(`/admin/calendar-sync/conflicts/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: calendarSyncKeys.admin() });
    },
  });
}
