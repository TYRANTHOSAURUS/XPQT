-- Phase 1.5 — Visual approval workflow — sub-step 6.B.
-- Schema additions + 3 SECURITY DEFINER tenant triggers + 2 PL/pgSQL RPCs +
-- per-rule backfill + chain_threshold derivation backfill + landed-assertion.
--
-- Spec: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md
--   §3.2 (lines 779-999) — canonical migration body.
--   §2.6.1-2.6.3 (lines 465-479) — column shape.
--   §2.6.7 (lines 508-590) — ensure_room_booking_rule_workflow_definition RPC.
--   §2.6.8 (lines 599-697) — cancel_workflow_instance_with_approvals RPC.
--
-- Closures from v4 plan-review:
--   BLOCKER 1 — TS multi-write violates parent-spec invariant. Closed by
--     ensure_room_booking_rule_workflow_definition RPC (atomic version bump +
--     INSERT + archive + FK flip under one row lock on the rule).
--   BLOCKER 2 — chain_threshold='any' double-resolve race lives in 00401
--     (per-booking row lock + sibling re-observation). 00400 ships the column.
--   CRITICAL 3 — workflow_definitions.source_rule_id is a tenant-smuggling FK
--     with no trigger. Closed by the THIRD trigger
--     assert_workflow_definitions_source_rule_tenant.
--   CRITICAL 4 — Cancel approval expiry is best-effort post-cancel. Closed by
--     cancel_workflow_instance_with_approvals RPC (claim + expire + emit
--     wrapped in one tx). Backstop cron lives in 6.G.
--   CRITICAL 5 — Backfill forces chain_threshold='all' for parallel_group=NULL
--     rows that today encode 'any'. Closed by the DERIVE algorithm in block G:
--       parallel_group IS NULL AND group_cardinality > 1 → 'any'
--       parallel_group IS NULL AND group_cardinality = 1 → 'all' (any-of-1 ≡ all-of-1)
--       parallel_group IS NOT NULL                       → 'all' (today's encoding)
--
-- Companion migration: 00401_grant_booking_approval_v2.sql ships separately so
-- a bug in 00401 doesn't roll back 00400's backfill. 00401 owns BLOCKER 2 +
-- the chain_threshold-aware resolve semantics under the per-booking row lock.
--
-- Tenant-trigger pattern lifted from 00370_workflow_instance_links.sql:205-228.
-- SECURITY DEFINER + explicit search_path + P0001 errcode for the structured
-- error path TS error-mapper can route to AppError.code = 'realtime.unavailable'
-- (defensive: triggers should never fire from app-tier writes; service-role
-- writes are the threat).

-- ── A. Schema additions ───────────────────────────────────────────────────

alter table public.approvals
  add column if not exists workflow_instance_id uuid
    references public.workflow_instances(id) on delete set null,
  add column if not exists workflow_node_id text,
  add column if not exists chain_threshold text not null default 'all'
    check (chain_threshold in ('all','any'));

create index if not exists idx_approvals_workflow_instance
  on public.approvals (workflow_instance_id)
  where workflow_instance_id is not null;

alter table public.room_booking_rules
  add column if not exists workflow_definition_id uuid
    references public.workflow_definitions(id) on delete set null;

create index if not exists idx_room_booking_rules_workflow_def
  on public.room_booking_rules (workflow_definition_id)
  where workflow_definition_id is not null;

alter table public.workflow_definitions
  add column if not exists source_rule_id uuid
    references public.room_booking_rules(id) on delete set null;

-- Widen workflow_definitions.status CHECK to admit 'archived'. The original
-- CHECK is 00009_workflows.sql:10 — ('draft','published'). Phase 1.5 needs
-- archived so version-bump operations can soft-delete prior versions without
-- breaking in-flight resume() reads (which are status-agnostic per IMPORTANT 7).
alter table public.workflow_definitions
  drop constraint if exists workflow_definitions_status_check;
alter table public.workflow_definitions
  add constraint workflow_definitions_status_check
    check (status in ('draft','published','archived'));

create unique index if not exists idx_workflow_definitions_rule_version
  on public.workflow_definitions (tenant_id, source_rule_id, version)
  where source_rule_id is not null;

-- ── B. Three SECURITY DEFINER tenant triggers (CRITICAL 3 closure) ────────
--    Pattern: 00370_workflow_instance_links.sql:205-228. SECURITY DEFINER
--    because the row being inserted/updated may not yet be RLS-readable
--    under the actor's policy; the trigger needs cross-tenant lookup
--    authority. Explicit search_path prevents redirect attacks.

-- B.1: approvals.workflow_instance_id → workflow_instances.tenant_id
create or replace function public.assert_approvals_workflow_instance_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.workflow_instance_id is null then
    return new;
  end if;
  if not exists (
    select 1
      from public.workflow_instances wi
     where wi.id = new.workflow_instance_id
       and wi.tenant_id = new.tenant_id
  ) then
    raise exception
      'tenant_mismatch on approvals.workflow_instance_id: instance=% does not belong to tenant=%',
      new.workflow_instance_id, new.tenant_id
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists approvals_assert_workflow_instance_tenant on public.approvals;
create trigger approvals_assert_workflow_instance_tenant
  before insert or update of workflow_instance_id, tenant_id on public.approvals
  for each row execute function public.assert_approvals_workflow_instance_tenant();

-- B.2: room_booking_rules.workflow_definition_id → workflow_definitions.tenant_id
create or replace function public.assert_room_booking_rules_workflow_definition_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.workflow_definition_id is null then
    return new;
  end if;
  if not exists (
    select 1
      from public.workflow_definitions wd
     where wd.id = new.workflow_definition_id
       and wd.tenant_id = new.tenant_id
  ) then
    raise exception
      'tenant_mismatch on room_booking_rules.workflow_definition_id: definition=% does not belong to tenant=%',
      new.workflow_definition_id, new.tenant_id
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists room_booking_rules_assert_workflow_definition_tenant on public.room_booking_rules;
create trigger room_booking_rules_assert_workflow_definition_tenant
  before insert or update of workflow_definition_id, tenant_id on public.room_booking_rules
  for each row execute function public.assert_room_booking_rules_workflow_definition_tenant();

-- B.3: workflow_definitions.source_rule_id → room_booking_rules.tenant_id
--      (CRITICAL 3 proper closure — the third FK v3 missed).
create or replace function public.assert_workflow_definitions_source_rule_tenant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.source_rule_id is null then
    return new;
  end if;
  if not exists (
    select 1
      from public.room_booking_rules rbr
     where rbr.id = new.source_rule_id
       and rbr.tenant_id = new.tenant_id
  ) then
    raise exception
      'tenant_mismatch on workflow_definitions.source_rule_id: rule=% does not belong to tenant=%',
      new.source_rule_id, new.tenant_id
      using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists workflow_definitions_assert_source_rule_tenant on public.workflow_definitions;
create trigger workflow_definitions_assert_source_rule_tenant
  before insert or update of source_rule_id, tenant_id on public.workflow_definitions
  for each row execute function public.assert_workflow_definitions_source_rule_tenant();

-- ── C. RPC: ensure_room_booking_rule_workflow_definition (BLOCKER 1) ──────
--    Atomic compile-and-publish of a workflow_definition for a rule. Concurrent
--    admin edits serialise on the rule row lock; version is computed under the
--    lock so MAX(version)+1 is race-free; prior versions are archived in the
--    same tx (only if no in-flight workflow_instance references them); rule's
--    workflow_definition_id FK flips at the end.
--
--    Returns the new definition id, its version, and the count of prior
--    versions archived.
--
--    Spec body: phase-1.5-visual-approval-workflow-plan.md §2.6.7 lines 511-590.

create or replace function public.ensure_room_booking_rule_workflow_definition(
  p_rule_id          uuid,
  p_tenant_id        uuid,
  p_graph_definition jsonb,
  p_rule_name        text   default null
) returns table (
  definition_id     uuid,
  version           integer,
  archived_prior_ct integer
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rule_name    text;
  v_next_version integer;
  v_new_id       uuid := gen_random_uuid();
  v_archived_ct  integer := 0;
begin
  -- 1. Lock the rule row. Concurrent admin edits serialise here.
  select coalesce(p_rule_name, name)
    into v_rule_name
    from public.room_booking_rules
   where id = p_rule_id
     and tenant_id = p_tenant_id
   for update;
  if not found then
    raise exception
      'ensure_workflow_definition: rule % not found in tenant %',
      p_rule_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  -- 2. Compute next_version under the row lock — race-free.
  -- NOTE: qualify `version` as `wd.version` because the RETURNS TABLE
  -- declares an output column also named `version`, and PL/pgSQL's
  -- variable-resolution rules would otherwise reject the reference as
  -- ambiguous.
  select coalesce(max(wd.version), 0) + 1
    into v_next_version
    from public.workflow_definitions wd
   where wd.source_rule_id = p_rule_id;

  -- 3. Insert the new definition row. published immediately; the auto-recompile
  --    contract is "every admin edit mints a new published version, supersedes
  --    the prior IFF safe to archive."
  insert into public.workflow_definitions (
    id, tenant_id, name, entity_type, status, version,
    graph_definition, source_rule_id, published_at, created_at
  )
  values (
    v_new_id, p_tenant_id, 'Approval — ' || v_rule_name,
    'booking', 'published', v_next_version,
    p_graph_definition, p_rule_id, now(), now()
  );

  -- 4. Archive prior versions that are safe to archive (no in-flight
  --    workflow_instance reference). In-flight instances stay on archived
  --    versions; the resume() path is status-agnostic per IMPORTANT 7. The
  --    start path refuses archived definitions (workflow-engine 6.A change).
  with archived as (
    update public.workflow_definitions wd
       set status = 'archived'
     where wd.source_rule_id = p_rule_id
       and wd.tenant_id = p_tenant_id
       and wd.id != v_new_id
       and wd.status = 'published'
       and not exists (
         select 1
           from public.workflow_instances wi
          where wi.workflow_definition_id = wd.id
            and wi.tenant_id = p_tenant_id
            and wi.status in ('active','waiting')
       )
    returning wd.id
  )
  select count(*) into v_archived_ct from archived;

  -- 5. Flip the rule's FK to the new definition. In-flight workflow_instances
  --    keep their workflow_definition_id pointing at the prior (now-archived)
  --    version — they were spawned with it and continue to advance on it.
  update public.room_booking_rules
     set workflow_definition_id = v_new_id
   where id = p_rule_id
     and tenant_id = p_tenant_id;

  return query select v_new_id, v_next_version, v_archived_ct;
end $$;

revoke execute on function public.ensure_room_booking_rule_workflow_definition(uuid, uuid, jsonb, text) from public;
grant  execute on function public.ensure_room_booking_rule_workflow_definition(uuid, uuid, jsonb, text) to service_role;

comment on function public.ensure_room_booking_rule_workflow_definition(uuid, uuid, jsonb, text) is
  'Atomic compile-and-publish of a workflow_definition for a room_booking_rule.
   Returns (definition_id, version, archived_prior_ct). Serialises concurrent
   admin edits on the rule row lock. Phase 1.5 §2.6.7.';

-- ── D. RPC: cancel_workflow_instance_with_approvals (CRITICAL 4) ──────────
--    Atomic claim + approvals expiry + audit emit. If the approvals expiry
--    fails (saboteur trigger, FK violation), the whole tx rolls back; the
--    workflow_instance does NOT transition to cancelled. Backstop cron (6.G)
--    covers any drift from non-RPC flips (manual SQL, pre-Phase-1.5 rows).
--
--    Spec body: phase-1.5-visual-approval-workflow-plan.md §2.6.8 lines 602-676.

create or replace function public.cancel_workflow_instance_with_approvals(
  p_instance_id uuid,
  p_tenant_id   uuid,
  p_reason      text
) returns table (
  claimed              boolean,
  approvals_expired_ct integer
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_claimed     boolean := false;
  v_expired_ct  integer := 0;
  v_entity_kind text;
  v_entity_id   text;
begin
  -- 1. Atomic claim. Matches the existing TS-side claim semantics in
  --    workflow-engine.service.ts:346-357 — same IN ('active','waiting') gate.
  with claimed as (
    update public.workflow_instances
       set status = 'cancelled',
           cancelled_at = now(),
           cancelled_reason = p_reason
     where id = p_instance_id
       and tenant_id = p_tenant_id
       and status in ('active', 'waiting')
    returning id, entity_kind,
              coalesce(case_id::text, work_order_id::text, booking_id::text) as entity_id
  )
  select true, c.entity_kind, c.entity_id
    into v_claimed, v_entity_kind, v_entity_id
    from claimed c;

  if not coalesce(v_claimed, false) then
    -- Lost the race — another worker cancelled. No-op return; TS caller
    -- treats this the same as the old TS-side claim losing the race.
    return query select false, 0;
    return;
  end if;

  -- 2. Expire any pending approvals linked to this workflow_instance.
  --    approvals.status CHECK admits 'expired' (00012:- + later widenings).
  --    comments column already exists per current schema; no migration needed.
  update public.approvals
     set status       = 'expired',
         responded_at = now(),
         comments     = 'workflow_instance_cancelled'
   where workflow_instance_id = p_instance_id
     and tenant_id            = p_tenant_id
     and status               = 'pending';
  get diagnostics v_expired_ct = row_count;

  -- 3. Emit instance_cancelled audit event. Table is workflow_instance_events
  --    (00026); column is workflow_instance_id (verified against remote
  --    2026-05-13). event_type CHECK admits 'instance_cancelled' per 00376
  --    widening (Phase 1.B closure).
  insert into public.workflow_instance_events (
    tenant_id, workflow_instance_id, event_type, payload, created_at
  ) values (
    p_tenant_id, p_instance_id, 'instance_cancelled',
    jsonb_build_object(
      'reason',                p_reason,
      'entity_kind',           v_entity_kind,
      'entity_id',             v_entity_id,
      'approvals_expired_ct',  v_expired_ct
    ),
    now()
  );

  return query select true, v_expired_ct;
end $$;

revoke execute on function public.cancel_workflow_instance_with_approvals(uuid, uuid, text) from public;
grant  execute on function public.cancel_workflow_instance_with_approvals(uuid, uuid, text) to service_role;

comment on function public.cancel_workflow_instance_with_approvals(uuid, uuid, text) is
  'Atomic claim + approvals expiry + audit emit for cancelling a workflow_instance.
   Returns (claimed, approvals_expired_ct). RPC body rolls back on any partial
   failure — workflow_instance status stays IN (active, waiting) if the
   approvals expiry fails. Backstop: ApprovalCancelSweeperCron (Phase 1.5 6.G).
   Phase 1.5 §2.6.8.';

-- ── E. Preflight refuse — fail if any approval_config is shaped outside
--    what we can losslessly compile. Phase 1.5 §3.2 block D.
do $$
declare
  v_rogue integer;
begin
  select count(*) into v_rogue
    from public.room_booking_rules
   where approval_config is not null
     and not (
       jsonb_typeof(approval_config->'required_approvers') = 'array'
       and (approval_config->>'threshold') in ('all','any')
       and not exists (
         select 1
           from jsonb_array_elements(approval_config->'required_approvers') ap
          where not ((ap->>'type') in ('person','team') and (ap->>'id') is not null)
       )
     );
  if v_rogue > 0 then
    raise exception
      'phase 1.5 backfill: % rule(s) have non-canonical approval_config shape. Inspect + normalise before re-running.',
      v_rogue;
  end if;
end $$;

-- ── F. Per-rule backfill via the RPC. Phase 1.5 §3.2 block E.
--    For each rule with approval_config IS NOT NULL AND workflow_definition_id
--    IS NULL, build the canonical graph_definition jsonb via jsonb_build_object
--    and call the RPC. Idempotent: re-runs skip rules whose FK is already set.
--
--    JSONB KEY-ORDER CONTRACT (locked by 6.A.X code-quality review):
--    The compiler service `ApprovalConfigCompilerService.compile()` produces
--    jsonb with a specific key order that the byte-equality parity test
--    relies on (V8 JSON.stringify key insertion order matches Postgres
--    jsonb_build_object call order). The contract is:
--
--      Top-level graph_definition: {nodes, edges}
--      Per node:                   {id, type, config}
--      Per edge (trigger→approval): {from, to}
--      Per edge (approval→end_*):   {from, to, condition}
--      approval_main.config:        {required_approvers, threshold}
--      end_*.config:                {outcome}
--
--    DO NOT add `rule_type` or any other key inside approval_main.config —
--    6.A.X spec-review fix (commit 80afff03) confirmed the canonical shape
--    is two-key. The compiler's `ruleType` parameter exists on the input
--    API but is NOT emitted to the graph.

do $$
declare
  r           record;
  v_graph     jsonb;
  v_approvers jsonb;
  v_threshold text;
begin
  for r in
    select id, tenant_id, name, approval_config
      from public.room_booking_rules
     where approval_config is not null
       and workflow_definition_id is null
  loop
    v_approvers := r.approval_config->'required_approvers';
    v_threshold := coalesce(r.approval_config->>'threshold', 'all');
    v_graph := jsonb_build_object(
      'nodes', jsonb_build_array(
        jsonb_build_object(
          'id', 'trigger',
          'type', 'trigger',
          'config', jsonb_build_object()
        ),
        jsonb_build_object(
          'id', 'approval_main',
          'type', 'approval',
          'config', jsonb_build_object(
            'required_approvers', v_approvers,
            'threshold', v_threshold
          )
        ),
        jsonb_build_object(
          'id', 'end_success',
          'type', 'end',
          'config', jsonb_build_object('outcome', 'approved')
        ),
        jsonb_build_object(
          'id', 'end_failure',
          'type', 'end',
          'config', jsonb_build_object('outcome', 'rejected')
        )
      ),
      'edges', jsonb_build_array(
        jsonb_build_object('from', 'trigger', 'to', 'approval_main'),
        jsonb_build_object('from', 'approval_main', 'to', 'end_success', 'condition', 'approved'),
        jsonb_build_object('from', 'approval_main', 'to', 'end_failure', 'condition', 'rejected')
      )
    );
    perform public.ensure_room_booking_rule_workflow_definition(
      r.id, r.tenant_id, v_graph, r.name
    );
  end loop;
end $$;

-- ── G. Backfill chain_threshold via DERIVE algorithm (CRITICAL 5).
--    Phase 1.5 §3.2 block F.
--
--    Mapping (today's implicit encoding → explicit Phase 1.5 column):
--      parallel_group IS NULL AND group_cardinality > 1 → 'any'
--      parallel_group IS NULL AND group_cardinality = 1 → 'all' (any-of-1 ≡ all-of-1)
--      parallel_group IS NOT NULL                       → 'all' (today's encoding)
--
--    CITATION-DRIFT FIX: the plan §3.2 block F (lines 962-983) uses
--    `where chain_threshold is null` as the not-yet-migrated marker, but
--    block A's column definition is `NOT NULL DEFAULT 'all'` — so no row
--    can ever have chain_threshold IS NULL. The marker has to be different.
--
--    We use the existing-shape detector directly: rows where the implicit
--    encoding is 'any' (parallel_group IS NULL AND >1 siblings in the same
--    chain) BUT chain_threshold currently='all' (the default) get bumped to
--    'any'. All other rows stay 'all' — which is correct for both today's
--    parallel_group=NOT NULL='all' chains and the any-of-1 ≡ all-of-1 case.
--
--    We also fill in approval_chain_id for any pre-Phase-1.5 row that has
--    NULL chain_id (legacy createApprovalRows never set it; 00310 onward
--    does). Same target_entity_id + parallel_group → same chain_id.
--
--    Idempotency: subsequent runs find NO rows with the broken-marker shape
--    (everything is correctly encoded post-first-run); the loop's body is
--    a no-op.

do $$
declare
  cg        record;
  v_derived text;
begin
  -- Step 1: assign approval_chain_id to any row that's missing one. Group by
  -- (tenant_id, target_entity_id, parallel_group) — these are the same
  -- "chain" semantically in the pre-Phase-1.5 schema.
  for cg in
    select tenant_id,
           target_entity_id,
           parallel_group,
           gen_random_uuid() as new_chain_id,
           count(*) as group_cardinality
      from public.approvals
     where approval_chain_id is null
     group by tenant_id, target_entity_id, parallel_group
  loop
    update public.approvals
       set approval_chain_id = cg.new_chain_id
     where tenant_id        = cg.tenant_id
       and target_entity_id = cg.target_entity_id
       and parallel_group is not distinct from cg.parallel_group
       and approval_chain_id is null;
  end loop;

  -- Step 2: DERIVE chain_threshold for each grouped chain. Update is conditional
  -- so 'all' stays 'all' (no-op for the default); only the implicit-'any'
  -- chains flip to 'any'. RAISE NOTICE on every flip for post-backfill audit.
  for cg in
    select tenant_id,
           target_entity_id,
           parallel_group,
           approval_chain_id as chain_id,
           count(*) as group_cardinality
      from public.approvals
     group by tenant_id, target_entity_id, parallel_group, approval_chain_id
  loop
    v_derived := case
      when cg.parallel_group is null and cg.group_cardinality > 1 then 'any'
      when cg.parallel_group is null and cg.group_cardinality = 1 then 'all'
      else 'all'
    end;

    if v_derived = 'any' then
      raise notice 'phase 1.5 chain %: parallel_group=%, group_cardinality=%, derived chain_threshold=%',
        cg.chain_id, cg.parallel_group, cg.group_cardinality, v_derived;

      update public.approvals
         set chain_threshold = 'any'
       where approval_chain_id = cg.chain_id
         and chain_threshold = 'all';  -- idempotency: skip rows already flipped
    end if;
    -- v_derived='all' is a no-op (matches the default).
  end loop;
end $$;

-- ── H. Belt-and-suspenders — assert every rule with non-null approval_config
--    now carries a workflow_definition_id. Phase 1.5 §3.2 block G.
do $$
declare
  v_missing integer;
begin
  select count(*) into v_missing
    from public.room_booking_rules
   where approval_config is not null
     and workflow_definition_id is null;
  if v_missing > 0 then
    raise exception
      'phase 1.5 backfill: % rule(s) ended without a workflow_definition_id. Investigate before reload.',
      v_missing;
  end if;
end $$;

-- ── I. PostgREST schema cache reload — makes the new columns + RPCs
--    available to the running API immediately on remote.
notify pgrst, 'reload schema';
