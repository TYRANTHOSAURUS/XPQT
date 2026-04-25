-- 00133_seed_room_booking_examples.sql
-- Example data for the room booking module so the product is usable
-- end-to-end out of the box. All UUIDs are fixed so the seed is fully
-- idempotent (re-runs are noops via ON CONFLICT DO NOTHING).
--
-- Tenant: Solana Inc. (00000000-0000-0000-0000-000000000001)
-- Persons: Thomas Anderson (dev@prequest.nl), Liam de Vries (servicedesk.agent),
--          Noor Bakker (it.admin)
-- Rooms: three distinct meeting rooms upgraded with realistic booking config.

-- ===== Step 1: upgrade three sample rooms with booking config =====
-- Meeting Room 1.10 (capacity 6) — quick huddle room, no check-in
update public.spaces
set
  setup_buffer_minutes = 5,
  teardown_buffer_minutes = 5,
  check_in_required = false,
  min_attendees = null,
  default_search_keywords = array['huddle','standup','quick'],
  cost_per_hour = 0
where id = '14d74559-7f91-470a-98a3-780b3e8a5349';

-- Meeting Room 1.12 (capacity 10) — team meeting room w/ check-in
update public.spaces
set
  setup_buffer_minutes = 10,
  teardown_buffer_minutes = 5,
  check_in_required = true,
  check_in_grace_minutes = 15,
  min_attendees = null,
  default_search_keywords = array['team-sync','planning','retro'],
  cost_per_hour = 0
where id = '6df43476-f6af-4ffa-9d39-e79c0bbb3dad';

-- Meeting Room 1.12 (capacity 10, second one) — board / demo room w/ floor + check-in
update public.spaces
set
  setup_buffer_minutes = 15,
  teardown_buffer_minutes = 15,
  check_in_required = true,
  check_in_grace_minutes = 15,
  min_attendees = 4,
  default_search_keywords = array['demo','review','board','executive'],
  cost_per_hour = 25.00
where id = '207242ea-48e9-41a2-a72d-5ea4192f48bf';

-- ===== Step 2: three example booking rules using starter templates =====
-- 2a. Off-hours (outside business hours) need approval — tenant scope.
-- We use a tenant-wide business_hours_calendars row if one exists; otherwise
-- this rule is inactive until an admin picks a calendar.
insert into public.room_booking_rules (
  id, tenant_id, name, description,
  target_scope, target_id, applies_when, effect, approval_config,
  denial_message, priority, template_id, template_params, active,
  created_at, updated_at
)
select
  'b0010001-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Off-hours bookings need approval',
  'Bookings that fall outside business hours route to facilities for review.',
  'tenant', null,
  jsonb_build_object(
    'not', jsonb_build_object(
      'fn', 'in_business_hours',
      'args', jsonb_build_array('$.booking.start_at', cal.id::text)
    )
  ),
  'require_approval',
  '{"required_approvers":[{"type":"person","id":"95000000-0000-0000-0000-000000000007"}],"threshold":"any"}'::jsonb,
  'Off-hours bookings need facilities approval. Submit and we''ll review within 4 business hours.',
  100,
  'off_hours_need_approval',
  jsonb_build_object('calendar_id', cal.id::text),
  true,
  now(), now()
from public.business_hours_calendars cal
where cal.tenant_id = '00000000-0000-0000-0000-000000000001'
  and cal.active = true
limit 1
on conflict (id) do nothing;

-- 2b. Long bookings (> 4 hours) need manager approval.
insert into public.room_booking_rules (
  id, tenant_id, name, description,
  target_scope, target_id, applies_when, effect, approval_config,
  denial_message, priority, template_id, template_params, active,
  created_at, updated_at
) values (
  'b0010002-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Long bookings need manager approval',
  'Bookings over 4 hours route to the requester''s manager for approval.',
  'tenant', null,
  -- duration_minutes_gt(start_at, end_at, 240) — 4 hours = 240 minutes.
  -- Predicate engine has duration_minutes_gt; duration_hours doesn't exist.
  '{"fn":"duration_minutes_gt","args":["$.booking.start_at","$.booking.end_at",240]}'::jsonb,
  'require_approval',
  '{"required_approvers":[{"type":"person","id":"95000000-0000-0000-0000-000000000004"}],"threshold":"any"}'::jsonb,
  'Bookings over 4 hours need manager approval.',
  90,
  'long_bookings_need_manager_approval',
  '{"interval_minutes":240}'::jsonb,
  true,
  now(), now()
)
on conflict (id) do nothing;

-- 2c. Soft over-capacity warning.
insert into public.room_booking_rules (
  id, tenant_id, name, description,
  target_scope, target_id, applies_when, effect,
  denial_message, priority, template_id, active,
  created_at, updated_at
) values (
  'b0010003-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Over-capacity warning',
  'Bookings whose attendee count exceeds the room capacity show a soft warning.',
  'tenant', null,
  '{"fn":"attendees_over_capacity_factor","args":["$.booking.attendee_count","$.space.capacity",1.0]}'::jsonb,
  'warn',
  'This room is smaller than your attendee count — consider a larger room.',
  50,
  'soft_over_capacity_warning',
  true,
  now(), now()
)
on conflict (id) do nothing;

-- Initial version-history rows so the rule detail page shows the create event.
insert into public.room_booking_rule_versions (
  id, rule_id, tenant_id, version_number, change_type, snapshot,
  diff, actor_user_id, actor_at
)
select
  ('b0019001-0000-0000-0000-' || lpad(row_number() over (order by id)::text, 12, '0'))::uuid,
  id, tenant_id, 1, 'create',
  jsonb_build_object(
    'name', name, 'description', description,
    'target_scope', target_scope, 'effect', effect,
    'applies_when', applies_when, 'active', active
  ),
  null, null, created_at
from public.room_booking_rules
where tenant_id = '00000000-0000-0000-0000-000000000001'
  and id in (
    'b0010001-0000-0000-0000-000000000001',
    'b0010002-0000-0000-0000-000000000001',
    'b0010003-0000-0000-0000-000000000001'
  )
on conflict (rule_id, version_number) do nothing;

-- ===== Step 3: example reservations spanning the seven-state model =====
-- Anchor times relative to today so the seed stays useful as time passes.
-- Use deterministic dates so the seed is repeatable: anchor = next Monday 09:00 local.
do $$
declare
  v_tenant uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_thomas uuid := 'b3a0aa30-3648-4783-92fa-973090877238'::uuid;
  v_liam   uuid := '95000000-0000-0000-0000-000000000003'::uuid;
  v_noor   uuid := '95000000-0000-0000-0000-000000000004'::uuid;
  v_room_huddle uuid := '14d74559-7f91-470a-98a3-780b3e8a5349'::uuid;  -- 6
  v_room_team   uuid := '6df43476-f6af-4ffa-9d39-e79c0bbb3dad'::uuid;  -- 10
  v_room_board  uuid := '207242ea-48e9-41a2-a72d-5ea4192f48bf'::uuid;  -- 10 (board)
  v_anchor      timestamptz := date_trunc('week', now()) + interval '7 days' + interval '9 hours';
  v_series_id   uuid := 'a0010001-0000-0000-0000-000000000001'::uuid;
begin
  -- 3a. CONFIRMED — Thomas books huddle room next Tue 14:00–15:00 (just him + Liam).
  insert into public.reservations (
    id, tenant_id, reservation_type, space_id, requester_person_id,
    start_at, end_at, attendee_count, attendee_person_ids, status,
    setup_buffer_minutes, teardown_buffer_minutes, check_in_required,
    check_in_grace_minutes, source, applied_rule_ids, policy_snapshot,
    created_at, updated_at
  ) values (
    'a0020001-0000-0000-0000-000000000001'::uuid,
    v_tenant, 'room', v_room_huddle, v_thomas,
    v_anchor + interval '1 day' + interval '5 hours',
    v_anchor + interval '1 day' + interval '6 hours',
    2, array[v_liam], 'confirmed',
    5, 5, false, 15, 'portal', '{}', '{}',
    now(), now()
  ) on conflict (id) do nothing;

  -- 3b. CONFIRMED — Thomas books team room next Wed 10:00–11:30 (5 attendees).
  insert into public.reservations (
    id, tenant_id, reservation_type, space_id, requester_person_id,
    start_at, end_at, attendee_count, attendee_person_ids, status,
    setup_buffer_minutes, teardown_buffer_minutes, check_in_required,
    check_in_grace_minutes, source, applied_rule_ids, policy_snapshot,
    created_at, updated_at
  ) values (
    'a0020002-0000-0000-0000-000000000001'::uuid,
    v_tenant, 'room', v_room_team, v_thomas,
    v_anchor + interval '2 days' + interval '1 hour',
    v_anchor + interval '2 days' + interval '2 hours 30 minutes',
    5, array[v_liam, v_noor], 'confirmed',
    10, 5, true, 15, 'portal',
    array['b0010003-0000-0000-0000-000000000001'::uuid],
    '{"matched_rule_ids":["b0010003-0000-0000-0000-000000000001"],"effects_seen":["warn"]}',
    now(), now()
  ) on conflict (id) do nothing;

  -- 3c. PENDING_APPROVAL — Thomas books board room next Thu 13:00–18:00 (5 hours, triggers long-booking rule).
  insert into public.reservations (
    id, tenant_id, reservation_type, space_id, requester_person_id,
    start_at, end_at, attendee_count, attendee_person_ids, status,
    setup_buffer_minutes, teardown_buffer_minutes, check_in_required,
    check_in_grace_minutes, source, applied_rule_ids, policy_snapshot,
    created_at, updated_at
  ) values (
    'a0020003-0000-0000-0000-000000000001'::uuid,
    v_tenant, 'room', v_room_board, v_thomas,
    v_anchor + interval '3 days' + interval '4 hours',
    v_anchor + interval '3 days' + interval '9 hours',
    8, array[v_liam, v_noor], 'pending_approval',
    15, 15, true, 15, 'portal',
    array['b0010002-0000-0000-0000-000000000001'::uuid],
    '{"matched_rule_ids":["b0010002-0000-0000-0000-000000000001"],"effects_seen":["require_approval"]}',
    now(), now()
  ) on conflict (id) do nothing;

  -- 3c-approval rows — two pending approvals on the same reservation so
  -- whichever of Noor (it.admin) or Liam (servicedesk.agent) opens
  -- /desk/approvals first sees + acts on it. First-to-respond wins.
  insert into public.approvals (
    id, tenant_id, target_entity_type, target_entity_id,
    approver_person_id, status, requested_at, created_at
  ) values
    (
      'a0030003-0000-0000-0000-000000000001'::uuid,
      v_tenant, 'reservation', 'a0020003-0000-0000-0000-000000000001'::uuid,
      v_noor, 'pending', now(), now()
    ),
    (
      'a0030003-0000-0000-0000-000000000002'::uuid,
      v_tenant, 'reservation', 'a0020003-0000-0000-0000-000000000001'::uuid,
      v_liam, 'pending', now(), now()
    )
  on conflict (id) do nothing;

  -- 3d. CANCELLED — past meeting cancelled with reason.
  insert into public.reservations (
    id, tenant_id, reservation_type, space_id, requester_person_id,
    start_at, end_at, attendee_count, attendee_person_ids, status,
    setup_buffer_minutes, teardown_buffer_minutes, source, applied_rule_ids,
    policy_snapshot, created_at, updated_at
  ) values (
    'a0020004-0000-0000-0000-000000000001'::uuid,
    v_tenant, 'room', v_room_huddle, v_thomas,
    v_anchor - interval '2 days' + interval '5 hours',
    v_anchor - interval '2 days' + interval '6 hours',
    3, array[]::uuid[], 'cancelled',
    5, 5, 'portal', '{}', '{}',
    now() - interval '3 days', now() - interval '2 days'
  ) on conflict (id) do nothing;

  -- 3e. RECURRING SERIES — weekly team standup (next 4 weeks).
  -- Insert the series row first with parent_reservation_id NULL — the FK
  -- references reservations(id) which doesn't yet contain the master.
  -- We update the FK after the occurrences are inserted below.
  insert into public.recurrence_series (
    id, tenant_id, recurrence_rule, series_start_at, series_end_at,
    max_occurrences, materialized_through, parent_reservation_id,
    created_at, updated_at
  ) values (
    v_series_id, v_tenant,
    '{"frequency":"weekly","interval":1,"by_day":["MO"],"count":4}'::jsonb,
    v_anchor + interval '0 days',
    v_anchor + interval '28 days',
    52,
    v_anchor + interval '28 days',
    null,
    now(), now()
  ) on conflict (id) do nothing;

  -- 4 occurrences of the weekly standup.
  insert into public.reservations (
    id, tenant_id, reservation_type, space_id, requester_person_id,
    start_at, end_at, attendee_count, attendee_person_ids, status,
    setup_buffer_minutes, teardown_buffer_minutes, check_in_required,
    check_in_grace_minutes, source, applied_rule_ids, policy_snapshot,
    recurrence_series_id, recurrence_index,
    created_at, updated_at
  )
  select
    ('a0020005-0000-0000-0000-' || lpad((idx + 1)::text, 12, '0'))::uuid,
    v_tenant, 'room', v_room_team, v_thomas,
    v_anchor + (interval '7 days' * idx),
    v_anchor + (interval '7 days' * idx) + interval '30 minutes',
    4, array[v_liam, v_noor], 'confirmed',
    10, 5, true, 15, 'portal', '{}', '{}',
    v_series_id, idx,
    now(), now()
  from generate_series(0, 3) as idx
  on conflict (id) do nothing;

  -- Update the series row to point at the master we just created.
  update public.recurrence_series
  set parent_reservation_id = 'a0020005-0000-0000-0000-000000000001'::uuid
  where id = v_series_id and parent_reservation_id is null;

  -- 3f. CHECK-IN-REQUIRED, NOT YET CHECKED IN — within next hour.
  insert into public.reservations (
    id, tenant_id, reservation_type, space_id, requester_person_id,
    start_at, end_at, attendee_count, attendee_person_ids, status,
    setup_buffer_minutes, teardown_buffer_minutes, check_in_required,
    check_in_grace_minutes, source, applied_rule_ids, policy_snapshot,
    created_at, updated_at
  ) values (
    'a0020006-0000-0000-0000-000000000001'::uuid,
    v_tenant, 'room', v_room_team, v_liam,
    now() + interval '5 minutes',
    now() + interval '35 minutes',
    3, array[]::uuid[], 'confirmed',
    10, 5, true, 15, 'desk', '{}', '{}',
    now(), now()
  ) on conflict (id) do nothing;

  -- 3g. CHECKED_IN — Thomas already checked in to a meeting in progress.
  insert into public.reservations (
    id, tenant_id, reservation_type, space_id, requester_person_id,
    start_at, end_at, attendee_count, attendee_person_ids, status,
    setup_buffer_minutes, teardown_buffer_minutes, check_in_required,
    check_in_grace_minutes, checked_in_at, source, applied_rule_ids,
    policy_snapshot, created_at, updated_at
  ) values (
    'a0020007-0000-0000-0000-000000000001'::uuid,
    v_tenant, 'room', v_room_huddle, v_thomas,
    now() - interval '15 minutes',
    now() + interval '45 minutes',
    2, array[v_liam], 'checked_in',
    5, 5, false, 15, now() - interval '14 minutes', 'portal', '{}', '{}',
    now() - interval '1 hour', now() - interval '14 minutes'
  ) on conflict (id) do nothing;

  -- 3h. RELEASED — yesterday's no-show, auto-released.
  insert into public.reservations (
    id, tenant_id, reservation_type, space_id, requester_person_id,
    start_at, end_at, attendee_count, attendee_person_ids, status,
    setup_buffer_minutes, teardown_buffer_minutes, check_in_required,
    check_in_grace_minutes, released_at, source, applied_rule_ids,
    policy_snapshot, created_at, updated_at
  ) values (
    'a0020008-0000-0000-0000-000000000001'::uuid,
    v_tenant, 'room', v_room_team, v_liam,
    now() - interval '1 day' - interval '2 hours',
    now() - interval '1 day' - interval '1 hour',
    4, array[]::uuid[], 'released',
    10, 5, true, 15, now() - interval '1 day' - interval '1 hour 45 minutes',
    'portal', '{}', '{}',
    now() - interval '2 days', now() - interval '1 day' - interval '1 hour 45 minutes'
  ) on conflict (id) do nothing;
end $$;

-- ===== Step 4: simulation scenarios for the admin "Test rule" panel =====
insert into public.room_booking_simulation_scenarios (
  id, tenant_id, name, description, scenario, created_at, created_by
) values
(
  'a0050001-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  'After-hours boardroom request',
  'Thomas books the boardroom Friday 19:00–20:00. Should route to facilities approval.',
  '{"requester_person_id":"b3a0aa30-3648-4783-92fa-973090877238","space_id":"207242ea-48e9-41a2-a72d-5ea4192f48bf","start_at":"2026-05-01T19:00:00Z","end_at":"2026-05-01T20:00:00Z","attendee_count":6,"criteria":{}}'::jsonb,
  now(), null
),
(
  'a0050002-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  'All-day workshop request',
  'Thomas books the team room 09:00–17:00 — duration > 4h, should require manager approval.',
  '{"requester_person_id":"b3a0aa30-3648-4783-92fa-973090877238","space_id":"6df43476-f6af-4ffa-9d39-e79c0bbb3dad","start_at":"2026-05-04T09:00:00Z","end_at":"2026-05-04T17:00:00Z","attendee_count":8,"criteria":{}}'::jsonb,
  now(), null
),
(
  'a0050003-0000-0000-0000-000000000001'::uuid,
  '00000000-0000-0000-0000-000000000001'::uuid,
  'Over-capacity huddle',
  'Liam books the 6-person huddle for 8 people — should warn, not deny.',
  '{"requester_person_id":"95000000-0000-0000-0000-000000000003","space_id":"14d74559-7f91-470a-98a3-780b3e8a5349","start_at":"2026-05-04T10:00:00Z","end_at":"2026-05-04T11:00:00Z","attendee_count":8,"criteria":{}}'::jsonb,
  now(), null
)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
