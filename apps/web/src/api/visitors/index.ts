/**
 * Visitor management — React Query module.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §2, §6.
 * Backend: apps/api/src/modules/visitors/visitors.controller.ts.
 *
 * Patterned after `docs/react-query-guidelines.md`:
 *  - one key factory per module, hierarchical (`all → lists/details`).
 *  - `queryOptions` helpers everywhere — never inline objects in `useQuery`.
 *  - mutations live next to the queries; `useCancelInvitationViaToken`
 *    optimistically flips status='cancelled' and rolls back on failure.
 *
 * Ownership of the visitor types lookup:
 *  - The only listing endpoint shipped in slice 2d is `/admin/visitors/types`
 *    behind `AdminGuard`. Hosts (the only callers we have today) don't have
 *    admin role, so calling that surface from the portal would 403. Until
 *    slice 9 introduces a host-accessible `/visitor-types` (or similar), the
 *    web caches a hardcoded fallback list of the six tenant defaults seeded
 *    by migration `00257_visitor_types_seed.sql`. The id is unknown
 *    client-side, so the form sends `type_key` instead and the host posts
 *    by `visitor_type_key` as a request-time alias the backend can resolve.
 *    TODO: replace fallback once a host endpoint exists.
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { visitorKeys, type VisitorStatus, type VisitorType } from './keys';

// Re-export the shared keys + types so existing `import { visitorKeys } from
// '@/api/visitors'` callers keep working. The factory itself lives in
// `./keys` to avoid the index↔reception/admin runtime cycle.
export { visitorKeys, type VisitorStatus, type VisitorType };

/** Default tenant types seeded by migration 00257.
 *
 *  WARNING: these `id` values are UI-only sentinels (`__fallback_*`) — they
 *  are NOT real UUIDs and will be rejected by `POST /visitors/invitations`.
 *  We surface them only so the picker can render a populated dropdown for a
 *  non-admin host who can't read `/admin/visitors/types`. The form treats
 *  any `__fallback_*` id as un-submittable and renders an inline banner
 *  pointing the user at their admin.
 *
 *  Long-term fix: slice 9 (admin pages) should expose a host-accessible
 *  `GET /visitor-types` (or relax the AdminGuard on the existing endpoint
 *  to require only `visitors.invite`). Until then, this fallback exists to
 *  avoid an empty unusable form. */
export const DEFAULT_VISITOR_TYPES: VisitorType[] = [
  {
    id: '__fallback_guest',
    type_key: 'guest',
    display_name: 'Guest',
    requires_approval: false,
    allow_walk_up: true,
    default_expected_until_offset_minutes: 120,
  },
  {
    id: '__fallback_contractor',
    type_key: 'contractor',
    display_name: 'Contractor',
    requires_approval: false,
    allow_walk_up: true,
    default_expected_until_offset_minutes: 480,
  },
  {
    id: '__fallback_vendor',
    type_key: 'vendor',
    display_name: 'Vendor',
    requires_approval: false,
    allow_walk_up: true,
    default_expected_until_offset_minutes: 240,
  },
  {
    id: '__fallback_interview_candidate',
    type_key: 'interview_candidate',
    display_name: 'Interview candidate',
    requires_approval: false,
    allow_walk_up: false,
    default_expected_until_offset_minutes: 120,
  },
  {
    id: '__fallback_vip',
    type_key: 'vip',
    display_name: 'VIP',
    requires_approval: true,
    allow_walk_up: false,
    default_expected_until_offset_minutes: 240,
  },
  {
    id: '__fallback_delivery',
    type_key: 'delivery',
    display_name: 'Delivery',
    requires_approval: false,
    allow_walk_up: true,
    default_expected_until_offset_minutes: 30,
  },
];

export interface CreateInvitationPayload {
  first_name: string;
  last_name?: string;
  email?: string;
  phone?: string;
  company?: string;
  visitor_type_id: string;
  expected_at: string;
  expected_until?: string;
  building_id: string;
  meeting_room_id?: string;
  booking_bundle_id?: string;
  reservation_id?: string;
  co_host_person_ids?: string[];
  notes_for_visitor?: string;
  notes_for_reception?: string;
}

export interface CreateInvitationResponse {
  visitor_id: string;
  status: VisitorStatus;
  approval_id?: string | null;
}

/** Row shape returned by GET /visitors/expected. */
export interface ExpectedVisitor {
  visitor_id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  expected_at: string | null;
  expected_until: string | null;
  arrived_at: string | null;
  status: VisitorStatus;
  building_id: string | null;
  meeting_room_id: string | null;
}

/** Row shape returned by GET /visitors/:id. */
export interface VisitorDetail {
  id: string;
  tenant_id: string;
  status: VisitorStatus;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  expected_at: string | null;
  expected_until: string | null;
  arrived_at: string | null;
  checked_out_at: string | null;
  checkout_source: string | null;
  auto_checked_out: boolean;
  building_id: string | null;
  meeting_room_id: string | null;
  visitor_type_id: string | null;
  booking_bundle_id: string | null;
  reservation_id: string | null;
  notes_for_visitor: string | null;
  notes_for_reception: string | null;
  primary_host_person_id: string | null;
  visitor_pass_id: string | null;
}

// Key factory + shared types live in `./keys` (re-exported above).
// Putting them there breaks the runtime cycle between this module's
// `export * from './reception' | './admin'` and those modules' value
// imports of `visitorKeys`.

// ─── Query options ─────────────────────────────────────────────────────────

export function visitorDetailOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: visitorKeys.detail(id ?? '__none__'),
    queryFn: ({ signal }) => apiFetch<VisitorDetail>(`/visitors/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useVisitorDetail(id: string | null | undefined) {
  return useQuery(visitorDetailOptions(id));
}

export function myExpectedVisitorsOptions() {
  return queryOptions({
    queryKey: visitorKeys.expected(),
    queryFn: ({ signal }) => apiFetch<ExpectedVisitor[]>('/visitors/expected', { signal }),
    staleTime: 30_000,
  });
}

export function useMyExpectedVisitors() {
  return useQuery(myExpectedVisitorsOptions());
}

/**
 * Visitor types lookup. Slice 9 added a host-accessible `GET /visitors/types`
 * endpoint gated only on `visitors.invite` so the invite form stays
 * populated for non-admins. We hit that endpoint first; falling back to
 * `/admin/visitors/types` for legacy callers, and finally to the seeded
 * defaults if both 403.
 */
export function visitorTypesOptions() {
  return queryOptions({
    queryKey: visitorKeys.types(),
    queryFn: async ({ signal }) => {
      // 1. Host-accessible endpoint (slice 9 — preferred).
      try {
        return await apiFetch<VisitorType[]>('/visitors/types', { signal });
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status !== 401 && status !== 403) throw err;
      }
      // 2. Admin endpoint (works for tenant admins).
      try {
        return await apiFetch<VisitorType[]>('/admin/visitors/types', { signal });
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 401 || status === 403) {
          // 3. Last-resort seeded defaults so the picker can still render.
          return DEFAULT_VISITOR_TYPES;
        }
        throw err;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useVisitorTypes() {
  return useQuery(visitorTypesOptions());
}

/**
 * Public cancel-token preview (slice 10).
 *
 * Backend: `GET /visitors/cancel/:token/preview` — anonymous; the token is
 * the auth. NON-CONSUMING — calling N times is safe. Errors surface as
 * `ApiError` with status 410 and a body containing a stable `code`:
 *   - `invalid_token`   → token doesn't exist (or wrong tenant)
 *   - `token_expired`   → token is past expires_at
 * There is no `token_already_used` because peek is read-only — the
 * visitor's own status (e.g. 'cancelled') signals that path instead.
 *
 * Spec: §6.4 cancel UX
 */
export interface CancelPreview {
  visitor_id: string;
  visitor_status: VisitorStatus;
  first_name: string;
  expected_at: string | null;
  expected_until: string | null;
  building_id: string | null;
  building_name: string;
  host_first_name: string;
}

export const cancelTokenKeys = {
  all: ['visit-cancel-token'] as const,
  preview: (token: string) => [...cancelTokenKeys.all, 'preview', token] as const,
} as const;

export function cancelPreviewOptions(token: string | null | undefined) {
  return queryOptions({
    queryKey: cancelTokenKeys.preview(token ?? '__none__'),
    queryFn: ({ signal }) =>
      apiFetch<CancelPreview>(`/visitors/cancel/${encodeURIComponent(token!)}/preview`, {
        signal,
      }),
    enabled: Boolean(token && token.trim().length > 0),
    // Tokens are short-lived (24-72h typical); we still cache long enough
    // to avoid a re-fetch when the visitor flips between confirmation
    // states. Don't auto-refetch: the preview doesn't drift.
    staleTime: 60 * 60_000,
    retry: (failureCount, error) => {
      // 410 errors (invalid/expired) are terminal — never retry.
      const status = (error as { status?: number })?.status;
      if (status === 410 || status === 400) return false;
      return failureCount < 2;
    },
  });
}

export function useCancelPreview(token: string | null | undefined) {
  return useQuery(cancelPreviewOptions(token));
}

// ─── Mutations ─────────────────────────────────────────────────────────────

/**
 * POST /visitors/invitations — host invites a visitor.
 *
 * Invalidates the host's expected list on success so the new row appears
 * without an explicit refetch from the caller. The detail key for the
 * new id is seeded with the response so a navigation to /portal/visitors/:id
 * doesn't re-fetch.
 */
export function useCreateInvitation() {
  const qc = useQueryClient();
  return useMutation<CreateInvitationResponse, Error, CreateInvitationPayload>({
    mutationFn: (payload) =>
      apiFetch<CreateInvitationResponse>('/visitors/invitations', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      // Invalidate the whole visitors namespace — receptionKeys live
      // under `[...visitorKeys.all, 'reception']` (see reception.ts), so
      // a hierarchical invalidate on `visitors` covers the host's
      // expected list, generic lists, AND the reception today/search/
      // daglijst views in one call. Without this the booking-composer
      // visitor flush would only refresh the host views, leaving
      // /desk/visitors stale until the 15s poll catches up.
      qc.invalidateQueries({ queryKey: visitorKeys.all });
    },
  });
}

/**
 * POST /visitors/cancel/:token — public-token cancellation.
 *
 * The token-bearing flow is the visitor's self-cancel landing. Hosts use
 * a different cancel surface (slice 7 reception or slice 9 admin). We
 * still expose the hook here because the token landing page lives in the
 * same module space.
 *
 * Optimistic update: flip status='cancelled' on the cached detail (if any)
 * before the request returns. Rolls back on error via the snapshot.
 */
export function useCancelInvitationViaToken() {
  const qc = useQueryClient();
  return useMutation<{ ok: true; visitor_id: string }, Error, { token: string; visitorIdHint?: string }>({
    mutationFn: ({ token }) =>
      apiFetch<{ ok: true; visitor_id: string }>(`/visitors/cancel/${encodeURIComponent(token)}`, {
        method: 'POST',
      }),
    onMutate: async ({ visitorIdHint }) => {
      if (!visitorIdHint) return { previous: undefined };
      await qc.cancelQueries({ queryKey: visitorKeys.detail(visitorIdHint) });
      const previous = qc.getQueryData<VisitorDetail>(visitorKeys.detail(visitorIdHint));
      if (previous) {
        qc.setQueryData<VisitorDetail>(visitorKeys.detail(visitorIdHint), {
          ...previous,
          status: 'cancelled',
        });
      }
      return { previous };
    },
    onError: (_err, vars, ctx) => {
      const snap = (ctx as { previous?: VisitorDetail } | undefined)?.previous;
      if (snap && vars.visitorIdHint) {
        qc.setQueryData(visitorKeys.detail(vars.visitorIdHint), snap);
      }
    },
    onSettled: (_data, _err, vars) => {
      qc.invalidateQueries({ queryKey: visitorKeys.expected() });
      if (vars.visitorIdHint) {
        qc.invalidateQueries({ queryKey: visitorKeys.detail(vars.visitorIdHint) });
      }
    },
  });
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** Compose a visitor's display name from first/last with the company in
 *  parens — used in list rows + invite confirmations. */
export function formatVisitorName(v: Pick<ExpectedVisitor, 'first_name' | 'last_name' | 'company'>): string {
  const name = [v.first_name, v.last_name].filter(Boolean).join(' ').trim();
  if (v.company) return `${name} (${v.company})`;
  return name;
}

// Reception workspace surface — extracted into its own file to keep this
// host-facing module focused. Re-exported here so callers can do
// `import { useReceptionToday } from '@/api/visitors'`.
export * from './reception';

// Admin surface (slice 9) — visitor-types CRUD, pool anchors, kiosk
// provisioning, desk lens. Lives in its own file so the host-facing
// bundle stays slim.
export * from './admin';

/** Status → human-friendly chip label. */
export function visitorStatusLabel(s: VisitorStatus): string {
  switch (s) {
    case 'pending_approval':
      return 'Pending approval';
    case 'expected':
      return 'Expected';
    case 'arrived':
      return 'Arrived';
    case 'in_meeting':
      return 'In meeting';
    case 'checked_out':
      return 'Checked out';
    case 'no_show':
      return 'No show';
    case 'cancelled':
      return 'Cancelled';
    default:
      return s;
  }
}
