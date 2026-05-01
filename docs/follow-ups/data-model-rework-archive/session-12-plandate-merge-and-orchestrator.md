# Session 12 — 2026-05-01 — Plandate merge + Slice 3.0 orchestrator + security alignment

This session closed all the open architectural items from Sessions 9–11
in one push. User mandate: "do all of them" — referring to the combined
plan-reviewer + code-reviewer findings from Session 11's adversarial gate.

## What shipped

7 commits this session:

```
13a1868 docs(handoff): split rework handoff into archive + index, normalize naming
f376e12 fix(security): backport tickets.assign + tickets.change_priority gates to TicketService
850ca6d refactor(work-orders): code-review cleanup C2 + C3 + C5
849aaee feat(plandate): merge plandate workstream — schema + spec + FE Plan SidebarGroup
09e28f6 refactor(plandate): delete dead case-side setPlan + can-plan surfaces
0d77367 refactor(work-orders): collapse to single PATCH /:id endpoint (P1 + C4)
```

Plus this handoff index update.

Migrations pushed to remote (in order):

- `00206_ticket_plandate.sql` — case-side `planned_*` columns + 4 partial
  indexes (already-applied indexes skipped via `IF NOT EXISTS`).
- `00247_backfill_assign_and_priority_permissions.sql` — grandfathering
  migration for existing roles. UPDATE 0 on remote (no roles needed it
  per the pre-push audit).

## Findings addressed

Session 11 ended with adversarial reviews returning 3 critical + 5
important + 2 nit findings. All closed except 2 (which were architectural
decisions punted to user, both later confirmed in Session 12):

### Plan-reviewer's critical findings

**P1 — Stop accreting per-field endpoints.** WorkOrderController went from
7 routes (5 PATCH + 1 GET + 1 POST) → 3 routes (1 PATCH + 1 GET + 1 POST).
New `WorkOrderService.update(id, dto, actor)` orchestrator dispatches per-
field gates internally. Per-field service methods kept for direct callers
(workflows, cron). FE collapsed 5 hooks → 1.

**P2 — Permission-gate divergence is security regression.** Backported
`tickets.assign` and `tickets.change_priority` permission gates to
`TicketService.update` + `TicketService.reassign`. Migration 00247
grandfathers existing roles (any role with `tickets.update` and not
`tickets.write_all` gets the per-action keys auto-added). Remote audit:
0 roles affected on current tenant. New `ticket-permissions.spec.ts`
with 14 tests covers the gate combinations.

**P3 — Plandate save-restore-amend dance is structurally untenable.**
User chose "fix it also" — committed plandate workstream as-is in
`849aaee`, immediately followed by dead-code cleanup in `09e28f6`
(deleted `TicketService.setPlan`, `/tickets/:id/plan` + `/can-plan`
routes, `useSetTicketPlan`, `useCanPlanTicket`,
`ticketCanPlanOptions`). The Plan SidebarGroup was already rewired
onto `useSetWorkOrderPlan` + `useCanPlanWorkOrder` from Sessions 9–11.

### Plan-reviewer's important findings

**P4 — Handoff doc structural debt.** Split into archive (one file per
session 7-11) + index. Main file went 886 → 445 lines. Chronology
fixed (Session 9 was previously appearing AFTER Session 11). Naming
normalized to "Slice N" (zero-indexed); legacy "B1.5" preserved in the
mapping table for searchability.

**P5 — CI assertion gate brittleness.** Documented in
`docs/follow-ups/ci-assertion-strategy.md` with the YAML-driven
invariant pattern + effort estimate (~half day) + triggering condition
(before next destructive cutover). Implementation deferred.

**P6 — Naming consistency.** Picked "Slice N" as canonical scheme.
Mapping table in main handoff. Archive filenames carry both old + new
names where applicable (e.g. `session-09-b15-sla-edit.md`).

**P7 — End state undefined.** Wrote explicit exit criteria (5 items
for the work-order command surface, 2 more for the full rework, 3
stretch goals explicitly NOT in scope). Each criterion has a status
marker.

**P8 — Codex fragility.** User picked combination (c) + (d): human
review for destructive when codex unavailable + accept "full-review
only" as degraded mode for non-destructive. Documented in main handoff.
This session's codex hit quota mid-review again — only full-review
findings were applied, with the user explicitly accepting that as the
degraded-mode posture.

### Code-reviewer's findings

**C1 — Tenant filter on SLA policy lookup** (one-line). Fixed inline
before P2 dispatch. `SlaService.applyWaitingStateTransition`'s
`sla_policies` query now filters by tenant_id.

**C2 — Activity metadata shape parity.** Backfilled case-side
`TicketService.update` + `reassign` activity emissions to use the
WO-side `previous` / `next` shape. Renderer reads only `metadata.event`
for system rows so the UI is unchanged; future consumers (audit query,
analytics) get a consistent shape.

**C3 — Test mock re-implementing the extracted helper.** Replaced
`work-order-update-status.spec.ts`'s helper-mirror mock with a stub.
Behavior tests for `applyWaitingStateTransition` moved into a new
describe block in `sla.service.spec.ts` (5 tests covering pause/resume
conditional logic + tenant-scoped policy lookup).

**C4 — Defensive return in `patch()`.** Added explicit
`if (!displayedTicket) return;` to `patch()` and `updateAssignment()`
in `ticket-detail.tsx`. Contract is now local to each function rather
than implicit in JSX render order.

**C5 — Routing_decisions polymorphic-columns convention parity.**
Picked the explicit-on-both-sides convention. `TicketService.reassign`
now sets `entity_kind='case'` + `case_id` explicitly when inserting
`routing_decisions` (matches `WorkOrderService.reassign`).

## Two-gate review pattern this session

| Stage | Gate | Findings |
|---|---|---|
| Plan, pre-code | full-review (plan-reviewer) | 3 direction changes folded in pre-implementation |
| Code, post-implementation | full-review (code-reviewer) | 5 important findings |
| Code, post-implementation | codex | Quota hit. Confirmed full-review's #2; found 1 NEW (timestamp string-equality) on the prior session, none this session. |

Codex degraded-mode posture (option c+d): for the work this session,
which was NOT destructive (no schema-shape changes; only additive
column adds + permission-gate refinement + service refactoring), the
"full-review only" posture was acceptable. No bugs slipped through to
my knowledge.

## Verification

- `pnpm db:reset` clean through 00247.
- `pnpm --filter @prequest/api exec jest work-order ticket sla` — 167
  tests pass across 25 suites (Session 11 was 153/24).
- `pnpm --filter @prequest/api run lint` exit 0.
- `pnpm --filter @prequest/web run lint` exit 0 (23 pre-existing
  warnings, none in touched files).
- CI assertion script A1..A11 green on remote.

## What's left after Session 12

The work-order command surface is now COMPLETE for the originally-listed
fields (sla, plan, status, priority, assignment, reassign). What
remains:

- **Slice 3 part B** — `cost` / `tags` / `watchers` / `title` /
  `description` on work_orders. The single PATCH endpoint exists; just
  add these fields to the union DTO + dispatch logic. ~half day.
- **`workflow_instances.ticket_id` soft pointer** — still FK-less,
  still polymorphically incomplete. Step 1c.9 split-API.
- **`bundle_is_visible_to_user` SECURITY DEFINER grant to authenticated**
  — pre-existing visibility oracle, separate targeted migration.
- **Status filter on visibility paths** — policy decision (approver
  retention, WO assignee retention).
- **CI assertion gate to YAML-driven invariants** — before next
  destructive cutover.
- **Class-wide timer/activity-write swallow** — transactional command
  pattern in SlaService.

The full data-model rework (Steps 2, 3, 4) is still deferred per Session 7
+ original design — those need product readiness, not architectural
prep.
