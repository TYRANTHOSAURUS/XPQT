-- Global search (⌘K command palette) -----------------------------------------
--
-- Provides one RPC `public.search_global(p_user_id, p_tenant_id, p_q, p_types,
-- p_per_type_limit)` that fans out across the searchable entity tables and
-- returns a unified `(kind, id, title, subtitle, breadcrumb, score, extra)`
-- rowset. The RPC is the single round-trip that backs the global command
-- palette in the web app.
--
-- Performance:
--   * Trigram GIN indexes on every searched text column → ILIKE '%q%' is index-
--     served, similarity() is fast.
--   * Per-type LIMIT inside each CTE keeps the working set small.
--   * Score = similarity(target, q) with a small bonus for prefix matches so
--     "TKT" finds tickets that start with TKT before fuzzy hits.
--
-- Visibility:
--   * Tickets are scoped through `public.ticket_visibility_ids` — same RLS
--     contract as the desk list page.
--   * Persons / assets / vendors / teams are operator-only — gated on the user
--     having at least one active role assignment in the tenant. Pure portal
--     users only get tickets + spaces + request types back.
--   * All results are tenant-isolated. Tenant comes from the caller (NestJS
--     resolves it from subdomain via TenantMiddleware).

create extension if not exists pg_trgm;

-- Trigram GIN indexes ---------------------------------------------------------
-- gin_trgm_ops makes both `field % 'q'` and `field ILIKE '%q%'` index-served.
-- We add them per searchable column rather than concatenating into a tsvector
-- because the palette ranks fuzzy matches and shows the matching field as the
-- title — not a stemmed haystack.

create index if not exists idx_tickets_title_trgm
  on public.tickets using gin (title gin_trgm_ops);

create index if not exists idx_tickets_description_trgm
  on public.tickets using gin (description gin_trgm_ops)
  where description is not null;

create index if not exists idx_persons_first_name_trgm
  on public.persons using gin (first_name gin_trgm_ops);

create index if not exists idx_persons_last_name_trgm
  on public.persons using gin (last_name gin_trgm_ops);

create index if not exists idx_persons_email_trgm
  on public.persons using gin (email gin_trgm_ops)
  where email is not null;

create index if not exists idx_spaces_name_trgm
  on public.spaces using gin (name gin_trgm_ops);

create index if not exists idx_spaces_code_trgm
  on public.spaces using gin (code gin_trgm_ops)
  where code is not null;

create index if not exists idx_assets_name_trgm
  on public.assets using gin (name gin_trgm_ops);

create index if not exists idx_assets_tag_trgm
  on public.assets using gin (tag gin_trgm_ops)
  where tag is not null;

create index if not exists idx_assets_serial_trgm
  on public.assets using gin (serial_number gin_trgm_ops)
  where serial_number is not null;

create index if not exists idx_vendors_name_trgm
  on public.vendors using gin (name gin_trgm_ops);

create index if not exists idx_teams_name_trgm
  on public.teams using gin (name gin_trgm_ops);

create index if not exists idx_request_types_name_trgm
  on public.request_types using gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Helper: ancestor breadcrumb for a space
-- ---------------------------------------------------------------------------
-- Returns "Site › Building › Floor › Room" walking up parent_id, skipping the
-- space itself. NULL for top-level. Stable so it can be inlined in selects.

create or replace function public.space_breadcrumb(p_space_id uuid)
returns text
language sql stable
as $$
  with recursive chain as (
    select s.id, s.parent_id, s.name, 0 as depth
    from public.spaces s
    where s.id = p_space_id
    union all
    select s.id, s.parent_id, s.name, c.depth + 1
    from public.spaces s
    join chain c on s.id = c.parent_id
    where c.depth < 20
  )
  select string_agg(name, ' › ' order by depth desc)
  from chain
  where depth > 0;
$$;

-- ---------------------------------------------------------------------------
-- search_global RPC
-- ---------------------------------------------------------------------------

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
          'active', p.active
        )
      from public.persons p
      where p.tenant_id = p_tenant_id
        and p.active = true
        and (
          p.first_name ilike v_pat
          or p.last_name ilike v_pat
          or coalesce(p.email, '') ilike v_pat
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
        s.type::text as subtitle,
        public.space_breadcrumb(s.id) as breadcrumb,
        greatest(
          similarity(lower(s.name), v_q),
          similarity(lower(coalesce(s.code, '')), v_q) * 0.9::real,
          case when lower(s.name) like v_q || '%' then 0.95::real else 0::real end
        )::real as score,
        jsonb_build_object(
          'type', s.type,
          'code', s.code,
          'reservable', s.reservable,
          'capacity', s.capacity
        )
      from public.spaces s
      where s.tenant_id = p_tenant_id
        and s.active = true
        and (s.name ilike v_pat or coalesce(s.code, '') ilike v_pat)
      order by score desc
      limit v_limit;
  end if;

  -- Assets (operator-only) ----------------------------------------------------
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
      left join public.asset_types at on at.id = a.asset_type_id
      where a.tenant_id = p_tenant_id
        and (
          a.name ilike v_pat
          or coalesce(a.tag, '') ilike v_pat
          or coalesce(a.serial_number, '') ilike v_pat
        )
      order by score desc
      limit v_limit;
  end if;

  -- Vendors (operator-only) ---------------------------------------------------
  if v_is_operator and (v_wants_all or 'vendor' = any(p_types)) then
    return query
      select
        'vendor'::text,
        v.id,
        v.name,
        coalesce(v.contact_email, 'Vendor') as subtitle,
        null::text,
        similarity(lower(v.name), v_q)::real as score,
        jsonb_build_object(
          'contact_email', v.contact_email,
          'contact_phone', v.contact_phone,
          'active', v.active
        )
      from public.vendors v
      where v.tenant_id = p_tenant_id
        and v.active = true
        and v.name ilike v_pat
      order by score desc
      limit v_limit;
  end if;

  -- Teams (operator-only) -----------------------------------------------------
  if v_is_operator and (v_wants_all or 'team' = any(p_types)) then
    return query
      select
        'team'::text,
        t.id,
        t.name,
        coalesce(t.domain_scope, 'Team') as subtitle,
        null::text,
        similarity(lower(t.name), v_q)::real as score,
        jsonb_build_object(
          'domain_scope', t.domain_scope,
          'active', t.active
        )
      from public.teams t
      where t.tenant_id = p_tenant_id
        and t.active = true
        and t.name ilike v_pat
      order by score desc
      limit v_limit;
  end if;

  -- Request types -------------------------------------------------------------
  if v_wants_all or 'request_type' = any(p_types) then
    return query
      select
        'request_type'::text,
        rt.id,
        rt.name,
        coalesce(rt.domain, 'Request type') as subtitle,
        null::text,
        similarity(lower(rt.name), v_q)::real as score,
        jsonb_build_object(
          'domain', rt.domain,
          'active', rt.active
        )
      from public.request_types rt
      where rt.tenant_id = p_tenant_id
        and rt.active = true
        and rt.name ilike v_pat
      order by score desc
      limit v_limit;
  end if;
end;
$$;

grant execute on function public.search_global(uuid, uuid, text, text[], int) to authenticated, anon, service_role;
grant execute on function public.space_breadcrumb(uuid) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
