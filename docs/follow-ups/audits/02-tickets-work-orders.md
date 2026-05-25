# Audit 02 — Tickets & Work Orders Architecture

**Scope:** ticket / work-order architecture: case-vs-WO split, routing/ownership/execution/visibility separation, atomic-write coverage, smoke-gate honesty.
**Date:** 2026-05-13.
**Method:** static code/read of `apps/api/src/modules/{ticket,work-orders,routing,sla,approval,workflow,outbox}/**`, recent migrations `0033x–0040x`, `docs/{assignments-routing-fulfillment,visibility,smoke-gates}.md`, `apps/api/scripts/smoke-{tickets,work-orders}.mjs`, `docs/follow-ups/b2-*`.
**Read-only.** No source edits, no DB writes.

---

## Executive verdict

**B+ on the happy paths, C− on the dark corners.** The B.2.A workstream successfully herded the *primary* mutation surface (`PATCH /tickets/:id`, `PATCH /work-orders/:id`, `POST /tickets/:id/dispatch`, `POST /tickets`, `respond` for ticket approvals) through atomic RPCs gated by `command_operations`, with client-request-id idempotency and audit/outbox emission folded in. The smoke-work-orders gate is strong on the surface it covers: every PATCH probe asserts a matching `command_operations.outcome='success'` row, plan-version concurrency is exercised end-to-end (00382), and there are non-vacuous requester negative-controls (00381).

But several second-class write paths still bypass the orchestrator outright, and they happen to be the ones with the worst blast radius if abused:

- **`PATCH /tickets/bulk/update`** — no `RequireClientRequestIdGuard`, no orchestrator RPC, no per-action permission gate (only visibility narrowing), no DTO validation, no audit row, no domain event. Raw `.from('tickets').update(dto)` with a 200-id cap. **P0.**
- **Both `reassign()` paths** — direct `.from(...).update(...)` + `routing_decisions.insert` + activity insert across three round-trips, no transaction, no idempotency, no `command_operations`. Acknowledged in `b2-followups.md:165-170` as "known second write path" and deferred to a Step-9-future cutover that hasn't happened. **P1** (well-documented, but a real partial-write hazard).
- **SLA escalation cron** (`sla.service.ts:796 applyEscalation`) writes `assigned_user_id` + `watchers` directly on tickets/work_orders via `updateTicketOrWorkOrder`, bypassing `set_entity_assignment` entirely. This is a cron-driven assignment change with zero `command_operations` row, no `routing_decisions` audit, no orchestrator-emitted activity. **P0** for audit/replay correctness.
- **Routing-evaluation outbox handler** (`routing-evaluation.handler.ts:282-289`) clears `tickets.routing_status` with a raw UPDATE after a successful `set_entity_assignment` call. The handler is hardcoded to `p_entity_kind: 'case'` (line 207) — work_orders can't be re-routed via this handler at all. **P1** for case-vs-WO parity.
- **Case-side `reassign()` rerun_resolver branch** does a raw `.from('tickets').update({assigned_team_id: null, assigned_user_id: null, assigned_vendor_id: null})` BEFORE the resolver runs (ticket.service.ts:1292-1296). A crash between clear-and-rerun leaves the ticket unassigned forever. **P1.**

The case-vs-WO split is **architecturally complete at the DB layer** (post-1c.10c — `tickets` is case-only, `work_orders` is its own table) but **leaky at the TS service layer**: `TicketService.getById` still falls back across both tables, `PATCH /tickets/:id` accepts either kind via the same controller, and `TicketVisibilityService.loadTicketRow` tries-tickets-then-work_orders. The split is a column rename, not a clean module boundary.

The smoke-work-orders gate is the strongest part of the system, but it has two material holes:
- It does not exercise `PATCH /tickets/bulk/update` at all (the entire bulk surface is untested live).
- It does not assert that `reassign` writes a `command_operations` row (because it doesn't — see P1 above).

---

## Findings

### P0 — Ship-stoppers

#### P0-1 — `PATCH /tickets/bulk/update` is the back door to every B.2.A guarantee

**Evidence:**
- `apps/api/src/modules/ticket/ticket.controller.ts:158-166` — `@Patch('bulk/update')` has **no** `@UseGuards(RequireClientRequestIdGuard)`. Every other mutation on this controller (create, single PATCH, reassign, dispatch) is guarded.
- `apps/api/src/modules/ticket/ticket.service.ts:1639-1644` — implementation:
  ```ts
  await this.supabase.admin
    .from('tickets')
    .update(dto as Record<string, unknown>)
    .in('id', ids)
    .eq('tenant_id', tenant.id)
    .select();
  ```
- Compared to `update()` at `ticket.service.ts:884-1144` which: tenant-validates watchers/assignees (969-989), enforces `tickets.change_priority` / `tickets.assign` permission gates (918-953), normalizes cost for float-round-trip stability (1051-1058), rejects `sla_id` mutation (1016-1020), gates close-while-children-open (1026-1039), threads through `update_entity_combined` with `command_operations` idempotency (1105-1116), and folds satisfaction patches.
- Bulk takes **none** of these. `dto` is cast to `Record<string, unknown>` and shoveled straight at PostgREST.

**Impact:**
- A bulk request can change `sla_id` on a case (single-path rejects this).
- A bulk request can change `priority` or assignment without the per-action permission check (single-path requires `tickets.change_priority` / `tickets.assign`).
- A bulk request can write `cost` as `0.30000000000000004` and re-write every row forever (single-path normalizes).
- A bulk request can change `status_category` to `closed` while children are open (single-path's parent-close guard at 1026-1039 doesn't fire — only the DB trigger `enforce_ticket_parent_close_invariant` would, but only if it fires for bulk-shaped updates; uncertain).
- No `command_operations` row → no idempotency, no replay safety. Two retries from a flaky network = two writes.
- No domain event, no activity row, no audit trail — the ticket changes shape and nothing on the timeline says so.

**Visibility doc admits this:** `docs/visibility.md:87` — "Bulk updates. `PATCH /tickets/bulk/update` doesn't call `assertVisible`. Rare and typically admin — follow-up." But the bulk path *does* call `assertVisible` per `ticket.service.ts:1620` — what it doesn't do is everything else. The doc undersells the gap.

**Recommendation:** route bulk through the same orchestrator. Either:
- Iterate ids and call `update_entity_combined` per row inside a server-side loop (with a deterministic per-id idempotency key derived from a single client-request-id + the id, so retries idempotent), OR
- Build a `bulk_update_entity_combined` RPC that takes `ids[]` + one `patches` payload and writes them in one tx.

If the second isn't on the roadmap, at minimum: add `@UseGuards(RequireClientRequestIdGuard)`, run the DTO through the same controller-layer type checks the single-PATCH does, run the per-action permission gates, and emit activity rows per id.

#### Update — 2026-05-16

Original finding:
- `P0-1 — PATCH /tickets/bulk/update is the back door to every B.2.A guarantee` (+ `P2-5 — bulkUpdate accepts any DTO; no _source or plan_version discrimination`)
- Location: `docs/follow-ups/audits/02-tickets-work-orders.md:34` (P0-1), `:217` (P2-5)

Status:
- closed (code; live smoke deferred to Slice 8 with rationale below)

Changed:
- `apps/api/src/modules/ticket/ticket.controller.ts` — `@UseGuards(RequireClientRequestIdGuard)` on `@Patch('bulk/update')`; `ids` validated as non-empty array of RFC-4122 UUID strings (`reference.invalid_uuid`); tags/watchers boundary narrowing mirrored from `@Patch(':id')`; `@Res({passthrough})` sets HTTP status per error-handling spec §3.1:88 (all-ok 200 · mixed 207 · all-failed 422).
- `apps/api/src/modules/ticket/ticket.service.ts` — `bulkUpdate` rewritten: de-dupe ids → loop the hardened single-path `update()` per id (inherits perm gates / tenant validation / `sla_id` immutability / parent-close guard / cost-norm / `update_entity_combined` idempotency+audit+domain-event / satisfaction fold); `results[]`/`okCount`/`errorCount`/`partialSuccess` contract; per-id error carries the neutral registered `code` only (no prose); effective crid folds a stable patch-payload fingerprint so a corrected resubmit reusing the batch crid does not `payload_mismatch`-brick already-succeeded ids.
- `docs/visibility.md:87` — corrected (was the mischaracterised "doesn't call assertVisible" line; now documents the closed state).
- No migration — `update_entity_combined` (00384) is already atomic; the audit's optional `bulk_update_entity_combined` batch RPC is the tracked deferral below.
- P2-5: dissolves — bulk DTO is `UpdateTicketDto` (no `plan_version`/`_source`); `update()`'s case path rejects `plan` and never threads `_source`.

Verified:
- `pnpm -C apps/api lint` (tsc --noEmit) -> pass
- `pnpm errors:check-app-errors` -> pass (0 raw throws across 35 migrated modules)
- `/full-review` (2 parallel adversarial subagents) -> run; 4 substantive findings folded in this commit (prose leak, ids amplification, retry-with-correction key, HTTP status semantics), 3 documented deferrals
- codex review -> pending in this slice
- Live smoke -> Not run. Reason: the dedicated bulk-update probe is a Slice-8 deliverable (no probe exists yet); the running :3001 server is shared with a concurrent audit-03 session (fixture-collision + code-provenance risk if run now); the *reused* single-path `update()` logic is unchanged by this slice and is covered by the existing committed `smoke:tickets`/`smoke:work-orders` gates.

Remaining:
- DEFERRED (integrator-verdict Week-1 follow-up): a true `bulk_update_entity_combined` batch RPC for cross-id atomicity (one tx, all-or-nothing). Current loop is per-id atomic + per-id idempotent; a mid-batch crash leaves each id individually consistent and replay-safe but the batch is not all-or-nothing. Acceptable interim per integrator verdict roadmap ("ship iterating-over-update_entity_combined first; batch RPC follow-up").
- DEFERRED (owned by error-handling workstream, spec §3.1): the FE bulk wire envelope (RFC-9457 `results[]` extension), 207 client handling, and the "Show me" expanding list are not yet built anywhere in the codebase. This slice ships the forward-compatible server side (status codes + `results[]` body); the FE rendering is that workstream's scope.
- Slice 8 will add the dedicated bulk-update smoke probe (P0-1 gate) + reassign / getChildTasks / vendor / dispatch-replay probes.
- Inherited behaviour (intended, not a bug): an all-noop dto returns per-id `ok` with no write/audit — correct idempotent no-op semantics of the canonical path; not divergently "fixed" here (would re-introduce a bulk-vs-single split).

---

#### P0-2 — SLA escalation cron bypasses `set_entity_assignment` entirely

**Evidence:**
- `apps/api/src/modules/sla/sla.service.ts:35-59` — `updateTicketOrWorkOrder` helper writes raw UPDATEs against `tickets` then `work_orders`.
- `apps/api/src/modules/sla/sla.service.ts:766-797 applyEscalation` — when an SLA threshold's `target_type='reassign_team'` or similar resolves a target person, builds an `updates` object with `assigned_user_id` (line 787), `assigned_team_id`/`vendor_id` (analogous in earlier branches), and `watchers` (line 794), then writes it via `updateTicketOrWorkOrder(ticket.id, updates, ticket.tenant_id)` (line 796).
- This is identical in spirit to what `set_entity_assignment` (00327 v2) exists to do — but it doesn't go through it.

**Impact:**
- No `command_operations` row → an at-risk cron tick that re-fires after a previous tick wrote 70% of the way through still re-applies (no idempotency).
- No `routing_decisions` audit row → SLA-driven reassignments are invisible in the routing audit feed. (`writeActivity` at line 824 emits an activity, but it's a system-event note, not a `routing_decisions` entry.)
- No domain event for the new assignee → downstream subscribers (notifications, MS Graph sync) don't see SLA-driven reassignment.
- Inconsistent with the `b2-followups.md:165-170` acknowledgement that even `reassign()` is a known gap — the cron escalation path has none of that scrutiny.

**Compounding fact:** the resolver-rerun branch of `WorkOrderService.reassign` is explicitly *unimplemented* (`work-order.service.ts:910-921`) — it throws `work_order.rerun_resolver_unsupported`. But the SLA escalation cron silently performs an equivalent operation on work_orders (via `updateTicketOrWorkOrder`'s WO branch) with none of the audit guarantees. The "this isn't ready" gate on the user-driven path is missing from the system-driven path.

**Recommendation:** route SLA escalation reassignments through `set_entity_assignment` with a deterministic idempotency key `sla:escalation:<crossing_id>` (each crossing is a single canonical event; the natural key is the crossing). The watchers update is metadata, not assignment — move it to `update_entity_combined`'s metadata branch with the same key.

#### Update — 2026-05-16

Original finding:
- `P0-2 — SLA escalation cron bypasses set_entity_assignment entirely`
- Location: `docs/follow-ups/audits/02-tickets-work-orders.md:97`

Status:
- closed (code; live SLA-escalation smoke deferred to Slice 8 with rationale)

Changed:
- `apps/api/src/modules/sla/sla.service.ts` — `applyReassignment` no longer raw-UPDATEs via `updateTicketOrWorkOrder`. Assignment → `set_entity_assignment` (00327 v2) with idem key `sla:escalation:<timer_id>:<at_percent>:<timer_type>` (the established `crossingKey` identity); `reason` non-null ⇒ RPC writes `routing_decisions` + `reassigned` activity + `ticket_assigned` domain event atomically. Watchers → `update_entity_combined` (00384 v6) metadata branch, key `…:watchers`. Entity-kind resolved once in `loadTicketForFire`. Outgoing assignee `users.id` translated to `persons.id` (fixes a latent legacy bug: the raw path wrote `users.id` into the `persons.id[]` `watchers` column). Duplicate `writeActivity` deleted. **Recurrence-safety reordering:** the crossing row is written immediately after the committed assignment and BEFORE all best-effort side-effects (notification, watcher copy); every await between the committed assignment and that anchor is non-throwing by construction (watcher RPC fully try/catch-wrapped for returned-error AND rejected-promise; `emitTelemetryBestEffort` non-throwing; no other await on the path).
- `docs/assignments-routing-fulfillment.md` — new "SLA escalation reassign" subsection + the anchor-first recurrence-safety contract (living-contract doc, edited in place).
- `docs/follow-ups/b2-followups.md` — P0-2 closure entry (was acknowledged nowhere — audit §346) + recurrence-safety note.
- No migration — `set_entity_assignment` (00327) + `update_entity_combined` (00384) already provide every guarantee.
- Commits: `ba1a4322` (route through RPC) → `d89a29b4` (/full-review C1 watcher-best-effort + I2 timer_type) → `0858d9b8` (codex BLOCK#1: notify best-effort) → `c4033863` (codex BLOCK#2: anchor-first + non-throwing telemetry helper) → `b93c5ed7` (codex BLOCK#3: wrap watcher RPC await — rejected-promise door).

Verified:
- `pnpm -C apps/api lint` (tsc --noEmit) -> pass; `pnpm errors:check-app-errors` -> pass (0 raw throws / 35 modules).
- `/full-review` (2 adversarial agents) -> C1 ship-blocker + I2 + nits, all folded.
- codex review -> 3 substantive rounds, each BLOCK on the same recurrence class via a progressively narrower door (notifier → in-catch telemetry → unwrapped watcher-await); each folded. codex re-verify #3 stated the class closes "once the pre-anchor watcher await is fully swallowed" — done in `b93c5ed7`.
- codex re-verify #4 -> Not run to completion. Reason: the codex process was resource-starved by a concurrent audit-03 session running codex simultaneously (0-byte output; terminated). Closure was instead **self-verified by line-by-line trace** of the exact, narrow property codex#3 prescribed: every `await` between assignment-commit and `writeCrossing` is non-throwing by construction; `writeCrossing` is the sole bounded retry window (rare, RPC replay-idempotent, 23505 swallowed) — codex#3 already deemed that acceptable.
- Live SLA-escalation smoke -> Not run. Reason: no probe exists (the existing `smoke:work-orders`/`smoke:tickets` gates do not exercise the SLA-escalation cron — audit §331 confirms zero live coverage of this path); building it is a Slice-8 deliverable. Shared :3001 runtime is contended by the concurrent audit-03 session.

Remaining:
- Slice 8: add an SLA-escalation smoke probe (seed a near-breach timer, advance the clock, assert the `set_entity_assignment` `command_operations` row + `routing_decisions` + the crossing anchor) — closes audit §331 #4 + the integrator smoke matrix item.
- Pre-existing data hazard (surfaced, not introduced): tenants whose `watchers` arrays already hold legacy-malformed `users.id`s will have the (now best-effort) watcher add skipped + telemetry-flagged on escalation; a one-off `watchers` cleanup migration is out of scope here and tracked as a non-P0 follow-up.
- `crossing.notification_id` is now always null (anchor precedes send) — deliberate soft-trace-linkage trade for the recurrence invariant; no broken consumer (codex-checked).

---

### P1 — Ship but plan a fix

#### P1-1 — Both `reassign()` paths still bypass orchestrator (acknowledged)

**Evidence:**
- `apps/api/src/modules/ticket/ticket.service.ts:1290-1295` — rerun-resolver branch raw-clears all three assignment columns *before* running the resolver, then writes again at 1375 with the resolver's choice. Three writes, no transaction, no `command_operations`.
- `apps/api/src/modules/ticket/ticket.service.ts:1375` — `await this.supabase.admin.from('tickets').update(updates).eq('id', id).eq('tenant_id', tenant.id);` — raw UPDATE.
- `apps/api/src/modules/ticket/ticket.service.ts:1382-1394` — separate `routing_decisions.insert`.
- `apps/api/src/modules/ticket/ticket.service.ts:1399-1411` — separate `addActivity` call.
- `apps/api/src/modules/work-orders/work-order.service.ts:978-983` — WO side mirror: raw UPDATE.
- `apps/api/src/modules/work-orders/work-order.service.ts:1000-1019` — separate `routing_decisions.insert` (wrapped in try/catch that logs and continues — line 1020-1022 — so an audit failure is silently swallowed).
- `apps/api/src/modules/work-orders/work-order.service.ts:1027-1050` — separate activity insert, same try/catch swallow.
- Acknowledged in `docs/follow-ups/b2-followups.md:165-170` as deferred to Step-9-future.

**Impact:**
- Partial-write hazard between the three writes: a crash between assignment-UPDATE and routing_decisions-INSERT leaves the ticket reassigned with no audit row. Crash between routing_decisions-INSERT and activity-INSERT leaves the audit but no human-visible timeline entry.
- The WO side compounds it by **swallowing** the routing_decisions/activity errors — the assignment commits even when its breadcrumbs fail (line 1020-1022, 1048-1050). The case side at least throws (no try/catch on those inserts).
- Two retries from a flaky frontend = two routing_decisions rows, two activity rows.
- The rerun_resolver case-side branch (1290-1296) is worse: it nulls the assignment as step 1 of 3. A crash after step 1 leaves the ticket unassigned forever, no resolver decision recorded.

**Why P1 not P0:** documented gap, code-review acknowledged, low-traffic path (manual reassign with an explicit reason — not the common case). Still real.

**Recommendation:** the `set_entity_assignment` RPC (00327 v2) already supports the assignment write atomically; what's missing is the `routing_decisions.insert` + activity insert living *inside* it. Either:
- Extend `set_entity_assignment` to accept an optional `reason` + `actor_person_id` and emit the routing_decisions row inline (clean), OR
- Make a sibling `reassign_entity` RPC that wraps `set_entity_assignment` + the audit inserts in one tx (less invasive).

For the case-side rerun_resolver branch, do the resolver eval first, then send one PATCH with the result — never clear-then-write.

#### Update — 2026-05-16

Original finding:
- `P1-1 — Both reassign() paths still bypass orchestrator (acknowledged)` (+ `P1-4 — Permission/visibility asymmetry between case- and WO-reassign`, `P2-2 — routing_decisions inserts inconsistent on entity_kind`, `P2-4 — work-order.service.ts:1059 returns forbidden on a missing refetch row`)
- Location: `docs/follow-ups/audits/02-tickets-work-orders.md:146` (P1-1), `:145` (P1-4), `:193` (P2-2), `:213` (P2-4)

Status:
- closed (code; live reassign smoke deferred to Slice 8 with rationale)

Changed:
- `apps/api/src/modules/ticket/ticket.service.ts` + `apps/api/src/modules/work-orders/work-order.service.ts` — both `reassign()` paths cut from 3 non-atomic raw writes (assignment UPDATE + `routing_decisions` insert + activity insert; WO side swallowed audit errors in try/catch) to ONE atomic `set_entity_assignment` (00327 v2) call: assignment + status_category inheritance + `routing_decisions` (`entity_kind`/`case_id`|`work_order_id` set explicitly INSIDE the RPC — closes P2-2 for the reassign sites) + `reassigned` activity + `ticket_assigned` domain event + `command_operations` idempotency, one tx. **No migration** — the audit's "extend the RPC / sibling RPC" recommendation was a stale read of 00326; v2 (00327) already does it all via `p_payload`.
- **P1-1 rerun_resolver:** removed the dangerous pre-clear raw UPDATE (assigned_*=null before the resolver ran → crash left the case unassigned forever). Resolver-FIRST: `evaluate` (read-only) → derive target → `validateAssigneesInTenant` → `set_entity_assignment` (apply, atomic, **no `reason`** so no duplicate `manual` routing_decisions row) → **on RPC success** `RoutingService.recordDecision` (the SINGLE rich routing_decisions row: real strategy/chosen_by/trace/rule_id; human `reason`+`actor` threaded into `context` under the SAME keys the RPC manual path uses) → one internal activity carrying the reason. Design forks adjudicated by independent codex design-check: FORK-1 = option (a), FORK-2 = `assertCanPlan` floor.
- **P1-4:** case-side entry gate tightened `assertVisible(id,ctx,'write')` → `assertCanPlan(id,ctx)` to match WO-side (the reference; not weakened). `tickets.assign` perm check kept after the floor. `SYSTEM_ACTOR` still bypasses (cron/workflow unaffected — ticket.service.ts:1266 gate).
- **P2-4:** WO null post-RPC refetch → `notFound` (registered code `work_order.not_found`, error-codes.ts:830), not `forbidden`; mirrors case-side F-IMP-1.
- `packages/shared/src/idempotency.ts` — new `buildReassignIdempotencyKey(kind,id,crid)` → `reassign:<kind>:<id>:<crid>`; `clientRequestId` un-underscored + threaded from both controllers.
- Living-contract docs (edited in place): `docs/assignments-routing-fulfillment.md` (atomic reassign + resolver-first rerun flow + P1-4 decision); `docs/visibility.md` (reassign requires the planning floor on BOTH sides — full blast radius stated: excludes requester/watcher AND `tickets.assign`-holders acting outside their planning scope, since the floor is checked before the permission); `docs/follow-ups/b2-followups.md` (deferred Step-9 reassign cutover marked done).
- 3 reassign spec files realigned to the RPC-arg contract (independently confirmed: one strengthened, none weakened) + a new rerun happy-path test proving the headline P1-1 contract (RPC called WITHOUT reason, recordDecision AFTER the RPC with `{reason,actor}`, no direct routing_decisions insert).
- Commits: `380098e0` (cutover) → `ad34d44f` (/full-review fold: recordDecision-after-RPC reorder fixing the orphan-decision-on-RPC-rejection defect; uniform `context.{reason,actor}` keys; extraContext spread reversed so resolver keys are un-clobberable; +1 contract spec; visibility.md blast-radius).

Verified:
- `pnpm -C apps/api lint` (tsc --noEmit) -> pass; `pnpm errors:check-app-errors` -> pass (0 raw throws / 35 modules).
- `pnpm -C apps/api test -- ticket-reassign-rerun-resolver ticket-permissions work-order-reassign` -> **22/22 pass**.
- `/full-review` (2 parallel adversarial agents) -> ran reliably. Plan-C1 ("null-resolver state/audit divergence") VERIFIED FALSE by direct payload-code inspection (rerunPayload always sets all 3 assigned_* keys explicit-null → RPC correctly clears a stale assignee). Plan-C2 (recordDecision-before-RPC orphan-row defect) folded. NITs (uniform keys, spread order, doc blast-radius, thin rerun spec) folded. The code-review agent independently ran gates+specs and confirmed registered-code / no-weakened-specs / SYSTEM-bypass / dead-code-free.
- codex (tertiary gate) -> **NOT obtained**. Three attempts (1 background + re-spawn + foreground) all hung at 0-byte output under resource contention with a concurrently-running audit-03 codex session (same failure mode as Slice 2's final pass, where self-verification was the accepted fallback). Closure rests on the reliable `/full-review` two-agent adversarial pass + targeted self-verification + green gates/specs, not on chat assertion.
- Live reassign smoke -> Not run. No reassign happy-path probe exists in `smoke:tickets`/`smoke:work-orders` (audit §smoke #2/#3); building it is a Slice-8 deliverable. Shared :3001 runtime contended by the concurrent audit-03 session.

Remaining:
- Slice 8: reassign happy-path `command_operations` smoke probe (case + WO) — audit §smoke gaps #2/#3.
- Accepted residual (documented in code + this ledger, non-P0): a *changing* rerun_resolver writes both the RPC's `assignment_changed` system stub AND the internal reason activity (suppressing the RPC activity needs an RPC migration — out of slice scope; the pair reads as "assignment changed + operator rationale", strictly more info than the old single card). Same-target rerun no-ops the RPC (no `ticket_assigned` event) — matches pre-cutover behaviour.
- Accepted residual (non-P0): the narrow window where the RPC commits but `recordDecision` then fails and the client retries → a 2nd routing_decisions row (RPC replays idempotently; recordDecision idempotency-keying is a shared-RoutingService concern, separate scope).
- P2-2 residual: `routing.service.ts recordDecision` + the routing-evaluation outbox handler still rely on the 00232 derive trigger for `entity_kind` — bounded to Slice 4 (the handler slice).

---

#### P1-2 — Routing-evaluation handler clears `routing_status` with a raw UPDATE; hardcoded to `case`

**Evidence:**
- `apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts:206-208` — RPC call hardcodes `p_entity_kind: 'case'`.
- `routing-evaluation.handler.ts:282-294` — after the (atomic) `set_entity_assignment` succeeds, the handler does a follow-up `await this.supabase.admin.from('tickets').update({routing_status: 'idle', routing_failure_reason: null})` to clear status. This is a second write outside the orchestrator's atomic boundary.
- A crash between the RPC commit and this UPDATE leaves the ticket with the new assignment but `routing_status` stuck at `'pending'` — exactly the failure mode the codex-S11-I1 comment at line 279 warns against, with the warning then proceeding to introduce that same failure mode.

**Impact:**
- Work_orders can't be re-routed via this handler — the `case` hardcode means any `routing.evaluation_required` event with a work_order id is silently mishandled (or routed via the case path and fails on entity-kind validation, depending on the RPC).
- The clear-`routing_status` write is not idempotent, not audited, and not in the same tx as the assignment.
- The `routing_decisions.insert` at line 246-264 doesn't set `entity_kind` either — relies on the 00230 polymorphic-derive trigger.

**Recommendation:** fold `routing_status` clear into `set_entity_assignment`'s payload (it's a column on the same row; same tx). For work_orders parity, either branch on the event's entity kind and use the right RPC, or document that this handler is case-only and emit a separate `work_order.routing.evaluation_required` event.

#### Update — 2026-05-16

Original finding:
- `P1-2 — Routing-evaluation handler clears routing_status with a raw UPDATE; hardcoded to case`
- Location: `docs/follow-ups/audits/02-tickets-work-orders.md:206`

Status:
- closed (code + remote migration verified; live smoke → Slice 8)

Changed:
- `supabase/migrations/00406_set_entity_assignment_v3_clear_routing_status.sql` (NEW) — `CREATE OR REPLACE set_entity_assignment` v3, supersedes 00327 v2. Adds an **opt-in** `p_payload.clear_routing_status` boolean (default false → `coalesce(...,false)` → byte-identical to v2 for all 4 existing callers, none of which pass it). When true on a case: the same §10 row UPDATE also sets `routing_status='idle'`/`routing_failure_reason=null`; the §9 no-op fast path is skipped (`and not v_clear_routing_status`) so a re-evaluation that re-picks the SAME assignee still clears routing_status (the exact P1-2 bug, relocated). `work_order`+flag → raises `set_entity_assignment.routing_status_unsupported_for_work_order` (work_orders has no such columns — 00320 adds them to `tickets` only). §14 activity + §15 domain_event gated on substantive change (assignee axis moved OR reason present) so the pure-status-clear path emits no blank activity / no-op `ticket_assigned` event (review Code-I2).
- `apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts` — removed the non-atomic post-RPC raw `tickets.update({routing_status:'idle'...})`; the handler now ALWAYS calls `set_entity_assignment` with `clear_routing_status:true` (assignee keys included only when the resolved target differs from current; omitted = key-absent = "keep" otherwise) so the clear is atomic on every non-failure path, not just the apply path; `routing_decisions` inserts (success + `markRoutingFailure`) now set `entity_kind:'case'`/`case_id` explicitly (P2-2 tail closed at this site). Case-only contract made legible: documented that the `from('tickets').eq('id',ticket_id)` membership lookup IS the runnable case-only guard — a WO id (no producer today; future gap) misses it and returns cleanly BEFORE the RPC/markRoutingFailure, so the reviewed data-corruption concern (case_id=<wo_id>) is unreachable.
- `docs/assignments-routing-fulfillment.md` (living-contract, in place) — routing-evaluation handler clear folded into v3; case-only by construction; explicit entity_kind on the handler's routing_decisions.
- Spec `routing-evaluation.handler.spec.ts` realigned + strengthened (asserts `ticketUpdates.toHaveLength(0)`, `clear_routing_status:true`, explicit `entity_kind`/`case_id`).
- Commits: `81343650` (cutover + v3 migration) → `b163ee5d` (/full-review fold: Code-I2 gate spurious activity/event; document the case-only guard).

Verified:
- `pnpm -C apps/api lint` (tsc --noEmit) -> pass; `pnpm errors:check-app-errors` -> pass (0 raw throws / 35 modules); `pnpm -C apps/api test -- routing-evaluation.handler` -> **10/10 pass**.
- `/full-review` (2 adversarial agents) -> ran reliably. Code-I2 (new blank-activity/no-op-event write-amplification from the D3 no-op-skip) folded. Plan-I2 (claimed WO-id data corruption via markRoutingFailure) **verified FALSE** by reading the code — the tickets-membership lookup gates a WO id out cleanly first. Code-I1 (handler's own routing_decisions insert non-idempotent under outbox replay) is **pre-existing, not a P1-2 regression** — the P1-2 concern (routing_status non-atomic clear) is fixed; the replay-duplicate routing_decisions is a pre-existing handler property, scoped out (the "atomic" claim applies to the RPC's writes, not the handler's audit insert).
- **DB push: 00406 applied to remote** via psql fallback (standing auth; announced). Remote function body verified v3 by direct inspection: `pg_get_functiondef` contains `v_clear_routing_status` + `and not v_clear_routing_status` + `routing_status_unsupported_for_work_order` (query returned `t|t|t`). `notify pgrst` ran. Plan-C1 cross-session safety: confirmed `00406` is the sole next slot (no on-disk collision) and the ONLY `set_entity_assignment` redefinition anywhere is this one (concurrent audit-03 session touches booking RPCs, not `set_entity_assignment`).
- codex (tertiary gate) -> not obtained (hung/unavailable under concurrent-session resource contention, as for Slices 2-3). Gate = reliable `/full-review` 2-agent pass + per-caller backward-compat analysis + green tsc/errors/spec + verified remote function body.
- Live routing-evaluation smoke -> Not run. No probe exists for this handler; building it is a Slice-8 deliverable. v3 backward-compat for the 4 callers established by code+review (flag absent → identical to v2) + verified remote body; shared :3001 runtime contended by the concurrent audit-03 session.

Remaining:
- Plan-C1 residual (tracked, cross-session): v3 is a `CREATE OR REPLACE` on `set_entity_assignment`; if a future audit-03 (or other session) migration also redefines it and applies after this on the shared remote, last-writer-wins silently. Mitigation in place: this ledger + the `pg_get_functiondef` verification query are the clobber-detection mechanism; re-verify the `t|t|t` invariant if any later `set_entity_assignment` migration ships.
- Code-I1 residual (pre-existing, non-P0): the handler's own `routing_decisions` insert (and `markRoutingFailure`'s writes) remain non-idempotent under outbox redelivery — a replay can write a duplicate decision row. Not introduced by P1-2; an idempotency guard on the handler's audit insert is separate scope.
- Live routing-evaluation smoke probe = Slice 8.

---

#### P1-3 — Satisfaction rating writes outside orchestrator (acknowledged)

**Evidence:**
- `apps/api/src/modules/ticket/ticket.service.ts:1127-1144` — after the orchestrator commits, a side `from('tickets').update({satisfaction_rating, satisfaction_comment})` runs separately. No audit row, no idempotency.
- Acknowledged in `b2-followups.md:63-73` as "not P0 because satisfaction submissions are infrequent + non-critical for SLA correctness."

**Impact:** orchestrator can fail and the satisfaction patch can succeed (or vice versa). Two-write divergence between idempotency cache and reality. Low traffic, but it's an open inconsistency in the API surface contract: same endpoint, mixed atomicity.

**Recommendation:** fold both fields into the metadata branch of the orchestrator. The b2-followups note already prescribes this — execute it.

#### Update — 2026-05-16

Original finding:
- `P1-3 — Satisfaction rating writes outside orchestrator (acknowledged)`
- Location: `docs/follow-ups/audits/02-tickets-work-orders.md:250`

Status:
- closed (code + remote migration verified; live smoke → Slice 8)

Changed:
- `supabase/migrations/00410_update_entity_combined_v7_satisfaction.sql` (NEW; renumbered from 00407 — cross-session collision, see Notes) — `CREATE OR REPLACE update_entity_combined` v7, supersedes 00384 v6. Metadata branch additionally accepts `metadata.satisfaction_rating`/`satisfaction_comment` with the same key-presence semantics as cost/tags/watchers (absent → untouched; present-null → explicit clear), folded into the SAME metadata-branch row UPDATE + the SAME `metadata_changed` activity. **Case-only** (review Plan-2): `p_entity_kind='work_order'` + a satisfaction key raises `update_entity_combined.satisfaction_unsupported_for_work_order` (mirrors 00406 D5) — does NOT widen the writable surface beyond the case-only side-write it replaced. Keys absent → byte-identical to v6 (all 5 callers unaffected — verified per-caller). v6 plan_version lock intact.
- `apps/api/src/modules/ticket/ticket.service.ts` `update()` — the non-atomic post-RPC `from('tickets').update({satisfaction_rating,satisfaction_comment})` side-write removed; satisfaction folded into the `p_patches.metadata` builder with key-presence semantics. Satisfaction now atomic + audited + idempotent with every other branch.
- `docs/follow-ups/b2-followups.md` — the acknowledged P1-3/I4 gap marked CLOSED; the misleading "future rating caller flows through this guarded route" reassurance corrected (review Plan-1): the shipped requester-rating design uses a dedicated `requester_ratings` table + public token endpoint, decoupled from `tickets.satisfaction_rating` (now effectively legacy) — the fold still correctly closes the non-atomic divergence for any direct `PATCH /tickets/:id` satisfaction write.
- Commits: `087e7ed9` (v7 + side-write removal) → `9f2c612f` (/full-review fold: case-only guard + doc accuracy) → `78f8ea8a` (renumber 00407→00410).

Verified:
- `pnpm -C apps/api lint` (tsc --noEmit) -> pass; `pnpm errors:check-app-errors` -> pass (0 raw throws / 35 modules); WO update specs 39/39, ticket update/metadata specs 23 pass + 1 pre-existing obsolete skip (no satisfaction-specific spec exists — transitive coverage; follow-up test noted).
- `/full-review` (2 adversarial agents) -> both SHIP on the code (semantic-diff-vs-v6 = satisfaction-only; 5-caller backward-compat verified; balanced `$$`; command_operations lifecycle complete on satisfaction-only path; no spec weakened). Plan-2 (WO surface-widening) + Plan-1 (misleading prose) folded.
- **DB push: 00410 applied to remote + verified** (`pg_get_functiondef` → `v_has_sat_rating_key`=t, `satisfaction_unsupported_for_work_order`=t, `p_expected_plan_version`=t [v6 lock intact]). `notify pgrst` ran. Collision safety: `git log --all` confirmed NO concurrent `update_entity_combined` redefinition (the triple-claimed 00407s are disjoint booking functions); number rebased 00407→00410 (true next-free across all sessions).
- codex (tertiary gate) -> not obtained (unavailable under concurrent-session resource contention, as for Slices 2-4). Gate = reliable `/full-review` 2-agent pass + per-caller backward-compat analysis + verified remote function body + green tsc/errors/specs.
- Live satisfaction smoke -> Not run. No satisfaction caller exists anywhere yet (FE or internal — grep-confirmed); no probe exists. v6 backward-compat for the 5 callers established by code+review + verified remote body. Probe = Slice 8 if/when a satisfaction caller ships.

Remaining:
- Cross-session migration-number collision (audit P2-3 class): 00407 is triple-claimed across this + booking + phase-1.5 sessions; this slice rebased its own to 00410. The broader renumber is P2-3 (separate finding) — coordination tracked there.
- Plan-C1-class residual: v7 is `CREATE OR REPLACE`; detection = this ledger + the `pg_get_functiondef` verify query if any later `update_entity_combined` migration ships.
- No dedicated satisfaction round-trip spec (transitive coverage today; the metadata branch is exercised by cost/tags specs). Follow-up test + live probe → Slice 8 / when a satisfaction caller exists.
- `tickets.satisfaction_rating` is legacy w.r.t. the shipped requester-rating product (separate `requester_ratings` table) — documented so a future engineer does not wire rating here.

---

#### P1-4 — Permission/visibility asymmetry between case- and WO-reassign

**Evidence:**
- Case side `reassign` (`ticket.service.ts:1243-1267`): uses `assertVisible(id, ctx, 'write')` (broad write floor) + `tickets.assign` permission check.
- WO side `reassign` (`work-order.service.ts:923 → assertAssignPermission` at `:1076-1099`): uses `assertCanPlan(workOrderId, ctx)` (narrower plandate floor — excludes requester, watcher, readonly cross-domain roles per `ticket-visibility.service.ts:282-294`) + `tickets.assign` permission check.

**Impact:** the same logical operation (reassign with reason) uses different visibility floors on the two sides. A user who can `write` (broad) a case can reassign it, but a user who can `write` a work_order via the watcher/requester paths still can't reassign it — they need plandate-level access. That's defensible as a product decision (plandate ⊂ write makes sense for execution), but it's not documented and the case-side doesn't apply the same logic. Either side could be the bug.

**Recommendation:** decide once which floor is correct, then align. If plandate is the right floor for the WO side, the case side should match (cases don't have a "plandate" but they have a `tickets.assign` gate — the floors are different abstractions). Document in `docs/visibility.md`.

---

#### P1-5 — `getChildTasks` inherits parent visibility, doesn't filter children

**Evidence:** `ticket.service.ts:1573-1593`:
```ts
await this.visibility.assertVisible(parentTicketId, ctx, 'read');
// If the actor can see the parent case, they can see its work_order
// children. (The visibility model treats children as inheriting parent
// visibility for read; tighter scoping is a future step 1c.9 concern.)
```

**Impact:** any user who can see a case can see *every* child work_order on it, regardless of the WO's own assignee / location / domain restrictions. If a case is in a public-ish domain but a child WO is dispatched to a sensitive vendor, the parent's requester sees the vendor's WO too.

**Recommendation:** documented as "future step 1c.9 concern" inline. Concretely: pass each child id through `work_order_visibility_ids` (00374) before returning. Cheap (single RPC call with the parent's child id list) and structurally correct. Until then, surface the leak in `docs/visibility.md` (currently silent).

#### Update — 2026-05-16

Original finding:
- `P1-5 — getChildTasks inherits parent visibility, doesn't filter children`
- Location: `docs/follow-ups/audits/02-tickets-work-orders.md:302`

Status:
- closed (code + spec; FE rollup follow-up deferred with rationale)

Changed:
- `apps/api/src/modules/ticket/ticket.service.ts` `getChildTasks` — parent-case `assertVisible(...,'read')` kept as a PRECONDITION; each child work_order now filtered through `work_order_visibility_ids` (00374) `.in('id', visibleWoIds)`. `tickets:read_all` + `SYSTEM_ACTOR` bypass the per-child filter; empty visible set → parent visible, zero children. TS-only, no migration (audit's prescribed cheap fix).
- `apps/api/src/modules/ticket/ticket-get-child-tasks.spec.ts` (NEW) — 5/5: non-priv → only WO-visible children; `read_all` bypass; empty → []; parent-not-visible → throws (not empty); SYSTEM unfiltered. Closes the "a revert of `.in(visibleWoIds)` is green" gap (review I1).
- `docs/visibility.md` — §7 closed-finding bullet documents the prior leak + the fix (doc was silent — audit doc-drift §7); the `tickets:read_all` WO-child bypass documented as a DELIBERATE admin override per the 00374 same-key model + the future `work_orders.read_all` lever (review I2); line 39 corrected (`getChildTasks` removed from the tickets-predicate set-read list — it reads `work_orders` via the WO predicate).
- Commits: `6b4af8cd` (fix + doc) → `85dc82d6` (/full-review fold: spec + read_all doc precision + comment reword).

Verified:
- `pnpm -C apps/api lint` (tsc --noEmit) -> pass; `pnpm errors:check-app-errors` -> pass; `pnpm -C apps/api test -- ticket-get-child-tasks` -> **5/5 pass**.
- `/full-review` (adversarial code agent) -> verdict: security-correct, fail-closed, **NO leak** — independently verified `.in('id',[])`→0 rows (postgrest-js `id=in.()`), null/unknown-user gated by the `assertVisible` throw *before* the RPC (+ migration `actor` CTE fail-closes), parent precondition preserved, SYSTEM path unchanged, only caller is `GET /tickets/:id/children` (no internal full-list dependency), `mapRpcErrorToAppError` consistent. I1+I2 folded; I3 deferred (below).
- codex (tertiary gate) -> not obtained (unavailable, concurrent-session contention). Gate = `/full-review` code agent + the new 5-case spec + green tsc/errors.
- Live cross-visibility smoke (requester-of-case-can't-see-vendor-child) -> Slice 8 (audit §smoke #7).

Remaining:
- **DEFERRED (review I3, tracked — FE, out of slice scope per brief "do not mix … frontend cleanup" with schema/RPC slices):** `apps/web/src/components/desk/ticket-meta-row.tsx` `SubIssueProgress` + `apps/web/src/components/desk/sub-issues-section.tsx` compute `done/total` + a ratio bar + section count directly from `GET /tickets/:id/children`. Now that the endpoint correctly returns fewer children for scoped-out actors, a non-privileged viewer sees a *misleading* progress badge (e.g. "1/1 done" while the parent is still open because 2 of 3 children are filtered out). This is the correct security tradeoff but an unflagged UX-correctness regression. Follow-up (FE workstream): either move the rollup server-side as a privileged count, or label/suppress the badge for non-privileged actors ("visible to you"). Risk: misleading-but-not-unsafe progress display for scoped requesters/watchers until addressed. Tracked here + recommended for the FE follow-up backlog.

---

### P2 — Cleanup / nice to have

#### P2-1 — Case-vs-WO split is a column rename, not a module split

`TicketService` is 1978 lines and still owns:
- A `getById` that falls back across `tickets` → `work_orders` (`ticket.service.ts:583-624`).
- A `getChildTasks` that reads from `work_orders` (1583-1588).
- A `createBookingOriginWorkOrder` at line 1872 that writes directly to `work_orders`.
- The activity surface (`addActivity`, `getActivities`, `uploadActivityAttachments`) for both kinds.

`TicketVisibilityService.loadTicketRow` (`ticket-visibility.service.ts:359-371`) does a try-tickets-then-work_orders dance — and the join syntax depends on per-table FK aliases that exist for tickets but not for work_orders (line 374-394 hand-rolls the join for WOs). One control flow, two implementations.

`PATCH /tickets/:id` accepts both kinds and dispatches to either `ticket.update` or — wait, no, it always calls `ticket.update`, which does a `getById(id, SYSTEM_ACTOR)` that may return either kind, then runs case-only validation. Calling `PATCH /tickets/:id` on a work_order id would currently land in the case-update branch and either misbehave or fail.

**Impact:** the WO surface lives in a separate module (`work-orders/`), but the *ticket* surface still owns half the WO concerns via fallback. Either:
- Hard-split: `TicketService` only sees tickets, `WorkOrderService` only sees work_orders, `getById` rejects WO ids (force the FE to use `/work-orders/:id`), OR
- Polymorphic: keep the unified `PATCH /tickets/:id` but route to the right service based on `getById`'s discriminator. Today's behavior is neither.

The b2-followups + the data-model-redesign-2026-04-30 doc both treat 1c.10c as "split complete." It's complete at the schema layer. It's not at the service layer.

#### Update — 2026-05-16

Original finding:
- `P2-1 — Case-vs-WO split is a column rename, not a module split`
- Location: `docs/follow-ups/audits/02-tickets-work-orders.md:344`

Status:
- **deferred (explicit, with rationale)** — not a completion-bar blocker

Rationale:
- P2-1 is a P2 ("Cleanup / nice to have"); the audit itself frames it as "Probably a multi-day refactor" (see Recommendations summary §8). The remediation completion bar is: no P0 raw-write bypass (✅ Slices 1–2), assignment-changing paths canonical/atomic-or-documented (✅ Slices 1–5), visibility-sensitive reads/writes covered by code (✅ Slice 6) + smoke (deferred-with-owner below), reference docs match implementation (✅ maintained per-slice). The service-layer hard/polymorphic split is **not** required by that bar.
- Doing a 1978-line multi-day `TicketService`→`TicketReadService`/`WorkOrderService` re-architecture now would put the six shipped, reviewed, remote-pushed slices (incl. 2 live RPC migrations) at regression risk for a pure-hygiene refactor with no P0/P1 content, while a concurrent audit-03 session is mutating the shared tree/runtime. Per the brief ("If a route remains intentionally interim, document the reason and risk") this is the correct call.
- Scope/shape of such a refactor is a direction-class decision that would normally go to codex (per `feedback_ask_codex_not_user_for_direction`); codex was unobtainable for the entire workstream (concurrent-session resource contention). Deferring rather than guessing a multi-day architecture unreviewed is the disciplined choice.

Changed:
- None (no code change — explicit deferral).

Verified:
- N/A (deferral). The leaky-split's *security-relevant* consequence (P1-5 `getChildTasks` child-visibility) was independently closed in Slice 6; the *atomicity* consequences (reassign/satisfaction/routing-status mixed surfaces) were closed in Slices 1–5. What remains in P2-1 is purely module-boundary hygiene (`getById` tickets→work_orders fallback; `loadTicketRow` try-both; `createBookingOriginWorkOrder` placement; `PATCH /tickets/:id` accepting WO ids) with no remaining P0/P1 behaviour.

Remaining:
- Follow-up (architectural-hygiene backlog, NOT this workstream): hard-split or polymorphic-route `TicketService` vs `WorkOrderService`; pull `getById`/`getChildTasks`/`createBookingOriginWorkOrder` out of `TicketService`; collapse `loadTicketRow`'s try-both. Risk while deferred: developer-ergonomics + a `PATCH /tickets/:id` on a WO id misbehaving (case-only validation on a WO row) — a correctness sharp-edge for an undocumented call shape, not an exploitable P0/P1. Recommend an explicit "WO id rejected on `PATCH /tickets/:id`, use `/work-orders/:id`" guard as the cheap interim if the full split stays deferred; flagged for the integrator/data-model owner (verdict Should-fix #16).

#### P2-2 — `routing_decisions` inserts inconsistent on `entity_kind`

Three call sites:
- `ticket.service.ts:1382-1394` (case reassign): sets `entity_kind: 'case'`, `case_id: id`, `ticket_id: id` (legacy soft pointer).
- `work-order.service.ts:1000-1019` (WO reassign): sets `entity_kind: 'work_order'`, `work_order_id: workOrderId`, `ticket_id: workOrderId` (legacy soft pointer reused for the WO id — confusing).
- `routing.service.ts:65-85` (`recordDecision`, called by create + reclassify paths): **doesn't set `entity_kind`** — relies on the 00230 polymorphic-derive trigger.
- `routing-evaluation.handler.ts:246-264` (outbox handler): also doesn't set `entity_kind`.

The C5 code-review convention is "set them explicitly on both sides" per `ticket.service.ts:1377-1381` comment, but `routing.service.ts` and the outbox handler both rely on the trigger. The deterministic-at-write-time convention isn't applied consistently.

**Recommendation:** pick one (probably "always explicit") and fix the two remaining sites. Or drop the trigger as a deprecation step.

#### Update — 2026-05-16

Original finding:
- `P2-2 — routing_decisions inserts inconsistent on entity_kind`
- Location: `docs/follow-ups/audits/02-tickets-work-orders.md:362`

Status:
- **partial — closed at the high-value sites; residual accepted with rationale**

Changed:
- `ticket.service.ts` + `work-order.service.ts` reassign sites (was: inconsistent TS inserts setting `entity_kind` ad-hoc): both now route through `set_entity_assignment` (Slice 3), which sets `entity_kind`/`case_id`/`work_order_id` **explicitly inside the RPC** (00327:260-271). The ad-hoc TS `routing_decisions` inserts at these sites are deleted entirely.
- `routing-evaluation.handler.ts` (was: insert without `entity_kind`, relied on the 00232 derive trigger): now sets `entity_kind:'case'` + `case_id` explicitly (Slice 4, both the success insert and `markRoutingFailure`).
- `routing.service.ts` `recordDecision` (used by create + reclassify + the Slice-3 rerun path): **unchanged — keeps the 00230/00232 derive-trigger path. Accepted, not a defect.** Decision (codex unobtainable → documented judgment): the 00232 trigger derives `entity_kind`/`case_id`/`work_order_id` from `ticket_id` existence (tickets vs work_orders) BEFORE INSERT — it is a correct, shipped, tested mechanism that *guarantees* the columns are set; it is a *different valid convention*, not a missing value. The audit's "pick one (probably always-explicit)" is a consistency-nicety, not a correctness gap. `recordDecision` is a shared RoutingService method on the create/reclassify hot paths; rewriting it to thread an explicit kind through every caller is out of this audit's clean scope and would touch create/reclassify (not audit-02 findings). The high-blast-radius sites (reassign, routing-eval handler) are now explicit; the append-only audit-row writer keeps the trigger.

Verified:
- Reassign sites: 22/22 reassign specs (Slice 3) + remote `set_entity_assignment` body verified (Slice 3/4 closures). Handler: 10/10 handler spec (Slice 4) asserts explicit `entity_kind`/`case_id`. `recordDecision` trigger path: unchanged, pre-existing 00232 trigger remains authoritative.

Remaining:
- Accepted convention split (non-P0/P1): explicit-at-write for reassign + routing-eval; trigger-derive for `recordDecision` (create/reclassify/rerun). If a future workstream wants full uniformity, the lever is either threading kind into `recordDecision`'s signature (touches create/reclassify) or deprecating the 00230/00232 trigger — both out of audit-02 scope. Documented so it is not re-discovered as a bug.

#### P2-3 — Duplicate migration prefixes in `00367-00400`

`ls supabase/migrations/ | tail -50` shows duplicate numeric prefixes for at least: `00367`, `00368`, `00369`, `00370`, `00371`, `00372`, `00373`, `00374`, `00376`, `00400`. Looks like two parallel branches merged without renumbering.

**Impact:** Supabase CLI orders by lexical filename. Two files with the same numeric prefix are ordered by alphabetical tail. As long as both apply cleanly that's fine, but readers can't reason about "what ran before what" without checking the alphabetic order. Future migrations writing `00401_*` then `0040_2` (typo) would land out of order without warning.

**Recommendation:** renumber on next migration batch; add a CI lint that catches duplicate prefixes.

#### Update — 2026-05-16

Original finding:
- `P2-3 — Duplicate migration prefixes in 00367-00400`
- Location: `docs/follow-ups/audits/02-tickets-work-orders.md:374`

Status:
- **deferred to the integrator / data-model owner (cross-audit) — with new evidence + in-scope mitigation applied**

Rationale:
- P2-3 is the same finding as integrator-verdict **Top-10 blocker #8 / Agent-1 P0-1** ("renumber 10 duplicate prefixes + add `scripts/check-migration-prefix-unique.sh` CI guard"). It is a repo-wide renumber sweep + a cross-cutting CI guard explicitly owned by the data-model/integrator workstream, not audit-02. Renumbering historical migrations or adding a global CI guard from inside the tickets/WO worktree would collide with the concurrent audit-03 + phase-1.5 sessions also mutating `supabase/migrations/`.

New evidence (this workstream observed it live):
- The collision is **not historical-only**. While shipping Slice 5 the migration number `00407` was found **triple-claimed across concurrent sessions**: `00407_update_entity_combined_v7_satisfaction` (this audit), `00407_booking_edit_idempotency_intent_hash` (audit-03/booking), `00407_grant_booking_approval_v3_outbox_emit_signature_fix` (phase-1.5). Confirmed via `git log --all` that these are **disjoint functions** (no concurrent `set_entity_assignment`/`update_entity_combined` redefinition), so no function-body clobber occurred — but it is concrete proof the duplicate-prefix problem is active in `00406+`, not just `00367–00400`.

In-scope mitigation already applied (no broad renumber):
- This workstream's own migrations were kept collision-free: `00406_set_entity_assignment_v3` (Slice 4, sole next-free slot at the time) and the Slice-5 migration **rebased `00407 → 00410`** (true next-free across all worktrees/branches: max = 00409) so the merge does not add a *fourth* `00407`. Per `feedback_migration_number_collision`: claim next-free at write time, auto-rebase, don't bake numbers into TS.

Changed:
- `supabase/migrations/00407_update_entity_combined_v7_satisfaction.sql` → `00410_…` (Slice-5 rebase, commit 78f8ea8a). No historical files renumbered (out of scope / cross-session-unsafe).

Verified:
- N/A (deferral). Mitigation verified: `00406` + `00410` are unique on disk + in `git log --all`; both pushed to remote + function bodies verified (Slice 4/5 closures).

Remaining:
- DEFERRED to integrator/data-model owner (verdict blocker #8): the historical `00367–00400` renumber + the `scripts/check-migration-prefix-unique.sh` CI guard. Risk while deferred: Supabase-CLI lexical apply-ordering is non-deterministic across duplicate prefixes; a future "after 00370"-style assumption breaks silently; cross-session number races recur (now demonstrated at 00407). The CI-guard is the highest-leverage cheap fix and is explicitly recommended to that owner. Audit-02's own migrations are collision-safe and do not worsen the count (rebased).

#### P2-4 — `work-order.service.ts:1059` returns `forbidden` on a missing refetch row

Acknowledged at the case-side line 504 as a fix (`F-IMP-1`: not forbidden, notFound), but the WO side still throws `forbidden('work_order.no_longer_accessible')` at line 1060 in the `reassign` flow. Same logic — committed under service_role + tenant match means `notFound` is the right shape. Inconsistent with the `update()` path on the same file.

#### P2-5 — `bulkUpdate` accepts any DTO; no `_source` or `plan_version` discrimination

If/when bulk goes through the orchestrator (P0-1 fix), the `plan_version` optimistic-lock and `_source` audit-provenance fields need to be threaded per-id or rejected at the bulk surface. The current cast-to-`Record<string,unknown>` admits them silently and they'd be written as raw columns on the row (or rejected by Postgres if not allowed).

---

### P3 — Notes / observations

- The 1978-line `ticket.service.ts` reads as the right candidate for the next split: pull `getById`, `getChildTasks`, `createBookingOriginWorkOrder` into a `TicketReadService` and let `WorkOrderService` own the WO surface end-to-end. Cross-cutting concerns (activities, inbox) into their own services.
- `addActivity` on `ticket.service.ts:1483-1523` writes activities directly with no idempotency. Comment thread + watcher mentions don't need orchestrator-grade idempotency, but a frontend retry from a flaky comment submission today creates two comment rows. Worth a thin `command_operations` key.
- `routing_decisions` inserts in `dispatch.service.ts` happen inside the RPC (good), but the outbox handler at `routing-evaluation.handler.ts:246` inserts them in TS — pre/post-tx-boundary inconsistency between dispatch and routing-evaluation paths.
- `b2-followups.md:75-80` says "create/dispatch/reassign/reclassify/portal-tickets/approvals stay underscored awaiting their §3.x cutovers" — dispatch + create + approvals shipped; reassign + reclassify + portal-tickets are the remaining unfinished cutovers. The audit confirms reassign is still the worst of the three.

---

## Section findings

### Case-vs-work-order split: complete?

**At the DB layer: yes.** Post-1c.10c, `tickets.ticket_kind` is gone (`ticket.service.ts:1014` comment); cases live in `tickets`, work_orders in `work_orders`. UUIDs are globally unique across both tables. Visibility predicates are paired (`ticket_visibility_ids` / `work_order_visibility_ids`, 00187 / 00374).

**At the API layer: messy.** `PATCH /tickets/:id` is the only single-PATCH route, and `TicketService.update` is case-only. There's no `GET /tickets/:id` → work_order path documented anywhere; in practice `getById` returns a `ticket_kind` discriminator (`ticket.service.ts:609-622`) so the FE knows what it got. The FE has to know to call `/work-orders/:id` for WO mutations even though `/tickets/:id` returns a WO row.

**At the service layer: leaky.** `TicketService` still touches `work_orders` directly in three places (`getById` fallback, `getChildTasks`, `createBookingOriginWorkOrder`). `TicketVisibilityService.loadTicketRow` does the same fallback. The split would be clean if `TicketService` rejected WO ids on `getById` and the FE was forced to use `WorkOrderService` end-to-end. Today's behavior is half-polymorphic.

### Atomic-write coverage matrix

| Mutation | Atomic RPC? | `command_operations`? | Idempotency-keyed? | Audit/activity? | Notes |
|---|---|---|---|---|---|
| `POST /tickets` | yes (`create_ticket_with_automation`) | yes | yes (key = (actor, crid)) | yes (RPC) | gold path |
| `PATCH /tickets/:id` (case) | yes (`update_entity_combined`) | yes | yes (key = (case, id, crid)) | yes (RPC) | gold path; satisfaction side-write (P1-3) |
| `PATCH /tickets/bulk/update` | **NO** — raw UPDATE | **NO** | **NO** | **NO** | **P0-1** |
| `POST /tickets/:id/reassign` (case) | yes (`set_entity_assignment` v3) | yes | yes (key = (case, id, crid)) | yes (RPC) | **P1-1 CLOSED (Slice C)** — evaluate-first then ONE write (no clear-then-rerun); rerun passes `decision` provenance, manual is reason-gated |
| `POST /tickets/:id/dispatch` | yes (`dispatch_child_work_order`) | yes | yes (key = (parent, crid)) | yes (RPC) | gold path |
| `PATCH /work-orders/:id` | yes (`update_entity_combined`) | yes | yes (key = (work_order, id, crid)) | yes (RPC) | gold path |
| `POST /work-orders/:id/reassign` | yes (`set_entity_assignment` v3) | yes | yes (key = (work_order, id, crid)) | yes (RPC) | **P1-1 CLOSED (Slice C)** — swallowed try/catch inserts removed; manual-only (rerun still unsupported); refetch-miss now `notFound` (P2-4) |
| `POST /approvals/:id/respond` (ticket) | yes (`grant_ticket_approval`) | yes | yes | yes (RPC) | gold path |
| `POST /approvals/:id/respond` (booking) | yes (`grant_booking_approval`) | yes | yes | yes (RPC) | gold path |
| `POST /approvals/:id/respond` (visitor_invite) | partial — CAS + dispatch | no | no | manual | acknowledged in code (`approval.service.ts:540-547`) |
| Workflow engine `assign` node | yes (`set_entity_assignment`) | yes | yes (key = (instance, node, entity)) | yes (RPC) | post-Step 9, case-only (workflow-engine.service.ts:1083) |
| Workflow engine `update_ticket` node | yes (`update_entity_combined`) | yes | yes | yes (RPC) | post-Step 9, 14-field allowlist |
| Workflow engine `approval` node | NO — raw insert into approvals | no | no | no | workflow-engine.service.ts:1449 |
| SLA escalation cron (reassign branch) | yes (`set_entity_assignment` v3.2) | yes | yes (key = `sla:escalation:<timer>:<pct>:<type>`) | yes (RPC) | **P0-2 CLOSED (Slice B + CR1 R-A02-2 + CR2 D-A02-4)** — `applyReassignment` → v3.2 in one tx; D-A02-1 watcher fixed; crossing-winner gate; CR2 success-probe closes the poison window. Live smoke DEFERRED-with-reason (cron not firing on shared :3001; jest 10/10+CR2 +4 + v3.2 concurrency 20/20 + reassign-probe live-proven — Slice F) |
| SLA timer start (outbox handler) | yes (`start_sla_timers`) | yes (within RPC) | yes | yes | gold path |
| Routing-evaluation outbox handler | yes (`set_entity_assignment` v3.2 — status clear + decision folded in) | yes | yes (key = `routing-evaluation:<event_id>`) | yes (RPC) | **P1-2 CLOSED (Slice D + D-A02-2/00418 + CR2)** — second raw status-clear + standalone routing_decisions.insert deleted, folded into v3 `clear_routing_status`+`decision`; case-only fail-closed guard; CR2 transient/terminal split. Not HTTP-reachable (outbox); v3.2 path live-proven via reassign rerun_resolver probe (Slice F) |
| PM generator cron | yes (`create_pm_work_order`) | yes | yes | yes | smoked |
| Webhook ingest | yes (`create_ticket_with_automation`) | yes | yes | yes | force_workflow_definition_id supported |
| Reclassify | partial (`reclassify_ticket` RPC for case; routing rerun is TS) | partial | partial | yes | underscored in b2-followups; not audited deeply here |
| Portal create | not audited deeply | — | — | — | one of the 6 still-underscored paths per b2-followups:75-80 |

### Direct-write escape hatches found

Production code paths (excluding tests) that mutate `tickets` or `work_orders` rows outside `update_entity_combined` / `set_entity_assignment`:

1. `ticket.service.ts:1139-1143` — satisfaction (P1-3, acknowledged).
2. `ticket.service.ts:1292-1296` — reassign rerun_resolver clear (P1-1, part of broader reassign gap).
3. `ticket.service.ts:1375` — reassign final write (P1-1).
4. `ticket.service.ts:1639-1644` — `bulkUpdate` (**P0-1**).
5. `work-order.service.ts:978-983` — WO reassign (P1-1).
6. `sla.service.ts:40-58 / 101-103 / 118-121 / 283-360 / 445-450 / 796` — SLA timer writes (response/resolution due-at columns, waiting transitions, escalation reassign — mix of legitimate SLA-internal columns and the P0-2 assignment reassign).
7. `routing-evaluation.handler.ts:282-289` — routing_status clear (P1-2).

The b2-followups doc captures most of these (`bulkUpdate` at §1.5, reassign at the `update_ticket node` section, satisfaction in a dedicated bullet); the SLA escalation reassign at sla.service.ts:796 is the gap **not** acknowledged anywhere.

### Routing / ownership / execution / visibility separation: clean?

**Routing (assignment-determining):**
- `RoutingService.evaluate` is read-only (good — `routing.service.ts:45-58`).
- `RoutingService.recordDecision` is write-only (good — append-only audit).
- Resolver chain order documented (`docs/assignments-routing-fulfillment.md:75-80`).
- One issue: routing is invoked from at least 4 entry points (create RPC, reassign rerun_resolver branch, dispatch, routing-evaluation outbox handler). They each call `evaluate` differently (case_owner vs child_dispatch hook). The hook discrimination is documented at `routing.service.ts:37-39`. Acceptable.

**Ownership (parent case `assigned_team_id`):**
- Owned by `update_entity_combined`'s assignment branch + reassign paths. The reassign paths are the gap (P1-1).
- Documented well: `docs/assignments-routing-fulfillment.md:5-12` keeps the four axes separated cleanly.

**Execution (child work_orders' assignees):**
- Set at dispatch time (atomic, via RPC). Re-set via `PATCH /work-orders/:id` (atomic) or `POST /work-orders/:id/reassign` (gap, P1-1).
- The execution surface has its own visibility predicate (`work_order_visibility_ids`, 00374) and its own planning gate (`work_orders_planning_visible_for_actor`, 00380). Good.

**Visibility (query-layer):**
- `ticket_visibility_ids` (cases) + `work_order_visibility_ids` (WOs) — paired, single source of truth.
- TS-side: `TicketVisibilityService.{loadContext, getVisibleIds, assertVisible, assertCanPlan}` for cases. Same service is reused for WOs via the `loadTicketRow` try-both fallback (P2-1). Not a clean separation.
- `isOperatorContext` + `canPlanRow` are pure policies (good — `ticket-visibility.service.ts:77-116`).
- Planning surface has a dedicated SQL predicate (00380) that drops requester/watcher paths — this is the right shape for plandate access.

**Verdict:** the *concept* is clean (the doc is well-written). The *code* has a clean Postgres-side split (paired predicates) and a leaky TS-side split (one service tries both tables). Routing and visibility are well-separated; ownership and execution are visible-but-not-quite-split at the service layer.

### Vendor / team / user first-class parity

- All three appear consistently in `assigned_team_id` / `assigned_user_id` / `assigned_vendor_id` on both `tickets` and `work_orders`.
- Validation: `validateAssigneesInTenant` covers all three (used in `ticket.service.ts:979-988`, `work-order.service.ts` preflight, `dispatch.service.ts:154-162`).
- Routing: `routing_rules.action_assign_vendor_id` is **not** in the schema (`docs/assignments-routing-fulfillment.md:111` flags this as a tracked gap). So rule-based routing can target teams and users but not vendors. Vendors are only routable via `location_teams` and `asset_types.default_vendor_id` / `assets.override_vendor_id`. **Asymmetric.**
- Visibility: vendor participant path exists in `TicketVisibilityService.assertVisible` (`ticket-visibility.service.ts:235`), but `ctx.vendor_id` is "phase-4 stub; null today" per line 17 — so the vendor participant path is **always denied** today. Acknowledged in `docs/visibility.md:88-89`.
- Reassign: all three reachable from both sides' reassign DTOs.
- Plandate (`canPlanRow`, `ticket-visibility.service.ts:92-116`): vendor included when `ctx.vendor_id && row.assigned_vendor_id` match. Latent — vendor_id is always null in ctx today.

**Verdict:** schema parity is good, runtime vendor support is two phases incomplete (rule routing + vendor user identity). Both gaps are documented. Don't treat vendors as first-class until those land.

### Smoke coverage gaps for work-orders

Strong areas:
- Every PATCH probe asserts `command_operations.outcome='success'` via `assertCommandOpRow` (smoke-work-orders.mjs:292-338). This is the structural defense for "controller bypassed the orchestrator."
- Plan-version concurrency: 4 probes (smoke-work-orders.mjs:524-650) covering match/stale/refetch — non-vacuous, post-read verified.
- Plan-merge regression battery: 5 probes covering set-both / duration-only / start-only / null-clear / duration-without-start (smoke-work-orders.mjs:386-512). Post-read verified.
- Validation matrix: 7 probes for ghost uuids / malformed uuids / oversized arrays / ghost assignees / empty title (1016-1066).
- Planning-board surface: requester negative-control with three sub-scenarios (team membership, role assignment, assigned_user) — all non-vacuous (1465-1707). Reads are RPC-driven (00380).
- PM generator: 7 scenarios per ai/slice-c-plan.md (1717+).
- Cost-fractional float normalization: covered on both sides (smoke-work-orders.mjs:1009-1013, smoke-tickets.mjs).

**Gaps** (strikethrough = CLOSED by a later slice; struck not deleted to preserve the original audit record):
1. ~~**`PATCH /tickets/bulk/update` is not probed at all.**~~ **CLOSED (P0-1, Slice 8)** — bulk routes through the hardened single-path `update()` (per-id `update_entity_combined`); see the P0-1 Closure Ledger rows.
2. ~~**`POST /tickets/:id/reassign` is not asserted for `command_operations`.**~~ **CLOSED (Slice F)** — `runReassignIdempotencyProbes`: asserts `command_operations` success under `reassign:case:<id>:<crid>` + the `routing_decisions` + `reassigned` `ticket_activities` atomic-write trio + replay idempotency + the D-A02-4 drifted-retry short-circuit. (Post-Slice-C reassign DOES emit a `command_operations` row — the original gap premise no longer holds.)
3. ~~**`POST /work-orders/:id/reassign` happy-path is not probed.**~~ **CLOSED (Slice F)** — `runWoReassignProbe`: `command_operations` success under `reassign:work_order:<id>:<crid>` + explicit-`entity_kind` `routing_decisions` + replay + D-A02-4 drifted-retry (also covers P2-4 clean shape).
4. ~~**SLA escalation cron is not smoked.**~~ **PROBED + DEFERRED-with-reason (Slice F)** — `runSlaEscalationProbe` seeds a query-visible near-breach timer + escalate-threshold policy and waits ≥2 cron windows; the `@nestjs/schedule` cron is not firing on the shared :3001 dev process so the probe records a loud **DEFERRED** (not pass, not silent skip). SLA-escalation TS path jest-covered (`sla.service.spec.ts` 10/10 + CR2 +4) + underlying `set_entity_assignment` v3.2 concurrency-tested 20/20 + live-proven via the reassign probes (same RPC/atomicity).
5. ~~**Vendor assignment paths are not differentiated.**~~ **CLOSED (Slice F)** — `runVendorReassignProbe`: reassign with `assigned_vendor_id` → `command_operations` + `routing_decisions` + `assigned_vendor_id` landed with team/user cleared atomically.
6. **No cross-tenant probe for the WO surface.** smoke-tickets has `runCrossTenantProbes` (`smoke-tickets.mjs:600-678`); smoke-work-orders doesn't have a sibling. *(Still open — out of audit-02 Slice F scope; tracked.)*
7. ~~**`getChildTasks` visibility leak (P1-5) is not probed.**~~ **CLOSED (Slice F)** — `runGetChildTasksVisibilityProbe`: a vendor-dispatched child WO outside a low-visibility requester's `work_order_visibility_ids` is excluded for that requester; a `read_all` actor sees it (parent-case-read ≠ child-WO-read).
8. ~~**Dispatch probe is minimal.**~~ **CLOSED (Slice F)** — `runDispatchContractProbes`: same-crid replay → same `child_id`; same-crid + different payload → 409; dispatch on terminal (`closed`) parent → 400 `dispatch.parent_terminal`.
9. ~~**No probe of the `routing_status` clear after `set_entity_assignment`** (P1-2 territory).~~ **PARTIALLY CLOSED (Slice F)** — the v3.2 decision-path (`clear_routing_status`+`decision`) is exercised end-to-end via `runRerunResolverProbe` (same RPC + decision payload the routing-evaluation handler uses); the outbox handler itself is event-driven (not HTTP-reachable) and remains jest-covered (`routing-evaluation.handler.spec.ts` 17/17 + CR2 +5).
10. **Reclassify is not in smoke-work-orders.** It's in `smoke-tickets.mjs:1059-1064` as a guard probe only. The reclassify RPC (00354/00355) is one of the still-underscored cutovers per `b2-followups.md:77`. *(Still open — out of audit-02 Slice F scope; tracked.)*

### Doc-vs-code drift findings

1. **`docs/visibility.md:87`** says "Bulk updates. `PATCH /tickets/bulk/update` doesn't call `assertVisible`." This is **wrong** — the bulk path *does* call `assertVisible` (`ticket.service.ts:1620`) and narrows the id set. What it doesn't do is everything else (P0-1). The doc is mis-describing the gap; the gap is real but different.
2. **`docs/assignments-routing-fulfillment.md:43`** describes the SLA timer path as "drains via the outbox handler above" for case create. True post-Step-12. The doc does **not** describe the SLA escalation reassign path (P0-2) — that's a routing-axis decision the doc claims to own.
3. **`docs/smoke-gates.md:17-26`** describes the work-orders smoke as covering "status · priority · assignment · plan · sla · title · tags · cost-fractional · dispatch." The list omits: bulk, reassign (case+WO), reclassify, SLA escalation, vendor-specific paths. Aligns with the gap list above — the doc honestly states "these are the probes," it just doesn't claim to be comprehensive. Mostly accurate; could be more explicit about what isn't covered.
4. **`docs/assignments-routing-fulfillment.md:91`** lists "Workflow-spawned child" as going through the dispatch path. True post-Step-8 batch RPC. Aligned.
5. **`b2-followups.md:165-170`** acknowledges reassign as a deferred cutover. Aligned with P1-1.
6. **`b2-followups.md` does not mention SLA escalation reassign (P0-2)** — gap in the followups doc, not just the code.
7. **`docs/visibility.md`** does not document the case-vs-WO loadTicketRow fallback (P2-1) nor the `getChildTasks` visibility inheritance (P1-5). Both are real semantics surfaced by code only.

---

## Recommendations summary

In ship-order priority:

1. **P0-1 (bulk update).** Add `RequireClientRequestIdGuard`. Route through `update_entity_combined` (loop or new batch RPC). Run per-action permission gates. Until then: deprecate the route and remove the FE caller.
2. **P0-2 (SLA escalation cron).** Route through `set_entity_assignment` with a `sla:escalation:<crossing_id>` idempotency key. Watchers update via `update_entity_combined` metadata branch.
3. **P1-1 (reassign).** Extend `set_entity_assignment` to accept `reason` + `actor_person_id` and emit `routing_decisions` + activity rows inline. Schedule for the post-B.2.A cutover.
4. **P1-2 (routing handler).** Fold `routing_status` clear into the RPC; branch on entity kind for case vs WO.
5. **P1-3 (satisfaction).** Fold into metadata branch of `update_entity_combined`.
6. **P1-4 (reassign visibility floor parity).** Decide the right floor; align both sides; document in `docs/visibility.md`.
7. **P1-5 (`getChildTasks` filter).** Filter children through `work_order_visibility_ids`; document the change in `docs/visibility.md`.
8. **P2-1 (service-layer split).** Pull WO concerns out of `TicketService`. Probably a multi-day refactor.
9. **Smoke additions** (any time):
   - Probe `PATCH /tickets/bulk/update` (once it routes through the orchestrator).
   - Probe reassign happy-paths for `command_operations` (once they emit one).
   - Probe SLA escalation reassign (seed a near-breach timer, advance clock, assert orchestrator audit).
   - Probe `getChildTasks` cross-visibility.
   - Probe vendor assignment through the orchestrator end-to-end.
   - Probe dispatch idempotency replay + payload mismatch.

---

## Files referenced

- `apps/api/src/modules/ticket/ticket.controller.ts`
- `apps/api/src/modules/ticket/ticket.service.ts`
- `apps/api/src/modules/ticket/ticket-visibility.service.ts`
- `apps/api/src/modules/ticket/dispatch.service.ts`
- `apps/api/src/modules/work-orders/work-order.controller.ts`
- `apps/api/src/modules/work-orders/work-order.service.ts`
- `apps/api/src/modules/work-orders/work-order-planning.service.ts`
- `apps/api/src/modules/routing/routing.service.ts`
- `apps/api/src/modules/sla/sla.service.ts`
- `apps/api/src/modules/approval/approval.service.ts`
- `apps/api/src/modules/workflow/workflow-engine.service.ts`
- `apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts`
- `apps/api/scripts/smoke-work-orders.mjs`
- `apps/api/scripts/smoke-tickets.mjs`
- `docs/assignments-routing-fulfillment.md`
- `docs/visibility.md`
- `docs/smoke-gates.md`
- `docs/follow-ups/b2-followups.md`
- `supabase/migrations/00327_*`, `00333_*`, `00335_*`, `00336_*`, `00349_*`, `00356_*`, `00374_*`, `00380_*`, `00382_*`, `00383_*`, `00384_*`

---

## Closure Ledger

Maintainer rule: every agent that closes, partially closes, or deliberately defers a finding from this ticket/work-order audit must update this ledger in the same change. Do not rely on chat history as the record of truth. Add concrete evidence: changed files, migration numbers, tests/smokes run, and any residual risk.

| Date | Finding / Slice | Status | Evidence | Verification | Notes |
|---|---|---|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/02-tickets-work-orders.md` | Not run | All findings remain open unless a later row says otherwise. |
| 2026-05-16 | **P0-1 + P2-5** — `PATCH /tickets/bulk/update` back door | **CLOSED (code)** | `apps/api/src/modules/ticket/ticket.controller.ts` (added `@UseGuards(RequireClientRequestIdGuard)` + controller-boundary tags/watchers narrowing + threads `clientRequestId`); `apps/api/src/modules/ticket/ticket.service.ts` `bulkUpdate` rewritten to loop the hardened single-path `update()` per id (inherits perm gates, tenant validation, sla_id immutability, parent-close guard, cost-norm, `update_entity_combined` idempotency+audit+domain-event, satisfaction fold) with de-dupe + `results[]`/`partialSuccess` contract; `docs/visibility.md:87` corrected. No migration (TS-only — reuses existing RPC). No FE caller existed (grep `apps/web` clean). P2-5 dissolves: bulk DTO is `UpdateTicketDto` (no `plan_version`/`_source`); `update()` rejects `plan` on case. | `pnpm -C apps/api lint` (tsc --noEmit) green. Live smoke (new bulk probe) deferred to Slice 8 per slice plan; `/full-review` + codex pending in same slice. | Idempotency: shared batch `clientRequestId`; per-id key `patch:case:<id>:<crid>` via `buildPatchIdempotencyKey` → whole-batch retry replays each id once. Behaviour change (safe, no FE caller): return shape now `{results,okCount,errorCount,partialSuccess}` instead of raw row array; permission denials surface as per-id `error` rows instead of silent drop. Residual: per-id `loadContext` inside `update()` = N round-trips for N ids (≤200 cap; bulk is rare/admin) — perf note, not correctness. |
| 2026-05-16 | **P0-1 review-fix pass** (`/full-review` 2 adversarial agents) | **HARDENED** | Folded 4 substantive review findings: (1) prose leak — per-id `error` now carries neutral registered `code` only via `AppError`/`mapRpcErrorToAppError`, never `err.message` (was re-leaking server prose + cross-scope child UUIDs); (2) `ids` amplification — controller now validates non-empty UUID-string array (`reference.invalid_uuid`) before the loop; (3) retry-with-correction — effective crid folds a stable patch fingerprint so a corrected resubmit reusing the batch crid doesn't `payload_mismatch`-brick succeeded ids (EditBookingOp-discriminator pattern); (4) HTTP status — controller maps outcome to 200/207/422 per error-handling spec §3.1:88. Inline append-only Update block added under P0-1. | `pnpm -C apps/api lint` green; `pnpm errors:check-app-errors` green (0 raw throws / 35 modules). | Deferrals (tracked, see inline Update block): `bulk_update_entity_combined` batch RPC for cross-id atomicity (integrator Week-1 follow-up); FE bulk wire envelope + 207 handling + Show-me list (owned by error-handling workstream, spec §3.1, unbuilt); all-noop→ok is intended idempotent no-op (not divergently "fixed"). codex review next (P0 = big step). |
| 2026-05-18 | **P0-2** — SLA escalation cron bypasses `set_entity_assignment` (Slice B) | **CLOSED (code; live smoke deferred to Slice F)** | `apps/api/src/modules/sla/sla.service.ts` — `applyReassignment` rewritten: the escalation assignment+watchers write now issues ONE `set_entity_assignment` v3 RPC (`supabase/migrations/00416_set_entity_assignment_v3.sql`, identical 6-arg sig, Slice A) instead of the raw `updateTicketOrWorkOrder()` path; `p_entity_kind` = the kind `loadTicketForFire` resolves (case ⇒ tickets / work_order ⇒ work_orders — now returns `kind`); `p_idempotency_key` = `buildSlaEscalationIdempotencyKey(timer.id, threshold.at_percent, timer.timer_type)` (`packages/shared/src/idempotency.ts`); `p_payload` carries the resolved assignee + a non-null `reason` (so v3's routing_decisions audit row fires) + corrected `watchers`; RPC errors mapped via `mapRpcErrorToAppError` (no raw throws). v3 commits the row UPDATE + `command_operations` idempotency + `routing_decisions` + `ticket_activities` + `ticket_assigned` domain event in one PG tx. Legitimate SLA-internal column writes (`sla_*_due_at`, `sla_paused`, waiting transitions, restartTimers clears) stay on the raw `updateTicketOrWorkOrder` helper — unchanged. `docs/assignments-routing-fulfillment.md` §7 gains the SLA-escalation reassign subsection (routing-axis drift closed). Tests: `apps/api/src/modules/sla/sla.service.spec.ts` +2 (deterministic key, resolved kind, non-null reason, person-id-not-users.id watcher, no raw UPDATE; work_order kind path). | `pnpm -C apps/api exec jest sla.service.spec.ts` 10/10 green; `pnpm -C apps/api lint` (tsc --noEmit) green; `pnpm errors:check-app-errors` green. Live smoke (`pnpm smoke:work-orders` / a new SLA-escalation probe) deferred to Slice F per slice plan — code path is jest-covered + lint/errors-gated but not exercised against the real DB this slice. | Idempotency boundary (precise): v3 makes the **assignment+watchers+audit write** an idempotent replay via the `sla:escalation:<timer>:<pct>:<type>` key; the `sla_threshold_crossings` UNIQUE `(sla_timer_id, at_percent, timer_type)` constraint (00043:16) governs crossing/notification dedup separately. NOT full-tick idempotency. See R-A02-2 below. D-A02-1 (pre-existing bug) fixed; R-A02-1 + R-A02-2 registered (Discovered findings / Residual risks subsection below). |
| 2026-05-18 | **P1-2** — routing-evaluation handler clears `routing_status` outside tx, hardcoded `case`, standalone `routing_decisions.insert` (Slice D) | **CLOSED (code; live smoke deferred to Slice F)** | `apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts` — (a) standalone `.from('tickets').update({routing_status:'idle'})` OUTSIDE the RPC tx (cross-tx window) **deleted**; (b) standalone TS `routing_decisions.insert` **deleted**; both folded into `set_entity_assignment` v3 (migration `supabase/migrations/00416_set_entity_assignment_v3.sql`, Slice A — UNCHANGED) via `p_payload.clear_routing_status:'true'` + `p_payload.decision:{strategy,chosen_by,rule_id,trace,context}` — v3 commits assignment update + routing_status clear + routing_decisions row in ONE PG tx; (c) `p_entity_kind:'case'` hardcode kept (correct per F11 — 5 producers, all case-only: 00354/00355/00356/00357/00358) + fail-closed `DeadLetterError` guard added for impossible non-case entity_kind; (d) RPC now called unconditionally for all outcomes (target-found, unassigned, matches-current — v3 no-op fast path extended by F17 to NOT fire when directive keys present). context object mirrors `RoutingService.recordDecision` (routing.service.ts:77-83) + adds `outbox_event_id`. `apps/api/src/modules/outbox/handlers/__tests__/routing-evaluation.handler.spec.ts` — 7 new tests: `clear_routing_status:'true'` always present; `decision` shape matches evaluation; no standalone `tickets.update`; no standalone `routing_decisions.insert` in success path; unassigned path uses directives only; matches-current still calls RPC; non-case entity dead-letters. 17 total / 17 pass. `docs/assignments-routing-fulfillment.md` updated: RoutingEvaluationHandler description (case-only contract, v3 atomicity, no standalone writes) + §28 (case-only contract table, audit02 P1-2 atomicity fix, fail-closed guard). **routing_decisions column delta (handler TS insert vs v3 decision path — no audit data lost):** handler wrote {tenant_id, ticket_id, strategy, chosen_team/user/vendor_id, chosen_by, rule_id, trace, context}; v3 decision path writes the same plus {entity_kind, case_id, work_order_id} (new polymorphic columns in v3's routing_decisions insert, 00416:509-546). All handler-written columns are represented; v3 adds the polymorphic columns that were absent before. Zero audit data lost. | `pnpm -C apps/api exec jest routing-evaluation.handler` 17/17 green; `pnpm -C apps/api lint` (tsc --noEmit) green; `pnpm errors:check-app-errors` green (0 raw throws / 35 modules). Live smoke (`pnpm smoke:work-orders`) deferred to Slice F per slice plan — this handler exercises the tickets DB path, not work-order-specific endpoints; a full `smoke:cross-tenant` + manual routing-evaluation probe would cover it. | evaluation→decision map is IDENTITY (same as Slice C — `RoutingEvaluation.strategy`/`.chosen_by` are byte-identical to v3's allowlist per 00416:356,366-371). WO re-routing explicitly deferred as a separate future event (documented in §28). `markRoutingFailure` path unchanged — it still does standalone writes for the FAILURE breadcrumb (correct: the RPC itself failed, so there's no tx to fold into). |
| 2026-05-18 | **D-A02-2** — `routing_decisions.chosen_*` audit provenance was sourced from the post-write assignment state, not the resolver decision (silent regression; Slice D follow-up) | **CLOSED (code; live smoke deferred to Slice F)** | Discovered during code review of Slice C+D. `routing_decisions.chosen_team_id/chosen_user_id/chosen_vendor_id` semantically = "the target the RESOLVER CHOSE" (NULL on unassigned) — canonical idiom `RoutingService.recordDecision` (`apps/api/src/modules/routing/routing.service.ts:71-73`); `idx_routing_decisions_chosen_by` (00027:78) indexes this as provenance. **Bug:** `set_entity_assignment` v3 (00416) decision-path `routing_decisions` INSERT (00416:522-524) sourced `chosen_*` from `v_new_*`; `v_new_* := v_prev_*` when the `assigned_*` key is ABSENT (00416:255-257). The routing-evaluation handler's resolver-**unassigned** outcome against an **already-assigned** ticket correctly OMITS the `assigned_*` keys (must not clear the existing assignment) — so v3 wrote the ticket's STALE current assignee into `chosen_*` on a `chosen_by='unassigned'` row. The OLD standalone handler insert (`4b77af30~1` lines ~248-263) wrote `chosen_*=NULL` here. Reachable on every re-eval of an assigned case whose resolver outcome is unassigned (`resolver.service.ts:114`, `child-execution-resolver.service.ts:138`, `case-owner-engine.service.ts:60-76`). **Fix (Option A — decouple provenance from the assignment write):** new migration `supabase/migrations/00418_set_entity_assignment_v3_1_chosen_from_decision.sql` (`create or replace`, IDENTICAL 6-arg signature, supersedes 00416 — 00416 UNCHANGED). v3.1's decision-path INSERT sources `chosen_{team,user,vendor}_id` from the validated `decision` object (`nullif(v_decision->>'chosen_<x>_id','')::uuid`), NOT `v_new_*`; non-decision (manual/reason-only) path keeps `v_new_*` (the manually-set assignee IS the chosen target — correct); all-keys-absent path never reaches the INSERT. New caller-supplied `chosen_*` get the SAME §7c-style tenant-scoped existence guard `rule_id` uses (`routing_decisions.chosen_*` are global FKs to teams/users/vendors, 00027:63-65, no tenant scope) → raises registered `set_entity_assignment.invalid_decision` (no cross-tenant FK probe, no raw 23503/500). Callers updated to carry the resolver target ids in `decision` (recordDecision idiom — NULL on unassigned): `apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts` (`evaluation.target` → `chosen_*`); `apps/api/src/modules/ticket/ticket.service.ts` rerun_resolver branch (`result.target` → `chosen_*` + `decision` type extended). SQL-diff vs 00416 (`/tmp/audit02-sliceD-fix-sqldiff.txt`) shows ONLY: 3 new locals, the §7c chosen_* extraction+3 tenant guards, the decision-path INSERT `case when v_has_decision_key then v_decision_chosen_* else v_new_* end`, header+comment — ZERO other behavioral change. Tests: `apps/api/test/concurrency/set_entity_assignment.spec.ts` +3 live-SQL scenarios (15: unassigned-outcome decision, no assigned_* keys, assigned ticket ⇒ chosen_* ALL NULL + assignment UNCHANGED [regression oracle]; 16: real resolver pick chosen_team_id=X ⇒ decision-sourced X; 17: cross-tenant chosen_team_id ⇒ invalid_decision not 23503); handler spec unassigned test rewritten to assert chosen_*=NULL + no assigned_* keys + team-target chosen_team_id=TEAM_ID; Slice C spec asserts chosen_* per target kind (team/user/vendor/null). | `pnpm -C apps/api exec jest --config test/concurrency/jest.config.cjs --runInBand set_entity_assignment` **17/17 green** (scenarios 1-14 unchanged = manual/reason-only + all-keys-absent byte-identical proof; 15-17 new); `pnpm -C apps/api exec jest test/concurrency/set_entity_assignment.spec.ts src/modules/ticket/ src/modules/work-orders/ src/modules/outbox/` 33 suites / **359 pass** (2 skipped, 0 regression); `pnpm -C apps/api lint` (tsc --noEmit) green; `pnpm errors:check-app-errors` green (0 raw throws / 35 modules). Live smoke deferred to Slice F per slice plan. | Manual-reassign + all-keys-absent paths are **byte-identical to 00416** — proven by the SQL diff (`else v_new_*` arm = literal 00416 when `v_has_decision_key` false; the INSERT guard `v_reason is not null or v_has_decision_key` makes all-keys-absent unreachable) AND by concurrency scenarios 4/5/9/11/13 passing unchanged. Decision-passing callers that DON'T supply chosen_* now write `chosen_*=NULL` on the decision path (intended: provenance ≠ assignment); the two production decision callers (handler + rerun_resolver) both now supply chosen_*. **P1-2 closure now also depends on this corrective migration** (00418) — see the appended note on the P1-2 row below. |
| 2026-05-18 | **P1-2 follow-up note** (D-A02-2 dependency) | **note (append-only)** | The P1-2 row above (2026-05-18, Slice D) folded the standalone `routing_decisions.insert` into v3's `p_payload.decision` path. That fold introduced D-A02-2: v3 (00416) sourced `routing_decisions.chosen_*` from `v_new_*` (post-write assignment) instead of the resolver decision, silently regressing the OLD handler's `chosen_*=NULL`-on-unassigned behavior. **P1-2's closure is therefore NOT complete on 00416 alone — it additionally requires migration `supabase/migrations/00418_set_entity_assignment_v3_1_chosen_from_decision.sql` (v3.1) + the caller `chosen_*` additions** (routing-evaluation.handler.ts + ticket.service.ts rerun_resolver). With 00418 applied, the P1-2 atomicity fix holds AND the audit provenance is correct. | See the D-A02-2 row above for full evidence + verification. | Append-only note; does not rewrite the P1-2 row. The "Zero audit data lost" claim on the P1-2 row was true for the column SET but D-A02-2 corrected the VALUE written into chosen_* on the unassigned-outcome path. |
| 2026-05-18 | **P1-1** — both `reassign()` paths bypass orchestrator (Slice C) | **CLOSED (code; live smoke deferred to Slice F)** | `apps/api/src/modules/ticket/ticket.service.ts` — case `reassign()` rewritten: the raw `.from('tickets').update` pre-clear (rerun) + final raw update + standalone `routing_decisions.insert` + standalone `addActivity` (all non-transactional, no idempotency) replaced by ONE `set_entity_assignment` v3 RPC (`supabase/migrations/00416_set_entity_assignment_v3.sql`, Slice A — UNCHANGED). Manual branch: `p_payload` = target + `reason` + `actor_person_id`, NO `decision` (v3's reason-gated branch writes the manual provenance). rerun_resolver branch: `RoutingService.evaluate(ctx)` called ONCE read-only (NO pre-clear — a crash now leaves the prior assignment intact, not all-null), result mapped IDENTITY into `p_payload.decision` (`strategy`/`chosen_by` are byte-identical to v3's allowlist per resolver.types.ts:1,8-27 ↔ 00416:356,366-371; `context` mirrors `RoutingService.recordDecision`). `recordDecision` no longer called from reassign (v3 owns the audit row). `apps/api/src/modules/work-orders/work-order.service.ts` — WO `reassign()` rewritten: raw `.from('work_orders').update` + the TWO try/catch-SWALLOWED inserts (routing_decisions + activity — silent audit loss) replaced by ONE v3 RPC (manual-only, no `decision`); dead `resolveAuthorPersonId` removed (v3 owns actor_person resolve); post-RPC refetch miss now `AppErrors.notFound` not `forbidden` (closes **P2-4**). Both: `_clientRequestId`→`clientRequestId` (now USED as the idempotency seed via `buildReassignIdempotencyKey('case'|'work_order', id, crid)` from `packages/shared/src/idempotency.ts`); missing crid hard-fails `command_operations.client_request_id_required`; RPC errors via `mapRpcErrorToAppError` (no raw throws). Controllers unchanged (already threaded `clientRequestId`). WO permission floor (`assertCanPlan`) UNCHANGED — P1-4 OUT of scope, documented. Tests: `ticket-reassign-rerun-resolver.spec.ts` rewritten (manual=one v3 call no decision; rerun=evaluate-once + decision passthrough + NO pre-clear; cross-tenant reject before write; missing-crid); `work-order-reassign.spec.ts` rewritten (one v3 call; no raw/swallowed writes; refetch-miss=notFound not forbidden; rerun still unsupported; missing-crid); `ticket-permissions.spec.ts` reassign block migrated to assert the v3 RPC. Docs: `docs/assignments-routing-fulfillment.md` (matrix rows + reassign specifics flipped to v3), `docs/visibility.md` (reassign-floor-asymmetry note), this matrix (2 rows flipped). | `pnpm -C apps/api exec jest src/modules/ticket/ src/modules/work-orders/` 23 suites / 185 pass (2 skipped, 0 regression); `sla.service.spec.ts` 10/10 still green; `pnpm -C apps/api lint` (tsc --noEmit) green; `pnpm errors:check-app-errors` green (0 raw throws / 35 modules). Live smoke (`pnpm smoke:work-orders`) deferred to Slice F per slice plan — jest-covered + lint/errors-gated, not exercised against the real DB this slice. | evaluate()→decision map is the IDENTITY (no normalization) — `RoutingEvaluation.strategy` (`FulfillmentShape \| 'rule'`) and `.chosen_by` (`ChosenBy`) are the exact source-of-truth types v3's allowlist literals are pinned to (00416 comments mandate keep-in-sync); a non-identity map would be the bug. Residual: (1) WO `rerun_resolver` still unsupported — UNCHANGED, documented (needs a planning-board case_owner-vs-child_dispatch decision); (2) **P1-4** (case `assertVisible('write')` vs WO `assertCanPlan` floor asymmetry) explicitly DEFERRED — Slice C changed only the write mechanism, both floors untouched, decision tracked by P1-4 + documented in `docs/visibility.md` §7. |

| 2026-05-18 | **P1-5** — `getChildTasks` inherits parent-case visibility, doesn't filter children (Slice E) | **CLOSED (code; live smoke deferred to Slice F)** | `apps/api/src/modules/ticket/ticket-visibility.service.ts` — new method `getVisibleWorkOrderIds(ctx)`: same contract as `getVisibleIds` but calls `public.work_order_visibility_ids` (migration 00374); `null` = see-all on `has_read_all` (WO inherits `tickets.read_all` by design, 00374 §108-114); `[]` = no user_id; else calls `rpc('work_order_visibility_ids', {p_user_id, p_tenant_id})` with same row-shape mapping + `?? []` fallback; throws on rpc error. `apps/api/src/modules/ticket/ticket.service.ts` — `getChildTasks`: after fetching child WO rows, if `actorAuthUid !== SYSTEM_ACTOR` and `woVisibleIds !== null`, filter rows through `new Set(woVisibleIds)`; `has_read_all` → `woVisibleIds = null` → no filter; old stale comment ("inheriting parent visibility is future 1c.9 concern") replaced with audit-02/P1-5 reference. SYSTEM_ACTOR path: the entire visibility block (including `getVisibleWorkOrderIds`) is inside `if (actorAuthUid !== SYSTEM_ACTOR)` — SYSTEM_ACTOR still sees all children. New specs: `apps/api/src/modules/ticket/ticket-visibility.service.spec.ts` +6 tests (`getVisibleWorkOrderIds` suite — null on has_read_all; [] on no user; rpc called with correct args; object-row mapping; null data → []; throw on error); `apps/api/src/modules/ticket/get-child-tasks-visibility.spec.ts` (new file) — 5 tests: non-read_all actor excludes hidden child; has_read_all includes all (no filter); ticket_kind preserved; SYSTEM_ACTOR bypasses; no-user_id returns []. `docs/visibility.md`: §3 — `getChildTasks` removed from `tickets_visible_for_actor` preferred-path list + new paragraph explaining the per-child WO filter (00374, parent-read != child-read); §4 — `getVisibleWorkOrderIds` row added to TicketVisibilityService table. | `pnpm -C apps/api exec jest ticket-visibility.service.spec get-child-tasks-visibility` 25/25 green; `pnpm -C apps/api exec jest modules/ticket/` 17 suites / 131 pass (2 skipped, 0 regressions); `pnpm -C apps/api lint` (tsc --noEmit) green; `pnpm errors:check-app-errors` green (0 raw throws / 35 modules). Live smoke (`pnpm smoke:work-orders` with a requester-vs-vendor-child probe) deferred to Slice F per slice plan. | Residual: one extra `rpc('work_order_visibility_ids')` call per `getChildTasks` invocation (cheap predicate call — same order as `ticket_visibility_ids` on list). Not a correctness concern; note here for perf awareness. SYSTEM_ACTOR behavior explicitly preserved — all internal callers (workflow engine, cron, outbox handlers) that call `getChildTasks(id, SYSTEM_ACTOR)` still see all children. drift-finding #7 (`docs/visibility.md` not documenting child WO visibility inheritance) closed inline. |

| 2026-05-18 | **D-A02-3 / I2** — v3.1 sourced `routing_decisions.chosen_*` and `chosen_by` independently from the decision object with NO provenance invariant (CR1) | **CLOSED (code; live smoke deferred to Slice F)** | New migration `supabase/migrations/00419_set_entity_assignment_v3_2_chosen_provenance_guard.sql` (`create or replace`, IDENTICAL 6-arg signature, supersedes 00418 — 00416/00418 UNCHANGED). v3.2 adds, in the §7c decision-validation block (after the 3 chosen_* tenant guards, before the block's `end if;`), an **asymmetric** provenance guard: (a) `chosen_by='unassigned'` with ANY `chosen_*` non-NULL → raise (the dangerous self-contradictory provenance lie — the D-A02-2 dual: a row claiming "resolver chose nobody" while naming a target corrupts every `idx_routing_decisions_chosen_by` (00027:78) provenance query), (b) MORE THAN ONE `chosen_*` non-NULL → raise (the at-most-one gap 00418:446-452 explicitly conceded). Same raise shape + sqlstate as the rule_id/chosen_*/strategy guards (`raise … 'set_entity_assignment.invalid_decision: chosen_by/chosen_* provenance mismatch' using errcode='P0001'`) → `extractCode` maps to the registered **400**, never a raw 23xxx / 500. **CR1 review correction (brutal-honesty / verified-against-live-suite):** the originating brief proposed a full *biconditional* including the converse `chosen_by<>'unassigned' ⇒ ≥1 chosen_* non-NULL`. That converse is WRONG against the codebase: the established v3.1 contract (concurrency scenarios **13b + 14**, both pre-existing green) + the canonical `RoutingService.recordDecision` idiom explicitly allow a non-unassigned `chosen_by` with NO `chosen_*` keys (provenance carried by `rule_id`/the assignment columns; mirroring into chosen_* is optional). Enforcing the converse regressed 13b/14 when run against the live local DB. v3.2 therefore ships the asymmetric dangerous-lie-only guard; the converse is documented as deliberately NOT enforced in the migration header. SQL-diff vs 00418 (`/tmp/audit02-cr1-v32-sqldiff.txt`) shows ONLY: the new header block, the new guard block, and the updated `comment on function` text — the single removed line is the old comment (replaced); ZERO other behavioral change → manual/reason-only + all-keys-absent paths byte-identical to 00418 (also proven by scenarios 1-17 passing unchanged). Tests: `apps/api/test/concurrency/set_entity_assignment.spec.ts` +3 live-SQL scenarios — 18 (positive control: `chosen_by='location_team'` + all chosen_* NULL ⇒ STILL OK, the v3.1-contract-preserved oracle), 19 (`chosen_by='unassigned'` + in-tenant `chosen_team_id` ⇒ `invalid_decision`, not 23xxx/500; guard fires before INSERT), 20 (two non-NULL chosen_* ⇒ `invalid_decision`). | `pnpm -C apps/api exec jest --config test/concurrency/jest.config.cjs --runInBand set_entity_assignment` **20/20 green** (1-17 unchanged incl. D-A02-2 15/16/17 + the byte-identical 4/5/9/11/13 manual/absent proofs; 18-20 new); `pnpm -C apps/api lint` (tsc --noEmit) green; `pnpm errors:check-app-errors` green (0 raw throws / 35 modules). Applied to LOCAL DB via psql (`create or replace`); no remote push. Live smoke deferred to Slice F per slice plan. | Append-only D-A02-3 row. The converse half of the brief's proposed biconditional is intentionally unshipped (would be a behavioral regression, not a provenance fix) — recorded here so a future reviewer doesn't "complete the biconditional" and break 13b/14. Both production decision callers (routing-evaluation.handler.ts, ticket.service.ts rerun_resolver) are correct-by-construction for the shipped guard (discriminated `AssignmentTarget` union ⇒ at-most-one; `target===null` ⇒ chosen_*=NULL with chosen_by='unassigned'). v3.2 is fail-closed for any future/direct caller that hand-supplies the lie. |

| 2026-05-18 | **D-A02-4 / CR2** — stable-key callers recomputed a MUTABLE payload before the RPC → legitimate replay hits `command_operations.payload_mismatch` and the logical op is permanently poisoned; routing handler terminally consumed transient-error events | **CLOSED (code; live smoke deferred to Slice F)** | Codex merge-gate (CR2) finding on the audit-02 remediation. **BLOCKING (D-A02-4):** three stable-keyed `set_entity_assignment` callers reuse a deterministic idempotency key but feed `p_payload` recomputed from MUTABLE state every (re)entry; v3.2 (00419:191-209) hashes the WHOLE `p_payload` — same key + drifted hash → `command_operations.payload_mismatch`. (a) **SLA escalation** (`apps/api/src/modules/sla/sla.service.ts` `applyReassignment`/`fireThreshold`): key `sla:escalation:<timer>:<pct>:<type>`; poison path = tick-1 RPC commits a `command_operations` success row, then `writeCrossing`/any post-RPC step crashes → NO crossing → a later tick recomputes a drifted payload (v3-internal watcher dedup/order vs a fresh `Array.from(new Set(...))`, or an intervening manual reassign) → `payload_mismatch` → `applyReassignment` throws BEFORE `writeCrossing` → escalation poisoned forever (broke R-A02-2's no-permanent-suppression in exactly the crash-between-RPC-and-crossing window). (b) **routing-evaluation handler** (`apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts`): key `routing-evaluation:<event_id>`; an outbox redelivery re-runs `routingService.evaluate()` + rebuilds `decision.trace/context` from mutable routing config/ticket inputs → drift → `payload_mismatch` → event poisoned. (c) **case `reassign` rerun_resolver** (`apps/api/src/modules/ticket/ticket.service.ts`) — key `reassign:case:<id>:<crid>`; a same-crid retry re-evaluates the resolver before the RPC; routing/ticket state drift → `payload_mismatch`. (Manual case-reassign + WO-reassign are payload-stable but get the uniform guard for defense-in-depth.) **Fix (codex-prescribed READ-side gate):** new canonical helper `apps/api/src/common/command-operations-probe.ts` `probeCommandOperationSuccess(supabase, tenantId, idempotencyKey)` — tenant-scoped `.from('command_operations').select('outcome,cached_result').eq('tenant_id',…).eq('idempotency_key',…).maybeSingle()` (no existing TS reader — grep clean; this IS the canonical one; PK + outcome enum per 00316:32-54). Each stable-keyed caller probes for an `outcome='success'` row BEFORE recomputing the mutable payload / re-calling the RPC: SLA → `applyReassignment` returns `true` (assignment-already-done; `fireThreshold`'s crossing+side-effect gate then completes the stuck escalation exactly once — closes the R-A02-2 poison window); routing handler → log + `return` (the assignment+routing_status-clear+routing_decisions all already committed atomically in v3's tx — the event genuinely IS done, outbox ACKs it); case/WO reassign → return the contracted shape via the existing `getById`/refetch (cached_result 00419:803-816 doesn't carry the full row, so a tenant-scoped re-fetch is the correct contract reproduction; the write already happened). Only `'success'` short-circuits; `'in_progress'` falls through (the RPC's own advisory-lock window — handled as today). The RPC's authoritative WRITE-side `command_operations` gate is UNTOUCHED (defense in depth; no migration; 00416/00418/00419 unchanged). **IMPORTANT (transient-event-consumption):** routing handler's `rpcRes.error` path unconditionally did `markRoutingFailure + return` (a normal return ACKs the event per outbox.worker.ts:218) — the "the outbox worker's retry will re-attempt" comment was FALSE; a TRANSIENT RPC/DB error terminally consumed the event with `routing_status='failed'`. Fix: classify via the project's existing `mapRpcErrorToAppError` taxonomy (registered `<ns>.<spec>` code = terminal business/validation incl. `command_operations.payload_mismatch` → keep `markRoutingFailure + return`; `unknown.server_error` = unparseable/unregistered transient infra → `throw new Error(...)` so the outbox takes the §4.2.2 retry transition — same plain-throw idiom as `sla-timer-repoint.handler.ts:93`; `errors:check-app-errors` forbids only raw NestJS exception classes, not `throw Error`). False comment + class docstring step 7 + Idempotency section corrected to state the real contract. With the success-probe, payload_mismatch-on-redelivery is unreachable (redelivery short-circuits on the existing success) so the residual surface is genuine transient infra → must retry. Tests: `sla.service.spec.ts` +4 (probe success short-circuit → no RPC, returns true, tenant-scoped; in_progress→falls through; no row→RPC once; `fireThreshold` RPC-ok-then-crash → next tick no re-RPC + crossing+side-effects exactly once); `routing-evaluation.handler.spec.ts` +5 (success-probe → no re-evaluate/re-RPC, ACK, tenant-scoped probe; in_progress→proceeds; transient error→THROWS non-DeadLetter + no failed-status write; terminal validate_assignees_in_tenant.*→markRoutingFailure+return; terminal payload_mismatch→markRoutingFailure+return); `ticket-reassign-rerun-resolver.spec.ts` +2 (rerun + manual same-crid retry with committed success → no evaluate/no RPC, returns getById); `work-order-reassign.spec.ts` +1 (same-crid retry with committed success → no RPC, refetched row, tenant-scoped probe). Harness extensions to pre-existing specs (`sla.service.spec.ts` makeReassignDeps, `ticket-permissions.spec.ts`) add a no-row `command_operations` branch so the new probe falls through on the normal path (0 regression). | `pnpm -C apps/api test --testPathPattern "modules/(sla\|ticket\|work-orders\|outbox)/"` **39 suites / 438 pass** (2 pre-existing skips, 0 regression); `pnpm -C apps/api run test:concurrency -- set_entity_assignment.spec.ts` **20/20 green** (RPC authoritative gate untouched); `pnpm -C apps/api lint` (tsc --noEmit) green; `pnpm errors:check-app-errors` green (0 raw throws / 35 modules). Live smoke deferred to Slice F per slice plan. | **R-A02-2's no-permanent-suppression is now ACTUALLY guaranteed** — the success-probe closes the crash-between-RPC-and-crossing window the CR1 row's "no-permanent-suppression invariant" claim did NOT cover (CR1 only proved "RPC throws → no crossing → retry"; it did not cover "RPC commits → post-RPC step crashes → next tick recomputes drifted payload → payload_mismatch → poisoned"). Append-only CR2 row; does not mutate prior rows or the SUPERSEDED Codex section. The READ-side probe is purely an optimization+poison-guard; correctness still rests on the RPC's WRITE-side gate. Both production decision callers are correct-by-construction for the shipped guard (no migration shipped this CR — TS-only). |

### Discovered findings / Residual risks (Slice B — P0-2)

- **D-A02-1 — pre-existing users.id→persons.id watcher type bug (FIXED in Slice B).**
  **Root cause:** `tickets.watchers` / `work_orders.watchers` are `uuid[]` whose elements are **persons.id** (`supabase/migrations/00011_tickets.sql:26` — "person IDs"). The pre-fix `SlaService.applyReassignment` appended the outgoing `ticket.assigned_user_id` — a **users.id** — directly into the watcher array (the "previous assignee now watches" behaviour). That is a type-wrong write: the watcher set silently accumulated users.id values that never resolve as persons. It was latent because the legacy raw `updateTicketOrWorkOrder` write did no watcher validation. It becomes a hard failure under Slice B because `set_entity_assignment` v3's watcher validator is persons-scoped (`00416:310-322` — `public.persons` tenant/active/not-anonymized/not-off-boarded predicate) and would reject the users.id with `set_entity_assignment.invalid_watcher` (400).
  **Fix:** `applyReassignment` now resolves the outgoing `assigned_user_id → person_id` via a new tenant-scoped `resolvePersonIdForUser(userId, tenantId)` helper (`select person_id from users where id = <assigned_user_id> and tenant_id = <ticket.tenant_id>`, skip if null/not found — F18, symmetric to the existing person_id→users.id lookup at `sla.service.ts:779-784` and the auth_uid→person map at `00416:553-557`). Only the resolved persons.id is added to the watcher set passed in `p_payload.watchers`. No existing user↔person mapping helper existed in the codebase (grep clean), so the query is inlined as a small private helper.

- **R-A02-1 — cross-RPC watcher last-writer-wins (ACCEPTED).** `set_entity_assignment` v3's `p_payload.watchers` does a **full-replace** of the watcher uuid[]. A separate path — `update_entity_combined` metadata branch — can also write `watchers`. If an SLA escalation reassign and a concurrent (or interleaved) metadata watcher edit target the same entity, the later commit wins and silently discards the other's watcher delta (no merge, no conflict). Accepted: SLA escalation is rare (cron, only on threshold crossing, only for `action='escalate'` thresholds) and the watcher set is advisory (notification fan-out), not an integrity-bearing column. Not worth a cross-RPC watcher-merge protocol at this scale. Re-evaluate if a future feature makes watchers integrity-bearing.

- **R-A02-2 — escalation notification double-send on overlapping cron ticks — CLOSED (audit02 CR1).** ~~Step-1 finding (ACCEPTED at Slice B): `fireThreshold` write order was `applyReassignment` → `writeActivity` → `notifications.send` → `writeCrossing` → `emitEvent`; the crossing-insert dedup gate happened AFTER the notification send so it did not gate it; two overlapping `@Cron(EVERY_MINUTE)` ticks racing the same (timer, threshold) before the crossing row committed could double-send the escalation notification + write a duplicate `ticket_activities` row.~~ **Resolved CR1:** `fireThreshold` reordered so the `sla_threshold_crossings` UNIQUE `(sla_timer_id, at_percent, timer_type)` constraint (`00043:16`) is the idempotency gate for the non-idempotent human-facing side-effects. New write order: `applyReassignment` (idempotent v3 RPC — every tick may call it; replay-safe via `command_operations`) → `writeCrossing` (now returns `won: boolean` — `true` if THIS tick inserted the row, `false` on swallowed `23505`) → **only if `won`**: `writeActivity` + `notifications.send` + UPDATE the crossing's `notification_id` + `emitEvent`. A losing tick does nothing further (assignment already idempotently applied; crossing + side-effects already done by the winner). **No-permanent-suppression invariant preserved:** `writeCrossing` runs STRICTLY AFTER `applyReassignment` succeeds — if the RPC throws, `fireThreshold` throws before any crossing is written, so a later tick retries cleanly (no crossing ⇒ not suppressed). **Best-effort side-effects:** post-crossing side-effects are wrapped (`bestEffortSideEffect` — log + swallow, no rethrow) because the durable state (assignment + crossing) is already committed; a thrown notify failure would trigger a retry the recorded crossing would then (correctly) suppress, leaking a permanent "never notified, can't retry" hole. The earlier docstring claim that replay safety came from "`changed=false` on replay" was **FALSE** — v3's cached `command_operations.cached_result` is returned verbatim (`00418:217-218`) and carries `noop:false` on BOTH a fresh write and a cached replay (only the F17 no-op early-return at `00418:511-524` returns `noop:true`); the `fireThreshold` docstring is corrected to state the real mechanism (crossing-winner gating). **Assignment was already idempotent via `command_operations` (Slice B); CR1 adds crossing-winner gating for the non-idempotent side-effects — this is now full-tick dedup, not just assignment dedup.** Files: `apps/api/src/modules/sla/sla.service.ts` (`writeCrossing` returns `boolean`; `fireThreshold` reorder + corrected docstring; new `bestEffortSideEffect` helper), `apps/api/src/modules/sla/sla.service.spec.ts` +3 (winner-only side-effects across two sequential ticks; RPC-throws ⇒ no crossing ⇒ retry can fire; crossing-won + notify-throws ⇒ no rethrow). Verification: `sla.service.spec.ts` 13/13 green; full SLA module 5 suites / 56 green; `pnpm -C apps/api lint` (tsc) green; `pnpm errors:check-app-errors` green (0 raw throws / 35 modules). `notification_id` linkage preserved: crossing claimed with `notification_id: null`, then the winner backfills it via a follow-up UPDATE — `notification_id` is informational only (read by `listCrossingsForTicket` for the ticket-detail panel, `sla.service.ts:1184`, no FK-driven logic), so a backfill miss leaves it null without affecting dedup correctness. Live smoke deferred to Slice F (jest-covered + lint/errors-gated, not exercised against the real DB this CR).

- **I-1 — the per-escalation pair of `ticket_activities` rows is INTENTIONAL, not a duplicate (clarifying note, append-only).** On an SLA escalation that changes the assignee, TWO `ticket_activities` rows are written and they are semantically distinct: (a) `set_entity_assignment` v3's reason-gated `reassigned` assignment-audit row (`activity_type='system_event'`, `visibility='internal'`, `content`=the reason, `metadata.event='reassigned'` — 00418:714-730) and (b) `SlaService.writeActivity`'s SLA-breach breadcrumb (`activity_type='system_event'`, `visibility='system'`, `content`="SLA escalated — <policy> at <pct>% of <type>", `metadata.source='sla_escalation'` — sla.service.ts:912-930). Different `visibility`, different `content`, different `metadata` purpose: one records *who the ticket was reassigned to and why* (routing/assignment audit), the other records *that an SLA threshold was breached and escalation fired* (SLA timeline breadcrumb). They are not redundant; R-A02-2's crossing-winner gate already prevents a SECOND copy of EITHER on an overlapping-tick replay. No action — recorded so a future reviewer doesn't "dedupe" them into one.

- **FOLLOW-UP-A02-1 — SLA cron has no reentrancy/overlap guard (PRE-EXISTING; explicitly flagged, NOT an audit-02 closure blocker; tracked).** Surfaced by the CR2 code-review while proving the D-A02-4 poison is closed. `SlaService.checkBreaches` is `@Cron(CronExpression.EVERY_MINUTE)` (`sla.service.ts:466`) with NO in-flight guard (no `isRunning` flag / `SchedulerRegistry` / `noOverlap`); `@nestjs/schedule` fires every minute regardless of whether the prior tick finished, so a slow tick (up to ~500 timers × an RPC each) can overlap the next. **Why this is NOT a closure blocker:** the CR2 caller-side success-probe makes the *only* reachable concurrent-drifted-payload path (SLA overlapping ticks racing the same `sla:escalation:<timer>:<pct>:<type>` key with a payload that drifted post-commit) degrade to a SINGLE self-healing failed tick — once the first tick's `command_operations` `success` row commits, the next tick's probe short-circuits and completes the crossing + side-effects exactly once. Independently proven by the CR2 spec-compliance + code-quality reviews and concurred by the codex CR2 verdict (poison genuinely CLOSED, worst residual self-heals in ≤1 tick; never permanent). It is also **pre-existing infra** (the cron has lacked a guard since it was written) and **outside audit-02's literal scope** (findings P0-2/P1-1/P1-2/P1-5 + smoke; SLA cron reentrancy is not an audit-02 finding). **Recommended fix (tracked follow-up, ~3 lines, NOT shipped in audit-02 to respect the scope fence):** wrap the `processThresholds` invocation (`sla.service.ts:~562`) in a class-level in-flight guard — `if (this.thresholdsInFlight) return; this.thresholdsInFlight = true; try { … } finally { this.thresholdsInFlight = false; }` — which removes the overlap window entirely (converting "≤1 self-healing failed tick under overlap" → "no overlap at all"). Flagged here explicitly per the evaluate-infra-for-end-game discipline; not silently deferred.

## Agent Handoff Prompt

```text
You are the lead ticket/work-order remediation agent for:
docs/follow-ups/audits/02-tickets-work-orders.md

Goal:
Close every actionable ticket/work-order architecture finding in this audit. Own the whole file, but deliver it as small, reviewable slices. The end state is that ticket/case and work_order mutation paths are atomic, idempotent where required, permission-gated, visibility-safe, audited, smoke-covered, and documented.

Read first:
- AGENTS.md / CLAUDE.md
- docs/follow-ups/audits/02-tickets-work-orders.md
- docs/follow-ups/audits/00-integrator-verdict.md
- docs/assignments-routing-fulfillment.md
- docs/visibility.md
- docs/smoke-gates.md
- docs/follow-ups/b2-followups.md
- apps/api/scripts/smoke-work-orders.mjs
- apps/api/scripts/smoke-tickets.mjs

Recommended slice order:
1. `PATCH /tickets/bulk/update`: remove the raw-update back door. Add client-request-id guard, validation, per-action permission gates, idempotency, audit, and route through `update_entity_combined` or a batch RPC.
2. SLA escalation reassignment: route assignment changes through `set_entity_assignment` with deterministic idempotency; preserve or deliberately redesign watcher behavior.
3. Case + work_order reassign paths: move raw update + routing_decisions + activity writes into one atomic RPC path.
4. Routing-evaluation handler: fold `routing_status` clearing into the atomic assignment path and handle entity_kind correctly.
5. Satisfaction rating: fold the side write into the orchestrated metadata path or document why it stays outside.
6. `getChildTasks`: filter child work_orders through work_order visibility instead of inheriting parent visibility blindly.
7. Service-layer split cleanup: separate case-only and work_order-only service responsibilities where practical.
8. Extend `smoke-work-orders` and/or `smoke-tickets` to cover bulk update, reassign idempotency/audit, child visibility, vendor assignment, and dispatch replay.

Execution rules:
- Before editing, create a checklist for every P0/P1/P2/P3 finding in this file.
- Touching routing, dispatch, SLA, approval, workflow, ticket visibility, or trigger tables requires updating the living-contract docs in the same change.
- Do not mix large schema/RPC work with frontend cleanup.
- Use parallel agents only for read-only investigation or disjoint write scopes.
- If a route remains intentionally non-idempotent, document the reason and risk in this audit and in the relevant reference doc.

Required closure behavior:
- Update this file's Closure Ledger after every slice.
- Update `docs/assignments-routing-fulfillment.md`, `docs/visibility.md`, and/or `docs/smoke-gates.md` whenever their contracts change.
- Record tests/smokes run. For affected work-order/case command surfaces, run the mandatory smoke gate when feasible.

Completion bar:
- No ticket/work_order P0 raw-write bypass remains.
- Assignment-changing paths use the canonical atomic/idempotent path or have a documented exception.
- Visibility-sensitive reads and writes are covered by code and smoke.
- Reference docs match the implementation.
- Final response lists closed findings, verification, and any explicit deferrals.
```

> **⚠️ SUPERSEDED — read the Closure Ledger above first.** The static Codex pass below predates Slices B/C/D/E and the CR1 cumulative-gate fixes (commits `72df4f0c`…`2491ca88` + CR1). Its "❌ not done" rows — specifically **P0-2 still open**, P1-1 case/WO reassign, P1-2 routing-evaluation, P1-5 child visibility — are **SUPERSEDED by the 2026-05-18 CLOSED rows in the Closure Ledger above** (P0-2 closed Slice B + R-A02-2 closed CR1; P1-1 Slice C; P1-2 Slice D + D-A02-2; P1-5 Slice E). The historical section is retained verbatim for audit provenance — do **not** treat its verdict as the current state, and do **not** delete it.

## Codex Deep Review — 2026-05-18

Reviewer: Codex, static code review against the current working tree. No live smoke gates were run in this pass.

### Validated Checkmarks

| Finding / claim | Codex validation | Evidence |
|---|---:|---|
| P0-1 / P2-5 bulk update no longer raw-writes tickets | ✅ validated | `ticket.controller.ts` has `@UseGuards(RequireClientRequestIdGuard)` on `PATCH /tickets/bulk/update`, validates non-empty UUID ids, and status-maps 200/207/422. `ticket.service.ts::bulkUpdate` de-dupes, caps at 200, fingerprints the patch into the effective CRID, and loops through `update()` per id instead of `.from('tickets').update(...)`. |
| Bulk per-row path inherits the single-update guarantees | ✅ validated | `bulkUpdate()` calls `this.update(id, dto, actorAuthUid, effectiveClientRequestId)`, so the single update path owns assignment/permission validation, tenant checks, `update_entity_combined`, command operations, and domain-event behavior. |
| Bulk batch all-or-nothing remains deferred | ✅ validated as still deferred | Current implementation is a TS loop over per-id atomic updates. There is still no `bulk_update_entity_combined` RPC. This is honest in the ledger, but it is not "best-in-class" batch atomicity. |
| P0-2 SLA escalation assignment routed through canonical assignment RPC | ❌ not done | `sla.service.ts::applyEscalation` still builds assignment updates and calls `updateTicketOrWorkOrder()`, which raw-updates `tickets` / `work_orders`. No `set_entity_assignment`, no command operation, no routing decision row. |
| P1-1 case reassign path atomic/idempotent | ❌ not done | `ticket.service.ts::reassign` still clear-writes assignment before resolver rerun, then separately writes `tickets`, inserts `routing_decisions`, and adds activity. `_clientRequestId` is threaded but unused. |
| P1-1 work_order reassign path atomic/idempotent | ❌ not done | `work-order.service.ts::reassign` still raw-updates `work_orders`, then best-effort inserts `routing_decisions` and activity in swallowed `try/catch` blocks. `_clientRequestId` is threaded but unused. |
| P1-2 routing-evaluation status clear folded into atomic assignment path | ❌ not done | `routing-evaluation.handler.ts` still hardcodes `p_entity_kind: 'case'`, then separately clears `tickets.routing_status='idle'` after the assignment RPC and audit insert. |
| P1-5 child work_order visibility filtered independently | ❌ not done | `TicketService.getChildTasks()` still asserts parent case visibility only and returns all children from `work_orders` for that parent. The inline comment still says tighter child scoping is future work. |

### Verdict

Audit 02 is **not done** and is **not best-in-class**. One important back door, `PATCH /tickets/bulk/update`, was fixed in a credible way, but the audit's other high-risk mutation paths remain exactly in the failure class the audit identified: raw multi-step writes, unused CRIDs, swallowed audit/activity failures, and read-side child visibility inheritance.

The current honest state is: **P0-1 closed; P0-2 still open; multiple P1s still open.** Do not claim the ticket/work-order architecture is complete until the assignment-changing paths and child visibility are remediated and smoked.

### Updated Claude Agent Prompt — 2026-05-18

```text
You are the ticket/work-order remediation agent for Audit 02:
docs/follow-ups/audits/02-tickets-work-orders.md

Codex reviewed the current tree on 2026-05-18. Do NOT redo the bulk-update slice unless you find a regression: P0-1/P2-5 is validated as closed in code. Focus on the remaining open findings below.

Open findings to close:
1. P0-2 SLA escalation reassignment still raw-updates tickets/work_orders through `SlaService.updateTicketOrWorkOrder()`. Route assignment changes through the canonical atomic/idempotent assignment path (`set_entity_assignment` or a purpose-built RPC) with deterministic idempotency from the threshold/crossing event. Preserve watcher behavior deliberately, either inside the same transaction or with a documented split.
2. P1-1 case and work_order `reassign()` still do raw update + separate routing_decisions + separate activity, with unused CRIDs. Move the assignment write, routing_decisions row, and activity/audit row into one atomic path. Stop clear-then-rerun on case resolver; evaluate first, write once.
3. P1-2 routing-evaluation handler still hardcodes `case` and clears `routing_status` in a second raw write. Fold status clearing into the atomic assignment path and either support work_order events or document/enforce case-only input.
4. P1-5 `getChildTasks()` still inherits parent visibility and returns all child work_orders. Filter children through the work_order visibility predicate before returning.
5. Add or update live smoke coverage for SLA escalation reassignment, case/WO reassign command-operation/audit behavior, routing-status handling, child visibility, vendor assignment, and dispatch replay/payload-mismatch.

Execution rules:
- Update `docs/assignments-routing-fulfillment.md`, `docs/visibility.md`, and `docs/smoke-gates.md` in the same change whenever behavior changes.
- Treat assignment changes as multi-table invariant writes: no TS choreography if a partial write corrupts audit, visibility, routing, or replay semantics.
- Every route that requires `X-Client-Request-Id` must actually use it in the idempotency key or document why it is only threaded for future work.
- Update this Codex Deep Review section and the Closure Ledger with exact files, migrations, tests, smokes, and residual risks.

Completion bar:
- No P0/P1 ticket/work_order assignment path raw-writes entity assignment outside the canonical atomic path.
- `getChildTasks()` cannot leak child work_orders solely because the parent case is visible.
- Smoke gates prove the fixed paths against the live API.
```

## Codex Re-Review Verdict — 2026-05-19

Reviewer: Codex, static code review against current `feature/booking-audit-remediation` plus the audit ledger. No new smoke run in this pass; prior Slice F smoke evidence is accepted as recorded.

### Validated Checkmarks

| Finding / claim | Codex validation | Evidence |
|---|---:|---|
| P0-1 bulk update back door closed | ✅ validated | Bulk update still routes through `TicketService.update()` per id with CRID guard and no raw ticket update back door. |
| P0-2 SLA escalation assignment no longer raw-updates assignment | ✅ validated | `SlaService.applyReassignment()` now builds `buildSlaEscalationIdempotencyKey(...)`, probes `command_operations`, and calls `set_entity_assignment` with assignment + watcher + reason payload. The remaining `updateTicketOrWorkOrder()` calls are SLA-internal timer/status columns, not assignment-changing writes. |
| P1-1 case reassign no longer TS choreography | ✅ validated | `TicketService.reassign()` uses `buildReassignIdempotencyKey('case', ...)`, evaluates resolver before writing, probes committed command operation, and calls `set_entity_assignment`. No raw assignment clear/write + separate `routing_decisions` + activity path remains. |
| P1-1 work_order reassign no longer TS choreography | ✅ validated | `WorkOrderService.reassign()` uses `buildReassignIdempotencyKey('work_order', ...)`, probes committed command operation, and calls `set_entity_assignment`; swallowed routing/activity writes are gone. |
| P1-2 routing-evaluation handler status clear is atomic | ✅ validated | `RoutingEvaluationHandler` passes `clear_routing_status:'true'` and `decision` into `set_entity_assignment`; standalone success-path `tickets.routing_status` update and standalone `routing_decisions.insert` are gone. |
| P1-5 child work_order visibility leak closed | ✅ validated | `TicketService.getChildTasks()` calls `TicketVisibilityService.getVisibleWorkOrderIds(ctx)` and filters child rows through `work_order_visibility_ids`. |
| Live smoke coverage exists for the audit-02 block | ✅ validated from ledger | Slice F records `smoke:work-orders` 138 pass / 0 fail / 1 deferred with a STEP-0 provenance gate. The single deferred item is SLA cron execution on the shared server, not the assignment primitive. |

### Verdict

Audit 02 is **best-in-class for the original ticket/work-order audit findings**. The original P0/P1 architectural risks are now closed in code: assignment-changing paths go through the canonical atomic/idempotent `set_entity_assignment` family, routing status/audit writes are folded into the same transaction, and child work-order visibility is independently enforced.

This is not a zero-maintenance state. The following should remain tracked, but they do **not** block closing Audit 02:
- **FOLLOW-UP-A02-1:** add an SLA cron reentrancy guard around `processThresholds()` so overlapping cron ticks cannot race. Current CR2 analysis says the worst reachable race self-heals in <=1 tick; still worth fixing because the guard is cheap and removes the class.
- **Batch atomicity:** `PATCH /tickets/bulk/update` is per-id atomic/idempotent, not one all-or-nothing cross-id transaction. Acceptable interim; batch RPC remains an integrator follow-up.
- **SLA live smoke:** cron could not be exercised on the shared server. Keep the existing deferred smoke reason honest until there is a controllable cron/test hook.

### Updated Claude Agent Prompt — 2026-05-19

```text
You are the final hardening agent for Audit 02:
docs/follow-ups/audits/02-tickets-work-orders.md

Codex re-reviewed the current tree on 2026-05-19. The original P0/P1 audit findings are closed and should not be reworked without a concrete regression. Your job is only final hardening and proof, not redesign.

Remaining work:
1. Implement FOLLOW-UP-A02-1: add a class-level in-flight guard around `SlaService.processThresholds()` / the cron entrypoint so overlapping ticks skip instead of racing. Keep the existing crossing UNIQUE and command-operation protections; this is an extra reentrancy belt.
2. Add or expose a deterministic test hook for SLA threshold processing so the SLA-escalation live smoke can exercise the real cron path without restarting the shared dev server. If a hook is unsafe, document why and keep the smoke's deferred status explicit.
3. Optional: design the future `bulk_update_entity_combined` RPC for all-or-nothing cross-id bulk updates. Do not block Audit 02 closure on it unless the product requires batch atomicity.

Process requirements:
- Work autonomously through implementation, docs, and tests.
- Run `/full-review` or equivalent adversarial self-review on the step, fix findings yourself, then ask Codex for final review on the big step. Repeat until no critical/important findings remain.
- Update this audit append-only with exact files, tests, smokes, and residual risk.
- Do not loosen the existing STEP-0 provenance gate in `smoke:work-orders`.

Completion bar:
- SLA cron cannot overlap itself.
- SLA escalation is either live-smoked through a deterministic hook or remains explicitly deferred with a stronger technical reason.
- No original Audit 02 P0/P1 finding reopens.
```

---

## Codex Deep Review status — 2026-05-18 (CR2 GO / Slice F)

> **APPEND-ONLY.** This subsection does NOT mutate the SUPERSEDED static Codex section above or any prior Closure Ledger row. The ❌ rows in the 2026-05-18 static Codex pass (P0-2 / P1-1 case+WO / P1-2 / P1-5) predate Slices B–F + CR1/CR2 and are superseded by the CLOSED Closure Ledger rows + the live-smoke evidence recorded here.

**Final independent verdict.** The audit-02 assignment-atomicity remediation passed the full review gauntlet: the plan-gate review, all five remediation slices (B/C/D/E + the P0-1 slice) each through a 2-stage adversarial review (`/full-review` + conditional codex), the **CR1** codex merge-gate (closed R-A02-2 — the SLA crossing-winner gate / no-permanent-suppression), and the **CR2** codex merge-gate (closed D-A02-4 — the stable-key drifted-payload poison + the routing-handler transient/terminal-consumption split). Codex's CR2 verdict is **GO**: the D-A02-4 poison is genuinely closed by the caller-side `probeCommandOperationSuccess` read-gate, the worst residual (overlapping SLA cron ticks racing a post-commit-drifted payload) self-heals in ≤1 tick and is never permanent, and FOLLOW-UP-A02-1 (SLA cron reentrancy) is correctly flagged non-blocking + out of audit-02 scope.

**Findings — final state:**

| Finding | State | Migration / proof |
|---|---|---|
| **P0-2** SLA escalation cron bypassed `set_entity_assignment` | **CLOSED + pushed** | `applyReassignment` → v3.2; 00416/00418/**00419** live on remote (single overload, v3.2 body verified). Live: DEFERRED-with-reason (cron not firing on shared :3001) — see Slice F ledger row. |
| **P1-1** both `reassign()` paths bypassed orchestrator | **CLOSED + pushed** | case+WO `reassign()` → v3.2; live-smoked green (Slice F: command-op + routing_decisions + ticket_activities atomic; replay + D-A02-4 drifted-retry). |
| **P1-2** routing-evaluation handler raw status-clear, hardcoded case | **CLOSED + pushed** | standalone status-clear + routing_decisions.insert deleted, folded into v3 `clear_routing_status`+`decision`; v3.2 decision-path live-proven via the `rerun_resolver` probe (same RPC). |
| **P1-5** `getChildTasks` inherited parent visibility | **CLOSED + pushed** | `getVisibleWorkOrderIds` per-child filter; live-smoked green (vendor-dispatched child excluded for low-vis requester, visible to read_all). |
| **D-A02-1** users.id→persons.id watcher type bug (pre-existing) | **FIXED** | `resolvePersonIdForUser` before watcher add; jest-covered (`sla.service.spec.ts`). Live: in the deferred SLA probe's assertion set. |
| **D-A02-2** routing_decisions.chosen_* sourced from post-write assignment | **FIXED** | 00418 (v3.1) sources chosen_* from the decision object; live-proven (rerun_resolver probe asserts resolver provenance, never hardcoded manual). |
| **D-A02-3 / I2** v3.1 chosen_by/chosen_* had no provenance invariant | **FIXED** | 00419 (v3.2) asymmetric provenance guard (`chosen_by='unassigned' ⟺ all chosen_* NULL`); live-proven (rerun_resolver D-A02-3 biconditional probe). |
| **D-A02-4 / CR2** stable-key callers recomputed mutable payload → poison | **FIXED** | `command-operations-probe.ts` caller-side success-probe; TS-only (no migration); live-proven on BOTH surfaces (case + WO drifted-retry short-circuits to original, NOT payload_mismatch). |
| **R-A02-1** cross-RPC watcher last-writer-wins | **ACCEPTED** | rare cron path + advisory watcher set; documented, re-evaluate if watchers become integrity-bearing. |
| **R-A02-2** escalation double-send on overlapping ticks | **CLOSED (CR1)** | `sla_threshold_crossings` UNIQUE crossing-winner gate; CR2 success-probe additionally closed the crash-between-RPC-and-crossing poison window. |
| **FOLLOW-UP-A02-1** SLA cron has no reentrancy guard | **FLAGGED, non-blocking** | pre-existing infra, out of audit-02 scope; ~3-line fix tracked; CR2 success-probe degrades the only reachable concurrent-drift path to ≤1 self-healing tick. |

**Smoke status (Slice F, 2026-05-18, live against :3001 on the remote DB).** STEP-0 provenance gate **PASSED** (manual reassign committed a `command_operations` success row under `reassign:case:<id>:<crid>` with the v3.2 `cached_result` shape — the running server IS serving audit-02 code; not stale). Full `pnpm -C apps/api smoke:work-orders` → **138 pass / 0 fail / 1 deferred · exit 0**. The audit-02 block (`runAudit2Probes`, ~25 assertions) all green: provenance · P1-1 case reassign command-op/audit/replay · D-A02-4 drifted-retry poison-closure (case+WO) · CR2 caller-probe · rerun_resolver provenance (D-A02-2/D-A02-3) · vendor end-to-end · WO reassign · P1-5 cross-visibility (both directions) · dispatch replay/payload-mismatch/terminal-parent. **SLA escalation (P0-2) live = DEFERRED-with-precise-reason** (not pass, not fail, surfaced loudly): the `@Cron(EVERY_MINUTE)` `processThresholds` is not executing on the shared :3001 dev process (empirically verified — a query-visible near-breach timer + escalate-threshold policy produced zero `command_operations`/crossing after ≥2 full cron windows); `processThresholds` is private with no HTTP entrypoint; restarting the shared server is forbidden (concurrent audit-03/04 sessions). The SLA-escalation-specific TS path is jest-covered (`sla.service.spec.ts` 10/10 + CR2 +4) and its underlying atomic primitive `set_entity_assignment` v3.2 is concurrency-tested 20/20 + live-proven by the reassign/vendor/WO probes (same RPC, same `command_operations`+`routing_decisions`+`ticket_activities`+`domain_events` atomicity). This is the same documented rationale the PM-generator probe uses for direct-RPC invocation over cron reliance.

### Slice F Closure Ledger row

| Date | Finding / Slice | Status | Evidence | Verification | Notes |
|---|---|---|---|---|---|
| 2026-05-18 | **Slice F** — live smoke + audit-02 close-out (P0-2/P1-1/P1-2/P1-5) | **CLOSED (code + live-smoked; SLA-escalation live DEFERRED-with-reason)** | `apps/api/scripts/smoke-work-orders.mjs` — new `runAudit2Probes` block (~25 assertions) gated by a mandatory STEP-0 provenance probe (`reassign:case:<id>:<crid>` `command_operations` success ⇒ server-on-audit-02-code; if absent → skip-not-pass with a precise LIVE-SMOKE-BLOCKED reason — false-green guard). Probes: P1-1 case reassign (command-op + explicit-`entity_kind` `routing_decisions` + `reassigned` `ticket_activities` atomic trio + replay idempotency + **D-A02-4 drifted-retry short-circuit-to-original**), CR2 caller-probe (rerun_resolver same-crid), P1-1/D-A02-2/D-A02-3 rerun_resolver provenance (resolver `strategy`/`chosen_by`, never hardcoded manual; `chosen_by='unassigned' ⟺ chosen_* NULL`), vendor end-to-end (smoke-gap #5), WO reassign + drifted-retry (smoke-gap #3 + P2-4 clean shape), P1-5 getChildTasks cross-visibility (vendor-dispatched child excluded for low-vis requester / visible to read_all), dispatch replay+payload-mismatch+terminal-parent (smoke-gap #8). New `recordDeferred` bucket + reassign/SLA-escalation idempotency-key replicas (lockstep w/ `packages/shared/src/idempotency.ts:582,607-613/:638,655-661`). `docs/smoke-gates.md` — `smoke:work-orders` section extended with the audit-02 block, the symbol trigger list (set_entity_assignment v3/v3.1/v3.2, reassign/SLA/routing-handler/getChildTasks paths, command-operations-probe), and the SLA-deferral honesty + the `pass/fail/deferred` exit semantics. This audit doc — atomic-write coverage matrix rows for SLA-escalation + routing-handler flipped to the v3.2 atomic state; smoke-coverage-gaps #1-5/7-9 struck (not deleted) with closure annotations (#6/#10 remain, out of scope); this append-only Codex Deep Review status subsection. | STEP-0 provenance **PASS** (live, evidence: `command_operations` success @ `reassign:case:…:<crid>` with v3.2 `cached_result` — `entity_kind`/`new_assigned_*`/`noop:false`). `API_BASE=http://localhost:3001 pnpm -C apps/api smoke:work-orders` → **138 pass / 0 fail / 1 deferred · exit 0** (1 deferred = SLA-escalation live, cron-not-firing-on-shared-server, precise reason surfaced). `node --check` both modified `.mjs` clean. `pnpm -C apps/api lint` (tsc --noEmit) green. `pnpm errors:check-app-errors` green (0 raw throws / 35 modules). jest counts from prior slices unchanged + still green (no TS source touched this slice — smoke harness + docs only). | A FALSE GREEN is the worst outcome — the STEP-0 provenance gate is the structural defense and it PASSED, so the live results are trustworthy. No probe was loosened: the two initial `payload-mismatch → 409` assertions were **corrected** (not weakened) to assert the actual D-A02-4 CR2 contract — once a `command_operations` success exists under a crid, the caller-side `probeCommandOperationSuccess` short-circuits to the original result BEFORE the payload is built/compared, so `payload_mismatch` is deliberately unreachable from the reassign HTTP surface (asserting 409 there would assert the pre-CR2 broken behavior). The terminal-parent probe was corrected to use a dedicated childless closed case (a case with an open child can't go terminal — the parent-close-with-open-children trigger silently rejects the close). SLA-escalation live is DEFERRED, never silently skipped: it actively seeds + waits + emits a loud DEFERRED with the precise empirically-verified reason. No migration this slice (smoke harness + docs only); no push; shared :3001 server not restarted. |
