# 08 — Smoke / Test-Coverage Audit

**Date:** 2026-05-13
**Auditor scope:** does the test + smoke pyramid prove the architecture against real DB behavior, or only against mocks?
**Method:** read every `apps/api/scripts/smoke-*.mjs` source end-to-end; sample ~30 `*.spec.ts` files across all 9 critical domains; cross-reference canonical RPCs (16 of them, 00309–00399) against probe surface; read `docs/smoke-gates.md`, `AGENTS.md`, `CLAUDE.md` smoke section, `apps/api/test/concurrency/*` config + harness.

---

## Executive verdict

**Smoke coverage is excellent for the four explicitly-gated areas — work-orders, edit-booking, edit-booking-scope, floor-plans — and is genuinely catching real-DB regressions that mocked-jest cannot.** The probes are dense, do current-row-XOR-sentinel writes, assert `command_operations` outcomes, exercise cross-tenant smuggling, idempotency replay, payload-mismatch, parallel races, and CAS. This is best-in-class for a NestJS+Supabase stack.

**But: ~60% of the canonical RPC surface still has zero live-API happy-path smoke.** Specifically:

- `create_ticket_with_automation` (00349/50/51) — the ticket-creation orchestrator with full automation fan-out. Mocked-jest only.
- `grant_ticket_approval` (00356/57/58) — case approval grant path. Mocked-jest only. (`POST /approvals/:id/respond` is touched in smoke-tickets ONLY with a ghost UUID for guard coverage — never as a happy-path approval grant.)
- `grant_booking_approval` (00310) — booking approval grant path. Mocked + concurrency-only (local DB).
- `approve_booking_setup_trigger` (00311) — post-grant setup-WO trigger. Mocked + concurrency-only.
- `reclassify_ticket` (00354/55) — case reclassification. `POST /tickets/:id/reclassify` is touched ONLY with a ghost request_type id for guard coverage — never as a happy-path reclassify.
- `dispatch_child_work_order` / `dispatch_child_work_orders_batch` (00336–42) — happy-path dispatch IS in smoke-work-orders + smoke-tickets, but the BATCH variant is not.
- `delete_booking_with_guard` (00292) — booking cancel/delete. ZERO smoke.
- `create_pm_work_order` (00389/97/98) — PM generator. Internal probe inside smoke-work-orders (`runPmGeneratorProbes`) covers it via direct RPC + service, which is good; not via the cron path.
- Visitor module HTTP surface (~25 POST/PATCH/DELETE endpoints across `visitors.controller`, `reception.controller`, `kiosk.controller`, `admin.controller`) — ZERO smoke. State-machine "single-write-path" enforcement is unit-tested but never validated against the real DB through HTTP.
- Vendor portal HTTP surface (magic-link `redeem`, order status, decline) — ZERO smoke. Magic-link auth + PII-minimisation are the two things mocks cannot catch.
- Bundle cascade on cancel (visitor cascade on booking cancel; orders cascade; approvals cascade) — ZERO smoke.

**Smoke gates that exist are not registered in CLAUDE.md.** `pnpm smoke:tickets` (1236 lines, the most comprehensive probe in the repo, ships approval/SLA/state-machine coverage) and `pnpm smoke:outbox` (full booking→outbox→handler→work-order roundtrip) are NOT in the CLAUDE.md "Smoke gates (mandatory before claiming ship)" matrix. They run and pass; they're just invisible to the workflow. A future engineer reading CLAUDE.md will run 4 of 6 gates and feel safe.

**Fixture purity is high but the wrong direction.** Most booking smokes intentionally avoid linked rows (services, orders, work_orders, approvals) so the probe scope is narrow. That's correct for the unit-of-test discipline — BUT the "services dropped silently on POST /reservations" failure mode (project_booking_composer_delta_shipped memory) is exactly the bug that a clean fixture would miss. Only `smoke-outbox-roundtrip` exercises a booking with a linked service, and only for the single rule path (`requires_internal_setup=true` + `effect=allow`). The other 7 branches in §3.6.5 (require_approval transitions) are pinned by `smoke-edit-booking`'s approval-flip probe, but the CREATE side is unprotected.

**Bottom line: the 4 named gates are world-class. The other 60% of the write surface relies on the same mocked-jest pattern that the 2026-05-01 P0 incident proved doesn't catch real-DB failures.** Add four targeted probes (below) and the pyramid is sound.

---

## Coverage matrix

Legend: ✅ full live-HTTP smoke · 🟡 partial (guard-only / cleanup-only / via fixture seed not HTTP) · ❌ none · 🧪 local-only (concurrency harness, not remote)

| Domain | Live HTTP smoke? | Linked-row fixture? | Cross-tenant cases? | Idempotency replay? | Race / concurrency? | Post-write DB validation? |
|---|---|---|---|---|---|---|
| **Booking — create** | 🟡 only via `smoke-outbox-roundtrip` happy path | 🟡 1 service line, 1 rule, allow-only | ❌ | ❌ | 🧪 (local) | ✅ booking + slots + orders + OLIs + attach_operations rows |
| **Booking — editOne / editSlot** | ✅ `smoke-edit-booking` | 🟡 deliberately NO services (per script header §6) | ✅ cross-tenant space + person + team | ✅ + payload-mismatch | ✅ pin via op-discrimination | ✅ command_operations + bookings/slots row state |
| **Booking — editScope** | ✅ `smoke-edit-booking-scope` | 🟡 recurrence_series + 5 occurrences, no services | ❌ | ✅ + splitSeries non-idempotency | 🧪 (local) | ✅ command_operations + new series + occurrences |
| **Booking — cancel / delete** | ❌ | n/a | ❌ | ❌ | ❌ | ❌ |
| **Booking — approval flip via edit** | ✅ `smoke-edit-booking` approval-flip probe | ✅ rule b0010002 fixture | ❌ | ❌ | ❌ | ✅ approvals + inbox + outbox rows + chain_id match |
| **Booking — approval grant** (`grant_booking_approval`) | ❌ `POST /approvals/:id/respond` only guard-tested with ghost UUID | n/a | ❌ | ❌ | 🧪 (local) | ❌ |
| **Booking — setup-WO emit on grant** (`approve_booking_setup_trigger`) | ❌ | n/a | ❌ | ❌ | 🧪 (local) | ❌ |
| **Ticket / case — PATCH** | ✅ `smoke-tickets` | n/a (mutation surface) | ✅ TENANT_B user smuggling probe (real fixture, not just ghost) | ✅ + payload-mismatch + body-byte-identity | ❌ | ✅ command_operations + post-state read |
| **Ticket — create** (`create_ticket_with_automation`) | ❌ guard-only (empty body, missing header) | n/a | ❌ | ❌ | 🧪 (local) | ❌ |
| **Ticket — reclassify** (`reclassify_ticket`) | ❌ guard-only (ghost request_type id) | n/a | ❌ | ❌ | 🧪 (local) | ❌ |
| **Ticket — grant approval** (`grant_ticket_approval`) | ❌ | n/a | ❌ | ❌ | 🧪 (local) | ❌ |
| **Ticket — dispatch (single child WO)** | ✅ `smoke-work-orders` POST dispatch | n/a | ❌ | ❌ | 🧪 (local) | ✅ created.id + cleanup |
| **Ticket — dispatch batch** | ❌ | n/a | ❌ | ❌ | 🧪 (local) | ❌ |
| **Ticket — state machine + terminal stamps** | ✅ `smoke-tickets` runStateMachineProbes (close→reopen→resolve cycle) | n/a | ❌ | ❌ | ❌ | ✅ resolved_at / closed_at coalesce contract |
| **Work order — PATCH (status/priority/plan/sla/title/tags/cost/assign)** | ✅ `smoke-work-orders` (2749 lines, the most thorough probe) | n/a | ✅ ghost + malformed UUID matrix | ✅ | ✅ plan_version race + source-hash race | ✅ command_operations + current-row XOR sentinel |
| **Work order — PM generator (cron path)** | 🟡 internal probe (`runPmGeneratorProbes`) via direct RPC + service-layer call, not via cron | ✅ seeds asset_type + N assets, 7 scenarios | ✅ tenant_B request_type scenario | ✅ ON CONFLICT DO NOTHING | ❌ | ✅ work_orders row + last_generated_at advance |
| **Floor plan** | ✅ `smoke-floor-plans` (1020 lines) | ✅ fabricates floor + room + sibling | ✅ TENANT_B reads tenant A draft (P9) | ❌ | ✅ parallel publish (P15) + CAS If-Match (P16) | ✅ signed URL freshness + history rows + post-cancel availability |
| **Floor plan — direct REST bypass** | ✅ P20 direct PostgREST INSERT blocked | n/a | ✅ | ❌ | n/a | ✅ |
| **Visitor — invite / cancel / check-in / kiosk / pass-pool** | ❌ | n/a | ❌ | ❌ | ❌ | ❌ (all unit + integration-mocked) |
| **Visitor — bundle cascade on booking cancel** | ❌ | n/a | ❌ | ❌ | ❌ | ❌ |
| **Approval — chain / parallel / respond** | ❌ guard-only on `/respond` | n/a | ❌ | ❌ | 🧪 grant_*_approval (local) | ❌ |
| **Workflow — spawn-wake (booking.created → workflow_instances)** | ❌ (Phase 1 universal-workflow shipped; outbox handler exists; no live smoke) | n/a | ❌ | ❌ | ❌ | ❌ |
| **Workflow — cancel cascade (booking.cancelled)** | ❌ | n/a | ❌ | ❌ | ❌ | ❌ |
| **Outbox — full producer→worker→handler roundtrip** | ✅ `smoke-outbox-roundtrip` 1 event_type (`setup_work_order.create_required`) | ✅ rule + lsr + booking + OLI | ❌ | 🟡 attach_operations idempotency soft-asserted | ❌ | ✅ outbox event + processed_at + WO + dedup row + audit |
| **Outbox — other event types** (`booking.approval_required`, `sla.timer_recompute_required`, `booking.location_changed`, `routing.evaluation_required`, `workflow.spawn_required`, etc.) | ❌ (asserted as ROW PRESENT only inside smoke-edit-booking; no worker-drain assertion) | n/a | ❌ | ❌ | ❌ | 🟡 row-present only, no terminal-state validation |
| **Vendor portal** | ❌ | n/a | ❌ | ❌ | ❌ | ❌ |
| **Daily list (`pnpm daily-list:*`)** | ❌ | n/a | ❌ | ❌ | ❌ | ❌ |
| **Search (`POST /search`)** | ❌ | n/a | ❌ | ❌ | ❌ | ❌ |

---

## Top smoke gaps ranked by severity

### P0 — would catch the next 2026-05-01-class P0

1. **`create_ticket_with_automation` (00351 v3) end-to-end smoke.**
   Mocked-jest specs in `apps/api/src/modules/ticket/ticket.controller.spec.ts` + `dispatch.service.spec.ts` mock supabase.from / supabase.rpc. The RPC has been revved three times in two weeks (00349/50/51) and each rev modifies SQL invariants (assignment fan-out, routing resolver call, workflow spawn emit). Mocked tests passed across all three revs; a missing `service_role` grant on the new outbox event_type would slip past mocks. NO live HTTP probe currently exists.

2. **`grant_ticket_approval` (00358 v3) + `grant_booking_approval` (00310) live-HTTP happy path.**
   `POST /approvals/:id/respond` is touched in smoke-tickets ONLY with a ghost UUID — that exercises the controller guard, NOT the RPC. The two RPCs underpin every approval flow (booking approval flip → respond → either approved or rejected → either setup-WO emit fires OR cancellation cascades fire). Concurrency tests exist against LOCAL Supabase (`apps/api/test/concurrency/grant_*_approval.spec.ts`) but the smoke harness against REMOTE never exercises the controller path. A schema drift between local and remote (e.g. an unmigrated `00357 → 00358` revision on prod) would not surface.

3. **`smoke:tickets` and `smoke:outbox` not in CLAUDE.md "mandatory" matrix.**
   Both probes are runnable, are pass-green, and cover load-bearing surface (smoke-tickets does the state-machine cycle + terminal-stamp preservation + 8 guard endpoints + cross-tenant assignment smuggling; smoke-outbox does the full producer→worker→handler roundtrip). CLAUDE.md lines 47–51 list only 4 of the 6 smoke scripts. A future engineer reading the docs will skip the two that aren't on the list. **The fix is a one-line doc update + lift smoke:outbox to mandatory for any work touching combined RPCs or outbox handlers.**

### P1 — would catch silently-dropped writes

4. **Booking-create with linked services (full fan-out) live HTTP smoke.**
   `smoke-outbox-roundtrip` covers ONE happy path (1 rule, allow, 1 service line). It does not cover:
   - Booking with services that trigger `require_approval` rule (the §3.6.5 Row 2 path on CREATE, not just EDIT).
   - Booking with services that trigger `deny` rule (the create_booking_with_attach_plan §10.b deny-on-create path).
   - Booking with 2+ services hitting different vendors (multi-OLI fan-out).
   - Booking with services + visitors (bundle cascade insert into visitors table; the `project_booking_composer_delta_shipped` memory specifically notes "services were silently dropped on POST /reservations" — that exact bug had to be caught by a UI test because no smoke covered linked-services CREATE).

5. **Booking cancel / `delete_booking_with_guard` (00292) live HTTP smoke.**
   Zero coverage. Cancel emits a chain of outbox events (booking.cancelled → workflow.cancel_required → cascade to orders/OLIs/visitors/work_orders). The whole cascade depends on the trigger firing correctly. Mocked-jest cannot verify the cascade. `smoke-outbox-roundtrip` explicitly avoids the cancel path ("cancel emits its own events and we want a clean tear-down" — line 337).

6. **Workflow spawn-wake roundtrip live HTTP smoke.**
   Phase 1 universal-workflow shipped 2026-05-12 (HEAD 784d8d9c per memory). New producers (`booking.created`, `booking.cancelled`) and the `WorkflowSpawnWakeHandler` with atomic per-row claim — all critical-path. Concurrency tests exist; no live HTTP probe. The `condition_met` / `parent_cancelled` / `timeout` paths each have their own subtle SQL contract and PostgREST `.gt.now()` was a real bug 24 hours ago (per memory).

### P2 — would catch tenant-leakage variants

7. **Cross-tenant probes on the booking RPCs.**
   `smoke-edit-booking` covers cross-tenant space + person + team — but `smoke-edit-booking-scope` does not. `smoke-outbox-roundtrip` doesn't. `smoke-floor-plans` covers cross-tenant draft reads (P9) but not cross-tenant `space_id` in availability queries. The visibility-gate-lateral memory (`feedback_visibility_gate_lateral`) flagged this exact class of bug as a P0 security incident.

8. **Visitors HTTP surface — ZERO live smoke.**
   `project_visitors_v1_shipped` memory: 38 commits, 25 migrations, state-machine single-write-path enforced via session marker. The session-marker enforcement is exactly the kind of trigger-based invariant that mocked-jest can't catch. `visitors.integration.spec.ts` is hermetic (mocked services).

### P3 — would catch payload-shape drift

9. **Outbox event-type-specific roundtrips.**
   Only `setup_work_order.create_required` is exercised end-to-end. The other event types (`booking.approval_required`, `sla.timer_recompute_required`, `routing.evaluation_required`, `workflow.spawn_required`, `booking.location_changed`, `booking.cost_changed`, etc.) are only row-asserted in `smoke-edit-booking` — the probe verifies the row WAS emitted but does NOT wait for `processed_at` / verify the downstream handler fired. A handler that crashes on a payload field would dead-letter silently.

10. **Vendor portal magic-link redemption + status updates.**
    The vendor portal is in a separate codebase (memory: `project_vendor_portal_separate_codebase`) but its API endpoints (`POST /api/vendor/auth/redeem`, `POST /api/vendor/orders/:id/status`, `POST /api/vendor/orders/:id/decline`) live in `apps/api/` and are exposed to this app's smoke harness. Magic-link auth + PII-minimisation are the two things mocks cannot validate (token shape, JWT signature path, PII redaction in the response). Zero smoke.

---

## Proposed new smoke probes

### New: `pnpm smoke:create-booking-with-services`

**File:** `apps/api/scripts/smoke-create-booking-with-services.mjs`

**Fixture (psql-seeded):**
- One service rule of effect=`require_approval` on a known catalog_item, applies_when={and:[]} (always-match).
- One service rule of effect=`deny` on a different catalog_item (for negative probe).
- A pre-existing Noor person + user (already in 00133 seed) as the approver.
- A clean tenant-default `location_service_routing` row for the catering category (or assert that one exists).

**Probes (8):**

| # | Action | Expected outcome | DB-state assertion |
|---|---|---|---|
| 1 | POST /reservations with 1 require_approval service line | 200, status=`pending_approval` | 1 bookings row + 1 slot + 1 order + 1 OLI + 1 approvals row + 1 outbox `booking.approval_required` event + 1 inbox_notifications row for Noor |
| 2 | POST /reservations with 1 deny service line | 422 `service_rule.deny_on_create` | NO bookings / orders / OLIs / outbox rows (partial-write check via tenant-scoped count delta) |
| 3 | POST /reservations with 2 services hitting different vendors | 201 | 1 booking + 1 slot + 2 orders (vendor-split) + 2 OLIs + 0 approval rows + 0 setup-WO emits (allow path) |
| 4 | POST /reservations with allow + require_approval mix | 200, status=`pending_approval` | 1 approvals row, only for the require_approval line |
| 5 | Same POST replayed with same X-Client-Request-Id + same body | 201 byte-identical body | attach_operations.outcome=success with cached_result populated; NO duplicate bookings row |
| 6 | Same POST replayed with same X-Client-Request-Id + DIFFERENT body | 409 `command_operations.payload_mismatch` (or `attach_operations.payload_mismatch`) | NO new rows; original booking intact |
| 7 | POST /reservations with cross-tenant space_id (real tenant B space, seeded) | 422 `validate_entity_in_tenant.space_not_in_tenant` | NO bookings row; tenant_id leak check |
| 8 | POST /reservations omitting X-Client-Request-Id | 400 `client_request_id.required` | NO rows |

**Pass criteria:** all 8 probes exit 0; cleanup deletes all created bookings + cascade + approval rows + outbox events.

**Trigger files to make this MANDATORY:** `apps/api/src/modules/reservations/booking-flow.service.ts` · `bundle.service.ts` (build-attach-plan path) · `apps/api/src/modules/booking-bundles/**` · migration touching `create_booking_with_attach_plan` (currently 00309 + 00315) · migration touching `service_rules` shape.

---

### New: `pnpm smoke:approvals`

**File:** `apps/api/scripts/smoke-approvals.mjs`

**Fixture (psql-seeded):**
- Two bookings, both already at status=`pending_approval` with 1 approvals row each (chain_id distinct).
- One CASE (ticket) with an open approval chain.

**Probes (12):**

| # | Action | RPC | Expected DB delta |
|---|---|---|---|
| 1 | POST /approvals/:id/respond {decision:'approve'} on booking approval | `grant_booking_approval` | approvals.status='approved'; booking.status='confirmed'; outbox `booking.approval_granted` row; setup-WO emit fires per `approve_booking_setup_trigger` |
| 2 | Wait for OutboxWorker drain | `create_setup_work_order_from_event` | work_orders row + setup_work_order_emissions row present |
| 3 | Replay #1 same X-CRID + same body | command_operations cache hit | NO new approvals update; identical response |
| 4 | Replay #1 same X-CRID + different body | 409 payload_mismatch | NO state change |
| 5 | POST /approvals/:id/respond {decision:'reject'} on second booking approval | `grant_booking_approval` reject path | approvals.status='rejected'; booking.status='cancelled'; outbox `booking.approval_rejected` + cascade |
| 6 | Verify cascade fires (orders cancelled, OLIs cancelled, visitors detached, outbox `booking.cancelled` event drains) | n/a | Full cascade state assertion |
| 7 | POST /approvals/:id/respond on already-approved approval | 422 `approval.already_decided` | NO state change |
| 8 | POST /approvals/:id/respond as wrong approver (not in chain) | 403 `approval.not_approver` | NO state change |
| 9 | POST /approvals/:id/respond with cross-tenant approval id | 404 (RLS hides) | NO state change |
| 10 | POST /tickets/:id/grant-approval (case path, `grant_ticket_approval`) | RPC fires | approvals + status flip + audit_events row |
| 11 | Missing X-Client-Request-Id | 400 `client_request_id.required` | NO state change |
| 12 | Concurrent /respond from 2 connections same approval id | Exactly one 200 + one 409/422 | Single approval state change, no double-grant |

**Pass criteria:** 12 probes pass; cleanup unwinds all approvals/inbox/outbox/work_orders touched.

**Trigger files to make MANDATORY:** `apps/api/src/modules/approval/**` · migrations touching `grant_booking_approval` (00310) / `grant_ticket_approval` (00356–58) / `approve_booking_setup_trigger` (00311) · any approval-chain config change.

---

### New: `pnpm smoke:create-ticket`

**File:** `apps/api/scripts/smoke-create-ticket.mjs`

**Fixture:**
- One known request_type with routing rule that hits a specific team.
- One known asset + space tied to a domain_parent for the routing branch.
- TENANT_B fixture (already exists in `smoke-tickets`).

**Probes (10):**

1. POST /tickets happy path → 201 + ticket row + routing_decisions row + sla_timers row started + workflow_instances row spawned (per universal-workflow Phase 1).
2. Same POST replayed → cached response, no duplicate ticket.
3. Same X-CRID + different body → 409 payload_mismatch.
4. POST /tickets with cross-tenant asset_id (TENANT_B asset) → 422.
5. POST /portal/tickets happy path → 201 + ticket row tagged source=portal + scope from requester's grants.
6. POST /portal/tickets when requester has no grant covering the location → 403 portal scope-violation.
7. POST /tickets with request_type triggering require_approval rule → ticket.status='pending_approval' + approvals row + outbox `case.approval_required` event.
8. POST /tickets with no routing match → routing_decisions.outcome='unassigned', ticket.assigned_team_id IS NULL.
9. POST /tickets → POST /tickets/:id/reclassify → routing re-evaluation; old workflow cancelled; new spawned (per `reclassify_ticket` v2).
10. Missing X-Client-Request-Id on /tickets → 400.

**Trigger files to make MANDATORY:** `ticket.service.ts` create + reclassify · `apps/api/src/modules/routing/**` · migrations touching `create_ticket_with_automation` (00349–51) / `reclassify_ticket` (00354–55) / `start_sla_timers` (00347/52) / `repoint_sla_timer` (00348/53).

---

### New: `pnpm smoke:visitors`

**File:** `apps/api/scripts/smoke-visitors.mjs`

**Fixture:**
- One visitor_type + pass_pool (already in seed).
- One host person + user (admin).
- One booking_slot to attach visitors to (for bundle-cascade probe).

**Probes (15):**

1. POST /visitors/invitations happy path → visitor row + cancel_token + invite_token + outbox event.
2. Replay → cached.
3. POST /visitors/cancel/:token (public, no auth) → visitor.status='cancelled' + outbox `visitor.cancelled` event + host inbox notification.
4. POST /visitors/cancel/:token (replay same token) → 422 `visitor.cancel_token.used`.
5. POST /visitors/cancel/:token with forged/wrong token → 404.
6. POST /visitors/:id/acknowledge as wrong host → 403 `visitor.not_host`.
7. POST /visitor-reception/walk-up → visitor row created at status=`expected`.
8. POST /visitor-reception/visitors/:id/check-in → status=`arrived` + arrived_at + host SSE event fires.
9. POST /visitor-reception/visitors/:id/check-out → status=`checked_out` + checked_out_at; pass auto-returned to pool.
10. POST /visitor-reception/visitors/:id/no-show after configured grace period → status=`no_show`.
11. POST /visitor-reception/passes/:id/assign + /reserve + /return + /missing + /recovered → state-machine cycle through pass_pool_passes.status.
12. PATCH /admin/visitor-types as non-admin → 403.
13. Cross-tenant visitor read → 404 (RLS hides).
14. Single-write-path enforcement: attempt direct supabase-rest UPDATE on visitors.status → must fail (RLS or session marker).
15. **Bundle cascade:** cancel the parent booking; verify all attached visitors cascade to status=`cancelled` + outbox `visitor.bundle_cancelled` event per visitor.

**Trigger files to make MANDATORY:** `apps/api/src/modules/visitors/**` · any migration touching `visitors` / `visitor_hosts` / `pass_pool_passes` / `visitor_status_transitions` trigger.

---

### Smaller / focused additions

- **`smoke:cancel-booking`** (or merge into create-with-services as final teardown) — exercises `delete_booking_with_guard` (00292): cancel with active children → blocked; cancel forcing cascade → orders + visitors + work_orders + approvals + outbox fan-out all consistent.
- **`smoke:workflow-spawn`** — POST a booking, wait ≤30s for `workflow.spawn_required` outbox drain, assert workflow_instances row created with active_unique_idx not violated; POST a booking cancel, assert `parent_cancelled` path runs.
- **`smoke:dispatch-batch`** — POST /tickets/:id/dispatch with batch payload → multiple work_orders created atomically; if one row fails validation, none created.

---

## Mocked-but-should-be-live

These are jest specs that currently mock Supabase + would benefit from being lifted to a live-API smoke OR getting a sibling integration spec under `test:integration` (currently nonexistent — see `docs/follow-ups/outbox-integration-tests.md`):

| Spec file | Current pattern | Should also have |
|---|---|---|
| `apps/api/src/modules/ticket/ticket.controller.spec.ts` | mocked supabase.from + supabase.rpc | live HTTP smoke for create + reclassify (proposed `smoke:create-ticket`) |
| `apps/api/src/modules/approval/approval.service.spec.ts` | mocked rpc | live HTTP smoke (proposed `smoke:approvals`) |
| `apps/api/src/modules/orders/asset-reservation.service.spec.ts` | mocked supabase | live smoke for `POST /orders` + asset-reservation FK chain |
| `apps/api/src/modules/visitors/visitors.integration.spec.ts` | hermetic, mocked services | live HTTP smoke (proposed `smoke:visitors`) |
| `apps/api/src/modules/vendor-portal/vendor-auth.service.spec.ts` | mocked redeem | live smoke for magic-link redeem roundtrip |
| `apps/api/src/modules/workflow/workflow-engine.service.spec.ts` | spies on `advance` + `emit` | live smoke for spawn-wake roundtrip via outbox |
| `apps/api/src/modules/outbox/handlers/__tests__/workflow-spawn-wake.handler.spec.ts` | jest.fn for supabase | live smoke (the handler is part of the proposed `smoke:workflow-spawn`) |
| `apps/api/src/modules/maintenance/pm-generator.service.spec.ts` | mocked rpc | partially covered by smoke-work-orders `runPmGeneratorProbes`; the CRON entry-point still uncovered |
| `apps/api/src/modules/sla/sla.service.spec.ts` | mocked timers | live smoke for `start_sla_timers` + `repoint_sla_timer` (could fold into `smoke:create-ticket`) |
| `apps/api/src/modules/inbox/inbox.service.spec.ts` | mocked | live smoke for inbox INSERT trigger on outbox emit (B4A5 critical fix per memory) |

---

## Mandatory pre-ship gate (proposed)

Replace CLAUDE.md "Smoke gates" matrix with this expanded table (add 2 missing scripts + 4 proposed):

| Touched module / RPC | Mandatory smoke command |
|---|---|
| `WorkOrderService` / `TicketService.update` / desk-detail sidebar | `pnpm smoke:work-orders` |
| `TicketService` (PATCH path + state machine) / `update_entity_combined` | `pnpm smoke:tickets` ← **add** |
| `ReservationService.editScope` / `edit_booking_scope` RPC | `pnpm smoke:edit-booking-scope` |
| `ReservationService.editOne` / `editSlot` / `edit_booking` RPC | `pnpm smoke:edit-booking` |
| `FloorPlanService` / `publish_floor_plan_draft` RPC / floor-plan editor | `pnpm smoke:floor-plans` |
| **Any combined RPC change (00309, 00310, 00311, 00312, 00335, 00349, 00354, 00356, 00361, 00370, 00383, 00389) — any handler change in `apps/api/src/modules/outbox/handlers/`** | `pnpm smoke:outbox` ← **add to mandatory list** |
| `BookingFlowService.create` / `bundle.service.ts` build-attach-plan / `create_booking_with_attach_plan` | `pnpm smoke:create-booking-with-services` ← **new** |
| `ApprovalService` / `grant_booking_approval` / `grant_ticket_approval` / `approve_booking_setup_trigger` | `pnpm smoke:approvals` ← **new** |
| `TicketService.create` / `create_ticket_with_automation` / `reclassify_ticket` / `RoutingService` / `SlaService.start/repoint` | `pnpm smoke:create-ticket` ← **new** |
| Anything under `apps/api/src/modules/visitors/**` / visitor migrations | `pnpm smoke:visitors` ← **new** |

**Cutover rule:** if a PR touches more than one trigger band, run **all** matching smokes; do not cherry-pick. The smokes are < 5 min combined wall-clock; the cost of running them all is lower than the cost of the next 2026-05-01 P0.

**Additionally:** keep `pnpm test:concurrency` mandatory for any touch of advisory-lock contracts in the 16 canonical RPCs (already gated via path-filtered CI job per `b0-real-db-concurrency-harness.md`). It validates the LOCAL DB. The smoke gates validate the REMOTE DB. Both layers are necessary.

---

## Sources read

- `/Users/x/Desktop/XPQT/apps/api/scripts/smoke-work-orders.mjs` (2749 lines)
- `/Users/x/Desktop/XPQT/apps/api/scripts/smoke-tickets.mjs` (1236 lines)
- `/Users/x/Desktop/XPQT/apps/api/scripts/smoke-edit-booking.mjs` (1448 lines)
- `/Users/x/Desktop/XPQT/apps/api/scripts/smoke-edit-booking-scope.mjs` (1298 lines)
- `/Users/x/Desktop/XPQT/apps/api/scripts/smoke-floor-plans.mjs` (1020 lines)
- `/Users/x/Desktop/XPQT/apps/api/scripts/smoke-outbox-roundtrip.mjs` (710 lines)
- `/Users/x/Desktop/XPQT/docs/smoke-gates.md`
- `/Users/x/Desktop/XPQT/CLAUDE.md` "Smoke gates" section
- `/Users/x/Desktop/XPQT/AGENTS.md` "Smoke gates" section
- `/Users/x/Desktop/XPQT/apps/api/test/concurrency/jest.config.cjs` + `pool.ts` + `helpers.ts` + sample specs (`edit_booking.spec.ts`)
- `/Users/x/Desktop/XPQT/docs/follow-ups/outbox-integration-tests.md` (deferred-coverage manifest)
- `/Users/x/Desktop/XPQT/docs/follow-ups/b0-real-db-concurrency-harness.md`
- ~30 `*.spec.ts` files across booking-bundles / reservations / ticket / work-orders / approval / visitors / vendor-portal / workflow / outbox handlers
- Migration listing 00309–00402 (16 canonical RPCs identified)
- `/Users/x/Desktop/XPQT/package.json` + `apps/api/package.json` (smoke script registration)

---

## Closure Ledger

Every agent that closes, partially closes, or intentionally defers a finding in this audit must add a row here in the same change. Do not mark the audit as complete from unit tests alone; cite live-API smoke coverage, package scripts, docs, and code/database evidence.

| Date | Agent / owner | Status | Evidence | Verification | Notes |
|---|---|---:|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/08-smoke-coverage.md` | Not run | All findings remain open unless a later row says otherwise. |
| 2026-05-16 | booking-audit Slice 1 | partially_closed | smoke-edit-booking.mjs Fixture D (linked rows: order+OLI+boundary/custom asset_reservations+setup WO); migration 00407; see audit 03 ledger | pnpm smoke:edit-booking 78/78 exit 0 | editOne/editSlot smoke now exercises linked-row cascade + idempotency-replay. Scope linked-row time fixture intentionally NOT added (editScope rejects time edits by design — see audit 03 CONTESTED). |
| 2026-05-16 | CONTEST of this file's coverage matrix — "Booking — editOne / editSlot ✅ smoke-edit-booking" (the ✅ as of 2026-05-13) | contested | n/a | reservation.service.ts passed users.id where edit_booking F-CRIT-1 (00394:289-303) requires auth_uid; ALL editOne/editSlot/editScope 404'd actor_not_found until fixed 2026-05-16 (audit 03 D-1) | The ✅ was inaccurate: the editOne/editSlot live smoke could not have been green on 2026-05-13. Original matrix text left intact per append-only; this row is the correction. |
| 2026-05-17 | booking-audit Slice 2 — closes the "Booking — cancel / delete ❌ (zero coverage)" matrix gap | closed | new `apps/api/scripts/smoke-cancel-booking.mjs` (138 probes; all 3 scopes this/this_and_following/series; linked order+OLI+asset_reservation+setup WO+pending approval+visitors; asserts every TX cascade row + `booking.cancelled` outbox per booking + durable OBX visitor cascade + requester notification + idempotency replay + payload-mismatch + already-cancelled short-circuit + ghost/CRID guards); registered in package.json + docs/smoke-gates.md + CLAUDE.md | `pnpm smoke:cancel-booking` 138/0; backs `cancel_booking_with_cascade` (00408) — see audit 03 ledger 2026-05-17 | The matrix's "Booking — cancel / delete ❌ … ❌ … ❌" row (every column) is now covered by a live-HTTP gate. Original matrix text left intact per append-only; this row is the correction. The draft-slot + non-pivot-series probes are genuine bug-catchers (would fail pre-fix), not constructed-to-pass. |
| 2026-05-17 | booking-audit Slice 3 — new `smoke:create-multi-room` gate; closes the multi-room atomic-create + D-4 §7a coverage gap | closed | new `apps/api/scripts/smoke-create-multi-room.mjs` (46 probes: atomic N-slot create-with-services, idempotency replay/no-dup, partial-room full-rollback, cross-tenant reject, missing-CRID 400, require_approval→pending_approval+rows [f], single-room create-with-services+matched-room-rule→201 no §7a 400 [g]); registered package.json + docs/smoke-gates.md + CLAUDE.md | `pnpm smoke:create-multi-room` 46/0; backs `create_booking_with_attach_plan` multi-room cutover + `migration 00410` validator fix — see audit 03 ledger 2026-05-17 | A prior pass shipped probe (f) asserting the BROKEN 400 + a "RESIDUAL banner" (the dishonest-fixture anti-pattern this file's audit exists to kill) and a stale `smoke-gates.md` describing it — the 2-agent full-review caught both; both rewritten to assert correct post-00410 behavior. Probe (g) genuinely exercises §7a (off-hours rule ⇒ non-empty applied_rule_ids), not a tautology. |
| 2026-05-17 | booking-audit Slice 4 — `smoke:edit-booking-scope` Scenario 7b split-idempotency probes + 3 harness-bug repairs | partially_closed | `apps/api/scripts/smoke-edit-booking-scope.mjs`: 7 Scenario-7b probes proving `split_recurrence_series` (00411) atomic+idempotent (exactly 1 series at pivot, exactly 1 split command_operations success row, recurrence_series count UNCHANGED on retry = no orphan); + fixed 3 pre-existing harness bugs that had been silently aborting this gate early (`select command_operations.id` — NO such column; deleteFixture split-child slot-orphan; flip-assertion `.schema('outbox')` PGRST106) | `pnpm smoke:edit-booking-scope` 45/1 — the 7 split probes GREEN; the 1 fail = newly-UNMASKED pre-existing D-5/R-e (`edit_booking_scope` same-body-retry 409, non-`_` scope-producer determinism), honestly asserted as `expect:conflict` WITH a FIXME→D-5/R-e/task#14/flip-when-fixed pointer | **Meta-finding (dishonest-gate class):** this gate had been aborting on a `command_operations.id` select (no such column) BEFORE reaching the replay probe — i.e. smoke:edit-booking-scope was never actually exercising commit-replay; prior "green" was illusory. Now fixed → the pre-existing edit_booking_scope producer-determinism (D-5) is correctly surfaced + owned (task #14), not silently passed. The 7b probes are genuine bug-catchers (fail vs the pre-Slice-4 non-atomic splitSeries via the command_operations-row invariant). |
| 2026-05-17 | booking-audit debt #15 — NEW `smoke:attach-services` gate; closes the "post-create service-attach has zero live coverage" gap (P1-3 regression boundary) | closed | new `apps/api/scripts/smoke-attach-services.mjs` (44 probes: (1) atomic attach catering+AV → exact order/OLI/asset_reservation/attach_operations deltas; (2) idempotency replay no-dup; (3) same-CRID different-payload → 409 `booking.idempotency_payload_mismatch` + zero new rows; (4) cross-tenant Tenant-A-JWT+Tenant-B-header → 403 + zero rows under wrong tenant; (5) missing X-Client-Request-Id → 400 + zero rows; (6) **load-bearing atomicity** — pre-seeded `confirmed` asset_reservation forces an RPC-internal `asset_reservations_no_overlap` 23P01 *after* the catering order/OLI insert; asserts ZERO partial orders/OLIs/AR/approvals + `attach_operations` marker rolled back = proves Postgres atomicity replaced the TS `Cleanup` queue; (7) require_approval rule → pending approval routed to seeded approver + `setup_work_order.create_required` outbox SUPPRESSED for the booking); registered `package.json`×2 + `docs/smoke-gates.md` + `CLAUDE.md` matrix | `pnpm smoke:attach-services` **44/0/0 exit 0** — run TWICE by the orchestrator (pre-I1 + post-`migration 00413`; identical). Backs `attach_services_to_existing_booking` (00412, now `SECURITY INVOKER` via 00413). Gate read line-by-line for honesty: per-run-`booking_id`-scoped deltas (multi-session-safe; outbox via `payload->>'booking_id'`, never global counts), skips NOT counted as pass, `exit 1` on any fail / `exit 2` infra. See audit 03 ledger + Update 2026-05-17 (debt #15) | Drains the only booking-audit slice that had shipped (f1085072) without its live gate + 2-agent full-review (both then-blocked by API infra). Probe 6 is a genuine bug-catcher (a non-atomic RPC would leave the catering OLI inserted before the AR failure — the probe asserts it does NOT survive), NOT constructed-to-pass. The 2-agent full-review (now run) surfaced D-6 (producer-determinism, deferred-with-owner bundled #14) — NOT smoke-covered here by design (the deterministic-case idempotency IS covered by probes 2/3; the lead-time-rule retry case is documented in the smoke header + ledger as a known gap, not a hidden one, mirroring Slice-4's honest D-5 handling). |

## Agent Handoff Prompt

```text
You are the smoke-coverage remediation agent for Prequest.

Primary file:
- docs/follow-ups/audits/08-smoke-coverage.md

Goal:
Close every smoke/test coverage gap in this audit so the high-risk database-backed workflows are protected by live API probes, not just mocked Supabase or unit tests. Keep this audit doc current while you work.

Read before editing:
- AGENTS.md and CLAUDE.md
- docs/follow-ups/audits/08-smoke-coverage.md
- docs/follow-ups/audits/00-integrator-verdict.md
- docs/smoke-gates.md
- package.json and apps/api/package.json
- Existing smoke scripts under apps/api/scripts/
- Existing concurrency tests under apps/api/test/concurrency/
- The service/RPC files named by each missing or weak smoke gate.

Execution model:
1. First register and document existing but missing gates: smoke:tickets and smoke:outbox where applicable.
2. Strengthen existing booking smokes so they cover linked rows after the underlying booking cascade fixes land. Do not hide the 2026-05-01 failure mode with fixtures that avoid linked services.
3. Add missing live-API smoke scripts in small slices: create-ticket automation, approvals, booking-with-services, booking cancellation, visitors, workflow spawn, and dispatch batch where the audit calls for them.
4. Each smoke should mint a real JWT, call the live API, assert persisted database state, verify idempotency/error contracts where relevant, and clean up fixtures in finally.
5. Update package scripts, docs/smoke-gates.md, and any root agent instructions in the same change that adds or changes a gate.
6. Do not run pnpm db:push, supabase db push, or remote psql migrations without explicit user approval. Local validation is fine when needed.
7. Use parallel agents only for independent smoke scripts with disjoint files. Tell them they are not alone in the codebase and must not revert other edits.

Required output after each slice:
- Smoke script and package/doc registration changed.
- Exact command run and result.
- One Closure Ledger row in this file with status: closed, partially_closed, blocked, or deferred.
- Any residual untested behavior written into this audit doc, not left in chat.

Completion bar:
- Every critical RPC or multi-table write path listed in this audit has a mandatory smoke gate, or a documented blocker with owner and acceptance criteria.
- The mandatory smoke matrix in docs and agent instructions matches the package scripts.
- Existing smokes exercise real linked-row and failure-path cases, not only simplified happy fixtures.
- The integrator verdict can cite this file as current evidence.
```
