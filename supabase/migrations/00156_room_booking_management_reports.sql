-- 00156_room_booking_management_reports.sql
--
-- Four management-focused report RPCs that complement the bookings overview
-- (00155) for workplace / facilities admins:
--
--   1. room_booking_utilization_report   — per-room utilization rankings,
--                                          capacity-fit, building rollup
--   2. room_booking_no_shows_report      — no-show & cancellation deep-dive,
--                                          top organizers, time-to-cancel
--   3. room_booking_services_report      — services attach + costs by bundle
--                                          type, top items, top cost centers
--   4. room_booking_demand_report        — peak-demand patterns, contention,
--                                          daily volume + creation lead time
--
-- All RPCs follow the overview's contract: stable, security invoker, single
-- JSONB document. Inputs are tenant + window + optional building filter +
-- IANA timezone (for local-clock bucketing).
--
-- Spec: docs/superpowers/specs/2026-04-27-bookings-overview-report-design.md
-- (extension; same patterns apply).

-- ===========================================================================
-- 1. UTILIZATION
-- ===========================================================================

create or replace function public.room_booking_utilization_report(
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
  v_per_room_bookable_hours numeric;  -- per individual room, per window
  v_kpis            jsonb;
  v_rooms           jsonb;
  v_by_building     jsonb;
  v_capacity_fit    jsonb;
begin
  if p_from is null or p_to is null then raise exception 'from/to required' using errcode='22023'; end if;
  if p_from > p_to then raise exception 'from > to' using errcode='22023'; end if;
  if (p_to - p_from) > 365 then raise exception 'window too large' using errcode='22023'; end if;

  v_from_ts := (p_from::timestamp at time zone p_tz);
  v_to_ts   := ((p_to + 1)::timestamp at time zone p_tz);

  if p_building_id is null then
    select coalesce(array_agg(s.id), '{}'::uuid[]) into v_room_ids
      from public.spaces s
     where s.tenant_id = p_tenant_id and s.reservable and s.active
       and s.type in ('room','meeting_room');
  else
    select coalesce(array_agg(s.id), '{}'::uuid[]) into v_room_ids
      from public.spaces s
      join public.space_descendants(p_building_id) d(id) on d.id = s.id
     where s.tenant_id = p_tenant_id and s.reservable and s.active
       and s.type in ('room','meeting_room');
  end if;
  v_rooms_in_scope := coalesce(array_length(v_room_ids, 1), 0);

  select count(*) into v_weekdays
    from generate_series(p_from, p_to, interval '1 day') gs(d)
   where extract(isodow from gs.d) between 1 and 5;
  v_per_room_bookable_hours := 10::numeric * v_weekdays;

  if v_rooms_in_scope = 0 then
    return jsonb_build_object(
      'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1),
      'kpis', jsonb_build_object(
        'rooms_in_scope', 0, 'avg_utilization', 0,
        'underused_count', 0, 'overused_count', 0,
        'avg_attendees', null, 'avg_capacity_fit', null
      ),
      'rooms', '[]'::jsonb,
      'by_building', '[]'::jsonb,
      'capacity_fit_buckets', jsonb_build_object('right_sized',0,'oversized',0,'undersized',0,'unknown',0)
    );
  end if;

  -- Per-room aggregation
  with base as (
    select r.space_id, r.attendee_count, r.status,
      extract(epoch from (r.effective_end_at - r.effective_start_at)) / 3600.0 as hours,
      (r.status = 'released' and r.checked_in_at is null and r.check_in_required = true) as is_no_show
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  per_room_agg as (
    select
      b.space_id,
      count(*) as bookings,
      sum(b.hours) filter (where b.status in ('confirmed','checked_in','completed')) as booked_hours,
      avg(b.attendee_count::numeric) filter (where b.attendee_count is not null) as avg_attendees,
      count(*) filter (where b.is_no_show) as no_show_count,
      count(*) filter (where b.status not in ('cancelled')) as eligible
      from base b
     group by b.space_id
  ),
  rooms_full as (
    select
      s.id as space_id, s.name, s.capacity,
      coalesce(pra.bookings, 0)            as bookings,
      coalesce(pra.booked_hours, 0)        as booked_hours,
      pra.avg_attendees,
      coalesce(pra.no_show_count, 0)       as no_show_count,
      coalesce(pra.eligible, 0)            as eligible,
      case when v_per_room_bookable_hours > 0
           then coalesce(pra.booked_hours, 0) / v_per_room_bookable_hours
           else 0 end as utilization,
      case when s.capacity is not null and s.capacity > 0 and pra.avg_attendees is not null
           then pra.avg_attendees / s.capacity else null end as capacity_fit
      from unnest(v_room_ids) u(space_id)
      join public.spaces s on s.id = u.space_id
      left join per_room_agg pra on pra.space_id = u.space_id
  ),
  rooms_with_building as (
    select rf.*,
      (
        with recursive up as (
          select id, parent_id, type, name, 1 as depth from public.spaces where id = (select parent_id from public.spaces where id = rf.space_id)
          union all
          select sp.id, sp.parent_id, sp.type, sp.name, u.depth+1 from public.spaces sp join up u on sp.id = u.parent_id where u.depth < 6
        )
        select jsonb_build_object('id', id, 'name', name) from up where type = 'building' limit 1
      ) as building
      from rooms_full rf
  )
  select
    -- KPIs
    jsonb_build_object(
      'rooms_in_scope', v_rooms_in_scope,
      'avg_utilization', round(avg(utilization)::numeric, 4),
      'underused_count', count(*) filter (where utilization < 0.20),
      'overused_count',  count(*) filter (where utilization > 0.85),
      'avg_attendees',   round(avg(avg_attendees)::numeric, 2),
      'avg_capacity_fit', round(avg(capacity_fit)::numeric, 4)
    ),
    -- rooms list
    coalesce(jsonb_agg(jsonb_build_object(
      'space_id', space_id,
      'name', name,
      'building_name', building->>'name',
      'building_id',   building->>'id',
      'capacity', capacity,
      'bookings', bookings,
      'booked_hours', round(booked_hours::numeric, 2),
      'utilization', round(utilization::numeric, 4),
      'avg_attendees', round(avg_attendees::numeric, 2),
      'capacity_fit',  round(capacity_fit::numeric, 4),
      'no_show_count', no_show_count
    ) order by utilization desc), '[]'::jsonb)
    into v_kpis, v_rooms
    from rooms_with_building;

  -- Building rollup
  with base as (
    select r.space_id,
      extract(epoch from (r.effective_end_at - r.effective_start_at)) / 3600.0 as hours,
      r.status
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  rooms_with_building as (
    select s.id as space_id,
      (
        with recursive up as (
          select id, parent_id, type, name from public.spaces where id = s.parent_id
          union all
          select sp.id, sp.parent_id, sp.type, sp.name from public.spaces sp join up u on sp.id = u.parent_id
        )
        select jsonb_build_object('id', id, 'name', name) from up where type = 'building' limit 1
      ) as building
      from public.spaces s where s.id = any(v_room_ids)
  ),
  per_building as (
    select
      coalesce(rwb.building->>'id', 'no_building') as building_id,
      coalesce(rwb.building->>'name', '— No building —') as building_name,
      count(distinct rwb.space_id) as room_count,
      count(b.space_id) as bookings,
      coalesce(sum(b.hours) filter (where b.status in ('confirmed','checked_in','completed')), 0) as booked_hours
      from rooms_with_building rwb
      left join base b on b.space_id = rwb.space_id
     group by rwb.building->>'id', rwb.building->>'name'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'building_id', building_id,
      'building_name', building_name,
      'room_count', room_count,
      'bookings', bookings,
      'booked_hours', round(booked_hours::numeric, 2),
      'utilization',
        case when room_count > 0 and v_per_room_bookable_hours > 0
             then round(booked_hours::numeric / (room_count::numeric * v_per_room_bookable_hours), 4)
             else 0 end
    ) order by booked_hours desc), '[]'::jsonb)
    into v_by_building
    from per_building;

  -- Capacity-fit buckets
  with base as (
    select r.attendee_count, s.capacity
      from public.reservations r
      join public.spaces s on s.id = r.space_id
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status in ('confirmed','checked_in','completed')
       and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  )
  select jsonb_build_object(
      'right_sized', count(*) filter (where attendee_count is not null and capacity > 0
                                        and attendee_count::numeric / capacity::numeric between 0.6 and 1.0),
      'oversized',   count(*) filter (where attendee_count is not null and capacity > 0
                                        and attendee_count::numeric / capacity::numeric < 0.6),
      'undersized',  count(*) filter (where attendee_count is not null and capacity > 0
                                        and attendee_count::numeric / capacity::numeric > 1.0),
      'unknown',     count(*) filter (where attendee_count is null or capacity is null or capacity = 0)
    )
    into v_capacity_fit
    from base;

  return jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1),
    'kpis',  v_kpis,
    'rooms', v_rooms,
    'by_building', v_by_building,
    'capacity_fit_buckets', v_capacity_fit
  );
end
$$;

comment on function public.room_booking_utilization_report(uuid, date, date, uuid, text) is
  'Per-room utilization, capacity fit, and building rollup. Bookable hours = 10h × weekdays per room.';

grant execute on function public.room_booking_utilization_report(uuid, date, date, uuid, text) to authenticated;

-- ===========================================================================
-- 2. NO-SHOWS & CANCELLATIONS
-- ===========================================================================

create or replace function public.room_booking_no_shows_report(
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
  v_room_ids       uuid[];
  v_from_ts        timestamptz;
  v_to_ts          timestamptz;
  v_kpis           jsonb;
  v_trend          jsonb;
  v_top_no_show    jsonb;
  v_top_cancel     jsonb;
  v_ttc_buckets    jsonb;
  v_watchlist      jsonb;
begin
  if p_from is null or p_to is null then raise exception 'from/to required' using errcode='22023'; end if;
  if p_from > p_to then raise exception 'from > to' using errcode='22023'; end if;
  if (p_to - p_from) > 365 then raise exception 'window too large' using errcode='22023'; end if;
  v_from_ts := (p_from::timestamp at time zone p_tz);
  v_to_ts   := ((p_to + 1)::timestamp at time zone p_tz);

  if p_building_id is null then
    select coalesce(array_agg(s.id), '{}'::uuid[]) into v_room_ids
      from public.spaces s
     where s.tenant_id = p_tenant_id and s.reservable and s.active
       and s.type in ('room','meeting_room');
  else
    select coalesce(array_agg(s.id), '{}'::uuid[]) into v_room_ids
      from public.spaces s
      join public.space_descendants(p_building_id) d(id) on d.id = s.id
     where s.tenant_id = p_tenant_id and s.reservable and s.active
       and s.type in ('room','meeting_room');
  end if;

  if coalesce(array_length(v_room_ids, 1), 0) = 0 then
    return jsonb_build_object(
      'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1),
      'kpis', jsonb_build_object(
        'total_no_shows', 0, 'total_cancellations', 0,
        'no_show_rate', 0, 'cancellation_rate', 0,
        'avg_time_to_cancel_hours', null
      ),
      'trend_by_day', '[]'::jsonb,
      'top_no_show_organizers', '[]'::jsonb,
      'top_cancellation_organizers', '[]'::jsonb,
      'time_to_cancel_buckets', jsonb_build_object('lt_1h',0,'lt_24h',0,'lt_7d',0,'ge_7d',0,'after_start',0),
      'watchlist', '[]'::jsonb
    );
  end if;

  -- Base set
  with base as (
    select
      r.id, r.space_id, r.host_person_id, r.requester_person_id,
      r.start_at, r.end_at, r.created_at, r.updated_at, r.status,
      r.checked_in_at, r.released_at, r.check_in_required, r.attendee_count,
      (
        (r.status = 'released' and r.checked_in_at is null and r.check_in_required = true)
        or
        (r.status = 'confirmed' and r.end_at < now() and r.checked_in_at is null and r.check_in_required = true)
      ) as is_no_show,
      (r.status = 'cancelled') as is_cancelled
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  )
  select
    jsonb_build_object(
      'total_no_shows',      count(*) filter (where is_no_show),
      'total_cancellations', count(*) filter (where is_cancelled),
      'total_eligible',      count(*) filter (where check_in_required),
      'no_show_rate',
        case when count(*) filter (where check_in_required) > 0
             then round((count(*) filter (where is_no_show))::numeric
                      / (count(*) filter (where check_in_required))::numeric, 4)
             else 0 end,
      'cancellation_rate',
        case when count(*) > 0
             then round((count(*) filter (where is_cancelled))::numeric / count(*)::numeric, 4)
             else 0 end,
      'avg_time_to_cancel_hours', (
        select round(avg(extract(epoch from (start_at - updated_at)) / 3600.0)::numeric, 2)
          from base where is_cancelled and updated_at < start_at
      )
    )
    into v_kpis
    from base;

  -- Trend (by local day)
  with base as (
    select ((r.start_at at time zone p_tz)::date) as d,
      (
        (r.status = 'released' and r.checked_in_at is null and r.check_in_required = true)
        or
        (r.status = 'confirmed' and r.end_at < now() and r.checked_in_at is null and r.check_in_required = true)
      ) as is_no_show,
      (r.status = 'cancelled') as is_cancelled
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  days as (
    select gs::date as d from generate_series(p_from, p_to, interval '1 day') gs
  ),
  agg as (
    select d.d,
      count(*) filter (where b.is_no_show)   as no_shows,
      count(*) filter (where b.is_cancelled) as cancellations
      from days d left join base b on b.d = d.d
     group by d.d order by d.d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', to_char(d, 'YYYY-MM-DD'),
    'no_shows', no_shows,
    'cancellations', cancellations
  ) order by d), '[]'::jsonb)
    into v_trend from agg;

  -- Top no-show organizers
  with base as (
    select coalesce(r.host_person_id, r.requester_person_id) as person_id,
      (
        (r.status = 'released' and r.checked_in_at is null and r.check_in_required = true)
        or
        (r.status = 'confirmed' and r.end_at < now() and r.checked_in_at is null and r.check_in_required = true)
      ) as is_no_show
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
       and r.check_in_required = true
  ),
  per_org as (
    select person_id,
      count(*) filter (where is_no_show) as no_show_count,
      count(*) as total
      from base where person_id is not null
     group by person_id
  ),
  ranked as (
    select * from per_org where no_show_count > 0
     order by no_show_count desc, (no_show_count::numeric / total::numeric) desc
     limit 10
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'person_id', r.person_id,
      'name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
      'email', p.email,
      'no_show_count', r.no_show_count,
      'total', r.total,
      'rate', round(r.no_show_count::numeric / r.total::numeric, 4)
    ) order by r.no_show_count desc), '[]'::jsonb)
    into v_top_no_show
    from ranked r left join public.persons p on p.id = r.person_id;

  -- Top cancellation organizers
  with base as (
    select coalesce(r.host_person_id, r.requester_person_id) as person_id,
      (r.status = 'cancelled') as is_cancelled
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  per_org as (
    select person_id,
      count(*) filter (where is_cancelled) as cancel_count,
      count(*) as total
      from base where person_id is not null
     group by person_id
  ),
  ranked as (
    select * from per_org where cancel_count > 0
     order by cancel_count desc
     limit 10
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'person_id', r.person_id,
      'name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
      'email', p.email,
      'cancel_count', r.cancel_count,
      'total', r.total,
      'rate', round(r.cancel_count::numeric / r.total::numeric, 4)
    ) order by r.cancel_count desc), '[]'::jsonb)
    into v_top_cancel
    from ranked r left join public.persons p on p.id = r.person_id;

  -- Time-to-cancel buckets (using updated_at as proxy)
  with base as (
    select r.start_at, r.updated_at
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status = 'cancelled'
       and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  with_lead as (
    select extract(epoch from (start_at - updated_at)) / 3600.0 as hrs from base
  )
  select jsonb_build_object(
      'lt_1h',       count(*) filter (where hrs >= 0    and hrs <  1),
      'lt_24h',      count(*) filter (where hrs >= 1    and hrs <  24),
      'lt_7d',       count(*) filter (where hrs >= 24   and hrs < 168),
      'ge_7d',       count(*) filter (where hrs >= 168),
      'after_start', count(*) filter (where hrs <  0)
    )
    into v_ttc_buckets from with_lead;

  -- Watchlist
  with watchlist_base as (
    select r.id, r.space_id, r.start_at, r.end_at, r.released_at, r.attendee_count,
      coalesce(r.host_person_id, r.requester_person_id) as person_id
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
       and r.check_in_required = true and r.checked_in_at is null
       and (r.status = 'released' or (r.status = 'confirmed' and r.end_at < now()))
     order by r.start_at desc
     limit 20
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'reservation_id', wb.id,
      'room_name', s.name,
      'organizer_name', trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
      'organizer_email', p.email,
      'start_at', wb.start_at,
      'released_at', wb.released_at,
      'attendee_count', wb.attendee_count
    ) order by wb.start_at desc), '[]'::jsonb)
    into v_watchlist
    from watchlist_base wb
    join public.spaces s on s.id = wb.space_id
    left join public.persons p on p.id = wb.person_id;

  return jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1),
    'kpis', v_kpis,
    'trend_by_day', v_trend,
    'top_no_show_organizers', v_top_no_show,
    'top_cancellation_organizers', v_top_cancel,
    'time_to_cancel_buckets', v_ttc_buckets,
    'watchlist', v_watchlist
  );
end
$$;

comment on function public.room_booking_no_shows_report(uuid, date, date, uuid, text) is
  'No-show & cancellation deep-dive: KPIs, daily trend, top organizers, time-to-cancel histogram, recent watchlist.';

grant execute on function public.room_booking_no_shows_report(uuid, date, date, uuid, text) to authenticated;

-- ===========================================================================
-- 3. SERVICES & COSTS
-- ===========================================================================

create or replace function public.room_booking_services_report(
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
  v_room_ids       uuid[];
  v_from_ts        timestamptz;
  v_to_ts          timestamptz;
  v_kpis           jsonb;
  v_by_type        jsonb;
  v_top_items      jsonb;
  v_by_cc          jsonb;
  v_trend          jsonb;
begin
  if p_from is null or p_to is null then raise exception 'from/to required' using errcode='22023'; end if;
  if p_from > p_to then raise exception 'from > to' using errcode='22023'; end if;
  if (p_to - p_from) > 365 then raise exception 'window too large' using errcode='22023'; end if;
  v_from_ts := (p_from::timestamp at time zone p_tz);
  v_to_ts   := ((p_to + 1)::timestamp at time zone p_tz);

  if p_building_id is null then
    select coalesce(array_agg(s.id), '{}'::uuid[]) into v_room_ids
      from public.spaces s
     where s.tenant_id = p_tenant_id and s.reservable and s.active
       and s.type in ('room','meeting_room');
  else
    select coalesce(array_agg(s.id), '{}'::uuid[]) into v_room_ids
      from public.spaces s
      join public.space_descendants(p_building_id) d(id) on d.id = s.id
     where s.tenant_id = p_tenant_id and s.reservable and s.active
       and s.type in ('room','meeting_room');
  end if;

  -- The set of bookings in the window
  with base as (
    select r.id as reservation_id, r.booking_bundle_id,
      ((r.start_at at time zone p_tz)::date) as start_date
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  bundles_active as (
    select distinct b.booking_bundle_id
      from base b
     where b.booking_bundle_id is not null
       and exists (select 1 from public.orders o
                    where o.booking_bundle_id = b.booking_bundle_id
                      and o.status <> 'cancelled')
  ),
  total_costs as (
    select coalesce(sum(oli.line_total), 0) as total_cost,
           count(distinct o.id) as order_count
      from bundles_active ba
      join public.orders o on o.booking_bundle_id = ba.booking_bundle_id and o.status <> 'cancelled'
      left join public.order_line_items oli
        on oli.order_id = o.id and oli.fulfillment_status <> 'cancelled'
  ),
  attached_count as (
    select count(distinct b.reservation_id) as bookings_with_services,
           count(distinct b.reservation_id) filter (where exists(
             select 1 from bundles_active ba where ba.booking_bundle_id = b.booking_bundle_id
           )) as actually_with_services
      from base b
  )
  select jsonb_build_object(
      'total_bookings',
        (select count(*) from base),
      'bundles_with_services',
        (select count(*) from bundles_active),
      'bookings_with_services',
        (select count(distinct b.reservation_id)
           from base b
           join bundles_active ba on ba.booking_bundle_id = b.booking_bundle_id),
      'attach_rate',
        case when (select count(*) from base) > 0
             then round(
               (select count(distinct b.reservation_id)::numeric from base b
                  join bundles_active ba on ba.booking_bundle_id = b.booking_bundle_id)
               / (select count(*)::numeric from base), 4)
             else 0 end,
      'total_orders',         (select order_count from total_costs),
      'total_estimated_cost', (select round(total_cost, 2) from total_costs),
      'avg_cost_per_serviced_booking',
        case when (select count(*) from bundles_active) > 0
             then round((select total_cost from total_costs) / (select count(*) from bundles_active), 2)
             else 0 end
    ) into v_kpis;

  -- By bundle type
  with base as (
    select r.id as reservation_id, r.booking_bundle_id
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
       and r.booking_bundle_id is not null
  ),
  by_bt as (
    select bb.bundle_type,
      count(distinct b.reservation_id) as bookings,
      coalesce(sum(oli.line_total), 0) as est_cost,
      count(distinct o.id) as orders
      from base b
      join public.booking_bundles bb on bb.id = b.booking_bundle_id
      left join public.orders o on o.booking_bundle_id = bb.id and o.status <> 'cancelled'
      left join public.order_line_items oli on oli.order_id = o.id and oli.fulfillment_status <> 'cancelled'
     group by bb.bundle_type
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'bundle_type', bundle_type,
      'bookings', bookings,
      'orders', orders,
      'est_cost', round(est_cost::numeric, 2)
    ) order by bookings desc), '[]'::jsonb)
    into v_by_type from by_bt;

  -- Top catalog items (by cost)
  with reservation_orders as (
    select distinct o.id as order_id
      from public.reservations r
      join public.booking_bundles bb on bb.id = r.booking_bundle_id
      join public.orders o on o.booking_bundle_id = bb.id and o.status <> 'cancelled'
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  per_item as (
    select oli.catalog_item_id,
      count(*) as line_count,
      sum(oli.quantity) as total_qty,
      sum(oli.line_total) as est_cost
      from reservation_orders ro
      join public.order_line_items oli on oli.order_id = ro.order_id
     where oli.fulfillment_status <> 'cancelled'
     group by oli.catalog_item_id
     order by sum(oli.line_total) desc nulls last
     limit 10
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'catalog_item_id', pi.catalog_item_id,
      'name', ci.name,
      'line_count', pi.line_count,
      'total_qty',  pi.total_qty,
      'est_cost',   round(coalesce(pi.est_cost, 0)::numeric, 2)
    ) order by coalesce(pi.est_cost, 0) desc), '[]'::jsonb)
    into v_top_items
    from per_item pi
    left join public.catalog_items ci on ci.id = pi.catalog_item_id;

  -- By cost center
  with base as (
    select r.id as reservation_id, bb.cost_center_id, bb.id as bundle_id
      from public.reservations r
      join public.booking_bundles bb on bb.id = r.booking_bundle_id
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
       and bb.cost_center_id is not null
  ),
  per_cc as (
    select b.cost_center_id,
      count(distinct b.reservation_id) as bookings,
      coalesce(sum(oli.line_total), 0) as est_cost
      from base b
      left join public.orders o on o.booking_bundle_id = b.bundle_id and o.status <> 'cancelled'
      left join public.order_line_items oli on oli.order_id = o.id and oli.fulfillment_status <> 'cancelled'
     group by b.cost_center_id
     order by coalesce(sum(oli.line_total), 0) desc
     limit 10
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'cost_center_id', pc.cost_center_id,
      'code', cc.code,
      'name', cc.name,
      'bookings', pc.bookings,
      'est_cost', round(pc.est_cost::numeric, 2)
    ) order by pc.est_cost desc), '[]'::jsonb)
    into v_by_cc
    from per_cc pc
    left join public.cost_centers cc on cc.id = pc.cost_center_id;

  -- Daily trend (services-attached bookings + cost)
  with base as (
    select ((r.start_at at time zone p_tz)::date) as d, r.booking_bundle_id
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
       and r.booking_bundle_id is not null
  ),
  bundle_costs as (
    select b.d, b.booking_bundle_id, coalesce(sum(oli.line_total), 0) as cost
      from base b
      left join public.orders o on o.booking_bundle_id = b.booking_bundle_id and o.status <> 'cancelled'
      left join public.order_line_items oli on oli.order_id = o.id and oli.fulfillment_status <> 'cancelled'
     where exists(select 1 from public.orders o2
                   where o2.booking_bundle_id = b.booking_bundle_id and o2.status <> 'cancelled')
     group by b.d, b.booking_bundle_id
  ),
  days as (select gs::date as d from generate_series(p_from, p_to, interval '1 day') gs),
  agg as (
    select d.d,
      count(distinct bc.booking_bundle_id) as serviced_bundles,
      coalesce(sum(bc.cost), 0) as cost
      from days d left join bundle_costs bc on bc.d = d.d
     group by d.d order by d.d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', to_char(d, 'YYYY-MM-DD'),
    'serviced_bundles', serviced_bundles,
    'est_cost', round(cost::numeric, 2)
  ) order by d), '[]'::jsonb)
    into v_trend from agg;

  return jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1),
    'kpis', coalesce(v_kpis, '{}'::jsonb),
    'by_bundle_type', v_by_type,
    'top_catalog_items', v_top_items,
    'by_cost_center', v_by_cc,
    'trend_by_day', v_trend
  );
end
$$;

comment on function public.room_booking_services_report(uuid, date, date, uuid, text) is
  'Services + cost report: KPIs, by bundle type, top catalog items, by cost center, daily cost trend.';

grant execute on function public.room_booking_services_report(uuid, date, date, uuid, text) to authenticated;

-- ===========================================================================
-- 4. DEMAND & CONTENTION
-- ===========================================================================

create or replace function public.room_booking_demand_report(
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
  v_kpis            jsonb;
  v_dayhour         jsonb;
  v_lead_buckets    jsonb;
  v_top_contended   jsonb;
  v_daily           jsonb;
begin
  if p_from is null or p_to is null then raise exception 'from/to required' using errcode='22023'; end if;
  if p_from > p_to then raise exception 'from > to' using errcode='22023'; end if;
  if (p_to - p_from) > 365 then raise exception 'window too large' using errcode='22023'; end if;
  v_from_ts := (p_from::timestamp at time zone p_tz);
  v_to_ts   := ((p_to + 1)::timestamp at time zone p_tz);

  if p_building_id is null then
    select coalesce(array_agg(s.id), '{}'::uuid[]) into v_room_ids
      from public.spaces s
     where s.tenant_id = p_tenant_id and s.reservable and s.active
       and s.type in ('room','meeting_room');
  else
    select coalesce(array_agg(s.id), '{}'::uuid[]) into v_room_ids
      from public.spaces s
      join public.space_descendants(p_building_id) d(id) on d.id = s.id
     where s.tenant_id = p_tenant_id and s.reservable and s.active
       and s.type in ('room','meeting_room');
  end if;
  v_rooms_in_scope := coalesce(array_length(v_room_ids, 1), 0);

  if v_rooms_in_scope = 0 then
    return jsonb_build_object(
      'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1),
      'kpis', jsonb_build_object(
        'total_bookings', 0, 'peak_hour_local', null, 'peak_dow', null,
        'avg_bookings_per_business_day', 0, 'rooms_in_scope', 0
      ),
      'demand_by_hour_dow', '[]'::jsonb,
      'creation_lead_buckets', jsonb_build_object('same_day',0,'lt_24h',0,'lt_7d',0,'ge_7d',0),
      'top_contended_rooms', '[]'::jsonb,
      'demand_by_day', '[]'::jsonb
    );
  end if;

  -- Demand by (dow, hour) — count of room-hour-slots booked
  with grid as (
    select gs as slot_start
      from generate_series(date_trunc('hour', v_from_ts), v_to_ts - interval '1 hour', interval '1 hour') gs
     where extract(hour from gs at time zone p_tz)::int between 8 and 20
  ),
  busy as (
    select g.slot_start,
      extract(isodow from g.slot_start at time zone p_tz)::int as dow,
      extract(hour   from g.slot_start at time zone p_tz)::int as hour,
      count(distinct r.space_id) as occupied_rooms,
      count(r.id) as bookings_overlapping
      from grid g
      left join public.reservations r
        on r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.space_id = any(v_room_ids)
       and r.status in ('confirmed','checked_in','completed')
       and r.effective_start_at < g.slot_start + interval '1 hour'
       and r.effective_end_at   > g.slot_start
     group by g.slot_start
  ),
  cells as (
    select dow, hour from generate_series(1,7) dow cross join generate_series(8,20) hour
  ),
  agg as (
    select dow, hour,
      coalesce(sum(occupied_rooms),0) as occupied_room_hours,
      coalesce(sum(bookings_overlapping),0) as total_bookings_overlap,
      count(*) as slots
      from busy group by dow, hour
  ),
  joined as (
    select c.dow, c.hour,
      coalesce(a.occupied_room_hours, 0) as occupied_rooms,
      coalesce(a.total_bookings_overlap, 0) as bookings,
      coalesce(a.slots, 0) as slots
      from cells c left join agg a on a.dow=c.dow and a.hour=c.hour
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'dow', dow, 'hour', hour,
    'occupied_rooms', occupied_rooms,
    'bookings', bookings,
    'rooms_in_scope', v_rooms_in_scope,
    'utilization', case when slots > 0
                        then round(occupied_rooms::numeric / (slots::numeric * v_rooms_in_scope), 4)
                        else 0 end
  ) order by dow, hour), '[]'::jsonb)
  into v_dayhour
  from joined;

  -- KPIs (peak from the demand_by_hour_dow data)
  with base as (
    select r.id, r.created_at, r.start_at, r.attendee_count
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  by_local_hour as (
    select extract(hour from start_at at time zone p_tz)::int as hour, count(*) as n from base group by 1
  ),
  by_local_dow as (
    select extract(isodow from start_at at time zone p_tz)::int as dow, count(*) as n from base group by 1
  ),
  business_days as (
    select count(*) as n from generate_series(p_from, p_to, interval '1 day') gs
     where extract(isodow from gs) between 1 and 5
  )
  select jsonb_build_object(
    'total_bookings', (select count(*) from base),
    'peak_hour_local', (select hour from by_local_hour order by n desc limit 1),
    'peak_dow', (select dow from by_local_dow order by n desc limit 1),
    'avg_bookings_per_business_day',
      case when (select n from business_days) > 0
           then round((select count(*)::numeric from base) / (select n::numeric from business_days), 2)
           else 0 end,
    'rooms_in_scope', v_rooms_in_scope
  ) into v_kpis;

  -- Creation lead-time buckets
  with base as (
    select extract(epoch from (r.start_at - r.created_at)) / 3600.0 as hrs
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  )
  select jsonb_build_object(
    'same_day', count(*) filter (where hrs <  2),
    'lt_24h',   count(*) filter (where hrs >= 2  and hrs <  24),
    'lt_7d',    count(*) filter (where hrs >= 24 and hrs < 168),
    'ge_7d',    count(*) filter (where hrs >= 168)
  ) into v_lead_buckets from base;

  -- Top contended rooms (most bookings + concurrent overlap potential)
  with base as (
    select r.space_id from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status in ('confirmed','checked_in','completed')
       and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  per_room as (
    select space_id, count(*) as bookings from base group by 1 order by 2 desc limit 10
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'space_id', pr.space_id,
    'name', s.name,
    'capacity', s.capacity,
    'bookings', pr.bookings
  ) order by pr.bookings desc), '[]'::jsonb)
    into v_top_contended
    from per_room pr left join public.spaces s on s.id = pr.space_id;

  -- Daily demand
  with base as (
    select ((r.start_at at time zone p_tz)::date) as d, r.id,
      coalesce(r.host_person_id, r.requester_person_id) as person_id
      from public.reservations r
     where r.tenant_id = p_tenant_id and r.reservation_type = 'room'
       and r.status <> 'draft' and r.space_id = any(v_room_ids)
       and r.start_at >= v_from_ts and r.start_at < v_to_ts
  ),
  days as (select gs::date as d from generate_series(p_from, p_to, interval '1 day') gs),
  agg as (
    select d.d,
      count(b.id) as bookings,
      count(distinct b.person_id) as distinct_organizers
      from days d left join base b on b.d = d.d
     group by d.d order by d.d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', to_char(d, 'YYYY-MM-DD'),
    'bookings', bookings,
    'distinct_organizers', distinct_organizers
  ) order by d), '[]'::jsonb)
    into v_daily from agg;

  return jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1),
    'kpis', v_kpis,
    'demand_by_hour_dow', v_dayhour,
    'creation_lead_buckets', v_lead_buckets,
    'top_contended_rooms', v_top_contended,
    'demand_by_day', v_daily
  );
end
$$;

comment on function public.room_booking_demand_report(uuid, date, date, uuid, text) is
  'Demand & contention report: peak hours/days, creation lead-time, contended rooms, daily volume.';

grant execute on function public.room_booking_demand_report(uuid, date, date, uuid, text) to authenticated;

notify pgrst, 'reload schema';
