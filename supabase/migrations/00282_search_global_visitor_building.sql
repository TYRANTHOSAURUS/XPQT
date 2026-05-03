-- search_global: surface latest_visitor_building_id, gate visitor LATERAL
-- through visitor_visibility_ids, and exclude terminal no-show statuses.
--
-- Why (three coupled fixes):
--
-- 1. Frontend deep-link to /desk/visitors/<id> needs the visitor's building_id
--    so the desk layout's ReceptionBuildingProvider snaps to the correct
--    building (otherwise it sticks to the user's last-picked building from
--    localStorage, leaving the surrounding sidebar / list view scoped to the
--    wrong site — operator hits Back from the detail and sees an empty list).
--
-- 2. The persons branch's LATERAL was projecting `lv.id` (and now wants
--    `lv.building_id`) WITHOUT consulting visitor_visibility_ids — a Tier 2
--    operator scoped to building A could learn that "James Doe" was at
--    building B even though they have no visibility on building B's
--    visitors. The 3-tier visibility model in 00255/00259/00267 was meant
--    to be the boundary; the search payload bypasses it. Now gated.
--
-- 3. The LATERAL was picking the FUTUREMOST scheduled visit, including
--    cancelled / no-show rows. Reception searching for "James" right now
--    would deep-link to next month's pre-registration over today's check-in.
--    Filter out terminal-not-attended states and sort by absolute time
--    distance from now, with currently-on-site visits winning.
--
-- Non-persons branches: copied byte-identical from 00280 (which is the most
-- recent shipped baseline — 00280 dropped public.reservations and rewrote
-- the reservation branch against bookings + booking_slots). Re-deriving from
-- 00274 here would resurrect a now-dropped relation.

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
  --
  -- For visitor-typed persons we LATERAL-join the most-relevant visible visit
  -- so the frontend can route directly to /desk/visitors/<latest_visitor_id>
  -- AND pre-set the reception building context. The LATERAL is gated on
  -- public.visitor_visibility_ids so we only ever surface visit ids the
  -- searching operator could open anyway — same boundary the visitor
  -- service enforces.
  --
  -- Ordering: prefer currently-on-site (arrived / in_meeting), then nearest
  -- to "now" by absolute time distance. Excludes terminal not-attended
  -- statuses (cancelled / no_show / denied) — those are dead-ends for "find
  -- this visitor" intent.
  --
  -- Defense in depth: re-validate spaces.tenant_id for the surfaced
  -- building_id even though visitors.building_id should already be tenant-
  -- scoped via the visitors row's tenant. Cheap (covered by spaces PK) and
  -- matches the project's tenant-defense posture.
  if v_is_operator and (v_wants_all or 'person' = any(p_types)) then
    return query
      with visible_visitors as (
        -- Materialize the 3-tier visibility set once per call. Inlining the
        -- function in a per-row subquery would re-run it for every persons
        -- match (O(matches × visibility-cost)).
        select vv as id
        from public.visitor_visibility_ids(p_user_id, p_tenant_id) vv
      )
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
          'latest_visitor_id', lv.id,
          'latest_visitor_building_id', lv.building_id
        )
      from public.persons p
      left join lateral (
        select v.id, v.building_id
        from public.visitors v
        join visible_visitors vv on vv.id = v.id
        where p.type = 'visitor'
          and v.tenant_id = p.tenant_id
          and v.person_id = p.id
          and v.status not in ('cancelled', 'no_show', 'denied')
          and (
            v.building_id is null
            or exists (
              select 1
              from public.spaces s
              where s.id = v.building_id
                and s.tenant_id = p.tenant_id
            )
          )
        order by
          case when v.status in ('arrived', 'in_meeting') then 0 else 1 end,
          abs(extract(epoch from (now() - coalesce(v.expected_at, v.created_at)))) asc
        limit 1
      ) lv on true
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
  -- is `bookings` (00277) joined with the primary `booking_slots` row
  -- (lowest display_order per 00277:154). The hit's `id` is the booking id.
  -- Branch copied byte-identical from 00280.
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

-- Lock down per the existing pattern (00137_search_global_grant_lockdown.sql).
revoke all on function public.search_global(uuid, uuid, text, text[], int) from public;
revoke all on function public.search_global(uuid, uuid, text, text[], int) from anon;
revoke all on function public.search_global(uuid, uuid, text, text[], int) from authenticated;
grant execute on function public.search_global(uuid, uuid, text, text[], int) to service_role;

notify pgrst, 'reload schema';
