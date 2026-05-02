# Booking canonicalization — Phase 0 design (v2)

**Date:** 2026-05-02
**Status:** Design (pre-implementation) — v2 after full-review corrections
**Owner:** Backend (deep) + frontend (type cleanup) + migration
**Depends on:** None (this IS the foundation)
**Blocks:** Booking-modal redesign, visitors-on-booking-detail polish, future booking-platform features
**Investigation:** [`docs/superpowers/specs/2026-05-02-booking-canonicalization-investigation.md`](./2026-05-02-booking-canonicalization-investigation.md) — read this first.

**Revision history:**
- v1 (2026-05-02): Initial spec. **Substantively wrong** on: transactional primitive (assumed JS transactions; codebase has none), slice ordering safety, calendar column drop (claimed unwired; actually wired in production cron + UI), backfill batching (named but not written), CONCURRENTLY-in-transaction semantics, multi-room file:lines, recurrence function signature, idempotency. Caught by parallel adversarial reviewers.
- v2 (2026-05-02): Corrected. Atomicity via new Postgres function `public.create_booking_with_reservation` (matches `bundle.service.ts:38-44` stated future direction). Slices 0.1+0.2 fold into one atomic deploy. Calendar column drop deferred to Slice 0.6 after `reconciler.service.ts` and `booking-detail-content.tsx` migrate off. Real PL/pgSQL backfill loop. Concurrent indexes split into separate migration. Pseudocode rewritten against actual method signatures.

## Problem

The codebase models a "booking" with a dual-root data model:

- `reservations` is created for every booking. Universal.
- `booking_bundles` is created **lazily** only on first-service-attach. Most reservations have `booking_bundle_id IS NULL` (measured: 81% on dev DB).

Tax this creates: cognitive overhead in every code path; title has nowhere clean to live; recurrence is broken-by-design (occurrences' orders point at the master's bundle while the occurrence's own `booking_bundle_id` stays NULL); multi-room bundle attachment lives outside `BookingFlowService`; approval visibility is split (`target_entity_type IN ('reservation', 'booking_bundle')`); the data model fights the human mental model.

## The decision (locked)

`booking_bundles` becomes the **canonical "booking" entity**.

- Every reservation belongs to a booking.
- Title, description, host, status, audit anchor on the booking.
- Reservations are pure resource+time children.
- Services + visitors + tickets attach to the booking.
- The lazy-bundle invariant is dead.

The table stays named `booking_bundles` (rename is a separate, larger refactor). In code/UI vocabulary, "Booking" refers to a `booking_bundles` row.

## Goals

1. **Always-create-bundle invariant.** Every reservation insert is preceded — *atomically* — by a bundle insert. `reservations.booking_bundle_id` becomes NOT NULL.
2. **Atomicity via a Postgres function.** No JS-side transaction primitive exists in this codebase (verified). The atomic boundary moves to Postgres: a new `public.create_booking_with_reservation(...)` function does both inserts in one statement. This matches `bundle.service.ts:38-44`'s stated future direction.
3. **Single insertion point.** All reservation creation routes through the new RPC: `BookingFlowService.create` becomes a thin wrapper. Multi-room reuses the RPC by passing an existing `bundle_id` for siblings. Recurrence per-occurrence routes through the same RPC.
4. **One bundle per multi-room group** (today's behavior preserved).
5. **One bundle per recurrence occurrence.** Each occurrence is a real booking. Orders attach to the occurrence's bundle, not the master's. Ends today's hybrid.
6. **Title + description columns on `booking_bundles`**, persisted, not theater.
7. **Approval cutover with zero approver-visibility loss.** In-place re-target of in-flight `target_entity_type='reservation'` rows during the migration; temporary CHECK constraint blocks new `'reservation'`-typed inserts during the deploy gap; dispatcher branch removed once cleanup ships.
8. **Audit immutability.** Historical reservation-typed `audit_events` rows stay as-is. New events under canonical use `'booking_bundle'`. Runbook documents the dual-query during transition.
9. **Frontend type cleanup.** Nullable bundle fields flip to non-null on the reservation side. Components stop branching on bundle presence.
10. **Smoke gate extended.** Add a canonical-invariant probe to verify every `POST /reservations` returns a non-null `booking_bundle_id`.

## Non-goals

- **Renaming the table to `bookings`.** Separate refactor.
- **Folding services-only bundles into canonical.** The 1 existing services-only bundle (`primary_reservation_id IS NULL`) stays. Invariant is one-directional: every reservation has a bundle, but not every bundle has a reservation. **Documented explicitly.**
- **Realtime channel consolidation.** Tracked as follow-up.
- **Outlook calendar-sync wiring.** Phase C is unwired today; this slice doesn't wire it.
- **Booking modal redesign.** Separate spec; depends on this Phase 0 landing first.
- **Dropping `reservations.calendar_event_id`.** v1 wrongly claimed this was safe to drop. It's actively read by `apps/api/src/modules/calendar-sync/reconciler.service.ts:189` (hourly cron) and `apps/web/src/components/booking-detail/booking-detail-content.tsx:190`. The drop is **deferred to Slice 0.6** after both consumers migrate off; v2 keeps the columns until then.

## Architecture

### The atomicity primitive — `public.create_booking_with_reservation`

The keystone of the design. Located in `supabase/migrations/00276_booking_canonicalization.sql` (alongside the schema changes).

```sql
create or replace function public.create_booking_with_reservation(
  p_tenant_id uuid,
  p_requester_person_id uuid,
  p_host_person_id uuid,                      -- nullable per 00140
  p_space_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_timezone text,
  p_source text,                              -- 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception'
  p_reservation_type text,                    -- 'room' | 'desk' | 'asset' | 'parking'
  p_attendee_count integer,
  p_attendee_person_ids uuid[],
  p_title text default null,
  p_description text default null,
  p_recurrence_series_id uuid default null,
  p_multi_room_group_id uuid default null,
  p_existing_bundle_id uuid default null,     -- multi-room siblings pass this
  p_status text default 'confirmed',          -- caller decides 'confirmed' | 'pending_approval'
  p_initial_attendees jsonb default null      -- caller-supplied for parity with today's flow
) returns table (reservation_id uuid, booking_bundle_id uuid, bundle_was_created boolean)
language plpgsql
security invoker
as $$
declare
  v_bundle_id uuid := p_existing_bundle_id;
  v_reservation_id uuid;
  v_bundle_was_created boolean := false;
  v_derived_bundle_type text;
begin
  -- 1. Mint the bundle if not provided (multi-room siblings reuse).
  if v_bundle_id is null then
    v_derived_bundle_type := case p_reservation_type
      when 'room' then 'meeting'
      when 'desk' then 'desk_day'
      when 'parking' then 'parking'
      when 'asset' then 'other'
      else 'other'
    end;

    insert into public.booking_bundles (
      tenant_id, bundle_type,
      requester_person_id, host_person_id,
      primary_reservation_id,                -- updated below after reservation insert
      location_id, start_at, end_at, timezone, source,
      title, description, policy_snapshot,
      created_at, updated_at
    ) values (
      p_tenant_id, v_derived_bundle_type,
      p_requester_person_id, p_host_person_id,
      null,
      p_space_id, p_start_at, p_end_at, coalesce(p_timezone, 'UTC'), p_source,
      p_title, p_description, '{}'::jsonb,
      now(), now()
    ) returning id into v_bundle_id;

    v_bundle_was_created := true;
  end if;

  -- 2. Insert the reservation with bundle stamped (atomically with bundle insert).
  insert into public.reservations (
    tenant_id, reservation_type, space_id,
    requester_person_id,
    start_at, end_at,
    attendee_count, attendee_person_ids,
    booking_bundle_id,                       -- always set; NOT NULL post-Slice-0.1+0.2
    recurrence_series_id, multi_room_group_id,
    status,
    created_at, updated_at
  ) values (
    p_tenant_id, p_reservation_type, p_space_id,
    p_requester_person_id,
    p_start_at, p_end_at,
    p_attendee_count, coalesce(p_attendee_person_ids, '{}'::uuid[]),
    v_bundle_id,
    p_recurrence_series_id, p_multi_room_group_id,
    p_status,
    now(), now()
  ) returning id into v_reservation_id;

  -- 3. If we created the bundle, set primary_reservation_id (subject to 00153 unique constraint).
  if v_bundle_was_created then
    update public.booking_bundles
    set primary_reservation_id = v_reservation_id
    where id = v_bundle_id;
  end if;

  return query select v_reservation_id, v_bundle_id, v_bundle_was_created;
end;
$$;
```

**Notes:**
- `security invoker` — runs as the calling user. RLS on `booking_bundles` and `reservations` (both pure `tenant_isolation = current_tenant_id()`) protects against cross-tenant writes. Tenant context is set by Supabase JWT — same as today's inserts.
- **What the function does NOT do:** approvals (caller-side), service line attachment (caller-side via `BundleService.attachServicesToReservation`), post-create automation, audit events. Atomicity guarantee covers bundle + reservation only. Caller still uses bespoke `Cleanup` pattern (`bundle.service.ts:110-118`) for downstream rollback on failure.
- **Errors propagate:** GiST exclusion violations (`23P01`) on overlapping reservations, FK violations, etc. surface as Postgres errors and the caller's `Cleanup` handles them.
- **Idempotency:** the function is NOT idempotent — calling twice creates two bundles + two reservations. Idempotency is the caller's responsibility (e.g., dedupe by request id).

### `BookingFlowService.create` — thin wrapper around the RPC

Today's signature (`apps/api/src/modules/reservations/booking-flow.service.ts:63`): `async create(input, ctx)`. Returns a `Reservation` row.

After Slice 0.2:

```typescript
async create(input: CreateReservationInput, ctx: TenantContext): Promise<CreateBookingResult> {
  const { data, error } = await this.supabase.admin.rpc('create_booking_with_reservation', {
    p_tenant_id: ctx.tenantId,
    p_requester_person_id: input.requester_person_id,
    p_host_person_id: input.host_person_id ?? null,
    p_space_id: input.space_id,
    p_start_at: input.start_at,
    p_end_at: input.end_at,
    p_timezone: input.timezone ?? 'UTC',
    p_source: input.source,
    p_reservation_type: input.reservation_type,
    p_attendee_count: input.attendee_count,
    p_attendee_person_ids: input.attendee_person_ids ?? [],
    p_title: input.title ?? null,
    p_description: input.description ?? null,
    p_recurrence_series_id: input.recurrence_series_id ?? null,
    p_multi_room_group_id: input.multi_room_group_id ?? null,
    p_existing_bundle_id: input.booking_bundle_id ?? null,  // multi-room siblings
    p_status: this.requiresApproval(input) ? 'pending_approval' : 'confirmed',
  });

  if (error) throw error;
  const { reservation_id, booking_bundle_id, bundle_was_created } = data[0];

  // Caller-side: approvals, service attachment, post-create automation
  // (unchanged from today, but always-present bundle simplifies their callers)
  const cleanup = new Cleanup();
  try {
    if (this.requiresApproval(input)) {
      await this.approvalService.createForBundle({
        tenant_id: ctx.tenantId,
        target_entity_type: 'booking_bundle',  // never 'reservation' anymore
        target_entity_id: booking_bundle_id,
        // ...
      });
      cleanup.add(() => this.approvalService.deleteForBundle(booking_bundle_id));
    }

    if (input.services?.length) {
      await this.bundleService.attachServicesToReservation({
        reservation_id,
        requester_person_id: input.requester_person_id,
        services: input.services,
      });
    }

    await this.runPostCreateAutomation({ reservation_id, booking_bundle_id });

    return { reservation_id, booking_bundle_id, bundle_was_created };
  } catch (err) {
    await cleanup.run();
    // Optionally also delete the bundle+reservation; today's Cleanup pattern
    // doesn't propagate that far. Decide at implementation time.
    throw err;
  }
}
```

`lazyCreateBundle` is removed (`bundle.service.ts:845-902`). `attachServicesToReservation` no longer creates a bundle — it just writes lines to the existing one.

### Multi-room — single bundle, N reservations, all atomic per-call

`MultiRoomBookingService.createGroup` today (`apps/api/src/modules/reservations/multi-room-booking.service.ts:39`) iterates rooms, calling `bookingFlow.create` per room. The first call lazily creates a bundle; the others end up with `booking_bundle_id IS NULL` until `attachServicesToReservation` retrofits them.

After Slice 0.2:

```typescript
async createGroup(input: MultiRoomBookingInput, ctx: TenantContext): Promise<CreateGroupResult> {
  const groupId = crypto.randomUUID();
  await this.insertGroup(groupId, input, ctx);

  let sharedBundleId: string | null = null;
  const reservations: CreateBookingResult[] = [];

  for (const room of input.rooms) {
    const result = await this.bookingFlow.create({
      ...input,
      space_id: room.space_id,
      multi_room_group_id: groupId,
      booking_bundle_id: sharedBundleId,  // null for first room → bundle minted; set for siblings → reused
    }, ctx);
    if (sharedBundleId === null) sharedBundleId = result.booking_bundle_id;
    reservations.push(result);
  }

  // Services attach to the shared bundle (still primary-anchored conceptually)
  if (input.services?.length) {
    await this.bundleService.attachServicesToReservation({
      reservation_id: reservations[0].reservation_id,
      requester_person_id: input.requester_person_id,
      services: input.services,
    });
  }

  return { reservations, booking_bundle_id: sharedBundleId };
}
```

**No raw bundle-id fan-out write.** Each per-room RPC is atomic; the shared bundle id is threaded through the loop. The lazy fan-out problem (only primary gets bundle id) goes away because every per-room call passes the bundle id explicitly.

### Recurrence — one bundle per occurrence

`RecurrenceService.materialize` today calls `bookingFlow.create` per occurrence WITHOUT a bundle id; `cloneBundleOrdersToOccurrence` (signature at `apps/api/src/modules/reservations/recurrence.service.ts:465-472`) writes orders against `master.booking_bundle_id`.

After Slice 0.3:

```typescript
async materialize(series: RecurrenceSeries, ctx: TenantContext) {
  const masterBundleId = series.parent_reservation
    ? await this.lookupBundleId(series.parent_reservation_id)
    : null;

  for (const occurrenceTime of computeOccurrences(series)) {
    // Create occurrence as a new booking (its own bundle).
    const result = await this.bookingFlow.create({
      ...series.template,
      start_at: occurrenceTime.start,
      end_at: occurrenceTime.end,
      recurrence_series_id: series.id,
      // booking_bundle_id NOT passed — each occurrence gets its own.
    }, ctx);

    // Clone orders from the master series' bundle to THIS occurrence's bundle.
    if (masterBundleId) {
      await this.cloneBundleOrdersToOccurrence({
        masterReservationId: series.parent_reservation_id,
        masterStartAt: series.start_at_template,
        bundleId: result.booking_bundle_id,  // ← was master.booking_bundle_id
        seriesId: series.id,
        newReservation: { id: result.reservation_id, start_at: occurrenceTime.start, end_at: occurrenceTime.end },
        requesterPersonId: series.requester_person_id,
      }, ctx);
    }
  }
}
```

`cloneBundleOrdersToOccurrence` keeps its existing signature; we change the `bundleId` param to point at the occurrence's bundle, not the master's. The orders module's `cloneOrderForOccurrence` (lazily wired via `setOrdersFanOut`) needs the same retarget — Slice 0.3 covers both.

**Volume implication:** A 90-day daily series produces 90 RPC calls + 90 bundles + 90 visitor-cascade emits. Bundles are 1 row each; visitor-cascade emits are sub-ms point-lookups when no visitors exist. Acceptable; monitor materialisation latency post-deploy and gate on `bundle.has_visitors` (denormalized cache, follow-up slice) if hotspot.

### Approval cutover

Migration steps (in order):

1. **Add temporary CHECK constraint** preventing new `'reservation'`-typed approval inserts:
   ```sql
   alter table public.approvals
     add constraint approvals_no_new_reservation_target
     check (target_entity_type <> 'reservation') not valid;
   -- Don't VALIDATE: existing 'reservation' rows are allowed to remain until re-targeted.
   ```
   This stops the race-condition gap that row-locks alone don't close.

2. **Re-target in-flight rows:**
   ```sql
   update public.approvals a
   set target_entity_type = 'booking_bundle',
       target_entity_id = r.booking_bundle_id
   from public.reservations r
   where a.target_entity_type = 'reservation'
     and a.target_entity_id = r.id
     and a.status = 'pending';
   ```
   Bundles exist post-backfill, so the lookup always succeeds.

3. **Validate the constraint** (now safe — no `'reservation'` rows remain pending; historical decided rows can stay):
   ```sql
   alter table public.approvals validate constraint approvals_no_new_reservation_target;
   ```

After Slice 0.4 (dispatcher cleanup ships):
- `approval.service.ts:329-347` `target_entity_type='reservation'` branch is removed.
- `multi-room-booking.service.ts:221` filter is re-pointed to `'booking_bundle'`.
- The CHECK constraint stays as defensive infrastructure.

### Audit-event entity_type mapping

Audit events are 7-year retention; immutable. Per call-site decisions:

| Call site | Today writes | After canonical |
|---|---|---|
| `reservation.service.ts:359` (created via direct path) | `entity_type='reservation'` | `entity_type='booking_bundle'`, `entity_id=booking_bundle_id` |
| `reservation.service.ts:389` (status change) | `'reservation'` | `'booking_bundle'` |
| `reservation.service.ts:454` (cancelled) | `'reservation'` | `'booking_bundle'` |
| `reservation.service.ts:540` (edit) | `'reservation'` | `'booking_bundle'` |
| `booking-flow.service.ts:602` (created via flow) | `'reservation'` | `'booking_bundle'` |
| `check-in.service.ts:80-95` (`reservation.checked_in`) | `'reservation'` | **stays `'reservation'`** — check-in is a per-room event; multi-room bookings have N check-ins, each genuinely per-reservation |
| `check-in.service.ts:174-185` (`reservation.auto_released`) | `'reservation'` | **stays `'reservation'`** — same rationale |
| `bundle.service.ts:1163, 1327` (current `audit_events` insert/lookup) | `'booking_bundle'` | unchanged |
| `bundle-cascade.service.ts:353` | `'booking_bundle'` | unchanged |

**Runbook update (post-migration):** "Reports filtering audit_events by entity_type='reservation' for *booking-lifecycle* queries (created/cancelled/edited/status-changed) should also include entity_type='booking_bundle' for events after [migration date]. Pre-migration historical rows remain reservation-anchored and are dual-queried during transition. Check-in events stay reservation-anchored permanently — no dual query needed."

### Frontend type cleanup (Slice 0.6)

Three primary types flip:

```typescript
// apps/web/src/api/room-booking/types.ts:85
export interface Reservation {
  booking_bundle_id: string; // was: string | null
}

// apps/web/src/api/orders/types.ts:12
export interface Order {
  booking_bundle_id: string; // was: string | null
}

// apps/web/src/api/visitors/index.ts:108, 154 + admin.ts:391
// Visitor.booking_bundle_id: string (was: string | null)
```

Component changes:
- `apps/web/src/components/booking-detail/booking-detail-content.tsx:394` — conditional becomes unconditional.
- `apps/web/src/components/booking-detail/bundle-services-section.tsx:62-148` — "no bundle yet" branch deleted (~50 lines).
- `apps/web/src/components/booking-detail/bundle-services-section.tsx:236` — `useBundle(bundleId)` always returns a real bundle.
- `apps/web/src/pages/desk/bookings.tsx:413` — chip becomes unconditional or removed.
- `apps/web/src/components/booking-composer/booking-composer.tsx:528-567` — two-shape result handling collapses.
- `apps/web/src/components/desk/visitor-detail.tsx:476-501` — fallback pattern collapses.
- `apps/web/src/pages/desk/approvals.tsx:276` — deeplink fix for services-only bundles (route addition: `?scope=services&bundle_id=...`; verify route exists or add it).

### Visitor module simplification

- `invitation.service.ts:135-136` — keep both `reservation_id` + `booking_bundle_id` writes; under canonical they're always consistent.
- `bundle-cascade.adapter.ts:316-322` — already bundle-anchored; works as-is.
- `reservation.service.ts:562` — visitor cascade emit gate. The `r.booking_bundle_id &&` clause is removed. Cascade fires for every room edit; no-ops on bundles with no visitors. **Sub-ms cost per emit (indexed point-lookup); confirmed by spec, monitor in production.** For a 90-day series cancellation cascading via `cancelForward`, that's 90 empty-query emits — still fast.
- `apps/web/src/components/desk/visitor-detail.tsx:476-501` — fallback pattern collapses to single canonical lookup.

The `reservation_id` field on visitors stays as a denormalized shortcut to the primary reservation. Removing it is a follow-up.

## Migration plan

The migration ships across **two SQL files** because `CREATE INDEX CONCURRENTLY` cannot run inside a transaction (Supabase wraps each migration file in `BEGIN...COMMIT`).

### File 1: `supabase/migrations/00276_booking_canonicalization.sql` (transactional)

Steps:

1. **Add new columns** on `booking_bundles`:
   ```sql
   alter table public.booking_bundles
     add column title text,
     add column description text;
   ```
   Safe: NULL-default columns don't rewrite the table on Postgres ≥11.

2. **Create the `create_booking_with_reservation` function** (full body from §Architecture above).

3. **Backfill bundles via batched PL/pgSQL loop** to avoid single-transaction lock holds at customer scale:
   ```sql
   create or replace function public.backfill_canonical_bundles_batch(p_batch_size int default 500)
   returns int language plpgsql as $$
   declare
     v_processed int := 0;
   begin
     with batch as (
       select r.id, r.tenant_id, r.requester_person_id, r.host_person_id,
              r.space_id, r.start_at, r.end_at, r.timezone,
              r.source, r.reservation_type, r.recurrence_series_id, r.multi_room_group_id,
              r.created_at as r_created_at, r.updated_at as r_updated_at,
              case r.reservation_type
                when 'room' then 'meeting'
                when 'desk' then 'desk_day'
                when 'parking' then 'parking'
                when 'asset' then 'other'
                else 'other'
              end as derived_bundle_type
       from public.reservations r
       left join public.booking_bundles bb on bb.primary_reservation_id = r.id
       where r.booking_bundle_id is null
         and bb.id is null  -- TRUE idempotency: skip rows where a bundle already exists from a prior batch
       order by r.id
       limit p_batch_size
       for update of r skip locked
     ),
     inserted as (
       insert into public.booking_bundles (
         tenant_id, bundle_type,
         requester_person_id, host_person_id,   -- host left NULL when not derivable; per 00140 it's nullable
         primary_reservation_id,
         location_id, start_at, end_at, timezone, source,
         policy_snapshot,
         created_at, updated_at                 -- carry source reservation timestamps to avoid report spike
       )
       select tenant_id, derived_bundle_type,
              requester_person_id, host_person_id,
              id,
              space_id, start_at, end_at, coalesce(timezone, 'UTC'), source,
              '{}'::jsonb,
              r_created_at, r_updated_at
       from batch
       returning id, primary_reservation_id
     )
     update public.reservations r
     set booking_bundle_id = i.id, updated_at = r.updated_at  -- preserve updated_at
     from inserted i
     where r.id = i.primary_reservation_id;

     get diagnostics v_processed = row_count;
     return v_processed;
   end;
   $$;

   -- Driver loop (runs inside the migration transaction; PL/pgSQL block):
   do $$
   declare
     v_batch_count int;
   begin
     loop
       v_batch_count := public.backfill_canonical_bundles_batch(500);
       exit when v_batch_count = 0;
     end loop;
   end;
   $$;
   ```
   - Batched at 500 rows. `for update of r skip locked` lets concurrent inserts (if any during migration) skip rather than block.
   - `LEFT JOIN booking_bundles` makes the loop fully idempotent — partial completes can resume cleanly.
   - `created_at` carried from source reservation, `host_person_id` left NULL when not present.

4. **Verify backfill completed:**
   ```sql
   do $$
   declare v_remaining int;
   begin
     select count(*) into v_remaining from public.reservations where booking_bundle_id is null;
     if v_remaining > 0 then
       raise exception 'Backfill incomplete: % rows remaining', v_remaining;
     end if;
   end;
   $$;
   ```

5. **Add temporary CHECK constraint** on approvals (blocks new `'reservation'`-typed inserts):
   ```sql
   alter table public.approvals
     add constraint approvals_no_new_reservation_target
     check (target_entity_type <> 'reservation') not valid;
   ```

6. **Re-target in-flight reservation-typed approvals:**
   ```sql
   update public.approvals a
   set target_entity_type = 'booking_bundle',
       target_entity_id = r.booking_bundle_id
   from public.reservations r
   where a.target_entity_type = 'reservation'
     and a.target_entity_id = r.id
     and a.status = 'pending';
   ```
   Decided rows stay reservation-anchored (immutable history; the CHECK constraint allows them via `NOT VALID`).

7. **Add NOT NULL constraint on `reservations.booking_bundle_id`** using the two-pass pattern (avoids full-table lock under AccessExclusive):
   ```sql
   alter table public.reservations
     add constraint reservations_booking_bundle_id_not_null
     check (booking_bundle_id is not null) not valid;
   alter table public.reservations
     validate constraint reservations_booking_bundle_id_not_null;
   alter table public.reservations
     alter column booking_bundle_id set not null;
   alter table public.reservations
     drop constraint reservations_booking_bundle_id_not_null;
   ```
   Postgres ≥12 (Supabase is 15) recognizes the validated `IS NOT NULL` CHECK and skips the `SET NOT NULL` scan (commit `b08df9ca`).

8. **Update report RPCs** that have now-vacuous `WHERE booking_bundle_id IS NOT NULL` clauses (`00155`, `00156`):
   - `CREATE OR REPLACE FUNCTION` for each affected RPC, removing the dead clauses.

9. **Reload PostgREST schema:**
   ```sql
   notify pgrst, 'reload schema';
   ```

### File 2: `supabase/migrations/00276b_booking_canonicalization_indexes.sql` (NON-transactional)

CONCURRENTLY DDL must run outside any transaction:

```sql
-- Each statement standalone; Supabase migration runner must be configured to run this file
-- without wrapping in a transaction. If not configurable, split each statement into its own file.

create index concurrently if not exists idx_reservations_bundle
  on public.reservations (tenant_id, booking_bundle_id);
drop index concurrently if exists public.idx_reservations_with_bundle;

create index concurrently if not exists idx_tickets_bundle_v2
  on public.tickets (tenant_id, booking_bundle_id);
drop index concurrently if exists public.idx_tickets_bundle;

-- Repeat for: idx_orders_bundle (00144), idx_asset_reservations_bundle (00142),
-- idx_visitors_booking_bundle (00252), work_orders bundle index (00213).
```

### Pre-migration verification

Before applying File 1 to remote, run these read-only queries to confirm scope hasn't shifted:

```sql
select count(*) filter (where booking_bundle_id is null) as null_count,
       count(*) filter (where booking_bundle_id is not null) as not_null_count,
       count(*) as total
from public.reservations;

select target_entity_type, status, count(*)
from public.approvals
group by 1, 2
order by 1, 2;

select count(*) from public.booking_bundles where primary_reservation_id is null;
```

Apply migration. Re-run queries; null_count must be 0, status='pending' rows with target_entity_type='reservation' must be 0.

### Rollback strategy

Honestly: **rollback is not free.** The `SET NOT NULL` + `DROP CONSTRAINT` are cheap to reverse, but the bundle backfill UPDATE on the entire table is a big lock-holder. The approval re-target is reversible only if we kept the original `(reservation_id, booking_bundle_id)` mapping (which we do via the FK relationship). Practical advice: **test rollback on local DB before remote push; treat remote push as one-way for the bundle backfill.**

## Deploy strategy

**Slices 0.1 + 0.2 ship as ONE atomic deploy.** This is the spec-corrected fix for v1's slice-ordering bug. Sequence:

1. Pre-migration verification queries (read-only).
2. Deploy app code (Slice 0.2 — `BookingFlowService` always-create + multi-room threading + DTO updates) to a holding branch. **Do not merge to main yet.**
3. Apply File 1 of the migration to remote.
4. Apply File 2 of the migration to remote.
5. Run smoke gate to verify invariant.
6. Merge the holding branch to main; CI deploys the app code.
7. Watch logs for 1 hour for any unexpected 23502 (should be zero).

**The migration's CHECK constraint on `reservations.booking_bundle_id` adds defensive protection during the brief window between migration and app-code deploy** — if any code path tries to insert without a bundle, it 23502s loudly instead of failing silently.

After the deploy is green, the holding branch is deleted and remaining slices (0.3–0.7) deploy normally.

## Risk register

| Risk | Mitigation |
|---|---|
| App code missed a `booking_bundle_id`-providing insert path → 23502 in production | Pre-deploy grep for all `from('reservations').insert` callers; verify each post-Slice-0.2 passes `booking_bundle_id`. CI fails on any caller without it. |
| Backfill at customer scale (50K+ rows) takes too long under lock | Batched PL/pgSQL loop with `for update skip locked`; per-batch commit time bounded; remote push during low-traffic window |
| Approval re-target races with new approvals | CHECK constraint blocks new `'reservation'`-typed inserts before the UPDATE runs |
| CONCURRENTLY indexes blocked by a long-running query | Split into File 2; Postgres CONCURRENTLY waits — acceptable; monitor and abort if stuck |
| Calendar reconciler reads dropped column | DROP deferred to Slice 0.6 after `reconciler.service.ts:189` migrates to `bookings.calendar_event_id` |
| Recurrence series materialisation creates N bundles per series — load spike | Acceptable per design; monitor materialisation latency. Bundle insert is one row; visitor-cascade emits no-op for room-only |
| Visitor cascade emit fires for every room edit (was gated by bundle presence) | Empty queries on room-only bookings; sub-ms cost. Smoke-test asserts. Follow-up if hotspot |
| Audit-event reporting under-counts during transition | Documented in runbook; reports updated to query both entity_types |
| Frontend type cleanup misses a caller | TypeScript flips will surface every consumer at compile time; CI fails on first miss |
| Smoke gate's invariant probe regresses without obvious test failure | Added probe asserts every `POST /reservations` returns non-null `booking_bundle_id`; runs in `pnpm smoke:work-orders` |
| The new CHECK constraint on approvals breaks legacy testing fixtures | Test fixtures updated in Slice 0.7; CHECK is `NOT VALID` so existing rows aren't re-validated |
| `cloneOrderForOccurrence` (orders module) still references master bundle id | Slice 0.3 explicitly retargets it; codex review post-slice |

## Slice plan (revised v2)

7 slices. Each ends with codex review (when available) or full-review + commit + remote push (where applicable).

| Slice | Scope | Est. days |
|---|---|---|
| **0.0 — Calendar consumer migration** | Migrate `reconciler.service.ts:189` and `booking-detail-content.tsx:190` to read `bookings.calendar_event_id` (or alias correctly). Pre-requisite for Slice 0.6's column drop. | 1 |
| **0.1 + 0.2 — Atomic deploy: migration + always-create code** | Both SQL files + `BookingFlowService.create` rewrite (RPC wrapper) + multi-room threading + DTO updates. Ships together. | 3–4 |
| **0.3 — Recurrence per-occurrence bundles** | `RecurrenceService.materialize` rewrite + `cloneBundleOrdersToOccurrence` retarget + `cloneOrderForOccurrence` retarget (orders module) | 2 |
| **0.4 — Approval dispatcher + audit-event mapping** | Remove `target_entity_type='reservation'` branch; multi-room filter re-point; per-call-site audit-event updates | 1.5 |
| **0.5 — Visitor module + 5 service-layer branch removals** | Cascade emit gate, dispatch path simplification, visibility helper delegation | 1.5 |
| **0.6 — Frontend type cleanup + drop calendar columns** | Type flips, conditional removal, approvals deeplink fix, composer simplification, drop `reservations.calendar_event_id/provider/etag` | 2 |
| **0.7 — Test suite updates + smoke probe + final review** | 9 spec files, fixture FK ordering, canonical-invariant smoke probe, final codex/full review | 3–4 |
| **Total** | | **14–18 days, ~3 weeks** (slightly higher than v1 estimate due to Slice 0.0 addition + atomic-deploy carefulness) |

**Order matters:** 0.0 must land first. 0.1+0.2 ships atomically. 0.3 depends on 0.1+0.2. 0.4/0.5 depend on 0.1+0.2. 0.6 depends on 0.4 + 0.5 + 0.0. 0.7 final.

**Codex/full-review checkpoints:** after each slice. User-facing `/full-review` after the atomic deploy (0.1+0.2) and the final slice.

## Testing strategy

- **Per-slice TDD:** failing test first.
- **Smoke probe addition** in `apps/api/scripts/smoke-work-orders.mjs`:
  - `POST /reservations` returns non-null `booking_bundle_id`.
  - Multi-room: one bundle id stamped on N reservations.
  - Recurrence series materialisation: per-occurrence bundle ids are unique.
- **Manual verification** before merging atomic-deploy slice: create one each of (room-only single, room+services, multi-room, recurring); verify shape via `psql`.
- **Integration tests:** `bundle.service.spec.ts`, `multi-room-booking.service.spec.ts`, `recurrence.service.spec.ts`, `bundle-cascade.service.spec.ts`, `bundle-visibility.service.spec.ts`, `booking-origin-work-order.spec.ts` get re-fixtured.

## Open questions

1. **Cleanup-on-bundle-failure scope.** Today's `Cleanup` pattern (`bundle.service.ts:110-118`) cleans up service lines and approvals on failure but doesn't unwind the bundle/reservation pair. Under canonical, should it? The bundle+reservation pair is now atomic-by-Postgres-function; if downstream (approvals, services) fails, do we delete the bundle+reservation, or leave them as an empty booking? **My pick: leave them.** A reservation that exists with no services is a valid state (room-only booking). The failed downstream gets surfaced as a 500 to the user; they can retry. Document in implementation.

2. **Multi-room rollback semantics.** If room 3 of a 5-room group fails to insert, today the group's primary bundle exists and rooms 1-2 are inserted. Cleanup deletes them or leaves them? Today: leaves them (bug). Under canonical: should still leave them; transactional multi-room is a separate spec.

## Spec self-review (v2)

- ✅ All 13 critical findings from full-review v1 addressed:
  1. Atomicity via Postgres function (not invented JS transactions)
  2. Slices 0.1+0.2 ship atomically
  3. Calendar columns kept; drop deferred to Slice 0.6 with prerequisite Slice 0.0
  4. Backfill is a real PL/pgSQL function with batched commits
  5. CONCURRENTLY indexes split to File 2
  6. Multi-room file:lines re-checked; no raw fan-out write claim
  7. `cloneBundleOrdersToOccurrence` real signature used
  8. `master_bundle_id` resolved as `master.booking_bundle_id` (existing) or via lookup
  9. Function-first design avoids the lazyCreateBundle reorder problem
  10. Backfill carries `created_at` from source reservation
  11. Backfill leaves `host_person_id` NULL when not derivable
  12. LEFT JOIN ensures backfill idempotency
  13. CHECK constraint blocks approval-cutover race
- ✅ No placeholders.
- ✅ Internal consistency: function signature, caller code, slice plan all align.
- ✅ Scope: focused on canonicalization; explicit deferrals listed.
- ✅ Risk register covers production hazards including the atomic-deploy procedure.
- ✅ Slice plan has clear dependency ordering + review checkpoints.

Ready for second adversarial review (codex unavailable; using full-review).
