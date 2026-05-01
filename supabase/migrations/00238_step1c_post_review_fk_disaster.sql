-- ⚠️ DATA-LOSS RECOVERY MIGRATION ⚠️
--
-- Codex round 4 caught a catastrophic miss in 00233's FK-softening
-- section. The DO block used the same broken `pg_get_constraintdef like
-- '%public.tickets%'` pattern that made 00234 a no-op. Result: the FK
-- drops on sla_timers, routing_decisions, workflow_instances also DID
-- NOTHING when 00233 ran. The DELETE FROM tickets WHERE ticket_kind=
-- 'work_order' then cascade-deleted every dependent row tied to a
-- work-order ticket via the still-CASCADE FK.
--
-- Verified data loss in dev:
--   sla_timers: pre=1130 (484 case + 646 wo) / post=484 (case only)
--   → 646 work-order SLA timers deleted by cascade. NOT RECOVERABLE
--      in dev. Production needs point-in-time recovery if any rows
--      were lost there.
--
-- Lucky in dev (no work-order rows existed):
--   routing_decisions: 243 case / 0 wo → 0 lost
--   workflow_instances: 216 case / 0 wo → 0 lost
--
-- Drop the FKs NOW so any future DELETE on tickets doesn't trigger
-- more cascades. Drop by EXPLICIT NAME (the only reliable way) — the
-- LIKE pattern bug burned us twice (00234, 00233). New constraint
-- names are auto-named by Postgres so they're predictable.
--
-- Also drop the case_id ON DELETE CASCADE FK on the same tables —
-- that's a future hazard if a tickets case is ever deleted while
-- timers exist.
--
-- Add CI smoke later (out of scope for this hotfix).

-- ── sla_timers ────────────────────────────────────────────────
alter table public.sla_timers
  drop constraint if exists sla_timers_ticket_id_fkey,
  drop constraint if exists sla_timers_case_id_fkey,
  drop constraint if exists sla_timers_work_order_id_fkey;

-- Re-add case_id and work_order_id FKs without CASCADE.
-- ticket_id stays FK-less (legacy soft pointer).
alter table public.sla_timers
  add constraint sla_timers_case_id_fkey
    foreign key (case_id) references public.tickets(id) on delete set null,
  add constraint sla_timers_work_order_id_fkey
    foreign key (work_order_id) references public.work_orders(id) on delete set null;

-- ── routing_decisions ─────────────────────────────────────────
alter table public.routing_decisions
  drop constraint if exists routing_decisions_ticket_id_fkey,
  drop constraint if exists routing_decisions_case_id_fkey,
  drop constraint if exists routing_decisions_work_order_id_fkey;

alter table public.routing_decisions
  add constraint routing_decisions_case_id_fkey
    foreign key (case_id) references public.tickets(id) on delete set null,
  add constraint routing_decisions_work_order_id_fkey
    foreign key (work_order_id) references public.work_orders(id) on delete set null;

-- ── workflow_instances ────────────────────────────────────────
alter table public.workflow_instances
  drop constraint if exists workflow_instances_ticket_id_fkey,
  drop constraint if exists fk_wi_ticket,
  drop constraint if exists workflow_instances_case_id_fkey,
  drop constraint if exists workflow_instances_work_order_id_fkey;

alter table public.workflow_instances
  add constraint workflow_instances_case_id_fkey
    foreign key (case_id) references public.tickets(id) on delete set null,
  add constraint workflow_instances_work_order_id_fkey
    foreign key (work_order_id) references public.work_orders(id) on delete set null;

-- Verify post-state
do $$
declare v_cnt int;
begin
  select count(*) into v_cnt from pg_constraint
   where conrelid in (
     'public.sla_timers'::regclass,
     'public.routing_decisions'::regclass,
     'public.workflow_instances'::regclass
   )
   and contype = 'f'
   and pg_get_constraintdef(oid) like '%REFERENCES tickets(id)%'
   and pg_get_constraintdef(oid) like '%CASCADE%';
  if v_cnt > 0 then
    raise exception '00238 FAIL: % CASCADE FKs to tickets still remain', v_cnt;
  end if;
  raise notice '00238: 0 CASCADE FKs to tickets remain';
end $$;

notify pgrst, 'reload schema';
