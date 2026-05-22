# Smoke gates — mandatory pre-ship probes

The smoke gates in this repo are live-API integration probes that mint a real Admin JWT and hit the running dev server. They exist because mocked-Supabase jest tests pass even when the real DB write fails (the 2026-05-01 P0 incident — mocked tests green, prod migration 42501) and no-op fast paths silently break on NUMERIC round-trip (Slice 3.1 cost-float bug). Code review + jest specs are necessary but **not sufficient** — they don't talk to a real database.

Each smoke script:
- Mints a real Admin JWT against the live API.
- Seeds disposable fixtures directly via psql (or the Supabase admin client), bypassing parts of the create-flow that are out of scope.
- Runs the full mutation matrix against the live HTTP surface.
- Drops fixtures in a `finally` so a failed run doesn't leave orphans.

Exit 0 = all probes pass. Exit 1 = at least one regression.

---

## `pnpm smoke:work-orders`

**Required before claiming complete:** any work touching `WorkOrderService` / `TicketService.update` / the desk-detail sidebar.

**Also required (added 2026-05-18, audit-02 Slice F):** any work touching `set_entity_assignment` v3/v3.1/v3.2 (migrations 00416/00418/00419) · `TicketService.reassign` / `WorkOrderService.reassign` (case+WO, manual + `rerun_resolver`) · the routing-evaluation outbox handler (`routing-evaluation.handler.ts`) · `SlaService.applyReassignment` / `fireThreshold` / `processThresholds` (SLA escalation) · `TicketService.getChildTasks` / `TicketVisibilityService.getVisibleWorkOrderIds` (P1-5) · `apps/api/src/common/command-operations-probe.ts` (`probeCommandOperationSuccess` — the CR2 caller-side success-probe) · any migration altering `routing_decisions` (`entity_kind`/`case_id`/`work_order_id`/`chosen_*`/`strategy`/`chosen_by`), `command_operations`, `sla_timers`, `sla_threshold_crossings`, `sla_policies`.

Script: `apps/api/scripts/smoke-work-orders.mjs`.

Mutation matrix: status · priority · assignment · plan · sla · title · tags · cost-fractional · dispatch.

Validation probes (7): ghost uuids, malformed uuids, oversized arrays, ghost assignees, empty title.

Uses the **current-row-XOR-sentinel pattern** so every mutation actually exercises the write path — no phantom-success on a no-op fast path.

**audit-02 Slice F block (`runAudit2Probes`, ~25 assertions).** Gated by a mandatory **STEP-0 provenance probe**: a manual `POST /tickets/:id/reassign` must land a `command_operations` `outcome='success'` row under `reassign:case:<id>:<crid>` — pre-Slice-C reassign wrote NO such row, so its presence proves the running :3001 server is serving audit-02 code (not stale TS / the concurrent audit-04 branch state). If the provenance probe FAILS the rest of the audit-02 block is **skipped** (not passed) and a precise LIVE-SMOKE-BLOCKED reason is surfaced — a green smoke against stale TS is a false-green, worse than no smoke. With provenance green, the block covers (live-validated 2026-05-18):

- **P1-1 case reassign** — `command_operations` success + `routing_decisions` (explicit `entity_kind='case'`, manual `strategy='manual'`/`chosen_by='manual_reassign'`) + a `reassigned` `ticket_activities` row, ALL atomic; idempotent same-crid replay (no duplicate audit); **D-A02-4 drifted-retry** — a same-crid + drifted-payload retry after a committed success short-circuits to the ORIGINAL committed result (NOT `payload_mismatch`, NOT double-apply — the CR2 poison-closure; `payload_mismatch` is deliberately unreachable from the reassign HTTP surface once a success exists); the **CR2 caller-probe** on the `rerun_resolver` path.
- **P1-1/D-A02-2/D-A02-3 rerun_resolver provenance** — `routing_decisions` reflects the RESOLVER (`strategy ∈ {asset,location,fixed,auto,rule}`, resolver `chosen_by`), never hardcoded `manual`; the D-A02-3 `chosen_by='unassigned' ⟺ all chosen_* NULL` provenance invariant holds.
- **Vendor end-to-end (smoke-gap #5)** — reassign with `assigned_vendor_id` → `command_operations` + `routing_decisions` + `assigned_vendor_id` landed with team/user cleared atomically.
- **P1-1 WO reassign (smoke-gap #3)** — `command_operations` success under `reassign:work_order:<id>:<crid>` + `routing_decisions` (explicit `entity_kind='work_order'`) + replay idempotency + D-A02-4 drifted-retry short-circuit (also covers **P2-4**: clean non-403/non-5xx shape).
- **P1-5 getChildTasks cross-visibility** — a child WO dispatched to a vendor outside a low-visibility requester's `work_order_visibility_ids` is EXCLUDED for that requester (parent-case-read ≠ child-WO-read) while a `read_all` actor sees it.
- **Dispatch contract (smoke-gap #8)** — same-crid replay → same `child_id`; same-crid + different payload → 409; dispatch on a terminal (`closed`) parent → 400 `dispatch.parent_terminal`.

**SLA escalation (P0-2 / D-A02-1 / R-A02-2) — DEFERRED-with-reason, not skipped, not failed.** The SLA-escalation reassign is reachable ONLY via `SlaService.checkBreaches`' `@Cron(EVERY_MINUTE)` → `processThresholds` (private; `sla.controller.ts` exposes only two GET reads — no HTTP entrypoint). The probe seeds a query-visible near-breach `sla_timers` + an escalate-threshold `sla_policies` row and waits ≥2 full cron windows. Empirically (2026-05-18) the `@nestjs/schedule` cron is **not firing on the shared :3001 dev process** — so the probe records a **DEFERRED** outcome (counted separately; NOT pass, NOT a fatal fail; surfaced loudly in the summary), with the precise reason. This is the same documented rationale the PM-generator probe uses for invoking its RPC directly rather than relying on the cron (`smoke-work-orders.mjs:134-143`). The SLA-escalation-specific TS path (D-A02-1 `users.id→persons.id` watcher conversion; the CR2 success-probe; the R-A02-2 crossing-winner gate) is **jest-covered** (`sla.service.spec.ts` 10/10 + CR2 +4 per the audit-02 Closure Ledger) and its underlying atomic primitive `set_entity_assignment` v3.2 is **concurrency-tested 20/20 + live-proven by the reassign/vendor/WO probes above** (same RPC, same `command_operations`+`routing_decisions`+`ticket_activities`+`domain_events` atomicity). Restarting the shared server is forbidden (concurrent audit-03/04 sessions depend on :3001); fabricating a pass is forbidden. Live SLA-escalation-specific validation is therefore deferred-with-reason, surfaced not hidden.

Exit-code semantics for this script gain a third bucket: `N pass / M fail / K deferred`. Exit 1 iff `M>0`; deferred items never flip the exit code but are always printed.

---

## `pnpm smoke:edit-booking-scope`

**Required before claiming complete:** any work touching `ReservationService.editScope` / `assembleScopeEditPlan` / the `edit_booking_scope` RPC.

Script: `apps/api/scripts/smoke-edit-booking-scope.mjs`. Run via `pnpm --filter @prequest/api smoke:edit-booking-scope`.

Fixture: a `recurrence_series` + 5 occurrences seeded directly via psql (bypassing the create-flow's rule resolver + conflict guard, which are out of scope for an edit-pipeline probe).

Exercises `POST /reservations/:id/edit-scope` across:

- **`scope='series'`** — dry-run + commit + idempotent replay + payload-mismatch (409).
- **`scope='this_and_following'`** — dry-run (splitSeries suppressed) + commit (splitSeries fires, new series minted, forward bookings move).
- **Validation gates:**
  - `scope='this'` → `wrong_endpoint`
  - `start_at` → `edit_booking_scope.time_shift_not_supported` (422)
  - invalid scope + non-boolean `dry_run` → `edit_booking_scope.invalid_plans` (400)
  - missing `X-Client-Request-Id` → guard fires

**Also required (added 2026-05-16, booking-audit Slice 1):** any migration that touches `edit_booking_scope` / `booking_edit_idempotency_payload_hash` / `booking_edit_strip_hash_server_fields`, or any change to `AssembleEditPlanService.buildLinkedRowPatches` or `ActorContext` actor threading (the `auth_uid` thread-through that previously made every editScope call 404 `actor_not_found` — see `docs/follow-ups/audits/03-booking-reservation.md` D-1). `edit_booking_scope` receives the D-2 idempotency-hash fix (migration 00407, verbatim from 00399 + one delta line). Note: editScope rejects `start_at`/`end_at` by design, so this gate has no linked-row time-shift fixture — the linked-row Fixture D lives in `smoke:edit-booking` (see below).

---

## `pnpm smoke:edit-booking`

**Required before claiming complete:** any work touching `ReservationService.editOne` / `ReservationService.editSlot` / `assembleEditPlan` (kinds `'one'` + `'slot'`) / the `edit_booking` RPC (migration 00364).

Script: `apps/api/scripts/smoke-edit-booking.mjs`. Run via `pnpm --filter @prequest/api smoke:edit-booking`.

**Fixtures (psql-seeded):**
- **Fixture A:** single booking + 1 slot, +130d on `ROOM_HUDDLE`.
- **Fixture B:** single booking + 2 slots, +131d, primary on `ROOM_HUDDLE` + non-primary on `ROOM_BOARD` — `display_order` 0/1 seeded explicitly.

**20 scenarios across two endpoints:**

`PATCH /reservations/:id` (**editOne**):
- space_id move
- geometry shift
- idempotency replay
- payload-mismatch
- `invalid_window` for `start >= end` + parse-failure
- `invalid_space_id` empty string
- `reference.not_in_tenant` ghost-uuid
- `booking_not_found` ghost-booking
- missing `X-Client-Request-Id`

`PATCH /reservations/:bookingId/slots/:slotId` (**editSlot**):
- non-primary slot space_id move
- URL mismatch via Fixture A's `slotId` + Fixture B's `bookingId`
- `MIN(slots)` rollup on `start_at` shift
- idempotency replay
- payload-mismatch
- `invalid_space_id`
- missing `X-Client-Request-Id`

**Op-discrimination (Step 2F.3 contract):** editOne + editSlot sharing one CRID mint 2 distinct `command_operations` rows.

**Also required (added 2026-05-16, booking-audit Slice 1):** any migration that touches `edit_booking` / `booking_edit_idempotency_payload_hash` / `booking_edit_strip_hash_server_fields`, or any change to `AssembleEditPlanService.buildLinkedRowPatches` or `ActorContext` actor threading (the `auth_uid` thread-through that previously made every editOne/editSlot call 404 `actor_not_found` — see `docs/follow-ups/audits/03-booking-reservation.md` D-1).

**Fixture D is mandatory (P0-2/P0-3 closure, 2026-05-16):** this gate MUST include the linked-row Fixture D — a single booking + 1 catering order + 1 OLI + a boundary-aligned `asset_reservation` + a custom-window `asset_reservation` + 1 setup `work_order`, asserting that the post-edit instants propagate to all linked rows (see `docs/follow-ups/audits/03-booking-reservation.md` P0-2 / P0-3). A fixture with NO linked rows is insufficient: the empty-patch-array bug (Agent 3 P0-2) was invisible precisely because the prior fixtures (A/B) intentionally seeded no services/orders/work_orders. The §10.c–§10.d RPC cascade branches must be exercised against real linked rows, not no-ops.

**Fixture E is mandatory (multi-slot guardrail, 2026-05-22):** this gate MUST include a multi-slot booking with at least one live booking-level linked row and assert that a single-slot edit returns `409 edit_booking.linked_rows_require_booking_scope` with no slot mutation or booking audit write. This protects the current data model until linked rows gain explicit `booking_slot_id` attribution.

---

## `pnpm smoke:cancel-booking`

**Required before claiming complete:** any work touching `ReservationService.cancelOne` / the `POST /reservations/:id/cancel` route / the `cancel_booking_with_cascade` RPC (migration 00408) / `RecurrenceService.cancelForward` / the `BookingCancelledCascadeHandler` outbox handler / `BundleCascadeAdapter.handleBundleCancelled` / `buildCancelBookingIdempotencyKey`.

Script: `apps/api/scripts/smoke-cancel-booking.mjs`. Run via `pnpm --filter @prequest/api smoke:cancel-booking`.

This is the **P0-1 / P1-5 regression gate** (audit `docs/follow-ups/audits/03-booking-reservation.md`). It proves the user-cancel cascade is atomic + emits `booking.cancelled` on every cancel + the durable visitor/notification cascade fires. Equivalence contract: `docs/follow-ups/cancel-booking-equivalence-checklist.md`.

**Fixtures (psql-seeded, `session_replication_role='replica'`):** a single booking (+140d) and two recurrence series (3 occurrences each, +141d) — each booking carries the full linked graph: 1 order + 1 OLI + 1 asset_reservation + 1 non-terminal setup `work_order` + 1 pending approval + 1 `expected` visitor + 1 `arrived` visitor.

**Probes per scope (`this` / `this_and_following` / `series`):**
- TX rows: booking + slot → cancelled (grace set); order + OLI → cancelled (pending_setup_trigger_args nulled); asset_reservation → cancelled; work_order → status_category=closed + closed_at; approval → expired + responded_at; `series_end_at` capped for forward/series; `recurrence_cancel_forward` audit row.
- `booking.cancelled` outbox present **per cancelled booking** with `{tenant_id,booking_id,reason,started_at}` payload; `booking.cancel_cascade_required` outbox present per booking.
- OBX (after the 30s outbox worker drains, polled ≤75s): `expected` visitor → cancelled + `visitor.cancelled` + `visitor.cascade.cancelled` domain_event; `arrived` visitor unchanged + `visitor.cascade.host_alert`; requester `reservation_cancelled` notification + `reservation.notification_sent` audit.
- Idempotency replay (same key → cached body, no double cascade, no duplicate outbox); payload mismatch (same key, different reason → 409); already-cancelled re-cancel (new key → 200 short-circuit, no new emit); missing `X-Client-Request-Id` → 400; cross-tenant booking id → 404.

Note: the OBX assertions depend on the dev API's outbox worker (30s cron) draining `booking.cancel_cascade_required`; the probe polls with a 75s window per scope.

---

## `pnpm smoke:create-multi-room`

**Required before claiming complete:** any work touching `MultiRoomBookingService.createGroup` / the `POST /reservations/multi-room` route / its use of `create_booking_with_attach_plan` (migrations 00309 / 00315) / the `validate_attach_plan_internal_refs` §7a `applied_rule_ids[]` snapshot validator (migration **00410**) / `BundleService.buildAttachPlan` (multi-room consumer) / the multi-room room-rule approval fan-out (`createApprovalRows` / `WorkflowService.start`) / the cross-room approval priority aggregation.

Script: `apps/api/scripts/smoke-create-multi-room.mjs`. Run via `pnpm --filter @prequest/api smoke:create-multi-room`.

This is the **P1-1 + D-4 regression gate** (audit `docs/follow-ups/audits/03-booking-reservation.md`). It proves multi-room create is now ONE atomic `create_booking_with_attach_plan` transaction (booking + N slots + orders + OLIs + asset_reservations + approvals) — replacing the pre-Slice-3 legacy choreography (`create_booking` + a separate `bundle.attachServicesToBooking` + in-process `BookingTransactionBoundary` compensation, with a real window of inconsistency) — AND that the §7a `applied_rule_ids[] → room_booking_rules` validator fix (migration **00410**, shipped IN this slice, on remote) holds end-to-end. Equivalence + table-assignment decision: `docs/follow-ups/slice3-multiroom-validator-decision.md`.

**Fixtures (psql-seeded, `session_replication_role='replica'`):** dedicated, self-contained per probe (no shared-room collision). Primary fixture: 3 reservable test rooms (+145d) + 1 catering `catalog_item` + 1 AV `catalog_item` linked to a seeded `asset`/`asset_type` (service line carries `linked_asset_id` → 1 `asset_reservation`). The approval + single-room probes seed no fixture rule — they deterministically match the pre-existing 00133-seeded off-hours tenant rule (hour-17 UTC 60-min booking).

**Probes:**
- (a) atomic create with services → 1 booking + 3 booking_slots + ≥1 order + ≥2 OLIs + ≥1 asset_reservation ALL present; exactly 1 `attach_operations` row with `outcome=success` + `cached_result` (proves single tx).
- (b) idempotency replay (same actor + same `X-Client-Request-Id`) → same `group_id`, NO duplicate booking / slots / orders / OLIs / asset_reservations; still exactly 1 `attach_operations` row.
- (c) partial-room conflict (one of the N rooms pre-booked → GiST 23P01 inside the tx) → 409 `multi_room_booking_failed`; WHOLE tx rolls back: zero new slots, zero orphan orders, zero orphan asset_reservations.
- (d) cross-tenant `space_id` (one space seeded in another tenant) → 404 `space_not_found`; zero rows on the ok-space (no partial create).
- (e) missing `X-Client-Request-Id` → 400 (RequireClientRequestIdGuard, already on the route).
- (f) require_approval room rule matched (off-hours 00133 tenant rule) → create **succeeds** (200/201), NOT 400. Asserts the full post-00410 path: booking lands `status='pending_approval'`; `bookings.applied_rule_ids` carries ≥1 `room_booking_rules` id (the §7a fix — pre-00410 that exact id raised `attach_plan.internal_refs: applied_rule_ids[] … not in tenant service_rules`, 42501 → HTTP 400); the room-rule approval fan-out created the approval rows (booking-targeted, `status='pending'`, `approval_chain_id` set, approver set MATCHES the matched rule's `required_approvers` read from the DB — no hardcode); all N slots + service orders/OLIs/asset_reservations committed atomically in the one combined-RPC transaction (exactly 1 `attach_operations` row).
- (g) **single-room** create-with-services + a matched room rule (same off-hours 00133 tenant rule, one space) → 201, booking row present, `bookings.applied_rule_ids` non-empty, NOT 400. This is the largest §7a/00410 blast radius: single-room create-with-services where a room rule matched was a pre-existing, never-smoke-covered latent break (the legacy `create_booking` RPC had no such validator). The probe genuinely exercises §7a (a matched room rule ⇒ non-empty `applied_rule_ids`), not a tautology.

Note: this gate also serves as a Slice-1/Slice-2 regression check — `MultiRoomBookingService` shares the reservations module + `BundleService.buildAttachPlan`, so a break here would also threaten `smoke:edit-booking` / `smoke:cancel-booking`.

---

## `pnpm smoke:attach-services`

**Required before claiming complete:** any work touching `BundleService.attachServicesToBooking` / the `POST /reservations/:id/services` route / `attach_services_to_existing_booking` RPC (migrations **00412** / **00413**) / its `attach_operations` idempotency gate / `BundleService.buildAttachPlan` + `hydrateLines` (the attach producer) / `buildAttachServicesIdempotencyKey` / `mapAttachRpcError`.

Script: `apps/api/scripts/smoke-attach-services.mjs`. Run via `pnpm --filter @prequest/api smoke:attach-services`.

This is the **P1-3 regression gate** (audit `docs/follow-ups/audits/03-booking-reservation.md`). It proves post-create service attach is now ONE atomic `attach_services_to_existing_booking` transaction (orders + order_line_items + asset_reservations + approvals + the guarded `setup_work_order.create_required` outbox emit) — replacing the pre-Slice-5 non-atomic TS N-write + reverse-order TS `Cleanup` undo-queue (the same data-loss class as the cancelOne bug). Decision + residuals: `docs/follow-ups/slice5-attach-services-decision.md`.

**Fixtures (psql-seeded, `session_replication_role='replica'`):** dedicated per-probe (+150d, clears sibling-smoke windows). 2 reservable rooms + a priced catering `catalog_item` + an AV `catalog_item` linked to a seeded `asset`/`asset_type` (service line `linked_asset_id` → 1 `asset_reservation`) + a `require_approval` `service_rules` row (catalog_item-scoped, always-true predicate, person approver). Each probe creates its OWN fresh no-services booking via `POST /api/reservations`, then attaches — so every assertion is a baseline→after delta keyed to that run's `booking_id` (multi-session-safe on the shared remote; outbox assertions key on `payload->>'booking_id'`, never a global count).

**Probes (44 assertions):**
- (1) atomic attach (catering + AV) → ≥1 order, exactly 2 OLIs (qty 8 + qty 1), exactly 1 asset_reservation, exactly 1 `attach_operations` row `outcome=success`, 0 approvals (plain items).
- (2) idempotency replay (same booking + same `X-Client-Request-Id`) → orders/OLIs/AR counts UNCHANGED, still exactly 1 `attach_operations` success row.
- (3) same `X-Client-Request-Id`, DIFFERENT payload → HTTP 409 `booking.idempotency_payload_mismatch`; zero new orders/OLIs; no qty=99 OLI ever persisted.
- (4) cross-tenant: Tenant-A JWT + Tenant-B `X-Tenant-Id` → reject (403/404/401, all correct rejects); zero orders for the booking under the wrong tenant and under `OTHER_TENANT_ID`.
- (5) missing `X-Client-Request-Id` → 400 (RequireClientRequestIdGuard); zero new orders.
- (6) **load-bearing atomicity gate** — a pre-seeded `confirmed` asset_reservation overlapping the window makes the RPC's AR INSERT trip the `asset_reservations_no_overlap` GiST exclusion (23P01) AFTER the catering order/OLI insert; asserts the request did NOT succeed AND ZERO partial rows (no orphan order, no OLI incl. no qty=5 OLI, no AR, no approval, `attach_operations` marker rolled back). A surviving partial row here is a REAL RPC bug — the probe fails loudly, never weakens.
- (7) require_approval `service_rules` rule → response `any_pending_approval=true`; ≥1 pending booking-targeted approval routed to the seeded approver; `setup_work_order.create_required` outbox SUPPRESSED for THIS booking (the RPC guards the emit on `NOT any_pending_approval`).

**Known deferred (NOT a gate gap — documented, owned):** D-6 producer-determinism — `buildAttachPlan` bakes a `Date.now()`-derived `lead_time_remaining_hours` into the hashed plan, so a same-intent retry that straddles a tenant lead-time-rule boundary 409s. Same root class as D-5 (debt #14); bundled into the producer-determinism slice (audit 03 Closure Ledger, decision doc §D-6). Probes 2/3 cover the deterministic-case idempotency; the lead-time-rule retry case is an explicitly-recorded gap, not a hidden one.

---

## `pnpm smoke:cancel-order-line`

**Required before claiming complete:** any work touching `BundleCascadeService.cancelLine` / `cancelBundle` / the `DELETE /reservations/:id/services/:lineId` + `DELETE /reservations/:id/bundle` routes / `cancel_order_lines_with_cascade` RPC (migration **00414**) / its `command_operations` idempotency gate / the approval rescope-vs-expire-all branch / `bundle-services-cancelled-cascade.handler.ts` / `BundleCascadeAdapter.handleBundleCancelled` / `buildCancelOrderLinesIdempotencyKey` / `mapCancelOrderLinesRpcError`.

Script: `apps/api/scripts/smoke-cancel-order-line.mjs`. Run via `pnpm --filter @prequest/api smoke:cancel-order-line`.

This is the **P1-4 regression gate** (audit `docs/follow-ups/audits/03-booking-reservation.md`). It proves per-line + bundle-services cancel is now ONE atomic `cancel_order_lines_with_cascade` transaction (OLI → asset_reservations → work_orders → orders → approvals rescope/expire → conditional booking/slot close → in-tx audit/domain + durable `bundle.services_cancelled` outbox on the bundle path) — replacing the pre-Slice-6 non-atomic TS choreography + lossy in-process `BundleEventBus` emit. Decision + residuals: `docs/follow-ups/slice6-cancel-order-line-plan.md`. The Slice-2 equivalence checklist had explicitly deferred P1-4 out of `smoke:cancel-booking` — this gate closes that coverage gap.

**Fixtures (psql-seeded, `session_replication_role='replica'`):** dedicated per-probe booking + cancellable OLI(s) + linked asset_reservation + work_order (+ a pending booking-targeted approval for the rescope/poison probes); a foreign-tenant variant under `OTHER_TENANT_ID` for probe 8. Every assertion is a baseline→after delta keyed to that run's `booking_id` (multi-session-safe; outbox via `payload->>'booking_id'`, never a global count).

**Probes (55 assertions):**
- (1) per-line cancel atomic deltas — OLI `fulfillment_status='cancelled'` + linked asset_reservation cancelled + linked work_order closed + approval rescoped; exactly 1 `command_operations` success row.
- (2) idempotency replay (same `X-Client-Request-Id`) → counts unchanged, still 1 success row.
- (3) same CRID, different line set → 409 payload_mismatch; zero new writes.
- (4) fulfilled-line protection → 422 `line_already_fulfilled`; zero writes.
- (5) approval rescope correctness — multi-entity approval: cancel one line ⇒ `scope_breakdown` shrinks, approval still `pending`; cancel the last in scope ⇒ approval `expired`.
- (6) bundle cancel (`p_line_ids` NULL) — BOTH weak-close branches: pure-services booking ⇒ booking + slots cancelled; a kept/fulfilled line ⇒ booking stays; `bundle.services_cancelled` outbox present for the booking.
- (7) **load-bearing atomicity** — a `status='pending'` booking-targeted approval with `scope_breakdown = '{"order_line_item_ids":"POISON_NOT_AN_ARRAY"}'::jsonb` makes the per-line rescope loop run `jsonb_array_elements_text(<scalar>)` → real Postgres 22023 mid-tx → 5 strict assertions prove the request did NOT 2xx AND OLI/asset_reservation/work_order are UNCHANGED AND ZERO `command_operations` success (the in_progress insert rolled back with the tx). `expect:'error'` (any non-2xx) — a forced raw-PG raise is UNMAPPED → correctly 500/`unknown.server_error`, not a user-actionable 422; the proof is the 5 zero-partial-row assertions, not the status (mirrors `smoke:attach-services` probe 6).
- (8) cross-tenant — a REAL booking+OLI+asset_reservation+work_order seeded under `OTHER_TENANT_ID`; per-line cancel as the real tenant → 404 + ZERO writes on the foreign rows (defense-in-depth: controller `findOne` visibility 404 in front of the RPC's `where tenant_id` FOR UPDATE) + a ghost-uuid sub-probe.
- (9) missing `X-Client-Request-Id` → 400 (RequireClientRequestIdGuard).

---

## `pnpm smoke:recurrence-clone`

**Required before claiming complete:** any work touching `RecurrenceService.materialize` / `cloneBundleOrdersToOccurrence` / `OrderService.cloneOrderForOccurrence` / `BookingFlowService.startSeries` (the recurring-create → series → materialize → occurrence-clone path) / `recurrence_series` creation / `delete_booking_with_guard` as the recurrence compensation primitive / `booked-by-user-id.util.ts` (`bookedByUserIdForRpc`) / the synthetic `SYSTEM_ACTOR` (recurrence) or Outlook-sync system actor / any future re-introduction of an in-process compensation boundary.

Script: `apps/api/scripts/smoke-recurrence-clone.mjs`. Run via `pnpm --filter @prequest/api smoke:recurrence-clone`.

This is the **P2-1 regression gate** (audit `docs/follow-ups/audits/03-booking-reservation.md`). It proves the recurrence occurrence-clone path still works end-to-end AFTER `BookingTransactionBoundary` + `InProcessBookingTransactionBoundary` + `BookingCompensationService` were retired (Slice 7) — i.e. `materialize()`'s clone is now a plain try/catch + a direct `delete_booking_with_guard` (the audit-mandated compensation primitive), with NO in-process boundary abstraction. It also gates discovered finding **D-8** (the synthetic `system:*`-actor → `uuid` create-RPC booker-bind 500 that silently produced ZERO materialised occurrences via HTTP from 2026-04-25 until Slice 7; the shared `bookedByUserIdForRpc` guard fixes it). Decision + the 6-iteration honest fix-cycle: `docs/follow-ups/slice7-retire-tx-boundary-plan.md`.

**Fixtures (psql-seeded, `session_replication_role='replica'`):** a dedicated reservable room + catering/AV catalog + a seeded asset, anchored at `FIXTURE_DAYS=30` snapped to the next **Monday at 10:00 UTC**. The anchor is load-bearing and deterministic: it MUST be (a) within the rolling 90-day materialisation horizon (`startSeries` calls `materialize` with `horizon = now+90d`; `materialize`'s `passes(d)` rejects `d > materialized_through`), AND (b) a Europe/Amsterdam business-hours weekday so tenant-001's 00133 "Off-hours bookings need approval" `room_booking_rule` does NOT route the booking to `pending_approval` (which would suppress `startSeries` by design). Dedicated room ⇒ no sibling-smoke collision (the far-future window other smokes use is unnecessary here).

**Probes (14 assertions):**
- pre-flight: `delete_booking_with_guard` present on remote.
- `POST /api/reservations` (daily ×3, services mixed `repeats_with_series`) → 2xx; master booking row present.
- **master booking is `confirmed`** (self-diagnosing: if `pending_approval` the fixture tripped the off-hours rule → fails LOUDLY with the remediation hint, because `startSeries` is suppressed for pending bookings by design — booking-flow.service.ts:622-627).
- `recurrence_series` row created + anchored at the master (bounded ≤40s poll — `startSeries` is `void`-fired + `.catch()`-swallowed, so a never-appearing row is a REAL failure, not a timing artefact).
- ≥2 occurrence bookings materialised; all tenant-scoped (#0 invariant).
- per occurrence ×2: catering line (`repeats_with_series=true`) cloned; AV line (`repeats_with_series=false`) NOT cloned (`order.service.ts:206` filter); cloned order tagged `recurrence_series_id`; cloned service window time-shifted onto the occurrence day (NOT the master day).

**Honest coverage boundary (printed, NOT skip-as-pass, NOT a counted probe):** the forced-clone-failure → `deleteOrphanOccurrence` → `delete_booking_with_guard` + `booking.compensation_*` audit + don't-advance-`materialized_through` branch is NOT deterministically drivable through the live POST entrypoint — the only AR-conflict lever is *caught* at `order.service.ts:275-281` (`assetConflicted=true`, no throw) before reaching compensation, and the failure-injection points live inside the void+catch-swallowed `materialize`. That branch is covered against the REAL `deleteOrphanOccurrence` + REAL `delete_booking_with_guard` arg shape by the 7 rewritten jest tests in `apps/api/src/modules/reservations/recurrence-materialize.service.spec.ts` (Slice 7). Asserting an HTTP failure here would be a constructed-to-pass fixture — deliberately not done.

---

## `pnpm smoke:floor-plans`

**Required before claiming complete:** any work touching `FloorPlanService` / `FloorPlanDraftService` / `publish_floor_plan_draft` RPC / the floor-plan editor.

Script: `apps/api/scripts/smoke-floor-plans.mjs`.

Fabricates a disposable floor + child room via the Supabase admin client, then runs **20 probes**:

- **Happy-path CRUD:** GET draft, PATCH, publish, GET published, history.
- **Validation rejections:** 1-point polygon, unlinked polygon, cross-tenant `space_id`, space not a child of floor, duplicate `space_id`, publish with no image.
- **Cross-tenant RLS isolation:** tenant B cannot see tenant A draft.
- **Atomic CAS / optimistic locking:** `If-Match` stale → 409.
- **Parallel publish race:** exactly one success.
- **Signed-URL freshness.**
- **Direct Supabase REST block:** RLS rejects direct INSERT into `floor_plan_publish_history`.

**Skipped (known gaps):**
- P10 (non-admin JWT probe) — requires a seeded non-admin user.
- P17 (bounds-check probe) — DTO does not yet enforce pixel clamping.

All fabricated test data is cleaned up on exit.

---

## `pnpm smoke:cross-tenant`

**Required before claiming complete:** any work touching `AuthGuard`, `AdminGuard`, `PermissionGuard`, the global tenant binding bridge, or any admin/config controller that previously read `TenantContext.current()` without bridging `auth_uid → users`.

Script: `apps/api/scripts/smoke-cross-tenant.mjs`.

**The gate this protects.** Pre-Slice-1 the `X-Tenant-Id` header was trusted with no JWT cross-check, so any authenticated user could read/write 9 admin-controller surfaces (workflow, routing-rules, sla-policies, etc.) in any tenant by flipping the header (`docs/follow-ups/audits/04-rls-security.md` P0 §`X-Tenant-Id` header trusted). Slice 1 (`auth.guard.ts`) bridges `auth_uid → public.users(id) WHERE tenant_id AND status='active'` and 403s mismatch with `auth.user_not_in_tenant`. Slice 2 layers `@UseGuards(AdminGuard)` on the 10 named admin controllers as belt+suspenders.

**Fixture:** TENANT_B (`00000000-0000-0000-0000-0000000000b1`) seeded directly via psql with `session_replication_role = 'replica'` to skip the drifted `trg_tenants_seed_retention` trigger. Idempotent — re-runs are no-ops.

**12 probes:**

- **Regression — own-tenant** (2): Tenant-A admin JWT + Tenant-A header → `GET /workflows` and `GET /routing-rules` return 200. Confirms the bridge didn't break the happy path.
- **Regression — bare auth** (1): no Bearer token → 401. Confirms AuthGuard still rejects unauthenticated requests.
- **P0 attack — cross-tenant GETs** (6): Tenant-A admin JWT + `X-Tenant-Id: TENANT_B` against the 6 admin GET endpoints from the audit (`workflows`, `routing-rules`, `sla-policies`, `space-groups`, `location-teams`, `domain-parents`) → all 403. Verified red-before-green: against pre-Slice-1 main these all returned 200 with target-tenant data.
- **Slice 1 + Slice 2 belt+suspenders — cross-tenant POSTs** (3): same JWT + cross-tenant header, with a write body → 403 on `workflows`, `routing-rules`, `sla-policies`. Safe to run continuously because AuthGuard rejects before the controller / RPC sees any body (no attacker rows land in Tenant B).

**Known gap deferred to Slice 3.b:** no same-tenant non-admin probe. Requires a second auth fixture (non-admin user in TENANT_A) we don't seed yet. Once added, will assert that AdminGuard (Slice 2) rejects non-admin same-tenant POSTs even when the bridge (Slice 1) passes.
