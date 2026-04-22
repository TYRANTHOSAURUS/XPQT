-- Seed workflows + wire them to request types so reclassify can be exercised
-- end-to-end against realistic fixtures. Three scenarios with different shapes:
--
--   1. "Office Move Orchestration" — trigger → create_child_tasks(3) → approval → end
--      Wired to Office Move. Stays in `waiting` after setup → reclassify must
--      cancel the active workflow (exercises the full cancellation path).
--
--   2. "Maintenance Dispatch" — trigger → create_child_tasks(2) → end
--      Wired to Maintenance Issue. Completes immediately → reclassify finds no
--      active workflow, only closes the spawned children (covers the
--      "nothing to cancel" branch).
--
--   3. "Security Incident Response" — trigger → create_child_tasks(2) → approval → end
--      Wired to Security Incident. Like #1 but with Critical SLA on children to
--      exercise SLA stop/start across policies.
--
-- Re-runnable: upserts via on conflict do nothing / update where relevant.

-- ── Workflow definitions ─────────────────────────────────────────────────────
insert into public.workflow_definitions (id, tenant_id, name, status, version, graph_definition, published_at)
values (
  'de000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-000000000001',
  'Office Move Orchestration',
  'published',
  1,
  jsonb_build_object(
    'nodes', jsonb_build_array(
      jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
      jsonb_build_object('id', 'spawn', 'type', 'create_child_tasks', 'config', jsonb_build_object(
        'tasks', jsonb_build_array(
          jsonb_build_object(
            'title', 'Coordinate physical move',
            'description', 'Pack, transport, unpack furniture and equipment.',
            'assigned_team_id', 'c0000000-0000-0000-0000-000000000001',
            'priority', 'high',
            'sla_policy_id', 'f0000000-0000-0000-0000-000000000001'
          ),
          jsonb_build_object(
            'title', 'Set up catering at new location',
            'description', 'Stock pantry, verify kitchen equipment, update vendors.',
            'assigned_team_id', 'c0000000-0000-0000-0000-000000000004',
            'priority', 'medium',
            'sla_policy_id', 'f0000000-0000-0000-0000-000000000001'
          ),
          jsonb_build_object(
            'title', 'Install AV / meeting room equipment',
            'description', 'Mount screens, verify conferencing kit, label ports.',
            'assigned_team_id', '41000000-0000-0000-0000-000000000003',
            'priority', 'medium',
            'sla_policy_id', 'f0000000-0000-0000-0000-000000000001'
          )
        )
      )),
      jsonb_build_object('id', 'approval', 'type', 'approval', 'config', jsonb_build_object(
        'approver_team_id', 'c0000000-0000-0000-0000-000000000001'
      )),
      jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
    ),
    'edges', jsonb_build_array(
      jsonb_build_object('from', 'trigger', 'to', 'spawn'),
      jsonb_build_object('from', 'spawn', 'to', 'approval'),
      jsonb_build_object('from', 'approval', 'to', 'end', 'condition', 'approved')
    )
  ),
  now()
) on conflict (id) do update set
  graph_definition = excluded.graph_definition,
  name = excluded.name,
  status = 'published',
  published_at = coalesce(public.workflow_definitions.published_at, now());

insert into public.workflow_definitions (id, tenant_id, name, status, version, graph_definition, published_at)
values (
  'de000000-0000-0000-0000-0000000000a2',
  '00000000-0000-0000-0000-000000000001',
  'Maintenance Dispatch',
  'published',
  1,
  jsonb_build_object(
    'nodes', jsonb_build_array(
      jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
      jsonb_build_object('id', 'spawn', 'type', 'create_child_tasks', 'config', jsonb_build_object(
        'tasks', jsonb_build_array(
          jsonb_build_object(
            'title', 'Inspect reported issue',
            'description', 'Assess scope and schedule repair.',
            'assigned_team_id', 'c0000000-0000-0000-0000-000000000001',
            'priority', 'high',
            'sla_policy_id', 'f0000000-0000-0000-0000-000000000002'
          ),
          jsonb_build_object(
            'title', 'Clean up area after repair',
            'description', 'Restore workspace and sign off.',
            'assigned_team_id', 'c0000000-0000-0000-0000-000000000001',
            'priority', 'low',
            'sla_policy_id', 'f0000000-0000-0000-0000-000000000001'
          )
        )
      )),
      jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
    ),
    'edges', jsonb_build_array(
      jsonb_build_object('from', 'trigger', 'to', 'spawn'),
      jsonb_build_object('from', 'spawn', 'to', 'end')
    )
  ),
  now()
) on conflict (id) do update set
  graph_definition = excluded.graph_definition,
  name = excluded.name,
  status = 'published',
  published_at = coalesce(public.workflow_definitions.published_at, now());

insert into public.workflow_definitions (id, tenant_id, name, status, version, graph_definition, published_at)
values (
  'de000000-0000-0000-0000-0000000000a3',
  '00000000-0000-0000-0000-000000000001',
  'Security Incident Response',
  'published',
  1,
  jsonb_build_object(
    'nodes', jsonb_build_array(
      jsonb_build_object('id', 'trigger', 'type', 'trigger', 'config', jsonb_build_object()),
      jsonb_build_object('id', 'spawn', 'type', 'create_child_tasks', 'config', jsonb_build_object(
        'tasks', jsonb_build_array(
          jsonb_build_object(
            'title', 'Security investigation',
            'description', 'Contain the incident and gather initial evidence.',
            'assigned_team_id', 'c0000000-0000-0000-0000-000000000003',
            'priority', 'urgent',
            'sla_policy_id', 'f0000000-0000-0000-0000-000000000003'
          ),
          jsonb_build_object(
            'title', 'IT forensic analysis',
            'description', 'Preserve logs, analyse any affected systems.',
            'assigned_team_id', 'c0000000-0000-0000-0000-000000000002',
            'priority', 'urgent',
            'sla_policy_id', 'f0000000-0000-0000-0000-000000000003'
          )
        )
      )),
      jsonb_build_object('id', 'approval', 'type', 'approval', 'config', jsonb_build_object(
        'approver_team_id', 'c0000000-0000-0000-0000-000000000003'
      )),
      jsonb_build_object('id', 'end', 'type', 'end', 'config', jsonb_build_object())
    ),
    'edges', jsonb_build_array(
      jsonb_build_object('from', 'trigger', 'to', 'spawn'),
      jsonb_build_object('from', 'spawn', 'to', 'approval'),
      jsonb_build_object('from', 'approval', 'to', 'end', 'condition', 'approved')
    )
  ),
  now()
) on conflict (id) do update set
  graph_definition = excluded.graph_definition,
  name = excluded.name,
  status = 'published',
  published_at = coalesce(public.workflow_definitions.published_at, now());

-- ── Wire request types to their workflows ────────────────────────────────────
update public.request_types
set workflow_definition_id = 'de000000-0000-0000-0000-0000000000a1',
    sla_policy_id = coalesce(sla_policy_id, 'f0000000-0000-0000-0000-000000000001')
where id = 'dd000000-0000-0000-0000-000000000005';  -- Office Move

update public.request_types
set workflow_definition_id = 'de000000-0000-0000-0000-0000000000a2',
    sla_policy_id = coalesce(sla_policy_id, 'f0000000-0000-0000-0000-000000000002')
where id = 'dd000000-0000-0000-0000-000000000003';  -- Maintenance Issue

update public.request_types
set workflow_definition_id = 'de000000-0000-0000-0000-0000000000a3',
    sla_policy_id = coalesce(sla_policy_id, 'f0000000-0000-0000-0000-000000000003')
where id = 'dd000000-0000-0000-0000-000000000008';  -- Security Incident

notify pgrst, 'reload schema';
