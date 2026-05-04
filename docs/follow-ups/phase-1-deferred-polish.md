# Phase 1 — Deferred polish (Nits 8 / 9 / 10)

> Tracked from /full-review v3 closure (2026-05-04). Out of scope for the
> Phase 1 closure round but worth picking up in a quiet sprint.

## Nit 8 — Test coverage gaps

Missing test coverage for:

- `ReservationService.editOne` C2 split paths exercised in isolation:
  - geometry-only patch (already covered by C2 regression tests in
    `reservation-edit-slot.spec.ts`, but the meta-only and combined
    paths share the test surface and could be split).
  - mixed patch (geometry + slot-meta + booking-meta) — exercised
    end-to-end but no dedicated assertion that all three writes happen
    in the right order (RPC → slot-meta UPDATE → booking-meta UPDATE).
- `recurrence.service.materialize` partial-failure path:
  - covered (I4) but only with a single occurrence. A test with N=3
    occurrences where occurrence 2 hits partial_failure while 1 and 3
    succeed would exercise the loop's recovery semantics.
- `editSlot` round-trip with the visitor cascade emitter:
  - I3 tests cover the emit side. An adapter-side test (visitor
    expected_at updated when bundle.line.moved fires) lives in
    `bundle-cascade-integration.spec.ts` but is editOne-shaped, not
    editSlot-shaped. A direct editSlot-→adapter integration test
    would catch any future regression where editSlot stops emitting
    on the slot-targeted path.

## Nit 9 — Magic-string DI token

`apps/api/src/modules/reservations/booking-transaction-boundary.ts`:

```typescript
export const BOOKING_TX_BOUNDARY = 'BookingTransactionBoundary';
```

The token is a plain string. NestJS allows `Symbol` or `InjectionToken` (via the framework's typed-token mechanism) for type-safe DI. Migrating to `Symbol('BookingTransactionBoundary')` would catch typos at compile time when the token is referenced from `@Inject()` decorators. Low priority — there's only one consumer today (BookingFlowService + RecurrenceService post-I4) and both reference the exported constant.

## Nit 10 — Doc drift

`docs/assignments-routing-fulfillment.md:1056` (the `PATCH /reservations/:id` paragraph in §26):

> "PATCH /reservations/:id (booking-level fields: host_person_id, attendee_count, attendee_person_ids)."

After C2, this is **partially wrong**:

- `host_person_id` IS booking-level (correct).
- `attendee_count` and `attendee_person_ids` live on `booking_slots` (per-slot semantics — different rooms can have different attendee counts).
- C2 also routes `space_id`, `start_at`, `end_at` through the same endpoint, but they delegate internally to `editSlot`.

The corrected description:

> `PATCH /reservations/:id` accepts:
> - **Booking-level fields** (host_person_id, recurrence_overridden) — written to `bookings`.
> - **Slot-meta fields** (attendee_count, attendee_person_ids) — written to the booking's PRIMARY slot.
> - **Geometry fields** (space_id, start_at, end_at) — internally delegated to `editSlot` for the booking's PRIMARY slot, which calls the `edit_booking_slot` RPC (00291 + 00293) for atomic mirror recompute.
>
> For non-primary slot edits (drag/resize/move on the desk scheduler), call `PATCH /reservations/:bookingId/slots/:slotId` directly via `useEditBookingSlot`.

Update the table cell and the surrounding paragraph in the same PR that introduces the next non-trivial change to editOne.
