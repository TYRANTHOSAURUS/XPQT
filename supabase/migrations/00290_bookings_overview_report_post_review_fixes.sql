-- 00290_bookings_overview_report_post_review_fixes.sql
--
-- Post-/full-review remediation for slice K1 (00289). Two findings from
-- the adversarial code review:
--
-- C1 (CRITICAL) — services_breakdown cardinality regression. The
--   original 00155:463-491 keyed on `booking_bundles.bundle_type` —
--   a singleton per booking, so each booking contributed to exactly
--   one bucket and `sum(buckets) ≤ total_bookings_with_services`.
--   bundle_type was dropped by 00277 (canonical schema). 00289:516-525
--   keyed instead on `catalog_items.category` per-line, which is a
--   multi-set per booking (a booking with both catering + AV lines
--   contributes to BOTH buckets) AND counted distinct slot_ids
--   (multi-room bookings doubly inflated). Frontend at
--   apps/web/src/pages/admin/room-booking-reports/components/services-attach-section.tsx
--   renders `pct(n / total)` where total = sum(entries) — pie-chart-
--   style — so values silently summed to >100% on tenants with
--   multi-line and/or multi-room bookings.
--
--   This rebuild keeps the multi-set semantic (it's the most honest
--   thing — a booking with both catering and AV genuinely IS in both
--   buckets) but counts DISTINCT booking_ids per bucket (no more
--   slot-multiplication) and adds a sibling field
--   `services_breakdown_total_bookings` so the frontend can render
--   the right denominator. The frontend update lands in the same
--   commit so the percent-rendering matches reality.
--
-- I1 (IMPORTANT) — services-report `bundle_costs` LEFT JOIN
--   over-multiplies cost by slot count. Original 00156:715-721 had
--   the same shape; it was masked when most bookings were single-
--   room. Under canonical multi-room is first-class and the
--   inflation surfaces. The fix groups orders to bookings first via
--   a CTE before the per-line sum, so each (booking, line) is counted
--   exactly once regardless of slot count.
--
-- Both fixes are isolated to the SQL — no signature change, return
-- shape preserved (services_breakdown_total_bookings is additive).

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
  v_services_total  int;
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
      'services_breakdown', '{}'::jsonb,
      'services_breakdown_total_bookings', 0
    );
  end if;

  -- KPIs (unchanged from 00289).
  with base as (
    select bs.id, bs.space_id, bs.attendee_count, bs.checked_in_at,
           bs.check_in_required, bs.start_at, bs.end_at, bs.status,
           extract(epoch from (bs.end_at - bs.start_at)) / 3600.0 as hours,
           bs.status in ('confirmed','checked_in','completed') as is_active,
           bs.status = 'cancelled' as is_cancelled,
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
         where o.booking_id = (select b.id from public.booking_slots s join public.bookings b on b.id=s.booking_id where s.id = bx.id)
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

  -- volume_by_day (unchanged from 00289 — uses booking_slots directly).
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
    select (gs.d)::date as d
      from generate_series(v_from_ts, v_to_ts - interval '1 day', interval '1 day') as gs(d)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date',     d.d,
           'created',  coalesce(c, 0),
           'cancelled',coalesce(x, 0),
           'no_show',  coalesce(ns, 0),
           'completed',coalesce(cm, 0)
         ) order by d.d), '[]'::jsonb)
    into v_volume
    from days d
    left join (
      select d, count(*) as c, count(*) filter (where status = 'cancelled') as x,
             count(*) filter (where is_no_show) as ns,
             count(*) filter (where status = 'completed') as cm
        from base group by d
    ) agg on agg.d = d.d;

  -- utilization_heatmap (unchanged from 00289).
  with cells as (
    select
      ((bs.start_at at time zone p_tz)::date) as d,
      extract(isodow from (bs.start_at at time zone p_tz))::int as dow,
      extract(hour   from (bs.start_at at time zone p_tz))::int as hr
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.status in ('confirmed','checked_in','completed')
       and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
  )
  select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'hr', hr, 'count', n) order by dow, hr), '[]'::jsonb)
    into v_heatmap
    from (
      select dow, hr, count(*) as n from cells group by dow, hr
    ) g;

  -- top_rooms (unchanged from 00289).
  with usage as (
    select bs.space_id,
           count(*) filter (where bs.status in ('confirmed','checked_in','completed')) as bookings,
           sum(extract(epoch from (bs.end_at - bs.start_at)) / 3600.0)
             filter (where bs.status in ('confirmed','checked_in','completed')) as hours,
           count(*) filter (where (bs.status = 'released' and bs.checked_in_at is null and bs.check_in_required = true)
                                 or (bs.status = 'confirmed' and bs.end_at < now() and bs.checked_in_at is null and bs.check_in_required = true)) as no_shows
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.status   <> 'draft'
       and bs.space_id  = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
     group by bs.space_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'space_id',     u.space_id,
           'name',         s.name,
           'parent_chain', coalesce(public.space_path(u.space_id), '[]'::jsonb),
           'bookings',     u.bookings,
           'hours',        round(coalesce(u.hours, 0), 2),
           'no_shows',     u.no_shows
         ) order by u.bookings desc, u.hours desc nulls last), '[]'::jsonb)
    into v_top_rooms
    from (select * from usage order by bookings desc, hours desc nulls last limit 10) u
    join public.spaces s on s.id = u.space_id;

  -- no_show_watchlist (unchanged from 00289).
  with no_shows as (
    select bs.id, b.requester_person_id, ((bs.start_at at time zone p_tz)::date) as occurred_on
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
       and (
         (bs.status = 'released' and bs.checked_in_at is null)
         or (bs.status = 'confirmed' and bs.end_at < now() and bs.checked_in_at is null)
       )
  ),
  ranked as (
    select requester_person_id, count(*) as n,
           array_agg(occurred_on order by occurred_on desc) as days
      from no_shows
     where requester_person_id is not null
     group by requester_person_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'person_id',   r.requester_person_id,
           'name',        coalesce(p.first_name || ' ' || p.last_name, p.email),
           'email',       p.email,
           'count',       r.n,
           'recent_days', (select jsonb_agg(d) from unnest(r.days[1:5]) as d)
         ) order by r.n desc), '[]'::jsonb)
    into v_watchlist
    from (select * from ranked order by n desc limit 25) r
    join public.persons p on p.id = r.requester_person_id;

  -- lead_time + duration buckets (unchanged from 00289 — booking-level).
  with base as (
    select b.created_at, bs.start_at, bs.end_at
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.status in ('confirmed','checked_in','completed')
       and bs.space_id = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
  ),
  with_buckets as (
    select extract(epoch from (start_at - created_at)) / 3600.0 as lead_h,
           extract(epoch from (end_at - start_at)) / 60.0 as duration_min
      from base where created_at <= start_at
  )
  select
    jsonb_build_object(
      'same_day', count(*) filter (where lead_h <  24 and lead_h >= 0),
      'lt_24h',   count(*) filter (where lead_h >= 24 and lead_h < 48),
      'lt_7d',    count(*) filter (where lead_h >= 48 and lead_h < 24*7),
      'ge_7d',    count(*) filter (where lead_h >= 24*7)
    ),
    jsonb_build_object(
      'le_30m', count(*) filter (where duration_min <= 30),
      'le_1h',  count(*) filter (where duration_min > 30 and duration_min <= 60),
      'le_2h',  count(*) filter (where duration_min > 60 and duration_min <= 120),
      'gt_2h',  count(*) filter (where duration_min > 120)
    )
    into v_lead_buckets, v_dur_buckets
    from with_buckets;

  -- ─── services_breakdown — REWRITTEN (C1 fix) ────────────────────────
  -- Multi-set semantic, but per-BOOKING (not per-slot). A booking with
  -- both catering and AV contributes to both buckets exactly once each.
  -- Sister field `services_breakdown_total_bookings` carries the
  -- denominator the frontend needs to render correct percentages.
  with bookings_in_scope as (
    -- Distinct booking ids that have at least one slot in the window.
    select distinct b.id as booking_id
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
  bookings_with_services as (
    -- Of those, the ones whose booking has at least one non-cancelled order.
    select distinct bis.booking_id
      from bookings_in_scope bis
      join public.orders o
        on o.booking_id = bis.booking_id
       and o.status <> 'cancelled'
  ),
  per_booking_categories as (
    -- For each services-attached booking, the DISTINCT set of categories
    -- across all its non-cancelled order lines.
    select distinct bws.booking_id, ci.category as bucket
      from bookings_with_services bws
      join public.orders o
        on o.booking_id = bws.booking_id
       and o.status <> 'cancelled'
      join public.order_line_items oli
        on oli.order_id = o.id
       and oli.fulfillment_status <> 'cancelled'
      join public.catalog_items ci
        on ci.id = oli.catalog_item_id
     where ci.category is not null
  ),
  per_category as (
    select bucket, count(*) as n
      from per_booking_categories
     group by bucket
  )
  select
    coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb),
    (select count(*) from bookings_with_services)
    into v_services_break, v_services_total
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
    'services_breakdown', coalesce(v_services_break, '{}'::jsonb),
    'services_breakdown_total_bookings', coalesce(v_services_total, 0)
  );
end
$$;

comment on function public.room_booking_report_overview(uuid, date, date, uuid, text) is
  'Bookings overview report (canonical-schema rebuild + 00290 cardinality fix). KPIs, volume-by-day, utilization heatmap, top rooms, no-show watchlist, lead-time/duration buckets, and services breakdown for a tenant + window. services_breakdown is a multi-set per-booking count; services_breakdown_total_bookings is the matching denominator. See docs/superpowers/specs/2026-04-27-bookings-overview-report-design.md.';

grant execute on function public.room_booking_report_overview(uuid, date, date, uuid, text) to authenticated;

-- ─── I1 fix — services report bundle_costs LEFT JOIN inflation ───────
-- Fold orders+lines to one row per (booking, line) before joining
-- against booking_slots. The legacy 00156:715-721 silently inflated
-- costs by slot count for multi-room bookings; under canonicalization
-- multi-room is first-class and the bug surfaces. The fix: precompute
-- order-level totals per booking, then attach booking-level metadata,
-- then do any per-window filter via the booking's own start_at/end_at
-- range derived from booking_slots.

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
  v_room_ids   uuid[];
  v_from_ts    timestamptz;
  v_to_ts      timestamptz;
  v_top_items  jsonb;
  v_top_vendors jsonb;
  v_by_type    jsonb;
  v_by_dow     jsonb;
  v_kpis       jsonb;
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

  if coalesce(array_length(v_room_ids, 1), 0) = 0 then
    return jsonb_build_object(
      'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', (p_to - p_from + 1)),
      'kpis', jsonb_build_object(
        'bookings_with_services', 0,
        'total_orders', 0, 'total_line_items', 0,
        'estimated_revenue', 0, 'avg_order_value', 0
      ),
      'top_items', '[]'::jsonb, 'top_vendors', '[]'::jsonb,
      'by_bundle_type', '[]'::jsonb, 'by_day_of_week', '[]'::jsonb
    );
  end if;

  -- Distinct bookings in scope (one row per booking, NOT per slot).
  -- This is the join-base for everything below; it dedupes multi-room
  -- bookings to a single row to prevent the I1 cost-inflation bug.
  with bookings_in_scope as (
    select distinct b.id as booking_id
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
  -- Active orders attached to those bookings.
  active_orders as (
    select o.id as order_id, o.booking_id, o.vendor_id
      from bookings_in_scope bis
      join public.orders o
        on o.booking_id = bis.booking_id
       and o.status <> 'cancelled'
  ),
  -- Per-line cost (no slot multiplication — joined off active_orders).
  active_lines as (
    select ao.order_id, ao.booking_id, ao.vendor_id,
           oli.id as line_id, oli.catalog_item_id,
           coalesce(oli.line_total, oli.unit_price * coalesce(oli.quantity, 1), 0)::numeric as line_total
      from active_orders ao
      join public.order_line_items oli
        on oli.order_id = ao.order_id
       and oli.fulfillment_status <> 'cancelled'
  ),
  totals as (
    select
      count(distinct booking_id) as bookings_with_services,
      count(distinct order_id)   as total_orders,
      count(*)                   as total_line_items,
      coalesce(sum(line_total), 0) as estimated_revenue
    from active_lines
  )
  select jsonb_build_object(
      'bookings_with_services', t.bookings_with_services,
      'total_orders',           t.total_orders,
      'total_line_items',       t.total_line_items,
      'estimated_revenue',      round(t.estimated_revenue, 2),
      'avg_order_value',
        case when t.total_orders > 0
             then round(t.estimated_revenue / t.total_orders, 2)
             else 0 end
    )
    into v_kpis
    from totals t;

  -- Top items by line count, then revenue.
  with active_orders as (
    select o.id as order_id, o.booking_id
      from public.orders o
     where o.status <> 'cancelled'
       and o.booking_id in (
         select distinct b.id
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
       )
  ),
  active_lines as (
    select oli.catalog_item_id, oli.id as line_id,
           coalesce(oli.line_total, oli.unit_price * coalesce(oli.quantity, 1), 0)::numeric as line_total
      from active_orders ao
      join public.order_line_items oli
        on oli.order_id = ao.order_id
       and oli.fulfillment_status <> 'cancelled'
  ),
  per_item as (
    select catalog_item_id,
           count(*) as n_lines,
           sum(line_total) as revenue
      from active_lines
     where catalog_item_id is not null
     group by catalog_item_id
  ),
  ranked as (
    select * from per_item order by n_lines desc, revenue desc nulls last limit 10
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'catalog_item_id', r.catalog_item_id,
           'name',            ci.name,
           'category',        ci.category,
           'lines',           r.n_lines,
           'revenue',         round(r.revenue, 2)
         ) order by r.n_lines desc, r.revenue desc nulls last), '[]'::jsonb)
    into v_top_items
    from ranked r
    join public.catalog_items ci on ci.id = r.catalog_item_id;

  -- Top vendors by revenue (bookings × revenue).
  with active_orders as (
    select o.id as order_id, o.vendor_id, o.booking_id
      from public.orders o
     where o.status <> 'cancelled'
       and o.booking_id in (
         select distinct b.id
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
       )
  ),
  active_lines as (
    select ao.vendor_id, ao.booking_id, ao.order_id,
           coalesce(oli.line_total, oli.unit_price * coalesce(oli.quantity, 1), 0)::numeric as line_total
      from active_orders ao
      join public.order_line_items oli
        on oli.order_id = ao.order_id
       and oli.fulfillment_status <> 'cancelled'
  ),
  per_vendor as (
    select vendor_id,
           count(distinct booking_id) as bookings,
           count(distinct order_id)   as orders,
           sum(line_total)            as revenue
      from active_lines
     where vendor_id is not null
     group by vendor_id
  ),
  ranked as (
    select * from per_vendor order by revenue desc nulls last, bookings desc limit 10
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'vendor_id', r.vendor_id,
           'name',      v.name,
           'bookings',  r.bookings,
           'orders',    r.orders,
           'revenue',   round(coalesce(r.revenue, 0), 2)
         ) order by r.revenue desc nulls last, r.bookings desc), '[]'::jsonb)
    into v_top_vendors
    from ranked r
    join public.vendors v on v.id = r.vendor_id;

  -- by_bundle_type (now keyed on catalog_items.category — the closest
  -- analog post-canonicalization; bundle_type was dropped). Per-booking
  -- DISTINCT to match 00290's services_breakdown semantic.
  with active_orders as (
    select distinct o.booking_id, o.id as order_id
      from public.orders o
     where o.status <> 'cancelled'
       and o.booking_id in (
         select distinct b.id
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
       )
  ),
  per_booking_category as (
    select distinct ao.booking_id, ci.category as bundle_type,
           sum(coalesce(oli.line_total, oli.unit_price * coalesce(oli.quantity, 1), 0))
             over (partition by ao.booking_id, ci.category) as cost
      from active_orders ao
      join public.order_line_items oli
        on oli.order_id = ao.order_id
       and oli.fulfillment_status <> 'cancelled'
      join public.catalog_items ci
        on ci.id = oli.catalog_item_id
     where ci.category is not null
  ),
  rolled_up as (
    select bundle_type,
           count(distinct booking_id) as bookings,
           count(distinct booking_id) as orders, -- one (booking,category) row per bucket
           sum(cost) as est_cost
      from per_booking_category
     group by bundle_type
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'bundle_type', bundle_type,
           'bookings',    bookings,
           'orders',      orders,
           'est_cost',    round(coalesce(est_cost, 0), 2)
         ) order by bookings desc), '[]'::jsonb)
    into v_by_type
    from rolled_up;

  -- by_day_of_week — distinct bookings per ISO dow.
  with bookings_with_services_dow as (
    select distinct b.id as booking_id,
           extract(isodow from (bs.start_at at time zone p_tz))::int as dow
      from public.booking_slots bs
      join public.bookings b
        on b.id = bs.booking_id
       and b.tenant_id = bs.tenant_id
      join public.orders o
        on o.booking_id = b.id
       and o.status <> 'cancelled'
     where bs.tenant_id = p_tenant_id
       and bs.slot_type = 'room'
       and bs.status   <> 'draft'
       and bs.space_id  = any(v_room_ids)
       and bs.start_at >= v_from_ts
       and bs.start_at  < v_to_ts
  )
  select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'bookings', n) order by dow), '[]'::jsonb)
    into v_by_dow
    from (
      select dow, count(*) as n from bookings_with_services_dow group by dow
    ) g;

  return jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to, 'days', (p_to - p_from + 1)),
    'kpis',           coalesce(v_kpis, '{}'::jsonb),
    'top_items',      coalesce(v_top_items, '[]'::jsonb),
    'top_vendors',    coalesce(v_top_vendors, '[]'::jsonb),
    'by_bundle_type', coalesce(v_by_type, '[]'::jsonb),
    'by_day_of_week', coalesce(v_by_dow, '[]'::jsonb)
  );
end
$$;

comment on function public.room_booking_services_report(uuid, date, date, uuid, text) is
  'Services & costs report (canonical-schema rebuild + 00290 cardinality fix). All aggregations dedupe to per-booking before per-line/vendor/category sums to prevent multi-room slot-multiplication. See docs/superpowers/specs/2026-04-27-bookings-overview-report-design.md.';

grant execute on function public.room_booking_services_report(uuid, date, date, uuid, text) to authenticated;

notify pgrst, 'reload schema';
