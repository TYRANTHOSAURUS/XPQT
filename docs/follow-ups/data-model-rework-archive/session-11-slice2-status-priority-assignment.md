# Session 11 — 2026-05-01 — Slice 2: status / priority / assignment / reassign on work_orders

> Archived from `docs/follow-ups/data-model-rework-full-handoff.md`. The main
> handoff is the index; this file is the full historical record.
>
> **Naming note:** This is **Slice 2** of the work-order command surface
> (per the renumbered scheme). Builds on Slice 1 (Session 10) and
> Slice 0 (Session 9, originally "B1.5").

## Why this exists

After Slice 1 (setPlan) shipped, status / priority / team / assignee mutations on work_orders were still silently broken from the desk detail sidebar (firing `PATCH /tickets/:id` and `POST /tickets/:id/reassign` which `TicketService.update` and `TicketService.reassign` reject case-only). Slice 2 closes the rest of the bug class.

Plus reassign-with-reason (POST analog) ships in the same slice — without it, the FE's `useReassignTicket` would still silently no-op on WOs.

## What shipped

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

## Two-gate review pattern (codex hit quota mid-review)

1. **Plan-time review (full-review).** 3 critical findings caught pre-implementation:
   - Visibility floor for `updateStatus`: I had it backwards — `assertVisible('write')` allows requesters/watchers via participant match (abuse path); `assertCanPlan` is the canonical operator gate. Corrected.
   - Per-transition close/reopen permission gates DON'T EXIST on case-side. Adding them only on WO creates wrong-direction divergence. Dropped from plan; documented as future security improvement.
   - Domain event renaming (`work_order_status_changed`) — no subscribers exist for `ticket_status_changed`; renaming would split reports for no benefit. Kept the same names.

2. **Code-time review (full-review).** 4 important findings + 1 nit. All addressed in this slice except #9 / #10 (see below).

3. **Code-time review (codex).** Hit quota immediately. No findings produced this round.

## Fixes applied post-code-review

| # | Source | Fix |
|---|---|---|
| 1 | full-review | `reassign(rerun_resolver: true)` switched from `BadRequestException` to `NotImplementedException` (501). 400 says "your request is malformed"; 501 is the truth. |
| 2 | full-review | Extracted `applyWaitingStateTransition` from TicketService + WorkOrderService into a public method on SlaService. Eliminates the duplication risk. Both services now call `slaService.applyWaitingStateTransition(...)`. |
| 4 | full-review | Fixed misleading comment about the 00230 derive trigger. The actual story: 00232 supersedes 00230 and handles polymorphic auto-derive correctly across `tickets` + `work_orders`; the explicit columns we set in `routing_decisions` insert are defensive (skip per-row trigger lookup, deterministic on app side), not strictly required. Comment + doc note both updated. |

## Deferred (documented for future)

- **Full-review #3 (logDomainEvent duplication, nit).** 5-line helper, two copies, drift cost is real but small. Add a `// kept in sync with ticket.service.ts` comment to both. Defer extraction.

- **Full-review #9 (FE multi-field PATCH fan-out race).** `patchWorkOrder()` fires up to 3 PATCHes serially when a single FE call combines status/priority/assignment fields. If A succeeds and B fails, B rolls back to its snapshot which doesn't include A's optimistic write — cache visually loses A's value until next refetch. Practical risk: low (desk UI almost never fires multi-field patches in one call). Real fix is a single `PATCH /work-orders/:id` server endpoint that accepts the whole DTO — defer to Slice 3.

- **Full-review #10 (permission-gate divergence — needs decision).** Case-side `TicketService.update()` and `reassign()` use ONLY `assertVisible('write')`. WO-side adds `tickets.change_priority` and `tickets.assign` permission gates per the catalog. **Real divergence** — case is under-gated OR WO is over-gated. My judgment: WO-side is the canonical pattern (green-field; the catalog's per-action keys exist for a reason); case-side is legacy undergated. **Future security alignment work:** add the same gates to TicketService.update + TicketService.reassign. This expands Slice 3 scope or becomes a separate "security alignment" slice. **User has not decided** — handoff entry flags this for next session.

## Verification

- `pnpm db:reset` clean (no new migration in Slice 2).
- `pnpm --filter @prequest/api exec jest work-order ticket-sla-edit ticket-close-guard` — 52 passed + 1 pre-existing skip across 11 suites.
- `pnpm --filter @prequest/api run lint` exit 0.
- `pnpm --filter @prequest/web run lint` exit 0 (23 pre-existing warnings, none in touched files).

## Plandate workstream coordination (still uncommitted)

The plandate workstream's files remain dirty. Slice 2 added hooks to `mutations.ts` and surgical edits to `ticket-detail.tsx`; same selective-staging dance as Sessions 9 + 10. Plandate hunks confirmed untouched.

## What's left

- **Slice 3 (deferred):** cost / tags / watchers / title / description on work_orders (also broken from desk detail). Plus the single `PATCH /work-orders/:id` endpoint that resolves Full-review #9.
- **Security alignment slice (deferred, decision needed):** add `tickets.change_priority` and `tickets.assign` permission gates to `TicketService.update` + `TicketService.reassign` so case-side matches WO-side. Or decide the divergence is intentional and document it.
- **Plandate workstream coordination:** when plandate commits, they must (a) delete `TicketService.setPlan` + `useSetTicketPlan` + `/tickets/:id/plan` route per Session 10's flag, (b) confirm the rewired Plan SidebarGroup uses `useSetWorkOrderPlan`/`useCanPlanWorkOrder` (already done in working tree).

## Codex quota

Codex hit quota mid-review on Slice 2. Full-review (Opus subagent) handled the heavy lifting alone this round. No bugs slipped through to my knowledge — full-review caught 5 of 5 important items including the permission-gate divergence which is the most consequential. **The two-gate pattern is robust to one gate being unavailable**, but degrades when codex is offline because the Postgres-internals nuance class (timestamp roundtrip etc.) is codex's specialty. Plan accordingly for future sessions.
