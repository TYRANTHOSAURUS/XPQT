-- Demo catalog seed for the default tenant — realistic FMIS/ITSM taxonomy so the admin tree
-- editor and portal flow have content to demonstrate the full model.

do $$
declare
  t uuid := '00000000-0000-0000-0000-000000000001';

  -- Top-level categories
  cat_it         uuid := '10000000-0000-0000-0000-000000000001';
  cat_facilities uuid := '10000000-0000-0000-0000-000000000002';
  cat_hr         uuid := '10000000-0000-0000-0000-000000000003';
  cat_visitor    uuid := '10000000-0000-0000-0000-000000000004';

  -- Level-2 subcategories
  cat_it_hw       uuid := '20000000-0000-0000-0000-000000000001';
  cat_it_sw       uuid := '20000000-0000-0000-0000-000000000002';
  cat_it_access   uuid := '20000000-0000-0000-0000-000000000003';
  cat_fm_work     uuid := '20000000-0000-0000-0000-000000000004';
  cat_fm_clean    uuid := '20000000-0000-0000-0000-000000000005';
  cat_fm_maint    uuid := '20000000-0000-0000-0000-000000000006';

  -- Request types
  rt_laptop_new     uuid := '30000000-0000-0000-0000-000000000001';
  rt_laptop_return  uuid := '30000000-0000-0000-0000-000000000002';
  rt_monitor        uuid := '30000000-0000-0000-0000-000000000003';
  rt_peripherals    uuid := '30000000-0000-0000-0000-000000000004';
  rt_sw_license     uuid := '30000000-0000-0000-0000-000000000005';
  rt_vpn            uuid := '30000000-0000-0000-0000-000000000006';
  rt_password       uuid := '30000000-0000-0000-0000-000000000007';
  rt_access_card    uuid := '30000000-0000-0000-0000-000000000008';
  rt_parking        uuid := '30000000-0000-0000-0000-000000000009';
  rt_chair          uuid := '30000000-0000-0000-0000-00000000000a';
  rt_desk_adjust    uuid := '30000000-0000-0000-0000-00000000000b';
  rt_aircon         uuid := '30000000-0000-0000-0000-00000000000c';
  rt_spill          uuid := '30000000-0000-0000-0000-00000000000d';
  rt_deep_clean     uuid := '30000000-0000-0000-0000-00000000000e';
  rt_lighting       uuid := '30000000-0000-0000-0000-00000000000f';
  rt_plumbing       uuid := '30000000-0000-0000-0000-000000000010';
  rt_leave          uuid := '30000000-0000-0000-0000-000000000011';
  rt_letter         uuid := '30000000-0000-0000-0000-000000000012';
  rt_expense        uuid := '30000000-0000-0000-0000-000000000013';
  rt_visitor_reg    uuid := '30000000-0000-0000-0000-000000000014';
  rt_room_booking   uuid := '30000000-0000-0000-0000-000000000015';
begin
  -- Top-level categories
  insert into public.service_catalog_categories (id, tenant_id, name, description, icon, display_order, parent_category_id) values
    (cat_it,         t, 'IT',                'Hardware, software, and access requests',        'Monitor',      0, null),
    (cat_facilities, t, 'Facilities',        'Workspace, cleaning, and building maintenance',  'Wrench',       1, null),
    (cat_hr,         t, 'HR',                'Leave, letters, and people operations',          'Users',        2, null),
    (cat_visitor,    t, 'Visitor & Rooms',   'Register visitors and book meeting rooms',       'ShieldCheck',  3, null)
  on conflict (id) do nothing;

  -- Subcategories
  insert into public.service_catalog_categories (id, tenant_id, name, description, icon, display_order, parent_category_id) values
    (cat_it_hw,     t, 'Hardware',  'Laptops, monitors, peripherals',         'Package',      0, cat_it),
    (cat_it_sw,     t, 'Software',  'Licenses, VPN, passwords',               'Printer',      1, cat_it),
    (cat_it_access, t, 'Access',    'Building and parking access',            'Key',          2, cat_it),
    (cat_fm_work,   t, 'Workspace', 'Your desk, chair, and seating area',     'MapPin',       0, cat_facilities),
    (cat_fm_clean,  t, 'Cleaning',  'Spills and deep cleaning',               'Utensils',     1, cat_facilities),
    (cat_fm_maint,  t, 'Maintenance', 'Lighting, plumbing, HVAC',             'Wrench',       2, cat_facilities)
  on conflict (id) do nothing;

  -- Request types — IT › Hardware
  insert into public.request_types (id, tenant_id, name, description, icon, domain, display_order, keywords) values
    (rt_laptop_new,    t, 'Request a new laptop',    'For new hires or refresh cycle',     'FileText', 'it', 0, array['laptop','computer','new','refresh']),
    (rt_laptop_return, t, 'Return or swap laptop',   'End-of-service or broken device',    'FileText', 'it', 1, array['laptop','return','swap','broken']),
    (rt_monitor,       t, 'Request a monitor',       'Additional or replacement monitor',  'FileText', 'it', 2, array['monitor','screen','display']),
    (rt_peripherals,   t, 'Request peripherals',     'Keyboard, mouse, headset, dock',     'FileText', 'it', 3, array['keyboard','mouse','headset','dock'])
  on conflict (id) do nothing;

  -- Request types — IT › Software
  insert into public.request_types (id, tenant_id, name, description, icon, domain, display_order, keywords) values
    (rt_sw_license, t, 'New software license', 'Adobe, Figma, JetBrains, etc.',         'FileText', 'it', 0, array['software','license','adobe','figma']),
    (rt_vpn,        t, 'VPN access',           'Remote access to internal systems',     'FileText', 'it', 1, array['vpn','remote','access']),
    (rt_password,   t, 'Password reset',       'Reset account or SSO password',         'FileText', 'it', 2, array['password','reset','login','sso'])
  on conflict (id) do nothing;

  -- Request types — IT › Access
  insert into public.request_types (id, tenant_id, name, description, icon, domain, display_order, keywords) values
    (rt_access_card, t, 'Building access card', 'Request or replace access card',       'FileText', 'it', 0, array['access','card','badge','building']),
    (rt_parking,     t, 'Parking access',       'Add vehicle to parking whitelist',     'FileText', 'it', 1, array['parking','vehicle','car'])
  on conflict (id) do nothing;

  -- Request types — Facilities › Workspace
  insert into public.request_types (id, tenant_id, name, description, icon, domain, display_order, keywords) values
    (rt_chair,       t, 'Broken chair',       'Chair is damaged or uncomfortable',      'FileText', 'fm', 0, array['chair','broken','seat']),
    (rt_desk_adjust, t, 'Desk adjustment',    'Standing desk or ergonomic setup',       'FileText', 'fm', 1, array['desk','standing','ergonomic']),
    (rt_aircon,      t, 'Air-con too cold',   'Temperature or airflow issue',           'FileText', 'fm', 2, array['aircon','ac','hvac','temperature'])
  on conflict (id) do nothing;

  -- Request types — Facilities › Cleaning
  insert into public.request_types (id, tenant_id, name, description, icon, domain, display_order, keywords) values
    (rt_spill,      t, 'Spill cleanup',       'Urgent spill or mess',                    'FileText', 'fm', 0, array['spill','cleanup','urgent']),
    (rt_deep_clean, t, 'Deep cleaning',       'Request scheduled deep clean',            'FileText', 'fm', 1, array['clean','deep','scheduled'])
  on conflict (id) do nothing;

  -- Request types — Facilities › Maintenance
  insert into public.request_types (id, tenant_id, name, description, icon, domain, display_order, keywords) values
    (rt_lighting, t, 'Lighting issue',  'Bulb out or flickering',                 'FileText', 'fm', 0, array['lighting','bulb','flicker']),
    (rt_plumbing, t, 'Plumbing issue',  'Leak, blockage, or toilet issue',        'FileText', 'fm', 1, array['plumbing','leak','toilet','water'])
  on conflict (id) do nothing;

  -- Request types — directly under HR (no subcategory, demonstrates flexible placement)
  insert into public.request_types (id, tenant_id, name, description, icon, domain, display_order, keywords) values
    (rt_leave,   t, 'Leave request',         'Annual, sick, or unpaid leave',        'FileText', 'hr', 0, array['leave','vacation','sick','off']),
    (rt_letter,  t, 'Employment letter',     'Employment verification letter',       'FileText', 'hr', 1, array['letter','employment','verification']),
    (rt_expense, t, 'Expense reimbursement', 'Submit receipts for reimbursement',    'FileText', 'hr', 2, array['expense','reimbursement','receipt'])
  on conflict (id) do nothing;

  -- Request types — directly under Visitor & Rooms
  insert into public.request_types (id, tenant_id, name, description, icon, domain, display_order, keywords) values
    (rt_visitor_reg,  t, 'Register a visitor',     'Pre-register a guest for reception', 'FileText', 'visitor', 0, array['visitor','guest','register']),
    (rt_room_booking, t, 'Meeting room booking',   'Reserve a meeting room',              'FileText', 'visitor', 1, array['room','meeting','booking','reservation'])
  on conflict (id) do nothing;

  -- M2M links: request type ↔ category
  -- IT › Hardware
  insert into public.request_type_categories (tenant_id, request_type_id, category_id) values
    (t, rt_laptop_new,    cat_it_hw),
    (t, rt_laptop_return, cat_it_hw),
    (t, rt_monitor,       cat_it_hw),
    (t, rt_peripherals,   cat_it_hw)
  on conflict (request_type_id, category_id) do nothing;

  -- IT › Software
  insert into public.request_type_categories (tenant_id, request_type_id, category_id) values
    (t, rt_sw_license, cat_it_sw),
    (t, rt_vpn,        cat_it_sw),
    (t, rt_password,   cat_it_sw)
  on conflict (request_type_id, category_id) do nothing;

  -- IT › Access
  insert into public.request_type_categories (tenant_id, request_type_id, category_id) values
    (t, rt_access_card, cat_it_access),
    (t, rt_parking,     cat_it_access)
  on conflict (request_type_id, category_id) do nothing;

  -- Facilities › Workspace
  insert into public.request_type_categories (tenant_id, request_type_id, category_id) values
    (t, rt_chair,       cat_fm_work),
    (t, rt_desk_adjust, cat_fm_work),
    (t, rt_aircon,      cat_fm_work)
  on conflict (request_type_id, category_id) do nothing;

  -- Facilities › Cleaning
  insert into public.request_type_categories (tenant_id, request_type_id, category_id) values
    (t, rt_spill,      cat_fm_clean),
    (t, rt_deep_clean, cat_fm_clean)
  on conflict (request_type_id, category_id) do nothing;

  -- Facilities › Maintenance
  insert into public.request_type_categories (tenant_id, request_type_id, category_id) values
    (t, rt_lighting, cat_fm_maint),
    (t, rt_plumbing, cat_fm_maint)
  on conflict (request_type_id, category_id) do nothing;

  -- HR (leaf request types directly under the root — flexible placement)
  insert into public.request_type_categories (tenant_id, request_type_id, category_id) values
    (t, rt_leave,   cat_hr),
    (t, rt_letter,  cat_hr),
    (t, rt_expense, cat_hr)
  on conflict (request_type_id, category_id) do nothing;

  -- Visitor & Rooms (same — leaves directly under root)
  insert into public.request_type_categories (tenant_id, request_type_id, category_id) values
    (t, rt_visitor_reg,  cat_visitor),
    (t, rt_room_booking, cat_visitor)
  on conflict (request_type_id, category_id) do nothing;

  -- Bonus: demonstrate M2M (one request type in multiple categories).
  -- A laptop request also belongs under HR's onboarding flow — common in real tenants.
  insert into public.request_type_categories (tenant_id, request_type_id, category_id) values
    (t, rt_laptop_new, cat_hr)
  on conflict (request_type_id, category_id) do nothing;
end $$;
