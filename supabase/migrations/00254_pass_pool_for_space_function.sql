-- 00254_pass_pool_for_space_function.sql
-- Visitor Management v1 — most-specific pass pool inheritance walk.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.5
--
-- Walks spaces.parent_id ancestry from the given space upward. Most-specific
-- (smallest depth) wins; building-level pool overrides site-level. If any
-- ancestor has uses_visitor_passes=false the entire subtree opts out.
--
-- security_invoker — RLS predicates apply (tenant_id = current_tenant_id())
-- so a tenant cannot read a peer tenant's pool through the function.

create or replace function public.pass_pool_for_space(p_space_id uuid)
  returns setof public.visitor_pass_pool
  language sql stable security invoker
as $$
  with recursive ancestors as (
    select id, parent_id, 0 as depth
      from public.spaces
     where id = p_space_id
    union all
    select s.id, s.parent_id, a.depth + 1
      from public.spaces s
      join ancestors a on s.id = a.parent_id
     where a.depth < 20
  ),
  -- explicit opt-out: if any ancestor (inclusive) has uses_visitor_passes=false,
  -- the whole subtree is opted out and the function returns no rows.
  opt_out_check as (
    select bool_or(s.uses_visitor_passes = false) as opted_out
      from ancestors a
      join public.spaces s on s.id = a.id
  )
  select pool.*
    from public.visitor_pass_pool pool
    join ancestors a on pool.space_id = a.id
   where pool.tenant_id = public.current_tenant_id()
     and coalesce((select opted_out from opt_out_check), false) = false
   order by a.depth asc
   limit 1;  -- most-specific wins
$$;

comment on function public.pass_pool_for_space(uuid) is
  'Most-specific visitor pass pool inheritance for a space. Walks spaces.parent_id ancestry. Building-level overrides site-level. uses_visitor_passes=false on any ancestor blocks inheritance for the subtree. See visitor-management-v1-design.md §4.5.';

notify pgrst, 'reload schema';
