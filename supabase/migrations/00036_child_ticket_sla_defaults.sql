-- 00036_child_ticket_sla_defaults.sql
-- Adds nullable default SLA policy columns to vendors and teams.
-- Used by DispatchService.resolveChildSla as fallback when no explicit
-- sla_id is supplied at child-ticket dispatch.

alter table vendors
  add column default_sla_policy_id uuid references sla_policies(id);

alter table teams
  add column default_sla_policy_id uuid references sla_policies(id);

-- Help PostgREST cache pick up the new columns immediately on reload.
notify pgrst, 'reload schema';
