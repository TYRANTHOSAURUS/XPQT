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
- P2-5: closed by routing through the canonical path — the original corruption vector (raw-write of an arbitrary cast `Record` incl. `plan_version`/`_source`) is gone because nothing is raw-written; `update()`'s case path builds patches via `buildPatchesPayloadForCase`, rejects `plan`, and never threads `_source`. Precision (codex P3): the `UpdateTicketDto` annotation is a TS type on the controller body, NOT a runtime DTO-validation boundary — unknown keys are *silently ignored by the canonical path*, not rejected. The corruption class is closed; a strict reject-unknown-keys DTO boundary is a separate non-P0 hardening, not claimed here.

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
| `POST /tickets/:id/reassign` (case) | **NO** — 3 raw writes | **NO** | **NO** | yes (manual) | **P1-1** |
| `POST /tickets/:id/dispatch` | yes (`dispatch_child_work_order`) | yes | yes (key = (parent, crid)) | yes (RPC) | gold path |
| `PATCH /work-orders/:id` | yes (`update_entity_combined`) | yes | yes (key = (work_order, id, crid)) | yes (RPC) | gold path |
| `POST /work-orders/:id/reassign` | **NO** — 3 raw writes (errors swallowed) | **NO** | **NO** | yes (manual, best-effort) | **P1-1**, worse than case side |
| `POST /approvals/:id/respond` (ticket) | yes (`grant_ticket_approval`) | yes | yes | yes (RPC) | gold path |
| `POST /approvals/:id/respond` (booking) | yes (`grant_booking_approval`) | yes | yes | yes (RPC) | gold path |
| `POST /approvals/:id/respond` (visitor_invite) | partial — CAS + dispatch | no | no | manual | acknowledged in code (`approval.service.ts:540-547`) |
| Workflow engine `assign` node | yes (`set_entity_assignment`) | yes | yes (key = (instance, node, entity)) | yes (RPC) | post-Step 9, case-only (workflow-engine.service.ts:1083) |
| Workflow engine `update_ticket` node | yes (`update_entity_combined`) | yes | yes | yes (RPC) | post-Step 9, 14-field allowlist |
| Workflow engine `approval` node | NO — raw insert into approvals | no | no | no | workflow-engine.service.ts:1449 |
| SLA escalation cron (reassign branch) | **NO** — raw UPDATE | **NO** | **NO** | yes (activity only) | **P0-2** |
| SLA timer start (outbox handler) | yes (`start_sla_timers`) | yes (within RPC) | yes | yes | gold path |
| Routing-evaluation outbox handler | yes (`set_entity_assignment`) + raw status clear | partial | yes (RPC side) | yes | **P1-2** — case-only, second write outside tx |
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

**Gaps:**
1. **`PATCH /tickets/bulk/update` is not probed at all.** This is the P0-1 surface. Zero coverage means a future change that accidentally re-routes the surface through `update_entity_combined` (or breaks it entirely) won't surface in CI.
2. **`POST /tickets/:id/reassign` is not asserted for `command_operations`.** It's exercised by `smoke-tickets.mjs:1054-1058` as a guard-coverage probe (asserts the missing-X-Client-Request-Id 400), but no probe exercises the happy path's audit. Since reassign doesn't emit a `command_operations` row (P1-1), the smoke gate can't detect a regression in the routing_decisions audit insert.
3. **`POST /work-orders/:id/reassign` happy-path is not probed.** Same shape as #2.
4. **SLA escalation cron is not smoked.** The whole class-of-thing where an SLA breach silently reassigns the ticket has zero live-DB coverage. Mocked tests in `sla.service.spec.ts` exist but per the smoke-gates philosophy ("mocked tests pass when prod migrations fail"), they're necessary but not sufficient.
5. **Vendor assignment paths are not differentiated.** Probes write `assigned_team_id`; no probe specifically writes `assigned_vendor_id` through the orchestrator end-to-end.
6. **No cross-tenant probe for the WO surface.** smoke-tickets has `runCrossTenantProbes` (`smoke-tickets.mjs:600-678`); smoke-work-orders doesn't have a sibling.
7. **`getChildTasks` visibility leak (P1-5) is not probed.** Easy probe: requester of a case can see a child WO that's dispatched to a vendor outside the requester's visibility predicate.
8. **Dispatch probe is minimal:** smoke-work-orders.mjs:2666-2698 just asserts 201/200 and cleans up. No probe of idempotency replay (same crid → same `child_id`), no payload-mismatch probe, no terminal-parent-rejection probe. The full dispatch RPC contract (`docs/follow-ups/b2-survey-and-design.md` §3.4) is not exercised.
9. **No probe of the `routing_status` clear after `set_entity_assignment`** (P1-2 territory). If the outbox handler's second write breaks, no smoke catches it.
10. **Reclassify is not in smoke-work-orders.** It's in `smoke-tickets.mjs:1059-1064` as a guard probe only. The reclassify RPC (00354/00355) is one of the still-underscored cutovers per `b2-followups.md:77`.

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
| 2026-05-16 | **P0-1 codex review** (independent, scoped to `1c5f4785..HEAD`) | **VERDICT: SHIP-WITH-NITS — closed** | codex confirmed: looping `update()` truly inherits every B.2.A guarantee per id (visibility/perm gates, tenant validation, sla_id immutability, close guard, cost-norm, command_operations/audit/domain-event, satisfaction fold; verified `ticket.service.ts:899-1150`); no per-id key collision; `@Res({passthrough})` returns body+status correctly while thrown errors still hit the global filter (`all-exceptions.filter.ts:90`); original audit finding NOT rewritten (append-only respected); 3 deferrals honest, no hidden P0. 3 nits folded: P2 — fingerprint now hashes the *cost-normalised* payload (mirrors `update()` float-norm) so `0.30000000000000004`≡`0.3`; P3 — replaced `JSON.stringify(obj, replacer[])` with a recursive `canonicalJson` (robust to future nested DTO growth); P3 — audit P2-5 wording corrected to "ignored by canonical path, not a runtime DTO-validation boundary". Work isolated in worktree `.worktrees/tickets-wo-audit-remediation` (commits cherry-picked off the wrongly-landed branch — see [[feedback_shared_working_tree_hazard]]). | `pnpm -C apps/api lint` green; `pnpm errors:check-app-errors` green. Live bulk smoke = Slice 8 (probe doesn't exist yet; runtime shared with concurrent audit-03 session). | **P0-1 + P2-5 CLOSED.** Residual (all tracked, non-P0): batch-RPC cross-id atomicity; FE bulk envelope (error-handling workstream); strict reject-unknown-keys DTO boundary. |
| 2026-05-16 | **P0-2** — SLA escalation cron bypasses `set_entity_assignment` | **CLOSED (code)** | `apps/api/src/modules/sla/sla.service.ts`: `applyReassignment` → `set_entity_assignment` (00327, idem key `sla:escalation:<timer_id>:<at_percent>:<timer_type>`) + watchers via `update_entity_combined` (00384) metadata; entity-kind resolved once; `users.id`→`persons.id` watcher fix; duplicate `writeActivity` deleted; anchor-first crossing ordering. `docs/assignments-routing-fulfillment.md` + `docs/follow-ups/b2-followups.md` synced. No migration. Commits ba1a4322 / d89a29b4 / 0858d9b8 / c4033863 / b93c5ed7. See inline Update block under P0-2. | tsc + errors:check-app-errors green. `/full-review` (2 agents) + codex ×3 substantive rounds. | P0-2 CLOSED. See next row for review trail. |
| 2026-05-16 | **P0-2 review trail** (`/full-review` + codex ×3 on one recurrence class) | **HARDENED — closed by construction** | `/full-review`: C1 ship-blocker (watcher RPC threw on legacy-malformed `watchers` → permanent per-tick cron deadlock, worse than the P0) + I2 (idem key missing `timer_type` → collides `both`-scope crossings). codex BLOCK#1: same class via notifier throw. codex BLOCK#2: same class via in-`catch` telemetry insert → fixed structurally (anchor crossing FIRST + non-throwing `emitTelemetryBestEffort`). codex BLOCK#3: same class via unwrapped watcher RPC `await` (rejected promise, not just returned `{error}`) → whole call try/catch-wrapped. | codex re-verify #4 NOT completed (process resource-starved by concurrent audit-03 codex; terminated, 0-byte). Closure **self-verified by line-by-line trace** of codex#3's exact prescribed condition: every `await` between assignment-commit and `writeCrossing` is non-throwing by construction; `writeCrossing` = sole bounded retry window (rare; RPC replay-idempotent; 23505 swallowed — codex#3 deemed acceptable). | Residual (tracked, non-P0): SLA-escalation live smoke = Slice 8 (no probe exists; audit §331 #4); pre-existing legacy-malformed `watchers` data → best-effort skip + telemetry, one-off cleanup migration out of scope; `crossing.notification_id` now null (deliberate trace-linkage trade, no broken consumer). |
| 2026-05-16 | **P1-1 + P1-4 + P2-2 + P2-4** — both `reassign()` paths atomic + floor parity | **CLOSED (code)** | Both `reassign()` paths → ONE `set_entity_assignment` (00327) call (no migration — RPC already atomic; audit's "extend RPC" was a stale 00326 read). rerun_resolver: resolver-first, no pre-clear, RPC-without-reason, `recordDecision` after RPC (rich audit), reason activity (FORK-1a). P1-4: case-side floor `assertVisible('write')`→`assertCanPlan` (FORK-2, SYSTEM bypass intact). P2-2: entity_kind explicit in RPC for reassign sites. P2-4: WO null-refetch→`notFound`. `buildReassignIdempotencyKey`. Docs (assignments-routing-fulfillment / visibility / b2-followups) synced. Commits 380098e0 + ad34d44f. See inline Update block under P1-1. | tsc + errors:check-app-errors green; 22/22 reassign specs (incl. new rerun-contract test). | P1-1/P1-4/P2-2(reassign-sites)/P2-4 CLOSED. See next row for review trail. |
| 2026-05-16 | **P1-1 review trail** (`/full-review` 2 agents; codex unobtainable) | **HARDENED — verified** | Plan-C1 (claimed null-resolver state/audit divergence, severity CRITICAL) **verified FALSE** by direct payload-code inspection — `rerunPayload` always sets all 3 `assigned_*` keys explicit-null so the RPC correctly clears a stale assignee; checked rather than trusting the louder reviewer. Plan-C2 (recordDecision committed BEFORE the RPC → orphan "decided X but never applied" routing_decisions row on RPC rejection + retry-duplicates) — real defect, folded by reordering recordDecision to AFTER RPC success. NITs folded: uniform `context.{reason,actor}` keys; extraContext spread reversed (resolver keys un-clobberable); +1 rerun-contract spec; visibility.md full blast-radius. Code-review agent independently ran gates+specs, confirmed registered-code/no-weakened-specs/SYSTEM-bypass/dead-code-free. | codex tertiary gate NOT obtained — 3 attempts hung at 0-byte under concurrent audit-03 codex resource contention (same mode as P0-2 codex#4). Gate = reliable `/full-review` 2-agent adversarial pass + targeted self-verify + green tsc/errors/22-specs. | Accepted residuals (non-P0, documented in code + Update block): changing-rerun system-stub+internal-card activity pair (RPC-activity suppression needs a migration, out of scope); narrow RPC-ok-then-recordDecision-fails-retry → 2nd decision row (recordDecision idempotency = separate RoutingService scope). P2-2 routing.service/handler residual → Slice 4. |
| 2026-05-16 | **P1-2** — routing-evaluation handler raw `routing_status` clear + `case` hardcode | **CLOSED (code + remote migration verified)** | `set_entity_assignment` v3 migration `00406` (opt-in `clear_routing_status` flag; no-op-path-skip so same-assignee re-eval still clears; WO+flag fail-loud; §14/§15 gated on substantive change) + handler always-calls-RPC-with-flag (raw post-RPC `tickets.update` removed; explicit `entity_kind`/`case_id` on routing_decisions). **00406 pushed to remote + verified** (`pg_get_functiondef` → `t\|t\|t`). Case-only contract = the runnable `tickets`-membership lookup (documented). Commits 81343650 + b163ee5d. See inline Update block under P1-2. | tsc + errors:check-app-errors green; 10/10 handler spec; `/full-review` 2-agent (Code-I2 folded; Plan-I2 verified false); remote body verified v3. | P1-2 CLOSED. P2-2 fully closed at this site (handler routing_decisions explicit). Residuals (non-P0): Plan-C1 cross-session CREATE-OR-REPLACE clobber risk (detection = ledger + verify query); Code-I1 handler routing_decisions non-idempotent under outbox replay (pre-existing, not a P1-2 regression). Live routing-eval smoke = Slice 8. |
| 2026-05-16 | **P1-3** — satisfaction rating writes outside orchestrator | **CLOSED (code + remote migration verified)** | `update_entity_combined` v7 migration `00410` (renumbered from 00407 — cross-session triple-claim): metadata branch folds `satisfaction_rating`/`satisfaction_comment` (key-presence semantics, case-only — WO+sat-key raises `satisfaction_unsupported_for_work_order` mirroring 00406 D5; keys-absent → byte-identical to v6); `ticket.service.ts` `update()` side-write removed. **00410 pushed to remote + verified** (`pg_get_functiondef` → v7-sat=t, case-only-guard=t, v6-plan-lock=t). Commits 087e7ed9 + 9f2c612f + 78f8ea8a. See inline Update block under P1-3. | tsc + errors:check-app-errors green; WO 39/39 + ticket 23 specs; `/full-review` 2-agent both SHIP (Plan-2 WO-surface-widening + Plan-1 misleading-prose folded); remote body verified v7. | P1-3 CLOSED. Residuals (non-P0): cross-session 00407 triple-claim (rebased mine→00410; broader renumber = P2-3); no dedicated satisfaction spec (transitive; → Slice 8); `tickets.satisfaction_rating` legacy vs shipped requester-rating product (documented, decoupled); Plan-C1 clobber-detection in place. Live satisfaction smoke = Slice 8 / when a caller ships (none today). |
| 2026-05-16 | **P1-5** — `getChildTasks` inherits parent visibility | **CLOSED (code + spec)** | `getChildTasks` filters child work_orders through `work_order_visibility_ids` (00374) — parent-case `read` is precondition only; `read_all`/SYSTEM bypass; empty→[]; TS-only, no migration. New `ticket-get-child-tasks.spec.ts` 5/5. `docs/visibility.md` §7 + line 39 + read_all-deliberate-decision. Commits 6b4af8cd + 85dc82d6. See inline Update block under P1-5. | tsc + errors:check green; 5/5 new spec; `/full-review` code agent: security-correct, fail-closed, NO leak (independently verified). | P1-5 CLOSED. **Deferred (review I3, FE, brief: don't mix FE into RPC slices):** `SubIssueProgress`/`sub-issues-section` `done/total` badge now under-reports for scoped-out actors (misleading-but-safe) — FE follow-up: server-side privileged rollup or per-actor label. Cross-visibility live smoke = Slice 8 (audit §smoke #7). |
| 2026-05-16 | **P2-1** — service-layer case-vs-WO split | **DEFERRED (explicit, rationale)** | No code change. P2 "nice-to-have"; audit calls it "probably a multi-day refactor"; NOT a completion-bar item. Security consequence (P1-5 child-visibility) + atomicity consequences (P1-1/3, P0-2) already closed in Slices 1–6; what remains is module-boundary hygiene. See inline Update block under P2-1. | N/A (deferral) — scope/shape is a direction-class call; codex unobtainable all workstream; deferring beats guessing a multi-day re-arch unreviewed while a concurrent session mutates the shared tree. | Follow-up → integrator/data-model owner (verdict Should-fix #16): hard/polymorphic split; cheap interim = reject WO ids on `PATCH /tickets/:id`. Risk: dev-ergonomics + a WO-id-on-`PATCH /tickets/:id` sharp-edge (not P0/P1). |
| 2026-05-16 | **P2-2** — `routing_decisions` `entity_kind` consistency | **PARTIAL — high-value sites closed; residual accepted** | reassign sites → `set_entity_assignment` (entity_kind explicit in RPC, Slice 3); routing-eval handler explicit (Slice 4). `routing.service.ts recordDecision` (create/reclassify/rerun) keeps the 00230/00232 derive-trigger — a correct/tested mechanism, a different valid convention, NOT a missing value. See inline Update block under P2-2. | Slice 3 (22/22) + Slice 4 (10/10) specs; trigger path unchanged (pre-existing). | Accepted convention split (non-P0/P1): explicit-at-write for the high-blast sites; trigger-derive for the shared append-only writer. Full uniformity = future workstream (touches create/reclassify, out of audit-02 scope). |
| 2026-05-16 | **P2-3** — duplicate migration prefixes | **DEFERRED to integrator owner + in-scope mitigation applied** | No historical renumber (cross-session-unsafe). New evidence: `00407` found **triple-claimed** live across this/audit-03/phase-1.5 (disjoint fns, no clobber). This workstream's own migs kept collision-free (`00406`; Slice-5 rebased `00407→00410`). See inline Update block under P2-3. | `00406`+`00410` unique on-disk + `git log --all`; both pushed + bodies verified. | DEFERRED → integrator/data-model owner (verdict blocker #8): historical renumber + `scripts/check-migration-prefix-unique.sh` CI guard (highest-leverage cheap fix; recommended). audit-02 migs do not worsen the count. |
| 2026-05-16 | **P2-4** / **P2-5** | **CLOSED (in earlier slices)** | P2-4 (WO reassign `forbidden`→`notFound`) closed in Slice 3 (commit 380098e0). P2-5 (`bulkUpdate` `_source`/`plan_version` discrimination) closed in Slice 1 (routed through the canonical path; codex-precision-corrected). | See P1-1 and P0-1 Update blocks/ledger rows. | None. |
| 2026-05-16 | **P3 notes** — observations | **TRIAGED (non-actionable / tracked-elsewhere)** | (1) 1978-line `TicketService` split → same as P2-1 (deferred). (2) `addActivity` no idempotency (flaky-comment double-row) → non-P0/P1 comment-surface follow-up, NOT assignment/visibility scope; tracked for the activity-surface backlog. (3) `routing_decisions` TS-vs-RPC insert-location inconsistency → the routing-eval handler now sets entity_kind explicitly (Slice 4); the TS-vs-in-RPC insert *location* is an accepted architectural note (append-only audit, both correct). (4) reassign cutover done (Slice 3); reclassify + portal-tickets underscored cutovers are OTHER §3.x cutovers, not audit-02 findings. | Observational; no code owed by audit-02. | addActivity-idempotency = tracked non-P0 follow-up (activity surface, out of scope). |
| 2026-05-16 | **Slice 8 — live-smoke** (consolidated explicit deferral) | **DEFERRED with owner + per-finding risk (completion-bar §"explicit deferred owner and risk statement")** | No new smoke probe authored. Rationale: the shared `:3001` dev runtime is contended by a concurrent audit-03 session for the entire workstream — server-code-provenance is unattributable and fixture collision is likely; `feedback_runnable_guards_mandate` forbids shipping un-runnable probes (paper tigers). The CODE layer IS gated per slice: unit specs (Slice 3 22/22, Slice 4 10/10, Slice 5 WO39+ticket23, Slice 6 5/5) + `/full-review` adversarial pass every slice + remote function-body verification for the 2 pushed RPCs (00406 `t\|t\|t`, 00410 v7/guard/plan-lock). | tsc + `errors:check-app-errors` green every slice; all unit specs green; remote RPCs verified by `pg_get_functiondef`. | **Deferred probes, owner = this workstream's Slice-8 / next clean-runtime window** (audit §"Smoke coverage gaps" #1–10): bulk-update (P0-1); reassign happy-path `command_operations` case+WO (#2/#3); SLA-escalation reassign (#4); vendor-assignment-through-orchestrator (#5); WO cross-tenant sibling (#6); `getChildTasks` cross-visibility (#7, P1-5); dispatch idempotency-replay (#8); `routing_status` clear (#9, P1-2); reclassify (#10); satisfaction round-trip (P1-3, only when a caller exists). **Risk:** the 2026-05-01-class hazard (mocked/unit-green while a real-DB path regresses) is mitigated for the 2 pushed RPCs by direct remote body verification + per-caller backward-compat analysis, but the live HTTP→DB happy/replay paths of the closed surfaces are unverified end-to-end until these probes run. Recommended owner action: run the enumerated probes against an uncontended runtime before broad release. |
| 2026-05-16 | **Workstream status** | **All P0 + all P1 CLOSED; P2-4/P2-5 closed; P2-1/P2-3 deferred (rationale); P2-2 partial; P3 triaged; live-smoke deferred (owner+risk)** | Slices 1–6 shipped on `feature/tickets-wo-audit-remediation` (isolated worktree). Migrations 00406 + 00410 on remote, bodies verified. Completion bar: no P0 raw-write bypass ✅ · assignment paths canonical/atomic-or-documented ✅ · visibility reads/writes code-covered ✅ (smoke deferred w/ owner+risk) · reference docs synced ✅. | Per-slice tsc/errors/specs green; `/full-review` every slice; remote RPC bodies verified; codex unobtainable all workstream (concurrent-session contention) — gate = `/full-review` + targeted self-verify + green gates/specs + verified remote bodies. | Residuals all tracked above. codex tertiary gate never available (environmental). Branch ready for merge decision. |
| 2026-05-17 | **P2-1** — cheap interim guard SHIPPED | **SHIPPED (interim; full split stays DEFERRED + owned)** | `TicketService.update()` rejects a `work_order` id on `PATCH /tickets/:id` with registered `ticket.work_order_id_on_case_endpoint` (400) instead of the misleading generic `update_entity_combined.not_found`. Covers `PATCH /tickets/bulk/update` too (per-id `results[]` error, batch not aborted). New code in `KnownErrorCode` + en/nl catalogs (api+web). No migration. Commit aac61b7a. See §2026-05-17 best-in-class continuation. | tsc + errors:check-app-errors + web tsc green; `/full-review` 2-agent (code: P2-1 clean across 6 sub-checks; plan: layer-choice + reject-not-route both sound); codex Q3 clean. | Full case-vs-WO `TicketService` split STILL DEFERRED → integrator/data-model owner (verdict Should-fix #16). Interim converts a misleading error into a correct typed one; it does not reduce the split's necessity (tracked here + `docs/follow-ups/audit-02-best-in-class-routing-2026-05-17.md`, not only a code comment). |
| 2026-05-17 | **Code-I1** — routing-eval handler non-idempotent audit inserts under outbox redelivery | **RE-DEFERRED with risk + owner + ready-to-apply prescription** (NOT closed — deliberate) | A TS check-then-insert guard was authored, adversarially reviewed, and **reverted**: it has a residual TOCTOU race (`outbox.worker.ts` `sweepStaleClaims` re-claims after ~staleClaimMs with NO handler-liveness check; multi-replica also possible) AND adds an unbounded extra SELECT on every routing eval; the handler class-doc explicitly documents duplicate `routing_decisions` rows as *tolerable, not corruption*. Shipping a racy guard under "closed" = overclaim. Confirmed by `/full-review` plan agent + **codex Q4**. See §2026-05-17 for the exact prescription. | `/full-review` 2-agent + codex Q4 all converged on re-defer. RPC assignment write already replay-safe (`command_operations` key `routing-evaluation:<event_id>`); only the audit row dupes. | **Owner = next authorized + uncontended DB-push window (data-model migration owner; same window as P2-3 renumber + `check-migration-prefix-unique.sh`).** Prescription (codex-validated): claim next-free mig number at write time → `create unique index if not exists uq_routing_decisions_outbox_event on public.routing_decisions (tenant_id, (context->>'outbox_event_id'), chosen_by) where context ? 'outbox_event_id';` + `notify pgrst,'reload schema';` + the 2 handler inserts (success ~291; `markRoutingFailure` ~427) → ON CONFLICT DO NOTHING. **Risk if unapplied:** a duplicate append-only `routing_decisions` audit row on outbox redelivery — NO double-assignment (idempotent), documented tolerable, pre-existing (NOT a P1-2 regression). Not P0/P1. |
| 2026-05-17 | **codex tertiary adversarial gate** — unobtainable 2026-05-16, **OBTAINED 2026-05-17** | **OBTAINED — supersedes the 2026-05-16 "codex unobtainable" gate-degradation** | Scoped review: Q1 00406 v3 backward-compat across ALL `set_entity_assignment` callers; Q2 00410 v7 across ALL `update_entity_combined` callers; Q3 reassign/bulkUpdate/getChildTasks; Q4 Code-I1 direction. | codex `succeeded` (responsive); prompt-to-file per `feedback_codex_long_argv_hang`. | **00406/00410 safe-as-merged for all current callers** (Q1/Q2). Q3 clean. Q4 → re-defer confirmed. 3 NITs: Q1+Q2 unregistered guard error codes → **FOLDED** (commit 53ea0c66, registered 400 + en/nl api+web); Q2 00410 `comment on function` says satisfaction "handled symmetrically" but code rejects WO satisfaction → **documented forward-only fix** (no migration push solely for a comment; correct on next `update_entity_combined` touch). The 2026-05-16 "codex never available" gate-degradation is now CLOSED — it WAS obtained; merged RPCs are codex-clean. |

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

---

## 2026-05-17 — Best-in-class continuation pass

Continuation workstream taking audit-02 from "findings closed" (2026-05-16) to
best-in-class by the project's OWN bar (live-API smoke is the ship gate;
code-review + unit specs are necessary-not-sufficient). Isolated worktree
`worktree-audit-02-best-in-class` off `origin/main` 34f82c0a (PR #16 merge).
Append-only; the 2026-05-16 rows above are unchanged.

#### Update — 2026-05-17 — P2-1 cheap interim guard

- **Original finding:** P2-1 service-layer case-vs-WO split (verdict Should-fix
  #16) — DEFERRED 2026-05-16 as a multi-day refactor; cheap interim recommended.
- **Status:** Interim SHIPPED (commit aac61b7a). Full split remains DEFERRED +
  owned (integrator/data-model).
- **Changed:** `TicketService.update()` rejects a `work_order` id with the new
  registered `ticket.work_order_id_on_case_endpoint` (400) right after the
  `getById` load — mirrors `reclassify.service.ts` `assertReclassifiable`.
  Placed in `update()` (not the controller) so `PATCH /tickets/bulk/update`
  is covered as a per-id `results[]` error without aborting the batch. Error
  code added to `KnownErrorCode` union + runtime array + en/nl message
  catalogs (api + web). No migration.
- **Verified:** tsc + `errors:check-app-errors` + web tsc green. `/full-review`
  2-agent: code reviewer verified clean across 6 sub-checks (getById sets
  ticket_kind on both arms; badRequest signature correct; bulk per-id capture;
  no web caller sends a WO id to `PATCH /tickets/:id` — `ticket-detail.tsx`
  branches on `ticket_kind` first); plan reviewer: layer choice + reject-not-
  transparent-route both sound. codex Q3 clean.
- **Remaining:** the full split is unchanged-deferred. Routed explicitly to
  `docs/follow-ups/audit-02-best-in-class-routing-2026-05-17.md` so the debt is
  not buried only in a code comment.

#### Update — 2026-05-17 — Code-I1 RE-DEFERRED (not closed — deliberate)

- **Original finding:** Code-I1 — the routing-evaluation handler's own two
  `routing_decisions` inserts (success ~291; `markRoutingFailure` ~427) are
  non-idempotent; under outbox redelivery a duplicate audit row is written.
  Pre-existing; NOT introduced by the P1-2 fix.
- **Status:** RE-DEFERRED with explicit risk + owner + a ready-to-apply,
  codex-validated prescription. A TS check-then-insert guard was authored and
  then **reverted**.
- **Why not closed with the TS guard:** `/full-review` plan agent and **codex
  Q4** independently found the TS guard unsound as a *closure*: (1) residual
  TOCTOU race — `outbox.worker.ts` `sweepStaleClaims` re-claims a row after
  ~`staleClaimMs` with NO handler-liveness check, and the `draining` guard is
  per-process not fleet-wide, so the same `event.id` can be in two concurrent
  `handle()` invocations; (2) it adds an unbounded extra SELECT on every
  routing evaluation (happy-path tax) to suppress an anomaly the handler
  class-doc explicitly calls *tolerable, not corruption*; (3) shipping a
  partial/racy guard under a "Code-I1 CLOSED" banner would be exactly the
  paper-tiger overclaim the project's honest-ledger posture forbids. There is
  no clean race-free TS-only fix (gating off the `command_operations` replay
  signal would *lose* the audit row if the process crashes between the RPC
  commit and the insert — strictly worse).
- **Prescription (apply in the next authorized + uncontended DB-push window):**
  claim the next free migration number at write time (collision protocol):
  `create unique index if not exists uq_routing_decisions_outbox_event on
  public.routing_decisions (tenant_id, (context->>'outbox_event_id'),
  chosen_by) where context ? 'outbox_event_id';` then
  `notify pgrst, 'reload schema';` — and change the two handler
  `routing_decisions` inserts to ON CONFLICT DO NOTHING (the `.upsert(...,
  { onConflict, ignoreDuplicates:true })` form, or the raw on-conflict idiom
  already used in `outbox.worker.ts:300` / `00299_outbox_foundation.sql:171`).
  codex Q4 verified the `where context ? 'outbox_event_id'` predicate
  correctly exempts every non-handler `routing_decisions` writer (manual
  reassign / dispatch / pm-generator / `routing.service.ts` `recordDecision`)
  — they do not set that context key — and `chosen_by` in the key keeps the
  success row + a later `auto_routing_failed` row for the same event from
  colliding.
- **Owner:** the next authorized + uncontended DB-push window (data-model
  migration owner) — same window as the P2-3 historical renumber +
  `scripts/check-migration-prefix-unique.sh` CI guard, since all three are
  DB-push-window items.
- **Risk if unapplied:** a duplicate append-only `routing_decisions`
  audit/debug row on outbox redelivery. NO double-assignment (the assignment
  write is idempotent via the `command_operations` key
  `routing-evaluation:<event_id>`). Documented tolerable; pre-existing; not
  P0/P1. Routing analytics that count decision rows could double-count for an
  affected event until applied.

#### Update — 2026-05-17 — codex tertiary gate OBTAINED

- **Original state:** the entire 2026-05-16 workstream recorded codex as
  "environmentally unobtainable" (0-byte hangs under concurrent-session
  contention); the gate degraded to `/full-review` + self-verify + verified
  remote bodies.
- **Status:** codex is responsive 2026-05-17; the tertiary gate was OBTAINED
  and run scoped (prompt-to-file per `feedback_codex_long_argv_hang`).
- **Result:** Q1 (00406 v3) + Q2 (00410 v7) — **safe-as-merged for every
  current caller**; codex enumerated all `set_entity_assignment` /
  `update_entity_combined` callers and proved byte-equivalence when the new
  opt-in keys are absent. Q3 (reassign / bulkUpdate / getChildTasks) — clean.
  Q4 (Code-I1 direction) — re-defer confirmed correct. Three NITs only:
  Q1+Q2 unregistered guard error codes → **FOLDED** (commit 53ea0c66 —
  registered both as 400 across `KnownErrorCode` + runtime array +
  `map-rpc-error` + en/nl api+web catalogs); Q2 `00410` `comment on function`
  claims satisfaction "handled symmetrically in both arms" but the code
  rejects WO satisfaction → **documented forward-only**: a migration push
  solely to fix a comment is disproportionate (append-only migration
  discipline); correct the comment on the next migration that touches
  `update_entity_combined`.
- **Verified:** codex `succeeded` (non-hanging); findings cross-checked against
  the actual code before folding.
- **Remaining:** the 2026-05-16 "codex never available (environmental)" gate
  caveat is now CLOSED for the merged RPC surface.
