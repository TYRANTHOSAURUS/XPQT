-- 00094_request_type_replace_fns.sql
-- Codex Phase C/D review follow-up:
--   1. Service-layer replace-set writes were non-transactional (delete → insert
--      across two Supabase calls). An insert failure after delete lost the
--      prior config set. Fix: plpgsql functions per satellite so the delete +
--      insert run in a single implicit transaction.
--   2. request_type_coverage_rules had no active-row uniqueness. Duplicate
--      active rows made matched_coverage_rule_id insertion-order-dependent in
--      request_type_offering_matches. Fix: partial unique indexes mirroring
--      the 00091 scope_overrides pattern.
--
-- Every replace-set function verifies the request_type belongs to the calling
-- tenant before touching data. They do not bypass RLS (no security definer);
-- the API calls them via the service_role client which is already RLS-exempt.

-- ── 1. Active-row uniqueness on coverage rules ────────────────────────────
create unique index uniq_rt_coverage_active_tenant
  on public.request_type_coverage_rules (request_type_id)
  where active = true and scope_kind = 'tenant';

create unique index uniq_rt_coverage_active_space
  on public.request_type_coverage_rules (request_type_id, space_id)
  where active = true and scope_kind = 'space';

create unique index uniq_rt_coverage_active_group
  on public.request_type_coverage_rules (request_type_id, space_group_id)
  where active = true and scope_kind = 'space_group';

-- ── 2. Atomic replace-set functions ───────────────────────────────────────
-- Each function:
--   * asserts p_request_type_id belongs to p_tenant_id (raises 22023 otherwise),
--   * deletes the entire existing set for (tenant, request_type) for that satellite,
--   * inserts the new set from a JSONB array / UUID array,
--   * runs as one implicit plpgsql transaction so a failed insert rolls back the delete.

create or replace function public._assert_rt_in_tenant(p_request_type_id uuid, p_tenant_id uuid)
returns void language plpgsql as $$
begin
  if not exists (
    select 1 from public.request_types
    where id = p_request_type_id and tenant_id = p_tenant_id
  ) then
    raise exception using
      errcode = '22023',
      message = format('request_type_id %L not found in tenant %L', p_request_type_id, p_tenant_id);
  end if;
end;
$$;

create or replace function public.request_type_replace_categories(
  p_request_type_id uuid,
  p_tenant_id uuid,
  p_category_ids uuid[]
) returns void language plpgsql as $$
begin
  perform public._assert_rt_in_tenant(p_request_type_id, p_tenant_id);

  delete from public.request_type_categories
  where tenant_id = p_tenant_id and request_type_id = p_request_type_id;

  insert into public.request_type_categories (tenant_id, request_type_id, category_id)
  select p_tenant_id, p_request_type_id, cid
  from unnest(coalesce(p_category_ids, '{}'::uuid[])) cid;
end;
$$;

create or replace function public.request_type_replace_coverage(
  p_request_type_id uuid,
  p_tenant_id uuid,
  p_rules jsonb
) returns void language plpgsql as $$
begin
  perform public._assert_rt_in_tenant(p_request_type_id, p_tenant_id);

  delete from public.request_type_coverage_rules
  where tenant_id = p_tenant_id and request_type_id = p_request_type_id;

  insert into public.request_type_coverage_rules (
    tenant_id, request_type_id, scope_kind, space_id, space_group_id,
    inherit_to_descendants, starts_at, ends_at, active
  )
  select
    p_tenant_id,
    p_request_type_id,
    (r->>'scope_kind'),
    nullif(r->>'space_id', '')::uuid,
    nullif(r->>'space_group_id', '')::uuid,
    coalesce((r->>'inherit_to_descendants')::boolean, true),
    nullif(r->>'starts_at', '')::timestamptz,
    nullif(r->>'ends_at', '')::timestamptz,
    coalesce((r->>'active')::boolean, true)
  from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) r;
end;
$$;

create or replace function public.request_type_replace_audience(
  p_request_type_id uuid,
  p_tenant_id uuid,
  p_rules jsonb
) returns void language plpgsql as $$
begin
  perform public._assert_rt_in_tenant(p_request_type_id, p_tenant_id);

  delete from public.request_type_audience_rules
  where tenant_id = p_tenant_id and request_type_id = p_request_type_id;

  insert into public.request_type_audience_rules (
    tenant_id, request_type_id, criteria_set_id, mode,
    starts_at, ends_at, active
  )
  select
    p_tenant_id,
    p_request_type_id,
    (r->>'criteria_set_id')::uuid,
    (r->>'mode'),
    nullif(r->>'starts_at', '')::timestamptz,
    nullif(r->>'ends_at', '')::timestamptz,
    coalesce((r->>'active')::boolean, true)
  from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) r;
end;
$$;

create or replace function public.request_type_replace_form_variants(
  p_request_type_id uuid,
  p_tenant_id uuid,
  p_variants jsonb
) returns void language plpgsql as $$
begin
  perform public._assert_rt_in_tenant(p_request_type_id, p_tenant_id);

  delete from public.request_type_form_variants
  where tenant_id = p_tenant_id and request_type_id = p_request_type_id;

  insert into public.request_type_form_variants (
    tenant_id, request_type_id, criteria_set_id, form_schema_id,
    priority, starts_at, ends_at, active
  )
  select
    p_tenant_id,
    p_request_type_id,
    nullif(v->>'criteria_set_id', '')::uuid,
    (v->>'form_schema_id')::uuid,
    coalesce((v->>'priority')::int, 0),
    nullif(v->>'starts_at', '')::timestamptz,
    nullif(v->>'ends_at', '')::timestamptz,
    coalesce((v->>'active')::boolean, true)
  from jsonb_array_elements(coalesce(p_variants, '[]'::jsonb)) v;
end;
$$;

create or replace function public.request_type_replace_on_behalf_rules(
  p_request_type_id uuid,
  p_tenant_id uuid,
  p_rules jsonb
) returns void language plpgsql as $$
begin
  perform public._assert_rt_in_tenant(p_request_type_id, p_tenant_id);

  delete from public.request_type_on_behalf_rules
  where tenant_id = p_tenant_id and request_type_id = p_request_type_id;

  insert into public.request_type_on_behalf_rules (
    tenant_id, request_type_id, role, criteria_set_id
  )
  select
    p_tenant_id,
    p_request_type_id,
    (r->>'role'),
    (r->>'criteria_set_id')::uuid
  from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) r;
end;
$$;

create or replace function public.request_type_replace_scope_overrides(
  p_request_type_id uuid,
  p_tenant_id uuid,
  p_overrides jsonb
) returns void language plpgsql as $$
begin
  perform public._assert_rt_in_tenant(p_request_type_id, p_tenant_id);

  delete from public.request_type_scope_overrides
  where tenant_id = p_tenant_id and request_type_id = p_request_type_id;

  insert into public.request_type_scope_overrides (
    tenant_id, request_type_id, scope_kind, space_id, space_group_id,
    inherit_to_descendants, active, starts_at, ends_at,
    handler_kind, handler_team_id, handler_vendor_id,
    workflow_definition_id, case_sla_policy_id,
    case_owner_policy_entity_id, child_dispatch_policy_entity_id,
    executor_sla_policy_id
  )
  select
    p_tenant_id,
    p_request_type_id,
    (o->>'scope_kind'),
    nullif(o->>'space_id', '')::uuid,
    nullif(o->>'space_group_id', '')::uuid,
    coalesce((o->>'inherit_to_descendants')::boolean, true),
    coalesce((o->>'active')::boolean, true),
    nullif(o->>'starts_at', '')::timestamptz,
    nullif(o->>'ends_at', '')::timestamptz,
    nullif(o->>'handler_kind', ''),
    nullif(o->>'handler_team_id', '')::uuid,
    nullif(o->>'handler_vendor_id', '')::uuid,
    nullif(o->>'workflow_definition_id', '')::uuid,
    nullif(o->>'case_sla_policy_id', '')::uuid,
    nullif(o->>'case_owner_policy_entity_id', '')::uuid,
    nullif(o->>'child_dispatch_policy_entity_id', '')::uuid,
    nullif(o->>'executor_sla_policy_id', '')::uuid
  from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) o;
end;
$$;

notify pgrst, 'reload schema';
