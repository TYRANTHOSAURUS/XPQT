-- 00056_portal_onboardable_locations.sql
-- Portal scope slice — onboarding UX: returns sites/buildings that have at least
-- one active request type whose location_granularity has an eligible descendant
-- under that root. Used by the self-onboard picker so users don't pick a site
-- that would immediately produce an empty catalog.
--
-- Not filtered by person — v1 doesn't have role-based RT visibility (codex Q6:
-- future service-scope restrictions AND with authorized set, never replace it).
-- Every employee sees the same onboardable-location set pre-claim; post-claim
-- the catalog is still gated by portal_availability_trace.

create or replace function public.portal_onboardable_locations(p_tenant_id uuid)
returns setof uuid language sql stable as $$
  select distinct s.id
  from public.spaces s
  where s.tenant_id = p_tenant_id
    and s.active = true
    and s.type in ('site','building')
    and exists (
      select 1
      from public.request_types rt
      where rt.tenant_id = p_tenant_id
        and rt.active = true
        and public.portal_request_type_has_eligible_descendant(s.id, rt.location_granularity, p_tenant_id)
    );
$$;
