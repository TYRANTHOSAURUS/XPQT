import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { withErrorHandling } from '@/lib/errors';
import { roomBookingKeys } from './keys';
import type { BookingPayload, MultiRoomBookingPayload, Reservation } from './types';

/**
 * Producer-route mutation discipline (B.0.E.3).
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §3.3 (v8.1).
 *
 * Booking-create + service-attach hooks accept a `requestId: string` in
 * their variables shape so the caller (form-submit handler, override
 * dialog, etc.) generates the id ONCE per attempt with `crypto.randomUUID()`
 * and React Query retries of that attempt reuse it. Threaded as
 * `X-Client-Request-Id` so the backend producer constructs an
 * idempotency_key of the form `booking.create:${userId}:${requestId}` —
 * see BookingFlowService.createWithAttachPlan and the `attach_operations`
 * table for the cached_result semantics.
 *
 * The id MUST NOT be generated inside `mutationFn` — React Query retries
 * re-run mutationFn, which would produce a fresh UUID per retry and
 * defeat the idempotency mechanism (the v7-I1 hole that v8 closes).
 */

/**
 * Invalidate every cached read that could be affected by a write to a
 * reservation: the user-facing list, the portal picker, the unified
 * scheduler-data bucket, and the find-time / availability buckets.
 *
 * /full-review v4 I6 — dropped the legacy `scheduler-window`
 * invalidation. That bucket is no longer subscribed by any live page
 * (the desk scheduler cut over to `scheduler-data` in Phase 1.4 — see
 * apps/web/src/pages/desk/scheduler/hooks/use-realtime-scheduler.ts:44
 * which explicitly notes "scheduler-window keys are no longer used by
 * this page"). Keeping the invalidation alive only paid for itself if
 * some other surface still subscribed to that key — grep confirms
 * `useSchedulerReservations` / `schedulerWindowOptions` are exported
 * but unused. Drop. If a future surface needs the legacy bucket back,
 * re-add the invalidation there along with the subscriber.
 */
function invalidateAfterWrite(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: roomBookingKeys.lists() });
  queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'picker'] });
  // Unified scheduler-data bucket (rooms + reservations in one round-trip).
  // Phase 1.4 wires the desk scheduler against this key, so any geometry
  // mutation invalidates it.
  queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'scheduler-data'] });
  queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'availability'] });
  queryClient.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'find-time'] });
}

/**
 * Variables shape for `useCreateBooking`. `requestId` MUST be generated
 * once per attempt by the caller (e.g. `crypto.randomUUID()` inside the
 * form-submit handler) and threaded through React Query's `mutate()` so
 * automatic retries of the same logical attempt reuse it. See §3.3.
 */
export interface CreateBookingVariables {
  payload: BookingPayload;
  requestId: string;
}

/**
 * Create a single-room booking. Runs the full pipeline server-side
 * (rule resolver + conflict guard + write).
 *
 * On 409 (race lost), the API returns alternatives in the error body —
 * surface them in the UI so the user can rebook in one click.
 *
 * Producer route — requires X-Client-Request-Id (see CreateBookingVariables).
 */
export function useCreateBooking() {
  const queryClient = useQueryClient();
  // No `withErrorHandling` here: the 409-conflict path returns alternatives
  // in the error body and the booking composer renders them inline as a
  // re-book affordance. A generic toast for that class would compete with
  // the bespoke alternatives panel. Other classes (auth/transport/server)
  // are surfaced by the calling page's withErrorHandling on the
  // submit-handler wrapper. (Pattern E — custom branched error UI.)
  return useMutation({
    mutationFn: ({ payload, requestId }: CreateBookingVariables) =>
      apiFetch<Reservation>('/reservations', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'X-Client-Request-Id': requestId },
      }),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

/**
 * Dry-run a booking without writing — used by the picker to preview the
 * pipeline outcome before the user commits, and by the desk scheduler to
 * tag cells as "would require approval" or "denied for this requester."
 */
export function useDryRunBooking() {
  return useMutation({
    mutationFn: (payload: BookingPayload) =>
      apiFetch<{
        outcome: 'allow' | 'deny' | 'require_approval' | 'warn';
        denial_message?: string;
        warnings?: string[];
        matched_rule_ids: string[];
      }>('/reservations/dry-run', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    ...withErrorHandling({ actionTitle: "Couldn't preview booking" }),
  });
}

/**
 * Variables shape for `useMultiRoomBooking`. Same Pattern A as
 * `useCreateBooking` — caller generates `requestId` once per attempt.
 */
export interface MultiRoomBookingVariables {
  payload: MultiRoomBookingPayload;
  requestId: string;
}

export function useMultiRoomBooking() {
  const queryClient = useQueryClient();
  // Same Pattern E rationale as useCreateBooking — 409 has alternatives;
  // composer renders inline. No withErrorHandling here.
  return useMutation({
    mutationFn: ({ payload, requestId }: MultiRoomBookingVariables) =>
      // Post-canonicalisation (2026-05-02): the response shape is
      // `{ group_id, reservations[] }` where `group_id` is the booking
      // id (the dropped `multi_room_groups` table is replaced by
      // `booking_id` grouping; multi-room-booking.service.ts:331).
      // Each `reservations[i].id` also equals the booking id, so any
      // of them resolves to /desk/bookings/:id correctly.
      apiFetch<{ group_id: string; reservations: Reservation[] }>(
        '/reservations/multi-room',
        {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'X-Client-Request-Id': requestId },
        },
      ),
    onSuccess: () => invalidateAfterWrite(queryClient),
  });
}

/**
 * Booking-LEVEL edit. Use for fields that are not slot geometry —
 * `host_person_id`, `attendee_count`, `attendee_person_ids`. Routes to
 * `PATCH /reservations/:id` which edits the booking's PRIMARY slot
 * (lowest display_order). For slot-geometry edits in a multi-room
 * context, use `useEditBookingSlot` below — that's the path the desk
 * scheduler drag/resize/move hits so a non-primary slot actually moves
 * the slot the operator clicked.
 *
 * Producer route — REQUIRES `requestId`. Codex NIT-1e (2026-05-12):
 * pre-cutover this hook's `requestId` was defense-in-depth because
 * editOne delegated to editSlot under the hood. Post B.4 step 2E
 * editOne is a producer route in its own right (assembleEditPlan +
 * edit_booking RPC, sibling to editSlot — no cross-method delegation).
 * The PATCH /:id controller is now guarded by RequireClientRequestIdGuard
 * (same as multi-room and editSlot), so the header is mandatory: omit
 * it and the request 400s with `client_request_id.required`. Caller
 * generates `requestId` ONCE per attempt with `crypto.randomUUID()`
 * inside the form-submit handler so React Query retries reuse the id
 * and the backend's `command_operations` cached_result hits on the
 * second attempt.
 */
export interface EditBookingVariables {
  id: string;
  patch: Partial<Pick<Reservation,
    'space_id' | 'start_at' | 'end_at' | 'attendee_count' |
    'attendee_person_ids' | 'host_person_id'>>;
  requestId: string;
}

export function useEditBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch, requestId }: EditBookingVariables) =>
      apiFetch<Reservation>(`/reservations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
        headers: { 'X-Client-Request-Id': requestId },
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(vars.id) });
      invalidateAfterWrite(queryClient);
    },
    ...withErrorHandling({ actionTitle: "Couldn't update booking" }),
  });
}

/**
 * SLOT-targeted geometry edit (Phase 1.4 — Bug #2: slot-first scheduler).
 *
 * Use this for any drag / resize / move on the desk scheduler — anywhere
 * the operator manipulates a specific slot's space / start / end. Routes
 * to `PATCH /reservations/:bookingId/slots/:slotId` so a non-primary
 * slot of a multi-room booking actually moves THAT slot, not the
 * booking's primary.
 *
 * The booking-level mirror (start_at / end_at / location_id) is
 * recomputed atomically on the server inside the `edit_booking` RPC
 * (00364, post B.4 step 2D-D cutover) — there's no separate booking
 * write to issue from the client.
 *
 * For booking-level fields (host_person_id, attendee_count), use
 * `useEditBooking` instead.
 *
 * Producer route — REQUIRES `requestId` (B.4 step 2D-D self-review P1).
 * The controller (reservation.controller.ts:329-330) is now guarded by
 * `RequireClientRequestIdGuard`; the guard rejects 400
 * `client_request_id.required` (require-client-request-id.guard.ts:44)
 * when the header is missing or server-defaulted. Without the header,
 * EVERY operator drag / resize / move on the desk scheduler 400s. Same
 * Pattern A as `useCreateBooking` and `useAttachReservationServices`:
 * caller generates `requestId` ONCE per attempt with `crypto.randomUUID()`
 * inside the form-submit handler so React Query retries reuse the id
 * and the backend's `command_operations` cached_result row hits on the
 * second attempt.
 */
export interface EditBookingSlotVariables {
  bookingId: string;
  slotId: string;
  patch: Partial<Pick<Reservation, 'space_id' | 'start_at' | 'end_at'>>;
  requestId: string;
}

export function useEditBookingSlot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ bookingId, slotId, patch, requestId }: EditBookingSlotVariables) =>
      apiFetch<Reservation>(`/reservations/${bookingId}/slots/${slotId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
        headers: { 'X-Client-Request-Id': requestId },
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(vars.bookingId) });
      invalidateAfterWrite(queryClient);
    },
    ...withErrorHandling({ actionTitle: "Couldn't move booking" }),
  });
}

/**
 * B.4 Step 2F.3 — scope-edit hooks for `POST /reservations/:id/edit-scope`.
 *
 * Series edits run through the same `assembleScopeEditPlan` +
 * `edit_booking_scope` RPC pipeline (atomic across N occurrences). Two
 * hooks pair the wire shape:
 *
 *   - `useEditBookingScopeDryRun` sends `p_dry_run=true` and returns the
 *     preview envelope (`would_succeed`, per-occurrence breakdown,
 *     aggregated_follow_ups). NO commits — visitor cascade is skipped
 *     on the backend; idempotency row not touched. Mainstream use case:
 *     a "What will change?" panel before the operator clicks Commit.
 *   - `useEditBookingScope` sends `p_dry_run=false` and commits across
 *     every occurrence. Returns the commit envelope with `committed`,
 *     `new_series_id` (when scope='this_and_following'), and the
 *     per-occurrence diff for UI confirmation.
 *
 * Both producer routes require `X-Client-Request-Id` (the controller is
 * guarded by `RequireClientRequestIdGuard`). Same Pattern A as every
 * other producer hook: caller mints `requestId` once per attempt with
 * `crypto.randomUUID()` so React Query retries reuse the id and the
 * RPC's `command_operations` cached_result short-circuits. **dry-run +
 * commit MAY share the same crid** by 00371 v2 design — dry-run is a
 * stateless preview that does NOT touch `command_operations`, so a
 * crid covering both phases of a "preview then commit" flow is valid.
 */
export interface EditBookingScopeVariables {
  id: string;
  body: {
    scope: 'this_and_following' | 'series';
    space_id?: string;
    attendee_count?: number | null;
    attendee_person_ids?: string[];
    host_person_id?: string | null;
  };
  requestId: string;
}

/**
 * Per-occurrence row in the RPC return envelope (commit shape +
 * dry-run shape overlap; commit has `slots_updated`/`follow_ups`,
 * dry-run has `would_succeed`/`follow_ups_preview` — both branches
 * always carry the before/after diff fields).
 *
 * Mirrors the TS type on the service layer at
 * `apps/api/src/modules/reservations/reservation.service.ts` and the
 * RPC return shapes at `supabase/migrations/00371_edit_booking_scope
 * _rpc_v2.sql:1114-1125` (commit) + `:808-822` (dry-run).
 */
export interface EditBookingScopeOccurrence {
  booking_id: string;
  space_id_before: string;
  space_id_after: string;
  start_at_before: string;
  start_at_after: string;
  // Commit branch.
  slots_updated?: number;
  assets_updated?: number;
  orders_updated?: number;
  wo_updated?: number;
  follow_ups?: string[];
  // Dry-run branch.
  would_succeed?: boolean;
  approval_action?: string;
  follow_ups_preview?: string[];
  slots_to_update?: number;
  assets_to_update?: number;
  orders_to_update?: number;
  wo_to_update?: number;
}

export interface EditBookingScopeResult {
  scope: 'this_and_following' | 'series';
  new_series_id?: string;
  dry_run: boolean;
  // Commit-only.
  committed?: number;
  // Dry-run-only.
  would_succeed?: boolean;
  // Shared.
  series_id?: string;
  per_occurrence?: EditBookingScopeOccurrence[];
  aggregated_follow_ups?: string[];
}

/**
 * Dry-run preview. Same body shape as the commit hook except `dry_run`
 * is forced to `true` on the wire. Returns the preview envelope with
 * `would_succeed: true` + per-occurrence outcomes (or rejects with the
 * RPC's structured error code on validation failure / capacity bust /
 * approval-required at any single occurrence).
 *
 * Does NOT invalidate any queries — preview by definition mutates
 * nothing. The mainstream "preview, then click Commit" flow re-uses
 * the `useEditBookingScope` hook below for the actual write.
 */
export function useEditBookingScopeDryRun() {
  return useMutation<EditBookingScopeResult, Error, EditBookingScopeVariables>({
    mutationFn: ({ id, body, requestId }) =>
      apiFetch<EditBookingScopeResult>(`/reservations/${id}/edit-scope`, {
        method: 'POST',
        body: JSON.stringify({ ...body, dry_run: true }),
        headers: { 'X-Client-Request-Id': requestId },
      }),
    ...withErrorHandling({ actionTitle: "Couldn't preview series edit" }),
  });
}

/**
 * Commit. Fan-out atomic write across every occurrence in scope.
 * Returns the commit envelope with `committed: N` + (when scope=
 * `this_and_following`) the `new_series_id` minted by `splitSeries`.
 *
 * On success, invalidates the pivot booking's detail key + every
 * key under `roomBookingKeys.lists()` / scheduler-data / etc. — same
 * fan-out as `useEditBooking`, because we don't have a list of every
 * affected booking_id at the client (the RPC return carries
 * `per_occurrence[].booking_id` if a future iteration wants surgical
 * invalidation).
 */
export function useEditBookingScope() {
  const queryClient = useQueryClient();
  return useMutation<EditBookingScopeResult, Error, EditBookingScopeVariables>({
    mutationFn: ({ id, body, requestId }) =>
      apiFetch<EditBookingScopeResult>(`/reservations/${id}/edit-scope`, {
        method: 'POST',
        body: JSON.stringify({ ...body, dry_run: false }),
        headers: { 'X-Client-Request-Id': requestId },
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(vars.id) });
      invalidateAfterWrite(queryClient);
    },
    ...withErrorHandling({ actionTitle: "Couldn't update series" }),
  });
}

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, scope, reason }: {
      id: string;
      scope?: 'this' | 'this_and_following' | 'series';
      reason?: string;
    }) =>
      apiFetch<Reservation>(`/reservations/${id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ scope, reason }),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(vars.id) });
      invalidateAfterWrite(queryClient);
    },
    ...withErrorHandling({ actionTitle: "Couldn't cancel booking" }),
  });
}

export function useRestoreBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Reservation>(`/reservations/${id}/restore`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(id) });
      invalidateAfterWrite(queryClient);
    },
    ...withErrorHandling({ actionTitle: "Couldn't restore booking" }),
  });
}

export interface AttachServicesInput {
  catalog_item_id: string;
  menu_id?: string | null;
  quantity: number;
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
}

/**
 * Attach service lines to an existing reservation. Lazy-creates the
 * booking_bundle on first attach; appends to it on subsequent calls.
 * Used by the post-booking "+ Add service" affordance.
 *
 * Producer route — caller generates `requestId` once per attempt
 * (Pattern A, spec §3.3). React Query retries reuse the same id so
 * the backend's `attach_operations` cached_result row hits on the second
 * attempt and the client gets back the original result without
 * re-inserting OLIs.
 */
export function useAttachReservationServices(reservationId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    {
      bundle_id: string;
      order_ids: string[];
      order_line_item_ids: string[];
      asset_reservation_ids: string[];
      approval_ids: string[];
      any_pending_approval: boolean;
    },
    Error,
    { services: AttachServicesInput[]; requestId: string }
  >({
    mutationFn: ({ services, requestId }) =>
      apiFetch(`/reservations/${reservationId}/services`, {
        method: 'POST',
        body: JSON.stringify({ services }),
        headers: { 'X-Client-Request-Id': requestId },
      }),
    onSuccess: (data) => {
      // Post-canonicalisation (2026-05-02) the booking IS the bundle, so
      // attaching services doesn't flip a `booking_bundle_id` field on
      // the reservation — but the booking now carries linked orders.
      // Invalidate detail (in case denormalized status changes), the
      // bundle key (no-op today since `useBundle` is stubbed, but
      // future-proof against the read endpoint coming back), and the
      // lists (which the `?scope=bundles` filter narrows on).
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(reservationId) });
      queryClient.invalidateQueries({ queryKey: ['booking-bundles', 'detail', data.bundle_id] as const });
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.lists() });
    },
    ...withErrorHandling({ actionTitle: "Couldn't add services" }),
  });
}

export function useCheckInBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; checked_in_at: string }>(`/reservations/${id}/check-in`, {
        method: 'POST',
      }),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: roomBookingKeys.detail(id) });
      invalidateAfterWrite(queryClient);
    },
    ...withErrorHandling({ actionTitle: "Couldn't check in booking" }),
  });
}
