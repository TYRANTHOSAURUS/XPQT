# B.2 config-reads triage

Companion to `apps/api/src/modules/.b2-config-reads-allowlist.txt`. The
allowlist file itself is content-keyed and reviewed via diff; this doc
records the **classification + rationale** for each entry so future
reviewers (and PR reviewers) know whether each read is legit, to-fix,
or pending review.

**Scope.** Raw reads of `workflow_definition_id`, `sla_policy_id`,
`case_sla_policy_id` in `apps/api/src/modules/{ticket, sla, approval,
workflow, portal}`. Per spec §0.2: the B.2 contract says the runtime
row (`tickets.workflow_id` / `sla_id`, `work_orders.workflow_id` /
`sla_id`) carries the effective plan after create/grant/reclassify; raw
config reads outside the documented sites are the failure-class that
v3-v9 spec rounds tried to close.

**Classifications.**
- `legit`: permanent. Documented in spec §0.2 as a legitimate read.
- `to-fix`: temporary. Will be eliminated when the named B.2.A RPC
  ships (§3.5 / §3.10 / §3.11). The line stays in the allowlist until
  the RPC cutover deletes the TS reader.
- `pending review`: not used in the bootstrap (B.2.A.0). Reserved for
  PRs that add new entries without a clear classification — CI
  reviewer must triage during PR.

This is a **SNAPSHOT**, not approval-forever. Re-triage on every PR
that touches a B.2-scope module.

---

## sla.service.ts (5 entries)

All 5 reads here are accesses to `sla_policy_id` as a **column on
`sla_timers` rows**, not as a raw config read. The column lives on the
timers table — the read pattern is correct.

- `legit`: `const thresholds = thresholdsByPolicy.get(timer.sla_policy_id) ?? [];`
  - Reading the timer row's policy id to look up cached thresholds. Column on `sla_timers`.
- `legit`: `sla_policy_id: slaPolicyId,`
  - Writing the column on a new `sla_timers` INSERT (lines 92, 110 — both response/resolution timer rows). Sort -u dedupes; same content.
- `legit`: `.select('id, tenant_id, ticket_id, sla_policy_id, timer_type, target_minutes, started_at, due_at, total_paused_minutes')`
  - SELECT columns from `sla_timers`. `sla_policy_id` is the column name.
- `legit`: `const policyIds = Array.from(new Set(timerRows.map((t) => t.sla_policy_id)));`
  - Distinct policy ids from a batch of timer rows for threshold lookup.
- `legit`: `const policyName = await this.loadPolicyName(timer.sla_policy_id);`
  - Name lookup keyed on the timer row's policy id.

## ticket/dispatch.service.ts (1 entry)

- `legit`: `* Resolve which sla_policy_id to attach to a child work order.`
  - JSDoc comment in `resolveChildSla`. Documentation, not code.

## ticket/reclassify.service.ts (9 entries)

All 9 reads are part of the reclassify resolution path, which spec §3.10
explicitly identifies as a legitimate raw-config read site (it computes
new effective workflow + SLA from the new request_type's config + scope
overrides).

- `legit`: `.update({ sla_id: newType.sla_policy_id })`
  - **Writing the runtime `sla_id` column** on `tickets` from the resolved new request_type's `sla_policy_id`. Direction: config → runtime row. Correct pattern per §0.2.
- `legit`: `? this.loadWorkflowDefinition(newType.workflow_definition_id, tenant.id)`
  - Loading the new workflow definition for cascade decisions during reclassify.
- `legit`: `await this.slaService.startTimers(ticketId, tenant.id, newType.sla_policy_id);`
  - Invoking startTimers with the resolved policy id (not a raw config-table read; passing a value).
- `legit`: `await this.workflowEngine.startForTicket(ticketId, newType.workflow_definition_id);`
  - Same — passing a resolved value.
- `legit`: `.select('id, name, domain, active, sla_policy_id, workflow_definition_id')`
  - SELECT request_types config — the legit reclassify resolution read site (§3.10).
- `legit`: `newType.sla_policy_id ? this.loadSlaPolicy(newType.sla_policy_id, tenant.id) : Promise.resolve(null),`
  - Branching on whether the new request_type has a policy attached.
- `legit`: `newType.workflow_definition_id`
  - Same branching pattern for workflow.
- `legit`: `if (newType.sla_policy_id) {`
  - Same — guard before SLA cascade.
- `legit`: `if (newType.workflow_definition_id) {`
  - Same — guard before workflow cascade.

## ticket/ticket.service.ts (10 entries)

The bulk — and 2 of the 10 are TO-FIX in B.2.A. The 8 legitimate ones
are the existing `runPostCreateAutomation` plan-build pattern that
§3.11 will formalize.

- **`to-fix` (B.2.A / §3.11)**: `.select('domain, sla_policy_id, workflow_definition_id, requires_approval, approval_approver_team_id, approval_approver_person_id')`
  - `ticket.service.ts:632` — TicketService.create raw config read. **Replaced by §3.11 `create_ticket_with_automation` RPC + TS plan-build.** Will be deleted when §3.11 ships.
- **`to-fix` (B.2.A / §3.5)**: `.select('domain, sla_policy_id, workflow_definition_id')`
  - `ticket.service.ts:712` — `runPostCreateAutomation` re-fetch on approval grant. **Replaced by §3.5 `grant_ticket_approval` RPC reading from ticket row.** Will be deleted when §3.5 ships.
- `legit`: `(requestTypeCfg?.sla_policy_id as string | null | undefined) ??`
  - Plan-build resolution: fall back to request_types config if no override.
- `legit`: `(requestTypeCfg?.workflow_definition_id as string | null | undefined) ??`
  - Same — workflow resolution fallback.
- `legit`: `scopeOverride?.case_sla_policy_id ??`
  - Plan-build resolution: prefer the scope override's value.
- `legit`: `scopeOverride?.workflow_definition_id ??`
  - Same — workflow override.
- `legit`: `sla_id: args.sla_policy_id ?? null,`
  - Internal helper writing `sla_id` column from resolved `sla_policy_id` arg. Direction: arg → runtime column.
- `legit`: `// Same precedence: scope override's workflow_definition_id wins.`
  - Comment.
- `legit`: `// Scope override's case_sla_policy_id wins over request_types.sla_policy_id`
  - Comment.

## workflow/workflow-engine.service.ts (5 entries — was 3, +2 from audit follow-up)

The audit follow-up commit added two new entries to this file by
splitting the embedded-resource resume() read into separate
tenant-filtered queries:

- `legit`: `.eq('id', instance.workflow_definition_id as string)`
  - The new explicit tenant-filtered SELECT of workflow_definitions
    that replaces the unsafe embed at line 702. Reads the column
    from the workflow_instances row (already tenant-filtered) and
    passes it to a separately-filtered SELECT with
    `.eq('tenant_id', tenantId)`. Closing the embed leak.
- `legit`: comment `// workflow_definition_id (FK-smuggle) would load a foreign graph and`
  - Documentation explaining the embed-leak fix.



All 3 are workflow-engine internals around node-config payloads, not
raw config-table reads.

- `legit`: `? { sla_id: task.sla_policy_id ?? null }`
  - Workflow `create_child_tasks` node passes per-task `sla_policy_id` (from the workflow definition's graph payload) to the child WO's `sla_id` column. Direction: graph config → runtime column.
- `legit`: `...(Object.prototype.hasOwnProperty.call(task, 'sla_policy_id')`
  - Same node — checking whether the task config carries a policy id.
- `legit`: `workflow_definition_id: workflowDefinitionId,`
  - Writing the `workflow_definition_id` column on a new `workflow_instances` row INSERT. Column on the runtime instance table.

---

## Summary

| Module | Total | Legit | To-fix | Pending |
|---|---|---|---|---|
| sla | 5 | 5 | 0 | 0 |
| dispatch | 1 | 1 | 0 | 0 |
| reclassify | 9 | 9 | 0 | 0 |
| ticket.service | 10 | 8 | 2 | 0 |
| workflow | 3 | 3 | 0 | 0 |
| **Total** | **28** | **26** | **2** | **0** |

Two entries (after sort -u dedupe of the `sla_policy_id: slaPolicyId,`
duplicate, the allowlist file has 27 unique lines).

**To-fix entries trigger deletion in B.2.A:**
- `§3.11 ships` → delete `ticket.service.ts:632` line from allowlist + (optionally) delete the TS code path if no other caller. The `--gen` script regenerates and the entry is gone.
- `§3.5 ships` → same for `:712`.

**No pending-review entries.** Bootstrap is clean.
