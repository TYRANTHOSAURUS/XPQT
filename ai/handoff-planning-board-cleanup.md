# Handoff — Planning-board cleanup + v1.1 expansion

**Date:** 2026-05-12 (created)
**Branch:** all work to date is on `main` (14 commits, grep `feat\|fix\|docs.*planning-board`).
**Status:** Slice B (planning board) shipped MVP, two full-review + two codex passes done. This document hands off the remaining findings + scope expansions for autonomous execution.

---

## 1. Identity + ground rules

You are picking up the planning-board workstream after Slice B shipped. The user has explicitly granted:

- **DB push authorisation** (memory: `feedback_db_push_authorized`). `pnpm db:push` is broken; use the psql fallback in `.claude/CLAUDE.md`. Always rebuild + restart the dev API after a migration push so the new RPC / schema is in scope before you smoke-test.
- **Codex as the canonical adversarial reviewer** (memory: `feedback_codex_reviews`). One pass after a substantive batch — not per file. Use the architecture-review prompt shape from the previous slice (see §5 below).
- **Brutal honesty / no epistemic cowardice** (global `CLAUDE.md`). Push back firmly if a finding is wrong or out of scope. Don't fold under pressure. Distinguish facts / judgments / preferences.

Mandatory project rules to never break:

- **`tenant_id` is invariant #0** (`feedback_tenant_id_ultimate_rule`). Every new query / table / test enforces it at schema + service + test layers. A missing filter is a P0 cross-tenant leak.
- **No LATERAL projection past a `*_visibility_ids` predicate** (`feedback_visibility_gate_lateral`). Materialise the visible-id set as a CTE; INNER JOIN every dimension table on `(id, tenant_id)`. Don't use Supabase's nested `.select('relation(...)')` syntax for dimensions.
- **Smoke gate is non-negotiable** (CLAUDE.md "Smoke gate"). `pnpm smoke:work-orders` must pass against the live remote API + DB before you claim WO/case-surface work shipped. Extend the script with new probes when you add new endpoints / mutations.
- **Desktop ≠ mobile** (`feedback_desktop_separate_from_mobile`). Don't add `sm:`/`md:`/`lg:` responsive overrides on `/desk/*`. Mobile users live in the portal or the separate vendor-portal codebase.
- **Plandate is hidden from requesters** (`project_plandate_not_for_requester`). The planning endpoint must NOT leak `planned_start_at`/`planned_duration_minutes` to requesters or watchers via API.
- **Orchestrator pattern for big multi-step tasks** (`feedback_orchestrator_pattern_for_big_tasks`). Stay as orchestrator from turn one; delegate investigation, implementation, and verification to subagents. Main context holds only digest + decisions.

---

## 2. What's already in the codebase

Read these first to anchor:

- **Spec:** `docs/superpowers/specs/2026-04-30-plandate-planning-board-pm-design.md`. Has the shipped journal + the codex deferred-items rationale.
- **Migrations on remote:** `00374_work_orders_visibility.sql`, `00377_work_order_visibility_vendor_dormant.sql`, `00380_work_orders_planning_visibility.sql`. The operator-only predicate (`work_orders_visible_to_operator` + `work_orders_planning_visible_for_actor`) is in 00380 — the planning service uses it.
- **Backend:** `apps/api/src/modules/work-orders/work-order-planning.service.ts` (read service), `work-order.controller.ts` (`GET /work-orders/planning`), `work-order-planning.spec.ts` (8 unit tests).
- **Shared policy:** `apps/api/src/modules/ticket/ticket-visibility.service.ts` exports `canPlanRow(row, ctx)` — single source of truth for the plandate gate. Single-row `assertCanPlan` + batch `evaluateCanPlan` both delegate to it.
- **Frontend:** `apps/web/src/pages/desk/planning/` (page + components + hooks). `apps/web/src/api/work-order-planning/` (query module). `apps/web/src/lib/scheduler-time.ts` (DST-correct math).
- **Smoke gate:** `apps/api/scripts/smoke-work-orders.mjs` — `runPlanningProbes` block.

---

## 3. Findings to address

Ordered P0 → P3. Ship in priority order. After each P-level finishes, run a full-review pass (skill: `full-review`) against the diff. After all P0–P1 are done, run a codex pass (see §5). Address codex findings. Then proceed to P2.

### P0 — Bugs, security, quality (must fix)

**P0-1. Optimistic-update rollback window in `commitDrop` + `commitResize`.**
- File: `apps/web/src/pages/desk/planning/index.tsx`.
- Issue: on a failed PATCH, the optimistic cache patch already mutated the planning response. The current path calls `invalidatePlanning()` after `toastError`, which triggers a refetch — so the user briefly sees the wrong value before the truth arrives. Pre-existing pattern in `commitDrop`; `commitResize` inherits it.
- Fix: snapshot the previous response before patching; on error path, restore the snapshot synchronously *before* the toast fires. Then call `invalidatePlanning` so a fresh refetch happens. Mirror the pattern from `useUpdateWorkOrder`'s `onMutate` + `onError` (in `apps/web/src/api/tickets/mutations.ts`).
- Definition of done: write a test that simulates a 500 response, asserts the cache reverts before the toast renders.

**P0-2. Concurrent pointer-gesture corruption in `usePlanningDrag`.**
- File: `apps/web/src/pages/desk/planning/hooks/use-planning-drag.ts`.
- Issue: `ctxRef` is a single ref. If a second `begin()` fires while the first gesture is active (two-finger touch, second mouse, programmatic re-entry), it overwrites the context — the first gesture's `onPointerMove` then reads the second gesture's context.
- Fix: either (a) reject the second `begin` when `ctxRef.current != null` AND `pointerId !== ctxRef.current.pointerId`, or (b) key `ctxRef` by `pointerId` (`Map<number, …>`). Option (a) is enough for v1 — operators use one pointer at a time.
- Definition of done: test that calls `begin` twice with different pointerIds; second call is a no-op while the first is active.

**P0-3. Smoke probe gap — no requester-only actor coverage.**
- File: `apps/api/scripts/smoke-work-orders.mjs` + seed.
- Issue: `00380` adds an operator-only predicate, but the smoke gate runs only as an admin (read_all) — so the predicate's exclusion behaviour is unverified end-to-end. Codex flagged this; I deferred because there's no requester-only user in the seed.
- Fix: add a seed migration that creates a deterministic requester-only user in the test tenant (no team membership, no role assignment, no read_all override). Then add a `runPlanningRequesterProbe` block that mints a JWT for that user and asserts `GET /work-orders/planning?from=…&to=…` returns `{planned: [], unscheduled: []}` regardless of how many WOs they're the requester on.
- Definition of done: smoke probe fails if the seed user is given a team membership; passes when they're requester-only. Comments cite the codex finding by commit hash.

**P0-4. Inline lane derivation is unverified for unassigned-only days.**
- File: `apps/web/src/pages/desk/planning/index.tsx` lines 203-228.
- Issue: I added "seed lanes from unscheduled blocks" per a prior codex finding, but there's no test. A regression that removes the loop would silently break the dispatcher's most common gesture.
- Fix: write a Vitest unit test for the page-level lane-derivation memo (extract it to a pure function first if needed). Cases: (a) only planned blocks → lanes match; (b) only unscheduled blocks → lanes match; (c) empty → no lanes; (d) duplicate lane keys from planned + unscheduled → deduped.
- Definition of done: 4 cases pass.

### P1 — High-value operator UX

**P1-1. Server-side lane derivation.**
- Files: `apps/api/src/modules/work-orders/work-order-planning.service.ts` (return `lanes: PlanningLaneId[]`), `packages/shared/src/types/work-order-planning.ts` (extend response shape), `apps/web/src/pages/desk/planning/index.tsx` (consume `data.lanes` instead of computing locally).
- Issue: lanes are FE-derived from returned blocks, so an idle assignee (no planned, no unscheduled, but in the team) has zero drop targets. Real dispatcher complaint waiting to happen.
- Fix: when `team_id` is filtered, return all members of that team as lanes (plus assigned vendors with grants for the filter location). When no team filter, return only lanes that have at least one block (current behaviour) to avoid 200-lane explosions on the all-teams view. Cap at 50 lanes; if exceeded, return the most-active 50 + a `truncated: true` flag.
- Definition of done: an empty assignee in a filtered team appears as a drop target; the all-teams view still scales.

**P1-2. Realtime / optimistic-locking on concurrent drag.**
- Files: backend `work-order.service.ts` (accept `If-Match` header or a `plan_version` field), `apps/web/src/pages/desk/planning/index.tsx` (pass the version; handle 409).
- Issue: two dispatchers drag the same WO → last write silently wins. Codex flagged this as a real concurrency hole.
- Decision needed before starting: `If-Match` (HTTP-native, but Supabase admin client doesn't ergonomically attach it) vs. `plan_version` column on `work_orders` (cleaner but a migration).
- Fix: column path. New migration `00XXX_work_orders_plan_version.sql` adds `plan_version int not null default 1`, increments on every `planned_*` update. Service rejects with 409 + `{ code: 'planning.version_conflict', current_version }` when the caller's `plan_version` doesn't match. FE catches 409, shows "Moved by someone else — reload or keep mine?" dialog with two CTAs.
- Definition of done: two browser sessions racing the same drag → one wins, the other sees the conflict dialog.

**P1-3. Pointer-only drag a11y.**
- File: `apps/web/src/pages/desk/planning/components/planning-block.tsx` (keyboard handlers).
- Issue: blocks are keyboard-openable (Enter → navigates to detail), but you can't move or resize a plan from the keyboard. Operators with motor impairments / power-users on keyboards have no way in.
- Fix: focus a block → arrow-keys nudge `planned_start_at` by `cellMinutes` (Left/Right) and by 30 min (Shift+Left/Right). Shift+Up/Down resizes duration by `cellMinutes`. Enter still navigates. Escape commits the pending change; commits debounce so an arrow burst is one PATCH.
- Definition of done: a Vitest + Testing Library spec that tabs to a block, fires ArrowRight, asserts the PATCH body has the new `planned_start_at`.

**P1-4. `metadata.source: 'board'|'detail'|'generator'` on `plan_changed` activity events.**
- Files: new SQL RPC `00XXX_update_entity_combined_v6.sql` (or whatever next version is), `apps/api/src/modules/work-orders/work-order.service.ts` (accept optional `_source` in DTO; pass through to RPC), `apps/web/src/pages/desk/planning/index.tsx` (pass `_source: 'board'` on every plan-touching PATCH), `apps/web/src/components/desk/plan-field.tsx` (pass `_source: 'detail'`).
- Issue: the audit log can't differentiate where a plan change came from. Will bite hard once Slice C's PM generator starts emitting `plan_changed` rows that look identical to operator edits.
- Fix: new RPC version. The v5 RPC at `00335_update_entity_combined_v5.sql` is the model — copy it, add `p_activity_source text default null`, stamp it into `metadata.source` of the inserted `system_event` row when present.
- Definition of done: drag a block on the board → query `ticket_activities.metadata->>'source'` → `'board'`. Edit from detail → `'detail'`.
- **Coordinate with Slice C** (PM generator). Same RPC change unblocks the generator's `'generator'` source value.

### P2 — Spec scope expansion (deferred MVP items)

These are explicit MVP cuts from the plan-gate review. Codex flagged them as "not done against design" — defensible to defer, but real value to ship.

**P2-1. Week view.** Day + Week toggle in the toolbar; reuse `expandDates(anchor, 'week')` from `scheduler-time`. Operator press: 1-click capacity scan.
**P2-2. Location filter.** Add to `TicketListFilters` shape + planning endpoint query params. UI: pill alongside team filter.
**P2-3. Request-type / origin colour.** Block edge or chip coloured by `request_type.domain` (today colour comes from status). Useful when a lane has mixed work.
**P2-4. Manager mode (team-axis).** Per-team lanes with items coloured by assignee. Toggle in toolbar. Recommend a separate page route (`/desk/planning/by-team`) to keep state simple.
**P2-5. URL-state-shareable filters.** Mirror `useSchedulerWindow`'s URL pattern. Trivial copy-paste once the filter set stabilises.
**P2-6. Capacity heatmap overlay.** Lane background tinted by load (% of business hours filled).

### P3 — Long-term architecture

**P3-1. Extract `<ResourceLaneGrid>` primitives.** Two grid implementations now (room scheduler + planning board). Extract `<TimeAxis>` + `<NowLine>` + `<LaneBufferShading>` + the cell→ISO math into `apps/web/src/components/scheduler-primitives/`. Refactor both consumers. Tech-debt note already in the planning spec.
**P3-2. Codex-RPC for batched can_plan.** Currently `canPlanRow` is in TS; the SQL function `work_orders_visible_to_operator` doesn't expose can-plan per row. If the visible set grows past ~1000 rows, the TS evaluation becomes meaningful overhead. Add a SQL function `work_orders_can_plan_for_actor(user_id, tenant_id)` that returns the subset where can_plan = true.
**P3-3. Realtime push subscription.** Supabase Realtime channel on `work_orders` filtered by tenant + visible-id-set. Replace invalidate-on-focus with `qc.setQueryData` on each push.

---

## 4. Working pattern

For each finding:

1. **Read the spec + the file(s)** named in the finding. Don't trust the finding's line numbers blindly — verify.
2. **Write a focused commit** with a HEREDOC commit message that explains *why* the change is correct, not just what changed.
3. **Smoke gate after every backend chunk.** Restart the dev API after a rebuild. Migration push → rebuild → restart → smoke.
4. **Update the spec's "shipped journal"** when a P0 or P1 lands.
5. **Run `full-review` skill** at the end of each P-level (P0 done → full-review; P1 done → full-review).
6. **Run codex** (see §5) after all P0 + P1 land. Address findings. Stop before P2 unless the user has greenlit it.

Per-P-level test discipline:

- API: `cd apps/api && pnpm tsc --noEmit && pnpm test`. Must stay green.
- Web: `cd apps/web && pnpm tsc --noEmit && pnpm test --run`. Must stay green.
- Smoke: `pnpm smoke:work-orders`. Must pass with new probes.

If a finding turns out to be wrong, **push back in the commit message + this doc.** Brutal honesty includes saying "no, this is wrong because X" and leaving the finding open.

---

## 5. Codex prompt template

Copy this into a file and pipe via stdin (`--full-auto` is deprecated; use `--sandbox workspace-write`). Keep it under 2KB; the previous codex got hung on a 5KB prompt.

```text
Hi codex. Architecture-level review of the planning-board cleanup pass.
Not a line-by-line code review — I want you to tell me:

(1) Is this slice DONE per the priorities in
    ai/handoff-planning-board-cleanup.md §3?
(2) What did the cleanup miss? Cite file:line.
(3) What's the next investment, ranked?

Read the handoff at ai/handoff-planning-board-cleanup.md first.
Then walk the commits since 5a689110 (the prior codex remediation):

    git log --oneline 5a689110..HEAD -- apps/api/src/modules/work-orders \
        apps/api/src/modules/ticket/ticket-visibility.service.ts \
        apps/web/src/pages/desk/planning \
        apps/web/src/api/work-order-planning \
        supabase/migrations \
        apps/api/scripts/smoke-work-orders.mjs

Pressure-test:
1. Operator-only predicate (00380) — any other surface that should
   use it instead of work_orders_visible_for_actor?
2. The `canPlanRow` extraction — is it the right home? Should it
   live in the policy package instead of inside the visibility
   service?
3. Optimistic-rollback fix (commitDrop / commitResize) — does it
   handle filter-changed-mid-drag, cache-key-shifted, query-paused?
4. Concurrent-pointer rejection — sufficient or should it queue?
5. New smoke probes — do they actually exercise the predicate's
   exclusion, or are they vacuous?
6. plan_version / If-Match — clean shape, or future regret?
7. metadata.source RPC change — backward compatible with existing
   v5 callers? Migration ordering vs Slice C generator?
8. Anything in P2 / P3 you'd reorder.

Cap response 800 words. Categorize: critical / important / nit.
End with verdict: "done — proceed to Slice C" /
"hold — fix X before Slice C" / specific recommended next move.
```

Invocation:

```bash
cat > /tmp/codex-handoff-review.txt <<'EOF'
...prompt above...
EOF
codex exec --sandbox workspace-write --skip-git-repo-check - < /tmp/codex-handoff-review.txt
```

---

## 6. When to stop

This handoff covers P0–P3. **Default scope is P0 + P1.** P2 is "do if the user explicitly asks". P3 is for a separate slice (worth a fresh design doc and its own codex review).

Stop conditions:

- All P0 done, full-review clean, codex returns "done — proceed to Slice C" → handoff complete, ping the user.
- All P0 + P1 done, codex returns specific blockers → fix those, re-run codex, then stop.
- A P0 turns out to need a design change (e.g., P0-2 reveals the drag model is wrong) → stop, write a follow-up spec, surface to user. Don't keep shipping on a foundation that just shifted.

Don't:

- Quietly add P2 scope without the user saying so.
- Skip the smoke gate to ship faster — that's how the 2026-05-01 P0 landed.
- Trust a finding without verifying the cited file:line yourself. Codex and full-review reviewers can be wrong; treat their reports as evidence, not authority.

---

## 7. Open questions for the user (ask before P1-2 + P1-4)

- **P1-2 (concurrency):** confirm `plan_version` column vs `If-Match` header. Default: column.
- **P1-4 (audit source):** confirm the RPC bump (v5 → v6) is acceptable. Default: yes, but coordinate with Slice C to land in one migration.
- **P2:** any of P2-1..P2-6 the user wants in this pass? Default: none — let the operators surface real demand first.

These are the only three decisions you need from the user. Everything else is documented above and can ship autonomously.
