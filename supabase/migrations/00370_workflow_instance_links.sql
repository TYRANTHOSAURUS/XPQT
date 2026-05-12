-- Universal Workflow Architecture — Phase 0 commit 2: workflow_instance_links
-- table. The audit + resume registry that connects a parent workflow node
-- to the entity it spawned (with or without a child workflow).
--
-- Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.2
--       (lines 505-603) + §4 migration plan (lines 1043-1052).
--
-- Slot note: spec §4 (line 1048) reserves slot 00368 for this migration.
-- Two slot collisions discovered at execution time:
--   (1) B.4.Step2F shipped `00367_edit_booking_scope_rpc.sql` between spec
--       lock and execution.
--   (2) The 00369 polymorphism preflight needed a prep migration to
--       classify pre-existing dev seeds, which now occupies 00368
--       (`workflow_definitions_seed_entity_type_backfill.sql`).
-- Net result: this links migration lands at slot 00370. Downstream slots
-- in §4 shift by +2.
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- §3.3 (lines 605-631) introduces a `spawn` node taxonomy where one
-- workflow node creates a child entity (booking, work_order, ticket) and
-- optionally pauses the parent until the child reaches a terminal state.
-- The parent → child relationship needs persistent audit + a resume
-- handle that survives child entity deletion. Two existing tables fail
-- the test:
--
--   - `workflow_instances` itself: the parent workflow instance has no
--     slot for "I spawned X at node Y and I'm waiting on it" without
--     polluting `context jsonb` with structured state that's expensive to
--     query and impossible to index. The parent could spawn N children;
--     a single waiting_for column doesn't cut it.
--
--   - The outbox: `domain_events` records what happened, not what's
--     pending. Fine for audit; useless for "wake parent when child
--     resolves".
--
-- This table is THE canonical record. It also denormalizes
-- parent_entity_kind/parent_entity_id + child_entity_kind/child_entity_id
-- so the audit row survives parent or child workflow_instance deletion
-- (per spec §3.2 line 601: "freezes the contract at spawn time so editor
-- changes to the workflow definition don't retroactively change semantics").
--
-- ── CHECK shape correctness (codex remediation) ───────────────────────────
--
-- Spec §3.2 lines 546-551 calls out that SQL `CHECK (col IN (...))`
-- *accepts* NULL because IN-comparisons against NULL are unknown. The v1
-- enum constraints that included `null` literally were no-ops. The
-- columns below use bare nullable types + a value-set CHECK with NULL
-- handled explicitly via `is null or in (...)`.
--
-- ── Tenant assertion at insert time ───────────────────────────────────────
--
-- The FK to workflow_instances doesn't carry tenant_id. Tenant_id is the
-- #0 invariant (project CLAUDE.md). The `assert_workflow_instance_link_tenant`
-- trigger at the bottom verifies parent.tenant_id (and, when
-- child_instance_id is non-null, child.tenant_id) matches NEW.tenant_id.
-- Without this trigger, a privileged caller could smuggle a cross-tenant
-- parent reference into a tenant-isolated link row, leaking workflow state
-- across tenants. The trigger is NOT `security definer` — it reads
-- workflow_instances which is RLS-gated, but at INSERT time the calling
-- session must already see both the parent and child rows for this to be
-- a meaningful check. Operators (admin/service-role) bypass RLS naturally.
--
-- ── Cleanup runbook ───────────────────────────────────────────────────────
--
-- This migration is purely additive (new table + new trigger function).
-- No backfill, no destructive alter. Failure modes:
--
--   - Permission failure on `create table`: rerun under the migration
--     role.
--   - `relation already exists`: a prior partial run left the table
--     behind. Drop the table + trigger function and re-run, OR add `if
--     not exists` to the create-table (already present on indices and
--     trigger drop). The create-table itself is intentionally non-idempotent
--     so a column drift is loud.

create table public.workflow_instance_links (
  -- Identity + tenant. tenant_id is the #0 invariant.
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id),

  -- Parent: the workflow_instance that spawned the child. Cascade on
  -- parent delete: if the parent workflow instance is fully deleted (rare
  -- — usually you cancel, not delete), the link audit goes with it.
  parent_instance_id       uuid not null
    references public.workflow_instances(id) on delete cascade,
  parent_node_id           text not null,  -- the spawn node id within parent.workflow_definition

  -- Child workflow instance, NULLABLE: spawn-without-workflow path
  -- (e.g. spawn a booking that has no attached workflow definition).
  -- ON DELETE SET NULL: child workflow can be cancelled/deleted without
  -- losing the link audit row.
  child_instance_id        uuid null
    references public.workflow_instances(id) on delete set null,

  -- Denormalized parent + child entity references. Spec §3.2 line 601:
  -- survives parent/child workflow_instance deletion; makes audit-chain
  -- queries faster (no join through workflow_instances); freezes the
  -- contract at spawn time.
  parent_entity_kind       text not null,
  parent_entity_id         uuid not null,
  child_entity_kind        text not null,
  child_entity_id          uuid not null,

  -- Spawn semantics (Spec §3.3-§3.4).
  --   continue: parent advances immediately after spawn.
  --   wait:     parent enters waiting state until wait_for resolves.
  spawn_mode               text not null
    check (spawn_mode in ('continue', 'wait')),

  -- Wait configuration (relevant only when spawn_mode='wait').
  -- Nullable when spawn_mode='continue'. CHECK uses `is null or in (...)`
  -- per the §3.2 CHECK-shape note above.
  wait_for                 text null,
  entity_terminal_statuses text[] null,
  wait_timeout_at          timestamptz null,
  on_timeout_branch        text null,  -- branch label in parent workflow if timeout fires

  -- Cancellation cascade (Spec §3.6 — v2.2 locked default = cancel_child).
  on_parent_cancel         text not null
    default 'cancel_child'
    check (on_parent_cancel in ('cancel_child', 'orphan_child')),

  -- Resolution audit.
  resolved_at              timestamptz null,
  resolution_kind          text null,
  group_resolved_at        timestamptz null,  -- aggregation: set on the firing row when group meets strategy

  -- Aggregation columns (Spec §3.7 + §9.3 deferred). Schema-additive — the
  -- claim RPC ships in 00376 (per §4) when concrete demand arrives.
  aggregation_group_id     uuid null,
  aggregation_strategy     text null,
  aggregation_quorum_n     int null,

  created_at               timestamptz not null default now(),

  -- Composite tenant assertion via trigger below; FK can't carry tenant.
  -- Per §3.2 lines 546-551: CHECK with `IN (...)` accepts NULL silently,
  -- so we use `is null or in (...)` to make NULL handling explicit. The
  -- spawn_mode + on_parent_cancel CHECKs above are NOT NULL columns so
  -- bare `IN` is fine for those.
  constraint workflow_instance_links_wait_for_check
    check (wait_for is null
        or wait_for in ('workflow_terminal', 'entity_status', 'either')),
  constraint workflow_instance_links_resolution_kind_check
    check (resolution_kind is null
        or resolution_kind in ('condition_met', 'timeout', 'parent_cancelled')),
  constraint workflow_instance_links_aggregation_strategy_check
    check (aggregation_strategy is null
        or aggregation_strategy in ('all', 'any', 'first', 'quorum')),
  constraint workflow_instance_links_aggregation_quorum_check
    check ((aggregation_strategy = 'quorum' and aggregation_quorum_n is not null and aggregation_quorum_n >= 1)
        or (aggregation_strategy is distinct from 'quorum' and aggregation_quorum_n is null))
);

alter table public.workflow_instance_links enable row level security;

-- RLS policy: tenant_id-scoped. Mirrors workflow_instances at 00009:43-44.
-- Spec §3.2 line 603: "wake handler runs under supabase.admin to clear
-- RLS, so tenant enforcement at the wake boundary is a TS-side assertion
-- (not RLS)".
create policy "tenant_isolation" on public.workflow_instance_links
  using (tenant_id = public.current_tenant_id());

create index idx_wil_tenant on public.workflow_instance_links (tenant_id);
create index idx_wil_parent on public.workflow_instance_links (parent_instance_id);
create index idx_wil_child  on public.workflow_instance_links (child_instance_id)
  where child_instance_id is not null;
create index idx_wil_waiting on public.workflow_instance_links (resolved_at, wait_timeout_at)
  where resolved_at is null and spawn_mode = 'wait';
create index idx_wil_aggregation on public.workflow_instance_links (aggregation_group_id)
  where aggregation_group_id is not null;

-- ── Tenant assertion trigger. Spec §3.2 lines 571-598.
--
-- Defends the #0 invariant: parent + child workflow_instances must belong
-- to the same tenant as the link row. Raises:
--   - workflow_instance_link.tenant_mismatch_parent (registered in §3.12)
--   - workflow_instance_link.tenant_mismatch_child  (registered in §3.12)
--
-- SECURITY DEFINER (plan-review remediation, 2026-05-12): the function
-- reads workflow_instances.tenant_id. Without security definer, the
-- caller's RLS context applies — if `current_tenant_id()` is unset (e.g.
-- background worker, mis-configured session), the SELECT silently returns
-- NULL and the legitimate same-tenant insert is rejected as a cross-tenant
-- mismatch. The trigger's purpose is a tenant-equality CHECK, not RLS
-- enforcement; bypassing RLS to make the check authoritative is the right
-- tradeoff. Explicit `set search_path = public, pg_catalog` prevents
-- search_path manipulation from redirecting the lookup. Project CLAUDE.md
-- restricts security definer to RLS-bypass cases; this is one.
create or replace function public.assert_workflow_instance_link_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_parent_tenant uuid;
  v_child_tenant  uuid;
begin
  select tenant_id into v_parent_tenant
    from public.workflow_instances where id = new.parent_instance_id;
  if v_parent_tenant is null or v_parent_tenant <> new.tenant_id then
    raise exception 'workflow_instance_link.tenant_mismatch_parent';
  end if;
  if new.child_instance_id is not null then
    select tenant_id into v_child_tenant
      from public.workflow_instances where id = new.child_instance_id;
    if v_child_tenant is null or v_child_tenant <> new.tenant_id then
      raise exception 'workflow_instance_link.tenant_mismatch_child';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists workflow_instance_links_assert_tenant on public.workflow_instance_links;
create trigger workflow_instance_links_assert_tenant
  before insert on public.workflow_instance_links
  for each row execute function public.assert_workflow_instance_link_tenant();

comment on table public.workflow_instance_links is
  'Spec 2026-05-12 §3.2 (lines 505-603). Audit + resume registry for parent workflow nodes that spawn child entities (with or without a child workflow). Denormalizes parent/child entity refs so the audit row survives workflow_instance deletion. Tenant_id enforced by trigger (FK doesn''t carry tenant).';

comment on function public.assert_workflow_instance_link_tenant() is
  'Spec 2026-05-12 §3.2 (lines 571-598). Asserts parent and child workflow_instances belong to the same tenant as the link row. #0 invariant defense: FK to workflow_instances doesn''t carry tenant_id.';

notify pgrst, 'reload schema';
