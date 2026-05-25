# XPQT Architecture Audit — Seed Prompt

This is the master prompt used to run the 8-agent + integrator architecture audit.
Re-use verbatim (or as a starting point) when running the audit again. First run produced reports `01-08` and `00-integrator-verdict.md` in this folder on 2026-05-13.

## How to dispatch

1. Spawn 8 specialist agents IN PARALLEL using the per-agent prompts below. Each is read-only and writes one report file under this folder (`01-data-model.md` … `08-smoke-coverage.md`).
2. After all 8 reports exist on disk, spawn the integrator agent (last section). It synthesizes them into `00-integrator-verdict.md`.
3. Each agent should return a ≤6-line summary to the orchestrator; full output goes to its file.

## Standard constraints for every agent

- READ-ONLY. No source edits, no DB writes, no commits.
- No `db:push`, no `db:reset`, no `psql` writes, no smoke-script execution.
- The only file each agent may WRITE is its own report.
- Static analysis only — do not query the live remote DB.
- Tool-use budget: aim for ≤80 calls per agent; sample, don't enumerate.

---

## Master Prompt For Every Agent

You are auditing the XPQT / Prequest codebase for best-in-class architecture readiness.

**Goal:**
Determine whether the current data model, ticket/work-order model, booking/reservation model, migrations, RPC boundaries, RLS, and operational architecture are actually complete and best-in-class, or whether there are remaining correctness, scalability, security, or product-architecture gaps.

**Repository:**
- Root: `/Users/x/Desktop/XPQT`
- Read `AGENTS.md` first and follow its constraints.
- Do not make destructive changes.
- Do not run `db:push`, `db:reset` against remote, or any write command without explicit approval.
- Prefer read-only analysis unless your task explicitly asks for a patch.

**Sources you must inspect:**
1. Actual code under:
   - `apps/api/src/modules/**`
   - `apps/web/src/**`
   - `packages/shared/**`
2. Database migrations under:
   - `supabase/migrations/**`
3. Follow-up / status docs:
   - `docs/follow-ups/**`
4. Architecture / product docs:
   - `docs/**`
   - `docs/superpowers/specs/**`
   - `docs/superpowers/plans/**`
5. Smoke scripts:
   - `apps/api/scripts/**`
6. Tests/specs:
   - `apps/api/src/**/*.spec.ts`
   - `supabase/tests/**`
7. If credentials are available and approval is granted, query the live Supabase catalog read-only:
   - tables, columns, FKs, checks, indexes, policies, triggers, functions, RLS status
   - do not mutate data.

**Important:**
Do not treat docs as truth. Treat docs as claims. Verify them against code, migrations, tests, and live schema when possible.

**Definitions:**
"Best-in-class architecture" means:
- Clear bounded domains and ownership.
- Canonical source of truth for each concept.
- No duplicated legacy model still driving behavior.
- Cross-table invariants enforced transactionally.
- Multi-step writes done in Postgres RPCs where partial state would corrupt correctness.
- Idempotency for external/user-triggered mutations.
- Tenant isolation enforced by both API visibility and database RLS.
- Query paths aligned with visibility/authorization rules.
- Strong constraints, indexes, and FK design.
- Explicit lifecycle/state-machine rules.
- Migration chain is coherent and current.
- Smoke tests prove critical live DB paths, not just mocks.
- Product architecture supports real operations, not just demos.

**Required output format:**
1. Executive verdict:
   - Done / mostly done / not done
   - Best-in-class / close / not close
   - Confidence level
2. Evidence-backed findings:
   - Severity: P0, P1, P2, P3
   - Area
   - Concrete evidence with file paths and line numbers
   - Why it matters
   - Recommended fix
3. Docs-vs-code drift:
   - Claims in docs that are stale, false, or not implemented
4. Data model assessment:
   - What is canonical
   - What is legacy
   - What is duplicated
   - What should be retired
5. Transactionality / idempotency assessment:
   - Which writes are properly atomic
   - Which writes still have split-write / compensation / direct-table gaps
6. RLS / security assessment:
   - Tables without RLS or weak policies
   - SECURITY DEFINER functions that need scrutiny
   - Cross-tenant FK risks
7. Testing / smoke gaps:
   - What is covered
   - What is not covered
   - What new smoke probes are required
8. Recommended roadmap:
   - Must-fix before "best-in-class" claim
   - Should-fix
   - Later polish

---

## Agent 1: Data Model / Database Architecture

You are the Data Model Architecture Agent.

**Focus:**
Audit whether the XPQT database schema is coherent, canonical, and best-in-class.

**Inspect:**
- `supabase/migrations/**`
- `docs/data-model-redesign-2026-04-30.md`
- `docs/data-model-step1c-plan.md`
- `docs/follow-ups/**`
- `docs/superpowers/specs/2026-05-02-booking-canonicalization-*.md`
- `docs/superpowers/specs/2026-05-04-domain-outbox-design.md`
- `apps/api/src/modules/**` where database writes occur

**Questions to answer:**
1. Is the data model rework actually complete?
2. Are old tables/columns still active in production code?
3. Are canonical entities clear?
   - tickets vs work_orders
   - bookings vs reservations
   - booking_slots
   - recurrence_series
   - orders / order_line_items
   - approvals
   - work_orders
   - activities / audit / outbox
4. Are there duplicated sources of truth?
5. Are foreign keys, unique constraints, check constraints, and partial indexes sufficient?
6. Are tenant_id constraints consistently present?
7. Are cross-tenant FK leaks possible?
8. Are legacy compatibility triggers still required, or are they hiding unfinished migration work?
9. Are migrations ordered cleanly, or are there conflicting duplicate prefixes / stale redefinitions?
10. Are database functions / RPCs the right transactional boundaries?

**Deliver:**
- Verdict on whether the data model rework is done.
- List of legacy remnants that still matter.
- List of tables/columns/functions that should be retired or consolidated.
- Best-in-class target model.
- Migration plan to get there.

---

## Agent 2: Ticket / Work-Order Architecture

You are the Ticket and Work-Order Architecture Agent.

**Focus:**
Audit the ticket / case / work-order model for best-in-class service-management architecture.

**Inspect:**
- `apps/api/src/modules/ticket/**`
- `apps/api/src/modules/work-orders/**`
- `apps/api/src/modules/routing/**`
- `apps/api/src/modules/sla/**`
- `apps/api/src/modules/approval/**`
- `apps/api/src/modules/workflow/**`
- `supabase/migrations/**` involving:
  - tickets
  - work_orders
  - routing_decisions
  - sla_timers
  - command_operations
  - activities
  - approvals
- `docs/assignments-routing-fulfillment.md`
- `docs/visibility.md`
- `docs/follow-ups/**`
- `docs/service-management-*.md`
- `apps/api/scripts/smoke-work-orders.mjs`

**Questions to answer:**
1. Is the case vs work-order split fully complete?
2. Are tickets only cases now, or do work-order semantics still leak through tickets?
3. Are all important mutations routed through atomic RPCs?
4. Are any direct table writes still bypassing command_operations, audit, outbox, or visibility?
5. Are reassignment, SLA changes, status transitions, dispatch, bulk updates, satisfaction rating, and planning all consistent?
6. Is routing clearly separated from ownership, execution, and visibility?
7. Are vendor, team, and user assignment paths equally first-class?
8. Are terminal-state rules strong enough?
9. Is visibility enforced consistently for reads and writes?
10. Does the smoke gate prove the full live DB surface?

**Pay special attention to:**
- `TicketService.update`
- `TicketService.reassign`
- `TicketService.bulkUpdate`
- `WorkOrderService.update / reassign / planning`
- dispatch RPCs
- `update_entity_combined` RPC
- `transition_entity_status` RPC
- `ticket_visibility_ids`
- work_order visibility functions

**Deliver:**
- Verdict: best-in-class, close, or incomplete.
- Concrete list of direct-write escape hatches.
- Which paths need to move into RPCs.
- Any mismatch between docs and actual code.
- Missing smoke tests.

---

## Agent 3: Booking / Reservation Architecture

You are the Booking and Reservation Architecture Agent.

**Focus:**
Audit whether the booking model is now canonical, transactional, and best-in-class.

**Inspect:**
- `apps/api/src/modules/reservations/**`
- `apps/api/src/modules/booking-bundles/**`
- `apps/api/src/modules/approval/**`
- `apps/api/src/modules/work-orders/**`
- `supabase/migrations/**` involving:
  - bookings
  - booking_slots
  - reservations
  - recurrence_series
  - asset_reservations
  - orders
  - order_line_items
  - approvals
  - inbox_notifications
  - command_operations
  - `edit_booking`
  - `edit_booking_scope`
  - `create_booking`
  - `create_booking_with_attach_plan`
  - `delete_booking_with_guard`
- `apps/api/scripts/smoke-edit-booking.mjs`
- `apps/api/scripts/smoke-edit-booking-scope.mjs`
- `docs/booking-platform-roadmap.md`
- `docs/booking-services-roadmap.md`
- `docs/room-booking.md`
- `docs/follow-ups/**`
- `docs/superpowers/specs/2026-05-02-booking-canonicalization-*.md`
- `docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md`
- `docs/superpowers/specs/2026-04-26-linked-services-design.md`

**Questions to answer:**
1. Is `bookings + booking_slots` now the real source of truth?
2. Is `reservations` fully retired, compatibility-only, or still behaviorally active?
3. Are create, edit-one, edit-slot, edit-scope, cancel/delete, recurrence split, approval, service attach, and notification flows atomic?
4. Do edit plans actually populate all linked-row patches?
   - asset_reservations
   - orders
   - order_line_items
   - work_orders
   - approvals
   - inbox notifications
5. Do smoke tests cover bookings with linked services, orders, work_orders, approvals, asset reservations, and recurrence?
6. Are no-service bookings and service bookings equally safe?
7. Is multi-room booking transactional, or still relying on in-process compensation?
8. Are recurrence operations safe against partial split failures?
9. Are conflict constraints and exclusion indexes correct?
10. Is calendar / Graph synchronization modeled but not implemented?

**Pay special attention to:**
- `AssembleEditPlanService`
- `ReservationService.editOne / editSlot / editScope`
- `BookingFlowService`
- `MultiRoomBookingService`
- `BookingTransactionBoundary`
- `edit_booking` RPC
- `edit_booking_scope` RPC
- `create_booking_with_attach_plan` RPC
- smoke fixtures that intentionally avoid linked services

**Deliver:**
- Verdict on booking architecture.
- Whether B.4 / canonicalization is truly complete.
- Exact remaining correctness gaps.
- Required additional smoke tests.
- Recommended final architecture.

---

## Agent 4: RLS / Security / Tenant Isolation

You are the RLS and Security Architecture Agent.

**Focus:**
Audit tenant isolation, RLS, SECURITY DEFINER functions, API visibility, and cross-tenant safety.

**Inspect:**
- `supabase/migrations/**`
- `docs/visibility.md`
- `docs/superpowers/specs/2026-04-20-visibility-scoping-design.md`
- `apps/api/src/common/**`
- `apps/api/src/modules/**` visibility / auth / guard code
- `packages/shared/src/permissions.ts`
- `packages/shared/src/role-defaults.ts`

**Questions to answer:**
1. Which public tables lack RLS?
2. Which RLS policies are tenant-only and too broad?
3. Which SECURITY DEFINER functions can bypass RLS?
4. Do SECURITY DEFINER functions validate `tenant_id` on every input FK?
5. Are user permissions checked in API only, DB only, or both?
6. Are ticket / work_order / booking visibility rules aligned?
7. Are vendor users currently real participants or dormant placeholders?
8. Are reporting / search / global scheduler functions visibility-safe?
9. Are there cross-tenant FK risks caused by single-column UUID FKs instead of composite tenant-aware constraints?
10. Are service-role-only tables protected from browser clients?

**Deliver:**
- Table-by-table RLS summary.
- Top cross-tenant risks.
- SECURITY DEFINER functions needing review.
- Visibility holes.
- Recommended hardening plan.

---

## Agent 5: RPC / Transaction Boundary / Idempotency

You are the Transaction Boundary and Idempotency Agent.

**Focus:**
Audit whether all critical multi-table writes are atomic, idempotent, and retry-safe.

**Inspect:**
- `supabase/migrations/**` RPCs / functions
- `apps/api/src/modules/**` service write paths
- `packages/shared/src/idempotency.ts`
- `docs/superpowers/specs/2026-05-04-domain-outbox-design.md`
- `docs/follow-ups/**`
- smoke scripts under `apps/api/scripts/**`

**Questions to answer:**
1. Which API mutations write to more than one table?
2. Which are implemented as one PL/pgSQL RPC?
3. Which are still TypeScript sequences?
4. Which use command_operations / idempotency keys?
5. Which are retry-safe?
6. Which can leave partial state if Node crashes?
7. Which perform outbox / inbox / audit writes in the same transaction?
8. Which use advisory locks or row locks correctly?
9. Which idempotency scopes are too broad or too narrow?
10. Which smoke tests prove real DB write paths?

**Deliver:**
- Matrix of mutation → transactional boundary → idempotency → risk.
- List of highest-risk split writes.
- Concrete RPC consolidation plan.

---

## Agent 6: Product Architecture / Best-In-Class Gap Analysis

You are the Product Architecture Agent.

**Focus:**
Judge whether the current architecture supports a best-in-class workplace operations platform, not merely whether the code compiles.

**Inspect:**
- `docs/booking-platform-roadmap.md`
- `docs/booking-services-roadmap.md`
- `docs/service-management-improvement-roadmap-2026-04-20.md`
- `docs/competitive-benchmark.md`
- `docs/competitive-gap-analysis-2026-04-20.md`
- `docs/superpowers/specs/**`
- `docs/follow-ups/**`
- `apps/api/src/modules/**`
- `apps/web/src/**`

**Compare the product architecture against top-tier expectations for:**
- ServiceNow-like service management
- OfficeSpace / Robin / Envoy-style workplace booking
- Vendor operations / fulfilment
- Facility work-order execution
- Visitor management
- Approval workflows
- SLA / escalation
- Audit / compliance
- Reporting / analytics
- Mobile-first workflows
- Microsoft 365 / Google calendar integration

**Questions to answer:**
1. Which domains are architecturally strong?
2. Which domains are MVP-only?
3. Which features are documented but not built?
4. Which features are built but not operationally complete?
5. Which personas are under-modeled?
   - requester
   - service desk
   - facility operator
   - vendor
   - approver
   - receptionist
   - admin
6. Does the data model support future best-in-class workflows, or will it need another rework?
7. Which missing product capabilities block a "best-in-class" claim?

**Deliver:**
- Best-in-class readiness score by domain.
- Product-architecture gaps.
- Top 10 capabilities required before claiming leadership.
- Recommended sequencing.

---

## Agent 7: Docs Drift / Follow-Up Closure

You are the Docs Drift and Follow-Up Closure Agent.

**Focus:**
Find every place where docs claim work is done, deferred, open, or blocked, then verify against actual code and migrations.

**Inspect:**
- `docs/follow-ups/**`
- `docs/**`
- `docs/superpowers/specs/**`
- `docs/superpowers/plans/**`
- `AGENTS.md`
- `apps/api/src/modules/**`
- `supabase/migrations/**`
- `apps/api/scripts/**`

**Questions to answer:**
1. Which follow-up items are truly closed?
2. Which are marked closed but not actually implemented?
3. Which are marked open but appear implemented?
4. Which docs contradict one another?
5. Which docs describe legacy architecture that is no longer true?
6. Which mandatory smoke gates exist but do not cover the claimed risk?
7. Which docs should be updated before another engineer trusts them?

**Deliver:**
- Follow-up closure table:
  - item
  - doc claim
  - code/schema reality
  - verdict
  - evidence
- Stale docs list.
- Missing docs list.
- Recommended doc cleanup PR.

---

## Agent 8: Smoke / Test Coverage

You are the Smoke and Test Coverage Agent.

**Focus:**
Decide whether tests and smoke gates prove the architecture, especially against real database behavior.

**Inspect:**
- `apps/api/scripts/smoke-*.mjs`
- `apps/api/src/**/*.spec.ts`
- `supabase/tests/**`
- `package.json` scripts
- `AGENTS.md` smoke gate instructions
- `docs/follow-ups/**`
- migration RPCs under `supabase/migrations/**`

**Questions to answer:**
1. Which critical flows have live-API smoke tests?
2. Which critical flows only have mocked Supabase / Jest tests?
3. Which smoke fixtures are too clean and avoid risky linked rows?
4. Which known failure modes are not covered?
5. Are smoke scripts actually validating DB state after mutations?
6. Are RLS failures covered?
7. Are idempotency replay and payload mismatch covered?
8. Are partial failure and concurrency / race cases covered?
9. Which commands should be mandatory before claiming done?
10. Which smoke tests need linked services / orders / work_orders / approvals fixtures?

**Deliver:**
- Coverage matrix by domain.
- Smoke gaps ranked by severity.
- Proposed new smoke probes.
- Exact pass/fail criteria.

---

## Integrator Prompt

Give this to a final agent after the others finish.

You are the Architecture Integrator.

You will receive reports from:
1. Data Model Architecture Agent
2. Ticket / Work-Order Architecture Agent
3. Booking / Reservation Architecture Agent
4. RLS / Security Agent
5. Transaction Boundary / Idempotency Agent
6. Product Architecture Agent
7. Docs Drift Agent
8. Smoke / Test Coverage Agent

**Your task:**
Synthesize them into one final answer for leadership.

**Output:**
1. One-page executive verdict:
   - Is data model rework done?
   - Is ticket/work-order best-in-class?
   - Is booking/reservation best-in-class?
   - Is the whole architecture best-in-class?
2. Confidence level and why.
3. Top 10 blockers to best-in-class.
4. Top 10 strengths worth preserving.
5. "Do not touch" architectural principles.
6. Required refactors before claiming done.
7. Required smoke tests before claiming done.
8. Required doc corrections.
9. 30 / 60 / 90-day roadmap.
10. Final recommendation:
    - Can we market this as best-in-class now?
    - If not, what exact bar must be met?

---

## Closure Ledger

Every agent that updates this prompt pack must add a row here in the same change. This file is meta-process, so "done" means the prompt set matches the current audit structure and still produces evidence-based reports.

| Date | Agent / owner | Status | Evidence | Verification | Notes |
|---|---|---:|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/_AUDIT-PROMPT.md` | Not run | Keep this prompt pack aligned with the numbered audit reports. |

## Agent Handoff Prompt

```text
You are the audit-prompt maintenance agent for Prequest.

Primary file:
- docs/follow-ups/audits/_AUDIT-PROMPT.md

Goal:
Keep the master audit prompt pack aligned with the current audit reports, remediation workflow, and architecture standards. This file should help future specialist agents produce evidence-based audits and fixes, not stale restatements of old docs.

Read before editing:
- AGENTS.md and CLAUDE.md
- docs/follow-ups/audits/_AUDIT-PROMPT.md
- docs/follow-ups/audits/00-integrator-verdict.md
- docs/follow-ups/audits/01-data-model.md
- docs/follow-ups/audits/02-tickets-work-orders.md
- docs/follow-ups/audits/03-booking-reservation.md
- docs/follow-ups/audits/04-rls-security.md
- docs/follow-ups/audits/05-rpc-transactions.md
- docs/follow-ups/audits/06-product-architecture.md
- docs/follow-ups/audits/07-docs-drift.md
- docs/follow-ups/audits/08-smoke-coverage.md

Execution model:
1. Compare this prompt pack to the current numbered audit files. Add, remove, or revise specialist prompts when the audit set changes.
2. Ensure every specialist prompt tells agents to verify against actual code/database state, update the relevant audit doc, update canonical docs, and record work in a Closure Ledger.
3. Keep the integrator prompt aligned with the current evidence model: top blockers, strengths, do-not-touch principles, smoke gates, doc corrections, and roadmap.
4. Remove stale assumptions from this file when audits are closed or when architecture standards change.
5. Do not mark product or architecture work complete here. Completion claims belong in the relevant numbered audit doc with evidence.

Required output after each slice:
- Prompt changes in this file.
- A short explanation of which numbered audit reports drove the change.
- One Closure Ledger row in this file.

Completion bar:
- This prompt pack references the current audit files and no removed scopes.
- Every prompt pushes agents toward code/database verification, small reviewable slices, smoke evidence, and doc-ledger updates.
- A fresh integrator agent can use this file without rediscovering the remediation process from scratch.
```
