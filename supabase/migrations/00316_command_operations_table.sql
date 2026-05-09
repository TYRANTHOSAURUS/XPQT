-- B.2.A.1 — command_operations table for combined-RPC operation idempotency.
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.7 + §4 (line 3100).
--
-- Mirror of `attach_operations` (00302). Every B.2 combined RPC
-- (transition_entity_status, set_entity_assignment, update_entity_sla,
-- update_entity_combined, dispatch_child_work_order, grant_ticket_approval,
-- reclassify_ticket, update_entity_metadata, create_ticket_with_automation)
-- takes a pg_advisory_xact_lock keyed on (tenant_id, idempotency_key),
-- SELECTs the row, INSERTs an in_progress marker if absent, and UPDATEs to
-- success+cached_result on commit. Same key + same payload_hash returns
-- cached_result. Same key + different payload_hash raises
-- 'command_operations.payload_mismatch'.
--
-- v6 contract (mirrors attach_operations §2.4 of outbox spec): outcome
-- enum is ('in_progress', 'success'). The 'failed' state and stale
-- 'in_progress' rows do NOT materialise — the marker INSERT lives inside
-- the RPC's tx, so any failure rolls the row back. A future retry with
-- the same key sees an empty command_operations and starts fresh.
--
-- Why not reuse attach_operations? Spec §3.7 — semantically different
-- operation classes (booking attach vs. WO/case command surface);
-- diagnostic queries / cleanup runbooks need to distinguish them; payload
-- hashes for different classes shouldn't collide on a shared key
-- namespace.
--
-- RLS: service_role only — combined RPCs run as service_role from TS;
-- end users reach them via authorized service methods. Tenant policy
-- uses public.current_tenant_id() to mirror attach_operations (00302) /
-- outbox.events foundation (00299).

create table if not exists public.command_operations (
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

alter table public.command_operations enable row level security;

drop policy if exists tenant_isolation on public.command_operations;
create policy tenant_isolation on public.command_operations
  using (tenant_id = public.current_tenant_id());

revoke all on table public.command_operations from public;
grant select, insert, update on table public.command_operations to service_role;

comment on table public.command_operations is
  'Operation-level idempotency for B.2 combined RPCs (transition_entity_status, set_entity_assignment, update_entity_sla, update_entity_combined, dispatch_child_work_order, grant_ticket_approval, reclassify_ticket, update_entity_metadata, create_ticket_with_automation). Spec: docs/follow-ups/b2-survey-and-design.md §3.7. One row per (tenant_id, idempotency_key). Each RPC takes a pg_advisory_xact_lock keyed on the same pair, then SELECTs the row, INSERTs an in_progress marker if absent, and UPDATEs to success+cached_result on commit. Same key + same payload_hash returns cached_result. Same key + different payload_hash raises ''command_operations.payload_mismatch''. v6 contract: ''failed'' state and stale ''in_progress'' rows do NOT exist (rolled back by the RPC tx).';
