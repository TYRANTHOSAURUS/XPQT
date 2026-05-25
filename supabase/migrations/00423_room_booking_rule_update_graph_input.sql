-- 00423 — Use the TS approval graph compiler for room-rule update RPCs.
--
-- 00406 made create/update atomic, but update still rebuilt the workflow
-- graph in SQL while create used ApprovalConfigCompilerService. That left
-- two graph producers and let malformed patched approval_config reach the
-- write RPC. The service now pre-compiles the effective approval_config for
-- update(), so this RPC accepts the compiled graph and fails closed if a
-- recompile is requested for an approval rule without one.

drop function if exists public.update_room_booking_rule_with_workflow(
  uuid,
  uuid,
  jsonb,
  boolean,
  uuid
);

create or replace function public.update_room_booking_rule_with_workflow(
  p_tenant_id        uuid,
  p_rule_id          uuid,
  p_patch            jsonb,
  p_recompile        boolean,
  p_graph_definition jsonb,
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

  if p_recompile and v_rule.approval_config is not null then
    if p_graph_definition is null then
      raise exception
        'update_room_booking_rule_with_workflow: p_graph_definition required when recompiling approval rule %',
        p_rule_id
        using errcode = 'P0001';
    end if;

    select definition_id, version
      into v_def
      from public.ensure_room_booking_rule_workflow_definition(
        p_rule_id,
        p_tenant_id,
        p_graph_definition,
        v_rule.name
      );
    v_def_id  := v_def.definition_id;
    v_version := v_def.version;

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

revoke execute on function public.update_room_booking_rule_with_workflow(
  uuid,
  uuid,
  jsonb,
  boolean,
  jsonb,
  uuid
) from public;
grant execute on function public.update_room_booking_rule_with_workflow(
  uuid,
  uuid,
  jsonb,
  boolean,
  jsonb,
  uuid
) to service_role;

comment on function public.update_room_booking_rule_with_workflow(
  uuid,
  uuid,
  jsonb,
  boolean,
  jsonb,
  uuid
) is
  'Phase 1.5 — atomic sparse UPDATE room_booking_rules plus optional workflow
   recompile using the TS-compiled p_graph_definition. Replaces 00406 update
   signature, which rebuilt update graphs in SQL.';

notify pgrst, 'reload schema';
