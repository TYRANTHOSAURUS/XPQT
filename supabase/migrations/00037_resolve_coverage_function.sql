-- Routing Studio — coverage matrix support.
--
-- Purpose: given a set of spaces and domains, return one resolution row per
-- (space, domain) pair showing which team/vendor would handle it today and
-- *why* (direct, inherited from parent, via space group, via domain fallback,
-- or uncovered).
--
-- This mirrors the TypeScript ResolverService's location-chain walk but
-- without routing_rules / asset / request-type-default paths — those depend
-- on request-type metadata that isn't part of "coverage" as a concept.
--
-- Runtime: one call resolves N*M cells. Read-only (STABLE).
-- Rollback: drop both functions. No schema changes, no data.

create or replace function public.resolve_coverage_cell(
  p_tenant_id uuid,
  p_space_id  uuid,
  p_domain    text
)
returns table (
  chosen_by            text,
  target_kind          text,
  target_id            uuid,
  via_parent_space_id  uuid,
  via_space_group_id   uuid,
  via_parent_domain    text
)
language plpgsql
stable
as $$
declare
  v_chain_domain text;
  v_chain_space  uuid;
  v_depth_d      int := 0;
  v_depth_s      int;
  v_hit_team     uuid;
  v_hit_vendor   uuid;
  v_hit_group    uuid;
begin
  v_chain_domain := p_domain;

  loop
    v_chain_space := p_space_id;
    v_depth_s := 0;

    -- Walk the location chain for this (current) domain.
    loop
      exit when v_chain_space is null or v_depth_s > 10;

      -- 1. Direct location_teams row for (space, domain)
      select lt.team_id, lt.vendor_id
      into v_hit_team, v_hit_vendor
      from public.location_teams lt
      where lt.space_id = v_chain_space
        and lt.domain   = v_chain_domain
        and lt.tenant_id = p_tenant_id
      limit 1;

      if found then
        if v_depth_d > 0 then
          chosen_by := 'domain_fallback';
          via_parent_domain   := v_chain_domain;
          via_parent_space_id := case when v_depth_s > 0 then v_chain_space else null end;
        elsif v_depth_s > 0 then
          chosen_by := 'parent';
          via_parent_space_id := v_chain_space;
          via_parent_domain   := null;
        else
          chosen_by := 'direct';
          via_parent_space_id := null;
          via_parent_domain   := null;
        end if;
        via_space_group_id := null;
        if v_hit_team is not null then
          target_kind := 'team';   target_id := v_hit_team;
        elsif v_hit_vendor is not null then
          target_kind := 'vendor'; target_id := v_hit_vendor;
        else
          target_kind := null;     target_id := null;
        end if;
        return next;
        return;
      end if;

      -- 2. Space-group match: any group this space belongs to with a row for this domain
      select lt.team_id, lt.vendor_id, lt.space_group_id
      into v_hit_team, v_hit_vendor, v_hit_group
      from public.space_group_members sgm
      join public.location_teams lt on lt.space_group_id = sgm.space_group_id
      where sgm.space_id  = v_chain_space
        and lt.domain     = v_chain_domain
        and lt.tenant_id  = p_tenant_id
      limit 1;

      if found then
        if v_depth_d > 0 then
          chosen_by := 'domain_fallback';
          via_parent_domain := v_chain_domain;
        else
          chosen_by := 'space_group';
          via_parent_domain := null;
        end if;
        via_parent_space_id := case when v_depth_s > 0 then v_chain_space else null end;
        via_space_group_id  := v_hit_group;
        if v_hit_team is not null then
          target_kind := 'team';   target_id := v_hit_team;
        elsif v_hit_vendor is not null then
          target_kind := 'vendor'; target_id := v_hit_vendor;
        end if;
        return next;
        return;
      end if;

      -- 3. Advance up the space hierarchy
      select s.parent_id into v_chain_space from public.spaces s where s.id = v_chain_space;
      v_depth_s := v_depth_s + 1;
    end loop;

    -- Nothing matched at this domain; try the next parent domain (cycle-safe via depth cap).
    v_depth_d := v_depth_d + 1;
    exit when v_depth_d > 10;

    select dp.parent_domain into v_chain_domain
    from public.domain_parents dp
    where dp.domain = v_chain_domain
      and dp.tenant_id = p_tenant_id;

    if not found or v_chain_domain is null then
      exit;
    end if;
  end loop;

  -- No match anywhere.
  chosen_by           := 'uncovered';
  target_kind         := null;
  target_id           := null;
  via_parent_space_id := null;
  via_space_group_id  := null;
  via_parent_domain   := null;
  return next;
end;
$$;

comment on function public.resolve_coverage_cell(uuid, uuid, text) is
  'Routing Studio coverage helper. Resolves one (space, domain) cell using the same chain logic as ResolverService''s location branch + domain fallback.';


create or replace function public.resolve_coverage(
  p_tenant_id uuid,
  p_space_ids uuid[],
  p_domains   text[]
)
returns table (
  space_id             uuid,
  domain               text,
  chosen_by            text,
  target_kind          text,
  target_id            uuid,
  via_parent_space_id  uuid,
  via_space_group_id   uuid,
  via_parent_domain    text
)
language sql
stable
as $$
  select
    s.id                    as space_id,
    d.domain                as domain,
    r.chosen_by,
    r.target_kind,
    r.target_id,
    r.via_parent_space_id,
    r.via_space_group_id,
    r.via_parent_domain
  from unnest(p_space_ids) as s(id)
  cross join unnest(p_domains) as d(domain),
  lateral public.resolve_coverage_cell(p_tenant_id, s.id, d.domain) r;
$$;

comment on function public.resolve_coverage(uuid, uuid[], text[]) is
  'Routing Studio coverage matrix. Returns one row per (space, domain) cell with resolution outcome.';

-- PostgREST schema reload so the RPC is visible to the API layer immediately.
notify pgrst, 'reload schema';
