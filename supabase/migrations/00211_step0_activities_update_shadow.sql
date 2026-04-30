-- Step 0 follow-up: add UPDATE shadow trigger on ticket_activities.
--
-- Self-review of the data-model rework caught that 00202 added an INSERT
-- shadow trigger and 00203 added a DELETE shadow trigger, but UPDATE was
-- never covered. Today no code path UPDATEs ticket_activities (verified
-- via grep — only 4 SELECTs and 2 INSERTs across the codebase). The gap
-- is theoretical, but a future writer or admin tool could update a row
-- and activities would silently desync.
--
-- Plug the gap now while it's cheap. Consistent with codex's earlier
-- guidance: "biggest miss is deletes/updates, not bulk insert."

create or replace function public.shadow_ticket_activity_update_to_activities()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  -- Resolve current ticket_kind (in case it changed since the source row
  -- was created — e.g. via reclassify). Match the same logic as the
  -- INSERT shadow.
  select case t.ticket_kind
    when 'work_order' then 'work_order'
    else 'case'
  end into v_kind
  from public.tickets t
  where t.id = new.ticket_id;
  v_kind := coalesce(v_kind, 'ticket');

  update public.activities
     set entity_kind = v_kind,
         entity_id = new.ticket_id,
         activity_type = new.activity_type,
         author_person_id = new.author_person_id,
         visibility = new.visibility,
         content = new.content,
         attachments = coalesce(new.attachments, '[]'::jsonb),
         metadata = new.metadata
   where source_table = 'ticket_activities'
     and source_id = new.id;
  return new;
end;
$$;

drop trigger if exists trg_ticket_activities_shadow_update on public.ticket_activities;
create trigger trg_ticket_activities_shadow_update
after update on public.ticket_activities
for each row execute function public.shadow_ticket_activity_update_to_activities();

comment on function public.shadow_ticket_activity_update_to_activities() is
  'Step 0 dual-write update shim. Drops alongside the insert + delete shims in step 1c when service-layer code writes to activities directly.';

notify pgrst, 'reload schema';
