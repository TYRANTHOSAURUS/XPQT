-- Catalog hierarchy: enforce depth cap on category tree, add discovery fields to request types.
-- Schema already supports the tree via service_catalog_categories.parent_category_id and the
-- request_type_categories M2M. This migration adds guardrails and the columns the portal needs
-- to render a Linear-style catalog (icon, description, order, search keywords).

-- 1. Discovery fields on request_types (parity with service_catalog_categories).
alter table public.request_types
  add column if not exists description text,
  add column if not exists icon text,
  add column if not exists display_order integer not null default 0,
  add column if not exists keywords text[] not null default '{}'::text[];

create index if not exists idx_rt_keywords
  on public.request_types using gin (keywords);

create index if not exists idx_rt_tenant_active_order
  on public.request_types (tenant_id, display_order)
  where active = true;

-- 2. Category tree integrity: cap depth at 3 levels, forbid cycles.
-- Depth policy: root = level 1, child = level 2, grandchild = level 3. Level 4 is rejected.
-- Industry benchmark: ServiceNow and Freshservice both cap practical nesting at ~3 levels —
-- deeper trees measurably hurt portal discoverability.
create or replace function public.check_category_hierarchy()
returns trigger
language plpgsql
as $$
declare
  ancestor_depth int;
  cycle_detected boolean;
begin
  if new.parent_category_id is null then
    return new;
  end if;

  if new.parent_category_id = new.id then
    raise exception 'category_self_parent: a category cannot be its own parent';
  end if;

  with recursive ancestors as (
    select id, parent_category_id, 1 as depth
    from public.service_catalog_categories
    where id = new.parent_category_id
    union all
    select c.id, c.parent_category_id, a.depth + 1
    from public.service_catalog_categories c
    join ancestors a on c.id = a.parent_category_id
    where a.depth < 10
  )
  select max(depth), bool_or(id = new.id)
  into ancestor_depth, cycle_detected
  from ancestors;

  if cycle_detected then
    raise exception 'category_cycle: moving this category would create a cycle in the hierarchy';
  end if;

  if ancestor_depth >= 3 then
    raise exception 'category_depth_exceeded: catalog hierarchy is capped at 3 levels (attempted %)', ancestor_depth + 1;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_category_hierarchy on public.service_catalog_categories;
create trigger enforce_category_hierarchy
  before insert or update of parent_category_id
  on public.service_catalog_categories
  for each row execute function public.check_category_hierarchy();
