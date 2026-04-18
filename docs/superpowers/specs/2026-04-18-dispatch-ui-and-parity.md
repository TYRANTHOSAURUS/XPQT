# Dispatch UI + Workflow Parity — Design Spec

**Status:** Draft for implementation.
**Date:** 2026-04-18.
**Owners:** Backend routing + frontend desk UI.
**Depends on:** Merged case/work-order backend (`POST /tickets/:id/dispatch`, `ticket_kind` column, rollup trigger) and the sidebar inline-editing work (`EntityPicker`, `useTicketMutation`).

---

## 1. Goal

Make the case/work-order model usable from the service desk UI, close the parity gap between manual dispatch and workflow-spawned children, and consolidate routing documentation into one canonical file.

## 2. Background

`DispatchService.dispatch(parentId, dto)` ships on main today and creates a child `work_order` with resolver-assigned target, SLA timers, routing audit, and a `dispatched` event on the parent. The `POST /tickets/:id/dispatch` endpoint exposes it. Nothing on the desk UI calls it yet. Additionally, the `create_child_tasks` workflow node still inserts child tickets directly, which means workflow-spawned work orders skip SLA timer start, `routing_decisions`, and the parent activity log — documented as a known gap.

Two overlapping reference docs exist: `docs/routing.md` (pre-dates dispatch, covers PATCH vs `/reassign`, scope-field rationale, known gaps) and `docs/assignments-routing-fulfillment.md` (written with the case/work-order feature, covers entities, scope hierarchies, dispatch, rollup). They will drift if both stay.

## 3. User-facing outcomes

### Service desk agent on a case
- Sees a **Work Orders** section below the activity timeline. Shows all child work orders (whether created manually via dispatch or spawned by a workflow) as a compact list with title, status, and assignee.
- Can click **Add work order**, fill a short form (title, description, assignee via Team/User/Vendor tabs, priority), submit, and see the new row appear in the list.
- Can click a row to navigate to the child's own ticket detail.
- When the agent opens a work order directly (e.g., via a queue filtered to `?kind=work_order`), the top of the detail shows a **"Work order of [Case title]"** link back to the parent.

### Workflow engine
- When a workflow's `create_child_tasks` node fires, each spawned child goes through `DispatchService.dispatch` instead of a direct insert. The child receives the same SLA timer start, routing decision audit, and parent activity event that manual dispatch produces.

## 4. Scope

### In scope
1. New backend endpoint `GET /tickets/:id/children`.
2. Frontend React Query hook `useWorkOrders`.
3. New component `WorkOrdersSection` mounted inside `ticket-detail.tsx` when `ticket_kind === 'case'`.
4. New component `AddWorkOrderDialog` with a tabbed assignee picker (Team / User / Vendor), wrapping the existing `EntityPicker`.
5. New top-of-page ribbon on `ticket-detail.tsx` when `ticket_kind === 'work_order'`, linking back to the parent.
6. Refactor `workflow-engine.service.ts`'s `create_child_tasks` node to call `DispatchService.dispatch`.
7. Merge `docs/routing.md` into `docs/assignments-routing-fulfillment.md`. Delete `docs/routing.md`. Update inbound references.
8. One backend integration test for `GET /children`. One unit test for the workflow-dispatch parity path.

### Out of scope (deferred to later plans)
- Visibility scoping on the ticket list (Pass 3).
- Admin UI for space groups and domain parents (Pass 2).
- Rescope endpoint (`POST /tickets/:id/rescope`) — open question in the existing docs.
- `action_assign_vendor_id` on routing rules.
- Drag-and-drop reordering, bulk dispatch, or parent-side quick-status toggles on child rows.

## 5. Architecture

### 5.1 Backend changes

**`apps/api/src/modules/ticket/ticket.controller.ts`** — add one method:

```ts
@Get(':id/children')
async children(@Param('id') id: string) {
  return this.ticketService.getChildTasks(id);
}
```

Uses the already-hardened `getChildTasks` (returns `ticket_kind`, `assigned_vendor_id` from the final-review fix). Tenant scoping is inherited from `TenantContext.current()` inside the service.

**`apps/api/src/modules/workflow/workflow-engine.service.ts`** — the `create_child_tasks` branch currently does `await this.supabase.admin.from('tickets').insert({...})` per task. Replace with a `DispatchService.dispatch(parentId, dto)` call per task:

```ts
for (const task of tasks) {
  await this.dispatchService.dispatch(ticketId, {
    title: task.title,
    description: task.description,
    assigned_team_id: task.assigned_team_id,
    priority: task.priority,
    interaction_mode: (task.interaction_mode as 'internal' | 'external' | undefined),
  });
}
```

Inject `DispatchService` into `WorkflowEngineService`. `TicketModule` already exports it; `WorkflowModule` imports `TicketModule` via forwardRef — same import path, new provider.

Guards inside `DispatchService.dispatch` that the workflow engine must respect:
- Parent must exist and not be a work order.
- Parent must not be in `pending_approval`. If a workflow fires `create_child_tasks` on a case still in approval, the dispatch throws `BadRequestException`. The node should either **(a)** catch and log (matching the existing error-handling style of other workflow node branches — `console.error(...)` + advance), or **(b)** fail the workflow instance loudly. Decision: **(a)** for parity with the existing node-error patterns in `workflow-engine.service.ts`; the workflow config is responsible for ordering steps correctly.
- Non-empty title. If a workflow task has an empty title, the dispatch rejects. The node should fall back to a generated title (e.g., `"Subtask ${i+1}"`) before calling dispatch, never passing through an empty string.

### 5.2 Frontend changes

**`apps/web/src/hooks/use-work-orders.ts`** (new) — two hooks:

```ts
// List children of a parent case.
export function useWorkOrders(parentId: string | null) {
  return useQuery({
    queryKey: ['ticket', parentId, 'children'],
    queryFn: () => apiFetch<WorkOrderRow[]>(`/tickets/${parentId}/children`),
    enabled: !!parentId,
  });
}

// Dispatch a new work order under a parent case.
export function useDispatchWorkOrder(parentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: DispatchDto) =>
      apiFetch<WorkOrderRow>(`/tickets/${parentId}/dispatch`, {
        method: 'POST',
        body: JSON.stringify(dto),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ticket', parentId, 'children'] });
      qc.invalidateQueries({ queryKey: ['ticket', parentId] });  // parent status may have rolled up
    },
  });
}
```

`WorkOrderRow` matches the fields returned by `getChildTasks` (id, title, status, status_category, priority, ticket_kind, assigned_team_id, assigned_user_id, assigned_vendor_id, interaction_mode, created_at, resolved_at).

**`apps/web/src/components/desk/work-orders-section.tsx`** (new) — renders inside `ticket-detail.tsx` on cases:

```
┌─ Work Orders (3)                 [+ Add work order] ┐
│                                                     │
│  🔧 Replace window pane     In progress  · Glazier  │
│  📦 Buy replacement glass   Assigned     · Supplier │
│  🧹 Clean up debris         Resolved     · Janitor  │
└─────────────────────────────────────────────────────┘
```

- Pulls `useWorkOrders(parentId)`.
- Renders empty state if zero children: "No work orders yet. Add one to send work to a vendor, team, or teammate."
- Each row clickable → `navigate(\`/desk/tickets/\${id}\`)`.
- Uses shadcn `Badge` for status pill, existing status color tokens.
- The "Add work order" button opens `AddWorkOrderDialog`.

**`apps/web/src/components/desk/add-work-order-dialog.tsx`** (new) — shadcn `Dialog` with `Field` primitives (per CLAUDE.md form composition rules):

```
Add work order                                         ×
──────────────────────────────────────────────────────
  [FieldGroup]
    [Field] Title *            [_______________________]
    [Field] Description        [_______________________]
                               [                       ]
    [Field] Assignee *
            [Tabs: Team | User | Vendor]
            [EntityPicker for selected tab]
    [Field] Priority           [Select: low/med/high/urgent]
                                          ─ defaults to parent.priority
                                                         ─────────
                                            [Cancel]  [Add work order]
```

- Title: required, non-empty trimmed (matches backend validation).
- Description: optional textarea.
- Assignee: shadcn `Tabs` with three tabs. Each tab's body contains an `EntityPicker` scoped to its entity type (team / user / vendor). Only one tab's value is submitted — the active tab's selection. Switching tabs clears inactive selections so the submitted DTO has exactly one assignee field.
- Priority: shadcn `Select`, default = parent's priority; options are the tenant's priority enum.
- Submit: calls `useDispatchWorkOrder.mutate(dto)`. On success, close dialog + toast `"Work order '<title>' added"`. On error, show inline `FieldError` or `Alert` with the backend error message.

**`apps/web/src/components/desk/ticket-detail.tsx`** — two edits:

1. At the top (after the header, before the body columns), render a ribbon when `ticket.ticket_kind === 'work_order'`:
   ```tsx
   {ticket.ticket_kind === 'work_order' && ticket.parent_ticket_id && (
     <ParentCaseRibbon parentId={ticket.parent_ticket_id} />
   )}
   ```
   `ParentCaseRibbon` is a small local component (or inline) that fetches the parent's title via the existing ticket-detail query and renders a link: `"← Work order of <parent title>"`.

2. After the activity timeline block, mount the section when `ticket.ticket_kind === 'case'`:
   ```tsx
   {ticket.ticket_kind === 'case' && <WorkOrdersSection parentId={ticket.id} />}
   ```

Keep both additions minimal and behind the `ticket_kind` check so the work order path stays clean.

### 5.3 Documentation changes

1. Open `docs/assignments-routing-fulfillment.md`. Add sections from `docs/routing.md` that aren't already covered:
   - **"When the resolver runs"** table (create, approval granted, manual rerun).
   - **"Two ways to change an assignee"** — silent `PATCH` vs audited `POST /tickets/:id/reassign` + the `useTicketMutation` tiered-assignment behavior shipped by the other session.
   - **"What happens on status transitions"** — `applyWaitingStateTransition`, SLA pause/resume, resolved_at / closed_at.
   - **"What happens to SLA on reassignment"** — SLA is a promise to the requester; timers don't reset.
   - **"Scope fields — not editable today"** table and rescope rationale.
   - **"Known gaps"** list (kept live).
   - **"Resolved"** section, seeded with: `2026-04-18 — sidebar reassign now calls POST /tickets/:id/reassign (useTicketMutation)`.
2. Add any cross-references to `docs/routing.md` found in the codebase (CLAUDE.md was already updated to point at the consolidated doc; grep for other mentions).
3. Delete `docs/routing.md`.

## 6. Data flow

### Dispatch from the UI
1. Agent clicks **Add work order** in the section.
2. Dialog opens with parent's priority pre-selected.
3. Agent types title, optionally description, picks a tab, picks an assignee via `EntityPicker`, submits.
4. `useDispatchWorkOrder.mutate(dto)` → `POST /tickets/:id/dispatch`.
5. Backend runs `DispatchService.dispatch`:
   - Loads parent, validates (must be `case`, not `pending_approval`, title non-empty).
   - Copies parent context, builds insert row.
   - If no assignee in DTO, runs resolver (ours has that path). Here DTO has an assignee — skip.
   - Inserts child with `ticket_kind = 'work_order'`, `sla_id` from request type.
   - Writes `routing_decisions` (if resolver ran) or nothing (if DTO-assigned).
   - Starts SLA timers.
   - Appends `dispatched` activity on the parent.
   - Rollup trigger fires: parent moves `new` → `assigned` (if it was `new`) based on child state.
6. Hook's `onSuccess` invalidates children + parent queries. Section re-fetches. Parent ticket query re-fetches and picks up any status change.
7. Dialog closes. Toast confirms.

### Dispatch from a workflow
1. Workflow engine reaches a `create_child_tasks` node with config `{ tasks: [...] }`.
2. For each task: calls `this.dispatchService.dispatch(ticketId, dto)` where DTO carries `title || 'Subtask N'`, optional `description`, `assigned_team_id`, `priority`, `interaction_mode`.
3. `DispatchService` runs the same pipeline as above, writing SLA + audit + activity.
4. On error (e.g., parent in `pending_approval`), `console.error` + `advance(...)` — same pattern as other node branches.

### Viewing a work order
1. Agent clicks a child row in the Work Orders section.
2. Router navigates to `/desk/tickets/:childId` — same ticket-detail route.
3. Detail page loads. `ticket_kind === 'work_order'` triggers the ribbon.
4. Ribbon fetches parent title (either via embedded join already in the detail query, or a separate small query keyed on `parent_ticket_id`). Ribbon links back to `/desk/tickets/<parent>`.
5. The Work Orders section does NOT render on the work order (only on cases), so no infinite recursion.

## 7. Error handling

| Error | UX |
|---|---|
| Backend 400 `empty title` | Inline FieldError on the Title field. |
| Backend 400 `pending_approval` parent | Dialog-level Alert: "This case is awaiting approval — resolve the approval before dispatching." |
| Backend 400 `work_order parent` | Should be unreachable (button only shows on cases). Still, dialog-level Alert if it happens. |
| Network / 500 | Toast "Failed to add work order — try again." Dialog stays open. |
| Workflow dispatch fails inside node | `console.error('[workflow] create_child_tasks: dispatch failed', err)` + advance workflow. Matches existing pattern. |
| `useWorkOrders` fetch fails | Section shows a compact inline error + retry button. Section still visible. |

## 8. Testing

### Backend
- **New test:** `apps/api/src/modules/ticket/ticket.controller.spec.ts` (or integration equivalent) — one test asserting `GET /tickets/:id/children` returns the expected shape including `ticket_kind` and `assigned_vendor_id`, tenant-scoped.
- **New test:** `apps/api/src/modules/workflow/workflow-engine.service.spec.ts` — test that `create_child_tasks` calls `dispatchService.dispatch` once per task; that errors from dispatch are caught and the workflow advances; that empty titles are replaced with `Subtask N`.
- `dispatch.service.spec.ts`, `resolver.service.spec.ts`, `scenarios.spec.ts` remain unchanged and green.

### Frontend
- No web test suite in project today. Verification is manual:
  1. `pnpm dev` locally.
  2. Open a case. Confirm Work Orders section appears, empty state renders.
  3. Add a work order via the dialog. Confirm row appears; parent status updates.
  4. Open the new work order. Confirm the ribbon shows and links back.
  5. Open a case that runs a workflow with `create_child_tasks`. Confirm children appear with SLA timers started and a `dispatched` activity on the parent.

## 9. Risks and open questions

- **Workflow task config today.** `create_child_tasks.config.tasks[]` items carry `assigned_team_id` only — no `assigned_user_id` or `assigned_vendor_id`. Out of scope to expand here; the schema is backwards compatible (DTO fields are optional). If workflow authors want to target users or vendors, that's a separate config schema change.
- **Parent-title lookup for the ribbon.** Two options: **(a)** add `parent_title` to the ticket-detail response (cheap extra join); **(b)** issue a tiny follow-up fetch keyed on `parent_ticket_id`. Plan will pick based on the existing query shape — either is fine. Both keep the ribbon client-concern only.
- **Tab-switching UX in the dialog.** When the user picks a Team, then switches to Vendor, the team selection is cleared. Decision: cleared (not remembered) so the submitted DTO is unambiguous. Plan will document this.
- **Dispatch button visibility.** Shown for all service-desk users on any case today (no role gate). Aligns with the existing inline-editing pattern on the sidebar; future role scoping is part of the visibility plan.
- **Deletion of `docs/routing.md`.** Inbound references likely include `CLAUDE.md` (already consolidated to point at the new doc) and possibly individual commit messages or other plans. Plan will `grep -rn 'routing\.md'` across `docs/` and the repo root and patch any hits.

## 10. Success criteria

- All 5 deliverables ship on one branch: Work Orders section, ribbon, dialog, workflow-dispatch parity, doc consolidation.
- Full API test suite green (53+ tests) + new tests for children endpoint and workflow parity.
- Web build clean.
- Manual run-through: dispatch from UI → child appears → parent status rolls up. Workflow-spawned child has an SLA timer, a `routing_decisions` row, and a `dispatched` parent activity.
- `docs/routing.md` removed; all references point at `docs/assignments-routing-fulfillment.md`.
- CLAUDE.md update rule fires the next time anything under the trigger list changes (the rule is already in place from the prior commit).

## 11. File map

| File | New / Modified | Responsibility |
|---|---|---|
| `apps/api/src/modules/ticket/ticket.controller.ts` | Modified | Add `GET :id/children`. |
| `apps/api/src/modules/workflow/workflow-engine.service.ts` | Modified | `create_child_tasks` node uses `DispatchService`. |
| `apps/api/src/modules/workflow/workflow.module.ts` | Modified | Inject `DispatchService` (via `TicketModule` already imported). |
| `apps/api/src/modules/ticket/ticket.controller.spec.ts` | New (or extend) | Integration test for `/children`. |
| `apps/api/src/modules/workflow/workflow-engine.service.spec.ts` | New (or extend) | Parity test for `create_child_tasks` → `DispatchService`. |
| `apps/web/src/hooks/use-work-orders.ts` | New | `useWorkOrders`, `useDispatchWorkOrder`. |
| `apps/web/src/components/desk/work-orders-section.tsx` | New | Section UI + empty state. |
| `apps/web/src/components/desk/add-work-order-dialog.tsx` | New | Dialog with Field-composed form. |
| `apps/web/src/components/desk/parent-case-ribbon.tsx` | New | "Work order of [parent]" link at top of detail. |
| `apps/web/src/components/desk/ticket-detail.tsx` | Modified | Mount ribbon + section based on `ticket_kind`. |
| `docs/assignments-routing-fulfillment.md` | Modified | Absorb content from `docs/routing.md`. Add Resolved section. |
| `docs/routing.md` | Deleted | Consolidated into the single reference. |
