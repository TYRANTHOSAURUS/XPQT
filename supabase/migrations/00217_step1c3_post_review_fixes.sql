-- Step 1c.0–1c.3 post-full-review fixes.
--
-- Adversarial subagent review of commit bbbb0cd surfaced 9 issues in the
-- materialization scaffolding. This migration addresses the ones that are
-- SQL-fixable. Doc-only fixes (gate criteria, monitoring SLO, plan
-- annotations) are in the same commit as plan/doc edits.
--
-- 1. (CRITICAL) module_number nullable + no uniqueness on work_orders_new.
--    On tickets (00139), module_number is NOT NULL with UNIQUE per
--    (tenant_id, ticket_kind, module_number). On work_orders_new it was
--    nullable bigint with no default and no uniqueness. At 1c.4 cutover,
--    writers omitting the column would silently insert NULL without
--    per-tenant uniqueness. Add NOT NULL + UNIQUE.
--
-- 2. (CRITICAL) Loop guard too coarse. The forward trigger uses
--    pg_trigger_depth() > 1 to skip nested invocations. This works for
--    the reverse trigger to come, but ALSO blocks legitimate writes
--    nested inside other triggers (e.g. workflow engine create_child_tasks
--    inside a parent trigger). Replace with a session-local GUC that is
--    set ONLY by the reverse trigger (1c.3.5).
--
-- 3. (CRITICAL) Tenant-id integrity. work_orders_new.tenant_id is required
--    not-null (already enforced by NOT NULL on the column) but there's no
--    constraint that asserts it matches the legacy_ticket_id source ticket.
--    Add a constraint trigger that enforces match-on-write.
--
-- 4. (IMPORTANT) set_updated_at trigger overwrites shadow's updated_at.
--    The shadow forward trigger sets updated_at = excluded.updated_at
--    (the source tickets.updated_at), but BEFORE UPDATE set_updated_at()
--    immediately overwrites it with now(). Result: updated_at always
--    drifts to "shadow ran at" time. Drop the set_updated_at trigger;
--    the shadow always provides updated_at.
--
-- 5. (IMPORTANT) service_role had INSERT/UPDATE/DELETE prematurely. The
--    trigger runs as table owner (postgres), so service_role writes are
--    not needed during 1c.3. Revoke until 1c.4 stages explicit writers.
--
-- 6. (IMPORTANT) legacy_ticket_id FK was ON DELETE SET NULL. Combined
--    with the shadow's DELETE trigger this creates ambiguous order:
--    if SET NULL fires before AFTER DELETE trigger, the trigger's
--    DELETE WHERE legacy_ticket_id = old.id finds no row (already
--    nulled) — silent orphan in work_orders_new. Change to RESTRICT
--    so the FK enforces invariant ordering: source ticket can only be
--    deleted if no work_orders_new row points at it, and the shadow
--    DELETE trigger does the cleanup atomically.
--
-- 7. (IMPORTANT) Divergence view filtered NULL legacy_ticket_id which
--    would mask post-1c.4 rows. Drop that filter so the view stays
--    correct through the writer flip.
--
-- 8. (IMPORTANT) parent_kind nullable on the table is currently
--    unreachable (00208's constraint on tickets enforces exactly one
--    parent for work_orders, so the trigger always derives a non-null
--    kind). But the constraint structure allows NULL as defense-in-depth.
--    Tighten with a CHECK that parent_kind NOT NULL when either FK is set.
--
-- 9. (IMPORTANT) ANALYZE after backfill is missing. Phase 1c.2's planner
--    statistics aren't updated until autovacuum runs, which on a quiet
--    table can take days. Add explicit ANALYZE.

-- ── 1. module_number constraints ──────────────────────────────
-- All backfilled rows have module_number from tickets (which is NOT NULL),
-- so no rows would violate NOT NULL today. Add the constraint.
alter table public.work_orders_new
  alter column module_number set not null;

create unique index work_orders_new_tenant_module_uniq
  on public.work_orders_new (tenant_id, module_number);

-- ── 2. Replace pg_trigger_depth guard with session GUC ────────
-- The reverse trigger (to come in 1c.3.5) will set this GUC before
-- writing back to tickets, so the forward trigger knows to skip. The
-- GUC defaults unset, so normal application writes still propagate.
-- A nested-but-legitimate write (workflow create_child_tasks etc.)
-- never sets the GUC, so its propagation is preserved.
create or replace function public.shadow_ticket_to_work_orders_new()
returns trigger
language plpgsql
as $$
begin
  -- Loop-prevention: only skip when the reverse shadow explicitly
  -- announced itself via the GUC. Other nested-trigger paths still
  -- propagate.
  if coalesce(current_setting('xpqt.dual_write_reverse_active', true), 'off') = 'on' then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    if old.ticket_kind = 'work_order' then
      delete from public.work_orders_new where legacy_ticket_id = old.id;
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.ticket_kind = 'work_order' and new.ticket_kind != 'work_order' then
    delete from public.work_orders_new where legacy_ticket_id = new.id;
    return new;
  end if;

  if new.ticket_kind != 'work_order' then
    return new;
  end if;

  insert into public.work_orders_new (
    id, tenant_id, ticket_type_id, parent_kind, parent_case_id, booking_bundle_id,
    title, description, status, status_category, waiting_reason, interaction_mode,
    priority, impact, urgency, requester_person_id, requested_for_person_id,
    location_id, asset_id, assigned_team_id, assigned_user_id, assigned_vendor_id,
    workflow_id, sla_id, source_channel, tags, watchers, cost,
    satisfaction_rating, satisfaction_comment, form_data,
    sla_response_due_at, sla_resolution_due_at, sla_response_breached_at,
    sla_resolution_breached_at, sla_at_risk, sla_paused, sla_paused_at,
    sla_total_paused_minutes, module_number, external_system, external_id,
    linked_order_line_item_id, planned_start_at, planned_duration_minutes,
    reclassified_at, reclassified_from_id, reclassified_reason, reclassified_by,
    close_reason, closed_by, created_at, updated_at, resolved_at, closed_at,
    legacy_ticket_id
  ) values (
    new.id, new.tenant_id, new.ticket_type_id,
    case
      when new.booking_bundle_id is not null then 'booking_bundle'
      when new.parent_ticket_id is not null  then 'case'
      else null
    end,
    new.parent_ticket_id, new.booking_bundle_id,
    new.title, new.description, new.status, new.status_category, new.waiting_reason,
    new.interaction_mode, new.priority, new.impact, new.urgency,
    new.requester_person_id, new.requested_for_person_id, new.location_id,
    new.asset_id, new.assigned_team_id, new.assigned_user_id, new.assigned_vendor_id,
    new.workflow_id, new.sla_id, new.source_channel,
    coalesce(new.tags, '{}'::text[]), coalesce(new.watchers, '{}'::uuid[]),
    new.cost, new.satisfaction_rating, new.satisfaction_comment, new.form_data,
    new.sla_response_due_at, new.sla_resolution_due_at, new.sla_response_breached_at,
    new.sla_resolution_breached_at, new.sla_at_risk, new.sla_paused, new.sla_paused_at,
    new.sla_total_paused_minutes, new.module_number, new.external_system, new.external_id,
    new.linked_order_line_item_id, new.planned_start_at, new.planned_duration_minutes,
    new.reclassified_at, new.reclassified_from_id, new.reclassified_reason, new.reclassified_by,
    new.close_reason, new.closed_by, new.created_at, new.updated_at, new.resolved_at, new.closed_at,
    new.id
  )
  on conflict (legacy_ticket_id) do update set
    tenant_id = excluded.tenant_id,
    ticket_type_id = excluded.ticket_type_id,
    parent_kind = excluded.parent_kind,
    parent_case_id = excluded.parent_case_id,
    booking_bundle_id = excluded.booking_bundle_id,
    title = excluded.title,
    description = excluded.description,
    status = excluded.status,
    status_category = excluded.status_category,
    waiting_reason = excluded.waiting_reason,
    interaction_mode = excluded.interaction_mode,
    priority = excluded.priority,
    impact = excluded.impact,
    urgency = excluded.urgency,
    requester_person_id = excluded.requester_person_id,
    requested_for_person_id = excluded.requested_for_person_id,
    location_id = excluded.location_id,
    asset_id = excluded.asset_id,
    assigned_team_id = excluded.assigned_team_id,
    assigned_user_id = excluded.assigned_user_id,
    assigned_vendor_id = excluded.assigned_vendor_id,
    workflow_id = excluded.workflow_id,
    sla_id = excluded.sla_id,
    source_channel = excluded.source_channel,
    tags = excluded.tags,
    watchers = excluded.watchers,
    cost = excluded.cost,
    satisfaction_rating = excluded.satisfaction_rating,
    satisfaction_comment = excluded.satisfaction_comment,
    form_data = excluded.form_data,
    sla_response_due_at = excluded.sla_response_due_at,
    sla_resolution_due_at = excluded.sla_resolution_due_at,
    sla_response_breached_at = excluded.sla_response_breached_at,
    sla_resolution_breached_at = excluded.sla_resolution_breached_at,
    sla_at_risk = excluded.sla_at_risk,
    sla_paused = excluded.sla_paused,
    sla_paused_at = excluded.sla_paused_at,
    sla_total_paused_minutes = excluded.sla_total_paused_minutes,
    module_number = excluded.module_number,
    external_system = excluded.external_system,
    external_id = excluded.external_id,
    linked_order_line_item_id = excluded.linked_order_line_item_id,
    planned_start_at = excluded.planned_start_at,
    planned_duration_minutes = excluded.planned_duration_minutes,
    reclassified_at = excluded.reclassified_at,
    reclassified_from_id = excluded.reclassified_from_id,
    reclassified_reason = excluded.reclassified_reason,
    reclassified_by = excluded.reclassified_by,
    close_reason = excluded.close_reason,
    closed_by = excluded.closed_by,
    updated_at = excluded.updated_at,
    resolved_at = excluded.resolved_at,
    closed_at = excluded.closed_at;

  return new;
end;
$$;

comment on function public.shadow_ticket_to_work_orders_new() is
  'Step 1c.3 forward dual-write trigger. Mirrors writes on tickets where ticket_kind=work_order into work_orders_new. Loop-prevention via xpqt.dual_write_reverse_active GUC (set ONLY by 1c.3.5 reverse trigger). Drops at phase 1c.10c.';

-- ── 3. Tenant-id integrity (constraint trigger) ──────────────
create or replace function public.assert_work_orders_new_tenant_matches_source()
returns trigger
language plpgsql
as $$
declare
  v_source_tenant uuid;
begin
  if new.legacy_ticket_id is null then
    -- Post-1c.4 path: writers create work_orders_new rows directly with
    -- no source ticket. No source row to compare against; rely on the
    -- application layer to set tenant_id correctly.
    return new;
  end if;
  select tenant_id into v_source_tenant
    from public.tickets where id = new.legacy_ticket_id;
  if v_source_tenant is null then
    raise exception 'work_orders_new.tenant_id integrity: legacy_ticket_id % does not exist in tickets', new.legacy_ticket_id;
  end if;
  if v_source_tenant != new.tenant_id then
    raise exception 'work_orders_new.tenant_id integrity: source ticket tenant % does not match work_orders_new tenant %',
      v_source_tenant, new.tenant_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_won_tenant_integrity on public.work_orders_new;
create trigger trg_won_tenant_integrity
before insert or update of tenant_id, legacy_ticket_id on public.work_orders_new
for each row execute function public.assert_work_orders_new_tenant_matches_source();

-- ── 4. Drop set_updated_at trigger (shadow always provides) ──
drop trigger if exists set_work_orders_new_updated_at on public.work_orders_new;

-- ── 5. Revoke premature service_role writes ──────────────────
revoke insert, update, delete on public.work_orders_new from service_role;
-- service_role keeps SELECT only during 1c.3.

-- ── 6. legacy_ticket_id FK: SET NULL → RESTRICT ──────────────
-- Drop and re-add. The shadow trigger handles deletes atomically; the FK
-- enforces invariant ordering by refusing to delete a tickets row that
-- still has a work_orders_new mirror. (In practice, the trigger fires
-- and the mirror is gone before the FK check runs, but this defends
-- against a future code path that bypasses the trigger.)
alter table public.work_orders_new
  drop constraint work_orders_new_legacy_ticket_id_fkey;
alter table public.work_orders_new
  add constraint work_orders_new_legacy_ticket_id_fkey
  foreign key (legacy_ticket_id) references public.tickets(id) on delete restrict;

-- ── 7. Divergence view: drop NULL filter so it works post-1c.4 ─
create or replace view public.work_orders_dual_write_divergence_v as
with
counts as (
  select 'counts_mismatch' as kind,
         abs(
           (select count(*) from public.tickets where ticket_kind = 'work_order')
           - (select count(*) from public.work_orders_new where legacy_ticket_id is not null)
         ) as divergence_count
),
only_in_tickets as (
  select 'only_in_tickets' as kind,
         count(*) as divergence_count
  from public.tickets t
  where t.ticket_kind = 'work_order'
    and not exists (
      select 1 from public.work_orders_new won
       where won.legacy_ticket_id = t.id
    )
),
only_in_won as (
  -- Pre-1c.4: every work_orders_new row should have legacy_ticket_id set.
  --           A row missing it is divergent.
  -- Post-1c.4: rows created by direct writers will have legacy_ticket_id
  --            null; those should NOT count as divergent because they
  --            never had a tickets source.
  -- Detection: rows where legacy_ticket_id IS NOT NULL but no matching
  --            tickets row.
  select 'only_in_won' as kind,
         count(*) as divergence_count
  from public.work_orders_new won
  where won.legacy_ticket_id is not null
    and not exists (
      select 1 from public.tickets t
       where t.id = won.legacy_ticket_id
         and t.ticket_kind = 'work_order'
    )
),
won_missing_legacy as (
  -- Pre-1c.4 invariant: every row in work_orders_new MUST have
  -- legacy_ticket_id. Post-1c.4 this becomes valid for direct writes.
  -- During the bridge, this row counts as a divergence.
  select 'won_missing_legacy' as kind,
         count(*) as divergence_count
  from public.work_orders_new won
  where won.legacy_ticket_id is null
)
select * from counts
union all
select * from only_in_tickets
union all
select * from only_in_won
union all
select * from won_missing_legacy;

comment on view public.work_orders_dual_write_divergence_v is
  'Step 1c.3 dual-write monitoring (00216 + 00217). Each row reports a divergence-count by class. Pre-1c.4 (current bridge): all four classes should be zero. Post-1c.4 (writers flipped): won_missing_legacy is allowed to be non-zero. Daily cron alerts on counts_mismatch / only_in_tickets / only_in_won > 0 always. Drops at phase 1c.10c.';

-- ── 8. parent_kind invariant: NOT NULL when FKs are set ───────
-- Already enforced by work_orders_new_kind_matches_fk: any row with a
-- parent FK set must have parent_kind set to the matching value.
-- The (parent_kind=null and both FKs null) case is the legitimate
-- orphan WO; that stays. No DDL change needed here — documenting in
-- the migration so future reviewers don't repeat the question.

-- ── 9. ANALYZE for fresh planner statistics ──────────────────
analyze public.work_orders_new;

notify pgrst, 'reload schema';
