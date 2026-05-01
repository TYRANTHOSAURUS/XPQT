-- Returns the parent trail of a space as text[] (root-first, leaf-last).
-- Used by the reservation detail endpoint so the booking detail "Where"
-- row can render "Building › Floor › Room" without the frontend
-- fetching the entire tenant space tree just to walk parents.
--
-- The recursive CTE walks parent_id from the leaf upwards, then the
-- outer query reverses the order so the result reads root-first
-- (matching how a breadcrumb is read).
--
-- Stable + language sql so the planner can inline it.
--
-- IMPORTANT — security model:
-- `security invoker` means RLS on `spaces` is enforced when the function
-- is called by an anon/authenticated PostgREST client. The current caller
-- in our code (`reservation.service.ts:findOne`) uses `supabase.admin`
-- (service role key), which BYPASSES RLS. The call is safe ONLY because
-- `space_id` is read from a tenant-scoped `reservations` row immediately
-- before the rpc call.
--
-- DO NOT call this function from a service-role context with a
-- user-controlled `p_space_id` without first verifying the space belongs
-- to the current tenant. Doing so leaks names from other tenants.
--
-- TODO (data-model-redesign Step 3): when the unified `resources` catalog
-- lands and replaces `spaces`, this function becomes obsolete. Replace
-- with `resource_path(uuid)` reading from `resources`, drop this
-- function, and update `reservation.service.ts:findOne` accordingly.
create or replace function public.space_path(p_space_id uuid)
returns text[]
language sql
stable
security invoker
as $$
  with recursive walk as (
    select id, parent_id, name, 0 as depth
    from public.spaces
    where id = p_space_id
    union all
    select s.id, s.parent_id, s.name, w.depth + 1
    from public.spaces s
    join walk w on w.parent_id = s.id
    where w.depth < 16
  )
  select array_agg(name order by depth desc) from walk;
$$;

comment on function public.space_path(uuid) is
  'Root-first parent trail (text[]) for a space. Capped at 16 levels.';

notify pgrst, 'reload schema';
