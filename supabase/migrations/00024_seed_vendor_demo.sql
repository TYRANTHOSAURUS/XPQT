-- Demo seed for vendors + menus. Shows the "cola is $2 in Amsterdam but $3 in Rotterdam"
-- pattern plus a building-specific vendor override and multi-service vendor coverage.

do $$
declare
  t uuid := '00000000-0000-0000-0000-000000000001';

  -- Buildings
  bld_ams uuid := '40000000-0000-0000-0000-000000000001'; -- Amsterdam HQ
  bld_rtm uuid := '40000000-0000-0000-0000-000000000002'; -- Rotterdam Office
  bld_ein uuid := '40000000-0000-0000-0000-000000000003'; -- Eindhoven Lab

  -- Internal owning teams
  tm_fm_ops       uuid := '41000000-0000-0000-0000-000000000001';
  tm_catering_ops uuid := '41000000-0000-0000-0000-000000000002';
  tm_av_ops       uuid := '41000000-0000-0000-0000-000000000003';

  -- Catalog items (products)
  ci_cola      uuid := '42000000-0000-0000-0000-000000000001';
  ci_water     uuid := '42000000-0000-0000-0000-000000000002';
  ci_capp      uuid := '42000000-0000-0000-0000-000000000003';
  ci_pastry    uuid := '42000000-0000-0000-0000-000000000004';
  ci_blt       uuid := '42000000-0000-0000-0000-000000000005';
  ci_wrap      uuid := '42000000-0000-0000-0000-000000000006';
  ci_fruit     uuid := '42000000-0000-0000-0000-000000000007';
  ci_projector uuid := '42000000-0000-0000-0000-000000000008';
  ci_mic       uuid := '42000000-0000-0000-0000-000000000009';
  ci_clicker   uuid := '42000000-0000-0000-0000-00000000000a';
  ci_speaker   uuid := '42000000-0000-0000-0000-00000000000b';

  -- Vendors
  v_compass uuid := '43000000-0000-0000-0000-000000000001';
  v_crave   uuid := '43000000-0000-0000-0000-000000000002';
  v_sharp   uuid := '43000000-0000-0000-0000-000000000003';

  -- Menus
  m_compass_default uuid := '44000000-0000-0000-0000-000000000001'; -- Spring 2026, all buildings
  m_compass_rtm     uuid := '44000000-0000-0000-0000-000000000002'; -- Spring 2026, Rotterdam-specific
  m_compass_autumn  uuid := '44000000-0000-0000-0000-000000000003'; -- Archived
  m_crave_av        uuid := '44000000-0000-0000-0000-000000000004'; -- 2026 AV rental
  m_sharp_ein       uuid := '44000000-0000-0000-0000-000000000005'; -- Eindhoven-only vendor
begin
  -----------------------------------------------------------------------------
  -- Buildings
  -----------------------------------------------------------------------------
  insert into public.spaces (id, tenant_id, parent_id, type, code, name, active) values
    (bld_ams, t, null, 'building', 'AMS', 'Amsterdam HQ',     true),
    (bld_rtm, t, null, 'building', 'RTM', 'Rotterdam Office', true),
    (bld_ein, t, null, 'building', 'EIN', 'Eindhoven Lab',    true)
  on conflict (id) do nothing;

  -----------------------------------------------------------------------------
  -- Internal owning teams
  -----------------------------------------------------------------------------
  insert into public.teams (id, tenant_id, name, domain_scope, active) values
    (tm_fm_ops,       t, 'FM Operations',        'fm',       true),
    (tm_catering_ops, t, 'Catering Operations',  'catering', true),
    (tm_av_ops,       t, 'AV Operations',        'fm',       true)
  on conflict (id) do nothing;

  -----------------------------------------------------------------------------
  -- Catalog items (the products — name, image, unit; price lives on menu_items)
  -----------------------------------------------------------------------------
  insert into public.catalog_items (id, tenant_id, name, description, category, subcategory, unit, active) values
    (ci_cola,      t, 'Can of Cola',          '330ml chilled can',                    'food_and_drinks', 'beverages', 'per_item',   true),
    (ci_water,     t, 'Bottled Water',        '500ml still or sparkling',             'food_and_drinks', 'beverages', 'per_item',   true),
    (ci_capp,      t, 'Cappuccino',           'Fresh barista-made',                   'food_and_drinks', 'beverages', 'per_item',   true),
    (ci_pastry,    t, 'Pastry Box (12 pcs)',  'Assorted morning pastries',            'food_and_drinks', 'breakfast', 'flat_rate',  true),
    (ci_blt,       t, 'BLT Sandwich',         'Bacon, lettuce, tomato on sourdough',  'food_and_drinks', 'lunch',     'per_item',   true),
    (ci_wrap,      t, 'Veggie Wrap',          'Hummus, grilled veg, spinach',         'food_and_drinks', 'lunch',     'per_item',   true),
    (ci_fruit,     t, 'Fruit Platter (S)',    'Seasonal fruit, serves ~10',           'food_and_drinks', 'snacks',    'flat_rate',  true),
    (ci_projector, t, 'Projector Rental',     '4K HDMI projector, full-day',          'equipment',       null,        'flat_rate',  true),
    (ci_mic,       t, 'Wireless Microphone',  'Handheld, includes receiver',          'equipment',       null,        'per_item',   true),
    (ci_clicker,   t, 'Presentation Clicker', 'Laser pointer + slide advance',        'equipment',       null,        'per_item',   true),
    (ci_speaker,   t, 'Portable Speaker',     'Bluetooth + aux, includes mic in',     'equipment',       null,        'flat_rate',  true)
  on conflict (id) do nothing;

  -----------------------------------------------------------------------------
  -- Vendors
  -----------------------------------------------------------------------------
  insert into public.vendors (id, tenant_id, name, contact_email, contact_phone, website, notes, owning_team_id, active) values
    (v_compass, t, 'Compass Catering',   'orders@compass.example',    '+31 20 555 0101', 'https://compass.example',
      'Primary catering partner for AMS and RTM. Weekly menu rotation.',
      tm_catering_ops, true),
    (v_crave,   t, 'Crave AV Rentals',   'rentals@craveav.example',   '+31 10 555 0202', 'https://craveav.example',
      'AV equipment rental across all buildings. 24h lead time standard.',
      tm_av_ops, true),
    (v_sharp,   t, 'Sharp Bites',        'hello@sharpbites.example',  '+31 40 555 0303', null,
      'Eindhoven-only caterer. Local sourcing, fast turnaround.',
      tm_catering_ops, true)
  on conflict (id) do nothing;

  -----------------------------------------------------------------------------
  -- Vendor service areas
  -----------------------------------------------------------------------------
  -- Compass: catering in AMS + RTM
  insert into public.vendor_service_areas (tenant_id, vendor_id, space_id, service_type, default_priority, active) values
    (t, v_compass, bld_ams, 'catering',     100, true),
    (t, v_compass, bld_rtm, 'catering',     100, true),
    -- Crave: AV in all three
    (t, v_crave,   bld_ams, 'av_equipment', 100, true),
    (t, v_crave,   bld_rtm, 'av_equipment', 100, true),
    (t, v_crave,   bld_ein, 'av_equipment', 100, true),
    -- Sharp Bites: catering only in EIN
    (t, v_sharp,   bld_ein, 'catering',     100, true)
  on conflict (vendor_id, space_id, service_type) do nothing;

  -----------------------------------------------------------------------------
  -- Menus
  -----------------------------------------------------------------------------
  insert into public.catalog_menus (id, tenant_id, vendor_id, space_id, service_type, name, description, effective_from, effective_until, status) values
    -- Compass default menu (applies to every building Compass serves)
    (m_compass_default, t, v_compass, null,    'catering',     'Spring 2026 Lunch',            'Seasonal lunch items — vendor default pricing across all buildings served.', '2026-03-01', '2026-05-31', 'published'),
    -- Compass Rotterdam-specific override: same items, higher prices (the "cola differs by building" case)
    (m_compass_rtm,     t, v_compass, bld_rtm, 'catering',     'Spring 2026 Lunch — Rotterdam', 'Rotterdam surcharge: different kitchen + delivery cost.',                     '2026-03-01', '2026-05-31', 'published'),
    -- Archived prior season (shows lifecycle)
    (m_compass_autumn,  t, v_compass, null,    'catering',     'Autumn 2025 Lunch',            'Prior season — kept for reporting.',                                         '2025-09-01', '2025-11-30', 'archived'),
    -- Crave AV rental sheet (all buildings)
    (m_crave_av,        t, v_crave,   null,    'av_equipment', '2026 AV Rental Sheet',         'Standard AV rental pricing for all three buildings.',                        '2026-01-01', null,         'published'),
    -- Sharp Bites Eindhoven-only catering
    (m_sharp_ein,       t, v_sharp,   bld_ein, 'catering',     'Eindhoven Daily Menu',         'Local caterer for Eindhoven Lab only.',                                      '2026-01-01', null,         'published')
  on conflict (id) do nothing;

  -----------------------------------------------------------------------------
  -- Menu items (the priced offerings)
  -----------------------------------------------------------------------------
  -- Compass default (AMS + RTM default pricing)
  insert into public.menu_items (menu_id, tenant_id, catalog_item_id, price, unit, lead_time_hours, active) values
    (m_compass_default, t, ci_cola,   2.00,  'per_item',  24, true),
    (m_compass_default, t, ci_water,  1.75,  'per_item',  24, true),
    (m_compass_default, t, ci_capp,   3.50,  'per_item',  24, true),
    (m_compass_default, t, ci_pastry, 28.00, 'flat_rate', 48, true),
    (m_compass_default, t, ci_blt,    6.50,  'per_item',  48, true),
    (m_compass_default, t, ci_wrap,   6.50,  'per_item',  48, true),
    (m_compass_default, t, ci_fruit,  32.00, 'flat_rate', 48, true)
  on conflict (menu_id, catalog_item_id) do nothing;

  -- Compass Rotterdam override — notable: cola is +$1, sandwiches are +$1, water +$0.50
  insert into public.menu_items (menu_id, tenant_id, catalog_item_id, price, unit, lead_time_hours, active) values
    (m_compass_rtm, t, ci_cola,   3.00,  'per_item',  24, true),
    (m_compass_rtm, t, ci_water,  2.25,  'per_item',  24, true),
    (m_compass_rtm, t, ci_capp,   4.00,  'per_item',  24, true),
    (m_compass_rtm, t, ci_pastry, 32.00, 'flat_rate', 48, true),
    (m_compass_rtm, t, ci_blt,    7.50,  'per_item',  48, true),
    (m_compass_rtm, t, ci_wrap,   7.50,  'per_item',  48, true)
  on conflict (menu_id, catalog_item_id) do nothing;

  -- Compass Autumn 2025 (archived — historical reference)
  insert into public.menu_items (menu_id, tenant_id, catalog_item_id, price, unit, lead_time_hours, active) values
    (m_compass_autumn, t, ci_cola,   1.80, 'per_item',  24, true),
    (m_compass_autumn, t, ci_capp,   3.20, 'per_item',  24, true),
    (m_compass_autumn, t, ci_blt,    6.00, 'per_item',  48, true)
  on conflict (menu_id, catalog_item_id) do nothing;

  -- Crave AV rental
  insert into public.menu_items (menu_id, tenant_id, catalog_item_id, price, unit, lead_time_hours, active) values
    (m_crave_av, t, ci_projector, 75.00, 'flat_rate', 24, true),
    (m_crave_av, t, ci_mic,       15.00, 'per_item',  24, true),
    (m_crave_av, t, ci_clicker,    8.00, 'per_item',  24, true),
    (m_crave_av, t, ci_speaker,   45.00, 'flat_rate', 24, true)
  on conflict (menu_id, catalog_item_id) do nothing;

  -- Sharp Bites Eindhoven menu (different caterer for Building EIN)
  insert into public.menu_items (menu_id, tenant_id, catalog_item_id, price, unit, lead_time_hours, active) values
    (m_sharp_ein, t, ci_cola,   2.25,  'per_item',  12, true),
    (m_sharp_ein, t, ci_water,  1.50,  'per_item',  12, true),
    (m_sharp_ein, t, ci_capp,   3.75,  'per_item',  12, true),
    (m_sharp_ein, t, ci_blt,    6.00,  'per_item',  24, true),
    (m_sharp_ein, t, ci_fruit,  28.00, 'flat_rate', 24, true)
  on conflict (menu_id, catalog_item_id) do nothing;
end $$;
