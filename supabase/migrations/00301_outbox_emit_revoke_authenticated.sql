-- Outbox foundation amendment — revoke authenticated EXECUTE on outbox.emit
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §2.6 (grants).
-- Codex v3 review finding: I3 — the foundation migration
-- (`supabase/migrations/00299_outbox_foundation.sql:348`) granted EXECUTE on
-- `outbox.emit` to the `authenticated` role with the comment "future per-user
-- RPC bodies can emit". That claim is false: `outbox.emit` is SECURITY
-- INVOKER and `authenticated` has NO direct DML on `outbox.events` (the
-- migration explicitly only grants the table to `service_role`). So an
-- authenticated caller CAN execute the function, but the underlying INSERT
-- fails inside it — a misleading API surface.
--
-- Fix (path A): tighten the grant. `authenticated` loses EXECUTE on both
-- `outbox.emit` and `outbox.mark_consumed`. The contract becomes "outbox is
-- service_role only". Today's backend path is service_role anyway (the worker
-- and the boundary-side emit calls). If a real user-emit case appears later,
-- the fix is an explicit `outbox.emit_as_user(...)` SECURITY DEFINER wrapper
-- that validates `current_setting('app.tenant_id')` and is grant-able to
-- `authenticated` by name — that's a follow-up, not a precondition.

revoke execute on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz)
  from authenticated;

revoke execute on function outbox.mark_consumed(text, uuid, text)
  from authenticated;

-- Re-state the canonical comment so the contract is explicit at the schema
-- level (the misleading "future per-user RPC bodies can emit" rationale in
-- 00299's grants block is now superseded).
comment on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz) is
  'Canonical entry point for emitting domain events. SECURITY INVOKER, service_role only. authenticated callers MUST go through a SECURITY DEFINER wrapper that validates the caller''s tenant context — none ships today; add `outbox.emit_as_user(...)` if a real user-emit case appears. Idempotent on (tenant_id, idempotency_key); same-key/different-payload raises 23505. Spec §2.3 / §2.6.';

comment on function outbox.mark_consumed(text, uuid, text) is
  'Marks a lease event consumed. SECURITY INVOKER, service_role only — same access policy as outbox.emit. Idempotent. Spec §2.5 / §2.6.';

notify pgrst, 'reload schema';
