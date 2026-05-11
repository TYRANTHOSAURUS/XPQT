-- B.4.A.3 — edit_booking RPC v2 (self-review remediation; supersedes 00361).
--
-- Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.2 + §3.4.
--
-- v1 → v2 supersession. v2 drops 00361's function (no transition wrapper,
-- mirrors the B.2.A pattern at 00335 v5 / 00355 v2 / 00358 v3) and recreates
-- it with the 9 self-review fixes folded in:
--
--   Fix 1 (CRITICAL) — extend EditPlan booking sub-object to cover
--     host_person_id (tenant-validated as 'person'),
--     recurrence_overridden (bare boolean),
--     config_release_id (no FK / no validation; spec calls for re-pin every
--     edit). Citations: 00277:37 host_person_id, 00277:76 recurrence_overridden,
--     00277:65 config_release_id. Spec §1 "Mutable field" table row for
--     host_person_id (notifications, cost-center cascade); §9.4 open question
--     "re-pin to current release on every edit (matches edit = new commit
--     semantics)" — pinned by codex review.
--
--   Fix 2 (CRITICAL) — preserve-or-overwrite semantics for ALL optional
--     booking fields. v1 had `case when ? then ... else preserved` ONLY for
--     applied_rule_ids; every other field silently overwrote on key absence.
--     v2 applies the same `case when v_booking_patch ? '<key>' then ... else
--     v_booking.<col> end` to: policy_snapshot, cost_center_id, calendar_etag,
--     host_person_id, recurrence_overridden, config_release_id. TS callers
--     MUST include the key explicitly (with any value, including null) to
--     mutate the column; omission means preserve. location_id, start_at,
--     end_at, cost_amount_snapshot stay REQUIRED — preflight raises
--     edit_booking.invalid_plan_shape if any is missing.
--
--   Fix 3 (IMPORTANT) — narrow stale_resolution gate. v1 queried
--     `max(updated_at) from room_booking_rules where tenant_id = p_tenant_id`,
--     which trips on every tenant-wide rule edit even when nothing about the
--     booking's scope changed. v2 mirrors the resolver's specificity model
--     (rule-resolver.service.ts:84-156 + bucketRulesBySpecificity at
--     :424-464): consider only rules that COULD have matched this booking's
--     location_id. The resolver scopes by target_scope/target_id, NOT by
--     request_type — bookings has no request_type_id column (verified
--     against the live remote schema 2026-05-12). The narrowed filter is:
--       target_scope = 'tenant'                                       (always relevant)
--       OR (target_scope = 'room' AND target_id = v_booking.location_id)
--       OR target_scope IN ('space_subtree', 'room_type')             (conservative include — see TODO)
--     This narrows `room`-scoped rules to the booking's exact location
--     (filters out edits to OTHER rooms' rules — the dominant hot path on a
--     multi-room tenant). `space_subtree` and `room_type` stay tenant-wide
--     because tightening them needs the resolver's ancestor walk
--     (loadAncestorChain at rule-resolver.service.ts:209-236) or a
--     space.type lookup — both non-trivial in PL/pgSQL and a B.4.A.4 follow-up.
--
--   Fix 4 (IMPORTANT) — F-CRIT-2 consistency. v1's command_operations
--     completion UPDATE used `completed_at = now()` while every other
--     persisted timestamp used `v_started_at`. Operationally identical (same
--     transaction), narratively inconsistent. v2 uses v_started_at uniformly.
--
--   Fix 5 (IMPORTANT) — narrow grant. v1 granted execute to
--     `service_role, authenticated`. SECURITY DEFINER bypasses RLS and the
--     canonical caller is the service-role-impersonating supabase-js client.
--     v2 grants to service_role ONLY (mirrors 00309:361, 00310:260, 00358:389).
--
--   Fix 6 (IMPORTANT) — concurrency test scenario 13. The existing suite
--     stopped at 12 scenarios. v2 adds scenario 13 asserting that a work-
--     order patch with needs_repoint=true emits exactly one
--     sla.timer_repointed_required outbox event with shape
--     { work_order_id, started_at, source='edit_booking' }. Producer-side
--     only — the handler is still ticket-specific (sla-timer-repoint.handler.ts
--     :74-100; WO-side extension lives in B.4.A.4 / Phase 8.D).
--
--   Fix 7 (IMPORTANT) — outbox-idempotency assertion on replay. Scenario 2
--     (idempotent replay) now asserts that the outbox emit count is the
--     same after the second call as after the first — no duplicate emits
--     on cached_result return. outbox.emit dedupes on its own
--     idempotency_key, but the assertion makes the contract explicit.
--
--   Fix 8 (IMPORTANT) — spec §3.2 return-shape doc sync. Spec said the RPC
--     returns `{ booking, follow_ups }`; the migration actually returns 6
--     keys. v2 extends the spec to enumerate all 6 (booking, follow_ups,
--     slots_updated, assets_updated, orders_updated, wo_updated) — TS
--     consumers need the counts for telemetry and the operator UX
--     ("3 orders rescheduled, 1 work order repointed").
--
--   Fix 9 (NIT) — search_path. v1 used `public, pg_catalog, outbox`. The
--     canonical RPCs (00309:63, 00358:34) use `public, outbox` — outbox
--     IS its own schema (00299:16 `create schema if not exists outbox`),
--     so dropping it would break the `outbox.emit` calls. v2 aligns with
--     the canonical: `public, outbox`. The self-review note suggesting
--     `public, pg_catalog` was based on an incorrect premise ("outbox is a
--     table in public") — verified false; outbox.events lives in schema
--     outbox per 00299:13-18.
--
-- Sibling RPCs (template for body shape + F-CRIT compliance):
--   - 00309_create_booking_with_attach_plan_rpc.sql — booking-side canonical.
--   - 00310_grant_booking_approval_rpc.sql — approval-side canonical.
--   - 00335_update_entity_combined_v5.sql — B.2.A orchestrator template.
--   - 00358_grant_ticket_approval_v3.sql — F-CRIT-1 actor resolution.
--   - 00352_start_sla_timers_v2.sql — started_at-as-explicit-parameter.
--
-- ── EditPlan jsonb contract (v2) ─────────────────────────────────────────
--
-- {
--   "_resolution_at":            "2026-05-12T13:00:00Z",
--   "rule_outcome_fingerprint":  "<sha256>",
--   "client_request_id":         "<crid>",
--   "approval_outcome_changed":  false,
--
--   "booking": {
--     -- REQUIRED:
--     "location_id":          uuid,           -- primary slot's space_id
--     "start_at":             iso timestamptz, -- MIN(slot.start_at)
--     "end_at":               iso timestamptz, -- MAX(slot.end_at)
--     "cost_amount_snapshot": numeric,
--
--     -- OPTIONAL (omit = preserve existing column; include with any value,
--     -- including null, = overwrite):
--     "policy_snapshot":         jsonb,
--     "applied_rule_ids":        [uuid],
--     "cost_center_id":          uuid | null,
--     "calendar_etag":           text,
--     "host_person_id":          uuid | null,     -- v2 new
--     "recurrence_overridden":   boolean,         -- v2 new
--     "config_release_id":       uuid | null      -- v2 new (re-pin on edit)
--   },
--
--   "slot_patches":             [ ... ],          -- (unchanged)
--   "asset_reservation_patches":[ ... ],
--   "order_patches":            [ ... ],
--   "work_order_sla_patches":   [ ... ]
-- }
--
-- ── Raise codes (every one registered in packages/shared/src/error-codes.ts) ─
--
--   edit_booking.actor_not_found                       (404)
--   edit_booking.not_found                             (404)
--   edit_booking.invalid_plan_shape                    (400)
--   edit_booking.approval_reconciliation_required      (422)
--   booking.cancelled_cannot_edit                      (422)
--   command_operations.payload_mismatch                (409)
--   command_operations.unexpected_state                (500)
--   automation_plan.stale_resolution                   (409)
--   validate_entity_in_tenant.*_not_in_tenant          (404) — including 'person'
--                                                            (00321/00340/00359/00360)

drop function if exists public.edit_booking(uuid, jsonb, uuid, uuid, text);

create or replace function public.edit_booking(
  p_booking_id      uuid,
  p_plan            jsonb,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public, outbox
as $$
declare
  v_started_at         constant timestamptz := now();

  v_existing           public.command_operations;
  v_payload_hash       text;
  v_lock_key           bigint;

  v_actor_users_id     uuid;

  v_booking            record;

  v_booking_patch      jsonb;
  v_slot_patches       jsonb;
  v_asset_patches      jsonb;
  v_order_patches      jsonb;
  v_wo_patches         jsonb;

  v_slot               jsonb;
  v_asset              jsonb;
  v_order              jsonb;
  v_wo                 jsonb;
  v_rule_id            uuid;

  -- Required (must be present in the booking patch):
  v_new_location_id        uuid;
  v_new_start_at           timestamptz;
  v_new_end_at             timestamptz;
  v_new_cost_snapshot      numeric(10,2);
  v_resolution_at_ts       timestamptz;

  -- Optional (preserve-or-overwrite — computed at write-time below):
  v_new_policy_snapshot    jsonb;
  v_new_applied_rule_ids   uuid[];
  v_new_cost_center_id     uuid;
  v_new_calendar_etag      text;
  v_new_host_person_id     uuid;
  v_new_recurrence_over    boolean;
  v_new_config_release_id  uuid;

  -- Semantic re-derivation gate.
  v_rules_max_updated_at   timestamptz;

  v_audit_before           jsonb;
  v_audit_after            jsonb;

  v_emitted                jsonb := '[]'::jsonb;

  v_result                 jsonb;
  v_row_count              int;
  v_orders_updated         int := 0;
  v_assets_updated         int := 0;
  v_wo_updated             int := 0;
  v_slots_updated          int := 0;
begin
  -- ── 0. Argument shape checks ─────────────────────────────────────────
  if p_tenant_id is null then
    raise exception 'edit_booking: p_tenant_id required';
  end if;
  if p_booking_id is null then
    raise exception 'edit_booking: p_booking_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'edit_booking: p_idempotency_key required';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan must be a jsonb object'
      using errcode = 'P0001';
  end if;

  if not (p_plan ? 'booking') or jsonb_typeof(p_plan->'booking') <> 'object' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking must be a jsonb object'
      using errcode = 'P0001';
  end if;
  if not (p_plan ? 'slot_patches') or jsonb_typeof(p_plan->'slot_patches') <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.slot_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if not (p_plan ? '_resolution_at') or jsonb_typeof(p_plan->'_resolution_at') <> 'string' then
    raise exception 'edit_booking.invalid_plan_shape: p_plan._resolution_at must be an ISO timestamp string'
      using errcode = 'P0001';
  end if;
  if not (p_plan ? 'approval_outcome_changed')
     or jsonb_typeof(p_plan->'approval_outcome_changed') not in ('boolean') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.approval_outcome_changed must be boolean'
      using errcode = 'P0001';
  end if;

  v_booking_patch := p_plan->'booking';
  v_slot_patches  := p_plan->'slot_patches';
  v_asset_patches := coalesce(p_plan->'asset_reservation_patches', '[]'::jsonb);
  v_order_patches := coalesce(p_plan->'order_patches',             '[]'::jsonb);
  v_wo_patches    := coalesce(p_plan->'work_order_sla_patches',    '[]'::jsonb);

  if jsonb_typeof(v_asset_patches) <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: asset_reservation_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_order_patches) <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: order_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_wo_patches) <> 'array' then
    raise exception 'edit_booking.invalid_plan_shape: work_order_sla_patches must be a jsonb array'
      using errcode = 'P0001';
  end if;

  -- Fix 2: REQUIRED booking-patch keys must be present. v1's preflight
  -- only checked top-level p_plan keys, leaving these four to fail later
  -- at the UPDATE with a less-helpful error.
  if not (v_booking_patch ? 'location_id') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.location_id is required'
      using errcode = 'P0001';
  end if;
  if not (v_booking_patch ? 'start_at') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.start_at is required'
      using errcode = 'P0001';
  end if;
  if not (v_booking_patch ? 'end_at') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.end_at is required'
      using errcode = 'P0001';
  end if;
  if not (v_booking_patch ? 'cost_amount_snapshot') then
    raise exception 'edit_booking.invalid_plan_shape: p_plan.booking.cost_amount_snapshot is required'
      using errcode = 'P0001';
  end if;

  -- ── 1. F-CRIT-1: auth_uid → users.id ONCE. (Unchanged from v1.)
  if p_actor_user_id is not null then
    select u.id
      into v_actor_users_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;

    if v_actor_users_id is null then
      raise exception 'edit_booking.actor_not_found: auth_uid=% not registered as a user in tenant=%',
        p_actor_user_id, p_tenant_id
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 2. Advisory lock keyed on (tenant_id, idempotency_key) ───────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 3. command_operations idempotency gate ───────────────────────────
  v_payload_hash := md5(coalesce(p_plan::text, ''));

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

  -- ── 4. Row lock on bookings + load pre-edit snapshot ─────────────────
  select id, tenant_id, title, description,
         requester_person_id, host_person_id, booked_by_user_id,
         location_id, start_at, end_at, timezone,
         status, source,
         cost_center_id, cost_amount_snapshot,
         policy_snapshot, applied_rule_ids, config_release_id,
         calendar_event_id, calendar_provider, calendar_etag,
         recurrence_series_id, recurrence_index, recurrence_overridden,
         recurrence_skipped, template_id,
         created_at, updated_at
    into v_booking
    from public.bookings
   where id = p_booking_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'edit_booking.not_found: booking=% tenant=%', p_booking_id, p_tenant_id
      using errcode = 'P0001';
  end if;

  -- ── 5. Cancelled-state guard ──────────────────────────────────────────
  if v_booking.status = 'cancelled' then
    raise exception 'booking.cancelled_cannot_edit: booking=% is cancelled and can no longer be edited',
      p_booking_id
      using errcode = 'P0001';
  end if;

  -- ── 6. Semantic re-derivation gate (Fix 3 — narrowed) ───────────────
  -- Mirror RuleResolverService specificity (rule-resolver.service.ts:84-156
  -- + bucketRulesBySpecificity at :424-464):
  --   tenant            → always could match
  --   room              → matches when target_id = booking.location_id
  --   space_subtree     → matches when target_id is an ancestor of location_id
  --   room_type         → matches when target_id-as-text = space.type
  -- We narrow the `room` scope exactly (filters out edits to OTHER rooms'
  -- rules — the dominant case on a multi-room tenant). We leave
  -- `space_subtree` + `room_type` as conservative includes — narrowing those
  -- requires the resolver's ancestor walk (rule-resolver.service.ts:209-236)
  -- or a space.type read, both non-trivial in PL/pgSQL. TODO B.4.A.4: extend
  -- to ancestor / type narrowing if telemetry shows tenant-wide stale-resolution
  -- false-positives remain a hot path even with the room-scope fix.
  v_resolution_at_ts := (p_plan->>'_resolution_at')::timestamptz;
  select max(updated_at)
    into v_rules_max_updated_at
    from public.room_booking_rules
   where tenant_id = p_tenant_id
     and (
       target_scope = 'tenant'
       or (target_scope = 'room' and target_id = v_booking.location_id)
       or target_scope in ('space_subtree', 'room_type')
     );

  if v_rules_max_updated_at is not null
     and v_rules_max_updated_at > v_resolution_at_ts then
    raise exception 'automation_plan.stale_resolution: room_booking_rules.updated_at=% > plan._resolution_at=%',
      v_rules_max_updated_at, v_resolution_at_ts
      using errcode = 'P0001',
            hint = 'The booking rule set changed since the plan was built. Refetch and retry.';
  end if;

  -- ── 7. Approval-flip deferral guard (B.4.A.4 boundary) ───────────────
  if coalesce((p_plan->>'approval_outcome_changed')::boolean, false) then
    raise exception 'edit_booking.approval_reconciliation_required: plan reports approval_outcome_changed=true; reconciliation lands in B.4.A.4'
      using errcode = 'P0001',
            hint = 'This edit changes the rule outcome''s approval requirement. Retry after B.4.A.4 ships, or revert the change that crosses the approval boundary.';
  end if;

  -- ── 8. Tenant-validate every FK in the plan ──────────────────────────
  perform public.validate_entity_in_tenant(
    p_tenant_id, 'space', (v_booking_patch->>'location_id')::uuid
  );

  if (v_booking_patch ? 'cost_center_id')
     and jsonb_typeof(v_booking_patch->'cost_center_id') = 'string' then
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'cost_center', (v_booking_patch->>'cost_center_id')::uuid
    );
  end if;

  -- Fix 1: tenant-validate host_person_id BEFORE the write block.
  -- person kind allowlisted at 00360:98 + 00360:173-179.
  if (v_booking_patch ? 'host_person_id')
     and jsonb_typeof(v_booking_patch->'host_person_id') = 'string' then
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'person', (v_booking_patch->>'host_person_id')::uuid
    );
  end if;

  -- config_release_id has NO tenant validation: the config_releases table
  -- isn't created yet (column is unconstrained `uuid` per 00277:65, planned
  -- for a future FK). v2 writes through verbatim — see comment in §3.4 fix 1.

  if (v_booking_patch ? 'applied_rule_ids')
     and jsonb_typeof(v_booking_patch->'applied_rule_ids') = 'array' then
    for v_rule_id in
      select (value)::uuid
        from jsonb_array_elements_text(v_booking_patch->'applied_rule_ids')
    loop
      perform public.validate_entity_in_tenant(p_tenant_id, 'booking_rule', v_rule_id);
    end loop;
  end if;

  for v_slot in select * from jsonb_array_elements(v_slot_patches) loop
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'space', (v_slot->>'space_id')::uuid
    );
  end loop;

  for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
    if v_asset ? 'asset_id' and jsonb_typeof(v_asset->'asset_id') = 'string' then
      perform public.validate_entity_in_tenant(
        p_tenant_id, 'asset', (v_asset->>'asset_id')::uuid
      );
    end if;
  end loop;

  for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
    perform public.validate_entity_in_tenant(
      p_tenant_id, 'work_order', (v_wo->>'id')::uuid
    );
  end loop;

  for v_order in select * from jsonb_array_elements(v_order_patches) loop
    if not exists (
      select 1 from public.orders
       where id = (v_order->>'id')::uuid
         and tenant_id = p_tenant_id
    ) then
      raise exception 'edit_booking.not_found: order=% does not reference a known order in tenant %',
        (v_order->>'id')::uuid, p_tenant_id
        using errcode = 'P0001';
    end if;
  end loop;

  -- ── 9. Derive new booking values from the patch ──────────────────────
  -- Fix 2: required fields read directly; optional fields use preserve-
  -- or-overwrite based on key presence.
  v_new_location_id    := (v_booking_patch->>'location_id')::uuid;
  v_new_start_at       := (v_booking_patch->>'start_at')::timestamptz;
  v_new_end_at         := (v_booking_patch->>'end_at')::timestamptz;
  v_new_cost_snapshot  := nullif(v_booking_patch->>'cost_amount_snapshot', '')::numeric(10,2);

  v_new_policy_snapshot := case
                             when v_booking_patch ? 'policy_snapshot'
                             then coalesce(v_booking_patch->'policy_snapshot', '{}'::jsonb)
                             else v_booking.policy_snapshot
                           end;
  v_new_applied_rule_ids := case
                              when v_booking_patch ? 'applied_rule_ids'
                              then coalesce(
                                (select array_agg(value::uuid)
                                   from jsonb_array_elements_text(v_booking_patch->'applied_rule_ids')),
                                '{}'::uuid[])
                              else v_booking.applied_rule_ids
                            end;
  v_new_cost_center_id := case
                            when v_booking_patch ? 'cost_center_id'
                            then nullif(v_booking_patch->>'cost_center_id', '')::uuid
                            else v_booking.cost_center_id
                          end;
  v_new_calendar_etag  := case
                            when v_booking_patch ? 'calendar_etag'
                            then v_booking_patch->>'calendar_etag'
                            else v_booking.calendar_etag
                          end;
  v_new_host_person_id := case
                            when v_booking_patch ? 'host_person_id'
                            then nullif(v_booking_patch->>'host_person_id', '')::uuid
                            else v_booking.host_person_id
                          end;
  v_new_recurrence_over := case
                             when v_booking_patch ? 'recurrence_overridden'
                             then coalesce((v_booking_patch->>'recurrence_overridden')::boolean,
                                           v_booking.recurrence_overridden)
                             else v_booking.recurrence_overridden
                           end;
  v_new_config_release_id := case
                               when v_booking_patch ? 'config_release_id'
                               then nullif(v_booking_patch->>'config_release_id', '')::uuid
                               else v_booking.config_release_id
                             end;

  -- ── 10. Atomic write block ───────────────────────────────────────────

  -- 10.a — booking_slots (per slot_patch). (Unchanged from v1.)
  for v_slot in select * from jsonb_array_elements(v_slot_patches) loop
    update public.booking_slots
       set space_id                = (v_slot->>'space_id')::uuid,
           start_at                = (v_slot->>'start_at')::timestamptz,
           end_at                  = (v_slot->>'end_at')::timestamptz,
           setup_buffer_minutes    = coalesce((v_slot->>'setup_buffer_minutes')::int,
                                              setup_buffer_minutes),
           teardown_buffer_minutes = coalesce((v_slot->>'teardown_buffer_minutes')::int,
                                              teardown_buffer_minutes),
           attendee_count          = case
                                       when v_slot ? 'attendee_count'
                                       then nullif(v_slot->>'attendee_count', '')::int
                                       else attendee_count
                                     end,
           attendee_person_ids     = case
                                       when v_slot ? 'attendee_person_ids'
                                            and jsonb_typeof(v_slot->'attendee_person_ids') = 'array'
                                       then coalesce(
                                         (select array_agg(value::uuid)
                                            from jsonb_array_elements_text(v_slot->'attendee_person_ids')),
                                         '{}'::uuid[])
                                       else attendee_person_ids
                                     end
     where id        = (v_slot->>'slot_id')::uuid
       and tenant_id = p_tenant_id
       and booking_id = p_booking_id;
    get diagnostics v_row_count = row_count;
    v_slots_updated := v_slots_updated + v_row_count;
  end loop;

  -- 10.b — bookings. Fix 1 + Fix 2: extended column set with preserve-
  -- or-overwrite values computed above.
  update public.bookings
     set location_id           = v_new_location_id,
         start_at              = v_new_start_at,
         end_at                = v_new_end_at,
         cost_amount_snapshot  = v_new_cost_snapshot,
         policy_snapshot       = v_new_policy_snapshot,
         applied_rule_ids      = v_new_applied_rule_ids,
         cost_center_id        = v_new_cost_center_id,
         calendar_etag         = v_new_calendar_etag,
         host_person_id        = v_new_host_person_id,
         recurrence_overridden = v_new_recurrence_over,
         config_release_id     = v_new_config_release_id,
         updated_at            = v_started_at
   where id        = p_booking_id
     and tenant_id = p_tenant_id;

  -- 10.c — asset_reservations. (Unchanged from v1.)
  for v_asset in select * from jsonb_array_elements(v_asset_patches) loop
    update public.asset_reservations
       set start_at = (v_asset->>'start_at')::timestamptz,
           end_at   = (v_asset->>'end_at')::timestamptz
     where id        = (v_asset->>'id')::uuid
       and tenant_id = p_tenant_id;
    get diagnostics v_row_count = row_count;
    v_assets_updated := v_assets_updated + v_row_count;
  end loop;

  -- 10.d — orders. (Unchanged from v1.)
  for v_order in select * from jsonb_array_elements(v_order_patches) loop
    update public.orders
       set delivery_location_id   = case
                                      when v_order ? 'delivery_location_id'
                                      then nullif(v_order->>'delivery_location_id', '')::uuid
                                      else delivery_location_id
                                    end,
           requested_for_start_at = case
                                      when v_order ? 'requested_for_start_at'
                                      then nullif(v_order->>'requested_for_start_at', '')::timestamptz
                                      else requested_for_start_at
                                    end,
           requested_for_end_at   = case
                                      when v_order ? 'requested_for_end_at'
                                      then nullif(v_order->>'requested_for_end_at', '')::timestamptz
                                      else requested_for_end_at
                                    end
     where id        = (v_order->>'id')::uuid
       and tenant_id = p_tenant_id;
    get diagnostics v_row_count = row_count;
    v_orders_updated := v_orders_updated + v_row_count;
  end loop;

  -- 10.e — work_orders sla patches. (Unchanged from v1.)
  for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
    update public.work_orders
       set planned_start_at      = (v_wo->>'planned_start_at')::timestamptz,
           sla_resolution_due_at = case
                                     when v_wo ? 'sla_due_at'
                                     then nullif(v_wo->>'sla_due_at', '')::timestamptz
                                     else sla_resolution_due_at
                                   end,
           updated_at            = v_started_at
     where id        = (v_wo->>'id')::uuid
       and tenant_id = p_tenant_id;
    get diagnostics v_row_count = row_count;
    v_wo_updated := v_wo_updated + v_row_count;
  end loop;

  -- ── 11. audit_events insert ──────────────────────────────────────────
  -- Fix 1: extended before/after to include v2's new columns.
  v_audit_before := jsonb_build_object(
    'location_id',           v_booking.location_id,
    'start_at',              v_booking.start_at,
    'end_at',                v_booking.end_at,
    'cost_amount_snapshot',  v_booking.cost_amount_snapshot,
    'cost_center_id',        v_booking.cost_center_id,
    'calendar_etag',         v_booking.calendar_etag,
    'applied_rule_ids',      to_jsonb(v_booking.applied_rule_ids),
    'policy_snapshot',       v_booking.policy_snapshot,
    'host_person_id',        v_booking.host_person_id,
    'recurrence_overridden', v_booking.recurrence_overridden,
    'config_release_id',     v_booking.config_release_id
  );
  v_audit_after := jsonb_build_object(
    'location_id',           v_new_location_id,
    'start_at',              v_new_start_at,
    'end_at',                v_new_end_at,
    'cost_amount_snapshot',  v_new_cost_snapshot,
    'cost_center_id',        v_new_cost_center_id,
    'calendar_etag',         v_new_calendar_etag,
    'applied_rule_ids',      to_jsonb(v_new_applied_rule_ids),
    'policy_snapshot',       v_new_policy_snapshot,
    'host_person_id',        v_new_host_person_id,
    'recurrence_overridden', v_new_recurrence_over,
    'config_release_id',     v_new_config_release_id
  );

  insert into public.audit_events
    (tenant_id, event_type, entity_type, entity_id, actor_user_id, details, created_at)
  values (
    p_tenant_id,
    'booking.edited',
    'booking',
    p_booking_id,
    v_actor_users_id,
    jsonb_build_object(
      'before',          v_audit_before,
      'after',           v_audit_after,
      'slots_updated',   v_slots_updated,
      'assets_updated',  v_assets_updated,
      'orders_updated',  v_orders_updated,
      'wo_updated',      v_wo_updated,
      'idempotency_key', p_idempotency_key
    ),
    v_started_at
  );

  -- ── 12. domain_events insert ─────────────────────────────────────────
  insert into public.domain_events
    (tenant_id, event_type, entity_type, entity_id, payload, actor_user_id, created_at)
  values (
    p_tenant_id,
    'booking.edited',
    'booking',
    p_booking_id,
    jsonb_build_object(
      'booking_id',     p_booking_id,
      'started_at',     v_started_at,
      'idempotency_key', p_idempotency_key
    ),
    v_actor_users_id,
    v_started_at
  );

  -- ── 13. Outbox emits ─────────────────────────────────────────────────
  if v_booking.location_id is distinct from v_new_location_id then
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.location_changed',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => p_booking_id,
      p_payload         => jsonb_build_object(
        'tenant_id',         p_tenant_id,
        'booking_id',        p_booking_id,
        'previous_location', v_booking.location_id,
        'new_location',      v_new_location_id,
        'started_at',        v_started_at
      ),
      p_idempotency_key => 'booking.location_changed:' || p_booking_id::text || ':' || p_idempotency_key,
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted || to_jsonb('booking.location_changed'::text);
  end if;

  if v_booking.cost_amount_snapshot is distinct from v_new_cost_snapshot then
    perform outbox.emit(
      p_tenant_id       => p_tenant_id,
      p_event_type      => 'booking.cost_changed',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => p_booking_id,
      p_payload         => jsonb_build_object(
        'tenant_id',     p_tenant_id,
        'booking_id',    p_booking_id,
        'previous_cost', v_booking.cost_amount_snapshot,
        'new_cost',      v_new_cost_snapshot,
        'started_at',    v_started_at
      ),
      p_idempotency_key => 'booking.cost_changed:' || p_booking_id::text || ':' || p_idempotency_key,
      p_event_version   => 1,
      p_available_at    => null
    );
    v_emitted := v_emitted || to_jsonb('booking.cost_changed'::text);
  end if;

  -- sla.timer_repointed_required per WO patch that signalled needs_repoint.
  for v_wo in select * from jsonb_array_elements(v_wo_patches) loop
    if coalesce((v_wo->>'needs_repoint')::boolean, false) then
      perform outbox.emit(
        p_tenant_id       => p_tenant_id,
        p_event_type      => 'sla.timer_repointed_required',
        p_aggregate_type  => 'work_order',
        p_aggregate_id    => (v_wo->>'id')::uuid,
        p_payload         => jsonb_build_object(
          'tenant_id',     p_tenant_id,
          'work_order_id', (v_wo->>'id')::uuid,
          'sla_policy_id', nullif(v_wo->>'sla_policy_id', '')::uuid,
          'started_at',    v_started_at,
          'source',        'edit_booking'
        ),
        p_idempotency_key => 'sla.timer_repointed_required:' || (v_wo->>'id')::text || ':' || p_idempotency_key,
        p_event_version   => 1,
        p_available_at    => null
      );
      v_emitted := v_emitted || to_jsonb('sla.timer_repointed_required'::text);
    end if;
  end loop;

  -- ── 14. Assemble result + mark command_operations success ────────────
  -- Fix 1: include v2's new columns in the returned booking sub-object so
  -- TS consumers see the canonical post-edit state.
  v_result := jsonb_build_object(
    'booking',     jsonb_build_object(
      'id',                    p_booking_id,
      'tenant_id',             p_tenant_id,
      'location_id',           v_new_location_id,
      'start_at',              v_new_start_at,
      'end_at',                v_new_end_at,
      'cost_amount_snapshot',  v_new_cost_snapshot,
      'cost_center_id',        v_new_cost_center_id,
      'calendar_etag',         v_new_calendar_etag,
      'applied_rule_ids',      to_jsonb(v_new_applied_rule_ids),
      'policy_snapshot',       v_new_policy_snapshot,
      'host_person_id',        v_new_host_person_id,
      'recurrence_overridden', v_new_recurrence_over,
      'config_release_id',     v_new_config_release_id,
      'status',                v_booking.status,
      'updated_at',            v_started_at
    ),
    'follow_ups',  v_emitted,
    'slots_updated',  v_slots_updated,
    'assets_updated', v_assets_updated,
    'orders_updated', v_orders_updated,
    'wo_updated',     v_wo_updated
  );

  -- Fix 4: F-CRIT-2 consistency. completed_at = v_started_at (same
  -- constant used for every other persisted timestamp above).
  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = v_started_at
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

revoke all on function public.edit_booking(uuid, jsonb, uuid, uuid, text) from public;
-- Fix 5: service_role only (no authenticated). Mirrors 00309:361, 00310:260, 00358:389.
grant  execute on function public.edit_booking(uuid, jsonb, uuid, uuid, text) to service_role;

comment on function public.edit_booking(uuid, jsonb, uuid, uuid, text) is
  'B.4.A.3 — edit_booking RPC v2 (supersedes 00361). v2 folds 9 self-review fixes: (1) extended EditPlan covers host_person_id [tenant-validated as person] + recurrence_overridden + config_release_id [re-pin every edit per spec §9.4]; (2) preserve-or-overwrite for ALL optional booking fields based on key presence; (3) stale_resolution gate narrowed to (target_scope=tenant OR room+location_id match OR space_subtree/room_type conservative include) — mirrors RuleResolverService specificity (no request_type_id column exists on bookings); (4) command_operations.completed_at uses v_started_at for F-CRIT-2 consistency; (5) grant execute to service_role only (canonical lockdown — 00309/00310/00358); (6) concurrency test scenario 13 added (needs_repoint outbox shape); (7) idempotent-replay scenario asserts zero additional outbox emits; (8) spec §3.2 return-shape doc-synced to all 6 keys; (9) search_path=public,outbox aligns with canonical RPCs (outbox IS a schema per 00299:16). F-CRIT-1: auth_uid→users.id once. F-CRIT-2: v_started_at captured once. aggregate_type=''booking''. v1 deferral on approval_outcome_changed=true unchanged (B.4.A.4 boundary). Idempotent on (tenant_id, idempotency_key) via command_operations. Tenant-validates every FK via validate_entity_in_tenant v5 (00360). Spec: docs/follow-ups/b4-booking-edit-pipeline.md §3.2 + §3.4.';

notify pgrst, 'reload schema';
