-- audit-03 deferred-closeout — P2-3 (consolidate the two create_booking RPC
-- families). Step E: revoke EXECUTE on the now-dead legacy 20-arg
-- `create_booking` RPC.
--
-- ── Why ──────────────────────────────────────────────────────────────────
--
-- The legacy `public.create_booking(...)` RPC (defined in
-- 00277_create_canonical_booking_schema.sql:236-334) had exactly ONE live
-- caller: `BookingFlowService.create` → `this.supabase.admin.rpc(
-- 'create_booking', …)` at booking-flow.service.ts. That call site was
-- DELETED in this slice (STEP D): `create()` now always delegates to
-- `createWithAttachPlan` → `create_booking_with_attach_plan`. Multi-room
-- already uses the combined RPC (Slice-3/P1-1). Recurrence + Outlook-sync
-- create via the SAME `bookingFlow.create` gate, so they too no longer
-- touch this function. There are no remaining callers anywhere.
--
-- 00277 created `create_booking` with NO explicit grant, so it carries the
-- PostgreSQL default of `EXECUTE` granted to PUBLIC. Leaving a dead,
-- PUBLIC-executable, multi-table-writing RPC on the database is an
-- unnecessary surface (it bypasses the atomic combined-RPC path's
-- attach_operations idempotency + the chain-aware approval discipline). We
-- REVOKE it from every role.
--
-- ── Revoke, NOT drop (forward-only, reversible, workstream norm) ─────────
--
-- Consistent with the audit workstream's forward-only norm (see e.g.
-- 00379_drop_edit_booking_slot_rpc.sql chose DROP for a never-shipped RPC;
-- here the function is long-lived + referenced by historical migrations'
-- comments + the combined-RPC body's "Mirrors create_booking RPC body at
-- 00277:278-296" provenance notes, so we keep the definition for
-- archaeological traceability and reversibility). A `grant execute … to
-- service_role;` re-applies access if a regression ever needs it. No DROP,
-- no data change, idempotent, safe to re-run.
--
-- ── Exact signature ──────────────────────────────────────────────────────
--
-- The signature (7 required + 14 defaulted = 21 args; the brief's "20-arg"
-- shorthand undercounts by one — verified against the source) is quoted
-- verbatim from 00277_create_canonical_booking_schema.sql:236-259. `revoke`
-- resolves the function by its full argument-type list; the parameter names
-- are illustrative only (Postgres ignores names for overload resolution —
-- the 21 types below match the live definition exactly, in order).

revoke execute on function public.create_booking(
  uuid,         -- p_requester_person_id
  uuid,         -- p_location_id
  timestamptz,  -- p_start_at
  timestamptz,  -- p_end_at
  text,         -- p_source
  text,         -- p_status
  jsonb,        -- p_slots
  uuid,         -- p_tenant_id            (default null)
  uuid,         -- p_host_person_id       (default null)
  text,         -- p_title                (default null)
  text,         -- p_description          (default null)
  text,         -- p_timezone             (default 'UTC')
  uuid,         -- p_booked_by_user_id    (default null)
  uuid,         -- p_cost_center_id       (default null)
  numeric,      -- p_cost_amount_snapshot (default null)
  jsonb,        -- p_policy_snapshot      (default '{}'::jsonb)
  uuid[],       -- p_applied_rule_ids     (default '{}')
  uuid,         -- p_config_release_id    (default null)
  uuid,         -- p_recurrence_series_id (default null)
  int,          -- p_recurrence_index     (default null)
  uuid          -- p_template_id          (default null)
) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
