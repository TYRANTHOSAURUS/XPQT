-- Demo webhooks for the admin Webhooks page. Each row is idempotent (fixed UUID + on conflict do nothing).
--
-- These point at the most recently published workflow for the default tenant so the UI has something to
-- render. If the tenant has no workflow yet, a minimal "Incoming ticket" workflow is stubbed so the
-- webhooks remain valid. Tokens are deterministic per row so the public URL stays stable across resets.

do $$
declare
  t uuid := '00000000-0000-0000-0000-000000000001';
  wf uuid;
begin
  -- Pick any workflow for the tenant (prefer published); stub one if none exists so the seed is self-contained.
  select id into wf
    from public.workflow_definitions
   where tenant_id = t
   order by (status = 'published') desc, created_at desc
   limit 1;

  if wf is null then
    wf := '90000000-0000-0000-0000-000000000001';
    insert into public.workflow_definitions (id, tenant_id, name, entity_type, version, status, graph_definition)
    values (
      wf, t, 'Incoming ticket (demo)', 'ticket', 1, 'published',
      jsonb_build_object(
        'nodes', jsonb_build_array(
          jsonb_build_object('id', 'start',  'type', 'start'),
          jsonb_build_object('id', 'create', 'type', 'create_ticket'),
          jsonb_build_object('id', 'end',    'type', 'end')
        ),
        'edges', jsonb_build_array(
          jsonb_build_object('from', 'start',  'to', 'create'),
          jsonb_build_object('from', 'create', 'to', 'end')
        )
      )
    )
    on conflict (id) do nothing;
  end if;

  -- 1) Axxerion (legacy FMIS) → our tickets. Realistic shape from their outbound webhook.
  insert into public.workflow_webhooks (
    id, tenant_id, workflow_id, name, token, active, ticket_defaults, field_mapping, last_received_at, last_error
  ) values (
    '40000000-0000-0000-0000-000000000001', t, wf,
    'Axxerion → ticket (legacy migration)',
    'demo_axxerion_7f3a9c2e4b1d8f05c9a2e1b7',
    true,
    jsonb_build_object(
      'source', 'axxerion',
      'interaction_mode', 'internal',
      'request_type_slug', 'facilities_maintenance',
      'priority', 'medium',
      'tags', jsonb_build_array('migrated', 'axxerion')
    ),
    jsonb_build_object(
      'title',       '$.data.subject',
      'description', '$.data.description',
      'priority',    '$.data.priority',
      'external_id', '$.data.id',
      'location',    '$.data.location.building',
      'reporter_email', '$.data.reporter.email',
      'reporter_name',  '$.data.reporter.name'
    ),
    now() - interval '2 hours',
    null
  ) on conflict (id) do nothing;

  -- 2) Zendesk support ticket → internal incident
  insert into public.workflow_webhooks (
    id, tenant_id, workflow_id, name, token, active, ticket_defaults, field_mapping, last_received_at, last_error
  ) values (
    '40000000-0000-0000-0000-000000000002', t, wf,
    'Zendesk → incident',
    'demo_zendesk_2b8e1f4a6c9d7b3e0f5a8c14',
    true,
    jsonb_build_object(
      'source', 'zendesk',
      'interaction_mode', 'customer',
      'request_type_slug', 'it_incident',
      'priority', 'high'
    ),
    jsonb_build_object(
      'title',       '$.ticket.subject',
      'description', '$.ticket.description',
      'external_id', '$.ticket.id',
      'reporter_email', '$.ticket.requester.email'
    ),
    now() - interval '20 minutes',
    null
  ) on conflict (id) do nothing;

  -- 3) PagerDuty incident → urgent ticket
  insert into public.workflow_webhooks (
    id, tenant_id, workflow_id, name, token, active, ticket_defaults, field_mapping, last_received_at, last_error
  ) values (
    '40000000-0000-0000-0000-000000000003', t, wf,
    'PagerDuty → urgent incident',
    'demo_pagerduty_a1c5d9e3f7b2084c6d1e3f90',
    true,
    jsonb_build_object(
      'source', 'pagerduty',
      'interaction_mode', 'internal',
      'request_type_slug', 'it_incident',
      'priority', 'urgent',
      'tags', jsonb_build_array('oncall', 'alert')
    ),
    jsonb_build_object(
      'title',       '$.event.data.title',
      'description', '$.event.data.summary',
      'external_id', '$.event.data.id',
      'severity',    '$.event.data.urgency'
    ),
    now() - interval '5 minutes',
    null
  ) on conflict (id) do nothing;

  -- 4) Typeform submission → service request (disabled, to show the off state)
  insert into public.workflow_webhooks (
    id, tenant_id, workflow_id, name, token, active, ticket_defaults, field_mapping, last_received_at, last_error
  ) values (
    '40000000-0000-0000-0000-000000000004', t, wf,
    'Typeform guest request',
    'demo_typeform_c4f2a8b1e6d90371a5b8c2d4',
    false,
    jsonb_build_object(
      'source', 'typeform',
      'interaction_mode', 'guest',
      'request_type_slug', 'visitor_pass'
    ),
    jsonb_build_object(
      'title',       '$.form_response.answers[0].text',
      'description', '$.form_response.answers[1].text',
      'reporter_email', '$.form_response.hidden.email'
    ),
    null,
    null
  ) on conflict (id) do nothing;

  -- 5) Generic JSON probe (has a last_error so the UI shows that state)
  insert into public.workflow_webhooks (
    id, tenant_id, workflow_id, name, token, active, ticket_defaults, field_mapping, last_received_at, last_error
  ) values (
    '40000000-0000-0000-0000-000000000005', t, wf,
    'Generic JSON probe',
    'demo_generic_e8b3f0a5c7d9216b4f0c1e72',
    true,
    jsonb_build_object('source', 'custom'),
    jsonb_build_object(
      'title',       '$.title',
      'description', '$.body'
    ),
    now() - interval '3 days',
    'JSONPath $.title did not match payload at 2026-04-17T09:12:44Z'
  ) on conflict (id) do nothing;
end $$;

notify pgrst, 'reload schema';
