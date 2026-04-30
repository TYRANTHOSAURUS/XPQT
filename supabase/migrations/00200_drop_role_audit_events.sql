-- Drop the legacy role_audit_events table.
--
-- Migration 00192 backfilled all rows into audit_events and re-pointed the
-- TS layer (UserManagementService.emitAudit / listRoleAuditEvents) at the
-- unified table via partial indexes. The source table was intentionally
-- left in place to survive the rolling API deploy without crashing
-- in-flight binaries that still wrote to it. That rollout has settled
-- (verified 2026-05-14, ~2 weeks after slice 2 merge db957ca on
-- 2026-04-30); no code path references this table any more.
--
-- CASCADE to take any FK / view dependents with it. PostgREST schema
-- reload at the end so the API instances drop the cached relation.

begin;

drop table if exists public.role_audit_events cascade;

notify pgrst, 'reload schema';

commit;
