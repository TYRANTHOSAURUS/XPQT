-- 00099_scope_override_scheduled_handoffs.sql
-- Codex review of commit 89df35c: fix #5 (temporal-overlap service check) was
-- based on a false premise — the 00091 partial-unique indexes
-- `uniq_rt_override_active_{tenant,space,group}` reject ANY second active=true
-- row on the same (request_type, scope, scope-target) regardless of dates.
-- That makes scheduled handoffs impossible (admin can't prepare "next month's
-- override" with active=true + future starts_at while the current one is
-- still active).
--
-- Drop the DB-level partial uniques. The service-layer
-- validateNoTemporalOverlap check in RequestTypeService.putScopeOverrides
-- becomes the sole arbiter: it allows multiple active rows as long as their
-- [starts_at, ends_at) windows don't intersect. The resolver's precedence
-- function already filters by `active AND starts_at<=now() AND ends_at>now()`
-- so at most one row is ever in-effect at runtime; `id ASC` breaks any
-- residual tie deterministically.

drop index if exists public.uniq_rt_override_active_tenant;
drop index if exists public.uniq_rt_override_active_space;
drop index if exists public.uniq_rt_override_active_group;

notify pgrst, 'reload schema';
