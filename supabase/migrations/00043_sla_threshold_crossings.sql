-- SLA threshold crossings — per-fire audit + idempotency for escalation thresholds.
-- See docs/superpowers/specs/2026-04-20-sla-escalation-thresholds-design.md

create table public.sla_threshold_crossings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  sla_timer_id uuid not null references public.sla_timers(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  at_percent integer not null check (at_percent between 1 and 200),
  timer_type text not null check (timer_type in ('response', 'resolution')),
  action text not null check (action in ('notify', 'escalate', 'skipped_no_manager')),
  target_type text not null,
  target_id uuid,
  notification_id uuid references public.notifications(id),
  fired_at timestamptz not null default now(),
  unique (sla_timer_id, at_percent, timer_type)
);

alter table public.sla_threshold_crossings enable row level security;

create policy "tenant_isolation" on public.sla_threshold_crossings
  using (tenant_id = public.current_tenant_id());

create index idx_sla_crossings_timer on public.sla_threshold_crossings (sla_timer_id);
create index idx_sla_crossings_ticket on public.sla_threshold_crossings (ticket_id, fired_at desc);
create index idx_sla_crossings_tenant on public.sla_threshold_crossings (tenant_id);

-- Partial index for the threshold-pass scan in SlaService.checkBreaches.
create index idx_sla_timers_active on public.sla_timers (tenant_id, due_at)
  where breached = false and paused = false and completed_at is null;

-- One-time cleanup: drop any legacy threshold rows that lack a structured target.
-- The old shape was { at_percent, action, notify: string }; the new shape requires
-- target_type + target_id. Admins reconfigure via the new UI.
update public.sla_policies
set escalation_thresholds = (
  select coalesce(jsonb_agg(t), '[]'::jsonb)
  from jsonb_array_elements(escalation_thresholds) as t
  where t ? 'target_type'
)
where escalation_thresholds is not null
  and escalation_thresholds <> '[]'::jsonb;

notify pgrst, 'reload schema';
