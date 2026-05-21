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
| 2026-05-17 | **Slice 8 — live-smoke** | **PASSED — supersedes the 2026-05-16 "DEFERRED with owner + per-finding risk" row** | 10 probes authored into `smoke-tickets.mjs` (+1097) + `smoke-work-orders.mjs` (+418): P0-1 bulk/update 200/207/422+replay; P1-1 case+WO reassign (`command_operations`+`routing_decisions`+activity+domain-event+assignee-change); P0-2 SLA-escalation reassign (cron-driven, crossing anchor + `sla:escalation:*` cmd-op + assignee moved + recurrence-safe); P1-2 routing_status→idle atomic + no spurious activity; P1-5 getChildTasks cross-visibility (zero-role watcher EXCLUDES vendor child, admin INCLUDES — non-vacuous, asserts parent readable); vendor-assignment e2e; WO cross-tenant; dispatch idempotency-replay; reclassify; P1-3 satisfaction round-trip + WO-guard negative. Commit 051bbbe8. Registered: CLAUDE.md mandatory matrix + `docs/smoke-gates.md` (COVERED). See §2026-05-17 live-smoke Update. | **Independently re-run by the orchestrator (not just the authoring subagent), TWICE: `smoke:tickets` 122/0 exit 0, `smoke:work-orders` 125/0 exit 0, ZERO CONTENTION-DEFER triggered on any of 3 full runs.** Adversarial vacuousness review: NO CRITICAL, no fake-green, P1-5 security probe proven to go red on the exact revert mutation; 2 IMPORTANT folds applied (probe-9 audit assertion tightened to `metadata.event='reclassified'`; SLA CONTENTION-DEFER backstop made self-verifying). | **Runtime honesty:** not a truly *solo* runtime — the shared remote DB + concurrent `:3001` session/cron persisted. What was achieved: server-code-provenance isolation (`:3010` server built from THIS worktree; `:3001` runs a divergent branch) + per-run isolated fixtures + server-agnostic idempotent-outcome assertions + a scoped CONTENTION-DEFER escape hatch that **never triggered across 3 independent full runs** — i.e. the gate is proven robust UNDER the real concurrent conditions, a stronger result than a one-off solo pass. No genuine product regression found. The 2026-05-16 per-finding risk (HTTP→DB paths unverified end-to-end) is now **DISCHARGED** for all 10 enumerated probes. |
| 2026-05-17 | **Best-in-class status** | **MET — by the project's own bar (live-API smoke is the ship gate)** | All 2026-05-16 P0/P1 closures now live-HTTP-smoked green; codex tertiary gate obtained (2026-05-16 "environmental" caveat closed); P2-1 interim shipped+reviewed; Code-I1 re-deferred with codex-validated prescription+owner+risk; living-contract docs (`smoke-gates.md`/CLAUDE.md/`visibility.md`/`assignments-routing-fulfillment.md`) synced; 02+00 ledgers reconciled append-only; cross-session items routed not absorbed (`audit-02-best-in-class-routing-2026-05-17.md`, with the brief's "B.2 CI-RED" premise corrected by evidence). | Per-slice `tsc`/`errors:check-app-errors`/web-tsc/design-polish green; `/full-review` 2-agent per substantive slice (folds verified against real code); **codex obtained** Q1–Q4; live smoke independently re-confirmed green ×3. Commits aac61b7a · 53ea0c66 · 7898b33e · 051bbbe8 (+ this row) on `worktree-audit-02-best-in-class`. | Remaining are explicitly-deferred-with-owner items, NOT audit-02 gaps: Code-I1 unique-index (next authorized DB-push window), P2-1 full split (integrator/data-model), P2-3 prefix renumber (integrator/data-model — `00410` `comment on function` forward-only fix rides the same window), P1-5 FE rollup (FE workstream). Branch ready for merge decision. |
| 2026-05-18 | **Post-PR#20 concurrent-merge integrity re-verification** | **audit-02 SURVIVED + 1 regression fixed + 1 pre-existing B.2 defect discovered & routed** | A concurrent workstream merged PR#20 (booking-audit) on top of audit-02's PR#18 (origin/main 362c45f1→4c4ba587). Re-verified on the ACTUAL merged main: (a) all 5 audit-02 commits + PR#18 merge are ancestors; (b) PR#20's `error-codes.ts` +105 merge **dropped** audit-02's `ticket.work_order_id_on_case_endpoint` runtime-array entry (type-union survived → no tsc break, but P2-1 error would render generic at runtime) → **RESTORED** on branch `audit-02-pr20-reconcile-fix`; (c) remote `set_entity_assignment` v3 + `update_entity_combined` v7 bodies **re-verified intact** (PR#20's colliding 00406/00410 files do not redefine them); (d) gate re-run on merged-main surfaced a **pre-existing B.2 dispatch idempotency-replay defect** (server-stamped `timers.due_at` in `md5(p_payload)` @ 00341:153 + dispatch.service.ts:309 → spurious `payload_mismatch` 409 on legitimate replay when an SLA resolves; 3/3 deterministic). | tsc + errors:check-app-errors green on merged-main+fix; remote bodies via `pg_get_functiondef` (`t\|t` / `t\|t\|t`); dispatch defect root-caused (00341:153, dispatch.service.ts:255-265/309, 9 sla_policies) + reproduced 3×; safety invariant (no duplicate WO) hard-asserted ✓ 3×. | The dispatch defect is **NOT audit-02 / NOT this continuation / NOT a PR#20 code regression** (dispatch code unchanged; PR#20-era SLA-config data flipped a dormant latent bug active) — pre-existing B.2 subsystem defect, **discovered by the audit-02 gate doing its job**. Routed (not absorbed) → B.2/dispatch owner with confirmed root cause + the 00407-pattern fix prescription: `docs/follow-ups/audit-02-best-in-class-routing-2026-05-17.md` §5. Probe hardened with an evidenced, fingerprint-scoped `[KNOWN-DEFECT]` carve-out (mirrors the validated SLA CONTENTION-DEFER; safety still hard-asserted; no fake-green). audit-02's own scope remains MET. |
| 2026-05-18 | **B.2 dispatch idempotency-replay** — the defect routed §5 in the row above | **CLOSED (code + remote migration verified + smoke 3×)** | Migration `00428_dispatch_idempotency_intent_hash.sql`: path-scoped `dispatch_strip_hash_server_fields(jsonb)` (strips `due_at` ONLY from elements of a key literally named `timers`; `routing_context.due_at` preserved) + `dispatch_idempotency_payload_hash(jsonb)`; `dispatch_child_work_order` reproduced VERBATIM from `00341` v3 + `dispatch_child_work_orders_batch` VERBATIM from `00342` v3 (byte-diff: exactly one `v_payload_hash` line changed per fn). Probe-8 `[KNOWN-DEFECT b2-dispatch-replay-sla-due_at]` carve-out REMOVED → strict hard gate. New runnable guard `apps/api/src/modules/ticket/dispatch.idempotency.spec.ts` (mirrors 00407 GUARD-2). **C1 caught & fixed:** batch was first reproduced from STALE `00337` v1 → `create-or-replace` last-writer would have clobbered `00342` v3 (the F-IMP-1 per-task `routing_rule_id` tenant-validate P0 cross-tenant guard + F-CRIT-1 `sla_timers` polymorphic cols); caught by `/full-review`, re-based on `00342`, live-verified preserved. | 00428 pushed to remote + `pg_get_functiondef`: both RPCs route through `dispatch_idempotency_payload_hash`, no raw `md5(p_*::text)`, C1 routing_rule tenant-validate + polymorphic cols PRESERVED, helper path-scoped. `smoke:work-orders` 3/3 exit 0 deterministic — probe-8 `✓ dispatch replay — same WO id both calls` all 3 (fresh fixtures). codex pre-impl design-check (GO-WITH-CHANGES, folded) + `/full-review` 2-agent (C1 caught & fixed) + codex tertiary (GO-WITH-CHANGES, folded); tsc + errors:check-app-errors green; guard 4/4. | **Supersedes the §5 routed deferral** (prior row + `audit-02-best-in-class-routing-2026-05-17.md` §5, now RESOLVED append-only). I1 accepted non-goals documented: replay-after-SLA-policy-edit 409 is by-design (config genuinely changed → fail-closed); forward-only — pre-00428 `command_operations` rows not rewritten so a pre-00428 dispatch replayed post-00428 may still 409, NOT a regression (that deploy-crossing replay was already broken by the very bug fixed). `smoke:tickets` prior interleaved-load flake (scattered P1-3/P0-2 probes, client-side ECONNRESET) characterized **FLAKE_INFRA** — 5/5 green in isolation; 00428 is dispatch-only and cannot affect those probes; NO smoke-tickets carve-out (green in isolation; weakening = fake-green). **NEW sibling I2** (same now()-in-hash on the WO + workflow-engine SLA-install path via `update_entity_combined` v7 `00427`:241 / `update_entity_sla` `00330`:115; producer `sla.service.ts:219`→`work-order.service.ts:584`/`workflow-engine.service.ts:1907`; NOT the case path — verified phantom) discovered by `/full-review`, independently verified, **user-approved ROUTE-not-fold** → `docs/follow-ups/i2-sla-install-idempotency-due_at-2026-05-18.md`. |
| 2026-05-18 | **P2-1** — case-vs-WO `TicketService` split | **RE-DEFERRED (codex design-check attached; user-acknowledged) — interim guard = honest closure for this bar** | No code change this engagement. The brief mandated codex-design-first for P2-1; the codex design-check was run 2026-05-18 → **RE-DEFER**, and the user **acknowledged the re-deferral** 2026-05-18 (brief #3 bar permits a fresh user-acknowledged re-deferral with the design-check attached). The sole unsafe residual the audit identified (a WO id misbehaving on `PATCH /tickets/:id`) is **already neutralized** by the shipped interim reject guard (`ticket.work_order_id_on_case_endpoint` 400, covers bulk; commit `aac61b7a`, 2026-05-17 row above). The WO **mutation** surface is **already fully separated** into `apps/api/src/modules/work-orders/work-order.service.ts` (the audit's "1978-line multi-day refactor" framing predates that split). Self-contained design-check + architecture prescription: `docs/follow-ups/p2-1-case-wo-split-design-check-2026-05-18.md`. See `#### Update — 2026-05-18 — P2-1 codex design-check DONE → user-acknowledged RE-DEFER`. | N/A (re-deferral). codex confirmed **NO latent cross-tenant hole** in the `getById`/`loadTicketRow` WO-fallback (tenant-scoped + visibility-gated). What remains is purely layering/ownership hygiene (~1 engineer-week READ-path extraction) with regression risk to 6 shipped audit-02 slices (incl. 2 live RPC migrations) for ZERO P0/P1 content in a live multi-session shared tree — re-defer beats executing now. | **Owner = integrator / data-model (verdict Should-fix #16, ~1 eng-week).** Prescribed architecture (codex, for the owner): a DELIBERATE HYBRID — keep ONE explicit *named* polymorphic id-resolver (kind-agnostic READ contract, NOT the "neither" the audit criticized) + HARD-SPLIT commands/kind-specific reads (case `list`/`update`/`reassign`/inbox/`create`/`bulkUpdate` stay in `TicketService`; WO mutations + `getChildTasks` + `createBookingOriginWorkOrder` move to `WorkOrderService`). TWO must-not-regress invariants: (1) `PATCH /tickets/:id` keeps rejecting `ticket_kind==='work_order'` with `ticket.work_order_id_on_case_endpoint`; (2) child-WO listing keeps the parent-case `assertVisible(parent,'read')` precondition AND THEN filters children via `work_order_visibility_ids` (00374) — parent visibility must NEVER imply child-WO visibility (P1-5); `getChildTasks` may move to `WorkOrderService` only if it still uses the shared `TicketVisibilityService` for the parent gate. Only real wart: `createBookingOriginWorkOrder` placement (`ticket.service.ts` ~2070); 1 consumer to rewire: `setup-work-order-trigger.service.ts:37`. Interim guard + this design-check = honest closure for the audit-02 engagement bar (P2, non-completion-bar). Integrator #16 reconciliation folded into the final 02+00 ledger reconciliation step (00-integrator-verdict NOT edited here). |
| 2026-05-18 | **Code-I1** — routing-eval handler non-idempotent `routing_decisions` audit inserts under outbox redelivery | **CLOSED (code + remote partial-unique-index verified + smoke 3×)** | Migration `00429_routing_decisions_outbox_event_unique_index.sql` pushed to the shared remote 2026-05-18; `pg_indexes` live-verified: `CREATE UNIQUE INDEX uq_routing_decisions_outbox_event ON public.routing_decisions USING btree (tenant_id, ((context ->> 'outbox_event_id')), chosen_by) WHERE (context ? 'outbox_event_id')`, `indisunique=t`. Index-only (remote pre-verified 0 dup groups / 0 null `chosen_by` → `CREATE UNIQUE INDEX` cannot fail on data; no dedup step). `routing-evaluation.handler.ts`: both `routing_decisions` inserts converted from supabase-js `.insert()` to raw parameterised `this.db.query(... on conflict (tenant_id,(context->>'outbox_event_id'),chosen_by) where context ? 'outbox_event_id' do nothing returning id)` (`DbService` injected — DbModule is `@Global`, same provider `outbox.worker.ts` uses, no module-import change). Per-site error semantics PRESERVED: Site 1 (§6 success) genuine DB error still THROWS (outbox retry contract), conflict-skipped replay (`rows.length===0`) → idempotent SUCCESS (debug, no throw); Site 2 (`markRoutingFailure`) genuine error stays WARN-ONLY (NOT escalated to throw — a throw in the failure-recording path could wedge the outbox), conflict-skipped → silent success. **The codex-tertiary NO-GO ("item 3") was mis-scoped** — verified by reading the handler L256-294: the cited control flow is ENTIRELY PRE-EXISTING and untouched by Code-I1; it is a separate `set_entity_assignment` idempotency-key/payload-stability defect, **routed not folded** as **I3** (user-approved). | 00429 pushed + `pg_indexes` live-verified (`indisunique=t`, expression partial index byte-matches the handler's explicit `ON CONFLICT` arbiter). codex pre-impl design-check → "Approach A explicit-conflict-target, GO-WITH-CHANGES" (B `.upsert` invalid for an expression partial index; C catch-23505 weaker); `/full-review` 2-agent (no CRITICAL; both designated high-risk items — DbService BYPASSRLS/tenant posture == supabase service_role, 12-col↔$1..$12 1:1 no transposition — verified correct; IMPORTANT-1 rollback-coupling + I-1 defensive init + N-3 folded); codex tertiary (smoke replay hardened: per-run scoped pre-clean + baseline isolation + `finally` outbox.events teardown scoped by case-id AND a2 tenant; NUL-byte sanitiser on jsonb-bound `trace`/`context`/`failure_reason`). `pnpm -C apps/api lint` + `pnpm errors:check-app-errors` green; `routing-evaluation.handler.spec.ts` 14/14 (10 pre-existing preserved + 4 new). `smoke:tickets` independently re-run isolated 3/3 exit 0 (123 pass / 0 fail each) — `a2ProbeRoutingEvalClear` gained `✓ routing-eval — same outbox event REDELIVERED, still exactly 1 routing_decisions row (Code-I1: ON CONFLICT DO NOTHING)`, deterministically green all 3 runs. | **Supersedes the 2026-05-17 "Code-I1 RE-DEFERRED" row** (left intact; this is appended). **Rollback-coupling note (folded IMPORTANT-1, also in the 00429 header):** the handler's EXPLICIT `ON CONFLICT` target hard-requires 00429's index — if the index is dropped while the handler change is deployed, EVERY routing eval throws "no unique or exclusion constraint matching the ON CONFLICT specification" → `audit_insert_failed` → outbox retry → dead-letter. Deploy index-first; forward-only; **never drop `uq_routing_decisions_outbox_event` independently.** **`smoke:tickets` FLAKE_INFRA only under concurrent/interleaved load** (green in isolation; mitigation = run the final gate isolated; no carve-out). **I3 routed** (codex-tertiary NO-GO finding, verified PRE-EXISTING + orthogonal by reading handler L256-294, user-approved ROUTE-not-fold): `set_entity_assignment` idempotency-key/payload-drift on an assignment-changing routing-eval retry → wrong `auto_routing_failed` audit + missing success breadcrumb (assignment still correctly applied; no corruption; pre-existing; not P0/P1) → `audit-02-best-in-class-routing-2026-05-17.md` (new row #8) + `docs/follow-ups/i3-routing-eval-assignment-rpc-payload-drift-2026-05-18.md`. |
| 2026-05-18 | **P2-3** — duplicate migration-prefix epidemic | **CLOSED for this engagement's bar — renumber DONE upstream (PR #21); prefix guard now CI-ENFORCED (this session)** | Brief premise STALE on re-verification: the "11+" duplicate-prefix epidemic (incl. 00400/00406/00407/00410) + the Migration-smoke **RC1** red were ALREADY resolved by **PR #21 `ab980b28`** (`fix/ci-migration-prefixes`, merged 2026-05-18 by the integrator/data-model owner — exactly the "coordinate the historical renumber as its own reviewed PR with the owner" the brief prescribed; the colliding block was renumbered to a contiguous `00415–00427`). Independently verified on `audit-02-finish` (3-ahead/0-behind origin/main): **0 duplicate 5-digit prefixes** on disk AND on `origin/main` (427 files); `docs/follow-ups/ci-red-cascade-2026-05-18.md` present; `00428`/`00429` (this session's) unique. RC1 was a `schema_migrations` PK collision aborting `supabase db reset` (runtime, renumber-only-fixable — a detection guard could never have cleared it; PR #21's renumber did). **This session's contribution:** the recurrence guard `scripts/check-migration-prefixes.sh` existed + was wired into root `pnpm lint`, but **NO CI job ran root lint** (CI runs only per-package `@prequest/web|api` lints) → the guard was toothless and a future concurrent dup could slip in pre-merge (the exact RC1 mode). Added a `Migration prefix uniqueness guard` step (`run: bash scripts/check-migration-prefixes.sh`) to the `check` job in `.github/workflows/ci.yml` — the explicitly-recommended cheap fix (integrator verdict blocker #8 + audit ledger). | Guard verified exit 0 on current tree (427 files, 0 dups) so the new CI step is additive + green, not a new red. `ci.yml` re-validated as well-formed YAML after the edit (parsed; `check` job steps intact, new step between "Phase 8 naming-allowlist drift gate" and "Typecheck web"). Diff purely additive (12 ins / 0 del). User-authorized the CI-pipeline edit. Renumber/RC1 closure CI-verified upstream per `ci-red-cascade-2026-05-18.md` (PR #21: `check`+`migration-smoke` red→green); RC6/B.0 separately resolved (`e842ef12`, on main). | **Renumber: DONE upstream (PR #21) — NOT this session; the brief's "don't renumber unilaterally / coordinate with the owner" is now moot (the owner already did it correctly).** Recurrence guard: now CI-enforced (this session, user-approved). **Still open + correctly deferred (cosmetic, owner):** the `00410`→`00427_update_entity_combined_v7_satisfaction` `comment on function` mismatch (comment says satisfaction "handled symmetrically" but v7 raises `satisfaction_unsupported_for_work_order` for WOs) — zero behavioral impact; rides the **next** `update_entity_combined`/grant touch (no migration push solely for a comment), owner = whoever next touches that RPC. Relates to **#6**: the Migration-smoke CI red is already cleared upstream by PR #21's renumber (not by this guard); this guard prevents *recurrence*. Continuation-table NOT mirrored for P2-3 (deliberate — to stop perpetuating the known dual-ledger-table drift; consolidation is part of the final 02+00 reconciliation step). |
| 2026-05-18 | **P1-5 FE-rollup** — sub-issue progress under-reports for scoped-out actors | **CLOSED (code: thin BE privileged-aggregate endpoint + FE single-source; security model verified clean; disclosure boundary documented honestly)** | New `TicketService.getChildTasksRollup(parentCaseId)` + `GET /tickets/:id/children/rollup` → `{done,total}` only: IDENTICAL precondition to `getChildTasks` (`assertVisible(parent,'read')` + SYSTEM bypass), **tenant-scoped both count queries** (`.eq('tenant_id', …)`, #0 invariant), `head:true` so zero row data, `done = status_category in ('resolved','closed')`. FE: `ticketKeys.childrenRollup` + `useWorkOrdersRollup` (useQuery+handleQueryError); `SubIssueProgress` + `sub-issues-section` single-source done/total from the rollup, child LIST stays `work_order_visibility_ids`-filtered (**P1-5 intact**), removed the `data.length===0⇒null` suppression, "Some sub-issues may be hidden" tooltip when `visible<total`, "No visible sub-issues" state. No DB migration (TS+FE only). | codex pre-impl design-check → **PREFERRED-WITH-CHANGES** (new sibling endpoint not array-mutation; rollup-key + invalidation; remove length===0 suppression; safety boundary {done,total}-only — all folded). `/full-review` 2-agent: **security model independently verified CLEAN** — code-reviewer exhaustively traced `assertVisible(parent,'read')`: NO ctx passes parent-read with `!user_id && !has_read_all`, so the one omitted `getChildTasks` line is unreachable dead-defense (no precondition drift / not more permissive); both counts tenant-scoped; `head:true` zero-row (supabase-js v2 precedent); done/total exact-match; `parentId`-from-context resolves for the detail-surface hooks. **3 real FE bugs folded:** C1 (`ticket-context-menu` quick-status close used `useUpdateTicket` which never invalidated `childrenRollup` → stale ring on the PRIMARY close path) + item-7 (`useWorkOrders.refetch` missed `childrenRollup` → reclassify-nonce drift) + item-5 (`hasHidden` flicker before list settles). web tsc/build + api tsc + errors:check green; ticket specs 20/20 + 32 pass/2 skip, none weakened. | **I1/I2 (spec-overclaim) — corrected, product-owner-approved (NOT papered):** `/full-review` plan-agent showed `visibility.md` §7 overclaimed "no per-row identity leak / equivalent to the tenant-wide reporting precedent" — at small N (`total=1,visible=0,done=1`) a parent-`read`-able actor (incl. the requester/watcher class at the *endpoint* level — the desk FE route redirects non-`agent`s so the practical FE surface is the scoped operator; requester is the direct-API edge) infers the single hidden child's existence + done-state (NOT identity/vendor/assignee — P1-5's core stays intact at every N). User chose **"document accurately + ship"**: §7 rewritten to state the **bounded** disclosure honestly (per-parent ≠ tenant-wide; what's exposed vs protected; why accepted = the slice's purpose is true progress for legitimate oversight & existence+done ≪ which-vendor) + a tracked **residual lever** (gate the endpoint on operator-tier perm instead of the broad `read` floor if the requester-class direct-API edge is ever deemed unacceptable — not a current defect). Continuation-table NOT mirrored (same dual-ledger-drift discipline as the P2-3 row; consolidated at final reconciliation). |
| 2026-05-18 | **CI reds** — bisect/route | **DISPOSED — brief's red-list fully STALE (verified GREEN on origin/main); 1 branch-introduced red FIXED; 1 foreign infra red ROUTED-with-evidence** | gh-authed verification of `origin/main@218f781d`: the `ci` workflow run **`26027689859` = SUCCESS (3/3 jobs green)** — "Design check + typecheck" ✓, "B.0 concurrency harness" ✓ (ran for real 4m50s, not vacuous), "Migration smoke (db:reset + invariants)" ✓. `docs/follow-ups/ci-red-cascade-2026-05-18.md` RC1–RC6 ALL RESOLVED upstream: RC1–RC5 via PR #21 `ab980b28` (renumber + ripgrep + naming + eslint), RC6 (B.0 fixture drift) via PR #23 `e842ef12`. The brief's named reds map: "Design-check+typecheck"/"Migration-smoke" = RC1–RC5 (fixed), "B.0 concurrency" = RC6 (fixed), "B.2 config-reads" = RC2 (a *step* in `check`, not a job; fixed). **None are red on current main.** | **Branch-introduced red — FIXED (mine, not foreign):** `/full-review`-class CI investigation caught that this branch's `apps/api/src/modules/ticket/dispatch.idempotency.spec.ts:4` (added by `a47cdc48`, the #1 B.2 guard) carried a bare `…/reservations/…` path token in a comment → tripped `check` job's `pnpm naming:check-allowlist [api]` (Phase-8 gate pattern `\breservations\b`), not on the api allowlist. Reworded the comment to drop the path literal (kept the cross-ref by spec filename). Verified: `pnpm naming:check-allowlist` → **OK both scopes** (api 383 / web 149 refs); guard spec still **4/4**; `check-migration-prefixes.sh` exit 0; 00428/00429 trip no `ci-migration-asserts.sql` invariant + apply clean in fresh ordered db:reset; `errors:check-app-errors` green. So the branch re-greens `check` and adds no other red. | **Foreign infra red — ROUTED with evidence (not a code SHA):** the `deploy` workflow's **Deploy-api (Render)** job fails `Render trigger failed with HTTP 401` (bad/expired `RENDER_API_KEY` secret) — run `26027689837`. NOT code, NOT bisectable, pre-existing on EVERY main push since ≥PR #17, and `deploy.yml` triggers `push:[main]`+`workflow_dispatch` ONLY (never `pull_request`) so it does **not** gate this PR. Already recorded as cascade-doc owed-follow-up #3 ("deploy separately red — environment/secrets, unrelated"). **Owner = whoever holds the `RENDER_API_KEY` secret** (rotate/refresh it); evidence: `gh run view 26027689837` → `render` job `HTTP 401`. Satisfies brief #6 "fixed-or-routed-with-SHA" (routed-with-precise-evidence; it is a secret, not a commit). Continuation-table NOT mirrored (same dual-ledger-drift discipline; consolidated at final reconciliation). |
| 2026-05-18 | **P2-2 residual** — `RoutingService.recordDecision` entity_kind via 00230/00232 derive-trigger | **DISPOSITIONED — LEAVE + DOCUMENTED (codex design-checked; accepted correct-convention split, NOT a defect)** | The 2026-05-16 P2-2 row already accepted this as a convention split; the brief asked to codex-design-check (only if pursuing full write-time uniformity) else leave+documented. Read-only investigation + live remote: the SOLE prod caller of `recordDecision` is the `rerun_resolver` reassign path (`ticket.service.ts:1436`) which always passes a CASE id (same id given to `set_entity_assignment` `p_entity_kind:'case'` at :1411); reclassify spec asserts recordDecision is NOT called by reclassify; case-create writes routing_decisions inside `create_ticket_with_automation` (not via recordDecision); dispatch/WO call `evaluate()` only. The live 00232 BEFORE-INSERT trigger (body verified) deterministically derives `entity_kind='case'`+`case_id` for that path (post-1c.10c `tickets` is case-only, no UUID overlap). Live `routing_decisions`: 973 rows, **0 null entity_kind, 0 bad entity_kind, 0 case-rows with null case_id**; 41 `manual_reassign` (the recordDecision path) rows all correct non-null `entity_kind='case'`. NOT a missing/wrong value. | codex design-check (2026-05-18, prompt-to-file) → **LEAVE-DOCUMENTED**: "no concrete correctness gap write-time uniformity would close … the 00232 trigger deterministically maps that id to entity_kind='case' … the concurrent-delete branch is an append-only-durability edge, not the original P2-2 missing/wrong-entity_kind defect … explicit-at-write would not make the audit semantically stronger enough to justify touching shared routing/create/reclassify surfaces now." | **No code change.** Disposition = accepted correct-convention split (explicit-at-write for the high-blast reassign + routing-eval sites — already closed; trigger-derive for the shared append-only `recordDecision` writer — correct + reliable + live-verified). **Full write-time uniformity ROUTED as an explicit out-of-audit-02 future-workstream note** (the lever is threading `entity_kind` into `recordDecision`'s signature — touches create/reclassify — or deprecating the 00230/00232 trigger; both out of audit-02 scope, zero correctness benefit). Documented here so it is not re-discovered as a bug. Continuation-table NOT mirrored (same dual-ledger-drift discipline; consolidated at final reconciliation). |
| 2026-05-19 | **audit-02 RECONCILE (codex decision: canonical = C)** — two divergent audit-02 lineages reconciled onto main | **D-A02-1/-2 ALREADY-ON-MAIN (no-op); D-A02-3 N/A; D-A02-4 PORTED (code + specs); ACTIVE-BREAK restore migration 00433 authored (remote-apply = orchestrator's gated step)** | Two divergent audit-02 remediations existed: `origin/main` carries the CANONICAL lineage (`set_entity_assignment` == `supabase/migrations/00425_set_entity_assignment_v3_clear_routing_status.sql`); a divergent branch (`feature/booking-audit-remediation`) shipped lineage 00416/00418/00419 and OUT-OF-BAND pushed its `00419` body to the SHARED REMOTE, so the live remote `set_entity_assignment` is now that foreign v3.2 (ACTIVE-BREAK: spurious activity / `ticket_assigned` events on pure status-clears). codex 2026-05-19 decided **canonical = C** (keep main's lineage). Actions taken in worktree `worktree-audit-02-reconcile-d-a02`: **(1)** new forward-only migration `supabase/migrations/00433_restore_set_entity_assignment_main_v3_after_remote_reconcile.sql` reproduces main's `00425` `create or replace` body **byte-identically** (independently re-verifiable: `md5` of the comment-stripped `create…$$…EOF` region of 00433 == that of 00425 — both `c72651d0c235eb73221f87fefde1418a`; only the leading header comment differs) so the orchestrator's gated remote-apply restores the canonical body. **(2)** D-A02-1 (SLA resolves `users.id`→`persons.id` before adding the outgoing assignee to watchers) + D-A02-2 (routing-eval handler sets `chosen_*` from the resolver target) are **ALREADY ON MAIN** — verified by reading `sla.service.ts` `applyReassignment` (`resolveUserPersonId` tenant-scoped) + `routing-evaluation.handler.ts` step-6 (`target?.kind` → `chosen_team/user/vendor`); no code owed. **(3)** D-A02-3 **N/A on main** — main's `set_entity_assignment` (00425) has NO RPC-`decision` payload path (the divergent 00419 introduced `decision`; main never did). **(4)** D-A02-4 (caller-side `command_operations` success-probe before the mutable-payload recompute → closes the `payload_mismatch` poison) **PORTED**: new standalone helper `apps/api/src/common/command-operations-probe.ts` (`probeCommandOperationSuccess`, tenant-scoped on the table PK) + integrated into the 4 main callers — `sla.service.ts` `applyReassignment` (return true → fireThreshold's crossing-anchor completes the stuck escalation once), `ticket.service.ts` `reassign` (return getById; AFTER perm/visibility gates), `work-order.service.ts` `reassign` (return shared `refetchContracted()`; AFTER `assertAssignPermission`), `outbox/handlers/routing-evaluation.handler.ts` (log+return → outbox ACK) PLUS the retryable/terminal RPC-error split (`mapRpcErrorToAppError` `unknown.server_error` ⇒ transient ⇒ plain throw → outbox redelivers, same idiom as `sla-timer-repoint.handler.ts:93`; registered code ⇒ terminal ⇒ `markRoutingFailure`+return — fixes the pre-existing bug where ALL `rpcRes.error` unconditionally consumed the event). Only `'success'` short-circuits; `'in_progress'` falls through. NO migration (the RPC's authoritative WRITE-side gate is untouched; defense-in-depth). **Narrower than the divergent branch's port:** main's `ticket.service.reassign` ALREADY had the `client_request_id` check + `idempotencyKey` hoisted above the resolver re-eval, so that sub-change of D-A02-4 was a no-op on main and is NOT duplicated. Commits: `8de7d6c2` (00433 restore) · `b98bb641` (D-A02-4 port) · this docs row. | `pnpm -C apps/api lint` (tsc --noEmit) **green, 0 errors**; `pnpm errors:check-app-errors` **green** (0 raw throws / 35 modules — the handler's plain `throw new Error` is the sanctioned outbox-transient idiom, not a NestJS class). Touched suites **54/54** (`sla.service` +3, `ticket-reassign-rerun-resolver` +1, `ticket-permissions` harness-only, `work-order-reassign` +1, `routing-evaluation.handler` +5); broader regression sweep `sla`/`ticket`/`work-orders`/`outbox`/`workflow` **508 passed / 2 pre-existing skips / 0 fail**. 00433 SQL parse-validated in a rolled-back tx against a schema-loaded local Postgres (`CREATE FUNCTION`/`REVOKE`/`GRANT`/`COMMENT`/`NOTIFY` all OK; rolled back — no DB mutated; remote untouched per worktree-isolation rules). | **Remote-apply of 00433 is the ORCHESTRATOR's gated step** (no `db:push`/psql-to-remote/`git push` from this worktree; the ACTIVE-BREAK on the shared remote is only RESOLVED once the orchestrator applies+verifies 00433). Divergent-lineage migrations 00416/00418/00419 (and any other divergent change) are **NOT brought** per codex canonical=C. Append-only respected: zero prior rows / frozen mirrors / SUPERSEDED sections mutated; this is a single new ledger row. Continuation-table NOT mirrored (same dual-ledger-drift discipline as the 2026-05-18 rows; consolidated at final reconciliation). Smoke deferred to the orchestrator's gated step (shared dev server). |
| 2026-05-18 | **Cross-session drift — `set_entity_assignment` direct-remote re-push** | **ROUTED (not absorbed) — discovered by the post-merge survived-concurrent re-verify gate** | The audit-02-finish Step-0(c) baseline recorded live `set_entity_assignment.routing_status_unsupported = t` at session start; post-merge (re-checked 2026-05-19) the same exact query returns `f`. The live body is still a valid `clear_routing_status`-v3 body but **dropped the explicit work_order+`clear_routing_status` fail-loud raise** (the v3 D5 guard P1-2 shipped via 00406/00425). `git log 218f781d..e3302060 -- *set_entity_assignment* *00425*` is EMPTY (NONE of PR #24's 8 commits touch it) and `origin/main` never advanced past the PR #24 merge `e3302060` → a **concurrent workstream re-pushed `set_entity_assignment` directly to the shared remote DB** (PR#20-clobber-class, on a prior-slice P1-2 deliverable, NOT this continuation's scope). | Proven by observation (exact Step-0 query re-run twice post-merge; single overload; body lacks the token; ALL PR #24 deliverables independently re-verified intact on the same remote at the same time). Functional reachability: `RoutingEvaluationHandler` is case-only by construction → the dropped WO+flag raise is an **unreachable path → no *proven* live functional regression** (loss of defense-in-depth only). | **NOT absorbed** (foreign concurrent mutation; out of PR #24 scope; folding would risk a redefinition war + masking the owner's intent). **Routed with precise evidence** → `set_entity_assignment` / B.2 / P1-2 owner: self-contained record at `docs/follow-ups/cross-session-set-entity-assignment-remote-drift-2026-05-18.md` (evidence, reachability analysis, the plausible secondary `spurious assignment_changed` smoke-flake mechanism, the live↔source `db:reset`/CI divergence hazard, recommended owner actions). Continuation-table NOT mirrored (same dual-ledger-drift discipline). |
| 2026-05-21 | **FOLLOW-UP-A02-1** — SLA cron reentrancy guard | **CLOSED (code + spec + docs + live smoke)** | `SlaService.checkBreaches()` now uses a class-level `checkBreachesInFlight` guard and releases it in `finally`; overlapping minute ticks return before running breach / at-risk / threshold passes. The existing `checkBreaches` body was moved behind private `runBreachCheck(now)`; no DB migration and no production-visible test/debug trigger. `docs/assignments-routing-fulfillment.md` documents the no-overlap contract. `docs/smoke-gates.md` records that `smoke:tickets` remains a real-cron live probe and why no HTTP hook was added. | `pnpm -C packages/shared build`; `pnpm -C apps/api test src/modules/sla/sla.service.spec.ts` → 13/13 pass (2 new guard specs); `pnpm -C apps/api lint` → green; `pnpm errors:check-app-errors` → green (0 raw throws / 45 migrated modules; 0 raw rethrows / 37 swept modules). Live Worker-backed API run on `:3001` from the audit worktree: `pnpm smoke:tickets` → **123 pass / 0 fail** including the real SLA escalation cron probe; `pnpm smoke:work-orders` → **125 pass / 0 fail**. | This closes the follow-up called out after the audit-02 re-review: overlapping scheduler ticks now skip instead of racing. The already-shipped crossing unique key + `command_operations` protections remain the durable DB/idempotency layer; this change removes the in-process overlap window. Future SLA escalation changes still require the real-cron `pnpm smoke:tickets` gate. |

### Reconcile — post-merge full-review adjudication (2026-05-19, append-only)

A final adversarial `/full-review` (2 fresh-context agents) + a codex execution-check ran on PR #28. Code reviewer = SHIP (independently re-derived: `00433` body byte-identical to `00425`; history-replay `…00425…00427[calls]…00433` converges to exactly the canonical body == live remote; D-A02-4 port composes with main's *real* `outbox.worker` bounded-retry→dead-letter + `mapRpcErrorToAppError` taxonomy — no infinite-storm). Design reviewer raised C1 + I1–I3; adjudicated:

- **C1 (REQUEST-CHANGES driver) — DISSOLVED by source inspection.** Claim: the divergent push may have mutated remote objects beyond `set_entity_assignment` that `00433` doesn't restore. Verified: `git show feature/booking-audit-remediation:supabase/migrations/004{16,18,19}_*.sql` each contain ONLY `create or replace function public.set_entity_assignment` + `grant/revoke execute on function` *on that function* — zero CREATE/ALTER TABLE, zero other-object DDL/grants. **The divergent audit-02 push's blast radius is exactly one object (by inspection, not assertion); `00433` fully reverses it.** The reviewer conflated migration numbers: `00417_revoke_browser_execute_grants` is explicitly **"(RLS Audit 04)"** — a separate concurrent workstream, never part of audit-02's push and out of audit-02's reconcile scope (audit-04 owns 00415/00417). No other-object collateral exists from audit-02's divergent push.
- **I1 (handler retryable/terminal split = scope-creep?) — resolves with context.** That split is the IMPORTANT-half of codex's CR2 **D-A02-4** finding (codex explicitly flagged "routing handler terminally consumes transient-error events" as part of D-A02-4), not an independent bugfix smuggled into the reconcile. It is in-scope by construction; code reviewer independently verified it composes safely with main's bounded-retry worker.
- **I2 — TRACKED RESIDUAL (not a PR-28 blocker): no DB-level fence prevents a future out-of-band clobber** of `set_entity_assignment` on the shared remote (the concurrent audit-04 session or a re-run of `feature/booking-audit-remediation` could re-push). `00433` correctly fixes the symptom; recurrence-prevention is a systemic/process fix (shared-remote push discipline; the migration-prefix-uniqueness CI guard already added on main for P2-3 partially covers the prefix-collision angle, not the function-clobber angle). Flagged explicitly, deliberately out of "restore + port D-A02-4" scope.
- **I3 — TRACKED RESIDUAL (not a PR-28 blocker): `feature/booking-audit-remediation` remains a divergent, do-not-merge branch** with its own `00416/00418/00419` set_entity_assignment files + audit-doc edits. In-repo neutralization (a SUPERSEDED/DO-NOT-MERGE marker on that branch) is intentionally NOT done here — that branch has a live concurrent audit-04 session and the shared-tree-hazard rule forbids touching it. Mitigation = the memory record (`project_audit02_workstream_state`, cross-linked) + recommend the human de-commission that branch's audit-02 portion once the audit-04 session settles.

**Status:** remote-apply of `00433` DONE + verified (single overload, canonical body, divergent `decision`/provenance path absent — ACTIVE-BREAK resolved); PR #28 open to `main`, mergeable (0 behind origin/main), no C1/blocking finding outstanding; I2/I3 are documented residuals, not merge blockers.

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

#### Update — 2026-05-17 — Slice 8 live-smoke PASSED (the ship gate)

- **Original state:** 2026-05-16 deferred the entire Slice-8 probe set "with
  owner + per-finding risk" — the single largest gap to best-in-class, since
  CLAUDE.md makes live smoke the ship standard precisely because unit/
  code-review miss real-DB regressions (2026-05-01 P0).
- **Status:** CLOSED — authored, registered, and **independently re-run green
  by the orchestrator (twice, post-fold), not merely by the authoring
  subagent**: `smoke:tickets` 122 pass / 0 fail exit 0; `smoke:work-orders`
  125 pass / 0 fail exit 0; **zero CONTENTION-DEFER triggered on any of 3
  full runs**.
- **Approach:** the 2026-05-16 blocker was contention on the shared `:3001`
  runtime (server-code provenance unattributable + fixture collision). Solved
  by (a) building + running an API server from THIS worktree on `:3010`
  (provenance attributable — `:3001` runs the divergent
  `feature/booking-audit-remediation` branch with ±368/176/463 lines in the
  exact ticket/WO/SLA code under test), and (b) per-run isolated fixtures
  (unique RFC-4122-v4 uuids, `psql session_replication_role='replica'` seed,
  `finally` teardown) + server-agnostic idempotent-outcome assertions, so the
  still-shared remote DB + concurrent cron never make a probe flaky. A scoped
  CONTENTION-DEFER escape hatch exists for the one SLA crossing-anchor
  ordering sub-assertion; it never fired.
- **Adversarial-reviewed:** a fresh-context reviewer hunted vacuous/fake-green
  probes — verdict: NO CRITICAL, no fake-green, no existing probe weakened
  (1527 insertions, 3 doc deletions only); the P1-5 security probe is
  genuinely sound (proven it goes red on the exact `ticket.service.ts`
  visibility-filter revert). 2 IMPORTANT findings folded: probe-9's audit
  assertion tightened from a `length>=1` count-proxy to
  `metadata.event='reclassified'` (per `00355_reclassify_ticket_v2.sql`:
  332-338); the SLA CONTENTION-DEFER backstop made self-verifying (asserts
  the seeded case is not pre-assigned to the escalate target, so a future
  seed change can't silently hollow the backstop).
- **No genuine product regression** found across all 10 probes. One apparent
  P1-5 "leak" was traced to intentional pre-existing operator-scope semantics
  (empty domain/location scope = tenant-wide operator tier, `00374`
  unmodified vs main) and the probe corrected to the zero-role planning
  requester seed (`00381`) — the P1-5 remediation itself is correct.
- **Risk discharged:** the 2026-05-16 per-finding risk ("the live HTTP→DB
  happy/replay paths of the closed surfaces are unverified end-to-end") is
  now discharged for all 10 enumerated probes. Best-in-class bar MET — see
  the Closure Ledger "Best-in-class status" 2026-05-17 row.

#### Update — 2026-05-18 — Post-PR#20 concurrent-merge integrity re-verification

A concurrent session merged PR#20 (booking-audit-remediation) onto
`origin/main` immediately after audit-02's PR#18, so "merged + verified" was
re-checked against the ACTUAL post-PR#20 tree (the user pushed back —
"continue try again" / "are you fully done" — correctly: there WAS post-merge
work).

- **audit-02 survived (git):** PR#18 merge `362c45f1` + all 5 audit-02
  commits are ancestors of `origin/main` `4c4ba587`. The two flagged PR#20
  reconciliation touch-points verified: `buildReassignIdempotencyKey`
  unchanged (PR#20 idempotency.ts diff is purely additive after L420);
  CLAUDE.md `smoke:tickets` present in both commands list + mandatory matrix.
- **Regression found + fixed (audit-02's own contribution clobbered):**
  PR#20's 105-line `error-codes.ts` merge dropped one of audit-02 P2-1's two
  insertions of `ticket.work_order_id_on_case_endpoint` — the **runtime
  array** entry (the **type-union** survived, so `ticket.service.ts:1043`
  still compiles → no build break, but the P2-1 error would render as
  `unknown.server_error` at runtime). Restored at `error-codes.ts:1203` on
  branch `audit-02-pr20-reconcile-fix` (off `origin/main` 4c4ba587).
  tsc + `errors:check-app-errors` green on the merged-main+fix tree. This is
  the exact cross-session reconciliation-drift class the project has been
  burned by — caught by an explicit post-merge survival audit, not assumed.
- **No RPC-body overwrite:** PR#20's colliding `00406`/`00410` files
  (`00406_room_booking_rule_with_workflow_rpcs`,
  `00410_fix_applied_rule_ids_validates_room_rules`) do NOT redefine
  `set_entity_assignment` / `update_entity_combined`. Remote bodies
  re-verified via `pg_get_functiondef` — still audit-02's v3 (`t|t`) / v7
  (`t|t|t`); 00410's `comment on function` still reads "00410 v7 (audit-02
  P1-3)". The new 00400/00406/00407/00410 on-disk collisions are the P2-3
  `db:reset` epidemic (worsened, still integrator/data-model-owned), not
  remote corruption — codex Q1/Q2 "safe-as-merged" still holds live.
- **Pre-existing B.2 dispatch defect discovered + ROUTED (not absorbed):**
  the dispatch idempotency-replay probe, re-run against the real merged main,
  deterministically (3/3) hit `payload_mismatch` 409 on replay because
  `00341:153` md5-hashes the whole `p_payload` including the now()-derived
  `timers.due_at` (`dispatch.service.ts:255-265,309`) once an SLA resolves
  (tenant A: 9 sla_policies). Same bug-class PR#20's own 00407 fixed for
  booking-edit; dispatch was never fixed; pre-PR#20 it was dormant (the
  probe's minimal dispatch then resolved no SLA). NOT audit-02 / NOT this
  continuation / NOT a PR#20 code regression — a latent B.2 defect surfaced
  by the audit-02 gate doing exactly its job. Safety holds (deterministic
  `child_id` ⇒ no duplicate WO, hard-asserted 3×). Routed to the B.2/dispatch
  owner with confirmed root cause + the 00407-pattern fix prescription
  (`audit-02-best-in-class-routing-2026-05-17.md` §5). Probe 8 hardened: the
  no-duplicate safety invariant stays a hard pass/fail; only the out-of-scope
  "replay returns cached id" sub-assertion is downgraded to an explicit,
  fingerprint-scoped, loudly-logged `[KNOWN-DEFECT]` carve-out (mirrors the
  adversarially-validated SLA `CONTENTION-DEFER`; not a fake-green — any
  non-matching failure still hard-reds).
- **SLA P0-2 command_op-visibility sub-assertion — observability flake,
  carve-out extended (NOT a product defect, NOT routed):** under the same
  still-active concurrent `:3001` shared-cron load, the SLA-escalation
  probe's *corroboration* poll for the `sla:escalation:*` `command_operations`
  row flaked **non-deterministically** (PASS/FAIL/PASS/FAIL/FAIL across 5
  data points on identical code+server — the defining flake signature, vs
  the dispatch defect's 3/3 determinism). In **100% of runs the functional
  P0-2 invariant held** (`✓ assigned_team_id moved to escalate target` +
  `✓ recurrence-safe`); since `set_entity_assignment` writes
  `command_operations` in the SAME transaction as the assignment (remote
  body verified `t|t`), assignee-moved ✓ proves the row exists by
  construction — only the probe's SELECT observation lagged under load. The
  existing adversarially-validated `!anchorRow` CONTENTION-DEFER was
  extended to this sibling sub-assertion, **fingerprint-scoped** to
  `(cmd_op-miss ∧ anchor-observed ∧ assignee-moved-to-escalate-target)`;
  any other signature (assignee did NOT move) still hard-reds. **Verified:**
  7/7 consecutive post-carve-out green E2E runs (carve-out does not
  over-fire — cmd_op still hard-passes when it propagates) + a deterministic
  unit-proof of the demotion accounting against the REAL captured flake
  fingerprint (demotes it → fail 0) AND a real-regression case
  (assignee✗ → stays fail 1, NOT masked) AND a no-escalation case (stays
  fail 1). The live flake did not recur post-edit (concurrent contention
  subsided), so the demotion path is proven by deterministic logic-test
  against real failure data + structural identity to the validated
  anchor-defer, not by a stochastic live observation (stated honestly — no
  overclaim).
- **Net:** audit-02's own scope remains MET on the post-PR#20 tree; one
  cross-session regression to audit-02's code was caught + fixed; one
  pre-existing foreign-subsystem defect was discovered + honestly routed.
  "Fully done" for audit-02 ⇒ yes; the routed B.2 dispatch fix + the
  standing deferrals (Code-I1, P2-1 split, P2-3 renumber, P1-5 FE) are
  explicitly owned elsewhere with risk stated.

#### Update — 2026-05-18 — B.2 dispatch idempotency-replay FIXED (00428) + C1 caught + I2 routed

The pre-existing B.2 dispatch idempotency-replay defect routed in the prior
2026-05-18 block (and `audit-02-best-in-class-routing-2026-05-17.md` §5) is
now **FIXED, SHIPPED, and live-verified**. The probe carve-out it carried is
**removed** — probe 8 is a strict hard gate again.

- **Fix shipped + verified:** migration
  `supabase/migrations/00428_dispatch_idempotency_intent_hash.sql` pushed to
  the shared remote 2026-05-18 + `pg_get_functiondef`-verified live. New
  `public.dispatch_strip_hash_server_fields(jsonb)` (recursive, immutable,
  `language sql`, `search_path=public`; **path-scoped** — strips `due_at`
  ONLY from elements of a key literally named `timers`, so an arbitrary
  `routing_context.due_at` is preserved; `timer_type` /
  `target_minutes` / `business_hours_calendar_id` stay in the hash identity)
  + `public.dispatch_idempotency_payload_hash(jsonb)` =
  `md5(coalesce(strip(p)::text,''))`. Mirrors the 00407 booking-edit
  pattern. `dispatch_child_work_order` reproduced VERBATIM from the
  verified-latest single v3 (`00341_dispatch_child_work_order_v3.sql`) and
  `dispatch_child_work_orders_batch` VERBATIM from the verified-latest batch
  v3 (`00342_dispatch_child_work_orders_batch_v3.sql`), each with ONLY the
  `v_payload_hash` line changed (byte-diffs proved exactly one changed line
  per function). Review chain: codex pre-impl design-check
  (GO-WITH-CHANGES — path-scoped strip folded) → `/full-review` (2
  adversarial agents) → codex tertiary (GO-WITH-CHANGES — folded);
  lint + `errors:check-app-errors` green.
- **C1 — a real caught regression (recorded, not a hypothetical):** the
  batch RPC was INITIALLY reproduced from the **STALE**
  `00337_dispatch_child_work_orders_batch.sql` (v1). Because
  `create or replace` is last-writer-wins and 00428 is numerically last,
  pushing as-drafted would have **silently clobbered** `00342_..._v3`,
  reverting (a) the F-IMP-1 / codex-S8-I1 per-task `routing_rule_id` tenant
  validation (`perform public.validate_entity_in_tenant(p_tenant_id,
  'routing_rule',...)`) — a **P0 cross-tenant leak guard** — and (b) the
  F-CRIT-1 `sla_timers` polymorphic columns
  (`entity_kind`/`case_id`/`work_order_id`/`started_at`). Caught by the
  `/full-review` code reviewer; re-based on `00342` v3; live
  `pg_get_functiondef` confirms the routing_rule tenant-validate
  (×5 `validate_entity_in_tenant`, incl. the routing_rule gate guarded by
  `if v_routing_rule_id is not null`) + polymorphic cols are PRESERVED. This
  is the exact stale-source-clobber class the project's last-writer-wins
  migration model is vulnerable to — record it as a caught near-miss, not a
  clean pass.
- **Runnable structural guard:**
  `apps/api/src/modules/ticket/dispatch.idempotency.spec.ts` (mirrors
  00407's `assemble-edit-plan.idempotency.spec.ts` GUARD-2 static
  migration-text scan): resolves the numerically-highest migration defining
  each dispatch RPC + the strip helper; asserts the hash routes through
  `dispatch_idempotency_payload_hash`, no raw
  `md5(coalesce(p_(payload|tasks)::text`, helper is path-scoped (not
  neutered / flat / identity); 4/4 pass; demonstrably catches the C1
  stale-source-clobber class. Satisfies `feedback_runnable_guards_mandate`
  (no paper tiger — verified to go red on the regression it guards).
- **I1 accepted non-goals (recorded):** (a) a legitimate replay AFTER an
  SLA-policy edit (`target_minutes`/`business_hours_calendar_id` changed
  under the same `sla_id`) still 409s **by design** — those stay in the
  hash identity; the intent's SLA config genuinely changed, so fail-closed
  is correct. (b) 00428's header documents a forward-only caveat:
  pre-00428 `command_operations` rows are not rewritten, so a dispatch
  whose row was written pre-00428 then replayed post-00428 may still 409 —
  NOT a regression (that deploy-crossing replay was already broken by the
  very bug 00428 fixes).
- **Probe carve-out REMOVED — strict hard gate restored:** the
  `[KNOWN-DEFECT b2-dispatch-replay-sla-due_at]` probe-8 carve-out in
  `apps/api/scripts/smoke-work-orders.mjs` (`a2ProbeDispatchReplay`) was
  removed. Replay MUST return 200/201 with the same WO id;
  `payload_mismatch` on replay is now a hard fail. Proven GREEN **3/3
  deterministic** with fresh isolated fixtures: probe-8
  `✓ dispatch replay — same WO id both calls` on all 3 runs; no
  KNOWN-DEFECT line, no `✗`.
- **`smoke-tickets` FLAKE_INFRA characterization (recorded so it is NOT
  mistaken for a regression, and NO carve-out was added):** when run
  interleaved with 3× `smoke-work-orders` under concurrent-session
  shared-proxied-DB load, `smoke-tickets` flaked at **scattered** probes
  (P1-3 `a2ProbeSatisfaction`; P0-2 `a2ProbeSlaEscalation`/`a2GetCase`)
  with client-side `TypeError: fetch failed` / `ECONNRESET` (server healthy
  throughout; the failing probe passed on retry). Characterized
  **FLAKE_INFRA**: 5/5 fully green in ISOLATION (122 pass / 0 fail each,
  610 assertions, zero network errors). Not a code defect; 00428 is
  dispatch-only and cannot touch those probes; the Step-0 baseline was
  0/0/0 on the same code pre-push. Mitigation = run the final tickets gate
  in isolation. **No `smoke-tickets` carve-out was added** — it is green in
  isolation; weakening it would be fake-green.
- **I2 — a NEW sibling now()-in-hash bug discovered + ROUTED (not folded):**
  the same idempotency-hash bug-class exists on the **work-order PATCH
  SLA-install path AND the workflow-engine SLA-install path** (NOT the case
  path — that is a verified phantom; `buildPatchesPayloadForCase` never
  emits an `sla` branch, case SLA immutable). Producer
  `sla.service.ts:219`→`:236`/`:250`, consumed at
  `work-order.service.ts:584`/`:589` + `workflow-engine.service.ts:1907`,
  hashed by `update_entity_combined` v7 (latest `00427`:241-245) /
  `update_entity_sla` (latest `00330`:115). User-approved to **ROUTE not
  fold** (it is the smoke-gated mega-RPC, high blast radius; needs its own
  full review+smoke cycle). Routed to the B.2 / SLA-restart owner via the
  routing doc (`audit-02-best-in-class-routing-2026-05-17.md`, new row) +
  the self-contained follow-up doc
  `docs/follow-ups/i2-sla-install-idempotency-due_at-2026-05-18.md`. Risk
  if unfixed: spurious 409 on legitimate WO + workflow-engine SLA-install
  retries with a stable `X-Client-Request-Id` — correctness/ergonomics
  only, no data corruption (identical severity profile to the now-fixed
  dispatch defect).
- **Net:** the routed B.2 dispatch defect from the prior block is now
  CLOSED on remote with a runnable guard and a strict (carve-out-free)
  probe; one stale-source-clobber near-miss (C1) was caught in review
  before push; one NEW genuine sibling defect (I2) was discovered by the
  same `/full-review` and honestly routed (not silently absorbed) per
  user direction.

| Date | Finding / Slice | Status | Evidence | Verification | Notes |
|---|---|---|---|---|---|
| 2026-05-18 | **B.2 dispatch idempotency-replay** (routed 2026-05-18 §5) | **CLOSED — fixed on remote + strict probe restored** | `00428_dispatch_idempotency_intent_hash.sql` pushed + `pg_get_functiondef`-verified live (path-scoped `dispatch_strip_hash_server_fields` + `dispatch_idempotency_payload_hash`; both dispatch RPCs reproduced VERBATIM from verified-latest v3 — `00341`/`00342` — with one `v_payload_hash` line changed; byte-diff-proven). `smoke-work-orders.mjs` `[KNOWN-DEFECT]` probe-8 carve-out REMOVED → strict hard gate. New runnable guard `apps/api/src/modules/ticket/dispatch.idempotency.spec.ts` (4/4). | codex design-check → `/full-review` 2-agent → codex tertiary (all GO-WITH-CHANGES, folded); lint + errors:check green; **probe-8 GREEN 3/3 deterministic** (`✓ same WO id both calls`, fresh isolated fixtures, no KNOWN-DEFECT/✗); guard 4/4. | **C1 caught:** batch RPC was first reproduced from STALE `00337` v1 → would have silently clobbered `00342` v3's F-IMP-1 routing_rule tenant-validate (P0 cross-tenant guard) + F-CRIT-1 sla_timers polymorphic cols; caught by `/full-review`, re-based, live-verified preserved (×5 `validate_entity_in_tenant`, polymorphic cols). **I1 accepted non-goals:** post-SLA-policy-edit replay 409 by design; pre-00428 cmd_op rows not rewritten (forward-only, not a regression). **FLAKE_INFRA:** `smoke-tickets` flaked at scattered probes ONLY under concurrent shared-DB load (5/5 green isolated, 122/0); not code; NO carve-out added. **I2 routed** (NOT folded, user-approved): sibling now()-in-hash on WO + workflow-engine SLA-install via `update_entity_combined` v7 → `audit-02-best-in-class-routing-2026-05-17.md` (new row) + `docs/follow-ups/i2-sla-install-idempotency-due_at-2026-05-18.md`. |
| 2026-05-18 | **Code-I1** — routing-eval handler non-idempotent audit inserts under outbox redelivery (the 2026-05-17 RE-DEFERRED finding) | **CLOSED — fixed on remote + smoke 3× + I3 routed** | `00429_routing_decisions_outbox_event_unique_index.sql` pushed + `pg_indexes`-verified live: partial UNIQUE index `uq_routing_decisions_outbox_event` on `(tenant_id, (context->>'outbox_event_id'), chosen_by) WHERE context ? 'outbox_event_id'`, `indisunique=t` (index-only — remote pre-verified 0 dup groups / 0 null `chosen_by`, no dedup). `routing-evaluation.handler.ts`: both `routing_decisions` inserts → raw parameterised `this.db.query(... ON CONFLICT … DO NOTHING RETURNING id)` with the EXPLICIT conflict target byte-matching the index; per-site error semantics preserved (§6 success genuine-error THROWS / conflict-skipped → idempotent success; `markRoutingFailure` genuine-error WARN-only / conflict-skipped → silent success). `DbService` injected (DbModule `@Global`, no module-import change). | codex pre-impl design-check (Approach A explicit-conflict-target GO-WITH-CHANGES; B/.upsert invalid for an expression partial index, C catch-23505 weaker) → `/full-review` 2-agent (no CRITICAL; high-risk items — DbService BYPASSRLS/tenant posture == service_role, 12-col↔$1..$12 1:1, ON CONFLICT byte-matches index — verified; IMPORTANT-1 rollback-coupling + I-1 + N-3 folded) → codex tertiary (smoke replay hardened: scoped pre-clean + baseline isolation + `finally` teardown scoped by case-id AND a2 tenant; NUL-byte sanitiser on jsonb-bound fields). lint + errors:check green; handler spec 14/14. **`smoke:tickets` independently re-run isolated 3/3 exit 0** (123/0 each) — `a2ProbeRoutingEvalClear` `✓ routing-eval — same outbox event REDELIVERED, still exactly 1 routing_decisions row` all 3. | **Supersedes the 2026-05-17 "Code-I1 RE-DEFERRED" row** (left intact; appended). **Rollback-coupling (folded IMPORTANT-1, in the 00429 header too):** the handler's explicit `ON CONFLICT` target hard-requires 00429's index — dropping the index while the handler is deployed throws on EVERY routing eval → `audit_insert_failed` → outbox retry → dead-letter. Deploy index-first; forward-only; **never drop `uq_routing_decisions_outbox_event` independently.** **codex-tertiary NO-GO "item 3" was mis-scoped** (verified by reading handler L256-294: the cited control flow is ENTIRELY PRE-EXISTING + untouched by Code-I1 — Code-I1 only converts the routing_decisions insert and preserves the genuine-error-throw trigger). **I3 routed** (user-approved ROUTE-not-fold): `set_entity_assignment` idempotency-key/payload-drift on an assignment-changing routing-eval retry → wrong `auto_routing_failed` audit + missing success breadcrumb (assignment still correctly applied; no corruption; pre-existing; orthogonal; not P0/P1) → `audit-02-best-in-class-routing-2026-05-17.md` (new row #8) + `docs/follow-ups/i3-routing-eval-assignment-rpc-payload-drift-2026-05-18.md`. **`smoke:tickets` FLAKE_INFRA only under concurrent/interleaved load** (green isolated; mitigation = run the final gate isolated; no carve-out). |
| 2026-05-18 | **P2-1** — case-vs-WO `TicketService` split (codex-design-first per the brief) | **RE-DEFERRED (codex design-check attached; user-acknowledged) — interim guard = honest closure for this bar** | No code change this engagement. codex design-check run 2026-05-18 → RE-DEFER; user acknowledged the re-deferral 2026-05-18 (brief #3 bar permits a fresh user-acknowledged re-deferral with the design-check attached). The sole unsafe residual (a WO id misbehaving on `PATCH /tickets/:id`) is already neutralized by the shipped interim reject guard (`ticket.work_order_id_on_case_endpoint` 400, covers bulk; `aac61b7a`, 2026-05-17); the WO mutation surface is already fully separated into `work-orders/work-order.service.ts`. Self-contained design-check + prescription: `docs/follow-ups/p2-1-case-wo-split-design-check-2026-05-18.md`; see also `#### Update — 2026-05-18 — P2-1 codex design-check DONE → user-acknowledged RE-DEFER`. | N/A (re-deferral). codex confirmed NO latent cross-tenant hole in the `getById`/`loadTicketRow` WO-fallback (tenant-scoped + visibility-gated). Residual = ~1-eng-week READ-path layering hygiene with regression risk to 6 shipped audit-02 slices for ZERO P0/P1 — re-defer beats executing now in a live shared tree. | **Owner = integrator/data-model (Should-fix #16).** Prescribed: DELIBERATE HYBRID — one explicit *named* polymorphic READ resolver + HARD-SPLIT commands/kind-specific reads (case cmds stay in `TicketService`; WO mutations + `getChildTasks` + `createBookingOriginWorkOrder` → `WorkOrderService`). Invariants: (1) `PATCH /tickets/:id` keeps rejecting WO ids; (2) child-WO listing keeps parent `assertVisible(read)` THEN `work_order_visibility_ids` (00374) — parent visibility ≠ child-WO visibility (P1-5). Only wart: `createBookingOriginWorkOrder` placement (~2070); rewire `setup-work-order-trigger.service.ts:37`. Mirrors the canonical `## Closure Ledger` P2-1 2026-05-18 row (this continuation table is a tail-mirror of the 2026-05-18 set). |

#### Update — 2026-05-18 — Code-I1 CLOSED (00429) + I3 routed

The 2026-05-17 **Code-I1 RE-DEFERRED** finding (the routing-evaluation
handler's own two `routing_decisions` inserts being non-idempotent under
outbox redelivery — a replay could write a duplicate append-only audit
row) is now **CLOSED, SHIPPED, and live-verified**. The 2026-05-17 RE-DEFER
row + its `#### Update — 2026-05-17 — Code-I1 RE-DEFERRED` narrative are
left intact above — this is appended, not rewritten. The ready-to-apply
prescription recorded in the 2026-05-17 row was applied as written
(partial unique index + `ON CONFLICT DO NOTHING`), tightened by review.

- **Fix shipped + verified:** migration
  `supabase/migrations/00429_routing_decisions_outbox_event_unique_index.sql`
  pushed to the shared remote 2026-05-18 + `pg_indexes`-verified live:
  `CREATE UNIQUE INDEX uq_routing_decisions_outbox_event ON
  public.routing_decisions USING btree (tenant_id,
  ((context ->> 'outbox_event_id')), chosen_by) WHERE
  (context ? 'outbox_event_id')`, `indisunique=t`. The migration is
  **index-only** — the remote was pre-verified to have **0 duplicate
  groups and 0 null `chosen_by`** under the partial predicate, so
  `CREATE UNIQUE INDEX` cannot fail on existing data; no dedup step was
  needed or shipped. The 2026-05-17 prescription's exact-shape
  `(tenant_id, (context->>'outbox_event_id'), chosen_by) where context ?
  'outbox_event_id'` was honored.
- **Handler converted to the canonical idempotent write:** both
  `routing_decisions` inserts in
  `apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts`
  were converted from supabase-js `.insert()` to raw parameterised
  `this.db.query(... insert into public.routing_decisions (<12 cols>)
  values ($1..$12,$11::jsonb,$12::jsonb) on conflict
  (tenant_id,(context->>'outbox_event_id'),chosen_by) where context ?
  'outbox_event_id' do nothing returning id)`. `DbService` is injected
  (DbModule is `@Global` — the same provider `outbox.worker.ts` already
  uses; **no module-import change**). The EXPLICIT `ON CONFLICT` target
  byte-matches the 00429 index for arbiter inference.
- **Per-site error semantics PRESERVED (deliberate, asymmetric):**
  Site 1 (§6 success) — a genuine DB error still THROWS (the outbox
  retry contract is intact); a conflict-skipped replay
  (`rows.length===0`) → idempotent SUCCESS (debug log, no throw/warn).
  Site 2 (`markRoutingFailure`) — a genuine error stays WARN-ONLY
  (NOT escalated to throw: a throw in the failure-recording path could
  wedge the outbox); conflict-skipped → silent success. A defensive
  `let decisionRows: {id:string}[] = []` init (folded I-1) and a
  comment-accuracy fix (folded N-3) were applied.
- **Review chain:** codex pre-impl design-check returned "Approach A
  with EXPLICIT conflict target, GO-WITH-CHANGES" (folded); Approach B —
  a supabase-js `.upsert` — was proven invalid for an *expression
  partial* index, and Approach C — catch-23505 — is weaker.
  `/full-review` (2 adversarial agents) returned no CRITICAL; both
  designated high-risk items were verified correct: (a) `DbService`
  connects as Postgres role `postgres` (`BYPASSRLS`) — the SAME
  RLS-bypass/tenant posture as the supabase service_role the handler
  used before, **no security regression**; (b) the 12-col ↔ `$1..$12`
  mapping is 1:1 in BOTH inserts, no transposition; (c) `trace`/
  `context` are always non-null jsonb so no new throw surface;
  (d) outbox `event.id` is stable across redeliveries / `sweepStaleClaims`
  so the fix is not inert; (e) no other writer sets
  `context.outbox_event_id`, so the partial index constrains only this
  handler. codex tertiary hardened the smoke replay (per-run scoped
  pre-clean + baseline isolation + `finally` `outbox.events` teardown,
  all scoped by case-id AND the a2 tenant) and applied a NUL-byte
  sanitiser to the jsonb-bound `trace`/`context`/`failure_reason` so a
  NUL in a free-text exception message cannot make `$n::jsonb` reject
  and silently drop a failure audit row.
- **Rollback-coupling (folded IMPORTANT-1 — also documented in the 00429
  header):** the handler's EXPLICIT `ON CONFLICT` target **hard-requires**
  00429's index. If the index is dropped while the handler change is
  deployed, EVERY routing eval throws *"no unique or exclusion constraint
  matching the ON CONFLICT specification"* → `audit_insert_failed` →
  outbox retry → dead-letter. **Deploy index-first; forward-only; never
  drop `uq_routing_decisions_outbox_event` independently.**
- **Gates green:** `pnpm -C apps/api lint` (tsc --noEmit) +
  `pnpm errors:check-app-errors` (0 raw throws / 35 modules) green;
  `routing-evaluation.handler.spec.ts` 14/14 (10 pre-existing preserved
  via FakeDb + 4 new Code-I1 tests — the FakeDb positional reconstruction
  is a known column-transposition blind spot, mitigated by the manual
  1:1 verify in `/full-review` + the live smoke replay).
- **Smoke:** `smoke-tickets.mjs` `a2ProbeRoutingEvalClear` gained
  `✓ routing-eval — same outbox event REDELIVERED, still exactly 1
  routing_decisions row (Code-I1: ON CONFLICT DO NOTHING)`.
  Independently re-run by the orchestrator (not just the authoring
  subagent): **`smoke:tickets` 3/3 isolated, exit 0 (123 pass / 0 fail
  each)**; the routing-eval+replay probe was deterministically green on
  all 3 runs. `smoke-tickets` remains **FLAKE_INFRA only** under
  concurrent/interleaved load (green in isolation; mitigation = run the
  final gate isolated; no carve-out added — weakening it would be
  fake-green).
- **codex-tertiary NO-GO "item 3" was mis-scoped → routed as I3 (NOT a
  Code-I1 regression):** codex tertiary returned NO-GO on Code-I1 citing
  "item 3". Verified by reading the handler L256-294: the cited control
  flow (`applyAssignment` conditional payload → `set_entity_assignment`
  → `rpcRes.error` → `markRoutingFailure` + `return` BEFORE the §6
  success audit insert) is **ENTIRELY PRE-EXISTING and untouched by
  Code-I1** — Code-I1 only converts the `routing_decisions` insert and
  preserves the genuine-error-throw trigger, so item 3 exists
  IDENTICALLY before/after Code-I1. It is a separate defect in the
  `set_entity_assignment` idempotency-key/payload-stability design,
  orthogonal to the routing_decisions-dup Code-I1 scopes. The user
  explicitly chose **"Ship Code-I1 + route item 3"**. Routed (not
  folded) as **I3** → `docs/follow-ups/audit-02-best-in-class-routing-2026-05-17.md`
  (new "Summary for owners" row #8) + the self-contained follow-up
  `docs/follow-ups/i3-routing-eval-assignment-rpc-payload-drift-2026-05-18.md`.
  Risk if I3 unfixed: on a partial-commit retry or a plain redelivery of
  an **assignment-changing** routing-eval event, the assignment is
  correctly applied but the audit trail wrongly records
  `auto_routing_failed` and the success `routing_decisions` breadcrumb is
  missing — audit-integrity/ops-confusion only, NO wrong assignment, NO
  data corruption; pre-existing; not P0/P1 (same class/severity profile
  as the original Code-I1 dup-audit-row).
- **Net:** the 2026-05-17 Code-I1 re-deferral is now discharged on
  remote with the prescribed partial unique index + an idempotent
  `ON CONFLICT DO NOTHING` handler write, a live 3× smoke replay proof,
  and a recorded forward-only rollback-coupling caveat; the
  codex-tertiary NO-GO was proven to be a mis-scoped pre-existing
  defect (I3) and honestly routed — not silently absorbed — per user
  direction.

#### Update — 2026-05-18 — P2-1 codex design-check DONE → user-acknowledged RE-DEFER

The audit-02 brief mandated a **codex design-check before any further
P2-1 action** ("codex-design-first for P2-1"). That design-check was run
2026-05-18. The earlier P2-1 rows/blocks (the 2026-05-16 deferral, the
`#### Update — 2026-05-16`, the 2026-05-17 `#### Update — 2026-05-17 —
P2-1 cheap interim guard`, and their Closure Ledger rows) are **left
intact** — this is appended, not rewritten.

- **Verdict: RE-DEFER.** codex returned re-defer; the user
  **acknowledged the re-deferral** 2026-05-18. The brief's #3 bar
  explicitly permits "a fresh user-acknowledged re-deferral with the
  design-check attached" — this block + the new self-contained
  design-check doc are that attachment.
- **Decisive rationale (codex):** the ONLY unsafe residual the audit
  identified — a `work_order` id misbehaving on `PATCH /tickets/:id`
  (case-only validation on a WO row) — is **already neutralized** by the
  shipped interim reject guard (`TicketService.update()` raises the
  registered `ticket.work_order_id_on_case_endpoint` 400, covers bulk;
  commit `aac61b7a`, 2026-05-17). The WO **mutation** surface is
  **already fully separated** into
  `apps/api/src/modules/work-orders/work-order.service.ts` — the audit's
  "1978-line multi-day refactor" framing **predates that split**. What
  remains is purely layering/ownership hygiene: a ~1-engineer-week
  READ-path extraction touching the polymorphic `getById` resolver +
  P1-5 child-visibility + cross-module consumers, with regression risk
  to **6 shipped audit-02 slices** (incl. 2 live RPC migrations) for
  **ZERO P0/P1 content**, in a live multi-session shared tree. codex
  confirmed **NO latent cross-tenant hole** in the
  `getById`/`loadTicketRow` WO-fallback (tenant-scoped +
  visibility-gated). Honest closure for THIS engagement's bar (P2,
  non-completion-bar, sharp-edge neutralized) = the shipped interim
  guard + this design-check, routed to the owner.
- **Prescribed architecture FOR THE OWNER (if/when later executed):** a
  DELIBERATE HYBRID — keep ONE explicit, *named* polymorphic id-resolver
  for "id → visible entity" (genuinely kind-agnostic: `/tickets/:id`,
  reclassify reloads, generic detail, activities don't know kind a
  priori — a named shared READ contract, **NOT** the "neither" the audit
  criticized) **+** HARD-SPLIT commands and kind-specific reads: case
  `list`/`update`/`reassign`/inbox/`create`/`bulkUpdate` stay in
  `TicketService`; WO mutations + `getChildTasks` (child-WO listing) +
  `createBookingOriginWorkOrder` move to `WorkOrderService`. Consistent
  with the shipped reject-not-route semantics (command endpoints stay
  hard-split).
- **TWO must-not-regress invariants the owner must preserve:** (1)
  `PATCH /tickets/:id` must keep resolving the current row and rejecting
  `ticket_kind==='work_order'` with the registered
  `ticket.work_order_id_on_case_endpoint`; (2) child-WO listing must
  keep the parent-case `assertVisible(parent,'read')` precondition AND
  THEN filter children through the `work_order_visibility_ids` RPC
  (00374) — parent-case visibility must **NEVER** imply child-WO
  visibility (P1-5). Moving `getChildTasks` to `WorkOrderService` is
  safe ONLY if it still depends on the shared `TicketVisibilityService`
  for the parent precondition (the precondition is case-read logic, but
  that is not a reason to keep the method in `TicketService`).
- **Only real layering wart:** `createBookingOriginWorkOrder` living in
  `TicketService` (`ticket.service.ts` ~`2070`) — ownership/cleanliness,
  NOT a behavioral bug; one cross-module consumer to rewire:
  `apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts:37`.
- **Owner:** integrator / data-model (verdict **Should-fix #16**;
  ~1 engineer-week per the integrator estimate). **No code change this
  engagement** — the interim guard already shipped (2026-05-17); this is
  the codex-design-check attachment + the user-acknowledged re-defer.
- **Self-contained prescription for whoever picks up Should-fix #16:**
  `docs/follow-ups/p2-1-case-wo-split-design-check-2026-05-18.md` — the
  question asked, the verdict + rationale, the verbatim hybrid
  architecture, the precise residual surface (file:line), the two
  invariants, the scoped task list, the ~1-week estimate, the owner, and
  the "why re-defer is honest closure for the audit-02 bar" section. The
  integrator verdict's #16 reconciliation is folded into the final 02+00
  ledger reconciliation step (not edited here); the trail is complete
  via this block + the design-check doc.

#### Update — 2026-05-18 — Ledger reconciliation (dual-ledger-table drift resolved, append-only)

This is the final reconciliation step for the audit-02-finish continuation.
It exists because this file carries **two** ledger tables and they had
deliberately drifted (each 2026-05-18 row in the continuation table notes
"Continuation-table NOT mirrored … consolidated at final reconciliation").
Nothing is deleted or rewritten — this block is the consolidation.

- **Single source of truth:** the mid-file **`## Closure Ledger`** table
  (the one whose maintainer-rule header begins *"Maintainer rule: every
  agent that closes, partially closes, or deliberately defers a finding
  …"*). It is authoritative and holds all seven 2026-05-18
  audit-02-finish rows: **B.2 dispatch idempotency-replay (00428)**,
  **Code-I1 routing-eval `routing_decisions` idempotency (00429) + I3
  routed**, **P2-1 RE-DEFERRED (codex design-check attached;
  user-acknowledged)**, **P2-3 (renumber DONE upstream PR#21; prefix
  guard now CI-enforced this session)**, **P1-5 FE-rollup (privileged
  `{done,total}` aggregate; disclosure boundary documented honestly)**,
  **CI reds (brief red-list STALE → DISPOSED; 1 branch red FIXED; 1
  foreign infra red ROUTED-with-evidence)**, **P2-2 residual
  (DISPOSITIONED LEAVE+DOCUMENTED)**. Always read/extend the canonical
  `## Closure Ledger` — not the table below.
- **The second table is a FROZEN partial mirror — NOT authoritative, do
  NOT extend it.** The headingless continuation table inside
  `## 2026-05-17 — Best-in-class continuation pass` (immediately under
  the *"Net: the routed B.2 dispatch defect …"* paragraph; columns
  `Date | Finding / Slice | Status | Evidence | Verification | Notes`)
  is a stale tail-mirror. It mirrors only **three** of the seven
  2026-05-18 rows — **B.2 dispatch idempotency-replay**, **Code-I1**,
  and **P2-1** — and is intentionally NOT being completed (extending it
  would perpetuate the exact dual-ledger-table drift this block closes).
  It is preserved verbatim for history only.
- **Canonical-only rows the frozen continuation table OMITS** (present
  in `## Closure Ledger`, deliberately never mirrored below — go to the
  canonical table for these):
  1. **P2-3** — duplicate migration-prefix epidemic (CLOSED for this
     bar; renumber DONE upstream PR #21 `ab980b28`; prefix guard
     `scripts/check-migration-prefixes.sh` now CI-enforced via the
     `ci.yml` `check` job this session).
  2. **P1-5 FE-rollup** — `getChildTasksRollup` privileged
     `{done,total}` aggregate + `GET /tickets/:id/children/rollup` + FE
     single-source; `visibility.md` §7 disclosure overclaim corrected to
     a bounded-narrowing statement.
  3. **CI reds** — brief red-list verified STALE on origin/main
     `218f781d` (`ci` run `26027689859` SUCCESS 3/3); the one
     branch-introduced naming-allowlist red FIXED; Deploy-api(Render)
     HTTP-401 foreign-infra red ROUTED-with-evidence to the
     `RENDER_API_KEY` secret owner.
  4. **P2-2 residual** — `RoutingService.recordDecision` entity_kind via
     the 00230/00232 derive-trigger: DISPOSITIONED LEAVE+DOCUMENTED
     (codex design-checked; accepted correct-convention split, not a
     defect); full write-time uniformity routed as an explicit
     out-of-audit-02 future-workstream note.
- **No row is duplicated by this block.** The seven canonical rows live
  once, in `## Closure Ledger`. This is a pointer + freeze declaration,
  not a third copy of the ledger.
