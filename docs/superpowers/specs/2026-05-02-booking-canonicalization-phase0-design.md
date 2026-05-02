# Booking canonicalization — Phase 0 design

**Date:** 2026-05-02
**Status:** Design (pre-implementation)
**Owner:** Backend (deep) + frontend (type cleanup) + migration
**Depends on:** None (this IS the foundation)
**Blocks:** Booking-modal redesign, visitors-on-booking-detail polish, future booking-platform features
**Investigation:** [`docs/superpowers/specs/2026-05-02-booking-canonicalization-investigation.md`](./2026-05-02-booking-canonicalization-investigation.md) — read this first; contains the blast-radius measurement and adversarial reviewer corrections that drove this design.

## Problem

The codebase models a "booking" with a dual-root data model:

- `reservations` is created for every booking. Universal.
- `booking_bundles` is created **lazily** only on first-service-attach. Most reservations have `booking_bundle_id IS NULL` (measured: 81% on dev DB).

This bifurcation creates ongoing tax:

1. **Cognitive overhead.** Every code path must remember "bundle might not exist". Six service-layer branches today (`bundle.service.ts:121, 851`; `reservation.service.ts:402-407, 562`; `bundle-cascade.service.ts:83-88, 493`; `booking-flow.service.ts:262, 273-316`).
2. **Title has nowhere to live.** Booking title can't go on `reservations` (multi-room reservations would replicate it) or `booking_bundles` alone (most bookings don't have a bundle).
3. **Recurrence is broken-by-design.** Per-occurrence reservations have NULL bundle, but their orders point at the master's bundle id. Two bundles per occurrence in the loosest sense.
4. **Multi-room writes bundle_id outside `BookingFlowService`** (`multi-room-booking.service.ts:165, 201`) to retrofit the bundle onto siblings after the primary's lazy-create. There are at minimum two insertion points today.
5. **Approval visibility is split.** `target_entity_type IN ('reservation', 'booking_bundle')` — same approval flow, two routing branches, 13 in-flight `'reservation'`-typed rows on dev DB.
6. **The data model fights the human mental model.** Users say "my booking", not "my reservation, plus maybe a bundle".

## The decision (locked)

`booking_bundles` becomes the **canonical "booking" entity**.

- Every reservation belongs to a booking.
- Title, description, host, status, audit anchor on the booking.
- Reservations are pure resource+time children of a booking.
- Services + visitors + tickets attach to the booking.
- The lazy-bundle invariant is dead.

The table stays named `booking_bundles` (rename is a separate, larger refactor not justified by this slice). In code/UI vocabulary, "Booking" refers to a `booking_bundles` row throughout.

## Goals

1. **Always-create-bundle invariant.** Every reservation insert is preceded (in the same transaction) by a bundle insert. `reservations.booking_bundle_id` becomes NOT NULL.
2. **Single insertion point.** Bundle creation lives in `BookingFlowService.create` (or a new `BookingService.create` that wraps it). Multi-room and recurrence routes through it; no second writer.
3. **One bundle per multi-room group.** Today's behavior preserved; lift creation above the per-room loop.
4. **One bundle per recurrence occurrence.** Each occurrence is a real booking. Orders attach to the occurrence's bundle, not the master's. Ends today's hybrid mess.
5. **Title + description columns on `booking_bundles`.** Persisted, not theater. Live-placeholder UX in the modal redesign now has a real backend.
6. **Approval cutover with zero approver-visibility loss.** In-place re-target of the 13 in-flight `target_entity_type='reservation'` rows during the migration, dispatcher branch removed in the same release.
7. **Audit immutability.** Historical reservation-typed `audit_events` rows stay as-is. New events under canonical use `'booking_bundle'`. Runbook documents the dual-query during transition.
8. **Frontend type cleanup.** Nullable bundle fields flip to non-null on the reservation side. Components stop branching on bundle presence.
9. **Smoke gate extended.** Add a canonical-invariant probe to verify every `POST /reservations` returns a non-null `booking_bundle_id`.

## Non-goals

- **Renaming the table to `bookings`.** Touches every routing/visibility/RLS rule. Separate refactor; the rename can come later when there's a bundled UX justification.
- **Folding services-only bundles into canonical.** The 1 existing services-only bundle (`primary_reservation_id IS NULL`) stays as-is. The invariant is one-directional: every reservation has a bundle, but not every bundle has a reservation. **Documented explicitly so frontend doesn't assume bundle ↔ reservation 1:1.**
- **Realtime channel consolidation.** Two parallel naming schemes (`bundle-lines:*` and `desk-scheduler:*`) overlap conceptually but don't break under canonical. Tracked as follow-up.
- **Outlook calendar-sync wiring.** Phase C is unwired today. Canonical model gives us `booking_bundles.calendar_event_id` as the single surface; this slice drops `reservations.calendar_event_id` (no production data) but doesn't wire the integration.
- **Booking modal redesign.** Separate spec ([`docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md`](./2026-05-02-create-booking-modal-redesign.md)) which depends on this Phase 0 landing first.

## Architecture

### Data model changes

```sql
-- New columns on booking_bundles (the canonical Booking)
alter table public.booking_bundles
  add column title text,
  add column description text;

-- Make booking_bundle_id non-null on reservations after backfill
alter table public.reservations
  alter column booking_bundle_id set not null;

-- Drop the now-vacuous calendar_event_id columns on reservations
-- (canonical surface is booking_bundles.calendar_event_id; Outlook unwired today)
alter table public.reservations
  drop column calendar_event_id,
  drop column calendar_provider,
  drop column calendar_etag;

-- Convert partial indexes to plain (will be done with CONCURRENTLY in actual migration)
drop index public.idx_reservations_with_bundle;
create index idx_reservations_bundle on public.reservations (tenant_id, booking_bundle_id);
-- Same pattern for the other 5 partial indexes (00145, 00144, 00142, 00252, 00213)
```

### `BookingFlowService.create` — always-create-bundle

The single insertion point. New flow:

```typescript
async create(input: CreateReservationInput, ctx: TenantContext): Promise<CreateBookingResult> {
  return await this.db.transaction(async (tx) => {
    // 1. Mint the booking (was lazy; now always)
    const bundle = await this.createBundle(input, ctx, tx);

    // 2. Insert the reservation with booking_bundle_id stamped
    const reservation = await this.insertReservation({
      ...input,
      booking_bundle_id: bundle.id,
    }, ctx, tx);

    // 3. Attach services if provided (was the bundle-creation trigger; now just the line writer)
    if (input.services?.length) {
      await this.bundleService.attachLines(bundle.id, input.services, ctx, tx);
    }

    // 4. Approvals — always anchor on bundle (no more 'reservation' target type)
    if (this.requiresApproval(input)) {
      await this.approvalService.create({
        target_entity_type: 'booking_bundle',
        target_entity_id: bundle.id,
        // ...
      }, ctx, tx);
    }

    // 5. Run post-create automation (unchanged — already bundle-aware)
    return { reservation, bundle };
  });
}
```

`lazyCreateBundle` is removed. `attachServicesToReservation` stays for the post-create services-attach path (operator adds catering after the booking exists), but no longer creates a bundle — it just writes lines.

### Multi-room — lift bundle creation above the loop

`MultiRoomBookingService.startGroupBooking` today creates the primary's bundle inside the loop (lazily on first-service-attach). New flow:

```typescript
async startGroupBooking(input: MultiRoomBookingInput, ctx: TenantContext): Promise<MultiRoomBookingResult> {
  return await this.db.transaction(async (tx) => {
    // 1. Mint ONE bundle for the whole group
    const bundle = await this.bookingFlow.createBundle({
      ...input,
      multi_room_group_id: groupId,
    }, ctx, tx);

    // 2. Insert N reservations all stamped with bundle.id (no fan-out write needed)
    const reservations = await Promise.all(
      input.rooms.map((room) =>
        this.bookingFlow.insertReservation({
          ...input,
          space_id: room.id,
          booking_bundle_id: bundle.id,
          multi_room_group_id: groupId,
        }, ctx, tx),
      ),
    );

    // 3. Services attach to the bundle (still primary-anchored conceptually)
    if (input.services?.length) {
      await this.bundleService.attachLines(bundle.id, input.services, ctx, tx);
    }

    return { reservations, bundle };
  });
}
```

The raw bundle-id fan-out write at `multi-room-booking.service.ts:165, 201` is **deleted**.

### Recurrence — one bundle per occurrence

`RecurrenceService.materialize` today calls `bookingFlow.create` per occurrence WITHOUT passing a bundle id, then `cloneBundleOrdersToOccurrence` writes orders against `master.booking_bundle_id`.

New flow under canonical:

```typescript
async materialize(series: RecurrenceSeries, ctx: TenantContext) {
  for (const occurrenceTime of computeOccurrences(series)) {
    // bookingFlow.create now ALWAYS creates a bundle for the occurrence
    const { reservation, bundle: occurrenceBundle } = await this.bookingFlow.create({
      ...series.template,
      start_at: occurrenceTime.start,
      end_at: occurrenceTime.end,
      recurrence_series_id: series.id,
    }, ctx);

    // Clone orders from master bundle to OCCURRENCE bundle (not master's)
    if (series.master_bundle_id) {
      await this.cloneBundleOrdersToOccurrence({
        sourceBundleId: series.master_bundle_id,
        targetBundleId: occurrenceBundle.id, // ← was master.booking_bundle_id
        reservationId: reservation.id,
      }, ctx);
    }
  }
}
```

**Volume implication:** A 90-day daily series produces 90 bundle inserts at materialisation. Acceptable; bundles are 1 row each, no cascading writes; visitor cascade emits no-op for room-only occurrences.

**Visibility-side check:** Materialisation triggers visitor-cascade emit per occurrence (now that every reservation has a bundle). For room-only series this is N empty queries per materialisation. Add a smoke-test asserting per-occurrence emit cost is sub-ms; if production traffic shows this is a hotspot, gate the emit on `bundle.has_visitors` (denormalized cache, follow-up slice).

### Approval cutover

Migration step (in the same transaction as the backfill):

```sql
-- Re-target the 13 (or more, at customer scale) in-flight reservation-typed approvals
update public.approvals a
set
  target_entity_type = 'booking_bundle',
  target_entity_id = r.booking_bundle_id
from public.reservations r
where a.target_entity_type = 'reservation'
  and a.target_entity_id = r.id
  and a.status = 'pending';
```

After the migration:
- `approval.service.ts:329-347` dispatcher branch for `target_entity_type='reservation'` is **removed**.
- `multi-room-booking.service.ts:221` filter for `target_entity_type='reservation'` is **re-pointed** to `'booking_bundle'`.
- `bundle-visibility.service.ts:127, 143` filter stays — it now sees ALL approvals, including the re-targeted ones.

The 13 approvers' visibility is preserved because their approvals now point at a bundle that exists (post-backfill), and the bundle-visibility surface picks them up.

### Audit-event entity_type mapping

7-year retention; audit_events are immutable. Per call-site decisions:

| Call site | Today writes | After canonical |
|---|---|---|
| `reservation.service.ts:359` (created) | `entity_type='reservation'` | `entity_type='booking_bundle'` (new event), `entity_id=booking_bundle_id` |
| `reservation.service.ts:389` (status change) | `'reservation'` | `'booking_bundle'` |
| `reservation.service.ts:454` (cancelled) | `'reservation'` | `'booking_bundle'` |
| `reservation.service.ts:540` (edit) | `'reservation'` | `'booking_bundle'` |
| `booking-flow.service.ts:602` (created via flow) | `'reservation'` | `'booking_bundle'` |
| `check-in.service.ts:90, 178` (check-in) | `'reservation'` | **stays `'reservation'`** — check-in is a reservation-time event, not a booking-state event |
| `bundle.service.ts:393, 1078, 1187, 1293` | `'booking_bundle'` | unchanged |
| `bundle-cascade.service.ts:353` | `'booking_bundle'` | unchanged |

**Rationale for check-in staying reservation-anchored:** Check-in is about the physical room+time slot, not the booking's lifecycle. Multi-room bookings have N check-ins. This is the only call site where reservation is genuinely the right entity.

**Runbook update (post-migration):** "Reports filtering audit_events by entity_type='reservation' for booking-lifecycle queries should also include entity_type='booking_bundle' for events after [migration date]. Pre-migration historical rows remain as-is."

### Frontend type cleanup

Three primary types flip:

```typescript
// apps/web/src/api/room-booking/types.ts
export interface Reservation {
  id: string;
  booking_bundle_id: string; // was: string | null
  // ...
}

// apps/web/src/api/orders/types.ts
export interface Order {
  booking_bundle_id: string; // was: string | null
  // ...
}

// apps/web/src/api/visitors/index.ts + admin.ts
// Visitor.booking_bundle_id: string (was: string | null)
```

Component changes:

- `booking-detail-content.tsx:394` — `{reservation.booking_bundle_id && <BundleWorkOrdersSection .../>}` becomes unconditional render.
- `bundle-services-section.tsx:62-148` — "no bundle yet" branch deleted (~50 lines).
- `bundle-services-section.tsx:236` — `useBundle(bundleId)` always returns a real bundle; loading/error states stay.
- `pages/desk/bookings.tsx:413` — `{item.booking_bundle_id && ...}` chip becomes unconditional or removed.
- `booking-composer.tsx:528-567` — two-shape result handling collapses; every booking returns `{ reservations, bundle }`.
- `apps/web/src/components/desk/visitor-detail.tsx:476-501` — "prefer reservation_id, fall back to booking_bundle_id" lookup collapses to single canonical lookup.
- `apps/web/src/pages/desk/approvals.tsx:276` — deeplink `${bundle.primary_reservation_id ?? ''}` fix: when `primary_reservation_id IS NULL` (services-only bundle), link to `/desk/bookings?scope=services&bundle_id=${bundle.id}` instead.

### Visitor module simplification

The dual-link (`reservation_id` + `booking_bundle_id`) collapses:

- `invitation.service.ts:135-136` — keep both writes; under canonical they're always consistent.
- `bundle-cascade.adapter.ts:316-322` — already bundle-anchored; works as-is.
- `reservation.service.ts:598-602` (visitor cascade emit on room edit) — the gate `if (... && r.booking_bundle_id && this.bundleEventBus)` becomes `if (... && this.bundleEventBus)`. Cascade fires for every room edit, no-ops for room-only bookings (empty visitor query).
- `apps/web/src/components/desk/visitor-detail.tsx:476-501` — fallback pattern collapses to single lookup.

The `reservation_id` field on visitors stays as a denormalized shortcut to the primary reservation. Removing it is a follow-up if it's not earning its keep.

## Migration plan

Single migration file: `supabase/migrations/00276_booking_canonicalization.sql`. Sequence:

1. **Add new columns** on `booking_bundles`: `title text`, `description text`. Nullable; populated by application code going forward.
2. **Backfill** — create a bundle for every reservation lacking one, in a batched CTE (default 500 rows/batch to keep transactions short):
   ```sql
   with reservations_to_backfill as (
     select id, tenant_id, requester_person_id, host_person_id, location_id,
            start_at, end_at, timezone, source, recurrence_series_id, multi_room_group_id,
            -- bundle_type derives from reservation_type (D8)
            case reservation_type
              when 'room' then 'meeting'
              when 'desk' then 'desk_day'
              when 'parking' then 'parking'
              else 'other'
            end as derived_bundle_type
     from public.reservations
     where booking_bundle_id is null
     -- includes cancelled/released per D6
   ),
   inserted_bundles as (
     insert into public.booking_bundles (
       id, tenant_id, bundle_type, requester_person_id, host_person_id,
       primary_reservation_id, location_id, start_at, end_at, timezone, source,
       policy_snapshot, created_at, updated_at
     )
     select
       gen_random_uuid(), tenant_id, derived_bundle_type, requester_person_id,
       coalesce(host_person_id, requester_person_id), -- bundle requires non-null host
       id, location_id, start_at, end_at, coalesce(timezone, 'UTC'), source,
       '{}'::jsonb, now(), now()
     from reservations_to_backfill
     returning id, primary_reservation_id
   )
   update public.reservations r
   set booking_bundle_id = ib.id
   from inserted_bundles ib
   where r.id = ib.primary_reservation_id;
   ```

3. **Verify backfill** — `select count(*) from public.reservations where booking_bundle_id is null;` must be 0.

4. **Re-target in-flight approvals** (D3):
   ```sql
   update public.approvals a
   set target_entity_type = 'booking_bundle',
       target_entity_id = r.booking_bundle_id
   from public.reservations r
   where a.target_entity_type = 'reservation'
     and a.target_entity_id = r.id
     and a.status = 'pending';
   ```

5. **Add NOT NULL constraint** using two-pass to avoid full-table lock:
   ```sql
   alter table public.reservations
     add constraint reservations_booking_bundle_id_not_null check (booking_bundle_id is not null) not valid;
   alter table public.reservations validate constraint reservations_booking_bundle_id_not_null;
   alter table public.reservations alter column booking_bundle_id set not null;
   alter table public.reservations drop constraint reservations_booking_bundle_id_not_null;
   ```

6. **Convert partial indexes to plain** using `CREATE INDEX CONCURRENTLY` then `DROP INDEX CONCURRENTLY`:
   - `idx_reservations_with_bundle` (00199)
   - `idx_tickets_bundle`, `idx_tickets_kind_bundle` (00145)
   - `idx_orders_bundle` (00144)
   - `idx_asset_reservations_bundle` (00142)
   - `idx_visitors_booking_bundle` (00252)
   - work_orders bundle index (00213:168)

7. **Drop now-vacuous WHERE clauses** in `00155_room_booking_report_rpc.sql` and `00156_room_booking_management_reports.sql` recurring-cost reports — done by re-creating the affected RPCs without the predicates.

8. **Drop redundant calendar columns on reservations** (D7):
   ```sql
   alter table public.reservations
     drop column calendar_event_id,
     drop column calendar_provider,
     drop column calendar_etag;
   ```

9. **Reload PostgREST schema:**
   ```sql
   notify pgrst, 'reload schema';
   ```

The migration is idempotent on re-run (uses `WHERE booking_bundle_id IS NULL` predicates; `INSERT ... RETURNING` only triggers on rows that actually need backfill).

**Rollback strategy:** The `booking_bundles.title` and `description` columns are nullable additions — safe to drop. The bundle backfill can be reversed by `UPDATE reservations SET booking_bundle_id = NULL WHERE id IN (SELECT primary_reservation_id FROM booking_bundles WHERE created_at >= '<migration_timestamp>')` followed by deleting the orphan bundles. The approval re-target is reversible by reading the dual `(reservation_id, booking_bundle_id)` mapping back. **Practical advice:** test rollback on local DB before remote push; don't rely on it in production.

## Risk register

| Risk | Mitigation |
|---|---|
| AccessExclusiveLock during NOT NULL migration on large customer tables | Two-pass NOT VALID + VALIDATE CONSTRAINT pattern |
| Backfill transaction bloat at 10K+ row tenants | Batched CTE (500 rows/batch) wrapped in a stored function the migration calls in a loop |
| Approval re-target races with new approvals being created | Migration runs in a transaction; new approvals during transaction wait on row locks |
| Recurrence materialisation creates N bundles per series — load spike | Acceptable per design; monitor materialisation latency post-deploy. Bundle insert is one row, no cascading writes |
| Visitor cascade emit fires for every room edit (was gated by bundle presence) | Empty queries on room-only bookings; sub-ms cost. Smoke-test asserts. Follow-up if hotspot |
| Audit-event reporting under-counts during transition | Documented in runbook; reports updated to query both entity_types |
| Frontend type cleanup misses a caller | TypeScript flips will surface every consumer at compile time; CI fails on first miss |
| Smoke gate's invariant probe regresses without obvious test failure | Added probe asserts every `POST /reservations` returns non-null `booking_bundle_id`; runs in `pnpm smoke:work-orders` |

## Slice plan

The work breaks into 7 slices that ship independently. Each slice ends with codex review + commit + remote push (where applicable).

| Slice | Scope | Est. days |
|---|---|---|
| **0.1 — Migration & backfill** | The 9-step SQL migration above; remote push; smoke gate verifies invariant | 2–3 |
| **0.2 — `BookingFlowService` always-create** | Refactor to always-create; remove lazy gate; multi-room lift; DTO updates | 2–3 |
| **0.3 — Recurrence per-occurrence bundles** | `RecurrenceService.materialize` rewrite; `cloneBundleOrdersToOccurrence` retarget | 1.5–2 |
| **0.4 — Approval dispatcher cleanup + audit-event mapping** | Remove `target_entity_type='reservation'` branch; multi-room filter re-point; per-call-site audit-event updates | 1–1.5 |
| **0.5 — Visitor module + 5 service-layer branch removals** | Cascade emit gate, dispatch path simplification, visibility helper delegation | 1–1.5 |
| **0.6 — Frontend type cleanup + component updates** | Type flips, conditional removal, approvals deeplink fix, composer simplification | 1.5–2 |
| **0.7 — Test suite updates + smoke probe + final codex review** | 9 spec files, fixture FK ordering, canonical-invariant smoke probe, final review | 3–4 |
| **Total** | | **12–17 days, ~3 weeks** |

**Order matters:** 0.1 must land first (everything else depends on the schema being canonical). 0.2/0.3 can parallelize after 0.1. 0.4/0.5 depend on 0.2. 0.6 depends on 0.2 + 0.3 + 0.5. 0.7 is the final gate.

**Codex review checkpoints:** after 0.1 (migration safety), after 0.3 (recurrence semantics), after 0.5 (full backend done), after 0.7 (entire phase). User-facing `/full-review` after 0.6 (combined backend + frontend assessment) and final.

## Testing strategy

- **Per-slice unit tests:** every slice writes failing tests first (TDD).
- **Integration tests:** `bundle.service.spec.ts`, `multi-room-booking.service.spec.ts`, `recurrence.service.spec.ts`, `bundle-cascade.service.spec.ts`, `bundle-visibility.service.spec.ts`, `booking-origin-work-order.spec.ts` get re-fixtured.
- **Smoke probe addition:** new probe in `apps/api/scripts/smoke-work-orders.mjs` (or a new `smoke-bookings.mjs`) asserts:
  - `POST /reservations` returns non-null `booking_bundle_id`.
  - The response shape matches `{ reservation, bundle }`.
  - Multi-room: one bundle id stamped on N reservations.
  - Recurrence: per-occurrence bundle ids are unique.
- **Manual verification:** create a recurring series with services attached, verify each occurrence has its own bundle and orders correctly attach.

## Open questions

None at design lock. Implementation may surface small choices (exact batch size for backfill, exact reporting query updates in the runbook); resolve inline at implementation time.

## Spec self-review

- ✅ Spec coverage: every decision D1–D9 from brainstorming is addressed.
- ✅ No placeholders.
- ✅ Internal consistency: D1–D9 don't contradict each other.
- ✅ Scope: focused on canonicalization; explicitly excludes table rename, services-only bundle fold, realtime channel consolidation, calendar-sync wiring, modal redesign.
- ✅ Type/method consistency: `BookingFlowService.create` returns `{ reservation, bundle }` throughout; `bookingService.createBundle` is the bundle-only entry; `bundleService.attachLines` is the line writer.
- ✅ Risk register covers the major failure modes.
- ✅ Slice plan has clear dependency ordering + codex/full-review checkpoints.

Ready for codex design review.
