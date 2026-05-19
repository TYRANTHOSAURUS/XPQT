# Routed follow-up — concurrent-session direct-remote re-push of `set_entity_assignment` dropped the v3 work-order fail-loud guard

- **Status:** OPEN — routed, NOT absorbed (foreign cross-session mutation; outside the audit-02-finish PR #24 scope).
- **Discovered:** 2026-05-18, by the audit-02-finish continuation's mandatory post-merge "re-verify your merge survived the next concurrent merge" gate.
- **Owner:** `set_entity_assignment` / B.2 / the audit-02 **P1-2 / P0-2** deliverable owner (the workstream that owns `00406`/`00425` `set_entity_assignment` v3).
- **Severity:** audit-integrity / defensive-guard regression on a **shared remote RPC**. NOT a proven *live functional* regression (the affected path is unreachable by current producers — see §4). NOT P0/P1 by that reasoning, but a genuine cross-session integrity event on a prior audit-02 deliverable.
- **Sibling routed findings (same engagement):** [`i2-sla-install-idempotency-due_at-2026-05-18.md`](./i2-sla-install-idempotency-due_at-2026-05-18.md), [`i3-routing-eval-assignment-rpc-payload-drift-2026-05-18.md`](./i3-routing-eval-assignment-rpc-payload-drift-2026-05-18.md).

## 1. What was observed (proven by observation)

The audit-02-finish continuation's **Step 0 (c)** baseline, run at session start (2026-05-18, against the live shared remote DB `db.iwbqnyrvycqgnatratrk`), recorded — verbatim from that run:

```
set_entity_assignment.clear_routing_status|t
set_entity_assignment.routing_status_unsupported|t      ← present at session start
update_entity_combined.satisfaction_rating|t
update_entity_combined.satisfaction_unsupported|t
update_entity_combined.expected_plan_version|t
```

The **post-merge re-verification** (same query, same connection, later the same day, and again on 2026-05-19) returned:

```
set_entity_assignment.clear_routing_status|t
set_entity_assignment.routing_status_unsupported|f      ← GONE
update_entity_combined.satisfaction_rating|t
update_entity_combined.satisfaction_unsupported|t
update_entity_combined.expected_plan_version|t
```

`pg_get_functiondef('public.set_entity_assignment'::regproc)` on the live remote is a **single overload** `(uuid,text,uuid,uuid,text,jsonb)` whose body **no longer contains the token `routing_status_unsupported`**. The body IS still a valid `clear_routing_status`-v3 body (`v_clear_routing_status` declared and used; the `routing_status='idle'` / `routing_failure_reason=null` reset is gated on `clear_routing_status='true'` on the CASE arm; `entity_kind in ('case','work_order')` validation present). What it dropped is the **explicit work-order + `clear_routing_status` "fail-loud" raise** (the v3 D5 guard that the audit-02 P1-2 work shipped via `00406`/`00425`, which raised `set_entity_assignment.routing_status_unsupported_for_work_order` when `p_entity_kind='work_order'` was passed with `clear_routing_status` — because `work_orders` has no `routing_status`/`routing_failure_reason` columns). The live work-order arm now **silently no-ops the flag** instead of raising.

## 2. This is a concurrent-session direct-remote push — NOT PR #24, NOT a git clobber

- `git log --name-only 218f781d..e3302060 -- 'supabase/migrations/*set_entity_assignment*' '*00425*'` is **empty** — none of PR #24's 8 commits (`a47cdc48`, `21e52e4a`, `0d990ed0`, `aadb4718`, `9ac033fa`, `71ed3d4a`, `99fe3f89`, `ad18683a`) touch `set_entity_assignment` or `00425`. PR #24's migrations are `00428` (dispatch RPCs) + `00429` (routing_decisions index) only.
- `origin/main` never advanced past PR #24's merge commit `e3302060` during the window — so the change did **not** arrive via a git merge to `main`. It was a **direct `psql`-to-shared-remote push by another concurrent workstream** (the project's documented remote-mutation path, used by multiple concurrent sessions). This is the same *class* of hazard as the PR#20-mid-flight-clobber the audit-02-finish brief warned about, but on the live DB rather than the git tree, and on a prior-slice deliverable rather than this continuation's.
- All PR #24 deliverables were independently re-verified **intact** on the same live remote at the same time (dispatch RPCs route through `dispatch_idempotency_payload_hash`, the C1 `routing_rule` cross-tenant guard + sla_timers polymorphic cols preserved in the batch RPC, `uq_routing_decisions_outbox_event` unique index present, `update_entity_combined` v7 markers all `t`). The drift is **isolated to `set_entity_assignment`** and did not touch audit-02-finish's own work.

## 3. Why audit-02-finish did NOT absorb / "fix" this

Per the engagement brief's explicit rule ("re-verify… do NOT absorb a foreign breakage blindly"; route cross-session events, do not silently fold them): `set_entity_assignment` is owned by a different (P1-2/P0-2 / B.2) workstream that is **actively mutating it on the shared remote right now**. Folding a competing redefinition from this continuation's worktree would (a) be out of PR #24's scope, (b) risk a redefinition war with the concurrent session, and (c) risk masking that workstream's in-flight intent. The correct action is to **route with precise evidence to the owner**, which this document does.

## 4. Functional reachability (why no *proven* live regression)

The only producer that calls `set_entity_assignment` with `clear_routing_status` is `RoutingEvaluationHandler` (`apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts`), and it is **case-only by construction** — it always passes `p_entity_kind:'case'` (the only `routing.evaluation_required` producers are `reclassify_ticket` (00354) and `grant_ticket_approval` (00358), both `aggregate_type='ticket'`; there is no work_order producer — documented as a future gap in `docs/assignments-routing-fulfillment.md` §3.9.3). Therefore the dropped **work_order + `clear_routing_status`** raise is on a **path no current producer reaches**. The guard's removal is a loss of *defense-in-depth* (a future WO producer would now silently get a no-op'd flag instead of a loud failure), **not** a reproducible live functional defect today. This is why it is routed (not P0/P1) rather than hot-fixed.

## 5. Plausible (NOT proven) secondary effect

The audit-02-finish post-merge `pnpm smoke:tickets` runs showed the **pre-existing** probe `audit-02 routing-eval spurious assignment_changed activity` (the same-assignee-re-eval "no spurious activity" assertion in `a2ProbeRoutingEvalClear` — distinct from, and not modified by, the Code-I1 replay sub-assertion this engagement added) flaking **non-deterministically** (≈2 pass / 3 fail across 5 *isolated* runs, no client-network errors — a shared-DB *state*-contention signature, not the network-contention FLAKE_INFRA class). A *plausible* mechanism (stated as inference, not proven causation): the same concurrent session re-pushing/exercising `set_entity_assignment` is writing cross-session `assignment_changed` activity rows on overlapping fixed-id smoke fixtures on the shared remote, which that probe then false-detects. The audit-02-finish in-scope assertions (B.2 dispatch probe-8; Code-I1 routing-eval-replay) were **deterministically green** every run. No contention carve-out was added to that pre-existing probe (it is not an audit-02-finish-authored assertion; carving it would be scope creep and could mask a real regression in the concurrently-mutated `set_entity_assignment`/activity domain).

## 6. Recommended action for the owner

1. Determine the intended current `set_entity_assignment` definition (which concurrent workstream re-pushed it, and whether dropping the v3 D5 work_order fail-loud raise was deliberate).
2. If deliberate: update `00425` (or ship the superseding migration) so the **migration source matches the live remote** — the live↔source divergence is itself a latent `db:reset`/CI hazard (a fresh `supabase db reset` would re-create the *old* body with the raise, diverging from prod).
3. If NOT deliberate (an accidental re-push of an older body): restore the v3 D5 guard on the live remote and add a runnable guard (per the project's runnable-guards mandate) asserting the resolved `set_entity_assignment` body carries the work_order+`clear_routing_status` fail-loud raise — analogous to `dispatch.idempotency.spec.ts` for the dispatch RPCs.
4. Re-baseline the audit-02 P1-2 ledger's `set_entity_assignment` v3 marker expectation accordingly.

## 7. Reproduction (read-only)

```
PGPASSWORD=$SUPABASE_DB_PASS psql "postgresql://postgres@$PG_HOST:5432/postgres?sslmode=require" -tA -c \
 "select position('routing_status_unsupported' in pg_get_functiondef('public.set_entity_assignment'::regproc))>0;"
# session-start (2026-05-18 Step 0): t   |   post-merge + 2026-05-19: f
```
