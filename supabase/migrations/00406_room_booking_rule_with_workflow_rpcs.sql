-- Phase 1.5 — Universal Workflow Architecture — consolidating room-booking-rule
-- create/update RPCs.
--
-- WHY: CLAUDE.md "Multi-step writes are PL/pgSQL RPCs, not TS pipelines."
-- RoomBookingRulesService.create() (room-booking-rules.service.ts:177-255)
-- previously INSERTed the rule row, then called the
-- ensure_room_booking_rule_workflow_definition RPC
-- (00400_room_booking_rules_workflow_definition_fk.sql:187-283) separately. A
-- partial failure between the two writes left an orphan rule with a non-null
-- approval_config but workflow_definition_id=NULL — silently falling through
-- the cutover gate to the legacy createApprovalRows path. Commit 2a5f1af3
-- added a TS-side compensation (delete-the-rule-on-recompile-failure,
-- room-booking-rules.service.ts:228-253). This migration replaces that
-- compensation with a single-transaction RPC pair; the TS catch/delete block
-- is deleted in the same change.
--
-- Convention parity (read this session):
--   * SECURITY DEFINER + `set search_path = public, pg_catalog` — matches
--     ensure_room_booking_rule_workflow_definition
--     (00400_room_booking_rules_workflow_definition_fk.sql:197-200) and the
--     three tenant triggers (ibid:86-90). NOT `security invoker` like
--     grant_booking_approval (00403_grant_booking_approval_v2.sql:63) — that
--     RPC runs invoker because RLS-readable rows already exist; here we
--     INSERT rows the actor's RLS policy can't yet see (same rationale as
--     00400's DEFINER block comment, ibid:78-82).
--   * `raise exception ... using errcode = 'P0001'` (bad input) / `'P0002'`
--     (not found) — matches 00400:215-218 + 00403:84-92,110-111. The TS
--     error mapper routes these into AppError.code =
--     'room_rule.workflow_recompile_failed' (already registered:
--     packages/shared/src/error-codes.ts:508,1408;
--     messages.en.ts / messages.nl.ts). No NEW client-facing error code is
--     introduced — the consolidating RPC keeps the exact same failure
--     surface as the pre-existing two-step path.
--   * revoke from public / grant to service_role — matches 00400:277-278,
--     00403:393-394. Both RPCs invoked via this.supabase.admin.rpc(...)
--     (service-role client) exactly like approval.service.ts:838.
--
-- room_booking_rules columns: 00121_room_booking_rules.sql:5-24
--   (id, tenant_id NOT NULL, name, description, target_scope, target_id,
--    applies_when, effect, approval_config, denial_message, priority,
--    template_id, template_params, active, created_at, updated_at,
--    created_by, updated_by) + workflow_definition_id added at
--   00400_room_booking_rules_workflow_definition_fk.sql:52-54.
-- workflow_definitions columns: 00009_workflows.sql:3-16
--   (id, tenant_id NOT NULL, config_entity_id, name, entity_type, version,
--    status, graph_definition, created_by, published_at, created_at,
--    updated_at) + source_rule_id added at
--   00400_room_booking_rules_workflow_definition_fk.sql:60-62; status CHECK
--   widened to admit 'archived' (ibid:68-72).
--
-- tenant_id is the #0 invariant (MEMORY feedback_tenant_id_ultimate_rule):
-- every INSERTed/UPDATEd row in both RPCs sets tenant_id = p_tenant_id, and
-- the three SECURITY DEFINER triggers from 00400 (block B) still fire on
-- these writes — a cross-tenant FK is rejected with P0001 before commit.

-- ── A. create_room_booking_rule_with_workflow ─────────────────────────────
--    One transaction:
--      1. INSERT the rule (tenant_id = p_tenant_id).
--      2. IFF p_graph_definition IS NOT NULL: INSERT workflow_definitions
--         (version=1, status='published', source_rule_id=new rule id,
--          tenant_id=p_tenant_id) and flip the rule's
--          workflow_definition_id FK to it.
--      3. RETURN {rule: <full row>, definition_id: <uuid|null>, version: 1|null}.
--
--    p_rule_data is the insert body assembled in TS (mirrors the
--    insertBody object at room-booking-rules.service.ts:181-197). The TS
--    side keeps doing all DTO validation + the predicate-engine check
--    (validateCreateInput, ibid:413-430) BEFORE calling this RPC; the RPC
--    only enforces the structural invariants the DB owns (tenant_id set,
--    required columns present).
--
--    p_graph_definition is the compiled approval graph
--    (ApprovalConfigCompilerService.compile(...).graphDefinition,
--    room-booking-rules.service.ts:117-120) or NULL when the rule has no
--    approval_config (the "no workflow" case — FK stays NULL, runtime falls
--    back to legacy createApprovalRows).

create or replace function public.create_room_booking_rule_with_workflow(
  p_tenant_id        uuid,
  p_rule_data        jsonb,
  p_graph_definition jsonb,
  p_actor_user_id    uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rule_id    uuid := gen_random_uuid();
  v_def_id     uuid;
  v_rule       public.room_booking_rules%rowtype;
  v_name       text;
  v_version    integer;
begin
  if p_tenant_id is null then
    raise exception 'create_room_booking_rule_with_workflow: p_tenant_id required'
      using errcode = 'P0001';
  end if;
  if p_rule_data is null or jsonb_typeof(p_rule_data) <> 'object' then
    raise exception 'create_room_booking_rule_with_workflow: p_rule_data must be a json object'
      using errcode = 'P0001';
  end if;

  v_name := nullif(btrim(p_rule_data->>'name'), '');
  if v_name is null then
    raise exception 'create_room_booking_rule_with_workflow: rule name required'
      using errcode = 'P0001';
  end if;

  -- 1. INSERT the rule. tenant_id forced = p_tenant_id (#0 invariant) —
  --    NEVER trusted from p_rule_data. Column list mirrors
  --    00121_room_booking_rules.sql:5-24 + the 00400 FK column.
  insert into public.room_booking_rules (
    id, tenant_id, name, description, target_scope, target_id,
    applies_when, effect, approval_config, denial_message, priority,
    template_id, template_params, active, created_by, updated_by
  )
  values (
    v_rule_id,
    p_tenant_id,
    v_name,
    nullif(btrim(coalesce(p_rule_data->>'description', '')), ''),
    p_rule_data->>'target_scope',
    nullif(p_rule_data->>'target_id', '')::uuid,
    coalesce(p_rule_data->'applies_when', '{}'::jsonb),
    p_rule_data->>'effect',
    case when jsonb_typeof(p_rule_data->'approval_config') in ('object','array')
         then p_rule_data->'approval_config' else null end,
    nullif(btrim(coalesce(p_rule_data->>'denial_message', '')), ''),
    coalesce((p_rule_data->>'priority')::int, 100),
    nullif(p_rule_data->>'template_id', ''),
    case when jsonb_typeof(p_rule_data->'template_params') in ('object','array')
         then p_rule_data->'template_params' else null end,
    coalesce((p_rule_data->>'active')::boolean, true),
    p_actor_user_id,
    p_actor_user_id
  )
  returning * into v_rule;

  -- 2. Mint + attach the workflow_definition iff a compiled graph was
  --    supplied. Mirrors ensure_room_booking_rule_workflow_definition's
  --    INSERT shape (00400:234-242) but version is unconditionally 1 (this
  --    is a brand-new rule — no prior versions can exist). The
  --    workflow_definitions_assert_source_rule_tenant trigger (00400:171-173)
  --    and room_booking_rules_assert_workflow_definition_tenant trigger
  --    (00400:140-142) both fire here and reject a cross-tenant FK with P0001.
  if p_graph_definition is not null then
    v_def_id  := gen_random_uuid();
    v_version := 1;
    insert into public.workflow_definitions (
      id, tenant_id, name, entity_type, status, version,
      graph_definition, source_rule_id, created_by, published_at, created_at
    )
    values (
      v_def_id, p_tenant_id, 'Approval — ' || v_rule.name,
      'booking', 'published', v_version,
      p_graph_definition, v_rule_id, p_actor_user_id, now(), now()
    );

    update public.room_booking_rules
       set workflow_definition_id = v_def_id
     where id = v_rule_id
       and tenant_id = p_tenant_id
    returning * into v_rule;
  end if;

  return jsonb_build_object(
    'rule',          to_jsonb(v_rule),
    'definition_id', v_def_id,
    'version',       v_version
  );
end $$;

revoke execute on function public.create_room_booking_rule_with_workflow(uuid, jsonb, jsonb, uuid) from public;
grant  execute on function public.create_room_booking_rule_with_workflow(uuid, jsonb, jsonb, uuid) to service_role;

comment on function public.create_room_booking_rule_with_workflow(uuid, jsonb, jsonb, uuid) is
  'Phase 1.5 — atomic INSERT room_booking_rules + (iff graph supplied)
   INSERT workflow_definitions v1 published + flip the rule FK, in one tx.
   Replaces the TS INSERT-then-recompile-then-compensate path
   (room-booking-rules.service.ts create()). Returns
   {rule, definition_id, version}. tenant_id forced = p_tenant_id on every
   row. P0001 = bad input, P0002 = not found — TS maps to
   room_rule.workflow_recompile_failed.';

-- ── B. update_room_booking_rule_with_workflow ─────────────────────────────
--    One transaction:
--      1. UPDATE the rule with the patch columns present in p_patch.
--      2. IFF p_recompile (TS decides: approval_config OR name changed —
--         room-booking-rules.service.ts:313) call the existing
--         ensure_room_booking_rule_workflow_definition RPC (00400:187-283)
--         INSIDE this same tx. That RPC row-locks the rule, computes the
--         next version under the lock, INSERTs the new published definition,
--         archives prior versions safe to archive, and flips the FK.
--      3. RETURN the same-shaped jsonb as the create RPC.
--
--    p_patch carries ONLY the columns the TS .update() path actually sets
--    (a sparse object mirroring the `body` map at
--    room-booking-rules.service.ts:265-284). A key absent from p_patch is
--    NOT touched (COALESCE-from-existing semantics via the
--    `p_patch ? 'col'` membership test). updated_at/updated_by are always
--    set (matches ibid:266-267).

create or replace function public.update_room_booking_rule_with_workflow(
  p_tenant_id        uuid,
  p_rule_id          uuid,
  p_patch            jsonb,
  p_recompile        boolean,
  p_actor_user_id    uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_rule    public.room_booking_rules%rowtype;
  v_def     record;
  v_def_id  uuid;
  v_version integer;
begin
  if p_tenant_id is null then
    raise exception 'update_room_booking_rule_with_workflow: p_tenant_id required'
      using errcode = 'P0001';
  end if;
  if p_rule_id is null then
    raise exception 'update_room_booking_rule_with_workflow: p_rule_id required'
      using errcode = 'P0001';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'update_room_booking_rule_with_workflow: p_patch must be a json object'
      using errcode = 'P0001';
  end if;

  -- 1. Sparse UPDATE. Each column is written only when its key is present
  --    in p_patch; otherwise it keeps its current value. tenant_id is the
  --    scoping predicate and is never mutated.
  update public.room_booking_rules r
     set name = case when p_patch ? 'name'
                     then p_patch->>'name' else r.name end,
         description = case when p_patch ? 'description'
                            then nullif(btrim(coalesce(p_patch->>'description','')), '')
                            else r.description end,
         target_scope = case when p_patch ? 'target_scope'
                             then p_patch->>'target_scope' else r.target_scope end,
         target_id = case when p_patch ? 'target_id'
                          then nullif(p_patch->>'target_id', '')::uuid
                          else r.target_id end,
         applies_when = case when p_patch ? 'applies_when'
                             then p_patch->'applies_when' else r.applies_when end,
         effect = case when p_patch ? 'effect'
                       then p_patch->>'effect' else r.effect end,
         approval_config = case when p_patch ? 'approval_config'
                                then (case when jsonb_typeof(p_patch->'approval_config') in ('object','array')
                                           then p_patch->'approval_config' else null end)
                                else r.approval_config end,
         denial_message = case when p_patch ? 'denial_message'
                                then nullif(btrim(coalesce(p_patch->>'denial_message','')), '')
                                else r.denial_message end,
         priority = case when p_patch ? 'priority'
                         then (p_patch->>'priority')::int else r.priority end,
         template_id = case when p_patch ? 'template_id'
                            then nullif(p_patch->>'template_id', '') else r.template_id end,
         template_params = case when p_patch ? 'template_params'
                                then (case when jsonb_typeof(p_patch->'template_params') in ('object','array')
                                           then p_patch->'template_params' else null end)
                                else r.template_params end,
         active = case when p_patch ? 'active'
                       then (p_patch->>'active')::boolean else r.active end,
         updated_at = now(),
         updated_by = p_actor_user_id
   where r.id = p_rule_id
     and r.tenant_id = p_tenant_id
  returning r.* into v_rule;

  if not found then
    raise exception
      'update_room_booking_rule_with_workflow: rule % not found in tenant %',
      p_rule_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  -- 2. Recompile iff TS asked for it (approval_config OR name changed).
  --    Reuses the canonical ensure_room_booking_rule_workflow_definition
  --    RPC (00400:187-283) INSIDE this tx — version bump + archive + FK
  --    flip are race-free under its per-rule FOR UPDATE row lock. When the
  --    rule has no approval_config the TS side passes p_recompile=false
  --    OR a null graph; here we mirror the TS guard: only recompile when
  --    approval_config is non-null (the rule actually needs a workflow).
  if p_recompile and v_rule.approval_config is not null then
    select definition_id, version
      into v_def
      from public.ensure_room_booking_rule_workflow_definition(
        p_rule_id,
        p_tenant_id,
        -- Re-derive the canonical graph from the post-UPDATE approval_config
        -- exactly like 00400 block F (the per-rule backfill,
        -- 00400:447-478). Keeping graph assembly in SQL keeps the
        -- byte-equality contract with ApprovalConfigCompilerService — but
        -- the TS side ALSO supplies the compiled graph for create(); for
        -- update we let the existing RPC + this canonical builder own it
        -- so the two write paths converge on one graph shape.
        jsonb_build_object(
          'nodes', jsonb_build_array(
            jsonb_build_object('id', 'trigger', 'type', 'trigger',
              'config', jsonb_build_object()),
            jsonb_build_object('id', 'approval_main', 'type', 'approval',
              'config', jsonb_build_object(
                'required_approvers', v_rule.approval_config->'required_approvers',
                'threshold', coalesce(v_rule.approval_config->>'threshold', 'all'))),
            jsonb_build_object('id', 'end_success', 'type', 'end',
              'config', jsonb_build_object('outcome', 'approved')),
            jsonb_build_object('id', 'end_failure', 'type', 'end',
              'config', jsonb_build_object('outcome', 'rejected'))
          ),
          'edges', jsonb_build_array(
            jsonb_build_object('from', 'trigger', 'to', 'approval_main'),
            jsonb_build_object('from', 'approval_main', 'to', 'end_success', 'condition', 'approved'),
            jsonb_build_object('from', 'approval_main', 'to', 'end_failure', 'condition', 'rejected')
          )
        ),
        v_rule.name
      );
    v_def_id  := v_def.definition_id;
    v_version := v_def.version;

    -- The ensure RPC already flips workflow_definition_id; re-read so the
    -- returned rule snapshot reflects the post-flip FK.
    select * into v_rule
      from public.room_booking_rules
     where id = p_rule_id
       and tenant_id = p_tenant_id;
  else
    v_def_id  := v_rule.workflow_definition_id;
    v_version := null;
  end if;

  return jsonb_build_object(
    'rule',          to_jsonb(v_rule),
    'definition_id', v_def_id,
    'version',       v_version
  );
end $$;

revoke execute on function public.update_room_booking_rule_with_workflow(uuid, uuid, jsonb, boolean, uuid) from public;
grant  execute on function public.update_room_booking_rule_with_workflow(uuid, uuid, jsonb, boolean, uuid) to service_role;

comment on function public.update_room_booking_rule_with_workflow(uuid, uuid, jsonb, boolean, uuid) is
  'Phase 1.5 — atomic sparse UPDATE room_booking_rules + (iff p_recompile
   AND approval_config non-null) ensure_room_booking_rule_workflow_definition,
   in one tx. Replaces the TS UPDATE-then-recompile path
   (room-booking-rules.service.ts update()). Returns
   {rule, definition_id, version}. tenant_id is the scoping predicate, never
   mutated. P0001 = bad input, P0002 = not found — TS maps to
   room_rule.workflow_recompile_failed.';

-- ── C. PostgREST schema cache reload (matches 00400:602, 00403:405). ──────
notify pgrst, 'reload schema';
