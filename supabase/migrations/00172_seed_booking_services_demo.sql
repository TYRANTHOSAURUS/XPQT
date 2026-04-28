-- Booking-services demo seed for the centralised example tenant.
--
-- Existing 00024 demo tied vendors to building UUIDs at 40000000-... but the
-- centralised example (00102 + 00104) uses 93000000-... for its real
-- buildings. Result: testing the booking flow on those buildings yields
-- empty service-picker tabs because the resolver finds no menu offers.
--
-- This migration adds:
--   - One internal AV team's catalog items (no vendor — fulfilled by team)
--   - Two new vendors: Compass Catering Central, Setup Crew
--   - Catalog items for catering / AV / room setup (services category)
--   - vendor_service_areas covering all six centralised buildings
--   - catalog_menus + menu_items with realistic Benelux-EUR pricing and
--     short lead times (0–2h) so same-day bookings actually return items
--
-- Idempotent on UUID — re-applying is safe.

do $$
declare
  t uuid := '00000000-0000-0000-0000-000000000001';

  -- Centralised buildings (per 00102_seed_centralised_example_foundation.sql)
  ams_a uuid := '93000000-0000-0000-0000-000000000011'; -- Atlas House
  ams_b uuid := '93000000-0000-0000-0000-000000000012'; -- Canal Court
  ams_c uuid := '93000000-0000-0000-0000-000000000013'; -- Singel Office
  dhg_a uuid := '93000000-0000-0000-0000-000000000021'; -- Wijnhaven Office
  dhg_b uuid := '93000000-0000-0000-0000-000000000022'; -- Spui Center
  dbh_a uuid := '93000000-0000-0000-0000-000000000031'; -- Pettelaar Park

  -- Internal owning teams (created in 00024 — re-upsert here is a no-op)
  tm_catering_ops uuid := '41000000-0000-0000-0000-000000000002';
  tm_av_ops       uuid := '41000000-0000-0000-0000-000000000003';

  -- New vendors for the centralised set (separate from 00024's 43xxx range)
  v_compass_central uuid := '45000000-0000-0000-0000-000000000001';
  v_setup_crew      uuid := '45000000-0000-0000-0000-000000000002';
  v_av_internal     uuid := '45000000-0000-0000-0000-000000000003';

  -- Alias for the existing AV team
  tm_av_internal uuid := '41000000-0000-0000-0000-000000000003';

  -- ── Catalog items ─────────────────────────────────────────────────────
  -- Catering (food_and_drinks)
  ci_coffee     uuid := '46000000-0000-0000-0000-000000000001';
  ci_tea        uuid := '46000000-0000-0000-0000-000000000002';
  ci_pastry_box uuid := '46000000-0000-0000-0000-000000000003';
  ci_sandwich   uuid := '46000000-0000-0000-0000-000000000004';
  ci_lunchbowl  uuid := '46000000-0000-0000-0000-000000000005';
  ci_fruit      uuid := '46000000-0000-0000-0000-000000000006';
  ci_water_still   uuid := '46000000-0000-0000-0000-000000000007';
  ci_water_sparkling uuid := '46000000-0000-0000-0000-000000000008';
  ci_juice      uuid := '46000000-0000-0000-0000-000000000009';

  -- AV (equipment)
  ci_projector  uuid := '47000000-0000-0000-0000-000000000001';
  ci_mic_set    uuid := '47000000-0000-0000-0000-000000000002';
  ci_camera     uuid := '47000000-0000-0000-0000-000000000003';
  ci_speakers   uuid := '47000000-0000-0000-0000-000000000004';
  ci_screen     uuid := '47000000-0000-0000-0000-000000000005';

  -- Room setup (services)
  ci_layout_u       uuid := '48000000-0000-0000-0000-000000000001';
  ci_layout_theatre uuid := '48000000-0000-0000-0000-000000000002';
  ci_layout_board   uuid := '48000000-0000-0000-0000-000000000003';
  ci_signage        uuid := '48000000-0000-0000-0000-000000000004';
  ci_flipchart      uuid := '48000000-0000-0000-0000-000000000005';
  ci_whiteboard     uuid := '48000000-0000-0000-0000-000000000006';

  -- ── Menus ─────────────────────────────────────────────────────────────
  m_compass_central uuid := '49000000-0000-0000-0000-000000000001';
  m_av_internal     uuid := '49000000-0000-0000-0000-000000000002';
  m_setup_crew      uuid := '49000000-0000-0000-0000-000000000003';
begin
  -- ── Internal teams (idempotent re-upsert in case 00024 was wiped) ────
  insert into public.teams (id, tenant_id, name, domain_scope, active) values
    (tm_catering_ops, t, 'Catering Operations', 'catering', true),
    (tm_av_internal,  t, 'AV Operations',       'fm',       true)
  on conflict (id) do nothing;

  -- ── Vendors ──────────────────────────────────────────────────────────
  insert into public.vendors (id, tenant_id, name, contact_email, contact_phone, website, notes, owning_team_id, active) values
    (v_compass_central, t, 'Compass Catering',
      'orders@compass.example', '+31 20 555 0150',
      'https://compass.example',
      'Catering partner for all Atlas, Canal, Singel, Wijnhaven, Spui, and Pettelaar locations. Same-day capable up to 2h lead time.',
      tm_catering_ops, true),
    (v_setup_crew, t, 'Setup Crew',
      'ops@setupcrew.example', '+31 20 555 0160',
      null,
      'In-house event setup team (FM workplace ops). Layouts, signage, flipcharts.',
      null, true),
    (v_av_internal, t, 'AV Operations',
      'av-ops@internal',
      null, null,
      'Internal AV team. Self-fulfilling — projectors, mics, cameras kept on inventory.',
      tm_av_internal, true)
  on conflict (id) do nothing;

  -- ── Vendor service areas ─────────────────────────────────────────────
  insert into public.vendor_service_areas (tenant_id, vendor_id, space_id, service_type, default_priority, active) values
    -- Compass: catering across every centralised building
    (t, v_compass_central, ams_a, 'catering', 100, true),
    (t, v_compass_central, ams_b, 'catering', 100, true),
    (t, v_compass_central, ams_c, 'catering', 100, true),
    (t, v_compass_central, dhg_a, 'catering', 100, true),
    (t, v_compass_central, dhg_b, 'catering', 100, true),
    (t, v_compass_central, dbh_a, 'catering', 100, true),
    -- Setup Crew: facilities_services across every centralised building
    (t, v_setup_crew, ams_a, 'facilities_services', 100, true),
    (t, v_setup_crew, ams_b, 'facilities_services', 100, true),
    (t, v_setup_crew, ams_c, 'facilities_services', 100, true),
    (t, v_setup_crew, dhg_a, 'facilities_services', 100, true),
    (t, v_setup_crew, dhg_b, 'facilities_services', 100, true),
    (t, v_setup_crew, dbh_a, 'facilities_services', 100, true),
    -- Internal AV team: av_equipment across every centralised building
    (t, v_av_internal, ams_a, 'av_equipment', 100, true),
    (t, v_av_internal, ams_b, 'av_equipment', 100, true),
    (t, v_av_internal, ams_c, 'av_equipment', 100, true),
    (t, v_av_internal, dhg_a, 'av_equipment', 100, true),
    (t, v_av_internal, dhg_b, 'av_equipment', 100, true),
    (t, v_av_internal, dbh_a, 'av_equipment', 100, true)
  on conflict (vendor_id, space_id, service_type) do nothing;

  -- ── Catalog items ────────────────────────────────────────────────────
  -- Catering
  insert into public.catalog_items (id, tenant_id, name, description, category, subcategory, unit, lead_time_hours, dietary_tags, image_url, fulfillment_team_id, active) values
    (ci_coffee,           t, 'Coffee carafe',         'Fresh-brewed coffee, ~10 cups per carafe',           'food_and_drinks', 'beverages', 'flat_rate', 1, '{vegan}',                     null, tm_catering_ops, true),
    (ci_tea,              t, 'Tea selection',         'Assorted English Breakfast, Earl Grey, herbal',      'food_and_drinks', 'beverages', 'flat_rate', 1, '{vegan,caffeine_free_option}', null, tm_catering_ops, true),
    (ci_water_still,      t, 'Still water',           '500ml glass bottles',                                'food_and_drinks', 'beverages', 'per_item',  1, '{vegan}',                     null, tm_catering_ops, true),
    (ci_water_sparkling,  t, 'Sparkling water',       '500ml glass bottles',                                'food_and_drinks', 'beverages', 'per_item',  1, '{vegan}',                     null, tm_catering_ops, true),
    (ci_juice,            t, 'Fresh juice',           'Orange or apple, 250ml',                             'food_and_drinks', 'beverages', 'per_item',  1, '{vegan,gluten_free}',         null, tm_catering_ops, true),
    (ci_pastry_box,       t, 'Pastry box',            '12 pastries — croissants, danishes, fruit muffins',  'food_and_drinks', 'breakfast', 'flat_rate', 2, '{contains_gluten,contains_dairy}', null, tm_catering_ops, true),
    (ci_sandwich,         t, 'Sandwich platter',      '20-piece selection: BLT, caprese, chicken-pesto, falafel',
                                                                                                            'food_and_drinks', 'lunch',     'flat_rate', 2, '{vegetarian_option,vegan_option,gluten_free_option}', null, tm_catering_ops, true),
    (ci_lunchbowl,        t, 'Lunch bowl',            'Grain bowl with greens, protein, dressing',          'food_and_drinks', 'lunch',     'per_item',  2, '{vegan_option,gluten_free_option}', null, tm_catering_ops, true),
    (ci_fruit,            t, 'Fruit platter',         'Seasonal sliced fruit, serves ~10',                  'food_and_drinks', 'snacks',    'flat_rate', 1, '{vegan,gluten_free}',         null, tm_catering_ops, true)
  on conflict (id) do nothing;

  -- AV
  insert into public.catalog_items (id, tenant_id, name, description, category, subcategory, unit, lead_time_hours, image_url, fulfillment_team_id, active) values
    (ci_projector, t, 'Projector + screen',     '4K HDMI/USB-C, includes projection screen',  'equipment', null, 'flat_rate', 1, null, tm_av_internal, true),
    (ci_mic_set,   t, 'Wireless microphone set', '2 handheld + 1 lavalier, includes receiver',                  'equipment', null, 'flat_rate', 1, null, tm_av_internal, true),
    (ci_camera,    t, 'Conference camera',       'PTZ camera, USB plug-and-play, suits hybrid meetings',         'equipment', null, 'flat_rate', 1, null, tm_av_internal, true),
    (ci_speakers,  t, 'Portable speakers',       'Bluetooth + 3.5mm aux, fills medium room',                     'equipment', null, 'flat_rate', 1, null, tm_av_internal, true),
    (ci_screen,    t, 'Mobile presentation screen', '85" rolling display, HDMI / wireless cast',                'equipment', null, 'flat_rate', 1, null, tm_av_internal, true)
  on conflict (id) do nothing;

  -- Room setup (services category — picker tab "Setup")
  insert into public.catalog_items (id, tenant_id, name, description, category, subcategory, unit, lead_time_hours, image_url, active) values
    (ci_layout_u,        t, 'U-shape layout',         'Tables in a U with chairs around outside',                   'services', 'layout', 'flat_rate', 2, null, true),
    (ci_layout_theatre,  t, 'Theatre layout',         'Rows of chairs facing front, no tables',                     'services', 'layout', 'flat_rate', 2, null, true),
    (ci_layout_board,    t, 'Boardroom layout',       'Single long table, chairs around all sides',                 'services', 'layout', 'flat_rate', 2, null, true),
    (ci_signage,         t, 'Welcome signage',        'Branded signs at lobby and door — name + meeting title',     'services', 'signage','flat_rate', 2, null, true),
    (ci_flipchart,       t, 'Flipchart + easel',      'Standard A1 flipchart pad on metal easel, includes markers', 'services', 'tools',  'per_item',  1, null, true),
    (ci_whiteboard,      t, 'Mobile whiteboard',      '180×120cm rolling whiteboard with eraser + marker set',      'services', 'tools',  'per_item',  1, null, true)
  on conflict (id) do nothing;

  -- ── Menus ────────────────────────────────────────────────────────────
  insert into public.catalog_menus (id, tenant_id, vendor_id, space_id, service_type, name, description, effective_from, effective_until, status) values
    (m_compass_central, t, v_compass_central, null, 'catering',
      'Compass — Spring 2026',
      'Default catering menu across all centralised buildings. Lead time 1–2h.',
      '2026-01-01', '2026-12-31', 'published'),
    (m_av_internal,     t, v_av_internal,     null, 'av_equipment',
      'AV Operations — internal',
      'Internal AV team self-service. No charge — fulfilled from inventory.',
      '2026-01-01', null, 'published'),
    (m_setup_crew,      t, v_setup_crew,      null, 'facilities_services',
      'Setup Crew — Standard',
      'Layouts, signage, flipcharts. Lead time 1–2h.',
      '2026-01-01', null, 'published')
  on conflict (id) do nothing;

  -- ── Menu items (the priced offerings) ────────────────────────────────
  -- Compass Catering
  insert into public.menu_items (menu_id, tenant_id, catalog_item_id, price, unit, lead_time_hours, active) values
    (m_compass_central, t, ci_coffee,           18.00, 'flat_rate', 1, true),
    (m_compass_central, t, ci_tea,              16.00, 'flat_rate', 1, true),
    (m_compass_central, t, ci_water_still,       2.50, 'per_item',  1, true),
    (m_compass_central, t, ci_water_sparkling,   2.50, 'per_item',  1, true),
    (m_compass_central, t, ci_juice,             3.50, 'per_item',  1, true),
    (m_compass_central, t, ci_pastry_box,       28.00, 'flat_rate', 2, true),
    (m_compass_central, t, ci_sandwich,         85.00, 'flat_rate', 2, true),
    (m_compass_central, t, ci_lunchbowl,        14.50, 'per_item',  2, true),
    (m_compass_central, t, ci_fruit,            32.00, 'flat_rate', 1, true)
  on conflict (menu_id, catalog_item_id) do nothing;

  -- AV (internal — zero cost, short lead times)
  insert into public.menu_items (menu_id, tenant_id, catalog_item_id, price, unit, lead_time_hours, active) values
    (m_av_internal, t, ci_projector,  0.00, 'flat_rate', 1, true),
    (m_av_internal, t, ci_mic_set,    0.00, 'flat_rate', 1, true),
    (m_av_internal, t, ci_camera,     0.00, 'flat_rate', 1, true),
    (m_av_internal, t, ci_speakers,   0.00, 'flat_rate', 1, true),
    (m_av_internal, t, ci_screen,     0.00, 'flat_rate', 1, true)
  on conflict (menu_id, catalog_item_id) do nothing;

  -- Setup Crew (room layouts + signage + tools)
  insert into public.menu_items (menu_id, tenant_id, catalog_item_id, price, unit, lead_time_hours, active) values
    (m_setup_crew, t, ci_layout_u,         45.00, 'flat_rate', 2, true),
    (m_setup_crew, t, ci_layout_theatre,   35.00, 'flat_rate', 2, true),
    (m_setup_crew, t, ci_layout_board,     25.00, 'flat_rate', 2, true),
    (m_setup_crew, t, ci_signage,          20.00, 'flat_rate', 2, true),
    (m_setup_crew, t, ci_flipchart,         8.00, 'per_item',  1, true),
    (m_setup_crew, t, ci_whiteboard,       12.00, 'per_item',  1, true)
  on conflict (menu_id, catalog_item_id) do nothing;
end $$;

notify pgrst, 'reload schema';
