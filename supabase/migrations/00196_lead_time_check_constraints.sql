-- 00196_lead_time_check_constraints.sql
-- Codex 2026-04-30 review: the API enforces 0..1440 minutes (24h) on the
-- two lead-time columns introduced in Slice 2, but the schema does not.
-- This repo applies migrations directly via psql in dev, and any future
-- bulk import / data-fix script that bypasses the API would persist
-- nonsensical values. Add CHECK constraints so the floor is in the
-- database, not just the application.

alter table public.service_rules
  add constraint service_rules_internal_setup_lead_time_range
  check (
    internal_setup_lead_time_minutes is null
    or (internal_setup_lead_time_minutes >= 0
        and internal_setup_lead_time_minutes <= 1440)
  );

alter table public.location_service_routing
  add constraint location_service_routing_default_lead_time_range
  check (default_lead_time_minutes >= 0 and default_lead_time_minutes <= 1440);

notify pgrst, 'reload schema';
