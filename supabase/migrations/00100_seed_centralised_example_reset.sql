-- 00100_seed_centralised_example_reset.sql
-- Replace the old default-tenant demo dataset with the centralised TSS example
-- dataset. Preserve Thomas Anderson (dev@prequest.nl) if he already exists;
-- everything else under the default tenant is reset.

do $$
declare
  t uuid := '00000000-0000-0000-0000-000000000001';
  v_thomas_person uuid;
  v_thomas_user uuid;
begin
  select id into v_thomas_person
  from public.persons
  where tenant_id = t
    and lower(coalesce(email, '')) = 'dev@prequest.nl'
  limit 1;

  if v_thomas_person is null then
    select id into v_thomas_person
    from public.persons
    where tenant_id = t
      and lower(first_name) = 'thomas'
      and lower(last_name) = 'anderson'
    limit 1;
  end if;

  select id into v_thomas_user
  from public.users
  where tenant_id = t
    and lower(email) = 'dev@prequest.nl'
  limit 1;

  -- Break FK links from the preserved Thomas rows before clearing spaces/people.
  if v_thomas_user is not null then
    update public.users
    set portal_current_location_id = null,
        username = 'thomas.anderson',
        status = 'active'
    where id = v_thomas_user;
  end if;

  if v_thomas_person is not null then
    update public.persons
    set manager_person_id = null,
        default_location_id = null,
        cost_center = null,
        active = true,
        type = 'employee'
    where id = v_thomas_person;
  end if;

  delete from public.notifications where tenant_id = t;
  delete from public.notification_preferences where tenant_id = t;
  delete from public.delegations where tenant_id = t;
  delete from public.audit_events where tenant_id = t;
  delete from public.domain_events where tenant_id = t;
  delete from public.routing_dualrun_logs where tenant_id = t;
  delete from public.routing_decisions where tenant_id = t;
  delete from public.workflow_instance_events where tenant_id = t;
  delete from public.workflow_instances where tenant_id = t;
  delete from public.workflow_webhooks where tenant_id = t;
  delete from public.webhook_events where tenant_id = t;
  delete from public.approvals where tenant_id = t;
  delete from public.sla_threshold_crossings where tenant_id = t;
  delete from public.sla_timers where tenant_id = t;
  delete from public.ticket_activities where tenant_id = t;
  delete from public.reservations where tenant_id = t;
  delete from public.visitors where tenant_id = t;
  delete from public.maintenance_schedules where tenant_id = t;
  delete from public.tickets where tenant_id = t;
  delete from public.asset_assignment_history where tenant_id = t;
  delete from public.order_line_items where tenant_id = t;
  delete from public.orders where tenant_id = t;
  delete from public.menu_items where tenant_id = t;
  delete from public.catalog_menus where tenant_id = t;
  delete from public.vendor_service_areas where tenant_id = t;
  delete from public.location_teams where tenant_id = t;
  delete from public.routing_rules where tenant_id = t;
  delete from public.request_type_scope_overrides where tenant_id = t;
  delete from public.request_type_on_behalf_rules where tenant_id = t;
  delete from public.request_type_form_variants where tenant_id = t;
  delete from public.request_type_audience_rules where tenant_id = t;
  delete from public.request_type_coverage_rules where tenant_id = t;
  delete from public.request_type_categories where tenant_id = t;
  delete from public.request_types where tenant_id = t;
  delete from public.criteria_sets where tenant_id = t;
  delete from public.domain_parents where tenant_id = t;
  delete from public.domains where tenant_id = t;
  delete from public.service_catalog_categories where tenant_id = t;
  delete from public.space_group_members where tenant_id = t;
  delete from public.space_groups where tenant_id = t;
  delete from public.catalog_items where tenant_id = t;
  delete from public.assets where tenant_id = t;
  delete from public.asset_types where tenant_id = t;
  delete from public.team_members where tenant_id = t;
  delete from public.user_role_assignments where tenant_id = t;
  delete from public.org_node_location_grants where tenant_id = t;
  delete from public.person_location_grants where tenant_id = t;
  delete from public.person_org_memberships where tenant_id = t;
  delete from public.org_nodes where tenant_id = t;
  update public.config_entities
  set current_published_version_id = null
  where tenant_id = t;
  delete from public.config_versions where tenant_id = t;
  delete from public.vendors where tenant_id = t;
  delete from public.teams where tenant_id = t;
  delete from public.roles where tenant_id = t;

  delete from public.users
  where tenant_id = t
    and (v_thomas_user is null or id <> v_thomas_user);

  delete from public.persons
  where tenant_id = t
    and (v_thomas_person is null or id <> v_thomas_person);

  delete from public.workflow_definitions where tenant_id = t;
  delete from public.sla_policies where tenant_id = t;
  delete from public.business_hours_calendars where tenant_id = t;
  delete from public.config_entities where tenant_id = t;
  delete from public.spaces where tenant_id = t;

  if v_thomas_person is not null then
    update public.persons
    set first_name = 'Thomas',
        last_name = 'Anderson',
        email = 'dev@prequest.nl',
        phone = null,
        external_source = null,
        updated_at = now()
    where id = v_thomas_person;
  end if;

  if v_thomas_user is not null then
    update public.users
    set person_id = v_thomas_person,
        email = 'dev@prequest.nl',
        updated_at = now()
    where id = v_thomas_user;
  end if;

  update public.tenants
  set name = 'Total Specific Services (TSS)',
      slug = 'tss',
      status = 'active',
      tier = 'standard'
  where id = t;
end
$$;

notify pgrst, 'reload schema';
