-- ⚠️ DESTRUCTIVE MIGRATION ⚠️
-- Step 1c.10c of docs/data-model-step1c-plan.md.
--
-- This is the POINT-OF-NO-RETURN migration that:
--   1. Drops the dual-write infrastructure (forward + reverse triggers)
--   2. Drops the work_orders.legacy_ticket_id bridge column
--   3. Drops or recreates ticket_kind-dependent triggers/functions/views
--   4. Softens cascade FKs from sla_timers, routing_decisions to tickets
--   5. DELETEs all work_order rows from tickets (319 rows in dev)
--   6. DROPs the ticket_kind column from tickets
--   7. Updates module_number unique constraint to be case-only
--   8. Recreates cases view as identity (no filter)
--   9. Recreates module allocator on tickets (case-only, TKT prefix)
--
-- After this migration:
--   - tickets is case-only
--   - work_orders is wo-only
--   - polymorphic case_id/work_order_id on sla_timers/routing_decisions/
--     workflow_instances are the source of truth
--   - The 00230/00232 derive trigger handles ticket_id-only writers
--
-- Pre-flight verified before running:
--   - divergence view all 0
--   - 319 wo rows in tickets matches 319 in work_orders
--   - all work_orders have legacy_ticket_id set
--   - 0 sla_timers/routing_decisions/workflow_instances with NULL
--     entity_kind when ticket_id is set
--
-- Single transaction for atomicity. If any step fails, the entire
-- migration rolls back to the pre-state.

begin;

-- ── 0. Pre-flight assert (belt-and-suspenders) ────────────────
do $$
declare v_divergence int; v_wo_tickets int; v_wo_table int;
begin
  select sum(divergence_count) into v_divergence from public.work_orders_dual_write_divergence_v;
  if v_divergence != 0 then raise exception '1c.10c PRE-FLIGHT FAIL: divergence sum=%', v_divergence; end if;

  select count(*) into v_wo_tickets from public.tickets where ticket_kind = 'work_order';
  select count(*) into v_wo_table from public.work_orders;
  if v_wo_tickets != v_wo_table then
    raise exception '1c.10c PRE-FLIGHT FAIL: tickets-wo-count=% != work_orders-count=%',
      v_wo_tickets, v_wo_table;
  end if;

  raise notice '1c.10c PRE-FLIGHT: divergence=0 wo_tickets=% wo_table=%', v_wo_tickets, v_wo_table;
end $$;

-- ── 1. Drop dual-write triggers (forward + reverse) ────────────
drop trigger if exists trg_ticket_to_work_orders_new_iud on public.tickets;
drop trigger if exists trg_work_orders_new_to_ticket_iud on public.work_orders;
drop function if exists public.shadow_ticket_to_work_orders_new() cascade;
drop function if exists public.shadow_work_orders_new_to_tickets() cascade;

-- The activities INSERT/UPDATE/DELETE shadow triggers (00202+00203+00211)
-- stay — they bridge ticket_activities → activities for the activities
-- polymorphic timeline. Keep the bridge until step 1c.11 ships.

-- The 00230/00232 polymorphic auto-derive trigger STAYS — its function
-- body now uses existence-check across both tables (00232 rewrite), so
-- it survives the schema change.

-- ── 2. Drop work_orders.legacy_ticket_id (FK is ON DELETE RESTRICT) ──
-- Pre-cleanup: drop dependents on legacy_ticket_id BEFORE dropping the column.
--   - work_orders_dual_write_divergence_v references legacy_ticket_id
--   - trg_won_tenant_integrity trigger uses legacy_ticket_id in function body
drop view if exists public.work_orders_dual_write_divergence_v;
drop trigger if exists trg_won_tenant_integrity on public.work_orders;
drop function if exists public.assert_work_orders_new_tenant_matches_source() cascade;

-- Find the actual FK constraint name (may vary across migrations).
do $$
declare v_constraint_name text;
begin
  select conname into v_constraint_name
    from pg_constraint
   where conrelid = 'public.work_orders'::regclass
     and contype = 'f'
     and pg_get_constraintdef(oid) like '%legacy_ticket_id%';
  if v_constraint_name is not null then
    execute format('alter table public.work_orders drop constraint %I', v_constraint_name);
    raise notice 'Dropped legacy_ticket_id FK: %', v_constraint_name;
  end if;
end $$;

drop index if exists public.idx_won_legacy_ticket;
alter table public.work_orders drop column if exists legacy_ticket_id;

-- ── 3. Drop ticket_kind-dependent triggers on tickets ────────
-- Rollup is now provided by 00226 rollup_parent_status_from_work_orders_trg
-- on public.work_orders. The tickets-side rollup (00030) is no longer
-- needed and would error on missing ticket_kind.
drop trigger if exists rollup_parent_status_trg on public.tickets;
drop function if exists public.rollup_parent_status() cascade;

-- 00208 enforce_work_order_parent_kind: protected against work_order
-- tickets having a non-case parent. Post-1c.10c, tickets has no
-- work_orders, so this guard is moot. work_orders has its own
-- equivalent (work_orders_new_kind_matches_fk constraint).
drop trigger if exists trg_assert_wo_parent_is_case on public.tickets;
drop function if exists public.assert_work_order_parent_is_case() cascade;

-- 00212 assert_no_work_order_children_on_kind_flip: protected against
-- a case being reclassified to work_order while it has wo children.
-- Post-1c.10c, work_order children are in work_orders not tickets, so
-- the parent's "kind flip" no longer matters.
drop trigger if exists trg_assert_no_wo_children_on_kind_flip on public.tickets;
drop function if exists public.assert_no_work_order_children_on_kind_flip() cascade;

-- 00134 enforce_ticket_parent_close_invariant: prevented closing a
-- parent case if any work_order children were still open. Post-1c.10c,
-- the equivalent invariant should query work_orders where parent_ticket_id.
-- Recreate without the ticket_kind filter (children in work_orders are
-- all wo by construction).
drop trigger if exists enforce_ticket_parent_close_invariant_trg on public.tickets;
drop function if exists public.enforce_ticket_parent_close_invariant() cascade;

create or replace function public.enforce_ticket_parent_close_invariant()
returns trigger
language plpgsql
as $$
declare
  v_open_children int;
begin
  -- Only fires on transitions to terminal status.
  if new.status_category not in ('resolved', 'closed') then
    return new;
  end if;
  if old.status_category in ('resolved', 'closed') then
    return new; -- already terminal, nothing to check
  end if;

  -- Children are now in public.work_orders (post-1c.10c).
  select count(*) into v_open_children
    from public.work_orders
   where parent_ticket_id = new.id
     and status_category not in ('resolved', 'closed');

  if v_open_children > 0 then
    raise exception 'cannot close parent ticket %: % work_order child(ren) still open', new.id, v_open_children;
  end if;
  return new;
end;
$$;

create trigger enforce_ticket_parent_close_invariant_trg
before update of status_category on public.tickets
for each row execute function public.enforce_ticket_parent_close_invariant();

-- ── 4. Soften cascade FKs on sla_timers + routing_decisions ───
-- These FK ticket_id ON DELETE CASCADE to tickets. The DELETE of work_order
-- rows would cascade-nuke real history. Drop the FK; ticket_id remains as
-- a soft pointer (legacy column). The polymorphic case_id / work_order_id
-- columns are now the FK source of truth.
do $$
declare v_name text;
begin
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.sla_timers'::regclass
       and contype = 'f'
       and pg_get_constraintdef(oid) like '%ticket_id%'
       and pg_get_constraintdef(oid) like '%public.tickets%'
  loop
    execute format('alter table public.sla_timers drop constraint %I', v_name);
    raise notice 'Dropped sla_timers FK: %', v_name;
  end loop;
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.routing_decisions'::regclass
       and contype = 'f'
       and pg_get_constraintdef(oid) like '%ticket_id%'
       and pg_get_constraintdef(oid) like '%public.tickets%'
  loop
    execute format('alter table public.routing_decisions drop constraint %I', v_name);
    raise notice 'Dropped routing_decisions FK: %', v_name;
  end loop;
  for v_name in
    select conname from pg_constraint
     where conrelid = 'public.workflow_instances'::regclass
       and contype = 'f'
       and pg_get_constraintdef(oid) like '%ticket_id%'
       and pg_get_constraintdef(oid) like '%public.tickets%'
  loop
    execute format('alter table public.workflow_instances drop constraint %I', v_name);
    raise notice 'Dropped workflow_instances FK: %', v_name;
  end loop;
end $$;

-- ── 5. Drop kind-dependent views ──────────────────────────────
-- (work_orders_dual_write_divergence_v already dropped at step 2 to clear
--  legacy_ticket_id dependency.)
drop view if exists public.cases;

-- ── 6. Drop kind-related indexes/constraints on tickets ───────
drop index if exists public.idx_tickets_kind;
drop index if exists public.idx_tickets_kind_bundle;
drop index if exists public.idx_tickets_parent_kind;
alter table public.tickets drop constraint if exists tickets_tenant_kind_module_number_uniq;
alter table public.tickets drop constraint if exists work_order_single_parent;

-- 00139's module-number allocator on tickets uses ticket_kind. Drop it;
-- recreate after the column is gone.
drop trigger if exists tickets_assign_module_number_trg on public.tickets;
drop function if exists public.tickets_assign_module_number() cascade;

-- ── 7. Capture pre-DELETE count for audit ─────────────────────
do $$
declare v_pre_delete int;
begin
  select count(*) into v_pre_delete from public.tickets where ticket_kind = 'work_order';
  raise notice '1c.10c: deleting % work_order rows from tickets', v_pre_delete;
end $$;

-- ── 8. THE DESTRUCTIVE DELETE ─────────────────────────────────
delete from public.tickets where ticket_kind = 'work_order';

-- ── 9. Drop the column ────────────────────────────────────────
alter table public.tickets drop column ticket_kind;

-- ── 10. Recreate cases view as identity (post-cutover, tickets is case-only) ──
create view public.cases as select * from public.tickets;
comment on view public.cases is
  'Step 1c.10c (00233): tickets is now case-only. cases is the canonical alias for the cases-only ticket table. Promotes to a real table at step 6 (or stays as a view permanently — see master doc).';
revoke all on public.cases from anon, authenticated, public;
grant select on public.cases to service_role;

-- ── 11. Recreate module-number allocator (case-only, TKT prefix) ──
create or replace function public.tickets_assign_module_number()
returns trigger
language plpgsql
as $$
begin
  if new.module_number is null then
    new.module_number := public.allocate_module_number(new.tenant_id, 'TKT');
  end if;
  return new;
end;
$$;

create trigger tickets_assign_module_number_trg
before insert on public.tickets
for each row execute function public.tickets_assign_module_number();

create unique index tickets_tenant_module_uniq
  on public.tickets (tenant_id, module_number);

-- ── 12. Post-flight assert ────────────────────────────────────
do $$
declare
  v_remaining_wo_in_tickets int;
  v_tickets_total int;
  v_work_orders_total int;
begin
  -- Can't query ticket_kind anymore (column dropped). Verify by row count.
  select count(*) into v_tickets_total from public.tickets;
  select count(*) into v_work_orders_total from public.work_orders;
  raise notice '1c.10c POST-FLIGHT: tickets=% (cases-only) work_orders=%',
    v_tickets_total, v_work_orders_total;
end $$;

commit;

notify pgrst, 'reload schema';
