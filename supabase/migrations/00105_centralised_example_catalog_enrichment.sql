-- 00105_centralised_example_catalog_enrichment.sql
-- Forward upgrade for the already-seeded TSS demo tenant. Fixes thin portal
-- catalog copy and expands the request type set without requiring a full reset.

do $$
declare
  t constant uuid := '00000000-0000-0000-0000-000000000001';
begin
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
    ('b1000000-0000-0000-0000-00000000001d', t, 'Email & Calendar Issue', 'Use this when Outlook, shared mailboxes, meeting invites, or calendar booking behavior is broken and you need IT support to restore normal communication.', 'mail', array['email','outlook','calendar','meeting invite'], 109, null, null, 'self_only', 'software', 'a5000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
    ('b1000000-0000-0000-0000-00000000001e', t, 'Mobile Device Issue', 'Report a business mobile phone or tablet that is damaged, locked, not syncing, or otherwise preventing you from working effectively.', 'smartphone', array['mobile','phone','tablet','sync'], 110, null, null, 'self_only', 'hardware', 'a5000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
    ('b1000000-0000-0000-0000-00000000001f', t, 'Software Access Change', 'Request a role change, elevated access, or removal of access in an approved business application for yourself or a team member.', 'shield-plus', array['access','software access','role change','permissions'], 204, null, null, 'direct_reports', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
    ('b1000000-0000-0000-0000-000000000020', t, 'Shared Mailbox Request', 'Request a new shared mailbox, membership change, or delegated access so a team inbox can be managed properly.', 'mailbox', array['shared mailbox','mailbox','outlook','delegation'], 205, null, null, 'direct_reports', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
    ('b1000000-0000-0000-0000-000000000021', t, 'Distribution List Request', 'Request a new mailing list, ownership update, or membership change for a department, project, or leadership communication group.', 'list', array['distribution list','mailing list','group email','membership'], 206, null, null, 'direct_reports', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
    ('b1000000-0000-0000-0000-000000000022', t, 'VPN Access Request', 'Request secure remote access for someone who needs VPN connectivity to reach internal systems from outside the office.', 'lock-keyhole', array['vpn','remote access','secure access','network access'], 207, null, null, 'direct_reports', 'identity', 'a5000000-0000-0000-0000-000000000003', 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
    ('b1000000-0000-0000-0000-000000000023', t, 'Furniture Request', 'Request new or replacement office furniture such as desks, chairs, storage, or meeting-room pieces for an approved workplace change.', 'sofa', array['furniture','desk','chair','workspace'], 303, null, null, 'direct_reports', 'workplace', 'a5000000-0000-0000-0000-000000000004', 'a3000000-0000-0000-0000-000000000005', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, true, null, '95000000-0000-0000-0000-00000000000b'),
    ('b1000000-0000-0000-0000-000000000024', t, 'Waste & Recycling Pickup', 'Request an extra waste, cardboard, or recycling pickup for a room, floor, or project area that cannot wait for the normal round.', 'trash-2', array['waste','recycling','pickup','cardboard'], 404, null, null, 'self_only', 'cleaning', 'a5000000-0000-0000-0000-000000000005', 'a3000000-0000-0000-0000-000000000001', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
    ('b1000000-0000-0000-0000-000000000025', t, 'Room Temperature Complaint', 'Use this when a room or floor is too hot, too cold, or has unstable temperature control that is affecting normal work.', 'thermometer', array['temperature','too hot','too cold','climate'], 506, null, null, 'self_only', 'hvac', 'a5000000-0000-0000-0000-000000000007', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
    ('b1000000-0000-0000-0000-000000000026', t, 'Power / Outlet Issue', 'Report dead sockets, unsafe power points, loose electrical fittings, or local power problems in an office or meeting space.', 'plug-zap', array['power','socket','outlet','electrical'], 507, null, null, 'self_only', 'electrical', 'a5000000-0000-0000-0000-000000000008', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
    ('b1000000-0000-0000-0000-000000000027', t, 'Lock / Key Issue', 'Report a faulty lock, broken key, jammed cylinder, or local door-security issue that needs facilities or specialist support.', 'key-square', array['lock','key','door lock','security'], 208, null, null, 'self_only', 'access_control', 'a5000000-0000-0000-0000-00000000000a', 'a3000000-0000-0000-0000-000000000002', true, 'location', false, false, '{}'::uuid[], true, true, 'building', null, null, false, null, null),
    ('b1000000-0000-0000-0000-000000000028', t, 'Payroll Question', 'Ask HR for help with payroll timing, missing payments, corrections, or understanding a payslip-related issue.', 'banknote', array['payroll','salary','payslip','payment'], 704, null, null, 'self_only', 'hr', 'a5000000-0000-0000-0000-00000000000c', 'a3000000-0000-0000-0000-000000000004', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
    ('b1000000-0000-0000-0000-000000000029', t, 'Employee Data Change', 'Request an update to employee master data such as address, legal name, emergency contact, or another HR profile attribute.', 'id-card', array['employee data','profile change','address change','hr record'], 705, null, null, 'self_only', 'hr', 'a5000000-0000-0000-0000-00000000000c', 'a3000000-0000-0000-0000-000000000004', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
    ('b1000000-0000-0000-0000-00000000002a', t, 'HR Policy Question', 'Ask for clarification on leave, travel, conduct, or another HR policy when you need an answer from the people team.', 'book-open-text', array['policy','hr policy','people policy','guidance'], 706, null, null, 'self_only', 'hr', 'a5000000-0000-0000-0000-00000000000c', 'a3000000-0000-0000-0000-000000000004', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
    ('b1000000-0000-0000-0000-00000000002b', t, 'Invoice / Supplier Payment Question', 'Ask for help with invoice status, missing supplier payment, coding questions, or another accounts-payable administration issue.', 'file-invoice', array['invoice','supplier payment','accounts payable','finance'], 803, null, null, 'self_only', 'admin', null, 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null),
    ('b1000000-0000-0000-0000-00000000002c', t, 'Travel Expense Issue', 'Report a problem with a submitted travel claim, missing reimbursement, or supporting documentation for a business trip.', 'plane', array['travel expense','claim','reimbursement','trip'], 804, null, null, 'self_only', 'admin', null, 'a3000000-0000-0000-0000-000000000001', true, 'fixed', false, false, '{}'::uuid[], false, false, null, null, null, false, null, null)
  on conflict (id) do update set
    name = excluded.name,
    description = excluded.description,
    icon = excluded.icon,
    keywords = excluded.keywords,
    display_order = excluded.display_order,
    on_behalf_policy = excluded.on_behalf_policy,
    domain = excluded.domain,
    workflow_definition_id = excluded.workflow_definition_id,
    sla_policy_id = excluded.sla_policy_id,
    active = excluded.active,
    fulfillment_strategy = excluded.fulfillment_strategy,
    requires_asset = excluded.requires_asset,
    asset_required = excluded.asset_required,
    asset_type_filter = excluded.asset_type_filter,
    requires_location = excluded.requires_location,
    location_required = excluded.location_required,
    location_granularity = excluded.location_granularity,
    default_team_id = excluded.default_team_id,
    default_vendor_id = excluded.default_vendor_id,
    requires_approval = excluded.requires_approval,
    approval_approver_team_id = excluded.approval_approver_team_id,
    approval_approver_person_id = excluded.approval_approver_person_id,
    updated_at = now();

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
    and rt.tenant_id = t;

  update public.request_types rt
  set domain_id = d.id
  from public.domains d
  where rt.tenant_id = t
    and d.tenant_id = t
    and d.key = rt.domain;

  insert into public.request_type_categories (tenant_id, request_type_id, category_id)
  values
    (t, 'b1000000-0000-0000-0000-00000000001d', 'a1110000-0000-0000-0000-000000000001'),
    (t, 'b1000000-0000-0000-0000-00000000001e', 'a1110000-0000-0000-0000-000000000001'),
    (t, 'b1000000-0000-0000-0000-00000000001f', 'a1110000-0000-0000-0000-000000000002'),
    (t, 'b1000000-0000-0000-0000-000000000020', 'a1110000-0000-0000-0000-000000000002'),
    (t, 'b1000000-0000-0000-0000-000000000021', 'a1110000-0000-0000-0000-000000000002'),
    (t, 'b1000000-0000-0000-0000-000000000022', 'a1110000-0000-0000-0000-000000000002'),
    (t, 'b1000000-0000-0000-0000-000000000023', 'a1110000-0000-0000-0000-000000000003'),
    (t, 'b1000000-0000-0000-0000-000000000024', 'a1110000-0000-0000-0000-000000000004'),
    (t, 'b1000000-0000-0000-0000-000000000025', 'a1110000-0000-0000-0000-000000000005'),
    (t, 'b1000000-0000-0000-0000-000000000026', 'a1110000-0000-0000-0000-000000000005'),
    (t, 'b1000000-0000-0000-0000-000000000027', 'a1110000-0000-0000-0000-000000000002'),
    (t, 'b1000000-0000-0000-0000-000000000028', 'a1110000-0000-0000-0000-000000000007'),
    (t, 'b1000000-0000-0000-0000-000000000029', 'a1110000-0000-0000-0000-000000000007'),
    (t, 'b1000000-0000-0000-0000-00000000002a', 'a1110000-0000-0000-0000-000000000007'),
    (t, 'b1000000-0000-0000-0000-00000000002b', 'a1110000-0000-0000-0000-000000000008'),
    (t, 'b1000000-0000-0000-0000-00000000002c', 'a1110000-0000-0000-0000-000000000008')
  on conflict (request_type_id, category_id) do nothing;

  insert into public.request_type_form_variants (
    tenant_id, request_type_id, criteria_set_id, form_schema_id, priority, active
  )
  select *
  from (
    values
      (t, 'b1000000-0000-0000-0000-00000000001d'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000001'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-00000000001e'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000001'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-00000000001f'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000002'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000020'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000002'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000021'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000002'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000022'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000002'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000023'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000004'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000024'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000003'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000025'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000003'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000026'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000003'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000027'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000003'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000028'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000005'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-000000000029'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000005'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-00000000002a'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000005'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-00000000002b'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000007'::uuid, 0, true),
      (t, 'b1000000-0000-0000-0000-00000000002c'::uuid, null::uuid, 'a2000000-0000-0000-0000-000000000007'::uuid, 0, true)
  ) as seed_rows(tenant_id, request_type_id, criteria_set_id, form_schema_id, priority, active)
  where not exists (
    select 1
    from public.request_type_form_variants v
    where v.tenant_id = seed_rows.tenant_id
      and v.request_type_id = seed_rows.request_type_id
      and v.criteria_set_id is null
  );

  insert into public.request_type_coverage_rules (
    tenant_id, request_type_id, scope_kind, inherit_to_descendants, active
  )
  select t, rt.id, 'tenant', true, true
  from public.request_types rt
  where rt.tenant_id = t
    and rt.id in (
      'b1000000-0000-0000-0000-00000000001d',
      'b1000000-0000-0000-0000-00000000001e',
      'b1000000-0000-0000-0000-00000000001f',
      'b1000000-0000-0000-0000-000000000020',
      'b1000000-0000-0000-0000-000000000021',
      'b1000000-0000-0000-0000-000000000022',
      'b1000000-0000-0000-0000-000000000023',
      'b1000000-0000-0000-0000-000000000024',
      'b1000000-0000-0000-0000-000000000025',
      'b1000000-0000-0000-0000-000000000026',
      'b1000000-0000-0000-0000-000000000027',
      'b1000000-0000-0000-0000-000000000028',
      'b1000000-0000-0000-0000-000000000029',
      'b1000000-0000-0000-0000-00000000002a',
      'b1000000-0000-0000-0000-00000000002b',
      'b1000000-0000-0000-0000-00000000002c'
    )
    and not exists (
      select 1
      from public.request_type_coverage_rules c
      where c.tenant_id = t
        and c.request_type_id = rt.id
        and c.scope_kind = 'tenant'
        and c.active = true
    );
end $$;

notify pgrst, 'reload schema';
