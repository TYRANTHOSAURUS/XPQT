-- Step 1c.10c follow-up: ticket_activities post-cutover repairs.
--
-- Two issues caught by codex review of 1c.10c:
--
-- 1. ticket_activities.ticket_id has FK to tickets ON DELETE CASCADE.
--    The 1c.10c DELETE of 319 wo ticket rows cascade-deleted 315
--    ticket_activities rows (verified in dev: 1398 → 1083 activities).
--    The delete shadow trigger then propagated the deletion to the
--    activities polymorphic table. Real data loss in dev — would have
--    been worse in production.
--
--    Going forward: any new ticket_activity for a work_order ticket id
--    would FK-fail (work_order ids are now in work_orders, not tickets).
--    Drop the FK so future writes succeed.
--
-- 2. The shadow_ticket_activity_to_activities() function (00204) selects
--    tickets.ticket_kind to derive entity_kind. Post-1c.10c that column
--    is dropped — the function will error on next ticket_activity insert.
--
--    Rewrite using the same existence-check pattern as 00232.

-- ── 1. Drop ticket_activities.ticket_id FK ────────────────────
-- ticket_id stays as a soft pointer. The polymorphic activities table
-- has the canonical entity_kind/entity_id linkage.
-- Drop the FK by name (constraint def shows `REFERENCES tickets(id)` —
-- pg_get_constraintdef omits the schema qualifier so a `like '%public.tickets%'`
-- filter wouldn't match. Drop by name for clarity.
alter table public.ticket_activities
  drop constraint if exists ticket_activities_ticket_id_fkey;

-- ── 2. Rewrite shadow trigger to use existence-check ──────────
create or replace function public.shadow_ticket_activity_to_activities()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  -- Existence-check across tickets + work_orders. ticket_kind column
  -- is gone post-1c.10c, but the id is unique across the two tables
  -- (UUIDs), so the table-membership tells us the kind.
  if exists (select 1 from public.tickets where id = new.ticket_id) then
    v_kind := 'case';
  elsif exists (select 1 from public.work_orders where id = new.ticket_id) then
    v_kind := 'work_order';
  else
    -- Source row not found (deleted concurrently?). Fall back to umbrella.
    v_kind := 'ticket';
  end if;

  insert into public.activities (
    tenant_id,
    entity_kind,
    entity_id,
    activity_type,
    author_person_id,
    visibility,
    content,
    attachments,
    metadata,
    source_table,
    source_id,
    created_at
  ) values (
    new.tenant_id,
    v_kind,
    new.ticket_id,
    new.activity_type,
    new.author_person_id,
    new.visibility,
    new.content,
    coalesce(new.attachments, '[]'::jsonb),
    new.metadata,
    'ticket_activities',
    new.id,
    new.created_at
  )
  on conflict (source_table, source_id) where source_id is not null do nothing;
  return new;
end;
$$;

-- Same fix for the UPDATE shadow.
create or replace function public.shadow_ticket_activity_update_to_activities()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  if exists (select 1 from public.tickets where id = new.ticket_id) then
    v_kind := 'case';
  elsif exists (select 1 from public.work_orders where id = new.ticket_id) then
    v_kind := 'work_order';
  else
    v_kind := 'ticket';
  end if;

  update public.activities
     set tenant_id = new.tenant_id,
         entity_kind = v_kind,
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

comment on function public.shadow_ticket_activity_to_activities() is
  'Step 0+1c.10c (00202+00211+00235): existence-check across tickets+work_orders. Survives ticket_kind drop.';
comment on function public.shadow_ticket_activity_update_to_activities() is
  'Step 0+1c.10c (00211+00235): existence-check across tickets+work_orders. Survives ticket_kind drop.';

notify pgrst, 'reload schema';
