-- Domain Outbox — Plan B.1 (v3) FOUNDATION
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md (commit 83f3ba0)
-- This migration ships the schema + SQL helpers + grants ONLY. No producer
-- cutover; no triggers on domain tables. The compensation cutover lands in
-- a separate migration after foundation lands and codex re-reviews.
--
-- Pattern reference: supabase/migrations/00161_gdpr_audit_outbox.sql is the
-- shape this table mirrors and extends with idempotency, payload_hash, lease,
-- event versioning, and dead-letter (spec §2.1).

-- ─────────────────────────────────────────────────────────────────────────
-- 1. outbox.events — single durable table for domain events (spec §2.1)
-- ─────────────────────────────────────────────────────────────────────────

create schema if not exists outbox;

create table if not exists outbox.events (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,

  -- Classification (spec §2.1)
  event_type          text        not null,                       -- e.g. 'booking.create_attempted'
  event_version       int         not null default 1,             -- spec §10
  aggregate_type      text        not null,                       -- 'booking', 'work_order', etc.
  aggregate_id        uuid        not null,

  payload             jsonb       not null default '{}'::jsonb,
  -- md5 of canonical payload at insert time. Used by the ON CONFLICT verifier
  -- in outbox.emit() to detect (tenant, key) collisions where two callers
  -- tried to emit semantically different events under the same idempotency
  -- key. See spec §2.3 (the I3 fold).
  payload_hash        text        not null,

  -- Idempotency: tenant-scoped to prevent cross-tenant collisions (spec §2.4 / C3).
  idempotency_key     text        not null,

  -- Processing state
  enqueued_at         timestamptz not null default now(),
  available_at        timestamptz not null default now(),         -- watchdog/lease (spec §7.2)
  processed_at        timestamptz,
  processed_reason    text,                                       -- 'attached'|'compensated'|'consumed'|'handler_ok'|...
  claim_token         uuid,
  claimed_at          timestamptz,
  attempts            int         not null default 0,
  last_error          text,
  dead_lettered_at    timestamptz,                                -- spec §4.2.3

  constraint outbox_events_attempts_nonneg check (attempts >= 0),
  constraint outbox_events_idem_unique unique (tenant_id, idempotency_key)
);

-- Hot index: worker drain. Leads with available_at because the drain query
-- filters globally across tenants in a single sweep (spec §2.1 / C2 fix).
create index if not exists idx_outbox_events_drainable
  on outbox.events (available_at, enqueued_at)
  where processed_at is null and claim_token is null and dead_lettered_at is null;

-- Optional: per-tenant drain support for future per-tenant workers / fairness
-- and tenant-scoped admin queries (spec §2.1).
create index if not exists idx_outbox_events_per_tenant_pending
  on outbox.events (tenant_id, available_at)
  where processed_at is null;

-- Stale-claim sweep (spec §4.2.4)
create index if not exists idx_outbox_events_stale_claim
  on outbox.events (claimed_at)
  where processed_at is null and claimed_at is not null;

-- Cleanup index (purge cron — spec §13.1)
create index if not exists idx_outbox_events_processed
  on outbox.events (processed_at)
  where processed_at is not null;

alter table outbox.events enable row level security;

drop policy if exists tenant_isolation on outbox.events;
create policy tenant_isolation on outbox.events
  using (tenant_id = public.current_tenant_id());

comment on table outbox.events is
  'Durable outbox for domain events. Producers MUST insert via outbox.emit() helper or row-triggers, inside the business write transaction. Worker drains asynchronously; at-least-once + idempotent handlers. Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §2.1.';
comment on column outbox.events.idempotency_key is
  'Tenant-scoped (see unique constraint with tenant_id). Format: <event_type>:<aggregate_id>[:<discriminator>].';
comment on column outbox.events.payload_hash is
  'md5 of canonical payload. Same idempotency_key + same payload_hash = idempotent silent success; same key + different hash = explicit error from outbox.emit().';
comment on column outbox.events.available_at is
  'Lease/backoff. The worker only claims rows where available_at <= now(). Watchdog events set this 30s in the future; success-path consumers mark the event processed before the lease expires.';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. outbox.events_dead_letter — write-once archive (spec §2.2)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists outbox.events_dead_letter (
  id                  uuid        primary key,                     -- mirrors source events.id
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  event_type          text        not null,
  event_version       int         not null default 1,
  aggregate_type      text        not null,
  aggregate_id        uuid        not null,
  payload             jsonb       not null default '{}'::jsonb,
  payload_hash        text        not null,
  idempotency_key     text        not null,
  enqueued_at         timestamptz not null,
  attempts            int         not null,
  last_error          text,
  dead_lettered_at    timestamptz not null default now(),
  -- 'max_attempts' | 'dead_letter_error' | 'tenant_not_found' | 'partial_failure_blocker' | 'no_handler_registered'
  dead_letter_reason  text        not null,

  constraint events_dead_letter_idem_unique unique (tenant_id, idempotency_key)
);

create index if not exists idx_events_dead_letter_recent
  on outbox.events_dead_letter (dead_lettered_at desc);
create index if not exists idx_events_dead_letter_event_type
  on outbox.events_dead_letter (event_type, dead_lettered_at desc);

alter table outbox.events_dead_letter enable row level security;

drop policy if exists tenant_isolation on outbox.events_dead_letter;
create policy tenant_isolation on outbox.events_dead_letter
  using (tenant_id = public.current_tenant_id());

comment on table outbox.events_dead_letter is
  'Write-once archive of events that exhausted retries or were rejected by the handler with DeadLetterError. The live outbox.events row is also flagged with dead_lettered_at so admin tooling has a single SELECT path. Spec §2.2 / §4.2.3.';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. outbox.emit() — canonical producer entry point (spec §2.3)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function outbox.emit(
  p_tenant_id       uuid,
  p_event_type      text,
  p_aggregate_type  text,
  p_aggregate_id    uuid,
  p_payload         jsonb,
  p_idempotency_key text,
  p_event_version   int default 1,
  p_available_at    timestamptz default null
) returns uuid
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_id      uuid;
  v_payload jsonb;
  v_hash    text;
begin
  if p_tenant_id is null then
    raise exception 'outbox.emit: p_tenant_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'outbox.emit: p_idempotency_key required (no anonymous emits)';
  end if;

  v_payload := coalesce(p_payload, '{}'::jsonb);
  v_hash    := md5(v_payload::text);

  -- Spec §2.3 — ON CONFLICT verifies payload identity. Same key + same payload
  -- = silent idempotent success (returns existing id); same key + different
  -- payload = explicit error (errcode 23505). The DO UPDATE … WHERE all-fields
  -- form returns the existing id only when classification + payload_hash match.
  insert into outbox.events
    (tenant_id, event_type, event_version, aggregate_type, aggregate_id,
     payload, payload_hash, idempotency_key, available_at)
  values
    (p_tenant_id, p_event_type, p_event_version, p_aggregate_type, p_aggregate_id,
     v_payload, v_hash, p_idempotency_key, coalesce(p_available_at, now()))
  on conflict (tenant_id, idempotency_key) do update
     set payload_hash = excluded.payload_hash   -- no-op; we just need the WHERE
   where outbox.events.event_type     = excluded.event_type
     and outbox.events.event_version  = excluded.event_version
     and outbox.events.aggregate_type = excluded.aggregate_type
     and outbox.events.aggregate_id   = excluded.aggregate_id
     and outbox.events.payload_hash   = excluded.payload_hash
  returning id into v_id;

  -- WHERE failed → no RETURNING row. Detect a true collision and raise; else
  -- (same-payload re-emit) fetch the existing id for caller observability.
  if v_id is null then
    perform 1 from outbox.events
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
       and payload_hash <> v_hash;
    if found then
      raise exception 'outbox.emit: idempotency key collision for tenant=% key=%',
        p_tenant_id, p_idempotency_key using errcode = '23505';
    end if;
    select id into v_id from outbox.events
     where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
  end if;

  return v_id;
end;
$$;

comment on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz) is
  'Canonical entry point for emitting domain events. SECURITY INVOKER. Called from inside RPC bodies (atomic with the business write) or row-lifecycle triggers. Idempotent on (tenant_id, idempotency_key); same-key/different-payload raises 23505. Spec §2.3.';

-- ─────────────────────────────────────────────────────────────────────────
-- 4. outbox.mark_consumed() — lease consumption (spec §2.5)
-- ─────────────────────────────────────────────────────────────────────────

create or replace function outbox.mark_consumed(
  p_idempotency_key text,
  p_tenant_id       uuid,
  p_reason          text default 'consumed'
) returns boolean
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_updated int;
begin
  if p_tenant_id is null then
    raise exception 'mark_consumed: p_tenant_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'mark_consumed: p_idempotency_key required';
  end if;

  -- Idempotent: re-calling on an already-consumed event is a no-op (returns false).
  -- WHERE excludes dead-lettered rows; consuming a dead-letter is a bug.
  update outbox.events
     set processed_at     = coalesce(processed_at, now()),
         processed_reason = case when processed_at is null then p_reason else processed_reason end,
         claim_token      = null
   where tenant_id = p_tenant_id
     and idempotency_key = p_idempotency_key
     and processed_at is null
     and dead_lettered_at is null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

comment on function outbox.mark_consumed(text, uuid, text) is
  'Marks a lease event consumed. Idempotent — re-calling on an already-consumed event returns false. Excludes dead-lettered rows. Spec §2.5.';

-- ─────────────────────────────────────────────────────────────────────────
-- 5. PostgREST wrappers — let supabase-js call helpers via .rpc() (spec §14)
--
-- supabase-js cannot call functions in non-public schemas. The wrappers live
-- in `public` and delegate to the schema-qualified outbox.* helpers.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.outbox_emit_via_rpc(
  p_tenant_id       uuid,
  p_event_type      text,
  p_aggregate_type  text,
  p_aggregate_id    uuid,
  p_payload         jsonb,
  p_idempotency_key text,
  p_event_version   int default 1
) returns uuid
language sql
security invoker
as $$
  select outbox.emit(
    p_tenant_id, p_event_type, p_aggregate_type, p_aggregate_id,
    p_payload, p_idempotency_key, p_event_version, null
  );
$$;

comment on function public.outbox_emit_via_rpc(uuid, text, text, uuid, jsonb, text, int) is
  'PostgREST wrapper around outbox.emit. supabase-js cannot reach non-public schemas via .rpc(); this is the canonical path for fire-and-forget TS-side emits.';

create or replace function public.outbox_mark_consumed_via_rpc(
  p_tenant_id       uuid,
  p_idempotency_key text,
  p_reason          text default 'consumed'
) returns boolean
language sql
security invoker
as $$
  select outbox.mark_consumed(p_idempotency_key, p_tenant_id, p_reason);
$$;

comment on function public.outbox_mark_consumed_via_rpc(uuid, text, text) is
  'PostgREST wrapper around outbox.mark_consumed. Spec §2.5.';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. outbox_shadow_results — Phase A cutover gate (spec §5.2 / I4)
--
-- Lives in public schema (RLS-policied per existing helpers) so admin tooling
-- and gate queries follow the existing tenant_isolation pattern. Schema
-- consistency: the spec text mentions both `outbox.shadow_results` and
-- `public.outbox_shadow_results` in different places; we pick public to align
-- with how the spec defines it in §5.2 and the existing tenant_isolation
-- policy convention used across other public.* tables.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.outbox_shadow_results (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,
  event_type        text        not null,
  event_version     int         not null,
  aggregate_id      uuid        not null,
  outbox_event_id   uuid        references outbox.events(id),

  -- What the existing inline path actually did (computed by the boundary).
  -- Shape: { kind: 'rolled_back'|'partial_failure'|'no_compensation_needed',
  --          booking_existed_before: bool, booking_existed_after: bool,
  --          blockers: string[], error_message: string | null }
  inline_outcome    jsonb       not null,

  -- What the shadow handler would have done (computed in dry-run; never mutates).
  shadow_outcome    jsonb       not null,

  matched           boolean     not null,
  -- When matched=false: structured diff. Shape: { fields_diff: [{path, inline, shadow}], reason: string }.
  diff              jsonb,

  recorded_at       timestamptz not null default now()
);

create index if not exists idx_outbox_shadow_results_unmatched
  on public.outbox_shadow_results (recorded_at)
  where matched = false;

create index if not exists idx_outbox_shadow_results_event_type
  on public.outbox_shadow_results (event_type, recorded_at desc);

alter table public.outbox_shadow_results enable row level security;

drop policy if exists tenant_isolation on public.outbox_shadow_results;
create policy tenant_isolation on public.outbox_shadow_results
  using (tenant_id = public.current_tenant_id());

comment on table public.outbox_shadow_results is
  'Phase A → Phase B cutover gate (spec §5.2 / I4). For each compensation invocation, the boundary records both the inline_outcome it produced and the shadow_outcome the handler would have produced; matched=false rows block the gate query.';

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Grants (spec §2.6)
--
-- outbox.events is reachable only via the helper functions; no role gets
-- direct DML except the worker (service_role only). authenticated tokens
-- can EXECUTE the helpers (so future per-user RPC bodies can emit) but
-- cannot SELECT/UPDATE the table directly.
-- ─────────────────────────────────────────────────────────────────────────

revoke all on schema outbox from public;
grant  usage on schema outbox to service_role, authenticated;

revoke all on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz) from public;
grant  execute on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz) to service_role, authenticated;

revoke all on function outbox.mark_consumed(text, uuid, text) from public;
grant  execute on function outbox.mark_consumed(text, uuid, text) to service_role, authenticated;

revoke all on function public.outbox_emit_via_rpc(uuid, text, text, uuid, jsonb, text, int) from public;
grant  execute on function public.outbox_emit_via_rpc(uuid, text, text, uuid, jsonb, text, int) to service_role;

revoke all on function public.outbox_mark_consumed_via_rpc(uuid, text, text) from public;
grant  execute on function public.outbox_mark_consumed_via_rpc(uuid, text, text) to service_role;

-- Worker is the only direct-table caller (drain CTE is hot-path SQL we keep
-- unmediated). Authenticated has NO direct access — must go through outbox.emit.
revoke all on table outbox.events from public;
grant  select, update on table outbox.events to service_role;

revoke all on table outbox.events_dead_letter from public;
grant  insert, select on table outbox.events_dead_letter to service_role;

revoke all on table public.outbox_shadow_results from public;
grant  insert, select on table public.outbox_shadow_results to service_role;

notify pgrst, 'reload schema';
