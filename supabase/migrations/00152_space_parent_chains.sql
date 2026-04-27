-- Recursive CTE that walks every requested space up to the root in a single
-- round-trip. Replaces the BFS-per-layer loop in
-- `ListBookableRoomsService.loadParentChains` (3 sequential SELECTs for a
-- typical 3-level tree) — the desk scheduler's first paint hot path.
--
-- Returns one row per (space, ancestor) pair, ordered closest-first via
-- `depth` (1 = immediate parent). Tenant_id filter is applied inside the
-- function so callers don't have to thread it through both legs of the CTE.
create or replace function public.space_parent_chains(
  p_tenant_id uuid,
  p_space_ids uuid[]
) returns table (
  space_id uuid,
  ancestor_id uuid,
  ancestor_name text,
  ancestor_type text,
  depth int
)
language sql
stable
as $$
  with recursive chain as (
    select
      s.id          as space_id,
      s.parent_id   as ancestor_id,
      1             as depth
    from public.spaces s
    where s.tenant_id = p_tenant_id
      and s.id = any(p_space_ids)
      and s.parent_id is not null

    union all

    select
      c.space_id,
      p.parent_id,
      c.depth + 1
    from chain c
    join public.spaces p
      on p.id = c.ancestor_id
     and p.tenant_id = p_tenant_id
    where c.depth < 8
      and p.parent_id is not null
  )
  select
    c.space_id,
    a.id          as ancestor_id,
    a.name        as ancestor_name,
    a.type        as ancestor_type,
    c.depth
  from chain c
  join public.spaces a
    on a.id = c.ancestor_id
   and a.tenant_id = p_tenant_id
  order by c.space_id, c.depth;
$$;

notify pgrst, 'reload schema';
