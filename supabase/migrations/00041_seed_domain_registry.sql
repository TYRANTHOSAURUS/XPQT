-- 00041_seed_domain_registry.sql
-- Workstream G / Artifact D steps 3-5: backfill public.domains from
-- existing free-text domain columns and wire domain_id FKs.
--
-- Idempotent: re-running is a no-op. Uses ON CONFLICT DO NOTHING and
-- WHERE ... IS NULL guards so partial states converge instead of diverging.
--
-- NOT the cutover step. Free-text columns (request_types.domain,
-- location_teams.domain, domain_parents.domain, .parent_domain) stay
-- populated during dual-run. Artifact D step 9 drops them after
-- routing_v2_mode=v2_only has stabilized.

-- 1. Seed public.domains from distinct free-text values across all callers.
insert into public.domains (tenant_id, key, display_name, active)
select distinct
  tenant_id,
  lower(trim(domain))                                            as key,
  initcap(replace(lower(trim(domain)), '_', ' '))                as display_name,
  true
from (
  select tenant_id, domain from public.request_types
    where domain is not null and trim(domain) <> ''
  union
  select tenant_id, domain from public.location_teams
    where domain is not null and trim(domain) <> ''
  union
  select tenant_id, domain from public.domain_parents
    where domain is not null and trim(domain) <> ''
  union
  select tenant_id, parent_domain as domain from public.domain_parents
    where parent_domain is not null and trim(parent_domain) <> ''
) all_uses
on conflict (tenant_id, key) do nothing;

-- 2. request_types.domain_id — backfill from free-text domain.
update public.request_types rt
set domain_id = d.id
from public.domains d
where d.tenant_id = rt.tenant_id
  and d.key = lower(trim(rt.domain))
  and rt.domain_id is null
  and rt.domain is not null
  and trim(rt.domain) <> '';

-- 3. location_teams.domain_id
update public.location_teams lt
set domain_id = d.id
from public.domains d
where d.tenant_id = lt.tenant_id
  and d.key = lower(trim(lt.domain))
  and lt.domain_id is null
  and lt.domain is not null
  and trim(lt.domain) <> '';

-- 4. domain_parents: both domain_id and parent_domain_id FKs.
update public.domain_parents dp
set domain_id = d.id
from public.domains d
where d.tenant_id = dp.tenant_id
  and d.key = lower(trim(dp.domain))
  and dp.domain_id is null
  and dp.domain is not null
  and trim(dp.domain) <> '';

update public.domain_parents dp
set parent_domain_id = d.id
from public.domains d
where d.tenant_id = dp.tenant_id
  and d.key = lower(trim(dp.parent_domain))
  and dp.parent_domain_id is null
  and dp.parent_domain is not null
  and trim(dp.parent_domain) <> '';

-- 5. Propagate parent_domain relationships into the registry itself so the
-- recursive walk in ChildExecutionResolverService / coverage SQL can use
-- domain_id alone without joining domain_parents.
update public.domains child
set parent_domain_id = parent.id
from public.domain_parents dp
join public.domains parent
  on parent.tenant_id = dp.tenant_id
  and parent.key = lower(trim(dp.parent_domain))
where child.tenant_id = dp.tenant_id
  and child.key = lower(trim(dp.domain))
  and child.parent_domain_id is null
  and trim(dp.parent_domain) <> '';
