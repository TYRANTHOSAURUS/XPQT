-- 00439_spaces_floor_plan_render_hint.sql
-- Adds render hint + canonicalizes polygon shape. Spec §3.2 + §3.4.
--
-- Renumbered from 00415 (2026-06-23) to resolve a duplicate-prefix
-- collision with 00415_revoke_browser_write_grants.sql that broke the
-- CI db:reset migration smoke. The column + constraint are already in
-- place on the remote DB (applied under the old prefix); the
-- `if not exists` / `do …` guards below make this file idempotent on
-- a fresh local stack AND a no-op when re-applied through any path
-- that's already seen the original.

alter table public.spaces
  add column if not exists floor_plan_render_hint text not null default 'default'
    check (floor_plan_render_hint in ('default', 'seat', 'parking'));

-- Normalize any pre-existing rows: wrap bare arrays in {points:[…]}.
update public.spaces
   set floor_plan_polygon = jsonb_build_object('points', floor_plan_polygon)
 where floor_plan_polygon is not null
   and jsonb_typeof(floor_plan_polygon) = 'array';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'floor_plan_polygon_shape'
      and conrelid = 'public.spaces'::regclass
  ) then
    alter table public.spaces
      add constraint floor_plan_polygon_shape
        check (
          floor_plan_polygon is null
          or (
            jsonb_typeof(floor_plan_polygon) = 'object'
            and floor_plan_polygon ? 'points'
            and jsonb_typeof(floor_plan_polygon->'points') = 'array'
            and jsonb_array_length(floor_plan_polygon->'points') >= 3
          )
        );
  end if;
end $$;

notify pgrst, 'reload schema';
