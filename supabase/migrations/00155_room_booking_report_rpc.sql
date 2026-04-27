-- 00155_room_booking_report_rpc.sql
--
-- Single-shot Postgres RPC that powers the Bookings Overview admin report
-- at /admin/room-booking-reports.
--
-- Returns one JSONB document with everything the page needs:
--   * window meta
--   * 6 KPIs (total / active / no-show / cancellation / utilization /
--     avg seat fill / services attach / rooms in scope)
--   * volume_by_day (4 series: confirmed / cancelled / no_show / completed)
--   * utilization_heatmap (dow × hour, 7 × 13 cells, 08:00–20:00 local)
--   * top_rooms (top 10 by booked hours)
--   * no_show_watchlist (last 20 no-shows in window)
--   * lead_time_buckets / duration_buckets / services_breakdown
--
-- Definitions are documented in
--   docs/superpowers/specs/2026-04-27-bookings-overview-report-design.md
--
-- A single round-trip (vs. the obvious 5-endpoint fan-out) is materially
-- faster on cold caches AND keeps every section consistent against the
-- same window snapshot — so the volume chart, KPIs, and heatmap can't
-- disagree with each other if a write lands mid-render.
--
-- The function is `stable` and runs as the caller (SECURITY INVOKER, the
-- default) so RLS still applies. Tenant scoping is enforced by the
-- explicit p_tenant_id parameter (the API resolves the current tenant
-- from the JWT before calling).

-- Covering index for the window slice (status filter + start_at).
-- The partial reservations indexes from 00129 are status-filtered, but
-- the report also needs cancelled/released/completed; this is the
-- generic version.
create index if not exists reservations_tenant_type_start_idx
  on public.reservations (tenant_id, reservation_type, start_at)
  where reservation_type = 'room';

create or replace function public.room_booking_report_overview(
  p_tenant_id   uuid,
  p_from        date,
  p_to          date,
  p_building_id uuid default null,
  p_tz          text default 'UTC'
) returns jsonb
language plpgsql
stable
as $$
declare
  v_room_ids        uuid[];
  v_rooms_in_scope  int;
  v_from_ts         timestamptz;
  v_to_ts           timestamptz;
  v_weekdays        int;
  v_bookable_hours  numeric;
  v_kpis            jsonb;
  v_volume          jsonb;
  v_heatmap         jsonb;
  v_top_rooms       jsonb;
  v_watchlist       jsonb;
  v_lead_buckets    jsonb;
  v_dur_buckets     jsonb;
  v_services_break  jsonb;
begin
  -- Input validation
  if p_from is null or p_to is null then
    raise exception 'from/to are required' using errcode = '22023';
  end if;
  if p_from > p_to then
    raise exception 'from > to' using errcode = '22023';
  end if;
  if (p_to - p_from) > 365 then
    raise exception 'window too large (> 365 days)' using errcode = '22023';
  end if;

  -- Time bounds: convert local date range to UTC timestamptz window.
  v_from_ts := (p_from::timestamp at time zone p_tz);
  v_to_ts   := ((p_to + 1)::timestamp at time zone p_tz);

  -- 1. Scope: in-tenant, reservable, active rooms — optionally
  --    restricted to a building subtree.
  if p_building_id is null then
    select coalesce(array_agg(s.id), '{}'::uuid[])
      into v_room_ids
      from public.spaces s
     where s.tenant_id  = p_tenant_id
       and s.reservable = true
       and s.active     = true
       and s.type       in ('room','meeting_room');
  else
    select coalesce(array_agg(s.id), '{}'::uuid[])
      into v_room_ids
      from public.spaces s
      join public.space_descendants(p_building_id) d(id) on d.id = s.id
     where s.tenant_id  = p_tenant_id
       and s.reservable = true
       and s.active     = true
       and s.type       in ('room','meeting_room');
  end if;

  v_rooms_in_scope := coalesce(array_length(v_room_ids, 1), 0);

  -- Weekdays in window (Mon..Fri) — drives bookable hours.
  select count(*)
    into v_weekdays
    from generate_series(p_from, p_to, interval '1 day') as gs(d)
   where extract(isodow from gs.d) between 1 and 5;

  v_bookable_hours := (v_rooms_in_scope::numeric) * 10 * (v_weekdays::numeric);

  -- Empty-scope shortcut: no rooms means every section is empty/zero.
  if v_rooms_in_scope = 0 then
    return jsonb_build_object(
      'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', (p_to - p_from + 1)),
      'kpis', jsonb_build_object(
        'total_bookings', 0, 'active_bookings', 0,
        'no_show_count', 0, 'no_show_rate', 0,
        'cancellation_count', 0, 'cancellation_rate', 0,
        'utilization', 0, 'avg_seat_fill', null,
        'services_attach_rate', 0, 'rooms_in_scope', 0
      ),
      'volume_by_day', '[]'::jsonb,
      'utilization_heatmap', '[]'::jsonb,
      'top_rooms', '[]'::jsonb,
      'no_show_watchlist', '[]'::jsonb,
      'lead_time_buckets', jsonb_build_object('same_day',0,'lt_24h',0,'lt_7d',0,'ge_7d',0),
      'duration_buckets',  jsonb_build_object('le_30m',0,'le_1h',0,'le_2h',0,'gt_2h',0),
      'services_breakdown', '{}'::jsonb
    );
  end if;

  -- 2. KPIs — single pass over reservations in window.
  with base as (
    select
      r.id, r.space_id, r.attendee_count, r.booking_bundle_id, r.check_in_required,
      r.status,
      extract(epoch from (r.effective_end_at - r.effective_start_at)) / 3600.0 as hours,
      (r.status = 'cancelled') as is_cancelled,
      (r.status in ('confirmed','checked_in','completed')) as is_active,
      (
        (r.status = 'released' and r.checked_in_at is null and r.check_in_required = true)
        or
        (r.status = 'confirmed' and r.end_at < now() and r.checked_in_at is null and r.check_in_required = true)
      ) as is_no_show
      from public.reservations r
     where r.tenant_id        = p_tenant_id
       and r.reservation_type = 'room'
       and r.status          <> 'draft'
       and r.space_id         = any(v_room_ids)
       and r.start_at        >= v_from_ts
       and r.start_at         < v_to_ts
  ),
  bundle_attach as (
    select b.id, exists(
        select 1 from public.orders o
         where o.booking_bundle_id = b.booking_bundle_id
           and o.status <> 'cancelled'
      ) as has_services
      from base b
     where b.booking_bundle_id is not null
  ),
  enriched as (
    select b.*, coalesce(ba.has_services, false) as has_services
      from base b
      left join bundle_attach ba on ba.id = b.id
  ),
  seat_fill as (
    select avg(e.attendee_count::numeric / s.capacity::numeric) as v
      from enriched e
      join public.spaces s on s.id = e.space_id
     where e.is_active
       and e.attendee_count is not null
       and s.capacity is not null
       and s.capacity > 0
  )
  select jsonb_build_object(
      'total_bookings',     count(*),
      'active_bookings',    count(*) filter (where is_active),
      'no_show_count',      count(*) filter (where is_no_show),
      'no_show_rate',
        case when count(*) filter (where check_in_required) > 0
             then round(
               (count(*) filter (where is_no_show))::numeric
               / (count(*) filter (where check_in_required))::numeric,
               4)
             else 0 end,
      'cancellation_count', count(*) filter (where is_cancelled),
      'cancellation_rate',
        case when count(*) > 0
             then round((count(*) filter (where is_cancelled))::numeric / count(*)::numeric, 4)
             else 0 end,
      'utilization',
        case when v_bookable_hours > 0
             then round(coalesce(sum(hours) filter (where is_active), 0) / v_bookable_hours, 4)
             else 0 end,
      'avg_seat_fill',      (select round(v, 4) from seat_fill),
      'services_attach_rate',
        case when count(*) > 0
             then round((count(*) filter (where has_services))::numeric / count(*)::numeric, 4)
             else 0 end,
      'rooms_in_scope',     v_rooms_in_scope
    )
    into v_kpis
    from enriched;

  -- 3. volume_by_day — gap-filled date range, 4 series.
  with base as (
    select r.status, ((r.start_at at time zone p_tz)::date) as d,
      (
        (r.status = 'released' and r.checked_in_at is null and r.check_in_required = true)
        or
        (r.status = 'confirmed' and r.end_at < now() and r.checked_in_at is null and r.check_in_required = true)
      ) as is_no_show
      from public.reservations r
     where r.tenant_id        = p_tenant_id
       and r.reservation_type = 'room'
       and r.status          <> 'draft'
       and r.space_id         = any(v_room_ids)
       and r.start_at        >= v_from_ts
       and r.start_at         < v_to_ts
  ),
  days as (
    select gs::date as d
      from generate_series(p_from, p_to, interval '1 day') as gs
  ),
  agg as (
    select
      d.d,
      count(*) filter (where b.status in ('pending_approval','confirmed','checked_in') and not b.is_no_show) as confirmed,
      count(*) filter (where b.status = 'cancelled') as cancelled,
      count(*) filter (where b.is_no_show) as no_show,
      count(*) filter (where b.status = 'completed') as completed
      from days d
      left join base b on b.d = d.d
     group by d.d
     order by d.d
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'date', to_char(d, 'YYYY-MM-DD'),
             'confirmed', confirmed,
             'cancelled', cancelled,
             'no_show',   no_show,
             'completed', completed
           ) order by d
         ), '[]'::jsonb)
    into v_volume
    from agg;

  -- 4. utilization_heatmap — for each (dow, hour) cell in [Mon..Sun] × [08..20]:
  --    sum across all matching local hour slots in window: distinct rooms occupied.
  --    Denominator = rooms_in_scope × occurrences_of_that_dow.
  with grid as (
    select gs as slot_start
      from generate_series(date_trunc('hour', v_from_ts), v_to_ts - interval '1 hour', interval '1 hour') as gs
     where extract(hour from gs at time zone p_tz)::int between 8 and 20
  ),
  busy as (
    select
      g.slot_start,
      extract(isodow from g.slot_start at time zone p_tz)::int as dow,
      extract(hour   from g.slot_start at time zone p_tz)::int as hour,
      count(distinct r.space_id) as occupied_rooms
      from grid g
      left join public.reservations r
        on r.tenant_id        = p_tenant_id
       and r.reservation_type = 'room'
       and r.space_id         = any(v_room_ids)
       and r.status           in ('confirmed','checked_in','completed')
       and r.effective_start_at < g.slot_start + interval '1 hour'
       and r.effective_end_at   > g.slot_start
     group by g.slot_start
  ),
  agg as (
    select dow, hour, sum(occupied_rooms)::int as room_hours_busy, count(*)::int as slots
      from busy
     group by dow, hour
  ),
  day_occurrences as (
    select extract(isodow from gs)::int as dow, count(*)::int as occurrences
      from generate_series(p_from, p_to, interval '1 day') as gs
     group by 1
  ),
  cells as (
    select dow, hour
      from generate_series(1, 7) as dow
      cross join generate_series(8, 20) as hour
  ),
  joined as (
    select
      c.dow,
      c.hour,
      coalesce(a.room_hours_busy, 0) as occupied_rooms,
      coalesce(d.occurrences, 0) * v_rooms_in_scope as denom
      from cells c
      left join agg a on a.dow = c.dow and a.hour = c.hour
      left join day_occurrences d on d.dow = c.dow
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'dow', dow,
             'hour', hour,
             'occupied_rooms', occupied_rooms,
             'rooms_in_scope', v_rooms_in_scope,
             'utilization',
               case when denom > 0
                    then round(occupied_rooms::numeric / denom::numeric, 4)
                    else 0 end
           ) order by dow, hour
         ), '[]'::jsonb)
    into v_heatmap
    from joined;

  -- 5. top_rooms — top 10 by booked hours among rooms in scope.
  with base as (
    select r.space_id, r.status, r.booking_bundle_id, r.check_in_required, r.checked_in_at, r.end_at,
      extract(epoch from (r.effective_end_at - r.effective_start_at)) / 3600.0 as hours,
      (
        (r.status = 'released' and r.checked_in_at is null and r.check_in_required = true)
        or
        (r.status = 'confirmed' and r.end_at < now() and r.checked_in_at is null and r.check_in_required = true)
      ) as is_no_show
      from public.reservations r
     where r.tenant_id        = p_tenant_id
       and r.reservation_type = 'room'
       and r.status          <> 'draft'
       and r.space_id         = any(v_room_ids)
       and r.start_at        >= v_from_ts
       and r.start_at         < v_to_ts
  ),
  per_room as (
    select
      b.space_id,
      count(*) as bookings,
      sum(b.hours) filter (where b.status in ('confirmed','checked_in','completed')) as booked_hours,
      count(*) filter (where b.is_no_show) as no_show_count,
      count(*) filter (where b.check_in_required) as eligible,
      count(*) filter (where b.booking_bundle_id is not null and exists(
        select 1 from public.orders o
         where o.booking_bundle_id = b.booking_bundle_id
           and o.status <> 'cancelled'
      )) as svc_count
      from base b
     group by b.space_id
  ),
  ranked as (
    select * from per_room order by coalesce(booked_hours, 0) desc nulls last limit 10
  ),
  with_building as (
    select
      r.*,
      s.name as room_name,
      bld.name as building_name
      from ranked r
      join public.spaces s on s.id = r.space_id
      left join lateral (
        with recursive up as (
          select id, parent_id, type, name, 1 as depth from public.spaces where id = s.parent_id
          union all
          select sp.id, sp.parent_id, sp.type, sp.name, u.depth + 1
            from public.spaces sp join up u on sp.id = u.parent_id where u.depth < 6
        )
        select name from up where type = 'building' limit 1
      ) bld on true
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'space_id',     wb.space_id,
             'name',         wb.room_name,
             'building_name', wb.building_name,
             'bookings',     wb.bookings,
             'booked_hours', round(coalesce(wb.booked_hours, 0)::numeric, 2),
             'no_show_rate', case when wb.eligible > 0
                                  then round(wb.no_show_count::numeric / wb.eligible::numeric, 4)
                                  else 0 end,
             'services_rate', case when wb.bookings > 0
                                   then round(wb.svc_count::numeric / wb.bookings::numeric, 4)
                                   else 0 end
           )
           order by coalesce(wb.booked_hours, 0) desc
         ), '[]'::jsonb)
    into v_top_rooms
    from with_building wb;

  -- 6. no_show_watchlist — last 20 in window, newest first.
  with watchlist_base as (
    select
      r.id, r.space_id, r.start_at, r.end_at, r.released_at, r.attendee_count,
      r.requester_person_id, r.host_person_id
      from public.reservations r
     where r.tenant_id        = p_tenant_id
       and r.reservation_type = 'room'
       and r.space_id         = any(v_room_ids)
       and r.start_at        >= v_from_ts
       and r.start_at         < v_to_ts
       and r.check_in_required = true
       and r.checked_in_at is null
       and (
         r.status = 'released'
         or (r.status = 'confirmed' and r.end_at < now())
       )
     order by r.start_at desc
     limit 20
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'reservation_id', wb.id,
             'room_name',      s.name,
             'building_name',  bld.name,
             'organizer_name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
             'organizer_email', p.email,
             'start_at',        wb.start_at,
             'end_at',          wb.end_at,
             'released_at',     wb.released_at,
             'attendee_count',  wb.attendee_count
           ) order by wb.start_at desc
         ), '[]'::jsonb)
    into v_watchlist
    from watchlist_base wb
    join public.spaces s on s.id = wb.space_id
    left join public.persons p on p.id = coalesce(wb.host_person_id, wb.requester_person_id)
    left join lateral (
      with recursive up as (
        select id, parent_id, type, name, 1 as depth from public.spaces where id = s.parent_id
        union all
        select sp.id, sp.parent_id, sp.type, sp.name, u.depth + 1
          from public.spaces sp join up u on sp.id = u.parent_id where u.depth < 6
      )
      select name from up where type = 'building' limit 1
    ) bld on true;

  -- 7. lead_time + duration buckets.
  with base as (
    select r.created_at, r.start_at, r.effective_start_at, r.effective_end_at
      from public.reservations r
     where r.tenant_id        = p_tenant_id
       and r.reservation_type = 'room'
       and r.status          <> 'draft'
       and r.space_id         = any(v_room_ids)
       and r.start_at        >= v_from_ts
       and r.start_at         < v_to_ts
  ),
  with_buckets as (
    select
      extract(epoch from (start_at - created_at)) / 3600.0 as lead_hours,
      extract(epoch from (effective_end_at - effective_start_at)) / 60.0 as duration_min
      from base
  )
  select
    jsonb_build_object(
      'same_day', count(*) filter (where lead_hours <  2),
      'lt_24h',   count(*) filter (where lead_hours >= 2  and lead_hours <  24),
      'lt_7d',    count(*) filter (where lead_hours >= 24 and lead_hours <  168),
      'ge_7d',    count(*) filter (where lead_hours >= 168)
    ),
    jsonb_build_object(
      'le_30m', count(*) filter (where duration_min <= 30),
      'le_1h',  count(*) filter (where duration_min >  30 and duration_min <=  60),
      'le_2h',  count(*) filter (where duration_min >  60 and duration_min <= 120),
      'gt_2h',  count(*) filter (where duration_min > 120)
    )
    into v_lead_buckets, v_dur_buckets
    from with_buckets;

  -- 8. services_breakdown — bookings with services, by bundle_type.
  with base as (
    select r.booking_bundle_id
      from public.reservations r
     where r.tenant_id        = p_tenant_id
       and r.reservation_type = 'room'
       and r.status          <> 'draft'
       and r.space_id         = any(v_room_ids)
       and r.start_at        >= v_from_ts
       and r.start_at         < v_to_ts
       and r.booking_bundle_id is not null
  ),
  with_bundle as (
    select bb.bundle_type
      from base b
      join public.booking_bundles bb on bb.id = b.booking_bundle_id
     where exists(
        select 1 from public.orders o
         where o.booking_bundle_id = bb.id
           and o.status <> 'cancelled'
      )
  )
  select coalesce(jsonb_object_agg(bundle_type, n), '{}'::jsonb)
    into v_services_break
    from (
      select bundle_type, count(*) as n
        from with_bundle
       group by bundle_type
    ) t;

  return jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', (p_to - p_from + 1)),
    'kpis', coalesce(v_kpis, '{}'::jsonb),
    'volume_by_day', coalesce(v_volume, '[]'::jsonb),
    'utilization_heatmap', coalesce(v_heatmap, '[]'::jsonb),
    'top_rooms', coalesce(v_top_rooms, '[]'::jsonb),
    'no_show_watchlist', coalesce(v_watchlist, '[]'::jsonb),
    'lead_time_buckets', coalesce(v_lead_buckets, jsonb_build_object('same_day',0,'lt_24h',0,'lt_7d',0,'ge_7d',0)),
    'duration_buckets',  coalesce(v_dur_buckets,  jsonb_build_object('le_30m',0,'le_1h',0,'le_2h',0,'gt_2h',0)),
    'services_breakdown', coalesce(v_services_break, '{}'::jsonb)
  );
end
$$;

comment on function public.room_booking_report_overview(uuid, date, date, uuid, text) is
  'Bookings overview report. Returns KPIs, volume-by-day, utilization heatmap, top rooms, no-show watchlist, lead-time/duration buckets, and services breakdown for a tenant + window. See docs/superpowers/specs/2026-04-27-bookings-overview-report-design.md.';

grant execute on function public.room_booking_report_overview(uuid, date, date, uuid, text) to authenticated;

notify pgrst, 'reload schema';
