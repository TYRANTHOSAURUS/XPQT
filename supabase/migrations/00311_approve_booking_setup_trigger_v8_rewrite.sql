-- B.0.B.3 — approve_booking_setup_trigger v8 rewrite (replaces v6).
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §7.9
-- (REWRITTEN IN V7 — folds v6-C4 + v7-C1; v8 §7.9.1 adds emit-time ruleIds
-- validation via validate_rule_ids_in_tenant).
--
-- The v6 cutover was broken: it kept 00198 (claim_deferred_setup_trigger_args)
-- in place and added a separate "emit" RPC. 00198 NULLed
-- pending_setup_trigger_args BEFORE returning, so the second RPC re-read the
-- args, found NULL on every row, and emitted ZERO events. The whole
-- durability promise of v6-C4 was voided.
--
-- v7+v8 fix: read + emit + clear in ONE transaction. The TS approval path
-- (B.0.D's ApprovalService.respond / BundleService.onApprovalDecided)
-- collapses from "claim → branch → triggerMany → audit" (~80 LOC) to "call
-- approve_booking_setup_trigger" (one line). 00198 stays on remote with no
-- callers; B.0.D applies 00308 to drop it cleanly post-cutover.
--
-- This migration uses CREATE OR REPLACE because:
--   1. v6 shipped a function with the SAME name but a DIFFERENT signature
--      (p_oli_ids uuid[], p_tenant_id uuid). Postgres treats different
--      signatures as different functions, so REPLACE silently creates a new
--      overload — leaving the broken v6 function reachable. Drop the old
--      signature explicitly first.
--   2. The new v8 signature is (p_booking_id, p_tenant_id, p_actor_user_id,
--      p_idempotency_key) — chain-derived, not OLI-list-derived. v8 follows
--      the same identity discipline as create_setup_work_order_from_event
--      (B.0.B.4): identity comes from the booking, not from caller-supplied
--      lists.
--
-- Schema note (spec ↔ schema reconciliation):
--   The §7.9 spec body references `oli.booking_id` but order_line_items has
--   no `booking_id` column (verified live against remote: 35 columns, none
--   named booking_id). The intent is "the booking the OLI belongs to via
--   its order". We derive it from `orders.booking_id` via the join already
--   present in the SELECT loop, then constant-fold to p_booking_id (which
--   filters the join, so it's tautologically equal). Spec ambiguity flagged
--   in the B.0.B return summary.
--
-- v8-I6 (§7.9.1): the OLI's pending_setup_trigger_args.ruleIds was validated
-- at plan time (00304). But the value is then PERSISTED on
-- order_line_items.pending_setup_trigger_args between plan time and approval
-- grant. Admin tooling, a future bulk rule-rewrite migration, or a
-- misbehaving cleanup job could mutate service_rules between plan-time and
-- grant-time, leaving a stale or cross-tenant rule id baked into the
-- persisted args. Validate here before the args land in an outbox event.
--
-- SECURITY INVOKER, service-role grant only. Called by grant_booking_approval
-- (00310) inline + by admin/batch tooling for the standalone re-emit path.

-- Drop the v6 signature explicitly to avoid leaving an obsolete overload
-- reachable. CREATE OR REPLACE only matches on (name, args), so without
-- this drop the v6 function would coexist with the v8 function silently.
drop function if exists public.approve_booking_setup_trigger(uuid[], uuid);

create or replace function public.approve_booking_setup_trigger(
  p_booking_id      uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_oli            record;
  v_args           jsonb;
  v_emit_count     int := 0;
  v_skip_cancel    int := 0;
  v_skip_no_args   int := 0;
  v_event_payload  jsonb;
  v_lock_key       bigint;
  v_rule_ids       uuid[];
begin
  if p_tenant_id is null then
    raise exception 'approve_booking_setup_trigger: p_tenant_id required';
  end if;
  if p_booking_id is null then
    raise exception 'approve_booking_setup_trigger: p_booking_id required';
  end if;

  -- ── 1. Per-grant advisory lock (v7-C1) — serialise concurrent grants on
  -- the same booking. Two approvers granting simultaneously across multiple
  -- API instances reach this lock; the second waits, then re-reads OLIs and
  -- finds pending_setup_trigger_args=NULL on every row (the first already
  -- cleared them) — emits zero, returns immediately.
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':approve_setup:' || p_booking_id::text, 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. Read + lock every OLI in this booking with non-null
  -- pending_setup_trigger_args. The `for update of oli` lock ensures that
  -- a concurrent cancel cascade can't race between our read and our update.
  -- (for-update is on order_line_items only, NOT orders/bookings — the
  -- cancel cascade locks a different set, so we don't deadlock.)
  --
  -- booking_id is derived from o.booking_id (= p_booking_id by the join
  -- filter) since order_line_items has no booking_id column on this schema.
  for v_oli in
    select oli.id, oli.order_id, oli.pending_setup_trigger_args,
           oli.fulfillment_status, oli.service_window_start_at,
           o.booking_id
      from public.order_line_items oli
      join public.orders o on o.id = oli.order_id
     where o.booking_id  = p_booking_id
       and o.tenant_id   = p_tenant_id
       and oli.tenant_id = p_tenant_id
     for update of oli
  loop
    -- Skip cancelled lines (race-guard equivalent of the TS code at
    -- bundle.service.ts:1550-1614 — but now in the same tx as the emit).
    if v_oli.fulfillment_status = 'cancelled' then
      v_skip_cancel := v_skip_cancel + 1;
      continue;
    end if;
    if v_oli.pending_setup_trigger_args is null then
      v_skip_no_args := v_skip_no_args + 1;
      continue;
    end if;
    v_args := v_oli.pending_setup_trigger_args;

    -- ── v8-I6: emit-time ruleIds validation against tenant service_rules.
    -- Defense-in-depth against rule mutations between plan-time and grant-time.
    v_rule_ids := coalesce(
      (select array_agg(value::uuid)
         from jsonb_array_elements_text(coalesce(v_args->'ruleIds', '[]'::jsonb))),
      '{}'::uuid[]
    );
    if cardinality(v_rule_ids) > 0 then
      perform public.validate_rule_ids_in_tenant(p_tenant_id, v_rule_ids);
    end if;

    -- Build event payload from the persisted args. Schema mirrors §7.6's
    -- v_event_payload — the handler is shape-agnostic across the create
    -- and approval-grant origins.
    v_event_payload := jsonb_build_object(
      'booking_id',                v_oli.booking_id,
      'oli_id',                    v_oli.id,
      'service_category',          v_args->>'serviceCategory',
      'service_window_start_at',   v_args->>'serviceWindowStartAt',
      'location_id',               v_args->>'locationId',
      'rule_ids',                  v_args->'ruleIds',
      'lead_time_override_minutes', nullif(v_args->>'leadTimeOverride', '')::int,
      'origin_surface',            coalesce(v_args->>'originSurface', 'bundle'),
      'requires_approval',         false   -- approval already granted
    );

    perform outbox.emit(
      p_tenant_id      => p_tenant_id,
      p_event_type     => 'setup_work_order.create_required',
      p_aggregate_type => 'order_line_item',
      p_aggregate_id   => v_oli.id,
      p_payload        => v_event_payload,
      p_idempotency_key => 'setup_work_order.create_required:' || v_oli.id::text,
      p_event_version  => 1,
      p_available_at   => null
    );

    -- Clear the args ATOMICALLY in the same tx. v7 — no separate claim RPC
    -- means there's no "claimed but not emitted" intermediate state.
    update public.order_line_items
       set pending_setup_trigger_args = null
     where id = v_oli.id;

    v_emit_count := v_emit_count + 1;
  end loop;

  -- ── 3. Audit row in same tx for ops triage.
  insert into public.audit_events (
    tenant_id, event_type, entity_type, entity_id, details
  ) values (
    p_tenant_id,
    'booking.deferred_setup_emitted_on_approval',
    'booking',
    p_booking_id,
    jsonb_build_object(
      'actor_user_id',   p_actor_user_id,
      'idempotency_key', p_idempotency_key,
      'emitted',         v_emit_count,
      'skipped_cancel',  v_skip_cancel,
      'skipped_no_args', v_skip_no_args
    )
  );

  return jsonb_build_object(
    'emitted_count',     v_emit_count,
    'skipped_cancelled', v_skip_cancel,
    'skipped_no_args',   v_skip_no_args
  );
end;
$$;

revoke execute on function public.approve_booking_setup_trigger(uuid, uuid, uuid, text) from public;
grant  execute on function public.approve_booking_setup_trigger(uuid, uuid, uuid, text) to service_role;

comment on function public.approve_booking_setup_trigger(uuid, uuid, uuid, text) is
  'Approval-grant emit path for setup_work_order.create_required (§7.9 of the outbox spec — v7 contract; v8 §7.9.1 adds emit-time ruleIds validation via validate_rule_ids_in_tenant). Reads pending_setup_trigger_args for every OLI in the booking, validates persisted ruleIds against tenant service_rules (defense-in-depth against rule mutations between plan-time and grant-time), emits one outbox event per non-null OLI, clears the args — all in one transaction. Replaces the v6 (00198 claim + separate RPC) two-step that broke because 00198 nulled the args before the second RPC could read them. SECURITY INVOKER; called inline by grant_booking_approval (00310) and standalone for admin/batch tooling.';

notify pgrst, 'reload schema';
