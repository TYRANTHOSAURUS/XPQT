-- 00420 — REVERT 00417's catastrophic blanket EXECUTE revoke; keep only
--          the narrow, correct tickets_distinct_tags fix.
--
-- INCIDENT (2026-05-19, self-caused, user-caught, production):
-- 00417 did `REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM
-- PUBLIC, anon, authenticated`. That is fundamentally incompatible with
-- Supabase RLS: every `tenant_isolation` policy calls
-- `public.current_tenant_id()` (and others call `current_user_id()` /
-- `user_has_permission()` / `gdpr_caller_has()`), and Postgres checks
-- EXECUTE on a policy's helper functions AS THE QUERYING ROLE
-- (anon/authenticated) — even for SECURITY DEFINER functions (DEFINER
-- changes the role *inside* the body, not the EXECUTE check). So after
-- 00417 every browser / PostgREST / Supabase-Realtime read on every
-- RLS-protected table failed with `42501 permission denied for function
-- current_tenant_id` — i.e. the entire app's data "disappeared" for
-- logged-in users. `smoke:work-orders` did not catch it because it
-- exercises the NestJS API on the service_role path, not the browser
-- path; the browser smoke probes asserted *denial* and mis-read it as
-- success rather than testing a normal authenticated RLS read as a
-- regression.
--
-- Root lesson: NEVER blanket-revoke EXECUTE on public functions from
-- anon/authenticated in a Supabase project. Lock individual proven-risky
-- SECURITY DEFINER RPCs per-function (the audit's own canonical
-- pattern), never schema-wide.
--
-- This migration:
--  1. Fully reverts 00417 — restores the Supabase-default posture that
--     RLS depends on (EXECUTE on all public routines + default privs to
--     anon, authenticated). This returns the broad RPC-EXECUTE surface
--     to its PRE-SESSION state (tracked-P2 as originally framed — the
--     blanket close is infeasible and is withdrawn).
--  2. Re-applies ONLY the narrow, correct, verified-safe fix for the one
--     codex-found LIVE cross-tenant leak: `tickets_distinct_tags(uuid)`
--     — a standalone SECURITY DEFINER RPC NOT referenced by any RLS
--     policy and NOT called browser-direct by the app (the API uses
--     service_role). Revoked from PUBLIC/anon/authenticated, granted to
--     service_role. This is the audit's documented per-function pattern
--     and has zero RLS/Realtime blast radius.
--  3. 00415 (table-DML write revoke, SELECT kept) is unaffected and
--     correct — it did NOT cause the incident; not touched here.
--
-- Idempotent. The remote DB was already hand-restored to this exact
-- state during the incident; applying this migration is a consistent
-- no-op against that state and the authoritative record going forward.

-- (1) Undo 00417's blanket revoke — restore the RLS-critical default.
grant execute on all routines in schema public to anon, authenticated;
alter default privileges in schema public
  grant execute on routines to anon, authenticated;

-- (2) Re-apply ONLY the narrow correct fix for the proven live leak.
revoke execute on function public.tickets_distinct_tags(uuid)
  from public, anon, authenticated;
grant execute on function public.tickets_distinct_tags(uuid)
  to service_role;

notify pgrst, 'reload schema';
