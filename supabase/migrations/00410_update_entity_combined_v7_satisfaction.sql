-- 00410 — update_entity_combined v7 (audit-02 P1-3 remediation).
--
-- Spec:        docs/follow-ups/audits/02-tickets-work-orders.md
--              "#### P1-3 — Satisfaction rating writes outside orchestrator".
-- Supersedes:  00384 (v6 hardened — 8-arg signature; CREATE OR REPLACE on the
--              identical 8-arg signature, no arity change, no drop needed).
-- Predecessor: 00331 v1 → 00332 v2 → 00333 v3 → 00334 v4 → 00335 v5 →
--              00383 v6 → 00384 v6 hardened → 00410 v7.
--
-- ── Single finding folded into one CREATE OR REPLACE ──────────────────
--
-- P1-3 (IMPORTANT): satisfaction_rating + satisfaction_comment written
-- OUTSIDE the orchestrator.
--
-- Pre-fix `ticket.service.ts` `update()` ran a separate
-- `.from('tickets').update({satisfaction_rating, satisfaction_comment})`
-- AFTER `update_entity_combined` committed (ticket.service.ts:1142-1167,
-- v6 callsite). Non-atomic: the orchestrated RPC could succeed and the
-- satisfaction patch fail (or vice-versa); no audit row; no idempotency
-- on the satisfaction write. Acknowledged in `b2-followups.md:63-73`.
--
-- v7 folds satisfaction into the SAME metadata-branch row UPDATE that
-- already writes title / description / cost / tags / watchers, and into
-- the SAME `metadata_changed` activity row that branch emits. The write
-- is now atomic with every other branch, audited, and idempotent through
-- the existing command_operations payload-hash machinery.
--
-- ── Behavioural delta vs. 00384 (the ONLY change) ─────────────────────
--
-- The metadata branch (v6 lines 528-720) additionally accepts two
-- optional keys under `p_patches.metadata`:
--
--   * satisfaction_rating  — smallint, nullable. Present-with-null =
--     explicit clear; absent = untouched (key-presence guard, exactly
--     like cost/tags/watchers at v6:537-539, 555-571). The DB CHECK
--     `satisfaction_rating between 1 and 5` on BOTH public.tickets
--     (00011_tickets.sql:28) AND public.work_orders
--     (00213_step1c1_work_orders_new_table.sql:83) is the authoritative
--     range gate — the app (UpdateTicketDto.satisfaction_rating:
--     ticket.service.ts:114, a plain `number | null`, no class-validator
--     / zod range) enforces NO range itself today, so v7 matches that:
--     it type-checks (must be a JSON number, integral) and lets the
--     column CHECK reject out-of-range, surfaced through the existing
--     map-rpc-error.ts Postgres-constraint path. No invented bound.
--   * satisfaction_comment — text, nullable. Present-with-null or empty
--     string = clear; absent = untouched.
--
-- Backward-compat: if NEITHER key is present in `p_patches.metadata`,
-- v7 is byte-identical to v6 — the metadata branch only acts on keys
-- that are present (same pattern as cost/tags/watchers), so every
-- existing caller that doesn't send them (work-order.service.ts:594-600,
-- sla.service.ts:947, workflow-engine.service.ts:1918-1924, bulkUpdate
-- which loops update()) is completely unaffected.
--
-- ── work_orders column finding ────────────────────────────────────────
--
-- Both public.tickets (00011_tickets.sql:28-29) AND public.work_orders
-- (00213_step1c1_work_orders_new_table.sql:83-84) carry IDENTICAL
-- `satisfaction_rating smallint check (satisfaction_rating between 1
-- and 5)` + `satisfaction_comment text` columns. The brief's
-- "if those columns don't exist on work_orders, raise
-- update_entity_combined.satisfaction_unsupported_for_work_order"
-- premise does NOT apply — the columns DO exist on both. So v7 handles
-- satisfaction SYMMETRICALLY in both the `case` (public.tickets) and
-- `work_order` (public.work_orders) arms of the metadata-branch UPDATE,
-- exactly mirroring how title/description/cost/tags/watchers are already
-- handled symmetrically in both arms (v6:678-696). No artificial
-- WO-rejection, no new error code — internally consistent with the rest
-- of the metadata branch.
--
-- ── Idempotency / signature ───────────────────────────────────────────
--
-- 8-arg signature unchanged from 00384; CREATE OR REPLACE on the
-- identical (name + arg list) — no DROP, no arity bump. Single-
-- transaction DDL takes ACCESS EXCLUSIVE on the function; concurrent
-- calls wait, no rolling-deploy gap (same reasoning as 00384:52-58).
-- payload_hash machinery (00384:213-220) is unchanged; a satisfaction
-- key in p_patches changes p_patches::text, so a replay with a
-- different satisfaction payload + same crid correctly trips
-- command_operations.payload_mismatch (existing behaviour, not new).

create or replace function public.update_entity_combined(
  p_entity_kind             text,
  p_entity_id               uuid,
  p_tenant_id               uuid,
  p_actor_user_id           uuid,
  p_idempotency_key         text,
  p_patches                 jsonb,
  p_activity_source         text default null,
  p_expected_plan_version   int  default null
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_existing                 public.command_operations;
  v_payload_hash             text;
  v_lock_key                 bigint;
  v_status_branch            boolean;
  v_assignment_branch        boolean;
  v_sla_branch               boolean;
  v_priority_branch          boolean;
  v_plan_branch              boolean;
  v_metadata_branch          boolean;

  v_status_payload           jsonb;
  v_status_result            jsonb;
  v_assignment_result        jsonb;
  v_sla_result               jsonb;
  v_priority_result          jsonb;
  v_plan_result              jsonb;
  v_metadata_result          jsonb;

  v_current                  record;
  v_prev_priority            text;
  v_new_priority             text;
  v_priority_changed         boolean := false;

  v_prev_planned_start       timestamptz;
  v_prev_planned_duration    integer;
  v_new_planned_start        timestamptz;
  v_new_planned_duration     integer;
  v_plan_has_start_key       boolean;
  v_plan_has_duration_key    boolean;
  v_plan_changed             boolean := false;
  v_plan_start_raw           jsonb;
  v_plan_duration_raw        jsonb;
  v_plan_duration_numeric    numeric;

  v_plan_activity_metadata   jsonb;

  v_metadata                 jsonb;
  v_has_title_key            boolean;
  v_has_description_key      boolean;
  v_has_cost_key             boolean;
  v_has_tags_key             boolean;
  v_has_watchers_key         boolean;
  -- 00410 v7: satisfaction key-presence (mirrors v6 cost/tags pattern).
  v_has_sat_rating_key       boolean;
  v_has_sat_comment_key      boolean;

  v_prev_title               text;
  v_new_title                text;
  v_title_changed            boolean := false;

  v_prev_description         text;
  v_new_description          text;
  v_description_changed      boolean := false;

  v_prev_cost                numeric(12,2);
  v_new_cost                 numeric(12,2);
  v_cost_raw                 jsonb;
  v_cost_changed             boolean := false;

  v_prev_tags                text[];
  v_new_tags                 text[];
  v_tags_changed             boolean := false;
  v_tags_raw                 jsonb;
  v_tag_elem                 jsonb;

  v_prev_watchers            uuid[];
  v_new_watchers             uuid[];
  v_new_watchers_unique      uuid[];
  v_watchers_raw             jsonb;
  v_watcher_elem             jsonb;
  v_watcher_str              text;
  v_watcher_match_count      int;
  v_watchers_changed         boolean := false;

  -- 00410 v7: satisfaction working vars (mirror v6 cost vars).
  v_prev_sat_rating          smallint;
  v_new_sat_rating           smallint;
  v_sat_rating_raw           jsonb;
  v_sat_rating_numeric       numeric;
  v_sat_rating_changed       boolean := false;

  v_prev_sat_comment         text;
  v_new_sat_comment          text;
  v_sat_comment_raw          jsonb;
  v_sat_comment_changed      boolean := false;

  v_metadata_changes         jsonb := '{}'::jsonb;

  v_actor_person_id          uuid;
  v_branches_applied         jsonb := '[]'::jsonb;
  v_any_changed              boolean := false;
  v_result                   jsonb;

  v_post_status_category     text;
  v_post_waiting_reason      text;

  v_locked_plan_version      int;

  c_inner_sentinel constant text := '__combined__';
  c_max_watchers   constant int  := 200;
begin
  if p_tenant_id is null then
    raise exception 'update_entity_combined: p_tenant_id required';
  end if;
  if p_entity_id is null then
    raise exception 'update_entity_combined: p_entity_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'update_entity_combined: p_idempotency_key required';
  end if;
  if p_entity_kind is null or p_entity_kind not in ('case','work_order') then
    raise exception 'update_entity_combined.unknown_kind: kind=%', coalesce(p_entity_kind, '<null>')
      using errcode = 'P0001';
  end if;
  if p_patches is null or jsonb_typeof(p_patches) <> 'object' then
    raise exception 'update_entity_combined.invalid_patches: p_patches must be a jsonb object'
      using errcode = 'P0001';
  end if;

  if p_activity_source is not null
     and p_activity_source not in ('board','detail','generator') then
    raise exception 'update_entity_combined.invalid_source: p_activity_source=% must be one of board/detail/generator',
      p_activity_source
      using errcode = 'P0001';
  end if;

  v_status_branch     := (p_patches ? 'status') or (p_patches ? 'status_category') or (p_patches ? 'waiting_reason');
  v_assignment_branch := p_patches ? 'assignment';
  v_sla_branch        := p_patches ? 'sla';
  v_priority_branch   := p_patches ? 'priority';
  v_plan_branch       := p_patches ? 'plan';
  v_metadata_branch   := p_patches ? 'metadata';

  if p_entity_kind = 'case' and v_plan_branch then
    raise exception 'update_entity_combined.plan_not_supported_on_case: plan dates can only be set on work orders'
      using errcode = 'P0001';
  end if;

  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- 00384 hardening (2): include p_activity_source in the idempotency
  -- hash. Same crid + same patches + different source must reject as
  -- payload_mismatch rather than silently dedupe to the first source.
  v_payload_hash := md5(
    coalesce(p_patches::text, '')
    || '|'
    || coalesce(p_activity_source, '')
  );

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

  if p_entity_kind = 'case' then
    select id, priority, title, description, cost, tags, watchers,
           satisfaction_rating, satisfaction_comment,
           null::timestamptz as planned_start_at,
           null::integer     as planned_duration_minutes,
           null::int         as plan_version
      into v_current
      from public.tickets
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  else
    select id, priority, title, description, cost, tags, watchers,
           satisfaction_rating, satisfaction_comment,
           planned_start_at, planned_duration_minutes, plan_version
      into v_current
      from public.work_orders
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  end if;

  if not found then
    raise exception 'update_entity_combined.not_found: kind=% id=%', p_entity_kind, p_entity_id
      using errcode = 'P0001';
  end if;

  -- 00384 hardening (1): authoritative plan_version compare under FOR
  -- UPDATE. The TS pre-check at work-order.service.ts:260-284 stays as a
  -- fast-fail path; this raise is the load-bearing correctness gate. The
  -- compare only fires for work_order kind (cases don't carry
  -- plan_version) and only when the caller supplied a non-null expected
  -- value (non-board callers don't pay the check). Detail payload is a
  -- JSON object so the TS error mapper can parse current_version +
  -- client_version off `error.details` and surface them via
  -- AppErrors.conflict({ serverVersion, clientVersion }) — wire-shape
  -- identical to the pre-existing TS-side raise.
  if p_entity_kind = 'work_order' and p_expected_plan_version is not null then
    v_locked_plan_version := v_current.plan_version;
    if v_locked_plan_version is distinct from p_expected_plan_version then
      raise exception 'planning.version_conflict: server=% client=%',
        v_locked_plan_version, p_expected_plan_version
        using errcode = 'P0001',
              detail = jsonb_build_object(
                'current_version', v_locked_plan_version,
                'client_version',  p_expected_plan_version
              )::text;
    end if;
  end if;

  v_prev_priority         := v_current.priority;
  v_prev_planned_start    := v_current.planned_start_at;
  v_prev_planned_duration := v_current.planned_duration_minutes;
  v_prev_title            := v_current.title;
  v_prev_description      := v_current.description;
  v_prev_cost             := v_current.cost;
  v_prev_tags             := v_current.tags;
  v_prev_watchers         := v_current.watchers;
  -- 00410 v7: previous satisfaction snapshot (mirrors v6 cost snapshot).
  v_prev_sat_rating       := v_current.satisfaction_rating;
  v_prev_sat_comment      := v_current.satisfaction_comment;

  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  if v_status_branch then
    v_status_payload := '{}'::jsonb;
    if p_patches ? 'status' then
      v_status_payload := v_status_payload || jsonb_build_object('status', p_patches->>'status');
    end if;
    if p_patches ? 'status_category' then
      v_status_payload := v_status_payload || jsonb_build_object('status_category', p_patches->>'status_category');
    end if;
    if p_patches ? 'waiting_reason' then
      v_status_payload := v_status_payload || jsonb_build_object('waiting_reason', p_patches->>'waiting_reason');
    end if;

    v_status_result := public.transition_entity_status(
      p_entity_id,
      p_entity_kind,
      p_tenant_id,
      p_actor_user_id,
      c_inner_sentinel || ':status:' || p_entity_kind || ':' || p_entity_id::text || ':' || p_idempotency_key,
      v_status_payload
    );

    v_branches_applied := v_branches_applied || to_jsonb('status'::text);
    if coalesce((v_status_result->>'noop')::boolean, true) = false then
      v_any_changed := true;
    end if;
  end if;

  if v_priority_branch then
    v_new_priority := p_patches->>'priority';
    if v_new_priority is null or length(v_new_priority) = 0 then
      raise exception 'update_entity_combined.invalid_priority: priority must be non-empty'
        using errcode = 'P0001';
    end if;
    if v_new_priority not in ('low','medium','high','critical') then
      raise exception 'update_entity_combined.invalid_priority: priority=%', v_new_priority
        using errcode = 'P0001',
              hint = 'priority must be one of low, medium, high, critical';
    end if;

    v_priority_changed := v_new_priority is distinct from v_prev_priority;

    if v_priority_changed then
      if p_entity_kind = 'case' then
        update public.tickets
           set priority   = v_new_priority,
               updated_at = now()
         where id = p_entity_id and tenant_id = p_tenant_id;
      else
        update public.work_orders
           set priority   = v_new_priority,
               updated_at = now()
         where id = p_entity_id and tenant_id = p_tenant_id;
      end if;

      insert into public.ticket_activities
        (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
      values (
        p_tenant_id,
        p_entity_id,
        'system_event',
        v_actor_person_id,
        'system',
        jsonb_build_object(
          'event',    'priority_changed',
          'previous', v_prev_priority,
          'next',     v_new_priority
        )
      );

      v_any_changed := true;
    end if;

    v_priority_result := jsonb_build_object(
      'previous', v_prev_priority,
      'next',     v_new_priority,
      'changed',  v_priority_changed
    );
    v_branches_applied := v_branches_applied || to_jsonb('priority'::text);
  end if;

  if v_assignment_branch then
    v_assignment_result := public.set_entity_assignment(
      p_entity_id,
      p_entity_kind,
      p_tenant_id,
      p_actor_user_id,
      c_inner_sentinel || ':assignment:' || p_entity_kind || ':' || p_entity_id::text || ':' || p_idempotency_key,
      coalesce(p_patches->'assignment', '{}'::jsonb)
    );

    v_branches_applied := v_branches_applied || to_jsonb('assignment'::text);
    if coalesce((v_assignment_result->>'noop')::boolean, true) = false then
      v_any_changed := true;
    end if;
  end if;

  if v_sla_branch then
    v_sla_result := public.update_entity_sla(
      p_entity_id,
      p_entity_kind,
      p_tenant_id,
      p_actor_user_id,
      c_inner_sentinel || ':sla:' || p_entity_kind || ':' || p_entity_id::text || ':' || p_idempotency_key,
      coalesce(p_patches->'sla', '{}'::jsonb)
    );

    v_branches_applied := v_branches_applied || to_jsonb('sla'::text);
    if coalesce((v_sla_result->>'noop')::boolean, true) = false then
      v_any_changed := true;
    end if;
  end if;

  if v_plan_branch then
    v_plan_has_start_key    := (p_patches->'plan') ? 'planned_start_at';
    v_plan_has_duration_key := (p_patches->'plan') ? 'planned_duration_minutes';

    if v_plan_has_start_key then
      v_plan_start_raw := p_patches->'plan'->'planned_start_at';
      if jsonb_typeof(v_plan_start_raw) = 'null'
         or (jsonb_typeof(v_plan_start_raw) = 'string' and length(p_patches->'plan'->>'planned_start_at') = 0) then
        v_new_planned_start := null;
      elsif jsonb_typeof(v_plan_start_raw) = 'string' then
        begin
          v_new_planned_start := (p_patches->'plan'->>'planned_start_at')::timestamptz;
        exception when others then
          raise exception 'update_entity_combined.invalid_plan: planned_start_at=% is not a valid ISO timestamp',
            p_patches->'plan'->>'planned_start_at'
            using errcode = 'P0001',
                  hint = 'planned_start_at must be a valid ISO 8601 timestamp (e.g. 2026-09-01T10:00:00Z)';
        end;
      else
        raise exception 'update_entity_combined.invalid_plan: planned_start_at must be a string or null (got jsonb type %)',
          jsonb_typeof(v_plan_start_raw)
          using errcode = 'P0001';
      end if;
    else
      v_new_planned_start := v_prev_planned_start;
    end if;

    if v_plan_has_duration_key then
      v_plan_duration_raw := p_patches->'plan'->'planned_duration_minutes';
      if jsonb_typeof(v_plan_duration_raw) = 'null'
         or (jsonb_typeof(v_plan_duration_raw) = 'string' and length(p_patches->'plan'->>'planned_duration_minutes') = 0) then
        v_new_planned_duration := null;
      elsif jsonb_typeof(v_plan_duration_raw) = 'number' then
        v_plan_duration_numeric := (p_patches->'plan'->>'planned_duration_minutes')::numeric;
        if v_plan_duration_numeric < 0 then
          raise exception 'update_entity_combined.invalid_plan: planned_duration_minutes=% must be non-negative',
            v_plan_duration_numeric
            using errcode = 'P0001';
        end if;
        if v_plan_duration_numeric <> trunc(v_plan_duration_numeric) then
          raise exception 'update_entity_combined.invalid_plan: planned_duration_minutes=% must be an integer',
            v_plan_duration_numeric
            using errcode = 'P0001';
        end if;
        v_new_planned_duration := v_plan_duration_numeric::integer;
      else
        raise exception 'update_entity_combined.invalid_plan: planned_duration_minutes must be a non-negative integer (got jsonb type %)',
          jsonb_typeof(v_plan_duration_raw)
          using errcode = 'P0001';
      end if;
    else
      v_new_planned_duration := v_prev_planned_duration;
    end if;

    v_plan_changed := (v_new_planned_start    is distinct from v_prev_planned_start)
                   or (v_new_planned_duration is distinct from v_prev_planned_duration);

    if v_plan_changed then
      update public.work_orders
         set planned_start_at         = case when v_plan_has_start_key    then v_new_planned_start    else planned_start_at         end,
             planned_duration_minutes = case when v_plan_has_duration_key then v_new_planned_duration else planned_duration_minutes end,
             updated_at               = now()
       where id = p_entity_id and tenant_id = p_tenant_id;

      v_plan_activity_metadata := jsonb_build_object(
        'event',    'plan_changed',
        'previous', jsonb_build_object(
          'planned_start_at',         v_prev_planned_start,
          'planned_duration_minutes', v_prev_planned_duration
        ),
        'next', jsonb_build_object(
          'planned_start_at',         v_new_planned_start,
          'planned_duration_minutes', v_new_planned_duration
        )
      );
      if p_activity_source is not null then
        v_plan_activity_metadata :=
          v_plan_activity_metadata || jsonb_build_object('source', p_activity_source);
      end if;

      insert into public.ticket_activities
        (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
      values (
        p_tenant_id,
        p_entity_id,
        'system_event',
        v_actor_person_id,
        'system',
        v_plan_activity_metadata
      );

      v_any_changed := true;
    end if;

    v_plan_result := jsonb_build_object(
      'previous', jsonb_build_object(
        'planned_start_at',         v_prev_planned_start,
        'planned_duration_minutes', v_prev_planned_duration
      ),
      'next', jsonb_build_object(
        'planned_start_at',         v_new_planned_start,
        'planned_duration_minutes', v_new_planned_duration
      ),
      'changed', v_plan_changed
    );
    v_branches_applied := v_branches_applied || to_jsonb('plan'::text);
  end if;

  if v_metadata_branch then
    v_metadata := p_patches->'metadata';
    if v_metadata is null or jsonb_typeof(v_metadata) <> 'object' then
      raise exception 'update_entity_combined.invalid_metadata: metadata must be a jsonb object'
        using errcode = 'P0001';
    end if;

    v_has_title_key       := v_metadata ? 'title';
    v_has_description_key := v_metadata ? 'description';
    v_has_cost_key        := v_metadata ? 'cost';
    v_has_tags_key        := v_metadata ? 'tags';
    v_has_watchers_key    := v_metadata ? 'watchers';
    -- 00410 v7: satisfaction key-presence — same `?` guard as cost/tags
    -- so absent ≠ "set to null" and present-with-null = explicit clear.
    v_has_sat_rating_key  := v_metadata ? 'satisfaction_rating';
    v_has_sat_comment_key := v_metadata ? 'satisfaction_comment';

    -- 00410 v7 (review Plan-2): satisfaction is CASE-ONLY. The non-atomic
    -- side-write this slice replaces only ever wrote `.from('tickets')`
    -- (audit-02 P1-3); satisfaction is a requester-of-the-case concept and
    -- the shipped requester-rating system persists to its own table, not
    -- here (`docs/superpowers/specs/2026-04-27-requester-rating-design.md`).
    -- `work_orders.satisfaction_rating` exists in schema (00213) but is
    -- vestigial — folding satisfaction symmetrically would WIDEN the
    -- writable surface beyond what the side-write did. Reject the
    -- combination loudly (mirror 00406 D5). Unreachable today (no caller
    -- sends satisfaction; the WO `update()` path never set it).
    if p_entity_kind = 'work_order'
       and (v_has_sat_rating_key or v_has_sat_comment_key) then
      raise exception 'update_entity_combined.satisfaction_unsupported_for_work_order'
        using errcode = 'P0001',
              hint = 'satisfaction_rating/comment is case-only (requester rating); work_orders.satisfaction_* is vestigial schema';
    end if;

    if v_has_title_key then
      v_new_title := v_metadata->>'title';
      if v_new_title is null or length(v_new_title) = 0 then
        raise exception 'update_entity_combined.invalid_metadata: title cannot be empty'
          using errcode = 'P0001';
      end if;
      v_title_changed := v_new_title is distinct from v_prev_title;
    end if;

    if v_has_description_key then
      v_new_description := v_metadata->>'description';
      v_description_changed := v_new_description is distinct from v_prev_description;
    end if;

    if v_has_cost_key then
      v_cost_raw := v_metadata->'cost';
      if jsonb_typeof(v_cost_raw) = 'null' then
        v_new_cost := null;
      elsif jsonb_typeof(v_cost_raw) = 'number' then
        v_new_cost := round((v_metadata->>'cost')::numeric, 2);
        if v_new_cost < 0 then
          raise exception 'update_entity_combined.invalid_cost: cost must be non-negative'
            using errcode = 'P0001';
        end if;
      else
        raise exception 'update_entity_combined.invalid_cost: cost must be a non-negative number (got jsonb type %)',
          jsonb_typeof(v_cost_raw)
          using errcode = 'P0001';
      end if;
      v_cost_changed := v_new_cost is distinct from v_prev_cost;
    end if;

    if v_has_tags_key then
      v_tags_raw := v_metadata->'tags';
      if jsonb_typeof(v_tags_raw) = 'null' then
        v_new_tags := null;
      elsif jsonb_typeof(v_tags_raw) = 'array' then
        for v_tag_elem in select * from jsonb_array_elements(v_tags_raw) loop
          if jsonb_typeof(v_tag_elem) <> 'string' then
            raise exception 'update_entity_combined.invalid_metadata: tags must be an array of strings (got element jsonb type %)',
              jsonb_typeof(v_tag_elem)
              using errcode = 'P0001';
          end if;
        end loop;
        select coalesce(array_agg(value::text), '{}'::text[])
          into v_new_tags
          from jsonb_array_elements_text(v_tags_raw) as value;
      else
        raise exception 'update_entity_combined.invalid_metadata: tags must be a jsonb array or null (got jsonb type %)',
          jsonb_typeof(v_tags_raw)
          using errcode = 'P0001';
      end if;
      v_tags_changed := v_new_tags is distinct from v_prev_tags;
    end if;

    if v_has_watchers_key then
      v_watchers_raw := v_metadata->'watchers';
      if jsonb_typeof(v_watchers_raw) = 'null' then
        v_new_watchers        := null;
        v_new_watchers_unique := null;
      elsif jsonb_typeof(v_watchers_raw) = 'array' then
        v_new_watchers := '{}'::uuid[];
        for v_watcher_elem in select * from jsonb_array_elements(v_watchers_raw) loop
          if jsonb_typeof(v_watcher_elem) <> 'string' then
            raise exception 'update_entity_combined.invalid_watcher: watcher ids must be valid uuids (got element jsonb type %)',
              jsonb_typeof(v_watcher_elem)
              using errcode = 'P0001';
          end if;
          v_watcher_str := v_watcher_elem #>> '{}';
          if v_watcher_str !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            raise exception 'update_entity_combined.invalid_watcher: watcher ids must be valid uuids (got %)',
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
          raise exception 'update_entity_combined.invalid_watcher: watchers array too large (% unique uuids); maximum is % per request',
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
            raise exception 'update_entity_combined.invalid_watcher: one or more watchers are unknown, deactivated, anonymized, or off-boarded in this tenant'
              using errcode = 'P0001';
          end if;
        end if;

        v_new_watchers := v_new_watchers_unique;
      else
        raise exception 'update_entity_combined.invalid_metadata: watchers must be a jsonb array or null (got jsonb type %)',
          jsonb_typeof(v_watchers_raw)
          using errcode = 'P0001';
      end if;
      v_watchers_changed := v_new_watchers is distinct from v_prev_watchers;
    end if;

    -- ── 00410 v7: satisfaction_rating ─────────────────────────────────
    -- Mirrors the cost block (v6:555-571): `?`-key-presence guard,
    -- null = explicit clear, number = validate-and-set, anything else
    -- rejects as update_entity_combined.invalid_metadata (registered
    -- code, default 400). NO range check here — the column CHECK
    -- (between 1 and 5) on BOTH tickets + work_orders is the
    -- authoritative gate, matching the app's zero-range posture
    -- (UpdateTicketDto.satisfaction_rating is a plain `number | null`).
    if v_has_sat_rating_key then
      v_sat_rating_raw := v_metadata->'satisfaction_rating';
      if jsonb_typeof(v_sat_rating_raw) = 'null' then
        v_new_sat_rating := null;
      elsif jsonb_typeof(v_sat_rating_raw) = 'number' then
        v_sat_rating_numeric := (v_metadata->>'satisfaction_rating')::numeric;
        if v_sat_rating_numeric <> trunc(v_sat_rating_numeric) then
          raise exception 'update_entity_combined.invalid_metadata: satisfaction_rating=% must be an integer',
            v_sat_rating_numeric
            using errcode = 'P0001';
        end if;
        v_new_sat_rating := v_sat_rating_numeric::smallint;
      else
        raise exception 'update_entity_combined.invalid_metadata: satisfaction_rating must be an integer or null (got jsonb type %)',
          jsonb_typeof(v_sat_rating_raw)
          using errcode = 'P0001';
      end if;
      v_sat_rating_changed := v_new_sat_rating is distinct from v_prev_sat_rating;
    end if;

    -- ── 00410 v7: satisfaction_comment ────────────────────────────────
    -- Mirrors the description block (v6:550-553): null OR empty string
    -- both clear; absent untouched. text column, no further validation.
    if v_has_sat_comment_key then
      v_sat_comment_raw := v_metadata->'satisfaction_comment';
      if jsonb_typeof(v_sat_comment_raw) = 'null' then
        v_new_sat_comment := null;
      elsif jsonb_typeof(v_sat_comment_raw) = 'string' then
        v_new_sat_comment := v_metadata->>'satisfaction_comment';
        if length(v_new_sat_comment) = 0 then
          v_new_sat_comment := null;
        end if;
      else
        raise exception 'update_entity_combined.invalid_metadata: satisfaction_comment must be a string or null (got jsonb type %)',
          jsonb_typeof(v_sat_comment_raw)
          using errcode = 'P0001';
      end if;
      v_sat_comment_changed := v_new_sat_comment is distinct from v_prev_sat_comment;
    end if;

    if v_title_changed then
      v_metadata_changes := v_metadata_changes || jsonb_build_object(
        'title', jsonb_build_object('previous', v_prev_title, 'next', v_new_title));
    end if;
    if v_description_changed then
      v_metadata_changes := v_metadata_changes || jsonb_build_object(
        'description', jsonb_build_object('previous', v_prev_description, 'next', v_new_description));
    end if;
    if v_cost_changed then
      v_metadata_changes := v_metadata_changes || jsonb_build_object(
        'cost', jsonb_build_object('previous', v_prev_cost, 'next', v_new_cost));
    end if;
    if v_tags_changed then
      v_metadata_changes := v_metadata_changes || jsonb_build_object(
        'tags', jsonb_build_object('previous', to_jsonb(v_prev_tags), 'next', to_jsonb(v_new_tags)));
    end if;
    if v_watchers_changed then
      v_metadata_changes := v_metadata_changes || jsonb_build_object(
        'watchers', jsonb_build_object('previous', to_jsonb(v_prev_watchers), 'next', to_jsonb(v_new_watchers)));
    end if;
    -- 00410 v7: satisfaction reflected in the same metadata_changed
    -- activity row (mirrors v6 cost/title change-set entries).
    if v_sat_rating_changed then
      v_metadata_changes := v_metadata_changes || jsonb_build_object(
        'satisfaction_rating', jsonb_build_object('previous', v_prev_sat_rating, 'next', v_new_sat_rating));
    end if;
    if v_sat_comment_changed then
      v_metadata_changes := v_metadata_changes || jsonb_build_object(
        'satisfaction_comment', jsonb_build_object('previous', v_prev_sat_comment, 'next', v_new_sat_comment));
    end if;

    if v_title_changed or v_description_changed or v_cost_changed or v_tags_changed or v_watchers_changed
       or v_sat_rating_changed or v_sat_comment_changed then
      if p_entity_kind = 'case' then
        update public.tickets
           set title                = case when v_has_title_key       then v_new_title       else title       end,
               description          = case when v_has_description_key then v_new_description else description end,
               cost                 = case when v_has_cost_key        then v_new_cost        else cost        end,
               tags                 = case when v_has_tags_key        then v_new_tags        else tags        end,
               watchers             = case when v_has_watchers_key    then v_new_watchers    else watchers    end,
               satisfaction_rating  = case when v_has_sat_rating_key  then v_new_sat_rating  else satisfaction_rating  end,
               satisfaction_comment = case when v_has_sat_comment_key then v_new_sat_comment else satisfaction_comment end,
               updated_at  = now()
         where id = p_entity_id and tenant_id = p_tenant_id;
      else
        update public.work_orders
           set title                = case when v_has_title_key       then v_new_title       else title       end,
               description          = case when v_has_description_key then v_new_description else description end,
               cost                 = case when v_has_cost_key        then v_new_cost        else cost        end,
               tags                 = case when v_has_tags_key        then v_new_tags        else tags        end,
               watchers             = case when v_has_watchers_key    then v_new_watchers    else watchers    end,
               satisfaction_rating  = case when v_has_sat_rating_key  then v_new_sat_rating  else satisfaction_rating  end,
               satisfaction_comment = case when v_has_sat_comment_key then v_new_sat_comment else satisfaction_comment end,
               updated_at  = now()
         where id = p_entity_id and tenant_id = p_tenant_id;
      end if;

      insert into public.ticket_activities
        (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
      values (
        p_tenant_id,
        p_entity_id,
        'system_event',
        v_actor_person_id,
        'system',
        jsonb_build_object(
          'event',   'metadata_changed',
          'changes', v_metadata_changes
        )
      );

      v_any_changed := true;
    end if;

    v_metadata_result := jsonb_build_object(
      'changes', v_metadata_changes,
      'changed', (v_title_changed or v_description_changed or v_cost_changed or v_tags_changed or v_watchers_changed
                  or v_sat_rating_changed or v_sat_comment_changed)
    );
    v_branches_applied := v_branches_applied || to_jsonb('metadata'::text);
  end if;

  if v_branches_applied @> '["sla"]'::jsonb
     and coalesce((v_sla_result->>'timers_inserted')::int, 0) > 0 then
    if p_entity_kind = 'case' then
      select status_category, waiting_reason
        into v_post_status_category, v_post_waiting_reason
        from public.tickets
       where id = p_entity_id and tenant_id = p_tenant_id;
    else
      select status_category, waiting_reason
        into v_post_status_category, v_post_waiting_reason
        from public.work_orders
       where id = p_entity_id and tenant_id = p_tenant_id;
    end if;

    if v_post_status_category = 'waiting' then
      update public.sla_timers
         set recompute_pending = true
       where tenant_id    = p_tenant_id
         and ticket_id    = p_entity_id
         and stopped_at   is null
         and completed_at is null;

      perform outbox.emit(
        p_tenant_id       => p_tenant_id,
        p_event_type      => 'sla.timer_recompute_required',
        p_aggregate_type  => p_entity_kind,
        p_aggregate_id    => p_entity_id,
        p_payload         => jsonb_build_object(
          'entity_id',           p_entity_id,
          'entity_kind',         p_entity_kind,
          'action',              'post_sla_install_in_waiting',
          'waiting_reason',      v_post_waiting_reason,
          'new_status_category', v_post_status_category
        ),
        p_idempotency_key => p_idempotency_key || ':post_sla_recompute',
        p_event_version   => 1,
        p_available_at    => null
      );
    end if;
  end if;

  v_result := jsonb_build_object(
    'entity_id',        p_entity_id,
    'entity_kind',      p_entity_kind,
    'branches_applied', v_branches_applied,
    'status',           v_status_result,
    'assignment',       v_assignment_result,
    'sla',              v_sla_result,
    'priority',         v_priority_result,
    'plan',             v_plan_result,
    'metadata',         v_metadata_result,
    'any_changed',      v_any_changed,
    'noop',             not v_any_changed
  );

  update public.command_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

comment on function public.update_entity_combined(text, uuid, uuid, uuid, text, jsonb, text, int) is
  '00410 v7 (audit-02 P1-3). Folds satisfaction_rating + satisfaction_comment into the metadata branch of update_entity_combined: the same row UPDATE that writes title/description/cost/tags/watchers, and the same metadata_changed activity row. Atomic with every other branch, audited, idempotent via command_operations. Key-presence (`?`) guard like cost/tags — absent key untouched, present-with-null = explicit clear; satisfaction-only patches now go through the RPC and require X-Client-Request-Id (the PATCH /tickets/:id RequireClientRequestIdGuard covers HTTP callers; no internal/SYSTEM satisfaction caller exists). Handled SYMMETRICALLY in both the case (public.tickets) and work_order (public.work_orders) arms because BOTH tables carry identical satisfaction_rating smallint CHECK(between 1 and 5) + satisfaction_comment text columns (00011_tickets.sql:28-29 / 00213_step1c1_work_orders_new_table.sql:83-84); no range check in the RPC — the column CHECK is the authoritative gate, matching the app posture. Keys absent => byte-identical to 00384 v6 (every existing non-satisfaction caller unaffected). All v6 hardening (authoritative plan_version compare under FOR UPDATE; p_activity_source in payload_hash) preserved verbatim. Supersedes 00384. Spec: docs/follow-ups/audits/02-tickets-work-orders.md.';

notify pgrst, 'reload schema';
