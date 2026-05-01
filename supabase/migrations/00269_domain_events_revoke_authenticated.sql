-- 00269_domain_events_revoke_authenticated.sql
-- Lock down public.domain_events to service_role-only.
--
-- Post-shipping review C2:
--   InvitationService writes plaintext cancel-link tokens into
--   domain_events.payload (visitor.invitation.expected event). The email
--   worker then reads them back to render the cancel URL. Migration 00019
--   created the table with a tenant_isolation RLS policy but never
--   restricted the default Postgres grants — `authenticated` and `anon`
--   both have full SELECT, plus INSERT/UPDATE/DELETE.
--
-- Verified on remote (information_schema.role_table_grants):
--   anon:          DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   authenticated: DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   service_role:  DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- That means any signed-in tenant user could
--   select payload->>'cancel_token'
--     from public.domain_events
--    where event_type = 'visitor.invitation.expected';
-- and harvest plaintext cancel tokens for every visitor in their tenant.
-- RLS only filters cross-tenant; the leak is intra-tenant by design.
--
-- Why this is the right fix vs. encrypting / rewriting the payload:
--   1. domain_events is service-role-only by intent. The API never reads
--      it from a user JWT — workers + cron + scheduled adapters all use
--      the service-role key. Removing the public grants matches actual
--      usage and is consistent with the cases/work_orders revoke pattern
--      established in 00204/00205/00208.
--   2. The cancel token leak is just one symptom. domain_events.payload
--      is a generic JSONB sink — many handlers write internal data
--      (correlation IDs, trace context, counts that hint at backlog) that
--      were never meant for tenant-user eyes. A blanket revoke fixes
--      every present + future leak in one line.
--   3. The cancel token already self-destructs at expected_at + 24h
--      (see invitation.service.ts). The leak window is bounded — but
--      that's not a reason to leave it open; it's a reason this fix is
--      sufficient on its own without requiring a token-rotation rollout.
--
-- The email worker continues to read the plaintext from the payload via
-- the service-role Supabase client. No application changes required.
--
-- Reviewer: post-shipping codex review (C2).

revoke insert, update, delete, truncate, references, trigger
  on public.domain_events
  from anon, authenticated, public;

revoke select on public.domain_events from anon, authenticated, public;

-- Belt-and-braces: ensure service_role retains full access. Default-grant
-- on this role means this is a no-op on a fresh DB, but a previous
-- accidental REVOKE could leave the worker broken. Idempotent.
grant select, insert, update, delete on public.domain_events to service_role;

comment on table public.domain_events is
  'Internal domain-event stream for workers + cron. Service-role-only access '
  '(public grants revoked in 00269 — was a JSONB-payload leak vector).';

notify pgrst, 'reload schema';
