-- search_global: restore the asset branch + two other invariants 00274 quietly
-- dropped.
--
-- 00274 (search_global_visitor_id) claimed in its header that "every other
-- branch (tickets, spaces, assets, vendors, teams, request_types,
-- reservations) is byte-identical to the previous shipped version (00158)."
-- That claim was false in THREE places — all carried forward into 00282
-- (search_global_visitor_building) and live on remote until this migration:
--
--   1. Asset branch — 00274 replaced it with a body that references columns
--      that don't exist on `assets` (a.label, a.kind, a.active, a.space_id).
--      The actual schema (00005_assets.sql + later normalizations) carries
--      `a.name`, `a.asset_role`, `a.assigned_space_id`, and has no `active`
--      column. Every unfiltered call to the RPC (p_types is null — the
--      default for admin/agent users via
--      apps/web/src/components/command-palette/command-palette-body.tsx
--      `backendRequestedTypes`) executes this branch and raises
--      `column a.label does not exist`, killing the entire RPC.
--      End-user symptom: ⌘K command palette returns no results for any
--      operator user (verified live on remote against the prod DB).
--
--   2. User-existence guard — 00151 (defense_in_depth) added an early-return
--      guard at the top of the function body:
--        `if not exists (select 1 from public.users u where u.id = p_user_id
--        and u.tenant_id = p_tenant_id) then return; end if;`
--      00158 kept it. 00274 silently dropped it. This is a security_definer
--      function trusting caller-supplied (p_user_id, p_tenant_id); the
--      current API caller (apps/api/src/modules/search/search.service.ts)
--      resolves auth_uid → users.id under the tenant predicate so it's safe
--      in practice today, but the function itself should not trust callers.
--      Restored verbatim from 00151.
--
--   3. Spaces breadcrumb — 00158:154 returned `public.space_breadcrumb(s.id)
--      as breadcrumb` for the spaces branch; 00274 flipped it to
--      `null::text`. The frontend reads `hit.breadcrumb` in both the row
--      body (command-palette-body.tsx ResultRow line ~887-891 — prefers
--      breadcrumb over subtitle) and the spaces HoverCard (line ~981).
--      Operators have been seeing only the subtitle (code / type) since
--      00274 shipped — no building → floor → room context line. Restored.
--
-- This migration recreates search_global with:
--   - User-existence guard restored at the top (fix #2).
--   - Asset branch restored to the canonical 00158 shape (fix #1):
--       * operator-gated (`v_is_operator`),
--       * joined to asset_types WITH `at.tenant_id = a.tenant_id` defense-
--         in-depth (the 00158 form omitted the tenant predicate on the join
--         — a pre-existing gap; tightened here per project rule "missing
--         tenant filter on a new query is a leak, not a bug"),
--       * uses a.name / a.asset_role / a.assigned_space_id / a.serial_number,
--       * no a.active predicate — assets have no `active` column,
--       * `public.space_breadcrumb(a.assigned_space_id)` for breadcrumb.
--   - Spaces branch with `public.space_breadcrumb(s.id)` restored (fix #3).
--   - Every remaining branch (tickets / persons LATERAL with building snap +
--     visitor_visibility_ids gate + terminal-status exclusion / vendors /
--     teams / request_types / reservations via bookings + booking_slots)
--     byte-identical to 00282.
--
-- DO NOT COPY 00282's asset / persons-guard-missing / spaces-breadcrumb-null
-- shapes into any future search_global migration. If you base a new revision
-- off 00282 you'll re-introduce all three regressions. Base off this file.
--
-- Verified columns on remote (information_schema.columns):
--   assets:      id, tenant_id, asset_type_id, asset_role, name, tag,
--                serial_number, status, assigned_person_id, assigned_space_id,
--                assignment_type, assignment_start_at, assignment_end_at,
--                linked_order_line_item_id, purchase_date, lifecycle_state,
--                external_source_id, created_at, updated_at,
--                override_team_id, override_vendor_id.
--   asset_types: id, tenant_id, name, description, default_role, active,
--                created_at, default_team_id, default_vendor_id.
-- Verified `public.space_breadcrumb(uuid)` exists.

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

  -- Defence in depth (00151): refuse if the (user, tenant) pair isn't real,
  -- even though the grant lockdown already prevents direct PostgREST calls.
  -- This makes the contract enforceable for any future service-role caller.
  -- 00274 dropped this guard silently; restored here.
  if not exists (
    select 1 from public.users u
    where u.id = p_user_id and u.tenant_id = p_tenant_id
  ) then
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
  -- See 00282 header — LATERAL visit lookup gated through
  -- visitor_visibility_ids; excludes terminal not-attended statuses; surfaces
  -- latest_visitor_building_id for desk-layout building snap.
  if v_is_operator and (v_wants_all or 'person' = any(p_types)) then
    return query
      with visible_visitors as (
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
  -- Breadcrumb restored from 00158:154; 00274/00282 had `null::text` here.
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
        public.space_breadcrumb(s.id) as breadcrumb,
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

  -- Assets (operator-only) ----------------------------------------------------
  -- Canonical from 00158, with `at.tenant_id = a.tenant_id` defense-in-depth
  -- added on the asset_types join (00158 omitted it). The 00274/00282
  -- versions referenced nonexistent columns (a.label/a.kind/a.active/a.space_id)
  -- and broke the whole RPC for any unfiltered call.
  if v_is_operator and (v_wants_all or 'asset' = any(p_types)) then
    return query
      select
        'asset'::text,
        a.id,
        a.name,
        coalesce(at.name, a.asset_role) || case when a.tag is not null then ' · ' || a.tag else '' end as subtitle,
        public.space_breadcrumb(a.assigned_space_id) as breadcrumb,
        greatest(
          similarity(lower(a.name), v_q),
          similarity(lower(coalesce(a.tag, '')), v_q) * 0.95::real,
          similarity(lower(coalesce(a.serial_number, '')), v_q) * 0.85::real,
          case when lower(coalesce(a.tag, '')) like v_q || '%' then 0.99::real else 0::real end
        )::real as score,
        jsonb_build_object(
          'tag', a.tag,
          'serial_number', a.serial_number,
          'status', a.status,
          'asset_role', a.asset_role,
          'asset_type_name', at.name
        )
      from public.assets a
      left join public.asset_types at
        on at.id = a.asset_type_id
       and at.tenant_id = a.tenant_id
      where a.tenant_id = p_tenant_id
        and (
          a.name ilike v_pat
          or coalesce(a.tag, '') ilike v_pat
          or coalesce(a.serial_number, '') ilike v_pat
          or a.name % v_q
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
  -- Source is `bookings` joined with the primary `booking_slots` row (lowest
  -- display_order per 00277:154); hit id is the booking id. Byte-identical to
  -- the 00280/00282 reservation branch.
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
          'cancelled_at', null
        )
      from hits h
      order by h.score desc, h.start_at desc
      limit v_limit;
  end if;

end;
$$;

-- Lock down per 00137_search_global_grant_lockdown.sql.
revoke all on function public.search_global(uuid, uuid, text, text[], int) from public;
revoke all on function public.search_global(uuid, uuid, text, text[], int) from anon;
revoke all on function public.search_global(uuid, uuid, text, text[], int) from authenticated;
grant execute on function public.search_global(uuid, uuid, text, text[], int) to service_role;

notify pgrst, 'reload schema';
