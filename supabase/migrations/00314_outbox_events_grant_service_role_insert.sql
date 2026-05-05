-- B.0.F follow-up — grant service_role INSERT on outbox.events.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §2.6.
--
-- Surfaced by the round-trip smoke probe (B.0.F.1) on the second live
-- run after fixing 00313:
--
--   POST /reservations with a service line that requires_internal_setup
--   failed at the combined RPC's INSERT into outbox.events with:
--     permission denied for table events
--
-- Root cause: 00299_outbox_foundation.sql:363 grants only
--   `select, update on table outbox.events to service_role`.
-- INSERT was missing. The §2.6 intent was that callers reach
-- `outbox.events` via `outbox.emit()` (the canonical producer
-- function), but `outbox.emit()` is `SECURITY INVOKER` — it runs as
-- the caller's role, so the caller still needs INSERT on the
-- underlying table. Service_role calls combined RPCs (also INVOKER)
-- which call outbox.emit() inline; the privilege check fires on the
-- INSERT inside emit, not on the function call itself.
--
-- Two ways to fix:
--   1. Make `outbox.emit()` SECURITY DEFINER (runs as table owner =
--      postgres, which has all privileges). Cleaner conceptually
--      because it matches the §2.6 wording "events is reachable only
--      via the helper functions"; but means `set search_path =
--      public, outbox` becomes load-bearing for security and the
--      definer pattern needs careful audit.
--   2. Grant service_role INSERT directly. Less elegant; simpler;
--      matches the precedent (worker already has SELECT + UPDATE
--      directly).
--
-- Going with option 2. The `revoke all on table outbox.events from
-- public` at 00299:362 still ensures no other role can write; only
-- service_role can, and the only realistic service_role caller is
-- inside an RPC body that uses outbox.emit (which has its own validity
-- checks: tenant_id NOT NULL, idempotency_key NOT NULL, ON CONFLICT
-- payload_hash check). The DELETE grant covered by 00299 stays absent
-- — purge is via the worker cron only.

grant insert on table outbox.events to service_role;

comment on table outbox.events is
  'Durable outbox for domain events. Producers MUST insert via outbox.emit() helper or row-triggers, inside the business write transaction. Worker drains asynchronously; at-least-once + idempotent handlers. service_role has SELECT + INSERT + UPDATE (00314 added INSERT — 00299 missed it). Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §2.1, §2.6.';
