-- 00249_visitor_pass_pool.sql
-- Visitor Management v1 — physical pass pool tracking.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.4, §4.5
--
-- The pool is anchored to a site or building space (never floor / room /
-- desk). Composite FKs to visitors(tenant_id, id) prevent a tenant-A pool
-- from referencing a tenant-B visitor. The denormalised space_kind column
-- is kept in sync via trigger and gated to ('site','building') via CHECK.

-- ---------------------------------------------------------------------------
-- Prerequisite: visitors(tenant_id, id) UNIQUE for composite FK targets.
-- Lives here (not 00252) because 00249 is the first migration to need it.
-- ---------------------------------------------------------------------------
alter table public.visitors
  add constraint visitors_pkey_tenant unique (tenant_id, id);

-- ---------------------------------------------------------------------------
-- spaces.uses_visitor_passes — opt-out flag for pool inheritance.
-- Null = inherit from ancestor; explicit false blocks inheritance for the
-- subtree (per spec §4.5).
-- ---------------------------------------------------------------------------
alter table public.spaces
  add column if not exists uses_visitor_passes boolean;

comment on column public.spaces.uses_visitor_passes is
  'Visitor pass-pool opt-out. NULL = inherit; FALSE = no pass pool applies in this subtree (per pass_pool_for_space() recursive walk).';

-- ---------------------------------------------------------------------------
-- visitor_pass_pool table
-- ---------------------------------------------------------------------------
create table public.visitor_pass_pool (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  space_id  uuid not null references public.spaces(id),
  -- Note: spaces uses column name "type", not "kind" (verified via local DB).
  -- We mirror the value into space_kind here (denormalised) so the CHECK
  -- constraint can fire without a join. Kept in sync via trg_pool_space_kind.
  space_kind text not null,
  pass_number text not null,
  pass_type   text not null default 'standard',
  status text not null default 'available' check (status in ('available','reserved','in_use','lost','retired')),
  current_visitor_id      uuid,
  reserved_for_visitor_id uuid,
  last_assigned_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- pool anchor must be site or building, never floor/desk/parking
  constraint pool_space_kind check (space_kind in ('site','building')),
  unique (tenant_id, space_id, pass_number)
);

-- Composite FK to visitors enforces tenant alignment (B1).
alter table public.visitor_pass_pool
  add constraint pool_current_visitor_fk
    foreign key (tenant_id, current_visitor_id) references public.visitors(tenant_id, id),
  add constraint pool_reserved_visitor_fk
    foreign key (tenant_id, reserved_for_visitor_id) references public.visitors(tenant_id, id);

-- in-use ⇒ current_visitor_id required; reserved ⇒ reserved_for_visitor_id required.
alter table public.visitor_pass_pool
  add constraint pool_state_consistency check (
    (status = 'in_use'    and current_visitor_id is not null) or
    (status = 'reserved'  and reserved_for_visitor_id is not null) or
    (status not in ('in_use','reserved'))
  );

-- ---------------------------------------------------------------------------
-- Trigger: keep space_kind in sync with spaces.type, gate to (site|building).
-- Note: spaces.type is the actual column (not "kind" as the spec text reads).
-- ---------------------------------------------------------------------------
create or replace function public.sync_pool_space_kind() returns trigger
  language plpgsql as $$
declare
  v_type text;
begin
  select type into v_type from public.spaces where id = new.space_id;
  if v_type is null then
    raise exception 'visitor_pass_pool.space_id % does not exist', new.space_id;
  end if;
  new.space_kind := v_type;
  if new.space_kind not in ('site','building') then
    raise exception 'visitor_pass_pool.space_id must reference a site or building (got %)', new.space_kind;
  end if;
  return new;
end;
$$;

create trigger trg_pool_space_kind
  before insert or update of space_id on public.visitor_pass_pool
  for each row execute function public.sync_pool_space_kind();

create trigger set_visitor_pass_pool_updated_at before update on public.visitor_pass_pool
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — per-verb (mirroring 00160 hardening pattern)
-- ---------------------------------------------------------------------------
alter table public.visitor_pass_pool enable row level security;

drop policy if exists tenant_isolation on public.visitor_pass_pool;
create policy "visitor_pass_pool_select" on public.visitor_pass_pool
  for select using (tenant_id = public.current_tenant_id());
create policy "visitor_pass_pool_insert" on public.visitor_pass_pool
  for insert with check (tenant_id = public.current_tenant_id());
create policy "visitor_pass_pool_update" on public.visitor_pass_pool
  for update
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
create policy "visitor_pass_pool_delete" on public.visitor_pass_pool
  for delete using (tenant_id = public.current_tenant_id());

revoke all on public.visitor_pass_pool from public, anon, authenticated;
grant select, insert, update, delete on public.visitor_pass_pool to service_role;

create index idx_pool_space on public.visitor_pass_pool (tenant_id, space_id, status);
create index idx_pool_current_visitor on public.visitor_pass_pool (tenant_id, current_visitor_id) where current_visitor_id is not null;
create index idx_pool_reserved_visitor on public.visitor_pass_pool (tenant_id, reserved_for_visitor_id) where reserved_for_visitor_id is not null;

comment on table public.visitor_pass_pool is
  'Physical visitor pass tracking, anchored to a site or building. Composite FK to visitors(tenant_id, id) enforces tenant alignment. See visitor-management-v1-design.md §4.4.';

notify pgrst, 'reload schema';
