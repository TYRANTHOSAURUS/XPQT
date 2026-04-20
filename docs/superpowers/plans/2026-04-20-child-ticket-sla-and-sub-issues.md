# Child Ticket SLA Model + Sub-Issues UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop child tickets from inheriting the parent's desk SLA, give the user a way to set the executor's SLA at dispatch (manual or workflow), and clean up the duplicated/dead Sub-issues UI on the ticket detail view.

**Architecture:** Two SLAs, two clocks, two audiences. Parent case `sla_id` comes from `request_types.sla_policy_id` (desk → requester). Child `sla_id` is resolved at dispatch by a new `DispatchService.resolveChildSla` helper using the order: explicit DTO → vendor default → team default → user's-team default → none. Vendors and teams gain a nullable `default_sla_policy_id` column. UI is reorganized so the real Sub-issues section lives above Activity, the dead placeholder is removed, and a new "Add sub-issue" dialog includes an SLA picker.

**Tech Stack:** NestJS 10 + Jest (`*.spec.ts`), TypeScript everywhere, Supabase (PostgreSQL + RLS), React 19 + Vite + Tailwind v4, shadcn/ui (Field primitives mandatory per `CLAUDE.md`).

**Spec:** `docs/superpowers/specs/2026-04-20-child-ticket-sla-and-sub-issues-design.md`

**Reference doc to update:** `docs/assignments-routing-fulfillment.md` (mandatory per `CLAUDE.md` "MANDATORY: keep the reference doc in sync" rule).

---

## Build Order

Tasks are ordered by dependency. Backend (Tasks 1–6) must precede UI (Tasks 7–12). Docs (Task 13) and smoke (Task 14) are last.

| # | Task | Layer | Depends on |
|---|---|---|---|
| 1 | Migration: add `default_sla_policy_id` to vendors and teams | DB | – |
| 2 | DispatchService: stop inheriting request_type SLA + add `resolveChildSla` | API | 1 |
| 3 | SlaService: add `restartTimers` helper | API | – |
| 4 | TicketService: support `sla_id` PATCH on children | API | 3 |
| 5 | TicketService: parent close guard | API | – |
| 6 | WorkflowEngineService: pass `sla_policy_id` from create_child_tasks node | API | 2 |
| 7 | Web hook: extend `DispatchDto` and `WorkOrderRow` types | Web | 2 |
| 8 | Rename + relocate Sub-issues section, delete placeholder, enrich rows | Web | 7 |
| 9 | Rename + extend Add sub-issue dialog with SLA picker | Web | 7 |
| 10 | Child detail: SLA picker in properties sidebar | Web | 4 |
| 11 | Vendor admin: default SLA picker | Web | 1 |
| 12 | Team admin: default SLA picker | Web | 1 |
| 13 | Workflow node form: per-task SLA + assignee + priority | Web | 6 |
| 14 | Update `docs/assignments-routing-fulfillment.md` | Docs | All |
| 15 | Manual smoke pass | – | All |

---

## Task 1: Migration — vendor/team default SLA columns

**Files:**
- Create: `supabase/migrations/00035_child_ticket_sla_defaults.sql`

**Context:**
- Both columns are nullable. No backfill needed: `null` means "no default; user must pick or accept No-SLA at dispatch."
- Per `CLAUDE.md`, `pnpm db:reset` validates locally; pushing to remote requires user confirmation. Do NOT push in this task — confirm with the user first.

- [ ] **Step 1.1: Create the migration file**

Create `supabase/migrations/00035_child_ticket_sla_defaults.sql`:

```sql
-- 00035_child_ticket_sla_defaults.sql
-- Adds nullable default SLA policy columns to vendors and teams.
-- Used by DispatchService.resolveChildSla as fallback when no explicit
-- sla_id is supplied at child-ticket dispatch.

alter table vendors
  add column default_sla_policy_id uuid references sla_policies(id);

alter table teams
  add column default_sla_policy_id uuid references sla_policies(id);

-- Help PostgREST cache pick up the new columns immediately on reload.
notify pgrst, 'reload schema';
```

- [ ] **Step 1.2: Validate locally**

Run: `pnpm db:reset`
Expected: clean exit, all migrations apply including 00035. If anything fails, fix the SQL and re-run.

- [ ] **Step 1.3: SKIP remote push in this run**

Per the user's policy for this execution, **do not run `pnpm db:push`**. The user will push to the remote Supabase project manually after the implementation is reviewed. This means the running dev app (which talks to the remote DB) will return `PGRST205` ("Could not find the table X in the schema cache") for vendor/team SLA defaults until the user pushes — that's expected. Local `pnpm db:reset` is the validation gate for this task.

- [ ] **Step 1.4: Commit**

```bash
git add supabase/migrations/00035_child_ticket_sla_defaults.sql
git commit -m "feat(db): add default_sla_policy_id to vendors and teams"
```

---

## Task 2: DispatchService — drop request_type SLA, add `resolveChildSla`

**Files:**
- Modify: `apps/api/src/modules/ticket/dispatch.service.ts`
- Modify: `apps/api/src/modules/ticket/dispatch.service.spec.ts`

**Context:**
The bug: `dispatch.service.ts:76` currently sets `sla_id: rtCfg.sla_policy_id` on the child, attaching the parent's desk SLA. Per the spec, the child's SLA must come from the resolution order in §3 of the spec. We also need to add `sla_id` to `DispatchDto` so explicit picks (manual UI, workflow node) flow through.

**Resolution order recap (first match wins):**
1. `dto.sla_id` is set (including explicit `null` meaning "no SLA")
2. Row's `assigned_vendor_id` → `vendors.default_sla_policy_id`
3. Row's `assigned_team_id` → `teams.default_sla_policy_id`
4. Row's `assigned_user_id` → look up that user's `team_id` → `teams.default_sla_policy_id`
5. None → `sla_id = null`, no timers

Treat `dto.sla_id === null` (explicit) as a final answer ("No SLA"), distinct from `dto.sla_id === undefined` (not specified, fall through to defaults).

- [ ] **Step 2.1: Update the failing test for the regression — child must NOT inherit request_type SLA**

Replace the existing `it('includes sla_id in the initial insert row', ...)` test in `apps/api/src/modules/ticket/dispatch.service.spec.ts` (the one around line 175 that asserts `sla-1`) with a regression test:

```ts
it('does NOT inherit sla_id from request_type (parent-vs-child SLA separation)', async () => {
  const parent = makeParent();
  const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
  const svc = new DispatchService(
    supabase as never,
    ticketService as never,
    routingService as never,
    slaService as never,
  );
  // request_types mock returns sla_policy_id: 'sla-1' — that's the parent's desk SLA.
  // Child must NOT pick it up unless explicitly passed in DTO.
  await svc.dispatch(parent.id, { title: 'anything', assigned_vendor_id: 'v1' });
  expect(inserted[0].sla_id).toBeNull();
  expect(slaService.startTimers).not.toHaveBeenCalled();
});
```

- [ ] **Step 2.2: Run the test to confirm it fails**

Run: `pnpm --filter api test -- dispatch.service.spec`
Expected: FAIL on the new test (received `'sla-1'`, expected `null`).

- [ ] **Step 2.3: Extend the test deps mock to include `vendors` and `teams` lookups**

Replace the `makeDeps` function in `apps/api/src/modules/ticket/dispatch.service.spec.ts` with the following expanded version (additions: vendors/teams/users tables and a configurable `defaults` arg):

```ts
function makeDeps(
  parent: ParentRow,
  defaults: {
    vendors?: Record<string, { default_sla_policy_id: string | null }>;
    teams?: Record<string, { default_sla_policy_id: string | null }>;
    users?: Record<string, { team_id: string | null }>;
  } = {},
) {
  const inserted: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const activities: Array<Record<string, unknown>> = [];

  const ticketService = {
    getById: jest.fn(async (_id: string) => parent),
    addActivity: jest.fn(async (_id: string, act: Record<string, unknown>) => {
      activities.push(act);
    }),
  };

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            insert: (row: Record<string, unknown>) => {
              inserted.push(row);
              return {
                select: () => ({
                  single: async () => ({ data: { ...row, id: `child-${inserted.length}` }, error: null }),
                }),
              };
            },
            update: (patch: Record<string, unknown>) => ({
              eq: (_col: string, id: string) => {
                updates.push({ id, patch });
                return { select: () => ({ single: async () => ({ data: patch, error: null }) }) };
              },
            }),
          } as unknown;
        }
        if (table === 'request_types') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { domain: 'fm', sla_policy_id: 'sla-1' }, error: null }),
              }),
            }),
          } as unknown;
        }
        if (table === 'vendors') {
          return {
            select: () => ({
              eq: (_col: string, id: string) => ({
                maybeSingle: async () => ({ data: defaults.vendors?.[id] ?? null, error: null }),
              }),
            }),
          } as unknown;
        }
        if (table === 'teams') {
          return {
            select: () => ({
              eq: (_col: string, id: string) => ({
                maybeSingle: async () => ({ data: defaults.teams?.[id] ?? null, error: null }),
              }),
            }),
          } as unknown;
        }
        if (table === 'users') {
          return {
            select: () => ({
              eq: (_col: string, id: string) => ({
                maybeSingle: async () => ({ data: defaults.users?.[id] ?? null, error: null }),
              }),
            }),
          } as unknown;
        }
        return {} as unknown;
      }),
    },
  };

  const routingService = {
    evaluate: jest.fn().mockResolvedValue({
      target: { kind: 'vendor', vendor_id: 'vendor-X' },
      chosen_by: 'request_type_default',
      rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
    }),
    recordDecision: jest.fn().mockResolvedValue(undefined),
  };

  const slaService = { startTimers: jest.fn().mockResolvedValue(undefined) };

  return { ticketService, supabase, routingService, slaService, inserted, updates, activities };
}
```

The existing tests above this function still work because `defaults` defaults to `{}` (all lookups return null) and the `tickets.update` stub now exists for the new SLA assignment path.

- [ ] **Step 2.4: Add tests for the resolution order**

Append to the same `describe('DispatchService', …)` block:

```ts
it('uses dto.sla_id when provided explicitly', async () => {
  const parent = makeParent();
  const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
  const svc = new DispatchService(
    supabase as never,
    ticketService as never,
    routingService as never,
    slaService as never,
  );
  await svc.dispatch(parent.id, { title: 'x', assigned_team_id: 't1', sla_id: 'sla-explicit' });
  expect(inserted[0].sla_id).toBe('sla-explicit');
  expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', 'sla-explicit');
});

it('treats dto.sla_id === null as explicit "No SLA"', async () => {
  const parent = makeParent();
  const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
    vendors: { 'v1': { default_sla_policy_id: 'sla-vendor' } }, // would otherwise apply
  });
  const svc = new DispatchService(
    supabase as never,
    ticketService as never,
    routingService as never,
    slaService as never,
  );
  await svc.dispatch(parent.id, { title: 'x', assigned_vendor_id: 'v1', sla_id: null });
  expect(inserted[0].sla_id).toBeNull();
  expect(slaService.startTimers).not.toHaveBeenCalled();
});

it('falls back to vendor default_sla_policy_id', async () => {
  const parent = makeParent();
  const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
    vendors: { 'v1': { default_sla_policy_id: 'sla-vendor' } },
  });
  const svc = new DispatchService(
    supabase as never,
    ticketService as never,
    routingService as never,
    slaService as never,
  );
  await svc.dispatch(parent.id, { title: 'x', assigned_vendor_id: 'v1' });
  expect(inserted[0].sla_id).toBe('sla-vendor');
  expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', 'sla-vendor');
});

it('falls back to team default_sla_policy_id when no vendor', async () => {
  const parent = makeParent();
  const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
    teams: { 't1': { default_sla_policy_id: 'sla-team' } },
  });
  const svc = new DispatchService(
    supabase as never,
    ticketService as never,
    routingService as never,
    slaService as never,
  );
  // override routing so no vendor is assigned
  routingService.evaluate.mockResolvedValueOnce({
    target: { kind: 'team', team_id: 't1' },
    chosen_by: 'request_type_default', rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
  });
  await svc.dispatch(parent.id, { title: 'x' });
  expect(inserted[0].sla_id).toBe('sla-team');
  expect(slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', 'sla-team');
});

it('vendor default beats team default when both assignees set', async () => {
  const parent = makeParent();
  const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
    vendors: { 'v1': { default_sla_policy_id: 'sla-vendor' } },
    teams: { 't1': { default_sla_policy_id: 'sla-team' } },
  });
  const svc = new DispatchService(
    supabase as never,
    ticketService as never,
    routingService as never,
    slaService as never,
  );
  await svc.dispatch(parent.id, { title: 'x', assigned_team_id: 't1', assigned_vendor_id: 'v1' });
  expect(inserted[0].sla_id).toBe('sla-vendor');
});

it('falls back through user → user.team → team default', async () => {
  const parent = makeParent();
  const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent, {
    users: { 'u1': { team_id: 'tA' } },
    teams: { 'tA': { default_sla_policy_id: 'sla-userteam' } },
  });
  const svc = new DispatchService(
    supabase as never,
    ticketService as never,
    routingService as never,
    slaService as never,
  );
  await svc.dispatch(parent.id, { title: 'x', assigned_user_id: 'u1' });
  expect(inserted[0].sla_id).toBe('sla-userteam');
});

it('resolves to null sla_id when no defaults available', async () => {
  const parent = makeParent();
  const { ticketService, supabase, routingService, slaService, inserted } = makeDeps(parent);
  const svc = new DispatchService(
    supabase as never,
    ticketService as never,
    routingService as never,
    slaService as never,
  );
  routingService.evaluate.mockResolvedValueOnce({
    target: { kind: 'team', team_id: 't1' },
    chosen_by: 'request_type_default', rule_id: null, rule_name: null, strategy: 'fixed', trace: [],
  });
  await svc.dispatch(parent.id, { title: 'x' });
  expect(inserted[0].sla_id).toBeNull();
  expect(slaService.startTimers).not.toHaveBeenCalled();
});
```

- [ ] **Step 2.5: Run all dispatch tests, confirm new tests fail**

Run: `pnpm --filter api test -- dispatch.service.spec`
Expected: the seven new tests fail, the older tests still pass (their `slaService.startTimers` expectations also must change — fix in next step).

Note: the existing test `'creates a child work_order with parent context copied'` asserts `slaService.startTimers).toHaveBeenCalledWith(expect.any(String), 't1', 'sla-1')`. After this task that assertion is wrong (no inheritance). Update it to:

```ts
expect(slaService.startTimers).not.toHaveBeenCalled();
```

Edit that line in the test file before re-running.

- [ ] **Step 2.6: Implement `DispatchDto` extension and `resolveChildSla`**

In `apps/api/src/modules/ticket/dispatch.service.ts`:

Add `sla_id` to the DTO:

```ts
export interface DispatchDto {
  title: string;
  description?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  assigned_vendor_id?: string;
  priority?: string;
  interaction_mode?: 'internal' | 'external';
  ticket_type_id?: string;
  asset_id?: string;
  location_id?: string;
  /**
   * Executor's SLA policy. `undefined` = fall through to vendor/team defaults.
   * Explicit `null` = "No SLA" — dispatch with no SLA timers running.
   */
  sla_id?: string | null;
}
```

Replace the `dispatch` method body. The full new method (replaces lines 30–140 of the current file):

```ts
async dispatch(parentId: string, dto: DispatchDto) {
  const tenant = TenantContext.current();

  if (!dto.title?.trim()) {
    throw new BadRequestException('dispatch requires a non-empty title');
  }

  const parent = await this.tickets.getById(parentId) as Record<string, unknown>;
  if (parent.ticket_kind === 'work_order') {
    throw new BadRequestException('cannot dispatch from a work_order; dispatch from the parent case');
  }

  if (parent.status_category === 'pending_approval') {
    throw new BadRequestException('cannot dispatch while parent is pending approval');
  }

  const ticketTypeId = dto.ticket_type_id ?? (parent.ticket_type_id as string | null);
  const locationId = dto.location_id ?? (parent.location_id as string | null);
  const assetId = dto.asset_id ?? (parent.asset_id as string | null);
  const priority = dto.priority ?? ((parent.priority as string | null) ?? 'medium');

  // Load request type for routing domain only (NOT for SLA — child SLAs are independent).
  const rtCfg = ticketTypeId
    ? await this.loadRequestTypeConfig(ticketTypeId)
    : { domain: null };

  // Build the row WITHOUT sla_id — resolved after routing fills in assignees.
  const row: Record<string, unknown> = {
    tenant_id: tenant.id,
    parent_ticket_id: parentId,
    ticket_kind: 'work_order',
    ticket_type_id: ticketTypeId,
    title: dto.title,
    description: dto.description ?? null,
    priority,
    interaction_mode: dto.interaction_mode ?? 'internal',
    location_id: locationId,
    asset_id: assetId,
    requester_person_id: (parent.requester_person_id as string | null) ?? null,
    status: 'new',
    status_category: 'new',
    assigned_team_id: dto.assigned_team_id ?? null,
    assigned_user_id: dto.assigned_user_id ?? null,
    assigned_vendor_id: dto.assigned_vendor_id ?? null,
    sla_id: null, // placeholder; resolveChildSla overwrites if it finds one
  };

  // Routing fills in assignees if none were passed.
  let routingCtx: Parameters<RoutingService['evaluate']>[0] | null = null;
  let routingEvaluation: Awaited<ReturnType<RoutingService['evaluate']>> | null = null;
  if (!row.assigned_team_id && !row.assigned_user_id && !row.assigned_vendor_id && ticketTypeId) {
    routingCtx = {
      tenant_id: tenant.id,
      ticket_id: 'pending',
      request_type_id: ticketTypeId,
      domain: rtCfg.domain,
      priority,
      asset_id: assetId,
      location_id: locationId,
    };
    routingEvaluation = await this.routingService.evaluate(routingCtx);
    if (routingEvaluation.target) {
      if (routingEvaluation.target.kind === 'team') row.assigned_team_id = routingEvaluation.target.team_id;
      if (routingEvaluation.target.kind === 'user') row.assigned_user_id = routingEvaluation.target.user_id;
      if (routingEvaluation.target.kind === 'vendor') row.assigned_vendor_id = routingEvaluation.target.vendor_id;
      row.status_category = 'assigned';
    }
  } else if (row.assigned_team_id || row.assigned_user_id || row.assigned_vendor_id) {
    row.status_category = 'assigned';
  }

  // Resolve child SLA based on (now finalised) assignees + dto override.
  const resolvedSlaId = await this.resolveChildSla(dto, row);
  row.sla_id = resolvedSlaId;

  const { data: inserted, error } = await this.supabase.admin
    .from('tickets')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  const child = inserted as Record<string, unknown>;

  // Post-insert side effects.
  try {
    if (routingCtx && routingEvaluation) {
      routingCtx.ticket_id = child.id as string;
      await this.routingService.recordDecision(child.id as string, routingCtx, routingEvaluation);
    }

    if (resolvedSlaId) {
      await this.slaService.startTimers(child.id as string, tenant.id, resolvedSlaId);
    }

    await this.tickets.addActivity(parentId, {
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'dispatched',
        child_id: child.id,
        assigned_team_id: row.assigned_team_id,
        assigned_user_id: row.assigned_user_id,
        assigned_vendor_id: row.assigned_vendor_id,
        sla_id: resolvedSlaId,
      },
    });
  } catch (err) {
    console.error('[dispatch] post-insert automation failed', err);
  }

  return child;
}

/**
 * Resolve which sla_policy_id to attach to a child work order.
 * Order: explicit dto.sla_id → vendor default → team default → user.team default → null.
 * `dto.sla_id === null` is a deliberate "No SLA" choice and short-circuits.
 */
private async resolveChildSla(
  dto: DispatchDto,
  row: Record<string, unknown>,
): Promise<string | null> {
  if (dto.sla_id !== undefined) return dto.sla_id; // explicit (string | null)

  const vendorId = row.assigned_vendor_id as string | null;
  if (vendorId) {
    const { data } = await this.supabase.admin
      .from('vendors')
      .select('default_sla_policy_id')
      .eq('id', vendorId)
      .maybeSingle();
    const id = (data as { default_sla_policy_id: string | null } | null)?.default_sla_policy_id;
    if (id) return id;
  }

  const teamId = row.assigned_team_id as string | null;
  if (teamId) {
    const { data } = await this.supabase.admin
      .from('teams')
      .select('default_sla_policy_id')
      .eq('id', teamId)
      .maybeSingle();
    const id = (data as { default_sla_policy_id: string | null } | null)?.default_sla_policy_id;
    if (id) return id;
  }

  const userId = row.assigned_user_id as string | null;
  if (userId) {
    const { data: user } = await this.supabase.admin
      .from('users')
      .select('team_id')
      .eq('id', userId)
      .maybeSingle();
    const userTeamId = (user as { team_id: string | null } | null)?.team_id;
    if (userTeamId) {
      const { data: team } = await this.supabase.admin
        .from('teams')
        .select('default_sla_policy_id')
        .eq('id', userTeamId)
        .maybeSingle();
      const id = (team as { default_sla_policy_id: string | null } | null)?.default_sla_policy_id;
      if (id) return id;
    }
  }

  return null;
}
```

Update `loadRequestTypeConfig` to drop `sla_policy_id` from its return shape (no longer used by dispatch):

```ts
private async loadRequestTypeConfig(id: string): Promise<{ domain: string | null }> {
  const { data } = await this.supabase.admin
    .from('request_types')
    .select('domain')
    .eq('id', id)
    .maybeSingle();
  const d = data as { domain: string | null } | null;
  return { domain: d?.domain ?? null };
}
```

- [ ] **Step 2.7: Run dispatch tests, confirm all pass**

Run: `pnpm --filter api test -- dispatch.service.spec`
Expected: all tests green (existing 6 + 7 new = 13).

If any test fails because the existing `request_types` mock still returns `sla_policy_id: 'sla-1'`: that's fine, the new code ignores that field. The old assertion that `slaService.startTimers` was called with `'sla-1'` was already fixed in Step 2.5.

- [ ] **Step 2.8: Run the full API test suite to catch any regressions**

Run: `pnpm --filter api test`
Expected: all green. If `workflow-engine.service.spec.ts` fails because it depends on the old SLA inheritance, leave the failure for Task 6 (which fixes the workflow path anyway).

- [ ] **Step 2.9: Commit**

```bash
git add apps/api/src/modules/ticket/dispatch.service.ts apps/api/src/modules/ticket/dispatch.service.spec.ts
git commit -m "fix(dispatch): stop inheriting request_type SLA on children; resolve from vendor/team defaults"
```

---

## Task 3: SlaService — `restartTimers` helper

**Files:**
- Modify: `apps/api/src/modules/sla/sla.service.ts`

**Context:**
Used by Task 4 when a user changes a child's `sla_id`. Stops existing timers, then starts new ones from the new policy. Implementation = `completeTimers` + `startTimers`, but as one method so callers don't have to know the sequence.

- [ ] **Step 3.1: Add the helper method**

Append to the `SlaService` class in `apps/api/src/modules/sla/sla.service.ts`, just below `completeTimers`:

```ts
/**
 * Stop existing timers and start fresh ones from a new policy.
 * Used when a child ticket's sla_id is reassigned (parent cases keep SLA on reassign).
 * If `newSlaPolicyId` is null, only stops existing timers (effectively "switch to No SLA").
 */
async restartTimers(ticketId: string, tenantId: string, newSlaPolicyId: string | null) {
  await this.completeTimers(ticketId, tenantId);

  // Clear ticket-level SLA computed fields. startTimers will re-set them if a policy is provided.
  await this.supabase.admin
    .from('tickets')
    .update({
      sla_response_due_at: null,
      sla_resolution_due_at: null,
      sla_response_breached_at: null,
      sla_resolution_breached_at: null,
      sla_at_risk: false,
      sla_paused: false,
      sla_paused_at: null,
    })
    .eq('id', ticketId);

  if (newSlaPolicyId) {
    await this.startTimers(ticketId, tenantId, newSlaPolicyId);
  }
}
```

- [ ] **Step 3.2: Type-check**

Run: `pnpm --filter api typecheck` (or `pnpm --filter api build` if no typecheck script exists)
Expected: no errors.

- [ ] **Step 3.3: Commit**

```bash
git add apps/api/src/modules/sla/sla.service.ts
git commit -m "feat(sla): add restartTimers helper for child SLA reassignment"
```

---

## Task 4: TicketService — accept `sla_id` PATCH on children

**Files:**
- Modify: `apps/api/src/modules/ticket/ticket.service.ts`
- Modify: `apps/api/src/modules/ticket/dispatch.service.spec.ts` (extend with TicketService coverage — there is no `ticket.service.spec.ts` today; we keep the new tests in a new spec file)
- Create: `apps/api/src/modules/ticket/ticket-sla-edit.spec.ts`

**Context:**
- `UpdateTicketDto` (line 32 of `ticket.service.ts`) currently has no `sla_id` field.
- `update()` (line 623) iterates over DTO entries and writes them to `tickets` table.
- We must:
  - Add `sla_id?: string | null` to `UpdateTicketDto`.
  - In `update()`, special-case `sla_id` changes: refuse for cases (`ticket_kind = 'case'`), apply for children, then call `slaService.restartTimers`, then log a `system_event` activity.
- New spec file because `ticket.service.ts` has no existing test file. Mock dependencies the same way `dispatch.service.spec.ts` does.

- [ ] **Step 4.1: Create the failing test file**

Create `apps/api/src/modules/ticket/ticket-sla-edit.spec.ts`:

```ts
import { TicketService, UpdateTicketDto } from './ticket.service';
import { BadRequestException } from '@nestjs/common';

type Row = {
  id: string;
  tenant_id: string;
  ticket_kind: 'case' | 'work_order';
  status_category: string;
  sla_id: string | null;
};

function makeDeps(initial: Row) {
  let row = { ...initial };
  const updates: Array<Record<string, unknown>> = [];
  const activities: Array<Record<string, unknown>> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: row, error: null }),
                }),
                single: async () => ({ data: row, error: null }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
              row = { ...row, ...patch };
              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({ single: async () => ({ data: row, error: null }) }),
                  }),
                  select: () => ({ single: async () => ({ data: row, error: null }) }),
                }),
              };
            },
          } as unknown;
        }
        return { insert: jest.fn().mockResolvedValue({ data: null, error: null }) } as unknown;
      }),
    },
  };

  const slaService = {
    restartTimers: jest.fn().mockResolvedValue(undefined),
    pauseTimers: jest.fn().mockResolvedValue(undefined),
    resumeTimers: jest.fn().mockResolvedValue(undefined),
    completeTimers: jest.fn().mockResolvedValue(undefined),
  };

  return { row: () => row, updates, activities, supabase, slaService };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  // Minimal stub of unrelated dependencies; tests only exercise the SLA branch.
  const visibility = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };
  const routingService = {} as never;
  const workflowEngine = {} as never;
  const approvalService = {} as never;
  return new TicketService(
    deps.supabase as never,
    routingService,
    deps.slaService as never,
    workflowEngine,
    approvalService,
    visibility as never,
  );
}

describe('TicketService.update — sla_id', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: 't1', subdomain: 't1' });
  });

  it('refuses sla_id change on a parent case', async () => {
    const deps = makeDeps({ id: 'c1', tenant_id: 't1', ticket_kind: 'case', status_category: 'assigned', sla_id: 'sla-old' });
    const svc = makeSvc(deps);
    await expect(
      svc.update('c1', { sla_id: 'sla-new' } as UpdateTicketDto, '__system__'),
    ).rejects.toThrow(BadRequestException);
    expect(deps.slaService.restartTimers).not.toHaveBeenCalled();
  });

  it('accepts sla_id change on a child work_order and restarts timers', async () => {
    const deps = makeDeps({ id: 'wo1', tenant_id: 't1', ticket_kind: 'work_order', status_category: 'assigned', sla_id: 'sla-old' });
    const svc = makeSvc(deps);
    await svc.update('wo1', { sla_id: 'sla-new' } as UpdateTicketDto, '__system__');
    expect(deps.slaService.restartTimers).toHaveBeenCalledWith('wo1', 't1', 'sla-new');
  });

  it('accepts sla_id = null on a child (clear SLA)', async () => {
    const deps = makeDeps({ id: 'wo1', tenant_id: 't1', ticket_kind: 'work_order', status_category: 'assigned', sla_id: 'sla-old' });
    const svc = makeSvc(deps);
    await svc.update('wo1', { sla_id: null } as UpdateTicketDto, '__system__');
    expect(deps.slaService.restartTimers).toHaveBeenCalledWith('wo1', 't1', null);
  });

  it('does not restart timers if sla_id is unchanged', async () => {
    const deps = makeDeps({ id: 'wo1', tenant_id: 't1', ticket_kind: 'work_order', status_category: 'assigned', sla_id: 'sla-same' });
    const svc = makeSvc(deps);
    await svc.update('wo1', { sla_id: 'sla-same' } as UpdateTicketDto, '__system__');
    expect(deps.slaService.restartTimers).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4.2: Run the test, confirm it fails**

Run: `pnpm --filter api test -- ticket-sla-edit.spec`
Expected: FAIL — `update` doesn't yet handle `sla_id`.

- [ ] **Step 4.3: Add `sla_id` to `UpdateTicketDto`**

In `apps/api/src/modules/ticket/ticket.service.ts` around line 32, extend the interface:

```ts
export interface UpdateTicketDto {
  title?: string;
  description?: string;
  status?: string;
  status_category?: string;
  waiting_reason?: string | null;
  priority?: string;
  assigned_team_id?: string | null;
  assigned_user_id?: string | null;
  assigned_vendor_id?: string | null;
  tags?: string[];
  watchers?: string[];
  cost?: number | null;
  satisfaction_rating?: number | null;
  satisfaction_comment?: string | null;
  /**
   * Reassigns the executor SLA on a child work order. Refused on parent cases
   * (parent SLA is locked on reassign per docs §SLA-on-reassignment).
   * Triggers SlaService.restartTimers which stops existing timers and starts new ones.
   * Pass `null` to clear the SLA (no timers will run).
   */
  sla_id?: string | null;
}
```

- [ ] **Step 4.4: Special-case `sla_id` in `update()`**

In `apps/api/src/modules/ticket/ticket.service.ts`, modify the `update` method (currently lines 623–700). The change happens inside the existing method. Insert this block right after `const current = await this.getById(id, SYSTEM_ACTOR);` (around line 633) and before the `for ([key, value])` loop:

```ts
// SLA reassignment guard: only allowed on children, only meaningful if changed.
if (dto.sla_id !== undefined) {
  if ((current as Record<string, unknown>).ticket_kind === 'case') {
    throw new BadRequestException('cannot change sla_id on a case; parent SLA is locked');
  }
}
```

Then, after the existing SLA pause/resume block (around line 671) and before the `// Log changes as system events` comment, insert:

```ts
// SLA policy change on a child: stop existing timers and start fresh ones.
if (changes.sla_id) {
  try {
    await this.slaService.restartTimers(id, tenant.id, (changes.sla_id.to as string | null));
    await this.addActivity(id, {
      activity_type: 'system_event',
      visibility: 'system',
      metadata: {
        event: 'sla_changed',
        from_sla_id: changes.sla_id.from,
        to_sla_id: changes.sla_id.to,
      },
    });
  } catch (err) {
    console.error('[sla] restart on sla_id change failed', err);
  }
}
```

You'll need to add `BadRequestException` to the existing import:

```ts
import { Injectable, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
```

- [ ] **Step 4.5: Run the test, confirm it passes**

Run: `pnpm --filter api test -- ticket-sla-edit.spec`
Expected: all 4 tests pass.

- [ ] **Step 4.6: Run the full API test suite**

Run: `pnpm --filter api test`
Expected: green. (`workflow-engine.service.spec.ts` may still fail — fixed in Task 6.)

- [ ] **Step 4.7: Commit**

```bash
git add apps/api/src/modules/ticket/ticket.service.ts apps/api/src/modules/ticket/ticket-sla-edit.spec.ts
git commit -m "feat(ticket): allow sla_id PATCH on children; refuse on cases"
```

---

## Task 5: TicketService — parent close guard

**Files:**
- Modify: `apps/api/src/modules/ticket/ticket.service.ts`
- Create: `apps/api/src/modules/ticket/ticket-close-guard.spec.ts`

**Context:**
Block transitioning a *case* to `resolved` or `closed` while it has any child with `status_category` not in (`resolved`, `closed`). Returns 400 listing open child IDs. Children can still close independently and roll up via the existing trigger.

- [ ] **Step 5.1: Create the failing test file**

Create `apps/api/src/modules/ticket/ticket-close-guard.spec.ts`:

```ts
import { TicketService, UpdateTicketDto } from './ticket.service';
import { BadRequestException } from '@nestjs/common';

type Row = {
  id: string;
  tenant_id: string;
  ticket_kind: 'case' | 'work_order';
  status_category: string;
  sla_id: string | null;
};

function makeDeps(parent: Row, openChildren: string[]) {
  let row = { ...parent };
  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            select: (cols?: string) => {
              // children query path: select id from tickets where parent_ticket_id = X and status not in (resolved, closed)
              if (cols && cols.includes('id') && !cols.includes('*')) {
                return {
                  eq: () => ({
                    eq: () => ({
                      not: () => ({
                        async then(cb: (v: { data: Array<{ id: string }>; error: null }) => unknown) {
                          return cb({ data: openChildren.map((id) => ({ id })), error: null });
                        },
                      }),
                    }),
                  }),
                };
              }
              return {
                eq: () => ({
                  eq: () => ({
                    single: async () => ({ data: row, error: null }),
                  }),
                  single: async () => ({ data: row, error: null }),
                }),
              };
            },
            update: (patch: Record<string, unknown>) => {
              row = { ...row, ...patch };
              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({ single: async () => ({ data: row, error: null }) }),
                  }),
                  select: () => ({ single: async () => ({ data: row, error: null }) }),
                }),
              };
            },
          } as unknown;
        }
        return { insert: jest.fn().mockResolvedValue({ data: null, error: null }) } as unknown;
      }),
    },
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({}),
    assertVisible: jest.fn().mockResolvedValue(undefined),
  };
  const slaService = {
    pauseTimers: jest.fn(), resumeTimers: jest.fn(), completeTimers: jest.fn(), restartTimers: jest.fn(),
  };
  const svc = new TicketService(
    supabase as never, {} as never, slaService as never, {} as never, {} as never, visibility as never,
  );
  return { svc, row: () => row };
}

describe('TicketService.update — parent close guard', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: 't1', subdomain: 't1' });
  });

  it('refuses to resolve a case while it has open children', async () => {
    const { svc } = makeDeps(
      { id: 'c1', tenant_id: 't1', ticket_kind: 'case', status_category: 'assigned', sla_id: null },
      ['wo-a', 'wo-b'],
    );
    await expect(
      svc.update('c1', { status_category: 'resolved' } as UpdateTicketDto, '__system__'),
    ).rejects.toThrow(BadRequestException);
  });

  it('allows resolving a case with no open children', async () => {
    const { svc, row } = makeDeps(
      { id: 'c1', tenant_id: 't1', ticket_kind: 'case', status_category: 'assigned', sla_id: null },
      [],
    );
    await svc.update('c1', { status_category: 'resolved' } as UpdateTicketDto, '__system__');
    expect(row().status_category).toBe('resolved');
  });

  it('allows resolving a child work_order regardless of its siblings', async () => {
    const { svc, row } = makeDeps(
      { id: 'wo1', tenant_id: 't1', ticket_kind: 'work_order', status_category: 'assigned', sla_id: null },
      ['wo-a'], // would be sibling, but guard is parent-only
    );
    await svc.update('wo1', { status_category: 'resolved' } as UpdateTicketDto, '__system__');
    expect(row().status_category).toBe('resolved');
  });
});
```

- [ ] **Step 5.2: Run the test, confirm it fails**

Run: `pnpm --filter api test -- ticket-close-guard.spec`
Expected: FAIL — guard not implemented.

- [ ] **Step 5.3: Implement the guard**

In `apps/api/src/modules/ticket/ticket.service.ts`, in the `update` method, after the existing `current = await this.getById(...)` line and the SLA guard added in Task 4 (around line 635), insert:

```ts
// Parent close guard: a case cannot move to resolved/closed while children are open.
if (
  (dto.status_category === 'resolved' || dto.status_category === 'closed') &&
  (current as Record<string, unknown>).ticket_kind === 'case'
) {
  const { data: openChildren } = await this.supabase.admin
    .from('tickets')
    .select('id')
    .eq('parent_ticket_id', id)
    .eq('tenant_id', tenant.id)
    .not('status_category', 'in', '(resolved,closed)');
  const childIds = (openChildren ?? []).map((c: { id: string }) => c.id);
  if (childIds.length > 0) {
    throw new BadRequestException(
      `cannot close case while children are open: ${childIds.join(', ')}`,
    );
  }
}
```

- [ ] **Step 5.4: Run the test, confirm it passes**

Run: `pnpm --filter api test -- ticket-close-guard.spec`
Expected: all 3 tests pass.

- [ ] **Step 5.5: Run the full API suite**

Run: `pnpm --filter api test`
Expected: green (except possibly workflow tests, which Task 6 addresses).

- [ ] **Step 5.6: Commit**

```bash
git add apps/api/src/modules/ticket/ticket.service.ts apps/api/src/modules/ticket/ticket-close-guard.spec.ts
git commit -m "feat(ticket): block resolving a case while children are open"
```

---

## Task 6: WorkflowEngineService — pass `sla_policy_id` from `create_child_tasks`

**Files:**
- Modify: `apps/api/src/modules/workflow/workflow-engine.service.ts`
- Modify: `apps/api/src/modules/workflow/workflow-engine.service.spec.ts`

**Context:**
The engine reads `node.config.tasks` and dispatches each one. Today it forwards `title`, `description`, `assigned_team_id`, `priority`, `interaction_mode`. Add forwarding of `sla_policy_id` (mapped to `sla_id` in the dispatch DTO), `assigned_user_id`, `assigned_vendor_id`. The UI (Task 13) will populate these.

- [ ] **Step 6.1: Update existing test and add new failing test**

The existing first test in `apps/api/src/modules/workflow/workflow-engine.service.spec.ts` uses `toEqual` on the DTO and will fail after Task 6.3 adds `assigned_user_id` and `assigned_vendor_id` keys to every dispatch (with `undefined` values). Update the assertion to use `toMatchObject` so it tolerates the wider DTO shape, and add a new test for SLA + assignee forwarding.

Replace the `it('routes each task through DispatchService with copied context', …)` test (currently lines 44–80) with:

```ts
it('routes each task through DispatchService with copied context', async () => {
  const { dispatchService, supabase, dispatchCalls } = makeDeps();
  const engine = new WorkflowEngineService(supabase as never, dispatchService as never);

  const advance = jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
  jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

  const graph = { nodes: [], edges: [] };
  const node = {
    id: 'n1',
    type: 'create_child_tasks',
    config: {
      tasks: [
        { title: 'Replace pane', assigned_team_id: 'glaziers', priority: 'high' },
        { title: '', assigned_team_id: 'janitorial' }, // empty title → falls back
      ],
    },
  };

  await (engine as unknown as {
    executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
  }).executeNode('inst-1', graph, node, 'parent-1', undefined);

  expect(dispatchCalls).toHaveLength(2);
  expect(dispatchCalls[0]).toMatchObject({
    parentId: 'parent-1',
    dto: {
      title: 'Replace pane',
      assigned_team_id: 'glaziers',
      priority: 'high',
    },
  });
  // Task with no sla_policy_id key in source should NOT have sla_id in the DTO.
  expect('sla_id' in dispatchCalls[0].dto).toBe(false);
  expect(dispatchCalls[1].dto.title).toBe('Subtask 2'); // empty-title fallback
  expect(advance).toHaveBeenCalled();
});
```

Then add this new test immediately below it:

```ts
it('forwards sla_policy_id, assigned_user_id, and assigned_vendor_id per task', async () => {
  const { dispatchService, supabase, dispatchCalls } = makeDeps();
  const engine = new WorkflowEngineService(supabase as never, dispatchService as never);

  jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
  jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);

  const node = {
    id: 'n1',
    type: 'create_child_tasks',
    config: {
      tasks: [
        { title: 'Glazier', sla_policy_id: 'sla-glaze', assigned_vendor_id: 'v-glaze' },
        { title: 'Janitor', sla_policy_id: null, assigned_team_id: 't-jan' },
        { title: 'Inspector', assigned_user_id: 'u1' }, // no sla_policy_id key → falls through to defaults
      ],
    },
  };

  await (engine as unknown as {
    executeNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
  }).executeNode('inst-1', { nodes: [], edges: [] }, node, 'parent-1', undefined);

  expect(dispatchCalls).toHaveLength(3);
  expect(dispatchCalls[0].dto.sla_id).toBe('sla-glaze');
  expect(dispatchCalls[0].dto.assigned_vendor_id).toBe('v-glaze');
  expect(dispatchCalls[1].dto.sla_id).toBeNull();
  expect(dispatchCalls[1].dto.assigned_team_id).toBe('t-jan');
  expect('sla_id' in dispatchCalls[2].dto).toBe(false); // not set in task → omitted from DTO
  expect(dispatchCalls[2].dto.assigned_user_id).toBe('u1');
});
```

- [ ] **Step 6.2: Run the test, confirm it fails**

Run: `pnpm --filter api test -- workflow-engine.service.spec`
Expected: FAIL — engine doesn't forward `sla_policy_id`, `assigned_vendor_id`, etc.

- [ ] **Step 6.3: Update the engine**

In `apps/api/src/modules/workflow/workflow-engine.service.ts`, replace the `case 'create_child_tasks'` block (lines 185–215) with:

```ts
case 'create_child_tasks': {
  const tasks = node.config.tasks as Array<{
    title: string;
    description?: string;
    assigned_team_id?: string;
    assigned_user_id?: string;
    assigned_vendor_id?: string;
    interaction_mode?: string;
    priority?: string;
    sla_policy_id?: string | null;
  }> | undefined;

  if (ctx?.dryRun) {
    await this.emit(instanceId, 'node_entered', {
      node_id: node.id, node_type: 'create_child_tasks',
      payload: { dry_run_would_create: tasks?.length ?? 0 },
    }, ctx);
  } else if (tasks && tenant) {
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const title = task.title?.trim() || `Subtask ${i + 1}`;
      try {
        await this.dispatchService.dispatch(ticketId, {
          title,
          description: task.description,
          assigned_team_id: task.assigned_team_id,
          assigned_user_id: task.assigned_user_id,
          assigned_vendor_id: task.assigned_vendor_id,
          priority: task.priority,
          interaction_mode: task.interaction_mode as 'internal' | 'external' | undefined,
          // Pass through ONLY if the task explicitly set the field. `undefined` falls through
          // to DispatchService.resolveChildSla; explicit `null` means "No SLA".
          ...(Object.prototype.hasOwnProperty.call(task, 'sla_policy_id')
            ? { sla_id: task.sla_policy_id ?? null }
            : {}),
        });
      } catch (err) {
        console.error('[workflow] create_child_tasks: dispatch failed', err);
      }
    }
  }

  await this.advance(instanceId, graph, node.id, ticketId, undefined, ctx);
  break;
}
```

- [ ] **Step 6.4: Run tests, confirm pass**

Run: `pnpm --filter api test -- workflow-engine.service.spec`
Expected: green.

Run: `pnpm --filter api test`
Expected: full suite green.

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/src/modules/workflow/workflow-engine.service.ts apps/api/src/modules/workflow/workflow-engine.service.spec.ts
git commit -m "feat(workflow): forward sla_policy_id and full assignee set from create_child_tasks"
```

---

## Task 7: Web — extend `DispatchDto` and `WorkOrderRow` types

**Files:**
- Modify: `apps/web/src/hooks/use-work-orders.ts`

**Context:**
The hook owns the typed shape of dispatch payloads and the row returned by `GET /tickets/:id/children`. Both need to expand. The endpoint already returns the full `tickets` row — the type just needs to widen to surface SLA fields the UI will display.

- [ ] **Step 7.1: Extend the types**

Replace the `WorkOrderRow` and `DispatchDto` interfaces in `apps/web/src/hooks/use-work-orders.ts` with:

```ts
export interface WorkOrderRow {
  id: string;
  title: string;
  status: string;
  status_category: string;
  priority: string;
  ticket_kind: 'case' | 'work_order';
  assigned_team_id: string | null;
  assigned_user_id: string | null;
  assigned_vendor_id: string | null;
  interaction_mode: string;
  created_at: string;
  resolved_at: string | null;
  // SLA fields (already on the tickets row server-side; surfaced for the row chip)
  sla_id: string | null;
  sla_resolution_due_at: string | null;
  sla_resolution_breached_at: string | null;
}

export interface DispatchDto {
  title: string;
  description?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  assigned_vendor_id?: string;
  priority?: string;
  interaction_mode?: 'internal' | 'external';
  /**
   * Executor SLA. `undefined` falls through to vendor/team defaults server-side.
   * Explicit `null` is "No SLA" — the server skips timer creation.
   */
  sla_id?: string | null;
}
```

- [ ] **Step 7.2: Type-check**

Run: `pnpm --filter web typecheck` (or `pnpm --filter web build`)
Expected: errors only at consumer sites that haven't been updated yet (e.g., places that destructured `WorkOrderRow` without these fields). Fix only if the existing code breaks; new fields are additive so most call sites won't notice.

- [ ] **Step 7.3: Commit**

```bash
git add apps/web/src/hooks/use-work-orders.ts
git commit -m "feat(web): extend WorkOrderRow with SLA fields; DispatchDto with sla_id"
```

---

## Task 8: Web — rename + relocate Sub-issues section, delete placeholder, enrich rows

**Files:**
- Create: `apps/web/src/components/desk/sub-issues-section.tsx` (replaces work-orders-section.tsx)
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`
- Delete: `apps/web/src/components/desk/work-orders-section.tsx`

**Context:**
- Today, `ticket-detail.tsx:488-498` renders a hardcoded dead "Sub-issues" placeholder and `ticket-detail.tsx:624-630` renders the real `<WorkOrdersSection>` after Activity. We delete the placeholder, move the real section above Activity, and rename it.
- New rows show: priority dot · title · assignee name+avatar · SLA chip · status badge.
- Assignee names resolved client-side from already-fetched `teams`, `users`, `vendors` (passed from `TicketDetail`).

- [ ] **Step 8.1: Create the new component file**

Create `apps/web/src/components/desk/sub-issues-section.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Clock, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PersonAvatar } from '@/components/person-avatar';
import { useWorkOrders, WorkOrderRow } from '@/hooks/use-work-orders';
import { cn } from '@/lib/utils';

interface AssigneeOption {
  id: string;
  label: string;
}
interface UserOption {
  id: string;
  email: string;
  person?: { first_name?: string; last_name?: string } | null;
}

interface SubIssuesSectionProps {
  parentId: string;
  onAddClick: () => void;
  refreshNonce?: number;
  teams: AssigneeOption[];
  users: UserOption[];
  vendors: AssigneeOption[];
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  new: 'outline',
  assigned: 'secondary',
  in_progress: 'default',
  waiting: 'secondary',
  resolved: 'secondary',
  closed: 'outline',
};

const PRIORITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-blue-500',
  low: 'bg-muted-foreground/40',
  urgent: 'bg-red-500',
};

function assigneeLabel(
  row: WorkOrderRow,
  teams: AssigneeOption[],
  users: UserOption[],
  vendors: AssigneeOption[],
): { label: string; person?: { first_name?: string; last_name?: string } | null } {
  if (row.assigned_vendor_id) {
    const v = vendors.find((x) => x.id === row.assigned_vendor_id);
    return { label: v?.label ?? 'Vendor' };
  }
  if (row.assigned_user_id) {
    const u = users.find((x) => x.id === row.assigned_user_id);
    if (!u) return { label: 'User' };
    const name = u.person
      ? `${u.person.first_name ?? ''} ${u.person.last_name ?? ''}`.trim() || u.email
      : u.email;
    return { label: name, person: u.person ?? null };
  }
  if (row.assigned_team_id) {
    const t = teams.find((x) => x.id === row.assigned_team_id);
    return { label: t?.label ?? 'Team' };
  }
  return { label: 'Unassigned' };
}

function SlaChip({ row }: { row: WorkOrderRow }) {
  if (!row.sla_id) return <span className="text-xs text-muted-foreground/60">No SLA</span>;
  if (row.sla_resolution_breached_at) {
    return (
      <span className="text-xs text-red-500 inline-flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" /> Breached
      </span>
    );
  }
  if (!row.sla_resolution_due_at) return <span className="text-xs text-muted-foreground/60">—</span>;

  const remaining = new Date(row.sla_resolution_due_at).getTime() - Date.now();
  if (remaining <= 0) {
    return (
      <span className="text-xs text-red-500 inline-flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" /> Overdue
      </span>
    );
  }
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const label = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  const tone =
    remaining < 3600000 ? 'text-red-500'
    : remaining < 7200000 ? 'text-yellow-500'
    : 'text-muted-foreground';
  return (
    <span className={cn('text-xs inline-flex items-center gap-1', tone)}>
      <Clock className="h-3 w-3" /> {label}
    </span>
  );
}

export function SubIssuesSection({
  parentId,
  onAddClick,
  refreshNonce = 0,
  teams,
  users,
  vendors,
}: SubIssuesSectionProps) {
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useWorkOrders(parentId);
  const [lastNonce, setLastNonce] = useState(refreshNonce);
  if (refreshNonce !== lastNonce) {
    setLastNonce(refreshNonce);
    refetch();
  }

  return (
    <section className="mt-10">
      <header className="flex items-center gap-3 mb-3">
        <span className="text-sm font-medium">Sub-issues</span>
        {data.length > 0 && <span className="text-xs text-muted-foreground">{data.length}</span>}
        <Button
          variant="ghost"
          size="icon"
          onClick={onAddClick}
          className="ml-auto h-6 w-6 text-muted-foreground"
          aria-label="Add sub-issue"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </header>

      {loading && <p className="text-sm text-muted-foreground py-2">Loading…</p>}

      {error && !loading && (
        <div className="text-sm text-destructive flex items-center gap-2 py-2">
          <span>Failed to load sub-issues.</span>
          <Button size="sm" variant="ghost" onClick={refetch}>Retry</Button>
        </div>
      )}

      {!loading && !error && data.length === 0 && (
        <p className="text-sm text-muted-foreground/60 py-2">No sub-issues yet</p>
      )}

      {!loading && !error && data.length > 0 && (
        <ul className="divide-y rounded-md border">
          {data.map((row) => {
            const { label: assignee, person } = assigneeLabel(row, teams, users, vendors);
            return (
              <li
                key={row.id}
                className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                onClick={() => navigate(`/desk/tickets/${row.id}`)}
              >
                <span
                  className={cn('h-2 w-2 rounded-full shrink-0', PRIORITY_DOT[row.priority] ?? 'bg-muted-foreground/40')}
                  title={`Priority: ${row.priority}`}
                />
                <span className="flex-1 truncate text-sm">{row.title}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
                  {person && <PersonAvatar size="sm" className="size-4" person={person} />}
                  <span className="truncate max-w-[120px]">{assignee}</span>
                </span>
                <span className="w-20 text-right">
                  <SlaChip row={row} />
                </span>
                <Badge variant={STATUS_VARIANT[row.status_category] ?? 'outline'} className="text-xs">
                  {row.status_category.replace('_', ' ')}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 8.2: Update `ticket-detail.tsx` — remove placeholder, mount new section above Activity**

In `apps/web/src/components/desk/ticket-detail.tsx`:

Replace the import on line 40:
```ts
import { WorkOrdersSection } from '@/components/desk/work-orders-section';
```
with:
```ts
import { SubIssuesSection } from '@/components/desk/sub-issues-section';
```

Delete the dead placeholder (lines 488-498):
```jsx
{/* Sub-issues placeholder */}
<div className="mt-10">
  <div className="flex items-center gap-3 mb-3">
    <span className="text-sm font-medium">Sub-issues</span>
    <span className="text-xs text-muted-foreground">0/0</span>
    <Button variant="ghost" size="icon" className="ml-auto h-6 w-6 text-muted-foreground">
      <span className="text-xs">+</span>
    </Button>
  </div>
  <div className="text-sm text-muted-foreground/50 py-2">No sub-issues yet</div>
</div>

<Separator className="my-8" />
```

Replace it with the live `<SubIssuesSection>` mount, followed by the same `<Separator>`:

```jsx
{displayedTicket?.ticket_kind === 'case' && (
  <SubIssuesSection
    parentId={displayedTicket.id}
    onAddClick={() => setAddWorkOrderOpen(true)}
    refreshNonce={workOrdersNonce}
    teams={(teams ?? []).map((t) => ({ id: t.id, label: t.name }))}
    users={users ?? []}
    vendors={(vendors ?? []).map((v) => ({ id: v.id, label: v.name }))}
  />
)}

<Separator className="my-8" />
```

Then delete the **second** mount of the section after Activity (lines 624-630 of the original file, the existing `<WorkOrdersSection>` block):
```jsx
{displayedTicket?.ticket_kind === 'case' && (
  <WorkOrdersSection
    parentId={displayedTicket.id}
    onAddClick={() => setAddWorkOrderOpen(true)}
    refreshNonce={workOrdersNonce}
  />
)}
```

The `<AddWorkOrderDialog>` mount immediately after stays where it is — the dialog is a portal and doesn't need a particular DOM position. (Task 9 renames the dialog component.)

- [ ] **Step 8.3: Delete the old file**

```bash
git rm apps/web/src/components/desk/work-orders-section.tsx
```

- [ ] **Step 8.4: Type-check + run dev server smoke**

Run: `pnpm --filter web typecheck`
Expected: no errors.

Run: `pnpm dev:web` (or `pnpm dev` if already running). Open a ticket detail. Expected: one Sub-issues section appears above Activity with the new row layout. The dead placeholder is gone. Adding a sub-issue still works (existing dialog).

- [ ] **Step 8.5: Commit**

```bash
git add apps/web/src/components/desk/sub-issues-section.tsx apps/web/src/components/desk/ticket-detail.tsx
git commit -m "refactor(desk): rename WorkOrdersSection to SubIssuesSection; remove dead placeholder; enrich rows"
```

---

## Task 9: Web — rename + extend Add sub-issue dialog with SLA picker

**Files:**
- Create: `apps/web/src/components/desk/add-sub-issue-dialog.tsx` (replaces add-work-order-dialog.tsx)
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`
- Delete: `apps/web/src/components/desk/add-work-order-dialog.tsx`

**Context:**
- Rename the component and file. Keep all existing fields (title, description, assignee tabs, priority).
- Add an SLA policy `<Field>`. Below the picker, render a hint that reflects what the server will fall back to: "Will inherit from <vendor/team>: <policy-name>" or "No SLA will run on this sub-issue".
- Three values for the picker: empty (`undefined` — inherit), specific `sla_policy_id` (string), explicit `"none"` (sends `sla_id: null`).

- [ ] **Step 9.1: Create the new component file**

Create `apps/web/src/components/desk/add-sub-issue-dialog.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Field, FieldDescription, FieldError, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { EntityPicker, EntityOption } from '@/components/desk/editors/entity-picker';
import { useDispatchWorkOrder } from '@/hooks/use-work-orders';
import { useApi } from '@/hooks/use-api';

interface AddSubIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentId: string;
  parentPriority: string;
  teamOptions: EntityOption[];
  userOptions: EntityOption[];
  vendorOptions: EntityOption[];
  onDispatched: () => void;
}

interface SlaPolicy { id: string; name: string }
interface VendorWithDefault { id: string; name: string; default_sla_policy_id: string | null }
interface TeamWithDefault { id: string; name: string; default_sla_policy_id: string | null }

type AssignTab = 'team' | 'user' | 'vendor';

const PRIORITIES: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

// Sentinel string used by the SLA Select; mapped to dto.sla_id = null on submit.
const SLA_NONE = 'none';
// Empty string represents "inherit from default" (dto.sla_id = undefined on submit).
const SLA_INHERIT = '';

export function AddSubIssueDialog({
  open,
  onOpenChange,
  parentId,
  parentPriority,
  teamOptions,
  userOptions,
  vendorOptions,
  onDispatched,
}: AddSubIssueDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(parentPriority);
  const [tab, setTab] = useState<AssignTab>('team');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [slaSelection, setSlaSelection] = useState<string>(SLA_INHERIT);

  const [titleError, setTitleError] = useState<string | null>(null);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: slaPolicies } = useApi<SlaPolicy[]>('/sla-policies', []);
  const { data: vendorsWithDefaults } = useApi<VendorWithDefault[]>('/vendors', []);
  const { data: teamsWithDefaults } = useApi<TeamWithDefault[]>('/teams', []);

  const { dispatch, submitting } = useDispatchWorkOrder(parentId);

  function reset() {
    setTitle(''); setDescription(''); setPriority(parentPriority);
    setTab('team'); setTeamId(null); setUserId(null); setVendorId(null);
    setSlaSelection(SLA_INHERIT);
    setTitleError(null); setAssigneeError(null); setFormError(null);
  }

  function onTabChange(next: string) {
    const t = next as AssignTab;
    setTab(t);
    if (t !== 'team') setTeamId(null);
    if (t !== 'user') setUserId(null);
    if (t !== 'vendor') setVendorId(null);
    setAssigneeError(null);
  }

  // Hint shown under the SLA picker — reflects what the server will resolve if user leaves it empty.
  const inheritedSlaHint = useMemo(() => {
    if (slaSelection !== SLA_INHERIT) return null;
    const policyName = (id: string | null) => slaPolicies?.find((p) => p.id === id)?.name ?? null;

    if (tab === 'vendor' && vendorId) {
      const v = vendorsWithDefaults?.find((x) => x.id === vendorId);
      const name = policyName(v?.default_sla_policy_id ?? null);
      return name ? `Will inherit from vendor: ${name}` : 'No SLA will run on this sub-issue';
    }
    if (tab === 'team' && teamId) {
      const t = teamsWithDefaults?.find((x) => x.id === teamId);
      const name = policyName(t?.default_sla_policy_id ?? null);
      return name ? `Will inherit from team: ${name}` : 'No SLA will run on this sub-issue';
    }
    if (tab === 'user' && userId) {
      // Server falls through user → user.team → team default. Without a team-membership
      // lookup here we just say "from the user's team if set".
      return 'Will inherit from the assignee\'s team default if set';
    }
    return 'Pick an assignee to see the inherited default';
  }, [slaSelection, tab, vendorId, teamId, userId, vendorsWithDefaults, teamsWithDefaults, slaPolicies]);

  async function onSubmit() {
    setTitleError(null); setAssigneeError(null); setFormError(null);
    const trimmed = title.trim();
    if (!trimmed) { setTitleError('Title is required'); return; }

    const selectedId = tab === 'team' ? teamId : tab === 'user' ? userId : vendorId;
    if (!selectedId) { setAssigneeError('Pick an assignee'); return; }

    // Map SLA picker value to DTO shape.
    let slaPayload: { sla_id?: string | null } = {};
    if (slaSelection === SLA_NONE) slaPayload = { sla_id: null };
    else if (slaSelection !== SLA_INHERIT) slaPayload = { sla_id: slaSelection };

    try {
      await dispatch({
        title: trimmed,
        description: description.trim() || undefined,
        priority,
        assigned_team_id: tab === 'team' ? selectedId : undefined,
        assigned_user_id: tab === 'user' ? selectedId : undefined,
        assigned_vendor_id: tab === 'vendor' ? selectedId : undefined,
        ...slaPayload,
      });
      toast.success(`Sub-issue "${trimmed}" added`);
      onDispatched();
      reset();
      onOpenChange(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to add sub-issue';
      setFormError(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); if (!next) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add sub-issue</DialogTitle>
          <DialogDescription>
            Send a piece of this case to a vendor, team, or teammate. They get their own ticket with its own SLA.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="si-title">Title</FieldLabel>
            <Input
              id="si-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Replace broken pane"
              disabled={submitting}
            />
            {titleError && <FieldError>{titleError}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="si-description">Description</FieldLabel>
            <Textarea
              id="si-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details the assignee should know"
              rows={3}
              disabled={submitting}
            />
          </Field>

          <Field>
            <FieldLabel>Assignee</FieldLabel>
            <Tabs value={tab} onValueChange={onTabChange}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="team">Team</TabsTrigger>
                <TabsTrigger value="user">User</TabsTrigger>
                <TabsTrigger value="vendor">Vendor</TabsTrigger>
              </TabsList>
              <TabsContent value="team" className="pt-2">
                <EntityPicker
                  value={teamId}
                  options={teamOptions}
                  placeholder="team"
                  clearLabel="Clear team"
                  onChange={(opt) => setTeamId(opt?.id ?? null)}
                />
              </TabsContent>
              <TabsContent value="user" className="pt-2">
                <EntityPicker
                  value={userId}
                  options={userOptions}
                  placeholder="user"
                  clearLabel="Clear user"
                  onChange={(opt) => setUserId(opt?.id ?? null)}
                />
              </TabsContent>
              <TabsContent value="vendor" className="pt-2">
                <EntityPicker
                  value={vendorId}
                  options={vendorOptions}
                  placeholder="vendor"
                  clearLabel="Clear vendor"
                  onChange={(opt) => setVendorId(opt?.id ?? null)}
                />
              </TabsContent>
            </Tabs>
            {assigneeError && <FieldError>{assigneeError}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="si-priority">Priority</FieldLabel>
            <Select value={priority} onValueChange={(v) => { if (v != null) setPriority(v); }} disabled={submitting}>
              <SelectTrigger id="si-priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Defaults to the parent case's priority.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="si-sla">SLA policy</FieldLabel>
            <Select
              value={slaSelection}
              onValueChange={(v) => setSlaSelection(v ?? SLA_INHERIT)}
              disabled={submitting}
            >
              <SelectTrigger id="si-sla"><SelectValue placeholder="Inherit from default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={SLA_INHERIT}>Inherit from default</SelectItem>
                <SelectItem value={SLA_NONE}>No SLA</SelectItem>
                {(slaPolicies ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {inheritedSlaHint && <FieldDescription>{inheritedSlaHint}</FieldDescription>}
          </Field>

          {formError && (
            <p className="text-sm text-destructive" role="alert">{formError}</p>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Adding…' : 'Add sub-issue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 9.2: Update `ticket-detail.tsx` to use the new dialog name**

In `apps/web/src/components/desk/ticket-detail.tsx`:

Replace the import on line 41:
```ts
import { AddWorkOrderDialog } from '@/components/desk/add-work-order-dialog';
```
with:
```ts
import { AddSubIssueDialog } from '@/components/desk/add-sub-issue-dialog';
```

Replace the dialog mount (around lines 632-652 of the current file after Task 8 edits):
```jsx
{displayedTicket?.ticket_kind === 'case' && (
  <AddWorkOrderDialog
    open={addWorkOrderOpen}
    onOpenChange={setAddWorkOrderOpen}
    ...
```
with:
```jsx
{displayedTicket?.ticket_kind === 'case' && (
  <AddSubIssueDialog
    open={addWorkOrderOpen}
    onOpenChange={setAddWorkOrderOpen}
    parentId={displayedTicket.id}
    parentPriority={displayedTicket.priority ?? 'medium'}
    teamOptions={(teams ?? []).map((t) => ({ id: t.id, label: t.name }))}
    userOptions={(users ?? []).map((u) => ({
      id: u.id,
      label: u.person
        ? `${u.person.first_name ?? ''} ${u.person.last_name ?? ''}`.trim() || u.email
        : u.email,
      sublabel: u.email,
    }))}
    vendorOptions={(vendors ?? []).map((v) => ({ id: v.id, label: v.name }))}
    onDispatched={() => {
      setWorkOrdersNonce((n) => n + 1);
      refetchTicket();
    }}
  />
)}
```

(The state variable `addWorkOrderOpen` keeps its name to minimize churn — only the component name changes.)

- [ ] **Step 9.3: Delete the old dialog file**

```bash
git rm apps/web/src/components/desk/add-work-order-dialog.tsx
```

- [ ] **Step 9.4: Smoke test**

Run dev server. Open a case. Click the `+` in the Sub-issues header. Expected: dialog title says "Add sub-issue". Picking a vendor with a default SLA shows the inherit hint. Picking "No SLA" submits with `sla_id: null`. Picking a specific policy submits with that id.

- [ ] **Step 9.5: Commit**

```bash
git add apps/web/src/components/desk/add-sub-issue-dialog.tsx apps/web/src/components/desk/ticket-detail.tsx
git commit -m "feat(desk): add SLA picker to Add sub-issue dialog; rename from AddWorkOrderDialog"
```

---

## Task 10: Web — child detail SLA picker in properties sidebar

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

**Context:**
Currently the SLA block in the right sidebar (lines ~927-930 after Task 8 edits) is read-only:
```jsx
<div>
  <div className="text-xs text-muted-foreground mb-1.5">SLA</div>
  <SlaTimer dueAt={displayedTicket!.sla_resolution_due_at} breachedAt={displayedTicket!.sla_resolution_breached_at} />
</div>
```
On a child (`ticket_kind === 'work_order'`), expose an editable SLA picker. On a case, keep the read-only display.

- [ ] **Step 10.1: Extend `TicketData` interface and useApi calls**

In `ticket-detail.tsx`, extend `TicketData` (currently at line 70) to include `sla_id`:

```ts
interface TicketData {
  id: string;
  ticket_kind: 'case' | 'work_order';
  parent_ticket_id: string | null;
  // ... existing fields ...
  sla_id: string | null;
  sla_at_risk: boolean;
  // ... rest unchanged
}
```

Add an SLA-policies fetch alongside the other `useApi` calls (top of `TicketDetail` around line 233):

```ts
const { data: slaPolicies } = useApi<Array<{ id: string; name: string }>>('/sla-policies', []);
```

- [ ] **Step 10.2: Replace the SLA sidebar block**

Find the SLA block in the properties sidebar and replace with:

```jsx
{/* SLA */}
<div>
  <div className="text-xs text-muted-foreground mb-1.5">SLA</div>
  {displayedTicket!.ticket_kind === 'work_order' ? (
    <Select
      value={displayedTicket!.sla_id ?? '__none__'}
      onValueChange={(v) => {
        const next = v === '__none__' ? null : v;
        if (next !== displayedTicket!.sla_id) patch({ sla_id: next } as Partial<UpdateTicketPayload>);
      }}
    >
      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="No SLA" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__">No SLA</SelectItem>
        {(slaPolicies ?? []).map((p) => (
          <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : null}
  <div className={displayedTicket!.ticket_kind === 'work_order' ? 'mt-2' : ''}>
    <SlaTimer dueAt={displayedTicket!.sla_resolution_due_at} breachedAt={displayedTicket!.sla_resolution_breached_at} />
  </div>
</div>
```

- [ ] **Step 10.3: Extend `UpdateTicketPayload` (if needed)**

Check `apps/web/src/hooks/use-ticket-mutation.ts`:

```bash
grep -n "UpdateTicketPayload" apps/web/src/hooks/use-ticket-mutation.ts
```

If `sla_id` is missing from the type, add `sla_id?: string | null;` to it. The hook just forwards arbitrary fields to the backend PATCH, so the runtime change is "extend the type".

- [ ] **Step 10.4: Smoke test**

Open a child work-order. Confirm the SLA block shows a Select. Change to a different policy → toast (or silent if optimistic) → timer countdown re-renders from new policy. Change to "No SLA" → countdown disappears.

- [ ] **Step 10.5: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx apps/web/src/hooks/use-ticket-mutation.ts
git commit -m "feat(desk): editable SLA picker on child ticket properties sidebar"
```

---

## Task 11: Web — vendor admin default SLA picker

**Files:**
- Modify: `apps/web/src/pages/admin/vendors.tsx`

**Context:**
The vendors edit dialog needs a `default_sla_policy_id` field. The backend update is via existing PATCH (the supabase-admin update accepts arbitrary columns; verify nothing rejects unknown fields server-side). Use the Field primitives.

- [ ] **Step 11.1: Add SLA-policies fetch and state**

Near the top of `VendorsPage`, add:

```ts
const { data: slaPolicies } = useApi<Array<{ id: string; name: string }>>('/sla-policies', []);
const [defaultSlaPolicyId, setDefaultSlaPolicyId] = useState<string>('');
```

In the `Vendor` interface, add:
```ts
default_sla_policy_id: string | null;
```

- [ ] **Step 11.2: Add a Field to the vendor edit dialog**

Locate the vendor edit Dialog form. After the existing fields (likely near the bottom of the FieldGroup), insert:

```tsx
<Field>
  <FieldLabel htmlFor="vendor-default-sla">Default SLA policy</FieldLabel>
  <Select value={defaultSlaPolicyId} onValueChange={(v) => setDefaultSlaPolicyId(v ?? '')}>
    <SelectTrigger id="vendor-default-sla"><SelectValue placeholder="None" /></SelectTrigger>
    <SelectContent>
      <SelectItem value="">None</SelectItem>
      {(slaPolicies ?? []).map((p) => (
        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
      ))}
    </SelectContent>
  </Select>
  <FieldDescription>
    Falls back to this when a sub-issue is dispatched to this vendor without an explicit SLA pick.
  </FieldDescription>
</Field>
```

- [ ] **Step 11.3: Wire load/save**

In the function that opens the dialog for an existing vendor (search for `setEditId` calls), populate state:
```ts
setDefaultSlaPolicyId(v.default_sla_policy_id ?? '');
```

In the form submit handler, include the field in the PATCH payload:
```ts
default_sla_policy_id: defaultSlaPolicyId || null,
```

In the `reset` (or close) helper, reset to empty:
```ts
setDefaultSlaPolicyId('');
```

- [ ] **Step 11.4: Smoke test**

Open admin → Vendors → Edit a vendor → set Default SLA → Save. Reopen → field is populated. Then create a child work-order assigned to that vendor with no explicit SLA → child shows the vendor's policy.

- [ ] **Step 11.5: Commit**

```bash
git add apps/web/src/pages/admin/vendors.tsx
git commit -m "feat(admin): vendor default SLA policy picker"
```

---

## Task 12: Web — team admin default SLA picker

**Files:**
- Modify: `apps/web/src/pages/admin/teams.tsx`

**Context:** Same shape as Task 11, applied to the teams page.

- [ ] **Step 12.1: Add fetch + state**

```ts
const { data: slaPolicies } = useApi<Array<{ id: string; name: string }>>('/sla-policies', []);
const [defaultSlaPolicyId, setDefaultSlaPolicyId] = useState<string>('');
```

In the team interface used by the page, add `default_sla_policy_id: string | null`.

- [ ] **Step 12.2: Add a Field to the team edit dialog**

Place after existing fields:

```tsx
<Field>
  <FieldLabel htmlFor="team-default-sla">Default SLA policy</FieldLabel>
  <Select value={defaultSlaPolicyId} onValueChange={(v) => setDefaultSlaPolicyId(v ?? '')}>
    <SelectTrigger id="team-default-sla"><SelectValue placeholder="None" /></SelectTrigger>
    <SelectContent>
      <SelectItem value="">None</SelectItem>
      {(slaPolicies ?? []).map((p) => (
        <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
      ))}
    </SelectContent>
  </Select>
  <FieldDescription>
    Falls back to this when a sub-issue is dispatched to this team (or to a user on this team) without an explicit SLA pick.
  </FieldDescription>
</Field>
```

- [ ] **Step 12.3: Wire load/save/reset**

Same pattern as vendors:
- On edit-load: `setDefaultSlaPolicyId(t.default_sla_policy_id ?? '')`
- On submit: include `default_sla_policy_id: defaultSlaPolicyId || null`
- On reset: `setDefaultSlaPolicyId('')`

- [ ] **Step 12.4: Smoke test**

Same flow as vendors but for teams.

- [ ] **Step 12.5: Commit**

```bash
git add apps/web/src/pages/admin/teams.tsx
git commit -m "feat(admin): team default SLA policy picker"
```

---

## Task 13: Web — workflow node form: per-task SLA + assignee + priority

**Files:**
- Modify: `apps/web/src/components/workflow-editor/inspector-forms/create-child-tasks-form.tsx`

**Context:**
Today the per-task editor only collects title and description. The engine (after Task 6) also accepts `assigned_team_id`, `assigned_user_id`, `assigned_vendor_id`, `priority`, `sla_policy_id`. Expose the assignee picker (single tabbed picker) plus priority and SLA policy per task.

- [ ] **Step 13.1: Replace the form file**

Replace the contents of `apps/web/src/components/workflow-editor/inspector-forms/create-child-tasks-form.tsx` with:

```tsx
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Field, FieldGroup, FieldLabel, FieldLegend, FieldSet,
} from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2 } from 'lucide-react';

interface Task {
  title: string;
  description?: string;
  priority?: string;
  assigned_team_id?: string;
  sla_policy_id?: string | null;
}

interface Team { id: string; name: string }
interface SlaPolicy { id: string; name: string }

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const SLA_INHERIT = '';
const SLA_NONE = '__none__';

export function CreateChildTasksForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const tasks = ((node.config as { tasks?: Task[] }).tasks ?? []) as Task[];
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: slaPolicies } = useApi<SlaPolicy[]>('/sla-policies', []);

  const setTasks = (t: Task[]) => update(node.id, { tasks: t });
  const patchTask = (i: number, patch: Partial<Task>) =>
    setTasks(tasks.map((x, j) => j === i ? { ...x, ...patch } : x));

  const slaValueFor = (t: Task): string => {
    if (t.sla_policy_id === undefined) return SLA_INHERIT;
    if (t.sla_policy_id === null) return SLA_NONE;
    return t.sla_policy_id;
  };
  const onSlaChange = (i: number, v: string) => {
    if (v === SLA_INHERIT) {
      const { sla_policy_id, ...rest } = tasks[i];
      void sla_policy_id;
      setTasks(tasks.map((x, j) => j === i ? rest : x));
    } else if (v === SLA_NONE) {
      patchTask(i, { sla_policy_id: null });
    } else {
      patchTask(i, { sla_policy_id: v });
    }
  };

  return (
    <FieldGroup>
      <FieldSet>
        <FieldLegend variant="label" className="text-xs">Child tasks</FieldLegend>
        {tasks.map((t, i) => (
          <div key={i} className="grid gap-2 border rounded p-2">
            <Field>
              <FieldLabel htmlFor={`task-${i}-title`}>Title</FieldLabel>
              <Input
                id={`task-${i}-title`}
                value={t.title ?? ''}
                placeholder="Title"
                onChange={(e) => patchTask(i, { title: e.target.value })}
                disabled={readOnly}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`task-${i}-desc`}>Description</FieldLabel>
              <Input
                id={`task-${i}-desc`}
                value={t.description ?? ''}
                placeholder="Description (optional)"
                onChange={(e) => patchTask(i, { description: e.target.value })}
                disabled={readOnly}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`task-${i}-team`}>Assigned team</FieldLabel>
              <Select
                value={t.assigned_team_id ?? ''}
                onValueChange={(v) => patchTask(i, { assigned_team_id: v || undefined })}
                disabled={readOnly}
              >
                <SelectTrigger id={`task-${i}-team`}><SelectValue placeholder="Resolver decides" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Resolver decides</SelectItem>
                  {(teams ?? []).map((tm) => (
                    <SelectItem key={tm.id} value={tm.id}>{tm.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`task-${i}-prio`}>Priority</FieldLabel>
              <Select
                value={t.priority ?? ''}
                onValueChange={(v) => patchTask(i, { priority: v || undefined })}
                disabled={readOnly}
              >
                <SelectTrigger id={`task-${i}-prio`}><SelectValue placeholder="Inherit from parent" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Inherit from parent</SelectItem>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`task-${i}-sla`}>SLA policy</FieldLabel>
              <Select
                value={slaValueFor(t)}
                onValueChange={(v) => onSlaChange(i, v)}
                disabled={readOnly}
              >
                <SelectTrigger id={`task-${i}-sla`}><SelectValue placeholder="Inherit from default" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={SLA_INHERIT}>Inherit from default</SelectItem>
                  <SelectItem value={SLA_NONE}>No SLA</SelectItem>
                  {(slaPolicies ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTasks(tasks.filter((_, j) => j !== i))}
              disabled={readOnly}
              className="gap-1 w-fit"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTasks([...tasks, { title: '' }])}
          disabled={readOnly}
          className="gap-1 w-fit"
        >
          <Plus className="h-3.5 w-3.5" /> Add task
        </Button>
      </FieldSet>
    </FieldGroup>
  );
}
```

- [ ] **Step 13.2: Type-check**

Run: `pnpm --filter web typecheck`
Expected: green.

- [ ] **Step 13.3: Smoke test**

Open admin → Workflow Templates → edit a workflow with a `create_child_tasks` node. Confirm the inspector now shows team, priority, and SLA pickers per task. Save the workflow. Run the workflow against a test ticket; verify children dispatched with the picked SLA via DB or child view.

- [ ] **Step 13.4: Commit**

```bash
git add apps/web/src/components/workflow-editor/inspector-forms/create-child-tasks-form.tsx
git commit -m "feat(workflow): per-task team/priority/SLA pickers in create_child_tasks form"
```

---

## Task 14: Docs — update assignments-routing-fulfillment.md

**Files:**
- Modify: `docs/assignments-routing-fulfillment.md`

**Context:**
Mandatory per `CLAUDE.md`: any change to dispatch, SLA, or routing requires the doc to be updated in the same change set.

- [ ] **Step 14.1: Replace §7 (SLA timers) with the two-track model**

Open `docs/assignments-routing-fulfillment.md`. Find §7 "SLA timers" (around line 250 of the file).

Replace the existing first paragraph (the one that begins "Attached at ticket creation (for cases) and at dispatch (for work orders). Both paths…") with:

```markdown
**Two SLAs, two clocks, two audiences.**

| | Case (`ticket_kind = 'case'`) | Child (`ticket_kind = 'work_order'`) |
|---|---|---|
| Audience | Requester (employee) | Service desk |
| Promised by | Service desk team | Executor (vendor or internal team) |
| Source of `sla_id` | `request_types.sla_policy_id` | Resolution order below — **never** `request_types.sla_policy_id` |
| Set when | Case is created | Child is dispatched (manual or workflow) |
| Mutable when | Locked on reassign | Editable in the child's properties sidebar (timers restart) |

### Case SLA — `request_types.sla_policy_id`

Attached at case creation. `TicketService.runPostCreateAutomation` reads `request_types.sla_policy_id` and calls `SlaService.startTimers(caseId, tenantId, slaPolicyId)`. Locked on reassign per the rule below.

### Child SLA resolution order

When a child is created (manual `POST /tickets/:id/dispatch` or workflow `create_child_tasks`), `DispatchService.resolveChildSla` picks the policy by, first match wins:

1. **Explicit:** `dto.sla_id` (manual UI pick or workflow node's per-task `sla_policy_id`). Pass `null` to mean "No SLA — no timer runs".
2. **Vendor default:** `assigned_vendor_id` → `vendors.default_sla_policy_id`.
3. **Team default:** `assigned_team_id` → `teams.default_sla_policy_id`.
4. **User's team default:** `assigned_user_id` → that user's `team_id` → `teams.default_sla_policy_id`.
5. **None.** `sla_id = null`. No `sla_timers` rows are created. UI surfaces this state as "No SLA".

If both `assigned_vendor_id` and `assigned_team_id` are set, the **vendor** default wins (vendor SLA is contractual; team default is internal convention).

### SLA on reassignment

**Same rule for both layers: SLA does not change on assignee reassignment.** Cases and children both keep `sla_id` and timer state across silent PATCH or `POST /tickets/:id/reassign`. To change a child's SLA the user must explicitly pick a new policy in the child's properties sidebar — that action calls `SlaService.restartTimers`, which stops existing `sla_timers` rows and starts new ones.

`request_types.sla_policy_id` is, after this change, **only** the case policy. Schema:
- `vendors.default_sla_policy_id` (nullable, FK `sla_policies(id)`) — added in `00035`.
- `teams.default_sla_policy_id` (nullable, FK `sla_policies(id)`) — added in `00035`.
```

(Then the existing paragraph about pause/resume timers and the `pause_on_waiting_reasons` field continues unchanged.)

- [ ] **Step 14.2: Add note to §6.5 about parent close guard**

Find §6.5 "Skip auto-routing for work orders". Insert a new sub-section above or below it (within §6):

```markdown
### 6.6 Parent close guard

A case in `status_category = 'case'` cannot move to `resolved` or `closed` while it has children with `status_category` not in (`resolved`, `closed`). `TicketService.update` enforces this guard and returns `400 Bad Request` with the open child IDs in the message. Children continue to roll up via the existing `rollup_parent_status()` trigger.

Workflows that programmatically close cases must close their children first; otherwise the close transition will fail loudly.
```

- [ ] **Step 14.3: Append a changelog entry**

Find the changelog section at the bottom of the file (where the "2026-04-18 — Workflow-spawned children reach parity..." entry lives). Add at the top of the list:

```markdown
- **2026-04-20 — Two-track SLA model.** Children no longer inherit `request_types.sla_policy_id` (that's the *case* policy). `DispatchService.resolveChildSla` now resolves child `sla_id` via explicit DTO → `vendors.default_sla_policy_id` → `teams.default_sla_policy_id` → user→team → none. New schema in `00035`. Existing children keep their (incorrectly-inherited) `sla_id` — no backfill. Cases gain a close guard that refuses `resolved`/`closed` while open children exist.
```

- [ ] **Step 14.4: Commit**

```bash
git add docs/assignments-routing-fulfillment.md
git commit -m "docs: two-track SLA model and parent close guard"
```

---

## Task 15: Smoke pass

**Files:** none.

**Context:** Verify the user-visible flows end-to-end against the running app.

- [ ] **Step 15.1: Start dev server and reset state**

```bash
pnpm dev
```

- [ ] **Step 15.2: Sub-issues placement**

Open any case in the desk. Expected:
- Single "Sub-issues" section above the Activity timeline.
- Header shows "Sub-issues" + count + "+" button.
- Empty state reads "No sub-issues yet" (subtle text, no fake `0/0`).

- [ ] **Step 15.3: Add sub-issue with explicit SLA**

Click "+", pick an assignee (any), pick a specific SLA policy, submit. Expected:
- Toast "Sub-issue '<title>' added".
- Row appears with priority dot, assignee name, SLA countdown, status badge.
- Click the row → child detail view loads.

- [ ] **Step 15.4: Add sub-issue with inherited vendor SLA**

Set a vendor's default SLA (admin → Vendors → edit → Default SLA). Add a sub-issue assigned to that vendor with no explicit SLA pick. Expected:
- Hint in the dialog: "Will inherit from vendor: <policy-name>".
- After submit, row shows the vendor's policy countdown.

- [ ] **Step 15.5: Add sub-issue with no SLA**

Pick "No SLA" in the dialog (any assignee). Expected:
- Hint dropdown shows "No SLA".
- Row shows "No SLA" instead of countdown.

- [ ] **Step 15.6: Edit child SLA post-create**

Open a child detail. In the properties sidebar, change the SLA policy. Expected:
- Live countdown switches to the new policy's targets within ~1s.
- An activity row "sla_changed" appears in the timeline.

- [ ] **Step 15.7: Parent close guard**

Open a case with at least one open sub-issue. Try to move status to "Resolved". Expected:
- Toast/error: "cannot close case while children are open: <id>".
- Status does not change.

Resolve all children, then resolve the case → succeeds.

- [ ] **Step 15.8: Workflow-spawned child SLA**

Edit a workflow with a `create_child_tasks` node. Pick a per-task SLA. Trigger the workflow on a test case. Expected:
- Each spawned child's `sla_id` matches the per-task pick (verify via child detail or DB).

- [ ] **Step 15.9: Confirm completion to user**

Report what was tested and any anomalies. Ask: *"Smoke pass complete. Anything else to verify before merging?"*

---

## Notes for the executing engineer

- **Commits in this repo:** the user-level rule (`~/.claude/CLAUDE.md`) is "only commit when explicitly requested." If you're running this plan via `superpowers:executing-plans` or `superpowers:subagent-driven-development`, follow the user's commit policy — confirm with the user before each commit step or batch commits at logical checkpoints.
- **Migrations and remote DB:** Task 1 includes the explicit checkpoint to confirm before `pnpm db:push`. Do not skip — `CLAUDE.md` treats this as a deploy.
- **Test framework:** the API uses Jest, not Vitest. Test files are co-located as `*.spec.ts`.
- **Web has no project-wide test runner** — frontend verification is manual smoke (Tasks 8–13 have smoke steps).
- **Field primitives are mandatory** per `CLAUDE.md`. All new form code in this plan uses `<Field>`, `<FieldLabel>`, `<FieldDescription>`, etc. Do not regress to bare `<div className="grid gap-1.5">` patterns.
