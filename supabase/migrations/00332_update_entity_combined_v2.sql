-- B.2.A.8 — update_entity_combined v2 (§3.0 orchestrator).
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.0 (lines 1781-1897).
-- Supersedes: 00331 (same function signature; CREATE OR REPLACE).
-- Schema citations: original at 00331_update_entity_combined_rpc.sql:1-665;
--   sibling RPC header style cribbed from 00330:1-55. TS dedupe parity
--   at apps/api/src/common/tenant-validation.ts:269 (`[...new Set(watchers)]`).
--
-- ── Why v2 (post-Commit-A self full-review) ────────────────────────────
--
-- Four review findings folded in:
--
-- F1. Inner-key namespacing (defense-in-depth — plan-reviewer C2).
--     Original 00331:294 / 376 / 393 constructed inner idempotency keys
--     as `<outer>:<branch>:<kind>:<id>`. v2 prefixes a sentinel:
--     `__combined__:<branch>:<kind>:<id>:<outer>`. The sentinel
--     `__combined__:` is reserved — direct callers of sibling RPCs
--     (cron, workflow, reclassify) MUST NOT mint a key with this
--     prefix. Defense-in-depth against the (theoretical) case where a
--     direct caller of transition_entity_status / set_entity_assignment
--     / update_entity_sla mints a key that happens to overlap with an
--     orchestrator-derived inner key. Outer keys today are
--     `patch:<kind>:<id>:<client_request_id>` and `client_request_id`
--     is a frontend-minted UUID per I1 (per Step 2 of B.2.A); collision
--     is already practically impossible. The sentinel converts it from
--     'practically impossible' to 'syntactically impossible'.
--
-- F2. Watcher dedupe (code-reviewer #1). Original 00331:541-550 parsed
--     `metadata.watchers` into `v_new_watchers uuid[]` then compared
--     `count(*) from persons` to `cardinality(v_new_watchers)`. For an
--     input like `[uuidA, uuidA]` the count is 1 but cardinality is 2
--     → false `invalid_watcher`. v2 dedupes via
--     `array(select distinct unnest(v_new_watchers))` BEFORE the
--     tenant-membership check; the deduped array is also persisted to
--     `tickets.watchers` / `work_orders.watchers` (no need to preserve
--     caller-side dups — matches the TS surface's
--     `[...new Set(watchers)]` normalization at
--     apps/api/src/common/tenant-validation.ts:269 called from
--     ticket.service.ts:1002-1006 + work-order.service.ts:625-627).
--
-- F3. Cast errors mapped to registered codes (code-reviewer #2 +
--     plan-reviewer I6). Original 00331:410-415 / 415-417 / 512 / 541
--     directly cast jsonb values to typed PG types via `nullif(...)::TYPE`
--     or `(value::text)::uuid`. Malformed inputs raised `22007`
--     (datetime_invalid_format), `22P02` (invalid_text_representation),
--     or `invalid_input_syntax_for_type_*` — bypassing every registered
--     `update_entity_combined.*` code. v2 type-checks each value
--     explicitly BEFORE the cast and raises the canonical registered
--     code on failure:
--       • planned_start_at  → invalid_plan      (P0001)
--       • planned_duration  → invalid_plan      (P0001)
--       • cost              → invalid_cost      (P0001)
--       • tags element      → invalid_metadata  (P0001)
--       • watcher uuid      → invalid_watcher   (P0001)
--     New error code `update_entity_combined.invalid_plan` registered
--     in packages/shared/src/error-codes.ts + EN/NL messages.
--
-- F4. Hoist v_actor_person_id resolution (code-reviewer #4). Original
--     00331:333-340 / 429-435 / 604-609 duplicated the same `select
--     u.person_id from public.users` block in the priority / plan /
--     metadata branches — three identical lookups per call when the
--     three inline branches all fire. v2 resolves once at the top of
--     the function (after argument checks + advisory lock +
--     command_operations gate + SELECT FOR UPDATE on the row, but
--     before any branch fires). All inline branches reuse the value.
--
-- All other behaviour from 00331 (advisory lock, command_operations
-- gate, full no-op detection, plan-on-case rejection, sub-RPC PERFORM
-- chain, ticket_activities emission shape, atomicity across branches)
-- is preserved verbatim.

create or replace function public.update_entity_combined(
  p_entity_kind     text,
  p_entity_id       uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text,
  p_patches         jsonb
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

  -- Sentinel used to namespace inner idempotency keys (F1).
  c_inner_sentinel constant text := '__combined__';
begin
  -- ── 0. Argument shape checks (mirror 00330:84-96 / 00331:175-192) ─────
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

  -- ── 1. Branch detection ───────────────────────────────────────────────
  v_status_branch     := (p_patches ? 'status') or (p_patches ? 'status_category') or (p_patches ? 'waiting_reason');
  v_assignment_branch := p_patches ? 'assignment';
  v_sla_branch        := p_patches ? 'sla';
  v_priority_branch   := p_patches ? 'priority';
  v_plan_branch       := p_patches ? 'plan';
  v_metadata_branch   := p_patches ? 'metadata';

  -- ── 2. Early scope guard: plan is WO-only ─────────────────────────────
  -- Citation: 00011_tickets.sql:1-44 has no planned_start_at / planned_duration_minutes
  --           columns; 00213_step1c1_work_orders_new_table.sql:108-109 does.
  if p_entity_kind = 'case' and v_plan_branch then
    raise exception 'update_entity_combined.plan_not_supported_on_case: plan dates can only be set on work orders'
      using errcode = 'P0001';
  end if;

  -- ── 3. Advisory xact lock (mirror 00330:110-112) ──────────────────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 4. Outer command_operations idempotency gate ──────────────────────
  v_payload_hash := md5(coalesce(p_patches::text, ''));

  select * into v_existing
    from public.command_operations
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.outcome = 'success' and v_existing.payload_hash = v_payload_hash then
      -- Outer cache hit — short-circuit before re-entering inner RPCs.
      -- Their own command_operations rows remain cached separately.
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
  -- Read every column the inline branches diff against. Plan columns
  -- only exist on work_orders.
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

  -- ── 5b. Hoist actor_person_id resolution (F4) ─────────────────────────
  -- The inline priority / plan / metadata branches each emit a
  -- ticket_activities row authored by the actor's person_id. Resolving
  -- once here means one users lookup per call instead of up to three.
  -- Mirrors 00330:326-333 lookup shape.
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

    -- F1: sentinel-prefixed inner key.
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
      -- UPDATE the priority + updated_at.
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

      -- Activity row matches TS path at ticket.service.ts:1224-1234.
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
    -- F1: sentinel-prefixed inner key.
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
    -- F1: sentinel-prefixed inner key.
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

    -- F3: validate planned_start_at type BEFORE cast. jsonb null is the
    -- "explicit clear" sentinel; jsonb string must parse as a timestamptz.
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

    -- F3: planned_duration_minutes must be a non-negative integer-valued
    -- jsonb number, or null/empty-string for an explicit clear.
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

      -- Activity row matches TS path at work-order.service.ts:942-968.
      insert into public.ticket_activities
        (tenant_id, ticket_id, activity_type, author_person_id, visibility, metadata)
      values (
        p_tenant_id,
        p_entity_id,
        'system_event',
        v_actor_person_id,
        'system',
        jsonb_build_object(
          'event',    'plan_changed',
          'previous', jsonb_build_object(
            'planned_start_at',         v_prev_planned_start,
            'planned_duration_minutes', v_prev_planned_duration
          ),
          'next', jsonb_build_object(
            'planned_start_at',         v_new_planned_start,
            'planned_duration_minutes', v_new_planned_duration
          )
        )
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

    -- title: NOT NULL on both tables; reject explicit null or empty.
    if v_has_title_key then
      v_new_title := v_metadata->>'title';
      if v_new_title is null or length(v_new_title) = 0 then
        raise exception 'update_entity_combined.invalid_metadata: title cannot be empty'
          using errcode = 'P0001';
      end if;
      v_title_changed := v_new_title is distinct from v_prev_title;
    end if;

    -- description: nullable.
    if v_has_description_key then
      v_new_description := v_metadata->>'description';
      v_description_changed := v_new_description is distinct from v_prev_description;
    end if;

    -- cost: numeric(12,2). F3 — validate jsonb type before cast; round
    -- to 2 decimals to match the TS contract's numeric(12,2) round-trip.
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

    -- tags: text[]. F3 — every element must be jsonb_typeof='string'.
    if v_has_tags_key then
      v_tags_raw := v_metadata->'tags';
      if jsonb_typeof(v_tags_raw) <> 'array' then
        raise exception 'update_entity_combined.invalid_metadata: tags must be a jsonb array'
          using errcode = 'P0001';
      end if;
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
      v_tags_changed := v_new_tags is distinct from v_prev_tags;
    end if;

    -- watchers: uuid[] of tenant person ids. F3 — every element must be
    -- a jsonb string AND match the canonical uuid regex BEFORE we cast
    -- to uuid. F2 — dedup before tenant-membership count so duplicate
    -- uuids don't false-reject. Persisted set is the deduped set
    -- (matches TS at apps/api/src/common/tenant-validation.ts:269).
    if v_has_watchers_key then
      v_watchers_raw := v_metadata->'watchers';
      if jsonb_typeof(v_watchers_raw) <> 'array' then
        raise exception 'update_entity_combined.invalid_metadata: watchers must be a jsonb array'
          using errcode = 'P0001';
      end if;
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

      -- F2: dedup before tenant-membership check. Caller may pass
      -- [uuidA, uuidA]; we dedup so a legal-looking duplicate doesn't
      -- false-reject. The deduped array is also what we persist.
      v_new_watchers_unique := array(select distinct unnest(v_new_watchers));

      if cardinality(v_new_watchers_unique) > 0 then
        select count(*) into v_watcher_match_count
          from public.persons
         where tenant_id = p_tenant_id
           and id        = any(v_new_watchers_unique);
        if v_watcher_match_count <> cardinality(v_new_watchers_unique) then
          raise exception 'update_entity_combined.invalid_watcher: one or more watchers are not tenant persons'
            using errcode = 'P0001';
        end if;
      end if;

      v_new_watchers := v_new_watchers_unique;
      v_watchers_changed := v_new_watchers is distinct from v_prev_watchers;
    end if;

    -- Apply update only if anything changed. Build the changes payload
    -- as we go so it matches TS's one-row-per-call shape
    -- (ticket.service.ts:1236-1252).
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

comment on function public.update_entity_combined(text, uuid, uuid, uuid, text, jsonb) is
  'B.2.A.8 §3.0 orchestrator v2 (00332 supersedes 00331). Same surface; folds F1 (inner-key sentinel __combined__:), F2 (watcher dedup before tenant check + persist deduped), F3 (jsonb_typeof validation BEFORE cast → registered codes instead of 22P02/22007: invalid_plan / invalid_cost / invalid_watcher / invalid_metadata), F4 (one actor_person_id lookup per call). Composes per-field RPCs (transition_entity_status 00325 / set_entity_assignment 00327 / update_entity_sla 00330) plus inline plan / priority / metadata branches mirroring ticket.service.ts (priority :1224-1234; metadata :1236-1252) + work-order.service.ts (plan :942-968). Plan-on-case rejected (00011_tickets.sql:1-44 has no planned_* cols). Nested idempotency keys are sentinel-prefixed; outer cache hit short-circuits before re-entering sub-RPCs. Atomicity: every branch in one tx; one raise rolls everything back. Watchers persisted as the deduped set (matches TS [...new Set] at apps/api/src/common/tenant-validation.ts:269). Cost rounded to 2dp for numeric(12,2) round-trip parity. Result: {entity_id, entity_kind, branches_applied, status, assignment, sla, priority, plan, metadata, any_changed, noop}. Idempotent on (tenant_id, p_idempotency_key) via command_operations (00316). Spec: docs/follow-ups/b2-survey-and-design.md §3.0.';

notify pgrst, 'reload schema';
