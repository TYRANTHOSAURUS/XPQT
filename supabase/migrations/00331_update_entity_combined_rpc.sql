-- B.2.A.8 — update_entity_combined orchestrator RPC (§3.0).
--
-- Spec: docs/follow-ups/b2-survey-and-design.md §3.0 (lines 1781-1897).
--
-- ── Purpose ─────────────────────────────────────────────────────────────
--
-- Single controller-facing RPC that replaces the TS write path for
-- `PATCH /tickets/:id` and `PATCH /work-orders/:id`. Composes the per-
-- field RPCs (§3.1-3.3) for status/assignment/sla, plus inline plan,
-- priority, and metadata branches matching the TS surface in
-- ticket.service.ts and work-order.service.ts.
--
-- Controllers do NOT cut over here — that happens in Commit B of this
-- B.2.A Step 6 wave. This migration only adds the RPC + grants + the
-- schema-reload notify.
--
-- ── Design defaults (locked) ────────────────────────────────────────────
--
-- (a) API surface unchanged. The RPC's external observable is row
--     state + ticket_activities + domain_events + outbox events.
-- (b) Partial patches. A branch fires only when its top-level key is
--     present in p_patches. Absent != null. Null is an explicit clear
--     where the schema allows. Missing key = no-op for that branch.
-- (c) Nested idempotency keys. PERFORMed sub-RPCs receive
--     `<outer>:<branch>:<entity_kind>:<entity_id>`. Branch names:
--     status, assignment, sla. Plan / priority / metadata are inline,
--     not sub-RPCs — they don't carry nested keys.
-- (d) Scope guard: §3.0 only. Plan-on-case is rejected up front
--     (tickets table has no planned_* columns per 00011_tickets.sql:1-44;
--     only work_orders does per 00213_step1c1_work_orders_new_table.sql
--     :108-109).
--
-- ── Behavioural notes per branch ────────────────────────────────────────
--
-- status: PERFORM public.transition_entity_status — emits the SLA
--   pause/resume outbox + outbox status_event already; we surface its
--   returned jsonb. Citations: 00325 (v2) lines 296-313 + 349-369.
--
-- assignment: PERFORM public.set_entity_assignment — emits
--   ticket_activities (assignment_changed/reassigned) + optional
--   routing_decisions + domain_events ('ticket_assigned'). Citation:
--   00327 lines 361-410.
--
-- sla: PERFORM public.update_entity_sla — emits ticket_activities
--   (sla_changed) + domain_events ('ticket_sla_changed'); requires
--   explicit sla_id key per v3 / I1 guard. Citation: 00330 lines
--   104-108 + 336-369.
--
-- priority (inline): mirrors TS path at ticket.service.ts:1224-1234.
--   One ticket_activities row with metadata.event='priority_changed';
--   NO domain_events, NO outbox emit.
--
-- plan (inline, WO-only): mirrors TS path at work-order.service.ts
--   :942-968. One ticket_activities row with metadata.event=
--   'plan_changed'; NO domain_events; NO outbox emit.
--
-- metadata (inline): mirrors TS path at ticket.service.ts:1236-1252.
--   Per-field diffs into a single `metadata_changed` activity row
--   carrying metadata.changes={<field>:{previous,next},...}. Watcher
--   uuids must be tenant persons (see 00011_tickets.sql:26 — watchers
--   are person ids); we validate here so cross-tenant probes fail
--   atomically. NO domain_events, NO outbox emit.
--
-- ── Idempotency model ───────────────────────────────────────────────────
--
-- Outer command_operations row keyed on (tenant_id, p_idempotency_key)
-- with payload_hash = md5(p_patches::text). Same key + same payload
-- returns cached_result. Same key + different payload raises
-- 'command_operations.payload_mismatch'.
--
-- Sub-RPCs each maintain their OWN command_operations row keyed on
-- (tenant_id, <nested_key>). On replay the outer cache hit short-
-- circuits before re-entering any sub-RPC.
--
-- Atomicity: every branch's writes (sub-RPC + inline) run in the same
-- transaction as the outer RPC. If any branch raises, the whole
-- combined call rolls back — outer + inner command_operations rows
-- included.
--
-- ── Result jsonb ────────────────────────────────────────────────────────
--
-- {
--   "entity_id":        uuid,
--   "entity_kind":      'case' | 'work_order',
--   "branches_applied": ["status","priority","assignment","sla","plan","metadata"] subset,
--   "status":     <sub-RPC result> | null,
--   "assignment": <sub-RPC result> | null,
--   "sla":        <sub-RPC result> | null,
--   "priority":   {"previous":..., "next":..., "changed": bool} | null,
--   "plan":       {"previous":{...}, "next":{...}, "changed": bool} | null,
--   "metadata":   {"changes":{...}, "changed": bool} | null,
--   "any_changed": bool,
--   "noop":        bool
-- }

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
  v_cost_changed             boolean := false;

  v_prev_tags                text[];
  v_new_tags                 text[];
  v_tags_changed             boolean := false;

  v_prev_watchers            uuid[];
  v_new_watchers             uuid[];
  v_watcher_match_count      int;
  v_watchers_changed         boolean := false;

  v_metadata_changes         jsonb := '{}'::jsonb;

  v_actor_person_id          uuid;
  v_branches_applied         jsonb := '[]'::jsonb;
  v_any_changed              boolean := false;
  v_result                   jsonb;
begin
  -- ── 0. Argument shape checks (mirror 00330:84-96) ─────────────────────
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
      p_idempotency_key || ':status:' || p_entity_kind || ':' || p_entity_id::text,
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

      -- Resolve actor_person_id (mirror 00330:326-333).
      if v_actor_person_id is null and p_actor_user_id is not null then
        select u.person_id into v_actor_person_id
          from public.users u
         where u.tenant_id = p_tenant_id
           and u.auth_uid  = p_actor_user_id
         limit 1;
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
    v_assignment_result := public.set_entity_assignment(
      p_entity_id,
      p_entity_kind,
      p_tenant_id,
      p_actor_user_id,
      p_idempotency_key || ':assignment:' || p_entity_kind || ':' || p_entity_id::text,
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
      p_idempotency_key || ':sla:' || p_entity_kind || ':' || p_entity_id::text,
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

    v_new_planned_start :=
      case when v_plan_has_start_key
           then nullif(p_patches->'plan'->>'planned_start_at', '')::timestamptz
           else v_prev_planned_start
      end;
    v_new_planned_duration :=
      case when v_plan_has_duration_key
           then nullif(p_patches->'plan'->>'planned_duration_minutes', '')::integer
           else v_prev_planned_duration
      end;

    v_plan_changed := (v_new_planned_start    is distinct from v_prev_planned_start)
                   or (v_new_planned_duration is distinct from v_prev_planned_duration);

    if v_plan_changed then
      update public.work_orders
         set planned_start_at         = case when v_plan_has_start_key    then v_new_planned_start    else planned_start_at         end,
             planned_duration_minutes = case when v_plan_has_duration_key then v_new_planned_duration else planned_duration_minutes end,
             updated_at               = now()
       where id = p_entity_id and tenant_id = p_tenant_id;

      if v_actor_person_id is null and p_actor_user_id is not null then
        select u.person_id into v_actor_person_id
          from public.users u
         where u.tenant_id = p_tenant_id
           and u.auth_uid  = p_actor_user_id
         limit 1;
      end if;

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

    -- cost: numeric(12,2). Reject negative; round to 2 decimals to match
    -- the TS contract's NUMERIC round-trip (cost is stored as numeric(12,2)).
    if v_has_cost_key then
      if v_metadata->>'cost' is null then
        v_new_cost := null;
      else
        v_new_cost := round((v_metadata->>'cost')::numeric, 2);
        if v_new_cost < 0 then
          raise exception 'update_entity_combined.invalid_cost: cost must be non-negative'
            using errcode = 'P0001';
        end if;
      end if;
      v_cost_changed := v_new_cost is distinct from v_prev_cost;
    end if;

    -- tags: text[]. Accept jsonb array.
    if v_has_tags_key then
      if jsonb_typeof(v_metadata->'tags') <> 'array' then
        raise exception 'update_entity_combined.invalid_metadata: tags must be a jsonb array'
          using errcode = 'P0001';
      end if;
      select coalesce(array_agg(value::text), '{}'::text[])
        into v_new_tags
        from jsonb_array_elements_text(v_metadata->'tags') as value;
      v_tags_changed := v_new_tags is distinct from v_prev_tags;
    end if;

    -- watchers: uuid[] of tenant person ids. Validate every uuid resolves
    -- to a person in this tenant before writing — atomic rejection on
    -- cross-tenant probes (00011_tickets.sql:26 — watchers are person ids).
    if v_has_watchers_key then
      if jsonb_typeof(v_metadata->'watchers') <> 'array' then
        raise exception 'update_entity_combined.invalid_metadata: watchers must be a jsonb array'
          using errcode = 'P0001';
      end if;
      select coalesce(array_agg((value::text)::uuid), '{}'::uuid[])
        into v_new_watchers
        from jsonb_array_elements_text(v_metadata->'watchers') as value;

      if cardinality(v_new_watchers) > 0 then
        select count(*) into v_watcher_match_count
          from public.persons
         where tenant_id = p_tenant_id
           and id        = any(v_new_watchers);
        if v_watcher_match_count <> cardinality(v_new_watchers) then
          raise exception 'update_entity_combined.invalid_watcher: one or more watchers are not tenant persons'
            using errcode = 'P0001';
        end if;
      end if;

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

      if v_actor_person_id is null and p_actor_user_id is not null then
        select u.person_id into v_actor_person_id
          from public.users u
         where u.tenant_id = p_tenant_id
           and u.auth_uid  = p_actor_user_id
         limit 1;
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

revoke execute on function public.update_entity_combined(text, uuid, uuid, uuid, text, jsonb) from public;
grant  execute on function public.update_entity_combined(text, uuid, uuid, uuid, text, jsonb) to service_role;

comment on function public.update_entity_combined(text, uuid, uuid, uuid, text, jsonb) is
  'B.2.A.8 §3.0 orchestrator. Single controller-facing RPC composing per-field RPCs (transition_entity_status 00325 / set_entity_assignment 00327 / update_entity_sla 00330) for status / assignment / sla, plus inline plan / priority / metadata branches mirroring the TS surface in ticket.service.ts (priority :1224-1234; metadata :1236-1252) and work-order.service.ts (plan :942-968). Partial patches: a branch fires only when its top-level key is present in p_patches (`?` test); plan-on-case is rejected because tickets has no planned_* columns (00011_tickets.sql:1-44 vs 00213_step1c1_work_orders_new_table.sql:108-109). Nested idempotency: sub-RPCs receive p_idempotency_key || `:<branch>:<kind>:<id>` so a same-outer-key replay short-circuits via the outer command_operations cache before re-entering them. Atomicity: every branch shares the outer tx; one raise rolls everything back, command_operations rows included. Watcher uuids must be tenant persons (00011_tickets.sql:26). Cost is rounded to 2 decimals in SQL to match the numeric(12,2) round-trip contract. Result: {entity_id, entity_kind, branches_applied, status, assignment, sla, priority, plan, metadata, any_changed, noop}. Idempotent on (tenant_id, p_idempotency_key) via command_operations (00316). Spec: docs/follow-ups/b2-survey-and-design.md §3.0.';

notify pgrst, 'reload schema';
