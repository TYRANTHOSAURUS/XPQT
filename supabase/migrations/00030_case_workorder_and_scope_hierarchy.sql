-- 00030_case_workorder_and_scope_hierarchy.sql
-- Case/work-order split, space groups, domain hierarchy, parent-status rollup.

-- ── 1. ticket_kind ────────────────────────────────────────────
alter table public.tickets
  add column if not exists ticket_kind text not null default 'case'
    check (ticket_kind in ('case', 'work_order'));

create index if not exists idx_tickets_kind on public.tickets (tenant_id, ticket_kind);
create index if not exists idx_tickets_parent_kind
  on public.tickets (parent_ticket_id, ticket_kind)
  where parent_ticket_id is not null;

-- ── 2. Space groups ───────────────────────────────────────────
-- A space group lets admins treat several unrelated spaces as one routing target
-- (solves: "Locations B/C/D → FM Shared" when B/C/D have no common ancestor).
create table if not exists public.space_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table public.space_groups enable row level security;
create policy "tenant_isolation" on public.space_groups
  using (tenant_id = public.current_tenant_id());

create trigger set_space_groups_updated_at before update on public.space_groups
  for each row execute function public.set_updated_at();

create table if not exists public.space_group_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  space_group_id uuid not null references public.space_groups(id) on delete cascade,
  space_id uuid not null references public.spaces(id) on delete cascade,
  unique (space_group_id, space_id)
);

alter table public.space_group_members enable row level security;
create policy "tenant_isolation" on public.space_group_members
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_sgm_group on public.space_group_members (space_group_id);
create index if not exists idx_sgm_space on public.space_group_members (space_id);

-- location_teams can now point to a space_group instead of a single space.
alter table public.location_teams
  add column if not exists space_group_id uuid references public.space_groups(id) on delete cascade;

-- space_id is no longer NOT NULL (it was implicitly required).  Drop and recreate the check
-- so EITHER space_id OR space_group_id must be set.
alter table public.location_teams alter column space_id drop not null;
alter table public.location_teams
  drop constraint if exists location_teams_scope_check;
alter table public.location_teams
  add constraint location_teams_scope_check
  check ((space_id is not null) <> (space_group_id is not null));

-- Existing unique (space_id, domain) doesn't cover groups; add a parallel one.
create unique index if not exists uniq_location_teams_group_domain
  on public.location_teams (space_group_id, domain)
  where space_group_id is not null;

create index if not exists idx_location_teams_group_domain
  on public.location_teams (space_group_id, domain);

-- ── 3. Domain hierarchy ───────────────────────────────────────
-- Admin-managed parent chain for domains: "doors" → "fm" means a request with
-- domain="doors" can fall back to "fm" if no "doors" team exists at a scope.
create table if not exists public.domain_parents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  domain text not null,
  parent_domain text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, domain),
  check (domain <> parent_domain)
);

alter table public.domain_parents enable row level security;
create policy "tenant_isolation" on public.domain_parents
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_domain_parents_tenant on public.domain_parents (tenant_id);

-- ── 4. Parent-status rollup trigger ───────────────────────────
-- When a work_order's status_category changes, recompute the parent case:
--   * if any child is 'in_progress' → parent 'in_progress'
--   * else if any child not in ('resolved','closed') → parent 'assigned'
--   * else (all resolved/closed) → parent 'resolved'
-- Parent status never goes backward past 'resolved' via this trigger — a human
-- must explicitly close/reopen the parent case.
create or replace function public.rollup_parent_status()
returns trigger
language plpgsql
as $$
declare
  parent_row record;
  any_in_progress boolean;
  any_open boolean;
begin
  if new.parent_ticket_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.status_category is not distinct from old.status_category then
    return new;
  end if;

  select * into parent_row from public.tickets where id = new.parent_ticket_id;
  if not found then
    return new;
  end if;

  select
    bool_or(status_category = 'in_progress'),
    bool_or(status_category not in ('resolved', 'closed'))
  into any_in_progress, any_open
  from public.tickets
  where parent_ticket_id = new.parent_ticket_id
    and ticket_kind = 'work_order';

  if any_in_progress then
    update public.tickets set status_category = 'in_progress'
    where id = new.parent_ticket_id and status_category <> 'in_progress'
      and status_category not in ('resolved', 'closed');
  elsif any_open then
    update public.tickets set status_category = 'assigned'
    where id = new.parent_ticket_id
      and status_category in ('new')
      and status_category not in ('resolved', 'closed');
  else
    update public.tickets
    set status_category = 'resolved',
        resolved_at = coalesce(resolved_at, now())
    where id = new.parent_ticket_id
      and status_category not in ('resolved', 'closed');
  end if;

  return new;
end;
$$;

drop trigger if exists rollup_parent_status_trg on public.tickets;
create trigger rollup_parent_status_trg
  after insert or update of status_category on public.tickets
  for each row
  when (new.ticket_kind = 'work_order' and new.parent_ticket_id is not null)
  execute function public.rollup_parent_status();

-- ── 5. Reload PostgREST schema cache ──────────────────────────
notify pgrst, 'reload schema';
