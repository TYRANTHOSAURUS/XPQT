-- search_global: include latest_visitor_id in person hits where type='visitor'.
--
-- The command palette splits person hits into a synthetic 'visitor' kind for
-- visitor-typed persons (extra.type === 'visitor'). Visitor hits then deep-link
-- to /desk/visitors/<visitor_id>. Without latest_visitor_id in the payload, the
-- frontend has only persons.id — which is the wrong target route (the visitor
-- record's id lives on public.visitors, not public.persons).
--
-- This migration adds a LATERAL lookup of the most-recent visitors row for
-- each person hit. For non-visitor persons, the lookup returns null and the
-- field is absent from extra. Performance: pulls one row per hit via the
-- existing (tenant_id, person_id) join; visitor lists are short per-person.
--
-- Re-applies the entire search_global function with the only change being the
-- persons-branch jsonb_build_object — every other branch (tickets, spaces,
-- assets, vendors, teams, request_types, reservations) is byte-identical to
-- the previous shipped version (00158).

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
  -- For visitor-typed persons we LATERAL-join the most-recent visitors row so
  -- the frontend can route directly to /desk/visitors/<latest_visitor_id>.
  -- The join filters by tenant + person_id; visitor lists per person are
  -- short (typically 1-N visits), so the per-row cost is small.
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

  -- Reservations (operator-only) ----------------------------------------------
  if v_is_operator and (v_wants_all or 'reservation' = any(p_types)) then
    return query
      with hits as (
        select
          r.id,
          r.title,
          r.start_at,
          r.end_at,
          r.space_id,
          r.requester_person_id,
          r.cancelled_at,
          greatest(
            similarity(lower(coalesce(r.title, '')), v_q),
            case when lower(coalesce(r.title, '')) like v_q || '%' then 0.95::real else 0::real end,
            case when right(r.id::text, 12) ilike v_q || '%' then 0.99::real else 0::real end
          )::real as score
        from public.reservations r
        where r.tenant_id = p_tenant_id
          and (
            r.title ilike v_pat
            or r.id::text ilike v_pat
            or r.title % v_q
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
          'cancelled_at', h.cancelled_at
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
