# Visitors on booking detail — design

**Date:** 2026-05-02
**Status:** Approved (brainstorm)
**Owner:** Frontend + small API addition
**Depends on:** Visitors v1 (PR #12, migrations 00248–00272)

## Problem

When an operator opens a booking detail (split-pane at `/desk/bookings?id=X` or full route at `/desk/bookings/:id`), there is no rendering of the visitors attached to that booking. Visitors created at booking-composer time (via `apps/web/src/components/booking-composer/sections/visitors-section.tsx`) are persisted with `visitors.reservation_id` set, but the booking detail surface has no block to show them — the data is invisible.

This is the gap the user reported: "the visitor is missing in booking details, need to be added there also."

## Goals

1. Show all visitors attached to a booking, on both the split-pane detail and the full detail route.
2. Let operators add a visitor to an existing booking from this surface (the obvious follow-on once visitors are visible).
3. Let operators remove a visitor from this surface (soft-cancel, not hard-delete).
4. Default the visitor's host to the booking's host wherever a visitor is being created — both at composer-time and post-booking.

## Non-goals

- Inline edit of visitor name / time / host on the booking detail. Those edits go to `/desk/visitors/:id`.
- Check-in actions (mark arrived / checked out / no show) on this surface. Reception workspace and visitor detail own that.
- Portal-side booking view changes. Whether requesters see visitors on their portal booking view is a separate decision.
- Bundle-line semantics. Visitors continue to attach via `reservation_id`; the optional `booking_bundle_id` linkage stays as-is.

## Architecture

### Surface

A new component `<BundleVisitorsSection>` mounted in `apps/web/src/components/booking-detail/booking-detail-content.tsx`, between the **Attendees** block (currently around line 249) and the **Check-in** block (currently around line 294). Visitors and attendees are siblings — both are "people on this meeting" — so they sit next to each other. Bundle services and bundle work orders stay at the bottom; they are about *what* the booking needs, not *who* is coming.

Both detail surfaces (split-pane and full page) use the same `BookingDetailContent`, so a single addition covers both routes.

### Section anatomy

| Region | Contents |
|---|---|
| Header | "Visitors" label · count badge · `+ Add visitor` button (right-aligned, only when operator has create perm) |
| Body — populated | List of rows. Each row: `First Last · Company` (left) · status pill · expected time (relative + tooltip with full timestamp) · host name (subtle) · trailing kebab → Remove |
| Body — empty | Single muted line: "No visitors expected" + the Add button still visible in the header |
| Body — loading | One skeleton row (don't block the rest of the detail; the section loads independently of the booking) |
| Body — error | Inline warning card per `docs/superpowers/specs/2026-05-02-error-handling-system-design.md` — does not replace the booking detail, just degrades the section |

A whole row is clickable → `/desk/visitors/:id`. The kebab is a `DropdownMenu` with a single `Remove` item that opens a `ConfirmDialog`.

### Data

#### Backend

Add `GET /reservations/:id/visitors` (route lives on the visitors controller, parameterized by reservation id — mirrors how reception endpoints are scoped by `building_id`). Returns the same row shape `/desk/visitors` rows already use:

```ts
type VisitorRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company: string | null;
  status: VisitorStatus;
  expected_at: string | null;   // ISO
  expected_until: string | null;
  primary_host_person_id: string | null;
  primary_host_name: string | null; // resolved server-side
  visitor_type_id: string | null;
  visitor_type_label: string | null; // resolved server-side
  has_pass: boolean;
};
```

**Visibility:** the endpoint must be gated by the same check that already gates `GET /reservations/:id`. If the caller can read the booking, they can read its visitors. There is no separate visibility model for visitors-attached-to-a-booking; the booking's gate is the visitor's gate. The implementation should call the same guard the existing reservation read endpoint calls (likely a `ReservationService.assertReadable(reservationId, ctx)` helper or equivalent — confirm at implementation time).

**Tenant isolation:** the endpoint must filter `visitors.tenant_id = current tenant` AND `visitors.reservation_id = :id`. Both filters in the same query; never assume the FK alone is enough (per `feedback_tenant_id_ultimate_rule`).

#### Frontend

New hook `useReservationVisitors(reservationId)` in `apps/web/src/api/visitors/index.ts`, following the React Query guidelines:

- Key factory entry: `visitorKeys.byReservation(reservationId)` under the existing `visitorKeys.all` namespace, so the existing `useCreateInvitation` invalidation (which clears `visitorKeys.all`) refreshes booking detail without changes.
- `queryOptions` helper.
- Stale time: 30s (matches `useReceptionToday`'s polling cadence; visitors mutate often enough that fresher is better).

### Mutations

#### Add visitor

A new component `<AddVisitorToBookingDialog>` opened by the section header's `+ Add visitor` button.

- Field shape lifted from the composer's `visitors-section.tsx`: first/last name, email, company, expected window (start + end), host picker, visitor type, notes for visitor, notes for reception.
- **Default host = booking's host (`reservations.requester_person_id`).** Pre-filled in the host picker; user can change it before submitting.
- Submits via the existing `useCreateInvitation()` hook with `reservation_id` set. The hook already supports `reservation_id` in its `CreateInvitationPayload` type (`apps/web/src/api/visitors/index.ts:109`), so no API change is needed for create.
- The existing `POST /visitors/invitations` endpoint owns approval: visitor type policy decides whether the new visitor lands in `pending_approval` or `expected`. Post-booking add MUST go through the same pipeline as composer-time add — no surprise gaps.
- On success: `toastCreated('Visitor', { onView: () => navigate(/desk/visitors/${id}) })`.

#### Remove visitor

The kebab → Remove → `ConfirmDialog` (destructive styling). The confirm copy names the consequence: "{Name} will be cancelled. They won't appear on the daglijst or the kiosk." On confirm, sets `visitors.status = 'cancelled'`.

**Soft-cancel, not hard-delete.** Visitors carry GDPR-relevant data with retention policies (per `docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md`); deletion is the GDPR pipeline's job on its scheduled cadence, not a desk-side button. Soft-cancel preserves the audit trail and the visitor's history.

The visitors v1 single-write-path invariant (per `project_visitors_v1_shipped.md`) requires status transitions to flow through `VisitorService` with the session marker set — the cancel mutation must too. There's no admin-cancel endpoint today (only the token-based cancel for visitors themselves at `POST /visitors/cancel/:token`). Add `POST /visitors/:id/cancel` to `visitors.controller.ts`, gated by `tickets:write` (or the visitor-specific perm if one exists), routed through `VisitorService.transition(visitorId, 'cancelled', { actorUserId, source: 'desk_booking_detail' })`.

Frontend hook `useCancelVisitor()` mirrors `useCancelInvitationViaToken`: optimistic flip to `cancelled` on the cached row, rollback on error, invalidate `visitorKeys.byReservation(reservationId)` and `visitorKeys.detail(visitorId)` on settle.

`toastRemoved('Visitor', { verb: 'cancelled', onUndo: () => /* re-set status to expected via VisitorService */ })`. Undo is supported because a `cancelled → expected` state-machine edge exists in visitors v1 (used by the kiosk recovery path); we wire the same edge here.

### Composer parity (sibling surface)

Per `feedback_propagate_polish_to_siblings`: the same default-host behavior must apply at composer-time. Update `apps/web/src/components/booking-composer/sections/visitors-section.tsx` so when the operator adds a new visitor row, the host picker pre-fills with the booking's configured host (the person the booking is being made for — proxy-booking compatible, not "the logged-in operator").

If the composer's visitor-add form already does this, no change. If it currently leaves the host empty or defaults to the operator, fix it.

## Permissions

- **View visitors on booking detail:** anyone who can see the booking. No new permission.
- **Add visitor to booking:** existing visitor-create permission (whatever currently gates `POST /visitors/invitations` — likely `visitors:create` or equivalent). The `+ Add visitor` button is hidden when the user lacks it.
- **Remove visitor from booking:** existing visitor-cancel permission, or `visitors:write`. Kebab item hidden when the user lacks it.

No new permission keys. Roles that already grant visitor management at the desk level (Reception, Service Desk Manager, Tenant Admin) automatically get these affordances.

## Realtime

The booking detail already subscribes to bundle changes via `useRealtimeBundle`. Visitors are not part of the bundle channel today. For v1 of this section, we rely on:

1. The 30s stale time of `useReservationVisitors` for incremental freshness.
2. The `useCreateInvitation` invalidation (already invalidates the whole visitors namespace) for self-driven mutations.

A future improvement is to subscribe the booking detail to a `visitors:reservation:{id}` realtime channel so a kiosk arrival or reception check-in flips the row's status without waiting for the poll. Out of scope here; tracked as a follow-up.

## Edge cases

- **Booking has no host (`requester_person_id IS NULL`).** The host picker stays empty; the user must pick one before submit (existing validation in the create-visitor form already handles this case).
- **Visitor status `cancelled` or `no_show`.** Still listed (status pill makes the state clear). Operator can view the row but the kebab Remove option is hidden (no-op on already-cancelled).
- **Visitor status `arrived` / `in_meeting` / `checked_out`.** Listed. Remove is hidden — the visitor has already physically arrived; cancelling at that point is wrong. Operator can navigate to visitor detail for further action.
- **Recurring booking.** The visitors section reflects visitors attached to the *specific occurrence* the user is viewing (the `reservation_id` is the occurrence, not the series). Recurrence-wide visitor management is out of scope for this section.
- **Multi-room booking.** Visitors attach to one reservation in the multi-room group (typically the primary). The section shows what's attached to the currently-viewed reservation only — operators can navigate to siblings via the existing multi-room chip nav (line 319–359).

## Files touched

**Backend:**
- `apps/api/src/modules/visitors/visitors.controller.ts` — add `GET /reservations/:id/visitors`, add `POST /visitors/:id/cancel`
- `apps/api/src/modules/visitors/visitor.service.ts` — add `listByReservation(reservationId, ctx)` + `cancelByOperator(visitorId, ctx)` (or extend the existing transition method)

**Frontend:**
- `apps/web/src/api/visitors/index.ts` — add `useReservationVisitors`, `useCancelVisitor`, key factory entry
- `apps/web/src/components/booking-detail/booking-detail-content.tsx` — mount `<BundleVisitorsSection>` between attendees and check-in
- `apps/web/src/components/booking-detail/bundle-visitors-section.tsx` — **new file**, the section
- `apps/web/src/components/booking-detail/add-visitor-to-booking-dialog.tsx` — **new file**, the add dialog
- `apps/web/src/components/booking-composer/sections/visitors-section.tsx` — default host to booking host (if not already)

**Docs / contracts:**
- This file
- Update `docs/visibility.md` if any new query path is added that needs to be acknowledged in the visibility model (the new GET endpoint is gated by booking visibility, which is already covered, but cross-check).

**No migrations required.** All schema is in place from visitors v1.

## Testing

- **Backend:** integration test asserting `GET /reservations/:id/visitors` returns visitors filtered by reservation_id + tenant_id + visibility. Negative tests for cross-tenant leak and unprivileged visibility.
- **Backend:** unit test for `cancelByOperator` going through the state machine session-marker path. Negative test asserts that direct UPDATE bypassing the service is rejected by the visitors v1 trigger.
- **Frontend:** RTL test mounting `BookingDetailContent` with a mock booking that has 2 visitors → asserts both rows render with the right status pills and host names.
- **Frontend:** RTL test for the add-visitor dialog — asserts the host picker pre-fills with the booking's `requester_person_id`.
- **Smoke gate:** `pnpm smoke:work-orders` is unaffected (no work-order surface change). Add a visitor-side smoke probe in a follow-up PR if visitor mutations become a recurring failure mode.

## Open questions

None at this point. All design decisions confirmed by the user (rapid-execution + ok confirmations on scope B, soft-cancel, same approval pipeline, default-host = booking host).
