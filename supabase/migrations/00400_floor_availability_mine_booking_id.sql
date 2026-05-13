-- 00400_floor_availability_mine_booking_id.sql
-- Extends `floor_availability` RPC to include `mine_booking_id` on each space
-- entry, so the portal /book/floor surface can wire an inline cancel action
-- when state='mine' (without a second round-trip to look up the booking id).
--
-- For state='mine': returns the most-recently-starting booking id owned by
-- the caller that overlaps the window. (Edge case: if a caller has multiple
-- overlapping bookings on the same space, the latest-starting one wins. UI
-- still navigates to /portal/me/bookings/<id> from there for the full
-- detail view, so the choice is non-fatal.)
-- For non-'mine' states: null. The aggregate-anonymized contract for other
-- states (codex C7 review) is preserved.
--
-- Identical signature + tenant + RLS posture as 00375. Service-role only.

create or replace function public.floor_availability(
  p_tenant_id uuid,
  p_floor_space_id uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_tenant_id uuid := p_tenant_id;
  v_caller_person_id uuid;
  v_spaces jsonb;
  v_heatmap jsonb;
  v_day_start timestamptz;
begin
  if p_tenant_id is null or p_floor_space_id is null then
    raise exception 'floor_plan.availability.invalid_args' using errcode = '22023';
  end if;
  if p_window_start >= p_window_end then
    raise exception 'floor_plan.availability.invalid_window' using errcode = '22023';
  end if;

  select u.person_id into v_caller_person_id
    from public.users u
   where u.id = p_user_id
     and u.tenant_id = v_tenant_id;

  with child_spaces as (
    select s.id, s.name, s.type, s.capacity, s.amenities,
           s.floor_plan_polygon, s.floor_plan_render_hint
      from public.spaces s
     where s.parent_id = p_floor_space_id
       and s.tenant_id = v_tenant_id
       and s.floor_plan_polygon is not null
  ),
  overlapping as (
    select bs.space_id,
           b.id as booking_id,
           bs.start_at, bs.end_at,
           b.requester_person_id, b.host_person_id, b.booked_by_user_id
      from public.bookings b
      join public.booking_slots bs on bs.booking_id = b.id
      join child_spaces cs on cs.id = bs.space_id
     where b.tenant_id = v_tenant_id
       and bs.tenant_id = v_tenant_id
       and bs.time_range && tstzrange(p_window_start, p_window_end, '[)')
       and bs.status in ('confirmed', 'checked_in', 'pending_approval')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',           cs.id,
    'name',         cs.name,
    'type',         cs.type,
    'capacity',     cs.capacity,
    'amenities',    cs.amenities,
    'polygon',      cs.floor_plan_polygon,
    'render_hint',  cs.floor_plan_render_hint,
    'state',        case
                      when not exists (
                        select 1 from overlapping o where o.space_id = cs.id
                      ) then 'available'
                      when v_caller_person_id is not null and exists (
                        select 1 from overlapping o
                         where o.space_id = cs.id
                           and (o.requester_person_id = v_caller_person_id
                                or o.host_person_id = v_caller_person_id
                                or o.booked_by_user_id = p_user_id)
                      ) then 'mine'
                      when exists (
                        select 1 from overlapping o
                         where o.space_id = cs.id
                           and o.start_at <= p_window_start
                           and o.end_at >= p_window_end
                      ) then 'booked'
                      else 'partial'
                    end,
    'free_at',      (
                      select min(o.end_at)
                        from overlapping o
                       where o.space_id = cs.id
                         and o.end_at > now()
                    ),
    'mine_booking_id', (
                      -- Only populated when state would be 'mine' (i.e. caller
                      -- has a booking overlapping the window on this space).
                      -- Picks the latest-starting overlapping booking owned
                      -- by the caller, so the cancel/manage CTA targets the
                      -- most-recent one if there's a stacked sequence.
                      select o.booking_id
                        from overlapping o
                       where o.space_id = cs.id
                         and v_caller_person_id is not null
                         and (o.requester_person_id = v_caller_person_id
                              or o.host_person_id = v_caller_person_id
                              or o.booked_by_user_id = p_user_id)
                       order by o.start_at desc
                       limit 1
                    )
  )), '[]'::jsonb)
    into v_spaces
    from child_spaces cs;

  v_day_start := date_trunc('day', p_window_start);
  with hours as (
    select generate_series(0, 12)::int as h
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'hour', h.h + 7,
    'occupancy', (
      select case when count(*) = 0 then 0
                  else (
                    sum(case when exists (
                      select 1
                        from public.bookings b
                        join public.booking_slots bs on bs.booking_id = b.id
                       where bs.space_id = cs.id
                         and bs.tenant_id = v_tenant_id
                         and b.tenant_id = v_tenant_id
                         and bs.time_range && tstzrange(
                             v_day_start + ((h.h + 7) || ' hours')::interval,
                             v_day_start + ((h.h + 8) || ' hours')::interval,
                             '[)')
                         and bs.status in ('confirmed', 'checked_in', 'pending_approval')
                    ) then 1.0 else 0.0 end) / count(*)
                  )
             end
        from public.spaces cs
       where cs.parent_id = p_floor_space_id
         and cs.tenant_id = v_tenant_id
         and cs.floor_plan_polygon is not null
    )
  )), '[]'::jsonb)
    into v_heatmap
    from hours h;

  return jsonb_build_object(
    'floor_space_id', p_floor_space_id,
    'window', jsonb_build_object('start', p_window_start, 'end', p_window_end),
    'spaces', v_spaces,
    'crowd_heatmap', v_heatmap
  );
end;
$$;

revoke all on function public.floor_availability(uuid, uuid, timestamptz, timestamptz, uuid) from public, authenticated;
grant execute on function public.floor_availability(uuid, uuid, timestamptz, timestamptz, uuid) to service_role;

notify pgrst, 'reload schema';
