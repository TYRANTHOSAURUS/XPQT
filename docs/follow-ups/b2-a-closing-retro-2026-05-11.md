# B.2.A closing retrospective — 2026-05-11

Closeout doc for the B.2.A workstream (orchestrator RPCs + controller
cutover + workflow/webhook cutovers). Steps 1–13 shipped to
`origin/main`. Supersedes `b2-a-interim-retro-2026-05-11.md` (Step-7
snapshot, kept for audit history).

This is a synthesis, not a log. Read this before starting B.4 (booking
edit pipeline RPC) or Phase 8.D (legacy `edit_booking_slot` drop).

## 1. Scope shipped

13 numbered steps + a planning reshuffle on Step 10 (revert + reland in
a different ordinal position). All on `origin/main`; all CI gates
0-violation at close.

| Step | Subject | Migrations | Tagged commits |
|---|---|---|---|
| 1 | Foundation (`command_operations`, `validate_*_in_tenant`, `sla_timers.recompute_pending`, `tickets.routing_status`) | 00316–00322 | `d9f63f22…b0c2d32b` |
| 2 | `RequireClientRequestIdGuard` wave (I1) | — | `561c69bc…bdeb98bf` |
| 3 | §3.1 `transition_entity_status` RPC | 00323–00325 | `909119bc…cda238c4` |
| 4 | §3.2 `set_entity_assignment` RPC | 00326–00327 | `0142a16b…524fdfc5` |
| 5 | §3.3 `update_entity_sla` RPC | 00328–00330 | `aa7a977e…1f2ba339` |
| 6 | §3.0 `update_entity_combined` orchestrator + PATCH controller cutover | 00331–00335 | `bad140d3…aba4c3f7` |
| 7 | Smoke probe extension + interim retro | — | `afde710a…0aa664e7` |
| 8 | §3.4 dispatch + batch + workflow-engine cutover (all-or-nothing HALT) | 00336–00342 | `6e9102cf…262ca48f` |
| 9 | §1.21 workflow engine `assign` + `update_ticket` cutover (14-field allowlist) | — | `6da7c0d2…1da5c7f2` |
| 10 (initial) | §3.5 grant_ticket_approval attempt — REVERTED | 00343 | `3834b702` reverted in `fde350df` |
| — | Step 10 revert | 00344 (drop) | `fde350df` |
| 11 | §3.10 `reclassify_ticket` + outbox handlers (SlaTimerRepoint, RoutingEvaluation) | 00354–00355 | `c9e2572a…3362e72f` |
| 12 | §3.11 `create_ticket_with_automation` + portal/webhook cutover + handlers (SlaTimerStart, WorkflowStart) | 00345–00353 | `94615015…8c115a7a` |
| 10 (reland) | §3.5 grant_ticket_approval + ApprovalService cutover | 00356–00358 | `f273428f…9f7e0508` |
| 13 | Closing retrospective | — | (this commit) |

**Migrations landed:** 42 in the 00316–00358 range (00343 dropped via
00344; both kept in tree for audit). Spec v10 plan
(`b2-survey-and-design.md` §6 table line ~3140) earmarked ~20 slots
for the same scope. **42 vs 20 = 22-migration overshoot.** Decomposed
in §2.

**Outbox handlers + supporting RPCs:** 10. Eight §3.x RPCs
(`transition_entity_status`, `set_entity_assignment`, `update_entity_sla`,
`update_entity_combined`, `dispatch_child_work_order` + batch,
`grant_ticket_approval`, `reclassify_ticket`,
`create_ticket_with_automation`) + two infrastructure RPCs
(`start_sla_timers`, `repoint_sla_timer`) + four outbox handlers
(`SlaTimerStart`, `SlaTimerRepoint`, `RoutingEvaluation`, `WorkflowStart`).

**Test + gate state at close:** API ~1535 / ~152 suites (3 skip, 21
todo). Web 186 / 21. Concurrency harness ~80 / 80 across 14 RPCs.
Smoke gates: `pnpm smoke:work-orders` 49 probes, `pnpm smoke:tickets`
88 probes, both green. CI ratchets (errors:check-app-errors,
naming:check-allowlist, b2:check-config-reads) all 0-violation.

**Per-spec-section status:**

| § | Surface | Status |
|---|---|---|
| §3.0 | `update_entity_combined` orchestrator | Shipped (Step 6). PATCH `/tickets/:id` + `/work-orders/:id` cut over. |
| §3.1 | `transition_entity_status` | Shipped (Step 3). |
| §3.2 | `set_entity_assignment` | Shipped (Step 4). Workflow `assign` cut over Step 9. |
| §3.3 | `update_entity_sla` | Shipped (Step 5). |
| §3.4 | `dispatch_child_work_order` + batch | Shipped (Step 8). Workflow `create_child_tasks` cut over Step 8. |
| §3.5 | `grant_ticket_approval` | Shipped (Step 10 reland). `ApprovalService` cut over. |
| §3.6 | metadata branch | Folded into §3.0. |
| §3.7 | `command_operations` table | Shipped (Step 1). |
| §3.10 | `reclassify_ticket` | Shipped (Step 11). `ReclassifyService` cut over. |
| §3.11 | `create_ticket_with_automation` | Shipped (Step 12). Portal + webhook cut over. |
| §1.21 | workflow engine cutovers | Shipped (Step 9). |
| §1.22 | reassign cutover | **Deferred.** Direct `.from('<table>').update(...)` + `routing_decisions` audit still live. |
| §1.23 | satisfaction atomicity | **Deferred.** `satisfaction_rating` / `satisfaction_comment` bypass §3.0 metadata branch. |

## 2. Migration count vs estimate

Spec v10 budgeted ~20 slots; reality was 42. Decomposed:

| Bucket | Count |
|---|---|
| Foundation (on-plan) | 7 |
| §3.x RPC v1s | 10 |
| Self-review + codex revision migrations (v2/v3/v4/v5) | 20 |
| New supporting RPCs / helpers not in v10 plan | 4 (`start_sla_timers`, `repoint_sla_timer`, two unique-active indexes) |
| Reverts / drops | 1 (`drop_grant_ticket_approval_rpc`; 00343 itself preserved for audit) |

The interim retro called the 20 revision migrations "review-loop
discipline." That's partly self-flattering. Honest decomposition of
those 20:

- **~6 were genuine "discipline working"** — codex-caught contract
  drifts that would have shipped to remote without review. The §3 list
  below.
- **~10 were "the v1 contract wasn't tight enough."** Examples: 00321
  added `'person'` to `validate_entity_in_tenant` because v1's allowlist
  was written from memory; 00327 re-aligned `set_entity_assignment`
  metadata shape because v1 didn't read `ticket.service.ts:1208-1216`
  first; 00338 added `(entity_kind, case_id, work_order_id)` polymorphic
  columns to dispatch INSERTs because v1 mirrored 00226 but not 00227.
  **Avoidable.** The B.0 destructive-default invariant (cite + read
  before write) was violated in spirit on several v1 landings.
- **~4 were "spec moved during build."** Step 12 needed two new helper
  RPCs (`start_sla_timers`, `repoint_sla_timer`) because v10 hand-waved
  handler internals. Defect in spec, not in build.

**Lesson for B.4:** v10's "1 RPC = 1 migration" estimate is wrong by
~2x. Realistic: "1 v1 + 1–2 revisions + ~0.3 supporting helpers." If
the next spec says 5 migrations, plan for 10–12.

## 3. Review-loop yield — self vs codex

Steps 3–12 ran the cycle: v1 → self full-review (plan + code) →
optional codex → fixes. Codex was used selectively per the user's
option-(c) directive (high-risk steps only).

**Aggregate findings:** ~65 labelled findings across the workstream.
~60% caught by self-review, ~40% by codex — same ratio as the Steps
1–6 interim sample.

**Codex catches that would have shipped without codex:**

1. **`parallel_group_id` vs `parallel_group` typo** (Step 10 reland,
   00358 hotfix, commit `9f7e0508`). RPC step 8 used
   `where chain_id = v_chain and parallel_group_id = v_pg` — but the
   actual column on `approval_chains` is `parallel_group`. Self-review
   missed because the *local PL/pgSQL variable* `v_parallel_group_id`
   was correctly named; only the WHERE-clause column reference was
   wrong. **Every approval-grant on the ticket path would have raised
   `column "parallel_group_id" does not exist` at runtime.** Clearest
   illustration in the workstream of why codex catches different things.

2. **SQL raise tail leak via `detail`** (CODEX-B-1, Step 6 Commit B).
   `mapRpcErrorToAppError` passed `detail: stripCodePrefix(message)`
   into AppError factories for registered codes; the renderer prefers
   explicit detail over registry copy, so users saw raw SQL fragments
   (`kind=case id=<uuid>`, `open_children=3`) instead of curated copy.
   Self-review tested happy path; codex tested the leak.

3. **`routing_rule_id` not tenant-validated** (codex-S8-I1, Step 8).
   `routing_decisions.rule_id` FK is global (no tenant composite);
   forged dispatch payload could write tenant A's audit row pointing
   at tenant B's rule. Cross-tenant audit-row leak. Self-review missed;
   codex caught by cross-referencing FK definition vs helper allowlist.

4. **Double `routing_decisions` row on auto-routing** (codex-S11-I2,
   Step 11). Reclassify's `mode='auto'` path emitted a routing-evaluation
   outbox event *and* the RoutingEvaluationHandler inserted a row.
   Two rows per reclassify = audit duplication + metric inflation.

5. **`started_at` skew on outbox handler lag** (codex-S12-I2, Step 12).
   Original sla.timer_start payload didn't snapshot `now()`; handler
   picked the event up minutes later and called `start_sla_timers(p_started_at=now())`.
   SLA clock wrong by the handler-lag delta. Fix: emit explicit
   `started_at` in payload, handler passes through.

6. **Step 10 initial — three independent drifts.** Codex flagged: approval
   enum gap on `delegated` (CAS pre-check + chain count both needed
   `'pending'|'delegated'`); F-CRIT-1 actor resolution writing `auth_uid`
   to `domain_events.actor_id` (FK violation on every authenticated
   write); F-CRIT-2 `started_at` skew (same as S12-I2). Three contract
   violations in one RPC → revert + reorder + reland.

**Codex non-catches.** §3.1 and §3.3 passed codex clean. Small surface
+ tight spec → clean v1. Codex isn't always net-positive; on small
slices its yield is zero. Option (c) was the right call — running it
on every step would have cost an extra ~$50–80 in tokens for ~3
additional findings.

## 4. Decisions that turned out load-bearing

In rough "without this, something breaks in production" order:

**1. Inner-key sentinel `__combined__:`** (Step 6, commit `2b4a31a9`).
The orchestrator's nested idempotency keys could collide with a
standalone sub-RPC call using a similar key shape. v2 prefixed with
`__combined__:` (non-user-supplyable). Cheap up front; impossible to
retrofit once shipped.

**2. Hard-fail on missing `clientRequestId`** (Step 6 / F-CRIT-1). v3
had a `clientRequestId ?? randomUUID()` fallback. Step 12's webhook
ingest cutover would have silently invented a fresh UUID per call,
making idempotency meaningless on retry. v4 throws
`command_operations.client_request_id_required`. Verified correct
in Step 12: webhook passes a deterministic per-ingest key.

**3. Step 10 revert + reorder** (`fde350df`). Three drifts in initial
Step 10 (see §3). Reverted, pushed Steps 11+12 first so handlers
existed, then relanded clean. The reorder saved a P0 production
regression. Discipline was *to revert rather than patch in place*.

**4. Step 12 v10 / S12-I1 concurrent-edit narrowing.** v1 stamped
`workflow_id` + `sla_id` on the new ticket via direct UPDATE post-create.
Under concurrent admin edits (admin reassigns workflow while automation
handler is mid-flight), the admin's later UPDATE could be silently
overwritten by the handler stamp. v2 narrowed to CAS UPDATE
(`where id = $1 and workflow_id is null`). Atomic write contract
preserved without locking.

**5. F-CRIT-1 actor resolution pattern (`auth_uid` → `users.id`).**
Recurred in §3.0, §3.5, §3.10, §3.11. Every authenticated RPC takes
`p_actor_user_id` = JWT's `auth.uid()` and must resolve to `users.id`
before writing `domain_events.actor_id` (FKs to `users.id`). Without
this pattern, every authenticated write would FK-violate on the audit
row.

**6. Smoke probe extension (Step 7).** Added a `command_operations`
row assertion to every PATCH probe. Catches "controller silently
bypasses the RPC" regressions that pass unit tests (mocked Supabase)
+ pass HTTP probes (the underlying write still happens). 92 probes today.

## 5. Architectural pivots

**Step 10 → 12 → 11 → 10-reland reorder.** Spec v10's ordering implied
linear §3.0 → §3.1 → ... → §3.11. Reality: data-dependency graph forced
the reorder. Step 10 needs `tickets.workflow_id` + `tickets.sla_id`
populated (written by Step 12), and needs `SlaTimerRepointHandler` +
`WorkflowStartHandler` to exist (Steps 11–12). **Lesson:** spec section
ordering is logical; build ordering is data-dependency-driven. v10
had no concept of "this RPC depends on those handlers." A pre-build
dependency-graph pass would have surfaced the reorder up front.

**Outbox-handler-or-inline.** Initial Step 10 emitted
`sla.timer_recompute_required` + `workflow.start_required` inline on
the theory handlers could be added later. Codex caught: emitting to
a queue without consumers is silent data loss. Reorder pulled handler
work into Steps 11/12; reland emitted to existing handlers. **Don't
ship producers before consumers.**

## 6. Deferred work + honest gaps

Live in `docs/follow-ups/b2-followups.md`. B.4 handoff checklist —
mark complete in `b2-followups.md` as they're addressed; don't update
this retro.

1. **Case-side satisfaction atomicity gap** (`ticket.service.ts:1162-1180`).
   `satisfaction_rating` + `satisfaction_comment` bypass §3.0 metadata
   branch via direct UPDATE after RPC commit. Multi-field PATCH lands
   in two transactions. Fix: fold into v6+ metadata branch OR accept +
   document on the satisfaction-survey workflow page.

2. **`clientRequestId` un-underscoring consistency.** Step 6 un-underscored
   2 of 8 Step-2 guarded params (PATCH paths). Steps 8/10/11/12 each
   un-underscored their own. Reassign (§1.22 deferred) still
   underscored — close when reassign cuts over.

3. **Refetch-after-RPC stale-read window.** Both PATCH handlers do RPC
   then `.select('*')` refetch. Between commit + refetch another writer
   can mutate. Mitigation: have orchestrator return full updated row
   in `cached_result`.

4. **Workflow node retry with edited config.** Idempotency keys are
   `(instance, node, ticket)` — no config-hash. If admin edits a
   workflow node mid-run and resumes, next call has same key + different
   payload → `command_operations.payload_mismatch` (409) and workflow
   halts. Latent today (workflow editor is design-time only); becomes
   real when mid-run edits land.

5. **Status-code shift on `workflow.update_ticket_field_not_allowed`.**
   Pre-Step-9: 400. Step 9: 422. Risk: a frontend handler keyed off
   legacy 400 regresses. Error system is code-keyed end-to-end so risk
   is small; cite when reviewing any frontend that consumes the code.

6. **Smoke gate coverage gap — `POST /approvals/:id/respond`.** Step 10
   reland cut over `ApprovalService.grantTicketApproval` but smoke matrix
   doesn't exercise the endpoint. Add `smoke-approvals.mjs` (or extend
   `smoke-tickets.mjs`) before B.4 starts.

7. **Conditional-emit matrix not fully covered in approval-grant harness.**
   Only 1 of 4 (chain_status × emit_required) cells asserted by the
   concurrency harness. Other 3 unit-tested only. Widen before relying
   on the harness as primary defense.

8. **§1.22 reassign cutover.** `WorkOrderService.reassign` /
   `TicketService.reassign` still write via direct UPDATE + `routing_decisions`
   audit insert. Folding into §3.2 needs a `reason` field +
   routing-decision emission from the RPC. Not P0; the last write path
   outside the §3.0/§3.2 boundary.

## 7. What's NEXT

**B.4 — booking edit pipeline RPC** is now unblocked. B.0 + B.2.A
foundations (command_operations, validate helpers, clientRequestId
guard, outbox handler pattern, smoke gate, codex review discipline)
all available. Budget ~2× the spec's nominal migration count (§2).
Codex on high-risk steps only.

**Phase 8.D — legacy `edit_booking_slot` drop** gated on B.4 shipping.
Cascading deletion needs a smoke probe added before merge to verify
no in-flight callers.

## 8. Lessons learned

1. **Spec section ordering ≠ build ordering.** v10's plan implied
   linear §3.0 → §3.11. Reality forced Steps 11+12 before Step 10
   reland. **For B.4:** pre-build dependency-graph pass — identify
   which RPCs need which handlers, columns, sibling RPCs. Resolve
   order from the graph, not from spec ToC.

2. **Codex catches different things than self-review.** The
   `parallel_group_id` typo, SQL raise tail leak, cross-tenant
   `routing_rule_id` audit gap, `started_at` skew, three Step 10
   drifts — all caught by codex, all missed by self-review.
   Self-review's blind spot: local variables named the right thing
   but referencing the wrong column / field. **For B.4:** run codex
   on every RPC v1 + every controller cutover. Skip on small
   mechanical follow-ups.

3. **Smoke gates as structural defense.** 137 live-DB probes catch
   "RPC was silently bypassed" regressions that ~1535 unit tests
   don't. Unit tests run against mocked Supabase; smoke mints a real
   Admin JWT and hits remote. **For B.4:** every new RPC gets a smoke
   probe before merge.

4. **Citation discipline.** Every step where the brief said "cite
   file:line" and the subagent did, fewer bugs. The `parallel_group_id`
   typo happened because this thread skipped re-reading the
   `approval_chains` schema before approving Step 10 reland. **For B.4:**
   no Write without a prior Read of every column, table, and TS caller
   touched.

5. **The "1 RPC = 1 migration" estimate is wrong.** Realistic: ~2.3×
   spec nominal. Partly avoidable (Read more before v1), partly inherent
   (codex finds things v1 genuinely missed). Don't promise spec-level
   migration counts.

6. **Producers before consumers loses.** Step 10 initial emitted to
   handlers that didn't exist. Silent data loss. **For B.4:** if an
   RPC emits an event, the consumer ships in the same commit or earlier.

7. **The interim retro framing was partly self-flattering.** Calling
   the migration churn "review-loop discipline" hid that ~10 of 20
   revisions were avoidable v1 mistakes. Discipline is keeping the
   loop tight + acting on findings; it isn't the existence of churn.

---

**Workstream close.** 13 steps, 42 migrations, ~65 labelled findings,
10 outbox handlers + supporting RPCs, 1 revert + reland, 2 smoke
scripts shipped, ~80 concurrency scenarios. Foundation in place for
B.4 + Phase 8.D. Decay this doc when B.4 starts.
