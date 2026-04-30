-- Step 1a/1b post-full-review fixes from the in-session adversarial review
-- (2026-04-30). Six findings addressed in one migration:
--
-- 1. (CRITICAL/C1) The shadow trigger on ticket_activities only handles
--    INSERT/UPDATE/DELETE — TRUNCATE silently desyncs activities. Today
--    no code TRUNCATEs ticket_activities (00100 seed reset uses DELETE),
--    but a future test fixture or ops command would wipe ticket_activities
--    and leave activities full of orphans. Add a statement-level BEFORE
--    TRUNCATE shadow that wipes the matching activities rows.
--
-- 2. (CRITICAL/C2) The assert_work_order_parent_is_case trigger fires on
--    child INSERT/UPDATE only. If a parent CASE is reclassified to a
--    work_order, every child WO becomes invalid retroactively (parent
--    is now a WO, violating the invariant) and nothing catches it. Add
--    a trigger on parent ticket_kind UPDATE that blocks the change when
--    the row has work_order children.
--
-- 3. (IMPORTANT/I1) 00203 revoked SELECT/INSERT/UPDATE/DELETE on
--    activities from anon, authenticated — but left TRIGGER, REFERENCES,
--    TRUNCATE intact. TRUNCATE in particular lets non-service callers
--    wipe the entire activities table. Tighten the revoke posture to
--    match the cases/work_orders views (revoke ALL from anon, authenticated,
--    public; service_role keeps SELECT/INSERT/UPDATE/DELETE only).
--
-- 4. (IMPORTANT/I2) The cases view (00208) doesn't expose parent_kind
--    even though both parent_ticket_id and booking_bundle_id are on the
--    table. work_orders has the discriminator; cases doesn't. Add it
--    for symmetry — cases that have a booking_bundle_id (rare but real)
--    will need this for downstream consumers.
--
-- 5. (IMPORTANT/I3) tickets_visible_for_vendor (00188 + 00191) is now
--    orphaned. Vendor portal cutover (865934e + a5cbbd2) was the only
--    caller; switched to public.work_orders direct. Drop the function
--    so future code doesn't pick up an unmaintained predicate.
--
-- 6. (NIT/N2) The 00211 UPDATE shadow trigger doesn't propagate
--    tenant_id changes. Add tenant_id to the SET list. (Theoretical —
--    tenant_id on ticket_activities should never change — but cheap to
--    cover.)

-- ── 1. TRUNCATE shadow trigger on ticket_activities (C1) ─────
create or replace function public.shadow_ticket_activity_truncate_to_activities()
returns trigger
language plpgsql
as $$
begin
  delete from public.activities where source_table = 'ticket_activities';
  return null;
end;
$$;

drop trigger if exists trg_ticket_activities_shadow_truncate on public.ticket_activities;
create trigger trg_ticket_activities_shadow_truncate
before truncate on public.ticket_activities
for each statement execute function public.shadow_ticket_activity_truncate_to_activities();

comment on function public.shadow_ticket_activity_truncate_to_activities() is
  'Step 0 dual-write TRUNCATE shim. Statement-level trigger because TRUNCATE does not fire row-level triggers. Drops with the other shadow shims at step 1c when service-layer code writes to activities directly.';

-- ── 2. Block reclassify of parent that has work_order children (C2) ──
-- assert_work_order_parent_is_case (00208) protects against children
-- pointing at a non-case parent at write time. But it doesn't protect
-- against the parent's ticket_kind being flipped after children exist.
-- Block the parent flip directly.
create or replace function public.assert_no_work_order_children_on_kind_flip()
returns trigger
language plpgsql
as $$
declare
  v_child_count int;
begin
  -- Only relevant when ticket_kind is actually changing.
  if new.ticket_kind is not distinct from old.ticket_kind then
    return new;
  end if;
  -- We only care about case → work_order flips (the dangerous direction).
  -- A case → case stays a case (no-op). A work_order → case is fine
  -- because that orphans children to a "case" parent which is the
  -- correct invariant.
  if old.ticket_kind = 'case' and new.ticket_kind = 'work_order' then
    select count(*) into v_child_count
      from public.tickets t
     where t.parent_ticket_id = new.id
       and t.ticket_kind = 'work_order';
    if v_child_count > 0 then
      raise exception
        'Cannot reclassify case % to work_order: it has % work_order child ticket(s). Reassign or close the children first.',
        new.id, v_child_count;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assert_no_wo_children_on_kind_flip on public.tickets;
create trigger trg_assert_no_wo_children_on_kind_flip
before update of ticket_kind on public.tickets
for each row execute function public.assert_no_work_order_children_on_kind_flip();

comment on function public.assert_no_work_order_children_on_kind_flip() is
  'Step 1a (00212): companion to assert_work_order_parent_is_case (00208). Blocks reclassify of a case to a work_order if the case has work_order children — protects the invariant from the parent side.';

-- ── 3. Tighten activities table revoke posture (I1) ──────────
revoke all on public.activities from anon, authenticated, public;
revoke truncate, references, trigger on public.activities from service_role;
grant select, insert, update, delete on public.activities to service_role;

comment on policy "tenant_isolation" on public.activities is
  'Tenant scope only. ALL privileges revoked from anon/authenticated/public; TRUNCATE/REFERENCES/TRIGGER also revoked from service_role. Reads go through the API which gates by entity visibility.';

-- ── 4. cases view: add parent_kind for symmetry (I2) ─────────
drop view if exists public.cases;

create view public.cases as
select
  t.id,
  t.tenant_id,
  t.ticket_type_id,
  t.parent_ticket_id,
  t.booking_bundle_id,
  -- parent_kind discriminator: cases occasionally have a booking_bundle_id
  -- (e.g. an incident raised against a specific booking). Symmetric with
  -- work_orders view; lets downstream consumers branch without re-deriving.
  case
    when t.booking_bundle_id is not null then 'booking_bundle'
    when t.parent_ticket_id is not null then 'case'
    else null
  end as parent_kind,
  t.title,
  t.description,
  t.status,
  t.status_category,
  t.waiting_reason,
  t.interaction_mode,
  t.priority,
  t.impact,
  t.urgency,
  t.requester_person_id,
  t.requested_for_person_id,
  t.location_id,
  t.asset_id,
  t.assigned_team_id,
  t.assigned_user_id,
  t.assigned_vendor_id,
  t.workflow_id,
  t.sla_id,
  t.source_channel,
  t.tags,
  t.watchers,
  t.cost,
  t.satisfaction_rating,
  t.satisfaction_comment,
  t.form_data,
  t.sla_response_due_at,
  t.sla_resolution_due_at,
  t.sla_response_breached_at,
  t.sla_resolution_breached_at,
  t.sla_at_risk,
  t.sla_paused,
  t.sla_paused_at,
  t.sla_total_paused_minutes,
  t.module_number,
  t.external_system,
  t.external_id,
  t.linked_order_line_item_id,
  t.planned_start_at,
  t.planned_duration_minutes,
  t.reclassified_at,
  t.reclassified_from_id,
  t.reclassified_reason,
  t.reclassified_by,
  t.close_reason,
  t.closed_by,
  t.created_at,
  t.updated_at,
  t.resolved_at,
  t.closed_at
from public.tickets t
where t.ticket_kind = 'case';

comment on view public.cases is
  'Step 1a (00204+00205+00208+00212) of data-model-redesign-2026-04-30.md. Read-only filtered view of tickets where ticket_kind=''case''. Direct API access is revoked; reads go through the service-role API which gates by entity visibility. Materialized into a real table at step 6.';

revoke all on public.cases from anon, authenticated, public, service_role;
grant select on public.cases to service_role;

-- ── 5. Drop orphaned tickets_visible_for_vendor (I3) ─────────
-- Confirmed orphan via repo grep: vendor-work-order.service.ts (the only
-- caller) was switched to public.work_orders + inlined vendor JOIN at
-- commit 865934e + a5cbbd2. The function definition still lived in 00188
-- + 00191 with no live callers.
drop function if exists public.tickets_visible_for_vendor(uuid, uuid);

-- ── 6. Fix UPDATE shadow to also propagate tenant_id (N2) ─────
create or replace function public.shadow_ticket_activity_update_to_activities()
returns trigger
language plpgsql
as $$
declare
  v_kind text;
begin
  select case t.ticket_kind
    when 'work_order' then 'work_order'
    else 'case'
  end into v_kind
  from public.tickets t
  where t.id = new.ticket_id;
  v_kind := coalesce(v_kind, 'ticket');

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

notify pgrst, 'reload schema';
