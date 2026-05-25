# Handoff — Phase 1.5 (Universal Workflow Architecture) → production-ready

You are picking up Phase 1.5 of the Universal Workflow Architecture for XPQT
(Prequest) and driving it to production-ready. The previous agent shipped the
full infrastructure scope + an external review pass + remediation; what remains
is the "production-ready" tail: full smoke matrix, end-to-end live verification,
one consolidating RPC, and small cleanups. This work is autonomous — execute,
don't ask, but apply the project's review discipline.

## Working directory
`/Users/x/Desktop/XPQT` — branch `main`. Push directly to main per the
project's working pattern. Use orchestrator pattern from turn 1 (delegate to
subagents for any task >2 files; previous agent timed out twice on dense direct
work).

## What "production-ready" means here
A real tenant in production must be able to:
1. Configure a `room_booking_rules` row with `effect='require_approval'` +
   `approval_config={required_approvers:[…], threshold:'all'|'any'}` via the
   admin API.
2. Create a booking matching that rule; the booking-flow auto-starts a
   `workflow_instance` on the rule's auto-recompiled `workflow_definition`.
3. Approvers receive the approval (existing TS-side `onApprovalRequested`
   fan-out — unchanged).
4. Approvers POST `/approvals/:id/respond` with `'approved'|'rejected'`; the
   booking transitions to `confirmed`/`cancelled` and the workflow graph
   advances to `end_success`/`end_failure`.
5. Cancel-booking, archived-definition refusal, concurrent-grant,
   cross-tenant, and 13 other edge cases all behave correctly under live DB
   load.

Done = the live smoke gate (`pnpm smoke:visual-approval`) runs all 16 probes
green AND the consolidating RPC ships AND the small follow-up NITs are closed.

## Current state — 2026-05-14

### Shipped commits (all on origin/main)
- 62079460 docs slot preamble
- d2443716 / 83dc0818 / 80afff03 — sub-step 6.A.X (ApprovalConfigCompilerService)
- cdd50c9d / 47199276 — sub-step 6.B (migration 00400, applied to remote)
- d54a1bfd / 2416a66f / 8c5e9037 — sub-step 6.A (engine polymorphization)
- f662d49c — sub-step 6.A.Y (WorkflowService.start({...}) + startForBooking)
- aa401722 — sub-step 6.C (migration 00403, applied to remote)
- 60193e56 — sub-step 6.D (WorkflowApprovalGrantedHandler)
- 3b2f90a4 — sub-step 6.E core (consumer cutover + auto-recompile + resolver plumbing)
- 6bc698cb — sub-step 6.G (ApprovalCancelSweeperCron)
- 9c33a00e — smoke probe v1 (6/16 probes)
- 0d0fefbf — 5 skipped cancel-cascade tests migrated to link_resolved chain
- 2a5f1af3 — adversarial-review fixes (1 CRITICAL + 2 IMPORTANT)

### Remote DB state
- Migration 00400 applied: schema additions, 3 tenant triggers, 2 RPCs
  (`ensure_room_booking_rule_workflow_definition`,
  `cancel_workflow_instance_with_approvals`), backfill ran (1 production chain
  flipped to `chain_threshold='any'`).
- Migration 00403 applied: `grant_booking_approval` v2 superseded 00310;
  per-booking row lock + chain_threshold-aware resolve + outbox emit.
- 17 workflow_definitions exist (2 with source_rule_id); 92 approvals
  (3 chain_threshold='any', 89 'all').

### Plan + memory
- Canonical plan:
  `docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md` (v4
  LOCKED, ~1583 lines). Read §7.4 (smoke probe matrix) + §7.5 (concurrency
  probes) + §6.E (consumer cutover scope).
- Project state memory:
  `~/.claude/projects/-Users-x-Desktop-XPQT/memory/project_phase1_5_shipped.md`.
- The plan file's slot references say 00400/00403 (impl-bumped twice from v4's
  original 00382/00383).

## What's OPEN — work in priority order

### 1. RUN THE SMOKE PROBE (HIGHEST PRIORITY)
`pnpm smoke:visual-approval` was written + wired but has **never been run
against the live API**. Until it runs green, the live happy path is unverified.
Do this first.

```bash
pnpm dev &              # start the dev server
sleep 15                # wait for boot
pnpm smoke:visual-approval
```

If probes fail, investigate. Likely failure modes:
- Booking-create endpoint expects different request shape — verify POST
  /reservations body against reservation.controller.ts:105. Adjust the
  createBookingViaApi helper.
- Approval respond endpoint — verify POST /approvals/:id/respond body shape;
  the probe sends {status: 'approved'|'rejected'}. Match
  approval.controller.ts.
- Workflow handler drain latency — the probe waits 3-4s after grant for the
  outbox to drain. If the worker poll is slower, increase the sleep.
- Tenant seed — the probe uses tenant 00000000-0000-0000-0000-000000000001
  (Solana Inc.) and admin uid 93d41232-35b5-424c-b215-bb5d55a2dfd9. Verify
  both exist on remote.
- Outbox row read — the probe queries outbox.events schema. Verify the
  table+schema name.

For any failure: read the probe at
apps/api/scripts/smoke-visual-approval.mjs, fix the issue, re-run. Commit
fixes as `fix(workflow-phase1.5.smoke): <what>` on main.

### 2. SMOKE PROBE v2 — add the remaining 10 probes
Plan §7.4 mandates 16 probes. v1 ships 6. TODOs:
7. Ghost approval id → 404 approval.not_found
8. Malformed approval id (non-uuid) → 400 validation
9. Foreign-tenant approval id with workflow_instance_id link → 00400 trigger
   refuses at SQL layer
10. Cancel-during-grant race — two concurrent processes; terminal state
    consistent
11. Double-emit approval.granted (simulate outbox retry) → resume's atomic
    claim makes idempotent
12. (Skip — B.4.A.5 gate moot; lifted by b4a5-step-h)
13. (Skip — same as 12)
14. Missing X-Client-Request-Id header → 400
15. Threshold='any' chain race with 3 different approvers (the load-bearing
    BLOCKER 2 probe). May need to seed extra persons.
16. (Already covered by v1 probe 5 — keep but rename for plan-§7.4 alignment)

Net: 7 probes to add (7, 8, 9, 10, 11, 14, 15). Commit shape:
`feat(workflow-phase1.5.smoke): add probe N — <name>`.

### 3. CONSOLIDATING PL/pgSQL RPC for rule create/update
The adversarial review flagged that RoomBookingRulesService.create() commits
the rule INSERT before the recompile RPC fires — partial-failure leaves an
orphan rule. Commit 2a5f1af3 shipped a TS-side compensation. The proper
long-term fix per project CLAUDE.md is a consolidating RPC:

`create_room_booking_rule_with_workflow(p_tenant_id uuid, p_rule_data jsonb,
p_graph_definition jsonb, p_actor_user_id uuid) RETURNS jsonb`

Body: INSERT room_booking_rules → INSERT workflow_definitions (v=1,
status='published') → flip rule.workflow_definition_id → return {rule,
definition_id, version}. Single transaction.

Symmetric: `update_room_booking_rule_with_workflow` for the .update() path.

Slot: `ls supabase/migrations/ | tail -10` — claim next free slot (00404+).
Bump twice if collision. Dry-run via BEGIN/ROLLBACK against remote BEFORE
pushing. After the RPC ships, delete the TS-side compensation block.

### 4. NIT cleanups (from external review)
a. Drop `entityHint` parameter from cancelInstanceById —
   workflow-engine.service.ts:354,417 (update 2 callers).
b. Refactor resume() to use getEntityKindForInstance helper —
   workflow-engine.service.ts:1925-1945 duplicates logic from line 184-223.
c. Add unit tests for startForBooking + WorkflowService.start({...}) — 3 tests
   min: happy case route, happy booking route, work_order throw.
d. cancelInstance mock in workflow-spawn-wake.handler.spec.ts:421 — remove
   unused stub or comment why.
e. Test-harness _engineForRpcEmit poke — workflow-engine.service.spec.ts:1206-1208
   brittle cast; accept or add defensive assertion.

### 5. Real-DB concurrency probes (Plan §7.5)
Once smoke v2 is green, add §7.5 probes as
apps/api/test/concurrency/visual-approval.spec.ts (mirrors
edit_booking_scope.spec.ts shape). Five probes:
- 50 concurrent grants of same approval id → exactly one succeeds.
- 10 concurrent booking creations matching rule → 10 workflow_instances; no
  double-starts.
- 10 concurrent booking.cancelled events → exactly one cancel call effective;
  approvals expire ONCE.
- 5 concurrent approval grants of threshold='any' chain → exactly one wins;
  others kind='already_resolved'; single outbox row.
- 5 concurrent ensure_room_booking_rule_workflow_definition calls on same rule
  → row lock serialises; versions monotonically increase; unique index never
  collides.

Run via `pnpm --filter @prequest/api test:concurrency`.

### 6. Open-question resolution (Plan §10)
- Q1: ApprovalConfigCompilerService packaging — DECIDED at
  apps/api/src/modules/approval/. Update plan.
- Q4: Drift defense for Option C+ per-executor dispatch — add convention test
  OR formally defer with §10 update.
- Q5: service-rule sibling spec schedule — defer formally.
- Q6: Auto-recompile interaction with admin-authored workflow_definitions —
  decide implement OR defer; update §10.
- Q8: cron cadence — locked at 5min, no further action.
- Q9: cancel RPC return shape claimed=false vs error — document in §10.

## Constraints + project conventions
- All migration discipline rules (project CLAUDE.md). Standing permission for
  Phase 1+ DB pushes IF both review layers green (per
  project_universal_workflow_phase0_shipped memory).
- All TS error handling — codes registered at 5 sites.
- tenant_id is the #0 invariant — every cross-tenant FK gets a row-level trigger.
- Multi-step writes are PL/pgSQL RPCs (work item #3).
- No Co-Authored-By: Claude in commits.
- Smoke gates mandatory before claiming shipped.
- codex IS used for adversarial review (project .claude/CLAUDE.md overrides
  global). Skip if codex hangs.
- Brutal honesty. If a probe genuinely can't be made to pass, say so.
- Orchestrator pattern for any multi-file or dense-spec work.

## Parallel-session navigation
Three workstreams interleaved on main: Phase 1.5 (this), B.4.A.5 follow-ups,
floor-plan polish. Do not commit anything not yours. If their files block a
commit (pre-commit migration-prefix collision check), temporarily `mv` the
colliding file outside supabase/migrations/, commit, then `mv` it back.

## Definition of done (production-ready)
- [ ] `pnpm smoke:visual-approval` all 16 probes green against live API + remote DB.
- [ ] Plan §7.5 concurrency probes pass via `pnpm --filter @prequest/api test:concurrency`.
- [ ] Consolidating `create_room_booking_rule_with_workflow` RPC shipped +
      applied to remote; TS service updated; compensation block removed.
- [ ] 5 NITs from external review closed (or formally deferred with TODO).
- [ ] §10 open questions resolved in the plan file.
- [ ] Full test suite passes (181+ suites, 0 new skipped).
- [ ] Memory project_phase1_5_shipped.md updated with final state.
- [ ] One final external review pass on the consolidating RPC (codex SQL
      review + subagent code-quality review).

## Starting commands
```bash
cd /Users/x/Desktop/XPQT
git fetch origin main
git log --oneline origin/main -20
ls supabase/migrations/ | tail -10
git status
pnpm dev &
sleep 20
pnpm smoke:visual-approval
```

If the smoke probe fails on probe 1 (happy threshold='all'), fix it before
doing anything else. Until probe 1 is green, NO claim about Phase 1.5 being
live can be made.
