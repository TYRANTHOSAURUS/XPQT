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
> **`pnpm smoke:tickets`** covers (final run 2026-05-17: **121 pass / 0 fail**, exit 0): `PATCH /tickets/bulk/update` 200/207/422 + per-id `command_operations` (fingerprint-folded `patch:case:<id>:<crid>:<fp>`) + idempotent replay no-double-write (**P0-1**); `POST /tickets/:id/reassign` manual + `rerun_resolver` happy-path with `set_entity_assignment` `command_operations` + `routing_decisions` + `reassigned` activity + `ticket_assigned` domain event + assignee change (**P1-1** case side); SLA-escalation reassign — isolated case + policy + past-80%-not-overdue timer, cron-driven, asserts `sla:escalation:*` `command_operations`, assignee moved to escalate target, crossing anchor, and recurrence-safety (no re-fire across ≥1 extra tick) (**P0-2**); `routing.evaluation_required` → `routing_status` cleared to `idle` atomically + no spurious `assignment_changed` on same-assignee re-eval (**P1-2**); `GET /tickets/:id/children` cross-visibility — zero-privilege parent-case watcher EXCLUDES a vendor child while admin INCLUDES it (**P1-5**, non-vacuous: also asserts the watcher can read the parent); satisfaction round-trip — atomic via `update_entity_combined` (`patch:case:<id>:<crid>` + same `metadata_changed` activity) plus the negative `update_entity_combined.satisfaction_unsupported_for_work_order` on a real WO id (**P1-3**); reclassify happy-path + audit row.
>
> **`pnpm smoke:work-orders`** covers (final run 2026-05-17: **125 pass / 0 fail**, exit 0): `POST /work-orders/:id/reassign` team + vendor with `set_entity_assignment` `command_operations` + `routing_decisions` (work_order/manual) + assignee change (**P1-1** WO side + vendor-assignment e2e); `rerun_resolver` → documented `400 work_order.rerun_resolver_unsupported`; `POST /tickets/:id/dispatch` idempotency-replay (same WO id, exactly one `work_order` row, `dispatch:*` `command_operations`); WO cross-tenant isolation (Tenant-A WO unreachable read+mutate under Tenant-B header, row intact).
>
> **CONTENTION-DEFER:** none required in the final runs — every sub-assertion passed (the probe-3 crossing-anchor sub-assertion has an isolate-and-SKIP branch with a `[CONTENTION-DEFER]` evidence line if a shared-cron race ever makes that one ordering sub-assertion unattributable; on 2026-05-17 it was not triggered — the anchor row was observed for the isolated timer and the assignment + recurrence-safety outcomes passed independently).
>
> **No genuine product regression found.** One investigation surfaced that the seed `Employee` role (`type=employee`, empty `domain_scope='{}'`/`location_scope='{}'`) is treated by `work_order_visibility_ids`/`ticket_visibility_ids` as a tenant-wide *operator* tier (empty scope = unbounded — verified: it sees all 242 tenant cases + every `location_id IS NULL` work_order). That is the **intentional, pre-existing operator-scope semantics** (00374 is unmodified vs `main`; `smoke-cross-tenant.mjs` relies on the same seed user as a legitimate non-admin), **orthogonal to P1-5** (it applies equally to parent case and child WO). Using it would have made the P1-5 probe vacuous; the probe was corrected to use the zero-role planning-requester seed (`00381`, zero team/role/read_all) as the participant actor, which correctly demonstrates the fix.

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
