# Dispatch UI + Workflow Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the case / work-order model usable from the service desk UI, close the parity gap between manual dispatch and workflow-spawned children, and consolidate the two overlapping routing docs into one canonical reference.

**Architecture:** Backend gets a thin `GET /tickets/:id/children` read endpoint and a refactor of the workflow engine's `create_child_tasks` node to call `DispatchService.dispatch` instead of inserting tickets directly. Frontend adds three small components (`ParentCaseRibbon`, `WorkOrdersSection`, `AddWorkOrderDialog`) and one hook (`useWorkOrders`), then mounts them inside `ticket-detail.tsx` gated on `ticket_kind`. Docs: fold `docs/routing.md` into `docs/assignments-routing-fulfillment.md`.

**Tech Stack:** NestJS, TypeScript, Jest (backend). React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui (frontend). No React Query — the project uses `apiFetch` + `useState/useEffect` + caller-provided `refetch` callbacks.

---

## File structure

### Backend

| File | Change | Responsibility |
|---|---|---|
| `apps/api/src/modules/ticket/ticket.controller.ts` | Modify | Add `GET :id/children`. |
| `apps/api/src/modules/workflow/workflow.module.ts` | Modify | Import `TicketModule` via `forwardRef` to pull in `DispatchService`. |
| `apps/api/src/modules/workflow/workflow-engine.service.ts` | Modify | `create_child_tasks` node calls `DispatchService.dispatch` instead of inline insert. Inject `DispatchService` via `forwardRef`. |
| `apps/api/src/modules/workflow/workflow-engine.service.spec.ts` | New | Parity test: `create_child_tasks` routes through `DispatchService`. |
| `apps/api/src/modules/ticket/ticket.controller.spec.ts` | New | One unit test asserting `children()` delegates to `TicketService.getChildTasks`. |

### Frontend

| File | Change | Responsibility |
|---|---|---|
| `apps/web/src/hooks/use-work-orders.ts` | New | `useWorkOrders(parentId)` + `useDispatchWorkOrder(parentId)` following the project's `apiFetch` + `useState`/`useEffect` pattern. |
| `apps/web/src/components/desk/parent-case-ribbon.tsx` | New | Small header ribbon linking a work-order view back to its parent case. |
| `apps/web/src/components/desk/work-orders-section.tsx` | New | Section rendered on case detail: header (count + Add button), children list, empty state. |
| `apps/web/src/components/desk/add-work-order-dialog.tsx` | New | shadcn Dialog, Field-composed form, tabbed Team/User/Vendor `EntityPicker`. |
| `apps/web/src/components/desk/ticket-detail.tsx` | Modify | Mount ribbon at top when `ticket_kind === 'work_order'`; mount section after activity timeline when `ticket_kind === 'case'`. |

### Documentation

| File | Change | Responsibility |
|---|---|---|
| `docs/assignments-routing-fulfillment.md` | Modify | Absorb content from `docs/routing.md`: when resolver runs, PATCH vs /reassign, SLA on reassignment, scope-field rationale, known gaps, Resolved section. |
| `docs/routing.md` | Delete | Consolidated. |

---

## Task 1: `GET /tickets/:id/children` endpoint

**Files:**
- Create: `apps/api/src/modules/ticket/ticket.controller.spec.ts`
- Modify: `apps/api/src/modules/ticket/ticket.controller.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/ticket/ticket.controller.spec.ts`:

```typescript
import { TicketController } from './ticket.controller';

describe('TicketController.children', () => {
  it('delegates to TicketService.getChildTasks with the given id', async () => {
    const ticketService = {
      getChildTasks: jest.fn().mockResolvedValue([
        { id: 'c1', title: 'Replace pane', ticket_kind: 'work_order' },
      ]),
    } as unknown as import('./ticket.service').TicketService;
    const dispatchService = {} as unknown as import('./dispatch.service').DispatchService;

    const controller = new TicketController(ticketService, dispatchService);
    const result = await controller.children('parent-1');

    expect(ticketService.getChildTasks).toHaveBeenCalledWith('parent-1');
    expect(result).toEqual([
      { id: 'c1', title: 'Replace pane', ticket_kind: 'work_order' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @prequest/api test -- ticket.controller.spec.ts`
Expected: FAIL — `controller.children is not a function`.

- [ ] **Step 3: Add the method**

In `apps/api/src/modules/ticket/ticket.controller.ts`, locate the `@Post(':id/dispatch')` handler. Immediately **above** that method (so `GET :id/children` appears before `POST :id/dispatch` in the file for readability), insert:

```typescript
  @Get(':id/children')
  async children(@Param('id') id: string) {
    return this.ticketService.getChildTasks(id);
  }
```

Verify `Get` is already imported from `@nestjs/common` at the top of the file. If not, add it to the import list.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @prequest/api test -- ticket.controller.spec.ts`
Expected: PASS — 1 test, 1 passing.

- [ ] **Step 5: Build and commit**

```bash
pnpm --filter @prequest/api build
git add apps/api/src/modules/ticket/ticket.controller.ts \
        apps/api/src/modules/ticket/ticket.controller.spec.ts
git commit -m "feat(tickets): GET /tickets/:id/children endpoint"
```

---

## Task 2: Workflow engine consumes DispatchService (module wiring only)

**Files:**
- Modify: `apps/api/src/modules/workflow/workflow.module.ts`

This task is wiring only. No logic change yet — the refactor is in Task 3.

- [ ] **Step 1: Update workflow.module.ts**

Replace `apps/api/src/modules/workflow/workflow.module.ts` with:

```typescript
import { Module, forwardRef } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { TicketModule } from '../ticket/ticket.module';
import { WorkflowService } from './workflow.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowValidatorService } from './workflow-validator.service';
import { WorkflowSimulatorService } from './workflow-simulator.service';
import { WorkflowWebhookService } from './workflow-webhook.service';
import { WorkflowController } from './workflow.controller';
import { WorkflowWebhookController, WorkflowWebhookReceiveController } from './workflow-webhook.controller';

@Module({
  imports: [TenantModule, forwardRef(() => TicketModule)],
  providers: [
    WorkflowService,
    WorkflowEngineService,
    WorkflowValidatorService,
    WorkflowSimulatorService,
    WorkflowWebhookService,
  ],
  controllers: [
    WorkflowController,
    WorkflowWebhookController,
    WorkflowWebhookReceiveController,
  ],
  exports: [
    WorkflowService,
    WorkflowEngineService,
    WorkflowValidatorService,
    WorkflowSimulatorService,
    WorkflowWebhookService,
  ],
})
export class WorkflowModule {}
```

(The existing `TicketModule` already does `forwardRef(() => WorkflowModule)`, so adding the reciprocal here resolves the circular dep.)

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @prequest/api build`
Expected: Clean compile. No new type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/workflow/workflow.module.ts
git commit -m "chore(workflow): import TicketModule for DispatchService access"
```

---

## Task 3: Workflow `create_child_tasks` routes through DispatchService (TDD)

**Files:**
- Create: `apps/api/src/modules/workflow/workflow-engine.service.spec.ts`
- Modify: `apps/api/src/modules/workflow/workflow-engine.service.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/workflow/workflow-engine.service.spec.ts`:

```typescript
import { WorkflowEngineService } from './workflow-engine.service';
import { TenantContext } from '../../common/tenant-context';

function makeDeps() {
  const dispatchCalls: Array<{ parentId: string; dto: Record<string, unknown> }> = [];

  const dispatchService = {
    dispatch: jest.fn(async (parentId: string, dto: Record<string, unknown>) => {
      dispatchCalls.push({ parentId, dto });
      return { id: `child-${dispatchCalls.length}` };
    }),
  };

  // Only needs `admin.from` for the single "load parent ticket" call the node does.
  // After the refactor, the node does NOT insert rows itself — all inserts flow through dispatch.
  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { tenant_id: 't1', requester_person_id: 'p1', location_id: 'l1' },
                  error: null,
                }),
              }),
            }),
          } as unknown;
        }
        return {} as unknown;
      }),
    },
  };

  return { dispatchService, supabase, dispatchCalls };
}

describe('WorkflowEngineService.create_child_tasks', () => {
  beforeEach(() => {
    jest.spyOn(TenantContext, 'current').mockReturnValue({ id: 't1', subdomain: 't1' } as never);
  });

  it('routes each task through DispatchService with copied context', async () => {
    const { dispatchService, supabase, dispatchCalls } = makeDeps();
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never);

    // Spy on advance() and emit() to short-circuit internal behavior.
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
      runNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).runNode('inst-1', graph, node, 'parent-1', undefined);

    expect(dispatchCalls).toHaveLength(2);
    expect(dispatchCalls[0]).toEqual({
      parentId: 'parent-1',
      dto: {
        title: 'Replace pane',
        description: undefined,
        assigned_team_id: 'glaziers',
        priority: 'high',
        interaction_mode: undefined,
      },
    });
    expect(dispatchCalls[1].dto.title).toBe('Subtask 2'); // empty-title fallback
    expect(advance).toHaveBeenCalled();
  });

  it('catches dispatch errors and advances the workflow', async () => {
    const { supabase } = makeDeps();
    const dispatchService = {
      dispatch: jest.fn().mockRejectedValue(new Error('cannot dispatch while parent is pending approval')),
    };
    const engine = new WorkflowEngineService(supabase as never, dispatchService as never);
    const advance = jest.spyOn(engine as never, 'advance').mockResolvedValue(undefined as never);
    jest.spyOn(engine as never, 'emit').mockResolvedValue(undefined as never);
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const node = {
      id: 'n1',
      type: 'create_child_tasks',
      config: { tasks: [{ title: 'Replace pane' }] },
    };

    await (engine as unknown as {
      runNode: (i: string, g: unknown, n: unknown, t: string, c: unknown) => Promise<void>;
    }).runNode('inst-1', { nodes: [], edges: [] }, node, 'parent-1', undefined);

    expect(dispatchService.dispatch).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    expect(advance).toHaveBeenCalled();

    logSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @prequest/api test -- workflow-engine.service.spec.ts`
Expected: FAIL — `WorkflowEngineService` constructor takes one argument (supabase), the spec passes two. The test should error with "cannot read property 'dispatch' of undefined" or similar.

- [ ] **Step 3: Refactor the engine's create_child_tasks branch**

In `apps/api/src/modules/workflow/workflow-engine.service.ts`:

1. Update imports at the top — add:
   ```typescript
   import { Inject, forwardRef, Injectable } from '@nestjs/common';
   import { DispatchService } from '../ticket/dispatch.service';
   ```
   (Replace the existing `import { Injectable } from '@nestjs/common';` line.)

2. Update the class constructor:
   ```typescript
   @Injectable()
   export class WorkflowEngineService {
     constructor(
       private readonly supabase: SupabaseService,
       @Inject(forwardRef(() => DispatchService)) private readonly dispatchService: DispatchService,
     ) {}
   ```

3. Replace the entire `case 'create_child_tasks': { ... }` block (currently lines ~181–220, look for the case label) with:

   ```typescript
         case 'create_child_tasks': {
           const tasks = node.config.tasks as Array<{
             title: string; description?: string; assigned_team_id?: string; interaction_mode?: string; priority?: string;
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
                   priority: task.priority,
                   interaction_mode: task.interaction_mode as 'internal' | 'external' | undefined,
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

   Note: the old code did `const { data: parentTicket } = await this.supabase.admin.from('tickets').select(...).single()` to pull `tenant_id, requester_person_id, location_id`. That is no longer needed here — `DispatchService` re-fetches the parent itself. Removing the call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @prequest/api test -- workflow-engine.service.spec.ts`
Expected: PASS — 2 tests.

Then run the full API suite to verify no regressions:

Run: `pnpm --filter @prequest/api test`
Expected: All suites pass, no regressions. `dispatch.service.spec.ts`, `resolver.service.spec.ts`, `scenarios.spec.ts` must stay green.

- [ ] **Step 5: Build and commit**

```bash
pnpm --filter @prequest/api build
git add apps/api/src/modules/workflow/workflow-engine.service.ts \
        apps/api/src/modules/workflow/workflow-engine.service.spec.ts
git commit -m "feat(workflow): route create_child_tasks through DispatchService for SLA + audit parity"
```

---

## Task 4: Frontend hook `useWorkOrders` + `useDispatchWorkOrder`

**Files:**
- Create: `apps/web/src/hooks/use-work-orders.ts`

The project does not use React Query (see `apps/web/package.json`). Follow the existing `apiFetch` + `useState`/`useEffect` pattern used elsewhere.

- [ ] **Step 1: Create the hook file**

Create `apps/web/src/hooks/use-work-orders.ts`:

```typescript
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';

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
}

export interface DispatchDto {
  title: string;
  description?: string;
  assigned_team_id?: string;
  assigned_user_id?: string;
  assigned_vendor_id?: string;
  priority?: string;
  interaction_mode?: 'internal' | 'external';
}

export interface UseWorkOrdersResult {
  data: WorkOrderRow[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Loads work-order children of a parent case.
 * Follows the project pattern: apiFetch + useState/useEffect + caller-driven refetch.
 */
export function useWorkOrders(parentId: string | null): UseWorkOrdersResult {
  const [data, setData] = useState<WorkOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!parentId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<WorkOrderRow[]>(`/tickets/${parentId}/children`)
      .then((rows) => { if (!cancelled) setData(rows); })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error('Failed to load work orders'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [parentId, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refetch };
}

export interface UseDispatchWorkOrderResult {
  dispatch: (dto: DispatchDto) => Promise<WorkOrderRow>;
  submitting: boolean;
  error: Error | null;
}

/**
 * Dispatches a new work order under the parent case. Caller is responsible for
 * calling refetch() on both the work-orders list and the parent ticket after success,
 * since the parent's status_category may have rolled up.
 */
export function useDispatchWorkOrder(parentId: string): UseDispatchWorkOrderResult {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const dispatch = useCallback(async (dto: DispatchDto) => {
    setSubmitting(true);
    setError(null);
    try {
      const row = await apiFetch<WorkOrderRow>(`/tickets/${parentId}/dispatch`, {
        method: 'POST',
        body: JSON.stringify(dto),
      });
      return row;
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error('Dispatch failed');
      setError(err);
      throw err;
    } finally {
      setSubmitting(false);
    }
  }, [parentId]);

  return { dispatch, submitting, error };
}
```

- [ ] **Step 2: Verify web build**

Run: `pnpm --filter @prequest/web build`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/use-work-orders.ts
git commit -m "feat(web): useWorkOrders + useDispatchWorkOrder hooks"
```

---

## Task 5: `ParentCaseRibbon` component

**Files:**
- Create: `apps/web/src/components/desk/parent-case-ribbon.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/desk/parent-case-ribbon.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { apiFetch } from '@/lib/api';

interface ParentCaseRibbonProps {
  parentId: string;
}

interface ParentMinimal {
  id: string;
  title: string;
}

/**
 * Top-of-page ribbon shown on work-order detail that links back to the parent case.
 * Fetches only the parent's title in a tiny request — the detail view doesn't join it today.
 */
export function ParentCaseRibbon({ parentId }: ParentCaseRibbonProps) {
  const [parent, setParent] = useState<ParentMinimal | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ParentMinimal>(`/tickets/${parentId}`)
      .then((row) => { if (!cancelled) setParent({ id: row.id, title: row.title }); })
      .catch(() => { if (!cancelled) setParent({ id: parentId, title: 'parent case' }); });
    return () => { cancelled = true; };
  }, [parentId]);

  return (
    <Link
      to={`/desk/tickets/${parentId}`}
      className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 border-b"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      <span>Work order of</span>
      <span className="font-medium text-foreground truncate">{parent?.title ?? '…'}</span>
    </Link>
  );
}
```

- [ ] **Step 2: Verify web build**

Run: `pnpm --filter @prequest/web build`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/desk/parent-case-ribbon.tsx
git commit -m "feat(web): ParentCaseRibbon component"
```

---

## Task 6: `WorkOrdersSection` component — list + empty state (without dialog)

**Files:**
- Create: `apps/web/src/components/desk/work-orders-section.tsx`

This task adds the section and the list. The dialog comes in Task 7; the button's onClick is stubbed here.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/desk/work-orders-section.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useWorkOrders, WorkOrderRow } from '@/hooks/use-work-orders';

interface WorkOrdersSectionProps {
  parentId: string;
  /** Called when the user clicks "Add work order". Task 7 wires this to a Dialog. */
  onAddClick: () => void;
  /**
   * Bumped by the parent when the dialog closes after a successful dispatch,
   * so the section re-fetches. The parent holds the nonce so it can also invalidate
   * its own ticket query in lockstep.
   */
  refreshNonce?: number;
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  new: 'outline',
  assigned: 'secondary',
  in_progress: 'default',
  waiting: 'secondary',
  resolved: 'secondary',
  closed: 'outline',
};

function formatAssignee(row: WorkOrderRow): string {
  if (row.assigned_vendor_id) return 'Vendor';
  if (row.assigned_user_id) return 'User';
  if (row.assigned_team_id) return 'Team';
  return 'Unassigned';
}

export function WorkOrdersSection({ parentId, onAddClick, refreshNonce = 0 }: WorkOrdersSectionProps) {
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useWorkOrders(parentId);
  const [lastNonce, setLastNonce] = useState(refreshNonce);

  if (refreshNonce !== lastNonce) {
    setLastNonce(refreshNonce);
    refetch();
  }

  return (
    <section className="border-t py-4 px-6">
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Work Orders</h3>
          {data.length > 0 && (
            <span className="text-xs text-muted-foreground">({data.length})</span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={onAddClick}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add work order
        </Button>
      </header>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {error && !loading && (
        <div className="text-sm text-destructive flex items-center gap-2">
          <span>Failed to load work orders.</span>
          <Button size="sm" variant="ghost" onClick={refetch}>Retry</Button>
        </div>
      )}

      {!loading && !error && data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No work orders yet. Add one to send work to a vendor, team, or teammate.
        </p>
      )}

      {!loading && !error && data.length > 0 && (
        <ul className="divide-y rounded-md border">
          {data.map((row) => (
            <li
              key={row.id}
              className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
              onClick={() => navigate(`/desk/tickets/${row.id}`)}
            >
              <span className="flex-1 truncate text-sm">{row.title}</span>
              <Badge variant={STATUS_VARIANT[row.status_category] ?? 'outline'} className="text-xs">
                {row.status_category.replace('_', ' ')}
              </Badge>
              <span className="text-xs text-muted-foreground w-20 text-right">
                {formatAssignee(row)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Verify web build**

Run: `pnpm --filter @prequest/web build`
Expected: clean compile. If `Badge` is not imported, add `npx shadcn@latest add badge` if missing in `apps/web/src/components/ui/badge.tsx`. Check first:

```bash
ls apps/web/src/components/ui/badge.tsx
```

If the file exists, proceed. If not, install: `npx shadcn@latest add badge` (run in `apps/web`).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/desk/work-orders-section.tsx
git commit -m "feat(web): WorkOrdersSection — children list + empty state"
```

---

## Task 7: `AddWorkOrderDialog` component

**Files:**
- Create: `apps/web/src/components/desk/add-work-order-dialog.tsx`

The dialog reuses `EntityPicker` (at `@/components/desk/editors/entity-picker`) inside shadcn `Tabs`. Team/user/vendor option lists are passed in from the parent component, matching the pattern used by the sidebar.

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/desk/add-work-order-dialog.tsx`:

```tsx
import { useState } from 'react';
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

interface AddWorkOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentId: string;
  parentPriority: string;
  teamOptions: EntityOption[];
  userOptions: EntityOption[];
  vendorOptions: EntityOption[];
  /** Called after a successful dispatch so the parent can refresh the children list and the ticket. */
  onDispatched: () => void;
}

type AssignTab = 'team' | 'user' | 'vendor';

const PRIORITIES: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export function AddWorkOrderDialog({
  open,
  onOpenChange,
  parentId,
  parentPriority,
  teamOptions,
  userOptions,
  vendorOptions,
  onDispatched,
}: AddWorkOrderDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(parentPriority);
  const [tab, setTab] = useState<AssignTab>('team');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);

  const [titleError, setTitleError] = useState<string | null>(null);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { dispatch, submitting } = useDispatchWorkOrder(parentId);

  function reset() {
    setTitle(''); setDescription(''); setPriority(parentPriority);
    setTab('team'); setTeamId(null); setUserId(null); setVendorId(null);
    setTitleError(null); setAssigneeError(null); setFormError(null);
  }

  // Switching tabs clears OTHER tabs' selections so the submitted DTO has exactly one assignee.
  function onTabChange(next: string) {
    const t = next as AssignTab;
    setTab(t);
    if (t !== 'team') setTeamId(null);
    if (t !== 'user') setUserId(null);
    if (t !== 'vendor') setVendorId(null);
    setAssigneeError(null);
  }

  async function onSubmit() {
    setTitleError(null); setAssigneeError(null); setFormError(null);
    const trimmed = title.trim();
    if (!trimmed) { setTitleError('Title is required'); return; }

    const selectedId = tab === 'team' ? teamId : tab === 'user' ? userId : vendorId;
    if (!selectedId) { setAssigneeError('Pick an assignee'); return; }

    try {
      await dispatch({
        title: trimmed,
        description: description.trim() || undefined,
        priority,
        assigned_team_id: tab === 'team' ? selectedId : undefined,
        assigned_user_id: tab === 'user' ? selectedId : undefined,
        assigned_vendor_id: tab === 'vendor' ? selectedId : undefined,
      });
      toast.success(`Work order "${trimmed}" added`);
      onDispatched();
      reset();
      onOpenChange(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to add work order';
      setFormError(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); if (!next) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add work order</DialogTitle>
          <DialogDescription>
            Send a piece of this case to a vendor, team, or teammate. They get their own ticket with its own SLA.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="wo-title">Title</FieldLabel>
            <Input
              id="wo-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Replace broken pane"
              disabled={submitting}
            />
            {titleError && <FieldError>{titleError}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="wo-description">Description</FieldLabel>
            <Textarea
              id="wo-description"
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
            <FieldDescription>
              Switching tabs clears the other tabs' selections — only one assignee is submitted.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="wo-priority">Priority</FieldLabel>
            <Select value={priority} onValueChange={setPriority} disabled={submitting}>
              <SelectTrigger id="wo-priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Defaults to the parent case's priority.</FieldDescription>
          </Field>

          {formError && (
            <p className="text-sm text-destructive" role="alert">{formError}</p>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Adding…' : 'Add work order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify web build**

Run: `pnpm --filter @prequest/web build`
Expected: clean compile. If `Textarea` is missing in `apps/web/src/components/ui/textarea.tsx`, install: `npx shadcn@latest add textarea` (run in `apps/web`). Same check applies to `Tabs` — should already be present per earlier recon.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/desk/add-work-order-dialog.tsx
git commit -m "feat(web): AddWorkOrderDialog — Field-composed form with tabbed assignee picker"
```

---

## Task 8: Mount ribbon + section in `ticket-detail.tsx`

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

`ticket-detail.tsx` is ~1030 lines and already owns the `teams`, `users`, `vendors` data. Two surgical edits.

- [ ] **Step 1: Add imports near the top of the file**

Find the existing imports block at the top (there's already `import { EntityPicker } from '@/components/desk/editors/entity-picker';` at line 38). Immediately after that line, add:

```typescript
import { ParentCaseRibbon } from '@/components/desk/parent-case-ribbon';
import { WorkOrdersSection } from '@/components/desk/work-orders-section';
import { AddWorkOrderDialog } from '@/components/desk/add-work-order-dialog';
```

- [ ] **Step 2: Add local state for the dialog + a refresh nonce**

Inside the component body, find where other `useState` hooks are declared (near the top of the function body after `const { ... } = useTicketMutation(...)` and similar). Add:

```typescript
  const [addWorkOrderOpen, setAddWorkOrderOpen] = useState(false);
  const [workOrdersNonce, setWorkOrdersNonce] = useState(0);
```

- [ ] **Step 3: Insert the ribbon near the top of the JSX**

Find the root JSX return for the component — the top-most wrapping element (likely a `<div>` or `<main>` containing the header). Immediately inside the root, before the existing header, insert:

```tsx
      {displayedTicket?.ticket_kind === 'work_order' && displayedTicket.parent_ticket_id && (
        <ParentCaseRibbon parentId={displayedTicket.parent_ticket_id} />
      )}
```

(Use whichever variable the file uses for the current ticket — in this file it's `displayedTicket`.)

- [ ] **Step 4: Mount the section after the activity timeline**

Search for the activity timeline block (it wraps `ticket_activities` or has a `Timeline` component near the end of the main column). After that block's closing tag, before the sidebar / closing wrapper, insert:

```tsx
      {displayedTicket?.ticket_kind === 'case' && (
        <WorkOrdersSection
          parentId={displayedTicket.id}
          onAddClick={() => setAddWorkOrderOpen(true)}
          refreshNonce={workOrdersNonce}
        />
      )}

      {displayedTicket?.ticket_kind === 'case' && (
        <AddWorkOrderDialog
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
            // The parent ticket's status may have rolled up — trigger the existing refetch.
            refetchTicket();
          }}
        />
      )}
```

Use whatever refetch function the file already exposes. Most likely `refetchTicket` or `refetch`. If the variable name differs, use the one defined in this file.

- [ ] **Step 5: Verify web build**

Run: `pnpm --filter @prequest/web build`
Expected: clean compile.

- [ ] **Step 6: Manual verification**

Run: `pnpm dev:web` (and `pnpm dev:api` in another terminal if not already running).
Expected flow:
1. Open a case's ticket detail. Scroll past the activity timeline. Work Orders section renders with empty state.
2. Click "Add work order". Dialog opens with parent's priority pre-selected.
3. Fill title, description, pick a vendor, submit. Dialog closes, toast appears. Section now shows the new row. Parent ticket's status pill may have changed.
4. Click the new row. Detail loads for the work order. Top of page shows "← Work order of [parent title]".
5. Click the ribbon. Returns to the parent case.

Stop the dev server.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx
git commit -m "feat(web): mount ParentCaseRibbon + WorkOrdersSection on ticket detail"
```

---

## Task 9: Consolidate `routing.md` into `assignments-routing-fulfillment.md`

**Files:**
- Modify: `docs/assignments-routing-fulfillment.md`
- Delete: `docs/routing.md`

This task ports specific sections from `docs/routing.md` into `docs/assignments-routing-fulfillment.md`. Open both files side by side.

- [ ] **Step 1: Add "When the resolver runs" subsection**

In `docs/assignments-routing-fulfillment.md`, find `## 3. The resolver algorithm`. Immediately BEFORE the `### 3.1 Routing rules pre-step` subheading, insert:

```markdown
### 3.0 When the resolver runs

| Trigger | Where | Notes |
|---|---|---|
| Ticket create | `TicketService.runPostCreateAutomation` | Skipped if `ticket_kind = 'work_order'` or if the ticket already has an assignee in the DTO. |
| Approval granted | `TicketService.onApprovalDecision('approved')` | Delegates to `runPostCreateAutomation`. |
| Manual reassign with rerun | `TicketService.reassign({ rerun_resolver: true })` | Clears current assignment, re-evaluates, records a new `routing_decisions` row. |
| Workflow-spawned child | `WorkflowEngineService.create_child_tasks` → `DispatchService.dispatch` | Goes through the full resolver + SLA + audit pipeline, same as manual dispatch. |
| Manual dispatch | `DispatchService.dispatch` (called by `POST /tickets/:id/dispatch`) | Runs when the DTO doesn't supply an assignee. |

The resolver does **not** run on generic `PATCH /tickets/:id`. Changing priority, status, tags, watchers, cost, etc. does not re-route.
```

- [ ] **Step 2: Add "Changing an assignee — two audited paths" section**

After the existing `## 8. Approval gates` section (and before `## 9. Audit — routing_decisions`), insert a new section:

```markdown
## 8a. Changing an assignee — audited paths

Two endpoints can change a ticket's assignee. They differ in audit trail, not in effect.

### Silent `PATCH /tickets/:id`

`UpdateTicketDto` accepts `assigned_team_id`, `assigned_user_id`, `assigned_vendor_id`. On change:
- Writes the ticket row.
- Posts a `system_event` activity (`assignment_changed`) and a `domain_events` row (`ticket_assigned`).
- **Does not** write a `routing_decisions` row.
- **Does not** require a reason.

Use when: bulk tooling, background jobs, trusted system actions where a reason is meaningless.

### Audited `POST /tickets/:id/reassign`

`ReassignDto` requires a `reason` string. Two modes:

- **Manual** (`rerun_resolver: false | undefined`): caller supplies the target assignee directly. Clears previous assignment, sets the new one.
- **Rerun resolver** (`rerun_resolver: true`): clears assignment, re-invokes `ResolverService.resolve()` with the current `{location, asset, request_type, priority, domain}` (falls back to `asset.assigned_space_id` if `location_id` is null).

Either mode:
- Writes a `routing_decisions` row with `chosen_by: 'manual_reassign'` or `'rerun_resolver'`. In rerun mode, the resolver's own trace is appended after a `manual_reassign` step so both the human reason and the machine decision are captured.
- Posts an **internal-visibility** activity (not `system_event`) with the reason in the `content` field — it shows up in the ticket timeline as a note.

Use when: a human is making the call and the reason matters for audit / ops review.

### Frontend behavior (today)

The desk sidebar's `useTicketMutation` hook (`apps/web/src/hooks/use-ticket-mutation.ts`) uses a tiered approach:

- **First-time assignment** (no previous assignee) → silent `PATCH`. No audit row — there's no previous state to explain.
- **Reassignment** (replacing an existing assignee) → `POST /tickets/:id/reassign` with a synthesized reason (`"Reassigned <kind> from X to Y by <actor> via ticket sidebar"`). Audit row captured.

This mirrors the intent of the endpoints: PATCH for initial state, reassign for state changes.
```

- [ ] **Step 3: Add "SLA on reassignment" subsection**

Inside `## 7. SLA timers`, append at the end:

```markdown
### SLA on reassignment

**Nothing changes on SLA when an assignee is reassigned** — via silent PATCH or `POST /tickets/:id/reassign`, manual or rerun mode. `due_at`, `sla_response_due_at`, `sla_resolution_due_at`, `sla_at_risk`, and breach timestamps all persist unchanged.

This is intentional and matches standard ITSM behavior: SLA is a promise to the requester, not to the assignee. Shuffling ownership internally does not reset the customer clock. If a ticket sat on the wrong team for three hours before reassignment, the new team inherits whatever's left of the window.

SLA pause/resume fires **only** on `status_category` or `waiting_reason` changes (`applyWaitingStateTransition` in `ticket.service.ts`). The per-minute `checkBreaches` cron in `sla.service.ts` is team-agnostic — it only looks at `due_at` and `paused` flags.

**Edge case worth knowing:** the business-hours calendar is attached to the **SLA policy** (`sla_policies.business_hours_calendar_id`), not the team. A 9–5 team and a 24/7 team working the same policy share the same business-minute calculation. There is no per-team calendar override today. If that matters for a product decision, it's a schema change.
```

- [ ] **Step 4: Add "Scope fields — not editable today" section**

After `## 8a. Changing an assignee — audited paths`, insert a new section:

```markdown
## 8b. Scope fields — not editable today

`UpdateTicketDto` deliberately omits `location_id`, `asset_id`, `ticket_type_id`, `requester_person_id`. There is no endpoint to change any of them on an existing ticket. Changing them would have cascading effects:

| Field | Cascade if changed |
|---|---|
| `location_id` | Resolver result changes (location chain differs). SLA/workflow unaffected. |
| `asset_id` | Resolver result changes (asset override path differs). SLA/workflow unaffected. |
| `ticket_type_id` | Resolver **and** SLA **and** workflow all tied to request type. SLA policy, workflow definition, approval gate, fulfillment strategy all change. High-impact. |
| `requester_person_id` | No resolver impact but changes who receives external notifications. Probably should not be mutable — effectively recreating the ticket. |

Until a scope-rerouting flow is built, these fields remain read-only in the UI. If/when we build it:

- New endpoint (probably `POST /tickets/:id/rescope`) that accepts the new field(s) + a reason, re-runs the resolver, and for `ticket_type_id` changes, restarts SLA timers and potentially the workflow instance.
- `routing_decisions` row with `chosen_by: 'rescope'` so the audit trail explains why the assignee changed.
```

- [ ] **Step 5: Expand the "not solved" section with known gaps**

In `docs/assignments-routing-fulfillment.md`, find `## 13. What's intentionally **not** solved here`. Replace that whole section with:

```markdown
## 13. What's intentionally not solved here

- **Visibility scoping** — `GET /tickets` returns everything in the tenant. Per-user / per-team / per-location visibility belongs in its own plan (list-endpoint filters + RLS tightening).
- **Vendor assignment via routing rules** — schema doesn't carry a vendor action column yet (`action_assign_vendor_id` is absent).
- **Auto-dispatch on request type** — no declarative "this request type always spawns a child WO to Vendor X." Dispatches are manual or workflow-driven today.
- **Case status re-open on child reopen** — rollup never moves a parent out of `resolved` or `closed`. Intentional; a human decides.
- **Scope-rerouting endpoint** — see §8b. No `POST /tickets/:id/rescope` exists.
- **Workflow impact on request-type change** — if/when rescoping lands, must decide whether in-flight workflow instances are terminated and restarted or migrated.
- **Bulk update does not re-route or audit.** `PATCH /tickets/bulk/update` accepts the same DTO as single update — silent. Audited bulk reassign would need a `/tickets/bulk/reassign` wrapping `/reassign`.
- **Overrides are not re-evaluated on ticket updates.** If an admin adds a `routing_rules` row that would have matched an existing ticket, the existing ticket is unaffected until someone calls `/reassign` with `rerun_resolver: true`. This is intentional — know it when debugging "why didn't my new rule fire."
```

- [ ] **Step 6: Add a "Resolved" section at the end**

After the existing `## 15. When to update this document` section, append:

```markdown
---

## 16. Resolved gaps

Move items here with a date when a gap from §13 is closed. Keeps the doc honest about what was once broken and when it was fixed.

- **2026-04-18 — Sidebar reassign now audits.** The desk sidebar's `useTicketMutation.updateAssignment` hook now calls `POST /tickets/:id/reassign` (with a synthesized reason) whenever an existing assignee is replaced. First-time assignment still uses silent `PATCH`. `routing_decisions` captures every sidebar reassignment going forward.
- **2026-04-18 — Workflow-spawned children reach parity with manual dispatch.** `WorkflowEngineService.create_child_tasks` now calls `DispatchService.dispatch` per task. Children receive SLA timer start, a `routing_decisions` row, and a `dispatched` parent activity — same as manual dispatch via `POST /tickets/:id/dispatch`.
```

- [ ] **Step 7: Delete the old doc**

```bash
git rm docs/routing.md
```

- [ ] **Step 8: Verify no inbound references remain**

Run: `grep -rn 'routing\.md' docs/ CLAUDE.md 2>/dev/null | grep -v 'assignments-routing-fulfillment'`
Expected: empty output. If any references remain, update them to point at `docs/assignments-routing-fulfillment.md` in the same commit.

- [ ] **Step 9: Commit**

```bash
git add docs/assignments-routing-fulfillment.md
git commit -m "docs: consolidate routing.md into assignments-routing-fulfillment.md"
```

---

## Task 10: End-to-end sanity pass

**Files:** none (verification only).

- [ ] **Step 1: Full API test suite**

Run: `pnpm --filter @prequest/api test`
Expected: all suites green. New tests added by Tasks 1 and 3 pass.

- [ ] **Step 2: API build**

Run: `pnpm --filter @prequest/api build`
Expected: clean compile.

- [ ] **Step 3: Web build**

Run: `pnpm --filter @prequest/web build`
Expected: clean compile.

- [ ] **Step 4: Manual smoke — manual dispatch path**

Run: `pnpm dev` (in one terminal, starts both api and web).
Open a case ticket. Verify:
- Work Orders section renders with "No work orders yet" empty state.
- "Add work order" opens the dialog.
- Submit with vendor tab + priority: dialog closes, toast appears, new row shows in section.
- Click the new row: navigates to the work order detail. Ribbon shows "Work order of [parent title]" and links back.

- [ ] **Step 5: Manual smoke — workflow dispatch parity**

With a case that triggers a workflow containing a `create_child_tasks` node:
- Open the case after the workflow has fired.
- Verify the spawned children appear in the Work Orders section alongside any manually-dispatched ones.
- Click one: the child ticket has an SLA timer running (visible in the ticket detail's SLA card) and the parent case has a `system_event` activity with `event: 'dispatched'` metadata.

- [ ] **Step 6: Final commit if any fix-ups were needed**

If any verification surfaced a bug, fix it and commit separately:

```bash
git add <fix files>
git commit -m "fix: <specific issue found during sanity pass>"
```

- [ ] **Step 7: Stop dev server and summary**

Stop `pnpm dev`. Report back with:
- List of commits on the branch (`git log --oneline main..HEAD`).
- Test counts and web build status.
- Any deviations from the plan.

---

## Self-Review Notes

- **Spec coverage:**
  - §5.1 endpoint + workflow parity → Tasks 1–3.
  - §5.2 frontend components + hook + mounting → Tasks 4–8.
  - §5.3 doc consolidation → Task 9.
  - §8 testing → tests in Tasks 1 and 3, manual verification in Task 10.
- **Placeholder scan:** every step has complete code or exact commands. No TBDs.
- **Type consistency:** `DispatchDto` (Task 4) matches `DispatchService.dispatch` backend DTO. `WorkOrderRow` (Task 4) matches the `getChildTasks` select list. `EntityOption` (Task 7) matches the existing `EntityPicker` interface. `refetchTicket` in Task 8 assumes whatever refetch callback `ticket-detail.tsx` already exposes — the engineer should use the actual variable name found in the file.
- **Known flex points:**
  - Task 8 Step 3/4 uses variable names (`displayedTicket`, `teams`, `users`, `vendors`, `refetchTicket`) that exist in the current file at the time of writing. If the file's names have changed, the engineer should use the current ones.
  - Task 6 uses shadcn `Badge`; engineer should `ls apps/web/src/components/ui/badge.tsx` before assuming it's present.
  - Task 7 uses shadcn `Textarea`; same check.
