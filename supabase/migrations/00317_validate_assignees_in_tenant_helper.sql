-- B.2.A.2 — validate_assignees_in_tenant helper.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.8 (line 2405) +
-- §4 (line 3101).
--
-- PL/pgSQL drop-in port of TS validateAssigneesInTenant
-- (apps/api/src/common/tenant-validation.ts:330-371). Used by every B.2
-- combined RPC that accepts assignment patches (set_entity_assignment,
-- update_entity_combined, dispatch_child_work_order,
-- create_ticket_with_automation, etc.) to enforce that every non-null
-- assignee uuid references a row in (teams|users|vendors) with
-- tenant_id matching p_tenant_id.
--
-- Defense-in-depth against a buggy or compromised TS preflight passing
-- foreign-tenant ids past supabase-js .eq(tenant_id) filters — same
-- rationale as validate_attach_plan_tenant_fks (00303). PostgreSQL's
-- own REFERENCES clause checks existence, not tenant.
--
-- SECURITY DEFINER — runs with the function-owner's privileges so the
-- helper can read teams/users/vendors regardless of the caller's RLS.
-- search_path is locked to (public, pg_catalog) to prevent search-path
-- hijacking. Caller is the combined RPC (already running as
-- service_role); this helper trusts that.
--
-- Failures raise 42501 with code-style messages matching the TS
-- contract: 'validate_assignees_in_tenant.<field>_not_in_tenant'.

create or replace function public.validate_assignees_in_tenant(
  p_tenant_id uuid,
  p_team_id   uuid default null,
  p_user_id   uuid default null,
  p_vendor_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_team_id is not null then
    perform 1 from public.teams
     where id = p_team_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'validate_assignees_in_tenant.assigned_team_id_not_in_tenant: % does not reference a known team in tenant %', p_team_id, p_tenant_id
        using errcode = '42501';
    end if;
  end if;

  if p_user_id is not null then
    perform 1 from public.users
     where id = p_user_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'validate_assignees_in_tenant.assigned_user_id_not_in_tenant: % does not reference a known user in tenant %', p_user_id, p_tenant_id
        using errcode = '42501';
    end if;
  end if;

  if p_vendor_id is not null then
    perform 1 from public.vendors
     where id = p_vendor_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'validate_assignees_in_tenant.assigned_vendor_id_not_in_tenant: % does not reference a known vendor in tenant %', p_vendor_id, p_tenant_id
        using errcode = '42501';
    end if;
  end if;
end;
$$;

revoke execute on function public.validate_assignees_in_tenant(uuid, uuid, uuid, uuid) from public;
grant  execute on function public.validate_assignees_in_tenant(uuid, uuid, uuid, uuid) to service_role;

comment on function public.validate_assignees_in_tenant(uuid, uuid, uuid, uuid) is
  'PL/pgSQL drop-in port of TS validateAssigneesInTenant (apps/api/src/common/tenant-validation.ts:330-371). Validates each non-null assignee uuid (team / user / vendor) belongs to p_tenant_id. SECURITY DEFINER with locked search_path. Raises 42501 ''validate_assignees_in_tenant.<field>_not_in_tenant'' on first miss. Spec: docs/follow-ups/b2-survey-and-design.md §3.8.';
