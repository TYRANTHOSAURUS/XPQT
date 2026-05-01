-- Step 1c.10c follow-up: drop sla_threshold_crossings.ticket_id FK.
--
-- Caught after 1c.10c shipped: full-review flagged sla_threshold_crossings
-- as another table with ON DELETE CASCADE to tickets. The 1c.10c migration
-- only softened FKs on sla_timers, routing_decisions, workflow_instances
-- — sla_threshold_crossings was missed. In dev this was harmless (0 rows
-- in the table), but in production with a populated table the CASCADE
-- would have silently nuked all crossings tied to the 319 deleted work-
-- order ticket rows.
--
-- Drop the FK now to prevent future similar surprises and to make
-- ticket_id a soft pointer (the polymorphic columns are SoT — but
-- sla_threshold_crossings doesn't have polymorphic columns yet, so
-- ticket_id stays as the reference for now; it just doesn't cascade).
--
-- A proper polymorphic split (case_id / work_order_id columns + entity_kind)
-- could be added later if the table sees real use.

do $$
declare v_name text;
begin
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.sla_threshold_crossings'::regclass
       and contype = 'f'
       and pg_get_constraintdef(oid) like '%ticket_id%'
       and pg_get_constraintdef(oid) like '%public.tickets%'
  loop
    execute format('alter table public.sla_threshold_crossings drop constraint %I', v_name);
    raise notice 'Dropped sla_threshold_crossings FK: %', v_name;
  end loop;
end $$;

notify pgrst, 'reload schema';
