# Phase 1.3 — Booking compensation manual smoke

> Manual end-to-end verification for the `delete_booking_with_guard` RPC
> (migration 00292) + the `BookingTransactionBoundary` it underwrites. This
> is the smoke gate referenced in
> [`docs/superpowers/plans/2026-05-04-architecture-phase-1-correctness-bugs.md`](../superpowers/plans/2026-05-04-architecture-phase-1-correctness-bugs.md)
> §1.3 "Manual smoke."
>
> Jest can't simulate FK semantics (CASCADE / SET NULL / NO ACTION). The
> `booking-flow-atomicity.spec.ts` + `booking-compensation.service.spec.ts`
> specs verify the boundary's branching, but the actual cascade behavior of
> the RPC against a real Postgres FK graph must be confirmed by running this
> probe against the running stack.

## Why this exists

Before Phase 1.3, `BookingFlowService.create` ran two writes:

1. `create_booking` RPC (atomic; one booking + N slots).
2. `BundleService.attachServicesToBooking` (sequential supabase-js calls).

If step 2 failed, step 1 persisted — the user got a 4xx response while the
room was silently still reserved. Phase 1.3 wraps step 2 in
`txBoundary.runWithCompensation`, which on failure invokes
`delete_booking_with_guard` (00292) to atomically delete the orphan booking.

This runbook verifies the compensation actually fires end-to-end.

## Prerequisites

- `pnpm dev` (or `pnpm dev:api` + `pnpm dev:web`) running against the remote
  Supabase project.
- A real auth token for a tenant + user that can call POST /api/reservations
  (use the dev shell or copy a JWT from the browser).
- `psql` access via the connection string in `.env`'s `SUPABASE_DB_PASS`.
- A valid `space_id` you can book (e.g. seeded room).
- A KNOWN-INVALID `catalog_item_id` (a uuid that doesn't resolve in
  `service_catalog_items`). The fastest way: pick a fresh uuid and use it
  directly; `BundleService.hydrateLines` will throw `catalog_item_not_found`.

## Probe 1: invalid service → booking rolled back

1. POST to `/api/reservations` (single-room) with a body that includes
   `services: [{ catalog_item_id: '<uuid-not-in-catalog>', quantity: 1 }]`.

   Example (substitute real values):

   ```bash
   curl -X POST http://localhost:3001/api/reservations \
     -H "Authorization: Bearer <jwt>" \
     -H "Content-Type: application/json" \
     -d '{
       "space_id": "<real-space-uuid>",
       "requester_person_id": "<real-person-uuid>",
       "start_at": "2026-06-01T09:00:00Z",
       "end_at": "2026-06-01T10:00:00Z",
       "attendee_count": 4,
       "services": [
         { "catalog_item_id": "00000000-0000-0000-0000-000000000000", "quantity": 1 }
       ]
     }'
   ```

2. Expect: HTTP 4xx with a body that includes `code: 'catalog_item_not_found'`
   (or whichever specific error the bundle service raises). The original
   error must be re-thrown unchanged — that's the boundary's `rolled_back`
   path.

3. Confirm the booking is gone:

   ```bash
   PGPASSWORD="$(grep -E '^SUPABASE_DB_PASS=' .env | cut -d= -f2-)" \
     psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
     -c "select id, created_at, status from public.bookings
           where created_at > now() - interval '1 minute'
           order by created_at desc
           limit 5;"
   ```

   Expect: zero rows for the time window of the failed POST. (Other rows
   from concurrent activity are fine; the failed one specifically must NOT
   be there.)

4. Also confirm slot rows are gone (CASCADE per 00277:119):

   ```sql
   select count(*) from public.booking_slots
     where created_at > now() - interval '1 minute';
   ```

   Expect: only counts from successful POSTs in the window, none from the
   failed one.

5. Server logs should contain:

   ```
   [InProcessBookingTransactionBoundary] booking <id> rolled back after operation failed: <original error>
   ```

## Probe 2: valid services → booking persists

Repeat Probe 1 with a real `catalog_item_id` (look one up with
`select id from public.service_catalog_items limit 1;` or via the admin UI).

1. POST should return HTTP 200/201 with a `Reservation` body.
2. The booking exists in `public.bookings`.
3. Slots exist in `public.booking_slots`.
4. Orders exist in `public.orders` with `booking_id = <new booking>`.
5. No "rolled back" log line.

## Probe 3 (optional): partial-failure path

This requires synthetically creating a `recurrence_series` row that points
at the booking BEFORE the compensation fires. In normal flow, the series
is created AFTER attach succeeds (booking-flow.service.ts:440-485) and the
attach would have already passed. So this probe is informational only — it
verifies the RPC's blocker logic, not a real production race.

1. Create a booking via the normal path (Probe 2; real services).
2. Manually insert a recurrence_series row referencing it:

   ```sql
   insert into public.recurrence_series (
     tenant_id, recurrence_rule, series_start_at, series_end_at,
     max_occurrences, materialized_through, parent_booking_id
   ) values (
     '<tenant-id>', '{"freq":"weekly"}'::jsonb,
     now(), null, 10, now() + interval '90 days',
     '<booking-id>'
   );
   ```

3. Call the RPC directly:

   ```sql
   select public.delete_booking_with_guard('<booking-id>'::uuid, '<tenant-id>'::uuid);
   ```

4. Expect: jsonb `{ "kind": "partial_failure", "blocked_by": ["recurrence_series"] }`.
5. Confirm the booking still exists.

## Failure → recovery

If Probe 1 leaves a stale booking:

1. Check the server logs for a `compensation RPC failed` line — that means
   the RPC itself errored. Investigate (likely an FK or RLS issue).
2. Manually clean up via psql:

   ```sql
   delete from public.bookings where id = '<orphan-id>';
   ```

3. File a follow-up: the boundary surfaced `BadRequestException(booking.compensation_failed)`
   to the API; the client got a 4xx with `code: 'booking.compensation_failed'`.
   Phase 6's outbox-driven impl is meant to make this self-healing.

## When to re-run

- After any change to:
  - `delete_booking_with_guard` RPC (`supabase/migrations/00292*.sql`)
  - `BookingTransactionBoundary` impl
  - `BookingCompensationService`
  - `BookingFlowService.create` or `MultiRoomBookingService.createGroup`
- After any FK ON DELETE rename on a table referenced in
  `docs/follow-ups/phase-1-3-blocker-map.md`.
- Before merging a release that includes Phase 1.3 work.

This is **not** a CI-runnable gate (it requires a running stack + manual
inspection). It's a pre-merge sanity check.
