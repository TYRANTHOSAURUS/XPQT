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

Script: `apps/api/scripts/smoke-work-orders.mjs`.

Mutation matrix: status · priority · assignment · plan · sla · title · tags · cost-fractional · dispatch.

Validation probes (7): ghost uuids, malformed uuids, oversized arrays, ghost assignees, empty title.

Uses the **current-row-XOR-sentinel pattern** so every mutation actually exercises the write path — no phantom-success on a no-op fast path.

> **Audit-02 remediation (2026-05-16) — live-HTTP-smoked + COVERED (2026-05-17).** The tickets/work-order audit remediation closed P0-1, P0-2, P1-1…P1-5 and shipped 2 RPC migrations (00406 `set_entity_assignment` v3, 00410 `update_entity_combined` v7, both pushed + remote function bodies verified). These surfaces are now **live-HTTP-smoked end-to-end** by the audit-02 Slice-8 probe sets wired into `smoke:tickets` + `smoke:work-orders` (2026-05-17). The 2026-05-16 "deferred / owned / why-deferred" framing is **superseded** — the contention concern was resolved by running every probe against a **worktree-isolated API server (`:3010`, built from the audit-02 worktree)** and using **per-run isolated fixtures** (unique RFC-4122-v4 uuids seeded via `psql` `session_replication_role='replica'` to bypass drifted triggers; full teardown in `finally`) so the shared remote DB — concurrently driven by another session's `:3001` server + cron — never collides; SLA + idempotency assertions are server-agnostic (asserted via `command_operations`-idempotent OUTCOMES, not which server ran).
>
> **`pnpm smoke:tickets`** covers (final run 2026-05-17: **121 pass / 0 fail**, exit 0): `PATCH /tickets/bulk/update` 200/207/422 + per-id `command_operations` (fingerprint-folded `patch:case:<id>:<crid>:<fp>`) + idempotent replay no-double-write (**P0-1**); `POST /tickets/:id/reassign` manual + `rerun_resolver` happy-path with `set_entity_assignment` `command_operations` + `routing_decisions` + `reassigned` activity + `ticket_assigned` domain event + assignee change (**P1-1** case side); SLA-escalation reassign — isolated case + policy + past-80%-not-overdue timer, cron-driven, asserts `sla:escalation:*` `command_operations`, assignee moved to escalate target, crossing anchor, and recurrence-safety (no re-fire across ≥1 extra tick) (**P0-2**); `routing.evaluation_required` → `routing_status` cleared to `idle` atomically + no spurious `assignment_changed` on same-assignee re-eval (**P1-2**) + the **same outbox event REDELIVERED still yields exactly 1 `routing_decisions` row** (`a2ProbeRoutingEvalClear`: `✓ routing-eval — same outbox event REDELIVERED, still exactly 1 routing_decisions row (Code-I1: ON CONFLICT DO NOTHING)`) — the handler `routing_decisions` insert is idempotent via the partial UNIQUE index `uq_routing_decisions_outbox_event` (migration `00429`, **Code-I1**, closed 2026-05-18, smoke 3× isolated); `GET /tickets/:id/children` cross-visibility — zero-privilege parent-case watcher EXCLUDES a vendor child while admin INCLUDES it (**P1-5**, non-vacuous: also asserts the watcher can read the parent); satisfaction round-trip — atomic via `update_entity_combined` (`patch:case:<id>:<crid>` + same `metadata_changed` activity) plus the negative `update_entity_combined.satisfaction_unsupported_for_work_order` on a real WO id (**P1-3**); reclassify happy-path + audit row.
>
> **`pnpm smoke:work-orders`** covers (final run 2026-05-17: **125 pass / 0 fail**, exit 0): `POST /work-orders/:id/reassign` team + vendor with `set_entity_assignment` `command_operations` + `routing_decisions` (work_order/manual) + assignee change (**P1-1** WO side + vendor-assignment e2e); `rerun_resolver` → documented `400 work_order.rerun_resolver_unsupported`; `POST /tickets/:id/dispatch` idempotency-replay (same WO id, exactly one `work_order` row, `dispatch:*` `command_operations`); WO cross-tenant isolation (Tenant-A WO unreachable read+mutate under Tenant-B header, row intact).
>
> **CONTENTION-DEFER:** none required in the final runs — every sub-assertion passed (the probe-3 crossing-anchor sub-assertion has an isolate-and-SKIP branch with a `[CONTENTION-DEFER]` evidence line if a shared-cron race ever makes that one ordering sub-assertion unattributable; on 2026-05-17 it was not triggered — the anchor row was observed for the isolated timer and the assignment + recurrence-safety outcomes passed independently).
>
> **No genuine product regression found.** One investigation surfaced that the seed `Employee` role (`type=employee`, empty `domain_scope='{}'`/`location_scope='{}'`) is treated by `work_order_visibility_ids`/`ticket_visibility_ids` as a tenant-wide *operator* tier (empty scope = unbounded — verified: it sees all 242 tenant cases + every `location_id IS NULL` work_order). That is the **intentional, pre-existing operator-scope semantics** (00374 is unmodified vs `main`; `smoke-cross-tenant.mjs` relies on the same seed user as a legitimate non-admin), **orthogonal to P1-5** (it applies equally to parent case and child WO). Using it would have made the P1-5 probe vacuous; the probe was corrected to use the zero-role planning-requester seed (`00381`, zero team/role/read_all) as the participant actor, which correctly demonstrates the fix.
>
> **Dispatch idempotency-replay — now a STRICT hard gate (2026-05-18).** The pre-existing B.2 dispatch defect (server-stamped `timers.due_at` in the dispatch idempotency `md5`, → spurious `payload_mismatch` 409 on legitimate replay once an SLA resolves) was **FIXED + SHIPPED**: migration `00428_dispatch_idempotency_intent_hash.sql` pushed + `pg_get_functiondef`-verified live (path-scoped `dispatch_strip_hash_server_fields` + `dispatch_idempotency_payload_hash`; both dispatch RPCs reproduced VERBATIM from the verified-latest v3 — `00341`/`00342` — with one `v_payload_hash` line changed). Probe 8 (`a2ProbeDispatchReplay` in `smoke-work-orders.mjs`) is now a **strict hard gate**: a transient `[KNOWN-DEFECT b2-dispatch-replay-sla-due_at]` carve-out existed only within the 2026-05-18 fix cycle and was **removed** before ship — replay MUST return 200/201 same WO id, replay `payload_mismatch` is a hard fail (proven GREEN 3/3 deterministic with fresh isolated fixtures). A runnable structural guard `apps/api/src/modules/ticket/dispatch.idempotency.spec.ts` (static migration-text scan, mirrors the 00407 booking-edit guard; 4/4) now blocks the stale-source-clobber regression class. **Also required:** any migration touching `dispatch_child_work_order` / `dispatch_child_work_orders_batch` / `dispatch_idempotency_payload_hash` / `dispatch_strip_hash_server_fields`. A genuine **sibling** of this bug-class on the WO + workflow-engine SLA-install path (via `update_entity_combined` v7) is **routed open** — `docs/follow-ups/i2-sla-install-idempotency-due_at-2026-05-18.md` (B.2 / SLA-restart owner); its gate is `pnpm smoke:tickets` (run in isolation — `smoke-tickets` has a documented FLAKE_INFRA under concurrent shared-DB load: green 5/5 isolated, no carve-out added).

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
- **Fixture E (audit-03 Slice 3, P0-2 multi-slot residual, Path B):** a **2-slot** booking (primary `ROOM_HUDDLE` + non-primary `ROOM_BOARD`) **plus the full linked-row graph** (1 catering order + 1 OLI + 1 boundary-aligned `asset_reservation` + 1 custom-window `asset_reservation` + 1 setup `work_order`), +135d.

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

**Fixture E is mandatory (audit-03 Slice 3 — P0-2 multi-slot residual, Path B):** this gate MUST include the **multi-slot SAFETY** Fixture E + `runFixtureEProbe`. After an `editOne` window-shift on a >1-slot booking, the probe asserts (post-edit DB reads, epoch compare — NOT http-200-only): **(i)** every linked child (order window, both asset_reservations, setup work_order) **AND the non-primary slot** are **UNCHANGED vs seed** — proves NO silent corruption (children were NOT shifted to a window the other slots never moved to — the honest skip, not generalized propagation, which is deferred-with-owner as **D-11**); **(ii)** exactly one **durable, tenant-scoped** `audit_events` row, `event_type = 'booking.linked_rows_not_propagated'`, `entity_id == bookingId`, `details.{reason:multi_slot_no_attribution, edit_kind:one, slot_count:2}` — the skip is no longer SILENT; **(iii)** clean 2xx + the response carries **NO invented wire field** (no `warnings`, no `_skipped_multi_slot_linked_rows` — the marker is stripped at the producer→RPC boundary; no migration, no RPC change, no response-wire change). It is a real fail-closed gate: any child moved OR the durable signal absent ⇒ a failed `passAssertion` ⇒ `results.fail` ⇒ exit 1. See `docs/follow-ups/audit03-deferred-multislot-decision.md`.

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

**Required before claiming complete:** any work touching `MultiRoomBookingService.createGroup` / the `POST /reservations/multi-room` route / its use of `create_booking_with_attach_plan` (migrations 00309 / 00315 / **00372** / **00431**) / the `validate_attach_plan_internal_refs` §7a `applied_rule_ids[]` snapshot validator (migration **00410**) / `BundleService.buildAttachPlan` (multi-room consumer) / `BookingFlowService.create` + `buildAttachPlan` (the audit-03 P2-3 no-services consolidation: ALL single-room — with OR without services — routes through `create_booking_with_attach_plan`; the legacy 20-arg `create_booking` RPC + `createApprovalRows` are deleted, revoked by **00432**) / the no-services FLAT approval builder / `ApprovalRoutingService.assemblePlan` chain-id derivation (C2) / the multi-room room-rule approval fan-out (`WorkflowService.start`) / the cross-room approval priority aggregation.

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
- (h)-(k) **audit-03 P2-3 no-services consolidation gate.** `smoke:recurrence-clone` seeds WITH services + forces `confirmed`, so the no-services pending-approval path was NEVER live-covered. P2-3 cut it over from the legacy `create_booking` RPC + best-effort `createApprovalRows` onto the combined RPC (migration **00431** extends its step-10 approvals INSERT 7→11 cols). Self-contained fixtures: 3 dedicated rooms + 2 dedicated room-scoped `require_approval` rules (one person-approver, one team-approver, with the admin user as the deterministic approver so the 00402 inbox trigger's `users` / `team_members` join finds a row) + a dedicated team + membership.
  - **(h)** no-services + NO approval rule → 2xx `status='confirmed'`, **0** approval rows, exactly 1 `attach_operations` row (proves the combined-RPC route), ≥1 slot.
  - **(i)** no-services + FLAT **person**-approver `require_approval` room rule → 2xx `status='pending_approval'`, ≥1 approvals row with `approval_chain_id IS NOT NULL` + `chain_threshold='all'` (matching rule config) + `approver_person_id` set + `status='pending'`, **≥1 `inbox_notifications` row** (THE exact P0 signal — pre-P2-3 the combined RPC's 7-col INSERT left `approval_chain_id=NULL` so the 00402 AFTER INSERT trigger silently skipped it → un-notified), exactly 1 `attach_operations` row, then `grant_booking_approval` resolves the chain (the row is real + wired, not an orphan).
  - **(j)** no-services + FLAT **team**-approver rule → `status='pending_approval'`, approval row with `approver_team_id` set + `approver_person_id NULL` + `approval_chain_id NOT NULL`, ≥1 `inbox_notifications` row via the 00402 **team** branch (`team_members` JOIN `users`).
  - **(k)** **C1-recurrence**: a recurrence-tagged combined-RPC create (`recurrence_series_id` + `recurrence_index=7`, a chain-bearing approval in the plan) invoked at the RPC boundary directly → the occurrence persists with its recurrence tags AND the approval row keeps `approval_chain_id` / `chain_threshold` / `parallel_group` (the 00431 INSERT must NOT special-case `recurrence_index` rows) + ≥1 inbox row for the occurrence. Asserted at the RPC boundary because the materialiser's master-confirmed/occurrence-approval-gated arrangement is fragile to seed drift; the boundary assertion is the precise C1-recurrence signal.
  - Fixture cleanup additionally sweeps `inbox_notifications` (keyed on `payload->>'booking_id'`), the dedicated `teams` / `team_members`, and the dedicated `room_booking_rules`.

Note: this gate also serves as a Slice-1/Slice-2 regression check — `MultiRoomBookingService` shares the reservations module + `BundleService.buildAttachPlan`, so a break here would also threaten `smoke:edit-booking` / `smoke:cancel-booking`.

---

## `pnpm smoke:attach-services`

**Required before claiming complete:** any work touching `BundleService.attachServicesToBooking` / the `POST /reservations/:id/services` route / `attach_services_to_existing_booking` RPC (migrations **00412** / **00413**) / its `attach_operations` idempotency gate / `BundleService.buildAttachPlan` + `hydrateLines` (the attach producer) / `buildAttachServicesIdempotencyKey` / `mapAttachRpcError`.

Script: `apps/api/scripts/smoke-attach-services.mjs`. Run via `pnpm --filter @prequest/api smoke:attach-services`.

This is the **P1-3 regression gate** (audit `docs/follow-ups/audits/03-booking-reservation.md`). It proves post-create service attach is now ONE atomic `attach_services_to_existing_booking` transaction (orders + order_line_items + asset_reservations + approvals + the guarded `setup_work_order.create_required` outbox emit) — replacing the pre-Slice-5 non-atomic TS N-write + reverse-order TS `Cleanup` undo-queue (the same data-loss class as the cancelOne bug). Decision + residuals: `docs/follow-ups/slice5-attach-services-decision.md`.

**Fixtures (psql-seeded, `session_replication_role='replica'`):** dedicated per-probe (+150d, clears sibling-smoke windows). 2 reservable rooms + a priced catering `catalog_item` + an AV `catalog_item` linked to a seeded `asset`/`asset_type` (service line `linked_asset_id` → 1 `asset_reservation`) + a `require_approval` `service_rules` row (catalog_item-scoped, always-true predicate, person approver). Each probe creates its OWN fresh no-services booking via `POST /api/reservations`, then attaches — so every assertion is a baseline→after delta keyed to that run's `booking_id` (multi-session-safe on the shared remote; outbox assertions key on `payload->>'booking_id'`, never a global count).

**Probes (8 probe groups; assertion count verified by the live run):**
- (1) atomic attach (catering + AV) → ≥1 order, exactly 2 OLIs (qty 8 + qty 1), exactly 1 asset_reservation, exactly 1 `attach_operations` row `outcome=success`, 0 approvals (plain items).
- (2) idempotency replay (same booking + same `X-Client-Request-Id`) → orders/OLIs/AR counts UNCHANGED, still exactly 1 `attach_operations` success row.
- (3) same `X-Client-Request-Id`, DIFFERENT payload → HTTP 409 `booking.idempotency_payload_mismatch`; zero new orders/OLIs; no qty=99 OLI ever persisted.
- (4) cross-tenant: Tenant-A JWT + Tenant-B `X-Tenant-Id` → reject (403/404/401, all correct rejects); zero orders for the booking under the wrong tenant and under `OTHER_TENANT_ID`.
- (5) missing `X-Client-Request-Id` → 400 (RequireClientRequestIdGuard); zero new orders.
- (6) **load-bearing atomicity gate** — a pre-seeded `confirmed` asset_reservation overlapping the window makes the RPC's AR INSERT trip the `asset_reservations_no_overlap` GiST exclusion (23P01) AFTER the catering order/OLI insert; asserts the request did NOT succeed AND ZERO partial rows (no orphan order, no OLI incl. no qty=5 OLI, no AR, no approval, `attach_operations` marker rolled back). A surviving partial row here is a REAL RPC bug — the probe fails loudly, never weakens.
- (7) require_approval `service_rules` rule → response `any_pending_approval=true`; ≥1 pending booking-targeted approval routed to the seeded approver; `setup_work_order.create_required` outbox SUPPRESSED for THIS booking (the RPC guards the emit on `NOT any_pending_approval`).
- (8) **D-6 producer-determinism (fail-closed gate)** — attach a catering line with a seeded LEAD-TIME-BOUNDARY `service_rules` rule (`lead_minutes_gt 60`) present, then REPLAY the SAME `X-Client-Request-Id` + body. Asserts the replay returned **2xx CACHED** (NOT a `booking.idempotency_payload_mismatch` 409 — a 409 here means the producer baked a wall-clock-derived value into the hashed plan = a D-6 regression), ZERO duplicate orders/OLIs, still exactly ONE `attach_operations` success row, and the net effect is exactly one logical attach. Fails loudly, never weakens.

**D-6 status — CLOSED (was "Known deferred"):** producer-determinism is fixed and gated. The attach idempotency basis is now the booking's server-immutable `created_at`; the create path uses a request-canonical `ActorContext.resolution_basis_at`; the predicate engine `lead_minutes_*` operators + the room/service resolver lead-time derivations all anchor on that one basis; the rule fetches are `id`-ordered (deterministic tie-break). Probe (8) is the live fail-closed attach gate; the create-path completeness proof is the jest guard `apps/api/src/modules/booking-bundles/bundle-attach-plan.determinism.spec.ts` (drives the real `BookingFlowService.buildAttachPlan` with a controlled clock — proves byte-stable `p_booking_input` + `p_attach_plan`). One residual is **deferred-with-owner, not silent**: the FE `X-Request-Time` pin (a same-crid create AUTO-retry across a lead-time boundary not resending the original instant — bounded because `query-client.ts` sets mutations `retry:false` app-wide). Decision + completeness proof: `docs/follow-ups/audit03-deferred-d6-decision.md`.

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

**Required before claiming complete:** any work touching `AuthGuard`, `AdminGuard`, `PermissionGuard`, the global tenant binding bridge, or any admin/config controller that previously read `TenantContext.current()` without bridging `auth_uid → users`. **Also required (R1 tertiary fold, 2026-05-20):** any work touching `PersonController.getMe` / `PersonService.getMe` / the `GET /api/persons/me` route — the gate's R1 probe (see below) catches both the original unwrapped-throw regression class AND the cross-tenant FK-leak class fixed in the same fold (the `users.person_id → persons(id)` FK at `supabase/migrations/00003_people_users_roles.sql:38` is NOT composite-tenant-scoped, so the persons read must explicitly re-assert `tenant_id`; the smoke probe asserts the 200/`person.id` contract end-to-end via the browser-token path).

Script: `apps/api/scripts/smoke-cross-tenant.mjs`.

**The gate this protects.** Pre-Slice-1 the `X-Tenant-Id` header was trusted with no JWT cross-check, so any authenticated user could read/write 9 admin-controller surfaces (workflow, routing-rules, sla-policies, etc.) in any tenant by flipping the header (`docs/follow-ups/audits/04-rls-security.md` P0 §`X-Tenant-Id` header trusted). Slice 1 (`auth.guard.ts`) bridges `auth_uid → public.users(id) WHERE tenant_id AND status='active'` and 403s mismatch with `auth.user_not_in_tenant`. Slice 2 layers `@UseGuards(AdminGuard)` on the 10 named admin controllers as belt+suspenders.

**Fixture:** TENANT_B (`00000000-0000-0000-0000-0000000000b1`) seeded directly via psql with `session_replication_role = 'replica'` to skip the drifted `trg_tenants_seed_retention` trigger. Idempotent — re-runs are no-ops.

**12 probes:**

- **Regression — own-tenant** (2): Tenant-A admin JWT + Tenant-A header → `GET /workflows` and `GET /routing-rules` return 200. Confirms the bridge didn't break the happy path.
- **Regression — bare auth** (1): no Bearer token → 401. Confirms AuthGuard still rejects unauthenticated requests.
- **P0 attack — cross-tenant GETs** (6): Tenant-A admin JWT + `X-Tenant-Id: TENANT_B` against the 6 admin GET endpoints from the audit (`workflows`, `routing-rules`, `sla-policies`, `space-groups`, `location-teams`, `domain-parents`) → all 403. Verified red-before-green: against pre-Slice-1 main these all returned 200 with target-tenant data.
- **Slice 1 + Slice 2 belt+suspenders — cross-tenant POSTs** (3): same JWT + cross-tenant header, with a write body → 403 on `workflows`, `routing-rules`, `sla-policies`. Safe to run continuously because AuthGuard rejects before the controller / RPC sees any body (no attacker rows land in Tenant B).

**Known gap deferred to Slice 3.b:** no same-tenant non-admin probe. Requires a second auth fixture (non-admin user in TENANT_A) we don't seed yet. Once added, will assert that AdminGuard (Slice 2) rejects non-admin same-tenant POSTs even when the bridge (Slice 1) passes.

**Also covers — browser-path RLS-helper EXECUTE regression (blanket-REVOKE-EXECUTE / 00435-outage class):** beyond the cross-tenant/AdminGuard probes above, this gate now also exercises the browser/Realtime read path the prior service_role-only probes never touched. Three additions (see `docs/follow-ups/audits/04-rls-security.md` → 2026-05-19 incident block; migrations `00434`/`00435`/`00436`, formerly `00415`/`00417`/`00420` per the renumber table there):

- **Browser-path RLS read** (3): a real authenticated browser JWT (minted via the existing magiclink→verify helper) does a plain PostgREST `GET /rest/v1/{inbox_notifications,bookings,tickets}?select=id&limit=1` → must be HTTP 200 with no `permission denied for function` in the body. This is the probe that would have caught the 2026-05-19 P0 outage end-to-end: migration `00435`'s blanket `REVOKE EXECUTE ON ALL ROUTINES ... FROM anon, authenticated` revoked EXECUTE on `public.current_tenant_id()`, and since Postgres checks function EXECUTE as the querying role even for `SECURITY DEFINER`, every authenticated browser/Realtime RLS read died with `42501`. Service_role / NestJS-API path probes bypass this check entirely. **Failure labels — three named classes (R3 precision fold, 2026-05-20; mirrors `smoke:prod-e2e` vocabulary):** `42501-rls-helper` (body contains `permission denied for function` OR JSON `code === '42501'` — the catastrophic 00435-outage class), `postgrest-4xx` (HTTP 4xx with a JSON envelope whose `code` is NOT `42501` — e.g. `42P01` table not found, `42703` column not found, `PGRST116`, JWT errors — unrelated to RLS-helper EXECUTE), `transport-or-5xx` (HTTP >= 500, non-JSON body, or fetch threw — cold-start / gateway / unreachable). Fail-closed binary outcome preserved across all three.
- **RLS-helper EXECUTE posture** (1): asserts `current_tenant_id` / `current_user_id` / `user_has_permission` remain browser-EXECUTE-able for both `anon` and `authenticated` (the RLS-correct inverse of the old "zero browser-EXECUTE-able app routines" assertion, which encoded the catastrophic `00435` state and went RED against the correct post-`00436` `main`).
- **Narrow per-function lock retained** (1): browser-direct `POST /rest/v1/rpc/tickets_distinct_tags` with a foreign tenant arg → non-2xx (the one proven cross-tenant leak stays `service_role`-only per `00436`).

**Also covers — Realtime channel CDC path (R4 fold, 2026-05-20):** the prior browser-path probe exercised the REST/PostgREST leg of `anon`/`authenticated`'s read surface; the Supabase Realtime channel path (a SEPARATE execution context — `realtime.list_changes` per-subscriber RLS, on a publication, over a WebSocket) was NOT exercised end-to-end. The May-19 outage broke "every browser/Realtime RLS read"; a future regression that only manifests on the Realtime leg (publication membership drift, replication-slot stall, an RLS-helper EXECUTE regression that the REST leg masks, or a Supabase Realtime backend outage) would still ship undetected against the REST-only probe.

- **Realtime channel CDC probe** (1): under a fresh ADMIN browser JWT, the probe opens a Supabase Realtime channel on `public.inbox_notifications` (publication-included per migration `00401`), service-role INSERTs one fixture row (unique per-run `randomUUID()`, `event_kind = 'r4-probe-realtime-cdc'`), and asserts the CDC event arrives at the channel callback within 15s (warm path P99 < 1s; ceiling absorbs broker-provisioning jitter without masking real outages). The probe scopes a tenant_id claim onto ADMIN's `raw_app_meta_data` immediately before minting and unconditionally strips it in `finally` (Supabase Auth's `updateUserById({ app_metadata })` MERGES rather than replaces — the restore sends `{ tenant_id: null }` to actually delete the key, which is both deterministic on success and idempotently self-healing if a prior run crashed mid-probe). **Four named failure classes (mirrors the R3 three-class vocabulary so the gate speaks one language):** `realtime-channel-subscribe-failed` (the WS handshake never reached `SUBSCRIBED` — Realtime auth or proxy broken for browser sessions); `realtime-cdc-timeout` (subscribed but the event never arrived in 15s — Realtime-leg RLS-helper EXECUTE regression, publication membership drift, replication-slot stall, or Realtime backend outage); `realtime-payload-mismatch` (event arrived but the `id` doesn't match the fixture); `realtime-leak-foreign-tenant` (defense-in-depth: event arrived but `tenant_id` is foreign — under correct RLS this can't fire, but the label exists so a future cross-tenant Realtime leak surfaces loudly instead of as a generic mismatch). Per-run fixture UUIDs + `finally` teardown hit the SHARED REMOTE DB; `select count(*) from public.inbox_notifications where event_kind like 'r4-probe-%'` MUST return 0 after every run.

**Also covers — R1 `/api/persons/me` unwrapped-throw regression (handoff-residuals 2026-05-20):** the prod incident was a `GET /api/persons/me` returning `HTTP 500 {"code":"unknown.server_error",...}` because no `@Get('me')` route existed — the `@Get(':id')` pattern captured `'me'`, Postgres rejected it as an invalid UUID, and the raw error fell through to the global filter as the catch-all `unknown.server_error`. The same browser-token branch above now asserts:

- **`/api/persons/me` returns 200 with person.id** (1): authenticated browser token → `GET ${API_BASE}/api/persons/me` → 200 with a JSON body containing a non-empty `id`. Distinguishes three regression classes in the failure label: `unknown.server_error` (the original R1 bug regressed — raw throw in the persons-me path), non-200 with any other code (an AppError shape did surface but the endpoint is still broken), wrong body shape (no `id`).

**Parallel safety (F2 fold, 2026-05-20):** the gate hits SHARED REMOTE DB state — the Slice 11.2b/11.4/11.5 proof seeds a role with `spaces.create` + `request_types.use` + `visitors.configure` onto a SHARED `NONADMIN_USER_ID` and the Slice-9/10 negative probes (`POST /spaces` / `POST /admin/visitors/types` expect 403) assume that user holds none of those keys. Two concurrent gate runs therefore race in two ways: (a) static fixture UUIDs collide on `on conflict (id) do update` and the proof-space teardown (`delete from public.spaces where ... name = '<static>'`) cross-deletes the other run's row; (b) the proof seed grants permissions to the shared user, and any parallel negative-403 probe running during that window incorrectly 2xxs. The fix has two layers:

- **Per-run UUIDs for fixture-row hygiene.** `PROOF_ROLE_ID`, `PROOF_ASSIGNMENT_ID`, `IDOR_NOTIF_ID`, `SELF_GRANT_INSERT_ID` are now `randomUUID()` at script load. The Slice-11.2b proof-space name is `xtenant-11.2b-proof-${randomUUID()}` (teardown deletes by name, not row id). This layer addresses (a) and makes crash-leaked rows trivially identifiable.
- **Script-level advisory lock** (`pg_try_advisory_lock(0x58544e54 /* 'XTNT' */)`) acquired BEFORE any probe runs and released in `finally`. Session-scoped so it dies with the psql child on SIGKILL/OOM (no orphan-lock risk). On contention the second run logs `cross-tenant-skipped-concurrent-run — another smoke:cross-tenant run holds the script advisory lock; this run is a no-op to avoid racing the shared-DB fixture seeds. Exiting 0.` and exits 0. This layer addresses (b) — per-run UUIDs by themselves cannot prevent the user-permission overlap, because both runs would still grant the same keys to the shared user during their respective seed-to-teardown windows.

The R4 Realtime probe's pre-existing internal advisory lock (`R4_ADVISORY_LOCK_KEY = 0x52345200`) is preserved as a separate concern (scoped to the ADMIN `raw_app_meta_data.tenant_id` mutation in the realtime channel probe). With the script-level lock holding the outer mutex, the R4 lock is now functionally a no-op (only one run can ever reach the realtime probe), but it stays in place so that any future code path that exercises R4 outside the script-lock boundary remains race-safe.

Choosing skip-and-exit-0 (rather than block-and-wait) matches the R4-internal pattern and means CI/dev never blocks indefinitely on a stuck prior run.

---

## `pnpm smoke:prod-e2e`

**Required after every prod deploy, and before claiming any backend bug fix is live in prod.** This is the post-deploy "did prod come up green for an authenticated browser session" gate.

Script: `apps/api/scripts/smoke-prod-e2e.mjs`. Default target: `https://xpqt-api-eu.onrender.com` (`PROD_BASE` env override).

**The gate this protects.** Every other smoke gate in this repo hits a dev API (`http://localhost:3001`/`:3010`). They cannot catch a route that:
- builds + typechecks cleanly,
- passes service-role-path probes,
- but throws an unwrapped (non-`AppError`) exception under a real authenticated browser JWT on the deployed instance.

That exact failure mode shipped on 2026-05-20: `/api/persons/me` returned `HTTP 500 unknown.server_error` and sat invisible until a transient `_prod-e2e-verify.mjs` was hand-rolled outside the smoke-gate set. R5 of `ai/handoff-residuals-2026-05-20.md` carved out the reusable gate. PR #36 (R1) fixes the underlying bug.

**Read-only by design.** No fixtures seeded, no rows written, no teardown. Safe to run against prod after every deploy and from CI without coordination.

**Cold-start tolerance.** Render free-tier services can take >30s to wake. Each probe gets `PROD_E2E_TIMEOUT_MS` (default 45s) per try and one automatic retry (`PROD_E2E_RETRIES`, default 1) on transient failure. The retry trigger is BOTH a transport throw (timeout / DNS / non-HTTP) AND a 5xx-gateway response (`502` / `503` / `504`) — Render's cold-start path can return either, and treating a cold-start 503 as a real `http-status` outage is the regression class R3 (codex tertiary) carves out. On retry exhaustion the failure CLASS is preserved (transport vs http-status); only the retry trigger is unified. Two consecutive transient fails still red the gate — this absorbs spin-up jitter, not real outages.

**Three named failure classes** (mirrors the R3 precision model in `smoke:cross-tenant`):
- **`transport`** — fetch threw (DNS / network / abort / non-HTTP). Surface: the underlying reason or `timeout after Nms`.
- **`http-status`** — got a response, status !== 200. Surface: status + first 200 chars of body.
- **`body-shape`** — got 200 + JSON, but the response shape doesn't match the contract. Surface: which field was missing or had the wrong type.

The same binary green/red outcome holds; the label tells the on-call which layer failed.

**4 probes:**

- **`GET /api/health`** (no auth) → HTTP 200 + `{ status: "ok" }`. Catches: the deploy built but the API process isn't healthy.
- **`GET /api/me/inbox`** (minted browser JWT) → HTTP 200 + `{ items: InboxItemDto[], nextCursor: string | null }`. Catches: AuthGuard / AsyncLocalStorage tenant binding / `InboxService.resolveActor` regressions on the real authenticated path.
- **`GET /api/me/inbox/count`** (minted browser JWT) → HTTP 200 + `{ unread: number, total: number }`. Catches: per-route NestJS exception filter / DTO contract drift on the count surface.
- **`GET /api/persons/me`** (minted browser JWT, gated by `R1_LANDED=1`) → HTTP 200 + `{ id: string, … }`. Gated until PR #36 (`fix/persons-me-apperror`) merges and prod redeploys — the route returns 500 pre-merge. Flip `R1_LANDED=1` once the redeploy is live; no code change required.

**JWT mint** mirrors `smoke-cross-tenant.mjs`: Supabase admin magiclink → verify-redirect access_token, for `ADMIN_AUTH_UID=93d41232-35b5-424c-b215-bb5d55a2dfd9` (default; override via `PROD_E2E_AUTH_UID=<uuid>` if the canonical user is rotated or deactivated — replacement MUST be an active admin in the canonical tenant). Requires `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY` in `.env` (or the process env, for CI). No `JWT_SECRET` required — the Supabase admin client mints session tokens server-side. The minted token is NEVER logged (not even a prefix) — log surfaces only `admin browser JWT minted (token redacted)`. Verify-redirect parse failures surface only the redirect origin, never the full URL.

**Not covered (by design):**
- Writes. This is a read-only gate. Write-path coverage stays in the dev-API smoke gates.
- Realtime channel. The Realtime regression class is covered by `smoke:cross-tenant`'s browser-path RLS probe.
- Cross-tenant attacks. Same — `smoke:cross-tenant` is the gate for that class.
- Per-tenant data correctness. Prod data drift is out of scope; this gate is "is the API answering at all under a real session."

**Exit codes:** 0 = all probes green. 1 = at least one probe red (any class). 2 = uncaught exception (treat as red).
