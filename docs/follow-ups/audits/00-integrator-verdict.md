# XPQT Architecture Audit — Integrator Verdict
Date: 2026-05-13
Synthesized from 8 specialist audits

---

## Executive verdict (one page)

| # | Claim | Status | Best-in-class | Confidence | Justification |
|---|---|---|---|---|---|
| 1 | Data model rework done? | **MOSTLY DONE** | **CLOSE** | **High** on schema; medium on tail | Canonical entities (bookings/slots/tickets/work_orders/orders/approvals/visitors/floor_plans) shipped destructively (Agent 1 §exec). Outbox is its own schema with idempotency/payload hashing. Tenant isolation via 3 layers works at runtime. BUT: 10 duplicate migration prefixes 00367–00400 (Agent 1 P0-1; Agent 2 P2-3), composite (tenant_id, id) FKs are inconsistent — old tables (bookings/tickets/work_orders) lack them, new tables (maintenance_plans 00386, work_orders PM cols 00387) have them (Agent 1 P0-2; Agent 4 cross-tenant FK risk). Step-0 polymorphic `activities` is write-only, never read (Agent 1 P1-1). Phase 8 TS naming sweep not started (1053-line allowlist; Agent 1 P1-3). |
| 2 | Ticket/work-order architecture best-in-class? | **MOSTLY DONE** | **NOT CLOSE** | **High** | Happy path (PATCH single, dispatch, create, respond) is excellent — atomic RPC + `command_operations` + idempotency + audit (Agent 2 exec; Agent 5 Era A). BUT: `PATCH /tickets/bulk/update` is a raw UPDATE that bypasses every guarantee — no idempotency, no per-action permission, no audit, no command_operations row (Agent 2 P0-1). SLA escalation cron bypasses `set_entity_assignment` entirely (Agent 2 P0-2). Both reassign paths are 3 raw writes; WO side swallows audit errors (Agent 2 P1-1; Agent 5 P1-5). Case-vs-WO split is clean at DB but leaky at service layer (Agent 2 P2-1). |
| 3 | Booking/reservation architecture best-in-class? | **MOSTLY DONE** | **NOT CLOSE** | **High** | Headline RPCs (create_booking_with_attach_plan, edit_booking v5, edit_booking_scope v3, grant_booking_approval) are gold-standard single-tx atomic with idempotency (Agent 3 exec; Agent 5 §Era A). BUT: 6 of 12 booking lifecycle ops are still TS choreography (Agent 3 atomicity matrix). `cancelOne` is non-atomic AND doesn't emit `booking.cancelled` to outbox — universal workflow consumers will hang (Agent 3 P0-1; Agent 5 P0-3/P0-4). Multi-room create still on legacy `BookingTransactionBoundary` (Agent 3 P1-1). **Edit plans send empty `asset_reservation_patches=[]`, `order_patches=[]`, `work_order_sla_patches=[]` arrays — a 10am→2pm edit leaves caterers/setup-WOs/asset bookings at 10am (Agent 3 P0-2)**. Smoke fixtures deliberately have no linked rows, hiding this (Agent 3 P0-3; Agent 8 booking-create matrix). |
| 4 | Whole platform architecture best-in-class? | **NOT DONE** | **NOT CLOSE** | **High** | Data model + canonical RPC pattern + workflow polymorphism + GDPR baseline are genuinely BIC (Agent 6 §scorecard, 5 BIC wedges). But buyer-evaluated dimensions are MVP or Missing: Mobile (no PWA, no offline write queue except kiosk) · Teams cards · Outlook add-in · Vendor scorecards · Requester rating · Vendor portal Phase B sprints 2–5 · KDS/Phase C · Reporting (251 LOC; no dashboard builder) · KB · email channel · AI/copilot (Agent 6 P0/P1). Header `X-Tenant-Id` trusted with no JWT-claim cross-check + 9 admin controllers don't bridge — any authed user can read/write tenant B's routing rules, workflows, floor plans (Agent 4 P0). |

---

## Confidence and why

High confidence on every verdict. Eight independent audits converged on the same patterns: canonical RPC pattern works wherever it was applied, the gaps are at the edges where legacy TS choreography survives, and the product-surface gaps are about shipping (not architecture). Where audits disagree is narrow and surfaced below. Static-only review across all 8; no live exploit exercised. Two specific risks not validated: Agent 4 P0 (header trust) is by code reading only and a live two-tenant probe would lift confidence to certainty; Agent 5/3 RPC-vs-TS coverage was complete by grep across `apps/api/src/modules/` (no module skipped).

---

## Top 10 blockers to best-in-class

| Rank | Sev | Area | Description | Evidence | Fix bucket |
|---|---|---|---|---|---|
| 1 | **P0** | Security | `X-Tenant-Id` header trusted with no JWT `app_metadata.tenant_id` cross-check; 9 admin controllers (workflow, sla-policy, 6 routing, buildings) skip the bridge → any authed user flips header, reads/writes target tenant's routing/SLA/workflows/floor plans | Agent 4 P0-1 + P0-2 | 4-line `AuthGuard` change + `@UseGuards(AdminGuard)` on 9 controllers; **<1 day** |
| 2 | **P0** | Bookings | Booking edit plans always send empty linked-row patch arrays — edit start_at, linked orders / asset_reservations / work_orders stay at OLD time. Silent data divergence reaching caterer daglijst | Agent 3 P0-2 + P0-3; Agent 8 booking matrix | Populate patches in `AssembleEditPlanService` + add linked-row fixture to smoke probes |
| 3 | **P0** | Bookings | `cancelOne` is 2 non-atomic writes + best-effort try/catch cascade + **never emits `booking.cancelled` outbox** — Universal Workflow Phase 1 consumers wired to wake on this event will silently miss every user-cancel | Agent 3 P0-1 + P1-5; Agent 5 P0-4 | New `cancel_booking_with_cascade` RPC mirroring `grant_booking_approval`; emit `booking.cancelled` in-tx |
| 4 | **P0** | Tickets | `PATCH /tickets/bulk/update` raw UPDATE with no guard, no permission gate, no idempotency, no audit, no `command_operations` row, accepts any DTO cast to Record | Agent 2 P0-1 | Add guard + route through `update_entity_combined` loop or new batch RPC |
| 5 | **P0** | Tickets | SLA escalation cron reassigns tickets/WOs via raw `updateTicketOrWorkOrder` — zero `command_operations`, zero `routing_decisions`, zero outbox emission. Not in any followup doc | Agent 2 P0-2 | Route via `set_entity_assignment` with `sla:escalation:<crossing_id>` idem-key |
| 6 | **P0** | RPCs / TS-sequence | 7 legacy TS-sequence services still in production violate CLAUDE.md mandate: `OrderService.createStandalone` (5+ tables, retired compensation pattern), `BundleCascadeService.cancelLine/cancelBundle`, `RecurrenceService.cancelForward/splitSeries`, `InvitationService.create`, `KioskService.walkUp`, `WorkflowEngineService` approval node (N approvals loop + status flip, no tx) | Agent 5 P0-1 through P0-6; Agent 3 P1-2/3/4 | Slices X.1–X.5 in Agent 5: cancel RPCs · visitor RPCs · standalone-order RPC · workflow-approval-node RPC. Mechanical work; pattern proven |
| 7 | **P0** | Data model | Composite `(tenant_id, id)` FKs inconsistent — bookings/tickets/work_orders/orders/approvals use single-column UUID FKs; maintenance_plans 00386 + WO PM cols 00387 use composite. Service-role writes bypass RLS AND validate_entity_in_tenant. Cross-tenant smuggle possible | Agent 1 P0-2; Agent 4 cross-tenant FK risk | Schema sweep retrofit + CI guard banning single-column UUID FKs to tenant tables |
| 8 | **P0** | Data model | 10 duplicate migration prefixes (00367–00400) from concurrent floor-plan + workflow branches. Currently no correctness bug because pairs touch disjoint tables, but ordering is non-deterministic and a future "after 00370" assumption will silently break | Agent 1 P0-1; Agent 2 P2-3 | Renumber floor-plan branch upward + `scripts/check-migration-prefix-unique.sh` CI guard; <½ day |
| 9 | **P0** | Smoke / Tests | ~60% of canonical RPC surface has zero live-HTTP smoke: `create_ticket_with_automation`, `grant_ticket_approval`, `grant_booking_approval`, `reclassify_ticket`, `dispatch_child_work_orders_batch`, `delete_booking_with_guard`, visitor controller, vendor portal. The 4 named gates are world-class; the unprotected 60% is the next 2026-05-01 P0 in waiting | Agent 8 P0 §1–3; Agent 5 P1-7 | New probes: `smoke:create-ticket`, `smoke:approvals`, `smoke:create-booking-with-services`, `smoke:visitors`, `smoke:cancel-booking`, `smoke:workflow-spawn`. Mechanical |
| 10 | **P0/P1** | Product surface | No buyer-evaluated dimension where XPQT beats all Tier A competitors. Mobile (no PWA, no offline writes except kiosk), Teams adaptive cards, Outlook add-in, vendor scorecards, requester rating, Phase C KDS, reporting (251 LOC), KB, email channel, AI all MVP/Missing | Agent 6 §scorecard; P0 1–6 | This is not refactor — it's the 30/60/90 roadmap; ~30–45 weeks engineer time per spec (discount 30× per memory) |

---

## Top 10 strengths worth preserving

1. **Canonical RPC pattern (B.0/B.2/B.4 era).** Every write does advisory_xact_lock + command_operations + same-tx outbox emit + cached_result replay + revoke from public + grant to service_role only. The template is correct; the work is to apply it everywhere. Agent 5 §Era A.
2. **`create_booking_with_attach_plan` (00309) + `grant_booking_approval` (00310) + `edit_booking` v5 (00394).** Gold-standard examples of "multi-table writes are RPCs not TS pipelines." Agent 3 §what's good.
3. **Universal Workflow polymorphism (Phase 1 complete; migrations 00368–00376).** `workflow_instances.entity_kind` polymorphic across ticket+work_order+booking with per-kind partial unique indexes, derive trigger before validate trigger, three wait-resolution paths (condition_met / parent_cancelled / timeout). Agent 1 §best-in-class; Agent 6 §data model.
4. **Four-axis routing model + persisted `routing_decisions` audit.** routing / ownership / execution / visibility cleanly separated; resolver is read-only, recordDecision is append-only. Agent 2 §section findings; Agent 6 §domain scorecard.
5. **Three-tier visibility (`ticket_visibility_ids` / `work_order_visibility_ids` / `visitor_visibility_ids` SQL predicates).** Materializes once, joined laterally. Agent 1 §what's BIC; Agent 4 SD review.
6. **GDPR baseline (retention engine + LIA + audit_outbox + DSR + legal holds + departure cascade; migrations 00161–00166).** Genuinely competitor-comparable; rare strength. Agent 6 BIC.
7. **GiST exclusion `booking_slots_no_overlap` on (tenant_id, space_id, time_range)** keeps double-booking races at the DB layer, not the app layer. Agent 3 §what's good; Agent 6 BIC wedge.
8. **Outbox is a dedicated schema** (`outbox.events` + `outbox.events_dead_letter`) with idempotency_key + payload_hash. Not a hand-rolled pattern on `domain_events`. Agent 1 §what's BIC.
9. **Approval `scope_breakdown` dedup + partial unique index.** One row per (entity, approver) across N lines — competitive moat against ServiceNow. Agent 6 §wedges.
10. **The 4 live smoke gates (`work-orders` 2749 LOC, `edit-booking` 1448 LOC, `edit-booking-scope` 1298 LOC, `floor-plans` 1020 LOC).** Probe density, current-row-XOR-sentinel writes, command_operations assertions, cross-tenant smuggling, idempotency replay, parallel races, CAS. Best-in-class for NestJS+Supabase. Agent 8 §exec verdict.

---

## "Do not touch" architectural principles

1. **Multi-step writes are PL/pgSQL RPCs, not TS pipelines.** Never re-introduce `BookingTransactionBoundary`-style in-process compensation. The pattern is mandate (CLAUDE.md).
2. **Idempotency key shape: `<prefix>:<scope>:<crid>`** with discriminator (op or entity_kind) included. F-CRIT-1 + Step 2F.3 hard-won lessons — actor in `create:ticket` only.
3. **Tenant-id is the #0 invariant.** Every table has it; every read filters on it; every RPC takes `p_tenant_id`; every polymorphic FK runs through `validate_entity_in_tenant`. New tables MUST use composite `(tenant_id, id)` FKs (the pattern shipped in 00386/00387 — propagate, don't regress).
4. **Same-tx outbox emit.** `outbox.emit()` SQL helper inside the business RPC. Never best-effort post-commit emission for domain events. Spec §3.2 + §3.6.
5. **Hidden vendor wedge.** Requester sees no vendor identity. Admin/desk does. Don't break this defaults — it's a competitive moat (memory `feedback_hide_vendor_from_requester`).
6. **One predicate engine** (RuleResolverService + applies_when AST) across room rules + service rules + future domains. Don't fragment.
7. **`docs/assignments-routing-fulfillment.md` + `docs/visibility.md` are living contracts.** Touch routing/visibility code = update doc in same PR. Mandate already in CLAUDE.md; violated once (Agent 7 §1: edit_booking_slot reference) — don't violate again.
8. **Workflow_instances polymorphism: per-kind partial unique indexes + derive-before-validate triggers in alphabetical order.** Document at `00369:384-393` — copy pattern; don't re-architect.
9. **Smoke gates: live-API probes mint Admin JWT and exercise running dev server.** Not jest with mocked Supabase. Mocked tests pass when prod migrations fail.
10. **Destructive-default schema rewrites for unmigrated tables.** No legacy preservation in booking canonicalisation (memory `.claude/CLAUDE.md`). Lift this rule only after the canonicalisation PR fully merges to main.

---

## Required refactors before claiming done

### Must-fix (blocks "best-in-class" claim)

1. **AuthGuard JWT tenant cross-check** (Agent 4 P0-1) — 4 lines + 9 controllers; closes entire admin-bypass class.
2. **Linked-row patches in edit assembler** (Agent 3 P0-2) — populates `asset_reservation_patches` / `order_patches` / `work_order_sla_patches` from booking children.
3. **`cancel_booking_with_cascade` RPC** (Agent 3 P0-1; Agent 5 P0-4) — atomic + emits `booking.cancelled` on every user-cancel path including recurrence.
4. **`PATCH /tickets/bulk/update`** route through orchestrator (Agent 2 P0-1) — guard + RPC + per-action perms.
5. **SLA escalation cron → `set_entity_assignment`** (Agent 2 P0-2) — atomic with idempotency key.
6. **7 legacy TS-sequence services → RPCs** (Agent 5 P0-1/2/3/5/6 + P0-4 above): `OrderService.createStandalone`, `BundleCascadeService.cancelLine/cancelBundle`, `RecurrenceService.splitSeries` (in-flight per memory `project_b4_workstream_state`), `InvitationService.create`, `KioskService.walkUp`, `WorkflowEngineService` approval node.
7. **Composite `(tenant_id, id)` FK retrofit** on bookings/tickets/work_orders/orders/approvals/booking_slots/asset_reservations + CI guard (Agent 1 P0-2).
8. **Renumber 10 duplicate migration prefixes + add CI guard** (Agent 1 P0-1).
9. **Both reassign paths → `set_entity_assignment` extended with `reason` + activity emission** (Agent 2 P1-1; Agent 5 P1-5).
10. **Routing-evaluation handler: fold `routing_status` clear into RPC; branch entity_kind for case vs WO** (Agent 2 P1-2).

### Should-fix (before broad RFP credibility)

11. **Step-0 polymorphic `activities` reader cutover** (Agent 1 P1-1) — drop `ticket_activities` + shadow trigger.
12. **`asset_reservations` exclusion constraint: add `tenant_id with =`** parity with `booking_slots_no_overlap` (Agent 1 P1-4).
13. **`approvals.target_entity_id` polymorphic tenant validation trigger** (Agent 1 P1-5).
14. **`booking_visibility_ids` SQL function** matching ticket/work_order/visitor pattern (Agent 1 P3-2; Agent 3 §dup SoT).
15. **Multi-room booking create → `create_booking_with_attach_plan`** (Agent 3 P1-1) — retires `BookingTransactionBoundary` from `multi-room-booking.service.ts`.
16. **Service-layer case-vs-WO split: pull `getById`/`getChildTasks`/`createBookingOriginWorkOrder` out of `TicketService`** (Agent 2 P2-1).
17. **`getChildTasks` filter children through `work_order_visibility_ids`** (Agent 2 P1-5) — currently inherits parent visibility, leaks vendor child WOs.
18. **Reassign visibility floor parity** between case and WO sides — pick one and document (Agent 2 P1-4).
19. **Satisfaction rating into `update_entity_combined` metadata branch** (Agent 2 P1-3).
20. **`tickets.sla_*` denormalisation invariant**: audit which writes touch which columns, add trigger or test (Agent 1 P2-3).
21. **`SlaService.startTimers` → `update_entity_sla`** (Agent 5 P1-2).
22. **`BookingFlowService.createApprovalRows` race**: append `approvers[]` to `create_booking` RPC (Agent 5 P1-4) — silent stuck-booking class.
23. **`OrdersApprovalRouting.upsertWithRetry` race**: SELECT FOR UPDATE or convert to upsert RPC (Agent 5 P1-1).
24. **`DbService` non-superuser app role** (Agent 4 P1) — currently `postgres` superuser bypasses every RLS policy.
25. **`ticket_visibility_ids` null-location branch** tighten to domain-scope match (Agent 4 P1).

### Polish (architectural hygiene)

26. **Drop `role_audit_events`** (Agent 1 P1-2; memory `project_role_audit_events_drop_pending`) — one-line migration.
27. **Tighten `activities.entity_kind` CHECK** to remove `'ticket'` umbrella + `'service_order'` (Agent 1 P2-1).
28. **Phase 8 TS naming sweep + diff CI guard** (Agent 1 P1-3) — 1053-line allowlist; backend then frontend then fixtures then SQL drops.
29. **Delete `OutboxService` TS class** (Agent 5 P2-1) — zero callers; @deprecated.
30. **Workflow-definition save-time validator** for `update_ticket` field allowlist (Agent 5 P2-4).
31. **`command_operations` janitor for orphan `in_progress` rows** (Agent 5 P2-2).
32. **`ALL_IDEMPOTENCY_KEY_PREFIXES` registry + CI test** (Agent 5 P3-2).
33. **`AGENTS.md` vs `CLAUDE.md` near-duplication** decision (Agent 7 §stale-docs 4).

---

## Required smoke tests before claiming done

From Agents 5 and 8. Each is a new probe `apps/api/scripts/smoke-<x>.mjs` with named fixture and assertion shape:

| Probe | Fixture | What it gates |
|---|---|---|
| **`smoke:create-ticket`** | request_type + routing rule hitting team · asset + space + domain_parent · TENANT_B fixture | `create_ticket_with_automation` (00349/50/51) — workflow spawn, routing_decisions, sla_timers, portal scope, reclassify roundtrip, missing X-CRID guard, cross-tenant asset id. 10 probes. |
| **`smoke:approvals`** | 2 bookings at `pending_approval` (chain_id distinct) · 1 case with open chain | `grant_booking_approval` (00310) + `grant_ticket_approval` (00356–58) + `approve_booking_setup_trigger` (00311) — happy approve, happy reject + cascade, replay (cache hit), payload mismatch, wrong approver, cross-tenant, concurrent /respond. 12 probes. |
| **`smoke:create-booking-with-services`** | 1 require_approval rule + 1 deny rule + Noor approver + tenant-default routing | `create_booking_with_attach_plan` create-side branches (allow / require_approval / deny / multi-vendor split / replay / payload mismatch / cross-tenant space / missing X-CRID). Closes the "services silently dropped on POST /reservations" failure class. 8 probes. |
| **`smoke:cancel-booking`** | booking with linked services (orders, OLIs, asset_reservations, work_orders) | `cancel_booking_with_cascade` RPC (after refactor #3 above): booking.cancelled outbox event present, orders flipped, asset_reservations flipped, approvals expired, inbox cleaned up. **Gates Agent 3 P0-1 fix.** |
| **`smoke:visitors`** | visitor_type + pass_pool + host person + booking slot | `InvitationService.create` RPC (after refactor): invite happy path, replay, public cancel via token, wrong host ack, walk-up → check-in → check-out cycle, pass-pool transitions, single-write-path attempt via direct REST (must fail), bundle cascade. 15 probes. |
| **`smoke:workflow-spawn`** | booking with workflow-spawning request_type | Producers (`booking.created`/`booking.cancelled` → 00372/00373) + `WorkflowSpawnWakeHandler` + cancelInstance polymorphic cascade + cron backstop. 3 wait-resolution paths (condition_met / parent_cancelled / timeout). |
| **`smoke:dispatch-batch`** | parent ticket + 3 child WO templates | `dispatch_child_work_orders_batch` (00337/39/42) — atomic batch, partial-failure rollback (one bad row → none created), idempotency replay. |
| **Augment `smoke:edit-booking` + `smoke:edit-booking-scope`** | Add Fixture D / Fixture B with linked services + orders + asset_reservations + setup work_order | Verifies linked-row patches populate per Agent 3 P0-2 fix. Currently both probes explicitly seed bookings with no linked rows. |
| **Augment `smoke:work-orders`** | Add bulk-update probe (P0-4 fix gate) · reassign happy-path command_operations assertion (P1-1 fix gate) · `getChildTasks` cross-visibility (P1-5 fix gate) · vendor assignment through orchestrator end-to-end · dispatch idempotency replay · `routing_status` clear in same tx | Closes Agent 2 §smoke gaps 1–10. |
| **Register existing probes** | `smoke:tickets` (1236 LOC) + `smoke:outbox` (710 LOC, full roundtrip) | Both run + pass; not in CLAUDE.md "mandatory" matrix — silent gap for any engineer reading the docs. Agent 8 P0 §3. |

---

## Required doc corrections

From Agent 7. Single hygiene PR scope:

1. **`docs/assignments-routing-fulfillment.md` §4 mutation matrix (lines 1206–1269)** — replace `edit_booking_slot` (00291, dropped 2026-05-12 via 00379) with `edit_booking` (00364) + `edit_booking_scope` (00371). Canonical operator-facing reference is wrong about a live RPC.
2. **`docs/room-booking.md:14`** — rename `reservations.time_range` to `booking_slots.time_range` (00277 rename). 1 stale ref, 0 canonical refs in that file.
3. **`AGENTS.md` ↔ `CLAUDE.md`** — 202-line near-duplicate. Decide: delete `AGENTS.md` with a redirect, OR scope it for codex/non-Claude with diverged content. Silent drift guaranteed if both keep evolving.
4. **`docs/smoke-gates.md`** — add `smoke:outbox-roundtrip` + `smoke:tickets` to the probe matrix. Both exist + pass + invisible.
5. **`docs/phase-{1,2,3,4}.md`** — add `> SUPERSEDED 2026-04-28 by docs/booking-platform-roadmap.md and docs/follow-ups/ corpus` headers. Don't delete (history value); stop the timeline-estimate-harm (months instead of days).
6. **`docs/data-model-redesign-2026-04-30.md`** — "Recommendation" framing is stale. Add `SHIPPED through Step 1c.10c (see data-model-overnight-handoff.md + full-handoff.md)` header.
7. **`docs/follow-ups/universal-workflow-phase1bx-followups.md:39-50`** — line citations drifted (`:959` → `:1024`, `:1149` → `:1202-1205`). Deferral still real and accurate.
8. **`docs/follow-ups/phase-8-canonical-naming.md:36-38`** — mark Phase 8.D shipped 2026-05-12 (cite 00379 + b4-followups).
9. **Add `docs/notifications.md`** — B.4.A.5 sub-step C shipped a real notifications module (4 services, React-email templates, template-overrides controller); zero operational doc.
10. **Add `docs/inbox-notifications.md`** — 00391 + 00401 + 00402 trigger fan-out is production infra with no one-pager.
11. **Add `docs/floor-plans.md`** — floor-plan designer + portal + map shipped over last week; only deferral doc exists.

---

## 30 / 60 / 90 day roadmap

Estimates flagged — the user discounts AI-authored timelines 30×.

### 30 days (architectural debt + security)

- **Week 1** (~3 engineer-days est, treat as 1 day actual)
  - AuthGuard JWT tenant cross-check + 9 admin controllers gated (Agent 4 P0).
  - `@UseGuards(RequireClientRequestIdGuard)` + raw-UPDATE removal on `PATCH /tickets/bulk/update`; ship as iterating-over-`update_entity_combined` first; batch RPC follow-up (Agent 2 P0-1).
  - Renumber 10 duplicate migration prefixes + ship CI guard (Agent 1 P0-1).
  - Drop `role_audit_events` table (Agent 1 P1-2).
  - Doc corrections #1–8 above (single PR).
- **Week 2** (~4 engineer-days est, 2 actual)
  - SLA escalation cron through `set_entity_assignment` (Agent 2 P0-2).
  - Reassign paths (case + WO) through extended `set_entity_assignment` with reason + audit emission (Agent 2 P1-1).
  - Routing-evaluation handler `routing_status` clear folded into RPC + entity_kind branching (Agent 2 P1-2).
- **Weeks 3–4** (~1.5 engineer-weeks est, 4 days actual)
  - **Linked-row patches in edit assembler + augment `smoke:edit-booking` and `smoke:edit-booking-scope` with Fixture D/B** (Agent 3 P0-2 + P0-3) — this is the blast-radius fix.
  - `cancel_booking_with_cascade` RPC + retire TS cancel choreography + emit `booking.cancelled` on every user-cancel path including recurrence (Agent 3 P0-1).
  - New `smoke:cancel-booking` probe.

**By end of 30 days:** 4 of top-10 blockers closed; 5 of must-fix list closed; admin-bypass class eliminated; booking cancel + edit no longer silently drop linked-row state.

### 60 days (atomicity sweep + smoke coverage)

- **Weeks 5–8** (~3 engineer-weeks est, ~1.5 actual)
  - 7 legacy TS-sequence services → RPCs (Slices X.1–X.4 from Agent 5): standalone-order RPC · bundle cascade RPCs · recurrence cancel/split RPCs · workflow-approval-node RPC · visitor invitation + walk-up RPCs.
  - `attach_services_to_existing_booking` RPC (Agent 3 P1-3).
  - Multi-room create → `create_booking_with_attach_plan` (Agent 3 P1-1).
  - Retire `BookingTransactionBoundary` after last caller migrated.
  - Composite `(tenant_id, id)` FK retrofit on bookings + booking_slots first (Agent 1 step 5).
- **Weeks 7–8** (parallel) (~1 engineer-week est, ~3 days actual)
  - New smoke probes: `smoke:create-ticket`, `smoke:approvals`, `smoke:create-booking-with-services`, `smoke:visitors`, `smoke:workflow-spawn`, `smoke:dispatch-batch`. Register in CLAUDE.md mandatory matrix.
  - Augment `smoke:work-orders` for bulk + reassign + getChildTasks + vendor + dispatch-replay.

**By end of 60 days:** Every canonical RPC has live smoke. Every booking lifecycle op (except recurrence series split, in flight per memory) is atomic. The "B.4 COMPLETE" memory is honest at the subsystem level, not just edit-paths.

### 90 days (composite-FK sweep + service-layer split + polish)

- **Weeks 9–10** (~1.5 engineer-weeks est, 1 actual)
  - Composite `(tenant_id, id)` FK retrofit on tickets, work_orders, orders, approvals, asset_reservations + CI guard banning new single-column UUID FKs.
  - `DbService` non-superuser app role (Agent 4 P1).
  - `ticket_visibility_ids` null-location branch tightening (Agent 4 P1).
- **Weeks 11–12** (~1.5 engineer-weeks est, 1 actual)
  - Service-layer case-vs-WO split: pull `getById`/`getChildTasks`/`createBookingOriginWorkOrder` out of `TicketService` (Agent 2 P2-1).
  - `getChildTasks` filter via `work_order_visibility_ids` (Agent 2 P1-5).
  - Step-0 polymorphic `activities` reader cutover; drop shadow trigger; drop `ticket_activities` (Agent 1 P1-1).
  - `booking_visibility_ids` SQL function (Agent 1 P3-2).
  - Tighten `activities.entity_kind` CHECK (Agent 1 P2-1).
  - `asset_reservations` exclusion constraint adds tenant_id (Agent 1 P1-4).
  - `approvals.target_entity_id` polymorphic tenant validation trigger (Agent 1 P1-5).
- **Weeks 13** (~3 days est, 1 actual)
  - Phase 8 TS naming sweep backend (Agent 1 P1-3 step 1 of 4) + diff CI guard. Frontend + fixtures + SQL drops in 90+.

**By end of 90 days:** Every architecture finding from Agents 1–5 closed. The architecture is genuinely best-in-class on the backend. **Not** the product surface — Agent 6's 30/60/90 (Mobile + Teams cards + Outlook add-in + vendor scorecards + reporting + KB + email channel) runs in parallel and is unfinished at end of 90.

---

## Final recommendation

**Can we market XPQT as "best-in-class workplace ops platform" TODAY? NO.**

Two reasons that together close the question:

1. **Architecturally there is one undisclosed P0 (`X-Tenant-Id` header trusted with no JWT cross-check; 9 admin controllers writable cross-tenant by any authed user) and one undisclosed P0 with silent data divergence (edit booking moves the booking, leaves caterer/setup-WO/asset_reservation at the old time).** Either alone is a "your customer found this and you can't unfind it" moment. Both undocumented in any followup before this audit batch.

2. **No buyer-evaluated dimension where XPQT beats every Tier A competitor today.** The 5 BIC scores are wedges (hidden vendor, composite events, GiST exclusion, scope_breakdown, one rule engine). Wedges win demos. RFP scorecards are won on Mobile, Outlook depth, vendor scorecards, reporting, KB, AI — XPQT scores MVP or Missing on every single one of those (Agent 6).

**The exact bar to clear before the claim:**
- All P0 architectural blockers (1–9 in Top 10) closed and smoke-gated. The four canonical RPC families that lack live probes (create-ticket, approvals, create-booking-with-services, cancel-booking) gated. ~30 actual days of focused engineering work.
- At least 3 of the P0 product surfaces shipped to Prod: Mobile (PWA + offline queue + responsive pass), Teams adaptive cards (notifications + approve-in-place), Vendor scorecards + Requester rating. ~12–18 actual weeks per memory `feedback_discount_ai_timelines`.

**Realistic time to "best-in-class" claim being defensible in a customer evaluation:** 4–6 months actual delivery time at current pace. Defensible against deskbird-on-mobile or Robin-on-Outlook claims in 6+ months.

**Closing argument:** The architecture is genuinely impressive — 410 migrations, 22 canonical RPCs, polymorphic workflow, four-axis routing, three-tier visibility, GDPR baseline, GiST conflict prevention, hidden vendor, scope_breakdown dedup. The engineering culture clearly works (B.0 + B.2.A + B.4 retros are exemplary; smoke gates are world-class on the 4 areas they cover). **But "best-in-class architecture" and "best-in-class product" are different claims, and right now the second is dishonest.** The honest one-liner today is *"strong MVP+ across many domains; two domains at production maturity; five wedge moats no competitor has; mid-market only; not yet credible for Outlook-first or mobile-first buyers"* (Agent 6 §exec). The path to the bigger claim is well-mapped — finish the canonical-RPC sweep on bookings/visitors/cancel, ship MS Graph Phase 3/4 + mobile PWA + vendor scorecards. None of it requires a rewrite. All of it requires the same shipping cadence applied to surfaces that aren't routing or ticket execution.

---

## Cross-cutting themes

### Theme 1 — TS-sequence write paths that should be RPCs

Appears in: Agent 1, Agent 2, Agent 3, Agent 5. Pattern: a multi-table write fans out to N supabase-js calls in TS, sometimes wrapped in `BookingTransactionBoundary` / `StandaloneCleanup` / try/catch compensation. CLAUDE.md mandate forbids this; the canonical RPC pattern (advisory_xact_lock + command_operations + same-tx outbox emit) is the replacement, and `create_booking_with_attach_plan` + `grant_booking_approval` + `edit_booking` v5 prove the pattern works. ~12 services still violate. Three risk profiles:
- **Data loss class** (`InvitationService.create`, `KioskService.walkUp`, `OrderService.createStandalone`): a Node crash leaves orphaned PII or duplicate orders on retry.
- **Cascade-decision class** (`BundleCascadeService.cancelLine/cancelBundle`, `RecurrenceService.cancelForward/splitSeries`): partial state with mismatched cascades — caterer prints wrong daglijst, approval stays scoped to cancelled line, etc.
- **Lost-event class** (`ReservationService.cancelOne`, `BookingFlowService.createApprovalRows`): silent missed outbox emit — universal workflow consumers hang forever; stuck-booking class.

### Theme 2 — Smoke fixtures avoiding linked rows hides cascade failures

Appears in: Agent 3, Agent 8. Pattern: smoke probes intentionally seed booking/ticket fixtures *without* their typical attachments (services, orders, asset_reservations, work_orders, visitors). The header comments justify this as scope-narrowing — but the bugs the smoke needs to catch are *exactly* the cascade-through-attachments failure modes (Agent 3 P0-2 + P0-3; Agent 8 §fixture purity). The "services were silently dropped on POST /reservations" bug (memory `project_booking_composer_delta_shipped`) caught in UI testing because no smoke covered linked-services CREATE. Same shape as the current P0-2: edit moves booking, edit assembler emits empty patch arrays, smoke fixture has no linked rows to expose it.

Fix pattern: every probe with a parent entity should have ONE fixture variant that exercises the cascade. `smoke:edit-booking` Fixture D + `smoke:edit-booking-scope` Fixture B + new `smoke:cancel-booking` per the proposals above.

### Theme 3 — Single-column UUID FKs trust the writer; composite FKs trust the schema

Appears in: Agent 1, Agent 4, Agent 2 (table). 66 tables have `tenant_id`; only ~12 have composite `(tenant_id, id)` uniqueness; only ~10 use composite FKs. The newer tables (maintenance_plans 00386, work_orders PM cols 00387) adopted composite — proves the team knows the pattern. The older tables (bookings, tickets, work_orders, orders, approvals, booking_slots, asset_reservations) didn't. Three runtime guards compensate (RLS, trigger-based assertions on polymorphic FKs, `validate_entity_in_tenant`) but they don't fire on `supabase.admin` writes if the writer forgot the helper. Composite FK is the only schema-side guarantee. Retrofit is mechanical; the pattern is proven.

### Theme 4 — Documentation drift in the "living contract" docs is the canary

Appears in: Agent 2, Agent 3, Agent 5, Agent 7. Pattern: CLAUDE.md mandates that `docs/assignments-routing-fulfillment.md` + `docs/visibility.md` + `docs/smoke-gates.md` are living contracts updated in the same PR as triggering code/migrations. Both have drifted: assignments doc still names `edit_booking_slot` (dropped 2026-05-12 via 00379); visibility doc undersells the `PATCH /tickets/bulk/update` gap (says "doesn't call assertVisible" — it does, but lacks everything else); smoke-gates doc missing 2 of 6 probes. Each drift is small alone; together they signal the mandate isn't held in all 3 docs uniformly. The B.4 closing retro is exemplary and is the model the other workstreams should follow.

---

## Contradictions between audits

1. **Doc visibility claim about bulk-update.** Agent 2 says `docs/visibility.md:87` is **wrong** — bulk PATCH *does* call `assertVisible`, just lacks idempotency/perm gates/audit. Agent 7 doesn't catch this because it audits the followup corpus, not visibility-doc-vs-code semantics. Both audits accurate within their scope — surfacing it because it changes the doc-fix shape (replace mischaracterisation, not just add line about gap).

2. **Severity of duplicate migration prefixes.** Agent 1 ranks 10-duplicate-prefixes as P0 ("ordering-determinism risk"). Agent 2 ranks the same finding as P2 ("readers can't reason about what ran before what"). Both are accurate frames — today no correctness bug; tomorrow a future migration claiming "after 00370" is non-deterministic across environments. The split reflects the auditors' lens: Agent 1 (data model) cares about future migrations; Agent 2 (tickets) cares about current ordering. The Integrator verdict treats it as P0 — preventing the future bug is cheaper than the post-mortem.

3. **B.4 completion claim.** Memory says "B.4 COMPLETE". Agent 3 frames this as "accurate for edit paths; misleading as a summary of the whole booking subsystem's state" — because 6 of 12 booking lifecycle ops are still TS choreography. Agent 5 backs this: edit/grant are canonical; cancel/standalone/cascade/recurrence are not. **Both are correct.** The memory entry covers what B.4's stated scope was; the architecture summary covers what "booking subsystem atomic" means. Tighten the memory entry to "B.4 edit-paths COMPLETE; cancel/cascade/standalone/recurrence-split remain (Slices X.1/X.3 ahead)."

4. **Reassign cutover acknowledgement.** Agent 2 P1-1 cites `b2-followups.md:165-170` as "acknowledged in code-review". Agent 5 P1-5 doesn't reference the followup file. Agent 7 confirms `b2-followups` accurately describes the deferral. No contradiction in content — just that Agent 5 missed citing the doc trail; Agent 2's version is the more complete picture.

5. **SLA escalation cron.** Agent 2 P0-2 + Agent 5 inventory both flag the raw-UPDATE behavior. Agent 2 explicitly notes the gap is **not** in any followup doc (`b2-followups` covers reassign but not SLA-escalation-reassign). Agent 7 doesn't catch this because it audits followups for accuracy of what they claim — not for gaps in coverage. Combined picture: undocumented P0.

6. **Smoke gate honesty.** Agent 5 P1-7 lists ~5 missing smoke probes as P1. Agent 8 §P0 lists overlapping items as P0 ("would catch the next 2026-05-01-class P0"). Difference is severity framing: Agent 5 ranks against the established RPC surface ("most of the canonical surface has mocked-only coverage"); Agent 8 ranks against the explicit incident risk ("the 2026-05-01 P0 happened because mocked tests passed"). Both are correct; the Integrator verdict adopts Agent 8's P0 framing because the incident is concrete history, not hypothetical.

— end —

---

## Closure Ledger

Maintainer rule: every agent that closes, partially closes, or deliberately defers a finding from this integrator verdict must update this ledger in the same change. Do not rely on chat history as the record of truth. Add concrete evidence: changed files, migration numbers, tests/smokes run, and any residual risk.

| Date | Finding / Slice | Status | Evidence | Verification | Notes |
|---|---|---|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/00-integrator-verdict.md` | Not run | All findings remain open unless a later row says otherwise. |
| 2026-05-16 | Top-10 blocker #4 / Must-fix #4 — `PATCH /tickets/bulk/update` → orchestrator | **CLOSED (code; review+smoke pending)** | See `docs/follow-ups/audits/02-tickets-work-orders.md` Closure Ledger row P0-1+P2-5 (2026-05-16). Branch `feature/tickets-wo-audit-remediation`. | `pnpm -C apps/api lint` green; `/full-review`+codex+bulk-smoke in Slice 8 | TS-only fix — `set_entity_assignment`/`update_entity_combined` already atomic; audit's "new batch RPC" was optional. Looped the hardened single-path per id. Remaining audit-02 P0/P1 slices tracked on the same branch. |
| 2026-05-16 | Top-10 blocker #5 / Must-fix #5 — SLA escalation cron → `set_entity_assignment` | **CLOSED (code; live smoke → Slice 8)** | See `docs/follow-ups/audits/02-tickets-work-orders.md` Closure Ledger rows P0-2 + P0-2 review-trail (2026-05-16). Branch `feature/tickets-wo-audit-remediation`. Commits ba1a4322→b93c5ed7. | tsc + errors:check-app-errors green; `/full-review` (2 agents) + codex ×3 substantive BLOCK rounds; final closure self-verified by trace (codex#4 process resource-starved by concurrent audit-03 session). | TS-only — RPCs already atomic, no migration. Recurrence-safety hardened well beyond the raw P0 (anchor-first ordering; every pre-anchor await non-throwing by construction). SLA-escalation live smoke probe = Slice 8 (none exists; audit §331 #4). |
| 2026-05-16 | Must-fix #9 — both reassign paths → atomic + reason/activity (Agent 2 P1-1; +P1-4/P2-2/P2-4) | **CLOSED (code; live smoke → Slice 8)** | See `docs/follow-ups/audits/02-tickets-work-orders.md` Closure Ledger rows P1-1+P1-4+P2-2+P2-4 + P1-1 review-trail (2026-05-16). Commits 380098e0 + ad34d44f. | tsc + errors:check-app-errors green; 22/22 reassign specs; `/full-review` 2-agent adversarial pass (Plan-C2 ordering defect folded; Plan-C1 verified false). codex tertiary gate unobtainable (3× hung under concurrent audit-03 codex contention) — gate = /full-review + self-verify + green gates/specs. | TS-only — `set_entity_assignment` (00327 v2) already atomic; audit's "extend RPC / sibling RPC" was a stale 00326 read. FORK-1a + FORK-2 adjudicated by codex design-check. P2-2 fully closed only for reassign sites; routing.service/handler residual → Must-fix #10 / Slice 4. Reassign happy-path smoke = Slice 8. |
| 2026-05-16 | Must-fix #10 — routing-evaluation handler: fold `routing_status` clear into RPC + entity_kind (Agent 2 P1-2) | **CLOSED (code + remote migration verified; live smoke → Slice 8)** | See `docs/follow-ups/audits/02-tickets-work-orders.md` Closure Ledger row P1-2 + inline Update block (2026-05-16). Migration `00406_set_entity_assignment_v3_clear_routing_status.sql` **pushed to remote + verified** (`pg_get_functiondef` → t\|t\|t). Commits 81343650 + b163ee5d. | tsc + errors:check-app-errors green; 10/10 handler spec; `/full-review` 2-agent (Code-I2 folded; Plan-I2 verified false); remote function body verified v3. codex unobtainable (concurrent-session contention) — gate = /full-review + per-caller backward-compat + verified remote body. | First DB push of the workstream (standing auth). v3 opt-in flag → byte-identical to v2 for the 4 existing callers. Handler `routing_decisions` entity_kind now explicit (P2-2 site closed). Residuals (non-P0): Plan-C1 cross-session clobber (detection mechanism in place); Code-I1 handler-insert replay non-idempotency (pre-existing). |

## Agent Handoff Prompt

```text
You are the lead architecture remediation agent for:
docs/follow-ups/audits/00-integrator-verdict.md

Goal:
Drive the entire audit program to completion. Treat this file as the cross-audit backlog and source of sequencing. You are not expected to land one mega-change. You are expected to plan, split, execute, review, and keep this document current until every blocker in the integrator verdict is closed or explicitly deferred with evidence.

Read first:
- AGENTS.md / CLAUDE.md
- docs/follow-ups/audits/00-integrator-verdict.md
- The specialist audit docs 01 through 08 before touching their areas
- docs/smoke-gates.md

Execution model:
1. Build a checklist from the Top 10 blockers, Required refactors, Required smoke tests, and Required doc corrections.
2. Split work into small slices with disjoint write sets where possible.
3. Run parallel subagents only for read-only investigation or clearly independent implementation slices.
4. After each slice, run a review pass before continuing. The review must check code, migrations, docs, tests, and smoke requirements for that slice.
5. Never run `pnpm db:push`, `supabase db push`, or direct remote psql migration application without explicit user approval.
6. Do not mark this verdict "done" while any P0/P1 item remains open without an explicit deferred rationale.

Required closure behavior:
- Update the Closure Ledger in this file after every completed or deferred slice.
- If a specialist audit file is affected, update that specialist file's Closure Ledger too.
- If code changes make a living-contract doc stale, update the doc in the same change.
- For each closed finding, record changed files, migration numbers, tests/smokes run, and residual risk.

Completion bar:
- All P0 architectural blockers in this verdict are fixed and smoke-gated.
- Existing unregistered smoke probes are documented.
- New required smokes are added or each missing smoke has an explicit deferred owner and risk statement.
- Specialist audit docs 01 through 08 agree with the final state.
- Final response includes: closed items, deferred items, verification run, and remaining best-in-class gaps.
```
