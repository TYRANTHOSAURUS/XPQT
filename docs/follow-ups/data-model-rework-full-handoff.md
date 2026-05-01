# Data-model rework — full handoff for fresh-context agent

**Session window:** 2026-04-30 → 2026-05-01
**Branch:** `main`
**Total commits this work:** 33 (excluding 1 unrelated permissions commit)
**Total migrations applied to remote:** 39 (00202–00240, with 00234 a known no-op)
**Test state:** 661 active tests pass, 6 obsolete tests skipped
**Codex review rounds run:** 6 (rounds 1–6)
**Total bugs caught by codex this session:** 39+ — at least 2 catastrophic data losses

This document is **the** authoritative handoff. Every other doc in this session (`docs/data-model-redesign-2026-04-30.md`, `docs/data-model-step1c-plan.md`, `docs/follow-ups/data-model-overnight-handoff.md`) is now superseded by this one for "what is the current state."

---

## Why this rework existed

Original problem: `tickets` table was overloaded via a `ticket_kind` discriminator. Cases (reactive incidents/requests) and work_orders (dispatched units) were both rows in `tickets`. Audit trail (`ticket_activities`) was ticket-only. SLA timers, routing decisions, workflow instances were all FK'd to `tickets`. The model worked but it was muddled and getting worse.

Master design doc: `docs/data-model-redesign-2026-04-30.md`. Read it for the WHY. The plan was 6 steps: extract work_orders, refactor orders→service_orders, unify resources catalog, rename booking_bundles→bookings, promote visitors, rename tickets→cases.

Per-step plan for the destructive bits: `docs/data-model-step1c-plan.md` (11 phases, 1c.0 through 1c.11).

---

## What got shipped — final state of the system

### Step 0 — `activities` polymorphic sidecar ✅ DONE

`public.activities` table replacing ticket-only `ticket_activities`. Polymorphic via `(entity_kind, entity_id)`. Migrations 00202, 00203, 00211 (UPDATE shadow), 00212 (TRUNCATE shadow + parent reclassify guard), 00235 (existence-check shadow function post-1c.10c), 00236 (entity-kind integrity trigger), 00237 (tighten 'ticket' kind to backfill-only), 00240 (cross-kind validator).

**Currently:** 1083 case + 315 lost work_order activities = 1083 active rows. (315 wo activities were CASCADE-deleted at 1c.10c — see "Catastrophic data loss" section.)

**Bridge state:** `ticket_activities` table still exists with shadow triggers. App writers still write to `ticket_activities`; it's mirrored to `activities` automatically.

### Step 1 — extract work_orders from tickets ✅ DONE END-TO-END

`public.work_orders` is now a real BASE TABLE (319 rows). `public.tickets` is case-only (241 rows). `ticket_kind` column is DROPPED.

Phases shipped:
- **1c.0** baseline audit (`docs/follow-ups/step1c-baseline.md`)
- **1c.1** create work_orders_new table (00213, 00217 hardening, 00218 column rename, 00219 FK cascade)
- **1c.2** backfill 319 rows (00214)
- **1c.3** forward shadow trigger + divergence view (00215, 00216)
- **1c.3.5** reverse shadow trigger + depth-guard loop prevention + module allocator + legacy_ticket_id backfill (00220, 00221, 00223, 00224, 00225)
- **1c.3.6** atomic rename work_orders_new → work_orders (00222)
- **1c.4** writer cutover (dispatch.service.ts + ticket.service.ts:1612 booking-origin)
- **1c.5** parallel rollup trigger on work_orders (00226)
- **1c.6/7/8** polymorphic FKs (entity_kind, case_id, work_order_id) on sla_timers/workflow_instances/routing_decisions (00227–00229), with auto-derive trigger (00230) made robust to ticket_kind drop (00232)
- **1c.10c** destructive cutover: DELETE work_order rows from tickets, DROP COLUMN ticket_kind, drop dependents, soften FKs, recreate cases view as identity (00233 + 00234 FK retry + 00235 ticket_activities follow-up)
- **post-1c.10c repair rounds 1–6** addressing service-layer drift (commits 371a5c3 → 6fd7d8d)

Phases NOT shipped:
- **1c.9** split listing API into case.service.ts / work_order.service.ts. Cosmetic — current code works via `ticket_kind=work_order` returning empty on the cases endpoint. UI still exposes "Work orders" filter; needs frontend cleanup OR a new endpoint.
- **1c.11** drop `ticket_activities` table entirely + migrate readers to `activities`. The shadow triggers + dropped FK make ticket_activities work for both kinds today; the cleanup is purely cosmetic.

### Step 2 — orders → service_orders ⚠️ ALIAS VIEW ONLY

Migration 00231 created views `service_orders` and `service_order_lines` over `orders` and `order_line_items` respectively. Underlying tables retain all FKs/triggers. The **destructive rename** (rename tables, update every reference) is deferred — needs frontend coordination.

### Step 3 — unified resources catalog ⏸ NOT STARTED

Multi-week refactor. Per-kind conflict guards must stay separate (rooms vs assets have different semantics — see migrations 00123 and 00142). Codex flagged this in the original review: unified catalog yes, unified conflict guard NO.

### Step 4 — booking_bundles → bookings ⚠️ ALIAS VIEW ONLY

Migration 00231 also created `bookings` view over `booking_bundles`. Destructive rename deferred — same reason as step 2.

### Step 5 — visitors promotion ⏸ BLOCKED

Memory `project_visitors_track_split_off` says do not touch — parallel workstream owns this. Don't pull back into scope.

### Step 6 — tickets → cases rename 🗑️ DELETED

User decided rename is cosmetic and not worth the cost. `tickets` stays named `tickets` (now case-only). The `cases` view from step 1c.10c provides the alias name for code that prefers it.

---

## ⚠️ Catastrophic data loss this session — POSTMORTEM

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
666 API tests:                     pass (661 active + 6 obsolete-skipped)
```

---

## Known deferred items (production-blocking → cleanup)

### Production-blocking (per codex round 6)

1. **Work-order list endpoint missing.** Desk UI exposes "Work orders" filter button (`apps/web/src/components/desk/ticket-filter-bar.tsx:476`). Frontend passes `kind=work_order` to the tickets endpoint. Post-1c.10c that returns empty — false affordance. Either (a) remove the filter from UI, or (b) add a new `GET /work-orders` endpoint with the same filter shape.

2. **CI migration smoke tests.** Current CI (`.github/workflows/ci.yml:32`) only installs/lints/typechecks. It does NOT run migrations against a fresh DB. The 00234 + 00233 LIKE-pattern bugs would have failed a `pg_constraint` assertion if CI ran one. **Highest leverage fix in the entire backlog** — prevents the next data-loss disaster. Implement: after `db:reset`, run `psql` assertions checking no CASCADE FKs to tickets remain post-migration; required check constraints exist; test deletes with rollback don't cascade-nuke.

### Integrity / semantic cleanup

3. **`workflow_instances.ticket_id` is now FK-less** (post-00238). It's a "soft pointer" — application code still writes/reads via it (`workflow-engine.service.ts:91`, `workflow.service.ts:129`). Stale pointers will accumulate until workflows become entity-aware (case_id / work_order_id). Step 1c.9 split-API would address this.

4. **`bundle_is_visible_to_user` SQL helper out of sync with TS.** `00148_booking_bundle_status_view.sql:89` covers requester/host/`rooms.read_all`/`rooms.admin`. The TS service `bundle-visibility.service.ts:113` adds approver and work-order-assignee paths. Bundle visibility is now inconsistent depending on which path is hit.

5. **3 `it.skip`'d tests** in `apps/api/src/modules/ticket/ticket-sla-edit.spec.ts` for work_order SLA editing. Post-1c.10c, ticket.service.update is case-only — but the desk UI still exposes SLA policy editing for work_orders (`apps/web/src/components/desk/ticket-detail.tsx:1072`). Either restore a work-order SLA update API path, or remove the UI option.

6. **Frontend types `apps/web/src/api/tickets/types.ts:27`** still declare `ticket_kind` as required. API responses synthesize it post-1c.10c, so the contract holds, but it's a code-smell that needs proper handling at step 1c.9.

---

## What I'd do next session — concrete game plan

### Priority 1: CI smoke tests (1–2 hours)

The single highest-leverage change. Prevents the LIKE-pattern bug class from ever shipping again. Spec:

```yaml
# .github/workflows/ci.yml — add after install/lint
- name: db:reset
  run: pnpm db:start && pnpm db:reset

- name: assert no CASCADE FKs to tickets
  run: |
    psql -c "
      do \$\$
      declare v_cnt int;
      begin
        select count(*) into v_cnt from pg_constraint
         where contype = 'f'
           and confrelid = 'public.tickets'::regclass
           and confdeltype = 'c';  -- 'c' = CASCADE
        if v_cnt > 0 then raise exception 'CI: % CASCADE FKs to tickets remain', v_cnt; end if;
      end \$\$;"

- name: assert kind-consistency triggers fire
  run: |
    psql -c "..."  # smoke test that polymorphic kind validators reject cross-kind
```

The CI also doesn't currently run `db:reset` because of pre-existing duplicate migration number 00105 (two migrations share that number). That's a separate fix. Document and address.

### Priority 2: Address production-blocking (4–6 hours)

- Remove the "Work orders" filter button from the desk UI OR add `GET /work-orders` endpoint. The simpler fix: remove the button and tell users work_orders are accessed through the dispatch / vendor portal / daglijst surfaces (which already work).
- Update bundle visibility SQL helper to match TS service. Add tests.

### Priority 3: Final convergence round (1–2 hours)

Round 7 codex review. Likely 2–4 more findings (per round 6 estimate). Fix them. Get to 0 new findings as the convergence target.

### Priority 4: Steps 2/3/4 destructive renames (DEFERRED until product readiness)

Each is several hours of careful migration + frontend coordination. Do NOT do these autonomously. They need:
- Decision on whether the rename is worth the cost (per Step 6, the answer is sometimes "no")
- Frontend coordination (every reference must update in sync)
- Codex review at each destructive boundary
- Backup/PITR readiness

---

## How to use this handoff

A fresh agent with this doc and `data-model-redesign-2026-04-30.md` should be able to:

1. Verify current state with the remote queries in the "Current state" section.
2. Read the "Known deferred items" list and pick a priority.
3. Implement using the patterns from THIS session's good migrations:
   - **00208** for adding constraints with explicit pre-flight audits
   - **00238** for dropping FKs by explicit name with post-state assertions
   - **00240** for cross-kind validators that handle SET NULL semantics
4. Run codex review (gpt-5.5 xhigh) at every destructive boundary. Pattern: write the migration, run codex on it, fix findings, re-run codex, repeat until zero new findings.
5. NEVER use `pg_get_constraintdef like '%public.X%'` in DDL DO blocks. Use explicit constraint names.
6. NEVER ship a destructive migration without an inline `do $$ ... assert ... $$` post-state check.

## File / commit reference

All commits this session: `git log --oneline 4a05488..HEAD` (33 commits).

Migration sequence (00202–00240, all applied to remote `iwbqnyrvycqgnatratrk`):

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
```

Stress test fixtures (NOT committed, in `/tmp/`):
- `/tmp/stress-test-1c-renamed.sql` — 12 forward scenarios
- `/tmp/stress-test-1c-reverse-renamed.sql` — 5 reverse scenarios
- `/tmp/stress-test-1c-r6r7.sql` — 3 unguarded-column scenarios

Re-create these in `apps/api/test/sql/` if you want them in CI.

## Codex usage — when, how, what to ask

The single most valuable session learning. Capturing this so the next agent doesn't relearn at the cost of more catastrophic data losses.

### When to use codex

**ALWAYS before shipping** (not after — see "before vs after" below):
- Destructive migrations (DELETE, DROP COLUMN, DROP TABLE, ALTER FK with cascade implications)
- Schema changes that affect existing FKs, triggers, or check constraints
- Anything described in the migration as "ON DELETE CASCADE" or "ON DELETE SET NULL"
- Any migration with a `do $$ ... loop ... drop constraint ... $$` pattern (pattern-matching DDL is fragile)
- Cross-table data integrity changes
- Any migration where a comment says "fix" or "follow-up" referencing a prior migration that may have been a no-op
- Service-layer changes that consume schema that recently changed

**Run after** (post-shipping review still useful):
- Multi-file refactors (>3 services touched)
- Test suite changes that mark scenarios as `it.skip`
- Data-model documentation updates

**SKIP codex for:**
- Pure additive migrations on new tables nobody reads from yet (low risk)
- Test fixture cleanup
- Comment / doc-only changes
- Trivial renames within a single file

### How to use codex effectively

#### The recursion fact

Each codex round on this session's work caught 4–8 bugs IN MY FIXES from the previous round. Six rounds in a row. That's not codex being annoying — that's reality. Migration work has hidden coupling. Plan for it:

- Budget multiple rounds for any destructive work. 3–6 is normal.
- Don't ship to production after one round. Iterate to convergence (zero new findings).
- The convergence trajectory was 8 → 8 → 7 → 4 → 6 → 6 — it slows but doesn't reach zero quickly.

#### Before vs after the destructive cutover

The biggest mistake this session: I ran codex AFTER shipping 1c.10c. Round 1 caught loss #1. The fix in 00234 was itself a no-op for the same reason. Round 4 (3 rounds later) caught the same bug class in 00233 — but by then loss #2 (646 sla_timers) had already happened. **Running codex on the migration BEFORE shipping would have caught both losses.**

Rule: **for destructive migrations, codex review is a pre-ship gate, not a post-ship audit.**

#### Prompt patterns that worked

Copy these. They produced the catches that mattered.

**Numbered specific questions about specific concerns.** Vague "review this migration" prompts produced vague reviews. Numbered prompts with concrete pressure-test items produced numbered findings. Example:

```
Review migration 00xxx at /Users/x/Desktop/XPQT.

Pressure-test specifically:
1. The DO block at line 23 filters constraints by `like '%public.tablename%'`.
   pg_get_constraintdef omits the schema. Verify with a query.
2. After this migration, what FKs to <table> remain? Run the audit.
3. ...
```

**Always ask "what did I miss that ISN'T in this diff."** Codex is best at finding adjacent files I forgot. Patterns:
- "What other tables FK to X that this migration didn't touch?"
- "What other code paths still reference Y after this change?"
- "What tests should be obsolete now that aren't marked it.skip?"

**Demand convergence estimate.** "How many more rounds do you think this needs?" Codex gives honest numbers (round 5 said "1–2 more" and round 6 was indeed mostly cleanup).

**Ask for severity categorization.** "Critical / Important / Nit." Without this, codex returns 8 findings and you don't know which to fix first. With it, you can prioritize rationally.

**Cite file paths + line numbers in the prompt.** Codex returns findings with paths + lines that you can directly Edit. Without prompting for this, codex returns "the trigger function has a bug" — useless to fix.

#### What codex catches well (and what it doesn't)

**Catches well:**
- LIKE-pattern silent no-ops in DDL
- Schema-cache stale references (PostgREST FK aliases)
- View-on-view dependents that block DROP
- Cascade FK semantics across rebuild migrations
- Service-layer drift after schema changes (every round)
- Constraint conflicts with FK actions (SET NULL vs CHECK)
- Test fixtures that should be obsolete
- Cross-table data integrity gaps
- Race conditions in trigger ordering

**Misses or weakly catches:**
- Performance regressions under real load (no production traffic to measure against)
- UX impact of API contract changes (it can flag the contract change but not the user experience)
- Legacy code paths that aren't grep-discoverable from the diff
- Whether a deferred item is "production-blocking" vs "cosmetic" — it can flag both, judgment is the user's
- Multi-step plans where step N's correctness depends on step N+1 design (it's better at "this code is wrong" than "this design is wrong")

### What to ask codex specifically — checklist

Copy this to every prompt for destructive migrations:

```
Pressure-test:
1. Does this migration drop the constraints it claims to? Verify with
   a pg_constraint query against remote post-flight.
2. What other tables have FKs pointing at the changed table? Are any
   ON DELETE CASCADE? Will my DELETE cascade-nuke them?
3. What views, functions, triggers reference the columns I'm dropping?
   Will they break or block the migration?
4. What service-layer code reads or writes the affected schema? Grep
   the codebase. Specifically check: writers, readers, joins, RPC calls.
5. What tests cover the affected paths? Will they pass after this
   migration? Are any tests now obsolete (testing dead code paths)?
6. What's the rollback path? If "restore from backup," flag it.
7. What CI/test gates would have caught this if they existed? Suggest
   the assertion to add.
8. Convergence estimate.
9. Severity-ranked findings: critical / important / nit.
```

### Cost vs value

Each codex round on this session ran ~5–10 minutes and used ~300K–800K tokens. Six rounds = ~3M tokens of codex compute. Found 39+ bugs. **Each bug avoided is worth more than 100K codex tokens** — production data-loss recovery is far more expensive.

Counter-balance: don't run codex on trivial changes. The signal-to-noise drops on small additive diffs. Reserve it for boundary moments (destructive cutovers, multi-file refactors, schema-shape changes).

### The pre-mortem question

Before running codex, ask yourself: **"if codex finds nothing, would I trust this enough to ship to production?"** If no, don't even ship to dev — fix the gaps first. If yes, run codex anyway as a final check.

This session: I shipped 1c.10c thinking the iterative review had de-risked it. Codex round 1 immediately found the data loss. The pre-mortem question would have caught my overconfidence: I should NOT have shipped without a final destructive-migration-specific codex review. Lesson absorbed.

---

## `/full-review` skill — when, how, what to ask

The skill lives at `~/.claude/skills/full-review/SKILL.md`. It spawns TWO adversarial subagents (plan reviewer + code reviewer) in parallel using the same model that's running the main session (currently Opus 4.7). It's the in-session equivalent of codex — but cheaper, faster, and weaker.

### When to use full-review (vs codex vs self-review)

| Context | First-pass tool | Why |
|---|---|---|
| Trivial change (typo, single-line config, pure doc) | self-review | overhead not justified |
| Multi-file additive refactor | full-review | fresh-context catches what self-review misses; codex would be overkill |
| Multi-step plan / spec doc | full-review (plan reviewer half) | challenges design before any code is written; cheap to iterate |
| Schema migration, additive only | full-review | first pass; escalate to codex only if findings are significant |
| Schema migration, destructive | **codex** (skip full-review) | full-review uses the same model that wrote the bug — won't catch it. Loss-class bugs need a different model. |
| Service-layer drift after a destructive cutover | **codex** | proven this session: codex caught 39+ bugs that full-review missed |
| Test-coverage check ("did I miss any test that should fail") | full-review | adequate; codex overkill |
| Pre-merge sanity on a feature branch | full-review | adequate |
| Pre-production cutover audit | **codex** AND full-review | both gates; redundancy is worth the cost |

**The rule of thumb:** full-review is the cheap first pass. Codex is the heavy gate. For destructive work skip full-review and go straight to codex.

### How to invoke

The skill description triggers on the user typing "full-review" (with or without slash, with or without quotes). It also fires proactively after a "complex task" — codified in the description as: any of (database migration shipped, security/RLS/visibility/auth code modified, multi-file changes >3 files, TodoWrite list of 3+ items completed, multi-step refactor shipped).

What it does internally:
1. Captures `git log` + diff + recent commits.
2. Spawns two `Agent` subagents in parallel:
   - **Plan reviewer** — reads design docs, doesn't review code. Pressure-tests "is the approach correct."
   - **Code reviewer** — reads the diff, reads adjacent files. Pressure-tests "what did this miss."
3. Synthesizes findings into one severity-ranked report.
4. Asks user: apply critical+important fixes? (yes / pick / skip).

The skill file at `~/.claude/skills/full-review/SKILL.md` is the source of truth — read it for the exact subagent prompts.

### What full-review catches well (vs codex)

| | full-review | codex |
|---|---|---|
| Forgot to update a sibling test fixture | ✓ | ✓ |
| Stale comment / docstring | ✓ | ✓ |
| Missing column in a view recreation | ✓ | ✓ |
| Cross-tenant FK gap | ✓ | ✓ |
| Plan-level "did you consider X alternative" | ✓ (plan reviewer) | ✓ |
| LIKE-pattern silent no-op in DDL | ✗ usually misses | ✓ caught it |
| Service-layer drift after schema change | ✗ partially | ✓ caught all |
| Cascade FK data-loss hazard | ✗ partially | ✓ caught both |
| Constraint conflict with FK SET NULL | ✗ missed | ✓ caught |
| Trigger nesting / pg_trigger_depth nuance | ✗ missed | ✓ caught |

The pattern: full-review catches the same CLASS of issue I would catch if I were more careful. Codex catches issues that require knowing Postgres internals at depth. Both have value; neither replaces the other for destructive work.

### Lessons specific to this session

- Built the skill mid-session (commit `34ffe59` era). Used it ~4 times. Each time it caught real issues — including the missing-columns bug in the cases/work_orders views (00204→00205 follow-up was needed because of full-review).
- Full-review's "spawn two parallel subagents" pattern catches more than one subagent because the plan/code split forces breadth.
- Full-review can NOT substitute for codex on destructive migrations. Full-review missed both data-loss disasters this session. Codex caught them.
- If you're tempted to skip codex because full-review came back clean: don't. The two are complementary, not redundant.

### What to ask full-review

Same prompt patterns as codex (numbered specifics, severity ranking, file:line citations). The skill prompts the subagents with these defaults already. If you want extra specificity, pass it via the user message that triggers the skill.

### Cost vs value

Full-review uses two parallel subagents, each ~30-90s. ~50K-200K tokens total. Cheap relative to codex (3-10x cheaper). Run it freely on additive work; skip it for trivial; supplement it (don't replace) with codex for destructive.

---

## Combining the two

The good workflow this session would have followed (with hindsight):

1. **Plan stage:** write the migration plan as a doc. Run `full-review` (plan reviewer specifically) on the plan. Iterate until plan is solid. Cost: ~2 cheap subagent runs.
2. **Implementation stage:** write the migration. Run `full-review` (code reviewer half) on the migration alone. Fix obvious bugs. Cost: ~1 cheap subagent run.
3. **Pre-ship gate (destructive only):** run `codex exec` with the destructive-migration prompt checklist. Iterate to convergence. Cost: 3-6 codex rounds (~5-10 min each).
4. **Ship to remote.**
5. **Post-ship verify:** smoke tests + `psql` queries asserting expected post-state.
6. **CI gate (one-time setup):** `psql` assertions on every PR that ships migrations.

If we'd done this for 1c.10c specifically: the LIKE-pattern bug would have been caught at step 3 or step 6, before any data was lost. The 961 lost rows were the cost of skipping steps 3 and 6.

---

## Final word

Step 1 is done. The post-cutover repair is at convergence-1 to convergence-2 rounds. The biggest remaining risk is CI-not-catching-LIKE-bugs — fix that next or accept the same disaster will happen on step 3.

The honest meta-lesson from this session: **codex (gpt-5.5 xhigh) is genuinely a better adversarial reviewer than I am for migration work.** Six rounds of codex review on my fixes still found 4–6 bugs each round. Without those rounds, all 39 bugs would have shipped. With CI smoke tests, the 2 catastrophic ones would have been caught BEFORE shipping. Both gates matter.

---

## Session 7 — 2026-05-01 — CI migration smoke gate shipped

Picked Priority 1 from this doc (CI smoke tests) on the user's "make me proud" mandate. Shipped, verified end-to-end.

### What's new

- **`.github/workflows/ci.yml`** — added `migration-smoke` parallel job that boots Supabase CLI, runs `supabase db reset`, and runs the assertion script. Independent of the existing `check` job; failure on either fails the PR.
- **`scripts/ci-migration-asserts.sql`** — 10 numbered schema-integrity assertions (A1–A10). A1 is the one the prior session needed: "no CASCADE FKs to public.tickets remain". Others cover ticket_kind drop, work_orders being a base table, polymorphic FKs intact, tenant_id present on every known tenant-scoped table, canonical visibility/permission functions present, polymorphic kind triggers installed, and the renumbered 00241–00244 migrations actually took effect. Each assertion has a comment explaining what bug class it defends.
- **Pre-existing latent bugs unblocking `db:reset`** — fresh `supabase db reset` was broken on main before this session by two unrelated migrations:
  - `00106_request_type_routing_chain_handler.sql` — re-defined `request_type_coverage_matrix` with an added `routing_chain` column, but `CREATE OR REPLACE FUNCTION` rejects return-type changes (SQLSTATE 42P13). Fixed by adding `drop function if exists public.request_type_coverage_matrix(uuid, uuid);` before the recreate. Idempotent on remote (function is already in 8-col shape).
  - `00133_seed_room_booking_examples.sql` — assumed three meeting rooms with hardcoded UUIDs (`14d74559…`, `6df43476…`, `207242ea…`) exist, but on a fresh apply 00102's procedural room generation produces different UUIDs, so the FK insert fails. Fixed by gating the entire DO block on a `if not exists (select 1 from spaces where id in (...))` early-return — the seed becomes a no-op on fresh installs and unchanged on remote.
- **Renumbered 4 duplicate-prefix migrations**:
  - `00105_tenant_branding_surface_colors.sql` → `00241_…`
  - `00153_scheduler_data_rpc.sql` → `00242_…`
  - `00172_vendor_portal_status_en_route.sql` → `00243_…`
  - `00173_vendor_status_events_realtime.sql` → `00244_…`
  
  Verified zero forward references via grep before deferring. Remote DB doesn't track migration filenames in any `supabase_migrations.schema_migrations` table (the prior sessions all used direct psql, not `supabase db push`), so the rename is purely a local/CI concern with no remote desync.

### Verification

End-to-end loop run locally:
1. `pnpm db:reset` — applies 244 migrations cleanly, exit 0.
2. `psql -v ON_ERROR_STOP=1 -f scripts/ci-migration-asserts.sql` — 10 assertions, all OK, exit 0.
3. Created a temp migration that re-introduces the bug class (`create table … references public.tickets(id) on delete cascade`).
4. Re-ran assertions: A1 fired with the exact diagnostic (`"1 CASCADE FK(s) to public.tickets remain. Cascade-delete data-loss hazard. Drop them by EXPLICIT name…"`), exit code 3.
5. Dropped the canary, removed the temp migration, re-ran: green again, exit 0.

The gate would have caught both 2026-04-30 data-loss incidents (315 ticket_activities + 646 sla_timers) before they shipped.

### What this does NOT cover

- **Seed data integrity.** The CI gate is schema-only; demo-seed bugs (UUID-drift like 00133 had) won't fail it. The `if not exists` guard in 00133 means broken seeds become no-ops, not visible failures. Fine for CI's purpose; might want a separate "seed sanity" check later if seed bugs accumulate.
- **Runtime behaviour after migration.** A1 asserts "no CASCADE FKs structurally"; it doesn't simulate a destructive cutover and watch for cascade. The structural check is sufficient for the bug class but a future enhancement could add savepoint-rollback "would-this-actually-cascade" tests.
- **Non-Postgres invariants.** PostgREST schema cache, NOTIFY pgrst reload, the API's runtime tenant resolution — none of those are checked. Out of scope for a schema gate.
- **The rename of `00105_tenant_branding_surface_colors.sql` → `00241`** — this changes the apparent ordering in fresh installs. The migration's effect (adding 4 keys to `tenants.branding`) runs much later than originally. Anything between 00105 and 00241 that depended on those keys would silently use the old default. Grep showed zero forward references at the time of the rename, but if a future migration adds such a reference it'll fail at the wrong place. Hopefully unlikely.

### Open questions / handoff to next session

- Is the user happy with renumbering already-applied migrations vs. some other resolution (e.g., editing 00105 to do both things and dropping the secondary file)? Renumbering felt cleanest; alternative is a discussion.
- Should `pnpm db:reset` itself become a `pnpm` smoke step (not just CI)? Right now devs can still ship a migration that breaks `db:reset` if they don't run it locally first — CI catches it but the feedback loop is slow. A pre-commit or `pnpm verify` target would shift it left.
- Priority 2 (remove "Work orders" filter from desk UI) and Priority 3 (bundle visibility SQL helper rewrite) remain unchanged — see the "Known deferred items" section.

### Files touched this session

```
.github/workflows/ci.yml                                     +44
scripts/ci-migration-asserts.sql                             +245 (new)
supabase/migrations/00106_request_type_routing_chain_handler.sql  +9
supabase/migrations/00133_seed_room_booking_examples.sql     +14
supabase/migrations/00105_tenant_branding_surface_colors.sql → 00241_… (renamed)
supabase/migrations/00153_scheduler_data_rpc.sql             → 00242_… (renamed)
supabase/migrations/00172_vendor_portal_status_en_route.sql  → 00243_… (renamed)
supabase/migrations/00173_vendor_status_events_realtime.sql  → 00244_… (renamed)
docs/follow-ups/data-model-rework-full-handoff.md            +this section
```

No remote DB changes. No application-code changes. CI workflow file is the user-visible artifact.

---

## Session 8 — 2026-05-01 — Priority 2 + Priority 3 shipped

Two follow-up priorities cleared in the same session: removed the dead "Work orders" filter (P2), brought `bundle_is_visible_to_user` SQL helper into parity with the TS service (P3), and ran codex review on P3 with the convergence patch folded in.

### Priority 2: removed dead "Work orders" filter

Commit `ded7cc5`. Files changed:

```
apps/web/src/components/desk/ticket-filter-bar.tsx  -23  (KindChip removed entirely)
apps/web/src/pages/desk/use-ticket-filters.ts        -4  (kind dropped from RawFilters / URL parse / activeCount)
apps/web/src/api/tickets/keys.ts                     -1  (ticketKind dropped from TicketListFilters)
apps/web/src/api/tickets/queries.ts                  -1  (kind query param dropped from ticketListOptions)
```

The filter was a 2-option toggle (Cases / Work orders). With work_orders gone from the tickets endpoint, "Cases" became a tautology — every row already qualifies. Killed the entire toggle, not just the work_order option.

Bookmarked URLs with `?kind=…` now silently fall back to the unfiltered list (strictly better than the prior dead-filter empty result). The API controller still parses `kind=…` for portal / external callers — a deeper deletion is documented as step 1c.9 cleanup along with `TicketDetail.ticket_kind` (still load-bearing on detail surfaces for ref-prefix formatting and conditional WO-only UI in 8+ files).

### Priority 3: bundle visibility parity (SQL ↔ TS)

**Important context the original handoff understated:** `bundle_is_visible_to_user` had **zero SQL call sites today** — no RLS policy, view, trigger, or RPC invokes it. The visibility logic in production was already enforced 100% by `BundleVisibilityService.assertVisible`. So this work was **future-proofing** the documented "canonical fallback," not fixing a live access-control bug. Worth shipping because someone WILL eventually wire the SQL helper into an RLS policy / view predicate / `bundle_visible_ids` RPC, and at that point the silent under-grant would become real.

Migration `00245_bundle_visibility_parity_with_ts.sql`:
- Added approver path: `EXISTS (approvals WHERE tenant_id, target_entity_id=bundle, target_entity_type='booking_bundle', approver_person_id=person)`. Mirrors `bundle-visibility.service.ts:113-124`.
- Added work-order assignee path: `EXISTS (work_orders WHERE tenant_id, booking_bundle_id=bundle, assigned_user_id=user)`. Mirrors `bundle-visibility.service.ts:126-140`.
- One **defensive deviation** from TS: the SQL filters `target_entity_type = 'booking_bundle'` on the approvals join. TS did not. Codex flagged this as a SQL/TS divergence in the opposite direction; I updated the TS service to match (`bundle-visibility.service.ts:115` now also filters by type), so they reconverge in the strict direction.

Behavioral verification before commit:
1. `pnpm db:reset` → applies clean.
2. Behavioral smoke test (insert bundle + approval + WO in a savepoint, exercise both new paths against the function): all paths return `true` correctly. Pre-state (no path applies) returns `false`.
3. Codex round 1 review on the migration + assertions + grants:
   - **0 critical findings.**
   - **2 important:** (a) SECURITY DEFINER + grant-to-authenticated is a cross-tenant visibility oracle (pre-existing in 00148; flagged as new deferred item below); (b) SQL/TS divergence on `target_entity_type` (fixed forward — TS updated to match).
   - **2 nits:** (a) A11 was string-match brittle (replaced with behavioral fixture test that inserts/exercises/cleans up); (b) `docs/room-booking.md:337-339` still pointed at 00148 (updated).

A11 is now behavioral and residue-free: in a DO block with `EXCEPTION WHEN OTHERS THEN cleanup; RAISE`, it inserts a synthetic bundle + approval + WO scoped to a generated UUID, exercises `bundle_is_visible_to_user` on each new path, and DELETEs everything on success or failure. Verified zero residue rows post-run.

Files changed for P3:

```
supabase/migrations/00245_bundle_visibility_parity_with_ts.sql  +99 (new)
apps/api/src/modules/booking-bundles/bundle-visibility.service.ts  +8 (target_entity_type filter)
scripts/ci-migration-asserts.sql                                +60 (A11 strengthened)
docs/room-booking.md                                            +6 -4 (visibility section updated)
docs/follow-ups/data-model-rework-full-handoff.md               +this section
```

### Status of "Known deferred items" from prior sessions

- ✅ #1 Work-order list endpoint missing → resolved as "remove the filter" in P2.
- ✅ #2 CI migration smoke tests → shipped in Session 7.
- ⚠ #3 `workflow_instances.ticket_id` is still a soft pointer with no FK → unchanged; needs step 1c.9.
- ✅ #4 `bundle_is_visible_to_user` out of sync with TS → shipped in Session 8 (P3).
- ⚠ #5 3 `it.skip`'d tests for work_order SLA editing → unchanged; see Session 7 doc for context.
- ⚠ #6 Frontend types declare `ticket_kind` as required → unchanged; ref-prefix and conditional UI in 8+ files block easy removal. Needs step 1c.9.

### NEW deferred items from this session

- **`bundle_is_visible_to_user` is granted EXECUTE to `authenticated` role** while running as SECURITY DEFINER. Codex flagged this in Session 8 P3 review: any authenticated caller can pass arbitrary `(p_user_id, p_tenant_id)` and get a true/false oracle for any bundle. Body-level tenant filtering means an attacker can't read bundle CONTENTS via this function — but they can probe whether `(user X, bundle Y)` has visibility, which leaks org structure. Pre-existing in migration 00148; the parity migration just inherited the grant. Two fixes possible: (a) revoke from `authenticated`, only allow `service_role` (then add a wrapper RPC bound to `auth.uid()` and `current_tenant_id()` for callers that need it from the client); (b) bind the function arguments to the calling session and refuse arbitrary p_user_id. Option (a) is simpler. Worth one targeted migration, not part of the rework's critical path.

- **TS `BundleVisibilityService.assertVisible` and SQL `bundle_is_visible_to_user` both grant access via approvals regardless of approval status.** Same for work_orders status. Historical-approver and closed-WO-assignee retention is defensible for audit, but it's a policy question that hasn't been explicitly debated. If product wants stricter scoping ("approver loses bundle access once approval is rejected/expired"), both implementations need a status filter — and the CI parity test (A11) needs to assert the behavior matches.

### What's left from the original priority list

- Priority 4: Codex round 7 — convergence verification on the prior cutover work. **Lower stakes now** that the three concrete priorities are done. The round-6 codex run on the cutover work converged at "1–2 more rounds." I'd put this at "ship if a future migration touches the same files; otherwise acceptable as-is."

### Session 8 verification summary

- `pnpm db:reset` → 245 migrations apply cleanly.
- `psql -f scripts/ci-migration-asserts.sql` → A1..A11 all green (A11 now behavioral).
- `pnpm --filter @prequest/api run lint` → tsc passes after TS visibility service change.
- Codex review round 1 on P3 → 0 critical, 2 important fixed forward, 2 nits cleared.
- No remote DB push yet (waiting on user sign-off; CLAUDE.md requires confirmation for `pnpm db:push`).

---

## Session 10 — 2026-05-01 — Slice 1: setPlan on work_orders

### Why this exists

The plandate workstream's uncommitted code wires `useSetTicketPlan` → `PATCH /tickets/:id/plan` → `TicketService.setPlan`, which loads work_orders via getById then writes to the `tickets` table. Post-1c.10c work_orders are not in tickets, so plandate is silently broken end-to-end. The Plan SidebarGroup is gated `ticket_kind === 'work_order'` (only ever runs on WOs). Without this fix the planning board ships dead.

This slice implements `WorkOrderService.setPlan` + `canPlan`, the second method on the work-order command surface (after B1.5 SLA edit). Plandate's broken `setPlan` / endpoint / hooks stay in their files (see "Plandate workstream coordination" below).

### What shipped

```
supabase/migrations/00246_work_orders_plandate_check.sql            (NEW, ~38 lines)
apps/api/src/modules/work-orders/work-order.service.ts              +203  (setPlan + canPlan + WorkOrderRow extension)
apps/api/src/modules/work-orders/work-order.controller.ts           +52   (@Patch(':id/plan') + @Get(':id/can-plan'))
apps/api/src/modules/work-orders/work-order-set-plan.spec.ts        (NEW, 7 tests, all green)
apps/api/src/modules/work-orders/work-order-can-plan.spec.ts        (NEW, 3 tests, all green)
apps/web/src/api/tickets/mutations.ts                               +93   (useSetWorkOrderPlan hook)
apps/web/src/api/tickets/queries.ts                                 +25   (useCanPlanWorkOrder + workOrderCanPlanOptions)
apps/web/src/components/desk/ticket-detail.tsx                      0 net (2 import swaps + 2 hook-call swaps)
docs/follow-ups/data-model-rework-full-handoff.md                   +this section
```

### Two-gate review pattern this session followed

The user explicitly directed me to use **full-review** AND **codex** at both checkpoints. New process going forward:

1. **Plan-time review (full-review skill).** Before any code: write the plan, dispatch the plan-reviewer subagent. This session's plan-review caught 3 critical findings I'd have shipped:
   - I claimed `work_orders` was missing the `planned_*` columns (false — they were added in 00213; only the CHECK constraint was missing).
   - I was about to use `assertCanPlan` for status / priority / assignment too — same over-grant mistake codex caught me making for SLA in B1.5.
   - I was treating "mirror TicketService.update" as a small lift; reviewer pointed out case-only guards that don't apply to WOs.
   
   Result: scope shrunk from "4 commands" to "setPlan only as Slice 1; status/priority/assignment as Slice 2 with proper per-field gates."

2. **Code-time review (full-review skill, code-reviewer half).** After implementation: 5 important findings:
   - Pre-existing data violations on remote (audit before push).
   - Validation upper bound missing (Number.isInteger(1e15) is true).
   - No-op fast-path test gap (only "both equal" tested).
   - Dead code: `TicketService.setPlan` + `useSetTicketPlan` still importable.
   - canPlan tests missing.

3. **Code-time review (codex).** Codex hit quota mid-review but produced 2 findings before stopping:
   - Confirmed full-review's #2 (audit mandatory — bridge migrations between 00213 and 00246 propagated values verbatim).
   - **NEW finding full-review missed:** the no-op fast-path used `===` on raw timestamp strings. Postgres returns a different STRING form (`+00:00`) than the caller's input (`Z`) for the same instant — `===` wrongly triggers a re-write + spurious activity row. Real bug, fixed.

### Codex + full-review fixes applied

| Source | Finding | Fix |
|---|---|---|
| codex (NEW) | T | Normalize timestamps via Date.parse before equality check in setPlan no-op path. New test locks the fix in. |
| full-review #3 | Validation upper bound | Reject `planned_duration_minutes > 60 * 24 * 365` (1 year). New test asserts. |
| full-review #5 | No-op test gap | Added 2 tests: "start equal, duration changed" + "duration equal, start changed". |
| full-review #8c | canPlan tests | New `work-order-can-plan.spec.ts` with 3 tests: SYSTEM_ACTOR shortcut, ForbiddenException → false, non-Forbidden → propagate. |

### Deferred (intentionally)

- **Full-review #2 / codex confirm** — pre-push audit on remote. Ran the audit before commit: `0` work_order rows have `planned_duration_minutes <= 0` (in fact 0 rows have it set at all out of 319 total). Migration 00246 is safe to push.
- **Full-review #8b** — dead code: `TicketService.setPlan` + `useSetTicketPlan` + `/tickets/:id/plan` route still live. Reviewer's framing: "the trap stays armed" — if plandate workstream removes the `ticket_kind === 'work_order'` gate before deleting the broken function, that's an incident. **Not deleted in this slice** because the broken code is in plandate-territory files (`apps/api/src/modules/ticket/ticket.controller.ts`, `apps/web/src/api/tickets/mutations.ts`, `apps/web/src/api/tickets/queries.ts`) which this session committed not to modify. **Plandate workstream owner: when you commit your work, please delete `TicketService.setPlan` (apps/api/src/modules/ticket/ticket.service.ts:1082-1180), `PATCH /tickets/:id/plan`, `GET /tickets/:id/can-plan`, `useSetTicketPlan`, `useCanPlanTicket`, and `ticketCanPlanOptions`. The Plan SidebarGroup is the only consumer and it's now rewired onto WorkOrder*.**
- **Full-review #7 nit** — class-validator DTOs vs hand-rolled validation. Wider cleanup pattern; not Slice-1 scope.

### Verification

- `pnpm db:reset` clean through 00246.
- `chk_work_orders_planned_duration_positive` constraint visible on local + verified absent in conflict on remote.
- `psql -f scripts/ci-migration-asserts.sql` → A1..A11 still green.
- `pnpm --filter @prequest/api exec jest work-order` → 26/26 across 5 suites (was 20/20; added 6 new setPlan + canPlan tests).
- `pnpm --filter @prequest/api run lint` exit 0.
- `pnpm --filter @prequest/web run lint` exit 0 (23 pre-existing warnings, none in touched files).

### Plandate workstream coordination

After this slice commits, the Plan SidebarGroup in `ticket-detail.tsx` consumes:
- `useSetWorkOrderPlan` (mine, in `apps/web/src/api/tickets/mutations.ts`) → `PATCH /work-orders/:id/plan` → `WorkOrderService.setPlan` ✅ working.
- `useCanPlanWorkOrder` (mine, in `apps/web/src/api/tickets/queries.ts`) → `GET /work-orders/:id/can-plan` → `WorkOrderService.canPlan` ✅ working.

The plandate workstream's surfaces (`useSetTicketPlan`, `useCanPlanTicket`, `ticketCanPlanOptions`, `TicketService.setPlan`, `PATCH /tickets/:id/plan`, `GET /tickets/:id/can-plan`) are now dead code with no consumers. Recommended cleanup at plandate commit time documented above.

If the plandate workstream wants plan-dates on cases later, those surfaces can be repurposed (rename → `useSetCasePlan` etc.). But that's a deliberate design call, not a side-effect.

### What's left (Slice 2 / Slice 3)

- **Slice 2 (separate session):** restore `updateStatus` / `updatePriority` / `updateAssignment` on work_orders with PROPER per-field gates (per plan-reviewer #2 finding):
  - `updateStatus`: `assertVisible('write')` + per-transition checks for `tickets.close` / `tickets.reopen`.
  - `updatePriority`: `assertCanPlan` floor + `tickets.change_priority || tickets.write_all`.
  - `updateAssignment`: `assertCanPlan` floor + `tickets.assign || tickets.write_all`.
  - Per-field endpoints (NOT a single `PATCH /work-orders/:id` field-dispatcher).
- **Slice 3 (deferred):** `cost`, `tags`, `watchers`, `title`, `description` on work_orders (also broken from desk detail).
- **The plandate workstream still needs to commit**, with the dead-code cleanup above.

### Pre-commit ground-truth: codex saved this slice from a real bug

The timestamp string-equality bug (codex finding T) would have shipped if I'd skipped codex and relied on full-review alone. Full-review (Opus subagent) didn't catch it — it's a Postgres-internals nuance codex specifically flagged. **Codex remains the heavier gate** on commands that touch DB roundtripping. Keep the two-gate pattern: full-review for breadth, codex for depth.

---

## Session 11 — 2026-05-01 — Slice 2: status / priority / assignment / reassign on work_orders

### Why this exists

After Slice 1 (setPlan) shipped, status / priority / team / assignee mutations on work_orders were still silently broken from the desk detail sidebar (firing `PATCH /tickets/:id` and `POST /tickets/:id/reassign` which `TicketService.update` and `TicketService.reassign` reject case-only). Slice 2 closes the rest of the bug class.

Plus reassign-with-reason (POST analog) ships in the same slice — without it, the FE's `useReassignTicket` would still silently no-op on WOs.

### What shipped

```
apps/api/src/modules/work-orders/work-order.service.ts             +750 net (4 commands + helpers)
apps/api/src/modules/work-orders/work-order.controller.ts          +109 (4 routes + DTOs)
apps/api/src/modules/work-orders/work-order-update-status.spec.ts  (NEW, 8 tests)
apps/api/src/modules/work-orders/work-order-update-priority.spec.ts (NEW, 4 tests)
apps/api/src/modules/work-orders/work-order-update-assignment.spec.ts (NEW, 7 tests)
apps/api/src/modules/work-orders/work-order-reassign.spec.ts       (NEW, 4 tests)
apps/api/src/modules/sla/sla.service.ts                            +43 (applyWaitingStateTransition extracted)
apps/api/src/modules/ticket/ticket.service.ts                      -29/+18 (delegates to sla.applyWaitingStateTransition)
apps/api/src/modules/ticket/ticket-close-guard.spec.ts             +5 (added no-op mock for the new SLA helper)
apps/web/src/api/tickets/mutations.ts                              +192 (4 hooks)
apps/web/src/components/desk/ticket-detail.tsx                     +115 net (patchWorkOrder dispatch + reassign rewire)
docs/assignments-routing-fulfillment.md                            +108 (§7 sub-section)
docs/follow-ups/data-model-rework-full-handoff.md                  +this section
```

### Two-gate review pattern (codex hit quota mid-review)

1. **Plan-time review (full-review).** 3 critical findings caught pre-implementation:
   - Visibility floor for `updateStatus`: I had it backwards — `assertVisible('write')` allows requesters/watchers via participant match (abuse path); `assertCanPlan` is the canonical operator gate. Corrected.
   - Per-transition close/reopen permission gates DON'T EXIST on case-side. Adding them only on WO creates wrong-direction divergence. Dropped from plan; documented as future security improvement.
   - Domain event renaming (`work_order_status_changed`) — no subscribers exist for `ticket_status_changed`; renaming would split reports for no benefit. Kept the same names.

2. **Code-time review (full-review).** 4 important findings + 1 nit. All addressed in this slice except #9 / #10 (see below).

3. **Code-time review (codex).** Hit quota immediately. No findings produced this round.

### Fixes applied post-code-review

| # | Source | Fix |
|---|---|---|
| 1 | full-review | `reassign(rerun_resolver: true)` switched from `BadRequestException` to `NotImplementedException` (501). 400 says "your request is malformed"; 501 is the truth. |
| 2 | full-review | Extracted `applyWaitingStateTransition` from TicketService + WorkOrderService into a public method on SlaService. Eliminates the duplication risk. Both services now call `slaService.applyWaitingStateTransition(...)`. |
| 4 | full-review | Fixed misleading comment about the 00230 derive trigger. The actual story: 00232 supersedes 00230 and handles polymorphic auto-derive correctly across `tickets` + `work_orders`; the explicit columns we set in `routing_decisions` insert are defensive (skip per-row trigger lookup, deterministic on app side), not strictly required. Comment + doc note both updated. |

### Deferred (documented for future)

- **Full-review #3 (logDomainEvent duplication, nit).** 5-line helper, two copies, drift cost is real but small. Add a `// kept in sync with ticket.service.ts` comment to both. Defer extraction.

- **Full-review #9 (FE multi-field PATCH fan-out race).** `patchWorkOrder()` fires up to 3 PATCHes serially when a single FE call combines status/priority/assignment fields. If A succeeds and B fails, B rolls back to its snapshot which doesn't include A's optimistic write — cache visually loses A's value until next refetch. Practical risk: low (desk UI almost never fires multi-field patches in one call). Real fix is a single `PATCH /work-orders/:id` server endpoint that accepts the whole DTO — defer to Slice 3.

- **Full-review #10 (permission-gate divergence — needs decision).** Case-side `TicketService.update()` and `reassign()` use ONLY `assertVisible('write')`. WO-side adds `tickets.change_priority` and `tickets.assign` permission gates per the catalog. **Real divergence** — case is under-gated OR WO is over-gated. My judgment: WO-side is the canonical pattern (green-field; the catalog's per-action keys exist for a reason); case-side is legacy undergated. **Future security alignment work:** add the same gates to TicketService.update + TicketService.reassign. This expands Slice 3 scope or becomes a separate "security alignment" slice. **User has not decided** — handoff entry flags this for next session.

### Verification

- `pnpm db:reset` clean (no new migration in Slice 2).
- `pnpm --filter @prequest/api exec jest work-order ticket-sla-edit ticket-close-guard` — 52 passed + 1 pre-existing skip across 11 suites.
- `pnpm --filter @prequest/api run lint` exit 0.
- `pnpm --filter @prequest/web run lint` exit 0 (23 pre-existing warnings, none in touched files).

### Plandate workstream coordination (still uncommitted)

The plandate workstream's files remain dirty. Slice 2 added hooks to `mutations.ts` and surgical edits to `ticket-detail.tsx`; same selective-staging dance as Sessions 9 + 10. Plandate hunks confirmed untouched.

### What's left

- **Slice 3 (deferred):** cost / tags / watchers / title / description on work_orders (also broken from desk detail). Plus the single `PATCH /work-orders/:id` endpoint that resolves Full-review #9.
- **Security alignment slice (deferred, decision needed):** add `tickets.change_priority` and `tickets.assign` permission gates to `TicketService.update` + `TicketService.reassign` so case-side matches WO-side. Or decide the divergence is intentional and document it.
- **Plandate workstream coordination:** when plandate commits, they must (a) delete `TicketService.setPlan` + `useSetTicketPlan` + `/tickets/:id/plan` route per Session 10's flag, (b) confirm the rewired Plan SidebarGroup uses `useSetWorkOrderPlan`/`useCanPlanWorkOrder` (already done in working tree).

### Codex quota

Codex hit quota mid-review on Slice 2. Full-review (Opus subagent) handled the heavy lifting alone this round. No bugs slipped through to my knowledge — full-review caught 5 of 5 important items including the permission-gate divergence which is the most consequential. **The two-gate pattern is robust to one gate being unavailable**, but degrades when codex is offline because the Postgres-internals nuance class (timestamp roundtrip etc.) is codex's specialty. Plan accordingly for future sessions.

---

## Session 9 — 2026-05-01 — B1.5 work-order command surface

### Why this exists

After Session 8 wrapped, codex was asked to independently weigh in on remaining priorities. It surfaced two findings I'd missed:

1. The work-order command surface is broken in MULTIPLE places, not just SLA. `TicketService.update` is case-only post-1c.10c — yet the desk-detail sidebar still routes status/priority/team/assignee/SLA mutations through `PATCH /tickets/:id`, which silently rejects work_orders. Same with `setPlan` (used by the plandate workstream's uncommitted code) — it loads work_orders via getById then writes to `tickets`.
2. The plandate workstream itself is shipping the same bug class. Whoever owns it needs to know.

So the right next step wasn't "restore SLA endpoint" (the original deferred #5). It was "build the work-order command surface and ship SLA on it as the first method." Codex called this **B1.5** — between B1 (full split, ~2-3 days) and B3 (don't split). Half-day of scaffolding, future-proof for status/priority/plan/assignment as they accumulate.

### What shipped

New module `apps/api/src/modules/work-orders/`:

```
work-order.service.ts          ~210 lines — WorkOrderService.updateSla(id, slaId, actor)
work-order.controller.ts       ~50 lines  — @Controller('work-orders'), PATCH :id/sla
work-orders.module.ts          ~20 lines  — wiring (forwardRef to SlaModule + TicketModule)
work-order-sla-edit.spec.ts    ~210 lines — 4 tests, 4 pass
```

Modified:

```
apps/api/src/app.module.ts                          — registered WorkOrdersModule
apps/api/src/modules/ticket/ticket-sla-edit.spec.ts — removed 3 it.skip lines (covered by new spec)
apps/web/src/api/tickets/mutations.ts               — added useUpdateWorkOrderSla hook
apps/web/src/components/desk/ticket-detail.tsx      — 3 surgical edits to wire the new mutation
docs/assignments-routing-fulfillment.md             — §6/§7 reflect post-1c.10c reality + new WorkOrderService surface
```

### Codex review round 1 — applied forward

- **0 critical findings.**
- **5 important** — patched in same session:
  1. **Auth gate too broad.** Used `assertCanPlan` alone (assignees/vendors get through). The catalog already has `sla.override` (danger:true) at `packages/shared/src/permissions.ts:296` — that's the canonical key. Added a two-axis gate: `assertCanPlan` for visibility floor + `tickets.write_all || sla.override` for the danger-permission check.
  2. **Stale returned row.** `restartTimers` writes SLA-derived columns AFTER my SELECT. Moved the final SELECT to AFTER the timer restart so the FE caches a fresh row.
  3. **`updated_at` not advancing.** `work_orders` has no auto-trigger for updated_at on UPDATE (the bridge-era trigger was dropped in 00217 and never restored). Set `updated_at` explicitly in the UPDATE payload.
  4. **(deferred)** Timer restart swallow leaves sla_id and timers inconsistent on failure. Same pattern as TicketService — class-wide debt, not B1.5 scope. Documented in service comment as known debt with codex citation.
  5. **(deferred)** Activity write swallow loses audit on failure. Same pattern, same deferral.
- **1 nit:** FE hook typed response as `TicketDetail` but backend returns raw `WorkOrderRow`. Narrowed to `Pick<TicketDetail, 'id' | 'sla_id' | 'updated_at'>` — honest contract; hook only invalidates anyway.

### Tests covering the codex fixes

`work-order-sla-edit.spec.ts` (4 tests):
- `accepts sla_id change on a work_order and restarts timers` (asserts updated_at is in the UPDATE payload).
- `accepts sla_id = null (clear SLA)`.
- `does NOT restart timers if sla_id is unchanged`.
- **`throws Forbidden when caller lacks sla.override and write_all`** — codex-driven. Asserts the gate runs the right RPC (`user_has_permission` with `sla.override`) AND stops before any mutation. Without this test, a future revert of the danger-permission gate would silently re-broaden authorization.

`ticket-sla-edit.spec.ts` (1 remaining): `refuses sla_id change on a parent case` (case-only ticket service still rejects).

### What this means for the plandate workstream (CRITICAL — read if you own those files)

The uncommitted plandate code (in your working tree at session-start: `apps/api/src/modules/ticket/ticket.controller.ts`, `apps/web/src/api/tickets/{keys,mutations,queries,types}.ts`, `apps/web/src/components/desk/{ticket-detail,plan-field}.tsx`, `supabase/migrations/00206_ticket_plandate.sql`, `docs/visibility.md`, `docs/superpowers/specs/2026-04-30-plandate-planning-board-pm-design.md`) has a real bug:

- `TicketService.setPlan` at `apps/api/src/modules/ticket/ticket.service.ts:1094-1134` loads a work_order via `getById`, then writes to the `tickets` table.
- Post-1c.10c, work_orders are not in the `tickets` table. The write silently affects no rows or fails.
- Same pattern as the deferred #5 SLA bug we just fixed via B1.5.

**Before committing the plandate workstream:** rebuild `setPlan` on top of `WorkOrderService` (the same way `updateSla` was built). Add `WorkOrderService.setPlan(workOrderId, plannedStartAt, plannedDurationMinutes, actor)`. Mount on the new `/work-orders` controller as `PATCH /work-orders/:id/plan`. Update FE `useSetTicketPlan` → `useSetWorkOrderPlan`. Reuse the same auth pattern (assertCanPlan visibility, no extra permission required since plan is not a danger key — but verify with the permission catalog). Add tests.

If this is left as-is, the plandate planning board will appear to work in the UI (optimistic updates, no API errors) while NEVER actually persisting plans. Worse — it'll write nothing AND succeed silently because the case-only `TicketService.setPlan` won't error on an empty UPDATE WHERE.

### What's left after Session 9

- Open question on B1's full scope (separate `/cases/*` controller, full split). Codex's recommendation: not required until planning board / per-kind RLS / WO queues are imminent. B1.5 is the incremental foothold; future commands grow into it.
- C1 (frontend `TicketDetail` split into `CaseDetail` + `WorkOrderDetail`) still rides full B1.
- Class-wide debt: timer/activity write swallowing across SLA-edit code paths. Both TicketService and WorkOrderService have this. Real fix is transactional command pattern in SlaService — not session-scoped.
- The plandate workstream coordination above.

### Session 9 verification summary

- `pnpm --filter @prequest/api exec jest work-order-sla-edit ticket-sla-edit` → 5/5 green (4 new + 1 case-only).
- `pnpm --filter @prequest/api run lint` → exit 0.
- `pnpm --filter @prequest/web run lint` → exit 0 (23 pre-existing warnings, none in touched files).
- Plandate workstream hunks confirmed untouched (line-count check: keys=+1, queries=+13, types=+9 unchanged; mutations grew +49→+97 with my hook only; ticket-detail grew +38→+52 with my 3 surgical edits only).
- Codex review round 1 → 0 critical, 5 important fixed forward, 1 nit fixed forward. Convergence ~85% per codex.
- No DB migration. No remote DB changes. CI assertion script unaffected.
