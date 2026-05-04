# Domain Outbox Design Specification — Plan B.1 (v3)

> **Authored:** 2026-05-04
> **Phase:** 6 (Durable Infrastructure)
> **Scope:** Investigation + Design only. No implementation code beyond this spec.

---

## Revision history

- **v1** (commit `f5b96c5`, superseded): proposed a TS-side `OutboxService.emitTx(client)` claiming to share a transaction with the business write. Foundational mismatch — `BookingFlowService.create` calls `supabase.admin.rpc('create_booking', ...)`, which is a PostgREST HTTP call on its own PgBouncer-pooled connection, not the API process's `pg.PoolClient`. No shared transaction exists; v1's atomicity claim was unsatisfiable. v1 also used a global idempotency unique key (cross-tenant collision), led the drain index with `tenant_id` while the worker filters globally, claimed RLS would catch cross-tenant smuggling at handler dispatch (service role bypasses RLS), and ordered the cutover "easiest first" (compensation last) — exactly inverse of the risk profile.
- **v2** (commit `b38db4a`, superseded): moved atomicity into Postgres. Producers emit via row triggers or via an `outbox.emit(...)` SQL helper called from inside an RPC, in the same transaction as the business write. TS-side `OutboxService.emit()` reframed as fire-and-forget. Folded 5 criticals + 5 importants from v1.
- **v3** (this revision): codex caught one foundational error plus 4 importants and 2 nits. **Headline fix:** v2 emitted `booking.compensation_required` from inside `delete_booking_with_guard()`, but that's too late — the orphan-booking failure window is BEFORE the RPC is called. By the time the RPC fires, the boundary either handled it synchronously (no event needed) or the process is dead (no one is calling the RPC). v3 replaces it with a **watchdog/lease pattern**: `create_booking()` emits `booking.create_attempted` with a 30s lease; the success path consumes the lease via `outbox.mark_consumed`; the crash path is recovered by a watchdog handler that fires after the lease expires. v3 also: makes the worker state machine explicit (4 transitions, no implicit "claim increments attempts" footgun); specifies SQL grants for the `outbox` schema; makes `ON CONFLICT` verify payload identity (not silently swallow caller bugs); defines an automated shadow-comparison contract (`outbox_shadow_results` + zero-mismatch gate) before cutover; reframes event-version rollout as three deploys with verification queries, not three commits.

---

## 1. Architectural rule (NON-NEGOTIABLE)

> **Atomic outbox events MUST be created inside Postgres, in the same transaction as the business write.**

Two acceptable mechanisms:

1. **Row-lifecycle triggers** — `AFTER INSERT`/`AFTER UPDATE` on a domain table emits when the event truly is "this row reached state X." Same transaction as the writing statement.
2. **`outbox.emit(...)` helper called from inside an RPC** — when the payload carries semantic content the row alone doesn't capture (input ids, computed payloads, idempotency tokens, lease windows). SECURITY INVOKER PL/pgSQL function called from inside another PL/pgSQL function (e.g. `create_booking`) that is itself running in a Postgres transaction.

**Excluded**: a TS-side `emitTx(client, ...)` pretending to share a transaction with a PostgREST RPC (the `pg.PoolClient` the API holds is on a different connection from PostgREST's; there is no shared transaction); generic per-table CDC firehose triggers (domain events are intentional, the payload is designed for the consumer).

**TS-side `OutboxService.emit()`** survives only as a fire-and-forget post-commit helper for best-effort operations (notifications, webhook delivery hints). Never the path for compensation, SLA timer creation, or anything where loss of the event corrupts state.

---

## 2. Schema

### 2.1 `outbox.events`

Single table with `event_type` discriminator. Mirrors the `audit_outbox` pattern (migration `00161_gdpr_audit_outbox.sql:12-50`) but with idempotency, backoff, dead-letter, event versioning, and lease-payload integrity bolted on.

```sql
-- supabase/migrations/00XXX_domain_outbox.sql

create table if not exists outbox.events (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,

  -- Classification
  event_type          text        not null,                       -- 'booking.create_attempted', etc.
  event_version       int         not null default 1,             -- §10
  aggregate_type      text        not null,                       -- 'booking', 'work_order', 'sla_timer'
  aggregate_id        uuid        not null,

  payload             jsonb       not null default '{}'::jsonb,
  -- Hash of payload at insert time. Used by the ON CONFLICT verifier in
  -- outbox.emit() to detect (tenant, key) collisions where two callers tried
  -- to emit semantically different events under the same idempotency key.
  -- See §2.3 (the I3 fold).
  payload_hash        text        not null,

  -- Idempotency: tenant-scoped (see §2.4 / C3)
  idempotency_key     text        not null,

  -- Processing state
  enqueued_at         timestamptz not null default now(),
  available_at        timestamptz not null default now(),         -- watchdog/lease (§7.2)
  processed_at        timestamptz,
  processed_reason    text,                                        -- 'attached'|'compensated'|'consumed'|'handler_ok'|...
  claim_token         uuid,
  claimed_at          timestamptz,
  attempts            int         not null default 0,
  last_error          text,
  dead_lettered_at    timestamptz,                                 -- §4.2.3

  constraint outbox_events_attempts_nonneg check (attempts >= 0),
  constraint outbox_events_idem_unique unique (tenant_id, idempotency_key)
);

-- Hot index: worker drain. Leads with available_at because the drain query
-- filters globally across tenants in a single sweep (the worker isn't sharded
-- per tenant in v2). C2: v1's lead-with-tenant_id index forced a full scan
-- across all tenant prefixes for every drain.
create index if not exists idx_outbox_events_drainable
  on outbox.events (available_at, enqueued_at)
  where processed_at is null and claim_token is null and dead_lettered_at is null;

-- Optional: per-tenant drain support for future per-tenant workers / fairness.
-- Justified because tenant-scoped admin queries ("show pending events for tenant X")
-- and any future per-tenant worker pool will benefit. Not used by the default drain.
create index if not exists idx_outbox_events_per_tenant_pending
  on outbox.events (tenant_id, available_at)
  where processed_at is null;

-- Stale-claim sweep
create index if not exists idx_outbox_events_stale_claim
  on outbox.events (claimed_at)
  where processed_at is null and claimed_at is not null;

-- Cleanup index
create index if not exists idx_outbox_events_processed
  on outbox.events (processed_at)
  where processed_at is not null;

alter table outbox.events enable row level security;

drop policy if exists tenant_isolation on outbox.events;
create policy tenant_isolation on outbox.events
  using (tenant_id = public.current_tenant_id());

comment on table outbox.events is
  'Durable outbox for domain events. Producers MUST insert via outbox.emit() helper or row-triggers, inside the business write transaction. Worker drains asynchronously; at-least-once + idempotent handlers.';
comment on column outbox.events.idempotency_key is
  'Tenant-scoped (see unique constraint with tenant_id). Format: <event_type>:<aggregate_id>[:<discriminator>].';
comment on column outbox.events.payload_hash is
  'md5 of canonical payload. Same idempotency_key + same payload_hash = idempotent silent success; same key + different hash = explicit error from outbox.emit().';
comment on column outbox.events.available_at is
  'Lease/backoff. The worker only claims rows where available_at <= now(). Watchdog events set this 30s in the future; success-path consumers mark the event processed before the lease expires.';
```

### 2.2 `outbox.events_dead_letter`

Same shape as v1 (separate table, write-once, narrow main table). Carry forward v1's `outbox_events_dead_letter` definition and add `event_version` + `payload_hash` + `(tenant_id, idempotency_key)` unique to match v3's `outbox.events`. Dead-lettering is implemented via a same-transaction copy + flag-set (see §4.2.3); the row stays visible in `outbox.events` (with `dead_lettered_at` set so the drain index excludes it) so admin tooling has a single SELECT path.

### 2.3 The `outbox.emit(...)` SQL helper (the canonical producer entry point)

The only way an event lands in `outbox.events`. Triggers and RPC bodies call it directly; TS calls a thin PostgREST wrapper (`outbox_emit_via_rpc`).

```sql
create schema if not exists outbox;

create or replace function outbox.emit(
  p_tenant_id uuid, p_event_type text, p_aggregate_type text, p_aggregate_id uuid,
  p_payload jsonb, p_idempotency_key text,
  p_event_version int default 1, p_available_at timestamptz default null
) returns uuid
language plpgsql security invoker set search_path = public, outbox as $$
declare v_id uuid; v_payload jsonb; v_hash text;
begin
  if p_tenant_id is null then raise exception 'outbox.emit: p_tenant_id required'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'outbox.emit: p_idempotency_key required (no anonymous emits)'; end if;

  v_payload := coalesce(p_payload, '{}'::jsonb);
  v_hash    := md5(v_payload::text);

  -- I3 fold: ON CONFLICT verifies payload identity. Same key + same payload =
  -- silent idempotent success; same key + different payload = explicit error.
  -- The DO UPDATE ... WHERE all-fields-match form returns the existing id
  -- only when classification + payload_hash all match.
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

  -- WHERE failed => no RETURNING row. Detect a true collision and raise; else
  -- (same payload re-emit) fetch the existing id for caller observability.
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
```

**Security model**: SECURITY INVOKER, matching `create_booking` (00277:262) and `delete_booking_with_guard` (00292:59). Single INSERT/UPDATE gated by RLS; service-role callers bypass RLS but pass `p_tenant_id` explicitly. Tenant id is NOT NULL — triggers have it pinned on the row, RPCs do their own JWT-or-explicit dance.

### 2.4 Tenant-scoped idempotency (C3)

v1 had `idempotency_key text unique` (global). Two tenants picking the same idempotency token would silently `on conflict do nothing` against each other — one tenant's event would be **silently dropped** by another tenant's prior emit. That's a CLAUDE.md #0 violation.

v2/v3: `unique (tenant_id, idempotency_key)`. Cross-tenant emits with the same logical key are independent. Within a tenant, idempotency works as before — but with v3's payload-hash verifier, same-key/different-payload is no longer silent (§2.3).

### 2.5 The `outbox.mark_consumed(...)` helper (lease consumption)

The watchdog/lease pattern (§7) needs a primitive for the success path to say "I succeeded; don't fire the watchdog." Called from TS via `outbox_mark_consumed_via_rpc` (mirroring the emit wrapper).

```sql
create or replace function outbox.mark_consumed(
  p_idempotency_key text, p_tenant_id uuid, p_reason text default 'consumed'
) returns boolean
language plpgsql security invoker set search_path = public, outbox as $$
declare v_updated int;
begin
  if p_tenant_id is null then raise exception 'mark_consumed: p_tenant_id required'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'mark_consumed: p_idempotency_key required'; end if;

  -- Idempotent: re-calling on an already-consumed event is a no-op (returns false).
  -- WHERE also excludes dead-lettered rows; consuming a dead-letter is a bug.
  update outbox.events
     set processed_at     = coalesce(processed_at, now()),
         processed_reason = case when processed_at is null then p_reason else processed_reason end,
         claim_token      = null
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
     and processed_at is null and dead_lettered_at is null;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function public.outbox_mark_consumed_via_rpc(
  p_tenant_id uuid, p_idempotency_key text, p_reason text default 'consumed'
) returns boolean language sql security invoker as $$
  select outbox.mark_consumed(p_idempotency_key, p_tenant_id, p_reason);
$$;
```

### 2.6 SQL grants (I2 fold + codex v3 I3 follow-up)

`outbox.events` is reachable only via the helper functions; no role (including `authenticated`) gets direct DML except the worker (`service_role` only). **Codex v3 review (I3)** found the original grant of `execute on outbox.emit(...) to authenticated` was misleading: `authenticated` could call the function but the underlying INSERT against `outbox.events` would fail because no DML grant exists on the table for that role. Fix: revoke EXECUTE on both helpers from `authenticated`. The helpers are now service_role-only; if a real user-emit case appears later, add an `outbox.emit_as_user(...)` SECURITY DEFINER wrapper that validates the caller's tenant context.

```sql
-- 00299_outbox_foundation.sql
revoke all on schema outbox from public;
grant  usage on schema outbox to service_role, authenticated;

revoke all on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz) from public;
grant  execute on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz) to service_role;

revoke all on function outbox.mark_consumed(text, uuid, text) from public;
grant  execute on function outbox.mark_consumed(text, uuid, text) to service_role;

revoke all on function public.outbox_emit_via_rpc(uuid, text, text, uuid, jsonb, text, int) from public;
grant  execute on function public.outbox_emit_via_rpc(uuid, text, text, uuid, jsonb, text, int) to service_role;
revoke all on function public.outbox_mark_consumed_via_rpc(uuid, text, text) from public;
grant  execute on function public.outbox_mark_consumed_via_rpc(uuid, text, text) to service_role;

-- 00301_outbox_emit_revoke_authenticated.sql (codex v3 I3 follow-up)
revoke execute on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz) from authenticated;
revoke execute on function outbox.mark_consumed(text, uuid, text) from authenticated;

-- Worker is the only direct-table caller (drain CTE is hot-path SQL we keep unmediated).
revoke all on table outbox.events from public;
grant  select, update on table outbox.events to service_role;
-- Authenticated has NO direct access — must go through outbox.emit (which is
-- itself service_role-only as of 00301). RLS would block cross-tenant reads
-- anyway; removing GRANT is a stronger structural defense (table not reachable
-- via PostgREST under auth tokens).
```

`outbox.events_dead_letter` and `outbox_shadow_results` get the same grants pattern (service_role read+update; nothing for authenticated). `outbox.emit` runs SECURITY INVOKER, so when called from another SECURITY INVOKER function (`create_booking`) the caller's tenant context is preserved; service-role callers pass `p_tenant_id` explicitly.

---

## 3. Producer API

### 3.1 Transactional emit — from RPCs and triggers

**From an RPC body** — `create_booking` (00277:236-334) gets a follow-up emit immediately before `return query`:

```sql
-- Migration REPLACEs create_booking. Existing params unchanged; adds two:
--   p_expected_services_count int default 0
--   p_emit_create_lease       boolean default true
-- Default is "lease on" because the safe-default is "leak nothing if I crash."
-- ...existing booking + slot inserts (00277:277-330)...

if p_emit_create_lease and coalesce(p_expected_services_count, 0) > 0 then
  perform outbox.emit(
    p_tenant_id       => v_tenant_id,
    p_event_type      => 'booking.create_attempted',
    p_aggregate_type  => 'booking',
    p_aggregate_id    => v_booking_id,
    p_payload         => jsonb_build_object(
      'requester_person_id', p_requester_person_id,
      'location_id',          p_location_id,
      'source',               p_source,
      'expected_services',    p_expected_services_count
    ),
    p_idempotency_key => 'booking.create_attempted:' || v_booking_id::text,
    p_available_at    => now() + interval '30 seconds'   -- §7 lease window
  );
end if;
```

Booking row + outbox row commit atomically. If `outbox.emit` raises (e.g. payload-hash collision), the booking insert rolls back. When `p_expected_services_count = 0` no lease is emitted (no service attach phase = no failure window to cover), so TS doesn't have to mark-consume.

**From a row-lifecycle trigger** — for events that are purely "this row reached state X." Mechanism retained but not used for compensation (§7 explains why compensation needs a watchdog-driven RPC emit, not a trigger).

### 3.2 TypeScript `OutboxService` — fire-and-forget emit + lease consumption

```typescript
// apps/api/src/modules/outbox/outbox.service.ts
@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);
  constructor(private readonly supabase: SupabaseService) {}

  /** Fire-and-forget emit. NOT transactional. Failures logged, never thrown.
   *  Use only where post-commit best-effort is acceptable (notifications etc). */
  async emit(input: OutboxEventInput): Promise<void> {
    try {
      const { error } = await this.supabase.admin.rpc('outbox_emit_via_rpc', {
        p_tenant_id:       input.tenantId,
        p_event_type:      input.eventType,
        p_aggregate_type:  input.aggregateType,
        p_aggregate_id:    input.aggregateId,
        p_payload:         input.payload ?? {},
        p_idempotency_key: `${input.eventType}:${input.aggregateId}:${input.operationId}`,
        p_event_version:   input.eventVersion ?? 1,
      });
      if (error) this.log.error(`outbox emit failed (${input.eventType}): ${error.message}`);
    } catch (err) {
      this.log.error(`outbox emit threw (${input.eventType}): ${(err as Error).message}`);
    }
  }

  /** Marks a lease event consumed. Throws on RPC error — the success path NEEDS this
   *  to succeed or the watchdog fires a false-positive in 30s. */
  async markConsumed(input: { tenantId: string; idempotencyKey: string; reason: string }): Promise<boolean> {
    const { data, error } = await this.supabase.admin.rpc('outbox_mark_consumed_via_rpc', {
      p_tenant_id: input.tenantId, p_idempotency_key: input.idempotencyKey, p_reason: input.reason,
    });
    if (error) throw error;
    return Boolean(data);
  }
}

export interface OutboxEventInput {
  tenantId: string; eventType: string; aggregateType: string; aggregateId: string;
  payload?: Record<string, unknown>;
  /** Required. No anonymous fire-and-forget. */
  operationId: string;
  eventVersion?: number;
}
```

---

## 4. Consumer / Worker

### 4.1 Drain query (C2)

```typescript
// Step 2 of drainOnce — claim a batch atomically.
const claimToken = randomUUID();
const claimed = await this.db.query<{ id: string; event_type: string; tenant_id: string }>(
  `with cte as (
     select id from outbox.events
      where processed_at is null
        and dead_lettered_at is null
        and claim_token is null
        and available_at <= now()
        and attempts < $3
      order by available_at, enqueued_at
      limit $1
      for update skip locked
   )
   update outbox.events o
      set claim_token = $2, claimed_at = now()
     from cte
    where o.id = cte.id
    returning o.id, o.event_type, o.tenant_id`,
  [this.batchSize, claimToken, this.maxAttempts],
);
```

**Index alignment**: the drain filter is `processed_at is null and dead_lettered_at is null and claim_token is null and available_at <= now()`, ordered by `(available_at, enqueued_at)`. The new `idx_outbox_events_drainable` covers that exactly.

### 4.2 Worker state machine (I1 fold)

Every claimed event passes through exactly one of four transitions; the worker MUST implement all four and nothing else. Each transition is its own SQL update, and each guards by `claim_token = $2` so a stale-claim sweep racing the handler can't double-write.

**(1) Success** — handler returned cleanly:
```sql
update outbox.events
   set processed_at = now(), processed_reason = 'handler_ok',
       claim_token = null, last_error = null, attempts = attempts + 1
 where id = $1 and claim_token = $2;
```
`attempts` IS incremented on success (a clean first run is `attempts = 1` when read). `processed_reason='handler_ok' AND attempts > 1` is the "succeeded after retries" observability cohort.

**(2) Retry** — handler threw a transient error and `attempts + 1 < max`:
```sql
update outbox.events
   set claim_token = null, last_error = $3, attempts = attempts + 1,
       available_at = now() + $4::interval   -- backoff per §4.4
 where id = $1 and claim_token = $2;
```

**(3) Dead-letter** — handler threw and `attempts + 1 >= max`, OR handler threw `DeadLetterError`. Single transaction: copy to `outbox.events_dead_letter`, set `dead_lettered_at` on the live row so the drain index excludes it. The live row stays visible so admin tooling has a single SELECT path; the DL table is for archival + alert hooks.
```sql
begin;
  insert into outbox.events_dead_letter
    (id, tenant_id, event_type, event_version, aggregate_type, aggregate_id,
     payload, payload_hash, idempotency_key, enqueued_at, attempts,
     last_error, dead_lettered_at, dead_letter_reason)
  select id, tenant_id, event_type, event_version, aggregate_type, aggregate_id,
         payload, payload_hash, idempotency_key, enqueued_at, attempts + 1,
         $3, now(), $4   -- 'max_attempts' | 'dead_letter_error' | 'tenant_not_found' | 'no_handler_registered'
    from outbox.events where id = $1;
  update outbox.events
     set claim_token = null, attempts = attempts + 1, last_error = $3, dead_lettered_at = now()
   where id = $1 and claim_token = $2;
commit;
```

**(4) Stale-claim recovery** — separate `@Cron(EVERY_MINUTE)` job; does NOT increment `attempts` (the v2 I2 fold; v3 keeps it):
```sql
update outbox.events
   set claim_token = null, claimed_at = null
 where claimed_at < now() - interval '5 minutes'
   and processed_at is null and dead_lettered_at is null;
```

Rationale for `attempts` only moving on observed handler outcomes: a worker crash between claim and handler call would otherwise burn five `attempts` of pure infrastructure flakiness and dead-letter the row without any handler ever running.

### 4.3 Tenant context wrapping (C4 + N2 fold)

Handlers run via `supabase.admin` (service role, bypasses RLS) — the worker is not request-scoped and crosses tenants every drain. **Tenant context is the explicit defense, not RLS.**

v2 used a placeholder. v3 loads real tenant info via a 30s TTL cache:

```typescript
const tenant = await this.tenantCache.get(event.tenant_id);
if (!tenant) {
  await this.deadLetter(event, 'tenant_not_found');
  this.metrics.tenantNotFoundTotal.inc({ event_type: event.event_type });
  return;
}
await TenantContext.run({ id: tenant.id, slug: tenant.slug, tier: tenant.tier }, () => handler.handle(event));
```

`tenantCache`: 30s TTL `Map<tenantId, Tenant | null>`. Positive hit returns tenant; negative hit re-fetches (don't trust a 30s-old "deleted" verdict); miss runs `select id, slug, tier from public.tenants where id = $1` and caches positive-or-null. Tenant hard-deletes are rare; 30s bounds staleness; worker isn't request-latency-sensitive.

### 4.4 Backoff schedule

Exponential with jitter, capped:

| `attempts` | Base delay | With jitter | Realized window |
|---:|---:|---|---|
| 1 | 30s | ±10s | 20s – 40s |
| 2 | 2m | ±20s | 1m40 – 2m20 |
| 3 | 10m | ±90s | 8m30 – 11m30 |
| 4 | 1h | ±10m | 50m – 1h10m |
| 5 | dead-letter | — | — |

The base delay table is configurable via env (`OUTBOX_BACKOFF_MS`); the table above is the default. Implementation: pick the array element by `attempts - 1`, apply jitter, set `available_at = now() + interval '$delay milliseconds'`.

### 4.5 Cross-tenant smuggling defense (C5)

v1 §9.5 claimed RLS would catch it. That's wrong: handlers run as service role. v3 keeps v2's structural defense — handlers MUST explicitly load the aggregate row, assert `aggregate.tenant_id === event.tenant_id`, and dead-letter on mismatch via `DeadLetterError`. The worker recognises `DeadLetterError` and goes straight to the §4.2.3 transition with `dead_letter_reason = 'dead_letter_error'`. Tenant mismatch is not a transient error.

---

## 5. Cutover order — compensation FIRST, in shadow mode (with real comparison contract — I4 fold)

v1 ordered the cutover "easiest first" (notifications → compensation). v2 corrected the order (compensation first). v3 keeps the order and adds a hard contract for the shadow window.

### 5.1 Three-deploy cutover for booking-compensation

**Phase A — Shadow + comparison (deploy 1)**: lease emit ships in `create_booking()`. `BookingCreateAttemptedHandler` ships in shadow mode — loads + asserts + writes a `outbox_shadow_results` row instead of mutating. Inline `runWithCompensation` (`booking-transaction-boundary.ts:78-160`) keeps doing the actual rollback. **Gate to B**: `select count(*) from outbox_shadow_results where matched = false and recorded_at > now() - interval '7 days'` returns 0.

**Phase B — Activate handler (deploy 2)**: handler flips from shadow to active. Mutation is `delete_booking_with_guard` (same RPC the inline path calls), so it's idempotent. Inline path keeps running but its happy path now also calls `outbox.mark_consumed`. Crash-path is now genuinely covered: lease expires → handler claims → deletes the booking. **Gate to C**: 30 days of zero `outbox_dead_letter_total{event_type="booking.create_attempted"}` and zero `outbox_shadow_results.matched=false`.

**Phase C — Remove inline path (deploy 3)**: `runWithCompensation`'s try/catch becomes: call `delete_booking_with_guard` synchronously, mark lease consumed on success. Synchronous path stays for happy-path latency; watchdog is the crash-recovery. The `booking-transaction-boundary.ts:99-122` path (compensation RPC failure) simplifies — leave the lease open and rely on the watchdog retry.

### 5.2 The `outbox_shadow_results` table (the I4 fold)

The Phase A → Phase B gate needs an automatable verdict. v2 said "logs comparison for one week" — too vague. v3 names the contract.

```sql
create table if not exists public.outbox_shadow_results (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  event_type      text        not null,
  event_version   int         not null,
  aggregate_id    uuid        not null,
  outbox_event_id uuid        references outbox.events(id),

  -- What the existing inline path actually did (computed by the boundary).
  -- Shape: { kind: 'rolled_back'|'partial_failure'|'no_compensation_needed',
  --          booking_existed_before: bool,
  --          booking_existed_after: bool,
  --          blockers: string[],
  --          error_message: string | null }
  inline_outcome  jsonb       not null,

  -- What the shadow handler would have done (computed by the handler in dry-run).
  -- Same shape as inline_outcome.
  shadow_outcome  jsonb       not null,

  matched         boolean     not null,
  -- When matched=false: structured diff. Shape: { fields_diff: [{path, inline, shadow}], reason: string }.
  diff            jsonb,

  recorded_at     timestamptz not null default now()
);

create index if not exists idx_outbox_shadow_results_unmatched
  on public.outbox_shadow_results (recorded_at)
  where matched = false;

alter table public.outbox_shadow_results enable row level security;
drop policy if exists tenant_isolation on public.outbox_shadow_results;
create policy tenant_isolation on public.outbox_shadow_results
  using (tenant_id = public.current_tenant_id());
```

**Producer of shadow rows**: the boundary (`InProcessBookingTransactionBoundary`) is extended for the Phase A window so that on every compensation invocation it ALSO calls the shadow handler and writes the comparison. The shadow handler signature is `dryRun(event): Promise<ShadowOutcome>` — it never mutates.

**Gate query (CI / staging deploy-blocker)**:

```sql
-- Must return 0 to advance from Phase A to Phase B.
select count(*)
  from public.outbox_shadow_results
 where matched = false
   and recorded_at > now() - interval '7 days';
```

Hooked into the CI pipeline as a staging-environment gate; production-deploy of Phase B requires this query to be 0 and 7-day window must include genuine traffic (we eyeball staging dashboards — automated traffic-volume floor TBD when we have a staging traffic-shaping rig).

**Why a table, not just logs**: logs lose structure, get sampled, get rotated. A table gives us SQL queryability + retention + a deterministic deploy gate.

### 5.3 Other event types

The other six event types (sla_timer, setup_work_order, notification, escalation, booking.service_attached, booking.compensation_required-future) follow the same Phase A → B → C cadence but with their own shadow rows. Notifications and similar best-effort events can collapse Phase A (no inline path to compare against).

---

## 6. Event taxonomy — mechanism per event type

| Event type | Mechanism |
|---|---|
| `booking.create_attempted` | RPC helper inside `create_booking()` (00277:236-334) with 30s lease. Payload: `expected_services`, `requester_person_id`, `location_id`, `source`. Success-path TS calls `outbox.mark_consumed` after attach (or sync-compensation). Crash-path: watchdog reaps after lease expiry. §7. |
| `booking.compensation_required` | **DEPRECATED in v3.** v2 emitted from `delete_booking_with_guard`, but by then the boundary had already fired the RPC — the event was descriptive, not actionable. The lease subsumes this; the event type name is reserved (no future reuse). |
| `booking.service_attached` | Future `attach_services_to_booking()` RPC (currently `BundleService.attachServicesToBooking` is a supabase-js sequence). Until that exists, **not durable** — `bookings.services_attached_at` (§7.3) is the durable signal; `outbox.mark_consumed('booking.create_attempted:<id>')` is the success ack. |
| `setup_work_order.create_required` | RPC helper inside the future bundle-commit RPC; until then fire-and-forget. Staged after the watchdog cutover. |
| `sla_timer.create_required` | RPC helper inside the dispatch RPC (when dispatch becomes an RPC). |
| `notification.send_required` | Fire-and-forget. Best-effort by design — loss is bad UX, not corruption. |
| `escalation.fire_required` | RPC helper inside the `pg_cron`-scheduled SLA-check function that mutates `sla_timers.escalated_at`. |

**Why not a generic "every row change" firehose:** the RPC-helper entries carry payload context the row doesn't capture (input ids, original errors, computed plan deltas, expected service counts for lease verification). Generic CDC triggers would force handlers to re-derive context — possibly wrong, possibly racing subsequent updates. Domain events are intentional.

---

## 7. Watchdog/lease compensation pattern (the v3 fix)

### 7.1 The bug v2 didn't fix

v2 said: emit `booking.compensation_required` inside `delete_booking_with_guard()`, before the DELETE. Codex flagged correctly: this is **too late**. The orphan-booking failure mode happens AFTER service attach fails but BEFORE TS calls `delete_booking_with_guard()`. If the RPC emits and then deletes the booking, the worker later loads no booking → the handler is a no-op. The event is "compensation executed/audited," not "compensation required." The actual failure window — process death between attach-fail and the compensation call — is uncovered.

What we need is a signal the producer creates **before** the failure window opens, that the consumer evaluates **after** the failure window must have closed. A lease.

### 7.2 The lease pattern

`create_booking()` emits `booking.create_attempted` with `available_at = now() + 30s`. Three outcomes:

- **Success.** TS calls `attachServicesToBooking` → on success, calls `mark_services_attached` RPC which atomically sets `bookings.services_attached_at = now()` AND `outbox.mark_consumed(..., 'attached')`. Watchdog never fires.
- **Sync failure.** TS catches operation error → calls `delete_booking_with_guard` → on success calls `outbox.mark_consumed(..., 'compensated_sync')`. Watchdog never fires.
- **Crash.** TS dies between attach-fail and compensation. Booking row remains; `services_attached_at = NULL`; lease unconsumed. After 30s the worker claims the event. Handler:
  1. Load booking by `event.aggregate_id`; assert tenant matches (§4.5).
  2. Booking missing → mark consumed `'booking_already_gone'`. No-op.
  3. `services_attached_at IS NOT NULL` → success path attached but mark-consumed never landed; mark consumed `'recovery_attached'`. Idempotent.
  4. Otherwise → call `delete_booking_with_guard`. On success → mark consumed `'compensated_watchdog'`. On `partial_failure` (recurrence_series blocker per 00292:102-107) → dead-letter with `'partial_failure_blocker'` for manual resolution. On error → backoff per §4.4.

### 7.3 Schema decision: `bookings.services_attached_at`

**Option A (chosen)** — add `bookings.services_attached_at timestamptz`; watchdog checks `IS NULL`. Set by a new `mark_services_attached(p_booking_id, p_tenant_id)` RPC that updates the column AND calls `outbox.mark_consumed` in the same transaction.

**Option B (rejected)** — derive the signal from the `orders` table. No schema change but requires a join in the watchdog and the semantics drift: "an order exists" ≠ "service attach completed." Partial success (created an order but failed line items) would have `count(orders) > 0` and the watchdog would conclude "attach succeeded, no recovery needed" — exactly wrong. Fragile.

**Why A**: explicit, atomic with the success-path mark-consumed, cheap to query, semantically unambiguous. Cost: one column + one tiny RPC.

```sql
alter table public.bookings add column if not exists services_attached_at timestamptz;

create or replace function public.mark_services_attached(p_booking_id uuid, p_tenant_id uuid)
returns void language plpgsql security invoker as $$
declare v_tenant_id uuid;
begin
  v_tenant_id := coalesce(p_tenant_id, public.current_tenant_id());
  if v_tenant_id is null then raise exception 'mark_services_attached: tenant_id required'; end if;

  update public.bookings set services_attached_at = now()
   where id = p_booking_id and tenant_id = v_tenant_id;
  if not found then raise exception 'booking.not_found' using errcode = 'P0002'; end if;

  perform outbox.mark_consumed('booking.create_attempted:' || p_booking_id::text, v_tenant_id, 'attached');
end;
$$;
```

TS success path is a single RPC call. When the input has no services, `create_booking` skips the lease emit entirely (gated by `p_expected_services_count > 0`, see §3.1) so TS doesn't need to mark-consume.

### 7.4 Sequence summary

```
SUCCESS    TS: rpc(create_booking) → PG: INSERT booking + outbox.emit(lease, +30s) → returns booking_id
           TS: attachServicesToBooking() → ok
           TS: rpc(mark_services_attached) → PG: UPDATE bookings SET attached_at; outbox.mark_consumed
           Watchdog never fires (lease consumed before available_at).

SYNC FAIL  TS: attachServicesToBooking() → throws
           TS: rpc(delete_booking_with_guard) → PG: DELETE bookings (cascades)
           TS: rpc(mark_consumed, 'compensated_sync')
           Watchdog never fires.

CRASH      TS dies after attach-fail, before delete_booking_with_guard.
           Booking row remains; services_attached_at = NULL; lease unconsumed.
           After 30s: worker claims event → handler loads booking, sees attached_at IS NULL,
                      tenant matches → rpc(delete_booking_with_guard) → mark_consumed('compensated_watchdog').
```

### 7.5 Handler implementation

```typescript
// apps/api/src/modules/outbox/handlers/booking-create-attempted.handler.ts
@Injectable()
@OutboxHandler('booking.create_attempted', { version: 1 })
export class BookingCreateAttemptedHandler {
  constructor(private readonly supabase: SupabaseService, private readonly outbox: OutboxService) {}

  async handle(event: OutboxEventWithPayload<BookingCreateAttemptedPayload>): Promise<void> {
    const { data: booking, error } = await this.supabase.admin
      .from('bookings').select('id, tenant_id, services_attached_at')
      .eq('id', event.aggregate_id).maybeSingle();
    if (error) throw error;                                    // transient → retry

    if (!booking) {
      await this.consume(event, 'booking_already_gone');       // success path raced us
      return;
    }
    if (booking.tenant_id !== event.tenant_id) {
      throw new DeadLetterError(`tenant mismatch: event=${event.tenant_id} agg=${booking.tenant_id}`);
    }
    if (booking.services_attached_at !== null) {
      await this.consume(event, 'recovery_attached');          // attach succeeded; mark_consumed never landed
      return;
    }

    // Crash path — compensate.
    const { data: result, error: rpcErr } = await this.supabase.admin.rpc(
      'delete_booking_with_guard',
      { p_booking_id: event.aggregate_id, p_tenant_id: event.tenant_id },
    );
    if (rpcErr) throw rpcErr;
    if (result?.kind === 'partial_failure') {
      throw new DeadLetterError(`partial_failure: blocked_by=${(result.blocked_by ?? []).join(',')}`);
    }
    await this.consume(event, 'compensated_watchdog');
  }

  /** Phase A shadow mode: never mutates; produces an outbox_shadow_results row. */
  async dryRun(event: OutboxEventWithPayload<BookingCreateAttemptedPayload>): Promise<ShadowOutcome> { /* same loads, no mutations */ }

  private consume(event: OutboxEventWithPayload<unknown>, reason: string) {
    return this.outbox.markConsumed({ tenantId: event.tenant_id, idempotencyKey: event.idempotency_key, reason });
  }
}
```

---

## 8. Idempotency

### 8.1 Key format (per event type)

- `booking.create_attempted:<booking_id>` — one per booking, unique by construction.
- `sla_timer.create_required:<ticket_id>:<policy_id>:<timer_type>` — one per (ticket, policy, timer-kind) tuple.
- `setup_work_order.create_required:<line_item_id>` — one per line item.
- `notification.send_required:<recipient_id>:<event_id>` — one per (recipient, source-event) pair.

The format is documented per event type; the producer (RPC helper or trigger) constructs it deterministically. **No anonymous emits** — `outbox.emit` rejects null/empty `p_idempotency_key` (§2.3).

### 8.2 Handler idempotency contract

Every handler MUST be safe to invoke multiple times for the same event. Patterns:

1. **Aggregate state check** — load the aggregate; if it's already in the post-event state, return success. The watchdog handler does this (booking already deleted → success).
2. **Upsert** — `insert ... on conflict do nothing` keyed on a deterministic id derived from the event.
3. **Outbox dedup token in the side-effect** — when sending a Slack/email, include the event's outbox `id` as the message dedup token, so the recipient's inbound webhook can deduplicate even if our retry happens after their ACK.

Idempotency is not optional. The infrastructure delivers at-least-once; handlers convert that to effectively-once.

---

## 9. Handler registration — decorator-based (with N1 fold)

```typescript
// apps/api/src/modules/outbox/outbox-handler.decorator.ts
export const OUTBOX_HANDLER_META = Symbol('outbox.handler');
export function OutboxHandler(eventType: string, opts?: { version?: number }): ClassDecorator {
  return (target) => Reflect.defineMetadata(OUTBOX_HANDLER_META,
    { eventType, version: opts?.version ?? 1 }, target);
}

// apps/api/src/modules/outbox/outbox-handler.registry.ts
@Injectable()
export class OutboxHandlerRegistry implements OnModuleInit {
  private readonly handlers = new Map<string, OutboxHandler>();
  constructor(private readonly moduleRef: ModuleRef, private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    // N1 fold — DiscoveryService walks all registered providers; we pull metatype,
    // read our decorator metadata, resolve via ModuleRef. No central map → no merge-conflict hot spot.
    for (const wrapper of this.discovery.getProviders()) {
      if (!wrapper.metatype) continue;
      const meta = Reflect.getMetadata(OUTBOX_HANDLER_META, wrapper.metatype);
      if (!meta) continue;
      const instance = this.moduleRef.get(wrapper.metatype, { strict: false });
      if (instance) this.handlers.set(`${meta.eventType}@v${meta.version}`, instance);
    }
  }

  get(eventType: string, version: number) { return this.handlers.get(`${eventType}@v${version}`) ?? null; }
}

// apps/api/src/modules/outbox/outbox.module.ts
@Module({
  imports: [DiscoveryModule],   // N1 fold — required for getProviders()
  providers: [OutboxService, OutboxWorker, OutboxHandlerRegistry, BookingCreateAttemptedHandler /* …more */],
  exports: [OutboxService],
})
export class OutboxModule {}
```

---

## 10. Event versioning rollout — deployment-state, not commits (resolves §11 #6 + I5 fold)

v1 said "three commits in order." That conflated VCS state with deployment state. v3 is explicit: a schema change ships in **three deploys**, with **observable verification** between each.

### 10.1 The three-deploy procedure

1. **Deploy 1 — Register v2 alongside v1.** The new handler `@OutboxHandler('foo.bar', { version: 2 })` ships in code. Both registry entries (`foo.bar@v1` and `foo.bar@v2`) exist; both are wired to live handler instances. Producers still emit `version=1`.
   - **Verification before advancing**: every worker pod's startup log line `[OutboxHandlerRegistry] registered foo.bar@v1, foo.bar@v2` appears at least once in the deploy window. Concretely, the dashboard query is `SELECT pod_id, MAX(timestamp) FROM logs WHERE message LIKE 'registered foo.bar@v2%' GROUP BY pod_id` — must list every pod from `kubectl get pods -l app=outbox-worker`.

2. **Deploy 2 — Switch producers to emit v2.** The migration that changes the producer (RPC body, trigger, or fire-and-forget call site) ships. New events flow with `event_version = 2`. In-flight `v1` events still drain via `v1` handler.
   - **Verification before advancing**: monitor the histogram `select event_version, count(*) from outbox.events where enqueued_at > now() - interval '1 hour' group by event_version` — must show `version=2` only for new events for at least 24 hours.
   - **Drain query**: `select count(*) from outbox.events where event_version = 1 and processed_at is null and dead_lettered_at is null` — must reach 0 and stay 0 for 24 hours.

3. **Deploy 3 — Remove v1 handler from code.** Now safe; no v1 events are enqueued and no v1 events remain unprocessed.
   - **Verification post-deploy**: `select count(*) from outbox.events_dead_letter where event_type = 'foo.bar' and event_version = 1 and dead_lettered_at > <deploy-3-time>` — must remain 0. Any non-zero value means an in-flight v1 event was claimed AFTER deploy 3 and dead-lettered because no handler was registered. (We expect 0 due to the deploy-2 drain check; this is belt-and-braces.)

### 10.2 Rules carried over from v2

1. **Producers always emit at the schema version they were written for**.
2. **Handlers declare the exact version they handle** via `@OutboxHandler('foo.bar', { version: 2 })`.
3. **Mismatch → dead-letter**. If the worker dispatches event_type `X` at version 2 and no `X@v2` handler is registered, the row moves to dead-letter immediately with `dead_letter_reason = 'no_handler_registered'`. No silent skip, no fall-back to v1.
4. **Breaking-change discipline**: bump the version when removing/renaming a payload field, changing a field's type, or changing the meaning of a field. Adding an optional field is **not** a version bump.

---

## 11. Test infrastructure (acknowledges N3 + scope reality)

The audit-outbox subsystem has no integration tests today; v1's assumption that test-DB wiring already existed was wrong. Adding it is part of the Phase 6 implementation scope.

### 11.1 Unit tests — real jest patterns

Use `jest.Mocked<SupabaseService>` (not v1's invented `mock(SupabaseService)`); hand-roll the supabase-js fluent builder mock per test. Coverage matrix per handler: tenant-mismatch raises `DeadLetterError`, post-success state mark-consumed without compensation, missing-aggregate marks consumed (`booking_already_gone`), happy-path crash recovery calls `delete_booking_with_guard` then mark-consumed (`compensated_watchdog`), `partial_failure` returned by RPC raises `DeadLetterError` with reason. One spec file per handler at `apps/api/src/modules/outbox/handlers/__tests__/<name>.handler.spec.ts`.

### 11.2 Integration tests

A `pnpm test:integration` command spins up local Supabase, runs a NestJS testing module against it, tears down between tests. Phase 6 scope:

- `TestDbModule` — real connection to local Supabase, `truncate-and-reseed` helper.
- Worker integration test: drain a batch end-to-end across the four §4.2 transitions.
- Per-handler integration test against real schemas.
- Watchdog test: emit a lease with `available_at = now() + 1s`, sleep 2s, drain, assert booking deleted.
- Stress test: 1000 events, single drain, exactly-once processing + zero dead-letter.

If test-DB wiring slips, handler unit tests + the smoke-test gate (extended with a forced-compensation probe and a feature-flag-gated process-exit between attach-fail and compensation-call) carry the reliability load.

---

## 12. Observability

Carry forward the metrics + admin dashboard endpoints + logging from v1 §7. v3 additions:

- **Per-tenant emit/drain counters** — labels include `tenant_id`. Cardinality concern noted; Prometheus handles it for the tenant counts XPQT targets in Wave 1.
- **Tenant-mismatch counter** — `outbox_dead_letter_tenant_mismatch_total{event_type}`. Any non-zero value is a P0 (cross-tenant smuggling attempt or producer bug).
- **`outbox_dead_letter_total{event_type, reason}`** — labels include the §4.2.3 reason (`max_attempts | dead_letter_error | tenant_not_found | partial_failure_blocker | no_handler_registered`).
- **`outbox_lease_recovery_total{event_type, recovery_reason}`** — counts watchdog-fired recoveries by reason (`compensated_watchdog | recovery_attached | booking_already_gone`). The `compensated_watchdog` count is the most important signal — every increment = a request that crashed mid-flight and was recovered durably. Should be 0–10/day in steady state; an order-of-magnitude jump means upstream instability (process crashes).
- **`outbox_shadow_unmatched_total{event_type}`** — drives the §5.2 cutover gate. Stays at 0 in Phase A; gate refuses Phase B otherwise.

---

## 13. Failure modes

Carry forward v1 §9 with corrections:

- §9.5 (tenant isolation) replaced by §4.5 above. RLS is not a defense at handler dispatch.
- §9.2 (transactional emit) reframed: there is no TS-side transactional emit. The corresponding case is "RPC body emits → if `outbox.emit` raises, the entire RPC rolls back, including the business write." That's the real Postgres semantics.

### 13.1 Purge cadence (I3 — kept from v2)

A separate `@Cron(CronExpression.EVERY_HOUR)` method on the worker runs `purgeProcessed` regardless of drain state. Cheap, narrow, decoupled. The "purge when idle" branch in v1's drain method goes away.

### 13.2 The "watchdog races the success path" failure mode (new in v3)

Lease is 30s; success path normally <1s. If `attachServicesToBooking` is degenerately slow (>30s) the watchdog can claim the event before the success path completes. Two cases:

1. **Watchdog claims but hasn't run RPC yet.** Success path's `mark_consumed` UPDATE filters on `processed_at IS NULL` (not `claim_token`), so it succeeds. Watchdog then loads the booking, sees `services_attached_at` is now set, takes the `recovery_attached` branch — no double-effect.
2. **Watchdog already ran `delete_booking_with_guard`.** Booking gone. Success path's `mark_services_attached` raises `booking.not_found`; TS surfaces 500 to the user; orphaned services (if any) are FK-NULL'd per the delete-with-guard cascades. Operator alert via the dead-letter audit. Post-mortem is straightforward (DL row + the `mark_services_attached` log line point at the affected booking). Mitigation: 30s lease is generous; widen if we see this happen.

---

## 14. File locations

### Schema
- `supabase/migrations/00XXX_domain_outbox.sql` — `outbox.events`, `outbox.events_dead_letter`, `outbox_shadow_results`, `outbox.emit()` + `outbox.mark_consumed()` helpers, `outbox_emit_via_rpc` + `outbox_mark_consumed_via_rpc` PostgREST wrappers, GRANTs (§2.6).
- `supabase/migrations/00XXX_bookings_services_attached_at.sql` — adds `bookings.services_attached_at` + `mark_services_attached` RPC (§7.3).
- `supabase/migrations/00XXX_create_booking_emits_lease.sql` — REPLACEs `create_booking` (00277) to add `outbox.emit` for `booking.create_attempted` with 30s lease + `p_expected_services_count` parameter.

### TypeScript
- `apps/api/src/modules/outbox/outbox.service.ts` — fire-and-forget producer + `markConsumed` helper.
- `apps/api/src/modules/outbox/outbox.worker.ts` — drain loop with the §4.2 state machine. Model: `audit-outbox.worker.ts:20-166`. Includes per-event `TenantContext.run` wrapping (C4) with the §4.3 tenant cache.
- `apps/api/src/modules/outbox/outbox-handler.registry.ts` — decorator-driven registry.
- `apps/api/src/modules/outbox/outbox-handler.decorator.ts` — `@OutboxHandler(eventType, { version })`.
- `apps/api/src/modules/outbox/dead-letter.error.ts` — `DeadLetterError` sentinel.
- `apps/api/src/modules/outbox/handlers/booking-create-attempted.handler.ts` — the watchdog handler that subsumes v2's `BookingCompensationHandler`.

### Existing references
- Audit outbox service: `apps/api/src/modules/privacy-compliance/audit-outbox.service.ts:1-103`.
- Audit outbox worker: `apps/api/src/modules/privacy-compliance/audit-outbox.worker.ts:20-166`.
- Compensation today: `apps/api/src/modules/reservations/booking-transaction-boundary.ts:78-160`.
- Tenant context: `apps/api/src/common/tenant-context.ts:1-29`.
- `create_booking` RPC: `supabase/migrations/00277_create_canonical_booking_schema.sql:236-334`.
- `delete_booking_with_guard` RPC: `supabase/migrations/00292_delete_booking_with_guard_rpc.sql:54-141`.
- Booking-flow producer: `apps/api/src/modules/reservations/booking-flow.service.ts:224-454` (the call site that emits the lease + consumes it).

---

## 15. Success criteria

Phase 6 is complete when:

1. v3's three migrations applied to remote Supabase + `notify pgrst, 'reload schema'`.
2. `OutboxService` + `OutboxWorker` (§4.2 state machine) + decorator registry implemented + unit-tested.
3. `BookingCreateAttemptedHandler` Phase A burn-in: 7 days, zero `outbox_shadow_results.matched=false`.
4. Compensation cutover Phase A→B→C without incident; `outbox_lease_recovery_total{recovery_reason="compensated_watchdog"} > 0` in staging via a forced-crash probe.
5. Other six event types ship in shadow-first cadence (§5.3).
6. Tenant-mismatch counter zero for 30+ days post-cutover.
7. `pnpm smoke:work-orders` extended with forced-compensation + forced-crash (process-exit between attach-fail and compensation-call) probes and passing.

---

## 16. Open questions remaining (post-v3)

Not blocking implementation; revisit before Phase 7 hardening.

1. **Per-tenant fairness** (still open post-v3) — sharded per-tenant worker vs today's FIFO drain. The optional `idx_outbox_events_per_tenant_pending` index supports it. Defer until a noisy-neighbor incident or a tenant >100x median emit rate.
2. **Cross-region replication** (still open) — probably "worker in primary DB region; cross-region events catch up in seconds." Confirm before we ship a multi-region tenant.
3. **Webhook delivery via outbox** (still open) — likely yes with a dedicated `webhook.deliver_required` event type; revisit in the webhook hardening sprint.
4. **`outbox_emit_via_rpc` / `outbox_mark_consumed_via_rpc` vs direct exposure** (still open; v3 doubled the wrapper count) — re-evaluate once we have ≥2 TS-side call sites in production.

New post-v3:

5. **Lease window tuning** — 30s is a 50× headroom over measured ~600ms p50. Tune after a month of staging metrics.
6. **`outbox_shadow_results` retention** — needs a daily purge job; fold into the GDPR retention catalog when cutover lands.
7. **`mark_services_attached` race with watchdog** (§13.2) — frequency unknown; widen lease if non-zero.

---

## Document version

- v3 — 2026-05-04. Status: DESIGN (not implemented; investigation + spec only). Replaces v2 (commit `b38db4a`).
- Next step: Phase 6 implementation — start with schema migrations (§14) + `outbox.emit` + `outbox.mark_consumed` + `bookings.services_attached_at` + `BookingCreateAttemptedHandler` in shadow mode.
