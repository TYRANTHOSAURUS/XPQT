-- Audit 02 (tickets/work-orders) Slice A — set_entity_assignment v3.
--
-- Supersedes: 00327_set_entity_assignment_v2.sql (same 6-arg signature;
--   CREATE OR REPLACE — in-place replacement, NOT a new overload).
--
-- ── Why v3 ──────────────────────────────────────────────────────────────
--
-- v3 in-place replacement, identical signature. Observable writes
-- byte-identical to v2 iff p_payload has none of keys
-- {watchers, decision, clear_routing_status}. New keys read from
-- p_payload (covered by the existing payload hash, F16). No-op
-- early-return extended (F17) so any new directive forces the full
-- write path.
--
-- The 6-arg signature is byte-identical to v2 (F4). Appending RPC
-- params would create a *new overload* and leave v2's 6-arg body live
-- for the 3 existing prod callers — a production-breaking footgun. The
-- three new behaviours are OPTIONAL keys inside the existing
-- `p_payload jsonb`:
--   * p_payload->'watchers'              — replace the entity's watcher set
--   * p_payload->'decision'              — caller-supplied routing provenance
--   * p_payload->>'clear_routing_status' — 'true' resets case routing state
-- Because they live in p_payload, v2's existing payload-hash idempotency
-- gate (00327:133, F16) already covers them — UNCHANGED here.
--
-- Branch-by-branch citation against the v2 source (00327):
--   * signature                 00327:64-71  (byte-identical, F4)
--   * arg shape checks          00327:106-126 (verbatim)
--   * advisory lock             00327:128-130 (verbatim)
--   * payload-hash + CO gate    00327:132-156 (verbatim; F16 hash UNCHANGED)
--   * key-presence detection    00327:158-161 (verbatim)
--   * FOR UPDATE arms           00327:164-176 (F5; + `watchers` column added
--                                              to BOTH arms — inert when the
--                                              `watchers` key is absent)
--   * prev-var capture          00327:183-186 (verbatim; + v_prev_watchers)
--   * target compute            00327:188-191 (verbatim)
--   * validate_assignees        00327:194     (verbatim)
--   * status_category inherit   00327:196-202 (verbatim)
--   * reason/actor extract      00327:204-206 (verbatim)
--   * no-op fast path           00327:208-237 (F17; condition EXTENDED with
--                                              the three new-directive guards)
--   * UPDATE arms               00327:240-256 (F6; + watchers set on BOTH
--                                              arms; + routing_status reset
--                                              on the CASE arm only — both
--                                              guarded so absent keys ⇒ v2)
--   * routing_decisions audit   00327:258-288 (F7; guard widened to also fire
--                                              on `decision`; values from the
--                                              decision object when present,
--                                              hardcoded 'manual'/'manual_reassign'
--                                              byte-identical when absent)
--   * actor_person resolve      00327:290-299 (verbatim)
--   * metadata build            00327:301-358 (verbatim path; + watchers
--                                              reflected when present)
--   * ticket_activities insert  00327:360-376 (verbatim path)
--   * domain_events insert      00327:378-410 (verbatim path; + watcher
--                                              previous/next when present)
--   * result + CO success       00327:412-432 (verbatim path)
--   * revoke/grant              00327:436-437 (verbatim)
--   * comment                   00327:439-440 (updated for v3)
--
-- Watcher validator transplant (F2): the WHOLE block from
-- 00384_update_entity_combined_v6_plan_version_lock.sql:596-654 — the
-- JSON-type guard, the UUID-string-shape regex, the stable dedup/order,
-- the `c_max_watchers` (=200, 00384:171) cap, the public.persons
-- predicate (tenant + active + anonymized_at is null + left_at is null,
-- 00384:634-645), and the mismatch-error semantics — transplanted
-- verbatim with the error code rebased to `set_entity_assignment.invalid_*`
-- (registered in packages/shared/src/error-codes.ts +
-- apps/api/src/common/errors/messages.{en,nl}.ts).
--
-- decision allowlist (Step 2): strategy ∈ FulfillmentShape | 'rule'
-- (apps/api/src/modules/routing/resolver.types.ts:1 +
-- routing.service.ts:18) = {asset, location, fixed, auto, rule};
-- chosen_by ∈ ChosenBy (resolver.types.ts:8-27) = {rule, asset_override,
-- asset_type_default, location_team, parent_location_team,
-- space_group_team, domain_fallback, request_type_default,
-- scope_override, scope_override_unassigned, policy_row, policy_default,
-- unassigned}. No DB CHECK on routing_decisions.strategy/chosen_by
-- (00027:62,66 — plain text), so v3 validates in-function (F8).
--
-- decision.rule_id tenant guard (§7c): routing_decisions.rule_id FK is
-- a GLOBAL `references public.routing_rules(id)` (00027:67 — NOT tenant-
-- scoped). A caller-supplied non-existent rule_id would raise raw 23503
-- (unparseable by map-rpc-error.ts extractCode → 500); a foreign-tenant
-- rule_id would FK-succeed and write cross-tenant audit data. v3 adds a
-- tenant-scoped `exists` check on public.routing_rules (tenant_id is
-- `not null`, 00018:5) inside the decision branch — raised with the
-- exact invalid_decision shape/sqlstate so it maps to the registered
-- 400. Inert when `decision` is absent (rule_id provably NULL, v2-equiv).
--
-- clear_routing_status: tickets.routing_status CHECK is
-- ('idle','pending','failed') (00320:34-35); 'idle' is valid. WO arm
-- untouched (routing_status lives on tickets only — 00320:33).
--
-- Spec: docs/follow-ups/audits/02-tickets-work-orders.md (assignment
-- atomicity remediation, Slice A).

create or replace function public.set_entity_assignment(
  p_entity_id        uuid,
  p_entity_kind      text,
  p_tenant_id        uuid,
  p_actor_user_id    uuid,
  p_idempotency_key  text,
  p_payload          jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_existing               public.command_operations;
  v_payload_hash           text;
  v_lock_key               bigint;
  v_current                record;
  v_prev_team              uuid;
  v_prev_user              uuid;
  v_prev_vendor            uuid;
  v_prev_status_category   text;
  v_new_team               uuid;
  v_new_user               uuid;
  v_new_vendor             uuid;
  v_new_status_category    text;
  v_has_team_key           boolean;
  v_has_user_key           boolean;
  v_has_vendor_key         boolean;
  v_any_new_assignee       boolean;
  v_team_changed           boolean;
  v_user_changed           boolean;
  v_vendor_changed         boolean;
  v_changed_axes           int;
  v_reason                 text;
  v_actor_person_id        uuid;
  v_payload_actor_person   uuid;
  v_activity_event         text;
  v_metadata_previous      jsonb;
  v_metadata_next          jsonb;
  v_event_type             text;
  v_result                 jsonb;
  -- ── v3 additive locals (inert when the corresponding key is absent) ──
  v_has_watchers_key       boolean := false;
  v_prev_watchers          uuid[];
  v_new_watchers           uuid[];
  v_new_watchers_unique    uuid[];
  v_watchers_raw           jsonb;
  v_watcher_elem           jsonb;
  v_watcher_str            text;
  v_watcher_match_count    int;
  v_watchers_changed       boolean := false;
  v_has_decision_key       boolean := false;
  v_decision               jsonb;
  v_decision_strategy      text;
  v_decision_chosen_by     text;
  v_decision_rule_id       uuid;
  v_decision_trace         jsonb;
  v_decision_context       jsonb;
  v_clear_routing_status   boolean := false;
  c_max_watchers   constant int  := 200;
begin
  -- ── 0. Argument shape checks ────────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'set_entity_assignment: p_tenant_id required';
  end if;
  if p_entity_id is null then
    raise exception 'set_entity_assignment: p_entity_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'set_entity_assignment: p_idempotency_key required';
  end if;
  if p_entity_kind is null or p_entity_kind not in ('case','work_order') then
    raise exception 'set_entity_assignment.unknown_kind: kind=%', coalesce(p_entity_kind, '<null>')
      using errcode = 'P0001';
  end if;

  -- ── 1. Reject rerun_resolver at this layer (spec lines 2012-2017) ──────
  if (p_payload ? 'rerun_resolver') and (p_payload->>'rerun_resolver') = 'true' then
    raise exception 'set_entity_assignment.resolver_rerun_not_supported_at_rpc'
      using errcode = 'P0001',
            hint = 'TS layer must call RoutingService.evaluate then re-invoke this RPC with the resolved assignees';
  end if;

  -- ── 2. Advisory lock (mirror 00323:104-106) ────────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 3. command_operations idempotency gate (00316) ─────────────────────
  --
  -- F16: hash covers the WHOLE p_payload. The v3 keys (watchers,
  -- decision, clear_routing_status) live INSIDE p_payload, so they are
  -- automatically part of this hash — same key + different watchers ⇒
  -- payload_mismatch. This line is UNCHANGED from v2 (00327:133); that
  -- coverage is the whole point of putting the new behaviours in
  -- p_payload rather than new RPC params.
  v_payload_hash := md5(coalesce(p_payload::text, ''));

  select * into v_existing
    from public.command_operations
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.outcome = 'success' and v_existing.payload_hash = v_payload_hash then
      return v_existing.cached_result;
    elsif v_existing.payload_hash <> v_payload_hash then
      raise exception 'command_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different payload';
    else
      raise exception 'command_operations.unexpected_state outcome=% hash_match=%',
        v_existing.outcome,
        (v_existing.payload_hash = v_payload_hash)
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.command_operations
    (tenant_id, idempotency_key, payload_hash, outcome)
  values (p_tenant_id, p_idempotency_key, v_payload_hash, 'in_progress');

  -- ── 4. Detect which assignment keys are present in payload ─────────────
  v_has_team_key   := p_payload ? 'assigned_team_id';
  v_has_user_key   := p_payload ? 'assigned_user_id';
  v_has_vendor_key := p_payload ? 'assigned_vendor_id';

  -- v3: detect the three optional directives.
  v_has_watchers_key     := p_payload ? 'watchers';
  v_has_decision_key     := p_payload ? 'decision';
  v_clear_routing_status := coalesce(p_payload->>'clear_routing_status', '') = 'true';

  -- ── 5. SELECT FOR UPDATE on the right entity table ─────────────────────
  if p_entity_kind = 'case' then
    select id, assigned_team_id, assigned_user_id, assigned_vendor_id, status_category, watchers
      into v_current
      from public.tickets
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  else
    select id, assigned_team_id, assigned_user_id, assigned_vendor_id, status_category, watchers
      into v_current
      from public.work_orders
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  end if;

  if not found then
    raise exception 'set_entity_assignment.not_found: kind=% id=%', p_entity_kind, p_entity_id
      using errcode = 'P0001';
  end if;

  v_prev_team            := v_current.assigned_team_id;
  v_prev_user            := v_current.assigned_user_id;
  v_prev_vendor          := v_current.assigned_vendor_id;
  v_prev_status_category := v_current.status_category;
  v_prev_watchers        := v_current.watchers;

  -- ── 6. Compute target values (key-absent = no change) ──────────────────
  v_new_team   := case when v_has_team_key   then nullif(p_payload->>'assigned_team_id',   '')::uuid else v_prev_team   end;
  v_new_user   := case when v_has_user_key   then nullif(p_payload->>'assigned_user_id',   '')::uuid else v_prev_user   end;
  v_new_vendor := case when v_has_vendor_key then nullif(p_payload->>'assigned_vendor_id', '')::uuid else v_prev_vendor end;

  -- ── 7. Validate non-null assignees are tenant-owned (00317 helper) ─────
  perform public.validate_assignees_in_tenant(p_tenant_id, v_new_team, v_new_user, v_new_vendor);

  -- ── 7b. v3 watcher validation (transplant of 00384:596-654, F2) ───────
  --
  -- Whole-block transplant: JSON-type guard, UUID-string-shape regex,
  -- stable dedup/order, max-count cap, public.persons predicate
  -- (tenant + active + anonymized_at is null + left_at is null), and the
  -- mismatch-error semantics. Error code rebased to
  -- `set_entity_assignment.invalid_watcher` (registered in
  -- packages/shared/src/error-codes.ts + messages.{en,nl}.ts). When the
  -- `watchers` key is absent this whole block is skipped and
  -- v_watchers_changed stays false (declared default), so the UPDATE arm
  -- writes the existing column value back — observably inert.
  if v_has_watchers_key then
    v_watchers_raw := p_payload->'watchers';
    if jsonb_typeof(v_watchers_raw) = 'null' then
      v_new_watchers        := null;
      v_new_watchers_unique := null;
    elsif jsonb_typeof(v_watchers_raw) = 'array' then
      v_new_watchers := '{}'::uuid[];
      for v_watcher_elem in select * from jsonb_array_elements(v_watchers_raw) loop
        if jsonb_typeof(v_watcher_elem) <> 'string' then
          raise exception 'set_entity_assignment.invalid_watcher: watcher ids must be valid uuids (got element jsonb type %)',
            jsonb_typeof(v_watcher_elem)
            using errcode = 'P0001';
        end if;
        v_watcher_str := v_watcher_elem #>> '{}';
        if v_watcher_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'set_entity_assignment.invalid_watcher: watcher ids must be valid uuids (got %)',
            v_watcher_str
            using errcode = 'P0001';
        end if;
        v_new_watchers := v_new_watchers || v_watcher_str::uuid;
      end loop;

      v_new_watchers_unique := (
        select coalesce(array_agg(elem order by ord), '{}'::uuid[])
          from (
            select distinct on (elem) elem, ord
              from unnest(v_new_watchers) with ordinality as t(elem, ord)
              order by elem, ord
          ) s
      );

      if cardinality(v_new_watchers_unique) > c_max_watchers then
        raise exception 'set_entity_assignment.invalid_watcher: watchers array too large (% unique uuids); maximum is % per request',
          cardinality(v_new_watchers_unique), c_max_watchers
          using errcode = 'P0001';
      end if;

      if cardinality(v_new_watchers_unique) > 0 then
        select count(*) into v_watcher_match_count
          from public.persons
         where tenant_id     = p_tenant_id
           and id            = any(v_new_watchers_unique)
           and active        = true
           and anonymized_at is null
           and left_at       is null;
        if v_watcher_match_count <> cardinality(v_new_watchers_unique) then
          raise exception 'set_entity_assignment.invalid_watcher: one or more watchers are unknown, deactivated, anonymized, or off-boarded in this tenant'
            using errcode = 'P0001';
        end if;
      end if;

      v_new_watchers := v_new_watchers_unique;
    else
      raise exception 'set_entity_assignment.invalid_watcher: watchers must be a jsonb array or null (got jsonb type %)',
        jsonb_typeof(v_watchers_raw)
        using errcode = 'P0001';
    end if;
    v_watchers_changed := v_new_watchers is distinct from v_prev_watchers;
  end if;

  -- ── 7c. v3 decision validation (F8 — no DB CHECK on the columns) ──────
  --
  -- When the `decision` key is present the caller supplies the routing
  -- provenance directly (SLA escalation, resolver-evaluation handler).
  -- strategy/chosen_by are validated against the TS allowlists
  -- (resolver.types.ts) since routing_decisions has no DB constraint
  -- (00027:62,66). When absent, the routing_decisions insert below is
  -- byte-identical to v2 (hardcoded 'manual'/'manual_reassign', F7).
  if v_has_decision_key then
    v_decision := p_payload->'decision';
    if jsonb_typeof(v_decision) <> 'object' then
      raise exception 'set_entity_assignment.invalid_decision: decision must be a jsonb object (got jsonb type %)',
        jsonb_typeof(v_decision)
        using errcode = 'P0001';
    end if;
    v_decision_strategy  := v_decision->>'strategy';
    v_decision_chosen_by := v_decision->>'chosen_by';
    -- KEEP IN SYNC WITH apps/api/src/modules/routing/resolver.types.ts:1
    --   (FulfillmentShape) + :97 (ResolverDecision.strategy =
    --   FulfillmentShape | 'rule'). routing_decisions.strategy is plain
    --   text (00027:62, no DB CHECK) so this allowlist is the only gate;
    --   a resolver-types change must update this list in the same PR.
    if v_decision_strategy is null
       or v_decision_strategy not in ('asset','location','fixed','auto','rule') then
      raise exception 'set_entity_assignment.invalid_decision: strategy must be one of asset, location, fixed, auto, rule (got %)',
        coalesce(v_decision_strategy, '<null>')
        using errcode = 'P0001';
    end if;
    -- KEEP IN SYNC WITH apps/api/src/modules/routing/resolver.types.ts:8-27
    --   (the ChosenBy union). routing_decisions.chosen_by is plain text
    --   (00027:66, no DB CHECK) so this allowlist is the only gate; a
    --   ChosenBy change must update this list in the same PR.
    if v_decision_chosen_by is null
       or v_decision_chosen_by not in (
            'rule','asset_override','asset_type_default','location_team',
            'parent_location_team','space_group_team','domain_fallback',
            'request_type_default','scope_override','scope_override_unassigned',
            'policy_row','policy_default','unassigned'
          ) then
      raise exception 'set_entity_assignment.invalid_decision: chosen_by is not a recognised provenance value (got %)',
        coalesce(v_decision_chosen_by, '<null>')
        using errcode = 'P0001';
    end if;
    v_decision_rule_id := nullif(v_decision->>'rule_id', '')::uuid;
    -- Tenant-isolation guard for the caller-supplied rule_id. The
    -- routing_decisions.rule_id FK references public.routing_rules(id)
    -- with NO tenant scope (00027:67 — plain `references
    -- public.routing_rules(id)`). Two failure modes this closes:
    --   (a) a non-existent rule_id would raise raw Postgres 23503 at the
    --       routing_decisions INSERT, which extractCode (map-rpc-error.ts
    --       :436-442 — anchors on a leading `<ns>.<specifier>` token) and
    --       STATUS_BY_CODE cannot parse → 500 unknown.server_error
    --       instead of the curated 400 set_entity_assignment.invalid_decision.
    --   (b) a foreign-tenant rule_id would FK-SUCCEED (the FK is global)
    --       and write cross-tenant provenance into this tenant's audit
    --       table — a tenant-isolation breach (#0 invariant).
    -- routing_rules.tenant_id is `not null` (00018:5), so the tenant-
    -- scoped existence check below doubles as the cross-tenant guard.
    -- Same raise shape + sqlstate as the strategy/chosen_by/invalid_watcher
    -- raises in this file so extractCode maps it to the registered 400
    -- code set_entity_assignment.invalid_decision. Runs inside the same
    -- advisory-lock + FOR UPDATE scope as the rest of this branch.
    if v_decision_rule_id is not null
       and not exists (
         select 1 from public.routing_rules
          where id = v_decision_rule_id and tenant_id = p_tenant_id
       ) then
      raise exception 'set_entity_assignment.invalid_decision: rule_id not found in tenant'
        using errcode = 'P0001';
    end if;
    v_decision_trace   := coalesce(v_decision->'trace', '[]'::jsonb);
    if jsonb_typeof(v_decision_trace) <> 'array' then
      raise exception 'set_entity_assignment.invalid_decision: trace must be a jsonb array'
        using errcode = 'P0001';
    end if;
    v_decision_context := coalesce(v_decision->'context', '{}'::jsonb);
    if jsonb_typeof(v_decision_context) <> 'object' then
      raise exception 'set_entity_assignment.invalid_decision: context must be a jsonb object'
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 8. status_category inheritance ─────────────────────────────────────
  v_any_new_assignee := (v_new_team is not null or v_new_user is not null or v_new_vendor is not null);
  v_new_status_category :=
    case
      when v_any_new_assignee and v_prev_status_category = 'new' then 'assigned'
      else v_prev_status_category
    end;

  -- Reason + actor_person_id from payload.
  v_reason := nullif(p_payload->>'reason', '');
  v_payload_actor_person := nullif(p_payload->>'actor_person_id', '')::uuid;

  -- ── 9. No-op fast path (F17 — EXTENDED for v3) ────────────────────────
  --
  -- v2: fired when all three target assignees match current AND no
  -- reason present. v3 ADDS three guards so any new directive forces
  -- the full write path:
  --   * not (p_payload ? 'watchers')              — a watcher replace must commit
  --   * not (p_payload ? 'decision')              — a caller-supplied audit row must commit
  --   * coalesce(...->>'clear_routing_status') <> 'true' — a status reset must commit
  -- Absent all three ⇒ the condition is byte-identical to v2 (00327:212-215).
  if v_new_team   is not distinct from v_prev_team
     and v_new_user   is not distinct from v_prev_user
     and v_new_vendor is not distinct from v_prev_vendor
     and v_reason is null
     and not v_has_watchers_key
     and not v_has_decision_key
     and not v_clear_routing_status then

    v_result := jsonb_build_object(
      'entity_id',                   p_entity_id,
      'entity_kind',                 p_entity_kind,
      'previous_assigned_team_id',   v_prev_team,
      'previous_assigned_user_id',   v_prev_user,
      'previous_assigned_vendor_id', v_prev_vendor,
      'new_assigned_team_id',        v_new_team,
      'new_assigned_user_id',        v_new_user,
      'new_assigned_vendor_id',      v_new_vendor,
      'previous_status_category',    v_prev_status_category,
      'new_status_category',         v_new_status_category,
      'reason',                      null,
      'noop',                        true
    );

    update public.command_operations
       set outcome = 'success', cached_result = v_result, completed_at = now()
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

    return v_result;
  end if;

  -- ── 10. UPDATE the row ────────────────────────────────────────────────
  --
  -- v3 additions, both guarded so absent keys ⇒ v2 behaviour:
  --   * watchers — set on BOTH arms only when the key is present
  --     (`v_has_watchers_key`); otherwise the column writes its own
  --     value back (observably inert, same as v2 which never named it).
  --   * routing_status / routing_failure_reason — reset on the CASE
  --     arm ONLY when `clear_routing_status='true'`. routing_status
  --     lives on tickets only (00320:33); the WO arm is untouched.
  if p_entity_kind = 'case' then
    update public.tickets
       set assigned_team_id   = case when v_has_team_key   then v_new_team   else assigned_team_id   end,
           assigned_user_id   = case when v_has_user_key   then v_new_user   else assigned_user_id   end,
           assigned_vendor_id = case when v_has_vendor_key then v_new_vendor else assigned_vendor_id end,
           status_category    = v_new_status_category,
           watchers           = case when v_has_watchers_key   then v_new_watchers else watchers               end,
           routing_status     = case when v_clear_routing_status then 'idle'       else routing_status         end,
           routing_failure_reason = case when v_clear_routing_status then null     else routing_failure_reason end,
           updated_at         = now()
     where id = p_entity_id and tenant_id = p_tenant_id;
  else
    update public.work_orders
       set assigned_team_id   = case when v_has_team_key   then v_new_team   else assigned_team_id   end,
           assigned_user_id   = case when v_has_user_key   then v_new_user   else assigned_user_id   end,
           assigned_vendor_id = case when v_has_vendor_key then v_new_vendor else assigned_vendor_id end,
           status_category    = v_new_status_category,
           watchers           = case when v_has_watchers_key then v_new_watchers else watchers end,
           updated_at         = now()
     where id = p_entity_id and tenant_id = p_tenant_id;
  end if;

  -- ── 11. routing_decisions audit row (F7 — guard widened for v3) ───────
  --
  -- v2: fired only when `reason` present, hardcoded
  -- strategy='manual'/chosen_by='manual_reassign'. v3 widens the guard
  -- to `v_reason is not null or v_has_decision_key`. When `decision`
  -- present, the row carries the caller-supplied
  -- strategy/chosen_by/rule_id/trace/context. When absent, the values
  -- are byte-identical to v2 (hardcoded 'manual'/'manual_reassign',
  -- '[]'::jsonb trace, the reason/previous/actor context). The
  -- polymorphic entity_kind/case_id/work_order_id columns stay explicit
  -- per F7 in BOTH paths.
  if v_reason is not null or v_has_decision_key then
    insert into public.routing_decisions (
      tenant_id, ticket_id,
      entity_kind,
      case_id, work_order_id,
      strategy, chosen_team_id, chosen_user_id, chosen_vendor_id,
      chosen_by, rule_id, trace, context
    ) values (
      p_tenant_id,
      p_entity_id,
      p_entity_kind,
      case when p_entity_kind = 'case'       then p_entity_id else null end,
      case when p_entity_kind = 'work_order' then p_entity_id else null end,
      case when v_has_decision_key then v_decision_strategy  else 'manual'          end,
      v_new_team,
      v_new_user,
      v_new_vendor,
      case when v_has_decision_key then v_decision_chosen_by else 'manual_reassign' end,
      -- rule_id: on the decision path (v_has_decision_key) v_decision_rule_id
      -- is validated above (existence + tenant scope, §7c) so the global FK
      -- to public.routing_rules(id) (00027:67, no tenant scope) cannot 23503
      -- nor accept a foreign-tenant row. On the absent-decision path this is
      -- provably NULL — byte-identical to v2's column omission (00327:265,
      -- which never named rule_id), so the v2-equivalence claim holds.
      case when v_has_decision_key then v_decision_rule_id   else null              end,
      case when v_has_decision_key then v_decision_trace     else '[]'::jsonb       end,
      case
        when v_has_decision_key then v_decision_context
        else jsonb_build_object(
          'reason',   v_reason,
          'previous', jsonb_build_object(
            'assigned_team_id',   v_prev_team,
            'assigned_user_id',   v_prev_user,
            'assigned_vendor_id', v_prev_vendor
          ),
          'actor',    v_payload_actor_person
        )
      end
    );
  end if;

  -- ── 12. Resolve actor_person_id for ticket_activities ─────────────────
  if v_payload_actor_person is not null then
    v_actor_person_id := v_payload_actor_person;
  elsif p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 13. Build metadata.previous + metadata.next per event ─────────────
  --
  -- C3 alignment with TS callers:
  --
  --  * assignment_changed (silent path; ticket.service.ts:1193-1216):
  --    previous + next include ONLY changed fields with the long
  --    `assigned_*_id` keys.
  --
  --  * reassigned (with-reason; ticket.service.ts:1431-1443):
  --    previous is short keys {team, user, vendor} (all three).
  --    next is {kind, id} for the single non-null target axis.
  --    If multiple axes are simultaneously set, fall back to the
  --    assignment_changed shape so the audit row carries everything.
  --
  -- v3: when `watchers` changed it is reflected under the long-key
  -- `watchers` field in both previous + next so the activity row
  -- carries the watcher delta. The team/user/vendor shape logic is
  -- byte-identical to v2.
  v_team_changed   := v_new_team   is distinct from v_prev_team;
  v_user_changed   := v_new_user   is distinct from v_prev_user;
  v_vendor_changed := v_new_vendor is distinct from v_prev_vendor;
  v_changed_axes := (
      (case when v_new_team   is not null then 1 else 0 end)
    + (case when v_new_user   is not null then 1 else 0 end)
    + (case when v_new_vendor is not null then 1 else 0 end)
  );

  v_activity_event := case when v_reason is not null then 'reassigned' else 'assignment_changed' end;

  if v_activity_event = 'reassigned' and v_changed_axes <= 1 then
    -- Canonical reassign shape: short-keyed previous, {kind,id} next.
    v_metadata_previous := jsonb_build_object(
      'team',   v_prev_team,
      'user',   v_prev_user,
      'vendor', v_prev_vendor
    );
    if v_new_team is not null then
      v_metadata_next := jsonb_build_object('kind', 'team', 'id', v_new_team);
    elsif v_new_user is not null then
      v_metadata_next := jsonb_build_object('kind', 'user', 'id', v_new_user);
    elsif v_new_vendor is not null then
      v_metadata_next := jsonb_build_object('kind', 'vendor', 'id', v_new_vendor);
    else
      v_metadata_next := 'null'::jsonb;
    end if;
  else
    -- assignment_changed shape (or reassigned multi-axis fallback):
    -- only changed fields appear, keys are long-form assigned_*_id.
    v_metadata_previous := '{}'::jsonb;
    v_metadata_next     := '{}'::jsonb;
    if v_team_changed then
      v_metadata_previous := v_metadata_previous || jsonb_build_object('assigned_team_id', v_prev_team);
      v_metadata_next     := v_metadata_next     || jsonb_build_object('assigned_team_id', v_new_team);
    end if;
    if v_user_changed then
      v_metadata_previous := v_metadata_previous || jsonb_build_object('assigned_user_id', v_prev_user);
      v_metadata_next     := v_metadata_next     || jsonb_build_object('assigned_user_id', v_new_user);
    end if;
    if v_vendor_changed then
      v_metadata_previous := v_metadata_previous || jsonb_build_object('assigned_vendor_id', v_prev_vendor);
      v_metadata_next     := v_metadata_next     || jsonb_build_object('assigned_vendor_id', v_new_vendor);
    end if;
  end if;

  -- v3: reflect a watcher change in BOTH metadata shapes (long-key
  -- `watchers`). Only added when the watchers key was present AND the
  -- set actually changed — absent ⇒ byte-identical to v2.
  if v_watchers_changed then
    v_metadata_previous := v_metadata_previous || jsonb_build_object('watchers', to_jsonb(v_prev_watchers));
    v_metadata_next     := v_metadata_next     || jsonb_build_object('watchers', to_jsonb(v_new_watchers));
  end if;

  -- ── 14. INSERT ticket_activities (system_event) ───────────────────────
  insert into public.ticket_activities
    (tenant_id, ticket_id, activity_type, author_person_id, visibility, content, metadata)
  values (
    p_tenant_id,
    p_entity_id,
    'system_event',
    v_actor_person_id,
    case when v_reason is not null then 'internal' else 'system' end,
    v_reason,
    jsonb_build_object(
      'event',    v_activity_event,
      'previous', v_metadata_previous,
      'next',     v_metadata_next,
      'reason',   v_reason
    )
  );

  -- ── 15. INSERT public.domain_events (ticket_assigned) ─────────────────
  --
  -- C1+C2 fix: write to domain_events instead of outbox.events. Both case
  -- and work_order side use event_type='ticket_assigned' + entity_type='ticket'
  -- — entity_id disambiguates per work-order.service.ts:1923-1929 + spec
  -- line 2024. actor_user_id stays NULL (existing TS callers don't fill
  -- it; ticket.service.ts:1685-1692).
  --
  -- v3: the event payload gains previous_watchers/new_watchers ONLY when
  -- a watcher change was committed (absent ⇒ byte-identical to v2).
  v_event_type := 'ticket_assigned';

  insert into public.domain_events
    (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id)
  values (
    p_tenant_id,
    v_event_type,
    'ticket',
    p_entity_id,
    jsonb_build_object(
      'entity_id',                   p_entity_id,
      'entity_kind',                 p_entity_kind,
      'previous_assigned_team_id',   v_prev_team,
      'previous_assigned_user_id',   v_prev_user,
      'previous_assigned_vendor_id', v_prev_vendor,
      'new_assigned_team_id',        v_new_team,
      'new_assigned_user_id',        v_new_user,
      'new_assigned_vendor_id',      v_new_vendor,
      'previous_status_category',    v_prev_status_category,
      'new_status_category',         v_new_status_category,
      'reason',                      v_reason,
      'actor_user_id',               p_actor_user_id,
      'actor_person_id',             v_payload_actor_person
    )
    || case
         when v_watchers_changed then jsonb_build_object(
           'previous_watchers', to_jsonb(v_prev_watchers),
           'new_watchers',      to_jsonb(v_new_watchers)
         )
         else '{}'::jsonb
       end,
    null
  );

  -- ── 16. Mark command_operations success and return ───────────────────
  v_result := jsonb_build_object(
    'entity_id',                   p_entity_id,
    'entity_kind',                 p_entity_kind,
    'previous_assigned_team_id',   v_prev_team,
    'previous_assigned_user_id',   v_prev_user,
    'previous_assigned_vendor_id', v_prev_vendor,
    'new_assigned_team_id',        v_new_team,
    'new_assigned_user_id',        v_new_user,
    'new_assigned_vendor_id',      v_new_vendor,
    'previous_status_category',    v_prev_status_category,
    'new_status_category',         v_new_status_category,
    'reason',                      v_reason,
    'noop',                        false
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke execute on function public.set_entity_assignment(uuid, text, uuid, uuid, text, jsonb) from public;
grant  execute on function public.set_entity_assignment(uuid, text, uuid, uuid, text, jsonb) to service_role;

comment on function public.set_entity_assignment(uuid, text, uuid, uuid, text, jsonb) is
  'Atomic assignment change for cases (tickets) and work_orders. Single transaction commits the row UPDATE (assignment columns + status_category inheritance + optional watcher replace + optional case routing_status reset) + ticket_activities (assignment_changed | reassigned) + optional routing_decisions audit row (when payload.reason present OR payload.decision supplied) + domain_events (ticket_assigned). v3 (audit02 Slice A) extends v2 (00327) IN PLACE — identical 6-arg signature, three OPTIONAL p_payload keys: watchers (validator transplanted from update_entity_combined 00384:596-654), decision (caller-supplied routing provenance, validated against the resolver allowlists since routing_decisions has no DB CHECK), clear_routing_status (resets tickets.routing_status to idle + clears routing_failure_reason). New keys are covered by the existing payload-hash idempotency gate (00327:133, F16, UNCHANGED). No-op fast path extended (F17) so any new directive forces the full write path. Observable writes byte-identical to v2 when none of the three keys are present. Idempotent on (tenant_id, idempotency_key) via command_operations (00316). Resolver-rerun rejected at this layer. Spec: docs/follow-ups/audits/02-tickets-work-orders.md (assignment atomicity remediation, Slice A).';

notify pgrst, 'reload schema';
