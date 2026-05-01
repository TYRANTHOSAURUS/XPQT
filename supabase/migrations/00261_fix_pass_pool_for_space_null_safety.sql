-- 00261_fix_pass_pool_for_space_null_safety.sql
-- Visitor Management v1 — explicit NULL-safe opt-out check in pass_pool_for_space.
--
-- Hardening:
--   In 00254 the opt-out subquery used:
--     bool_or(s.uses_visitor_passes = false)
--   wrapped by `coalesce(..., false)` in the outer query. This is
--   incidentally correct: NULL = false yields NULL, bool_or over NULL is
--   NULL, and only the outer coalesce makes the predicate fall back to
--   "not opted out". A future edit removing the coalesce would silently
--   break the opt-out semantics.
--
-- Fix:
--   Replace `uses_visitor_passes = false` with `uses_visitor_passes is false`.
--   `IS FALSE` is NULL-safe (returns false on NULL) and self-documenting,
--   so the bool_or aggregate yields a definite boolean for any non-empty
--   ancestor set. The outer coalesce stays for the empty-input edge case.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.5

drop function if exists public.pass_pool_for_space(uuid);

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
  -- explicit opt-out: if any ancestor (inclusive) has uses_visitor_passes
  -- explicitly false (IS FALSE — NULL-safe), the whole subtree is opted out
  -- and the function returns no rows.
  opt_out_check as (
    select bool_or(s.uses_visitor_passes is false) as opted_out
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
  'Most-specific visitor pass pool inheritance for a space. Walks spaces.parent_id ancestry. Building-level overrides site-level. uses_visitor_passes IS FALSE on any ancestor blocks inheritance for the subtree (NULL-safe; fixed in 00261). See visitor-management-v1-design.md §4.5.';

notify pgrst, 'reload schema';
