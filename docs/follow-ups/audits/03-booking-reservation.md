# Audit 03 — Booking / Reservation Architecture

Date: 2026-05-13
Scope: canonical source-of-truth · atomicity · transactional integrity · best-in-class operations on `bookings` + `booking_slots` and their cascades.
Reviewer pose: adversarial; brutal honesty.

---

## Executive verdict

**Mixed. The headline RPCs (`create_booking_with_attach_plan` 00309, `edit_booking` v5 00394, `edit_booking_scope` v3 00395/00399, `grant_booking_approval` 00310) are excellent — single-transaction, idempotency-gated, tenant-asserting, outbox-and-inbox atomic.** Canonical schema (00277) is clean. Legacy tables are gone (00276), no live `from('reservations')` or `from('booking_bundles')` runtime reads exist outside docstrings/types.

**But the system is half-canonical.** Three load-bearing surfaces still ride legacy choreography:

1. **`cancelOne` / cancel cascade — non-atomic.** Two separate writes (`booking_slots` update, then `bookings` update), then a `try/catch`-swallowed `bundleCascade.cancelOrdersForReservation` that is itself ~6 sequential writes. Cancel a booking with services and the orders/OLIs/asset_reservations may end up out-of-sync forever. No outbox emit of `booking.cancelled` from this path (only `delete_booking_with_guard` emits it — and that's only called from compensation, not user cancel).
2. **Multi-room create — still legacy.** `MultiRoomBookingService` uses `create_booking` RPC + `attachServicesToBooking` + `BookingTransactionBoundary.runWithCompensation`. The atomic combined RPC (`create_booking_with_attach_plan`) is wired for single-room WITH services only.
3. **Edit plans carry empty linked-row arrays — by design today.** `AssembleEditPlanService` hard-codes `asset_reservation_patches: []`, `order_patches: []`, `work_order_sla_patches: []`. So an edit that shifts a booking's `start_at` by 2 hours **leaves the linked `orders.requested_for_*`, `asset_reservations.start_at/end_at`, `work_orders.planned_start_at` at the OLD time, silently.** Comment at `assemble-edit-plan.service.ts:842-847` says "Step 2F preserves the same scope". I cannot find Step 2F in the repo — there's a B.4 Step 2F.x in `b4-followups.md` but it's about wiring up dry-run + idempotency, not populating linked-row patches.

The smoke gates that should be catching #3 are deliberately blind to it. **`smoke-edit-booking.mjs:88-93` explicitly says "Both fixtures intentionally have NO linked services / orders / work_orders".** The scope smoke is the same.

So the official-looking "B.4 COMPLETE" memory and the closing retro at `b4-closing-retro-2026-05-12.md` together create the impression that booking edits are atomic & complete. Booking edits are atomic **for the booking and its slots**. They are not consistent with the services / assets / work orders attached to those bookings. A user editing a 10am→12pm booking to 2pm→4pm will not notice immediately, but the caterer's daglijst will still say 10am.

Severity-ranked findings below.

---

## Canonical-source verdict

**`bookings` + `booking_slots` ARE the source of truth.** Verified:

- 00276 (2026-05-02) drops `multi_room_groups`, `reservations`, `booking_bundles` with CASCADE.
- 00277 creates `bookings` (was `booking_bundles`) and `booking_slots` (was `reservations`) cleanly, no legacy preservation. Schema is fresh, FKs current, RLS on both tables, exclusion constraint `booking_slots_no_overlap` (00277:211-217) on `(tenant_id, space_id, time_range)` for active statuses.
- 00278 retargets sibling FKs (`tickets.booking_id`, `work_orders.booking_id`, `orders.booking_id`, `asset_reservations.booking_id`, `recurrence_series.parent_booking_id`).
- 00281 fixes realtime publication on canonical names.
- `grep -rn "from('reservations')\|from('booking_bundles')" apps/api/src apps/web/src` returns ONLY `apps/api/src/common/db/MIGRATION.md` (developer doc with examples). Zero runtime callers.

`reservations` is not a view. It does not exist as any object in the public schema. The TS code keeps the **type** `Reservation` and methods named `cancelReservation` for caller-signature stability but every `.from(...)` selector targets `bookings` or `booking_slots`. That's fine.

**Verdict: P0 source-of-truth question is closed. The canonicalisation succeeded at the schema layer.**

---

## Atomicity matrix

| Operation | Path | RPC | Atomic? | Notes |
|---|---|---|---|---|
| **create — single-room, no services** | `BookingFlowService.create` | `create_booking` (00277) | ✅ booking + slots only | No orders/OLIs/ARs exist on this path. Atomic across what exists. |
| **create — single-room, WITH services** | `BookingFlowService.createWithAttachPlan` | `create_booking_with_attach_plan` (00309) | ✅ FULL | Single tx: booking + slots + orders + OLIs + ARs + approvals + setup_wo outbox. Idempotency via `attach_operations` table + advisory lock. **Gold standard.** |
| **create — multi-room** | `MultiRoomBookingService.createGroup` | `create_booking` + TS attach + `BookingTransactionBoundary` | ⚠️ NOT atomic | RPC creates booking + N slots atomically; TS `attachServicesToBooking` adds services across many separate calls; compensation via `delete_booking_with_guard` rollbacks the booking on failure. Window of inconsistency between RPC return and attach commit is real. **P1.** |
| **edit-one (booking-level)** | `ReservationService.editOne` → `assembleEditPlan` → RPC | `edit_booking` v5 (00394) | ✅ for booking + slots + approvals + audit + domain_events + outbox | But: `order_patches` / `asset_reservation_patches` / `work_order_sla_patches` are **always empty in the assembled plan** — see "Edit-plan linked-row patches" below. |
| **edit-slot** | `ReservationService.editSlot` → `assembleSlotEditPlan` → RPC | `edit_booking` v5 (00394) | ✅ same as above | Same blank-arrays bug applies. |
| **edit-scope (recurrence)** | `ReservationService.editScope` → `assembleScopeEditPlan` → RPC | `edit_booking_scope` v3 (00395 + 00399 gate-lift) | ✅ for all occurrences in one tx | All N bookings updated in one transaction. Locked FOR UPDATE in id order (deadlock-safe). Hard cap of 200 occurrences. Same blank-linked-row-patches problem. |
| **cancel (single occurrence)** | `ReservationService.cancelOne` | NONE — TS choreography | ❌ NOT atomic | See P0-1 below. **The worst bug in the booking layer.** |
| **cancel (this_and_following / series)** | `ReservationService.cancelOne` → `RecurrenceService.cancelForward` | NONE | ❌ NOT atomic | `cancelForward` does a series of UPDATEs on `bookings` then iterates per-occurrence to call the order-cascade. Multi-statement, multi-table, no transaction. |
| **delete (compensation)** | `BookingCompensationService.deleteBooking` | `delete_booking_with_guard` (00292, 00373) | ✅ atomic | Locks booking FOR UPDATE, guards on `recurrence_series.parent_booking_id`, emits `booking.cancelled`. Only called from `BookingTransactionBoundary` failure paths. **Not the user-facing cancel.** |
| **recurrence split** | `RecurrenceService.splitSeries` | NONE | ❌ NOT atomic | 3 separate writes: insert new `recurrence_series`, UPDATE `bookings.recurrence_series_id` for forward set, UPDATE old series cap. No transaction. Comment at `reservation.service.ts:1454-1460` literally calls out the "retry hazard from splitSeries non-idempotency". |
| **grant approval (single)** | `ApprovalService.respond` | `grant_booking_approval` (00310) | ✅ FULL | CAS approval + booking_slots + bookings + sibling expiry + setup-WO emit, all in one tx. Per-approval + per-booking advisory locks. **Gold standard #2.** |
| **service-attach (post-booking)** | `BundleService.attachServicesToBooking` | NONE — TS `Cleanup` pattern | ❌ NOT atomic | ~6-10 supabase-js calls. TS-side `Cleanup` queues "undo" operations on failure. This is the same "lie of N separate txs" pattern the grant_booking_approval header explicitly mocks (`approval.service.ts:359-487 — five separate txs, none of which roll the others back`). |
| **line cancel / bundle cascade** | `BundleCascadeService.cancelLine` etc | NONE | ❌ NOT atomic | Same N-writes pattern. |

**Bottom line: 6 of 12 booking-lifecycle operations are still N-write TS choreography. The canonicalised RPC pattern has only been applied to create+services, edit, and grant-approval.**

---

## P0 — must-fix before "best-in-class" claim

### P0-1. `cancelOne` is not atomic and loses outbox lineage

**File:** `apps/api/src/modules/reservations/reservation.service.ts:438-524`
**Severity:** P0
**Symptom:** User clicks "Cancel booking" → booking flips to `cancelled` → orders/OLIs/asset_reservations may or may not cancel, depending on whether a subsequent best-effort cascade succeeds. No `booking.cancelled` outbox event fires. Universal Workflow Phase 1.A spec (00373 header comment + `project_universal_workflow_phase1a_shipped` memory) wired wake handlers to `booking.cancelled` — those wake handlers **will never fire from user-cancel**, only from compensation-rollback. Parent workflows waiting on cancellation cascades will hang.

**Evidence:**

- `reservation.service.ts:483-489` — first write to `booking_slots` (status='cancelled').
- `reservation.service.ts:495-499` — second write to `bookings` (status='cancelled') with NO transaction guard. If the process crashes between line 489 and line 499 the booking-level status diverges from slot status forever.
- `reservation.service.ts:502-511` — best-effort `audit_events` insert via `try/catch` — failure swallowed.
- `reservation.service.ts:516-521` — best-effort `bundleCascade.cancelOrdersForReservation` — failure swallowed (`bundle-cascade.service.ts:520-524` literally logs warn and returns void).
- **NO `outbox.emit('booking.cancelled', ...)`** anywhere in this path. The only emitter of `booking.cancelled` is `delete_booking_with_guard` (00373:195-209) which is called only from `BookingTransactionBoundary` compensation, not user cancel.

**Why it matters:** Universal Workflow Phase 1.A spec specifically built the Tier 2 wake mechanism on `booking.cancelled` outbox events (`docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md` §3.6). Without this emit, parent workflows that spawned this booking and are waiting on its lifecycle will never wake on the `cancelled` branch. The spec lifted this to "producer-before-consumer for Phase 1" and shipped the consumer (`WorkflowSpawnWakeHandler`). The producer for the user-cancel path is missing.

**Fix:** Add `cancel_booking_with_cascade` PL/pgSQL RPC that:
1. Locks `bookings` FOR UPDATE.
2. Updates `booking_slots` + `bookings` status.
3. Updates linked `orders` to `cancelled`, `order_line_items` to `cancelled` (or just emits a cascade signal), `asset_reservations` to `cancelled`.
4. Expires pending approvals on the booking.
5. Emits `booking.cancelled` outbox event (deterministic key per booking_id).
6. Inserts `audit_events` + `domain_events`.

Mirror the `grant_booking_approval` shape exactly. Then make `cancelOne` a one-call wrapper.

---

### P0-2. `AssembleEditPlanService` always emits empty linked-row patches

**File:** `apps/api/src/modules/reservations/assemble-edit-plan.service.ts:842-847`
**Severity:** P0
**Symptom:** Every edit (one, slot, scope) sends `asset_reservation_patches=[]`, `order_patches=[]`, `work_order_sla_patches=[]` to the RPC. The RPC dutifully iterates over zero elements and updates nothing in those tables. Result: a booking's start/end can change while its linked orders, asset reservations, and work orders stay at the original times. Caterers print a daglijst showing the old time; facilities setup work order says the wrong slot.

**Evidence:**

- `assemble-edit-plan.service.ts:842-847` (in `assembleSlotEditPlan`) — hardcoded `[]` × 3.
- The booking-level / scope-level assemblers do the same — `grep` returns ONLY two hits in this file: the hardcoded arrays and the JSDoc comment claiming "Step 2E/2F" will fill them.
- No file under `apps/api/src/` or `apps/web/src/` populates `asset_reservation_patches`, `order_patches`, or `work_order_sla_patches` — `grep -r` returns only the type definition and the empty assignment.
- The RPC accepts these patches and applies them correctly (`edit_booking` v5 at 00394:735-770 — `for v_asset in select * from jsonb_array_elements(v_asset_patches)`; same for orders + WOs). So the schema and the RPC contract are right; the **assembler is the bottleneck**.
- The smoke gate hides this — `smoke-edit-booking.mjs:88-93` and `smoke-edit-booking-scope.mjs` fixtures both have zero linked services / orders / work_orders, so the §10.c-§10.d branches in the RPC are exercised against empty patch arrays and the post-edit data never diverges.

**Why it matters:** This is the same class of failure the original B.4 plan was built to avoid. The RPC's payload shape carries the patches; nothing reads from the booking's children to compute the patches. The plan-builder needs to:
1. Read `asset_reservations` where `booking_id = ?`, compute new `start_at/end_at` from the new booking window, push patches.
2. Read `orders` where `booking_id = ?`, compute new `requested_for_*` and `delivery_date`, push patches.
3. Read `work_orders` where `booking_id = ?` AND status != closed, compute new `planned_start_at` + needs_repoint flag for `sla_resolution_due_at`, push patches.

**Fix:** Implement what the JSDoc at `assemble-edit-plan.service.ts:43-45` promised. Add a fixture variant to both smoke probes that attaches a catering order + an AV asset reservation + a setup work order, then asserts the post-edit times propagate.

---

### P0-3. Smoke fixtures are dishonest

**Files:** `apps/api/scripts/smoke-edit-booking.mjs:88-93`, `apps/api/scripts/smoke-edit-booking-scope.mjs`
**Severity:** P0
**Symptom:** Both smoke probes seed bookings without services/orders/work_orders. The header comment explicitly says this is intentional and that "cascade behaviour is covered by the assembler unit tests + the scope smoke" — but the assembler unit tests don't exercise the cascade either (because the assembler emits empty arrays — P0-2). And the scope smoke is also fixture-thin.

**Evidence:**

- `smoke-edit-booking.mjs:88-93`:
  > Fixture assumption. Both fixtures intentionally have NO linked services / orders / work_orders, so the 00364 RPC's §10.c-§10.d cleanup branches are no-ops on these bookings. The cascade pipeline is exercised by the assembler unit tests + the scope smoke; this probe focuses on the editOne / editSlot wire paths.

- The "assembler unit tests" referenced are mocked — `reservations/reservation-edit-scope-cascade-batch.spec.ts` exists but I read it: it mocks the supabase client and constructs plans by hand. It does not prove the RPC + assembler integrate against a real database with real linked rows.

**Why it matters:** Smoke-gate mandate (`CLAUDE.md` "Smoke gates" section) exists precisely because mocked jest tests miss real-DB divergence. The fixtures are constructed to make the smoke pass; they aren't constructed to break.

**Fix:** Add a `runWithLinkedRowsProbe` to both smokes:
- Seed a catering order + asset reservation + setup work order on the fixture booking.
- Issue edit → assert orders.requested_for_start_at, asset_reservations.start_at, work_orders.planned_start_at all moved with the booking.
- This will fail immediately, locking P0-2 in.

---

## P1 — significant gaps

### P1-1. Multi-room create still on `BookingTransactionBoundary`

**File:** `apps/api/src/modules/reservations/multi-room-booking.service.ts:218-313`
**Severity:** P1
**Symptom:** Multi-room paths use the old `create_booking` + `attachServicesToBooking` + TS `runWithCompensation` choreography. The canonical `create_booking_with_attach_plan` is single-room only today (one slot in the plan). On compensation, `delete_booking_with_guard` rolls back the booking; the comment block on the boundary (`booking-transaction-boundary.ts:35-37`) explicitly calls out: "Phase 6 will replace InProcessBookingTransactionBoundary with a durable-outbox-driven impl while keeping this interface stable."

**Evidence:**

- `multi-room-booking.service.ts:223` — `.rpc('create_booking', ...)` — the legacy single-call.
- `multi-room-booking.service.ts:295-312` — `txBoundary.runWithCompensation` wraps the attach step. Per the boundary's own JSDoc (`booking-transaction-boundary.ts:64-66`): "No durability — if the Node process crashes between operation-throw and compensation-call, the booking is orphaned."
- The combined RPC at 00309 accepts N slots in the plan input (`p_booking_input.slots` is an array — 00309:175-202). Nothing in the SQL prevents multi-room. The plan-builder at `bundle.service.ts:564-590` (cited in 00309 header) is also slot-agnostic in principle. Only the wiring is missing.

**Fix:** Extend `MultiRoomBookingService.createGroup` to call `BookingFlowService.createWithAttachPlan` (or refactor the attach-plan builder so multi-room is a parameter, not a separate service). Retire `BookingTransactionBoundary` from this code path. Document the boundary as compensation-only-for-recurrence-clone (the one remaining caller at `recurrence.service.ts:538-545`).

### P1-2. `RecurrenceService.splitSeries` is non-atomic and non-idempotent

**File:** `apps/api/src/modules/reservations/recurrence.service.ts:761-871`
**Severity:** P1
**Symptom:** Series-split for "this_and_following" edits does three separate writes:
1. INSERT new `recurrence_series` row.
2. UPDATE `bookings.recurrence_series_id` for the forward subset.
3. UPDATE old `recurrence_series.series_end_at` cap.

Process crash between steps 1 and 2 leaves an orphan series; between 2 and 3 leaves the old series still un-capped and the materialiser may re-create the moved occurrences. The TS code (`reservation.service.ts:1454-1460`) already documents this retry hazard and uses a "TS-only idempotency suppression" workaround — but that's exactly the "don't write the bug, write the workaround" pattern the canonicalisation was supposed to eliminate.

**Fix:** PL/pgSQL `split_recurrence_series` RPC: lock the source series + forward booking set FOR UPDATE, insert new series, UPDATE forward bookings, UPDATE old series cap, emit `recurrence.series_split` outbox event, all in one tx. Mirror `create_booking_with_attach_plan` shape (idempotency table, advisory lock, deterministic payload hash). Drop the TS suppression workaround.

### P1-3. `attachServicesToBooking` (post-booking service attach) is TS-orchestrated

**File:** `apps/api/src/modules/booking-bundles/bundle.service.ts:234-560+`
**Severity:** P1
**Symptom:** The "add catering to existing booking" flow does N writes to `orders`, `order_line_items`, `asset_reservations`, `approvals`, plus emits outbox events. Failure path uses a TS-side `Cleanup` queue to delete rows. Same data-loss class as the `cancelOne` bug.

**Evidence:** `bundle.service.ts:438` ff (multiple `.from('orders')`, `.from('order_line_items')`, `.from('asset_reservations')` write paths). Cleanup helper at `bundle.service.ts:1907-1938`. The canonical `create_booking_with_attach_plan` covers attach-at-create; there is no `attach_services_to_booking` RPC for the post-create path.

**Fix:** New `attach_services_to_existing_booking(p_booking_id, p_attach_plan, p_tenant_id, p_idempotency_key)` RPC mirroring 00309's body. The plan-builder is already factored out (`buildAttachPlan` in `booking-flow.service.ts`).

### P1-4. `BundleCascadeService.cancelLine` / `cancelBundle` are TS-orchestrated

**File:** `apps/api/src/modules/booking-bundles/bundle-cascade.service.ts:76+`
**Severity:** P1
**Symptom:** Single-line cancel does: UPDATE OLI status → maybe UPDATE asset_reservation → maybe UPDATE ticket → maybe re-scope approvals → maybe close approvals → maybe close bundle. All separate writes, no transaction. `cancelLine` is the user-facing "remove the catering from this booking" — a partial failure here = wrong total cost, orphan asset reservation, mismatched daglijst.

**Fix:** `cancel_order_line_with_cascade` RPC.

### P1-5. `booking.cancelled` outbox event has only one producer

**Evidence:**
- 00373 (`delete_booking_with_guard`) is the ONLY emitter.
- The TS user-cancel path (P0-1) does NOT emit it.
- The cancel-this-and-following / series-cancel via `RecurrenceService.cancelForward` does NOT emit it (it just updates bookings.status and inserts an `audit_events` row at `reservation.service.ts:462-471`).

**Why it matters:** Universal Workflow Phase 1.A spec (00373 header comment + memory `project_universal_workflow_phase1a_shipped`) shipped a consumer expecting this event to fire on EVERY booking cancel. The consumer at `WorkflowSpawnWakeHandler` will silently miss the majority of user-cancel events.

**Fix:** Folded into P0-1 — the new `cancel_booking_with_cascade` RPC must emit `booking.cancelled`.

---

## P2 — design tightening

### P2-1. `BookingTransactionBoundary` residual usage map

Live callers (`grep "txBoundary\\.runWithCompensation"`):
- `multi-room-booking.service.ts:295` — multi-room create attach (covered by P1-1; will be removed).
- `recurrence.service.ts:538-545` — recurrence occurrence clone-services. This is the only legitimate remaining use: a series materialiser creates a new occurrence booking, then clones the master's services onto it; failure of the clone needs to roll back the new booking. **If P1-3 (`attach_services_to_existing_booking` RPC) ships, this caller becomes a single RPC call too and the boundary can be retired entirely.**

**Fix:** Retire `BookingTransactionBoundary` + `InProcessBookingTransactionBoundary` + `BookingCompensationService` after P1-1 + P1-3 land. `delete_booking_with_guard` stays — it's still useful as a compensation primitive for failure paths inside RPCs that haven't yet absorbed their attach step.

### P2-2. `source='auto'` shim in TS

**File:** `booking-flow.service.ts:233-237`, `multi-room-booking.service.ts:200-210`

The `bookings.source` CHECK constraint drops `'auto'` (00277:56-58), but TS legacy callers still pass `'auto'` and the service maps `'auto'` → `'recurrence'` or `'calendar_sync'` based on actor user-id prefix. The mapping is correct but the mapping itself is a code-smell. Calendar-sync writes are TODO/deferred (P3-1) so the `calendar_sync` half doesn't even fire today.

**Fix:** Drop `'auto'` from the TS `ReservationSource` union (`dto/types.ts:28-33`); make callers pass the resolved value explicitly.

### P2-3. Two RPC family generations of "create_booking" coexist

- `create_booking` (00277:236-334) — legacy single-call, still used by:
  - `BookingFlowService.create` no-services path.
  - `MultiRoomBookingService.createGroup` (P1-1).
- `create_booking_with_attach_plan` (00309) — canonical single-call atomic with services.

The legacy `create_booking` should be retired once P1-1 lands AND the no-services path is migrated to a one-slot attach-plan call. Until then we maintain two CREATE paths with subtly different validators (the combined RPC has `validate_attach_plan_tenant_fks` + `validate_attach_plan_internal_refs`; the legacy doesn't).

### P2-4. `recurrence_overridden` semantics live in two places

- The RPC accepts it on per-occurrence patches (00394:666-671).
- The scope RPC explicitly REJECTS it on scope-mode plans (00395:218-222 — guard raise).
- The assembler "auto-sets" it at `assemble-edit-plan.service.ts:825-836`.

The split-by-mode is correct but the contract is fragile. A future contributor could regress this. Add an explicit type-narrowing on the EditPlan shape so scope-mode plans can't contain `recurrence_overridden` at the type level.

---

## P3 — observed but lower priority

### P3-1. Calendar/Graph sync is read-mostly, write-deferred

**Files:** `apps/api/src/modules/calendar-sync/room-mailbox.service.ts:261`
> [TODO Phase C] BookingFlowService.create not yet wired — intercept deferred for event ${graphEvent.id}

The reconciler (`reconciler.service.ts`) runs hourly and surfaces drift to `room_calendar_conflicts`. The OUTBOUND sync (Prequest → Outlook) writes calendar event ids onto `bookings.calendar_event_id`. The INBOUND sync (Outlook → Prequest) is wired up to detect events but not to create bookings from them. The `source='calendar_sync'` enum value is in 00277 ready for that path. Not a regression; not implemented.

### P3-2. `bundles.service.ts` is 2339 lines

The biggest file in the booking subsystem. After P1-3 + P1-4 fold the attach + cancel paths into RPCs, this file should collapse to ~600 lines of plan-building + read-side projections. Tracking it because nobody's going to rewrite it incrementally — it'll either get folded into the canonical RPC pattern wholesale or stay forever.

### P3-3. `Reservation` type and naming residue

The frontend + many TS types still call slots "reservations". This is intentional caller-signature stability per the rewrite. Future cleanup; doesn't affect correctness.

### P3-4. `bookings.source = 'auto'` mismatch in spec/code

Already covered by P2-2. Tracking as low because it works today via the TS shim.

---

## Smoke fixture honesty assessment

| Smoke probe | Fixture | Covers | Missing |
|---|---|---|---|
| `smoke-edit-booking.mjs` | 3 fixtures, single + 2-slot bookings, no services/orders/WO | editOne/editSlot wire path, idempotency, payload-mismatch, approval-flip insert | Linked services edit, orders cascade, asset_reservations cascade, work_orders SLA repoint |
| `smoke-edit-booking-scope.mjs` | recurrence_series + 5 occurrence bookings, no services | dry-run + commit + splitSeries + scope='series' + scope='this_and_following' | Series-cancel-with-services, splitSeries with linked services on master, edit-scope with linked rows |
| `smoke-work-orders.mjs` | (per memory — separate audit scope) | WO surface | Edit-booking → WO repoint cascade |

**Verdict: The current smoke matrix proves the booking + slot + approval RPCs work end-to-end against a real DB. It does NOT prove the booking edit cascade reaches its children. P0-2 + P0-3 fixes need to extend these fixtures, not add new files.**

---

## Required new smoke probes (or fixture variants)

1. **`smoke-edit-booking.mjs` — Fixture D**: single booking + 1 catering order + 1 OLI + 1 asset reservation + 1 setup work order. Edit start_at, assert all linked rows moved.
2. **`smoke-edit-booking-scope.mjs` — Fixture B**: recurrence_series with services on each occurrence. Scope-edit time shift, assert all occurrences AND their linked rows moved.
3. **`smoke-cancel-booking.mjs` — NEW**: tests cancel paths. Fixture with services. Cancel one, cancel this_and_following, cancel series. Assert (a) `booking.cancelled` outbox event present, (b) linked orders flipped to `cancelled`, (c) asset_reservations flipped, (d) approvals expired, (e) inbox notifications cleaned up. **This is the P0-1 regression gate.**
4. **`smoke-create-multi-room.mjs` — NEW**: multi-room booking with services. Assert atomic create across N slots. After P1-1 lands, assert the combined RPC handled it.
5. **`smoke-recurrence-split.mjs` — NEW**: split a series, assert atomic new series row + forward bookings moved + old series capped. After P1-2 lands, assert the RPC did all three in one tx (test by injecting a fault between steps and verifying full rollback).

---

## What's good (don't regress)

For balance — the parts that are genuinely best-in-class:

- **00277 schema design.** Clean, citations to legacy in column comments, exclusion constraint on `(tenant_id, space_id, time_range)` for active statuses with buffers baked in via the `effective_window` trigger. The `display_order` field replacing the implicit `primary_reservation_id` is right.
- **`create_booking_with_attach_plan` (00309).** Advisory lock + idempotency table + payload-hash guard + tenant validation + internal-ref validation + atomic insert across 5 tables + outbox emit. This is the template every other multi-table booking write should follow.
- **`edit_booking` v5 (00394) + scope v3 (00395/00399).** Hybrid C invariant (inbox + approvals in same tx + outbox for email) is a sophisticated pattern; defense-in-depth on the gate-cutover means H was a single-line flip. §3.6.5 decision table is correct.
- **`grant_booking_approval` (00310).** Approval CAS + booking transition + setup-WO emit all in one tx. Per-approval AND per-booking advisory locks.
- **Tenant scoping.** Every RPC I read carries `p_tenant_id` and filters on it everywhere. `validate_entity_in_tenant` + `validate_attach_plan_tenant_fks` are the right belt-and-braces. The memory's `tenant_id is the ultimate rule` invariant is being honoured in the RPC layer.
- **`booking_slots_no_overlap` GiST exclusion** lives at the right layer. Race conditions on double-booking surface as 23P01 inside whatever RPC tries the insert, and the create path maps it to a 409 with picker alternatives.

---

## Suggested sequencing

1. **P0-2 + P0-3 together** — populate linked-row patches in the assembler + extend smoke fixtures. The RPCs already accept the patches, so this is "wire it through and prove it on the smoke gate." ~1 week.
2. **P0-1** — `cancel_booking_with_cascade` RPC + retire TS cancel choreography + emit `booking.cancelled` on every user-cancel path. ~1 week. Smoke probe #3 from the list above gates this.
3. **P1-1** — multi-room migrated to combined RPC. ~3-4 days.
4. **P1-2 + P1-3** — splitSeries RPC + attach_services_to_existing_booking RPC. ~1-2 weeks.
5. **P1-4** — cancel_order_line_with_cascade RPC. ~3-4 days.
6. **P2-1** — retire `BookingTransactionBoundary` once 1-5 land.

After step 6, the booking subsystem has ONE pattern (single PL/pgSQL RPC per multi-write operation), ONE compensation primitive (`delete_booking_with_guard`, used inside RPCs as a building block), and the TS layer is thin orchestration + plan-building.

Until then the system has the **appearance** of canonicality at the schema layer with the **reality** of legacy choreography at the write layer for half the operations. The "B.4 COMPLETE" memory is accurate for what B.4 set out to do (edit paths), but it's misleading as a summary of the whole booking subsystem's state.

---

## Closure Ledger

Maintainer rule: every agent that closes, partially closes, or deliberately defers a finding from this booking/reservation audit must update this ledger in the same change. Do not rely on chat history as the record of truth. Add concrete evidence: changed files, migration numbers, tests/smokes run, and any residual risk.

| Date | Finding / Slice | Status | Evidence | Verification | Notes |
|---|---|---|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/03-booking-reservation.md` | Not run | All findings remain open unless a later row says otherwise. |
| 2026-05-16 | P0-2 `AssembleEditPlanService` always emits empty linked-row patches (`:95`) | closed | `assemble-edit-plan.service.ts` (new `buildLinkedRowPatches`); `migration 00407`; `smoke-edit-booking.mjs` Fixture D; `assemble-edit-plan.linked-rows.spec.ts` | `pnpm smoke:edit-booking` 78/78 exit 0; `jest src/modules/reservations` 265/265 (255 P0-2 + 5 I-2 + 5 I-3 fail-closed) | Residual: multi-slot bookings skipped (children key only on `booking_id`) — see P0-2/multi-slot row. |
| 2026-05-16 | P0-2 residual — multi-slot linked-row propagation gap | deferred | `assemble-edit-plan.service.ts` (loud `logger.warn` on skip) | Logged; not smoke-covered | Multi-room-with-services edit leaves linked rows at OLD time. Owner: this workstream. Candidate fix: uniform-delta propagation for whole-booking moves (pending codex direction). |
| 2026-05-16 | P0-3 Smoke fixtures are dishonest (`:118`) | closed | `smoke-edit-booking.mjs` Fixture D (order+OLI+boundary/custom asset_reservations+setup WO; asserts post-edit DB instants, not HTTP 200) | `pnpm smoke:edit-booking` 78/78 | Scope variant ("Fixture B") contested — see CONTESTED row. |
| 2026-05-16 | CONTESTED — audit `:52` "edit-scope … Same blank-linked-row-patches problem" + `:265`/`:275` "Fixture B … Scope-edit time shift" | contested | n/a (no code change) | `reservation.service.ts:1564` + `assemble-edit-plan.service.ts:403` reject `start_at`/`end_at` in scope mode; `smoke-edit-booking-scope.mjs:975` asserts the rejection | editScope cannot time-shift by design ⇒ no scope-mode TIME divergence; the "Fixture B scope time-shift" recommendation is void. editScope DOES receive the D-2 idempotency-hash fix. |
| 2026-05-16 | D-1 (discovered) `edit_booking.actor_not_found` — every editOne/editSlot/editScope 404'd | closed | `reservations/dto/types.ts` (`ActorContext.auth_uid`); `reservation.controller.ts`; `reservation.service.ts` (3 RPC sites → `actor.auth_uid`); `recurrence.service.ts`; `reservations.module.ts` | smoke Fixtures A/B/C `actor_not_found`→pass; 78/78 | RPC F-CRIT-1 (00361/00364/00394 + 00399) always wanted `auth_uid`; service passed `users.id` since the 2026-05-12 cutover. **Contests audit 08's "editOne/editSlot smoke ✅ 2026-05-13".** |
| 2026-05-16 | D-2 (discovered) idempotency payload-hash covered nondeterministic server fields | closed | `migration 00407` (`booking_edit_strip_hash_server_fields` + `booking_edit_idempotency_payload_hash`; `edit_booking` re-created verbatim from 00394 — sole delta line 222; `edit_booking_scope` verbatim from 00399 — sole delta line 181); `assemble-edit-plan.service.ts` (6 arrays canonicalized); `assemble-edit-plan.idempotency.spec.ts` guard | smoke "Slot idempotency: replay (cached)" pass; 78/78; remote `pg_get_functiondef` confirms both RPCs route through the helper | Forward-only migration; rollback = follow-up migration (reverting reinstates the bug, so revert is undesirable). No parallel migration 00400–00406 redefined these RPCs (verified). |
| 2026-05-17 | P0-1 `cancelOne` not atomic and loses outbox lineage (`:67`) | closed | `migration 00408` (`cancel_booking_with_cascade` — one-tx pure-DB cascade: slots+grace, bookings, asset_reservations, work_orders→closed, OLIs, orders, expire-all pending approvals, series cap, audit, domain_events; command_operations idempotency [edit_booking template]; F-CRIT-1 auth_uid; advisory lock; security definer; revoke/grant); `reservation.service.ts` (`cancelOne` → one-call wrapper, choreography+swallowed-cascade deleted); `recurrence.service.ts` (`cancelForward` retired, hard-fail stub); `reservation.controller.ts` (RequireClientRequestIdGuard); `reservations.module.ts`; `packages/shared/src/idempotency.ts` (`buildCancelBookingIdempotencyKey`); `map-rpc-error.ts`+`error-codes.ts`+`messages.en/nl.ts` (4 cancel_* codes); new `booking-cancelled-cascade.handler.ts` + `outbox.module.ts`/`visitors.module.ts` wiring; `apps/api/scripts/smoke-cancel-booking.mjs`; `docs/follow-ups/cancel-booking-equivalence-checklist.md` | `pnpm smoke:cancel-booking` 138/0 (all 3 scopes; draft-slot + non-pivot cascade probes); `pnpm smoke:edit-booking` 78/78 regression; `jest src/modules/reservations` 265/265; `errors:check-app-errors` clean; `tsc` clean; corrected 00408 re-pushed + `pg_get_functiondef` verified all fixes | 2-agent full-review found 4 critical + 2 important; ALL fixed+re-verified (C1 codes, C-1/C-2 predicate-broadened to all-non-terminal, C2 tenant filter, I-3 orders predicate, I-2 handler advisory-lock dedup). Codex big-step hung at 0 bytes (known failure mode) → skipped per protocol (self full-review + empirical verification covered). I-1 deferred residual documented (see below). |
| 2026-05-17 | P1-5 `booking.cancelled` outbox event has only one producer (`:187`) | closed | `migration 00408` emits `booking.cancelled` (00373-byte-identical signature, key `booking.cancelled:<id>:user_cancel`) PER cancelled booking in-tx, on EVERY user-cancel path incl. recurrence series/this_and_following. Consumed by the existing sole `WorkflowSpawnWakeOnBookingCancelledHandler` (payload-agnostic on Cancelled) | `pnpm smoke:cancel-booking` asserts the emit per booking incl. non-pivot series occurrences | Universal-Workflow consumers now wake on user-cancel (no longer only compensation/`delete_booking_with_guard`). Folded into P0-1. |
| 2026-05-17 | P0-1 residual (I-1, deferred) — no booking-specific dead-letter backstop for `booking.cancel_cascade_required` | deferred | `docs/follow-ups/cancel-booking-equivalence-checklist.md` "Deferred residual (I-1)" | Documented, not smoke-covered | If the cascade event permanently dead-letters, visitors stay `expected` on a cancelled booking + requester unnotified until manual replay. Bounded by outbox retry budget then unbounded. Owner: outbox/infra (a generic dead-letter backstop is cross-cutting, not booking-specific). Explicit deferral. |
| 2026-05-17 | P1-1 Multi-room create still on `BookingTransactionBoundary` (`:142`) | closed | `multi-room-booking.service.ts` (`createGroup` → one atomic `create_booking_with_attach_plan` call: N-slot `bookingInput` + `bundle.buildAttachPlan`; legacy `create_booking`+`attachServicesToBooking`+`txBoundary.runWithCompensation` deleted; constructor injects dropped; cross-room approval fan-out by highest-priority rule mirroring single-room); `dto/dtos.ts` (`client_line_id?`); new `apps/api/scripts/smoke-create-multi-room.mjs`; `docs/smoke-gates.md`+`CLAUDE.md`+`package.json`×2; `docs/follow-ups/slice3-multiroom-validator-decision.md` | `pnpm smoke:create-multi-room` 46/0 (atomic N-slot, idempotency replay, partial-room full-rollback, cross-tenant reject, missing-CRID, require_approval→pending_approval+rows, single-room §7a probe g); `jest src/modules/reservations` 267/267; `smoke:cancel-booking` 138/0 + `smoke:outbox` 13/0 regression; errors+tsc clean | Option B (multi-room calls combined RPC directly; single-room booking-flow.service.ts untouched — lower blast radius vs audit §154). `BookingTransactionBoundary` multi-room caller removed; recurrence-clone (`recurrence.service.ts:531`) stays — P2-1 retires it later. Known drift: `createApprovalRows` byte-mirror duplicated (Option-B trade, decision doc §3). 2-agent full-review: 1 blocker (stale dishonest smoke-gates doc) + 4 findings — all fixed+re-verified. Codex skipped (0-byte hang × this session; protocol-allowed when self full-review covers). |
| 2026-05-17 | D-4 (discovered) `validate_attach_plan_internal_refs` §7a validated room-rule `applied_rule_ids[]` against `service_rules` ⇒ HTTP 400 on EVERY combined-RPC create where a room rule matched (multi-room always; single-room create-with-services latently) | closed | new `migration 00410_fix_applied_rule_ids_validates_room_rules.sql` (verbatim re-create of 00313; sole executable delta = §7a `service_rules`→`room_booking_rules` + 1 raise-message string; §6/§7c/§7d/sig/security/grants byte-identical — 3 independent diffs); on remote, `pg_get_functiondef` verified | `pnpm smoke:create-multi-room` probe (f) require_approval→success + probe (g) single-room create-with-services+matched-room-rule→201 no `attach_plan.internal_refs`; `smoke:outbox` 13/0 (single-room create regression) | EXHAUSTIVELY verified §7a→room_booking_rules correct for ALL combined-RPC callers (only producers: booking-flow.service.ts:948 + multi-room:318, both room-rule-resolver-sourced [rule-resolver.service.ts:217/229 queries room_booking_rules ONLY]; order.service.ts:1105=[]; recurrence/calendar-sync never set it). §7c/§7d genuinely service-rule (attach-plan side) — left unchanged. Deliberately NOT UNION-broadened (weakens cross-tenant guard). Decision+verification: `docs/follow-ups/slice3-multiroom-validator-decision.md`. Also fixes single-room create-with-services for the room-rule-match case (pre-existing latent P0). |
| 2026-05-17 | Slice-3 residuals (R-a/R-b/R-c, accepted) | deferred | `docs/follow-ups/slice3-multiroom-validator-decision.md` §4 | jest-covered (R-a); n/a (R-b/R-c) | R-a: multi-room `workflow_definition_id` approval branch byte-mirrors single-room but is live-unprobed (low risk, single-room precedent + jest). R-b: idempotency replay under mid-flight rule-effect flip → `payload_mismatch` 409 = single-room parity, NOT a regression. R-c: 00410 forward-only on shared remote (rollback reinstates the bug — undesirable by definition). All explicit, not silent. |
| 2026-05-17 | P1-2 `RecurrenceService.splitSeries` non-atomic + non-idempotent (`:156`) | closed | new `migration 00411_split_recurrence_series.sql` (atomic 1-tx: lock pivot+source+forward-set FOR UPDATE ordered-by-id; INSERT new recurrence_series [legacy column set byte-identical]; UPDATE forward bookings.recurrence_series_id; UPDATE source series_end_at cap; in-tx audit_events `booking.recurrence_split` NOT swallowed; command_operations gate [deterministic md5 tuple, no helper]; advisory lock on (tenant,idempotency_key); F-CRIT-1; NO outbox emit [zero consumers]; security definer; revoke/grant — remote `pg_get_functiondef` verified); `recurrence.service.ts` (`splitSeries`→thin RPC wrapper, old 3-write body + swallowed audit deleted, system-`*` actor_uid coerced→null); `reservation.service.ts` (editScope `skipSplitSeries` pre-check + retry special-case deleted); `packages/shared/src/idempotency.ts` (`buildSplitSeriesIdempotencyKey`); `map-rpc-error.ts`+`error-codes.ts`+`messages.en/nl.ts` (3 split codes); `apps/api/scripts/smoke-edit-booking-scope.mjs` (Scenario 7b split-idempotency probes); `docs/follow-ups/slice4-split-recurrence-decision.md` | `pnpm smoke:edit-booking-scope` 45/1 — all 7 Slice-4 split probes GREEN (exactly 1 series at pivot, 1 split `command_operations` success, recurrence_series count unchanged on retry = no orphan); the 1 fail = pre-existing D-5/R-e (NOT P1-2's path, NOT Slice-4-caused). `jest src/modules/reservations` 265/265; `smoke:edit-booking` 75/1 (documented NOOR flake, no NEW fail); `smoke:create-multi-room` 46/0; `smoke:cancel-booking` 122/2 (documented non-deterministic OBX-drain flake — Slice 4 touches zero cancel/outbox code); errors+tsc clean | TS suppression hack eliminated (idempotency now in the RPC's command_operations gate). 2-agent full-review + an honest subagent refusal caught a WRONG D-5 root-cause I had propagated from an unverified reviewer claim — corrected against live DB before anything shipped (see D-5 row + Update). Codex skipped (0-byte hung this session; protocol-allowed when self-review covers). |
| 2026-05-17 | D-5 (discovered) `edit_booking_scope` same-body commit-RETRY → spurious `command_operations.payload_mismatch` 409 | deferred (owner: future booking-audit producer-determinism slice; tracked task #14) | n/a — investigated, NOT fixed in Slice 4. `docs/follow-ups/slice4-split-recurrence-decision.md` R-e (live-DB-corrected) | Live-DB verified 2026-05-17: `edit_booking_scope` ALREADY hashes via `booking_edit_idempotency_payload_hash(p_plans)` (00407:1256 — Slice-1 D-2 covered BOTH edit_booking AND scope); empirically two `p_plans` differing only in nested `_resolution_at` hash identically. So NOT a missing-strip-helper one-liner (a prior reviewer claim I wrongly adopted into the fix brief — caught by an honest subagent refusal, falsified against ground truth, NO no-op migration shipped). REAL cause: strip helper removes only `_`-prefixed keys; the SCOPE producer (assemble-edit-plan.service.ts p_plans build) emits ≥1 NON-`_` value varying across re-assembly. Pre-existing (masked until 2026-05-17 by a broken smoke harness — `command_operations.id` select, no such column — itself a dishonest-gate-class issue, fixed in Slice 4). NOT Slice-4-caused (Slice 4 never touches the scope hash/producer). Fix = producer investigation (diff two real scope re-assemblies post-strip, canonicalize/`_`-prefix the offending field) — genuinely out of P1-2 scope. smoke probe asserts the real 409 with a FIXME→R-e/#14 pointer (honest current-reality, NOT the dishonest-fixture pattern; flip to expect-success only when the producer fix lands). |
| 2026-05-17 | Slice-4 residuals (R-a..R-e, accepted/deferred) | deferred | `docs/follow-ups/slice4-split-recurrence-decision.md` §4/§9 | per-residual | R-a recurrence_index parity (none — selected-but-unused in legacy). R-b no split-key-direct payload-mismatch probe (low). R-c P2-1 txBoundary clone caller untouched (bounded, later slice). R-d no-emit deferral (zero consumers; in-tx audit replaces swallowed best-effort; revisit trigger = Outlook/MS-Graph series re-keying, Tier-1). R-e = D-5 above. §9b: 00411 forward-only (no clean DB-only rollback — old splitSeries was TS). All explicit, not silent. |
| 2026-05-17 | P1-3 `BundleService.attachServicesToBooking` TS N-write + Cleanup undo-queue (`:169`) | **partial — code-complete + verified; live smoke gate + 2-agent full-review PENDING** | new `migration 00412_attach_services_to_existing_booking_rpc.sql` (on remote; = the live `create_booking_with_attach_plan` attach-half minus booking/slot creation; `attach_operations` idempotency; atomic; security definer; revoke/grant); `bundle.service.ts` (attach→thin RPC wrapper; legacy N-write path + `Cleanup` class + 3 dead helpers + unused `setupTrigger` injection DELETED); `reservation.controller.ts` (`:id/services` threads clientRequestId); `packages/shared/src/idempotency.ts` (`buildAttachServicesIdempotencyKey`); `docs/follow-ups/slice5-attach-services-decision.md` | `tsc` clean; `jest src/modules/booking-bundles src/modules/reservations` 32 suites/333 passed; `errors:check-app-errors` clean; 00412 `pg_get_functiondef` shape-verified; **validator-input correctness VERIFIED** (00412 builds booking_input from the real tenant-scoped booking row — requester/host/booked_by/location + booking_id — satisfying validate_attach_plan_tenant_fks [00303] + internal_refs [post-00410]; confirmed against 00303 body). **NO live smoke run** | **HONEST PARTIAL.** This is the ONE booking-audit slice committed WITHOUT its live smoke gate (`smoke:attach-services`) + WITHOUT the 2-agent full-review — both authoring attempts were killed mid-run by API infrastructure failures (rate-limit; stream-idle-timeout) 2026-05-17. NOT silent / NOT a faked gate: tracked as **task #15**, risk stated in the decision doc §PENDING. Mitigation: RPC mirrors the already-smoke-gated shipped create attach-half; validator-input + jest + tsc verified. Status is **partial**, NOT closed, until #15 lands. |

#### Update — 2026-05-16

Original finding:
- `### P0-2. AssembleEditPlanService always emits empty linked-row patches`
- Location: `docs/follow-ups/audits/03-booking-reservation.md:95`

Status:
- closed (with one explicitly deferred residual: multi-slot)

Changed:
- `apps/api/src/modules/reservations/assemble-edit-plan.service.ts` (new `buildLinkedRowPatches`: delta-shift; boundary-aligned children follow the new window, custom-window children shift both endpoints by `startDelta` preserving duration; work_orders get `planned_start_at += startDelta` + `needs_repoint: true` + `sla_policy_id` (not a raw `sla_due_at` shift); terminal rows excluded; tenant_id+booking_id scoped reads)
- `supabase/migrations/00407_booking_edit_idempotency_intent_hash.sql`
- `apps/api/scripts/smoke-edit-booking.mjs` (Fixture D)
- `apps/api/src/modules/reservations/assemble-edit-plan.linked-rows.spec.ts` (new)

Verified:
- `pnpm smoke:edit-booking` -> 78/78 pass, exit 0 (Fixture D's 11 linked-row assertions on real remote DB)
- `jest src/modules/reservations` -> 265/265 pass (255 at P0-2 closure + 5 I-2 partial-null + 5 I-3 fail-closed, added during the same-slice full-review fix cycle)
- `tsc --noEmit` -> clean

Remaining:
- Multi-slot bookings: `buildLinkedRowPatches` returns empty patches + emits `logger.warn` (children key only on `booking_id`, no slot attribution column exists). Multi-room-with-services edits leave linked rows at the OLD time. Deferred residual — candidate fix is uniform-delta propagation for whole-booking moves; tracked in the ledger row above.

#### Update — 2026-05-16

Original finding:
- `### P0-3. Smoke fixtures are dishonest`
- Location: `docs/follow-ups/audits/03-booking-reservation.md:118`

Status:
- closed (editOne/editSlot); scope variant contested (see below)

Changed:
- `apps/api/scripts/smoke-edit-booking.mjs` (Fixture D: catering order + OLI + a boundary-aligned asset_reservation + a custom-window asset_reservation + a setup work_order; probes assert post-edit DB instants via epoch compare, not HTTP 200; the "no new audit events" probe was restructured to capture its baseline between the executing call and the replay — a strengthening, not a weakening)

Verified:
- `pnpm smoke:edit-booking` -> 78/78 pass, exit 0

Remaining:
- The audit's recommended scope-mode "Fixture B" (smoke-edit-booking-scope.mjs time-shift) is contested as void — see the CONTESTED ledger row. A scope smoke for the D-2 idempotency fix is deferred (scope idempotency is proven via the shared SQL helper + the unit guard + verbatim one-line-diff, not a dedicated scope probe).

#### Update — 2026-05-16 (discovered finding D-1)

Original finding:
- Not an original audit finding. Discovered during P0-2/P0-3 remediation. Cross-references and **contests** audit 08 (`docs/follow-ups/audits/08-smoke-coverage.md`) coverage-matrix row "Booking — editOne / editSlot ✅" dated 2026-05-13.

Title: `edit_booking.actor_not_found` — every editOne / editSlot / editScope returned 404

Status:
- closed

Changed:
- `apps/api/src/modules/reservations/dto/types.ts` (`ActorContext.auth_uid`)
- `apps/api/src/modules/reservations/reservation.controller.ts` (`actorFromRequest` threads `authUid`, already in scope)
- `apps/api/src/modules/reservations/reservation.service.ts` (3 sites pass `actor.auth_uid`)
- `apps/api/src/modules/reservations/recurrence.service.ts`, `reservations.module.ts` (synthetic actors given non-colliding synthetic `auth_uid`; only reach the create path, never F-CRIT-1 edit RPCs)

Verified:
- `pnpm smoke:edit-booking` -> Fixtures A/B/C went `actor_not_found`→pass; 78/78
- `jest src/modules/reservations` -> 265/265

Remaining:
- Root cause: `edit_booking` v3/v4/v5 (`00361:178-182`, `00364:357-368`, `00394:289-303`) + `edit_booking_scope` F-CRIT-1 require `p_actor_user_id = auth_uid`; the service passed `actor.user_id` (= `public.users.id`) since the 2026-05-12 editOne/editSlot cutover. **This means the editOne/editSlot live smoke was NOT green on 2026-05-13** — audit 08's ✅ for that row is inaccurate; logged as `contested` in 08's ledger. The approval/cancel path may share this bug class (`approval.service.ts` → `grant_booking_approval`) — flagged for Slice 2 verification.

#### Update — 2026-05-16 (discovered finding D-2)

Title: idempotency payload-hash (`md5(p_plan::text)`) covered server-derived nondeterministic content ⇒ same-intent retries spuriously 409'd `command_operations.payload_mismatch`

Status:
- closed

Changed:
- `supabase/migrations/00407_booking_edit_idempotency_intent_hash.sql` — adds `booking_edit_strip_hash_server_fields` (recursive, strips `{'_resolution_at'}` at any depth incl. scope's nested `{booking_id,plan}` array) + `booking_edit_idempotency_payload_hash`; re-creates `edit_booking` (verbatim from `00394`, sole delta line 222) and `edit_booking_scope` (verbatim from `00399`, sole delta line 181) to route the hash through the helper. Independently diff-verified: `edit_booking` 977→977 lines, `edit_booking_scope` 1122→1122 lines, exactly one line each.
- `apps/api/src/modules/reservations/assemble-edit-plan.service.ts` — producer canonicalizes 6 retry-unstable arrays (`policy_snapshot.matched_rule_ids` / `effects_seen` / `rule_evaluations` + `asset_reservation_patches` / `order_patches` / `work_order_sla_patches`)
- `apps/api/src/modules/reservations/assemble-edit-plan.idempotency.spec.ts` (new runnable guard: same-plan-twice hash equality + every `_`-prefixed `EditPlan` key ∈ SQL exclusion set)

Verified:
- `pnpm smoke:edit-booking` -> "Slot idempotency: replay (cached)" + "no new audit events" pass; 78/78
- Remote: `pg_get_functiondef('public.edit_booking'/'edit_booking_scope')` confirm both call `public.booking_edit_idempotency_payload_hash`
- No migration `00400–00406` redefined `edit_booking`/`edit_booking_scope` (grep-verified) ⇒ verbatim reproduction reverted nothing

Remaining:
- Scope = booking-edit only (codex-confirmed: `create_booking_with_attach_plan` uses deterministic plan-UUID + pre-sorted collections; `grant_booking_approval`/`approve_booking_setup_trigger`/`create_setup_work_order_from_event` have no payload-hash gate). NOT a cross-RPC integrator P0.
- Forward-only; the `00407` migration is already on shared remote (pushed under standing authorization for this workstream). Rollback would require a follow-up migration restoring the buggy `md5(p_plan::text)` — undesirable by definition.
- Drift guard: GUARD-2 fails if a future `_`-prefixed `EditPlan` field is added without updating the SQL exclusion set; it does NOT catch a future non-`_`-prefixed request-varying field (documented residual).

#### Update — 2026-05-17 (Slice 2)

Original finding:
- `### P0-1. cancelOne is not atomic and loses outbox lineage` (Location: `docs/follow-ups/audits/03-booking-reservation.md:67`)
- `### P1-5. booking.cancelled outbox event has only one producer` (Location: `:187`)

Status:
- closed (P0-1, P1-5); one explicitly deferred residual (I-1, dead-letter backstop)

Changed:
- `supabase/migrations/00408_cancel_booking_with_cascade.sql` (new; on remote)
- `apps/api/src/modules/reservations/reservation.service.ts` (`cancelOne` → one-call wrapper; 4-write choreography + swallowed `bundleCascade` + in-process `onCancelled` removed)
- `apps/api/src/modules/reservations/recurrence.service.ts` (`cancelForward` retired — hard-fail stub, zero prod callers)
- `apps/api/src/modules/reservations/reservation.controller.ts` (`RequireClientRequestIdGuard` on `POST /:id/cancel`); `reservations.module.ts`
- `apps/api/src/modules/outbox/handlers/booking-cancelled-cascade.handler.ts` (new durable handler — visitor cascade via marker-safe `VisitorService` + requester notification, advisory-lock-deduped); `outbox.module.ts`; `visitors.module.ts`
- `packages/shared/src/idempotency.ts`; `apps/api/src/common/errors/{map-rpc-error,messages.en,messages.nl}.ts`; `packages/shared/src/error-codes.ts` (4 `cancel_booking_with_cascade.*` codes)
- `apps/api/scripts/smoke-cancel-booking.mjs` (new gate); `docs/smoke-gates.md`; `CLAUDE.md`; `package.json`+`apps/api/package.json`
- `docs/follow-ups/cancel-booking-equivalence-checklist.md` (new; the design contract — 40+ side-effects mapped TX/OBX/P1-4/REPLACED, converged over 3 codex plan-gate rounds)

Verified:
- `pnpm smoke:cancel-booking` -> 138/0 (this / this_and_following / series; draft-slot probe = genuine C-1/C-2 bug-catcher; non-pivot series visitor cascade asserted)
- `pnpm smoke:edit-booking` -> 78/78 (Slice-1 regression gate)
- `jest src/modules/reservations` -> 265/265; `errors:check-app-errors` clean; `tsc --noEmit` clean; `messages.spec.ts` 10/10 (EN/NL parity)
- corrected 00408 re-pushed to remote; `pg_get_functiondef` confirms broadened slot+sibling predicates, 7.d tenant filter, tightened orders predicate, lock-then-aggregate, security definer, revoke/grant
- Codex big-step: attempted, hung at 0 bytes (known codex failure mode, see [[project_b4_workstream_state]] precedent) -> skipped per `feedback_review_loop_protocol` (2-agent self full-review + empirical remote verification covered the gate; all 6 findings fixed+re-verified)

Remaining:
- I-1 (deferred, owner = outbox/infra): no booking-specific dead-letter backstop sweeper for `booking.cancel_cascade_required`; permanent dead-letter ⇒ visitors stuck `expected` + requester unnotified until manual replay. Bounded by outbox retry budget then unbounded. Documented in the equivalence checklist; a generic dead-letter backstop is cross-cutting infra, not booking Slice 2. Not silent.
- Cross-workstream discovered P0 `grant_ticket_approval` actor mismatch (logged in `00-integrator-verdict.md` ledger, owner = tickets-WO/audit-02) — unrelated to this slice, NOT fixed here.

#### Update — 2026-05-17 (Slice 3)

Original finding:
- `### P1-1. Multi-room create still on BookingTransactionBoundary` (Location: `docs/follow-ups/audits/03-booking-reservation.md:142`)

Status:
- closed (P1-1); discovered prerequisite D-4 closed; 3 accepted residuals (R-a/R-b/R-c) deferred-with-rationale

Changed:
- `apps/api/src/modules/reservations/multi-room-booking.service.ts` (`createGroup` → one atomic `create_booking_with_attach_plan`; choreography + `txBoundary`/`compensation` injects removed; cross-room approval fan-out by highest-priority rule via the resolver's own comparator `rule-resolver.service.ts:541-542`) + `.spec.ts`
- `supabase/migrations/00410_fix_applied_rule_ids_validates_room_rules.sql` (NEW; on remote — D-4 fix, §7a only)
- `apps/api/src/modules/reservations/dto/dtos.ts` (`client_line_id?`)
- `apps/api/scripts/smoke-create-multi-room.mjs` (NEW gate); `docs/smoke-gates.md`; `CLAUDE.md`; `package.json`+`apps/api/package.json`
- `docs/follow-ups/slice3-multiroom-validator-decision.md` (NEW — §7a/§7c/§7d table-assignment + exhaustive producer verification + Option-B + R-a/R-b/R-c)

Verified:
- `pnpm smoke:create-multi-room` -> 46/0 (atomic N-slot, idempotency replay/no-dup, partial-room full-rollback, cross-tenant reject, missing-CRID 400, require_approval→pending_approval+rows [probe f], single-room create-with-services+matched-room-rule→201 no §7a 400 [probe g])
- `jest src/modules/reservations` -> 267/267 (incl. the new highest-priority-cross-room-approval spec — fails pre-FIX-2, passes post)
- `pnpm smoke:cancel-booking` -> 138/0 ; `pnpm smoke:outbox` -> 13/0 (Slice-2 + single-room-create regression gates)
- `pnpm smoke:edit-booking` -> 75/1 — the 1 = pre-existing NOOR approval-flip seed/resolver flake, proven NOT a Slice-3 effect (`edit_booking` never calls `validate_attach_plan_internal_refs`; smoke-edit-booking.mjs unmodified since `a7570f14`). Flagged for the edit-booking/booking-flow workstream.
- `errors:check-app-errors` clean; `tsc --noEmit` clean
- 2-agent full-review: 1 blocker (stale dishonest `smoke-gates.md` probe-(f) doc — the exact dishonesty class) + 4 findings; all fixed + re-verified. Codex skipped — 0-byte hung repeatedly this session; protocol-allowed when self full-review + empirical verification cover ([[feedback_review_loop_protocol]], [[project_b4_workstream_state]] precedent).

Remaining:
- R-a (deferred): multi-room `workflow_definition_id` approval branch is a byte-mirror of single-room but live-unprobed (jest-covered; low risk). R-b: idempotency replay under mid-flight rule-effect flip = single-room parity, not a regression. R-c: 00410 forward-only on shared remote. All in `slice3-multiroom-validator-decision.md` §4.
- Drift risk (Option B, accepted): `createApprovalRows` is a byte-mirror duplicated in `multi-room-booking.service.ts` + `booking-flow.service.ts` — owner: booking-audit workstream; revisit if single-room approval wiring changes (audit §154's "one builder" prescription consciously traded for lower blast radius).
- D-4 also repaired a pre-existing latent P0 in single-room create-with-services (room-rule-match → 400). Now smoke-gated (probe g).

#### Update — 2026-05-17 (Slice 4)

Original finding:
- `### P1-2. RecurrenceService.splitSeries is non-atomic and non-idempotent` (Location: `docs/follow-ups/audits/03-booking-reservation.md:156`)

Status:
- closed (P1-2); discovered D-5 deferred-with-owner (task #14, R-e); residuals R-a..R-e documented

Changed:
- `supabase/migrations/00411_split_recurrence_series.sql` (NEW; on remote — atomic idempotent split RPC, canonical 00408 pattern)
- `apps/api/src/modules/reservations/recurrence.service.ts` (`splitSeries` → thin RPC wrapper; old 3-write body + swallowed audit deleted; `actorAuthUidForRpc` coerces synthetic `system:*` sentinels → null [I1 landmine])
- `apps/api/src/modules/reservations/reservation.service.ts` (editScope `skipSplitSeries` TS suppression pre-check + retry special-case DELETED — idempotency now in the RPC)
- `packages/shared/src/idempotency.ts` (`buildSplitSeriesIdempotencyKey`); `apps/api/src/common/errors/{map-rpc-error,messages.en,messages.nl}.ts` + `packages/shared/src/error-codes.ts` (3 `split_recurrence_series.*` codes)
- `apps/api/scripts/smoke-edit-booking-scope.mjs` (Scenario 7b split-idempotency probes + 3 legitimate harness-bug repairs incl. `command_operations.id`→`idempotency_key` [no such column existed] + a FIXME→D-5/R-e/#14 pointer on the pre-existing-409 probe)
- `docs/follow-ups/slice4-split-recurrence-decision.md` (NEW; live-DB-corrected root cause + R-a..R-e + rollback note)

Verified:
- `pnpm smoke:edit-booking-scope` -> 45/1: all 7 Slice-4 split-idempotency probes GREEN (exactly 1 series at pivot, exactly 1 split `command_operations` success row, recurrence_series count UNCHANGED on retry = no orphan); the 1 fail = pre-existing D-5/R-e on the `edit_booking_scope` envelope (NOT P1-2's path, NOT Slice-4-caused, FIXME-annotated)
- `jest src/modules/reservations` -> 265/265; `pnpm smoke:edit-booking` 75/1 (documented NOOR flake, NO new fail — confirms the scope hash/producer was not touched); `pnpm smoke:create-multi-room` 46/0; `pnpm smoke:cancel-booking` 122/2 (documented non-deterministic OBX-drain flake; Slice 4 changes zero cancel/outbox code); `errors:check-app-errors` clean; `tsc --noEmit` clean
- `split_recurrence_series` on remote: `pg_get_functiondef` confirms command_operations gate + advisory lock + F-CRIT-1 + 3-writes-in-tx + in-tx audit + NO emit + security definer + revoke/grant. Idempotency key deterministic.

Process honesty note (per the maintainer rule — recording the investigation, not just the conclusion):
- The D-5 root cause was MISDIAGNOSED twice before being verified against the live DB. (1) First: "scope assembler missing Slice-1 array canonicalization" — wrong (scope uses the same canonicalized `buildSingleSlotPlan`). (2) Then a full-review reviewer's claim "`edit_booking_scope` never adopted the 00407 strip helper; fix = one-line hash swap" was adopted by the orchestrator into a fix brief WITHOUT independent live-DB verification — also wrong: `00407:1256` shows `edit_booking_scope` already routes through `booking_edit_idempotency_payload_hash(p_plans)` (Slice-1 D-2 covered both RPCs), and two `p_plans` differing only in nested `_resolution_at` empirically hash identically. The fix-cycle subagent **refused** to author the resulting no-op migration / flip the smoke probe to assert a falsehood / rewrite a correct doc to be wrong (brutal-honesty rule), and surfaced the error. No no-op migration was shipped; nothing false reached the shared remote or the gate. The TRUE root cause (non-`_`-prefixed varying field in the scope producer) is now recorded in the D-5 row + `slice4-split-recurrence-decision.md` R-e and tracked as task #14. Lesson: P0/P1 root-cause claims must be verified against live ground truth before propagation into standing records or fix briefs — especially when they contradict a prior check.

Remaining:
- D-5 (R-e, task #14): pre-existing `edit_booking_scope` same-body-commit-retry 409 — non-`_`-prefixed producer-determinism; owner = future booking-audit producer-determinism slice; needs a producer-side diff investigation; honestly gated (probe asserts the real 409 with a FIXME→flip-when-fixed). Not Slice-4-caused.
- R-c: the `recurrence.service.ts` `txBoundary.runWithCompensation` clone caller is untouched (P2-1, later slice).

## Agent Handoff Prompt

```text
You are the lead booking/reservation remediation agent for:
docs/follow-ups/audits/03-booking-reservation.md

Goal:
Close every actionable booking/reservation architecture finding in this audit. Own the whole file, but ship in small slices. The end state is that bookings + booking_slots are not only the canonical schema, but every booking lifecycle operation that can corrupt cross-table state is implemented as a transactional, idempotent RPC with live smoke coverage.

Read first:
- AGENTS.md / CLAUDE.md
- docs/follow-ups/audits/03-booking-reservation.md
- docs/follow-ups/audits/00-integrator-verdict.md
- docs/follow-ups/audits/08-smoke-coverage.md
- docs/booking-platform-roadmap.md
- docs/booking-services-roadmap.md
- docs/superpowers/specs/2026-05-02-booking-canonicalization-*.md
- docs/superpowers/specs/2026-04-26-linked-services-design.md
- apps/api/scripts/smoke-edit-booking.mjs
- apps/api/scripts/smoke-edit-booking-scope.mjs

Recommended slice order:
1. Linked-row edit patches: populate `asset_reservation_patches`, `order_patches`, and `work_order_sla_patches` in `AssembleEditPlanService`.
2. Linked-row smoke coverage: extend editOne/editSlot and editScope smokes with linked services/orders/asset_reservations/setup work_orders.
3. User cancel path: add `cancel_booking_with_cascade` RPC; wire `ReservationService.cancelOne`; emit `booking.cancelled` in the same transaction.
4. Add `smoke:cancel-booking` with linked rows and outbox assertions.
5. Multi-room create: migrate service attach to the combined attach-plan RPC pattern.
6. Recurrence split/cancel: replace TS choreography with transactional RPCs.
7. Post-create/post-booking service attach: add `attach_services_to_existing_booking` RPC.
8. Bundle line/bundle cancel: add cascade RPCs and retire TS cleanup patterns.
9. Retire `BookingTransactionBoundary` once no live path needs in-process compensation.

Execution rules:
- Before editing, create a checklist for every P0/P1/P2/P3 finding in this file.
- Do not combine linked-row edit fixes with cancel-RPC work unless the user explicitly asks for a mega-slice.
- Use parallel agents only for read-only investigation or disjoint write scopes.
- Every new RPC must validate tenant-owned FKs, use the existing idempotency pattern where applicable, and emit required outbox/inbox/audit rows in the same transaction.
- Do not push or apply migrations to remote without explicit user approval.

Required closure behavior:
- Update this file's Closure Ledger after every slice.
- Update docs/smoke-gates.md when a new or augmented booking smoke becomes mandatory.
- Update booking follow-up docs when "B.4 complete" wording needs narrowing or expansion.
- Record migration numbers, tests/smokes run, and residual risk.

Completion bar:
- Edits cascade correctly to linked rows and are proven by live smoke fixtures.
- User cancel and recurrence cancel/split no longer rely on multi-table TS choreography.
- Service attach/cancel paths are transactional or explicitly deferred with owner and risk.
- Booking smokes cover linked services, approvals, orders, asset_reservations, work_orders, idempotency, and payload mismatch.
```
