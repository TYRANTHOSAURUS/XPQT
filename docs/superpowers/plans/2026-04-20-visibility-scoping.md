# Visibility Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the "GET /tickets returns all tenant rows" gap. Every ticket read and per-ticket write must check that the current user is allowed, using a layered policy (Participants + Operators + Overrides). Spec: `docs/superpowers/specs/2026-04-20-visibility-scoping-design.md`.

**Architecture:** A single SQL function `ticket_visibility_ids(user_id, tenant_id)` defines the canonical read predicate. A new `TicketVisibilityService` loads each request's user context (teams, role scopes, permissions) and exposes two helpers: `applyReadFilter` for listing (`.in('id', rpc(...))`) and `assertVisible` for per-ticket gates. API-layer enforcement; tenant RLS stays unchanged.

**Tech Stack:** NestJS, Supabase Postgres, TypeScript, Jest. Frontend: React 19 + shadcn/ui.

---

## File structure

| File | New / Modified | Purpose |
|---|---|---|
| `supabase/migrations/00033_ticket_visibility.sql` | New | `ticket_visibility_ids` SQL function + `ticket_visibility_has_write` helper + supporting indexes. |
| `supabase/migrations/00034_seed_admin_ticket_permissions.sql` | New | Idempotent grant of `tickets:read_all` + `tickets:write_all` to the default admin role. |
| `apps/api/src/modules/ticket/ticket-visibility.service.ts` | New | `TicketVisibilityService` — types, `loadContext`, `applyReadFilter`, `assertVisible`. |
| `apps/api/src/modules/ticket/ticket-visibility.service.spec.ts` | New | Unit tests: one per policy path. |
| `apps/api/src/modules/ticket/ticket.module.ts` | Modified | Register `TicketVisibilityService`. |
| `apps/api/src/modules/ticket/ticket.service.ts` | Modified | Every read + per-ticket-write path calls the helpers. Methods accept `actorAuthUid` (Supabase auth UID). |
| `apps/api/src/modules/ticket/ticket.controller.ts` | Modified | Pass `req.user.id` into service. Add `GET /tickets/:id/visibility-trace`. |
| `apps/api/src/modules/ticket/ticket.controller.spec.ts` | Modified | Stub the visibility service in the existing children test; add a trace test. |
| `apps/web/src/components/desk/ticket-detail.tsx` | Modified | Render a friendly "no access" state on 403. |
| `docs/visibility.md` | New | Living reference. |
| `CLAUDE.md` | Modified | Add a short Visibility section + update trigger list. |

---

## Task 1: Migration — `ticket_visibility_ids` SQL function + indexes

**Files:**
- Create: `supabase/migrations/00033_ticket_visibility.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00033_ticket_visibility.sql
-- Visibility predicate used by the API and (optionally later) by RLS.
-- Returns the set of ticket ids the given user can READ inside the given tenant.

-- Supporting indexes for the 6 visibility paths.
create index if not exists idx_tickets_requester_tenant on public.tickets (tenant_id, requester_person_id);
create index if not exists idx_tickets_assigned_user_tenant on public.tickets (tenant_id, assigned_user_id);
-- assigned_team_id already indexed in 00011
-- assigned_vendor_id already indexed in 00027
create index if not exists idx_tickets_watchers_gin on public.tickets using gin (watchers);
create index if not exists idx_tickets_tenant_domain_loc on public.tickets (tenant_id, ticket_type_id, location_id);

-- Helper: expand a set of space ids into the closure of all descendant space ids.
-- Uses recursive CTE on spaces.parent_id. Caps depth at 20 for safety.
create or replace function public.expand_space_closure(p_roots uuid[])
returns setof uuid
language sql stable
as $$
  with recursive chain(id, depth) as (
    select unnest(p_roots), 0
    union all
    select s.id, c.depth + 1
    from public.spaces s
    join chain c on s.parent_id = c.id
    where c.depth < 20
  )
  select distinct id from chain;
$$;

-- Main visibility predicate.
-- Takes a user id and tenant id, returns ids of visible tickets.
-- Read-only; no side effects.
create or replace function public.ticket_visibility_ids(p_user_id uuid, p_tenant_id uuid)
returns setof uuid
language sql stable
as $$
  with
    actor as (
      select u.id as user_id, u.person_id
      from public.users u
      where u.id = p_user_id and u.tenant_id = p_tenant_id
    ),
    team_ids as (
      select tm.team_id
      from public.team_members tm
      where tm.tenant_id = p_tenant_id and tm.user_id = p_user_id
    ),
    role_paths as (
      select
        coalesce(ura.domain_scope, '{}'::text[]) as domain_scope,
        coalesce(ura.location_scope, '{}'::uuid[]) as location_scope
      from public.user_role_assignments ura
      where ura.user_id = p_user_id
        and ura.tenant_id = p_tenant_id
        and ura.active = true
    ),
    -- Flatten every role's location scope to its descendant closure.
    -- Each role row expands independently, so matches preserve role provenance.
    role_location_closures as (
      select
        r.domain_scope,
        case
          when array_length(r.location_scope, 1) is null then '{}'::uuid[]
          else (select array_agg(id) from public.expand_space_closure(r.location_scope))
        end as location_closure
      from role_paths r
    ),
    -- Resolve ticket.domain via request_types join (domain lives on request_types, not tickets).
    -- We still select t.id; the join is needed only for the role-domain match.
    base as (
      select t.id, t.requester_person_id, t.assigned_user_id, t.assigned_team_id,
             t.assigned_vendor_id, t.watchers, t.location_id,
             rt.domain
      from public.tickets t
      left join public.request_types rt on rt.id = t.ticket_type_id
      where t.tenant_id = p_tenant_id
    )
  select distinct b.id
  from base b
  cross join actor a
  where
    -- Participant paths
    b.requester_person_id = a.person_id
    or b.assigned_user_id = a.user_id
    or a.person_id = any(b.watchers)
    -- Team path
    or b.assigned_team_id in (select team_id from team_ids)
    -- Vendor participant — a user is vendor-linked when their person has external_source='vendor'
    -- and a matching vendor exists. Placeholder: phase 4 will formalize. Included here so the
    -- predicate is forward-compatible. Today returns empty for non-vendor users.
    or b.assigned_vendor_id in (
      select v.id from public.vendors v
      join public.persons p on p.id = a.person_id
      where v.tenant_id = p_tenant_id and p.external_source = 'vendor'
    )
    -- Role paths: ANY role grants visibility when BOTH its domain AND location condition match.
    or exists (
      select 1 from role_location_closures rc
      where
        -- Domain: empty scope = all domains
        (array_length(rc.domain_scope, 1) is null or b.domain = any(rc.domain_scope))
        -- Location: empty closure = all locations, otherwise ticket location must be in closure.
        and (
          array_length(rc.location_closure, 1) is null
          or b.location_id = any(rc.location_closure)
          or b.location_id is null  -- tickets with no location are visible to domain-only roles
        )
    );
$$;

-- Does the user hold the given permission? Checks permissions jsonb across all active roles.
-- Permission keys are strings like 'tickets:read_all'.
create or replace function public.user_has_permission(p_user_id uuid, p_tenant_id uuid, p_permission text)
returns boolean
language sql stable
as $$
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.roles r on r.id = ura.role_id
    where ura.user_id = p_user_id
      and ura.tenant_id = p_tenant_id
      and ura.active = true
      and r.active = true
      and r.permissions ? p_permission
  );
$$;

-- Reload PostgREST schema cache so the new RPC functions are exposed.
notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally**

Run: `pnpm db:reset`
Expected: migration applies cleanly; no errors.

- [ ] **Step 3: Smoke-check the function**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select proname from pg_proc where proname in ('ticket_visibility_ids', 'expand_space_closure', 'user_has_permission');"
```
Expected: three rows listed.

- [ ] **Step 4: Ask user before pushing to remote**

Do NOT run `pnpm db:push` in this task. Ask the controlling session (or user) to push. Task 7 (sanity pass) handles it.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00033_ticket_visibility.sql
git commit -m "feat(db): ticket_visibility_ids SQL function + supporting indexes"
```

---

## Task 2: Migration — seed admin ticket permissions

**Files:**
- Create: `supabase/migrations/00034_seed_admin_ticket_permissions.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00034_seed_admin_ticket_permissions.sql
-- Idempotent: grant tickets:read_all + tickets:write_all to any role whose name is 'admin'
-- (case-insensitive). Existing permissions arrays are merged, not replaced.

update public.roles
set permissions =
  case
    when permissions is null or jsonb_typeof(permissions) <> 'array' then
      '["tickets:read_all","tickets:write_all"]'::jsonb
    else (
      select jsonb_agg(distinct elem)
      from (
        select jsonb_array_elements_text(permissions) as elem
        union
        select unnest(array['tickets:read_all','tickets:write_all'])
      ) t
    )
  end,
  updated_at = now()
where lower(name) = 'admin';

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally**

Run: `pnpm db:reset`
Expected: applies cleanly.

- [ ] **Step 3: Verify**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "select name, permissions from public.roles where lower(name)='admin';"
```
Expected: the admin role (if seeded) shows `permissions` containing both strings. If no admin role exists in the local seed, the update is a no-op — that's fine.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00034_seed_admin_ticket_permissions.sql
git commit -m "feat(db): grant tickets:read_all + tickets:write_all to admin role"
```

---

## Task 3: `TicketVisibilityService` + unit tests (TDD)

**Files:**
- Create: `apps/api/src/modules/ticket/ticket-visibility.service.ts`
- Create: `apps/api/src/modules/ticket/ticket-visibility.service.spec.ts`
- Modify: `apps/api/src/modules/ticket/ticket.module.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/modules/ticket/ticket-visibility.service.spec.ts`:

```typescript
import { ForbiddenException } from '@nestjs/common';
import { TicketVisibilityService, VisibilityContext } from './ticket-visibility.service';

function ctx(over: Partial<VisibilityContext> = {}): VisibilityContext {
  return {
    user_id: 'u1',
    person_id: 'p1',
    tenant_id: 't1',
    team_ids: [],
    role_assignments: [],
    vendor_id: null,
    has_read_all: false,
    has_write_all: false,
    ...over,
  };
}

describe('TicketVisibilityService.assertVisible', () => {
  // Shape of the ticket rows the helper reads for local path evaluation.
  type TicketRow = {
    id: string;
    tenant_id: string;
    requester_person_id: string | null;
    assigned_user_id: string | null;
    assigned_team_id: string | null;
    assigned_vendor_id: string | null;
    watchers: string[];
    location_id: string | null;
    domain: string | null;
  };

  function svc(row: TicketRow) {
    const supabase = {
      admin: {
        from: jest.fn(() => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: row, error: null }),
              }),
            }),
          }),
        })),
        rpc: jest.fn(async () => ({ data: [], error: null })),
      },
    };
    return new TicketVisibilityService(supabase as never);
  }

  const baseRow = {
    id: 'tk1', tenant_id: 't1',
    requester_person_id: null, assigned_user_id: null, assigned_team_id: null,
    assigned_vendor_id: null, watchers: [], location_id: null, domain: 'fm',
  };

  it('allows read when user is requester', async () => {
    const s = svc({ ...baseRow, requester_person_id: 'p1' });
    await expect(s.assertVisible('tk1', ctx(), 'read')).resolves.toBeUndefined();
  });

  it('allows read when user is personal assignee', async () => {
    const s = svc({ ...baseRow, assigned_user_id: 'u1' });
    await expect(s.assertVisible('tk1', ctx(), 'read')).resolves.toBeUndefined();
  });

  it('allows read when user person is a watcher', async () => {
    const s = svc({ ...baseRow, watchers: ['p9', 'p1'] });
    await expect(s.assertVisible('tk1', ctx(), 'read')).resolves.toBeUndefined();
  });

  it('allows read when user team matches the assigned team', async () => {
    const s = svc({ ...baseRow, assigned_team_id: 'team1' });
    await expect(s.assertVisible('tk1', ctx({ team_ids: ['team1'] }), 'read')).resolves.toBeUndefined();
  });

  it('allows read via a role with matching domain and empty location scope', async () => {
    const s = svc({ ...baseRow, domain: 'fm', location_id: 'spaceX' });
    const c = ctx({
      role_assignments: [
        { domain_scope: ['fm'], location_scope_closure: [], read_only_cross_domain: false },
      ],
    });
    await expect(s.assertVisible('tk1', c, 'read')).resolves.toBeUndefined();
  });

  it('allows read via a role whose location closure contains the ticket location', async () => {
    const s = svc({ ...baseRow, domain: 'fm', location_id: 'floor3' });
    const c = ctx({
      role_assignments: [
        { domain_scope: [], location_scope_closure: ['bldgA', 'floor3'], read_only_cross_domain: false },
      ],
    });
    await expect(s.assertVisible('tk1', c, 'read')).resolves.toBeUndefined();
  });

  it('denies read when no path matches', async () => {
    const s = svc(baseRow);
    await expect(s.assertVisible('tk1', ctx(), 'read')).rejects.toThrow(ForbiddenException);
  });

  it('allows read when has_read_all is true regardless of paths', async () => {
    const s = svc(baseRow);
    await expect(s.assertVisible('tk1', ctx({ has_read_all: true }), 'read')).resolves.toBeUndefined();
  });

  it('denies write when only path is a read_only_cross_domain role', async () => {
    const s = svc({ ...baseRow, domain: 'fm' });
    const c = ctx({
      role_assignments: [
        { domain_scope: ['fm'], location_scope_closure: [], read_only_cross_domain: true },
      ],
    });
    await expect(s.assertVisible('tk1', c, 'read')).resolves.toBeUndefined();
    await expect(s.assertVisible('tk1', c, 'write')).rejects.toThrow(ForbiddenException);
  });

  it('allows write when a non-readonly role matches', async () => {
    const s = svc({ ...baseRow, domain: 'fm' });
    const c = ctx({
      role_assignments: [
        { domain_scope: ['fm'], location_scope_closure: [], read_only_cross_domain: true },
        { domain_scope: ['fm'], location_scope_closure: [], read_only_cross_domain: false },
      ],
    });
    await expect(s.assertVisible('tk1', c, 'write')).resolves.toBeUndefined();
  });

  it('allows write for participants even with no operator role', async () => {
    const s = svc({ ...baseRow, requester_person_id: 'p1' });
    await expect(s.assertVisible('tk1', ctx(), 'write')).resolves.toBeUndefined();
  });

  it('allows write when has_write_all is true', async () => {
    const s = svc(baseRow);
    await expect(s.assertVisible('tk1', ctx({ has_write_all: true }), 'write')).resolves.toBeUndefined();
  });

  it('throws ForbiddenException when ticket does not exist', async () => {
    const supabase = {
      admin: {
        from: jest.fn(() => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        })),
      },
    };
    const s = new TicketVisibilityService(supabase as never);
    await expect(s.assertVisible('tk-missing', ctx(), 'read')).rejects.toThrow(ForbiddenException);
  });
});

describe('TicketVisibilityService.loadContext', () => {
  it('returns has_read_all=false and empty arrays for a user with no roles or teams', async () => {
    const supabase = {
      admin: {
        from: jest.fn((table: string) => {
          if (table === 'users') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({ data: { id: 'u1', person_id: 'p1' }, error: null }),
                  }),
                }),
              }),
            };
          }
          if (table === 'team_members') {
            return {
              select: () => ({
                eq: () => ({ eq: () => ({ then: (fn: Function) => fn({ data: [], error: null }) }) }),
              }),
            };
          }
          if (table === 'user_role_assignments') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({ then: (fn: Function) => fn({ data: [], error: null }) }),
                  }),
                }),
              }),
            };
          }
          if (table === 'persons') {
            return {
              select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
            };
          }
          return {};
        }),
        rpc: jest.fn(async () => ({ data: false, error: null })),
      },
    };
    const s = new TicketVisibilityService(supabase as never);
    const result = await s.loadContext('auth-123', 't1');
    expect(result.user_id).toBe('u1');
    expect(result.person_id).toBe('p1');
    expect(result.team_ids).toEqual([]);
    expect(result.role_assignments).toEqual([]);
    expect(result.has_read_all).toBe(false);
    expect(result.has_write_all).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm --filter @prequest/api test -- ticket-visibility.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/modules/ticket/ticket-visibility.service.ts`:

```typescript
import { ForbiddenException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';

export interface RoleAssignmentCtx {
  domain_scope: string[];          // empty array = all domains
  location_scope_closure: string[]; // empty array = all locations; otherwise expanded descendants
  read_only_cross_domain: boolean;
}

export interface VisibilityContext {
  user_id: string;
  person_id: string | null;
  tenant_id: string;
  team_ids: string[];
  role_assignments: RoleAssignmentCtx[];
  vendor_id: string | null;  // phase-4 stub; null today
  has_read_all: boolean;
  has_write_all: boolean;
}

interface TicketForVisibility {
  id: string;
  tenant_id: string;
  requester_person_id: string | null;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  assigned_vendor_id: string | null;
  watchers: string[] | null;
  location_id: string | null;
  domain: string | null;
}

@Injectable()
export class TicketVisibilityService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Resolves the Supabase auth uid to a full visibility context within the given tenant.
   * Callers pass `req.user.id` as `authUid`.
   */
  async loadContext(authUid: string, tenantId: string): Promise<VisibilityContext> {
    const userLookup = await (this.supabase.admin.from('users')
      .select('id, person_id')
      .eq('tenant_id', tenantId)
      .eq('auth_uid', authUid) as unknown as { maybeSingle: () => Promise<{ data: { id: string; person_id: string | null } | null; error: unknown }> }).maybeSingle();
    const userRow = userLookup.data;
    if (!userRow) {
      // Unknown user in this tenant — return a context that matches nothing.
      return {
        user_id: '', person_id: null, tenant_id: tenantId,
        team_ids: [], role_assignments: [], vendor_id: null,
        has_read_all: false, has_write_all: false,
      };
    }

    const [teamsRes, rolesRes, readAllRes, writeAllRes] = await Promise.all([
      this.supabase.admin.from('team_members')
        .select('team_id')
        .eq('tenant_id', tenantId)
        .eq('user_id', userRow.id),
      this.supabase.admin.from('user_role_assignments')
        .select('domain_scope, location_scope, read_only_cross_domain')
        .eq('tenant_id', tenantId)
        .eq('user_id', userRow.id)
        .eq('active', true),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id, p_tenant_id: tenantId, p_permission: 'tickets:read_all',
      }),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id, p_tenant_id: tenantId, p_permission: 'tickets:write_all',
      }),
    ]);

    const team_ids = ((teamsRes.data ?? []) as Array<{ team_id: string }>).map((r) => r.team_id);

    const rawRoles = (rolesRes.data ?? []) as Array<{
      domain_scope: string[] | null;
      location_scope: string[] | null;
      read_only_cross_domain: boolean;
    }>;

    const role_assignments: RoleAssignmentCtx[] = [];
    for (const r of rawRoles) {
      const closure = await this.expandLocationClosure(r.location_scope ?? []);
      role_assignments.push({
        domain_scope: r.domain_scope ?? [],
        location_scope_closure: closure,
        read_only_cross_domain: !!r.read_only_cross_domain,
      });
    }

    return {
      user_id: userRow.id,
      person_id: userRow.person_id,
      tenant_id: tenantId,
      team_ids,
      role_assignments,
      vendor_id: null, // phase-4 will populate via persons.external_source = 'vendor'
      has_read_all: !!readAllRes.data,
      has_write_all: !!writeAllRes.data,
    };
  }

  /**
   * Call the SQL closure helper for a given set of root space ids.
   */
  private async expandLocationClosure(rootIds: string[]): Promise<string[]> {
    if (rootIds.length === 0) return [];
    const { data } = await this.supabase.admin.rpc('expand_space_closure', { p_roots: rootIds });
    if (!Array.isArray(data)) return rootIds;
    return (data as Array<{ id?: string } | string>).map((row) =>
      typeof row === 'string' ? row : (row.id as string),
    );
  }

  /**
   * Returns a Supabase filter stub telling the caller how to narrow a tickets query
   * to visible rows. Strategy: use the `ticket_visibility_ids` SQL function via `.in()`.
   * Callers chain: baseQuery.in('id', await visibility.getVisibleIds(ctx)).
   */
  async getVisibleIds(ctx: VisibilityContext): Promise<string[] | null> {
    if (ctx.has_read_all) return null; // null = no filter (see all)
    if (!ctx.user_id) return [];
    const { data, error } = await this.supabase.admin
      .rpc('ticket_visibility_ids', { p_user_id: ctx.user_id, p_tenant_id: ctx.tenant_id });
    if (error) throw error;
    return (data as Array<string | { id: string }> | null)?.map((row) =>
      typeof row === 'string' ? row : row.id,
    ) ?? [];
  }

  /**
   * Per-ticket gate. Loads the ticket, evaluates paths in TypeScript against ctx.
   * `mode = 'read'`: any path matches or has_read_all.
   * `mode = 'write'`: participant OR non-readonly operator OR has_write_all.
   * Throws ForbiddenException on denial.
   */
  async assertVisible(ticketId: string, ctx: VisibilityContext, mode: 'read' | 'write'): Promise<void> {
    if (mode === 'read' && ctx.has_read_all) return;
    if (mode === 'write' && ctx.has_write_all) return;

    const row = await this.loadTicketRow(ticketId, ctx.tenant_id);
    if (!row) throw new ForbiddenException('Ticket not accessible');

    // Participant paths (allow read and write).
    const participantMatch =
      (!!ctx.person_id && row.requester_person_id === ctx.person_id) ||
      row.assigned_user_id === ctx.user_id ||
      (!!ctx.person_id && (row.watchers ?? []).includes(ctx.person_id)) ||
      (!!ctx.vendor_id && row.assigned_vendor_id === ctx.vendor_id);

    if (participantMatch) return;

    // Team path (treated as operator, always writable).
    const teamMatch = !!row.assigned_team_id && ctx.team_ids.includes(row.assigned_team_id);
    if (teamMatch && mode === 'write') return;

    // Role operator paths.
    const matchingRoles = ctx.role_assignments.filter((role) => {
      const domainOk =
        role.domain_scope.length === 0 ||
        (row.domain != null && role.domain_scope.includes(row.domain));
      const locationOk =
        role.location_scope_closure.length === 0 ||
        row.location_id == null ||
        role.location_scope_closure.includes(row.location_id);
      return domainOk && locationOk;
    });

    const anyRoleMatch = matchingRoles.length > 0;
    const anyWritableRole = matchingRoles.some((r) => !r.read_only_cross_domain);

    if (mode === 'read') {
      if (teamMatch || anyRoleMatch) return;
    } else {
      if (teamMatch || anyWritableRole) return;
    }

    throw new ForbiddenException('Ticket not accessible');
  }

  private async loadTicketRow(ticketId: string, tenantId: string): Promise<TicketForVisibility | null> {
    const { data } = await (this.supabase.admin
      .from('tickets')
      .select(`
        id, tenant_id, requester_person_id, assigned_user_id, assigned_team_id,
        assigned_vendor_id, watchers, location_id,
        ticket_type:request_types!tickets_ticket_type_id_fkey(domain)
      `)
      .eq('id', ticketId)
      .eq('tenant_id', tenantId) as unknown as { maybeSingle: () => Promise<{ data: Record<string, unknown> | null }> })
      .maybeSingle();
    if (!data) return null;
    const raw = data as Record<string, unknown>;
    const type = Array.isArray(raw.ticket_type) ? (raw.ticket_type as unknown[])[0] : raw.ticket_type;
    return {
      id: raw.id as string,
      tenant_id: raw.tenant_id as string,
      requester_person_id: (raw.requester_person_id as string | null) ?? null,
      assigned_user_id: (raw.assigned_user_id as string | null) ?? null,
      assigned_team_id: (raw.assigned_team_id as string | null) ?? null,
      assigned_vendor_id: (raw.assigned_vendor_id as string | null) ?? null,
      watchers: (raw.watchers as string[] | null) ?? [],
      location_id: (raw.location_id as string | null) ?? null,
      domain: (type as { domain?: string | null } | null)?.domain ?? null,
    };
  }
}
```

- [ ] **Step 4: Register in module**

Open `apps/api/src/modules/ticket/ticket.module.ts`. Add an import and list the new service in providers + exports:

```typescript
import { Module, forwardRef } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';
import { DispatchService } from './dispatch.service';
import { TicketVisibilityService } from './ticket-visibility.service';
import { RoutingModule } from '../routing/routing.module';
import { SlaModule } from '../sla/sla.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ApprovalModule } from '../approval/approval.module';

@Module({
  imports: [
    RoutingModule,
    SlaModule,
    forwardRef(() => WorkflowModule),
    forwardRef(() => ApprovalModule),
  ],
  providers: [TicketService, DispatchService, TicketVisibilityService],
  controllers: [TicketController],
  exports: [TicketService, DispatchService, TicketVisibilityService],
})
export class TicketModule {}
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @prequest/api test -- ticket-visibility.service.spec.ts`
Expected: all passing.

Then full suite: `pnpm --filter @prequest/api test`
Expected: no regressions.

- [ ] **Step 6: Build + commit**

```bash
pnpm --filter @prequest/api build
git add apps/api/src/modules/ticket/ticket-visibility.service.ts \
        apps/api/src/modules/ticket/ticket-visibility.service.spec.ts \
        apps/api/src/modules/ticket/ticket.module.ts
git commit -m "feat(tickets): TicketVisibilityService — loadContext + assertVisible + getVisibleIds"
```

---

## Task 4: Wire visibility into TicketService reads + per-ticket writes

**Files:**
- Modify: `apps/api/src/modules/ticket/ticket.service.ts`
- Modify: `apps/api/src/modules/ticket/ticket.controller.ts`

- [ ] **Step 1: Inject `TicketVisibilityService` into `TicketService`**

In `apps/api/src/modules/ticket/ticket.service.ts`, update the constructor. Find the existing constructor block and add the new dependency:

```typescript
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => RoutingService)) private readonly routingService: RoutingService,
    private readonly slaService: SlaService,
    @Inject(forwardRef(() => WorkflowEngineService)) private readonly workflowEngine: WorkflowEngineService,
    @Inject(forwardRef(() => ApprovalService)) private readonly approvalService: ApprovalService,
    private readonly visibility: TicketVisibilityService,
  ) {}
```

Add the import near the top of the file:

```typescript
import { TicketVisibilityService } from './ticket-visibility.service';
```

- [ ] **Step 2: Accept `actorAuthUid` in read + write entry points**

Every method on `TicketService` that a controller calls needs to accept a new first-parameter-after-existing `actorAuthUid: string`. Concretely:

- `list(filters, actorAuthUid)` — extend existing signature.
- `getById(id, actorAuthUid)` — extend.
- `getChildTasks(parentId, actorAuthUid)` — extend.
- `update(id, dto, actorAuthUid)` — extend.
- `reassign(id, dto, actorAuthUid)` — extend.
- `addActivity(id, dto, actorAuthUid)` — extend.
- `uploadAttachments(...args, actorAuthUid)` — extend (if this exists; check the file).

Strategy: add the parameter at the END of each method signature so existing call sites inside the service that reuse these methods can either (a) pass the UID through if they have it, or (b) pass a sentinel like `'__system__'` when called from a background context. To keep the implementation simple, define a module-private constant:

```typescript
const SYSTEM_ACTOR = '__system__';
```

For internal recursive calls (workflow engine, approval callbacks, etc.), use `SYSTEM_ACTOR`. The visibility helper treats it as "bypass everything" by checking `actorAuthUid === SYSTEM_ACTOR` at the top of each method.

Inside each controller-reachable method, at the top:

```typescript
  async list(filters: TicketListFilters = {}, actorAuthUid: string) {
    const tenant = TenantContext.current();
    const ctx = actorAuthUid === SYSTEM_ACTOR
      ? null
      : await this.visibility.loadContext(actorAuthUid, tenant.id);
    // ... existing setup ...
    let query = this.supabase.admin.from('tickets').select(...);
    if (ctx) {
      const ids = await this.visibility.getVisibleIds(ctx);
      if (ids !== null) query = query.in('id', ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000']);
    }
    // ... existing filters + execute + return ...
  }
```

(The sentinel UUID is a guaranteed-miss — without it, `.in('id', [])` in Supabase would return an empty set via a parse error. Safer to match nothing explicitly.)

For `getById`, before returning the row:

```typescript
  async getById(id: string, actorAuthUid: string) {
    const tenant = TenantContext.current();
    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(id, ctx, 'read');
    }
    // ... existing query ...
  }
```

For `getChildTasks(parentId, actorAuthUid)`:

```typescript
  async getChildTasks(parentId: string, actorAuthUid: string) {
    const tenant = TenantContext.current();
    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(parentId, ctx, 'read');
      // Also filter children to the visible subset.
      const visibleIds = await this.visibility.getVisibleIds(ctx);
      // ... base query ...
      let q = this.supabase.admin.from('tickets').select(...).eq('parent_ticket_id', parentId);
      if (visibleIds !== null) q = q.in('id', visibleIds.length > 0 ? visibleIds : ['00000000-0000-0000-0000-000000000000']);
      const { data, error } = await q.order('created_at');
      if (error) throw error;
      return data;
    }
    // SYSTEM_ACTOR path: existing unfiltered logic.
  }
```

For writes (`update`, `reassign`, `addActivity`, `uploadAttachments`):

```typescript
  async update(id: string, dto: UpdateTicketDto, actorAuthUid: string) {
    const tenant = TenantContext.current();
    if (actorAuthUid !== SYSTEM_ACTOR) {
      const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
      await this.visibility.assertVisible(id, ctx, 'write');
    }
    // ... existing update logic ...
  }
```

Note: `create()` is not gated — users always create as themselves and become the requester, which makes the ticket visible to them via the Participant path on subsequent reads.

- [ ] **Step 3: Update internal self-calls to pass SYSTEM_ACTOR**

Inside `ticket.service.ts`, `runPostCreateAutomation`, `onApprovalDecision`, and other internal paths call `getById` on behalf of the system. Audit every internal `this.getById(...)` / `this.update(...)` call and pass `SYSTEM_ACTOR` as the last argument. Example:

```typescript
  const ticketRecord = await this.getById(ticketId, SYSTEM_ACTOR);
```

Run a grep after editing to ensure every call site now has the parameter:

```bash
grep -n "this\.getById\|this\.update\|this\.reassign\|this\.addActivity\|this\.getChildTasks" apps/api/src/modules/ticket/ticket.service.ts
```

Every match should have a second (or third) argument that is either a user UID or `SYSTEM_ACTOR`.

- [ ] **Step 4: Update controller to pass `req.user.id`**

In `apps/api/src/modules/ticket/ticket.controller.ts`, every route handler that reaches the service must pass `req.user.id`. The handlers already use `@Req() request: Request` for some routes; extend to all.

Example for list:

```typescript
  @Get()
  async list(
    @Req() request: Request,
    @Query('status_category') statusCategory?: string,
    @Query('priority') priority?: string,
    @Query('kind') ticketKind?: 'case' | 'work_order',
    @Query('assigned_team_id') assignedTeamId?: string,
    @Query('assigned_user_id') assignedUserId?: string,
    @Query('location_id') locationId?: string,
    @Query('requester_person_id') requesterPersonId?: string,
    @Query('parent_ticket_id') parentTicketId?: string,
    @Query('sla_at_risk') slaAtRisk?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    return this.ticketService.list({
      status_category: statusCategory,
      priority,
      ticket_kind: ticketKind,
      assigned_team_id: assignedTeamId,
      assigned_user_id: assignedUserId,
      location_id: locationId,
      requester_person_id: requesterPersonId,
      parent_ticket_id: parentTicketId === 'null' ? null : parentTicketId,
      sla_at_risk: slaAtRisk === 'true' ? true : undefined,
      search,
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    }, actorAuthUid);
  }
```

Apply the same `actorAuthUid` extraction to every route in the controller: `getById`, `create`, `update`, `reassign`, `dispatch`, `children`, `addActivity`, attachment uploads. For routes that don't reach through `TicketService`, skip.

Ensure each controller method accepts `@Req() request: Request` and imports `UnauthorizedException` from `@nestjs/common`.

If a controller route protected by `AuthGuard` can trust `request.user.id` is populated, the only check needed is the non-null one shown above.

- [ ] **Step 5: Build**

Run: `pnpm --filter @prequest/api build`
Expected: clean compile. Any errors are almost certainly missing-parameter signatures on internal call sites — search for them with the grep in Step 3.

- [ ] **Step 6: Update `ticket.controller.spec.ts`**

The existing test for `children()` constructs `TicketController` directly. Since the controller signature now passes `actorAuthUid` through, update the test:

```typescript
import { TicketController } from './ticket.controller';

describe('TicketController.children', () => {
  it('delegates to TicketService.getChildTasks with the given id and actor', async () => {
    const ticketService = {
      getChildTasks: jest.fn().mockResolvedValue([
        { id: 'c1', title: 'Replace pane', ticket_kind: 'work_order' },
      ]),
    } as unknown as import('./ticket.service').TicketService;
    const dispatchService = {} as unknown as import('./dispatch.service').DispatchService;

    const controller = new TicketController(ticketService, dispatchService);
    const request = { user: { id: 'auth-123' } } as unknown as import('express').Request;
    const result = await controller.children(request, 'parent-1');

    expect(ticketService.getChildTasks).toHaveBeenCalledWith('parent-1', 'auth-123');
    expect(result).toEqual([
      { id: 'c1', title: 'Replace pane', ticket_kind: 'work_order' },
    ]);
  });
});
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @prequest/api test`
Expected: every suite green. If `ticket-visibility.service.spec.ts` or `ticket.controller.spec.ts` fails, fix by aligning signatures.

Regressions in `dispatch.service.spec.ts` or `workflow-engine.service.spec.ts` are possible because `DispatchService` and the workflow engine call `this.tickets.getById`/`addActivity`. Search dispatch.service.ts and workflow-engine.service.ts for calls into TicketService:

```bash
grep -n "tickets\.\|ticketService\." apps/api/src/modules/ticket/dispatch.service.ts apps/api/src/modules/workflow/workflow-engine.service.ts
```

Any call to `getById`, `addActivity`, `update`, `reassign`, `getChildTasks` needs a trailing `SYSTEM_ACTOR` argument. Export `SYSTEM_ACTOR` from `ticket.service.ts` if needed:

```typescript
export const SYSTEM_ACTOR = '__system__';
```

And import it in both files.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/ticket/ticket.service.ts \
        apps/api/src/modules/ticket/ticket.controller.ts \
        apps/api/src/modules/ticket/ticket.controller.spec.ts \
        apps/api/src/modules/ticket/dispatch.service.ts \
        apps/api/src/modules/workflow/workflow-engine.service.ts
git commit -m "feat(tickets): enforce visibility on reads + per-ticket writes"
```

(Only add files that were modified; if dispatch/workflow didn't need changes, omit them from `git add`.)

---

## Task 5: `GET /tickets/:id/visibility-trace` debug endpoint

**Files:**
- Modify: `apps/api/src/modules/ticket/ticket.controller.ts`

- [ ] **Step 1: Add the trace method to `TicketVisibilityService`**

Append to `apps/api/src/modules/ticket/ticket-visibility.service.ts`:

```typescript
  /**
   * Explains why a user can (or cannot) see a specific ticket.
   * Used by the /visibility-trace endpoint for support debugging.
   */
  async trace(ticketId: string, ctx: VisibilityContext): Promise<{
    user_id: string;
    ticket_id: string;
    visible: boolean;
    matched_paths: string[];
    readonly_role: boolean;
    has_read_all: boolean;
    has_write_all: boolean;
  }> {
    const paths: string[] = [];
    if (ctx.has_read_all) paths.push('read_all');

    const row = await this.loadTicketRow(ticketId, ctx.tenant_id);
    if (!row) {
      return {
        user_id: ctx.user_id, ticket_id: ticketId,
        visible: ctx.has_read_all, matched_paths: paths, readonly_role: false,
        has_read_all: ctx.has_read_all, has_write_all: ctx.has_write_all,
      };
    }

    if (ctx.person_id && row.requester_person_id === ctx.person_id) paths.push('requester');
    if (row.assigned_user_id === ctx.user_id) paths.push('assignee');
    if (ctx.person_id && (row.watchers ?? []).includes(ctx.person_id)) paths.push('watcher');
    if (ctx.vendor_id && row.assigned_vendor_id === ctx.vendor_id) paths.push('vendor');
    if (row.assigned_team_id && ctx.team_ids.includes(row.assigned_team_id)) paths.push('team');

    let readonlyRole = false;
    let hadRoleMatch = false;
    ctx.role_assignments.forEach((role, idx) => {
      const domainOk =
        role.domain_scope.length === 0 ||
        (row.domain != null && role.domain_scope.includes(row.domain));
      const locationOk =
        role.location_scope_closure.length === 0 ||
        row.location_id == null ||
        role.location_scope_closure.includes(row.location_id);
      if (domainOk && locationOk) {
        hadRoleMatch = true;
        paths.push(`role[${idx}]${role.read_only_cross_domain ? ':readonly' : ''}`);
        if (role.read_only_cross_domain) readonlyRole = true;
      }
    });

    const visible = paths.length > 0 || ctx.has_read_all;
    return {
      user_id: ctx.user_id,
      ticket_id: ticketId,
      visible,
      matched_paths: paths,
      readonly_role: readonlyRole && !hadRoleMatch ? false : readonlyRole,
      has_read_all: ctx.has_read_all,
      has_write_all: ctx.has_write_all,
    };
  }
```

- [ ] **Step 2: Add the controller endpoint**

In `apps/api/src/modules/ticket/ticket.controller.ts`, inject `TicketVisibilityService` into the controller:

```typescript
  constructor(
    private readonly ticketService: TicketService,
    private readonly dispatchService: DispatchService,
    private readonly visibility: TicketVisibilityService,
  ) {}
```

Add the import: `import { TicketVisibilityService } from './ticket-visibility.service';`

Add a new route. Place it near `children()`:

```typescript
  @Get(':id/visibility-trace')
  async visibilityTrace(@Req() request: Request, @Param('id') id: string) {
    const tenant = TenantContext.current();
    const actorAuthUid = (request as { user?: { id: string } }).user?.id;
    if (!actorAuthUid) throw new UnauthorizedException('No auth user');
    const ctx = await this.visibility.loadContext(actorAuthUid, tenant.id);
    if (!ctx.has_read_all) {
      throw new ForbiddenException('visibility-trace requires tickets:read_all');
    }
    return this.visibility.trace(id, ctx);
  }
```

Imports to ensure at the top of the controller file:

```typescript
import { Controller, Get, Post, Patch, Param, Body, Query, Req, UploadedFiles, UseInterceptors, BadRequestException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { TenantContext } from '../../common/tenant-context';
```

(Keep any existing imports; merge the new ones in.)

- [ ] **Step 3: Build**

Run: `pnpm --filter @prequest/api build`
Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/ticket/ticket-visibility.service.ts apps/api/src/modules/ticket/ticket.controller.ts
git commit -m "feat(tickets): visibility-trace debug endpoint for tickets:read_all holders"
```

---

## Task 6: Frontend — friendly 403 state in `ticket-detail.tsx`

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

- [ ] **Step 1: Surface the 403 from the fetch**

Find the existing ticket-fetch block in `ticket-detail.tsx`. The `useApi<Ticket>('/tickets/:id', ...)` hook returns `{ data, loading, error }`. Wherever `error` is handled today (likely a generic "Failed to load" message), extend it to check the HTTP status code.

`apiFetch` in `apps/web/src/lib/api.ts` throws on non-2xx. Inspect it to see if the error exposes the status — typical pattern is `error.message` contains a status string. Add a conditional render near the top of the component's return:

```tsx
  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isForbidden = /403|forbidden/i.test(msg);
    return (
      <div className="p-6 max-w-[480px] mx-auto text-center">
        <h2 className="text-lg font-semibold mb-2">
          {isForbidden ? 'You do not have access to this ticket' : 'Failed to load ticket'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {isForbidden
            ? 'Your role does not include this ticket. Contact an admin if you believe this is a mistake.'
            : msg}
        </p>
      </div>
    );
  }
```

Place this just after the loading check, before the main detail rendering.

- [ ] **Step 2: Build**

Run: `pnpm --filter @prequest/web build`
Expected: clean compile.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx
git commit -m "feat(web): ticket-detail renders a friendly 403 state"
```

---

## Task 7: Living doc `docs/visibility.md` + CLAUDE.md update

**Files:**
- Create: `docs/visibility.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Create `docs/visibility.md`**

Create the file with this content:

```markdown
# Ticket Visibility

This document is the operational reference for **who can see which tickets** in Prequest. Visibility is the fourth axis of the routing model (routing / ownership / execution / **visibility**) and is enforced independently of routing.

## 1. Mental model — three tiers

| Tier | Who it covers | Can write? |
|---|---|---|
| **Participants** | Requester · personal assignee · watcher · dispatched vendor | Yes (subject to the specific write's own semantics) |
| **Operators** | Team member of assigned team · user whose role's `domain_scope` covers the ticket's domain · user whose role's `location_scope` covers the ticket's location (hierarchically) | Team: yes. Role: yes unless `read_only_cross_domain = true`. |
| **Overrides** | `roles.permissions` contains `tickets:read_all` (see everything) or `tickets:write_all` (modify everything) | Yes |

A user can read a ticket if **any** tier matches. Can write if participant or (non-readonly operator) or write-all.

## 2. Core entities

| Table / column | Role |
|---|---|
| `users.id`, `users.person_id`, `users.auth_uid` | Identity; the Supabase auth uid maps to a `users` row per tenant. |
| `team_members(team_id, user_id)` | Team path source. |
| `user_role_assignments(user_id, role_id, domain_scope[], location_scope[], read_only_cross_domain)` | Operator path source; controls domain + location scope and whether it grants write. |
| `roles.permissions jsonb` | Override source. |
| `tickets.requester_person_id`, `assigned_user_id`, `assigned_team_id`, `assigned_vendor_id`, `watchers uuid[]` | Participant + team paths. |
| `request_types.domain` | Role-domain match is against the ticket's request type's domain. |
| `spaces.parent_id` | Hierarchical location closure walk. |

## 3. The SQL predicate

`public.ticket_visibility_ids(p_user_id uuid, p_tenant_id uuid)` returns the set of ticket ids visible to a user. It's the single source of truth for read visibility. API handlers call it via `.in('id', rpc(...))`.

`public.expand_space_closure(p_roots uuid[])` — recursive CTE over `spaces.parent_id`. Used both inside `ticket_visibility_ids` (for role location matches) and by the application (to precompute `role.location_scope_closure` on load).

`public.user_has_permission(p_user_id, p_tenant_id, p_permission)` — checks the `roles.permissions` jsonb for any active role assigned to the user.

## 4. The enforcement helpers (TypeScript)

`TicketVisibilityService` in `apps/api/src/modules/ticket/ticket-visibility.service.ts`:

| Method | Purpose |
|---|---|
| `loadContext(authUid, tenantId)` | Resolves the Supabase auth uid → full `VisibilityContext` (user_id, person_id, teams, roles with expanded location closure, permissions). Call once per request. |
| `getVisibleIds(ctx)` | Returns `string[] | null` — the list of visible ticket ids, or `null` if the user has `tickets:read_all` (meaning: no filter). Called by list/child/tags queries. |
| `assertVisible(ticketId, ctx, mode)` | Loads the ticket and evaluates paths. `mode = 'read'` or `'write'`. Throws `ForbiddenException` on denial. Called by every per-ticket endpoint (detail, PATCH, reassign, dispatch, addActivity, attachments). |
| `trace(ticketId, ctx)` | Explainer for the debug endpoint. |

## 5. Debug recipe

As a user with `tickets:read_all`, call:

```
GET /tickets/:id/visibility-trace
```

Response:
```json
{
  "user_id": "u1",
  "ticket_id": "tk-123",
  "visible": true,
  "matched_paths": ["team", "role[0]"],
  "readonly_role": false,
  "has_read_all": false,
  "has_write_all": false
}
```

## 6. System actors

Internal service-to-service calls (workflow engine, approvals, resolver callbacks) pass the exported `SYSTEM_ACTOR` constant instead of a real auth uid. `TicketService` methods bypass the visibility check in that case. This keeps background jobs working without a user context.

## 7. What's intentionally not solved yet

- **Reporting service.** `reporting.service.ts` queries tenant-wide for dashboard counts. Admin-facing; not yet filtered.
- **Bulk updates.** `PATCH /tickets/bulk/update` doesn't call `assertVisible`. Rare and typically admin — follow-up.
- **Search endpoint.** Not yet built; when added, use `getVisibleIds`.
- **Vendor portal (Phase 4).** The vendor path in `ticket_visibility_ids` is wired but dormant until a vendor-user provisioning flow exists.
- **RLS defense-in-depth.** Possible Phase 2 addition. The tenant-isolation RLS stays; a per-user visibility RLS policy can be added later that calls `ticket_visibility_ids` from a `SECURITY DEFINER` function.
- **Per-activity visibility.** `ticket_activities.visibility` (internal/external/system) is a separate concern and remains unchanged.

## 8. When to update this document

Update this document in the same PR as any change to:

- `apps/api/src/modules/ticket/ticket-visibility.service.ts`
- `apps/api/src/modules/ticket/ticket.service.ts` (read/write methods or their signatures)
- `apps/api/src/modules/ticket/ticket.controller.ts` (routing of `req.user.id` into the service)
- Any migration that alters: `ticket_visibility_ids`, `expand_space_closure`, `user_has_permission`, `users`, `user_role_assignments`, `team_members`, `roles`, or the tickets columns used by the predicate.
- New permission strings on `roles.permissions`.
```

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, after the existing "Assignments, Routing & Fulfillment" block (and before "## Frontend Rules"), insert:

```markdown
## Ticket Visibility

**Full reference:** [`docs/visibility.md`](docs/visibility.md). Read it before changing any read/write path on tickets.

Three-tier model: **Participants** (requester · assignee · watcher · vendor) · **Operators** (team member · role domain + location scope) · **Overrides** (`tickets:read_all` / `tickets:write_all` permissions on `roles.permissions`). Enforced at the API layer via `TicketVisibilityService` (`loadContext` + `getVisibleIds` + `assertVisible`). The canonical SQL predicate is `public.ticket_visibility_ids(user_id, tenant_id)`.

### MANDATORY: keep the reference doc in sync

Same rule as the assignments/routing doc — **touch visibility code or its dependent tables, update `docs/visibility.md` in the same PR.** Trigger files:

- `apps/api/src/modules/ticket/ticket-visibility.service.ts`
- `apps/api/src/modules/ticket/ticket.service.ts` (read/write method signatures or gates)
- `apps/api/src/modules/ticket/ticket.controller.ts` (req.user.id routing)
- Any migration altering `ticket_visibility_ids`, `expand_space_closure`, `user_has_permission`, or the tickets columns they reference (`requester_person_id`, `assigned_user_id`, `assigned_team_id`, `assigned_vendor_id`, `watchers`, `location_id`).
- Any migration changing `users`, `user_role_assignments`, `team_members`, `roles.permissions`, or `spaces.parent_id`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/visibility.md CLAUDE.md
git commit -m "docs: visibility reference + CLAUDE.md pointer and update rule"
```

---

## Task 8: End-to-end sanity pass + remote push gate + merge

**Files:** none (verification only).

- [ ] **Step 1: Full API test suite**

Run: `pnpm --filter @prequest/api test`
Expected: all suites green. New `ticket-visibility.service.spec.ts` passes. Existing suites (dispatch, resolver, workflow, etc.) stay green.

- [ ] **Step 2: API build**

Run: `pnpm --filter @prequest/api build`
Expected: clean.

- [ ] **Step 3: Web build**

Run: `pnpm --filter @prequest/web build`
Expected: clean.

- [ ] **Step 4: Ask user before pushing migrations to remote**

The branch contains two new migrations (`00033_ticket_visibility.sql`, `00034_seed_admin_ticket_permissions.sql`). Ask the user to approve pushing them. Two paths:
- Preferred: `pnpm db:push`.
- Fallback: direct psql with the DB password, following the pattern in CLAUDE.md "Supabase: remote vs local" section.

Do not push without explicit user confirmation.

- [ ] **Step 5: Smoke check after remote push**

Using psql against the remote, confirm the three functions exist:

```sql
select proname from pg_proc where proname in (
  'ticket_visibility_ids', 'expand_space_closure', 'user_has_permission'
);
```

Expected: three rows.

- [ ] **Step 6: Manual smoke test**

With `pnpm dev` running:

1. Log in as a user who is a team member (not admin). Open `/desk/tickets`. Confirm the list is narrowed.
2. Open a ticket you can see (via team). Submit a comment — should succeed.
3. Navigate to `/desk/tickets/<id-you-shouldn't-see>` via URL bar. Confirm 403 state renders.
4. As an admin user (has `tickets:read_all`), call `GET /tickets/:id/visibility-trace` on a ticket. Verify the JSON payload lists matched paths.
5. As a user with only a `read_only_cross_domain` role, open a cross-domain ticket: read works, attempting to change priority returns 403.

- [ ] **Step 7: Report and merge**

Report back with commit list (`git log --oneline main..HEAD`), test counts, and any fixups needed during the sanity pass. If all green, fast-forward merge to main:

```bash
git checkout main
git merge --ff-only feat/visibility-scoping
git branch -d feat/visibility-scoping
```

---

## Self-review notes

**Spec coverage:**
- §3.1 Participants → covered in `assertVisible` + SQL predicate (Task 3, Task 1).
- §3.2 Operators → same.
- §3.3 Overrides → `user_has_permission` + `has_read_all`/`has_write_all` (Task 1, 3).
- §3.4 Read vs write → separated in `assertVisible(mode)` (Task 3).
- §4.6 SQL function as canonical predicate → Task 1.
- §5 Endpoint coverage → Task 4 wires every reader/writer; Task 5 adds the debug trace.
- §6.2 Seed admin permissions → Task 2.
- §6.3 Frontend 403 state → Task 6.
- §7 Living doc + CLAUDE.md rule → Task 7.
- §8 Testing → Task 3 (unit tests) + Task 8 (manual smoke).

**Placeholder scan:** no TBDs. Every step has complete code or an exact command.

**Type consistency:**
- `VisibilityContext` and `RoleAssignmentCtx` defined in Task 3, referenced by Task 5's `trace`.
- `SYSTEM_ACTOR` introduced in Task 4, exported + imported in Task 4 Step 7 for dispatch/workflow.
- `ticket_visibility_ids` / `expand_space_closure` / `user_has_permission` — names consistent across Tasks 1, 3, 5, 7.

**Known flex point:** Task 4 Step 2 gives the general shape of how to thread `actorAuthUid` through methods but doesn't enumerate every internal caller in `ticket.service.ts` (1000+ lines). The engineer must use the grep in Step 3 to find them all. If any internal call lacks the parameter after the edit, TypeScript compilation fails — that's the backstop.
