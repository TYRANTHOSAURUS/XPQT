# Ticket Sidebar Inline Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every safely-mutable field in the ticket detail's right-hand properties sidebar editable inline, Linear-style, using shadcn primitives and reusable editor components.

**Architecture:** One mutation hook (`useTicketMutation`) owns optimistic state and tiered PATCH/reassign routing. One layout wrapper (`<InlineProperty>`) standardizes the label + trigger row. Four reusable editor bodies (`EntityPicker`, `MultiSelectPicker`, `InlineTextEditor`, `NumberEditor`) slot into the wrapper. One new backend endpoint (`GET /tickets/tags`) feeds tag autocomplete.

**Tech Stack:** React 19 + Vite + TypeScript + Tailwind, shadcn/ui primitives (Popover, Command, Select, Textarea, Input, Button, Badge), NestJS + Supabase + Jest (backend), Sonner (toasts). No new frontend test infra — UI verification is browser smoke-tests per project convention in `CLAUDE.md`. Backend tests use the existing Jest setup (see `apps/api/src/modules/ticket/dispatch.service.spec.ts` as a reference pattern).

**Spec:** `docs/superpowers/specs/2026-04-18-ticket-sidebar-inline-editing-design.md`
**Related reference:** `docs/routing.md` (explains PATCH vs `/reassign`, why Location/Asset/Request type stay read-only).

---

## File Structure

**Create:**
- `apps/web/src/hooks/use-ticket-mutation.ts` — mutation hook with optimistic overlay + tiered assignment routing
- `apps/web/src/components/desk/inline-property.tsx` — `<InlineProperty>` label+trigger row wrapper
- `apps/web/src/components/desk/editors/entity-picker.tsx` — reusable single-select Popover+Command picker (Team, Assignee, Vendor)
- `apps/web/src/components/desk/editors/multi-select-picker.tsx` — reusable multi-select with optional create-new (Tags, Watchers)
- `apps/web/src/components/desk/editors/inline-text-editor.tsx` — reusable click-to-edit text (Title, Description)
- `apps/web/src/components/desk/editors/number-editor.tsx` — reusable popover + numeric input (Cost)

**Modify:**
- `apps/api/src/modules/ticket/ticket.service.ts` — add `listDistinctTags()` method
- `apps/api/src/modules/ticket/ticket.controller.ts` — add `GET /tickets/tags` route
- `apps/web/src/components/desk/ticket-detail.tsx` — swap properties sidebar to use the new components + hook

**Test (backend only):**
- `apps/api/src/modules/ticket/ticket-tags.spec.ts` — tenant isolation test for `listDistinctTags()`

---

### Task 1: Backend — `GET /tickets/tags` endpoint

**Files:**
- Modify: `apps/api/src/modules/ticket/ticket.service.ts`
- Modify: `apps/api/src/modules/ticket/ticket.controller.ts`
- Create: `apps/api/src/modules/ticket/ticket-tags.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/ticket/ticket-tags.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { TicketService } from './ticket.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RoutingService } from '../routing/routing.service';
import { SlaService } from '../sla/sla.service';
import { WorkflowEngineService } from '../workflow/workflow-engine.service';
import { ApprovalService } from '../approval/approval.service';

describe('TicketService.listDistinctTags', () => {
  const tenantAId = '00000000-0000-0000-0000-00000000000a';
  const tenantBId = '00000000-0000-0000-0000-00000000000b';

  let service: TicketService;
  let supabase: { admin: any };
  let rpcMock: jest.Mock;

  beforeEach(async () => {
    rpcMock = jest.fn();
    supabase = {
      admin: {
        rpc: rpcMock,
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: SupabaseService, useValue: supabase },
        { provide: RoutingService, useValue: {} },
        { provide: SlaService, useValue: {} },
        { provide: WorkflowEngineService, useValue: {} },
        { provide: ApprovalService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(TicketService);
  });

  it('returns distinct tenant-scoped tags sorted alphabetically', async () => {
    rpcMock.mockResolvedValue({ data: [{ tag: 'billing' }, { tag: 'hvac' }, { tag: 'urgent' }], error: null });

    const result = await TenantContext.run(
      { id: tenantAId, subdomain: 'a' } as any,
      () => service.listDistinctTags(),
    );

    expect(result).toEqual(['billing', 'hvac', 'urgent']);
    expect(rpcMock).toHaveBeenCalledWith('tickets_distinct_tags', { tenant: tenantAId });
  });

  it('passes the current tenant id — never leaks across tenants', async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });

    await TenantContext.run({ id: tenantBId, subdomain: 'b' } as any, () => service.listDistinctTags());

    expect(rpcMock).toHaveBeenCalledWith('tickets_distinct_tags', { tenant: tenantBId });
  });

  it('returns [] when the RPC returns no data', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });

    const result = await TenantContext.run(
      { id: tenantAId, subdomain: 'a' } as any,
      () => service.listDistinctTags(),
    );

    expect(result).toEqual([]);
  });

  it('throws when the RPC returns an error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await expect(
      TenantContext.run({ id: tenantAId, subdomain: 'a' } as any, () => service.listDistinctTags()),
    ).rejects.toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @prequest/api test ticket-tags.spec.ts`
Expected: FAIL with "service.listDistinctTags is not a function" or similar.

- [ ] **Step 3: Add a Postgres RPC migration for tenant-scoped distinct tags**

Create `supabase/migrations/<next-number>_tickets_distinct_tags_rpc.sql`:

```sql
create or replace function public.tickets_distinct_tags(tenant uuid)
returns table(tag text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct t.tag::text as tag
  from tickets, lateral unnest(coalesce(tags, array[]::text[])) as t(tag)
  where tenant_id = tenant
    and t.tag is not null
    and length(trim(t.tag)) > 0
  order by tag
$$;

grant execute on function public.tickets_distinct_tags(uuid) to service_role, authenticated;
```

The `security definer` matters: the function runs with elevated privileges but is scoped by the `tenant` parameter, which the application sets from the authenticated tenant context — so RLS is enforced by the WHERE clause, not by caller identity.

- [ ] **Step 4: Apply migration locally**

Run: `pnpm db:reset`
Expected: migration runs cleanly. (Per `CLAUDE.md`, do NOT push to remote without the user's explicit go-ahead — flag for the user at end of task.)

- [ ] **Step 5: Implement `listDistinctTags()` on `TicketService`**

Add this method to `apps/api/src/modules/ticket/ticket.service.ts` (place near `list()`, around line 152):

```typescript
async listDistinctTags(): Promise<string[]> {
  const tenant = TenantContext.current();
  const { data, error } = await this.supabase.admin.rpc('tickets_distinct_tags', {
    tenant: tenant.id,
  });
  if (error) throw error;
  return (data ?? []).map((row: { tag: string }) => row.tag);
}
```

- [ ] **Step 6: Add the controller route**

In `apps/api/src/modules/ticket/ticket.controller.ts`, add this route **above** `@Get(':id')` (so `/tickets/tags` doesn't match as an id). Put it near the `@Get()` list handler:

```typescript
@Get('tags')
async listTags() {
  return this.ticketService.listDistinctTags();
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @prequest/api test ticket-tags.spec.ts`
Expected: PASS, all four test cases green.

- [ ] **Step 8: Smoke-test the endpoint**

Start the API (`pnpm dev:api`) and hit it with the current tenant header used by the web app. From the project root:

```bash
curl -s http://localhost:3000/tickets/tags \
  -H 'X-Tenant-Id: <your-tenant-uuid>' \
  -H 'Authorization: Bearer <valid-jwt>' | jq
```

Expected: JSON array of distinct tag strings for that tenant. Empty array `[]` if no tickets have tags.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/ticket/ticket.service.ts \
        apps/api/src/modules/ticket/ticket.controller.ts \
        apps/api/src/modules/ticket/ticket-tags.spec.ts \
        supabase/migrations/*_tickets_distinct_tags_rpc.sql
git commit -m "feat(tickets): GET /tickets/tags endpoint returning distinct tenant tags"
```

- [ ] **Step 10: Flag remote migration**

Tell the user: "Migration `tickets_distinct_tags_rpc.sql` applies cleanly locally. Want me to `pnpm db:push` to the remote Supabase project?" Per `CLAUDE.md`, always confirm before pushing migrations to remote.

---

### Task 2: `useTicketMutation` hook

**Files:**
- Create: `apps/web/src/hooks/use-ticket-mutation.ts`

- [ ] **Step 1: Create the hook file**

Create `apps/web/src/hooks/use-ticket-mutation.ts`:

```typescript
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

export interface UpdateTicketPayload {
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
}

export type AssignmentKind = 'team' | 'user' | 'vendor';

export interface AssignmentTarget {
  kind: AssignmentKind;
  id: string | null;
  /** Human-friendly label used when synthesizing the reassignment reason. */
  nextLabel: string | null;
  /** Human-friendly label of the current assignee, used for the reassignment reason. */
  previousLabel: string | null;
}

export interface UseTicketMutationArgs {
  ticketId: string;
  /** Refetch the ticket after a successful mutation. */
  refetch: () => void;
  /** Called with an optimistic patch overlay. Consumer merges it onto the displayed ticket. */
  onOptimistic: (overlay: Partial<UpdateTicketPayload> | null) => void;
  /** Fires when the server responds with an error, after rollback. Consumer may show inline state. */
  onError?: (field: string, error: Error) => void;
}

const ASSIGNMENT_FIELD: Record<AssignmentKind, keyof UpdateTicketPayload> = {
  team: 'assigned_team_id',
  user: 'assigned_user_id',
  vendor: 'assigned_vendor_id',
};

export function useTicketMutation({ ticketId, refetch, onOptimistic, onError }: UseTicketMutationArgs) {
  const { person } = useAuth();
  const [pending, setPending] = useState(false);

  const patch = useCallback(
    async (updates: Partial<UpdateTicketPayload>) => {
      onOptimistic(updates);
      setPending(true);
      try {
        await apiFetch(`/tickets/${ticketId}`, {
          method: 'PATCH',
          body: JSON.stringify(updates),
        });
        onOptimistic(null);
        refetch();
      } catch (err) {
        onOptimistic(null);
        const error = err instanceof Error ? err : new Error('Update failed');
        const field = Object.keys(updates)[0] ?? 'field';
        toast.error(`Failed to update ${field}: ${error.message}`);
        onError?.(field, error);
      } finally {
        setPending(false);
      }
    },
    [ticketId, onOptimistic, onError, refetch],
  );

  /**
   * Tiered assignment change.
   * - If the ticket currently has no assignee in that slot, send a silent PATCH.
   * - Otherwise, send POST /tickets/:id/reassign with a synthesized reason so
   *   routing_decisions captures the change.
   */
  const updateAssignment = useCallback(
    async (target: AssignmentTarget) => {
      const field = ASSIGNMENT_FIELD[target.kind];
      const isFirstAssignment = target.previousLabel === null;

      if (isFirstAssignment) {
        await patch({ [field]: target.id } as Partial<UpdateTicketPayload>);
        return;
      }

      const actorName = person ? `${person.first_name} ${person.last_name}`.trim() : 'an agent';
      const prevLabel = target.previousLabel ?? 'unassigned';
      const nextLabel = target.nextLabel ?? 'unassigned';
      const reason = `Reassigned ${target.kind} from ${prevLabel} to ${nextLabel} by ${actorName} via ticket sidebar`;

      const overlay: Partial<UpdateTicketPayload> = { [field]: target.id } as Partial<UpdateTicketPayload>;
      onOptimistic(overlay);
      setPending(true);
      try {
        await apiFetch(`/tickets/${ticketId}/reassign`, {
          method: 'POST',
          body: JSON.stringify({
            [field]: target.id,
            reason,
            actor_person_id: person?.id,
            rerun_resolver: false,
          }),
        });
        onOptimistic(null);
        refetch();
      } catch (err) {
        onOptimistic(null);
        const error = err instanceof Error ? err : new Error('Reassignment failed');
        toast.error(`Failed to reassign: ${error.message}`);
        onError?.(field, error);
      } finally {
        setPending(false);
      }
    },
    [patch, ticketId, person, onOptimistic, onError, refetch],
  );

  return { patch, updateAssignment, pending };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter @prequest/web exec tsc --noEmit`
Expected: No type errors in `use-ticket-mutation.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/hooks/use-ticket-mutation.ts
git commit -m "feat(web): useTicketMutation hook with optimistic overlay + tiered assignment"
```

---

### Task 3: `<InlineProperty>` layout wrapper

**Files:**
- Create: `apps/web/src/components/desk/inline-property.tsx`

- [ ] **Step 1: Create the component**

Create `apps/web/src/components/desk/inline-property.tsx`:

```tsx
import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface InlineProperty {
  label: string;
  icon?: ReactNode;
  /** The interactive trigger (a Popover trigger, Select, click-to-edit button, etc.) */
  children: ReactNode;
  className?: string;
}

/**
 * One sidebar row: muted label on top, interactive trigger below.
 * Standardises spacing so every field looks identical regardless of editor type.
 */
export function InlineProperty({ label, icon, children, className }: InlineProperty) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @prequest/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/desk/inline-property.tsx
git commit -m "feat(web): InlineProperty layout wrapper"
```

---

### Task 4: `<EntityPicker>` — reusable single-select picker

**Files:**
- Create: `apps/web/src/components/desk/editors/entity-picker.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { ReactNode, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface EntityOption {
  id: string;
  label: string;
  sublabel?: string | null;
}

export interface EntityPickerProps {
  /** Current selection id, or null if none. */
  value: string | null;
  /** All selectable options. For small lists we filter client-side; for large lists pass `onSearch`. */
  options: EntityOption[];
  /** Label shown in the trigger when nothing is selected. */
  placeholder?: string;
  /** What to render inside the trigger when a value IS selected. Defaults to the matched option's label. */
  renderValue?: (option: EntityOption | null) => ReactNode;
  /** Shown as the first command item; selecting it calls onChange(null). */
  clearLabel?: string | null;
  /** Optional custom filter function. Default: case-insensitive label substring match. */
  filter?: (option: EntityOption, query: string) => boolean;
  onChange: (next: EntityOption | null) => void;
  /** Disables the trigger. */
  disabled?: boolean;
  /** Width of the popover content. Defaults to the trigger's width. */
  contentWidth?: number;
}

const defaultFilter = (option: EntityOption, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    option.label.toLowerCase().includes(q) ||
    (option.sublabel?.toLowerCase().includes(q) ?? false)
  );
};

export function EntityPicker({
  value,
  options,
  placeholder = 'Select…',
  renderValue,
  clearLabel,
  filter = defaultFilter,
  onChange,
  disabled,
  contentWidth,
}: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = useMemo(() => options.find((o) => o.id === value) ?? null, [options, value]);
  const visible = useMemo(() => options.filter((o) => filter(o, query)), [options, query, filter]);

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            'h-8 w-full justify-start px-2 text-sm font-normal',
            !selected && 'text-muted-foreground',
          )}
        >
          {renderValue ? renderValue(selected) : selected?.label ?? `+ ${placeholder}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-1" align="start" style={contentWidth ? { width: contentWidth } : undefined}>
        <Command shouldFilter={false}>
          <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
              No results.
            </CommandEmpty>
            <CommandGroup>
              {clearLabel && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => { onChange(null); setOpen(false); }}
                  className="text-muted-foreground"
                >
                  {clearLabel}
                </CommandItem>
              )}
              {visible.map((option) => (
                <CommandItem
                  key={option.id}
                  value={`${option.label} ${option.sublabel ?? ''}`}
                  onSelect={() => { onChange(option); setOpen(false); }}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate">{option.label}</span>
                  {option.sublabel && (
                    <span className="truncate text-[11px] text-muted-foreground">{option.sublabel}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @prequest/web exec tsc --noEmit
git add apps/web/src/components/desk/editors/entity-picker.tsx
git commit -m "feat(web): EntityPicker reusable single-select picker"
```

---

### Task 5: `<MultiSelectPicker>` — reusable multi-select with optional create

**Files:**
- Create: `apps/web/src/components/desk/editors/multi-select-picker.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CheckIcon, PlusIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface MultiSelectOption {
  id: string;
  label: string;
  sublabel?: string | null;
}

export interface MultiSelectPickerProps {
  values: string[]; // array of selected option ids
  options: MultiSelectOption[];
  placeholder?: string;
  /** When true, typing a query that doesn't match any option shows "Create \"…\"". */
  allowCreate?: boolean;
  /** When provided, selected values render as removable pills inside the trigger. */
  renderPills?: boolean;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function MultiSelectPicker({
  values,
  options,
  placeholder = 'Select…',
  allowCreate = false,
  renderPills = true,
  onChange,
  disabled,
}: MultiSelectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selectedSet = useMemo(() => new Set(values), [values]);

  const visibleOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.sublabel?.toLowerCase().includes(q) ?? false),
    );
  }, [options, query]);

  const exactMatch = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return options.some((o) => o.label.toLowerCase() === q);
  }, [options, query]);

  const toggle = (id: string) => {
    if (selectedSet.has(id)) {
      onChange(values.filter((v) => v !== id));
    } else {
      onChange([...values, id]);
    }
  };

  const createFromQuery = () => {
    const q = query.trim();
    if (!q) return;
    if (!values.includes(q)) onChange([...values, q]);
    setQuery('');
  };

  const remove = (id: string) => onChange(values.filter((v) => v !== id));

  const selectedLabels = useMemo(() => {
    return values.map((v) => {
      const match = options.find((o) => o.id === v);
      return { id: v, label: match?.label ?? v };
    });
  }, [values, options]);

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            'h-auto min-h-8 w-full justify-start px-2 py-1 text-sm font-normal',
            values.length === 0 && 'text-muted-foreground',
          )}
        >
          {values.length === 0 ? (
            <span>+ {placeholder}</span>
          ) : renderPills ? (
            <div className="flex flex-wrap gap-1">
              {selectedLabels.map((s) => (
                <Badge
                  key={s.id}
                  variant="secondary"
                  className="text-xs gap-1"
                  onClick={(e) => { e.stopPropagation(); remove(s.id); }}
                >
                  {s.label}
                  <XIcon className="h-3 w-3 opacity-60" />
                </Badge>
              ))}
            </div>
          ) : (
            <span>{values.length} selected</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-1 w-[280px]" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={placeholder}
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && allowCreate && !exactMatch && query.trim()) {
                e.preventDefault();
                createFromQuery();
              }
            }}
          />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
              {allowCreate && query.trim() ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  onClick={createFromQuery}
                >
                  <PlusIcon className="h-3 w-3" /> Create "{query.trim()}"
                </button>
              ) : (
                'No results.'
              )}
            </CommandEmpty>
            <CommandGroup>
              {visibleOptions.map((option) => {
                const checked = selectedSet.has(option.id);
                return (
                  <CommandItem
                    key={option.id}
                    value={`${option.label} ${option.sublabel ?? ''}`}
                    onSelect={() => toggle(option.id)}
                    className="flex items-center gap-2"
                  >
                    <div className={cn('flex h-4 w-4 items-center justify-center rounded-sm border', checked && 'bg-primary border-primary text-primary-foreground')}>
                      {checked && <CheckIcon className="h-3 w-3" />}
                    </div>
                    <span className="truncate flex-1">{option.label}</span>
                    {option.sublabel && (
                      <span className="truncate text-[11px] text-muted-foreground">{option.sublabel}</span>
                    )}
                  </CommandItem>
                );
              })}
              {allowCreate && query.trim() && !exactMatch && (
                <CommandItem
                  value={`__create__${query}`}
                  onSelect={createFromQuery}
                  className="text-muted-foreground"
                >
                  <PlusIcon className="mr-2 h-3 w-3" />
                  Create "{query.trim()}"
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @prequest/web exec tsc --noEmit
git add apps/web/src/components/desk/editors/multi-select-picker.tsx
git commit -m "feat(web): MultiSelectPicker with optional create-new"
```

---

### Task 6: `<InlineTextEditor>` — click-to-edit text

**Files:**
- Create: `apps/web/src/components/desk/editors/inline-text-editor.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface InlineTextEditorProps {
  value: string;
  placeholder?: string;
  /** Rendering of the non-editing state. Defaults to the value as plain text. */
  renderView?: (value: string) => ReactNode;
  /** CSS classes applied to the <Textarea> in editing mode. */
  editorClassName?: string;
  /** CSS classes applied to the view wrapper. */
  viewClassName?: string;
  /** Single-line variant disables newlines and submits on Enter. */
  singleLine?: boolean;
  onSave: (next: string) => void;
  /** Disables editing entirely — renders view only. */
  disabled?: boolean;
}

/**
 * Click-to-edit text. Cmd/Ctrl+Enter saves, Esc cancels, blur saves.
 */
export function InlineTextEditor({
  value,
  placeholder = 'Empty',
  renderView,
  editorClassName,
  viewClassName,
  singleLine = false,
  onSave,
  disabled,
}: InlineTextEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      // Focus on next frame so the <Textarea> exists in the DOM.
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(node.value.length, node.value.length);
      });
    }
  }, [editing, value]);

  const commit = () => {
    const next = draft.trim();
    if (next !== value.trim()) onSave(next);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        className={cn(
          'cursor-text rounded-md px-2 py-1.5 -mx-2 transition-colors',
          !disabled && 'hover:bg-accent/30',
          viewClassName,
        )}
        onClick={() => { if (!disabled) setEditing(true); }}
      >
        {renderView
          ? renderView(value)
          : value
            ? <span>{value}</span>
            : <span className="text-muted-foreground">{placeholder}</span>}
      </div>
    );
  }

  return (
    <Textarea
      ref={textareaRef}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      rows={singleLine ? 1 : 3}
      className={cn('resize-none', editorClassName)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        } else if (e.key === 'Enter' && (singleLine || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @prequest/web exec tsc --noEmit
git add apps/web/src/components/desk/editors/inline-text-editor.tsx
git commit -m "feat(web): InlineTextEditor click-to-edit text component"
```

---

### Task 7: `<NumberEditor>` — popover + numeric input

**Files:**
- Create: `apps/web/src/components/desk/editors/number-editor.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface NumberEditorProps {
  value: number | null;
  placeholder?: string;
  /** Prefix rendered inside the input (e.g. "$"). */
  prefix?: string;
  /** Formatter for the trigger-button display. */
  formatDisplay?: (value: number | null) => string;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}

export function NumberEditor({
  value,
  placeholder = 'Add value',
  prefix,
  formatDisplay,
  onChange,
  disabled,
}: NumberEditorProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(value != null ? String(value) : '');
  const [error, setError] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(value != null ? String(value) : '');
      setError(false);
    }
  }, [open, value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      onChange(null);
      setOpen(false);
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) {
      setError(true);
      return;
    }
    onChange(parsed);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            'h-8 w-full justify-start px-2 text-sm font-normal',
            value == null && 'text-muted-foreground',
          )}
        >
          {value == null
            ? `+ ${placeholder}`
            : formatDisplay
              ? formatDisplay(value)
              : `${prefix ?? ''}${value}`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-2 w-[200px]" align="start">
        <div className="flex items-center gap-1.5">
          {prefix && <span className="text-sm text-muted-foreground">{prefix}</span>}
          <Input
            type="number"
            value={draft}
            placeholder={placeholder}
            autoFocus
            onChange={(e) => { setDraft(e.target.value); setError(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
            }}
            className={cn('h-8', error && 'border-red-500 focus-visible:ring-red-500/30')}
          />
        </div>
        <div className="flex justify-end gap-1.5 mt-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={commit}>Save</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @prequest/web exec tsc --noEmit
git add apps/web/src/components/desk/editors/number-editor.tsx
git commit -m "feat(web): NumberEditor popover + numeric input"
```

---

### Task 8: Refactor existing sidebar — Status/Priority/Team use new primitives

This task changes the sidebar plumbing but does NOT add new fields. It swaps Status/Priority/Team to use `useTicketMutation` + `InlineProperty`, and removes the now-redundant direct `apiFetch` and `refetch` wiring. No visible behavior change except that Team changes now go through the tiered PATCH/reassign logic.

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

- [ ] **Step 1: Add optimistic state + wire `useTicketMutation`**

Near the top of `TicketDetail` (after the existing `useApi` calls, around line 199), replace the existing `updateTicket` helper with the new hook. Update the `TicketData` type by adding any missing fields used below (`cost`, `watchers`, `assigned_vendor`).

Add these types near the existing `TicketData` (line 47):

```tsx
interface VendorRef { id: string; name: string }
```

Update the `TicketData` interface by adding:

```tsx
  cost?: number | null;
  watchers?: string[];
  assigned_vendor?: VendorRef | null;
```

Replace the `updateTicket` helper block with:

```tsx
const [overlay, setOverlay] = useState<Partial<UpdateTicketPayload> | null>(null);
const { patch, updateAssignment } = useTicketMutation({
  ticketId,
  refetch: refetchTicket,
  onOptimistic: setOverlay,
});

const displayedTicket: TicketData | null = ticket && overlay
  ? { ...ticket, ...overlay } as TicketData
  : ticket;
```

Add imports:

```tsx
import { useTicketMutation, UpdateTicketPayload } from '@/hooks/use-ticket-mutation';
import { InlineProperty } from '@/components/desk/inline-property';
```

Then replace every remaining `ticket.` reference inside the JSX rendering with `displayedTicket!.` (the `!` is safe — the early return on `!ticket` covers it).

- [ ] **Step 2: Rewrite the Status / Priority / Team fields using `<InlineProperty>`**

Find the three existing field blocks (`ticket-detail.tsx:699-748`) and replace with:

```tsx
<InlineProperty label="Status">
  <Select
    value={displayedTicket!.status_category}
    onValueChange={(v) => { if (v) patch({ status_category: v, status: v }); }}
  >
    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
    <SelectContent>
      {Object.entries(statusConfig).map(([key, cfg]) => (
        <SelectItem key={key} value={key}>
          <span className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${cfg.dotColor}`} /> {cfg.label}
          </span>
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
</InlineProperty>

<InlineProperty label="Priority">
  <Select
    value={displayedTicket!.priority}
    onValueChange={(v) => { if (v) patch({ priority: v }); }}
  >
    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
    <SelectContent>
      {Object.entries(priorityConfig).map(([key, cfg]) => (
        <SelectItem key={key} value={key}>
          <span className={cfg.color}>{cfg.label}</span>
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
</InlineProperty>

<InlineProperty label="Team">
  <EntityPicker
    value={displayedTicket!.assigned_team?.id ?? null}
    options={(teams ?? []).map((t) => ({ id: t.id, label: t.name }))}
    placeholder="team"
    clearLabel="Clear team"
    onChange={(option) => {
      updateAssignment({
        kind: 'team',
        id: option?.id ?? null,
        nextLabel: option?.label ?? null,
        previousLabel: displayedTicket!.assigned_team?.name ?? null,
      });
    }}
  />
</InlineProperty>
```

Add the EntityPicker import:

```tsx
import { EntityPicker } from '@/components/desk/editors/entity-picker';
```

- [ ] **Step 3: Smoke test — Status/Priority still work, Team now goes through reassign**

Run: `pnpm dev` and open a ticket detail that already has a team assigned. Change the team via the new picker. Verify in the browser dev-tools network tab that the request is `POST /tickets/:id/reassign` (not PATCH) and inspect the backend `routing_decisions` table:

```sql
select chosen_by, strategy, trace from routing_decisions where ticket_id = '<id>' order by created_at desc limit 1;
```

Expected: a new row with `chosen_by = 'manual_reassign'` and `trace[0].reason` containing "via ticket sidebar".

Then open a ticket that has no team assigned. Select a team. Expect a `PATCH /tickets/:id` (not `/reassign`), no new `routing_decisions` row.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx
git commit -m "refactor(web): sidebar Status/Priority/Team use InlineProperty + useTicketMutation"
```

---

### Task 9: Add Assignee + Vendor fields

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

- [ ] **Step 1: Fetch user + vendor lists**

Below the existing `useApi` calls, add:

```tsx
interface UserOption { id: string; email: string; person?: { first_name?: string; last_name?: string } | null }
interface VendorOption { id: string; name: string; active?: boolean }

const { data: users } = useApi<UserOption[]>('/users', []);
const { data: vendors } = useApi<VendorOption[]>('/vendors', []);
```

- [ ] **Step 2: Replace the existing read-only Assignee block with an EntityPicker**

Find the current Assignee block (`ticket-detail.tsx:751-757`) and replace with:

```tsx
<InlineProperty label="Assignee" icon={<User className="h-3 w-3 text-muted-foreground" />}>
  <EntityPicker
    value={displayedTicket!.assigned_agent?.id ?? null}
    options={(users ?? []).map((u) => ({
      id: u.id,
      label: u.person ? `${u.person.first_name ?? ''} ${u.person.last_name ?? ''}`.trim() || u.email : u.email,
      sublabel: u.email,
    }))}
    placeholder="assignee"
    clearLabel="Clear assignee"
    onChange={(option) => {
      updateAssignment({
        kind: 'user',
        id: option?.id ?? null,
        nextLabel: option?.label ?? null,
        previousLabel: displayedTicket!.assigned_agent?.email ?? null,
      });
    }}
  />
</InlineProperty>
```

- [ ] **Step 3: Replace the Vendor badge with an EntityPicker, only rendered when interaction_mode === 'external'**

Find the current `Interaction mode` block (`ticket-detail.tsx:827-833`) and replace with:

```tsx
{displayedTicket!.interaction_mode === 'external' && (
  <InlineProperty label="Vendor">
    <EntityPicker
      value={displayedTicket!.assigned_vendor?.id ?? null}
      options={(vendors ?? [])
        .filter((v) => v.active !== false)
        .map((v) => ({ id: v.id, label: v.name }))}
      placeholder="vendor"
      clearLabel="Clear vendor"
      onChange={(option) => {
        updateAssignment({
          kind: 'vendor',
          id: option?.id ?? null,
          nextLabel: option?.label ?? null,
          previousLabel: displayedTicket!.assigned_vendor?.name ?? null,
        });
      }}
    />
  </InlineProperty>
)}
```

Note: the backend `getById` ticket response may not yet include `assigned_vendor` as a joined relation. Check `ticket.service.ts:155-166`. If not, add it to the select inside `getById`:

```typescript
assigned_vendor:vendors!tickets_assigned_vendor_id_fkey(id, name),
```

- [ ] **Step 4: Smoke test**

Run `pnpm dev`. Open a ticket with `interaction_mode === 'internal'` → Vendor row is hidden. Open a ticket with `interaction_mode === 'external'` → Vendor picker visible. Change assignee and vendor; verify both route through the tiered logic in the dev-tools network panel.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx apps/api/src/modules/ticket/ticket.service.ts
git commit -m "feat(web): sidebar Assignee + Vendor editable via EntityPicker"
```

---

### Task 10: Add Labels (Tags) + Watchers

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

- [ ] **Step 1: Fetch tag suggestions**

Add near the other `useApi` calls:

```tsx
const { data: tagSuggestions } = useApi<string[]>('/tickets/tags', []);
```

- [ ] **Step 2: Replace the Tags block (`ticket-detail.tsx:800-815`) with MultiSelectPicker**

```tsx
<InlineProperty label="Labels" icon={<TagIcon className="h-3 w-3" />}>
  <MultiSelectPicker
    values={displayedTicket!.tags ?? []}
    options={(tagSuggestions ?? []).map((t) => ({ id: t, label: t }))}
    placeholder="label"
    allowCreate
    onChange={(next) => patch({ tags: next })}
  />
</InlineProperty>
```

Note the `id` of a tag option is the tag string itself — tags are identified by their value, not by a separate id.

- [ ] **Step 3: Add a Watchers block after Labels**

```tsx
<InlineProperty label="Watchers">
  <MultiSelectPicker
    values={displayedTicket!.watchers ?? []}
    options={(people ?? []).map((p) => ({
      id: p.id,
      label: `${p.first_name} ${p.last_name}`.trim(),
      sublabel: p.email ?? null,
    }))}
    placeholder="watcher"
    onChange={(next) => patch({ watchers: next })}
  />
</InlineProperty>
```

Add the import:

```tsx
import { MultiSelectPicker } from '@/components/desk/editors/multi-select-picker';
```

- [ ] **Step 4: Smoke test**

In the browser, add and remove tags, including a brand-new tag via "Create". Verify with a quick query:

```sql
select tags, watchers from tickets where id = '<id>';
```

Expected: both arrays updated as manipulated in the UI.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx
git commit -m "feat(web): sidebar Labels (with create) + Watchers editable"
```

---

### Task 11: Add Cost + Waiting reason

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

- [ ] **Step 1: Add Cost row** (place after Watchers)

```tsx
<InlineProperty label="Cost">
  <NumberEditor
    value={displayedTicket!.cost ?? null}
    placeholder="Add cost"
    prefix="$"
    formatDisplay={(v) => v == null ? '' : `$${v.toFixed(2)}`}
    onChange={(next) => patch({ cost: next })}
  />
</InlineProperty>
```

Add the import:

```tsx
import { NumberEditor } from '@/components/desk/editors/number-editor';
```

- [ ] **Step 2: Add Waiting reason, only when status_category === 'waiting'**

Place after Priority:

```tsx
{displayedTicket!.status_category === 'waiting' && (
  <InlineProperty label="Waiting reason">
    <Select
      value={displayedTicket!.waiting_reason ?? ''}
      onValueChange={(v) => patch({ waiting_reason: v || null })}
    >
      <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select reason" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="awaiting_requester">Awaiting requester</SelectItem>
        <SelectItem value="awaiting_vendor">Awaiting vendor</SelectItem>
        <SelectItem value="awaiting_parts">Awaiting parts</SelectItem>
        <SelectItem value="scheduled">Scheduled</SelectItem>
        <SelectItem value="blocked">Blocked</SelectItem>
      </SelectContent>
    </Select>
  </InlineProperty>
)}
```

If the project already has a canonical list of waiting reasons in a shared constants file (check `packages/shared/src/` or search for `waiting_reason` in `apps/web/src`), use that list instead of the hard-coded options above.

- [ ] **Step 3: Smoke test**

Change a ticket to status `waiting` → the Waiting reason row appears. Pick a reason → verify via dev-tools network panel that it posts to `PATCH /tickets/:id`. Set cost via the number editor; verify persistence with `select cost from tickets where id = '<id>'`.

Also verify SLA pause: pick a waiting reason that is included in the SLA policy's `pause_on_waiting_reasons` (see `docs/routing.md`) — the `sla_paused` flag on the ticket should flip to true. This exercises the existing pause logic, not new code, but it's worth confirming the UI path doesn't break it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx
git commit -m "feat(web): sidebar Cost + conditional Waiting reason editable"
```

---

### Task 12: Inline Title + Description editors

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

- [ ] **Step 1: Replace the title `<h1>` (line 370)**

Replace:

```tsx
<h1 className="text-2xl font-semibold leading-tight tracking-tight">{ticket.title}</h1>
```

with:

```tsx
<InlineTextEditor
  value={displayedTicket!.title}
  placeholder="Untitled"
  singleLine
  onSave={(next) => { if (next) patch({ title: next }); }}
  renderView={(v) => <h1 className="text-2xl font-semibold leading-tight tracking-tight">{v || 'Untitled'}</h1>}
  editorClassName="text-2xl font-semibold leading-tight tracking-tight border-0 shadow-none focus-visible:ring-0 px-0"
  viewClassName="rounded-md"
/>
```

- [ ] **Step 2: Replace the description block (lines 372-377)**

Replace:

```tsx
{ticket.description ? (
  <p className="mt-5 text-[15px] leading-relaxed text-foreground/80 whitespace-pre-wrap">{ticket.description}</p>
) : (
  <p className="mt-5 text-[15px] text-muted-foreground/60 cursor-pointer hover:text-muted-foreground">Add a description...</p>
)}
```

with:

```tsx
<div className="mt-5">
  <InlineTextEditor
    value={displayedTicket!.description ?? ''}
    placeholder="Add a description..."
    onSave={(next) => patch({ description: next })}
    renderView={(v) => v
      ? <p className="text-[15px] leading-relaxed text-foreground/80 whitespace-pre-wrap">{v}</p>
      : <p className="text-[15px] text-muted-foreground/60">Add a description...</p>}
    editorClassName="text-[15px] leading-relaxed min-h-[80px]"
  />
</div>
```

Add the import:

```tsx
import { InlineTextEditor } from '@/components/desk/editors/inline-text-editor';
```

- [ ] **Step 3: Smoke test**

Click the title → it becomes editable. Press Enter → saves. Press Esc → reverts. Same for description with Cmd+Enter to save (since it's multiline). Verify optimistic behavior: the UI updates the moment you blur, even before the server responds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx
git commit -m "feat(web): click-to-edit title + description"
```

---

### Task 13: Polish pass — empty states, hover, error surfacing

This task is a cleanup round. No new features, only consistency and affordance.

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`
- Modify: `apps/web/src/components/desk/editors/entity-picker.tsx` (possibly)

- [ ] **Step 1: Verify empty-state affordances across all fields**

Open a ticket with no team, no assignee, no vendor, no tags, no watchers, no cost. Every field should show `+ Add <label>` in muted color. Hover should reveal a `bg-accent/30` background.

If any field renders blank or without hover feedback, adjust the component's `placeholder` prop or wrap its trigger in `hover:bg-accent/30 rounded-md px-2 -mx-2` in `ticket-detail.tsx`. Do NOT modify the reusable editor components for one-off fixes — the components already handle this; any deviation is a configuration bug at the callsite.

- [ ] **Step 2: Verify hover affordance on filled fields**

Every filled field should also show `bg-accent/30` on hover. Same rule as above: fix callsites, not components, unless the component clearly misses the hover class.

- [ ] **Step 3: Verify error handling**

Temporarily stub `apiFetch` to throw on any `/tickets/` PATCH (or kill the API server). Attempt a change from any field. Expected: the UI reverts instantly, a red toast appears with the error message, no state stays stuck in an optimistic "ghost" value.

Restore the stub / API after verification.

- [ ] **Step 4: Verify accessibility (quick pass, no screen reader needed)**

Tab through the sidebar. Every trigger should be focusable. `Enter` / `Space` should open the popover or select. `Esc` should close it. Inline text editors should return focus to the view after save/cancel.

- [ ] **Step 5: Delete dead code**

Confirm removed:
- The `+ Add label` Button with no onClick (was at `ticket-detail.tsx:811`) — replaced by MultiSelectPicker.
- The old `updateTicket` helper (replaced by `useTicketMutation`).

Also remove any now-unused imports revealed by `tsc --noEmit`.

- [ ] **Step 6: Final type-check and lint**

```bash
pnpm --filter @prequest/web exec tsc --noEmit
pnpm --filter @prequest/web exec eslint "src/components/desk/**/*.{ts,tsx}" "src/hooks/**/*.ts"
```

Expected: no errors, no warnings.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx
git commit -m "chore(web): polish pass on sidebar inline editing"
```

---

## Definition of done

Mirror each bullet to `docs/superpowers/specs/2026-04-18-ticket-sidebar-inline-editing-design.md` § Success criteria:

- [ ] Every field in the spec's "made editable" table opens an editor on click and persists via the expected endpoint.
- [ ] Reassigning a team/assignee/vendor when one was previously set produces a `routing_decisions` row with `chosen_by = 'manual_reassign'`; a first-time assignment produces no such row.
- [ ] Optimistic update appears within one frame; rollback within one frame on error.
- [ ] The dead `+ Add label` button is gone; Tags editor handles both existing and new tag strings.
- [ ] No regression in the three previously-working fields (Status, Priority, Team).
- [ ] `GET /tickets/tags` returns distinct tenant-scoped tags; tenant isolation test passes.

## Out of scope (explicitly deferred — do NOT do these)

- Location, Asset, Request type, Requester editing. These need a "rescope" backend flow — tracked in `docs/routing.md` → Known gaps.
- Single-letter keyboard hotkeys (`A` / `L` / `P` / `S` / `T`). Stretch goal from the spec, explicitly optional. Do not ship unless every other task is done and it's a half-hour add.
- Mobile / narrow-viewport sidebar behavior.
- Satisfaction rating/comment editors.
- Sub-issues UI (placeholder at `ticket-detail.tsx:379-388`).
- Any refactor of the comment input / activity list / attachments flow — those are out of scope and healthy as-is.

## Self-review notes

- **Spec coverage:** every "made editable" row in the spec maps to a task in §8–§12. Read-only fields are deliberately not touched. Backend endpoint maps to §1. Optimistic updates + tiered reassign map to §2. Reusable components map to §3–§7.
- **Placeholder scan:** no TBD / TODO / "implement later". All code blocks are complete and runnable.
- **Type consistency:** `UpdateTicketPayload`, `AssignmentKind`, `AssignmentTarget`, `EntityOption`, `MultiSelectOption` are defined once and reused consistently in later tasks.
- **Known plan-level judgment calls:** (a) `/users` may or may not support `?search=` — client-side filtering is acceptable for tenants under a few hundred users; if scaling problems appear, add a query param to the backend. (b) The Waiting reason enum is hard-coded unless a shared constants file already defines it. Step 2 of Task 11 says check for one first.
