# Child Ticket SLA Model + Sub-Issues UI

**Date:** 2026-04-20
**Scope:** Backend (`apps/api`), web (`apps/web`), one schema migration, one docs update.
**Related docs:** `docs/assignments-routing-fulfillment.md` §6 (case vs work order), §7 (SLA timers).

---

## 1. Problem

Two distinct issues, traced to the same conceptual gap.

### 1.1 Sub-issues are visually duplicated and the placeholder is dead

`apps/web/src/components/desk/ticket-detail.tsx` currently renders **two** sections:

- A hardcoded "Sub-issues" placeholder (`ticket-detail.tsx:488-498`) — fixed `0/0` count, a `+` button with no `onClick`, and a "No sub-issues yet" message regardless of state.
- The real `<WorkOrdersSection>` (`ticket-detail.tsx:624-630`), placed **after** the Activity stream.

User-visible result: work orders appear *below comments*; the top "Sub-issues" section never updates and its `+` button does nothing.

### 1.2 Child tickets attach the wrong SLA policy

`DispatchService.dispatch` (`apps/api/src/modules/ticket/dispatch.service.ts:76`) sets:

```ts
sla_id: rtCfg.sla_policy_id,
```

This is the parent case's desk SLA (the service desk's promise to the requester). It is being applied to the executor's child work order, which is conceptually a *different* commitment (executor → desk).

The reference doc (`docs/assignments-routing-fulfillment.md:260`) already states "the case and its work orders have **independent SLA timers** — two different clocks to two different audiences," but the code does not implement that separation.

### 1.3 No way to specify the executor's SLA at dispatch

- Manual `AddWorkOrderDialog` exposes title, description, assignee, priority — no SLA field.
- Workflow `create_child_tasks` inspector form (`apps/web/src/components/workflow-editor/inspector-forms/create-child-tasks-form.tsx`) only collects title + description.
- `DispatchDto` has no `sla_id` field on either side.

So even if the bug in 1.2 were fixed, there is no input path for the executor SLA.

---

## 2. Conceptual model (the contract this spec enforces)

Two SLAs, two clocks, two audiences:

| | Case (`ticket_kind = 'case'`) | Child (`ticket_kind = 'work_order'`) |
|---|---|---|
| Audience | Requester (employee) | Service desk |
| Promised by | Service desk team | Executor (vendor or internal team) |
| Source of `sla_id` | `request_types.sla_policy_id` | Resolution order in §3 below — **never** `request_types.sla_policy_id` |
| Set when | Case is created | Child is dispatched (manual or workflow) |
| Mutable when | Locked on reassign (existing rule) | Manually editable on child detail (timers restart) |

`request_types.sla_policy_id` is, after this spec, *exclusively* the case's policy.

---

## 3. Child SLA resolution order

When a child ticket is created (manual dispatch OR workflow-spawned), `sla_id` is resolved by **`DispatchService.resolveChildSla(dto, row)`**, first match wins:

1. **Explicit:** `dto.sla_id` is set (manual user pick OR workflow node config) → use it.
2. **Vendor default:** `dto.assigned_vendor_id` resolved on the row → look up `vendors.default_sla_policy_id`.
3. **Team default:** `dto.assigned_team_id` resolved on the row → look up `teams.default_sla_policy_id`.
4. **User's team default:** `dto.assigned_user_id` resolved on the row → look up that user's team → `teams.default_sla_policy_id`. (One extra DB query; acceptable.)
5. **None.** `sla_id = null`. No SLA timers started. UI surfaces this state as "No SLA".

**Vendor before team:** if both `assigned_vendor_id` and `assigned_team_id` are populated (the schema permits it), vendor wins. Reasoning: a vendor SLA is contractual; a team default is an internal convention.

**Routing-resolved assignees count.** The resolver may fill in `assigned_team_id` / `assigned_user_id` / `assigned_vendor_id` *during* dispatch when none was passed in the DTO. The SLA resolution runs after that, on the row as it will be inserted, so routing-derived assignees produce the same default behavior as manual ones.

---

## 4. SLA on child reassignment

**Same rule as parent cases: SLA does not change on assignee reassignment.** Once `sla_id` is set at dispatch, switching the child's assignee post-create (via PATCH or `POST /tickets/:id/reassign`) does **not** re-run the resolution order and does **not** restart timers.

Rationale: matches the existing parent-case rule (`docs/assignments-routing-fulfillment.md` §"SLA on reassignment"), and avoids surprising clock resets when ownership shuffles internally.

To change a child's SLA, the user must explicitly pick a new policy in the child's properties sidebar (§6.3). That action *does* restart timers.

---

## 5. Schema changes

**One migration, additive only:**

```sql
-- supabase/migrations/000NN_child_ticket_sla_defaults.sql
alter table vendors
  add column default_sla_policy_id uuid references sla_policies(id);

alter table teams
  add column default_sla_policy_id uuid references sla_policies(id);

-- (Optional reload notify if required by remote PostgREST cache)
notify pgrst, 'reload schema';
```

- Both nullable, no backfill — `null` means "no default; user must pick or accept No-SLA at dispatch."
- No changes to `tickets`, `request_types`, `sla_policies`, or `sla_timers`.

Per project rules: migration must be applied locally via `pnpm db:reset` then pushed to remote with user confirmation (`pnpm db:push` or psql fallback per `CLAUDE.md`).

---

## 6. API changes

### 6.1 `DispatchDto` (api + web hook)

Add one field:

```ts
sla_id?: string | null;  // null = explicit "No SLA"; undefined = fall through to defaults
```

No deadline override field. Use SLA policy targets as the single source of truth for due dates. (If a one-off deadline is needed, the right answer is to create a new SLA policy.)

Files:
- `apps/api/src/modules/ticket/dispatch.service.ts` — `DispatchDto` interface
- `apps/web/src/hooks/use-work-orders.ts` — `DispatchDto` interface

### 6.2 `DispatchService.dispatch`

- Remove line 76 (`sla_id: rtCfg.sla_policy_id`).
- Remove the `loadRequestTypeConfig` call's reliance on `sla_policy_id` for the child (the `domain` field is still needed for routing).
- Insert the child row with `sla_id = null` initially (or omit the field entirely).
- After insert, call new helper `resolveChildSla(dto, child)` which implements §3.
- If a policy resolves: update the row's `sla_id` and call `slaService.startTimers(child.id, tenant.id, slaId)`. (Existing `startTimers` already creates `sla_timers` rows.)
- If no policy: leave `sla_id = null`, no timers.

The post-insert audit activity (`dispatched`) gains an `sla_id` field in its metadata for traceability.

### 6.3 Ticket PATCH — child SLA edit

`PATCH /tickets/:id` already accepts arbitrary field updates via `TicketService.update`. Add explicit handling for `sla_id` changes **on children only**:

- Require `ticket_kind = 'work_order'` for `sla_id` changes (cases keep current behavior).
- On change: stop existing `sla_timers` for the child, start new ones from the new policy.
- Log a `system_event` activity: `sla_changed` with `from_sla_id`, `to_sla_id`.

Cases continue to refuse `sla_id` changes (preserves parent SLA-on-reassignment immutability rule).

### 6.4 Workflow `create_child_tasks` engine pass-through

`apps/api/src/modules/workflow/workflow-engine.service.ts:185-215`:

- Extend the `tasks` array element type to include `sla_policy_id?: string | null` and `assigned_user_id?: string`, `assigned_vendor_id?: string` (the engine already passes `assigned_team_id`, `interaction_mode`, `priority` — round it out for parity with manual dispatch).
- Forward `sla_policy_id` as `sla_id` in the `dispatchService.dispatch` call.

### 6.5 Parent close guard

In `TicketService` status transitions: when a *case* is moved to `resolved` or `closed`, refuse if it has any child with `status_category` not in (`resolved`, `closed`).

- Error: `400 Bad Request` — `"cannot close case while children are open: <child-id-list>"`
- Implemented in `TicketService.update` (the central status-change path).
- Children rolling up via the `rollup_parent_status` trigger are unaffected (the trigger goes child→parent and is the *intended* path for parent state to move).

---

## 7. UI changes

### 7.1 `WorkOrdersSection` → renamed and relocated

File: `apps/web/src/components/desk/work-orders-section.tsx` (rename component to `SubIssuesSection`, file to `sub-issues-section.tsx`).

In `ticket-detail.tsx`:
- **Delete** the dead placeholder (lines 488-498).
- **Move** `<SubIssuesSection>` from after Activity to where the placeholder was (above the Activity header).
- Pass through the same `parentId`, `onAddClick`, `refreshNonce` props.

Section visual:
- Header: `Sub-issues` (lowercase plural) · `<count>` · `Add` button (icon + label).
- Empty state: subdued `"No sub-issues yet"` text (no fake counts).
- Each row: priority dot · title (truncate) · assignee name + small avatar · SLA chip (countdown / "Breached" / "No SLA") · status badge.
- Click row → `navigate('/desk/tickets/' + row.id)` (existing behavior).
- Style: borderless rows separated by `divide-y`, no card box — matches Linear-style spacing already used elsewhere.

Row data needed beyond what `useWorkOrders` returns today:
- Assignee display name. Today the hook returns `assigned_team_id` / `assigned_user_id` / `assigned_vendor_id`. Resolve names client-side using already-fetched `teams`, `users`, `vendors` (passed from parent `TicketDetail`).
- SLA state. Add `sla_id`, `sla_resolution_due_at`, `sla_resolution_breached_at` to the row type (already on the `tickets` table). `GET /tickets/:id/children` already returns the full row; the type just needs to widen.

### 7.2 `AddWorkOrderDialog` → renamed and extended

File: rename to `add-sub-issue-dialog.tsx`, component to `AddSubIssueDialog`. Title in the dialog: `"Add sub-issue"`.

Add one new `<Field>`:

```
SLA policy        [ Select / "Inherit from <vendor X> default: <policy Y>" / "No SLA" ]
                  Hint: "Inherits from the assignee's default if you leave this empty."
```

Behavior:
- When the user picks an assignee (team/user/vendor), if that entity has a `default_sla_policy_id`, show a hint under the SLA picker: `"Will inherit: <policy-name>"`.
- If no inheritance available, hint: `"No SLA will run on this sub-issue"`.
- Three values for the picker: empty (inherit), specific policy id, or explicit `"No SLA"` (sends `sla_id: null`).

Loading SLA policies: `useApi<SlaPolicy[]>('/sla-policies', [])`.

The dialog already uses Field primitives (`apps/web/src/components/ui/field.tsx`) per the project mandate; the new field follows the same shape.

### 7.3 Child ticket detail — SLA editable

In `TicketDetail` properties sidebar, replace the read-only SLA block (currently `ticket-detail.tsx:927-930`) with an editable `SlaPolicyPicker` when `displayedTicket.ticket_kind === 'work_order'`. Cases keep the read-only display.

The picker:
- Bound to `sla_id` via `useTicketMutation.patch({ sla_id })`.
- On change: backend stops existing timers, starts new ones (per §6.3).
- Local optimistic update to `sla_id`; live `<SlaTimer>` re-renders from the refetched ticket once the PATCH resolves.

### 7.4 Vendor admin — default SLA picker

File: `apps/web/src/pages/admin/vendors.tsx` (416 lines).

Add a `default_sla_policy_id` field to the vendor edit form (likely a row in the existing edit dialog/sheet). Same Field primitive pattern; loads SLA policies via `useApi`. Backend already updates arbitrary vendor columns via existing PATCH; verify the column is in the allowed-update list.

### 7.5 Team admin — default SLA picker

File: `apps/web/src/pages/admin/teams.tsx` (318 lines).

Same pattern as 7.4 for teams.

### 7.6 Workflow node — per-task SLA picker

File: `apps/web/src/components/workflow-editor/inspector-forms/create-child-tasks-form.tsx`.

The current form collects only title + description per task. Extend each task row with:
- `sla_policy_id` (Select; SLA policies fetched once at form mount).
- `assigned_team_id` (Select; teams fetched once).
- `priority` (Select).

(The engine already accepts `assigned_team_id`, `priority`, `interaction_mode` — exposing them in the UI is incidental polish that completes the parity with manual dispatch and is in scope here because the SLA picker requires we touch this form anyway.)

`assigned_user_id` and `assigned_vendor_id` in workflow tasks: out of scope for this spec — workflows currently route via team or rely on the resolver. Adding executor-level pickers in workflows is a follow-up.

---

## 8. Documentation update

`docs/assignments-routing-fulfillment.md` — required per `CLAUDE.md` "MANDATORY: keep the reference doc in sync" rule.

§7 (SLA timers): replace the existing paragraph that says "Attached at ticket creation (for cases) and at dispatch (for work orders). Both paths…" with the two-track model:

- **Case SLA** — desk → requester. From `request_types.sla_policy_id` at create time. Locked on reassign.
- **Child SLA** — executor → desk. Resolved at dispatch by the order in §3 of this spec. **Never** from `request_types.sla_policy_id`. Locked on reassign; explicit user change in the child's properties sidebar restarts timers.
- New schema: `vendors.default_sla_policy_id`, `teams.default_sla_policy_id`.

§6 (Case vs Work Order): add a one-line note about the parent close guard from §6.5.

Also add a dated entry to the changelog at the bottom of the same doc.

---

## 9. Non-goals (YAGNI)

- **Per-child deadline override** independent of SLA policy. (User explicitly agreed to drop.)
- **Cascade-resolve when parent closes.** Replaced by parent close *guard* (§6.5), which is simpler.
- **Per-priority SLA matrices.** Existing schema remains: one policy = one set of targets.
- **Re-resolve SLA on reassignment.** Locked, matches parent rule.
- **Vendor/user/asset/location override at child create-time.** Already passed through DTO from API perspective; not required for the SLA story.
- **Watchers, labels, custom-form data, attachments at child create-time.** All editable post-create.
- **Scheduled start date** (`scheduled_start_at`). No schema column today, no current ask.
- **Workflow node `assigned_user_id` / `assigned_vendor_id`.** Out of scope (§7.6).

---

## 10. Test surface

### Backend (Vitest, existing patterns under `apps/api/src/modules/**/*.spec.ts`)

- `dispatch.service.spec.ts` — extend:
  - Child with explicit `dto.sla_id` → row has that `sla_id`, timers started.
  - Child with vendor assignee + vendor has default → resolves to vendor default.
  - Child with team assignee + team has default → resolves to team default.
  - Child with user assignee + user's team has default → resolves to team default.
  - Child with no resolvable SLA → `sla_id = null`, no timers.
  - `request_types.sla_policy_id` is **never** applied to the child (regression test for the bug).
  - Vendor + team both set → vendor wins.

- `ticket.service.spec.ts` — add:
  - PATCH `sla_id` on a case → 400.
  - PATCH `sla_id` on a child → timers stopped + restarted; activity logged.
  - PATCH parent to `resolved` while child open → 400.
  - PATCH parent to `resolved` after children resolved → success.

- `workflow-engine.service.spec.ts` — add:
  - `create_child_tasks` with `sla_policy_id` per task → forwarded to dispatch.

### Frontend (smoke / manual; no React test runner is set up project-wide)

- Create case → open detail → see Sub-issues above Activity, no duplicate.
- Add sub-issue with explicit SLA → row shows countdown.
- Add sub-issue without SLA, vendor has default → row shows countdown from vendor default.
- Add sub-issue without SLA, no defaults → row shows "No SLA".
- Open child → change SLA in sidebar → timer restarts.
- Try to close parent with open child → error toast.

### Migration

- `pnpm db:reset` applies cleanly (validates SQL).
- After user confirmation, `pnpm db:push` to remote (or psql fallback).
- Smoke: `GET /vendors` includes the new column; admin form lets you set a default.

---

## 11. Rollout / risk

**Risk: existing children carry the old (wrong) `sla_id`.** They were dispatched with `request_types.sla_policy_id`. Two options:

- **A. Leave existing children alone.** Their `sla_id` is what it is. New dispatches use the new model. Doc the inconsistency.
- **B. One-off backfill: null out `sla_id` on existing work orders.** Risk of breaking SLA timers people expect. No clear right answer without product input.

**Recommendation: A.** The bug existed; existing data reflects the bug; future data is correct. Communicate via the changelog entry.

**Risk: parent close guard breaks workflows that auto-close cases.** Need to grep for callsites that close cases programmatically (e.g., workflow `update_ticket` nodes setting status to `closed`). Mitigation: the guard returns a clear error; workflows that rely on auto-close will fail loudly and can be updated to first close children.

---

## 12. Build sequence (high-level — detailed plan in writing-plans phase)

1. Migration + remote push.
2. `DispatchService` correctness fix + `resolveChildSla` + tests.
3. Workflow engine pass-through + tests.
4. Ticket PATCH `sla_id` for children + parent close guard + tests.
5. `AddWorkOrderDialog` → `AddSubIssueDialog` rename + SLA field.
6. `WorkOrdersSection` → `SubIssuesSection` rename + relocate + row enrichment.
7. Child detail SLA picker.
8. Vendor admin default SLA.
9. Team admin default SLA.
10. Workflow node-form per-task SLA + assignee.
11. Docs update (`assignments-routing-fulfillment.md`).
12. Manual smoke pass.

Steps 1-4 are backend, must precede UI. Steps 5-10 are frontend, mostly independent of each other and can be parallelized.
