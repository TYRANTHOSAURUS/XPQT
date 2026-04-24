-- 00104_seed_centralised_example_catalog.sql
-- Canonical local TSS demo catalog/runtime layer: domains, categories, forms,
-- SLAs, workflows, routing, request types, coverage, audience, and overrides.

-- ---------------------------------------------------------------------------
-- 1. Space groups
-- ---------------------------------------------------------------------------

insert into public.space_groups (id, tenant_id, name, description)
values
  ('a7000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Amsterdam Campus Buildings', 'Amsterdam campus buildings with shared services.'),
  ('a7000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Amsterdam All Buildings', 'All Amsterdam buildings including the Singel office.')
on conflict (id) do update
set name = excluded.name,
    description = excluded.description,
    updated_at = now();

insert into public.space_group_members (tenant_id, space_group_id, space_id)
values
  ('00000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000011'),
  ('00000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000012'),
  ('00000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000011'),
  ('00000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000012'),
  ('00000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000013')
on conflict (space_group_id, space_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Domains and parent chain
-- ---------------------------------------------------------------------------

insert into public.domains (id, tenant_id, key, display_name, parent_domain_id, active)
values
  ('c1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'fm', 'Facilities', null, true),
  ('c1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'it', 'IT', null, true),
  ('c1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'hr', 'HR', null, true),
  ('c1000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'admin', 'Admin', 'c1000000-0000-0000-0000-000000000001', true),
  ('c1000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'hardware', 'Hardware', 'c1000000-0000-0000-0000-000000000002', true),
  ('c1000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'software', 'Software', 'c1000000-0000-0000-0000-000000000002', true),
  ('c1000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'network', 'Network', 'c1000000-0000-0000-0000-000000000002', true),
  ('c1000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'printing', 'Printing', 'c1000000-0000-0000-0000-000000000002', true),
  ('c1000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'identity', 'Identity', 'c1000000-0000-0000-0000-000000000002', true),
  ('c1000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'av', 'AV', 'c1000000-0000-0000-0000-000000000002', true),
  ('c1000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'workplace', 'Workplace', 'c1000000-0000-0000-0000-000000000001', true),
  ('c1000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 'cleaning', 'Cleaning', 'c1000000-0000-0000-0000-000000000001', true),
  ('c1000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000001', 'maintenance', 'Maintenance', 'c1000000-0000-0000-0000-000000000001', true),
  ('c1000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000001', 'plumbing', 'Plumbing', 'c1000000-0000-0000-0000-00000000000d', true),
  ('c1000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000001', 'hvac', 'HVAC', 'c1000000-0000-0000-0000-00000000000d', true),
  ('c1000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'electrical', 'Electrical', 'c1000000-0000-0000-0000-00000000000d', true),
  ('c1000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'elevators', 'Elevators', 'c1000000-0000-0000-0000-00000000000d', true),
  ('c1000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'access_control', 'Access Control', 'c1000000-0000-0000-0000-00000000000d', true),
  ('c1000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'catering', 'Catering', 'c1000000-0000-0000-0000-000000000001', true),
  ('c1000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 'events', 'Events', 'c1000000-0000-0000-0000-000000000001', true);

insert into public.domain_parents (tenant_id, domain, parent_domain, domain_id, parent_domain_id)
values
  ('00000000-0000-0000-0000-000000000001', 'admin', 'fm', 'c1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'hardware', 'it', 'c1000000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'software', 'it', 'c1000000-0000-0000-0000-000000000006', 'c1000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'network', 'it', 'c1000000-0000-0000-0000-000000000007', 'c1000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'printing', 'it', 'c1000000-0000-0000-0000-000000000008', 'c1000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'identity', 'it', 'c1000000-0000-0000-0000-000000000009', 'c1000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'av', 'it', 'c1000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'workplace', 'fm', 'c1000000-0000-0000-0000-00000000000b', 'c1000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'cleaning', 'fm', 'c1000000-0000-0000-0000-00000000000c', 'c1000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'maintenance', 'fm', 'c1000000-0000-0000-0000-00000000000d', 'c1000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'plumbing', 'maintenance', 'c1000000-0000-0000-0000-00000000000e', 'c1000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-000000000001', 'hvac', 'maintenance', 'c1000000-0000-0000-0000-00000000000f', 'c1000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-000000000001', 'electrical', 'maintenance', 'c1000000-0000-0000-0000-000000000010', 'c1000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-000000000001', 'elevators', 'maintenance', 'c1000000-0000-0000-0000-000000000011', 'c1000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-000000000001', 'access_control', 'maintenance', 'c1000000-0000-0000-0000-000000000012', 'c1000000-0000-0000-0000-00000000000d'),
  ('00000000-0000-0000-0000-000000000001', 'catering', 'fm', 'c1000000-0000-0000-0000-000000000013', 'c1000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'events', 'fm', 'c1000000-0000-0000-0000-000000000014', 'c1000000-0000-0000-0000-000000000001');

-- ---------------------------------------------------------------------------
-- 3. Category tree
-- ---------------------------------------------------------------------------

insert into public.service_catalog_categories (id, tenant_id, name, description, icon, display_order, parent_category_id, active)
values
  ('a1100000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'IT & Digital', 'Digital workplace support and system access.', 'laptop', 10, null, true),
  ('a1100000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Workplace Operations', 'Facilities, moves, cleaning, maintenance, and events.', 'building', 20, null, true),
  ('a1100000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'People & Admin', 'HR and internal administrative support.', 'users', 30, null, true),
  ('a1110000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'IT Support', 'Device, software, and connectivity issues.', 'monitor', 11, 'a1100000-0000-0000-0000-000000000001', true),
  ('a1110000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Access & Identity', 'Permissions, badges, and account access.', 'shield', 12, 'a1100000-0000-0000-0000-000000000001', true),
  ('a1110000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Workplace Services', 'Moves, workstation changes, and workplace requests.', 'briefcase', 21, 'a1100000-0000-0000-0000-000000000002', true),
  ('a1110000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Cleaning', 'Routine and urgent cleaning services.', 'sparkles', 22, 'a1100000-0000-0000-0000-000000000002', true),
  ('a1110000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'Building Maintenance', 'Reactive maintenance and building faults.', 'wrench', 23, 'a1100000-0000-0000-0000-000000000002', true),
  ('a1110000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'Catering & Events', 'Meeting catering and event support.', 'coffee', 24, 'a1100000-0000-0000-0000-000000000002', true),
  ('a1110000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'HR Services', 'People operations and employee support.', 'user-round', 31, 'a1100000-0000-0000-0000-000000000003', true),
  ('a1110000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'Finance & Admin', 'Internal administrative and card support.', 'credit-card', 32, 'a1100000-0000-0000-0000-000000000003', true);

-- ---------------------------------------------------------------------------
-- 4. Form schemas
-- ---------------------------------------------------------------------------

insert into public.config_entities (id, tenant_id, config_type, slug, display_name, status)
values
  ('a2000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'form_schema', 'tss_it_issue', 'TSS IT Issue', 'active'),
  ('a2000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'form_schema', 'tss_access_request', 'TSS Access Request', 'active'),
  ('a2000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'form_schema', 'tss_facilities_issue', 'TSS Facilities Issue', 'active'),
  ('a2000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'form_schema', 'tss_workplace_change', 'TSS Workplace Change', 'active'),
  ('a2000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'form_schema', 'tss_hr_request', 'TSS HR Request', 'active'),
  ('a2000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'form_schema', 'tss_event_support', 'TSS Event Support', 'active'),
  ('a2000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'form_schema', 'tss_admin_request', 'TSS Admin Request', 'active');

insert into public.config_versions (id, config_entity_id, tenant_id, version_number, status, definition, published_at)
values
  (
    'a2100000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    1,
    'published',
    jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('id', 'summary', 'label', 'What is affected?', 'type', 'text', 'required', true),
      jsonb_build_object('id', 'impact', 'label', 'Impact', 'type', 'dropdown', 'required', true, 'options', jsonb_build_array('Low', 'Medium', 'High'), 'bound_to', 'impact'),
      jsonb_build_object('id', 'urgency', 'label', 'Urgency', 'type', 'dropdown', 'required', true, 'options', jsonb_build_array('Low', 'Medium', 'High'), 'bound_to', 'urgency'),
      jsonb_build_object('id', 'work_stopped', 'label', 'Work stopped', 'type', 'checkbox', 'required', false),
      jsonb_build_object('id', 'notes', 'label', 'Notes', 'type', 'textarea', 'required', false)
    )),
    now()
  ),
  (
    'a2100000-0000-0000-0000-000000000002',
    'a2000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    1,
    'published',
    jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('id', 'system_name', 'label', 'System or application', 'type', 'text', 'required', true),
      jsonb_build_object('id', 'requested_access', 'label', 'Requested access', 'type', 'textarea', 'required', true),
      jsonb_build_object('id', 'effective_date', 'label', 'Effective date', 'type', 'datetime', 'required', false),
      jsonb_build_object('id', 'justification', 'label', 'Justification', 'type', 'textarea', 'required', true)
    )),
    now()
  ),
  (
    'a2100000-0000-0000-0000-000000000003',
    'a2000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    1,
    'published',
    jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('id', 'problem_summary', 'label', 'Problem summary', 'type', 'text', 'required', true),
      jsonb_build_object('id', 'affected_people', 'label', 'People affected', 'type', 'number', 'required', false),
      jsonb_build_object('id', 'safe_to_work', 'label', 'Safe to keep using the area', 'type', 'checkbox', 'required', false),
      jsonb_build_object('id', 'preferred_date', 'label', 'Preferred date / time', 'type', 'datetime', 'required', false),
      jsonb_build_object('id', 'notes', 'label', 'Notes', 'type', 'textarea', 'required', false)
    )),
    now()
  ),
  (
    'a2100000-0000-0000-0000-000000000004',
    'a2000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001',
    1,
    'published',
    jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('id', 'requested_for', 'label', 'Requested for', 'type', 'person_picker', 'required', false),
      jsonb_build_object('id', 'move_date', 'label', 'Preferred move date', 'type', 'datetime', 'required', true),
      jsonb_build_object('id', 'headcount', 'label', 'Headcount', 'type', 'number', 'required', false),
      jsonb_build_object('id', 'special_needs', 'label', 'Special needs', 'type', 'textarea', 'required', false)
    )),
    now()
  ),
  (
    'a2100000-0000-0000-0000-000000000005',
    'a2000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000001',
    1,
    'published',
    jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('id', 'effective_date', 'label', 'Effective date', 'type', 'datetime', 'required', true),
      jsonb_build_object('id', 'employee_notes', 'label', 'Notes', 'type', 'textarea', 'required', false),
      jsonb_build_object('id', 'manager_confirmed', 'label', 'Manager already informed', 'type', 'checkbox', 'required', false)
    )),
    now()
  ),
  (
    'a2100000-0000-0000-0000-000000000006',
    'a2000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-000000000001',
    1,
    'published',
    jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('id', 'event_date', 'label', 'Event date / time', 'type', 'datetime', 'required', true),
      jsonb_build_object('id', 'attendees', 'label', 'Attendees', 'type', 'number', 'required', true),
      jsonb_build_object('id', 'room_setup', 'label', 'Room setup', 'type', 'textarea', 'required', false),
      jsonb_build_object('id', 'dietary_notes', 'label', 'Dietary notes', 'type', 'textarea', 'required', false)
    )),
    now()
  ),
  (
    'a2100000-0000-0000-0000-000000000007',
    'a2000000-0000-0000-0000-000000000007',
    '00000000-0000-0000-0000-000000000001',
    1,
    'published',
    jsonb_build_object('fields', jsonb_build_array(
      jsonb_build_object('id', 'reference_number', 'label', 'Reference number', 'type', 'text', 'required', false),
      jsonb_build_object('id', 'question', 'label', 'Question or issue', 'type', 'textarea', 'required', true),
      jsonb_build_object('id', 'deadline', 'label', 'Deadline', 'type', 'datetime', 'required', false)
    )),
    now()
  );

update public.config_entities set current_published_version_id = 'a2100000-0000-0000-0000-000000000001' where id = 'a2000000-0000-0000-0000-000000000001';
update public.config_entities set current_published_version_id = 'a2100000-0000-0000-0000-000000000002' where id = 'a2000000-0000-0000-0000-000000000002';
update public.config_entities set current_published_version_id = 'a2100000-0000-0000-0000-000000000003' where id = 'a2000000-0000-0000-0000-000000000003';
update public.config_entities set current_published_version_id = 'a2100000-0000-0000-0000-000000000004' where id = 'a2000000-0000-0000-0000-000000000004';
update public.config_entities set current_published_version_id = 'a2100000-0000-0000-0000-000000000005' where id = 'a2000000-0000-0000-0000-000000000005';
update public.config_entities set current_published_version_id = 'a2100000-0000-0000-0000-000000000006' where id = 'a2000000-0000-0000-0000-000000000006';
update public.config_entities set current_published_version_id = 'a2100000-0000-0000-0000-000000000007' where id = 'a2000000-0000-0000-0000-000000000007';

-- ---------------------------------------------------------------------------
-- 5. SLAs and defaults
-- ---------------------------------------------------------------------------

insert into public.sla_policies (
  id, tenant_id, name, response_time_minutes, resolution_time_minutes,
  business_hours_calendar_id, pause_on_waiting_reasons, escalation_thresholds, active
)
values
  ('a3000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'TSS Case Standard', 60, 480, '91100000-0000-0000-0000-000000000001', '{"requester","vendor","scheduled_work"}', '[]'::jsonb, true),
  ('a3000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'TSS Case Urgent', 15, 240, '91100000-0000-0000-0000-000000000002', '{"requester","vendor","scheduled_work"}', '[]'::jsonb, true),
  ('a3000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'TSS Case Critical', 5, 60, '91100000-0000-0000-0000-000000000003', '{"requester","vendor"}', '[]'::jsonb, true),
  ('a3000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'TSS HR Standard', 240, 2400, '91100000-0000-0000-0000-000000000001', '{"requester"}', '[]'::jsonb, true),
  ('a3000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'TSS Move Coordination', 120, 2880, '91100000-0000-0000-0000-000000000001', '{"requester","vendor","scheduled_work"}', '[]'::jsonb, true),
  ('a3000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'TSS Event Coordination', 30, 720, '91100000-0000-0000-0000-000000000002', '{"requester","vendor","scheduled_work"}', '[]'::jsonb, true),
  ('a3000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'TSS Executor Standard', 60, 480, '91100000-0000-0000-0000-000000000001', '{"requester","vendor","scheduled_work"}', '[]'::jsonb, true),
  ('a3000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'TSS Executor Critical', 15, 120, '91100000-0000-0000-0000-000000000003', '{"requester","vendor"}', '[]'::jsonb, true),
  ('a3000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'TSS Executor Scheduled', 240, 2880, '91100000-0000-0000-0000-000000000001', '{"requester","vendor","scheduled_work"}', '[]'::jsonb, true);

update public.teams
set default_sla_policy_id = case id
  when '94000000-0000-0000-0000-000000000001' then 'a3000000-0000-0000-0000-000000000007'
  when '94000000-0000-0000-0000-000000000002' then 'a3000000-0000-0000-0000-000000000007'
  when '94000000-0000-0000-0000-000000000003' then 'a3000000-0000-0000-0000-000000000004'
  when '94000000-0000-0000-0000-000000000004' then 'a3000000-0000-0000-0000-000000000007'
  when '94000000-0000-0000-0000-000000000005' then 'a3000000-0000-0000-0000-000000000007'
  when '94000000-0000-0000-0000-000000000006' then 'a3000000-0000-0000-0000-000000000007'
  else default_sla_policy_id
end
where tenant_id = '00000000-0000-0000-0000-000000000001';

update public.vendors
set default_sla_policy_id = case id
  when '97000000-0000-0000-0000-000000000001' then 'a3000000-0000-0000-0000-000000000007'
  when '97000000-0000-0000-0000-000000000002' then 'a3000000-0000-0000-0000-000000000008'
  when '97000000-0000-0000-0000-000000000003' then 'a3000000-0000-0000-0000-000000000007'
  when '97000000-0000-0000-0000-000000000004' then 'a3000000-0000-0000-0000-000000000007'
  when '97000000-0000-0000-0000-000000000005' then 'a3000000-0000-0000-0000-000000000007'
  when '97000000-0000-0000-0000-000000000006' then 'a3000000-0000-0000-0000-000000000007'
  when '97000000-0000-0000-0000-000000000008' then 'a3000000-0000-0000-0000-000000000007'
  when '97000000-0000-0000-0000-000000000009' then 'a3000000-0000-0000-0000-000000000007'
  when '97000000-0000-0000-0000-00000000000b' then 'a3000000-0000-0000-0000-000000000009'
  when '97000000-0000-0000-0000-00000000000c' then 'a3000000-0000-0000-0000-000000000009'
  when '97000000-0000-0000-0000-00000000000d' then 'a3000000-0000-0000-0000-000000000009'
  when '97000000-0000-0000-0000-00000000000e' then 'a3000000-0000-0000-0000-000000000007'
  else default_sla_policy_id
end
where tenant_id = '00000000-0000-0000-0000-000000000001';

update public.asset_types
set default_team_id = case id
      when '98000000-0000-0000-0000-000000000001' then '94000000-0000-0000-0000-000000000002'::uuid
      when '98000000-0000-0000-0000-000000000002' then '94000000-0000-0000-0000-000000000002'::uuid
      when '98000000-0000-0000-0000-000000000003' then '94000000-0000-0000-0000-000000000002'::uuid
      else null end,
    default_vendor_id = case id
      when '98000000-0000-0000-0000-000000000004' then '97000000-0000-0000-0000-000000000008'::uuid
      when '98000000-0000-0000-0000-000000000005' then '97000000-0000-0000-0000-00000000000e'::uuid
      when '98000000-0000-0000-0000-000000000006' then '97000000-0000-0000-0000-00000000000e'::uuid
      when '98000000-0000-0000-0000-000000000007' then '97000000-0000-0000-0000-000000000003'::uuid
      when '98000000-0000-0000-0000-000000000008' then '97000000-0000-0000-0000-000000000002'::uuid
      when '98000000-0000-0000-0000-000000000009' then '97000000-0000-0000-0000-000000000006'::uuid
      else default_vendor_id end
where tenant_id = '00000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 6. Workflows
-- ---------------------------------------------------------------------------

insert into public.workflow_definitions (id, tenant_id, name, entity_type, version, status, graph_definition, published_at)
values
  (
    'a5000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    'TSS IT Standard Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'assign_it', 'type', 'assign', 'config', jsonb_build_object('team_id', '94000000-0000-0000-0000-000000000002')),
        jsonb_build_object('id', 'priority_check', 'type', 'condition', 'config', jsonb_build_object('field', 'priority', 'operator', 'in', 'value', jsonb_build_array('high', 'urgent'))),
        jsonb_build_object('id', 'notify_major', 'type', 'notification', 'config', jsonb_build_object('notification_type', 'it_major_issue', 'subject', 'High-priority IT issue raised', 'body', 'Review and triage required.')),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'assign_it'),
        jsonb_build_object('from', 'assign_it', 'to', 'priority_check'),
        jsonb_build_object('from', 'priority_check', 'to', 'notify_major', 'condition', 'true'),
        jsonb_build_object('from', 'priority_check', 'to', 'end', 'condition', 'false'),
        jsonb_build_object('from', 'notify_major', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000001',
    'TSS Hardware Replacement Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'assign_it', 'type', 'assign', 'config', jsonb_build_object('team_id', '94000000-0000-0000-0000-000000000002')),
        jsonb_build_object('id', 'spawn_children', 'type', 'create_child_tasks', 'config', jsonb_build_object(
          'tasks', jsonb_build_array(
            jsonb_build_object('title', 'Remote diagnosis', 'assigned_team_id', '94000000-0000-0000-0000-000000000002', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
            jsonb_build_object('title', 'Replacement unit logistics', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000009', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
          )
        )),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'assign_it'),
        jsonb_build_object('from', 'assign_it', 'to', 'spawn_children'),
        jsonb_build_object('from', 'spawn_children', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000001',
    'TSS Access Provisioning Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'assign_it', 'type', 'assign', 'config', jsonb_build_object('team_id', '94000000-0000-0000-0000-000000000002')),
        jsonb_build_object('id', 'spawn_children', 'type', 'create_child_tasks', 'config', jsonb_build_object(
          'tasks', jsonb_build_array(
            jsonb_build_object('title', 'Review request and required access', 'assigned_team_id', '94000000-0000-0000-0000-000000000002', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
            jsonb_build_object('title', 'Badge or controller programming', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000006', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
          )
        )),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'assign_it'),
        jsonb_build_object('from', 'assign_it', 'to', 'spawn_children'),
        jsonb_build_object('from', 'spawn_children', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-000000000004',
    '00000000-0000-0000-0000-000000000001',
    'TSS Workplace Move Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'ams_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000012', '93000000-0000-0000-0000-000000000013'))),
        jsonb_build_object('id', 'dhg_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000021', '93000000-0000-0000-0000-000000000022'))),
        jsonb_build_object('id', 'ams_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Amsterdam move coordination', 'assigned_team_id', '94000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'Furniture move and relocation', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000012', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'IT workplace enablement', 'assigned_team_id', '94000000-0000-0000-0000-000000000002', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dhg_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Haag move coordination', 'assigned_team_id', '94000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'Furniture move and relocation', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000012', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'IT workplace enablement', 'assigned_team_id', '94000000-0000-0000-0000-000000000002', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dbh_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Bosch move coordination', 'assigned_team_id', '94000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'Furniture move and relocation', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000012', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'IT workplace enablement', 'assigned_team_id', '94000000-0000-0000-0000-000000000002', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'ams_check'),
        jsonb_build_object('from', 'ams_check', 'to', 'ams_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'ams_check', 'to', 'dhg_check', 'condition', 'false'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dhg_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dbh_dispatch', 'condition', 'false'),
        jsonb_build_object('from', 'ams_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dhg_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dbh_dispatch', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-000000000005',
    '00000000-0000-0000-0000-000000000001',
    'TSS Cleaning Dispatch Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'ams_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000012', '93000000-0000-0000-0000-000000000013'))),
        jsonb_build_object('id', 'dhg_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000021', '93000000-0000-0000-0000-000000000022'))),
        jsonb_build_object('id', 'ams_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Amsterdam facilities inspection', 'assigned_team_id', '94000000-0000-0000-0000-000000000004', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Cleaning vendor execution', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000001', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009')
        ))),
        jsonb_build_object('id', 'dhg_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Haag facilities inspection', 'assigned_team_id', '94000000-0000-0000-0000-000000000005', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Cleaning vendor execution', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000001', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009')
        ))),
        jsonb_build_object('id', 'dbh_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Bosch facilities inspection', 'assigned_team_id', '94000000-0000-0000-0000-000000000006', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Cleaning vendor execution', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000001', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009')
        ))),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'ams_check'),
        jsonb_build_object('from', 'ams_check', 'to', 'ams_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'ams_check', 'to', 'dhg_check', 'condition', 'false'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dhg_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dbh_dispatch', 'condition', 'false'),
        jsonb_build_object('from', 'ams_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dhg_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dbh_dispatch', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-000000000006',
    '00000000-0000-0000-0000-000000000001',
    'TSS Plumbing Dispatch Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'ams_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000012', '93000000-0000-0000-0000-000000000013'))),
        jsonb_build_object('id', 'dhg_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000021', '93000000-0000-0000-0000-000000000022'))),
        jsonb_build_object('id', 'ams_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Amsterdam plumbing assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Plumbing repair dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dhg_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Haag plumbing assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Plumbing repair dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dbh_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Bosch plumbing assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Plumbing repair dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'ams_check'),
        jsonb_build_object('from', 'ams_check', 'to', 'ams_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'ams_check', 'to', 'dhg_check', 'condition', 'false'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dhg_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dbh_dispatch', 'condition', 'false'),
        jsonb_build_object('from', 'ams_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dhg_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dbh_dispatch', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-000000000007',
    '00000000-0000-0000-0000-000000000001',
    'TSS HVAC Dispatch Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'ams_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000012', '93000000-0000-0000-0000-000000000013'))),
        jsonb_build_object('id', 'dhg_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000021', '93000000-0000-0000-0000-000000000022'))),
        jsonb_build_object('id', 'ams_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Amsterdam HVAC assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'HVAC specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000003', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dhg_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Haag HVAC assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'HVAC specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000003', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dbh_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Bosch HVAC assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'HVAC specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000003', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'ams_check'),
        jsonb_build_object('from', 'ams_check', 'to', 'ams_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'ams_check', 'to', 'dhg_check', 'condition', 'false'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dhg_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dbh_dispatch', 'condition', 'false'),
        jsonb_build_object('from', 'ams_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dhg_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dbh_dispatch', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-000000000008',
    '00000000-0000-0000-0000-000000000001',
    'TSS Electrical Dispatch Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'ams_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000012', '93000000-0000-0000-0000-000000000013'))),
        jsonb_build_object('id', 'dhg_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000021', '93000000-0000-0000-0000-000000000022'))),
        jsonb_build_object('id', 'ams_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Amsterdam electrical assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Electrical specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dhg_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Haag electrical assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Electrical specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dbh_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Bosch electrical assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Electrical specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'ams_check'),
        jsonb_build_object('from', 'ams_check', 'to', 'ams_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'ams_check', 'to', 'dhg_check', 'condition', 'false'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dhg_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dbh_dispatch', 'condition', 'false'),
        jsonb_build_object('from', 'ams_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dhg_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dbh_dispatch', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-000000000009',
    '00000000-0000-0000-0000-000000000001',
    'TSS Elevator Dispatch Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'ams_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000012', '93000000-0000-0000-0000-000000000013'))),
        jsonb_build_object('id', 'dhg_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000021', '93000000-0000-0000-0000-000000000022'))),
        jsonb_build_object('id', 'ams_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Amsterdam elevator assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000004', 'priority', 'urgent', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000008'),
          jsonb_build_object('title', 'Elevator specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000002', 'priority', 'urgent', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000008')
        ))),
        jsonb_build_object('id', 'dhg_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Haag elevator assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000005', 'priority', 'urgent', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000008'),
          jsonb_build_object('title', 'Elevator specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000002', 'priority', 'urgent', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000008')
        ))),
        jsonb_build_object('id', 'dbh_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Bosch elevator assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000006', 'priority', 'urgent', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000008'),
          jsonb_build_object('title', 'Elevator specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000002', 'priority', 'urgent', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000008')
        ))),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'ams_check'),
        jsonb_build_object('from', 'ams_check', 'to', 'ams_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'ams_check', 'to', 'dhg_check', 'condition', 'false'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dhg_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dbh_dispatch', 'condition', 'false'),
        jsonb_build_object('from', 'ams_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dhg_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dbh_dispatch', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-00000000000a',
    '00000000-0000-0000-0000-000000000001',
    'TSS Access Control Dispatch Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'ams_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000012', '93000000-0000-0000-0000-000000000013'))),
        jsonb_build_object('id', 'dhg_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000021', '93000000-0000-0000-0000-000000000022'))),
        jsonb_build_object('id', 'ams_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Amsterdam access control assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Access control specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dhg_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Haag access control assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Access control specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dbh_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Bosch access control assessment', 'assigned_team_id', '94000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Access control specialist dispatch', 'assigned_vendor_id', '97000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'ams_check'),
        jsonb_build_object('from', 'ams_check', 'to', 'ams_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'ams_check', 'to', 'dhg_check', 'condition', 'false'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dhg_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dbh_dispatch', 'condition', 'false'),
        jsonb_build_object('from', 'ams_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dhg_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dbh_dispatch', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-00000000000b',
    '00000000-0000-0000-0000-000000000001',
    'TSS New Starter Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'ams_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000011', '93000000-0000-0000-0000-000000000012', '93000000-0000-0000-0000-000000000013'))),
        jsonb_build_object('id', 'dhg_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000021', '93000000-0000-0000-0000-000000000022'))),
        jsonb_build_object('id', 'ams_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Prepare IT hardware and identity', 'assigned_team_id', '94000000-0000-0000-0000-000000000002', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Prepare workplace and starter pack', 'assigned_team_id', '94000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'Portal and service desk handover', 'assigned_team_id', '94000000-0000-0000-0000-000000000001', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dhg_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Prepare IT hardware and identity', 'assigned_team_id', '94000000-0000-0000-0000-000000000002', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Prepare workplace and starter pack', 'assigned_team_id', '94000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'Portal and service desk handover', 'assigned_team_id', '94000000-0000-0000-0000-000000000001', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dbh_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Prepare IT hardware and identity', 'assigned_team_id', '94000000-0000-0000-0000-000000000002', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
          jsonb_build_object('title', 'Prepare workplace and starter pack', 'assigned_team_id', '94000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'Portal and service desk handover', 'assigned_team_id', '94000000-0000-0000-0000-000000000001', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'ams_check'),
        jsonb_build_object('from', 'ams_check', 'to', 'ams_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'ams_check', 'to', 'dhg_check', 'condition', 'false'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dhg_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dbh_dispatch', 'condition', 'false'),
        jsonb_build_object('from', 'ams_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dhg_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dbh_dispatch', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-00000000000c',
    '00000000-0000-0000-0000-000000000001',
    'TSS HR Standard Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'assign_hr', 'type', 'assign', 'config', jsonb_build_object('team_id', '94000000-0000-0000-0000-000000000003')),
        jsonb_build_object('id', 'notify_hr', 'type', 'notification', 'config', jsonb_build_object('notification_type', 'hr_request', 'subject', 'HR request requires attention', 'body', 'Review and continue the HR request.')),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'assign_hr'),
        jsonb_build_object('from', 'assign_hr', 'to', 'notify_hr'),
        jsonb_build_object('from', 'notify_hr', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-00000000000d',
    '00000000-0000-0000-0000-000000000001',
    'TSS Event Support Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'dhg_check', 'type', 'condition', 'config', jsonb_build_object('field', 'location_id', 'operator', 'in', 'value', jsonb_build_array('93000000-0000-0000-0000-000000000021', '93000000-0000-0000-0000-000000000022'))),
        jsonb_build_object('id', 'dhg_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Haag event setup', 'assigned_team_id', '94000000-0000-0000-0000-000000000005', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'Catering coordination', 'assigned_vendor_id', '97000000-0000-0000-0000-00000000000c', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'AV setup', 'assigned_vendor_id', '97000000-0000-0000-0000-00000000000e', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'dbh_dispatch', 'type', 'create_child_tasks', 'config', jsonb_build_object('tasks', jsonb_build_array(
          jsonb_build_object('title', 'Den Bosch event setup', 'assigned_team_id', '94000000-0000-0000-0000-000000000006', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'Catering coordination', 'assigned_vendor_id', '97000000-0000-0000-0000-00000000000d', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
          jsonb_build_object('title', 'AV setup', 'assigned_vendor_id', '97000000-0000-0000-0000-00000000000e', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
        ))),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'dhg_check'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dhg_dispatch', 'condition', 'true'),
        jsonb_build_object('from', 'dhg_check', 'to', 'dbh_dispatch', 'condition', 'false'),
        jsonb_build_object('from', 'dhg_dispatch', 'to', 'end'),
        jsonb_build_object('from', 'dbh_dispatch', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-00000000000e',
    '00000000-0000-0000-0000-000000000001',
    'TSS Amsterdam Event Support Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'spawn_children', 'type', 'create_child_tasks', 'config', jsonb_build_object(
          'tasks', jsonb_build_array(
            jsonb_build_object('title', 'Amsterdam event setup', 'assigned_team_id', '94000000-0000-0000-0000-000000000004', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
            jsonb_build_object('title', 'Catering coordination', 'assigned_vendor_id', '97000000-0000-0000-0000-00000000000b', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000009'),
            jsonb_build_object('title', 'AV setup', 'assigned_vendor_id', '97000000-0000-0000-0000-00000000000e', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
            jsonb_build_object('title', 'Service desk coordination', 'assigned_team_id', '94000000-0000-0000-0000-000000000001', 'priority', 'medium', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
          )
        )),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'spawn_children'),
        jsonb_build_object('from', 'spawn_children', 'to', 'end')
      )
    ),
    now()
  ),
  (
    'a5000000-0000-0000-0000-00000000000f',
    '00000000-0000-0000-0000-000000000001',
    'TSS AV Room Support Flow',
    'ticket',
    1,
    'published',
    jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
        jsonb_build_object('id', 'assign_it', 'type', 'assign', 'config', jsonb_build_object('team_id', '94000000-0000-0000-0000-000000000002')),
        jsonb_build_object('id', 'spawn_children', 'type', 'create_child_tasks', 'config', jsonb_build_object(
          'tasks', jsonb_build_array(
            jsonb_build_object('title', 'Remote AV triage', 'assigned_team_id', '94000000-0000-0000-0000-000000000002', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007'),
            jsonb_build_object('title', 'AV vendor on-site visit', 'assigned_vendor_id', '97000000-0000-0000-0000-00000000000e', 'priority', 'high', 'sla_policy_id', 'a3000000-0000-0000-0000-000000000007')
          )
        )),
        jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'assign_it'),
        jsonb_build_object('from', 'assign_it', 'to', 'spawn_children'),
        jsonb_build_object('from', 'spawn_children', 'to', 'end')
      )
    ),
    now()
  );

-- ---------------------------------------------------------------------------
-- 7. Request types
-- ---------------------------------------------------------------------------

insert into public.request_types (
  id, tenant_id, name, description, icon, keywords, display_order,
  kb_link, disruption_banner, on_behalf_policy,
  domain, workflow_definition_id, sla_policy_id, active,
  fulfillment_strategy, requires_asset, asset_required, asset_type_filter,
  requires_location, location_required, location_granularity,
  default_team_id, default_vendor_id,
  requires_approval, approval_approver_team_id, approval_approver_person_id
)
values
  ('b1000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Laptop Broken', 'Your laptop is damaged, unusable, or needs replacement.', 'laptop', array['laptop','device','hardware','broken'], 101, null, null, 'self_only', 'hardware', 'a5000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000002', true, 'asset', true, true, array['98000000-0000-0000-0000-000000000001']::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Monitor Issue', 'Your monitor is flickering, dead, or not detected.', 'monitor', array['monitor','screen','display'], 102, null, null, 'self_only', 'hardware', 'a5000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', true, 'asset', true, true, array['98000000-0000-0000-0000-000000000002']::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Docking Station Issue', 'Your dock is failing to connect peripherals, network, or power.', 'plug', array['dock','usb-c','thunderbolt'], 103, null, null, 'self_only', 'hardware', 'a5000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', true, 'asset', true, true, array['98000000-0000-0000-0000-000000000003']::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Printer Problem', 'A shared office printer is offline, jammed, or printing badly.', 'printer', array['printer','mfp','toner','jam'], 104, null, null, 'self_only', 'printing', 'a5000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', true, 'asset', true, true, array['98000000-0000-0000-0000-000000000004']::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'Software Installation', 'Request installation or enablement of approved business software.', 'app-window', array['software','install','application','app'], 105, null, null, 'self_only', 'software', 'a5000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'Network Connectivity Issue', 'You cannot connect to Wi-Fi, VPN, or the wired office network.', 'wifi', array['network','wifi','vpn','connectivity'], 106, null, null, 'self_only', 'network', 'a5000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000002', true, 'auto', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'Meeting Room AV Issue', 'Audio, screens, or conferencing equipment in a meeting room are not working.', 'screen-share', array['meeting room','av','screen','teams room'], 107, null, null, 'self_only', 'av', 'a5000000-0000-0000-0000-00000000000f', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'New Hardware Request', 'Request a new standard laptop, monitor, or accessory.', 'package', array['new hardware','request','laptop','monitor','accessory'], 108, null, null, 'self_only', 'hardware', 'a5000000-0000-0000-0000-000000000002', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'Password Reset', 'You cannot sign in and need help regaining access.', 'key-round', array['password','reset','login','sign in'], 201, null, null, 'self_only', 'identity', null, 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'Badge Access Request', 'Request or change physical office access for yourself or a direct report.', 'badge', array['badge','access','physical access'], 202, null, null, 'direct_reports', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], true, true, 'building', null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'CRM Access Request', 'Request a new CRM role, extra access, or removal of access.', 'user-lock', array['crm','salesforce','access','role'], 203, null, null, 'self_only', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 'Office Move', 'Move a person or team to another workspace or building.', 'move-right', array['move','office move','relocation'], 301, null, null, 'direct_reports', 'workplace', 'a5000000-0000-0000-0000-000000000004', 'a3000000-0000-0000-0000-000000000005', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-000000000001', 'Workstation Setup Change', 'Request changes to your desk setup, furniture, or local equipment.', 'desk', array['desk','setup','ergonomic','workstation'], 302, null, null, 'self_only', 'workplace', 'a5000000-0000-0000-0000-000000000004', 'a3000000-0000-0000-0000-000000000001', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-00000000000e', '00000000-0000-0000-0000-000000000001', 'Cleaning Request', 'Request routine or targeted cleaning for an area.', 'spray-can', array['cleaning','janitorial','housekeeping'], 401, null, null, 'self_only', 'cleaning', 'a5000000-0000-0000-0000-000000000005', 'a3000000-0000-0000-0000-000000000001', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-00000000000f', '00000000-0000-0000-0000-000000000001', 'Spill Cleanup', 'Request urgent cleanup for a spill or hygiene issue.', 'droplets', array['spill','cleanup','urgent cleaning'], 402, null, null, 'self_only', 'cleaning', 'a5000000-0000-0000-0000-000000000005', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Deep Cleaning', 'Request deep cleaning for a project area, meeting space, or post-work cleanup.', 'bubbles', array['deep clean','project clean','post works'], 403, null, null, 'self_only', 'cleaning', 'a5000000-0000-0000-0000-000000000005', 'a3000000-0000-0000-0000-000000000005', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, true, '94000000-0000-0000-0000-000000000001', null),
  ('b1000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'Lighting Issue', 'Lighting is out, flickering, or unsafe.', 'lightbulb', array['light','lighting','electrical'], 501, null, null, 'self_only', 'electrical', 'a5000000-0000-0000-0000-000000000008', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000001', 'Plumbing Issue', 'Sinks, toilets, drains, or water systems are blocked or leaking.', 'bath', array['plumbing','leak','toilet','sink'], 502, null, null, 'self_only', 'plumbing', 'a5000000-0000-0000-0000-000000000006', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000001', 'HVAC Issue', 'Heating, cooling, or ventilation is not working correctly.', 'wind', array['hvac','aircon','heating','ventilation'], 503, null, null, 'self_only', 'hvac', 'a5000000-0000-0000-0000-000000000007', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000001', 'Elevator Issue', 'An elevator is stuck, unsafe, or not operating.', 'arrow-up-down', array['elevator','lift','stuck'], 504, null, null, 'self_only', 'elevators', 'a5000000-0000-0000-0000-000000000009', 'a3000000-0000-0000-0000-000000000003', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000001', 'Access Control Fault', 'A door, badge reader, or lock is not working as expected.', 'door-open', array['door','reader','lock','access control'], 505, null, null, 'self_only', 'access_control', 'a5000000-0000-0000-0000-00000000000a', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-000000000001', 'Leave Request', 'Ask HR to process or correct leave information.', 'calendar-days', array['leave','vacation','absence'], 701, null, null, 'self_only', 'hr', 'a5000000-0000-0000-0000-00000000000c', 'a3000000-0000-0000-0000-000000000004', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-000000000017', '00000000-0000-0000-0000-000000000001', 'Employment Letter Request', 'Request an employment confirmation or supporting HR letter.', 'file-text', array['employment letter','letter','proof of employment'], 702, null, null, 'direct_reports', 'hr', 'a5000000-0000-0000-0000-00000000000c', 'a3000000-0000-0000-0000-000000000004', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000018', '00000000-0000-0000-0000-000000000001', 'New Starter Setup', 'Coordinate IT, facilities, and service desk readiness for a starter.', 'user-plus', array['new starter','onboarding','setup'], 703, null, null, 'configured_list', 'hr', 'a5000000-0000-0000-0000-00000000000b', 'a3000000-0000-0000-0000-000000000005', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, true, '94000000-0000-0000-0000-000000000003', null),
  ('b1000000-0000-0000-0000-000000000019', '00000000-0000-0000-0000-000000000001', 'Meeting Catering', 'Order catering for a meeting or small internal gathering.', 'cup-soda', array['catering','meeting','lunch','coffee'], 601, null, null, 'self_only', 'catering', null, 'a3000000-0000-0000-0000-000000000006', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, true, '94000000-0000-0000-0000-000000000001', null),
  ('b1000000-0000-0000-0000-00000000001a', '00000000-0000-0000-0000-000000000001', 'Event Support', 'Coordinate facilities, catering, and AV for an internal event.', 'party-popper', array['event','town hall','support','av','catering'], 602, null, null, 'self_only', 'events', 'a5000000-0000-0000-0000-00000000000d', 'a3000000-0000-0000-0000-000000000006', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, true, '94000000-0000-0000-0000-000000000001', null),
  ('b1000000-0000-0000-0000-00000000001b', '00000000-0000-0000-0000-000000000001', 'Expense Question', 'Ask for help with an expense, reimbursement, or finance admin process.', 'receipt', array['expense','reimbursement','finance'], 801, null, null, 'self_only', 'admin', null, 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-00000000001c', '00000000-0000-0000-0000-000000000001', 'Company Card Issue', 'Report a blocked company card or question a card administration issue.', 'credit-card', array['card','company card','blocked card'], 802, null, null, 'self_only', 'admin', null, 'a3000000-0000-0000-0000-000000000002', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null);

insert into public.request_types (
  id, tenant_id, name, description, icon, keywords, display_order,
  kb_link, disruption_banner, on_behalf_policy,
  domain, workflow_definition_id, sla_policy_id, active,
  fulfillment_strategy, requires_asset, asset_required, asset_type_filter,
  requires_location, location_required, location_granularity,
  default_team_id, default_vendor_id,
  requires_approval, approval_approver_team_id, approval_approver_person_id
)
values
  ('b1000000-0000-0000-0000-00000000001d', '00000000-0000-0000-0000-000000000001', 'Email & Calendar Issue', 'Use this when Outlook, shared mailboxes, meeting invites, or calendar booking behavior is broken and you need IT support to restore normal communication.', 'mail', array['email','outlook','calendar','meeting invite'], 109, null, null, 'self_only', 'software', 'a5000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-00000000001e', '00000000-0000-0000-0000-000000000001', 'Mobile Device Issue', 'Report a business mobile phone or tablet that is damaged, locked, not syncing, or otherwise preventing you from working effectively.', 'smartphone', array['mobile','phone','tablet','sync'], 110, null, null, 'self_only', 'hardware', 'a5000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-00000000001f', '00000000-0000-0000-0000-000000000001', 'Software Access Change', 'Request a role change, elevated access, or removal of access in an approved business application for yourself or a team member.', 'shield-plus', array['access','software access','role change','permissions'], 204, null, null, 'direct_reports', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000001', 'Shared Mailbox Request', 'Request a new shared mailbox, membership change, or delegated access so a team inbox can be managed properly.', 'mailbox', array['shared mailbox','mailbox','outlook','delegation'], 205, null, null, 'direct_reports', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000001', 'Distribution List Request', 'Request a new mailing list, ownership update, or membership change for a department, project, or leadership communication group.', 'list', array['distribution list','mailing list','group email','membership'], 206, null, null, 'direct_reports', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000001', 'VPN Access Request', 'Request secure remote access for someone who needs VPN connectivity to reach internal systems from outside the office.', 'lock-keyhole', array['vpn','remote access','secure access','network access'], 207, null, null, 'direct_reports', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-000000000001', 'Furniture Request', 'Request new or replacement office furniture such as desks, chairs, storage, or meeting-room pieces for an approved workplace change.', 'sofa', array['furniture','desk','chair','workspace'], 303, null, null, 'direct_reports', 'workplace', 'a5000000-0000-0000-0000-000000000004', 'a3000000-0000-0000-0000-000000000005', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
  ('b1000000-0000-0000-0000-000000000024', '00000000-0000-0000-0000-000000000001', 'Waste & Recycling Pickup', 'Request an extra waste, cardboard, or recycling pickup for a room, floor, or project area that cannot wait for the normal round.', 'trash-2', array['waste','recycling','pickup','cardboard'], 404, null, null, 'self_only', 'cleaning', 'a5000000-0000-0000-0000-000000000005', 'a3000000-0000-0000-0000-000000000001', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000025', '00000000-0000-0000-0000-000000000001', 'Room Temperature Complaint', 'Use this when a room or floor is too hot, too cold, or has unstable temperature control that is affecting normal work.', 'thermometer', array['temperature','too hot','too cold','climate'], 506, null, null, 'self_only', 'hvac', 'a5000000-0000-0000-0000-000000000007', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000026', '00000000-0000-0000-0000-000000000001', 'Power / Outlet Issue', 'Report dead sockets, unsafe power points, loose electrical fittings, or local power problems in an office or meeting space.', 'plug-zap', array['power','socket','outlet','electrical'], 507, null, null, 'self_only', 'electrical', 'a5000000-0000-0000-0000-000000000008', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000027', '00000000-0000-0000-0000-000000000001', 'Lock / Key Issue', 'Report a faulty lock, broken key, jammed cylinder, or local door-security issue that needs facilities or specialist support.', 'key-square', array['lock','key','door lock','security'], 208, null, null, 'self_only', 'access_control', 'a5000000-0000-0000-0000-00000000000a', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000028', '00000000-0000-0000-0000-000000000001', 'Payroll Question', 'Ask HR for help with payroll timing, missing payments, corrections, or understanding a payslip-related issue.', 'banknote', array['payroll','salary','payslip','payment'], 704, null, null, 'self_only', 'hr', 'a5000000-0000-0000-0000-00000000000c', 'a3000000-0000-0000-0000-000000000004', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-000000000029', '00000000-0000-0000-0000-000000000001', 'Employee Data Change', 'Request an update to employee master data such as address, legal name, emergency contact, or another HR profile attribute.', 'id-card', array['employee data','profile change','address change','hr record'], 705, null, null, 'self_only', 'hr', 'a5000000-0000-0000-0000-00000000000c', 'a3000000-0000-0000-0000-000000000004', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-00000000002a', '00000000-0000-0000-0000-000000000001', 'HR Policy Question', 'Ask for clarification on leave, travel, conduct, or another HR policy when you need an answer from the people team.', 'book-open-text', array['policy','hr policy','people policy','guidance'], 706, null, null, 'self_only', 'hr', 'a5000000-0000-0000-0000-00000000000c', 'a3000000-0000-0000-0000-000000000004', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-00000000002b', '00000000-0000-0000-0000-000000000001', 'Invoice / Supplier Payment Question', 'Ask for help with invoice status, missing supplier payment, coding questions, or another accounts-payable administration issue.', 'file-invoice', array['invoice','supplier payment','accounts payable','finance'], 803, null, null, 'self_only', 'admin', null, 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
  ('b1000000-0000-0000-0000-00000000002c', '00000000-0000-0000-0000-000000000001', 'Travel Expense Issue', 'Report a problem with a submitted travel claim, missing reimbursement, or supporting documentation for a business trip.', 'plane', array['travel expense','claim','reimbursement','trip'], 804, null, null, 'self_only', 'admin', null, 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null);

update public.request_types rt
set domain_id = d.id
from public.domains d
where d.tenant_id = rt.tenant_id
  and d.key = rt.domain
  and rt.tenant_id = '00000000-0000-0000-0000-000000000001';

update public.request_types rt
set description = d.description
from (
  values
    ('b1000000-0000-0000-0000-000000000001'::uuid, 'Report a laptop that is damaged, unusable, or unreliable so IT can diagnose it, arrange a repair, or swap the device.'),
    ('b1000000-0000-0000-0000-000000000002'::uuid, 'Use this when your monitor is blank, flickering, damaged, or no longer detected so workplace IT can restore your setup quickly.'),
    ('b1000000-0000-0000-0000-000000000003'::uuid, 'Report a dock that is not providing power, displays, network, or peripherals at your main workspace or hybrid setup.'),
    ('b1000000-0000-0000-0000-000000000004'::uuid, 'Report a shared printer or multifunction device that is offline, jammed, streaking, or otherwise blocking office work.'),
    ('b1000000-0000-0000-0000-000000000005'::uuid, 'Request installation, update, or enablement of approved business software on a managed device, including license-backed tools.'),
    ('b1000000-0000-0000-0000-000000000006'::uuid, 'Use this when office Wi-Fi, VPN, wired network, or core connectivity is unstable or unavailable and work is being disrupted.'),
    ('b1000000-0000-0000-0000-000000000007'::uuid, 'Report broken meeting-room screens, audio, cameras, conferencing, or control-panel issues affecting planned meetings or workshops.'),
    ('b1000000-0000-0000-0000-000000000008'::uuid, 'Request standard end-user hardware such as a laptop, monitor, dock, keyboard, mouse, or another approved accessory.'),
    ('b1000000-0000-0000-0000-000000000009'::uuid, 'Use this when you are locked out or cannot sign in and need identity support to regain access without delay.'),
    ('b1000000-0000-0000-0000-00000000000a'::uuid, 'Request new badge access or a change to building or room permissions for yourself or an approved team member.'),
    ('b1000000-0000-0000-0000-00000000000b'::uuid, 'Request a new CRM role, extra permissions, or access removal for sales and customer-facing systems.'),
    ('b1000000-0000-0000-0000-00000000000c'::uuid, 'Coordinate an individual or team move between rooms, floors, or buildings including workplace, furniture, and IT enablement.'),
    ('b1000000-0000-0000-0000-00000000000d'::uuid, 'Request ergonomic changes, furniture adjustments, cable cleanup, or local setup improvements at your workspace.'),
    ('b1000000-0000-0000-0000-00000000000e'::uuid, 'Request routine or targeted cleaning for an office area, meeting room, pantry, or shared workplace space.'),
    ('b1000000-0000-0000-0000-00000000000f'::uuid, 'Use this for urgent cleanup of spills, hygiene issues, or other situations that require fast facilities response.'),
    ('b1000000-0000-0000-0000-000000000010'::uuid, 'Request project cleaning, post-works cleanup, or a deeper reset of a room, floor, or office area.'),
    ('b1000000-0000-0000-0000-000000000011'::uuid, 'Report failed, flickering, or unsafe lighting in a workspace, meeting room, corridor, pantry, or shared area.'),
    ('b1000000-0000-0000-0000-000000000012'::uuid, 'Use this for leaking sinks, blocked toilets, drainage problems, or other water and sanitary faults in the building.'),
    ('b1000000-0000-0000-0000-000000000013'::uuid, 'Report heating, cooling, airflow, or ventilation issues affecting comfort, safety, or normal use of a room or floor.'),
    ('b1000000-0000-0000-0000-000000000014'::uuid, 'Use this for elevators that are stuck, unsafe, noisy, unreliable, or otherwise not operating as expected.'),
    ('b1000000-0000-0000-0000-000000000015'::uuid, 'Report broken doors, locks, badge readers, turnstiles, or other access-control hardware that is not functioning correctly.'),
    ('b1000000-0000-0000-0000-000000000016'::uuid, 'Ask HR to process leave administration, fix a leave balance issue, or help with an absence-related request.'),
    ('b1000000-0000-0000-0000-000000000017'::uuid, 'Request an employment confirmation, salary statement, or supporting HR letter for an official external purpose.'),
    ('b1000000-0000-0000-0000-000000000018'::uuid, 'Coordinate onboarding for a new starter so HR, IT, and workplace teams are ready before the employee arrives.'),
    ('b1000000-0000-0000-0000-000000000019'::uuid, 'Order meeting catering for internal sessions, workshops, or client-facing meetings at a supported office location.'),
    ('b1000000-0000-0000-0000-00000000001a'::uuid, 'Request coordinated facilities, catering, and AV support for internal events, town halls, and larger hosted sessions.'),
    ('b1000000-0000-0000-0000-00000000001b'::uuid, 'Ask for help with expenses, reimbursements, travel claims, or general finance administration questions.'),
    ('b1000000-0000-0000-0000-00000000001c'::uuid, 'Report a blocked company card, missing transaction, declined payment, or another card administration problem.')
) as d(id, description)
where rt.id = d.id
  and rt.tenant_id = '00000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 8. Category bindings and form variants
-- ---------------------------------------------------------------------------

insert into public.request_type_categories (tenant_id, request_type_id, category_id)
values
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000003', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000004', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000005', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000006', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000007', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000008', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000009', 'a1110000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000a', 'a1110000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000b', 'a1110000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000c', 'a1110000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000d', 'a1110000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000e', 'a1110000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000f', 'a1110000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000010', 'a1110000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000011', 'a1110000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000012', 'a1110000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000013', 'a1110000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000014', 'a1110000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000015', 'a1110000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000016', 'a1110000-0000-0000-0000-000000000007'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000017', 'a1110000-0000-0000-0000-000000000007'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000018', 'a1110000-0000-0000-0000-000000000007'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000019', 'a1110000-0000-0000-0000-000000000006'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001a', 'a1110000-0000-0000-0000-000000000006'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001b', 'a1110000-0000-0000-0000-000000000008'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001c', 'a1110000-0000-0000-0000-000000000008'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001d', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001e', 'a1110000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001f', 'a1110000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000020', 'a1110000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000021', 'a1110000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000022', 'a1110000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000023', 'a1110000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000024', 'a1110000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000025', 'a1110000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000026', 'a1110000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000027', 'a1110000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000028', 'a1110000-0000-0000-0000-000000000007'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000029', 'a1110000-0000-0000-0000-000000000007'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000002a', 'a1110000-0000-0000-0000-000000000007'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000002b', 'a1110000-0000-0000-0000-000000000008'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000002c', 'a1110000-0000-0000-0000-000000000008');

insert into public.request_type_form_variants (tenant_id, request_type_id, criteria_set_id, form_schema_id, priority, active)
values
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', null, 'a2000000-0000-0000-0000-000000000001', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', null, 'a2000000-0000-0000-0000-000000000001', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000003', null, 'a2000000-0000-0000-0000-000000000001', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000004', null, 'a2000000-0000-0000-0000-000000000001', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000005', null, 'a2000000-0000-0000-0000-000000000001', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000006', null, 'a2000000-0000-0000-0000-000000000001', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000007', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000008', null, 'a2000000-0000-0000-0000-000000000001', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000009', null, 'a2000000-0000-0000-0000-000000000002', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000a', null, 'a2000000-0000-0000-0000-000000000002', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000b', null, 'a2000000-0000-0000-0000-000000000002', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000c', null, 'a2000000-0000-0000-0000-000000000004', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000d', null, 'a2000000-0000-0000-0000-000000000004', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000e', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000f', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000010', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000011', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000012', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000013', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000014', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000015', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000016', null, 'a2000000-0000-0000-0000-000000000005', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000017', null, 'a2000000-0000-0000-0000-000000000005', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000018', null, 'a2000000-0000-0000-0000-000000000005', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000019', null, 'a2000000-0000-0000-0000-000000000006', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001a', null, 'a2000000-0000-0000-0000-000000000006', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001b', null, 'a2000000-0000-0000-0000-000000000007', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001c', null, 'a2000000-0000-0000-0000-000000000007', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001d', null, 'a2000000-0000-0000-0000-000000000001', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001e', null, 'a2000000-0000-0000-0000-000000000001', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001f', null, 'a2000000-0000-0000-0000-000000000002', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000020', null, 'a2000000-0000-0000-0000-000000000002', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000021', null, 'a2000000-0000-0000-0000-000000000002', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000022', null, 'a2000000-0000-0000-0000-000000000002', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000023', null, 'a2000000-0000-0000-0000-000000000004', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000024', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000025', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000026', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000027', null, 'a2000000-0000-0000-0000-000000000003', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000028', null, 'a2000000-0000-0000-0000-000000000005', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000029', null, 'a2000000-0000-0000-0000-000000000005', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000002a', null, 'a2000000-0000-0000-0000-000000000005', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000002b', null, 'a2000000-0000-0000-0000-000000000007', 0, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000002c', null, 'a2000000-0000-0000-0000-000000000007', 0, true);

-- ---------------------------------------------------------------------------
-- 9. Criteria, audience, coverage, on-behalf, routing
-- ---------------------------------------------------------------------------

insert into public.criteria_sets (id, tenant_id, name, description, expression, active)
values
  ('a6000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'All Staff', 'Employees, contractors, and temporary workers.', '{"attr":"type","op":"in","values":["employee","contractor","temporary_worker"]}'::jsonb, true),
  ('a6000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Employees Only', 'Internal employees only.', '{"attr":"type","op":"eq","value":"employee"}'::jsonb, true),
  ('a6000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Contractors Only', 'Contractors only.', '{"attr":"type","op":"eq","value":"contractor"}'::jsonb, true),
  ('a6000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'Sales And Customer Success', 'Commercial users needing CRM-related services.', '{"attr":"org_node_code","op":"in","values":["SALES","CS"]}'::jsonb, true),
  ('a6000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'HR And Service Desk', 'HR and service desk actors who coordinate onboarding.', '{"attr":"org_node_code","op":"in","values":["HR","OPS"]}'::jsonb, true),
  ('a6000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'Employees And Contractors', 'Any worker who can be targeted by onboarding or moves.', '{"attr":"type","op":"in","values":["employee","contractor"]}'::jsonb, true);

insert into public.request_type_audience_rules (tenant_id, request_type_id, criteria_set_id, mode, active)
values
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000b', 'a6000000-0000-0000-0000-000000000004', 'visible_allow', true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000000b', 'a6000000-0000-0000-0000-000000000004', 'request_allow', true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000016', 'a6000000-0000-0000-0000-000000000001', 'visible_allow', true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000017', 'a6000000-0000-0000-0000-000000000002', 'visible_allow', true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000018', 'a6000000-0000-0000-0000-000000000005', 'visible_allow', true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000018', 'a6000000-0000-0000-0000-000000000005', 'request_allow', true);

insert into public.request_type_on_behalf_rules (tenant_id, request_type_id, role, criteria_set_id)
values
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000018', 'actor', 'a6000000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000018', 'target', 'a6000000-0000-0000-0000-000000000006');

insert into public.request_type_coverage_rules (
  tenant_id, request_type_id, scope_kind, space_id, space_group_id, inherit_to_descendants, active
)
select '00000000-0000-0000-0000-000000000001', rt.id, 'tenant', null, null, true, true
from public.request_types rt
where rt.tenant_id = '00000000-0000-0000-0000-000000000001'
  and rt.id not in (
    'b1000000-0000-0000-0000-000000000010',
    'b1000000-0000-0000-0000-000000000019',
    'b1000000-0000-0000-0000-00000000001a'
  );

insert into public.request_type_coverage_rules (tenant_id, request_type_id, scope_kind, space_group_id, inherit_to_descendants, active)
values
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000010', 'space_group', 'a7000000-0000-0000-0000-000000000002', false, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000019', 'space_group', 'a7000000-0000-0000-0000-000000000001', false, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001a', 'space_group', 'a7000000-0000-0000-0000-000000000002', false, true);

insert into public.request_type_coverage_rules (tenant_id, request_type_id, scope_kind, space_id, inherit_to_descendants, active)
values
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000010', 'space', '93000000-0000-0000-0000-000000000021', false, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000019', 'space', '93000000-0000-0000-0000-000000000021', false, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000019', 'space', '93000000-0000-0000-0000-000000000022', false, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000019', 'space', '93000000-0000-0000-0000-000000000031', false, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001a', 'space', '93000000-0000-0000-0000-000000000021', false, true),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001a', 'space', '93000000-0000-0000-0000-000000000031', false, true);

insert into public.location_teams (tenant_id, space_id, domain, domain_id, team_id, vendor_id)
values
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', 'fm', 'c1000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', 'it', 'c1000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000002', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', 'hr', 'c1000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000003', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', 'admin', 'c1000000-0000-0000-0000-000000000004', '94000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000013', 'fm', 'c1000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000013', 'it', 'c1000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000002', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000013', 'hr', 'c1000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000003', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000013', 'admin', 'c1000000-0000-0000-0000-000000000004', '94000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000021', 'fm', 'c1000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000021', 'it', 'c1000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000002', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000021', 'hr', 'c1000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000003', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000021', 'admin', 'c1000000-0000-0000-0000-000000000004', '94000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000022', 'fm', 'c1000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000022', 'it', 'c1000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000002', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000022', 'hr', 'c1000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000003', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000022', 'admin', 'c1000000-0000-0000-0000-000000000004', '94000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000031', 'fm', 'c1000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000031', 'it', 'c1000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000002', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000031', 'hr', 'c1000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000003', null),
  ('00000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000031', 'admin', 'c1000000-0000-0000-0000-000000000004', '94000000-0000-0000-0000-000000000001', null);

insert into public.request_type_scope_overrides (
  tenant_id, request_type_id, scope_kind, space_group_id, inherit_to_descendants, active,
  workflow_definition_id, case_sla_policy_id, executor_sla_policy_id
)
values
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-00000000001a', 'space_group', 'a7000000-0000-0000-0000-000000000002', false, true, 'a5000000-0000-0000-0000-00000000000e', 'a3000000-0000-0000-0000-000000000006', 'a3000000-0000-0000-0000-000000000008');

insert into public.request_type_scope_overrides (
  tenant_id, request_type_id, scope_kind, space_id, inherit_to_descendants, active,
  handler_kind, handler_vendor_id, case_sla_policy_id
)
values
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000010', 'space', '93000000-0000-0000-0000-000000000013', false, true, 'vendor', '97000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000014', 'space', '93000000-0000-0000-0000-000000000022', false, true, null, null, 'a3000000-0000-0000-0000-000000000003');

notify pgrst, 'reload schema';
