-- 00289_bookings_overview_reports_rebuild.sql
--
-- Rebuild the 5 room-booking report RPCs that were dropped in 00279
-- (because they aggregated over the now-gone `public.reservations` /
-- `public.booking_bundles` tables). Canonical-schema retarget against
-- `public.bookings` (00277:27) + `public.booking_slots` (00277:116).
--
-- Mechanical translation of the originals (00155 + 00156). Same input
-- signatures, same JSONB return shapes, same business logic — only the
-- table/column references change.
--
-- Column substitutions applied (per
-- apps/api/src/modules/reservations/reservation-projection.ts:55):
--   r (reservations)             → bs (booking_slots) joined to b (bookings)
--   r.tenant_id                  → bs.tenant_id
--   r.space_id                   → bs.space_id            (00277:124)
--   r.reservation_type           → bs.slot_type           (00277:122)
--     legacy filter `= 'room'`   → `bs.slot_type = 'room'`
--   r.start_at / r.end_at        → bs.start_at / bs.end_at (00277:127-128)
--   r.effective_*                → bs.effective_*         (00277:133-134)
--   r.status                     → bs.status              (00277:142-144)
--   r.attendee_count             → bs.attendee_count      (00277:138)
--   r.checked_in_at              → bs.checked_in_at       (00277:149)
--   r.released_at                → bs.released_at         (00277:150)
--   r.check_in_required          → bs.check_in_required   (00277:147)
--   r.requester_person_id        → b.requester_person_id  (00277:36)
--   r.host_person_id             → b.host_person_id       (00277:37)
--   r.created_at                 → b.created_at           (booking-level lead time)
--   r.updated_at                 → bs.updated_at          (slot status change time)
--   r.booking_bundle_id          → b.id                   (the booking IS the bundle)
--   r.booking_bundle_id IS NOT NULL → true (every slot has a parent booking now)
--   public.orders.booking_bundle_id → public.orders.booking_id (renamed in 00278:109)
--
-- One semantic departure from the original is unavoidable:
--   `booking_bundles.bundle_type` was dropped in 00277:15, so the
--   "by bundle type" (services report) and "services_breakdown"
--   (overview report) buckets cannot be grouped by it anymore. The
--   closest existing categorical column is `catalog_items.category`
--   (00013:8 — 'food_and_drinks'|'equipment'|'supplies'|'services'),
--   rolled up via the order_line_items joined to a booking's orders.
--   The wire shape (Record<string, number> for breakdown,
--   ServicesByTypeRow[] with `bundle_type: string` for by_bundle_type)
--   is preserved; the keys now read e.g. 'food_and_drinks' instead of
--   'meeting'/'event'. Frontend (services.tsx:136) falls back to the
--   raw key when not found in TYPE_LABELS, so this degrades cleanly.
--
-- Definitions originally documented in
--   docs/superpowers/specs/2026-04-27-bookings-overview-report-design.md

-- Covering index for the window slice on slots (replaces the partial
-- reservations index from 00155:30-35).
create index if not exists booking_slots_tenant_type_start_idx
  on public.booking_slots (tenant_id, slot_type, start_at)
  where slot_type = 'room';

-- ===========================================================================
-- 1. OVERVIEW (was 00155)
-- ===========================================================================

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
  if p_from is null or p_to is null then
    raise exception 'from/to are required' using errcode = '22023';
  end if;
  if p_from > p_to then
    raise exception 'from > to' using errcode = '22023';
  end if;
  if (p_to - p_from) > 365 then
    raise exception 'window too large (> 365 days)' using errcode = '22023';
  end if;

  v_from_ts := (p_from::timestamp at time zone p_tz);
  v_to_ts   := ((p_to + 1)::timestamp at time zone p_tz);

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

  select count(*)
    into v_weekdays
    from generate_series(p_from, p_to, interval '1 day') as gs(d)
   where extract(isodow from gs.d) between 1 and 5;

  v_bookable_hours := (v_rooms_in_scope::numeric) * 10 * (v_weekdays::numeric);

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

  -- 2. KPIs — single pass over slots+bookings in window.
  with base as (
    select
      bs.id, bs.space_id, bs.attendee_count, b.id as booking_id, bs.check_in_required,
      bs.status,
      extract(epoch from (bs.effective_end_at - bs.effective_start_at)) / 3600.0 as hours,
      (bs.status = 'cancelled') as is_cancelled,
      (bs.status in ('confirmed','checked_in','completed')) as is_active,
      (
        (bs.status = 'released' and bs.checked_in_at is null and bs.check_in_required = true)
        or
        (bs.status = 'confirmed' and bs.end_at < now() and bs.checked_in_at is null and bs.check_in_required = true)
      ) as is_no_show
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.status   <> 'draft'
       and bs.space_id  = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
  ),
  bundle_attach as (
    select bx.id, exists(
        select 1 from public.orders o
         where o.booking_id = bx.booking_id
           and o.status <> 'cancelled'
      ) as has_services
      from base bx
  ),
  enriched as (
    select bx.*, coalesce(ba.has_services, false) as has_services
      from base bx
      left join bundle_attach ba on ba.id = bx.id
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
    select bs.status, ((bs.start_at at time zone p_tz)::date) as d,
      (
        (bs.status = 'released' and bs.checked_in_at is null and bs.check_in_required = true)
        or
        (bs.status = 'confirmed' and bs.end_at < now() and bs.checked_in_at is null and bs.check_in_required = true)
      ) as is_no_show
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.status   <> 'draft'
       and bs.space_id  = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
  ),
  days as (
    select gs::date as d
      from generate_series(p_from, p_to, interval '1 day') as gs
  ),
  agg as (
    select
      d.d,
      count(*) filter (where bx.status in ('pending_approval','confirmed','checked_in') and not bx.is_no_show) as confirmed,
      count(*) filter (where bx.status = 'cancelled') as cancelled,
      count(*) filter (where bx.is_no_show) as no_show,
      count(*) filter (where bx.status = 'completed') as completed
      from days d
      left join base bx on bx.d = d.d
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
      count(distinct bs.space_id) as occupied_rooms
      from grid g
      left join public.booking_slots bs
        on bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.space_id  = any(v_room_ids)
       and bs.status    in ('confirmed','checked_in','completed')
       and bs.effective_start_at < g.slot_start + interval '1 hour'
       and bs.effective_end_at   > g.slot_start
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
    select bs.space_id, bs.status, b.id as booking_id, bs.check_in_required, bs.checked_in_at, bs.end_at,
      extract(epoch from (bs.effective_end_at - bs.effective_start_at)) / 3600.0 as hours,
      (
        (bs.status = 'released' and bs.checked_in_at is null and bs.check_in_required = true)
        or
        (bs.status = 'confirmed' and bs.end_at < now() and bs.checked_in_at is null and bs.check_in_required = true)
      ) as is_no_show
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.status   <> 'draft'
       and bs.space_id  = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
  ),
  per_room as (
    select
      bx.space_id,
      count(*) as bookings,
      sum(bx.hours) filter (where bx.status in ('confirmed','checked_in','completed')) as booked_hours,
      count(*) filter (where bx.is_no_show) as no_show_count,
      count(*) filter (where bx.check_in_required) as eligible,
      count(*) filter (where exists(
        select 1 from public.orders o
         where o.booking_id = bx.booking_id
           and o.status <> 'cancelled'
      )) as svc_count
      from base bx
     group by bx.space_id
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
  --    `reservation_id` field is preserved as the slot id (the per-slot
  --    record being flagged), matching the original semantics where
  --    each row was per-room.
  with watchlist_base as (
    select
      bs.id, bs.space_id, bs.start_at, bs.end_at, bs.released_at, bs.attendee_count,
      b.requester_person_id, b.host_person_id
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.space_id  = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
       and bs.check_in_required = true
       and bs.checked_in_at is null
       and (
         bs.status = 'released'
         or (bs.status = 'confirmed' and bs.end_at < now())
       )
     order by bs.start_at desc
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
  --    Lead time uses booking.created_at (the booking-level audit
  --    timestamp; legacy reservations.created_at carried the same
  --    semantics under the old single-row-per-reservation model).
  with base as (
    select b.created_at, bs.start_at, bs.effective_start_at, bs.effective_end_at
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.status   <> 'draft'
       and bs.space_id  = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
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

  -- 8. services_breakdown — bookings with services, grouped by
  --    catalog_items.category (00013:8). Replaces legacy
  --    booking_bundles.bundle_type which no longer exists.
  with base as (
    select bs.id as slot_id, b.id as booking_id
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.status   <> 'draft'
       and bs.space_id  = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
  ),
  active_orders as (
    select distinct o.id as order_id, bx.slot_id
      from base bx
      join public.orders o on o.booking_id = bx.booking_id and o.status <> 'cancelled'
  ),
  per_category as (
    select ci.category as bucket, count(distinct ao.slot_id) as n
      from active_orders ao
      join public.order_line_items oli on oli.order_id = ao.order_id and oli.fulfillment_status <> 'cancelled'
      join public.catalog_items ci on ci.id = oli.catalog_item_id
     group by ci.category
  )
  select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
    into v_services_break
    from per_category;

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
  'Bookings overview report (canonical-schema rebuild). KPIs, volume-by-day, utilization heatmap, top rooms, no-show watchlist, lead-time/duration buckets, and services breakdown for a tenant + window. See docs/superpowers/specs/2026-04-27-bookings-overview-report-design.md.';

grant execute on function public.room_booking_report_overview(uuid, date, date, uuid, text) to authenticated;

-- ===========================================================================
-- 2. UTILIZATION (was 00156 §1)
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
  v_per_room_bookable_hours numeric;
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

  with base as (
    select bs.space_id, bs.attendee_count, bs.status,
      extract(epoch from (bs.effective_end_at - bs.effective_start_at)) / 3600.0 as hours,
      (bs.status = 'released' and bs.checked_in_at is null and bs.check_in_required = true) as is_no_show
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
  ),
  per_room_agg as (
    select
      bx.space_id,
      count(*) as bookings,
      sum(bx.hours) filter (where bx.status in ('confirmed','checked_in','completed')) as booked_hours,
      avg(bx.attendee_count::numeric) filter (where bx.attendee_count is not null) as avg_attendees,
      count(*) filter (where bx.is_no_show) as no_show_count,
      count(*) filter (where bx.status not in ('cancelled')) as eligible
      from base bx
     group by bx.space_id
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
    jsonb_build_object(
      'rooms_in_scope', v_rooms_in_scope,
      'avg_utilization', round(avg(utilization)::numeric, 4),
      'underused_count', count(*) filter (where utilization < 0.20),
      'overused_count',  count(*) filter (where utilization > 0.85),
      'avg_attendees',   round(avg(avg_attendees)::numeric, 2),
      'avg_capacity_fit', round(avg(capacity_fit)::numeric, 4)
    ),
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

  with base as (
    select bs.space_id,
      extract(epoch from (bs.effective_end_at - bs.effective_start_at)) / 3600.0 as hours,
      bs.status
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
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

  with base as (
    select bs.attendee_count, s.capacity
      from public.booking_slots bs
      join public.spaces s on s.id = bs.space_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status in ('confirmed','checked_in','completed')
       and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
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
  'Per-room utilization, capacity fit, and building rollup (canonical-schema rebuild). Bookable hours = 10h × weekdays per room.';

grant execute on function public.room_booking_utilization_report(uuid, date, date, uuid, text) to authenticated;

-- ===========================================================================
-- 3. NO-SHOWS & CANCELLATIONS (was 00156 §2)
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

  -- Base set + KPIs.
  -- updated_at lives on the slot (per-slot status change time); legacy
  -- reservations.updated_at carried the same semantics.
  with base as (
    select
      bs.id, bs.space_id, b.host_person_id, b.requester_person_id,
      bs.start_at, bs.end_at, b.created_at, bs.updated_at, bs.status,
      bs.checked_in_at, bs.released_at, bs.check_in_required, bs.attendee_count,
      (
        (bs.status = 'released' and bs.checked_in_at is null and bs.check_in_required = true)
        or
        (bs.status = 'confirmed' and bs.end_at < now() and bs.checked_in_at is null and bs.check_in_required = true)
      ) as is_no_show,
      (bs.status = 'cancelled') as is_cancelled
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
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

  with base as (
    select ((bs.start_at at time zone p_tz)::date) as d,
      (
        (bs.status = 'released' and bs.checked_in_at is null and bs.check_in_required = true)
        or
        (bs.status = 'confirmed' and bs.end_at < now() and bs.checked_in_at is null and bs.check_in_required = true)
      ) as is_no_show,
      (bs.status = 'cancelled') as is_cancelled
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
  ),
  days as (
    select gs::date as d from generate_series(p_from, p_to, interval '1 day') gs
  ),
  agg as (
    select d.d,
      count(*) filter (where bx.is_no_show)   as no_shows,
      count(*) filter (where bx.is_cancelled) as cancellations
      from days d left join base bx on bx.d = d.d
     group by d.d order by d.d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date', to_char(d, 'YYYY-MM-DD'),
    'no_shows', no_shows,
    'cancellations', cancellations
  ) order by d), '[]'::jsonb)
    into v_trend from agg;

  with base as (
    select coalesce(b.host_person_id, b.requester_person_id) as person_id,
      (
        (bs.status = 'released' and bs.checked_in_at is null and bs.check_in_required = true)
        or
        (bs.status = 'confirmed' and bs.end_at < now() and bs.checked_in_at is null and bs.check_in_required = true)
      ) as is_no_show
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
       and bs.check_in_required = true
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

  with base as (
    select coalesce(b.host_person_id, b.requester_person_id) as person_id,
      (bs.status = 'cancelled') as is_cancelled
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
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

  with base as (
    select bs.start_at, bs.updated_at
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status = 'cancelled'
       and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
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

  with watchlist_base as (
    select bs.id, bs.space_id, bs.start_at, bs.end_at, bs.released_at, bs.attendee_count,
      coalesce(b.host_person_id, b.requester_person_id) as person_id
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
       and bs.check_in_required = true and bs.checked_in_at is null
       and (bs.status = 'released' or (bs.status = 'confirmed' and bs.end_at < now()))
     order by bs.start_at desc
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
  'No-show & cancellation deep-dive (canonical-schema rebuild): KPIs, daily trend, top organizers, time-to-cancel histogram, recent watchlist.';

grant execute on function public.room_booking_no_shows_report(uuid, date, date, uuid, text) to authenticated;

-- ===========================================================================
-- 4. SERVICES & COSTS (was 00156 §3)
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

  -- The set of slots in the window (one row per legacy "reservation").
  -- `bundle_id` here is the parent booking id (00277:27 — the booking IS
  -- the bundle).
  with base as (
    select bs.id as reservation_id, b.id as bundle_id,
      ((bs.start_at at time zone p_tz)::date) as start_date
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
  ),
  bundles_active as (
    select distinct bx.bundle_id
      from base bx
     where exists (select 1 from public.orders o
                    where o.booking_id = bx.bundle_id
                      and o.status <> 'cancelled')
  ),
  total_costs as (
    select coalesce(sum(oli.line_total), 0) as total_cost,
           count(distinct o.id) as order_count
      from bundles_active ba
      join public.orders o on o.booking_id = ba.bundle_id and o.status <> 'cancelled'
      left join public.order_line_items oli
        on oli.order_id = o.id and oli.fulfillment_status <> 'cancelled'
  )
  select jsonb_build_object(
      'total_bookings',
        (select count(*) from base),
      'bundles_with_services',
        (select count(*) from bundles_active),
      'bookings_with_services',
        (select count(distinct bx.reservation_id)
           from base bx
           join bundles_active ba on ba.bundle_id = bx.bundle_id),
      'attach_rate',
        case when (select count(*) from base) > 0
             then round(
               (select count(distinct bx.reservation_id)::numeric from base bx
                  join bundles_active ba on ba.bundle_id = bx.bundle_id)
               / (select count(*)::numeric from base), 4)
             else 0 end,
      'total_orders',         (select order_count from total_costs),
      'total_estimated_cost', (select round(total_cost, 2) from total_costs),
      'avg_cost_per_serviced_booking',
        case when (select count(*) from bundles_active) > 0
             then round((select total_cost from total_costs) / (select count(*) from bundles_active), 2)
             else 0 end
    ) into v_kpis;

  -- By "bundle type" — replaced by catalog_items.category since
  -- bundle_type was dropped (00277:15). Wire shape unchanged.
  with base as (
    select bs.id as reservation_id, b.id as bundle_id
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
  ),
  per_category as (
    select ci.category as bundle_type,
      count(distinct bx.reservation_id) as bookings,
      coalesce(sum(oli.line_total), 0)  as est_cost,
      count(distinct o.id)              as orders
      from base bx
      join public.orders o on o.booking_id = bx.bundle_id and o.status <> 'cancelled'
      join public.order_line_items oli on oli.order_id = o.id and oli.fulfillment_status <> 'cancelled'
      join public.catalog_items ci on ci.id = oli.catalog_item_id
     group by ci.category
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'bundle_type', bundle_type,
      'bookings', bookings,
      'orders', orders,
      'est_cost', round(est_cost::numeric, 2)
    ) order by bookings desc), '[]'::jsonb)
    into v_by_type from per_category;

  -- Top catalog items (by cost)
  with reservation_orders as (
    select distinct o.id as order_id
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
      join public.orders o on o.booking_id = b.id and o.status <> 'cancelled'
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
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

  -- By cost center (booking-level cost_center_id, 00277:61)
  with base as (
    select bs.id as reservation_id, b.cost_center_id, b.id as bundle_id
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
       and b.cost_center_id is not null
  ),
  per_cc as (
    select bx.cost_center_id,
      count(distinct bx.reservation_id) as bookings,
      coalesce(sum(oli.line_total), 0) as est_cost
      from base bx
      left join public.orders o on o.booking_id = bx.bundle_id and o.status <> 'cancelled'
      left join public.order_line_items oli on oli.order_id = o.id and oli.fulfillment_status <> 'cancelled'
     group by bx.cost_center_id
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
    select ((bs.start_at at time zone p_tz)::date) as d, b.id as bundle_id
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
  ),
  bundle_costs as (
    select bx.d, bx.bundle_id, coalesce(sum(oli.line_total), 0) as cost
      from base bx
      left join public.orders o on o.booking_id = bx.bundle_id and o.status <> 'cancelled'
      left join public.order_line_items oli on oli.order_id = o.id and oli.fulfillment_status <> 'cancelled'
     where exists(select 1 from public.orders o2
                   where o2.booking_id = bx.bundle_id and o2.status <> 'cancelled')
     group by bx.d, bx.bundle_id
  ),
  days as (select gs::date as d from generate_series(p_from, p_to, interval '1 day') gs),
  agg as (
    select d.d,
      count(distinct bc.bundle_id) as serviced_bundles,
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
  'Services + cost report (canonical-schema rebuild): KPIs, by category (legacy bundle_type slot), top catalog items, by cost center, daily cost trend.';

grant execute on function public.room_booking_services_report(uuid, date, date, uuid, text) to authenticated;

-- ===========================================================================
-- 5. DEMAND & CONTENTION (was 00156 §4)
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

  with grid as (
    select gs as slot_start
      from generate_series(date_trunc('hour', v_from_ts), v_to_ts - interval '1 hour', interval '1 hour') gs
     where extract(hour from gs at time zone p_tz)::int between 8 and 20
  ),
  busy as (
    select g.slot_start,
      extract(isodow from g.slot_start at time zone p_tz)::int as dow,
      extract(hour   from g.slot_start at time zone p_tz)::int as hour,
      count(distinct bs.space_id) as occupied_rooms,
      count(bs.id) as bookings_overlapping
      from grid g
      left join public.booking_slots bs
        on bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.space_id = any(v_room_ids)
       and bs.status in ('confirmed','checked_in','completed')
       and bs.effective_start_at < g.slot_start + interval '1 hour'
       and bs.effective_end_at   > g.slot_start
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

  with base as (
    select bs.id, b.created_at, bs.start_at, bs.attendee_count
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
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

  with base as (
    select extract(epoch from (bs.start_at - b.created_at)) / 3600.0 as hrs
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
  )
  select jsonb_build_object(
    'same_day', count(*) filter (where hrs <  2),
    'lt_24h',   count(*) filter (where hrs >= 2  and hrs <  24),
    'lt_7d',    count(*) filter (where hrs >= 24 and hrs < 168),
    'ge_7d',    count(*) filter (where hrs >= 168)
  ) into v_lead_buckets from base;

  with base as (
    select bs.space_id from public.booking_slots bs
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status in ('confirmed','checked_in','completed')
       and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
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

  with base as (
    select ((bs.start_at at time zone p_tz)::date) as d, bs.id,
      coalesce(b.host_person_id, b.requester_person_id) as person_id
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id and bs.slot_type = 'room'
       and bs.status <> 'draft' and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts and bs.start_at < v_to_ts
  ),
  days as (select gs::date as d from generate_series(p_from, p_to, interval '1 day') gs),
  agg as (
    select d.d,
      count(bx.id) as bookings,
      count(distinct bx.person_id) as distinct_organizers
      from days d left join base bx on bx.d = d.d
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
  'Demand & contention report (canonical-schema rebuild): peak hours/days, creation lead-time, contended rooms, daily volume.';

grant execute on function public.room_booking_demand_report(uuid, date, date, uuid, text) to authenticated;

notify pgrst, 'reload schema';
