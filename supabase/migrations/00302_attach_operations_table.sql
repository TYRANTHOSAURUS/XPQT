-- B.0.A.1 — attach_operations table for combined-RPC operation idempotency.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §2.4 (v6 contract).
--
-- The combined RPC `create_booking_with_attach_plan` (B.0.B) takes a
-- pg_advisory_xact_lock keyed on (tenant_id, idempotency_key), then SELECTs
-- the row, INSERTs an in_progress marker if absent, and UPDATEs to
-- success+cached_result on commit. Same key + same payload_hash returns
-- cached_result. Same key + different payload_hash raises
-- 'attach_operations.payload_mismatch'.
--
-- v6 contract: outcome enum is ('in_progress', 'success'). The 'failed' state
-- and stale 'in_progress' rows do NOT materialise — the marker INSERT lives
-- inside the RPC's tx, so any failure rolls the row back. A future retry
-- with the same key sees an empty attach_operations and starts fresh.
-- (Spec §2.4 "v6 change: drop failed and stale in_progress from the contract.")
--
-- RLS: service_role only — the combined RPC runs as service_role from TS;
-- end users reach it via BookingFlowService which authorizes before calling.
-- Tenant policy uses public.current_tenant_id() to mirror outbox.events
-- foundation in 00299.

create table if not exists public.attach_operations (
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  idempotency_key  text        not null,
  payload_hash     text        not null,
  outcome          text        not null
                     check (outcome in ('in_progress', 'success')),  -- v6: 'failed' dropped
  cached_result    jsonb,                            -- non-null when outcome='success'
  enqueued_at      timestamptz not null default now(),
  completed_at     timestamptz,
  primary key (tenant_id, idempotency_key)
);

alter table public.attach_operations enable row level security;

drop policy if exists tenant_isolation on public.attach_operations;
create policy tenant_isolation on public.attach_operations
  using (tenant_id = public.current_tenant_id());

revoke all on table public.attach_operations from public;
grant select, insert, update on table public.attach_operations to service_role;

comment on table public.attach_operations is
  'Operation-level idempotency for create_booking_with_attach_plan (§7 of the outbox spec). One row per (tenant_id, idempotency_key). The combined RPC takes a pg_advisory_xact_lock keyed on the same pair, then SELECTs the row, INSERTs an in_progress marker if absent, and UPDATEs to success+cached_result on commit. Same key + same payload_hash returns cached_result. Same key + different payload_hash raises ''attach_operations.payload_mismatch''. v6 contract: ''failed'' state and stale ''in_progress'' rows do NOT exist (rolled back by the RPC tx).';
