-- Slice C — PM generator §3: maintenance_plans schema.
--
-- Spec: ai/slice-c-plan.md §3 (lines 61-127, 163-167).
--
-- Two parts:
--   1. Composite-FK preconditions on public.assets / asset_types /
--      request_types / spaces — each needs `unique (tenant_id, id)` so
--      the table created in part 2 can declare tenant-safe composite
--      FKs. None of the four tables exposes that constraint today (PG
--      check 2026-05-13: only `<table>_pkey` PRIMARY KEY (id)). Tenant
--      ownership is otherwise not enforced at the FK layer.
--   2. The maintenance_plans table itself + indexes + RLS.
--
-- The composite-FK pattern mirrors `assigned_assets_tenant_id_id_key`
-- (00171:36) and `visitor_pass_pool_tenant_id_id_uniq` (00249:48) —
-- both are pre-existing in this codebase.

-- ── Part 1. Composite-FK preconditions ─────────────────────────────────

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'assets_tenant_id_id_unique'
  ) then
    alter table public.assets
      add constraint assets_tenant_id_id_unique unique (tenant_id, id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'asset_types_tenant_id_id_unique'
  ) then
    alter table public.asset_types
      add constraint asset_types_tenant_id_id_unique unique (tenant_id, id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'request_types_tenant_id_id_unique'
  ) then
    alter table public.request_types
      add constraint request_types_tenant_id_id_unique unique (tenant_id, id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'spaces_tenant_id_id_unique'
  ) then
    alter table public.spaces
      add constraint spaces_tenant_id_id_unique unique (tenant_id, id);
  end if;
end $$;

-- ── Part 2. maintenance_plans table ────────────────────────────────────

create table public.maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  name text not null,
  description text,
  active boolean not null default true,

  asset_id uuid,
  asset_type_id uuid,
  constraint maintenance_plans_target_mutex check (
    (asset_id is not null and asset_type_id is null) or
    (asset_id is null and asset_type_id is not null)
  ),
  constraint maintenance_plans_asset_tenant_fk
    foreign key (tenant_id, asset_id)
    references public.assets (tenant_id, id) on delete cascade,
  constraint maintenance_plans_asset_type_tenant_fk
    foreign key (tenant_id, asset_type_id)
    references public.asset_types (tenant_id, id) on delete cascade,

  request_type_id uuid not null,
  location_id uuid,
  constraint maintenance_plans_request_type_tenant_fk
    foreign key (tenant_id, request_type_id)
    references public.request_types (tenant_id, id),
  constraint maintenance_plans_location_tenant_fk
    foreign key (tenant_id, location_id)
    references public.spaces (tenant_id, id),

  title_template text not null,
  description_template text,
  priority text not null default 'normal'
    check (priority in ('low','normal','high','critical')),
  planned_duration_minutes int default 60
    check (planned_duration_minutes is null or planned_duration_minutes > 0),

  recurrence_interval int not null check (recurrence_interval > 0),
  recurrence_unit text not null
    check (recurrence_unit in ('day','week','month','year')),
  anchor_date date not null,
  lead_days int not null default 7 check (lead_days >= 0),

  next_run_at timestamptz not null,
  last_completed_at timestamptz,
  last_generated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.users(id),
  updated_by uuid references public.users(id),

  constraint maintenance_plans_tenant_id_id_unique unique (tenant_id, id)
);

comment on column public.maintenance_plans.tenant_id is
  'tenant_id invariant #0 — every row scoped + cascades on tenant delete';
comment on column public.maintenance_plans.name is
  'admin-facing plan name';
comment on column public.maintenance_plans.description is
  'admin-facing free-text description';
comment on column public.maintenance_plans.active is
  'inactive plans are skipped by the generator';
comment on column public.maintenance_plans.asset_id is
  'XOR with asset_type_id — single-asset plan target';
comment on column public.maintenance_plans.asset_type_id is
  'XOR with asset_id — fleet plan target (fan-out per asset of type)';
comment on column public.maintenance_plans.request_type_id is
  'request type stamped onto every spawned WO (drives routing + workflow)';
comment on column public.maintenance_plans.location_id is
  'optional WO location override — null falls back to asset.assigned_space_id';
comment on column public.maintenance_plans.title_template is
  'WO title template — v1 supports the single token {{asset.name}}';
comment on column public.maintenance_plans.description_template is
  'WO description template — same v1 token contract as title_template';
comment on column public.maintenance_plans.priority is
  'WO priority for spawned work orders';
comment on column public.maintenance_plans.planned_duration_minutes is
  'WO planned duration for spawned work orders';
comment on column public.maintenance_plans.recurrence_interval is
  'recurrence step count (e.g. 1 month = interval 1 unit month)';
comment on column public.maintenance_plans.recurrence_unit is
  'recurrence step unit — day, week, month, or year';
comment on column public.maintenance_plans.anchor_date is
  'recurrence origin date — next_run_at advance derives from this';
comment on column public.maintenance_plans.lead_days is
  'days ahead of next_run_at the generator spawns the WO';
comment on column public.maintenance_plans.next_run_at is
  'next planned_start_at the generator will stamp on spawned WOs';
comment on column public.maintenance_plans.last_completed_at is
  'most recent resolved_at of a generated WO — stamped by 00390 trigger';
comment on column public.maintenance_plans.last_generated_at is
  'most recent generator run that spawned at least one WO for this plan';
comment on column public.maintenance_plans.created_by is
  'users.id of the admin who created the plan';
comment on column public.maintenance_plans.updated_by is
  'users.id of the admin who last edited the plan';

create index idx_maintenance_plans_tenant
  on public.maintenance_plans (tenant_id);
create index idx_maintenance_plans_due
  on public.maintenance_plans (next_run_at) where active = true;
create index idx_maintenance_plans_asset
  on public.maintenance_plans (asset_id) where asset_id is not null;
create index idx_maintenance_plans_asset_type
  on public.maintenance_plans (asset_type_id) where asset_type_id is not null;

alter table public.maintenance_plans enable row level security;
create policy "tenant_isolation" on public.maintenance_plans
  using (tenant_id = public.current_tenant_id());

create trigger set_maintenance_plans_updated_at
  before update on public.maintenance_plans
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
