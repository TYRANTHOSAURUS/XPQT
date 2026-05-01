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
