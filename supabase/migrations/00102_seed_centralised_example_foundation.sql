-- 00101_seed_centralised_example_foundation.sql
-- Canonical local TSS demo foundation: roles, spaces, org nodes, teams,
-- fixed people/users, vendors, and asset types.

do $$
declare
  t uuid := '00000000-0000-0000-0000-000000000001';
  ams_site uuid := '93000000-0000-0000-0000-000000000001';
  ams_a    uuid := '93000000-0000-0000-0000-000000000011';
  ams_b    uuid := '93000000-0000-0000-0000-000000000012';
  ams_c    uuid := '93000000-0000-0000-0000-000000000013';
  dhg_a    uuid := '93000000-0000-0000-0000-000000000021';
  dhg_b    uuid := '93000000-0000-0000-0000-000000000022';
  dbh_a    uuid := '93000000-0000-0000-0000-000000000031';
  v_building record;
  v_floor uuid;
begin
  insert into public.business_hours_calendars (id, tenant_id, name, time_zone, working_hours, holidays, active)
  values
    (
      '91100000-0000-0000-0000-000000000001',
      t,
      'TSS Office Hours',
      'Europe/Amsterdam',
      '{
        "monday": {"start": "08:00", "end": "17:30"},
        "tuesday": {"start": "08:00", "end": "17:30"},
        "wednesday": {"start": "08:00", "end": "17:30"},
        "thursday": {"start": "08:00", "end": "17:30"},
        "friday": {"start": "08:00", "end": "17:00"},
        "saturday": null,
        "sunday": null
      }'::jsonb,
      jsonb_build_array(
        jsonb_build_object('date', '2026-01-01', 'name', 'New Year''s Day', 'recurring', true),
        jsonb_build_object('date', '2026-04-27', 'name', 'King''s Day', 'recurring', true),
        jsonb_build_object('date', '2026-12-25', 'name', 'Christmas Day', 'recurring', true),
        jsonb_build_object('date', '2026-12-26', 'name', 'Boxing Day', 'recurring', true)
      ),
      true
    ),
    (
      '91100000-0000-0000-0000-000000000002',
      t,
      'TSS Extended Support',
      'Europe/Amsterdam',
      '{
        "monday": {"start": "07:00", "end": "20:00"},
        "tuesday": {"start": "07:00", "end": "20:00"},
        "wednesday": {"start": "07:00", "end": "20:00"},
        "thursday": {"start": "07:00", "end": "20:00"},
        "friday": {"start": "07:00", "end": "19:00"},
        "saturday": {"start": "09:00", "end": "13:00"},
        "sunday": null
      }'::jsonb,
      '[]'::jsonb,
      true
    ),
    (
      '91100000-0000-0000-0000-000000000003',
      t,
      'TSS 24x7 Coverage',
      'Europe/Amsterdam',
      '{
        "monday": {"start": "00:00", "end": "23:59"},
        "tuesday": {"start": "00:00", "end": "23:59"},
        "wednesday": {"start": "00:00", "end": "23:59"},
        "thursday": {"start": "00:00", "end": "23:59"},
        "friday": {"start": "00:00", "end": "23:59"},
        "saturday": {"start": "00:00", "end": "23:59"},
        "sunday": {"start": "00:00", "end": "23:59"}
      }'::jsonb,
      '[]'::jsonb,
      true
    )
  on conflict (id) do update set
    name = excluded.name,
    time_zone = excluded.time_zone,
    working_hours = excluded.working_hours,
    holidays = excluded.holidays,
    active = excluded.active,
    updated_at = now();

  insert into public.roles (id, tenant_id, name, description, permissions, type, active)
  values
    (
      '91000000-0000-0000-0000-000000000001',
      t,
      'Admin',
      'Full tenant administration',
      '["people:manage","request_types:manage","routing_studio:access","organisations:manage"]'::jsonb,
      'admin',
      true
    ),
    (
      '91000000-0000-0000-0000-000000000002',
      t,
      'Agent',
      'Desk and fulfillment access',
      '[]'::jsonb,
      'agent',
      true
    ),
    (
      '91000000-0000-0000-0000-000000000003',
      t,
      'Employee',
      'Portal-only employee access',
      '[]'::jsonb,
      'employee',
      true
    )
  on conflict (id) do update set
    name = excluded.name,
    description = excluded.description,
    permissions = excluded.permissions,
    type = excluded.type,
    active = excluded.active,
    updated_at = now();

  insert into public.spaces (id, tenant_id, parent_id, type, code, name, capacity, amenities, reservable, active, attributes)
  values
    (ams_site, t, null, 'site', 'AMS-CAMPUS', 'Amsterdam Campus', null, '{}'::text[], false, true, '{"city":"Amsterdam"}'::jsonb),
    (ams_a,    t, ams_site, 'building', 'AMS-ATL', 'Atlas House', null, '{}'::text[], false, true, '{"city":"Amsterdam","address":"Atlaslaan 14"}'::jsonb),
    (ams_b,    t, ams_site, 'building', 'AMS-CAN', 'Canal Court', null, '{}'::text[], false, true, '{"city":"Amsterdam","address":"Kade 118"}'::jsonb),
    (ams_c,    t, null, 'building', 'AMS-SIN', 'Singel Office', null, '{}'::text[], false, true, '{"city":"Amsterdam","address":"Singel 245"}'::jsonb),
    (dhg_a,    t, null, 'building', 'DHG-WIJ', 'Wijnhaven Office', null, '{}'::text[], false, true, '{"city":"Den Haag","address":"Wijnhaven 64"}'::jsonb),
    (dhg_b,    t, null, 'building', 'DHG-SPU', 'Spui Center', null, '{}'::text[], false, true, '{"city":"Den Haag","address":"Spui 211"}'::jsonb),
    (dbh_a,    t, null, 'building', 'DBH-PET', 'Pettelaar Park', null, '{}'::text[], false, true, '{"city":"Den Bosch","address":"Pettelaarpark 92"}'::jsonb)
  on conflict (id) do update set
    parent_id = excluded.parent_id,
    type = excluded.type,
    code = excluded.code,
    name = excluded.name,
    capacity = excluded.capacity,
    amenities = excluded.amenities,
    reservable = excluded.reservable,
    active = excluded.active,
    attributes = excluded.attributes,
    updated_at = now();

  for v_building in
    select * from (values
      (ams_a, 'AMS-ATL'),
      (ams_b, 'AMS-CAN'),
      (ams_c, 'AMS-SIN'),
      (dhg_a, 'DHG-WIJ'),
      (dhg_b, 'DHG-SPU'),
      (dbh_a, 'DBH-PET')
    ) as b(id, code)
  loop
    for i in 1..3 loop
      insert into public.spaces (tenant_id, parent_id, type, code, name, active)
      values (t, v_building.id, 'floor', format('%s-F%s', v_building.code, i), format('Floor %s', i), true)
      returning id into v_floor;

      insert into public.spaces (tenant_id, parent_id, type, code, name, capacity, amenities, reservable, active, attributes)
      values
        (t, v_floor, 'room', format('%s-F%s-OPEN', v_building.code, i), format('Open Office %s', i), 36, array['desks','lockers'], false, true, '{"room_kind":"open_office"}'::jsonb),
        (t, v_floor, 'meeting_room', format('%s-F%s-MR10', v_building.code, i), format('Meeting Room %s.10', i), 6, array['display','whiteboard'], true, true, '{"room_kind":"meeting"}'::jsonb),
        (t, v_floor, 'meeting_room', format('%s-F%s-MR12', v_building.code, i), format('Meeting Room %s.12', i), 10, array['display','video_conference','whiteboard'], true, true, '{"room_kind":"meeting"}'::jsonb),
        (t, v_floor, 'common_area', format('%s-F%s-PANTRY', v_building.code, i), format('Pantry %s', i), 10, array['coffee','fridge'], false, true, '{"room_kind":"pantry"}'::jsonb),
        (t, v_floor, 'common_area', format('%s-F%s-COPY', v_building.code, i), format('Print Area %s', i), 4, array['printer'], false, true, '{"room_kind":"copy"}'::jsonb),
        (t, v_floor, 'storage_room', format('%s-F%s-STO', v_building.code, i), format('Storage %s', i), 4, '{}'::text[], false, true, '{"room_kind":"storage"}'::jsonb),
        (t, v_floor, 'technical_room', format('%s-F%s-TECH', v_building.code, i), format('Technical Room %s', i), 2, '{}'::text[], false, true, '{"room_kind":"technical"}'::jsonb);

      if i = 1 then
        insert into public.spaces (tenant_id, parent_id, type, code, name, capacity, amenities, reservable, active, attributes)
        values
          (t, v_floor, 'common_area', format('%s-F%s-REC', v_building.code, i), 'Reception', 8, array['visitor_desk'], false, true, '{"room_kind":"reception"}'::jsonb);
      end if;
    end loop;
  end loop;

  insert into public.org_nodes (id, tenant_id, parent_id, name, code, description, active)
  values
    ('92000000-0000-0000-0000-000000000001', t, null, 'Total Specific Services', 'TSS', 'Company root', true),
    ('92000000-0000-0000-0000-000000000002', t, '92000000-0000-0000-0000-000000000001', 'Operations', 'OPS', 'Operations and service functions', true),
    ('92000000-0000-0000-0000-000000000003', t, '92000000-0000-0000-0000-000000000001', 'IT', 'IT', 'Central IT organisation', true),
    ('92000000-0000-0000-0000-000000000004', t, '92000000-0000-0000-0000-000000000001', 'HR', 'HR', 'People operations', true),
    ('92000000-0000-0000-0000-000000000005', t, '92000000-0000-0000-0000-000000000001', 'Facilities', 'FM', 'Workplace and facilities', true),
    ('92000000-0000-0000-0000-000000000006', t, '92000000-0000-0000-0000-000000000001', 'Sales', 'SALES', 'Commercial teams', true),
    ('92000000-0000-0000-0000-000000000007', t, '92000000-0000-0000-0000-000000000001', 'Marketing', 'MKT', 'Marketing team', true),
    ('92000000-0000-0000-0000-000000000008', t, '92000000-0000-0000-0000-000000000001', 'Finance & Admin', 'FIN', 'Finance and administration', true),
    ('92000000-0000-0000-0000-000000000009', t, '92000000-0000-0000-0000-000000000001', 'Legal', 'LEGAL', 'Legal and compliance', true),
    ('92000000-0000-0000-0000-00000000000a', t, '92000000-0000-0000-0000-000000000001', 'Customer Success', 'CS', 'Customer support and success', true),
    ('92000000-0000-0000-0000-00000000000b', t, '92000000-0000-0000-0000-000000000005', 'Facilities Amsterdam', 'FM-AMS', 'Amsterdam facilities execution', true),
    ('92000000-0000-0000-0000-00000000000c', t, '92000000-0000-0000-0000-000000000005', 'Facilities Den Haag', 'FM-DHG', 'Den Haag facilities execution', true),
    ('92000000-0000-0000-0000-00000000000d', t, '92000000-0000-0000-0000-000000000005', 'Facilities Den Bosch', 'FM-DBH', 'Den Bosch facilities execution', true)
  on conflict (id) do update set
    parent_id = excluded.parent_id,
    name = excluded.name,
    code = excluded.code,
    description = excluded.description,
    active = excluded.active,
    updated_at = now();

  insert into public.teams (id, tenant_id, name, domain_scope, location_scope, org_node_id, active)
  values
    ('94000000-0000-0000-0000-000000000001', t, 'Central Service Desk', 'fm', ams_site, '92000000-0000-0000-0000-000000000002', true),
    ('94000000-0000-0000-0000-000000000002', t, 'Central IT', 'it', dbh_a, '92000000-0000-0000-0000-000000000003', true),
    ('94000000-0000-0000-0000-000000000003', t, 'Central HR', 'hr', ams_site, '92000000-0000-0000-0000-000000000004', true),
    ('94000000-0000-0000-0000-000000000004', t, 'Facilities Amsterdam', 'fm', ams_a, '92000000-0000-0000-0000-00000000000b', true),
    ('94000000-0000-0000-0000-000000000005', t, 'Facilities Den Haag', 'fm', dhg_a, '92000000-0000-0000-0000-00000000000c', true),
    ('94000000-0000-0000-0000-000000000006', t, 'Facilities Den Bosch', 'fm', dbh_a, '92000000-0000-0000-0000-00000000000d', true)
  on conflict (id) do update set
    name = excluded.name,
    domain_scope = excluded.domain_scope,
    location_scope = excluded.location_scope,
    org_node_id = excluded.org_node_id,
    active = excluded.active,
    updated_at = now();

  insert into public.vendors (id, tenant_id, name, contact_email, contact_phone, website, notes, owning_team_id, active)
  values
    ('97000000-0000-0000-0000-000000000001', t, 'BrightClean Services', 'ops@brightclean.example', '+31 20 555 1001', 'https://brightclean.example', 'Primary cleaning partner across all locations.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000002', t, 'LiftLine Elevators', 'dispatch@liftline.example', '+31 20 555 1002', 'https://liftline.example', 'Elevator maintenance and incident response.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000003', t, 'Klimaat Partners', 'service@klimaatpartners.example', '+31 20 555 1003', 'https://klimaatpartners.example', 'HVAC inspections and reactive maintenance.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000004', t, 'AquaFix Plumbing', 'tickets@aquafix.example', '+31 20 555 1004', 'https://aquafix.example', 'Plumbing and sanitary services.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000005', t, 'VoltWorks Electrical', 'dispatch@voltworks.example', '+31 20 555 1005', 'https://voltworks.example', 'Electrical faults and inspections.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000006', t, 'SecureEntry Systems', 'support@secureentry.example', '+31 20 555 1006', 'https://secureentry.example', 'Access control, locks and badge readers.', '94000000-0000-0000-0000-000000000002', true),
    ('97000000-0000-0000-0000-000000000007', t, 'Dutch Office Furnishings', 'service@dof.example', '+31 20 555 1007', 'https://dof.example', 'Furniture supply and ergonomic workstation changes.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000008', t, 'PrintPulse Managed Print', 'help@printpulse.example', '+31 20 555 1008', 'https://printpulse.example', 'Managed print services and consumables.', '94000000-0000-0000-0000-000000000002', true),
    ('97000000-0000-0000-0000-000000000009', t, 'DeviceCycle Logistics', 'support@devicecycle.example', '+31 20 555 1009', 'https://devicecycle.example', 'Hardware swaps, depot logistics and returns.', '94000000-0000-0000-0000-000000000002', true),
    ('97000000-0000-0000-0000-00000000000a', t, 'CableCraft Networks', 'dispatch@cablecraft.example', '+31 20 555 1010', 'https://cablecraft.example', 'Structured cabling and network-room work.', '94000000-0000-0000-0000-000000000002', true),
    ('97000000-0000-0000-0000-00000000000b', t, 'NorthStar Catering', 'orders@northstar.example', '+31 20 555 1011', 'https://northstar.example', 'Amsterdam campus catering partner.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-00000000000c', t, 'Hofstad Catering', 'orders@hofstad.example', '+31 70 555 1012', 'https://hofstad.example', 'Den Haag catering partner.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-00000000000d', t, 'Bosch Bites', 'orders@boschbites.example', '+31 73 555 1013', 'https://boschbites.example', 'Den Bosch catering partner.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-00000000000e', t, 'AV Horizon', 'desk@avhorizon.example', '+31 20 555 1014', 'https://avhorizon.example', 'Meeting-room AV support across all sites.', '94000000-0000-0000-0000-000000000002', true),
    ('97000000-0000-0000-0000-00000000000f', t, 'FireSafe Nederland', 'service@firesafe.example', '+31 20 555 1015', 'https://firesafe.example', 'Fire safety checks and urgent call-outs.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000010', t, 'GreenWaste Services', 'ops@greenwaste.example', '+31 20 555 1016', 'https://greenwaste.example', 'Waste handling and recycling.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000011', t, 'PestShield', 'help@pestshield.example', '+31 20 555 1017', 'https://pestshield.example', 'Pest control and inspection.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000012', t, 'Metro Movers', 'dispatch@metromovers.example', '+31 20 555 1018', 'https://metromovers.example', 'Internal move and workplace relocation partner.', '94000000-0000-0000-0000-000000000001', true),
    ('97000000-0000-0000-0000-000000000013', t, 'Legacy Lift Co', 'service@legacylift.example', '+31 20 555 1019', 'https://legacylift.example', 'Previous elevator partner retained for history.', '94000000-0000-0000-0000-000000000001', false),
    ('97000000-0000-0000-0000-000000000014', t, 'OldTown Cleaning', 'ops@oldtownclean.example', '+31 20 555 1020', 'https://oldtownclean.example', 'Retired cleaning partner retained for history.', '94000000-0000-0000-0000-000000000001', false)
  on conflict (id) do update set
    name = excluded.name,
    contact_email = excluded.contact_email,
    contact_phone = excluded.contact_phone,
    website = excluded.website,
    notes = excluded.notes,
    owning_team_id = excluded.owning_team_id,
    active = excluded.active,
    updated_at = now();

  insert into public.vendor_service_areas (tenant_id, vendor_id, space_id, service_type, default_priority, active)
  values
    (t, '97000000-0000-0000-0000-000000000001', ams_a, 'cleaning', 100, true),
    (t, '97000000-0000-0000-0000-000000000001', ams_b, 'cleaning', 100, true),
    (t, '97000000-0000-0000-0000-000000000001', ams_c, 'cleaning', 100, true),
    (t, '97000000-0000-0000-0000-000000000001', dhg_a, 'cleaning', 100, true),
    (t, '97000000-0000-0000-0000-000000000001', dhg_b, 'cleaning', 100, true),
    (t, '97000000-0000-0000-0000-000000000001', dbh_a, 'cleaning', 100, true),
    (t, '97000000-0000-0000-0000-000000000002', ams_a, 'maintenance', 10, true),
    (t, '97000000-0000-0000-0000-000000000002', ams_b, 'maintenance', 10, true),
    (t, '97000000-0000-0000-0000-000000000002', ams_c, 'maintenance', 10, true),
    (t, '97000000-0000-0000-0000-000000000002', dhg_a, 'maintenance', 10, true),
    (t, '97000000-0000-0000-0000-000000000002', dhg_b, 'maintenance', 10, true),
    (t, '97000000-0000-0000-0000-000000000002', dbh_a, 'maintenance', 10, true),
    (t, '97000000-0000-0000-0000-000000000003', ams_a, 'maintenance', 20, true),
    (t, '97000000-0000-0000-0000-000000000003', ams_b, 'maintenance', 20, true),
    (t, '97000000-0000-0000-0000-000000000003', ams_c, 'maintenance', 20, true),
    (t, '97000000-0000-0000-0000-000000000003', dhg_a, 'maintenance', 20, true),
    (t, '97000000-0000-0000-0000-000000000003', dhg_b, 'maintenance', 20, true),
    (t, '97000000-0000-0000-0000-000000000003', dbh_a, 'maintenance', 20, true),
    (t, '97000000-0000-0000-0000-000000000004', ams_a, 'maintenance', 30, true),
    (t, '97000000-0000-0000-0000-000000000004', ams_b, 'maintenance', 30, true),
    (t, '97000000-0000-0000-0000-000000000004', ams_c, 'maintenance', 30, true),
    (t, '97000000-0000-0000-0000-000000000004', dhg_a, 'maintenance', 30, true),
    (t, '97000000-0000-0000-0000-000000000004', dhg_b, 'maintenance', 30, true),
    (t, '97000000-0000-0000-0000-000000000004', dbh_a, 'maintenance', 30, true),
    (t, '97000000-0000-0000-0000-000000000008', ams_a, 'supplies', 20, true),
    (t, '97000000-0000-0000-0000-000000000008', ams_b, 'supplies', 20, true),
    (t, '97000000-0000-0000-0000-000000000008', ams_c, 'supplies', 20, true),
    (t, '97000000-0000-0000-0000-000000000008', dhg_a, 'supplies', 20, true),
    (t, '97000000-0000-0000-0000-000000000008', dhg_b, 'supplies', 20, true),
    (t, '97000000-0000-0000-0000-000000000008', dbh_a, 'supplies', 20, true),
    (t, '97000000-0000-0000-0000-00000000000b', ams_a, 'catering', 10, true),
    (t, '97000000-0000-0000-0000-00000000000b', ams_b, 'catering', 10, true),
    (t, '97000000-0000-0000-0000-00000000000c', dhg_a, 'catering', 10, true),
    (t, '97000000-0000-0000-0000-00000000000c', dhg_b, 'catering', 10, true),
    (t, '97000000-0000-0000-0000-00000000000d', dbh_a, 'catering', 10, true),
    (t, '97000000-0000-0000-0000-00000000000e', ams_a, 'av_equipment', 10, true),
    (t, '97000000-0000-0000-0000-00000000000e', ams_b, 'av_equipment', 10, true),
    (t, '97000000-0000-0000-0000-00000000000e', ams_c, 'av_equipment', 10, true),
    (t, '97000000-0000-0000-0000-00000000000e', dhg_a, 'av_equipment', 10, true),
    (t, '97000000-0000-0000-0000-00000000000e', dhg_b, 'av_equipment', 10, true),
    (t, '97000000-0000-0000-0000-00000000000e', dbh_a, 'av_equipment', 10, true),
    (t, '97000000-0000-0000-0000-000000000012', ams_a, 'transport', 10, true),
    (t, '97000000-0000-0000-0000-000000000012', ams_b, 'transport', 10, true),
    (t, '97000000-0000-0000-0000-000000000012', ams_c, 'transport', 10, true),
    (t, '97000000-0000-0000-0000-000000000012', dhg_a, 'transport', 10, true),
    (t, '97000000-0000-0000-0000-000000000012', dhg_b, 'transport', 10, true),
    (t, '97000000-0000-0000-0000-000000000012', dbh_a, 'transport', 10, true)
  on conflict (vendor_id, space_id, service_type) do update set
    default_priority = excluded.default_priority,
    active = excluded.active;

  insert into public.asset_types (id, tenant_id, name, description, default_role, active)
  values
    ('98000000-0000-0000-0000-000000000001', t, 'Laptop', 'Employee laptop device', 'personal', true),
    ('98000000-0000-0000-0000-000000000002', t, 'Monitor', 'Desktop monitor', 'personal', true),
    ('98000000-0000-0000-0000-000000000003', t, 'Dock', 'USB-C or Thunderbolt dock', 'personal', true),
    ('98000000-0000-0000-0000-000000000004', t, 'Printer', 'Shared office printer', 'fixed', true),
    ('98000000-0000-0000-0000-000000000005', t, 'Meeting Room Display', 'Shared meeting room display', 'fixed', true),
    ('98000000-0000-0000-0000-000000000006', t, 'AV Kit', 'Portable AV equipment', 'pooled', true),
    ('98000000-0000-0000-0000-000000000007', t, 'HVAC Unit', 'Building HVAC component', 'fixed', true),
    ('98000000-0000-0000-0000-000000000008', t, 'Elevator', 'Elevator asset', 'fixed', true),
    ('98000000-0000-0000-0000-000000000009', t, 'Door Controller', 'Access-control hardware', 'fixed', true)
  on conflict (id) do update set
    name = excluded.name,
    description = excluded.description,
    default_role = excluded.default_role,
    active = excluded.active;
end
$$;

do $$
declare
  t uuid := '00000000-0000-0000-0000-000000000001';
  ams_site uuid := '93000000-0000-0000-0000-000000000001';
  ams_a    uuid := '93000000-0000-0000-0000-000000000011';
  ams_c    uuid := '93000000-0000-0000-0000-000000000013';
  dhg_b    uuid := '93000000-0000-0000-0000-000000000022';
  dbh_a    uuid := '93000000-0000-0000-0000-000000000031';
  v_thomas_person uuid;
  v_thomas_user uuid;
begin
  select id into v_thomas_person
  from public.persons
  where tenant_id = t and lower(email) = 'dev@prequest.nl'
  limit 1;

  if v_thomas_person is null then
    v_thomas_person := '95000000-0000-0000-0000-000000000001';
    insert into public.persons (id, tenant_id, type, first_name, last_name, email, cost_center, active, default_location_id)
    values (v_thomas_person, t, 'employee', 'Thomas', 'Anderson', 'dev@prequest.nl', 'CC-OPS-001', true, ams_site);
  else
    update public.persons
    set type = 'employee',
        first_name = 'Thomas',
        last_name = 'Anderson',
        email = 'dev@prequest.nl',
        cost_center = 'CC-OPS-001',
        active = true,
        default_location_id = ams_site,
        updated_at = now()
    where id = v_thomas_person;
  end if;

  select id into v_thomas_user
  from public.users
  where tenant_id = t and lower(email) = 'dev@prequest.nl'
  limit 1;

  if v_thomas_user is null then
    v_thomas_user := '95100000-0000-0000-0000-000000000001';
    insert into public.users (id, tenant_id, person_id, auth_uid, email, username, status, portal_current_location_id)
    values (v_thomas_user, t, v_thomas_person, null, 'dev@prequest.nl', 'thomas.anderson', 'active', ams_site);
  else
    update public.users
    set person_id = v_thomas_person,
        email = 'dev@prequest.nl',
        username = 'thomas.anderson',
        status = 'active',
        portal_current_location_id = ams_site,
        updated_at = now()
    where id = v_thomas_user;
  end if;
end
$$;

insert into public.persons (id, tenant_id, type, first_name, last_name, email, cost_center, active, manager_person_id, default_location_id)
values
  ('95000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'employee', 'Sofia', 'Meyer', 'servicedesk.admin@prequest.nl', 'CC-OPS-010', true, '95000000-0000-0000-0000-00000000000b', '93000000-0000-0000-0000-000000000001'),
  ('95000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'employee', 'Liam', 'de Vries', 'servicedesk.agent@prequest.nl', 'CC-OPS-011', true, '95000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000001'),
  ('95000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'employee', 'Noor', 'Bakker', 'it.admin@prequest.nl', 'CC-IT-010', true, null, '93000000-0000-0000-0000-000000000031'),
  ('95000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', 'employee', 'Ethan', 'Jansen', 'it.agent@prequest.nl', 'CC-IT-011', true, '95000000-0000-0000-0000-000000000004', '93000000-0000-0000-0000-000000000031'),
  ('95000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', 'employee', 'Amelia', 'Clark', 'hr.agent@prequest.nl', 'CC-HR-010', true, null, '93000000-0000-0000-0000-000000000001'),
  ('95000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', 'employee', 'Daan', 'Visser', 'facilities.amsterdam@prequest.nl', 'CC-FM-AMS', true, '95000000-0000-0000-0000-00000000000b', '93000000-0000-0000-0000-000000000011'),
  ('95000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', 'employee', 'Sanne', 'Peters', 'facilities.denhaag@prequest.nl', 'CC-FM-DHG', true, '95000000-0000-0000-0000-00000000000b', '93000000-0000-0000-0000-000000000021'),
  ('95000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', 'employee', 'Ruben', 'Meijer', 'facilities.denbosch@prequest.nl', 'CC-FM-DBH', true, '95000000-0000-0000-0000-00000000000b', '93000000-0000-0000-0000-000000000031'),
  ('95000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', 'vendor_contact', 'Mila', 'Vos', 'cleaning.vendor@prequest.nl', 'CC-VENDOR', true, null, '93000000-0000-0000-0000-000000000011'),
  ('95000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', 'employee', 'James', 'Baker', 'manager.approver@prequest.nl', 'CC-OPS-020', true, null, '93000000-0000-0000-0000-000000000013'),
  ('95000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', 'employee', 'Olivia', 'Smith', 'employee.requester@prequest.nl', 'CC-SALES-001', true, '95000000-0000-0000-0000-00000000000b', '93000000-0000-0000-0000-000000000022')
on conflict (id) do update set
  type = excluded.type,
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  email = excluded.email,
  cost_center = excluded.cost_center,
  active = excluded.active,
  manager_person_id = excluded.manager_person_id,
  default_location_id = excluded.default_location_id,
  updated_at = now();

insert into public.users (id, tenant_id, person_id, auth_uid, email, username, status, portal_current_location_id)
values
  ('95100000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000002', null, 'servicedesk.admin@prequest.nl', 'servicedesk.admin', 'active', '93000000-0000-0000-0000-000000000001'),
  ('95100000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000003', null, 'servicedesk.agent@prequest.nl', 'servicedesk.agent', 'active', '93000000-0000-0000-0000-000000000001'),
  ('95100000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000004', null, 'it.admin@prequest.nl', 'it.admin', 'active', '93000000-0000-0000-0000-000000000031'),
  ('95100000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000005', null, 'it.agent@prequest.nl', 'it.agent', 'active', '93000000-0000-0000-0000-000000000031'),
  ('95100000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000006', null, 'hr.agent@prequest.nl', 'hr.agent', 'active', '93000000-0000-0000-0000-000000000001'),
  ('95100000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000007', null, 'facilities.amsterdam@prequest.nl', 'facilities.amsterdam', 'active', '93000000-0000-0000-0000-000000000011'),
  ('95100000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000008', null, 'facilities.denhaag@prequest.nl', 'facilities.denhaag', 'active', '93000000-0000-0000-0000-000000000021'),
  ('95100000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000009', null, 'facilities.denbosch@prequest.nl', 'facilities.denbosch', 'active', '93000000-0000-0000-0000-000000000031'),
  ('95100000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-00000000000a', null, 'cleaning.vendor@prequest.nl', 'cleaning.vendor', 'active', '93000000-0000-0000-0000-000000000011'),
  ('95100000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-00000000000b', null, 'manager.approver@prequest.nl', 'manager.approver', 'active', '93000000-0000-0000-0000-000000000013'),
  ('95100000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-00000000000c', null, 'employee.requester@prequest.nl', 'employee.requester', 'active', '93000000-0000-0000-0000-000000000022')
on conflict (id) do update set
  person_id = excluded.person_id,
  email = excluded.email,
  username = excluded.username,
  status = excluded.status,
  portal_current_location_id = excluded.portal_current_location_id,
  updated_at = now();

insert into public.user_role_assignments (tenant_id, user_id, role_id, domain_scope, location_scope, read_only_cross_domain, active)
values
  ('00000000-0000-0000-0000-000000000001', (select id from public.users where tenant_id = '00000000-0000-0000-0000-000000000001' and email = 'dev@prequest.nl'), '91000000-0000-0000-0000-000000000001', '{}', '{}', false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', '{}', '{}', false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000001', '{}', '{}', false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000002', array['fm','admin'], '{}', false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000005', '91000000-0000-0000-0000-000000000002', array['it'], '{}', false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000006', '91000000-0000-0000-0000-000000000002', array['hr'], '{}', false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000007', '91000000-0000-0000-0000-000000000002', array['fm'], array['93000000-0000-0000-0000-000000000011'], false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000008', '91000000-0000-0000-0000-000000000002', array['fm'], array['93000000-0000-0000-0000-000000000021'], false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000009', '91000000-0000-0000-0000-000000000002', array['fm'], array['93000000-0000-0000-0000-000000000031'], false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-00000000000a', '91000000-0000-0000-0000-000000000002', array['fm'], array['93000000-0000-0000-0000-000000000011'], false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-00000000000b', '91000000-0000-0000-0000-000000000003', '{}', '{}', false, true),
  ('00000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-00000000000c', '91000000-0000-0000-0000-000000000003', '{}', '{}', false, true)
on conflict do nothing;

insert into public.team_members (tenant_id, team_id, user_id)
values
  ('00000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', '95100000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000002', '95100000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000002', '95100000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000003', '95100000-0000-0000-0000-000000000006'),
  ('00000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000004', '95100000-0000-0000-0000-000000000007'),
  ('00000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000005', '95100000-0000-0000-0000-000000000008'),
  ('00000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000006', '95100000-0000-0000-0000-000000000009')
on conflict (team_id, user_id) do nothing;

insert into public.person_org_memberships (tenant_id, person_id, org_node_id, is_primary)
values
  ('00000000-0000-0000-0000-000000000001', (select id from public.persons where tenant_id = '00000000-0000-0000-0000-000000000001' and email = 'dev@prequest.nl'), '92000000-0000-0000-0000-000000000002', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000002', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000003', '92000000-0000-0000-0000-000000000002', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000004', '92000000-0000-0000-0000-000000000003', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000005', '92000000-0000-0000-0000-000000000003', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000006', '92000000-0000-0000-0000-000000000004', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000007', '92000000-0000-0000-0000-00000000000b', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000008', '92000000-0000-0000-0000-00000000000c', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000009', '92000000-0000-0000-0000-00000000000d', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-00000000000b', '92000000-0000-0000-0000-000000000006', true),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-00000000000c', '92000000-0000-0000-0000-000000000006', true)
on conflict (person_id, org_node_id) do update set
  is_primary = excluded.is_primary;

insert into public.person_location_grants (tenant_id, person_id, space_id, note)
values
  ('00000000-0000-0000-0000-000000000001', (select id from public.persons where tenant_id = '00000000-0000-0000-0000-000000000001' and email = 'dev@prequest.nl'), '93000000-0000-0000-0000-000000000001', 'Amsterdam campus'),
  ('00000000-0000-0000-0000-000000000001', (select id from public.persons where tenant_id = '00000000-0000-0000-0000-000000000001' and email = 'dev@prequest.nl'), '93000000-0000-0000-0000-000000000013', 'Singel Office'),
  ('00000000-0000-0000-0000-000000000001', (select id from public.persons where tenant_id = '00000000-0000-0000-0000-000000000001' and email = 'dev@prequest.nl'), '93000000-0000-0000-0000-000000000021', 'Den Haag Wijnhaven'),
  ('00000000-0000-0000-0000-000000000001', (select id from public.persons where tenant_id = '00000000-0000-0000-0000-000000000001' and email = 'dev@prequest.nl'), '93000000-0000-0000-0000-000000000022', 'Den Haag Spui'),
  ('00000000-0000-0000-0000-000000000001', (select id from public.persons where tenant_id = '00000000-0000-0000-0000-000000000001' and email = 'dev@prequest.nl'), '93000000-0000-0000-0000-000000000031', 'Den Bosch'),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000013', 'Service desk cross-site coverage'),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000021', 'Service desk cross-site coverage'),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000022', 'Service desk cross-site coverage'),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000031', 'Service desk cross-site coverage'),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000004', '93000000-0000-0000-0000-000000000001', 'Central IT multi-location support'),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000004', '93000000-0000-0000-0000-000000000013', 'Central IT multi-location support'),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000004', '93000000-0000-0000-0000-000000000021', 'Central IT multi-location support'),
  ('00000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000004', '93000000-0000-0000-0000-000000000022', 'Central IT multi-location support')
on conflict (person_id, space_id) do update set
  note = excluded.note;

notify pgrst, 'reload schema';
