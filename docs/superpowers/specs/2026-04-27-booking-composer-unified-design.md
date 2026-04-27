# Booking Composer + post-booking service edit — design

**Date:** 2026-04-27
**Owner:** room-booking + booking-services
**Status:** approved, in-flight

Phase A of the unified booking-composer roadmap. Closes the "you can attach catering at booking time but not after" asymmetry, brings the desk operator to feature parity for create flows, and establishes a mobile-native foundation that future phases (real-time, substitutions, smart defaults, conversational entry) extend additively.

## Goals

1. **Same shared composer** drives all three create entry points (portal `/portal/book-room`, desk scheduler drag-create, desk bookings list `+ New booking`). Each surface's chrome differs; the cart + assistant logic is shared.
2. **Add / edit / remove services post-booking** from any detail surface (portal drawer, desk panel, desk full page). Same picker components as initial booking.
3. **Visitor attach** — link existing visitor records to a reservation, or create new visitor records inline during booking. New `reservation_visitors` junction table (m:n).
4. **Mobile-native baseline** — bottom-sheet snap-points (30/60/90%), 44px+ touch targets, native pickers, optimistic UI.
5. **Substitution-shaped data flow** — endpoints + frontend cache shape work assumes future vendor-substitute flows; phase E lands as additions, not refactor.

## Non-goals (deferred to later phases)

- B (smart defaults / templates from history)
- C (real-time fulfillment status push)
- D (cross-resource pre-flight: room+vendor capacity)
- E (substitutions UX)
- F (visitor GDPR consent + dietary intake forms)
- G (Outlook bidirectional sync)
- H (rating + scorecard loop)
- I (conversational entry)

## Architecture

### Backend

**New endpoints (additive, follow existing booking-bundles patterns):**

```
POST   /booking-bundles/:id/lines          add lines to existing bundle
PATCH  /booking-bundles/lines/:lineId      edit qty / service_window
POST   /reservations/:id/visitors          attach existing visitor or create-and-attach
DELETE /reservations/:id/visitors/:vid     unlink visitor
```

**New DB:**

```sql
-- supabase/migrations/00159_reservation_visitors.sql
create table public.reservation_visitors (
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  visitor_id     uuid not null references public.visitors(id)     on delete cascade,
  tenant_id      uuid not null references public.tenants(id),
  attached_at    timestamptz not null default now(),
  attached_by_user_id uuid references public.users(id),
  primary key (reservation_id, visitor_id)
);

alter table public.reservation_visitors enable row level security;
create policy "tenant_isolation" on public.reservation_visitors
  using (tenant_id = public.current_tenant_id());

create index idx_reservation_visitors_visitor on public.reservation_visitors (visitor_id);
create index idx_reservation_visitors_tenant on public.reservation_visitors (tenant_id);
```

Junction (m:n) is the future-right shape: a visitor coming for a multi-meeting day, or a meeting with multiple visitors. Single-table `visitors.reservation_id` would force 1:1 and fight against the existing day-based visitor model.

**Bundle line endpoints — shape:**

`POST /booking-bundles/:id/lines` body:
```ts
{
  lines: Array<{
    catalog_item_id: string;
    quantity: number;
    service_window_start_at?: string | null;
    service_window_end_at?: string | null;
    notes?: string;
  }>;
  // future: substitution_policy, gdpr_consent_required, etc. Don't add now.
}
```

Response: 201 with the new lines (full shape) so the cache can patch in place.

`PATCH /booking-bundles/lines/:lineId` body:
```ts
{
  quantity?: number;
  service_window_start_at?: string | null;
  service_window_end_at?: string | null;
  notes?: string;
}
```

Both endpoints route through the existing `BundleVisibilityService` for read access, with an additional write check (requester or operator with `rooms.write` / `rooms.admin` — confirm permission name during impl).

Both write to the existing `BundleService.attachServicesToReservation` for add (refactored to `addLinesToBundle` if needed) and a new `BundleService.editLine`. Cascading semantics:
- Edit qty → updates `order_line_items.quantity` and recomputes `line_total`.
- Edit service_window → updates the window AND updates the linked work-order ticket's `requested_for_*` fields.
- Add lines → if the reservation already has a bundle, append; if not, create the bundle (rare path — most reservations get a bundle at create time only when services were attached, but a reservation can exist without a bundle).

### Frontend

**Shared composer (Phase A.foundation, lands first):**

```
apps/web/src/components/booking-composer/
├── booking-composer.tsx          ← cart + assistant brain (props-driven)
├── service-picker-sheet.tsx      ← catalog browser, lifted from service-section.tsx
├── visitor-picker-sheet.tsx      ← search-or-create visitor, lifted from visitor admin
├── attendee-stepper.tsx          ← qty + tap-to-add, mobile-friendly
├── on-behalf-of-picker.tsx       ← thin wrapper around PersonPicker, hidden when mode='self'
├── composer-summary-card.tsx     ← collapsible summary chip on mobile
└── index.ts                      ← barrel
```

**Three entry-point wrappers:**

- **Portal** — `apps/web/src/pages/portal/book-room/components/booking-confirm-dialog.tsx` rewrites to `<BookingComposer mode="self" surface="dialog" />`. The 572-line dialog → ~80 lines of wrapper + props.
- **Desk scheduler** — `scheduler-create-popover.tsx` rewrites to `<BookingComposer mode="operator" surface="dialog" />`. Adds services + visitors on top of today's bare quick-create.
- **Desk bookings list** — new `+ New booking` button on the toolbar of `/desk/bookings` opens `<BookingComposer mode="operator" surface="sheet" />` (sheet for mobile-friendliness, larger room for visitors).

**Post-booking service add/edit:**

`BundleServicesSection` gets:
- `+ Add service` button at top → opens `<ServicePickerSheet />` (the same sheet used in composer)
- Inline edit on each line: qty stepper, service-window picker — toggled via the row's `Pencil` icon (replaces today's hover-X cancel UI; cancel becomes a menu item)

**Visitor attach surfaces:**

- During booking: `<VisitorPickerSheet />` is reachable from a "Visitors" section in `BookingComposer` (only when `mode='operator'` OR portal user explicitly toggles "I'm hosting external guests").
- Post-booking: `<BookingDetailContent />` gains a "Visitors" section below "Attendees", same pattern as services. `+ Add visitor` button opens the picker.

### Mobile baseline

Specific rules baked into the composer + picker components:

- All sheet-based surfaces use shadcn `Sheet` with `side="bottom"` on viewports ≤ 768px, `side="right"` on desktop. Snap-points emulated via `data-snap` attribute + CSS (Sheet doesn't support native snap-points yet, so we use 50dvh / 80dvh / 100dvh tiers driven by content).
- Buttons inside the composer use `size="lg"` (h-11) on mobile breakpoints.
- Time pickers use `<input type="time">` + `<input type="date">` (native UI on mobile).
- Quantity stepper is a 3-column grid: `[-] [12] [+]`, each cell ≥ 44px tall.
- Catalog item cards on mobile: image (full-width crop) + title + price + 1-tap "Add" button. No scrolling-required configuration on the card itself.
- Confirmation screen post-submit: a "wallet card" view summarizing the booking with a calendar-add CTA + share link (deferred but layout-reserved).

### Cart + assistant logic

`BookingComposer` owns the cart in local state via `useReducer`:

```ts
interface ComposerState {
  mode: 'self' | 'operator';
  surface: 'dialog' | 'sheet' | 'popover';
  // Cart
  spaceId: string | null;
  startAt: string | null;
  endAt: string | null;
  attendees: number;
  attendeePersonIds: string[];
  hostPersonId: string | null;       // operator: who is this for
  costCenterId: string | null;        // operator-overridable
  services: Array<ComposerServiceLine>;
  visitors: Array<ComposerVisitorRef>;
  // Assistant
  smartDefaultsApplied: { qtyFromAttendees: boolean; windowFromBooking: boolean };
  preflight: { roomOk: boolean; vendorOk: boolean | null; approvalRequired: boolean | null };
  notes: string;
  // UI
  step: 'time' | 'services' | 'visitors' | 'review';
  errors: Record<string, string>;
}
```

The reducer dispatches discrete actions: `SET_TIME`, `ADD_SERVICE`, `EDIT_SERVICE`, `REMOVE_SERVICE`, `ADD_VISITOR`, `REMOVE_VISITOR`, `APPLY_SMART_DEFAULTS`, etc. This shape is deliberately extensible: phase B's "personal templates" become an `APPLY_TEMPLATE` action; phase D's pre-flight becomes a `SET_PREFLIGHT` action; phase I's conversational entry becomes a parser that synthesizes a sequence of these actions.

Smart defaults wired in from day one (so phase B is a content add, not a structural change):
- `attendees` change → if `services` has lines with `quantity` matching the prior attendee count, prompt "update quantities to N?" with one-tap accept.
- `startAt/endAt` change → if any service line had a window matching the old booking time exactly, update it.
- `hostPersonId` change (operator) → if the new host has a default cost center, update `costCenterId` to it (with a "changed to X" toast and undo).

These are minimal scaffolding for B; they don't ship value alone but make B trivial.

### React Query cache shape

Bundle reads invalidate keys:
- `bookingBundleKeys.detail(bundleId)` — full bundle (used by `BundleServicesSection`)
- `roomBookingKeys.detail(reservationId)` — reservation, since bundle add/edit affects derived `booking_bundle_id`

Mutations:
- `useAddBundleLines` — optimistic insert of synthetic lines (status: `ordered`, no IDs yet) → on success, replace with server response.
- `useEditBundleLine` — optimistic patch of the line in cache.
- `useAttachVisitor` / `useDetachVisitor` — on the reservation detail.

All mutations follow `docs/react-query-guidelines.md` `onMutate` + rollback pattern.

### Visibility correctness

- Bundle line CRUD → `BundleVisibilityService.assertVisible` for read; for write, additional permission check: `requester_person_id == acting_user.person_id` OR `rooms.write_all` OR `rooms.admin`.
- Visitor attach → reservation visibility check (existing `ReservationVisibilityService`) + visitor visibility check (existing — visitors carry tenant_id + host_person_id, RLS enforces tenant isolation).
- The new `reservation_visitors` table has tenant_id with RLS for tenant isolation; per-row read happens via the reservation visibility predicate (don't leak attendee identity to non-visible callers).

## Phase A sub-slices (executable in order)

| Slice | Scope | Verification |
|---|---|---|
| **α. Backend foundation** | `00159` migration; `POST /booking-bundles/:id/lines`; `PATCH /booking-bundles/lines/:lineId`; `POST /reservations/:id/visitors`; `DELETE /reservations/:id/visitors/:vid`; bundle service tests | API tests + psql smoke |
| **β. Add/edit services post-booking** | `ServicePickerSheet` extracted; `+ Add service` on `BundleServicesSection`; inline edit on lines; mobile bottom-sheet | Typecheck + manual smoke |
| **γ. Visitor attach** | `VisitorPickerSheet` (search-or-create); "Visitors" section on `BookingDetailContent`; +/- mutations | Typecheck + manual smoke |
| **δ. Composer extraction + desk parity** | `BookingComposer` extracted from portal dialog; plug into scheduler create + new desk list `+ New` button; on-behalf-of in all entry points; visitor section in operator mode | Typecheck + manual smoke |

Each slice is independently shippable. α + β + γ ships value (post-booking add + visitors). δ adds desk parity for new bookings. β + γ are the most user-visible.

## Out-of-scope but layout-reserved

These don't ship in Phase A but the data shape / UI scaffolding leaves room:
- `ComposerState.preflight` field (Phase D)
- `ComposerServiceLine.substitution_policy` field (Phase E)
- Realtime subscription point on `BundleServicesSection` (Phase C)
- Conversational entry slot above `attendee-stepper` (Phase I — single empty `<div data-conversational-slot>`)

## Testing

- **Backend:** Jest tests for the 4 new endpoints. Add a `bundle-line-edit.service.spec.ts` covering qty change → line_total recompute, window change → ticket cascade, visibility denial.
- **Migration smoke:** psql query confirming `reservation_visitors` rows can be inserted via service-role and selected via the reservation visibility predicate.
- **Frontend:** No vitest setup today. Manual smoke covering: portal post-booking add-service flow; desk operator add-service flow; visitor attach + detach; mobile bottom-sheet behavior at 360px width.

## Migration / rollout

Single PR per slice. No feature flag — all changes are additive. The composer extraction (slice δ) replaces the portal dialog body but preserves its outer Dialog wrapper, so the route still works.

## Acceptance for Phase A as a whole

- A requester who books a room can later add a coffee for 8 from `/portal/me/bookings/:id` in ≤ 4 taps.
- A desk operator processing a phone call can book a room + catering + AV + 2 visitors on behalf of an employee in a single dialog.
- The portal's mobile experience for booking a room with services is usable on a 360px-wide screen without horizontal scroll.
- Cancelling an existing line still works (no regression).
- All visibility predicates honored: a non-participant cannot add lines to someone else's bundle.
