-- P1-4 — update_entity_combined v6.
--
-- Spec:        ai/handoff-planning-board-cleanup.md §3 P1-4.
-- Supersedes:  00335 v5 (same function, additive new optional arg).
-- Predecessor: 00331 (v1) → 00332 (v2) → 00333 (v3) → 00334 (v4) → 00335 (v5) → 00383 (v6).
--
-- ── Why v6 (planning-board audit-source provenance) ───────────────────
--
-- The audit log can't tell where a plan change came from. Today, every
-- `plan_changed` activity row carries the same metadata shape:
--   { event: 'plan_changed', previous: {...}, next: {...} }
-- Drag from /desk/planning, edit from /desk/tickets/:id, or (soon) the
-- Slice C PM-generator producing a fresh recurring plan — they all
-- produce IDENTICAL audit rows. Operators investigating who-did-what
-- (or debugging an unexpected reschedule) hit a wall.
--
-- v6 fix: add an OPTIONAL trailing arg `p_activity_source text default
-- null`. When present and the plan branch fires, the inserted
-- ticket_activities row's metadata gets a `source` field stamped in
-- ('board' | 'detail' | 'generator'). When absent, the metadata shape
-- is byte-for-byte identical to v5. Backward-compat by construction:
-- existing callers using named-arg `.rpc('update_entity_combined',
-- { p_entity_kind, p_entity_id, ... })` simply don't pass the new key
-- and PostgREST fills the default null.
--
-- ── Why CREATE OR REPLACE on the same function name (push-back) ───────
--
-- The handoff doc literally said "Define public.update_entity_combined_v6(...)".
-- That would create a SECOND function on the DB with a near-identical
-- body — drift risk on every future change. The established pattern in
-- this codebase (v1..v5) is CREATE OR REPLACE on `update_entity_combined`
-- with the migration filename carrying the version semantic.
--
-- Important wrinkle discovered when applying: CREATE OR REPLACE does NOT
-- replace a function when the arity changes (PG treats different arg
-- counts as distinct overloads). So we MUST explicitly drop the v5
-- 6-arg variant before defining the 7-arg replacement, otherwise the
-- 6-arg call surface (everything in the codebase as of 00335) becomes
-- ambiguous: PostgREST + plain SQL both fail with "function is not
-- unique" because both overloads satisfy a 6-arg invocation (the 7-arg
-- variant's `p_activity_source` has DEFAULT NULL). Verified live:
-- `select public.update_entity_combined(...6 args...)` raises
-- "function public.update_entity_combined(text, uuid, uuid, uuid, text,
-- jsonb) is not unique" once both overloads coexist.
--
-- This is functionally equivalent to a CREATE OR REPLACE on the same
-- name — the 6-arg-named call from supabase-js continues to work
-- (PostgreSQL fills the default null for p_activity_source). Callers
-- that don't yet pass `_source` are byte-for-byte unaffected. Single
-- source of truth on the DB; the migration log is the version history.
--
-- ── Allowed values + defense in depth ─────────────────────────────────
--
-- Three values: 'board', 'detail', 'generator'. The controller layer
-- (work-order.controller.ts) also gates this on the way in via the
-- `work_order.field_invalid` validation code; the RPC raise here is the
-- belt-and-braces guard so an internal caller that bypasses the
-- controller (workflow engine, future Slice C generator) can't smuggle
-- an unrecognised value into the audit log.
--
-- All other v5 behaviour preserved verbatim — every branch (status,
-- priority, assignment, sla, plan, metadata), the post-SLA recompute
-- hook, F1..F10 fixes, idempotency gate, advisory lock, command_operations
-- success update. The diff vs v5 is exactly:
--   1. New param `p_activity_source text default null` at the end.
--   2. One validation raise on bad source.
--   3. One `jsonb_build_object('source', p_activity_source)` merged into
--      the `plan_changed` activity row's metadata when both the plan
--      branch fires AND p_activity_source is non-null.

-- Drop the v5 6-arg variant first so the 7-arg replacement is the only
-- definition. Without this, both overloads coexist and a 6-arg call
-- (the entire codebase as of 00335) becomes ambiguous.
drop function if exists public.update_entity_combined(text, uuid, uuid, uuid, text, jsonb);

create or replace function public.update_entity_combined(
  p_entity_kind     text,
  p_entity_id       uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text,
  p_patches         jsonb,
  p_activity_source text default null
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

  v_metadata_changes         jsonb := '{}'::jsonb;

  v_actor_person_id          uuid;
  v_branches_applied         jsonb := '[]'::jsonb;
  v_any_changed              boolean := false;
  v_result                   jsonb;

  v_post_status_category     text;
  v_post_waiting_reason      text;

  c_inner_sentinel constant text := '__combined__';
  c_max_watchers   constant int  := 200;
begin
  -- ── 0. Argument shape checks ──────────────────────────────────────────
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

  -- v6: defense-in-depth validation on the new optional activity source.
  -- Three accepted values (planning board / detail page / PM generator);
  -- null means "don't stamp" (v5 behaviour). Anything else is rejected
  -- so an unrecognised value can't leak into the audit log.
  if p_activity_source is not null
     and p_activity_source not in ('board','detail','generator') then
    raise exception 'update_entity_combined.invalid_source: p_activity_source=% must be one of board/detail/generator',
      p_activity_source
      using errcode = 'P0001';
  end if;

  -- ── 1. Branch detection ───────────────────────────────────────────────
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

  -- ── 3. Advisory xact lock ─────────────────────────────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 4. Outer command_operations idempotency gate ──────────────────────
  v_payload_hash := md5(coalesce(p_patches::text, ''));

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

  -- ── 5. SELECT FOR UPDATE on the right entity table ────────────────────
  if p_entity_kind = 'case' then
    select id, priority, title, description, cost, tags, watchers,
           null::timestamptz as planned_start_at,
           null::integer     as planned_duration_minutes
      into v_current
      from public.tickets
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  else
    select id, priority, title, description, cost, tags, watchers,
           planned_start_at, planned_duration_minutes
      into v_current
      from public.work_orders
     where id = p_entity_id and tenant_id = p_tenant_id
     for update;
  end if;

  if not found then
    raise exception 'update_entity_combined.not_found: kind=% id=%', p_entity_kind, p_entity_id
      using errcode = 'P0001';
  end if;

  v_prev_priority         := v_current.priority;
  v_prev_planned_start    := v_current.planned_start_at;
  v_prev_planned_duration := v_current.planned_duration_minutes;
  v_prev_title            := v_current.title;
  v_prev_description      := v_current.description;
  v_prev_cost             := v_current.cost;
  v_prev_tags             := v_current.tags;
  v_prev_watchers         := v_current.watchers;

  if p_actor_user_id is not null then
    select u.person_id into v_actor_person_id
      from public.users u
     where u.tenant_id = p_tenant_id
       and u.auth_uid  = p_actor_user_id
     limit 1;
  end if;

  -- ── 6. Branch (a) — status ────────────────────────────────────────────
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

  -- ── 7. Branch (b) — priority (inline) ─────────────────────────────────
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

  -- ── 8. Branch (c) — assignment ────────────────────────────────────────
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

  -- ── 9. Branch (d) — sla ───────────────────────────────────────────────
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

  -- ── 10. Branch (e) — plan (WO-only, already gated above) ──────────────
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

      -- v6: build the activity metadata with optional `source` field.
      -- When p_activity_source is null, the shape is byte-identical to
      -- v5's jsonb_build_object — no `source` key present in the row.
      -- When non-null, the merge stamps the provenance ('board' for
      -- drag/resize/keyboard nudge on /desk/planning, 'detail' for the
      -- detail-page plan field, 'generator' reserved for the Slice C
      -- PM generator).
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

  -- ── 11. Branch (f) — metadata (inline) ────────────────────────────────
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

    if v_title_changed or v_description_changed or v_cost_changed or v_tags_changed or v_watchers_changed then
      if p_entity_kind = 'case' then
        update public.tickets
           set title       = case when v_has_title_key       then v_new_title       else title       end,
               description = case when v_has_description_key then v_new_description else description end,
               cost        = case when v_has_cost_key        then v_new_cost        else cost        end,
               tags        = case when v_has_tags_key        then v_new_tags        else tags        end,
               watchers    = case when v_has_watchers_key    then v_new_watchers    else watchers    end,
               updated_at  = now()
         where id = p_entity_id and tenant_id = p_tenant_id;
      else
        update public.work_orders
           set title       = case when v_has_title_key       then v_new_title       else title       end,
               description = case when v_has_description_key then v_new_description else description end,
               cost        = case when v_has_cost_key        then v_new_cost        else cost        end,
               tags        = case when v_has_tags_key        then v_new_tags        else tags        end,
               watchers    = case when v_has_watchers_key    then v_new_watchers    else watchers    end,
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
      'changed', (v_title_changed or v_description_changed or v_cost_changed or v_tags_changed or v_watchers_changed)
    );
    v_branches_applied := v_branches_applied || to_jsonb('metadata'::text);
  end if;

  -- ── 11b. Post-SLA recompute hook (v4 plan-review C2; v5 codex CODEX-B-2 gate) ──
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

  -- ── 12. Assemble result + mark command_operations success ─────────────
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

comment on function public.update_entity_combined(text, uuid, uuid, uuid, text, jsonb, text) is
  'P1-4 §3 orchestrator v6 (00383 supersedes 00335 v5). v6 adds an optional trailing arg `p_activity_source text default null` so a `plan_changed` audit row can record where the plan change came from (planning board / detail page / Slice C PM generator). When non-null, the value is stamped into the inserted ticket_activities row''s metadata as `{..., source: <value>}`. When null, the metadata shape is byte-identical to v5 — strict backward compatibility for the 6-arg callers. Allowed values are board/detail/generator; the RPC raises invalid_source on anything else as defense-in-depth (the controller also validates). All v5 behaviour preserved verbatim — every branch (status / priority / assignment / sla / plan / metadata), post-SLA recompute hook, F1..F10 fixes. Spec: ai/handoff-planning-board-cleanup.md §3 P1-4.';

notify pgrst, 'reload schema';
