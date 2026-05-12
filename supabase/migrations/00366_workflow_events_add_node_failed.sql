-- B.2.A.Step8 follow-up: allow 'node_failed' on workflow_instance_events.event_type.
--
-- Step 8 added a `node_failed` emit on the create_child_tasks halt path
-- (workflow-engine.service.ts:541-554). The original 00026 CHECK constraint
-- omits 'node_failed', so every emit since Step 8 has been silently
-- rejected by Postgres and swallowed by the bare catch in `emit()` —
-- audit feed shows status='failed' with no node-level evidence of why.
-- Drop the old constraint by definition (auto-named) and re-add with a
-- stable name including 'node_failed'.

do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  join pg_class t on c.conrelid = t.oid
  join pg_namespace n on t.relnamespace = n.oid
  where n.nspname = 'public'
    and t.relname = 'workflow_instance_events'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%event_type%'
  limit 1;

  if v_name is not null then
    execute format('alter table public.workflow_instance_events drop constraint %I', v_name);
  end if;
end$$;

alter table public.workflow_instance_events
  add constraint workflow_instance_events_event_type_check
  check (event_type in (
    'node_entered', 'node_exited', 'node_failed', 'decision_made',
    'instance_started', 'instance_completed', 'instance_failed',
    'instance_waiting', 'instance_resumed'
  ));
