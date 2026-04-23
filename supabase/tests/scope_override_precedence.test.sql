-- Precedence fixtures for public.request_type_effective_scope_override.
-- Runs against a local / dev Supabase instance. Safe to re-run — every test
-- tenant is namespaced under a fixed UUID and dropped at the end.
--
-- Usage:
--   PGPASSWORD=<pw> psql "postgresql://postgres@db.<host>:5432/postgres" \
--     -v ON_ERROR_STOP=1 \
--     -f supabase/tests/scope_override_precedence.test.sql
--
-- Or against local supabase:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 \
--     -f supabase/tests/scope_override_precedence.test.sql
--
-- Covers the four precedence tiers in live-doc §6.3:
--   exact_space → ancestor_space (inherit) → space_group → tenant.

begin;

-- ── Fixtures ──────────────────────────────────────────────────────────────
-- Tenant, spaces (site → building → floor → room), space group, request type.
-- Fixed UUIDs so the test can assert by id.

do $$
declare
  v_tenant uuid := 'fffffff0-0000-0000-0000-000000000001';
  v_rt uuid := 'fffffff0-0000-0000-0000-00000000aaaa';
  v_site uuid := 'fffffff0-0000-0000-0000-0000000000a1';
  v_bld uuid := 'fffffff0-0000-0000-0000-0000000000a2';
  v_flr uuid := 'fffffff0-0000-0000-0000-0000000000a3';
  v_room uuid := 'fffffff0-0000-0000-0000-0000000000a4';
  v_other uuid := 'fffffff0-0000-0000-0000-0000000000b1';
  v_group uuid := 'fffffff0-0000-0000-0000-0000000000c1';
  v_ov_tenant uuid := 'fffffff0-0000-0000-0000-0000000000d1';
  v_ov_anc uuid := 'fffffff0-0000-0000-0000-0000000000d2';
  v_ov_group uuid := 'fffffff0-0000-0000-0000-0000000000d3';
  v_ov_exact uuid := 'fffffff0-0000-0000-0000-0000000000d4';
  v_team uuid := 'fffffff0-0000-0000-0000-0000000000e1';
  v_result jsonb;
begin
  -- Clean slate. Order matters: mirror triggers on request_types INSERT
  -- spawn service_items + service_item_offerings / _form_variants in the
  -- test tenant; those must be cleared before we can drop spaces + teams +
  -- the tenant itself. Legacy service_item_* tables are dropped in Phase E;
  -- until then this test must tear them down explicitly.
  delete from public.request_type_scope_overrides where tenant_id = v_tenant;
  delete from public.request_type_coverage_rules where tenant_id = v_tenant;
  delete from public.request_type_form_variants where tenant_id = v_tenant;
  delete from public.request_type_audience_rules where tenant_id = v_tenant;
  delete from public.request_type_on_behalf_rules where tenant_id = v_tenant;
  delete from public.service_item_offerings where tenant_id = v_tenant;
  delete from public.service_item_form_variants where tenant_id = v_tenant;
  delete from public.service_item_criteria where tenant_id = v_tenant;
  delete from public.service_item_on_behalf_rules where tenant_id = v_tenant;
  delete from public.service_item_categories where tenant_id = v_tenant;
  delete from public.request_type_service_item_bridge where tenant_id = v_tenant;
  delete from public.service_items where tenant_id = v_tenant;
  delete from public.space_group_members where tenant_id = v_tenant;
  delete from public.space_groups where tenant_id = v_tenant;
  delete from public.request_types where tenant_id = v_tenant;
  delete from public.spaces where tenant_id = v_tenant;
  delete from public.teams where tenant_id = v_tenant;
  delete from public.tenants where id = v_tenant;

  insert into public.tenants (id, name, slug) values (v_tenant, 'test-scope-override', 'test-scope-override');
  insert into public.teams (id, tenant_id, name) values (v_team, v_tenant, 'Test Team');
  insert into public.spaces (id, tenant_id, parent_id, type, name, active)
    values (v_site, v_tenant, null, 'site', 'Site A', true);
  insert into public.spaces (id, tenant_id, parent_id, type, name, active)
    values (v_bld, v_tenant, v_site, 'building', 'Building A1', true);
  insert into public.spaces (id, tenant_id, parent_id, type, name, active)
    values (v_flr, v_tenant, v_bld, 'floor', 'Floor 3', true);
  insert into public.spaces (id, tenant_id, parent_id, type, name, active)
    values (v_room, v_tenant, v_flr, 'room', 'Room 301', true);
  insert into public.spaces (id, tenant_id, parent_id, type, name, active)
    values (v_other, v_tenant, null, 'site', 'Site B', true);

  insert into public.space_groups (id, tenant_id, name) values (v_group, v_tenant, 'Group A');
  insert into public.space_group_members (tenant_id, space_group_id, space_id)
    values (v_tenant, v_group, v_room);

  insert into public.request_types (id, tenant_id, name, active, fulfillment_strategy)
    values (v_rt, v_tenant, 'Test RT', true, 'fixed');

  -- ── Test 1: only tenant override → precedence='tenant' ──
  insert into public.request_type_scope_overrides
    (id, tenant_id, request_type_id, scope_kind, active, handler_kind, handler_team_id)
    values (v_ov_tenant, v_tenant, v_rt, 'tenant', true, 'team', v_team);

  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if coalesce(v_result->>'precedence', '') <> 'tenant' then
    raise exception 'T1 expected precedence=tenant got %', v_result->>'precedence';
  end if;
  if coalesce(v_result->>'id', '') <> v_ov_tenant::text then
    raise exception 'T1 expected id=% got %', v_ov_tenant, v_result->>'id';
  end if;

  -- ── Test 2: add space_group override → wins over tenant ──
  insert into public.request_type_scope_overrides
    (id, tenant_id, request_type_id, scope_kind, space_group_id, active, handler_kind, handler_team_id)
    values (v_ov_group, v_tenant, v_rt, 'space_group', v_group, true, 'team', v_team);

  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if coalesce(v_result->>'precedence', '') <> 'space_group' then
    raise exception 'T2 expected precedence=space_group got %', v_result->>'precedence';
  end if;

  -- ── Test 3: add ancestor_space override (on building with inherit=true) → wins over space_group ──
  insert into public.request_type_scope_overrides
    (id, tenant_id, request_type_id, scope_kind, space_id, inherit_to_descendants, active, handler_kind, handler_team_id)
    values (v_ov_anc, v_tenant, v_rt, 'space', v_bld, true, true, 'team', v_team);

  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if coalesce(v_result->>'precedence', '') <> 'ancestor_space' then
    raise exception 'T3 expected precedence=ancestor_space got %', v_result->>'precedence';
  end if;

  -- ── Test 4: add exact space override on the selected room → wins over ancestor ──
  insert into public.request_type_scope_overrides
    (id, tenant_id, request_type_id, scope_kind, space_id, inherit_to_descendants, active, handler_kind, handler_team_id)
    values (v_ov_exact, v_tenant, v_rt, 'space', v_room, false, true, 'team', v_team);

  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if coalesce(v_result->>'precedence', '') <> 'exact_space' then
    raise exception 'T4 expected precedence=exact_space got %', v_result->>'precedence';
  end if;
  if coalesce(v_result->>'id', '') <> v_ov_exact::text then
    raise exception 'T4 expected id=% got %', v_ov_exact, v_result->>'id';
  end if;

  -- ── Test 5: null selected space → only tenant override matches ──
  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, null);
  if coalesce(v_result->>'precedence', '') <> 'tenant' then
    raise exception 'T5 expected precedence=tenant (null space) got %', v_result->>'precedence';
  end if;

  -- ── Test 6: selected space in a different tree → tenant (no ancestor/group hit) ──
  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_other);
  if coalesce(v_result->>'precedence', '') <> 'tenant' then
    raise exception 'T6 expected precedence=tenant (disjoint space) got %', v_result->>'precedence';
  end if;

  -- ── Test 7: ancestor without inherit_to_descendants → skipped ──
  update public.request_type_scope_overrides
    set inherit_to_descendants = false
    where id = v_ov_anc;
  -- Remove the exact match so the ancestor would be the next candidate if inherit were true.
  delete from public.request_type_scope_overrides where id = v_ov_exact;

  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if coalesce(v_result->>'precedence', '') <> 'space_group' then
    raise exception 'T7 expected precedence=space_group (inherit=false ancestor skipped) got %', v_result->>'precedence';
  end if;

  -- ── Test 8: inactive rows are ignored ──
  update public.request_type_scope_overrides set active = false where tenant_id = v_tenant;
  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if v_result is not null then
    raise exception 'T8 expected NULL (all overrides inactive) got %', v_result;
  end if;

  raise notice 'scope_override_precedence: 8/8 passed';

  -- Cleanup. See same ordering note as above.
  delete from public.request_type_scope_overrides where tenant_id = v_tenant;
  delete from public.request_type_coverage_rules where tenant_id = v_tenant;
  delete from public.request_type_form_variants where tenant_id = v_tenant;
  delete from public.request_type_audience_rules where tenant_id = v_tenant;
  delete from public.request_type_on_behalf_rules where tenant_id = v_tenant;
  delete from public.service_item_offerings where tenant_id = v_tenant;
  delete from public.service_item_form_variants where tenant_id = v_tenant;
  delete from public.service_item_criteria where tenant_id = v_tenant;
  delete from public.service_item_on_behalf_rules where tenant_id = v_tenant;
  delete from public.service_item_categories where tenant_id = v_tenant;
  delete from public.request_type_service_item_bridge where tenant_id = v_tenant;
  delete from public.service_items where tenant_id = v_tenant;
  delete from public.space_group_members where tenant_id = v_tenant;
  delete from public.space_groups where tenant_id = v_tenant;
  delete from public.request_types where tenant_id = v_tenant;
  delete from public.spaces where tenant_id = v_tenant;
  delete from public.teams where tenant_id = v_tenant;
  delete from public.tenants where id = v_tenant;
end $$;

commit;
