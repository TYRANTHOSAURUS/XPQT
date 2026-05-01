# Session 9 — 2026-05-01 — Slice 0 (originally B1.5): work-order command surface scaffolding + SLA edit

> Archived from `docs/follow-ups/data-model-rework-full-handoff.md`. The main
> handoff is the index; this file is the full historical record.
>
> **Naming note:** This session shipped under the "B1.5" name (codex's
> original nomenclature, between B1 full-split and B3 do-nothing). The slice
> series has since been renumbered. This is now **Slice 0** of the
> work-order command surface — the foundational scaffolding slice that all
> later slices (Slice 1 setPlan, Slice 2 status/priority/assignment, Slice 3
> remaining fields) build on top of.

## Why this exists

After Session 8 wrapped, codex was asked to independently weigh in on remaining priorities. It surfaced two findings I'd missed:

1. The work-order command surface is broken in MULTIPLE places, not just SLA. `TicketService.update` is case-only post-1c.10c — yet the desk-detail sidebar still routes status/priority/team/assignee/SLA mutations through `PATCH /tickets/:id`, which silently rejects work_orders. Same with `setPlan` (used by the plandate workstream's uncommitted code) — it loads work_orders via getById then writes to `tickets`.
2. The plandate workstream itself is shipping the same bug class. Whoever owns it needs to know.

So the right next step wasn't "restore SLA endpoint" (the original deferred #5). It was "build the work-order command surface and ship SLA on it as the first method." Codex called this **B1.5** — between B1 (full split, ~2-3 days) and B3 (don't split). Half-day of scaffolding, future-proof for status/priority/plan/assignment as they accumulate.

## What shipped

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

## Codex review round 1 — applied forward

- **0 critical findings.**
- **5 important** — patched in same session:
  1. **Auth gate too broad.** Used `assertCanPlan` alone (assignees/vendors get through). The catalog already has `sla.override` (danger:true) at `packages/shared/src/permissions.ts:296` — that's the canonical key. Added a two-axis gate: `assertCanPlan` for visibility floor + `tickets.write_all || sla.override` for the danger-permission check.
  2. **Stale returned row.** `restartTimers` writes SLA-derived columns AFTER my SELECT. Moved the final SELECT to AFTER the timer restart so the FE caches a fresh row.
  3. **`updated_at` not advancing.** `work_orders` has no auto-trigger for updated_at on UPDATE (the bridge-era trigger was dropped in 00217 and never restored). Set `updated_at` explicitly in the UPDATE payload.
  4. **(deferred)** Timer restart swallow leaves sla_id and timers inconsistent on failure. Same pattern as TicketService — class-wide debt, not Slice 0 scope. Documented in service comment as known debt with codex citation.
  5. **(deferred)** Activity write swallow loses audit on failure. Same pattern, same deferral.
- **1 nit:** FE hook typed response as `TicketDetail` but backend returns raw `WorkOrderRow`. Narrowed to `Pick<TicketDetail, 'id' | 'sla_id' | 'updated_at'>` — honest contract; hook only invalidates anyway.

## Tests covering the codex fixes

`work-order-sla-edit.spec.ts` (4 tests):
- `accepts sla_id change on a work_order and restarts timers` (asserts updated_at is in the UPDATE payload).
- `accepts sla_id = null (clear SLA)`.
- `does NOT restart timers if sla_id is unchanged`.
- **`throws Forbidden when caller lacks sla.override and write_all`** — codex-driven. Asserts the gate runs the right RPC (`user_has_permission` with `sla.override`) AND stops before any mutation. Without this test, a future revert of the danger-permission gate would silently re-broaden authorization.

`ticket-sla-edit.spec.ts` (1 remaining): `refuses sla_id change on a parent case` (case-only ticket service still rejects).

## What this means for the plandate workstream (CRITICAL — read if you own those files)

The uncommitted plandate code (in your working tree at session-start: `apps/api/src/modules/ticket/ticket.controller.ts`, `apps/web/src/api/tickets/{keys,mutations,queries,types}.ts`, `apps/web/src/components/desk/{ticket-detail,plan-field}.tsx`, `supabase/migrations/00206_ticket_plandate.sql`, `docs/visibility.md`, `docs/superpowers/specs/2026-04-30-plandate-planning-board-pm-design.md`) has a real bug:

- `TicketService.setPlan` at `apps/api/src/modules/ticket/ticket.service.ts:1094-1134` loads a work_order via `getById`, then writes to the `tickets` table.
- Post-1c.10c, work_orders are not in the `tickets` table. The write silently affects no rows or fails.
- Same pattern as the deferred #5 SLA bug we just fixed via Slice 0.

**Before committing the plandate workstream:** rebuild `setPlan` on top of `WorkOrderService` (the same way `updateSla` was built). Add `WorkOrderService.setPlan(workOrderId, plannedStartAt, plannedDurationMinutes, actor)`. Mount on the new `/work-orders` controller as `PATCH /work-orders/:id/plan`. Update FE `useSetTicketPlan` → `useSetWorkOrderPlan`. Reuse the same auth pattern (assertCanPlan visibility, no extra permission required since plan is not a danger key — but verify with the permission catalog). Add tests.

If this is left as-is, the plandate planning board will appear to work in the UI (optimistic updates, no API errors) while NEVER actually persisting plans. Worse — it'll write nothing AND succeed silently because the case-only `TicketService.setPlan` won't error on an empty UPDATE WHERE.

> Update from a later session: this work shipped in Slice 1 (Session 10).

## What's left after Session 9

- Open question on B1's full scope (separate `/cases/*` controller, full split). Codex's recommendation: not required until planning board / per-kind RLS / WO queues are imminent. Slice 0 is the incremental foothold; future commands grow into it.
- C1 (frontend `TicketDetail` split into `CaseDetail` + `WorkOrderDetail`) still rides full B1.
- Class-wide debt: timer/activity write swallowing across SLA-edit code paths. Both TicketService and WorkOrderService have this. Real fix is transactional command pattern in SlaService — not session-scoped.
- The plandate workstream coordination above.

## Session 9 verification summary

- `pnpm --filter @prequest/api exec jest work-order-sla-edit ticket-sla-edit` → 5/5 green (4 new + 1 case-only).
- `pnpm --filter @prequest/api run lint` → exit 0.
- `pnpm --filter @prequest/web run lint` → exit 0 (23 pre-existing warnings, none in touched files).
- Plandate workstream hunks confirmed untouched (line-count check: keys=+1, queries=+13, types=+9 unchanged; mutations grew +49→+97 with my hook only; ticket-detail grew +38→+52 with my 3 surgical edits only).
