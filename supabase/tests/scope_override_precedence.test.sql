-- Precedence fixtures for public.request_type_effective_scope_override.
-- Runs against a local / dev Supabase instance. Safe to re-run — every test
-- tenant is namespaced under a fixed UUID and dropped at the end.
--
-- Usage:
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 \
--     -f supabase/tests/scope_override_precedence.test.sql
--
-- Remote (prefer local):
--   PGPASSWORD=<pw> psql "postgresql://postgres@db.<host>:5432/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/scope_override_precedence.test.sql
--
-- Covers:
--   - Live-doc §6.3 precedence tiers (exact → ancestor-inherit → group → tenant)
--   - Null-space / disjoint-space edge cases
--   - inherit_to_descendants=false skips ancestor
--   - active=false rows are invisible
--   - starts_at / ends_at effective-dating boundaries
--   - Same-tier id tie-breaks via multi-group membership (earliest id wins)

begin;

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
  v_group2 uuid := 'fffffff0-0000-0000-0000-0000000000c2';
  -- Lower/higher UUIDs for deterministic id-based tie-break.
  v_ov_tenant uuid := 'fffffff0-0000-0000-0000-0000000000d1';
  v_ov_anc uuid := 'fffffff0-0000-0000-0000-0000000000d2';
  v_ov_group uuid := 'fffffff0-0000-0000-0000-0000000000d3';
  v_ov_exact uuid := 'fffffff0-0000-0000-0000-0000000000d4';
  v_ov_group2 uuid := 'fffffff0-0000-0000-0000-0000000000d5';
  v_ov_scheduled_past uuid := 'fffffff0-0000-0000-0000-0000000000d6';
  v_ov_scheduled_future uuid := 'fffffff0-0000-0000-0000-0000000000d7';
  v_team uuid := 'fffffff0-0000-0000-0000-0000000000e1';
  v_result jsonb;
begin
  -- Clean slate. After Phase E (migration 00097) the legacy service_item_*
  -- tables no longer exist; only request-type-native rows need clearing.
  delete from public.request_type_scope_overrides where tenant_id = v_tenant;
  delete from public.request_type_coverage_rules where tenant_id = v_tenant;
  delete from public.request_type_form_variants where tenant_id = v_tenant;
  delete from public.request_type_audience_rules where tenant_id = v_tenant;
  delete from public.request_type_on_behalf_rules where tenant_id = v_tenant;
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
  insert into public.space_groups (id, tenant_id, name) values (v_group2, v_tenant, 'Group B');
  insert into public.space_group_members (tenant_id, space_group_id, space_id)
    values (v_tenant, v_group, v_room);
  -- Same room is also a member of a second group → both apply at space_group tier.
  insert into public.space_group_members (tenant_id, space_group_id, space_id)
    values (v_tenant, v_group2, v_room);

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

  -- ── Test 3: ancestor_space with inherit=true → wins over space_group ──
  insert into public.request_type_scope_overrides
    (id, tenant_id, request_type_id, scope_kind, space_id, inherit_to_descendants, active, handler_kind, handler_team_id)
    values (v_ov_anc, v_tenant, v_rt, 'space', v_bld, true, true, 'team', v_team);

  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if coalesce(v_result->>'precedence', '') <> 'ancestor_space' then
    raise exception 'T3 expected precedence=ancestor_space got %', v_result->>'precedence';
  end if;

  -- ── Test 4: exact_space on the selected room → wins over ancestor ──
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

  -- ── Test 6: selected space in disjoint tree → tenant (no ancestor/group hit) ──
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

  -- ── Test 8: inactive rows are invisible ──
  update public.request_type_scope_overrides set active = false where tenant_id = v_tenant;
  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if v_result is not null then
    raise exception 'T8 expected NULL (all overrides inactive) got %', v_result;
  end if;
  -- Reactivate for subsequent tests.
  update public.request_type_scope_overrides set active = true where tenant_id = v_tenant;
  -- The inherit=false change persists from T7; put the ancestor back to inherit=true.
  update public.request_type_scope_overrides set inherit_to_descendants = true where id = v_ov_anc;

  -- ── Test 9: starts_at in the future → row invisible, falls through ──
  -- Ensure only the space-group override is active to start with.
  update public.request_type_scope_overrides set active = false where id in (v_ov_anc, v_ov_tenant);
  insert into public.request_type_scope_overrides
    (id, tenant_id, request_type_id, scope_kind, space_id, inherit_to_descendants, active,
     starts_at, handler_kind, handler_team_id)
    values (v_ov_scheduled_future, v_tenant, v_rt, 'space', v_room, false, true,
            now() + interval '1 day', 'team', v_team);
  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  -- Scheduled-future exact_space should be hidden → space_group wins.
  if coalesce(v_result->>'precedence', '') <> 'space_group' then
    raise exception 'T9 expected precedence=space_group (future exact hidden) got %', v_result->>'precedence';
  end if;

  -- ── Test 10: ends_at in the past → row invisible ──
  delete from public.request_type_scope_overrides where id = v_ov_scheduled_future;
  insert into public.request_type_scope_overrides
    (id, tenant_id, request_type_id, scope_kind, space_id, inherit_to_descendants, active,
     starts_at, ends_at, handler_kind, handler_team_id)
    values (v_ov_scheduled_past, v_tenant, v_rt, 'space', v_room, false, true,
            now() - interval '2 day', now() - interval '1 day', 'team', v_team);
  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if coalesce(v_result->>'precedence', '') <> 'space_group' then
    raise exception 'T10 expected precedence=space_group (past-ended exact hidden) got %', v_result->>'precedence';
  end if;
  delete from public.request_type_scope_overrides where id = v_ov_scheduled_past;

  -- ── Test 11: same-tier id tie-break via two space_group overrides.
  -- The selected room belongs to both v_group and v_group2. Both overrides
  -- match at the space_group tier; the precedence function's stable
  -- ORDER BY id ASC picks the earliest id. (This is the only real same-tier
  -- collision expressible in this tree: exact_space has one possible match
  -- per selected space; ancestors are naturally ordered by depth; tenant is
  -- uniquely scoped. Multi-group membership is where real ties happen.)
  insert into public.request_type_scope_overrides
    (id, tenant_id, request_type_id, scope_kind, space_group_id, active, handler_kind, handler_team_id)
    values (v_ov_group2, v_tenant, v_rt, 'space_group', v_group2, true, 'team', v_team);
  -- Remove the ancestor to isolate the tier.
  update public.request_type_scope_overrides set active = false where id = v_ov_anc;
  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if coalesce(v_result->>'precedence', '') <> 'space_group' then
    raise exception 'T11 expected precedence=space_group got %', v_result->>'precedence';
  end if;
  if coalesce(v_result->>'id', '') <> v_ov_group::text then
    raise exception 'T11 expected id=% (earlier) got %', v_ov_group, v_result->>'id';
  end if;

  -- ── Test 12: multi-space-group membership works regardless of which group's
  -- override is active. Deactivate v_ov_group → v_ov_group2 becomes the hit.
  update public.request_type_scope_overrides set active = false where id = v_ov_group;
  v_result := public.request_type_effective_scope_override(v_tenant, v_rt, v_room);
  if coalesce(v_result->>'precedence', '') <> 'space_group' then
    raise exception 'T12 expected precedence=space_group (second group) got %', v_result->>'precedence';
  end if;
  if coalesce(v_result->>'id', '') <> v_ov_group2::text then
    raise exception 'T12 expected id=% (only remaining group) got %', v_ov_group2, v_result->>'id';
  end if;

  raise notice 'scope_override_precedence: 12/12 passed';

  -- Cleanup. Same post-Phase-E order as above.
  delete from public.request_type_scope_overrides where tenant_id = v_tenant;
  delete from public.request_type_coverage_rules where tenant_id = v_tenant;
  delete from public.request_type_form_variants where tenant_id = v_tenant;
  delete from public.request_type_audience_rules where tenant_id = v_tenant;
  delete from public.request_type_on_behalf_rules where tenant_id = v_tenant;
  delete from public.space_group_members where tenant_id = v_tenant;
  delete from public.space_groups where tenant_id = v_tenant;
  delete from public.request_types where tenant_id = v_tenant;
  delete from public.spaces where tenant_id = v_tenant;
  delete from public.teams where tenant_id = v_tenant;
  delete from public.tenants where id = v_tenant;
end $$;

commit;
