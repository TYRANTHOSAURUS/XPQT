-- 00286_scheduler_data_drop_legacy_keys.sql
--
-- Slice H3 of the booking-canonicalization rewrite (2026-05-02).
-- Drop the two always-null/redundant JSON keys from scheduler_data's
-- response: `multi_room_group_id` (always null — column dropped in
-- 00277) and `booking_bundle_id` (always equals `id` — booking IS the
-- bundle post-canonicalization).
--
-- These were emitted as `null` / `b.id` aliases by the 00280 rewrite
-- (00280:617, 00280:622) so the frontend wouldn't blow up during the
-- transition. The frontend type at apps/web/src/api/room-booking/
-- types.ts:207,215 calls them out as "ALWAYS null/redundant" — no
-- consumer actually reads them today (verified: only references in
-- the codebase are the field declarations themselves + comments
-- explaining they're vestigial).
--
-- Top-level `'reservations'` key is INTENTIONALLY left as-is. The
-- entries are still the legacy Reservation projection (one row per
-- slot, but `row.id` is the parent booking's id) consumed by the
-- frontend Reservation[] readers via list-bookable-rooms.service.ts:309
-- and use-scheduler-data.ts:120. Renaming would cascade across
-- the entire desk scheduler without semantic clarification — the
-- projection itself is the legacy shape, not just the key.
--
-- Source for the rewrite: 00280_drop_reservation_visitors.sql:441-657.
-- Only lines 617 + 622 change (the two emitted aliases). Everything
-- else (room candidate logic, rules, ETag behavior) is byte-identical
-- to today.

create or replace function public.scheduler_data(
  p_tenant_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_attendee_count int default 1,
  p_site_id uuid default null,
  p_building_id uuid default null,
  p_floor_id uuid default null,
  p_must_have_amenities text[] default null
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
begin
  -- 1. Scope expansion (unchanged from 00280:462-476).
  if v_scope_root is not null then
    select array_agg(id)
      into v_allowed_ids
      from public.space_descendants(v_scope_root) as t(id);

    if v_allowed_ids is null then
      return jsonb_build_object(
        'rooms', '[]'::jsonb,
        'reservations', '[]'::jsonb
      );
    end if;
  end if;

  -- 2. Candidate space ids (unchanged from 00280:480-502).
  select array_agg(s.id order by s.name)
    into v_candidate_ids
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
   limit 200;

  if v_candidate_ids is null or array_length(v_candidate_ids, 1) = 0 then
    return jsonb_build_object(
      'rooms', '[]'::jsonb,
      'reservations', '[]'::jsonb
    );
  end if;

  -- 3. Rooms + parent chains (unchanged from 00280:504-564).
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

  -- 4. Reservations: lifted from 00280:566-645. Two changes vs that
  --    version: the `'multi_room_group_id': null` alias (was 00280:617)
  --    and the `'booking_bundle_id': b.id` alias (was 00280:622) are
  --    BOTH dropped. Frontend types.ts:207,215 had them flagged as
  --    vestigial; no live reader.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',                       b.id,
             'tenant_id',                b.tenant_id,
             'reservation_type',         bs.slot_type,
             'space_id',                 bs.space_id,
             'requester_person_id',      b.requester_person_id,
             'host_person_id',           b.host_person_id,
             'start_at',                 bs.start_at,
             'end_at',                   bs.end_at,
             'attendee_count',           bs.attendee_count,
             'attendee_person_ids',      coalesce(to_jsonb(bs.attendee_person_ids), '[]'::jsonb),
             'status',                   bs.status,
             'recurrence_rule',          null,
             'recurrence_series_id',     b.recurrence_series_id,
             'recurrence_master_id',     null,
             'recurrence_index',         b.recurrence_index,
             'recurrence_overridden',    b.recurrence_overridden,
             'recurrence_skipped',       b.recurrence_skipped,
             'setup_buffer_minutes',     bs.setup_buffer_minutes,
             'teardown_buffer_minutes',  bs.teardown_buffer_minutes,
             'effective_start_at',       bs.effective_start_at,
             'effective_end_at',         bs.effective_end_at,
             'check_in_required',        bs.check_in_required,
             'check_in_grace_minutes',   bs.check_in_grace_minutes,
             'checked_in_at',            bs.checked_in_at,
             'released_at',              bs.released_at,
             'cancellation_grace_until', bs.cancellation_grace_until,
             'policy_snapshot',          coalesce(b.policy_snapshot, '{}'::jsonb),
             'applied_rule_ids',         coalesce(to_jsonb(b.applied_rule_ids), '[]'::jsonb),
             'source',                   b.source,
             'booked_by_user_id',        b.booked_by_user_id,
             'cost_amount_snapshot',     b.cost_amount_snapshot,
             -- 'multi_room_group_id' DROPPED (was always null per 00280:617)
             'calendar_event_id',        b.calendar_event_id,
             'calendar_provider',        b.calendar_provider,
             'calendar_etag',            b.calendar_etag,
             'calendar_last_synced_at',  b.calendar_last_synced_at,
             -- 'booking_bundle_id' DROPPED (was an alias for `id` per 00280:622)
             'created_at',               b.created_at,
             'updated_at',               b.updated_at,
             'requester_first_name',     rp.first_name,
             'requester_last_name',      rp.last_name,
             'requester_email',          rp.email,
             'host_first_name',          hp.first_name,
             'host_last_name',           hp.last_name,
             'host_email',               hp.email
           ) order by bs.start_at
         ), '[]'::jsonb)
    into v_reservations
    from public.booking_slots bs
    join public.bookings b
      on b.id = bs.booking_id
     and b.tenant_id = bs.tenant_id
    left join public.persons rp on rp.id = b.requester_person_id
    left join public.persons hp on hp.id = b.host_person_id
   where bs.tenant_id = p_tenant_id
     and bs.space_id  = any(v_candidate_ids)
     and bs.status    in ('confirmed', 'checked_in', 'pending_approval')
     and bs.effective_start_at < p_end_at
     and bs.effective_end_at   > p_start_at
   limit 2000;

  return jsonb_build_object(
    'rooms',        coalesce(v_rooms,        '[]'::jsonb),
    'reservations', coalesce(v_reservations, '[]'::jsonb)
  );
end
$$;

notify pgrst, 'reload schema';
