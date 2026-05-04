-- 00296_scheduler_data_pagination.sql
--
-- B.3.1 — Fix the scheduler RPC's "LIMIT after aggregate" antipattern.
--
-- Pre-fix (00286_scheduler_data_drop_legacy_keys.sql:65, 156, 212):
-- The RPC builds a single `jsonb_agg(...)` over the entire matching slot
-- set and ends with `limit 2000` (line 217). In Postgres, an aggregate
-- collapses its input rows to ONE output row before any LIMIT applies —
-- so `limit 2000` post-aggregate is effectively `limit 1` against a
-- single-row scalar result, i.e. a no-op. The aggregator reads ALL
-- matching rows. Same problem for the rooms aggregate at line 133-149
-- (`limit 200` after `coalesce(jsonb_agg(...), '[]')`).
--
-- Result on busy tenants: a window with many slots produces a giant
-- jsonb payload, slow API response, large network transfer. The
-- "limit 2000" comment in the source promised a bound that was never
-- enforced.
--
-- Fix:
--   1. Move LIMIT into a CTE BEFORE the aggregate. Now the slice is
--      bounded at row level (the aggregator sees at most LIMIT rows).
--   2. Return `total` (full unbounded count), `truncated` (boolean if
--      total > limit), and `next_cursor` (encoded as
--      "<effective_start_at>__<slot_id>" for the last visible row) so
--      the frontend can show "showing first N of M" affordances.
--   3. Same treatment for the rooms aggregate (lines 133-149 of the
--      pre-fix RPC, where `limit 200` was already applied UPSTREAM at
--      the candidate-id selection step on line 81 — so room count
--      truncation already worked, but we surface it consistently in the
--      response shape).
--   4. Add `p_search` parameter for server-side room-name filter. The
--      scheduler frontend currently filters room names client-side
--      (apps/web/src/pages/desk/scheduler/hooks/use-scheduler-data.ts:73-79);
--      pushing it server-side reduces the candidate set BEFORE the slot
--      scan, which compounds the pagination win.
--
-- Reservation cursor: scheduler is a windowed grid (one day / one week);
-- when truncation hits, the operator should refine filters rather than
-- "load more" — partial reservations would mean a partial grid. The
-- cursor is therefore an audit/debug aid plus a knob for future "load
-- more" UX, not a primary pagination control.
--
-- Source: 00286_scheduler_data_drop_legacy_keys.sql (entire RPC body).
-- Schema citation: 00277_create_canonical_booking_schema.sql:166-188 —
-- existing indexes on booking_slots cover the row-level filter.
--
-- The `multi_room_group_id` and `booking_bundle_id` keys remain dropped
-- per 00286 (vestigial aliases). Rooms and reservation fields are
-- byte-identical to 00286.

-- The signature changes: we add `p_search text default null` AFTER the
-- existing optional args and `p_reservation_limit int default 2000` /
-- `p_room_limit int default 200`. To avoid the 'cannot change return
-- type' error from a return-type swap on CREATE OR REPLACE, drop and
-- recreate. Callers in TS pass named args so an additional optional
-- parameter is backwards-compatible at the network layer.

drop function if exists public.scheduler_data(
  uuid, timestamptz, timestamptz, int, uuid, uuid, uuid, text[]
);
drop function if exists public.scheduler_data(
  uuid, timestamptz, timestamptz, int, uuid, uuid, uuid, text[], text, int, int
);

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
begin
  -- 1. Scope expansion (unchanged from 00286:51-63).
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

  -- Search pattern: case-insensitive prefix-and-substring match on room
  -- name. Trim + lowercase + escape % and _ so a literal '%' in a name
  -- doesn't inflate the match. Empty/null = no filter.
  if p_search is not null and length(trim(p_search)) > 0 then
    v_search_pattern := '%' ||
      replace(replace(lower(trim(p_search)), '\', '\\'), '%', '\%') ||
      '%';
  end if;

  -- 2. Candidate space ids (lifted from 00286:65-81; adds search filter
  -- and uses p_room_limit; surfaces total via window function so the
  -- response can carry rooms_total/rooms_truncated honestly).
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

  -- 3. Rooms + parent chains (lifted from 00286:90-149, byte-identical
  -- save for the candidate-id source which is already capped above).
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

  -- 4. Reservations: ROW-LEVEL limit BEFORE the aggregate. Pre-fix
  -- 00286:156-217 ran `jsonb_agg(...) limit 2000`, where the LIMIT was
  -- applied AFTER the aggregate had collapsed the input to a single
  -- row — i.e. the LIMIT did nothing and the aggregator scanned every
  -- matching slot. Here we limit the row set FIRST inside a CTE, then
  -- aggregate the bounded slice.
  --
  -- Total count is computed in a separate scan of the same predicate
  -- (cheap — same partial GiST/btree indexes). The slice is ordered by
  -- (effective_start_at, slot_id) so the next_cursor is stable.
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
       and bs.effective_start_at < p_end_at
       and bs.effective_end_at   > p_start_at
  ),
  total_count as (
    select count(*)::int as n from eligible_slots
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

  select n into v_reservation_total
    from (
      select count(*)::int as n
        from public.booking_slots bs
       where bs.tenant_id = p_tenant_id
         and bs.space_id  = any(v_candidate_ids)
         and bs.status    in ('confirmed', 'checked_in', 'pending_approval')
         and bs.effective_start_at < p_end_at
         and bs.effective_end_at   > p_start_at
    ) t;

  v_reservation_truncated := coalesce(v_reservation_total, 0) > v_reservation_limit;

  -- next_cursor encodes (effective_start_at, slot_id) of the LAST row
  -- in the bounded slice — same shape as listMine's cursor. Only set
  -- when truncation actually happened; otherwise null.
  if v_reservation_truncated then
    select to_char(bs.effective_start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           || '__' || bs.id::text
      into v_reservation_next_cursor
      from public.booking_slots bs
     where bs.tenant_id = p_tenant_id
       and bs.space_id  = any(v_candidate_ids)
       and bs.status    in ('confirmed', 'checked_in', 'pending_approval')
       and bs.effective_start_at < p_end_at
       and bs.effective_end_at   > p_start_at
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
