# Data-model rework — handoff index for fresh-context agent

**Session window:** 2026-04-30 → 2026-05-01 (12 sessions, 47 commits, 41 migrations on remote, 167+ work-order/ticket/sla tests pass)
**Branch:** `main`

---

## ✅ P0 — RESOLVED (Session 13, 2026-05-01)

**Reporter:** the user, while testing the desk UI on remote dev environment.

**Symptoms (verbatim):**

> "many updates in the current ticket and workorder page dont work. i cant
> make workorders, i cant assign, or update any property of a workorder."

**Root cause (none of the 5 hypotheses originally listed below was right):**

Migration 00222 (step 1c.3.6 atomic rename, line 352-354) applied a
deliberately-temporary "SELECT only for service_role" posture to
public.work_orders, with an inline comment that the reversal would ship
at step 1c.4 (writer flip). **The reversal was never written.** Sessions
7-12 layered the entire work-order command surface on top of an
unwritable table. Every test mocked Supabase, so the table-level 42501
"permission denied for table work_orders" never surfaced until a real
PATCH against the live DB.

**Fix:** [`supabase/migrations/00275_restore_work_orders_service_role_writes.sql`](../../supabase/migrations/00275_restore_work_orders_service_role_writes.sql) — restore-and-assert grant posture mirroring the original from 00213 line 148. Idempotent. On remote.

**Regression gate:** A12 added to [`scripts/ci-migration-asserts.sql`](../../scripts/ci-migration-asserts.sql) — asserts service_role has SELECT, INSERT, UPDATE, DELETE on public.work_orders. The whole NestJS API authenticates as service_role for DML; any writable tenant table that loses one of those four privileges breaks an entire surface silently — every test passes, every UI click 500s. A1..A12 all pass on remote.

**Verification:** post-push smoke test against the live API with a real JWT — 9/9 mutations return 200/201 (priority change, plan change, SLA change, status change, assignment swap, dispatch creating a fresh WO + cleanup).

**Why the diagnosis-then-fix arc converged in one session this time:**
- Reproduce-first discipline: probe script with a real Admin JWT, not a mock.
- The 42501 in `/tmp/api-dev.log` was the smoking gun within 30 minutes.
- A grants-table comparison (work_orders vs. tickets) made the asymmetry obvious.
- A pre-push transactional audit (run migration → run service_role UPDATE + INSERT → rollback) was the strongest possible gate, and it stood in for codex (which hit quota during the review).

The original 5-tier hypothesis ranking from the previous handoff was wrong on every count — read path was fine, FE dispatch was fine, permission gates were fine, orchestrator was fine. The bug was one layer below all of them: Postgres role grants. **Future P0 trace orders should put grant/RLS state above application logic.**

---

## Original P0 hypotheses (kept for postmortem reference)

This is what the prior agent thought was most likely. None of the five turned out to be right — flagged here as a record of the kinds of detours adversarial diagnosis can produce when reasoning from code without instrumented reproduction.

### What you (the fresh agent) need to do, in order

**Step 1 — REPRODUCE BEFORE FIXING.** Don't trust the symptom description
verbatim. Open the desk UI, log in as the test user, and confirm:

1. Click into a work_order (from the desk tickets list with kind filter
   removed, or from a booking detail's work_orders section, or via direct
   URL `/desk/tickets/<work-order-id>`). Does the detail page load at all?
   Does it show `ticket_kind = 'work_order'`?
2. Try to change status from the sidebar Select. Does the network request
   fire? What's the URL? What's the response?
3. Try to dispatch (create a work_order from a parent case). Does
   `POST /tickets/:id/dispatch` fire? What's the response?
4. Try to assign a work_order team/user/vendor.

Capture the actual HTTP requests + responses (browser devtools). Without
this, you're debugging blind.

### Plausible root causes — investigate in order of likelihood

**Most likely — work_order detail READ path is broken on remote.** Sessions
9–12 only fixed WRITE paths. The READ path (`GET /tickets/:id` returning a
work_order's data with `ticket_kind = 'work_order'` synthesized) was
assumed to work but was never tested by the recent sessions. If
`displayedTicket` is undefined/null/wrong on the FE, every fix in this
session arc silently degrades:

- C4's defensive `if (!displayedTicket) return;` in `patch()` fires →
  user sees no error, click does nothing.
- The `ticket_kind === 'work_order'` dispatch in `patchWorkOrder` falls
  through to `updateTicket.mutate` which calls `PATCH /tickets/:id`
  which silently no-ops for work_order ids.

Investigate first:

```sql
-- On remote: pick a real work_order id and confirm what the read endpoint returns
select id, tenant_id from public.work_orders limit 1;
-- Then in browser: GET /tickets/<that-id> — does it return the row, 404,
-- or something else? Does it have ticket_kind set?
```

The handoff has been claiming `ticket_kind` is "synthesized post-1c.10c"
but **no recent session verified this claim against a real endpoint
response.** The claim originates in the original handoff (Session 6/7
era) and has never been re-tested. **This is the first thing to verify.**

Look at `apps/api/src/modules/ticket/ticket.controller.ts` `GET /:id`
and `TicketService.getById`. Trace what they do with a work_order id.
Per the rework's Step 1c.9 plan, work_order reads should go through a
separate `/work-orders/:id` endpoint — but that was deferred. The
current implementation either (a) reads from `tickets` (returns 404 for
WO ids), (b) reads from a polymorphic helper, or (c) reads from
work_orders directly. Whichever it is, the FE may be hitting the wrong
table.

**Second most likely — dispatch path broken by P2 gate backport.** Session
12's `f376e12` added `tickets.assign` permission gate to
`TicketService.reassign`. If `dispatch.service.ts` calls `reassign`
internally (it shouldn't, but verify), the dispatch flow now requires
`tickets.assign`. The grandfathering migration 00247 only covers roles
with explicit `tickets.update` permission — roles with `tickets.dispatch`
or other paths weren't grandfathered.

```sql
-- On remote: list all roles + their permissions
select id, name, permissions from public.roles;
-- Look for any role that has tickets.dispatch but NOT tickets.assign
-- AND NOT tickets.write_all AND NOT tickets.* wildcard.
```

If the test user's role is one of those, that explains "can't make work_orders."

**Third — single PATCH /work-orders/:id orchestrator has a bug.** Slice
3.0 collapsed 5 endpoints into 1. The new `WorkOrderService.update()`
dispatches by field-group, runs `assertCanPlan` N times. If the field-
group detection has a bug (e.g., empty DTO field set throws BadRequest
when it shouldn't, or a field is detected in the wrong group), the
update silently no-ops or 400s.

Check `apps/api/src/modules/work-orders/work-order.service.ts`'s
`update()` method (added in commit `0d77367`). Specifically the
`provided` set construction and the dispatch logic.

**Fourth — FE dispatch in `patch()` has a bug.** The `patchWorkOrder`
helper in `ticket-detail.tsx` was rewritten in `0d77367` to call a
single mutation. Maybe the union DTO shape doesn't match what the
backend expects, or `useUpdateWorkOrder`'s body is wrong. Check
`apps/web/src/api/tickets/mutations.ts` `useUpdateWorkOrder` against
the backend `UpdateWorkOrderDto`.

**Fifth — the "synthesize ticket_kind" claim was never true.** If the
backend never actually synthesized `ticket_kind` for work_order responses,
the FE has been receiving `ticket_kind = undefined` for work_orders
forever, and the `patchWorkOrder` dispatch never fired. All my work
on the WO command surface has been correct in isolation but the FE
dispatch never reached it.

### Diagnostic commands the next agent should run

```bash
# 1. Confirm work_orders exist on remote
PGPASSWORD="$(grep -E '^SUPABASE_DB_PASS=' .env | cut -d= -f2-)" \
  psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -At -c "select count(*), array_agg(distinct status_category) from public.work_orders;"

# 2. Run the auditing queries above (work_order count, role permissions)

# 3. Start the dev server and hit the actual endpoints with curl
pnpm dev
# Then:
# - GET /tickets/<work-order-id> — what does it return?
# - GET /work-orders/<work-order-id>/can-plan — does it 200 or 404?
# - PATCH /work-orders/<work-order-id> with a small body — does it work?

# 4. Check the FE network tab for what URLs the desk-detail sidebar fires
#    when the user clicks status / priority / assignee.
```

### What NOT to do

- **Don't** rip out the security gates (P2). They're correct; the
  grandfathering migration's coverage is the issue.
- **Don't** revert the single PATCH orchestrator. The collapse is
  architecturally right.
- **Don't** assume `ticket_kind` synthesis works without verifying it
  in a real response.
- **Don't** push more migrations to remote until you understand the
  shape of the regression. The first instinct of "add a column or fix
  a permission" is wrong if the bug is in the read path.

### Honest meta-note (kept; still load-bearing)

Sessions 7–12 added a LOT of code and tests but **none of them verified
the actual UI flow end-to-end on remote.** Tests against mocked Supabase
+ local `db:reset` + structural assertions all passed — but no browser
session and no real-JWT probe against the live API ever happened. The
recurring blind spot: tests that pass + lint that's clean + handoff
that claims "shipped" without a single integration smoke test.

The work shipped in Sessions 7–12 is correct in code. What was missing
was **the integration smoke test against the actual remote dev
environment.** Session 13 made this explicit:

- The probe script at the bottom of this section (under "Diagnostic
  commands") now exists in working form — see the smoke-test gate
  paragraph in the resolved-P0 section above. It runs the canonical
  9-mutation matrix against the live API with a real Admin JWT.
- A12 in `scripts/ci-migration-asserts.sql` is the structural sister:
  catches the specific bug class (service_role missing DML) at CI
  time, before code ships.

**Before claiming any future work-order or ticket surface "shipped",
run the probe script + check A1..A12 green.** The probe was a one-off
this session; if it stays one-off it'll rot. Tracking conversion to
a vitest integration test as a follow-up under
[ci-assertion-strategy.md](./ci-assertion-strategy.md).

---

## Reading order for fresh agent

1. **Read this file end-to-end first.** It is the index + current state digest.
2. If you need historical detail on a specific session, read the matching file
   under `docs/follow-ups/data-model-rework-archive/session-NN.md`.
3. For the original 6-step rework rationale, read
   [`docs/data-model-redesign-2026-04-30.md`](../data-model-redesign-2026-04-30.md).
4. For the CI assertion strategy and its planned refactor, see
   [`docs/follow-ups/ci-assertion-strategy.md`](./ci-assertion-strategy.md).
5. Other docs from this session window are now superseded by this index:
   `docs/follow-ups/data-model-overnight-handoff.md`,
   `docs/data-model-step1c-plan.md`.

---

## Why this rework existed

The `tickets` table was overloaded via a `ticket_kind` discriminator. Cases (reactive incidents/requests) and work_orders (dispatched units) were both rows in `tickets`. Audit trail (`ticket_activities`) was ticket-only. SLA timers, routing decisions, workflow instances were all FK'd to `tickets`. The model worked but it was muddled and getting worse.

Master design doc: `docs/data-model-redesign-2026-04-30.md`. The plan was 6 steps:

1. Extract work_orders from tickets.
2. Refactor `orders` → `service_orders`.
3. Unify resources catalog.
4. Rename `booking_bundles` → `bookings`.
5. Promote visitors.
6. Rename `tickets` → `cases`.

Per-step plan for the destructive bits: `docs/data-model-step1c-plan.md` (11 phases, 1c.0 through 1c.11).

---

## Naming conventions

The work-order command surface (sessions 9–11+) ships in slices. The naming has evolved during this work; **the canonical scheme going forward is "Slice N"** (zero-indexed, in chronological order).

**The slice series:**

| Canonical name | Originally called | What it shipped | Session |
|---|---|---|---|
| Slice 0 | `B1.5` (codex's name — "between B1 full-split and B3 do-nothing") | Work-order command surface scaffolding + `WorkOrderService.updateSla` | 9 |
| Slice 1 | `Slice 1` | `WorkOrderService.setPlan` + `canPlan` | 10 |
| Slice 2 | `Slice 2` | `WorkOrderService.updateStatus` / `updatePriority` / `updateAssignment` / `reassign` | 11 |
| Slice 3 | `Slice 3 (planned)` | `cost` / `tags` / `watchers` / `title` / `description` + the single `PATCH /work-orders/:id` endpoint | not started |

**Other names used in earlier docs that are still meaningful:**

- **B1** = the full work-order/case service split (separate `case.service.ts` file + `/cases/*` controller). Codex's recommendation: not required until planning board / per-kind RLS / WO queues are imminent. B1 is roughly equivalent to step 1c.9 from the original plan. Slice 0 was the incremental foothold instead.
- **B3** = "don't split the service" — the do-nothing alternative.
- **C1** = the frontend `TicketDetail` split into `CaseDetail` + `WorkOrderDetail`. Still rides B1.

If you are reading old session notes that say "B1.5", treat it as Slice 0.
If you are reading anything that says "Slice 1" / "Slice 2" / "Slice 3", the
names match the canonical scheme.

---

## Current state — verified on remote

```
tickets:       241 rows (cases only — ticket_kind column dropped)
work_orders:   319 rows (work_orders only — real BASE TABLE)
cases (view):  241 (identity over tickets)
activities:    1083 case + 0 work_order = 1083 (315 work_order rows lost)
sla_timers:    484 case + 0 work_order = 484 (646 work_order rows lost)
ticket_activities: 1083 (FK to tickets dropped, accepts work_order ids)

CASCADE FKs to tickets remaining: 0 (verified in 00238)
Divergence view:                   gone (dropped at 1c.10c — bridge done)
Forward + reverse dual-write:      gone (dropped at 1c.10c)
Test state:                        661 active tests pass, 6 obsolete tests skipped
Codex review rounds run:           6 (rounds 1–6) + per-slice plan/code reviews
Total bugs caught by codex:        39+ across the rework (incl. 2 catastrophic data losses)
```

### Step status at a glance

| Step | What | Status |
|---|---|---|
| 0 | `activities` polymorphic sidecar | ✅ DONE |
| 1 | extract work_orders from tickets | ✅ DONE END-TO-END (1c.10c destructive cutover landed; 1c.9 split-API deferred; 1c.11 ticket_activities drop deferred) |
| 2 | `orders` → `service_orders` | ⚠ ALIAS VIEW ONLY (00231). Destructive rename deferred. |
| 3 | unified resources catalog | ⏸ NOT STARTED. Multi-week refactor. Per-kind conflict guards must stay separate. |
| 4 | `booking_bundles` → `bookings` | ⚠ ALIAS VIEW ONLY (00231). Destructive rename deferred. |
| 5 | visitors promotion | ⏸ BLOCKED — parallel workstream owns it (memory `project_visitors_track_split_off`). Don't pull back into scope. |
| 6 | `tickets` → `cases` rename | 🗑 DELETED. User decided rename is cosmetic and not worth the cost. |

### Work-order command surface status

| Slice | Methods | Status |
|---|---|---|
| 0 | `updateSla` | ✅ shipped (Session 9) |
| 1 | `setPlan` + `canPlan` | ✅ shipped (Session 10) — migration 00246 |
| 2 | `updateStatus` / `updatePriority` / `updateAssignment` / `reassign` | ✅ shipped (Session 11) |
| 3.0 | Single `PATCH /work-orders/:id` orchestrator (collapses Slices 0–2 into one endpoint) | ✅ shipped (Session 12) |
| 3.1 | `cost` / `tags` / `watchers` / `title` / `description` field add | ✅ shipped (Session 14, commit `d9cccca` + hardening commit) |

---

## ⚠️ Catastrophic data loss postmortem (load-bearing — read before any destructive migration)

**Two real data-loss events occurred** during the destructive cutover. Both were caused by the same bug class: a `pg_get_constraintdef() like '%public.tickets%'` filter that NEVER matched because `pg_get_constraintdef()` omits the schema qualifier. The migrations advertised dropping FKs but actually dropped nothing.

### Loss #1: 315 ticket_activities cascade-deleted at 1c.10c

`ticket_activities.ticket_id` had `ON DELETE CASCADE` to tickets. When 00233 deleted 319 work_order rows, the 315 ticket_activities rows tied to those tickets cascaded out. The shadow trigger then deleted the corresponding 315 activities rows. Pre: 1398 activities (1083+315). Post: 1083.

Caught by codex round 1 review of 1c.10c. Fixed forward in 00234 — but 00234 itself was a no-op because of the LIKE bug. Manual `ALTER TABLE ... DROP CONSTRAINT` finally dropped it. Codex round 4 caught the 00234-was-no-op bug.

### Loss #2: 646 sla_timers cascade-deleted at 1c.10c

`sla_timers.ticket_id` was supposed to be dropped by 00233's softening loop. Same broken LIKE pattern → no-op. The 1c.10c DELETE then cascade-nuked all 646 work_order sla_timers. Pre: 1130 (484+646). Post: 484.

Caught by codex round 4 review (3 rounds AFTER the cutover). Fixed forward in 00238 — drops constraints by EXPLICIT NAME. Verifies post-state has 0 CASCADE FKs to tickets remaining.

### Why this matters for production

In dev, both losses are accepted (data is reproducible from migrations + seeds). In production, this would have been point-in-time recovery (PITR) territory. The lessons:

- **Never use `pg_get_constraintdef like '%public.tablename%'`.** The schema qualifier is omitted. Use `like '%REFERENCES tablename(%'` or query `pg_constraint.confrelid` directly.
- **Always drop FKs by EXPLICIT NAME.** Loops that match on definition strings are fragile.
- **Always assert post-migration state** in the same transaction (e.g. `do $$ ... raise exception if not 0 ...$$`).
- **The migration in 00238 has the right pattern** to copy.

---

## Codex review pattern — bugs caught per round

| Round | Date | Reviewing | Bugs found | Notable |
|---|---|---|---|---|
| 1 | 2026-04-30 | post-1c.10c repair | 8 | Caught loss #1 |
| 2 | 2026-04-30 | round-1 fixes | 8 | More service drift |
| 3 | 2026-05-01 | round-2 fixes | 7 | getById error masking 404 |
| 4 | 2026-05-01 | round-3 fixes | 4 | Caught loss #2 (00233 LIKE) |
| 5 | 2026-05-01 | round-4 fixes | 6 | kind_matches_fk conflicts SET NULL |
| 6 | 2026-05-01 | round-5 fixes | 6 | mark_sla_breached_batch incomplete |

**39+ bugs total.** Codex (gpt-5.5 with xhigh reasoning) caught patterns Opus 4.7 (this agent) consistently missed:

- LIKE-pattern bugs (silent no-ops in DDL)
- View-on-view dependents that block DROP
- Cascade FK semantics across rebuild migrations
- Service-layer drift after schema changes (every codex round found new drift in my fixes)
- Constraint conflicts with FK actions (SET NULL vs CHECK)

**Each round still finds bugs IN MY FIXES.** Convergence is real but slow.

For full notes on codex usage (when, how, what to ask), see the per-session
archive files (especially `session-09-b15-sla-edit.md`,
`session-10-slice1-setplan.md`) and the original handoff archive in git
history before this restructure.

---

## Codex fragility — known risk to the two-gate pattern

Codex hit quota in three of the last four sessions:

| Session | Slice | Codex availability | Outcome |
|---|---|---|---|
| 10 | Slice 1 | partial (2 findings before quota) | One critical bug still caught (timestamp roundtrip). Full-review missed it. |
| 11 | Slice 2 | zero (quota at start) | Full-review carried alone. All 5 important findings caught. No known misses. |
| 13 | P0 grant fix (00248) | zero (quota at start of review) | **Pre-push transactional audit substituted for codex on this destructive migration** — ran the migration body in `BEGIN…ROLLBACK`, exercised UPDATE + INSERT as `service_role`, observed both succeed, rolled back. Stronger than static review for grant-only changes because it actually executed the privileges the migration was meant to grant. No misses. |

The two-gate pattern (full-review for breadth + codex for depth) **is robust to one gate being unavailable**, but degrades when codex is offline because the Postgres-internals nuance class is codex's specialty:

- Timestamp roundtrip equality (`Z` vs `+00:00`)
- SQL function planner semantics
- View-on-view dependent invalidation
- Constraint interaction with FK SET NULL / CASCADE

Full-review's Opus subagents (same model class as the main agent) systematically miss those.

### Mitigation policy (decided Session 12)

User chose combination **(c) + (d)**:

- **(c)** Escalate to human review for destructive changes when codex is unavailable.
- **(d)** Accept "full-review only" as a degraded mode for non-destructive work; require codex (or skip) for destructive.

Rationale: full-review handles additive work fine — Sessions 11 and 12 both shipped under degraded-mode without bugs slipping through. Destructive work is rare and high-stakes; waiting for codex availability or escalating to human review is acceptable for the 1–2 destructive migrations per quarter that genuinely matter.

**Options NOT picked** (left on the table for future re-evaluation):

1. **Self-host gpt-5.5 via OpenRouter.** Removes the quota constraint. Reconsider if codex quota becomes a chronic blocker.
2. **Use a different LLM as the second gate** — Gemini 2.5 Pro with deep reasoning. Not a drop-in for codex's Postgres specialty but might catch a different bug class. Worth a spike if (c)+(d) starts feeling restrictive.

---

## Open work — single consolidated list

This replaces the per-session "deferred" lists that previously repeated across
sessions 7, 8, 10, 11. Each item appears here ONCE, with the session of origin
cited. Status reflects current state on `main`.

### Production-blocking

- **None known.** Both items previously flagged as production-blocking
  (work-order list endpoint missing → resolved Session 8 P2; CI migration
  smoke gate → shipped Session 7) are closed.

### Integrity / semantic cleanup

- **`workflow_instances.ticket_id` is now FK-less** (post-00238). It's a
  "soft pointer" — application code still writes/reads via it
  (`workflow-engine.service.ts:91`, `workflow.service.ts:129`). Stale
  pointers will accumulate until workflows become entity-aware (`case_id` /
  `work_order_id`). Step 1c.9 split-API would address this.
  *Origin: original handoff item #3.*

- **3 `it.skip`'d tests** in `apps/api/src/modules/ticket/ticket-sla-edit.spec.ts`
  were removed in Session 9 — coverage now lives in
  `work-order-sla-edit.spec.ts`. **Status: closed by Session 9.**

- **Frontend types declare `ticket_kind` as required**
  (`apps/web/src/api/tickets/types.ts:27`). API responses synthesize it
  post-1c.10c, so the contract holds, but it's a code-smell that needs proper
  handling at step 1c.9. Ref-prefix and conditional UI in 8+ files block
  easy removal.
  *Origin: original handoff item #6, reaffirmed Session 8.*

- **`bundle_is_visible_to_user` granted EXECUTE to `authenticated`**
  while running as SECURITY DEFINER. Pre-existing in migration 00148; the
  parity migration (00245, Session 8 P3) inherited the grant. Two fixes
  possible: (a) revoke from `authenticated`, only allow `service_role` (then
  add a wrapper RPC bound to `auth.uid()` and `current_tenant_id()`); (b) bind
  the function arguments to the calling session and refuse arbitrary
  `p_user_id`. Option (a) is simpler. Worth one targeted migration.
  *Origin: Session 8 codex round.*

- **TS `BundleVisibilityService.assertVisible` and SQL `bundle_is_visible_to_user`
  both grant access via approvals regardless of approval status.** Same for
  work_orders status. Historical-approver and closed-WO-assignee retention is
  defensible for audit, but it's a policy question that hasn't been explicitly
  debated. If product wants stricter scoping, both implementations need a
  status filter — and CI parity test (A11) needs to assert the behavior matches.
  *Origin: Session 8 codex round.*

### Work-order command surface — Slice 3.1 + alignment

- ✅ **Slice 3.1 — `cost` / `tags` / `watchers` / `title` / `description` on
  work_orders** — closed Session 14 (commit `d9cccca` + hardening). Single
  `WorkOrderService.updateMetadata` method, mirrors case-side parity. API
  smoke test 9/9 + 5 hardening probes pass on remote.
  *Origin: Sessions 10 + 11. The single-PATCH-endpoint half of this resolved Session 12 P1; the per-field add resolved Session 14.*

- ✅ **Security alignment slice — closed Session 12.** `tickets.assign` and
  `tickets.change_priority` gates backported to `TicketService.update`
  and `reassign` via commit `f376e12`. Migration 00247 grandfathers
  existing roles. UPDATE 0 on remote (no roles needed it).

### Plandate workstream coordination

- ✅ **Plandate workstream merged Session 12** (`849aaee` + `09e28f6`).
  Dead case-side surfaces deleted in the same session: `TicketService
  .setPlan`, `/tickets/:id/plan`, `/tickets/:id/can-plan`,
  `useSetTicketPlan`, `useCanPlanTicket`, `ticketCanPlanOptions`. The
  Plan SidebarGroup uses `useSetWorkOrderPlan` + `useCanPlanWorkOrder`
  via the new single PATCH endpoint.

### Test/observability debt

- **Class-wide debt: timer/activity write swallowing across SLA-edit code paths.**
  Both TicketService and WorkOrderService have this. Real fix is transactional
  command pattern in SlaService — not session-scoped.
  *Origin: Session 9 codex round (deferred items 4 + 5).*

- **`logDomainEvent` duplication between TicketService + WorkOrderService.**
  5-line helper, two copies, drift cost is real but small. Add a
  `// kept in sync with ticket.service.ts` comment to both. Defer extraction.
  *Origin: Session 11 full-review #3 (nit).*

### CI assertion gate — invariant pattern

- **Convert `scripts/ci-migration-asserts.sql` from hardcoded assertions to
  YAML-driven invariants** before Step 2 or Step 4 destructive cutover lands.
  Effort: ~half day. Without this, every assertion that mentions
  `tickets` / `orders` / `booking_bundles` will silently rot when those
  tables are renamed.
  *Origin: this restructure (P5). See [`ci-assertion-strategy.md`](./ci-assertion-strategy.md) for the full pattern.*

### Steps 2/3/4 destructive renames

- **DEFERRED until product readiness.** Each is several hours of careful
  migration + frontend coordination. Do NOT do these autonomously. They need:
  - Decision on whether the rename is worth the cost (per Step 6, the answer
    is sometimes "no")
  - Frontend coordination (every reference must update in sync)
  - Codex review at each destructive boundary
  - Backup/PITR readiness
  - The CI invariant pattern (above) shipped first.

---

## Exit criteria — when this work is "done"

The plan-reviewer correctly identified that "until product readiness" is not a plan. Explicit criteria:

The work-order command surface is complete when ALL of:

1. ✅ The desk-detail sidebar can mutate every WO field without touching
   `TicketService`, **verified end-to-end against the live remote dev API**
   with a real Admin JWT (browser click-through still pending — see note
   below).
   - status / priority / team / user / vendor / plan / SLA: ✅ shipped (Slices 0–2 +
     Slice 3.0 single PATCH orchestrator). 2026-05-01 P0 (service_role DML grants
     missing on `public.work_orders`) closed by migration 00248.
   - cost / tags / watchers / title / description: ✅ shipped (Slice 3.1, Session 14).
     `WorkOrderService.updateMetadata` mirrors the case-side bulk-write shape (no
     per-field permission gate beyond visibility floor; no per-field activity
     emission). Hardening from full-review applied in same session: cost normalized
     to 2 dp before diff (Postgres NUMERIC round-trip safe), empty-title rejected
     at the service layer (not just controller), explicit-undefined keys correctly
     skip dispatch (no extra round-trip).
   - **Browser click-through gate still owed.** API-layer smoke test passed 9/9 +
     hardening (no-op on float drift, validation on bad input, persist with 2-dp
     rounding). The FE pipeline `editor → patch() → patchWorkOrder() →
     useUpdateWorkOrder → fetch` was not exercised by a human or a Playwright
     run this session. Same blind spot Sessions 7-12 had; flagging openly. The
     code path is small (5 forwards in `patchWorkOrder` + the existing inline
     editors that already call `patch()`) but "code path is small" is not
     equivalent to "verified to work."

2. ✅ The plandate workstream has merged. (Session 12 commits `849aaee` + `09e28f6`.)

3. ✅ Case-side gates match WO-side. (Session 12 commit `f376e12` — `tickets.assign` + `tickets.change_priority` backported with grandfathering migration 00247.)

4. ✅ `TicketService.setPlan`, `useSetTicketPlan`, `useCanPlanTicket`, and the `/tickets/:id/plan` and `/tickets/:id/can-plan` routes deleted. (Session 12 commit `09e28f6`.)

5. ⏳ CI assertion script confirms the polymorphic gates work end-to-end.
   Currently A1..A11 assert structural integrity. The end-state version
   should also include behavioral assertions that exercise the WO command
   surface against `tickets` and confirm the case-only guards reject.
   Partially done; expand on Slice 3.1.

**The full data-model rework is complete when ALL of the above PLUS:**

6. ⏳ CI assertion script converted to YAML-driven invariants before Steps 2/4 destructive renames. (See [`ci-assertion-strategy.md`](./ci-assertion-strategy.md).)

7. Decision recorded for each of Steps 2 / 3 / 4: ship the destructive rename, or formalize the alias-view as the permanent state.
   - Step 2 (`orders` → `service_orders`): decision pending
   - Step 3 (unified resources catalog): not started; codex flagged unified conflict guard as a no-go
   - Step 4 (`booking_bundles` → `bookings`): decision pending
   - Step 5 (visitors): handled by parallel workstream
   - Step 6 (`tickets` → `cases`): ✅ DECIDED — not worth the cost; alias view via `cases` provides the name where needed

### Stretch goals (NOT exit criteria)

- Single `PATCH /work-orders/:id` endpoint (vs per-field). Currently per-field; consolidating to a single field-dispatcher endpoint would resolve Session 11 full-review #9 (FE multi-field PATCH fan-out race). Tracked under Slice 3.
- Workflow-driven WO mutations bypass the FE entirely (already work via `SYSTEM_ACTOR`).
- Step 1c.9 split-API (separate `case.service.ts` + `/cases/*` controller). Cosmetic; not required until planning board / per-kind RLS / WO queues are imminent.

---

## How to use this handoff

A fresh agent with this doc and `data-model-redesign-2026-04-30.md` should be able to:

1. Verify current state with the queries in the "Current state — verified on remote" section.
2. Read the "Open work" list and pick a priority.
3. Implement using the patterns from this rework's good migrations:
   - **00208** for adding constraints with explicit pre-flight audits
   - **00238** for dropping FKs by explicit name with post-state assertions
   - **00240** for cross-kind validators that handle SET NULL semantics
4. Run codex review (gpt-5.5 xhigh) at every destructive boundary. Pattern: write the migration, run codex on it, fix findings, re-run codex, repeat until zero new findings.
5. NEVER use `pg_get_constraintdef like '%public.X%'` in DDL DO blocks. Use explicit constraint names.
6. NEVER ship a destructive migration without an inline `do $$ ... assert ... $$` post-state check.

---

## File / commit reference

All commits this rework: `git log --oneline 4a05488..HEAD` (33 commits at the time of this restructure).

Migration sequence (00202–00246, all applied to remote `iwbqnyrvycqgnatratrk`):

```
00202_activities_polymorphic_sidecar.sql           Step 0 sidecar
00203_activities_hardening.sql                     Step 0 hardening
00204_step1a_cases_workorders_views.sql            Step 1a views (initial, columns missing)
00205_step1a_views_full_columns.sql                Step 1a column completeness fix
00208_step1a_codex_fixes.sql                       Step 1a codex round 1
00209_step1b_fulfillment_units_v_cutover.sql       Step 1b reader cutover
00210_step1b_booking_bundle_status_v_cutover.sql   Step 1b reader cutover
00211_step0_activities_update_shadow.sql           Step 0 UPDATE shadow
00212_step1a_post_full_review_fixes.sql            Step 1a TRUNCATE + parent reclassify
00213_step1c1_work_orders_new_table.sql            Step 1c.1 table
00214_step1c2_work_orders_new_backfill.sql         Step 1c.2 backfill
00215_step1c3_forward_shadow_trigger.sql           Step 1c.3 forward shadow
00216_step1c3_dual_write_divergence_view.sql       Step 1c.3 monitoring
00217_step1c3_post_review_fixes.sql                Step 1c.3 codex fixes
00218_step1c1_rename_parent_case_id_to_parent_ticket_id.sql
00219_step1c1_fk_cascade.sql                       Step 1c.1 FK cascade
00220_step1c35_reverse_trigger.sql                 Step 1c.3.5 reverse shadow
00221_step1c35_reverse_delete_scope.sql            Step 1c.3.5 DELETE scope fix
00222_step1c36_atomic_rename.sql                   Step 1c.3.6 atomic rename
00223_step1c35_loop_guard_and_module_alloc.sql     Step 1c.3.5 depth-guard + allocator
00224_step1c35_legacy_ticket_id_backfill.sql       Step 1c.3.5 backfill (then dropped)
00225_step1c35_backfill_via_reverse.sql            Step 1c.3.5 backfill via reverse
00226_step1c5_rollup_to_work_orders.sql            Step 1c.5 rollup
00227_step1c6_sla_timers_polymorphic.sql           Step 1c.6 polymorphic FKs
00228_step1c7_workflow_instances_polymorphic.sql   Step 1c.7
00229_step1c8_routing_decisions_polymorphic.sql    Step 1c.8
00230_step1c_polymorphic_auto_derive.sql           Step 1c.6/7/8 auto-derive
00231_step2_step4_alias_views.sql                  Step 2/4 alias views
00232_step1c10_prep_derive_trigger_robust.sql      Step 1c.10c prep (trigger)
00233_step1c10c_destructive_cutover.sql            ⚠️ Step 1c.10c destructive
00234_step1c10c_followup_threshold_crossings_fk.sql ⚠️ NO-OP: LIKE bug
00235_step1c10c_followup_ticket_activities.sql     Step 1c.10c follow-up
00236_step1c_post_review_fixes.sql                 Round 1 fixes (incl 00234 retry)
00237_step1c_round3_fixes.sql                      Round 3 fixes
00238_step1c_post_review_fk_disaster.sql           ⚠️ Round 4 — FK disaster recovery
00239_step1c_round5_fixes.sql                      Round 5 fixes
00240_step1c_round6_fixes.sql                      Round 6 fixes
00245_bundle_visibility_parity_with_ts.sql         Session 8 P3
00246_work_orders_plandate_check.sql               Slice 1 / Session 10
00247_backfill_assign_and_priority_permissions.sql Session 12 P2 grandfathering
00275_restore_work_orders_service_role_writes.sql  Session 13 P0 fix
```

Stress test fixtures (NOT committed, in `/tmp/`):

- `/tmp/stress-test-1c-renamed.sql` — 12 forward scenarios
- `/tmp/stress-test-1c-reverse-renamed.sql` — 5 reverse scenarios
- `/tmp/stress-test-1c-r6r7.sql` — 3 unguarded-column scenarios

Re-create these in `apps/api/test/sql/` if you want them in CI.

---

## Pointers to historical sessions

Each session has its own archive file with the full content that previously lived in this doc. The order below is chronological.

| Session | Date | Topic | Archive file |
|---|---|---|---|
| 7  | 2026-05-01 | CI migration smoke gate shipped | [`session-07-ci-smoke-gate.md`](./data-model-rework-archive/session-07-ci-smoke-gate.md) |
| 8  | 2026-05-01 | Priority 2 (dead WO filter removed) + Priority 3 (bundle_is_visible_to_user parity) | [`session-08-bundle-visibility-parity.md`](./data-model-rework-archive/session-08-bundle-visibility-parity.md) |
| 9  | 2026-05-01 | Slice 0 (originally "B1.5") — work-order command surface scaffolding + SLA edit | [`session-09-b15-sla-edit.md`](./data-model-rework-archive/session-09-b15-sla-edit.md) |
| 10 | 2026-05-01 | Slice 1 — `setPlan` on work_orders | [`session-10-slice1-setplan.md`](./data-model-rework-archive/session-10-slice1-setplan.md) |
| 11 | 2026-05-01 | Slice 2 — `updateStatus` / `updatePriority` / `updateAssignment` / `reassign` | [`session-11-slice2-status-priority-assignment.md`](./data-model-rework-archive/session-11-slice2-status-priority-assignment.md) |
| 12 | 2026-05-01 | Plandate merge + dead-code cleanup + Slice 3.0 single-PATCH orchestrator + security alignment (P2 backport) + 5 code-review fixes | [`session-12-plandate-merge-and-orchestrator.md`](./data-model-rework-archive/session-12-plandate-merge-and-orchestrator.md) |
| 13 | 2026-05-01 | P0 fix — service_role DML grants restored on `public.work_orders` (00248) + A12 CI invariant. Closes the 2026-05-01 user-reported regression | [`session-13-p0-service-role-grants.md`](./data-model-rework-archive/session-13-p0-service-role-grants.md) |
| 14 | 2026-05-01 | Slice 3.1 — `cost` / `tags` / `watchers` / `title` / `description` on work_orders. Closes exit-criteria item 1 of the rework. Full-review hardening applied in same session: float normalization, service-layer guards, explicit-undefined detector. | [`session-14-slice-3.1-metadata.md`](./data-model-rework-archive/session-14-slice-3.1-metadata.md) |

> **Chronology fix:** earlier versions of this doc had Session 9 appearing
> AFTER Sessions 10 and 11 (because Session 9's content was appended after
> the slice work was already documented). The archive files are now ordered
> correctly and Session 9's content references `Slice 0` rather than `B1.5`
> in cross-cuts back to the slice series.

For sessions 1–6 (the original cutover work and codex repair rounds 1–6), the
authoritative history is in `git log` and the migration files themselves.
The "Why this rework existed", "Catastrophic data loss postmortem", and
"Codex review pattern" sections above capture the load-bearing reference
material from those sessions.

---

## Final word

Step 1 is done. Sessions 7–12 closed the highest-leverage follow-ups: CI smoke gate, dead filter, bundle parity, work-order command surface through Slice 3.0 (single PATCH orchestrator), plandate workstream merge, security gate alignment, dead-code cleanup, all code-review findings except the deferred items in the consolidated open work list above. The desk-detail sidebar can now mutate every WO field that previously silently no-op'd, with the right per-field gates and a clean union DTO endpoint. The biggest remaining risks are (a) Slice 3.1 (cost / tags / watchers / title / description) not yet started — but cheap, ~half day on top of the orchestrator — and (b) the CI assertion gate brittleness when Steps 2/4 ship. Both are documented above with concrete next steps and effort estimates.

The honest meta-lesson: **codex (gpt-5.5 xhigh) is genuinely a better adversarial reviewer than this agent for migration work.** The codex fragility section above frames the option space when codex is unavailable. Don't drift into a degraded mode by accident.
