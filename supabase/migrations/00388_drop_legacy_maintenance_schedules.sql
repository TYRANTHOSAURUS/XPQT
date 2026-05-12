-- Slice C — drop legacy maintenance_schedules (00016).
--
-- Spec: ai/slice-c-plan.md §2 question 5 + §3 (lines 47, 159-161, 172).
--
-- 00016_maintenance_schedules.sql created the table with no other live
-- references. The only on-record use is in 00100_seed_centralised_
-- example_reset.sql:69 (a `delete from public.maintenance_schedules
-- where tenant_id = t` line that cascade now handles for us). Zero
-- service code touches the table; zero rows present in the remote
-- (PG count 2026-05-13 = 0).
--
-- Per `.claude/CLAUDE.md` "no legacy preservation" + the slice-c
-- decision matrix question 5, drop cleanly. Cascade carries away the
-- redundant trigger (`set_ms_updated_at`) + the RLS policy.

drop table if exists public.maintenance_schedules cascade;

notify pgrst, 'reload schema';
