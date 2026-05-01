/**
 * Reception workspace — React Query module.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.
 * Backend: apps/api/src/modules/visitors/reception.controller.ts (slice 2d).
 *
 * Patterned after `docs/react-query-guidelines.md`:
 *  - extends the existing `visitorKeys` factory under a `reception` branch.
 *  - `queryOptions` helpers for every screen so callers never inline the
 *    `queryKey` literal.
 *  - mutations live next to the queries; today-view + passes are
 *    optimistically updated where the state flip is unambiguous (status
 *    goes from `expected` → `arrived`, pass from `available` → `in_use`).
 *
 * The reception workspace gates every endpoint on `building_id` (the
 * receptionist's currently-selected building). The hooks accept
 * `building_id: string | null | undefined` — when null we keep the query
 * disabled rather than firing a 400.
 */
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { visitorKeys, type VisitorStatus } from './index';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Row shape returned by every reception list endpoint (today / search /
 *  daglijst). Flat enough to render directly into a list row without
 *  another lookup. */
export interface ReceptionVisitorRow {
  visitor_id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  primary_host_first_name: string | null;
  primary_host_last_name: string | null;
  expected_at: string | null;
  arrived_at: string | null;
  status: VisitorStatus;
  visitor_pass_id: string | null;
  pass_number: string | null;
  visitor_type_id: string | null;
}

/** The today-view bucketed payload from `GET /reception/today`. */
export interface ReceptionTodayView {
  building_id: string;
  generated_at: string;
  currently_arriving: ReceptionVisitorRow[];
  expected: ReceptionVisitorRow[];
  in_meeting: ReceptionVisitorRow[];
  checked_out_today: ReceptionVisitorRow[];
}

/** Pass pool row (mirrors apps/api/.../pass-pool.service.ts VisitorPassPool). */
export type ReceptionPassStatus =
  | 'available'
  | 'reserved'
  | 'in_use'
  | 'lost'
  | 'retired';

export interface ReceptionPass {
  id: string;
  tenant_id: string;
  space_id: string;
  space_kind: 'site' | 'building';
  pass_number: string;
  pass_type: string;
  status: ReceptionPassStatus;
  current_visitor_id: string | null;
  reserved_for_visitor_id: string | null;
  last_assigned_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Bounced-email row surfaced in the yesterday tile. */
export interface BouncedInviteRow {
  visitor_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  bounced_at: string;
  reason: string | null;
}

export interface ReceptionYesterdayLooseEnds {
  auto_checked_out_count: number;
  unreturned_passes: ReceptionPass[];
  bounced_emails: BouncedInviteRow[];
}

/** Quick-add walkup body. Mirrors `ReceptionWalkupSchema` in the backend. */
export interface QuickAddWalkupPayload {
  first_name: string;
  last_name?: string;
  company?: string;
  email?: string;
  phone?: string;
  visitor_type_id: string;
  primary_host_person_id: string;
  arrived_at?: string;
}

export interface CheckInPayload {
  /** Optional explicit arrival timestamp — defaults to now() server-side. */
  arrived_at?: string;
}

export interface CheckOutPayload {
  checkout_source: 'reception' | 'host';
  /** Whether the visitor returned their pass. Undefined = "skip" — leaves
   *  pass state alone so the loose-ends tile can reconcile later. */
  pass_returned?: boolean;
}

// ─── Key factory extension ─────────────────────────────────────────────────

/** Reception keys live under the visitors namespace so an `invalidate(['visitors'])`
 *  blast hits both the host's expected list AND the reception views. */
export const receptionKeys = {
  all: [...visitorKeys.all, 'reception'] as const,
  today: (buildingId: string) =>
    [...receptionKeys.all, 'today', buildingId] as const,
  search: (buildingId: string, q: string) =>
    [...receptionKeys.all, 'search', buildingId, q] as const,
  yesterday: (buildingId: string) =>
    [...receptionKeys.all, 'yesterday', buildingId] as const,
  daglijst: (buildingId: string) =>
    [...receptionKeys.all, 'daglijst', buildingId] as const,
  passes: (buildingId: string) =>
    [...receptionKeys.all, 'passes', buildingId] as const,
} as const;

// ─── Query options ─────────────────────────────────────────────────────────

/** GET /reception/today — bucketed view of today's visitors at this building.
 *
 *  Refetches every 15s while the query is active so the 9am-rush surface
 *  stays live without users having to manually reload. SSE could push
 *  faster, but polling is simpler and the worst case (one stale row for
 *  15s) is still acceptable for v1. */
export function receptionTodayOptions(buildingId: string | null | undefined) {
  return queryOptions({
    queryKey: receptionKeys.today(buildingId ?? '__none__'),
    queryFn: ({ signal }) =>
      apiFetch<ReceptionTodayView>('/reception/today', {
        signal,
        query: { building_id: buildingId ?? undefined },
      }),
    enabled: Boolean(buildingId),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function useReceptionToday(buildingId: string | null | undefined) {
  return useQuery(receptionTodayOptions(buildingId));
}

/** GET /reception/search — type-ahead by visitor / company / host name.
 *
 *  Empty query returns an empty array client-side without firing a request.
 *  Caller is expected to debounce the input. */
export function receptionSearchOptions(
  buildingId: string | null | undefined,
  query: string,
) {
  const trimmed = query.trim();
  return queryOptions({
    queryKey: receptionKeys.search(buildingId ?? '__none__', trimmed),
    queryFn: ({ signal }) =>
      apiFetch<ReceptionVisitorRow[]>('/reception/search', {
        signal,
        query: { building_id: buildingId ?? undefined, q: trimmed },
      }),
    enabled: Boolean(buildingId) && trimmed.length > 0,
    staleTime: 5_000,
  });
}

export function useReceptionSearch(
  buildingId: string | null | undefined,
  query: string,
) {
  return useQuery(receptionSearchOptions(buildingId, query));
}

export function receptionYesterdayOptions(
  buildingId: string | null | undefined,
) {
  return queryOptions({
    queryKey: receptionKeys.yesterday(buildingId ?? '__none__'),
    queryFn: ({ signal }) =>
      apiFetch<ReceptionYesterdayLooseEnds>('/reception/yesterday', {
        signal,
        query: { building_id: buildingId ?? undefined },
      }),
    enabled: Boolean(buildingId),
    staleTime: 30_000,
  });
}

export function useReceptionYesterday(buildingId: string | null | undefined) {
  return useQuery(receptionYesterdayOptions(buildingId));
}

export function receptionDaglijstOptions(
  buildingId: string | null | undefined,
) {
  return queryOptions({
    queryKey: receptionKeys.daglijst(buildingId ?? '__none__'),
    queryFn: ({ signal }) =>
      apiFetch<ReceptionVisitorRow[]>('/reception/daglijst', {
        signal,
        query: { building_id: buildingId ?? undefined },
      }),
    enabled: Boolean(buildingId),
    staleTime: 30_000,
  });
}

export function useReceptionDaglijst(buildingId: string | null | undefined) {
  return useQuery(receptionDaglijstOptions(buildingId));
}

/** Pass pool inventory for a building.
 *
 *  Slice 9 added the dedicated `GET /reception/passes?building_id=…`
 *  endpoint — it resolves the most-specific anchor pool via
 *  `pass_pool_for_space()` server-side and returns the full pass list
 *  at that anchor. Non-admin receptionists can call this without 403.
 */
export function passPoolOptions(buildingId: string | null | undefined) {
  return queryOptions({
    queryKey: receptionKeys.passes(buildingId ?? '__none__'),
    queryFn: ({ signal }) =>
      apiFetch<ReceptionPass[]>('/reception/passes', {
        signal,
        query: { building_id: buildingId ?? undefined },
      }),
    enabled: Boolean(buildingId),
    staleTime: 30_000,
  });
}

export function useReceptionPasses(buildingId: string | null | undefined) {
  return useQuery(passPoolOptions(buildingId));
}

// ─── Mutations ─────────────────────────────────────────────────────────────

/** POST /reception/visitors/:id/check-in — mark visitor arrived. */
export function useMarkArrived(buildingId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { visitorId: string; arrived_at?: string }>({
    mutationFn: ({ visitorId, arrived_at }) =>
      apiFetch<{ ok: true }>(`/reception/visitors/${visitorId}/check-in`, {
        method: 'POST',
        body: JSON.stringify({ arrived_at }),
      }),
    onMutate: async ({ visitorId, arrived_at }) => {
      if (!buildingId) return { previous: undefined };
      const key = receptionKeys.today(buildingId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ReceptionTodayView>(key);
      // Optimistic move: any matching row in `expected` flips to `arrived`
      // and shifts into `currently_arriving`.
      if (previous) {
        const moved = previous.expected.find((v) => v.visitor_id === visitorId);
        if (moved) {
          const updated: ReceptionVisitorRow = {
            ...moved,
            status: 'arrived',
            arrived_at: arrived_at ?? new Date().toISOString(),
          };
          qc.setQueryData<ReceptionTodayView>(key, {
            ...previous,
            expected: previous.expected.filter((v) => v.visitor_id !== visitorId),
            currently_arriving: [updated, ...previous.currently_arriving],
          });
        }
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      const snap = (ctx as { previous?: ReceptionTodayView } | undefined)?.previous;
      if (snap && buildingId) {
        qc.setQueryData(receptionKeys.today(buildingId), snap);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: visitorKeys.all });
    },
  });
}

/** POST /reception/visitors/:id/check-out — mark visitor checked-out. */
export function useMarkCheckedOut(buildingId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { visitorId: string } & CheckOutPayload>({
    mutationFn: ({ visitorId, ...body }) =>
      apiFetch<{ ok: true }>(`/reception/visitors/${visitorId}/check-out`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: visitorKeys.all });
      if (buildingId) {
        qc.invalidateQueries({ queryKey: receptionKeys.passes(buildingId) });
      }
    },
  });
}

/** POST /reception/visitors/:id/no-show. */
export function useMarkNoShow(buildingId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { visitorId: string }>({
    mutationFn: ({ visitorId }) =>
      apiFetch<{ ok: true }>(`/reception/visitors/${visitorId}/no-show`, {
        method: 'POST',
      }),
    onMutate: async ({ visitorId }) => {
      if (!buildingId) return { previous: undefined };
      const key = receptionKeys.today(buildingId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ReceptionTodayView>(key);
      if (previous) {
        // Drop the row from the `expected` bucket immediately.
        qc.setQueryData<ReceptionTodayView>(key, {
          ...previous,
          expected: previous.expected.filter((v) => v.visitor_id !== visitorId),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      const snap = (ctx as { previous?: ReceptionTodayView } | undefined)?.previous;
      if (snap && buildingId) {
        qc.setQueryData(receptionKeys.today(buildingId), snap);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: visitorKeys.all });
    },
  });
}

/** POST /reception/walk-up — quick-add a walk-in visitor.
 *
 *  Sends `X-Building-Id` header (required by the backend per slice 2d) so
 *  the visitor row anchors to the receptionist's building scope. */
export function useQuickAddWalkup(buildingId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ visitor_id: string }, Error, QuickAddWalkupPayload>({
    mutationFn: (payload) =>
      apiFetch<{ visitor_id: string }>('/reception/walk-up', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: buildingId ? { 'X-Building-Id': buildingId } : undefined,
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: visitorKeys.all });
    },
  });
}

// ─── Pass mutations ────────────────────────────────────────────────────────

export function useAssignPass(buildingId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { passId: string; visitorId: string }>({
    mutationFn: ({ passId, visitorId }) =>
      apiFetch<{ ok: true }>(`/reception/passes/${passId}/assign`, {
        method: 'POST',
        body: JSON.stringify({ visitor_id: visitorId }),
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: visitorKeys.all });
      if (buildingId) {
        qc.invalidateQueries({ queryKey: receptionKeys.passes(buildingId) });
      }
    },
  });
}

export function useReservePass(buildingId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { passId: string; visitorId: string }>({
    mutationFn: ({ passId, visitorId }) =>
      apiFetch<{ ok: true }>(`/reception/passes/${passId}/reserve`, {
        method: 'POST',
        body: JSON.stringify({ visitor_id: visitorId }),
      }),
    onSettled: () => {
      if (buildingId) {
        qc.invalidateQueries({ queryKey: receptionKeys.passes(buildingId) });
      }
    },
  });
}

export function useReturnPass(buildingId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { passId: string }>({
    mutationFn: ({ passId }) =>
      apiFetch<{ ok: true }>(`/reception/passes/${passId}/return`, {
        method: 'POST',
      }),
    onSettled: () => {
      if (buildingId) {
        qc.invalidateQueries({ queryKey: receptionKeys.passes(buildingId) });
      }
    },
  });
}

export function useMarkPassMissing(buildingId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { passId: string; reason?: string }>({
    mutationFn: ({ passId, reason }) =>
      apiFetch<{ ok: true }>(`/reception/passes/${passId}/missing`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSettled: () => {
      if (buildingId) {
        qc.invalidateQueries({ queryKey: receptionKeys.passes(buildingId) });
        qc.invalidateQueries({ queryKey: receptionKeys.yesterday(buildingId) });
      }
    },
  });
}

export function useMarkPassRecovered(buildingId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { passId: string }>({
    mutationFn: ({ passId }) =>
      apiFetch<{ ok: true }>(`/reception/passes/${passId}/recovered`, {
        method: 'POST',
      }),
    onSettled: () => {
      if (buildingId) {
        qc.invalidateQueries({ queryKey: receptionKeys.passes(buildingId) });
        qc.invalidateQueries({ queryKey: receptionKeys.yesterday(buildingId) });
      }
    },
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Compose a visitor row's display name. Same shape as ExpectedVisitor's
 *  helper — we duplicate locally because reception rows have a different
 *  field set (no `email`, primary-host name fields). */
export function formatReceptionRowName(row: ReceptionVisitorRow): string {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  if (row.company) return `${name} (${row.company})`;
  return name || 'Unknown';
}

/** Compose the primary host's first name for display in a row. */
export function formatPrimaryHost(row: ReceptionVisitorRow): string | null {
  const name = [row.primary_host_first_name, row.primary_host_last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name.length > 0 ? name : null;
}
