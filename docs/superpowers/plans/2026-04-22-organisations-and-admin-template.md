# Organisations + Admin-Page Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the org-node tree (with cascading portal-scope grants) and a reusable Linear-style admin-page template, end-to-end including migrations on the remote DB.

**Architecture:** New `org_nodes` self-referential tree per tenant, `person_org_memberships` join table, `org_node_location_grants` table, `teams.org_node_id` FK. Portal scope resolver extended to union `default` + `grant` + `org_grant` (ancestor-walked). Frontend gets new layout primitives (`SettingsPageShell`, `SettingsSection`, etc.) used by three new admin pages and reused as the project's settings-page template going forward.

**Tech Stack:** Postgres (Supabase), NestJS + TypeScript (api), React 19 + Vite + TS + Tailwind v4 + shadcn/ui (web), Jest (api tests). Frontend stays on the existing `useApi` pattern (React Query migration is parked per project memory).

**Spec:** [`docs/superpowers/specs/2026-04-22-organisations-and-admin-template-design.md`](../specs/2026-04-22-organisations-and-admin-template-design.md)

---

## File map

**Database — new migrations (`supabase/migrations/`)**
- `00075_create_org_nodes.sql`
- `00076_create_person_org_memberships.sql`
- `00077_create_org_node_location_grants.sql`
- `00078_teams_add_org_node_id.sql`
- `00079_drop_persons_division_department.sql`
- `00080_portal_authorized_root_matches_org_grants.sql`
- `00081_seed_organisations_permission.sql`

**Backend — new files (`apps/api/src/modules/org-node/`)**
- `org-node.module.ts`
- `org-node.service.ts`
- `org-node.controller.ts`
- `org-node.service.spec.ts`
- `org-node.controller.spec.ts`

**Backend — modified files**
- `apps/api/src/app.module.ts` — register `OrgNodeModule`
- `apps/api/src/modules/person/person.controller.ts` — drop `division`/`department`, accept `primary_org_node_id`
- `apps/api/src/modules/person/person.service.ts` — same; persist via membership upsert
- `apps/api/src/modules/team/team.controller.ts` — accept `org_node_id`
- `apps/api/src/modules/team/team.service.ts` — same
- `apps/api/src/modules/portal/portal.service.spec.ts` (or equivalent) — update fixtures if any reference the old function

**Frontend — new files**
- `apps/web/src/components/ui/settings-page.tsx` — `SettingsPageShell`, `SettingsPageHeader`, `SettingsSection`, `SettingsFooterActions`
- `apps/web/src/components/org-node-combobox.tsx`
- `apps/web/src/components/admin/org-node-tree.tsx`
- `apps/web/src/components/admin/org-node-members-panel.tsx`
- `apps/web/src/components/admin/org-node-grants-panel.tsx`
- `apps/web/src/components/admin/org-node-teams-panel.tsx`
- `apps/web/src/pages/admin/organisations.tsx`
- `apps/web/src/pages/admin/organisation-create.tsx`
- `apps/web/src/pages/admin/organisation-detail.tsx`

**Frontend — modified files**
- `apps/web/src/pages/admin/persons.tsx` — replace `division`/`department` with `OrgNodeCombobox`
- `apps/web/src/pages/admin/teams.tsx` — add `OrgNodeCombobox`
- `apps/web/src/App.tsx` (or wherever admin routes are registered) — three new routes
- `apps/web/src/components/sidebar.tsx` (or admin nav file) — new menu item

**Docs — modified files**
- `docs/portal-scope-slice.md` — note third source `org_grant`
- `CLAUDE.md` — mention `org_nodes` in the data-model overview

---

## Conventions used by every task

- **Migrations:** validate locally with `pnpm db:reset`; smoke-query result; do NOT push until the dedicated push task (Task 9). Keep all 7 migration files staged but unpushed until then.
- **Backend tests:** Jest spec files following the pattern of `apps/api/src/modules/sla/sla-policy.controller.spec.ts`. Pure-function validators get unit tests; service methods get supabase-client-mocked tests where worthwhile.
- **Frontend:** no Vitest setup exists. Verification = render the page in `pnpm dev:web`, exercise the flow, capture any visual regressions inline.
- **Commits:** one per task, message format `feat(orgs): <task summary>` for features, `fix(orgs): ...`, `chore(orgs): ...`, `docs(orgs): ...`.
- **Permissions:** all new endpoints guarded by `organisations:manage` (see Task 8 for seed).

---

## Task 1: Settings-page template primitives

**Why first:** lets every admin page later in the plan compose against a stable layout API, and validates the template against the original screenshots before we use it three times.

**Files:**
- Create: `apps/web/src/components/ui/settings-page.tsx`

- [ ] **Step 1: Create the file with all four primitives**

```tsx
// apps/web/src/components/ui/settings-page.tsx
import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface SettingsPageShellProps {
  children: React.ReactNode;
  className?: string;
}

export function SettingsPageShell({ children, className }: SettingsPageShellProps) {
  return (
    <div className={cn('mx-auto w-full max-w-[640px] px-6 py-10 flex flex-col gap-8', className)}>
      {children}
    </div>
  );
}

interface SettingsPageHeaderProps {
  backTo?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function SettingsPageHeader({ backTo, title, description, actions }: SettingsPageHeaderProps) {
  return (
    <div className="flex flex-col gap-4">
      {backTo && (
        <Link
          to={backTo}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function SettingsSection({ title, description, children, className }: SettingsSectionProps) {
  return (
    <section className={cn('flex flex-col gap-4 border-t pt-6 first:border-t-0 first:pt-0', className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">{title}</h2>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

interface ActionConfig {
  label: string;
  onClick?: () => void;
  href?: string;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost';
}

interface SettingsFooterActionsProps {
  primary: ActionConfig;
  secondary?: ActionConfig;
}

export function SettingsFooterActions({ primary, secondary }: SettingsFooterActionsProps) {
  return (
    <div className="flex items-center justify-end gap-2 pt-2">
      {secondary && (
        secondary.href ? (
          <Button asChild variant={secondary.variant ?? 'ghost'} disabled={secondary.disabled}>
            <Link to={secondary.href}>{secondary.label}</Link>
          </Button>
        ) : (
          <Button
            variant={secondary.variant ?? 'ghost'}
            onClick={secondary.onClick}
            disabled={secondary.disabled}
          >
            {secondary.label}
          </Button>
        )
      )}
      <Button
        variant={primary.variant ?? 'default'}
        onClick={primary.onClick}
        disabled={primary.disabled || primary.loading}
      >
        {primary.loading ? 'Saving…' : primary.label}
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: Sanity check imports**

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter web exec tsc --noEmit 2>&1 | head -40`
Expected: zero errors related to `settings-page.tsx`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ui/settings-page.tsx
git commit -m "feat(orgs): add settings-page template primitives"
```

---

## Task 2: Migration — `org_nodes` table

**Files:**
- Create: `supabase/migrations/00075_create_org_nodes.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00075_create_org_nodes.sql
-- Org-node tree: tenant-scoped, self-referential, requester-side hierarchy.
-- See docs/superpowers/specs/2026-04-22-organisations-and-admin-template-design.md §3.1

create table public.org_nodes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  parent_id uuid references public.org_nodes(id) on delete restrict,
  name text not null,
  code text,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, parent_id, name)
);

create index idx_org_nodes_tenant on public.org_nodes (tenant_id);
create index idx_org_nodes_parent on public.org_nodes (parent_id);

alter table public.org_nodes enable row level security;
create policy "tenant_isolation" on public.org_nodes
  using (tenant_id = public.current_tenant_id());

-- Tenant-match trigger: parent must be in the same tenant.
create or replace function public.enforce_org_node_tenant_match()
returns trigger language plpgsql as $$
declare v_parent_tenant uuid;
begin
  if new.parent_id is not null then
    select tenant_id into v_parent_tenant from public.org_nodes where id = new.parent_id;
    if v_parent_tenant is null then
      raise exception 'org_node parent_id % does not exist', new.parent_id;
    end if;
    if v_parent_tenant <> new.tenant_id then
      raise exception 'org_node tenant mismatch: parent.tenant=%, child.tenant=%',
        v_parent_tenant, new.tenant_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_org_nodes_tenant_match
  before insert or update on public.org_nodes
  for each row execute function public.enforce_org_node_tenant_match();

-- Cycle-prevention trigger: parent_id cannot be self or any descendant.
create or replace function public.enforce_org_node_no_cycle()
returns trigger language plpgsql as $$
declare v_cursor uuid; v_depth int := 0;
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then
    raise exception 'org_node cannot be its own parent';
  end if;
  v_cursor := new.parent_id;
  while v_cursor is not null and v_depth < 50 loop
    if v_cursor = new.id then
      raise exception 'org_node cycle detected via parent chain';
    end if;
    select parent_id into v_cursor from public.org_nodes where id = v_cursor;
    v_depth := v_depth + 1;
  end loop;
  if v_depth >= 50 then
    raise exception 'org_node tree exceeds max depth of 50';
  end if;
  return new;
end;
$$;

create trigger trg_org_nodes_no_cycle
  before insert or update on public.org_nodes
  for each row execute function public.enforce_org_node_no_cycle();

-- updated_at maintenance
create or replace function public.touch_org_node_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_org_nodes_touch_updated_at
  before update on public.org_nodes
  for each row execute function public.touch_org_node_updated_at();
```

- [ ] **Step 2: Validate locally**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:reset 2>&1 | tail -20`
Expected: migration applies cleanly, no errors.

- [ ] **Step 3: Smoke check the schema**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "\d public.org_nodes" 2>&1 | head -30`
Expected: shows the table with expected columns and triggers.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00075_create_org_nodes.sql
git commit -m "feat(orgs): add org_nodes table with cycle + tenant guards"
```

---

## Task 3: Migration — `person_org_memberships` join table

**Files:**
- Create: `supabase/migrations/00076_create_person_org_memberships.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00076_create_person_org_memberships.sql
-- Person ↔ org-node join table. UI v1 surfaces a single primary membership
-- per person; the schema is ready for multi-membership without migration.
-- See spec §3.2

create table public.person_org_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  person_id uuid not null references public.persons(id) on delete cascade,
  org_node_id uuid not null references public.org_nodes(id) on delete cascade,
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  unique (person_id, org_node_id)
);

create index idx_pom_person on public.person_org_memberships (person_id);
create index idx_pom_node   on public.person_org_memberships (org_node_id);
create index idx_pom_tenant on public.person_org_memberships (tenant_id);

create unique index idx_pom_one_primary_per_person
  on public.person_org_memberships (person_id)
  where is_primary;

alter table public.person_org_memberships enable row level security;
create policy "tenant_isolation" on public.person_org_memberships
  using (tenant_id = public.current_tenant_id());

create or replace function public.enforce_person_org_membership_tenant()
returns trigger language plpgsql as $$
declare v_person_tenant uuid; v_node_tenant uuid;
begin
  select tenant_id into v_person_tenant from public.persons where id = new.person_id;
  if v_person_tenant is null then
    raise exception 'membership person_id % does not exist', new.person_id;
  end if;
  if v_person_tenant <> new.tenant_id then
    raise exception 'membership tenant mismatch: person.tenant=%, membership.tenant=%',
      v_person_tenant, new.tenant_id;
  end if;

  select tenant_id into v_node_tenant from public.org_nodes where id = new.org_node_id;
  if v_node_tenant is null then
    raise exception 'membership org_node_id % does not exist', new.org_node_id;
  end if;
  if v_node_tenant <> new.tenant_id then
    raise exception 'membership tenant mismatch: node.tenant=%, membership.tenant=%',
      v_node_tenant, new.tenant_id;
  end if;
  return new;
end;
$$;

create trigger trg_pom_tenant_match
  before insert or update on public.person_org_memberships
  for each row execute function public.enforce_person_org_membership_tenant();
```

- [ ] **Step 2: Validate locally**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:reset 2>&1 | tail -10`
Expected: clean apply.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00076_create_person_org_memberships.sql
git commit -m "feat(orgs): add person_org_memberships join table"
```

---

## Task 4: Migration — `org_node_location_grants`

**Files:**
- Create: `supabase/migrations/00077_create_org_node_location_grants.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00077_create_org_node_location_grants.sql
-- Location grants attached to an org node. Cascades to all descendants
-- of the node when the portal resolver walks ancestors. See spec §3.3.

create table public.org_node_location_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  org_node_id uuid not null references public.org_nodes(id) on delete cascade,
  space_id uuid not null references public.spaces(id),
  granted_by_user_id uuid references public.users(id),
  granted_at timestamptz not null default now(),
  note text,
  unique (org_node_id, space_id)
);

create index idx_ongl_node   on public.org_node_location_grants (org_node_id);
create index idx_ongl_space  on public.org_node_location_grants (space_id);
create index idx_ongl_tenant on public.org_node_location_grants (tenant_id);

alter table public.org_node_location_grants enable row level security;
create policy "tenant_isolation" on public.org_node_location_grants
  using (tenant_id = public.current_tenant_id());

create or replace function public.enforce_org_node_location_grant_integrity()
returns trigger language plpgsql as $$
declare v_space_type text; v_space_tenant uuid; v_node_tenant uuid; v_granter_tenant uuid;
begin
  select type, tenant_id into v_space_type, v_space_tenant
  from public.spaces where id = new.space_id;
  if v_space_type is null then
    raise exception 'org-node grant space_id % does not exist', new.space_id;
  end if;
  if v_space_type not in ('site','building') then
    raise exception 'org-node grant target must be site or building (got %)', v_space_type;
  end if;
  if v_space_tenant <> new.tenant_id then
    raise exception 'org-node grant tenant mismatch: space.tenant=%, grant.tenant=%',
      v_space_tenant, new.tenant_id;
  end if;

  select tenant_id into v_node_tenant from public.org_nodes where id = new.org_node_id;
  if v_node_tenant is null then
    raise exception 'org-node grant org_node_id % does not exist', new.org_node_id;
  end if;
  if v_node_tenant <> new.tenant_id then
    raise exception 'org-node grant tenant mismatch: node.tenant=%, grant.tenant=%',
      v_node_tenant, new.tenant_id;
  end if;

  if new.granted_by_user_id is not null then
    select tenant_id into v_granter_tenant from public.users where id = new.granted_by_user_id;
    if v_granter_tenant is null then
      raise exception 'org-node grant granted_by_user_id % does not exist', new.granted_by_user_id;
    end if;
    if v_granter_tenant <> new.tenant_id then
      raise exception 'org-node grant tenant mismatch: granter.tenant=%, grant.tenant=%',
        v_granter_tenant, new.tenant_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_ongl_integrity
  before insert or update on public.org_node_location_grants
  for each row execute function public.enforce_org_node_location_grant_integrity();
```

- [ ] **Step 2: Validate locally**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:reset 2>&1 | tail -10`
Expected: clean apply.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00077_create_org_node_location_grants.sql
git commit -m "feat(orgs): add org_node_location_grants with integrity guard"
```

---

## Task 5: Migration — `teams.org_node_id`

**Files:**
- Create: `supabase/migrations/00078_teams_add_org_node_id.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00078_teams_add_org_node_id.sql
-- Teams may optionally be attached to an org node for categorization.
-- Does NOT cause team members to inherit the node's location grants.
-- See spec §3.4.

alter table public.teams
  add column org_node_id uuid references public.org_nodes(id) on delete set null;

create index idx_teams_org_node on public.teams (org_node_id);
```

- [ ] **Step 2: Validate locally**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:reset 2>&1 | tail -5`
Expected: clean apply.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00078_teams_add_org_node_id.sql
git commit -m "feat(orgs): add teams.org_node_id nullable FK"
```

---

## Task 6: Migration — drop free-text `division`/`department`

**Files:**
- Create: `supabase/migrations/00079_drop_persons_division_department.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00079_drop_persons_division_department.sql
-- Source of truth for a person's department is now person_org_memberships.
-- Test data only — no backfill (per spec §3.5).

alter table public.persons drop column if exists division;
alter table public.persons drop column if exists department;
```

- [ ] **Step 2: Validate locally**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:reset 2>&1 | tail -5`
Expected: clean apply.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00079_drop_persons_division_department.sql
git commit -m "feat(orgs): drop persons.division and persons.department free-text"
```

---

## Task 7: Migration — portal scope resolver update

**Files:**
- Create: `supabase/migrations/00080_portal_authorized_root_matches_org_grants.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00080_portal_authorized_root_matches_org_grants.sql
-- Portal scope: union default + person grants + org-node grants (ancestor-walked).
-- Tie-break in match_authorized_root extended: default > grant > org_grant.
-- See spec §4.

create or replace function public.org_node_ancestors(p_node_id uuid)
returns setof uuid language sql stable as $$
  with recursive walk(id, depth) as (
    select p_node_id, 0
    union all
    select n.parent_id, w.depth + 1
    from public.org_nodes n
    join walk w on n.id = w.id
    where n.parent_id is not null and w.depth < 20
  )
  select id from walk where id is not null;
$$;

create or replace function public.portal_authorized_root_matches(
  p_person_id uuid,
  p_tenant_id uuid
) returns table (root_id uuid, source text, grant_id uuid) language sql stable as $$
  select p.default_location_id, 'default'::text, null::uuid
  from public.persons p
  join public.spaces s on s.id = p.default_location_id
  where p.id = p_person_id and p.tenant_id = p_tenant_id
    and s.active = true

  union all

  select g.space_id, 'grant'::text, g.id
  from public.person_location_grants g
  join public.spaces s on s.id = g.space_id
  where g.person_id = p_person_id and g.tenant_id = p_tenant_id
    and s.active = true

  union all

  select ongl.space_id, 'org_grant'::text, ongl.id
  from public.person_org_memberships pom
  cross join lateral public.org_node_ancestors(pom.org_node_id) as a(node_id)
  join public.org_node_location_grants ongl on ongl.org_node_id = a.node_id
  join public.spaces s on s.id = ongl.space_id
  where pom.person_id = p_person_id
    and pom.tenant_id = p_tenant_id
    and ongl.tenant_id = p_tenant_id
    and s.active = true;
$$;

-- Replace match_authorized_root tie-break: default > grant > org_grant.
create or replace function public.portal_match_authorized_root(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_tenant_id uuid
) returns table (root_id uuid, source text, grant_id uuid) language plpgsql stable as $$
declare
  r record;
  best_root uuid; best_source text; best_grant uuid; best_distance int := null;
  v_selected_active boolean;
  v_distance int;
  -- lower number = higher precedence
  v_r_priority int; v_best_priority int;
begin
  if p_effective_space_id is null then return; end if;

  select active into v_selected_active
  from public.spaces where id = p_effective_space_id and tenant_id = p_tenant_id;
  if v_selected_active is null or v_selected_active = false then return; end if;

  for r in
    select * from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
  loop
    with recursive chain(id, depth) as (
      select p_effective_space_id, 0
      union all
      select s.parent_id, c.depth + 1
      from public.spaces s
      join chain c on s.id = c.id
      where c.depth < 12 and s.parent_id is not null and s.tenant_id = p_tenant_id
    )
    select depth into v_distance from chain where id = r.root_id;

    if v_distance is not null then
      v_r_priority := case r.source
        when 'default'   then 1
        when 'grant'     then 2
        when 'org_grant' then 3
        else 9
      end;
      v_best_priority := case best_source
        when 'default'   then 1
        when 'grant'     then 2
        when 'org_grant' then 3
        else 9
      end;

      if best_distance is null
         or v_distance < best_distance
         or (v_distance = best_distance and v_r_priority < v_best_priority) then
        best_root := r.root_id;
        best_source := r.source;
        best_grant := r.grant_id;
        best_distance := v_distance;
      end if;
    end if;
  end loop;

  if best_root is not null then
    root_id := best_root; source := best_source; grant_id := best_grant;
    return next;
  end if;
end;
$$;
```

- [ ] **Step 2: Validate locally**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:reset 2>&1 | tail -10`
Expected: clean apply.

- [ ] **Step 3: Smoke-test the function with a fresh fixture**

Run:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" <<'SQL'
-- Smoke: function compiles and returns rows shape.
select * from public.portal_authorized_root_matches(
  '00000000-0000-0000-0000-000000000000'::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid
);
select * from public.org_node_ancestors('00000000-0000-0000-0000-000000000000'::uuid);
SQL
```
Expected: zero rows from each (UUIDs don't match anything), no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00080_portal_authorized_root_matches_org_grants.sql
git commit -m "feat(orgs): extend portal resolver with org_grant source + ancestor walk"
```

---

## Task 8: Migration — seed `organisations:manage` permission

**Files:**
- Create: `supabase/migrations/00081_seed_organisations_permission.sql`

- [ ] **Step 1: Inspect how existing permissions are stored**

Run: `cd /Users/x/Desktop/XPQT && grep -r "people:manage" supabase/migrations | head -10`
Expected: shows where `people:manage` is seeded so the new permission follows the same shape.

If permissions live as text in `roles.permissions jsonb`, the seed appends a string to existing admin role rows. If there is a `permissions` lookup table, the seed inserts there first.

- [ ] **Step 2: Write the migration following the discovered pattern**

Adjust the SQL below to match the project's permission storage. Common case: `roles.permissions` is `jsonb`/`text[]`, granted on tenant-admin-style roles by name pattern.

```sql
-- 00081_seed_organisations_permission.sql
-- Adds organisations:manage to any role that already carries people:manage.
-- See spec §7.

update public.roles
set permissions = (
  case
    when permissions ? 'organisations:manage' then permissions
    else permissions || jsonb_build_array('organisations:manage')
  end
)
where permissions ? 'people:manage';

-- Reload PostgREST schema cache so new permission is picked up.
notify pgrst, 'reload schema';
```

If `permissions` is a `text[]` instead, replace the body with:

```sql
update public.roles
set permissions = array(
  select distinct unnest(permissions || array['organisations:manage'])
)
where 'people:manage' = any(permissions);
```

- [ ] **Step 3: Validate locally**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:reset 2>&1 | tail -5`
Expected: clean apply. Then:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
  "select name, permissions from public.roles where permissions::text like '%organisations:manage%';"
```
Expected: at least one role row containing `organisations:manage`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00081_seed_organisations_permission.sql
git commit -m "feat(orgs): seed organisations:manage on existing admin roles"
```

---

## Task 9: Push all org migrations to the remote DB

**Files:** none (operational task).

**Why now and not later:** the dev app talks to the remote DB. Backend code in Tasks 10–15 cannot run end-to-end until these migrations are on remote. Per project memory, the user has granted standing permission to push migrations during this workstream. Per CLAUDE.md, prefer `pnpm db:push`; fall back to psql if the CLI auth fails.

- [ ] **Step 1: Attempt the standard push**

Run: `cd /Users/x/Desktop/XPQT && pnpm db:push 2>&1 | tail -30`

If it succeeds, skip to Step 4. If it fails with auth/permission errors (likely), continue to Step 2.

- [ ] **Step 2: psql fallback — apply each migration in order**

Ask the user for the remote DB password if not already in your environment. Then for each new file in order (00075 → 00081):

```bash
PGPASSWORD='<password>' psql \
  "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/migrations/00075_create_org_nodes.sql
# ... repeat for 00076, 00077, 00078, 00079, 00080, 00081
```

- [ ] **Step 3: Reload PostgREST schema cache on remote**

```bash
PGPASSWORD='<password>' psql \
  "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -c "notify pgrst, 'reload schema';"
```

- [ ] **Step 4: Smoke-verify against remote**

```bash
PGPASSWORD='<password>' psql \
  "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -c "\d public.org_nodes" | head -10
```
Expected: table exists with columns matching the migration.

```bash
PGPASSWORD='<password>' psql \
  "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -c "select proname from pg_proc where proname = 'org_node_ancestors';"
```
Expected: one row.

- [ ] **Step 5: No commit (no file changes). Note status in plan run log.**

---

## Task 10: Backend module skeleton — `OrgNodeModule`

**Files:**
- Create: `apps/api/src/modules/org-node/org-node.module.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Create the module file**

```ts
// apps/api/src/modules/org-node/org-node.module.ts
import { Module } from '@nestjs/common';
import { OrgNodeService } from './org-node.service';
import { OrgNodeController } from './org-node.controller';
import { PermissionGuard } from '../../common/permission-guard';

@Module({
  providers: [OrgNodeService, PermissionGuard],
  controllers: [OrgNodeController],
  exports: [OrgNodeService],
})
export class OrgNodeModule {}
```

- [ ] **Step 2: Register in `AppModule`**

Read `apps/api/src/app.module.ts`, add `OrgNodeModule` to the `imports` array following the existing pattern. Show the diff in the commit. Example:

```ts
import { OrgNodeModule } from './modules/org-node/org-node.module';

@Module({
  imports: [
    // ... existing modules
    OrgNodeModule,
  ],
  // ...
})
export class AppModule {}
```

(The service + controller files are created in Task 11; the module references them now and will resolve once those land in the same atomic feature branch. If the engineer prefers a green build at every step, scaffold empty placeholders in this commit and replace them in Task 11.)

- [ ] **Step 3: Commit (with the placeholder scaffolds)**

Create empty placeholder files so the build stays green:

```ts
// apps/api/src/modules/org-node/org-node.service.ts
import { Injectable } from '@nestjs/common';
@Injectable()
export class OrgNodeService {}
```

```ts
// apps/api/src/modules/org-node/org-node.controller.ts
import { Controller } from '@nestjs/common';
@Controller('org-nodes')
export class OrgNodeController {}
```

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter api exec tsc --noEmit 2>&1 | tail -10`
Expected: zero errors.

```bash
git add apps/api/src/modules/org-node/ apps/api/src/app.module.ts
git commit -m "feat(orgs): scaffold OrgNodeModule and register in AppModule"
```

---

## Task 11: Backend service + controller — node CRUD

**Files:**
- Modify (replace placeholder): `apps/api/src/modules/org-node/org-node.service.ts`
- Modify (replace placeholder): `apps/api/src/modules/org-node/org-node.controller.ts`
- Create: `apps/api/src/modules/org-node/org-node.service.spec.ts`

- [ ] **Step 1: Write the service**

```ts
// apps/api/src/modules/org-node/org-node.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface OrgNodeRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  code: string | null;
  description: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrgNodeListItem extends OrgNodeRow {
  member_count: number;
  location_grant_count: number;
  team_count: number;
}

export interface CreateOrgNodeDto {
  name: string;
  parent_id?: string | null;
  code?: string | null;
  description?: string | null;
}

export interface UpdateOrgNodeDto {
  name?: string;
  parent_id?: string | null;
  code?: string | null;
  description?: string | null;
  active?: boolean;
}

@Injectable()
export class OrgNodeService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(): Promise<OrgNodeListItem[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_nodes')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;

    // Aggregate counts in one round-trip each — simple and adequate at expected scale.
    const ids = (data ?? []).map((r) => r.id);
    if (ids.length === 0) return [];

    const [members, grants, teams] = await Promise.all([
      this.supabase.admin
        .from('person_org_memberships')
        .select('org_node_id', { count: 'exact', head: false })
        .in('org_node_id', ids),
      this.supabase.admin
        .from('org_node_location_grants')
        .select('org_node_id')
        .in('org_node_id', ids),
      this.supabase.admin
        .from('teams')
        .select('org_node_id')
        .in('org_node_id', ids),
    ]);
    if (members.error) throw members.error;
    if (grants.error) throw grants.error;
    if (teams.error) throw teams.error;

    const tally = (rows: { org_node_id: string }[] | null) => {
      const m = new Map<string, number>();
      for (const r of rows ?? []) m.set(r.org_node_id, (m.get(r.org_node_id) ?? 0) + 1);
      return m;
    };
    const memberMap = tally(members.data as any);
    const grantMap = tally(grants.data as any);
    const teamMap = tally(teams.data as any);

    return (data as OrgNodeRow[]).map((r) => ({
      ...r,
      member_count: memberMap.get(r.id) ?? 0,
      location_grant_count: grantMap.get(r.id) ?? 0,
      team_count: teamMap.get(r.id) ?? 0,
    }));
  }

  async getById(id: string): Promise<OrgNodeRow> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_nodes')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundException(`org_node ${id} not found`);
    return data;
  }

  async create(dto: CreateOrgNodeDto): Promise<OrgNodeRow> {
    if (!dto.name?.trim()) throw new BadRequestException('name is required');
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_nodes')
      .insert({
        tenant_id: tenant.id,
        name: dto.name.trim(),
        parent_id: dto.parent_id ?? null,
        code: dto.code ?? null,
        description: dto.description ?? null,
      })
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async update(id: string, dto: UpdateOrgNodeDto): Promise<OrgNodeRow> {
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.parent_id !== undefined) patch.parent_id = dto.parent_id;
    if (dto.code !== undefined) patch.code = dto.code;
    if (dto.description !== undefined) patch.description = dto.description;
    if (dto.active !== undefined) patch.active = dto.active;
    if (Object.keys(patch).length === 0) {
      return this.getById(id);
    }
    const { data, error } = await this.supabase.admin
      .from('org_nodes')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async remove(id: string): Promise<{ ok: true }> {
    const tenant = TenantContext.current();
    // Cascade handles memberships + grants. parent_id RESTRICT blocks deletion if children exist.
    const { error } = await this.supabase.admin
      .from('org_nodes')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw new BadRequestException(error.message);
    return { ok: true };
  }

  // ── Memberships ────────────────────────────────────────────────────────
  async listMembers(nodeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('person_org_memberships')
      .select('id, person_id, is_primary, created_at, person:persons(id, first_name, last_name, email)')
      .eq('org_node_id', nodeId)
      .eq('tenant_id', tenant.id)
      .order('created_at');
    if (error) throw error;
    return data;
  }

  async addMember(nodeId: string, personId: string, isPrimary = true) {
    const tenant = TenantContext.current();

    if (isPrimary) {
      // Demote any existing primary for this person.
      const { error: demoteErr } = await this.supabase.admin
        .from('person_org_memberships')
        .update({ is_primary: false })
        .eq('person_id', personId)
        .eq('tenant_id', tenant.id)
        .eq('is_primary', true);
      if (demoteErr) throw demoteErr;
    }

    const { data, error } = await this.supabase.admin
      .from('person_org_memberships')
      .upsert({
        tenant_id: tenant.id,
        person_id: personId,
        org_node_id: nodeId,
        is_primary: isPrimary,
      }, { onConflict: 'person_id,org_node_id' })
      .select('*')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async removeMember(nodeId: string, personId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('person_org_memberships')
      .delete()
      .eq('org_node_id', nodeId)
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { ok: true };
  }

  // ── Location grants ────────────────────────────────────────────────────
  async listGrants(nodeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_node_location_grants')
      .select('id, space_id, granted_by_user_id, granted_at, note, space:spaces(id, name, type)')
      .eq('org_node_id', nodeId)
      .eq('tenant_id', tenant.id)
      .order('granted_at');
    if (error) throw error;
    return data;
  }

  async addGrant(nodeId: string, spaceId: string, note: string | undefined, grantedByUserId?: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('org_node_location_grants')
      .insert({
        tenant_id: tenant.id,
        org_node_id: nodeId,
        space_id: spaceId,
        note: note ?? null,
        granted_by_user_id: grantedByUserId ?? null,
      })
      .select('id, space_id, granted_by_user_id, granted_at, note')
      .single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async removeGrant(nodeId: string, grantId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('org_node_location_grants')
      .delete()
      .eq('id', grantId)
      .eq('org_node_id', nodeId)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { ok: true };
  }

  // ── Teams attached ─────────────────────────────────────────────────────
  async listAttachedTeams(nodeId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('teams')
      .select('id, name, description')
      .eq('org_node_id', nodeId)
      .eq('tenant_id', tenant.id)
      .order('name');
    if (error) throw error;
    return data;
  }
}
```

- [ ] **Step 2: Write the controller**

```ts
// apps/api/src/modules/org-node/org-node.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { OrgNodeService } from './org-node.service';
import { PermissionGuard } from '../../common/permission-guard';

const PERMISSION = 'organisations:manage';

@Controller('org-nodes')
export class OrgNodeController {
  constructor(
    private readonly service: OrgNodeService,
    private readonly permissions: PermissionGuard,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.list();
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, PERMISSION);
    const [node, members, grants, teams] = await Promise.all([
      this.service.getById(id),
      this.service.listMembers(id),
      this.service.listGrants(id),
      this.service.listAttachedTeams(id),
    ]);
    return { ...node, members, location_grants: grants, teams };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: { name: string; parent_id?: string | null; code?: string | null; description?: string | null },
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.create(dto);
  }

  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: { name?: string; parent_id?: string | null; code?: string | null; description?: string | null; active?: boolean },
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.update(id, dto);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.remove(id);
  }

  // ── Members ──────────────────────────────────────────────────────────
  @Get(':id/members')
  async listMembers(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.listMembers(id);
  }

  @Post(':id/members')
  async addMember(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: { person_id: string; is_primary?: boolean },
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.addMember(id, dto.person_id, dto.is_primary ?? true);
  }

  @Delete(':id/members/:personId')
  async removeMember(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('personId') personId: string,
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.removeMember(id, personId);
  }

  // ── Location grants ──────────────────────────────────────────────────
  @Get(':id/location-grants')
  async listGrants(@Req() req: Request, @Param('id') id: string) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.listGrants(id);
  }

  @Post(':id/location-grants')
  async addGrant(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: { space_id: string; note?: string },
  ) {
    const { userId } = await this.permissions.requirePermission(req, PERMISSION);
    return this.service.addGrant(id, dto.space_id, dto.note, userId);
  }

  @Delete(':id/location-grants/:grantId')
  async removeGrant(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('grantId') grantId: string,
  ) {
    await this.permissions.requirePermission(req, PERMISSION);
    return this.service.removeGrant(id, grantId);
  }
}
```

- [ ] **Step 3: Write a focused service spec**

The existing test pattern (see `apps/api/src/modules/sla/sla-policy.controller.spec.ts`) is direct unit tests on pure validators. The org-node service is supabase-heavy; write a thin spec that exercises the *demote-then-upsert* logic in `addMember` with a mocked supabase client.

```ts
// apps/api/src/modules/org-node/org-node.service.spec.ts
import { OrgNodeService } from './org-node.service';

function tenantStub() {
  // TenantContext.current() reads from AsyncLocalStorage. For unit purposes
  // we simulate by stubbing the static method on the imported module.
  return { id: 'tenant-1' };
}

jest.mock('../../common/tenant-context', () => ({
  TenantContext: { current: () => ({ id: 'tenant-1' }) },
}));

describe('OrgNodeService.addMember', () => {
  it('demotes any existing primary for the person before upserting the new primary', async () => {
    const calls: string[] = [];

    const fakeSupabase: any = {
      admin: {
        from: (table: string) => {
          calls.push(`from:${table}`);
          return {
            update: (patch: any) => {
              calls.push(`update:${JSON.stringify(patch)}`);
              return {
                eq: () => ({
                  eq: () => ({
                    eq: () => Promise.resolve({ error: null }),
                  }),
                }),
              };
            },
            upsert: (row: any) => {
              calls.push(`upsert:is_primary=${row.is_primary}`);
              return {
                select: () => ({
                  single: () => Promise.resolve({
                    data: { ...row, id: 'mem-1' },
                    error: null,
                  }),
                }),
              };
            },
          };
        },
      },
    };

    const service = new OrgNodeService(fakeSupabase);
    const result = await service.addMember('node-1', 'person-1', true);

    expect(calls).toEqual([
      'from:person_org_memberships',
      'update:{"is_primary":false}',
      'from:person_org_memberships',
      'upsert:is_primary=true',
    ]);
    expect(result).toMatchObject({ id: 'mem-1', is_primary: true });
  });
});
```

- [ ] **Step 4: Run the spec**

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter api exec jest org-node.service.spec --no-coverage 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 5: Type-check the api package**

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter api exec tsc --noEmit 2>&1 | tail -15`
Expected: zero errors in `org-node/*`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/org-node/
git commit -m "feat(orgs): implement OrgNode service+controller with demote-then-upsert primary"
```

---

## Task 12: Backend — persons API switches to `primary_org_node_id`

**Files:**
- Modify: `apps/api/src/modules/person/person.controller.ts`
- Modify: `apps/api/src/modules/person/person.service.ts`

- [ ] **Step 1: Update the controller DTO**

Open `apps/api/src/modules/person/person.controller.ts`. Drop `division` and `department` from the `create` body type. Keep `cost_center` and `manager_person_id`. Add `primary_org_node_id?: string | null`.

```ts
@Post()
async create(@Req() request: Request, @Body() dto: {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  type: string;
  cost_center?: string;
  manager_person_id?: string;
  primary_org_node_id?: string | null;
}) {
  await this.permissions.requirePermission(request, 'people:manage');
  return this.personService.create(dto);
}
```

The `update` controller already accepts `Record<string, unknown>` — no change needed.

- [ ] **Step 2: Update the service**

Replace the `create` method and append a private membership-upsert helper:

```ts
async create(dto: {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  type: string;
  cost_center?: string;
  manager_person_id?: string;
  primary_org_node_id?: string | null;
}) {
  const tenant = TenantContext.current();
  const { primary_org_node_id, ...personFields } = dto;

  const { data, error } = await this.supabase.admin
    .from('persons')
    .insert({ ...personFields, tenant_id: tenant.id })
    .select()
    .single();
  if (error) throw error;

  if (primary_org_node_id) {
    await this.upsertPrimaryMembership(data.id, primary_org_node_id);
  }
  return data;
}

async update(id: string, dto: Record<string, unknown>) {
  const tenant = TenantContext.current();
  const { primary_org_node_id, ...rest } = dto as Record<string, unknown> & { primary_org_node_id?: string | null };

  const { data, error } = await this.supabase.admin
    .from('persons')
    .update(rest)
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .select()
    .single();
  if (error) throw error;

  if (primary_org_node_id !== undefined) {
    if (primary_org_node_id === null) {
      await this.clearPrimaryMembership(id);
    } else {
      await this.upsertPrimaryMembership(id, primary_org_node_id);
    }
  }
  return data;
}

private async upsertPrimaryMembership(personId: string, orgNodeId: string) {
  const tenant = TenantContext.current();
  // Demote any existing primary for this person.
  const { error: demoteErr } = await this.supabase.admin
    .from('person_org_memberships')
    .update({ is_primary: false })
    .eq('person_id', personId)
    .eq('tenant_id', tenant.id)
    .eq('is_primary', true);
  if (demoteErr) throw demoteErr;

  const { error } = await this.supabase.admin
    .from('person_org_memberships')
    .upsert({
      tenant_id: tenant.id,
      person_id: personId,
      org_node_id: orgNodeId,
      is_primary: true,
    }, { onConflict: 'person_id,org_node_id' });
  if (error) throw error;
}

private async clearPrimaryMembership(personId: string) {
  const tenant = TenantContext.current();
  const { error } = await this.supabase.admin
    .from('person_org_memberships')
    .delete()
    .eq('person_id', personId)
    .eq('tenant_id', tenant.id)
    .eq('is_primary', true);
  if (error) throw error;
}
```

- [ ] **Step 3: Drop `department` from the existing `select` lists**

In `apps/api/src/modules/person/person.service.ts`, the `search()` and `list()` methods currently `.select('id, first_name, last_name, email, department, type')`. Remove `department` from both.

After: `.select('id, first_name, last_name, email, type')`.

Replace with the addition of the primary-membership join so consumers can still display the org context:

```ts
.select(`
  id, first_name, last_name, email, type,
  primary_membership:person_org_memberships!inner(
    org_node_id,
    org_node:org_nodes(id, name, code)
  )
`)
```

…with `primary_membership` filtered via `.eq('person_org_memberships.is_primary', true)`. Concretely:

```ts
async list() {
  const tenant = TenantContext.current();
  const { data, error } = await this.supabase.admin
    .from('persons')
    .select(`
      id, first_name, last_name, email, type,
      primary_membership:person_org_memberships(
        org_node_id, is_primary,
        org_node:org_nodes(id, name, code)
      )
    `)
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .eq('person_org_memberships.is_primary', true)
    .order('first_name')
    .limit(100);
  if (error) throw error;
  return data;
}
```

Apply the same shape to `search()` and `listByType()`.

- [ ] **Step 4: Type-check**

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter api exec tsc --noEmit 2>&1 | tail -20`
Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/person/
git commit -m "feat(orgs): persons API uses primary_org_node_id and joins primary membership"
```

---

## Task 13: Backend — teams API accepts `org_node_id`

**Files:**
- Modify: `apps/api/src/modules/team/team.controller.ts`
- Modify: `apps/api/src/modules/team/team.service.ts`

- [ ] **Step 1: Find the existing create/update DTOs**

Run: `grep -n "Body" /Users/x/Desktop/XPQT/apps/api/src/modules/team/team.controller.ts | head -10`
Identify the create + update endpoints.

- [ ] **Step 2: Add `org_node_id` to both DTOs**

In both create and update bodies, add `org_node_id?: string | null;`. Pass through to the service unchanged.

- [ ] **Step 3: Update the service to persist the column**

In the team service `create` and `update` methods, include `org_node_id` in the insert/update payload. (Most existing services pass `dto` whole — if so, no per-field change is needed once the type allows it.)

- [ ] **Step 4: Update list/get selects to include and join the node**

Wherever the team service `select`s for read, add `, org_node_id, org_node:org_nodes(id, name, code)` so the frontend can render the badge.

- [ ] **Step 5: Type-check**

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter api exec tsc --noEmit 2>&1 | tail -10`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/team/
git commit -m "feat(orgs): teams API accepts org_node_id and joins org node on read"
```

---

## Task 14: Frontend — `OrgNodeCombobox`

**Files:**
- Create: `apps/web/src/components/org-node-combobox.tsx`

- [ ] **Step 1: Inspect a sibling combobox for the established pattern**

Run: `cat /Users/x/Desktop/XPQT/apps/web/src/components/location-combobox.tsx | head -80`

- [ ] **Step 2: Implement following the same pattern**

```tsx
// apps/web/src/components/org-node-combobox.tsx
import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Building2 } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface OrgNode {
  id: string;
  name: string;
  code: string | null;
  parent_id: string | null;
}

interface Props {
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Allow clearing to "no organisation" (default true). */
  allowClear?: boolean;
  /** Restrict selection to nodes whose ids match this filter. */
  filter?: (node: OrgNode) => boolean;
}

function buildPath(node: OrgNode, byId: Map<string, OrgNode>): string {
  const segments: string[] = [];
  let cursor: OrgNode | undefined = node;
  let safety = 0;
  while (cursor && safety < 50) {
    segments.unshift(cursor.name);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
    safety += 1;
  }
  return segments.join(' › ');
}

export function OrgNodeCombobox({
  value,
  onChange,
  placeholder = 'Select organisation…',
  disabled,
  allowClear = true,
  filter,
}: Props) {
  const [open, setOpen] = useState(false);
  const { data, loading } = useApi<OrgNode[]>('/org-nodes');

  const byId = useMemo(() => {
    const m = new Map<string, OrgNode>();
    for (const n of data ?? []) m.set(n.id, n);
    return m;
  }, [data]);

  const items = useMemo(() => {
    const list = (data ?? []).filter((n) => (filter ? filter(n) : true));
    return list
      .map((n) => ({ id: n.id, label: buildPath(n, byId) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [data, byId, filter]);

  const selectedLabel = value ? items.find((i) => i.id === value)?.label : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || loading}
          className="justify-between font-normal"
        >
          <span className="flex items-center gap-2 truncate">
            <Building2 className="size-4 text-muted-foreground" />
            {selectedLabel ?? placeholder}
          </span>
          <ChevronsUpDown className="ml-2 size-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0" align="start">
        <Command>
          <CommandInput placeholder="Search organisations…" />
          <CommandList>
            <CommandEmpty>No organisations found.</CommandEmpty>
            <CommandGroup>
              {allowClear && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 size-4', value == null ? 'opacity-100' : 'opacity-0')} />
                  None
                </CommandItem>
              )}
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={item.label}
                  onSelect={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('mr-2 size-4', value === item.id ? 'opacity-100' : 'opacity-0')} />
                  {item.label}
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

- [ ] **Step 3: Type-check**

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter web exec tsc --noEmit 2>&1 | tail -15`
Expected: zero errors related to this file.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/org-node-combobox.tsx
git commit -m "feat(orgs): add OrgNodeCombobox with path display"
```

---

## Task 15: Frontend — Organisations list page

**Files:**
- Create: `apps/web/src/components/admin/org-node-tree.tsx`
- Create: `apps/web/src/pages/admin/organisations.tsx`

- [ ] **Step 1: Tree row component**

```tsx
// apps/web/src/components/admin/org-node-tree.tsx
import { ChevronRight, Building2, Users, MapPin, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface OrgNodeListItem {
  id: string;
  name: string;
  code: string | null;
  parent_id: string | null;
  member_count: number;
  location_grant_count: number;
  team_count: number;
}

interface OrgNodeTreeProps {
  nodes: OrgNodeListItem[];
}

interface TreeNode extends OrgNodeListItem {
  children: TreeNode[];
}

function buildTree(nodes: OrgNodeListItem[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) byId.set(n.id, { ...n, children: [] });
  const roots: TreeNode[] = [];
  for (const n of byId.values()) {
    if (n.parent_id && byId.has(n.parent_id)) {
      byId.get(n.parent_id)!.children.push(n);
    } else {
      roots.push(n);
    }
  }
  const sortRecursive = (list: TreeNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name));
    list.forEach((c) => sortRecursive(c.children));
  };
  sortRecursive(roots);
  return roots;
}

function Row({ node, depth }: { node: TreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <div
        className="group flex items-center gap-3 py-2 pr-2 hover:bg-muted/50 rounded-md"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'inline-flex size-4 items-center justify-center text-muted-foreground transition-transform',
            !hasChildren && 'invisible',
            expanded && 'rotate-90',
          )}
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronRight className="size-4" />
        </button>
        <Building2 className="size-4 text-muted-foreground" />
        <Link
          to={`/admin/organisations/${node.id}`}
          className="flex-1 truncate text-sm font-medium hover:underline"
        >
          {node.name}
        </Link>
        {node.code && <Badge variant="outline" className="font-mono text-xs">{node.code}</Badge>}
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="size-3" /> {node.member_count}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="size-3" /> {node.location_grant_count}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Wrench className="size-3" /> {node.team_count}
        </span>
      </div>
      {expanded && node.children.map((child) => (
        <Row key={child.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

export function OrgNodeTree({ nodes }: OrgNodeTreeProps) {
  const tree = buildTree(nodes);
  if (tree.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {tree.map((root) => (
        <Row key={root.id} node={root} depth={0} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: List page**

```tsx
// apps/web/src/pages/admin/organisations.tsx
import { Link } from 'react-router-dom';
import { Plus, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';
import { OrgNodeTree, type OrgNodeListItem } from '@/components/admin/org-node-tree';
import { useApi } from '@/hooks/use-api';

export function OrganisationsPage() {
  const { data, loading } = useApi<OrgNodeListItem[]>('/org-nodes');

  const isEmpty = !loading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        title="Organisations"
        description="The requester-side hierarchy. Members of a node inherit its location grants."
        actions={
          <Button asChild>
            <Link to="/admin/organisations/new">
              <Plus className="size-4" />
              Create organisation
            </Link>
          </Button>
        }
      />
      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {!loading && data && data.length > 0 && <OrgNodeTree nodes={data} />}
      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Building2 className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No organisations yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create your first organisation to start grouping employees and granting them
            access to locations in bulk.
          </p>
          <Button asChild>
            <Link to="/admin/organisations/new">
              <Plus className="size-4" />
              Create organisation
            </Link>
          </Button>
        </div>
      )}
    </SettingsPageShell>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter web exec tsc --noEmit 2>&1 | tail -15`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/admin/org-node-tree.tsx apps/web/src/pages/admin/organisations.tsx
git commit -m "feat(orgs): organisations list page with tree + counts"
```

---

## Task 16: Frontend — Create organisation sub-page

**Files:**
- Create: `apps/web/src/pages/admin/organisation-create.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/web/src/pages/admin/organisation-create.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  SettingsPageShell,
  SettingsPageHeader,
  SettingsSection,
  SettingsFooterActions,
} from '@/components/ui/settings-page';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { OrgNodeCombobox } from '@/components/org-node-combobox';
import { apiFetch } from '@/lib/api';

export function OrganisationCreatePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    setSubmitting(true);
    try {
      const created = await apiFetch<{ id: string }>('/org-nodes', {
        method: 'POST',
        body: {
          name: name.trim(),
          code: code.trim() || null,
          description: description.trim() || null,
          parent_id: parentId,
        },
      });
      toast.success('Organisation created');
      navigate(`/admin/organisations/${created.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create organisation');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/organisations"
        title="Create organisation"
        description="Add a new node to the requester-side hierarchy."
      />
      <SettingsSection
        title="Details"
        description="Identifying information for this organisation."
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="org-name">Name</FieldLabel>
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cairo Operations"
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="org-code">Code</FieldLabel>
            <Input
              id="org-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. CAI-OPS"
            />
            <FieldDescription>Optional short identifier shown as a badge.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="org-description">Description</FieldLabel>
            <Textarea
              id="org-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this organisation do?"
              rows={3}
            />
          </Field>
        </FieldGroup>
      </SettingsSection>
      <SettingsSection
        title="Hierarchy"
        description="Place this organisation under a parent, or leave blank to make it a top-level node."
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="org-parent">Parent organisation</FieldLabel>
            <OrgNodeCombobox value={parentId} onChange={setParentId} />
          </Field>
        </FieldGroup>
      </SettingsSection>
      <SettingsFooterActions
        primary={{
          label: 'Create organisation',
          onClick: submit,
          loading: submitting,
        }}
        secondary={{ label: 'Cancel', href: '/admin/organisations' }}
      />
    </SettingsPageShell>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter web exec tsc --noEmit 2>&1 | tail -10`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/admin/organisation-create.tsx
git commit -m "feat(orgs): create-organisation sub-page with template"
```

---

## Task 17: Frontend — Organisation detail page (with three panels)

**Files:**
- Create: `apps/web/src/components/admin/org-node-members-panel.tsx`
- Create: `apps/web/src/components/admin/org-node-grants-panel.tsx`
- Create: `apps/web/src/components/admin/org-node-teams-panel.tsx`
- Create: `apps/web/src/pages/admin/organisation-detail.tsx`

- [ ] **Step 1: Members panel — model after `PersonLocationGrantsPanel`**

```tsx
// apps/web/src/components/admin/org-node-members-panel.tsx
import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { PersonCombobox } from '@/components/person-combobox';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';

interface Member {
  id: string;
  person_id: string;
  is_primary: boolean;
  person: { id: string; first_name: string; last_name: string; email: string | null };
}

export function OrgNodeMembersPanel({ nodeId }: { nodeId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [addPersonId, setAddPersonId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<Member[]>(`/org-nodes/${nodeId}/members`);
      setMembers(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => { void reload(); }, [reload]);

  const addMember = async () => {
    if (!addPersonId) return;
    setAdding(true);
    try {
      await apiFetch(`/org-nodes/${nodeId}/members`, {
        method: 'POST',
        body: { person_id: addPersonId, is_primary: true },
      });
      setAddPersonId(null);
      await reload();
      toast.success('Member added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setAdding(false);
    }
  };

  const removeMember = async (personId: string) => {
    try {
      await apiFetch(`/org-nodes/${nodeId}/members/${personId}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="add-member">Add a member</FieldLabel>
          <PersonCombobox value={addPersonId} onChange={setAddPersonId} />
          <Button onClick={addMember} disabled={!addPersonId || adding}>
            <Plus className="size-4" />
            Add
          </Button>
        </Field>
      </FieldGroup>

      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {!loading && members.length === 0 && (
        <div className="text-sm text-muted-foreground">No members yet.</div>
      )}
      {members.length > 0 && (
        <ul className="flex flex-col gap-1">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {m.person.first_name} {m.person.last_name}
                </div>
                {m.person.email && (
                  <div className="text-xs text-muted-foreground truncate">{m.person.email}</div>
                )}
              </div>
              {m.is_primary && <Badge variant="secondary">Primary</Badge>}
              <Button variant="ghost" size="icon" onClick={() => removeMember(m.person_id)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Grants panel — mirror of `PersonLocationGrantsPanel`**

```tsx
// apps/web/src/components/admin/org-node-grants-panel.tsx
import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { LocationCombobox } from '@/components/location-combobox';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';

interface Grant {
  id: string;
  space_id: string;
  granted_at: string;
  note: string | null;
  space: { id: string; name: string; type: string };
}

export function OrgNodeGrantsPanel({ nodeId }: { nodeId: string }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(false);
  const [addSpaceId, setAddSpaceId] = useState<string | null>(null);
  const [addNote, setAddNote] = useState('');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<Grant[]>(`/org-nodes/${nodeId}/location-grants`);
      setGrants(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load grants');
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => { void reload(); }, [reload]);

  const add = async () => {
    if (!addSpaceId) return;
    setAdding(true);
    try {
      await apiFetch(`/org-nodes/${nodeId}/location-grants`, {
        method: 'POST',
        body: { space_id: addSpaceId, note: addNote.trim() || undefined },
      });
      setAddSpaceId(null);
      setAddNote('');
      await reload();
      toast.success('Location granted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add grant');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiFetch(`/org-nodes/${nodeId}/location-grants/${id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove grant');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="grant-space">Add location grant</FieldLabel>
          <LocationCombobox value={addSpaceId} onChange={setAddSpaceId} />
        </Field>
        <Field>
          <FieldLabel htmlFor="grant-note">Note (optional)</FieldLabel>
          <Input
            id="grant-note"
            value={addNote}
            onChange={(e) => setAddNote(e.target.value)}
            placeholder="e.g. Includes annex floors"
          />
        </Field>
        <div className="flex justify-end">
          <Button onClick={add} disabled={!addSpaceId || adding}>
            <Plus className="size-4" />
            Grant access
          </Button>
        </div>
      </FieldGroup>

      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {!loading && grants.length === 0 && (
        <div className="text-sm text-muted-foreground">No location grants yet.</div>
      )}
      {grants.length > 0 && (
        <ul className="flex flex-col gap-1">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
              <MapPin className="size-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{g.space.name}</div>
                {g.note && <div className="text-xs text-muted-foreground truncate">{g.note}</div>}
              </div>
              <Button variant="ghost" size="icon" onClick={() => remove(g.id)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Teams attached panel**

```tsx
// apps/web/src/components/admin/org-node-teams-panel.tsx
import { useCallback, useEffect, useState } from 'react';
import { Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';

interface Team { id: string; name: string; description: string | null; }

export function OrgNodeTeamsPanel({ nodeId }: { nodeId: string }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<Team[]>(`/org-nodes/${nodeId}`);
      setTeams((rows as unknown as { teams: Team[] }).teams ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load teams');
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => { void reload(); }, [reload]);

  const detach = async (teamId: string) => {
    try {
      await apiFetch(`/teams/${teamId}`, { method: 'PATCH', body: { org_node_id: null } });
      await reload();
      toast.success('Team detached');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to detach team');
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (teams.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        No teams attached. Attach a team from the Teams admin page.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {teams.map((t) => (
        <li key={t.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
          <Wrench className="size-4 text-muted-foreground" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{t.name}</div>
            {t.description && (
              <div className="text-xs text-muted-foreground truncate">{t.description}</div>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={() => detach(t.id)}>
            <X className="size-4" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Detail page wiring**

```tsx
// apps/web/src/pages/admin/organisation-detail.tsx
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  SettingsPageShell,
  SettingsPageHeader,
  SettingsSection,
  SettingsFooterActions,
} from '@/components/ui/settings-page';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { OrgNodeCombobox } from '@/components/org-node-combobox';
import { OrgNodeMembersPanel } from '@/components/admin/org-node-members-panel';
import { OrgNodeGrantsPanel } from '@/components/admin/org-node-grants-panel';
import { OrgNodeTeamsPanel } from '@/components/admin/org-node-teams-panel';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';

interface OrgNodeDetail {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  parent_id: string | null;
  active: boolean;
  members: unknown[];
  location_grants: unknown[];
  teams: unknown[];
}

export function OrganisationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [node, setNode] = useState<OrgNodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      setLoading(true);
      try {
        const data = await apiFetch<OrgNodeDetail>(`/org-nodes/${id}`);
        setNode(data);
        setName(data.name);
        setCode(data.code ?? '');
        setDescription(data.description ?? '');
        setParentId(data.parent_id);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  const save = async () => {
    if (!id) return;
    setSaving(true);
    try {
      await apiFetch(`/org-nodes/${id}`, {
        method: 'PATCH',
        body: {
          name: name.trim(),
          code: code.trim() || null,
          description: description.trim() || null,
          parent_id: parentId,
        },
      });
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id) return;
    if (!confirm('Delete this organisation? Members and location grants will be removed.')) return;
    try {
      await apiFetch(`/org-nodes/${id}`, { method: 'DELETE' });
      toast.success('Deleted');
      navigate('/admin/organisations');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Cannot delete (does it have children?)');
    }
  };

  if (loading || !node) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader backTo="/admin/organisations" title="Loading…" />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/organisations"
        title={node.name}
        description={node.code ?? undefined}
      />
      <SettingsSection title="Details">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="d-name">Name</FieldLabel>
            <Input id="d-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="d-code">Code</FieldLabel>
            <Input id="d-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="d-description">Description</FieldLabel>
            <Textarea
              id="d-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="d-parent">Parent organisation</FieldLabel>
            <OrgNodeCombobox
              value={parentId}
              onChange={setParentId}
              filter={(n) => n.id !== node.id}
            />
          </Field>
        </FieldGroup>
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Members"
        description="People whose primary organisation is this node. They inherit the location grants below."
      >
        <OrgNodeMembersPanel nodeId={node.id} />
      </SettingsSection>

      <SettingsSection
        title="Location grants"
        description="Sites and buildings every member of this organisation (and its descendants) can request for."
      >
        <OrgNodeGrantsPanel nodeId={node.id} />
      </SettingsSection>

      <SettingsSection
        title="Teams attached"
        description="Operational teams categorised under this organisation. Team membership does not grant locations."
      >
        <OrgNodeTeamsPanel nodeId={node.id} />
      </SettingsSection>

      <SettingsSection
        title="Danger zone"
        description="Deleting an organisation removes its memberships and location grants. Children must be moved or deleted first."
      >
        <SettingsFooterActions
          primary={{ label: 'Delete organisation', variant: 'destructive', onClick: remove }}
        />
      </SettingsSection>
    </SettingsPageShell>
  );
}
```

- [ ] **Step 5: Type-check**

Run: `cd /Users/x/Desktop/XPQT && pnpm --filter web exec tsc --noEmit 2>&1 | tail -15`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/admin/org-node-members-panel.tsx \
        apps/web/src/components/admin/org-node-grants-panel.tsx \
        apps/web/src/components/admin/org-node-teams-panel.tsx \
        apps/web/src/pages/admin/organisation-detail.tsx
git commit -m "feat(orgs): organisation detail page with members/grants/teams panels"
```

---

## Task 18: Frontend — register routes + sidebar item

**Files:**
- Modify: app router (likely `apps/web/src/App.tsx` — confirm with `grep -rn "admin/persons" apps/web/src/App.tsx`)
- Modify: admin sidebar/nav file (likely `apps/web/src/components/sidebar.tsx` — confirm with `grep -rn "Persons" apps/web/src/components/`)

- [ ] **Step 1: Locate the admin route registry**

Run: `grep -rn "/admin/persons" /Users/x/Desktop/XPQT/apps/web/src/`
Find the file that registers the existing admin routes.

- [ ] **Step 2: Add three new routes**

Following the existing pattern (likely `<Route path="..." element={<...Page />} />`), add:

```tsx
<Route path="/admin/organisations" element={<OrganisationsPage />} />
<Route path="/admin/organisations/new" element={<OrganisationCreatePage />} />
<Route path="/admin/organisations/:id" element={<OrganisationDetailPage />} />
```

Add the three corresponding imports at the top.

- [ ] **Step 3: Locate the admin nav menu**

Run: `grep -rn "Persons" /Users/x/Desktop/XPQT/apps/web/src/components/ | head -5`

- [ ] **Step 4: Add the menu item**

Add an entry near "Persons" / "Teams":

```tsx
{ label: 'Organisations', icon: Building2, href: '/admin/organisations' }
```

(Adjust to whatever shape the existing menu uses.)

- [ ] **Step 5: Type-check + boot the dev server**

```bash
cd /Users/x/Desktop/XPQT && pnpm --filter web exec tsc --noEmit 2>&1 | tail -10
```
Expected: zero errors.

```bash
cd /Users/x/Desktop/XPQT && pnpm dev:web
```
Open http://localhost:5173/admin/organisations — page should render with empty state.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/components/sidebar.tsx
git commit -m "feat(orgs): register organisations routes and sidebar entry"
```

---

## Task 19: Frontend — persons admin page swaps free-text for org picker

**Files:**
- Modify: `apps/web/src/pages/admin/persons.tsx`

- [ ] **Step 1: Read the file and identify the two field blocks**

Run: `grep -n "division\|department" /Users/x/Desktop/XPQT/apps/web/src/pages/admin/persons.tsx`

- [ ] **Step 2: Remove the `division` and `department` state + form fields**

Delete the `division`, `setDivision`, `department`, `setDepartment` state hooks and the two corresponding `<Field>` blocks for these inputs. Remove `department` from the table column list and any references.

- [ ] **Step 3: Add `primaryOrgNodeId` state and an Organisation `<Field>`**

```tsx
import { OrgNodeCombobox } from '@/components/org-node-combobox';

// inside component
const [primaryOrgNodeId, setPrimaryOrgNodeId] = useState<string | null>(null);

// inside the dialog form, replace the old Division/Department fields with:
<Field>
  <FieldLabel htmlFor="org-node">Organisation</FieldLabel>
  <OrgNodeCombobox
    value={primaryOrgNodeId}
    onChange={setPrimaryOrgNodeId}
  />
</Field>
```

- [ ] **Step 4: Wire submit + edit-load**

In the create / save handler, include `primary_org_node_id: primaryOrgNodeId` in the POST/PATCH body. On loading an existing person for edit, set the state from `person.primary_membership?.[0]?.org_node_id ?? null`.

- [ ] **Step 5: Update the table column for "Department"**

Replace the `department` column with `Organisation`. Render the joined `primary_membership[0]?.org_node?.name`.

- [ ] **Step 6: Type-check + visual check**

```bash
cd /Users/x/Desktop/XPQT && pnpm --filter web exec tsc --noEmit 2>&1 | tail -10
```
Expected: zero errors. Open `/admin/persons`, confirm the dialog shows the new field and the table renders the organisation column.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/admin/persons.tsx
git commit -m "feat(orgs): persons page replaces division/department with org picker"
```

---

## Task 20: Frontend — teams admin page accepts org picker

**Files:**
- Modify: `apps/web/src/pages/admin/teams.tsx`

- [ ] **Step 1: Read the file**

Run: `head -120 /Users/x/Desktop/XPQT/apps/web/src/pages/admin/teams.tsx`

- [ ] **Step 2: Add `orgNodeId` state and Field**

Following the existing field pattern in the team dialog, add:

```tsx
const [orgNodeId, setOrgNodeId] = useState<string | null>(null);

<Field>
  <FieldLabel htmlFor="team-org">Organisation</FieldLabel>
  <OrgNodeCombobox value={orgNodeId} onChange={setOrgNodeId} />
</Field>
```

- [ ] **Step 3: Pass `org_node_id` in submit and load it on edit**

Include in POST/PATCH body. On edit load, `setOrgNodeId(team.org_node_id ?? null)`.

- [ ] **Step 4: Type-check + visual**

```bash
cd /Users/x/Desktop/XPQT && pnpm --filter web exec tsc --noEmit 2>&1 | tail -10
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/teams.tsx
git commit -m "feat(orgs): teams page accepts optional org node attachment"
```

---

## Task 21: End-to-end smoke test in the browser

**Files:** none.

- [ ] **Step 1: Start backend + frontend**

```bash
cd /Users/x/Desktop/XPQT && pnpm dev
```

- [ ] **Step 2: Click through the golden path**

In the browser at http://localhost:5173:

1. **Navigate to `/admin/organisations`.** Expect empty state.
2. **Create a top-level org** "Cairo Operations" (code `CAI-OPS`). Expect redirect to detail page.
3. **Create a child org** "Finance" with parent = "Cairo Operations". Confirm tree shows Cairo Operations expanded with Finance under it.
4. **On Finance detail:** add a person as a member. Refresh — they appear with Primary badge.
5. **On Finance detail:** add a location grant for a known site. Confirm grant appears.
6. **Open the portal as the added person.** Confirm the granted site (and its descendants) appear as authorized roots.
7. **Add a second org** "AP" under Finance. Move a location grant up to "Cairo Operations" (delete from Finance, add at Cairo Operations). Refresh portal as the same person — they should still see the location (now via the ancestor walk).
8. **Open `/admin/persons`** — confirm the test person shows "Finance" in the Organisation column.
9. **Open `/admin/teams`** — pick a team, set its Organisation to "Cairo Operations". Refresh the org detail — the team appears in the "Teams attached" panel.
10. **Try to delete "Finance"** while it has a child ("AP") — expect an error toast.
11. **Delete "AP"** first, then "Finance" — expect success.

- [ ] **Step 3: Capture any visual/behavioural defects in a `notes.md` and fix inline before continuing.**

- [ ] **Step 4: No commit unless fixes were made.** Move on to documentation.

---

## Task 22: Update documentation

**Files:**
- Modify: `docs/portal-scope-slice.md` (or whichever doc currently describes portal scope — verify with `grep -rln "portal_authorized_root_matches" docs/`)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Portal-scope doc update**

Find the section describing `portal_authorized_root_matches` sources. Append:

```markdown
### `org_grant` — inherited via org-node membership (added 2026-04-22)

A person inherits location grants from every `org_node` they belong to (via
`person_org_memberships`) and from every ancestor of those nodes (via
`org_node_ancestors(node_id)`). The grants come from `org_node_location_grants`.

The third arm of `portal_authorized_root_matches` joins
`person_org_memberships` × `org_node_ancestors(...)` × `org_node_location_grants`
and emits `source = 'org_grant'`, `grant_id = org_node_location_grants.id`.

Tie-break in `portal_match_authorized_root` (when two roots are equidistant from
the selected space): `default > grant > org_grant` — the more specific source wins.
```

- [ ] **Step 2: CLAUDE.md update**

Find the "Architecture" section's tenant-isolation paragraph (or wherever first-class tenant tables are listed). Add a brief mention:

> `org_nodes` is the requester-side hierarchy (per-tenant tree). Membership via `person_org_memberships`; cascading location grants via `org_node_location_grants`. See `docs/superpowers/specs/2026-04-22-organisations-and-admin-template-design.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/portal-scope-slice.md CLAUDE.md
git commit -m "docs(orgs): document org_grant source and add org_nodes to overview"
```

---

## Task 23: Codex review pass + fix-up commit

Per project memory: codex reviews between slices.

- [ ] **Step 1: Hand the diff to codex**

```bash
cd /Users/x/Desktop/XPQT
codex exec --full-auto -C /Users/x/Desktop/XPQT \
  "Review the diff between origin/main and HEAD for the org-nodes feature. \
   Focus areas: (1) tenant isolation correctness across the new tables and triggers, \
   (2) potential RLS gaps, (3) cycle prevention safety under concurrency, \
   (4) portal_authorized_root_matches change correctness vs the existing semantics, \
   (5) UI accessibility and Field-primitive compliance per CLAUDE.md, \
   (6) any missed migrations, dead code, or scope creep. \
   Output: numbered findings with severity (blocker/major/minor/nit) and a concrete \
   suggested fix per item. Be terse and specific."
```

- [ ] **Step 2: Triage findings**

For each blocker/major: implement the fix in a follow-up commit `fix(orgs): <summary>`. For minor/nit: note in the run log; defer unless trivial.

- [ ] **Step 3: Commit any fixes**

```bash
git add <touched files>
git commit -m "fix(orgs): address codex review findings"
```

---

## Self-review (run before reporting completion)

Open the spec and walk through each requirement. Tick off:

- [ ] §3.1 `org_nodes` shipped with cycle + tenant triggers (Task 2)
- [ ] §3.2 `person_org_memberships` join table with partial unique primary index (Task 3)
- [ ] §3.3 `org_node_location_grants` with site/building integrity guard (Task 4)
- [ ] §3.4 `teams.org_node_id` nullable FK with `on delete set null` (Task 5)
- [ ] §3.5 `persons.division` and `persons.department` dropped (Task 6)
- [ ] §4 `portal_authorized_root_matches` extended with `org_grant`; ancestor helper added; tie-break extended (Task 7)
- [ ] §6.1 Template primitives present and used by all 3 org pages (Tasks 1, 15, 16, 17)
- [ ] §6.2 Organisations list page with tree + counts + create button (Task 15)
- [ ] §6.3 Create sub-page with back button (Task 16)
- [ ] §6.4 Detail page with Members / Grants / Teams attached / Danger zone (Task 17)
- [ ] §6.5 Persons form uses org picker (Task 19)
- [ ] §6.6 Teams form has org picker (Task 20)
- [ ] §6.7 Sidebar entry + routes registered (Task 18)
- [ ] §7 `organisations:manage` permission seeded (Task 8)
- [ ] §8 All 7 migrations on local + remote (Tasks 2–8 + Task 9)
- [ ] §11 Portal-scope doc + CLAUDE.md updated (Task 22)

If anything is unticked, add a follow-up task before declaring done.
