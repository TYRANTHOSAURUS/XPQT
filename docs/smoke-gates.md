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
