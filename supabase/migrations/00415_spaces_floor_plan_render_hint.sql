-- 00415_spaces_floor_plan_render_hint.sql
-- Adds render hint + canonicalizes polygon shape. Spec §3.2 + §3.4.

alter table public.spaces
  add column if not exists floor_plan_render_hint text not null default 'default'
    check (floor_plan_render_hint in ('default', 'seat', 'parking'));

-- Normalize any pre-existing rows: wrap bare arrays in {points:[…]}.
update public.spaces
   set floor_plan_polygon = jsonb_build_object('points', floor_plan_polygon)
 where floor_plan_polygon is not null
   and jsonb_typeof(floor_plan_polygon) = 'array';

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

notify pgrst, 'reload schema';
