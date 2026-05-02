-- 00280_drop_reservation_visitors.sql
-- Booking-canonicalisation rewrite (2026-05-02), follow-up #2.
--
-- Cleanup pass for the legacy `reservation_visitors` junction + four orphaned
-- SQL functions that survived the 00276 CASCADE because Postgres doesn't
-- track function-body dependencies:
--
--   1. public.reservation_visitors  (table) — 00159
--      Visitor↔reservation m:n junction. Replaced by the canonical
--      `visitors.booking_id` column (added by 00278:41 — the rename of
--      `visitors.booking_bundle_id` → `visitors.booking_id`). The
--      `visitors.reservation_id` denormalised cache column was already
--      dropped by 00278:38. With both link paths gone, the junction is
--      obsolete: every visitor links to its booking via
--      `visitors.booking_id` directly. Backend endpoints that still wrote
--      this table (POST/DELETE/GET /reservations/:id/visitors) are
--      removed in the same slice. The junction table's FK to
--      `public.reservations(id)` (00159:14) was also CASCADE-dropped by
--      00276 — leaving the table half-broken (PK column points at no
--      table). Drop the whole table.
--
--   2. public.reservation_visibility_ids(uuid, uuid)  — 00157
--      Built the per-user visible-reservation id set for the now-deleted
--      `reservation_visitors_select` RLS policy (00160:44). The table
--      it gates is dropped in this same migration; nothing else in the
--      app reads this function. Drop it.
--
--   3. public.reservations_assign_module_number()  — 00139:175
--      BEFORE INSERT trigger function on the dropped `reservations` table.
--      Allocated `RES-NNNN` reference numbers via `allocate_module_number`.
--      The new `bookings` table doesn't carry a per-booking monotonic
--      counter (per the rewrite spec; reservation-projection.ts:55 doesn't
--      synthesise one either). The trigger was attached to a now-dropped
--      table and disappeared with it; the function is dead code. Also
--      clean up any 'RES' rows lingering in `tenant_sequences` so we don't
--      preserve a counter for a module that no longer exists.
--
--   4. public.search_global(uuid, uuid, text, text[], int)  — 00274:21
--      Last shipped at 00274. Its `'reservation'` branch (00274:299-340)
--      queries `public.reservations r` — table is gone. Recreate the
--      function with the reservations branch rewritten against
--      `bookings` joined to its primary `booking_slots` row (the booking
--      IS the bundle; the first slot supplies the room/space anchor). Other
--      branches (tickets, persons, spaces, assets, vendors, teams,
--      request_types) are byte-identical to 00274.
--
--   5. public.scheduler_data(...)  — 00242
--      The desk-scheduler's one-shot RPC. Its reservation branch
--      (00242:149-169) reads `public.reservations r`. Rewrite to query
--      `bookings` joined with `booking_slots`, returning the legacy flat
--      `Reservation` shape that the frontend already consumes via
--      `apps/api/src/modules/reservations/reservation-projection.ts`.
--      The RPC is hot path for `/desk/scheduler` (apps/api/src/modules/
--      reservations/list-bookable-rooms.service.ts:256) — must stay alive,
--      not be dropped.
--
-- Defensive: each statement is `IF EXISTS` so the migration is
-- idempotent against fresh local resets and remote pushes alike.

begin;

-- ---------------------------------------------------------------------------
-- 1. Drop the orphaned junction table.
-- ---------------------------------------------------------------------------
-- CASCADE handles the RLS policies (00160:44, 00160:61, 00160:65, 00160:70)
-- and the surviving indexes (00159:27-28).
drop table if exists public.reservation_visitors cascade;

-- ---------------------------------------------------------------------------
-- 2. Drop the visibility helper that gated the dropped junction table.
-- ---------------------------------------------------------------------------
drop function if exists public.reservation_visibility_ids(uuid, uuid);

-- ---------------------------------------------------------------------------
-- 3. Drop the legacy module-number allocator + clean up RES counter rows.
-- ---------------------------------------------------------------------------
drop function if exists public.reservations_assign_module_number() cascade;
delete from public.tenant_sequences where module = 'RES';

-- ---------------------------------------------------------------------------
-- 4. Recreate search_global with the reservations branch rewritten.
-- ---------------------------------------------------------------------------
-- Rewrite of 00274_search_global_visitor_id.sql with one change: the
-- final 'reservation' branch now queries `public.bookings` joined to its
-- primary `public.booking_slots` row (lowest display_order = primary slot
-- per 00277:154). Hit shape is unchanged so the frontend command-palette
-- consumer continues to work. Cited 00277 line numbers track the canonical
-- schema sources.
drop function if exists public.search_global(uuid, uuid, text, text[], int);

create or replace function public.search_global(
  p_user_id uuid,
  p_tenant_id uuid,
  p_q text,
  p_types text[] default null,
  p_per_type_limit int default 4
)
returns table (
  kind text,
  id uuid,
  title text,
  subtitle text,
  breadcrumb text,
  score real,
  extra jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_q, '')));
  v_pat text;
  v_is_operator boolean;
  v_limit int := greatest(1, least(coalesce(p_per_type_limit, 4), 20));
  v_wants_all boolean := p_types is null or array_length(p_types, 1) is null;
begin
  if length(v_q) < 2 then
    return;
  end if;

  v_pat := '%' || v_q || '%';

  -- Operator gate: any active role assignment OR explicit tickets.read_all.
  select exists (
    select 1
    from public.user_role_assignments ura
    where ura.user_id = p_user_id
      and ura.tenant_id = p_tenant_id
      and ura.active = true
  ) or coalesce(public.user_has_permission(p_user_id, p_tenant_id, 'tickets.read_all'), false)
  into v_is_operator;

  -- Tickets ------------------------------------------------------------------
  if v_wants_all or 'ticket' = any(p_types) then
    return query
      with visible as (
        select v.id from public.ticket_visibility_ids(p_user_id, p_tenant_id) v(id)
      ),
      hits as (
        select
          t.id,
          t.title,
          t.status,
          t.status_category,
          t.created_at,
          t.requester_person_id,
          t.location_id,
          greatest(
            similarity(lower(coalesce(t.title, '')), v_q),
            similarity(lower(coalesce(t.description, '')), v_q) * 0.6::real,
            case when lower(coalesce(t.title, '')) like v_q || '%' then 0.95::real else 0::real end,
            case when right(t.id::text, 12) ilike v_q || '%' then 0.99::real else 0::real end
          )::real as score
        from public.tickets t
        join visible on visible.id = t.id
        where t.tenant_id = p_tenant_id
          and (
            t.title ilike v_pat
            or coalesce(t.description, '') ilike v_pat
            or t.id::text ilike v_pat
            or t.title % v_q
            or coalesce(t.description, '') % v_q
          )
      )
      select
        'ticket'::text,
        h.id,
        h.title,
        upper(left(h.id::text, 8)) || ' · ' || h.status as subtitle,
        null::text,
        h.score,
        jsonb_build_object(
          'status', h.status,
          'status_category', h.status_category,
          'created_at', h.created_at,
          'requester_person_id', h.requester_person_id,
          'location_id', h.location_id
        )
      from hits h
      order by h.score desc, h.created_at desc
      limit v_limit;
  end if;

  -- Persons (operator-only) ---------------------------------------------------
  if v_is_operator and (v_wants_all or 'person' = any(p_types)) then
    return query
      select
        'person'::text,
        p.id,
        (p.first_name || ' ' || p.last_name)::text as title,
        coalesce(p.email, p.cost_center, p.type) as subtitle,
        null::text,
        greatest(
          similarity(lower(p.first_name || ' ' || p.last_name), v_q),
          similarity(lower(coalesce(p.email, '')), v_q) * 0.9::real,
          case when lower(p.first_name) like v_q || '%' or lower(p.last_name) like v_q || '%' then 0.95::real else 0::real end
        )::real as score,
        jsonb_build_object(
          'email', p.email,
          'cost_center', p.cost_center,
          'type', p.type,
          'active', p.active,
          'latest_visitor_id', lv.id
        )
      from public.persons p
      left join lateral (
        select v.id
        from public.visitors v
        where v.tenant_id = p.tenant_id
          and v.person_id = p.id
        order by coalesce(v.expected_at, v.created_at) desc
        limit 1
      ) lv on p.type = 'visitor'
      where p.tenant_id = p_tenant_id
        and p.active = true
        and (
          p.first_name ilike v_pat
          or p.last_name ilike v_pat
          or coalesce(p.email, '') ilike v_pat
          or p.first_name % v_q
          or p.last_name % v_q
        )
      order by score desc
      limit v_limit;
  end if;

  -- Spaces / locations / rooms ------------------------------------------------
  if v_wants_all
     or 'space' = any(p_types)
     or 'room' = any(p_types)
     or 'location' = any(p_types) then
    return query
      select
        case when s.reservable then 'room' else 'space' end as kind,
        s.id,
        s.name,
        coalesce(s.code, s.type) as subtitle,
        null::text as breadcrumb,
        greatest(
          similarity(lower(coalesce(s.name, '')), v_q),
          similarity(lower(coalesce(s.code, '')), v_q) * 0.95::real,
          case when lower(coalesce(s.name, '')) like v_q || '%' then 0.95::real else 0::real end
        )::real as score,
        jsonb_build_object(
          'type', s.type,
          'code', s.code,
          'capacity', s.capacity,
          'parent_id', s.parent_id,
          'reservable', s.reservable
        )
      from public.spaces s
      where s.tenant_id = p_tenant_id
        and s.active = true
        and (
          s.name ilike v_pat
          or coalesce(s.code, '') ilike v_pat
          or s.name % v_q
        )
      order by score desc
      limit v_limit;
  end if;

  -- Assets --------------------------------------------------------------------
  if v_wants_all or 'asset' = any(p_types) then
    return query
      select
        'asset'::text,
        a.id,
        a.label,
        coalesce(a.tag, a.kind) as subtitle,
        null::text,
        greatest(
          similarity(lower(coalesce(a.label, '')), v_q),
          similarity(lower(coalesce(a.tag, '')), v_q) * 0.95::real,
          case when lower(coalesce(a.label, '')) like v_q || '%' then 0.95::real else 0::real end,
          case when lower(coalesce(a.tag, '')) like v_q || '%' then 0.95::real else 0::real end
        )::real as score,
        jsonb_build_object(
          'kind', a.kind,
          'tag', a.tag,
          'space_id', a.space_id
        )
      from public.assets a
      where a.tenant_id = p_tenant_id
        and a.active = true
        and (
          a.label ilike v_pat
          or coalesce(a.tag, '') ilike v_pat
          or a.label % v_q
        )
      order by score desc
      limit v_limit;
  end if;

  -- Vendors -------------------------------------------------------------------
  if v_is_operator and (v_wants_all or 'vendor' = any(p_types)) then
    return query
      select
        'vendor'::text,
        v.id,
        v.name,
        v.contact_email::text,
        null::text,
        greatest(
          similarity(lower(v.name), v_q),
          case when lower(v.name) like v_q || '%' then 0.95::real else 0::real end
        )::real as score,
        jsonb_build_object('contact_email', v.contact_email, 'active', v.active)
      from public.vendors v
      where v.tenant_id = p_tenant_id
        and v.active = true
        and (v.name ilike v_pat or v.name % v_q)
      order by score desc
      limit v_limit;
  end if;

  -- Teams ---------------------------------------------------------------------
  if v_is_operator and (v_wants_all or 'team' = any(p_types)) then
    return query
      select
        'team'::text,
        t.id,
        t.name,
        null::text,
        null::text,
        greatest(
          similarity(lower(t.name), v_q),
          case when lower(t.name) like v_q || '%' then 0.95::real else 0::real end
        )::real as score,
        jsonb_build_object('active', t.active)
      from public.teams t
      where t.tenant_id = p_tenant_id
        and t.active = true
        and (t.name ilike v_pat or t.name % v_q)
      order by score desc
      limit v_limit;
  end if;

  -- Request types -------------------------------------------------------------
  if v_is_operator and (v_wants_all or 'request_type' = any(p_types)) then
    return query
      select
        'request_type'::text,
        rt.id,
        rt.name,
        rt.description::text,
        null::text,
        greatest(
          similarity(lower(rt.name), v_q),
          case when lower(rt.name) like v_q || '%' then 0.95::real else 0::real end
        )::real as score,
        jsonb_build_object('active', rt.active)
      from public.request_types rt
      where rt.tenant_id = p_tenant_id
        and rt.active = true
        and (rt.name ilike v_pat or rt.name % v_q)
      order by score desc
      limit v_limit;
  end if;

  -- Reservations / Bookings (operator-only) -----------------------------------
  -- The 'reservation' kind is preserved for frontend compat, but the source
  -- is now `bookings` (00277:27) joined with the primary `booking_slots` row
  -- (lowest display_order per 00277:154). The hit's `id` is the booking id;
  -- click-through routes to the unified booking detail surface.
  if v_is_operator and (v_wants_all or 'reservation' = any(p_types)) then
    return query
      with hits as (
        select
          b.id,
          b.title,
          b.start_at,
          b.end_at,
          b.requester_person_id,
          ps.space_id,
          greatest(
            similarity(lower(coalesce(b.title, '')), v_q),
            case when lower(coalesce(b.title, '')) like v_q || '%' then 0.95::real else 0::real end,
            case when right(b.id::text, 12) ilike v_q || '%' then 0.99::real else 0::real end
          )::real as score
        from public.bookings b
        left join lateral (
          select bs.space_id
          from public.booking_slots bs
          where bs.booking_id = b.id
            and bs.tenant_id = b.tenant_id
          order by bs.display_order asc, bs.start_at asc
          limit 1
        ) ps on true
        where b.tenant_id = p_tenant_id
          and (
            coalesce(b.title, '') ilike v_pat
            or b.id::text ilike v_pat
            or b.title % v_q
          )
      )
      select
        'reservation'::text,
        h.id,
        h.title,
        to_char(h.start_at, 'YYYY-MM-DD HH24:MI') as subtitle,
        null::text,
        h.score,
        jsonb_build_object(
          'start_at', h.start_at,
          'end_at', h.end_at,
          'space_id', h.space_id,
          'requester_person_id', h.requester_person_id,
          -- Bookings carry no per-row cancelled_at; treat 'cancelled' status
          -- as the equivalent signal for the consumer.
          'cancelled_at', null
        )
      from hits h
      order by h.score desc, h.start_at desc
      limit v_limit;
  end if;

end;
$$;

-- Match 00274 lockdown.
revoke all on function public.search_global(uuid, uuid, text, text[], int) from public;
revoke all on function public.search_global(uuid, uuid, text, text[], int) from anon;
revoke all on function public.search_global(uuid, uuid, text, text[], int) from authenticated;
grant execute on function public.search_global(uuid, uuid, text, text[], int) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Recreate scheduler_data RPC against bookings + booking_slots.
-- ---------------------------------------------------------------------------
-- The desk-scheduler reads via this RPC (apps/api/src/modules/reservations/
-- list-bookable-rooms.service.ts:256). We must preserve the response shape
-- so the frontend `Reservation[]` consumer continues to parse the payload.
-- See `reservation-projection.ts:slotAndBookingToReservation` for the
-- canonical projection — this RPC reproduces it server-side per row.
--
-- Source for the rewrite: 00242_scheduler_data_rpc.sql — only the
-- reservation branch (00242:149-169) changes. Room candidate logic
-- (00242:40-141) is byte-identical.
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
  -- 1. Scope expansion (if a building/floor/site filter is set, restrict
  --    candidates to that subtree). `space_descendants` is the existing
  --    recursive helper from migration 00119.
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

  -- 2. Candidate space ids — reservable rooms that pass capacity +
  --    amenities + scope filters. Hard-capped at 200.
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

  -- 3. Rooms + parent chains (recursive CTE walks up parent_id from each
  --    candidate; capped at depth 8 — real trees are 3–4 deep).
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

  -- 4. Reservations on candidate rooms in the requested window.
  --    Joined as `bookings b` ⨝ `booking_slots bs` ⨝ persons (requester +
  --    host). Each slot row produces one reservation entry — the projection
  --    flattens booking-level fields onto each slot, mirroring the legacy
  --    reservation row shape consumed by the frontend.
  --
  --    Field map (legacy → new source, see reservation-projection.ts):
  --      id, status (overall) ← b.id (booking IS the bundle); slot status
  --                              mirrors booking.status on create
  --      reservation_type     ← bs.slot_type ('asset'→'other' done client-side)
  --      space_id, start_at, end_at, attendee_count, attendee_person_ids,
  --      setup/teardown buffer, effective_*, check_in_*, cancellation_grace ←
  --                              bs.* (slot fields)
  --      requester_person_id, host_person_id, source, booked_by_user_id,
  --      cost_amount_snapshot, policy_snapshot, applied_rule_ids,
  --      calendar_*, recurrence_series_id, recurrence_index,
  --      recurrence_overridden, recurrence_skipped, created_at, updated_at,
  --      booking_bundle_id (= b.id) ← b.* (booking fields)
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
             'multi_room_group_id',      null,
             'calendar_event_id',        b.calendar_event_id,
             'calendar_provider',        b.calendar_provider,
             'calendar_etag',            b.calendar_etag,
             'calendar_last_synced_at',  b.calendar_last_synced_at,
             'booking_bundle_id',        b.id,
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

commit;

notify pgrst, 'reload schema';
