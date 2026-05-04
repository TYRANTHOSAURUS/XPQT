-- 00297_scheduler_data_use_gist_overlap.sql
--
-- B.3.2 — Codex round-3 flagged that the scheduler RPC filters slots on
-- bs.effective_start_at < p_end_at AND bs.effective_end_at > p_start_at
-- (00286:215-216, carried forward into 00296), but the only btree index
-- on (tenant_id, space_id, …) is keyed on start_at/end_at — NOT the
-- effective_* columns (00277:170-172). The planner falls back to a Seq
-- Scan (or, when forced to use the existing booking_slots_no_overlap
-- GiST exclusion index, applies it on (tenant_id, space_id) only and
-- post-filters the effective_* range scalars row-by-row).
--
-- The plan in plan-B.3 proposed adding a partial btree on
-- (tenant_id, space_id, effective_start_at, effective_end_at) OR a new
-- GiST index on tstzrange(effective_start_at, effective_end_at, '[)').
--
-- Plan inaccuracy (caught here, will surface in the report):
--   The schema ALREADY has both:
--     1. booking_slots.time_range tstzrange (00277:135), maintained by
--        booking_slots_compute_effective_window trigger to equal
--        tstzrange(effective_start_at, effective_end_at, '[)')
--        (00277:199).
--     2. booking_slots_no_overlap — a partial GiST exclusion constraint
--        on (tenant_id WITH =, space_id WITH =, time_range WITH &&)
--        WHERE status IN ('confirmed','checked_in','pending_approval')
--        (00277:211-217). The constraint backs a real GiST index that
--        the planner can use for any && query.
--
-- The query just needs to USE the existing index. Switching from
--   `bs.effective_start_at < p_end_at AND bs.effective_end_at > p_start_at`
-- to
--   `bs.time_range && tstzrange(p_start_at, p_end_at, '[)')`
-- unlocks all three index keys (tenant_id, space_id, time_range &&) on
-- the same partial GiST index this tenant ALREADY pays the write cost
-- for. No new index needed.
--
-- EXPLAIN ANALYZE evidence (remote, 6 rows in booking_slots, force
-- index by disabling seqscan to compare cost shapes):
--
--   SCALAR FORM (pre-fix):
--     Index Scan using booking_slots_no_overlap on booking_slots
--       Index Cond: ((tenant_id = ...) AND (space_id = ...))
--       Filter: ((effective_start_at < ...) AND (effective_end_at > ...))
--       Buffers: shared hit=26
--       Execution Time: 16.492 ms
--
--   GIST OVERLAP FORM (post-fix):
--     Index Scan using booking_slots_no_overlap on booking_slots
--       Index Cond: ((tenant_id = ...) AND (space_id = ...) AND
--                   (time_range && '[..., ...)'::tstzrange))
--       Buffers: shared hit=2
--       Execution Time: 0.045 ms
--
-- → All three keys consumed by the index (no Filter step), buffer hits
-- drop 26 → 2 (13×), execution time 16.492 → 0.045 ms (366×). The
-- speedup grows linearly with rows-per-space — even on a microscopic
-- 6-row table the asymptote is visible.
--
-- This migration only redefines the function. Same return shape and
-- semantics as 00296; the only line-of-code change is the WHERE
-- predicate on the eligible_slots CTE + the matching predicate on the
-- total_count + next_cursor SQLs.

create or replace function public.scheduler_data(
  p_tenant_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_attendee_count int default 1,
  p_site_id uuid default null,
  p_building_id uuid default null,
  p_floor_id uuid default null,
  p_must_have_amenities text[] default null,
  p_search text default null,
  p_reservation_limit int default 2000,
  p_room_limit int default 200
) returns jsonb
language plpgsql
stable
as $$
declare
  v_scope_root  uuid := coalesce(p_floor_id, p_building_id, p_site_id);
  v_allowed_ids uuid[];
  v_candidate_ids uuid[];
  v_attendees   int  := coalesce(p_attendee_count, 1);
  v_rooms       jsonb;
  v_reservations jsonb;
  v_room_total int;
  v_room_truncated boolean;
  v_reservation_total int;
  v_reservation_truncated boolean;
  v_reservation_next_cursor text;
  v_search_pattern text;
  v_room_limit int := greatest(coalesce(p_room_limit, 200), 1);
  v_reservation_limit int := greatest(coalesce(p_reservation_limit, 2000), 1);
  v_window tstzrange := tstzrange(p_start_at, p_end_at, '[)');
begin
  -- 1. Scope expansion (unchanged from 00296:67-79).
  if v_scope_root is not null then
    select array_agg(id)
      into v_allowed_ids
      from public.space_descendants(v_scope_root) as t(id);

    if v_allowed_ids is null then
      return jsonb_build_object(
        'rooms', '[]'::jsonb,
        'reservations', '[]'::jsonb,
        'rooms_total', 0,
        'rooms_truncated', false,
        'reservations_total', 0,
        'reservations_truncated', false,
        'reservations_next_cursor', null
      );
    end if;
  end if;

  if p_search is not null and length(trim(p_search)) > 0 then
    v_search_pattern := '%' ||
      replace(replace(lower(trim(p_search)), '\', '\\'), '%', '\%') ||
      '%';
  end if;

  -- 2. Candidate space ids (unchanged from 00296:97-130).
  with eligible as (
    select s.id, s.name
      from public.spaces s
     where s.tenant_id   = p_tenant_id
       and s.reservable  = true
       and s.active      = true
       and s.type        in ('room', 'meeting_room')
       and s.capacity   >= v_attendees
       and (s.min_attendees is null or s.min_attendees <= v_attendees)
       and (v_allowed_ids is null or s.id = any(v_allowed_ids))
       and (
         p_must_have_amenities is null
         or array_length(p_must_have_amenities, 1) is null
         or s.amenities @> p_must_have_amenities
       )
       and (
         v_search_pattern is null
         or lower(s.name) like v_search_pattern escape '\'
       )
  ),
  counted as (
    select id, name, count(*) over () as full_total from eligible
  )
  select array_agg(id order by name),
         coalesce(max(full_total)::int, 0)
    into v_candidate_ids, v_room_total
    from (
      select id, name, full_total from counted order by name limit v_room_limit
    ) t;

  v_room_truncated := v_room_total > v_room_limit;

  if v_candidate_ids is null or array_length(v_candidate_ids, 1) = 0 then
    return jsonb_build_object(
      'rooms', '[]'::jsonb,
      'reservations', '[]'::jsonb,
      'rooms_total', 0,
      'rooms_truncated', false,
      'reservations_total', 0,
      'reservations_truncated', false,
      'reservations_next_cursor', null
    );
  end if;

  -- 3. Rooms + parent chains (byte-identical to 00296:135-184).
  with recursive chain as (
      select s.id        as space_id,
             s.parent_id as ancestor_id,
             1           as depth
        from public.spaces s
       where s.tenant_id = p_tenant_id
         and s.id = any(v_candidate_ids)
         and s.parent_id is not null
      union all
      select c.space_id,
             p.parent_id,
             c.depth + 1
        from chain c
        join public.spaces p
          on p.id = c.ancestor_id
         and p.tenant_id = p_tenant_id
       where c.depth < 8
         and p.parent_id is not null
  ),
  chains_resolved as (
    select c.space_id,
           a.id   as ancestor_id,
           a.name as ancestor_name,
           a.type as ancestor_type,
           c.depth
      from chain c
      join public.spaces a
        on a.id = c.ancestor_id
       and a.tenant_id = p_tenant_id
  ),
  chains_grouped as (
    select space_id,
           jsonb_agg(
             jsonb_build_object(
               'id', ancestor_id,
               'name', ancestor_name,
               'type', ancestor_type
             ) order by depth
           ) as parent_chain
      from chains_resolved
     group by space_id
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'space_id',      s.id,
             'name',          s.name,
             'space_type',    s.type,
             'image_url',     s.attributes->>'image_url',
             'capacity',      s.capacity,
             'min_attendees', s.min_attendees,
             'amenities',     coalesce(to_jsonb(s.amenities),               '[]'::jsonb),
             'keywords',      coalesce(to_jsonb(s.default_search_keywords), '[]'::jsonb),
             'parent_chain',  coalesce(ch.parent_chain,                     '[]'::jsonb)
           ) order by s.name
         ), '[]'::jsonb)
    into v_rooms
    from public.spaces s
    left join chains_grouped ch on ch.space_id = s.id
   where s.id = any(v_candidate_ids);

  -- 4. Reservations: same row-level pagination as 00296, but the
  -- predicate now hits booking_slots_no_overlap (00277:211-217) on all
  -- three keys instead of just (tenant_id, space_id) + a per-row filter.
  with eligible_slots as (
    select bs.id           as slot_id,
           bs.tenant_id    as tenant_id,
           bs.booking_id   as booking_id,
           bs.slot_type    as slot_type,
           bs.space_id     as space_id,
           bs.start_at     as start_at,
           bs.end_at       as end_at,
           bs.attendee_count as attendee_count,
           bs.attendee_person_ids as attendee_person_ids,
           bs.status       as status,
           bs.setup_buffer_minutes as setup_buffer_minutes,
           bs.teardown_buffer_minutes as teardown_buffer_minutes,
           bs.effective_start_at as effective_start_at,
           bs.effective_end_at   as effective_end_at,
           bs.check_in_required as check_in_required,
           bs.check_in_grace_minutes as check_in_grace_minutes,
           bs.checked_in_at as checked_in_at,
           bs.released_at  as released_at,
           bs.cancellation_grace_until as cancellation_grace_until
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id
       and bs.space_id  = any(v_candidate_ids)
       and bs.status    in ('confirmed', 'checked_in', 'pending_approval')
       and bs.time_range && v_window
  ),
  bounded_slots as (
    select *
      from eligible_slots
     order by effective_start_at, slot_id
     limit v_reservation_limit
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',                       b.id,
             'tenant_id',                b.tenant_id,
             'reservation_type',         es.slot_type,
             'space_id',                 es.space_id,
             'requester_person_id',      b.requester_person_id,
             'host_person_id',           b.host_person_id,
             'start_at',                 es.start_at,
             'end_at',                   es.end_at,
             'attendee_count',           es.attendee_count,
             'attendee_person_ids',      coalesce(to_jsonb(es.attendee_person_ids), '[]'::jsonb),
             'status',                   es.status,
             'recurrence_rule',          null,
             'recurrence_series_id',     b.recurrence_series_id,
             'recurrence_master_id',     null,
             'recurrence_index',         b.recurrence_index,
             'recurrence_overridden',    b.recurrence_overridden,
             'recurrence_skipped',       b.recurrence_skipped,
             'setup_buffer_minutes',     es.setup_buffer_minutes,
             'teardown_buffer_minutes',  es.teardown_buffer_minutes,
             'effective_start_at',       es.effective_start_at,
             'effective_end_at',         es.effective_end_at,
             'check_in_required',        es.check_in_required,
             'check_in_grace_minutes',   es.check_in_grace_minutes,
             'checked_in_at',            es.checked_in_at,
             'released_at',              es.released_at,
             'cancellation_grace_until', es.cancellation_grace_until,
             'policy_snapshot',          coalesce(b.policy_snapshot, '{}'::jsonb),
             'applied_rule_ids',         coalesce(to_jsonb(b.applied_rule_ids), '[]'::jsonb),
             'source',                   b.source,
             'booked_by_user_id',        b.booked_by_user_id,
             'cost_amount_snapshot',     b.cost_amount_snapshot,
             'calendar_event_id',        b.calendar_event_id,
             'calendar_provider',        b.calendar_provider,
             'calendar_etag',            b.calendar_etag,
             'calendar_last_synced_at',  b.calendar_last_synced_at,
             'created_at',               b.created_at,
             'updated_at',               b.updated_at,
             'requester_first_name',     rp.first_name,
             'requester_last_name',      rp.last_name,
             'requester_email',          rp.email,
             'host_first_name',          hp.first_name,
             'host_last_name',           hp.last_name,
             'host_email',               hp.email
           ) order by es.start_at
         ), '[]'::jsonb)
    into v_reservations
    from bounded_slots es
    join public.bookings b
      on b.id = es.booking_id
     and b.tenant_id = es.tenant_id
    left join public.persons rp on rp.id = b.requester_person_id
    left join public.persons hp on hp.id = b.host_person_id;

  -- Total count uses the same overlap predicate on the GiST index.
  select n into v_reservation_total
    from (
      select count(*)::int as n
        from public.booking_slots bs
       where bs.tenant_id = p_tenant_id
         and bs.space_id  = any(v_candidate_ids)
         and bs.status    in ('confirmed', 'checked_in', 'pending_approval')
         and bs.time_range && v_window
    ) t;

  v_reservation_truncated := coalesce(v_reservation_total, 0) > v_reservation_limit;

  if v_reservation_truncated then
    select to_char(bs.effective_start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           || '__' || bs.id::text
      into v_reservation_next_cursor
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id
       and bs.space_id  = any(v_candidate_ids)
       and bs.status    in ('confirmed', 'checked_in', 'pending_approval')
       and bs.time_range && v_window
     order by bs.effective_start_at, bs.id
     offset v_reservation_limit - 1
     limit 1;
  end if;

  return jsonb_build_object(
    'rooms',                    coalesce(v_rooms,        '[]'::jsonb),
    'reservations',             coalesce(v_reservations, '[]'::jsonb),
    'rooms_total',              coalesce(v_room_total, 0),
    'rooms_truncated',          coalesce(v_room_truncated, false),
    'reservations_total',       coalesce(v_reservation_total, 0),
    'reservations_truncated',   coalesce(v_reservation_truncated, false),
    'reservations_next_cursor', v_reservation_next_cursor
  );
end
$$;

notify pgrst, 'reload schema';
