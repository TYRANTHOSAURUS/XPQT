/**
 * Visitor management — admin React Query module.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4, §11, §13
 * Backend: apps/api/src/modules/visitors/admin.controller.ts (slice 2d) +
 *          slice 9 additions (pool-anchors, by-anchor, kiosks list).
 *
 * Patterned after `docs/react-query-guidelines.md`:
 *  - extends the existing `visitorKeys` factory under an `admin` branch.
 *  - `queryOptions` helpers everywhere — never inline objects in `useQuery`.
 *  - mutations invalidate the relevant lists; we don't optimistically
 *    update the admin pages (admin reads aren't latency-sensitive and
 *    rolling back a mis-applied optimistic update at this layer would
 *    require knowing the full anchor row).
 */
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { visitorKeys, type VisitorType } from './keys';
import type { ReceptionPass } from './reception';

// ─── Types ─────────────────────────────────────────────────────────────────

/** Aggregated row per pool anchor — drives the pools index page. */
export interface PoolAnchorRow {
  space_id: string;
  space_kind: 'site' | 'building';
  space_name: string;
  pass_count: number;
  available_count: number;
  in_use_count: number;
  reserved_count: number;
  lost_count: number;
  retired_count: number;
  uses_visitor_passes: boolean;
}

/** Detail payload for a single pool anchor. */
export interface PoolAnchorDetail {
  anchor: {
    id: string;
    space_kind: 'site' | 'building';
    name: string;
    uses_visitor_passes: boolean;
  };
  passes: ReceptionPass[];
}

/** One row in the inheritance preview table on the pool detail page. */
export interface PoolInheritanceRow {
  id: string;
  name: string;
  type: 'site' | 'building' | string;
  covered: boolean;
  opted_out: boolean;
}

/** Kiosk token row. The plaintext token is NEVER returned by the list
 *  endpoint — only at provision/rotate time. */
export interface KioskTokenRow {
  id: string;
  tenant_id: string;
  building_id: string;
  building_name: string;
  active: boolean;
  rotated_at: string | null;
  expires_at: string;
  created_at: string;
}

export interface KioskProvisionResponse {
  token: string;
  kiosk_token_id: string;
  expires_at: string;
}

export interface KioskRotateResponse {
  token: string;
  expires_at: string;
}

// ─── Key factory extension ─────────────────────────────────────────────────

export const visitorAdminKeys = {
  all: [...visitorKeys.all, 'admin'] as const,
  // visitor types
  typesAdmin: () => [...visitorAdminKeys.all, 'types'] as const,
  // pool anchors
  poolAnchors: () => [...visitorAdminKeys.all, 'pool-anchors'] as const,
  poolAnchor: (spaceId: string) =>
    [...visitorAdminKeys.all, 'pool-anchor', spaceId] as const,
  poolInheritance: (spaceId: string) =>
    [...visitorAdminKeys.all, 'pool-inheritance', spaceId] as const,
  // kiosk tokens
  kiosks: (spaceId?: string | null) =>
    [...visitorAdminKeys.all, 'kiosks', spaceId ?? '__all__'] as const,
} as const;

// ─── Visitor types CRUD ────────────────────────────────────────────────────

/** Admin endpoint — returns active + inactive types. Different cache key
 *  from the host-facing `visitorKeys.types()` (which omits inactive). */
export function adminVisitorTypesOptions() {
  return queryOptions({
    queryKey: visitorAdminKeys.typesAdmin(),
    queryFn: ({ signal }) =>
      apiFetch<VisitorType[]>('/admin/visitors/types', { signal }),
    staleTime: 30_000,
  });
}

export function useAdminVisitorTypes() {
  return useQuery(adminVisitorTypesOptions());
}

export interface CreateVisitorTypePayload {
  type_key: string;
  display_name: string;
  description?: string;
  requires_approval?: boolean;
  allow_walk_up?: boolean;
  default_expected_until_offset_minutes?: number;
}

export function useCreateVisitorType() {
  const qc = useQueryClient();
  return useMutation<VisitorType, Error, CreateVisitorTypePayload>({
    mutationFn: (payload) =>
      apiFetch<VisitorType>('/admin/visitors/types', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.typesAdmin() });
      qc.invalidateQueries({ queryKey: visitorKeys.types() });
    },
  });
}

export interface UpdateVisitorTypePayload {
  display_name?: string;
  description?: string;
  requires_approval?: boolean;
  allow_walk_up?: boolean;
  default_expected_until_offset_minutes?: number;
  active?: boolean;
}

export function useUpdateVisitorType(id: string) {
  const qc = useQueryClient();
  return useMutation<VisitorType, Error, UpdateVisitorTypePayload>({
    mutationFn: (payload) =>
      apiFetch<VisitorType>(`/admin/visitors/types/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.typesAdmin() });
      qc.invalidateQueries({ queryKey: visitorKeys.types() });
    },
  });
}

/** Soft-delete via DELETE — backend sets active=false rather than hard
 *  delete (visitor rows reference visitor_types). */
export function useDeleteVisitorType() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) =>
      apiFetch<{ ok: true }>(`/admin/visitors/types/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.typesAdmin() });
      qc.invalidateQueries({ queryKey: visitorKeys.types() });
    },
  });
}

// ─── Pool anchors (index) ──────────────────────────────────────────────────

export function poolAnchorsOptions() {
  return queryOptions({
    queryKey: visitorAdminKeys.poolAnchors(),
    queryFn: ({ signal }) =>
      apiFetch<PoolAnchorRow[]>('/admin/visitors/pool-anchors', { signal }),
    staleTime: 30_000,
  });
}

export function usePoolAnchors() {
  return useQuery(poolAnchorsOptions());
}

// ─── Pool detail (per anchor) ──────────────────────────────────────────────

export function poolAnchorOptions(spaceId: string | null | undefined) {
  return queryOptions({
    queryKey: visitorAdminKeys.poolAnchor(spaceId ?? '__none__'),
    queryFn: ({ signal }) =>
      apiFetch<PoolAnchorDetail>(
        `/admin/visitors/pools/by-anchor/${spaceId}`,
        { signal },
      ),
    enabled: Boolean(spaceId),
    staleTime: 30_000,
  });
}

export function usePoolAnchor(spaceId: string | null | undefined) {
  return useQuery(poolAnchorOptions(spaceId));
}

export function poolInheritanceOptions(spaceId: string | null | undefined) {
  return queryOptions({
    queryKey: visitorAdminKeys.poolInheritance(spaceId ?? '__none__'),
    queryFn: ({ signal }) =>
      apiFetch<PoolInheritanceRow[]>(
        `/admin/visitors/pools/by-anchor/${spaceId}/inheritance`,
        { signal },
      ),
    enabled: Boolean(spaceId),
    staleTime: 60_000,
  });
}

export function usePoolInheritance(spaceId: string | null | undefined) {
  return useQuery(poolInheritanceOptions(spaceId));
}

// ─── Pool / pass mutations ─────────────────────────────────────────────────

/** Create a new pool. The backend treats this as "create one placeholder
 *  pass at this anchor"; the new anchor is implicitly the resolved
 *  space_id. Caller can immediately add real passes via useAddPass. */
export function useCreatePool() {
  const qc = useQueryClient();
  return useMutation<
    ReceptionPass,
    Error,
    { space_id: string; notes?: string }
  >({
    mutationFn: (payload) =>
      apiFetch<ReceptionPass>('/admin/visitors/pools', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.poolAnchors() });
    },
  });
}

/** Add a pass to an existing anchor. The poolId here is the anchor
 *  space_id (or any pass id at that anchor — backend resolves either). */
export function useAddPass(spaceId: string) {
  const qc = useQueryClient();
  return useMutation<
    ReceptionPass,
    Error,
    { pass_number: string; pass_type?: string; notes?: string }
  >({
    mutationFn: (payload) =>
      apiFetch<ReceptionPass>(`/admin/visitors/pools/${spaceId}/passes`, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.poolAnchor(spaceId) });
      qc.invalidateQueries({ queryKey: visitorAdminKeys.poolAnchors() });
    },
  });
}

/** Update notes / retire a pass. The PATCH endpoint is on the pass id
 *  itself, not nested under the anchor. */
export function useUpdatePass(spaceId: string) {
  const qc = useQueryClient();
  return useMutation<
    ReceptionPass,
    Error,
    { pass_id: string; notes?: string; retired?: boolean }
  >({
    mutationFn: ({ pass_id, ...patch }) =>
      apiFetch<ReceptionPass>(`/admin/visitors/pools/passes/${pass_id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.poolAnchor(spaceId) });
      qc.invalidateQueries({ queryKey: visitorAdminKeys.poolAnchors() });
    },
  });
}

export function useMarkPassRecoveredAdmin(spaceId: string) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (passId) =>
      apiFetch<{ ok: true }>(
        `/admin/visitors/pools/passes/${passId}/recovered`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.poolAnchor(spaceId) });
      qc.invalidateQueries({ queryKey: visitorAdminKeys.poolAnchors() });
    },
  });
}

// ─── Kiosk tokens ──────────────────────────────────────────────────────────

export function kioskTokensOptions(spaceId?: string | null) {
  return queryOptions({
    queryKey: visitorAdminKeys.kiosks(spaceId ?? null),
    queryFn: ({ signal }) =>
      apiFetch<KioskTokenRow[]>('/admin/visitors/kiosks', {
        signal,
        query: spaceId ? { space_id: spaceId } : undefined,
      }),
    staleTime: 30_000,
  });
}

export function useKioskTokens(spaceId?: string | null) {
  return useQuery(kioskTokensOptions(spaceId));
}

/** Provision a new kiosk token for a building. Returns plaintext ONCE —
 *  callers must surface it immediately. */
export function useProvisionKiosk() {
  const qc = useQueryClient();
  return useMutation<KioskProvisionResponse, Error, { building_id: string }>({
    mutationFn: ({ building_id }) =>
      apiFetch<KioskProvisionResponse>(
        `/admin/visitors/kiosks/${building_id}/provision`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.all });
    },
  });
}

export function useRotateKiosk() {
  const qc = useQueryClient();
  return useMutation<KioskRotateResponse, Error, { kiosk_token_id: string }>({
    mutationFn: ({ kiosk_token_id }) =>
      apiFetch<KioskRotateResponse>(
        `/admin/visitors/kiosks/${kiosk_token_id}/rotate`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.all });
    },
  });
}

export function useRevokeKiosk() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, { kiosk_token_id: string }>({
    mutationFn: ({ kiosk_token_id }) =>
      apiFetch<{ ok: true }>(
        `/admin/visitors/kiosks/${kiosk_token_id}/revoke`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: visitorAdminKeys.all });
    },
  });
}

// ─── Desk lens ─────────────────────────────────────────────────────────────

export interface DeskLensRow {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  status: string;
  expected_at: string | null;
  arrived_at: string | null;
  building_id: string | null;
  visitor_type_id: string | null;
  visitor_type_name: string | null;
  primary_host_name: string | null;
  booking_bundle_id?: string | null;
  seconds_since_arrival?: number;
}

export interface UnreturnedPassRow {
  id: string;
  pass_number: string;
  status: string;
  last_assigned_at: string | null;
  current_visitor_id: string | null;
  space_id: string;
  space_kind: string;
  notes: string | null;
}

export interface DeskLensPayload {
  contractors: DeskLensRow[];
  pending_approval: DeskLensRow[];
  escalations: {
    host_not_acknowledged: DeskLensRow[];
    unreturned_passes: UnreturnedPassRow[];
  };
}

export function deskLensOptions() {
  return queryOptions({
    queryKey: [...visitorKeys.all, 'desk-lens'] as const,
    queryFn: ({ signal }) =>
      apiFetch<DeskLensPayload>('/reception/desk-lens', { signal }),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useDeskLens() {
  return useQuery(deskLensOptions());
}
