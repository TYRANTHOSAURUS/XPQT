-- Single-shot scheduler-data RPC.
--
-- Replaces the per-leg fan-out (candidate query → parent chains RPC →
-- reservations query) with one server-side function that returns the
-- entire payload as JSONB. Cuts the desk scheduler's first paint from
-- "three sequential Supabase REST round-trips" to "one Postgres call",
-- which is roughly an additional ~80–150 ms on warm caches.
--
-- The function is `stable` and `security definer` so PostgREST can
-- invoke it on behalf of the API; tenant scoping is enforced via the
-- explicit `p_tenant_id` parameter and the API resolves the current
-- tenant before calling. Rule outcomes are NOT computed here — they
-- still go through the TS RuleResolver because predicate evaluation
-- needs JS-defined helpers; the API merges them into `rule_outcome`
-- after this function returns.
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
  --    amenities + scope filters. Hard-capped at 200 to keep latency
  --    bounded; the desk scheduler virtualises rows so > 200 is a UI
  --    smell anyway.
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

  -- 3. Rooms + parent chains. The recursive CTE walks up parent_id from
  --    each candidate; capped at depth 8 (real trees are 3–4 deep).
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

  -- 4. Reservations on candidate rooms in the requested window with
  --    requester / host name joins — same shape the legacy
  --    `loadReservationsForWindow` produces, so the API doesn't have to
  --    rewrap. `to_jsonb(r) - 'time_range'` strips the tsrange index
  --    column the frontend doesn't read (and which JSON-encodes to a
  --    string that would only confuse downstream parsers).
  select coalesce(jsonb_agg(
           (to_jsonb(r) - 'time_range') ||
           jsonb_build_object(
             'requester_first_name', rp.first_name,
             'requester_last_name',  rp.last_name,
             'requester_email',      rp.email,
             'host_first_name',      hp.first_name,
             'host_last_name',       hp.last_name,
             'host_email',           hp.email
           ) order by r.start_at
         ), '[]'::jsonb)
    into v_reservations
    from public.reservations r
    left join public.persons rp on rp.id = r.requester_person_id
    left join public.persons hp on hp.id = r.host_person_id
   where r.tenant_id = p_tenant_id
     and r.space_id  = any(v_candidate_ids)
     and r.status    in ('confirmed', 'checked_in', 'pending_approval')
     and r.effective_start_at < p_end_at
     and r.effective_end_at   > p_start_at
   limit 2000;

  return jsonb_build_object(
    'rooms',        coalesce(v_rooms,        '[]'::jsonb),
    'reservations', coalesce(v_reservations, '[]'::jsonb)
  );
end
$$;

notify pgrst, 'reload schema';
