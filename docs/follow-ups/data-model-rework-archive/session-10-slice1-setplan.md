# Session 10 — 2026-05-01 — Slice 1: setPlan on work_orders

> Archived from `docs/follow-ups/data-model-rework-full-handoff.md`. The main
> handoff is the index; this file is the full historical record.
>
> **Naming note:** This is **Slice 1** of the work-order command surface
> (per the renumbered scheme). It builds on Slice 0 (Session 9, originally
> shipped under the "B1.5" name).

## Why this exists

The plandate workstream's uncommitted code wires `useSetTicketPlan` → `PATCH /tickets/:id/plan` → `TicketService.setPlan`, which loads work_orders via getById then writes to the `tickets` table. Post-1c.10c work_orders are not in tickets, so plandate is silently broken end-to-end. The Plan SidebarGroup is gated `ticket_kind === 'work_order'` (only ever runs on WOs). Without this fix the planning board ships dead.

This slice implements `WorkOrderService.setPlan` + `canPlan`, the second method on the work-order command surface (after Slice 0 SLA edit). Plandate's broken `setPlan` / endpoint / hooks stay in their files (see "Plandate workstream coordination" below).

## What shipped

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

## Two-gate review pattern this session followed

The user explicitly directed me to use **full-review** AND **codex** at both checkpoints. New process going forward:

1. **Plan-time review (full-review skill).** Before any code: write the plan, dispatch the plan-reviewer subagent. This session's plan-review caught 3 critical findings I'd have shipped:
   - I claimed `work_orders` was missing the `planned_*` columns (false — they were added in 00213; only the CHECK constraint was missing).
   - I was about to use `assertCanPlan` for status / priority / assignment too — same over-grant mistake codex caught me making for SLA in Slice 0.
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

## Codex + full-review fixes applied

| Source | Finding | Fix |
|---|---|---|
| codex (NEW) | T | Normalize timestamps via Date.parse before equality check in setPlan no-op path. New test locks the fix in. |
| full-review #3 | Validation upper bound | Reject `planned_duration_minutes > 60 * 24 * 365` (1 year). New test asserts. |
| full-review #5 | No-op test gap | Added 2 tests: "start equal, duration changed" + "duration equal, start changed". |
| full-review #8c | canPlan tests | New `work-order-can-plan.spec.ts` with 3 tests: SYSTEM_ACTOR shortcut, ForbiddenException → false, non-Forbidden → propagate. |

## Deferred (intentionally)

- **Full-review #2 / codex confirm** — pre-push audit on remote. Ran the audit before commit: `0` work_order rows have `planned_duration_minutes <= 0` (in fact 0 rows have it set at all out of 319 total). Migration 00246 is safe to push.
- **Full-review #8b** — dead code: `TicketService.setPlan` + `useSetTicketPlan` + `/tickets/:id/plan` route still live. Reviewer's framing: "the trap stays armed" — if plandate workstream removes the `ticket_kind === 'work_order'` gate before deleting the broken function, that's an incident. **Not deleted in this slice** because the broken code is in plandate-territory files (`apps/api/src/modules/ticket/ticket.controller.ts`, `apps/web/src/api/tickets/mutations.ts`, `apps/web/src/api/tickets/queries.ts`) which this session committed not to modify. **Plandate workstream owner: when you commit your work, please delete `TicketService.setPlan` (apps/api/src/modules/ticket/ticket.service.ts:1082-1180), `PATCH /tickets/:id/plan`, `GET /tickets/:id/can-plan`, `useSetTicketPlan`, `useCanPlanTicket`, and `ticketCanPlanOptions`. The Plan SidebarGroup is the only consumer and it's now rewired onto WorkOrder*.**
- **Full-review #7 nit** — class-validator DTOs vs hand-rolled validation. Wider cleanup pattern; not Slice-1 scope.

## Verification

- `pnpm db:reset` clean through 00246.
- `chk_work_orders_planned_duration_positive` constraint visible on local + verified absent in conflict on remote.
- `psql -f scripts/ci-migration-asserts.sql` → A1..A11 still green.
- `pnpm --filter @prequest/api exec jest work-order` → 26/26 across 5 suites (was 20/20; added 6 new setPlan + canPlan tests).
- `pnpm --filter @prequest/api run lint` exit 0.
- `pnpm --filter @prequest/web run lint` exit 0 (23 pre-existing warnings, none in touched files).

## Plandate workstream coordination

After this slice commits, the Plan SidebarGroup in `ticket-detail.tsx` consumes:
- `useSetWorkOrderPlan` (mine, in `apps/web/src/api/tickets/mutations.ts`) → `PATCH /work-orders/:id/plan` → `WorkOrderService.setPlan` ✅ working.
- `useCanPlanWorkOrder` (mine, in `apps/web/src/api/tickets/queries.ts`) → `GET /work-orders/:id/can-plan` → `WorkOrderService.canPlan` ✅ working.

The plandate workstream's surfaces (`useSetTicketPlan`, `useCanPlanTicket`, `ticketCanPlanOptions`, `TicketService.setPlan`, `PATCH /tickets/:id/plan`, `GET /tickets/:id/can-plan`) are now dead code with no consumers. Recommended cleanup at plandate commit time documented above.

If the plandate workstream wants plan-dates on cases later, those surfaces can be repurposed (rename → `useSetCasePlan` etc.). But that's a deliberate design call, not a side-effect.

## What's left (Slice 2 / Slice 3)

- **Slice 2 (separate session):** restore `updateStatus` / `updatePriority` / `updateAssignment` on work_orders with PROPER per-field gates (per plan-reviewer #2 finding):
  - `updateStatus`: `assertVisible('write')` + per-transition checks for `tickets.close` / `tickets.reopen`.
  - `updatePriority`: `assertCanPlan` floor + `tickets.change_priority || tickets.write_all`.
  - `updateAssignment`: `assertCanPlan` floor + `tickets.assign || tickets.write_all`.
  - Per-field endpoints (NOT a single `PATCH /work-orders/:id` field-dispatcher).
- **Slice 3 (deferred):** `cost`, `tags`, `watchers`, `title`, `description` on work_orders (also broken from desk detail).
- **The plandate workstream still needs to commit**, with the dead-code cleanup above.

## Pre-commit ground-truth: codex saved this slice from a real bug

The timestamp string-equality bug (codex finding T) would have shipped if I'd skipped codex and relied on full-review alone. Full-review (Opus subagent) didn't catch it — it's a Postgres-internals nuance codex specifically flagged. **Codex remains the heavier gate** on commands that touch DB roundtripping. Keep the two-gate pattern: full-review for breadth, codex for depth.
