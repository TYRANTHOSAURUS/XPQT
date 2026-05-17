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
