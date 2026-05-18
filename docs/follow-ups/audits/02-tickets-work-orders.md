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

---

#### P1-3 — Satisfaction rating writes outside orchestrator (acknowledged)

**Evidence:**
- `apps/api/src/modules/ticket/ticket.service.ts:1127-1144` — after the orchestrator commits, a side `from('tickets').update({satisfaction_rating, satisfaction_comment})` runs separately. No audit row, no idempotency.
- Acknowledged in `b2-followups.md:63-73` as "not P0 because satisfaction submissions are infrequent + non-critical for SLA correctness."

**Impact:** orchestrator can fail and the satisfaction patch can succeed (or vice versa). Two-write divergence between idempotency cache and reality. Low traffic, but it's an open inconsistency in the API surface contract: same endpoint, mixed atomicity.

**Recommendation:** fold both fields into the metadata branch of the orchestrator. The b2-followups note already prescribes this — execute it.

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

#### P2-2 — `routing_decisions` inserts inconsistent on `entity_kind`

Three call sites:
- `ticket.service.ts:1382-1394` (case reassign): sets `entity_kind: 'case'`, `case_id: id`, `ticket_id: id` (legacy soft pointer).
- `work-order.service.ts:1000-1019` (WO reassign): sets `entity_kind: 'work_order'`, `work_order_id: workOrderId`, `ticket_id: workOrderId` (legacy soft pointer reused for the WO id — confusing).
- `routing.service.ts:65-85` (`recordDecision`, called by create + reclassify paths): **doesn't set `entity_kind`** — relies on the 00230 polymorphic-derive trigger.
- `routing-evaluation.handler.ts:246-264` (outbox handler): also doesn't set `entity_kind`.

The C5 code-review convention is "set them explicitly on both sides" per `ticket.service.ts:1377-1381` comment, but `routing.service.ts` and the outbox handler both rely on the trigger. The deterministic-at-write-time convention isn't applied consistently.

**Recommendation:** pick one (probably "always explicit") and fix the two remaining sites. Or drop the trigger as a deprecation step.

#### P2-3 — Duplicate migration prefixes in `00367-00400`

`ls supabase/migrations/ | tail -50` shows duplicate numeric prefixes for at least: `00367`, `00368`, `00369`, `00370`, `00371`, `00372`, `00373`, `00374`, `00376`, `00400`. Looks like two parallel branches merged without renumbering.

**Impact:** Supabase CLI orders by lexical filename. Two files with the same numeric prefix are ordered by alphabetical tail. As long as both apply cleanly that's fine, but readers can't reason about "what ran before what" without checking the alphabetic order. Future migrations writing `00401_*` then `0040_2` (typo) would land out of order without warning.

**Recommendation:** renumber on next migration batch; add a CI lint that catches duplicate prefixes.

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
| 2026-05-18 | **P0-2** — SLA escalation cron bypasses `set_entity_assignment` (Slice B) | **CLOSED (code; live smoke deferred to Slice F)** | `apps/api/src/modules/sla/sla.service.ts` — `applyReassignment` rewritten: the escalation assignment+watchers write now issues ONE `set_entity_assignment` v3 RPC (`supabase/migrations/00416_set_entity_assignment_v3.sql`, identical 6-arg sig, Slice A) instead of the raw `updateTicketOrWorkOrder()` path; `p_entity_kind` = the kind `loadTicketForFire` resolves (case ⇒ tickets / work_order ⇒ work_orders — now returns `kind`); `p_idempotency_key` = `buildSlaEscalationIdempotencyKey(timer.id, threshold.at_percent, timer.timer_type)` (`packages/shared/src/idempotency.ts`); `p_payload` carries the resolved assignee + a non-null `reason` (so v3's routing_decisions audit row fires) + corrected `watchers`; RPC errors mapped via `mapRpcErrorToAppError` (no raw throws). v3 commits the row UPDATE + `command_operations` idempotency + `routing_decisions` + `ticket_activities` + `ticket_assigned` domain event in one PG tx. Legitimate SLA-internal column writes (`sla_*_due_at`, `sla_paused`, waiting transitions, restartTimers clears) stay on the raw `updateTicketOrWorkOrder` helper — unchanged. `docs/assignments-routing-fulfillment.md` §7 gains the SLA-escalation reassign subsection (routing-axis drift closed). Tests: `apps/api/src/modules/sla/sla.service.spec.ts` +2 (deterministic key, resolved kind, non-null reason, person-id-not-users.id watcher, no raw UPDATE; work_order kind path). | `pnpm -C apps/api exec jest sla.service.spec.ts` 10/10 green; `pnpm -C apps/api lint` (tsc --noEmit) green; `pnpm errors:check-app-errors` green. Live smoke (`pnpm smoke:work-orders` / a new SLA-escalation probe) deferred to Slice F per slice plan — code path is jest-covered + lint/errors-gated but not exercised against the real DB this slice. | Idempotency boundary (precise): v3 makes the **assignment+watchers+audit write** an idempotent replay via the `sla:escalation:<timer>:<pct>:<type>` key; the `sla_threshold_crossings` UNIQUE `(sla_timer_id, at_percent, timer_type)` constraint (00043:16) governs crossing/notification dedup separately. NOT full-tick idempotency. See R-A02-2 below. D-A02-1 (pre-existing bug) fixed; R-A02-1 + R-A02-2 registered (Discovered findings / Residual risks subsection below). |

### Discovered findings / Residual risks (Slice B — P0-2)

- **D-A02-1 — pre-existing users.id→persons.id watcher type bug (FIXED in Slice B).**
  **Root cause:** `tickets.watchers` / `work_orders.watchers` are `uuid[]` whose elements are **persons.id** (`supabase/migrations/00011_tickets.sql:26` — "person IDs"). The pre-fix `SlaService.applyReassignment` appended the outgoing `ticket.assigned_user_id` — a **users.id** — directly into the watcher array (the "previous assignee now watches" behaviour). That is a type-wrong write: the watcher set silently accumulated users.id values that never resolve as persons. It was latent because the legacy raw `updateTicketOrWorkOrder` write did no watcher validation. It becomes a hard failure under Slice B because `set_entity_assignment` v3's watcher validator is persons-scoped (`00416:310-322` — `public.persons` tenant/active/not-anonymized/not-off-boarded predicate) and would reject the users.id with `set_entity_assignment.invalid_watcher` (400).
  **Fix:** `applyReassignment` now resolves the outgoing `assigned_user_id → person_id` via a new tenant-scoped `resolvePersonIdForUser(userId, tenantId)` helper (`select person_id from users where id = <assigned_user_id> and tenant_id = <ticket.tenant_id>`, skip if null/not found — F18, symmetric to the existing person_id→users.id lookup at `sla.service.ts:779-784` and the auth_uid→person map at `00416:553-557`). Only the resolved persons.id is added to the watcher set passed in `p_payload.watchers`. No existing user↔person mapping helper existed in the codebase (grep clean), so the query is inlined as a small private helper.

- **R-A02-1 — cross-RPC watcher last-writer-wins (ACCEPTED).** `set_entity_assignment` v3's `p_payload.watchers` does a **full-replace** of the watcher uuid[]. A separate path — `update_entity_combined` metadata branch — can also write `watchers`. If an SLA escalation reassign and a concurrent (or interleaved) metadata watcher edit target the same entity, the later commit wins and silently discards the other's watcher delta (no merge, no conflict). Accepted: SLA escalation is rare (cron, only on threshold crossing, only for `action='escalate'` thresholds) and the watcher set is advisory (notification fan-out), not an integrity-bearing column. Not worth a cross-RPC watcher-merge protocol at this scale. Re-evaluate if a future feature makes watchers integrity-bearing.

- **R-A02-2 — escalation notification can still double-send on overlapping cron ticks (ACCEPTED).** Step-1 finding: `fireThreshold` write order is `applyReassignment` (now idempotent v3 RPC) → `writeActivity` → `notifications.send` → `writeCrossing` (the `sla_threshold_crossings` UNIQUE `(sla_timer_id, at_percent, timer_type)` insert, `00043:16`) → `emitEvent`. The crossing-insert dedup gate happens **AFTER** the notification send, so it does **not** gate the notification. Two overlapping `@Cron(EVERY_MINUTE)` ticks racing the same (timer, threshold) before the crossing row commits can therefore double-send the escalation *notification* — even though Slice B made the assignment+watchers+audit write itself an idempotent no-op replay (v3 `command_operations` keyed on `sla:escalation:<timer>:<pct>:<type>`). Window is narrow: a tick must run >60s to overlap the next, and `processThresholds` additionally pre-filters already-fired crossings into `firedKeys` (a best-effort read-then-act gate with its own TOCTOU). Accepted: distributed transactions across Supabase + the notification service are not justified at this scale; the assignment side (the integrity-bearing write) is now safe. This is explicitly **not** full-tick idempotency — only the assignment write is idempotent. A future hardening (move `writeCrossing` before `notifications.send`, or fold notification dispatch behind the crossing insert) would close R-A02-2 but is out of Slice B scope.

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
