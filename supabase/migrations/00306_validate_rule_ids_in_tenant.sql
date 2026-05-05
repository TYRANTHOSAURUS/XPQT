-- B.0.A.5 — validate_rule_ids_in_tenant helper.
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §7.9.1
-- (NEW in v8 — folds I6).
--
-- Defense-in-depth helper for the (forthcoming) approve_booking_setup_trigger
-- RPC. The OLI's pending_setup_trigger_args.ruleIds was validated at plan time
-- via validate_attach_plan_internal_refs (00304 §7d). But the value is then
-- PERSISTED on order_line_items.pending_setup_trigger_args between plan time
-- and approval grant. Admin tooling, a future bulk rule-rewrite migration, or
-- a misbehaving cleanup job could mutate service_rules between plan-time and
-- grant-time, leaving a stale or cross-tenant rule id baked into the
-- persisted args.
--
-- This validator is called inside approve_booking_setup_trigger's emit loop
-- (B.0.B). On the first miss, it raises and the whole grant tx rolls back —
-- no outbox event is emitted, the OLI's args stay non-null, the audit row
-- never lands. The next retry (or a corrected admin operation) re-runs.
--
-- SECURITY INVOKER — runs in the caller's tx. The combined RPC and the
-- approval-grant RPC both call as service_role.

create or replace function public.validate_rule_ids_in_tenant(
  p_tenant_id uuid,
  p_rule_ids  uuid[]
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_missing uuid;
begin
  if p_rule_ids is null or cardinality(p_rule_ids) = 0 then
    return;
  end if;

  -- Find any id in the input that's NOT in service_rules under tenant.
  -- Single round-trip; planner picks an index scan on (tenant_id, id).
  with input_ids as (
    select unnest(p_rule_ids) as id
  )
  select i.id into v_missing
    from input_ids i
   where not exists (
     select 1 from public.service_rules sr
      where sr.id = i.id and sr.tenant_id = p_tenant_id
   )
   limit 1;

  if v_missing is not null then
    raise exception 'setup_wo.rule_id_invalid: % not in tenant service_rules', v_missing
      using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.validate_rule_ids_in_tenant(uuid, uuid[]) from public;
grant  execute on function public.validate_rule_ids_in_tenant(uuid, uuid[]) to service_role;

comment on function public.validate_rule_ids_in_tenant(uuid, uuid[]) is
  'Defense-in-depth helper for v8: validates a UUID[] of rule ids against tenant-scoped public.service_rules. Used by approve_booking_setup_trigger at emit time to catch stale or cross-tenant rule_ids that were persisted on order_line_items.pending_setup_trigger_args between plan time and grant time. Folds v8-I6 of the outbox spec. SECURITY INVOKER; raises 42501 setup_wo.rule_id_invalid: <id>.';
