# Domain Outbox Design Specification — Plan B.1 (v4)

> **Authored:** 2026-05-04
> **Phase:** 6 (Durable Infrastructure)
> **Scope:** Investigation + Design only. No implementation code beyond this spec.

---

## Revision history

- **v1** (commit `f5b96c5`, superseded): proposed a TS-side `OutboxService.emitTx(client)` claiming to share a transaction with the business write. Foundational mismatch — `BookingFlowService.create` calls `supabase.admin.rpc('create_booking', ...)`, which is a PostgREST HTTP call on its own PgBouncer-pooled connection, not the API process's `pg.PoolClient`. No shared transaction exists; v1's atomicity claim was unsatisfiable. v1 also used a global idempotency unique key (cross-tenant collision), led the drain index with `tenant_id` while the worker filters globally, claimed RLS would catch cross-tenant smuggling at handler dispatch (service role bypasses RLS), and ordered the cutover "easiest first" (compensation last) — exactly inverse of the risk profile.
- **v2** (commit `b38db4a`, superseded): moved atomicity into Postgres. Producers emit via row triggers or via an `outbox.emit(...)` SQL helper called from inside an RPC, in the same transaction as the business write. TS-side `OutboxService.emit()` reframed as fire-and-forget. Folded 5 criticals + 5 importants from v1.
- **v3** (commit `83f3ba0`, superseded): introduced a watchdog/lease pattern with a 30s destructive timeout. `create_booking()` emitted `booking.create_attempted` with a 30s lease; the success path consumed the lease via `outbox.mark_consumed`; the crash path was recovered by a watchdog handler that fired after the lease expired. Also: explicit 4-transition worker state machine, SQL grants, payload-hash collision detector on `outbox.emit`, automated shadow-comparison contract, three-deploy event-version rollout. Codex flagged a known false-compensation path: a slow attach (>30s) gets falsely compensated by the watchdog, then `mark_services_attached` throws and the user sees a 500. The "watchdog races success path" failure mode (v3 §13.2) was acknowledged but not eliminated.
- **v4** (this revision): replaced the watchdog destructive-lease pattern with **A-prime atomic attach**. TS keeps the rule resolver / approval routing / asset-lookup logic as a *plan-building* preflight (it's complex, not pure SQL, lives naturally in TS). The WRITE phase becomes one Postgres transaction via `attach_services_to_booking(p_plan jsonb)` — the booking row is locked while attach runs, every plan FK is tenant-validated, and `outbox.mark_consumed` runs in the same tx as the orders/OLIs/approvals/asset-reservation inserts. `delete_booking_with_guard` was amended to **lock + re-check** (`already_gone` / `already_attached` outcomes); a slow attach can no longer be falsely deleted because the watchdog waits on the booking lock. Compensation contract gains `already_gone` + `already_attached` outcomes (C2 fold). Phase A → Phase B gate now requires ≥10 samples + zero mismatches over 7 days **plus** a forced lease-expiry probe in CI/staging (I2 fold). Lease window is 5 minutes by default, configurable via env. The "watchdog races success path" failure mode is now structurally impossible.

---

## 1. Architectural rule (NON-NEGOTIABLE)

> **Atomic outbox events MUST be created inside Postgres, in the same transaction as the business write.**
> **State changes that an outbox event represents MUST also be made in the same transaction (no split write).**

The first half (event + write atomic) was settled in v2/v3. The second half is new in v4 and is the headline correction: a "split write" — TS does part of the work, then asks Postgres to mark it done — is the failure pattern v3's destructive lease tried (and failed) to paper over. v4 collapses the split.

Two acceptable mechanisms:

1. **Row-lifecycle triggers** — `AFTER INSERT`/`AFTER UPDATE` on a domain table emits when the event truly is "this row reached state X." Same transaction as the writing statement.
2. **`outbox.emit(...)` helper called from inside an RPC** — when the payload carries semantic content the row alone doesn't capture (input ids, computed payloads, idempotency tokens, lease windows). SECURITY INVOKER PL/pgSQL function called from inside another PL/pgSQL function (e.g. `create_booking`, `attach_services_to_booking`) that is itself running in a Postgres transaction.

**Excluded**: a TS-side `emitTx(client, ...)` pretending to share a transaction with a PostgREST RPC (the `pg.PoolClient` the API holds is on a different connection from PostgREST's; there is no shared transaction); generic per-table CDC firehose triggers (domain events are intentional, the payload is designed for the consumer); split writes where TS performs side-effects and Postgres only stamps a "done" flag at the end.

**TS-side `OutboxService.emit()`** survives only as a fire-and-forget post-commit helper for best-effort operations (notifications, webhook delivery hints). Never the path for compensation, SLA timer creation, or anything where loss of the event corrupts state.

---

## 2. Schema

### 2.1 `outbox.events`

Single table with `event_type` discriminator. Mirrors the `audit_outbox` pattern (migration `00161_gdpr_audit_outbox.sql:12-50`) but with idempotency, backoff, dead-letter, event versioning, and lease-payload integrity bolted on.

```sql
-- supabase/migrations/00299_outbox_foundation.sql

create table if not exists outbox.events (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,

  -- Classification
  event_type          text        not null,                       -- 'booking.create_attempted', etc.
  event_version       int         not null default 1,             -- §10
  aggregate_type      text        not null,                       -- 'booking', 'work_order', 'sla_timer'
  aggregate_id        uuid        not null,

  payload             jsonb       not null default '{}'::jsonb,
  payload_hash        text        not null,                       -- ON CONFLICT verifier (§2.3)

  -- Idempotency: tenant-scoped (§2.4)
  idempotency_key     text        not null,

  -- Processing state
  enqueued_at         timestamptz not null default now(),
  available_at        timestamptz not null default now(),         -- watchdog/lease (§7.2)
  processed_at        timestamptz,
  processed_reason    text,                                        -- 'attached'|'rolled_back'|'consumed'|'handler_ok'|...
  claim_token         uuid,
  claimed_at          timestamptz,
  attempts            int         not null default 0,
  last_error          text,
  dead_lettered_at    timestamptz,

  constraint outbox_events_attempts_nonneg check (attempts >= 0),
  constraint outbox_events_idem_unique unique (tenant_id, idempotency_key)
);

create index if not exists idx_outbox_events_drainable
  on outbox.events (available_at, enqueued_at)
  where processed_at is null and claim_token is null and dead_lettered_at is null;

create index if not exists idx_outbox_events_per_tenant_pending
  on outbox.events (tenant_id, available_at)
  where processed_at is null;

create index if not exists idx_outbox_events_stale_claim
  on outbox.events (claimed_at)
  where processed_at is null and claimed_at is not null;

create index if not exists idx_outbox_events_processed
  on outbox.events (processed_at)
  where processed_at is not null;

alter table outbox.events enable row level security;

drop policy if exists tenant_isolation on outbox.events;
create policy tenant_isolation on outbox.events
  using (tenant_id = public.current_tenant_id());

comment on column outbox.events.available_at is
  'Lease/backoff. The worker only claims rows where available_at <= now(). Watchdog events set this OUTBOX_LEASE_SECONDS in the future (default 300s = 5min); the success-path mark_consumed runs in the same Postgres transaction as the attach work, so a slow attach can no longer race the watchdog.';
```

### 2.2 `outbox.events_dead_letter`

Same shape as v3 (separate table, write-once, narrow main table). Carry forward v3's definition. Dead-lettering is implemented via a same-transaction copy + flag-set (see §4.2.3); the row stays visible in `outbox.events` (with `dead_lettered_at` set so the drain index excludes it) so admin tooling has a single SELECT path.

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

  insert into outbox.events
    (tenant_id, event_type, event_version, aggregate_type, aggregate_id,
     payload, payload_hash, idempotency_key, available_at)
  values
    (p_tenant_id, p_event_type, p_event_version, p_aggregate_type, p_aggregate_id,
     v_payload, v_hash, p_idempotency_key, coalesce(p_available_at, now()))
  on conflict (tenant_id, idempotency_key) do update
     set payload_hash = excluded.payload_hash
   where outbox.events.event_type     = excluded.event_type
     and outbox.events.event_version  = excluded.event_version
     and outbox.events.aggregate_type = excluded.aggregate_type
     and outbox.events.aggregate_id   = excluded.aggregate_id
     and outbox.events.payload_hash   = excluded.payload_hash
  returning id into v_id;

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

### 2.4 Tenant-scoped idempotency

`unique (tenant_id, idempotency_key)`. Cross-tenant emits with the same logical key are independent. Within a tenant, idempotency works as before — but with the payload-hash verifier, same-key/different-payload is no longer silent (§2.3).

### 2.5 The `outbox.mark_consumed(...)` helper (lease consumption)

The watchdog/lease pattern (§7) needs a primitive for the success path to say "I succeeded; don't fire the watchdog." In v4 this is called from **inside** the `attach_services_to_booking` RPC body — never from TS — so the consume runs in the same transaction as the order/OLI/approval inserts.

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
```

The TS-side `outbox_mark_consumed_via_rpc` PostgREST wrapper is **kept in v4 only as the watchdog handler's primitive** for the rare reach-around case where the handler observes `services_attached_at IS NOT NULL` (success commit raced with lease expiry — possible only if the attach RPC took longer than the lease window) and needs to consume the lease without re-running the attach. In every steady-state success path, mark-consume happens inside the attach RPC and TS never calls it.

### 2.6 SQL grants

`outbox.events` is reachable only via the helper functions; no role (including `authenticated`) gets direct DML except the worker (`service_role` only). Per the v3 codex follow-up (migration `00301_outbox_emit_revoke_authenticated.sql`), `EXECUTE` on `outbox.emit` and `outbox.mark_consumed` is service_role-only; `authenticated` cannot reach the table or the helpers. v4 keeps that posture and adds a grant for the new `attach_services_to_booking` RPC (service_role only — TS calls it via `supabase.admin`).

```sql
-- supabase/migrations/00299_outbox_foundation.sql (excerpt — unchanged from v3)
revoke all on schema outbox from public;
grant  usage on schema outbox to service_role, authenticated;
grant  execute on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz) to service_role;
grant  execute on function outbox.mark_consumed(text, uuid, text) to service_role;
revoke all on table outbox.events from public;
grant  select, update on table outbox.events to service_role;

-- supabase/migrations/00301_outbox_emit_revoke_authenticated.sql (unchanged)
revoke execute on function outbox.emit(uuid, text, text, uuid, jsonb, text, int, timestamptz) from authenticated;
revoke execute on function outbox.mark_consumed(text, uuid, text) from authenticated;

-- new in v4 — see §X
grant  execute on function public.attach_services_to_booking(jsonb, uuid, uuid, text) to service_role;
```

`outbox.events_dead_letter` and `outbox_shadow_results` get the same grants pattern (service_role read+update; nothing for authenticated).

---

## 3. Producer API

### 3.1 Transactional emit — from RPCs and triggers

**From `create_booking()` (00277:236-334)** — emits `booking.create_attempted` immediately before `return query`, atomic with the booking + slot inserts:

```sql
-- Migration REPLACEs create_booking. Existing params unchanged; adds two:
--   p_expected_services_count int default 0
--   p_emit_create_lease       boolean default true
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
    p_available_at    => now() + (current_setting('outbox.lease_seconds', true)::int * interval '1 second')
  );
end if;
```

`current_setting('outbox.lease_seconds', true)::int` — the lease window is now configurable via Postgres GUC, defaulting to 300 (5 min). Configured at session level by the API (see §7.6 for the env wiring) or at database level via `ALTER DATABASE postgres SET outbox.lease_seconds = 300`.

**From `attach_services_to_booking()` (new in v4, §X)** — at the end of the RPC body, after the orders/OLIs/asset_reservations/approvals are committed and `bookings.services_attached_at = now()` is set:

```sql
perform outbox.mark_consumed(
  'booking.create_attempted:' || p_booking_id::text,
  p_tenant_id,
  'attached'
);
```

The mark-consume happens in the same transaction as every other row insert. If any insert fails, the entire RPC rolls back — the attach didn't happen, the lease stays unconsumed, the watchdog will (correctly) fire after lease expiry to clean up the orphan booking.

**From a row-lifecycle trigger** — for events that are purely "this row reached state X." Mechanism retained but not used for compensation (the lease consumed inside the attach RPC subsumes that need).

### 3.2 TypeScript `OutboxService` — fire-and-forget emit only

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
}
```

`OutboxService.markConsumed` is **removed in v4**. The only legitimate caller — the watchdog handler's reach-around for `services_attached_at IS NOT NULL` — now goes through a tiny `BookingCompensationService.markAttachedRecovery(bookingId)` helper that's scoped to that single use case.

---

## 4. Consumer / Worker

### 4.1 Drain query (unchanged from v3)

```typescript
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

### 4.2 Worker state machine (unchanged from v3)

Every claimed event passes through exactly one of four transitions; the worker MUST implement all four and nothing else. Each transition is its own SQL update, and each guards by `claim_token = $2` so a stale-claim sweep racing the handler can't double-write.

**(1) Success / (2) Retry / (3) Dead-letter / (4) Stale-claim recovery** — same SQL as v3 §4.2. Carry forward unchanged.

Rationale for `attempts` only moving on observed handler outcomes: a worker crash between claim and handler call would otherwise burn five `attempts` of pure infrastructure flakiness and dead-letter the row without any handler ever running.

### 4.3 Tenant context wrapping (unchanged from v3)

Handlers run via `supabase.admin` (service role, bypasses RLS) — the worker is not request-scoped and crosses tenants every drain. Tenant context is the explicit defense, not RLS. 30s TTL cache in `tenantCache`; positive-or-null cache; miss → `select id, slug, tier from public.tenants where id = $1`.

### 4.4 Backoff schedule (unchanged from v3)

Exponential with jitter, capped:

| `attempts` | Base delay | With jitter | Realized window |
|---:|---:|---|---|
| 1 | 30s | ±10s | 20s – 40s |
| 2 | 2m | ±20s | 1m40 – 2m20 |
| 3 | 10m | ±90s | 8m30 – 11m30 |
| 4 | 1h | ±10m | 50m – 1h10m |
| 5 | dead-letter | — | — |

### 4.5 Cross-tenant smuggling defense (unchanged from v3)

Handlers MUST explicitly load the aggregate row, assert `aggregate.tenant_id === event.tenant_id`, and dead-letter on mismatch via `DeadLetterError`. Tenant mismatch is not a transient error.

---

## 5. Cutover order — compensation FIRST, in shadow mode (with the I2 fold)

v3 ordered the cutover compensation-first and added a shadow-comparison contract. v4 keeps the order and tightens the gate.

### 5.1 Three-deploy cutover for booking-compensation

**Phase A — Shadow + comparison (deploy 1)**: lease emit ships in `create_booking()`. `attach_services_to_booking` RPC ships and is wired in TS (replacing the supabase-js sequence in `BundleService.attachServicesToBooking`). `BookingCreateAttemptedHandler` ships in shadow mode — loads + asserts + writes a `outbox_shadow_results` row instead of mutating. Inline `runWithCompensation` (`booking-transaction-boundary.ts:78-160`) keeps doing the actual rollback. **Gate to B**: see §5.2.

**Phase B — Activate handler (deploy 2)**: handler flips from shadow to active. Mutation is `delete_booking_with_guard` (the v4-amended RPC, same call shape; see §7.5 for outcome mapping). Inline path keeps running. Crash-path is now genuinely covered: lease expires → handler claims → calls `delete_booking_with_guard`, which locks the booking and re-checks `services_attached_at` before deleting. **Gate to C**: 30 days of zero `outbox_dead_letter_total{event_type="booking.create_attempted"}` and zero `outbox_shadow_results.matched=false`.

**Phase C — Remove inline path (deploy 3)**: `runWithCompensation`'s try/catch becomes: call `delete_booking_with_guard` synchronously on operation failure, rely on the locked re-check to disambiguate `rolled_back` / `already_gone` / `already_attached`. Watchdog is the crash-recovery; synchronous path stays for happy-path latency. The `booking-transaction-boundary.ts:99-122` path (compensation RPC failure) simplifies — leave the lease open and rely on the watchdog retry.

### 5.2 The Phase A → Phase B gate (the I2 fold)

v3 said "matched=false count = 0 over 7 days." That's necessary but insufficient — a 7-day window with one shadow row and matched=true would also pass, vacuously. v4 requires **two SQL conditions plus a forced lease-expiry probe**:

```sql
-- Both must be true to advance from Phase A to Phase B:

-- 1. Minimum sample count over 7 days
select count(*) >= 10
  from public.outbox_shadow_results
 where event_type = 'booking.create_attempted'
   and recorded_at > now() - interval '7 days';

-- 2. Zero mismatches over the same window
select count(*) = 0
  from public.outbox_shadow_results
 where event_type = 'booking.create_attempted'
   and recorded_at > now() - interval '7 days'
   and matched = false;
```

PLUS a **forced lease-expiry probe** that runs in CI/staging before each cutover deploy:

- Test scenario: simulate attach failure mid-flight by killing the TS process *before* the attach RPC commits (the natural way to do this is a feature-flag-gated `process.exit(1)` injected between the booking insert and the attach RPC call).
- Wait `OUTBOX_LEASE_SECONDS + 60`.
- Assert the watchdog handler fires and compensation succeeds (`rolled_back` outcome).
- Assert the booking row is gone.

The probe runs on every staging deploy and is a hard deploy gate — the cutover does not advance until the probe passes. Documented as part of the `pnpm smoke:work-orders` extension scope (success criteria §15.7).

The `outbox_shadow_results` table itself is unchanged from v3 §5.2; the only change is the gate query.

### 5.3 Other event types

Same Phase A → B → C cadence with their own shadow rows. Notifications and similar best-effort events can collapse Phase A (no inline path to compare against).

---

## 6. Event taxonomy — mechanism per event type

| Event type | Mechanism |
|---|---|
| `booking.create_attempted` | RPC helper inside `create_booking()` (00277:236-334) with configurable lease (default 5 min). Payload: `expected_services`, `requester_person_id`, `location_id`, `source`. Lease is consumed inside `attach_services_to_booking()` RPC — same Postgres tx as the orders/OLIs/approvals/asset_reservations inserts. Crash-path: watchdog reaps after lease expiry, calls `delete_booking_with_guard` which locks + re-checks. §7. |
| `booking.compensation_required` | DEPRECATED (v3 reservation kept). Subsumed by the lease + atomic attach. Event type name reserved (no future reuse). |
| `booking.service_attached` | Future (post-v4) — emit from inside `attach_services_to_booking()` RPC body for downstream subscribers (notifications, calendar sync). Until subscribers exist: the `outbox.mark_consumed('booking.create_attempted:<id>', 'attached')` is the success ack. |
| `setup_work_order.create_required` | RPC helper inside the future bundle-commit RPC; until then fire-and-forget. Staged after v4 cutover. |
| `sla_timer.create_required` | RPC helper inside the dispatch RPC (when dispatch becomes an RPC). |
| `notification.send_required` | Fire-and-forget. Best-effort by design — loss is bad UX, not corruption. |
| `escalation.fire_required` | RPC helper inside the `pg_cron`-scheduled SLA-check function that mutates `sla_timers.escalated_at`. |

**Why not a generic "every row change" firehose:** the RPC-helper entries carry payload context the row doesn't capture (input ids, original errors, computed plan deltas, expected service counts for lease verification). Generic CDC triggers would force handlers to re-derive context — possibly wrong, possibly racing subsequent updates. Domain events are intentional.

---

## 7. Watchdog/lease compensation pattern (the v4 fix)

### 7.1 The bug v3 didn't fix

v3 said: emit `booking.create_attempted` with a 30s lease; success path calls `mark_services_attached` from TS to atomically set `services_attached_at` AND `outbox.mark_consumed(..., 'attached')`. Codex flagged correctly: this is **a split write**. The window between "TS finishes the supabase-js attach sequence" and "TS calls `mark_services_attached`" is a real failure window. If TS dies in that window (rare but possible), the booking has fully attached services but the lease is unconsumed. After 30s the watchdog fires, sees `services_attached_at IS NULL` (because `mark_services_attached` never ran), and deletes the booking.

Worse: if `attachServicesToBooking` is degenerately slow (>30s — possible during high contention or large attach plans), the watchdog can fire **while** the success path is mid-flight. The success path's eventual `mark_services_attached` raises `booking.not_found`; the user sees a 500 even though the system was "working."

v3 §13.2 acknowledged this and said "30s lease is generous; widen if we see this happen." That's not a fix; it's hoping the race never trips.

### 7.2 The v4 fix — A-prime atomic attach

The attach phase becomes **one Postgres transaction** that locks the booking, validates the plan, writes every row, sets `services_attached_at`, and consumes the lease — all-or-nothing. The split is gone, not papered over. TS still does the complex preflight (rule resolver, approval routing, asset existence checks, cost calculations) — there's no value in porting that logic to PL/pgSQL — but TS produces a *plan*, not a sequence of writes.

```
PREFLIGHT (TS):
  BundleService.buildAttachPlan(input) →
    - resolve service rules (ServiceRuleResolverService.resolveBulk)
    - assemble approvals (ApprovalRoutingService.assemble — but in plan mode,
      no DB writes; produces the approver-id list with merged scope)
    - hydrate lines (catalog/menu lookups, lead-time calc, vendor/team)
    - look up asset existence + tenant ownership (single query for all asset_ids)
    - compute order totals + per-line line_totals
    - returns AttachPlan jsonb (see §X)

WRITE (Postgres, one transaction):
  attach_services_to_booking(p_plan jsonb, p_booking_id uuid,
                             p_tenant_id uuid, p_idempotency_key text) →
    1. SELECT 1 FROM bookings WHERE id=p_booking_id AND tenant_id=p_tenant_id FOR UPDATE
       (locks the booking; serialises against any concurrent
        delete_booking_with_guard call)
    2. Validate every FK in p_plan against tenant_id (see §X.3)
    3. INSERT orders (one per service_type group)
    4. INSERT asset_reservations (GiST exclusion fires here on conflict)
    5. INSERT order_line_items (with linked_asset_reservation_id stamped)
    6. INSERT approvals (deduped by approver_person_id; pre-merged in plan)
    7. UPDATE orders SET status = 'submitted'|'approved' (per any_pending)
    8. UPDATE bookings SET services_attached_at = now() WHERE id = p_booking_id
    9. PERFORM outbox.mark_consumed(
         'booking.create_attempted:' || p_booking_id::text,
         p_tenant_id, 'attached')
    Returns: { order_ids: [...], oli_ids: [...], asset_reservation_ids: [...],
               approval_ids: [...], any_pending_approval: bool }

POST-COMMIT (TS, same call site):
  - If RPC threw (FK validation failure, GiST conflict, etc.):
      → re-throw to runWithCompensation, which calls delete_booking_with_guard
        (which re-checks; sees services_attached_at IS NULL; deletes)
  - If RPC succeeded:
      → fire setup-work-order triggers in parallel (best-effort, post-commit;
        same posture as today's bundle.service.ts:375-456)
      → emit audit row 'bundle.created' (same as today)
```

### 7.3 The locked delete re-check

`delete_booking_with_guard` is amended to lock + re-check. The new return-shape adds two outcomes:

```sql
create or replace function public.delete_booking_with_guard(
  p_booking_id uuid,
  p_tenant_id  uuid default null
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_tenant_id  uuid;
  v_attached   timestamptz;
  v_has_series boolean;
begin
  v_tenant_id := coalesce(p_tenant_id, public.current_tenant_id());
  if v_tenant_id is null then
    raise exception 'delete_booking_with_guard: tenant_id required (none in JWT, none passed)';
  end if;

  -- Lock + re-check. The FOR UPDATE blocks until any in-flight
  -- attach_services_to_booking commits or rolls back.
  select services_attached_at
    into v_attached
    from public.bookings
   where id = p_booking_id
     and tenant_id = v_tenant_id
   for update;

  if not found then
    return jsonb_build_object('kind', 'already_gone');
  end if;

  if v_attached is not null then
    -- Attach landed before us. Don't delete; the watchdog handler will
    -- mark the lease consumed via the recovery path (§7.5).
    return jsonb_build_object('kind', 'already_attached');
  end if;

  -- Recurrence series blocker (unchanged from 00292)
  select exists (
    select 1 from public.recurrence_series
     where parent_booking_id = p_booking_id and tenant_id = v_tenant_id
  ) into v_has_series;
  if v_has_series then
    return jsonb_build_object(
      'kind', 'partial_failure',
      'blocked_by', jsonb_build_array('recurrence_series')
    );
  end if;

  -- Same delete + cascades as 00292:135-137
  delete from public.bookings
   where id = p_booking_id and tenant_id = v_tenant_id;

  return jsonb_build_object('kind', 'rolled_back');
end;
$$;
```

The 00292 `'P0002' booking.not_found` raise becomes a `'already_gone'` return. Callers (TS boundary, watchdog handler) get a structured outcome, never an exception, in the missing-row case. The boundary's catch-on-exception path now only fires for genuine RPC errors (network, server-side bug).

### 7.4 Sequence summary

```
SUCCESS    TS: rpc(create_booking) → PG: INSERT booking + outbox.emit(lease, +5min)
                                      → returns booking_id
           TS: BundleService.buildAttachPlan(input) → AttachPlan jsonb
           TS: rpc(attach_services_to_booking, p_plan, ...) → PG (one tx):
                LOCK booking → validate → INSERT orders/OLIs/asset_res/approvals
                → UPDATE bookings.services_attached_at → outbox.mark_consumed
           TS: receives { order_ids, ..., any_pending_approval }
           TS: triggerMany(setupWorkOrders) (post-commit, best-effort)
           Watchdog never fires (lease consumed inside the same tx as attach).

SYNC FAIL  TS: rpc(attach_services_to_booking) throws (FK validation, GiST,
                catalog_item_not_found, service_rule_deny — all raise inside
                the RPC; entire RPC rolls back)
           TS: catches → runWithCompensation calls delete_booking_with_guard
           PG: FOR UPDATE lock acquired (no in-flight attach to wait for —
               the failed RPC already rolled back). services_attached_at
               IS NULL → delete cascades → returns 'rolled_back'
           TS: re-throws original error to user. Watchdog never fires.

CRASH      TS dies after rpc(create_booking) returns, before
           rpc(attach_services_to_booking) is called (or while it's in flight,
           but on the TS process side — Postgres rolls the RPC back).
           Booking row remains; services_attached_at = NULL; lease unconsumed.
           After OUTBOX_LEASE_SECONDS: worker claims event → handler:
              - Calls delete_booking_with_guard
              - PG: FOR UPDATE lock waits for any in-flight attach RPC.
                If one was in flight and is still running, watchdog blocks
                until it commits (success path) or rolls back (failed path).
                After lock: re-checks services_attached_at.
                  - NULL  → delete → 'rolled_back'
                  - SET   → 'already_attached'
                  - row missing → 'already_gone' (e.g. another watchdog drained it)
              - Handler maps outcome → mark_consumed + log; no double-effect.

SLOW       TS: rpc(attach_services_to_booking) runs >5min for whatever reason
ATTACH        (huge plan, contention, slow disk).
              Watchdog claims the lease event in the meantime and calls
              delete_booking_with_guard. The FOR UPDATE BLOCKS waiting for
              the attach RPC's transaction to commit or roll back.
              When the attach RPC commits successfully, the watchdog's lock
              acquire returns; it sees services_attached_at IS NOT NULL and
              returns 'already_attached'. Handler maps to mark_consumed-only
              (no delete). User sees success, watchdog sees no-op, no race.
              (If the attach RPC rolls back instead, the watchdog sees NULL
              and proceeds with the delete — correct behavior.)
```

The "watchdog races success path" failure mode in v3 §13.2 is now structurally impossible.

### 7.5 Handler implementation

```typescript
// apps/api/src/modules/outbox/handlers/booking-create-attempted.handler.ts
@Injectable()
@OutboxHandler('booking.create_attempted', { version: 1 })
export class BookingCreateAttemptedHandler {
  constructor(
    private readonly compensation: BookingCompensationService,
    private readonly log = new Logger(BookingCreateAttemptedHandler.name),
  ) {}

  async handle(event: OutboxEventWithPayload<BookingCreateAttemptedPayload>): Promise<void> {
    // Tenant assertion is pre-handler (§4.5 + the worker's tenantCache).
    // The compensation service does its own internal aggregate-tenant check
    // via the RPC's p_tenant_id parameter (the RPC raises if mismatched).
    const outcome = await this.compensation.deleteBooking(event.aggregate_id);

    switch (outcome.kind) {
      case 'rolled_back':
        // Booking was orphaned, watchdog cleaned up. The mark_consumed
        // happens implicitly: delete_booking_with_guard's CASCADE wipes
        // the booking row, but the outbox event itself is a separate
        // tenant-scoped row. We mark it consumed explicitly so the
        // worker's success transition runs.
        this.log.warn(
          `compensated_watchdog booking=${event.aggregate_id} tenant=${event.tenant_id}`,
        );
        return;
      case 'already_gone':
        // Booking already deleted (another watchdog raced us; or a Phase B/C
        // synchronous boundary call beat us; or the booking was hand-deleted
        // by an admin). Idempotent success.
        this.log.log(
          `already_gone booking=${event.aggregate_id} tenant=${event.tenant_id}`,
        );
        return;
      case 'already_attached':
        // Attach landed (services_attached_at IS NOT NULL) but the lease
        // somehow wasn't consumed inside the attach RPC — should be
        // structurally impossible in v4 since mark_consumed runs inside the
        // same tx. If this fires, there's a bug; log a warning and consume
        // the lease so the row doesn't churn forever.
        this.log.warn(
          `already_attached_via_watchdog booking=${event.aggregate_id} ` +
          `tenant=${event.tenant_id} — lease should have been consumed inside attach RPC`,
        );
        await this.compensation.markAttachedRecovery(event);
        return;
      case 'partial_failure':
        // Recurrence series exists; manual op needed. Dead-letter.
        throw new DeadLetterError(
          `partial_failure: blocked_by=${outcome.blockedBy.join(',')}`,
        );
    }
  }

  /** Phase A shadow mode: never mutates; produces an outbox_shadow_results row. */
  async dryRun(event: OutboxEventWithPayload<BookingCreateAttemptedPayload>): Promise<ShadowOutcome> {
    /* same loads, no mutations; produces a parallel outcome the boundary compares */
  }
}
```

### 7.6 Lease window configuration

```typescript
// apps/api/src/modules/outbox/outbox.config.ts
export const OUTBOX_LEASE_SECONDS = parseInt(
  process.env.OUTBOX_LEASE_SECONDS ?? '300', 10,
);
```

The API sets `outbox.lease_seconds` as a session GUC on every request that calls `create_booking`:

```typescript
// On the supabase admin client, before rpc('create_booking', ...):
await this.supabase.admin.rpc('set_config', {
  setting: 'outbox.lease_seconds',
  value: String(OUTBOX_LEASE_SECONDS),
  is_local: true,  // session-scoped to the connection, reset on next checkout
});
```

Default 300s = 5 min. Tunable in CI/staging tests for the forced lease-expiry probe (set to 5s for the probe, 300s in production).

### 7.7 Why we don't port the resolver / routing logic to SQL

A reviewer might ask: if everything else is in PL/pgSQL, why keep `ServiceRuleResolverService` and `ApprovalRoutingService` in TS?

- The rule resolver evaluates a tree of service rules against a context object with ~30 fields (line, requester, bundle, order, permissions). Half the predicates are TS-only library calls (date math, tz arithmetic, JSON path resolution). Porting is a multi-week project and would create two implementations to keep in sync.
- Approval routing's `derived` expressions (`cost_center.default_approver`, future `requester.manager`) are a small DSL. The TS impl is ~20 lines per expression. Future expressions that need DB-driven lookups can be added as small functions called by the SQL plan-applier — but the orchestration stays in TS.

The key invariant is that TS produces a *plan* that the RPC can validate and apply atomically. TS reads the world; Postgres writes it. The split between read-only preflight and atomic write is honest and clean.

---

## X. Atomic attach RPC contract

The new RPC. Migration `00XXX_attach_services_to_booking_rpc.sql`.

### X.1 Function signature

```sql
create or replace function public.attach_services_to_booking(
  p_plan            jsonb,           -- the AttachPlan (§X.2)
  p_booking_id      uuid,            -- the booking to attach to
  p_tenant_id       uuid,            -- caller-supplied (service-role pattern)
  p_idempotency_key text             -- = 'booking.create_attempted:' || p_booking_id::text
) returns jsonb
language plpgsql security invoker set search_path = public, outbox as $$
-- ...body in §X.4 below
$$;
```

Returns:

```jsonb
{
  "order_ids": [...],
  "order_line_item_ids": [...],
  "asset_reservation_ids": [...],
  "approval_ids": [...],
  "any_pending_approval": false
}
```

Raises:
- `'P0002' booking.not_found` if `p_booking_id` doesn't exist in `p_tenant_id`.
- `'42501' tenant_mismatch` if any plan FK references a row in another tenant.
- `'23505'` (unique violation) on idempotency-key replay where the plan differs.
- `'23P01'` (exclusion violation) on asset GiST conflict — surfaced unchanged.
- `service_rule_deny` (custom errcode `42P10` family) when the plan's `effect` is `deny` for any line.

### X.2 The `AttachPlan` jsonb shape

The plan is a serialized projection of what the existing `BundleService.attachServicesToBooking` (bundle.service.ts:164-494) writes. Surveyed top-to-bottom from line 191 (`orderIds: string[]` accumulator) through line 472 (audit row):

```typescript
// Conceptual TypeScript shape; serialized as jsonb for the RPC.
interface AttachPlan {
  // Top-level meta
  version: 1;                                   // bump on shape change
  any_pending_approval: boolean;                // pre-computed from outcomes
  any_deny: boolean;                            // if true, RPC raises before any insert
  deny_messages: string[];                      // joined for the error payload

  // Orders — one per service_type group (bundle.service.ts:213-220)
  orders: Array<{
    id: string;                                 // uuid; pre-generated in TS so plan can self-reference
    service_type: string;                       // catalog_menus.service_type
    requester_person_id: string;                // = bundle args.requester_person_id
    delivery_location_id: string;               // = booking.space_id (== booking.location_id)
    delivery_date: string;                      // booking.start_at.slice(0, 10)
    requested_for_start_at: string;             // = booking.start_at
    requested_for_end_at: string;               // = booking.end_at
    initial_status: 'submitted' | 'approved';   // computed from any_pending_approval
    policy_snapshot: { service_type: string };  // bundle.service.ts:1246
  }>;

  // Asset reservations — one per line that has a linked_asset_id
  // (bundle.service.ts:228-238)
  asset_reservations: Array<{
    id: string;                                 // uuid; pre-generated
    asset_id: string;                           // tenant-validated in TS preflight
    start_at: string;                           // line.service_window_start_at
    end_at: string;                             // line.service_window_end_at
    requester_person_id: string;
    booking_id: string;                         // = p_booking_id
    status: 'confirmed';                        // bundle.service.ts:1323
  }>;

  // Order line items (bundle.service.ts:1254-1289)
  order_line_items: Array<{
    id: string;                                 // uuid; pre-generated
    order_id: string;                           // FK into plan.orders[].id
    catalog_item_id: string;
    quantity: number;
    unit_price: number | null;
    line_total: number | null;                  // unit_price * quantity (or null)
    fulfillment_status: 'ordered';
    fulfillment_team_id: string | null;
    vendor_id: string | null;                   // = line.fulfillment_vendor_id
    menu_item_id: string | null;
    linked_asset_id: string | null;
    linked_asset_reservation_id: string | null; // FK into plan.asset_reservations[].id
    service_window_start_at: string;
    service_window_end_at: string;
    repeats_with_series: boolean;
    pending_setup_trigger_args: object | null;  // persisted when any_pending_approval
                                                // (bundle.service.ts:418-441)
    policy_snapshot: {
      menu_id: string | null;
      menu_item_id: string | null;
      unit: 'per_item' | 'per_person' | 'flat_rate' | null;
      service_type: string;
    };
  }>;

  // Approvals — pre-deduped by ApprovalRoutingService.assemble in plan mode
  // (approval-routing.service.ts:96-136). One row per (approver_person_id)
  // with merged scope_breakdown.
  approvals: Array<{
    target_entity_type: 'booking';              // canonicalised; 00278:172
    target_entity_id: string;                   // = p_booking_id
    approver_person_id: string;
    scope_breakdown: {
      reservation_ids: string[];                // legacy field name; values are booking ids
      order_ids: string[];
      order_line_item_ids: string[];
      ticket_ids: string[];
      asset_reservation_ids: string[];
      reasons: Array<{ rule_id: string; denial_message: string | null }>;
    };
    status: 'pending';
  }>;

  // Audit row meta — for the bundle.created event_type (bundle.service.ts:464-472)
  bundle_audit_payload: {
    bundle_id: string;                          // = p_booking_id
    booking_id: string;                         // = p_booking_id
    order_ids: string[];                        // mirrors plan.orders[].id
    order_line_item_ids: string[];              // mirrors plan.order_line_items[].id
    asset_reservation_ids: string[];            // mirrors plan.asset_reservations[].id
    approval_ids: string[];                     // mirrors plan.approvals[].target_entity_id
    any_pending_approval: boolean;
  };
}
```

UUIDs for orders, asset_reservations, OLIs, and approvals are **pre-generated in TS via `crypto.randomUUID()`** so the plan can self-reference (`order_line_items[].order_id` → `orders[].id`). The RPC trusts the TS-generated UUIDs and inserts them verbatim. This is safe because UUIDv4 collisions are practically impossible and the inserts run inside one transaction (a duplicate would surface as a 23505 and roll the whole RPC back).

The `any_deny` short-circuit: if the TS preflight saw any line with `effect = 'deny'`, the plan is built with `any_deny: true` + `deny_messages: [...]`. The RPC's first action after the booking lock is to check `p_plan->>'any_deny'` and raise — *before* any insert. The deny path in today's `BundleService.attachServicesToBooking:351-361` becomes a no-write deny inside the RPC.

### X.3 Tenant validation inside the RPC

Every plan FK is validated against `p_tenant_id` before any insert. Single-statement form using `array` aggregation + `EXCEPT`:

```sql
-- Catalog items
perform 1 from (
  select unnest(array(
    select (li->>'catalog_item_id')::uuid
      from jsonb_array_elements(p_plan->'order_line_items') as li
  )) as id
) plan_ids
except
select id from public.catalog_items where tenant_id = p_tenant_id;
if found then
  raise exception 'tenant_mismatch: catalog_item' using errcode = '42501';
end if;
```

Same pattern for: `assets` (validated against `asset_reservations[].asset_id`), `menu_items` (against `order_line_items[].menu_item_id`), `cost_centers` (if used), `persons` (against `approvals[].approver_person_id`). Six queries total; all run before the inserts.

Why this matters: the existing supabase-js sequence does ad-hoc `.eq('tenant_id', tenant.id)` filters on each lookup (e.g. `bundle.service.ts:1302-1314` for assets). The plan can't rely on those filters because TS already did the lookups in preflight; without an explicit RPC-side check, a malicious or buggy preflight could pass a foreign-tenant id into the plan. CLAUDE.md #0 demands the gate at every layer.

### X.4 RPC body (annotated skeleton)

```sql
create or replace function public.attach_services_to_booking(
  p_plan            jsonb,
  p_booking_id      uuid,
  p_tenant_id       uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql security invoker set search_path = public, outbox as $$
declare
  v_lease_consumed boolean;
begin
  if p_tenant_id is null then
    raise exception 'attach_services_to_booking: p_tenant_id required';
  end if;

  -- 1. Lock the booking. Serialises against any concurrent
  --    delete_booking_with_guard call (which also takes FOR UPDATE).
  perform 1 from public.bookings
   where id = p_booking_id and tenant_id = p_tenant_id
   for update;
  if not found then
    raise exception 'booking.not_found' using errcode = 'P0002';
  end if;

  -- 2. Short-circuit deny.
  if (p_plan->>'any_deny')::boolean then
    raise exception 'service_rule_deny: %',
      coalesce(p_plan->'deny_messages'->>0, 'A service rule denied this booking.')
      using errcode = '42P10';
  end if;

  -- 3. Tenant-validate every FK in the plan (§X.3).
  -- ...validation queries here, six total...

  -- 4. Insert orders.
  insert into public.orders (id, tenant_id, requester_person_id, booking_id,
                             linked_slot_id, delivery_location_id, delivery_date,
                             requested_for_start_at, requested_for_end_at,
                             status, policy_snapshot)
  select
    (o->>'id')::uuid, p_tenant_id, (o->>'requester_person_id')::uuid, p_booking_id,
    null, (o->>'delivery_location_id')::uuid, (o->>'delivery_date')::date,
    (o->>'requested_for_start_at')::timestamptz, (o->>'requested_for_end_at')::timestamptz,
    (o->>'initial_status')::text, (o->'policy_snapshot')::jsonb
  from jsonb_array_elements(p_plan->'orders') as o;

  -- 5. Insert asset_reservations. GiST exclusion fires here on conflict.
  insert into public.asset_reservations (id, tenant_id, asset_id, start_at, end_at,
                                          status, requester_person_id, booking_id)
  select
    (a->>'id')::uuid, p_tenant_id, (a->>'asset_id')::uuid,
    (a->>'start_at')::timestamptz, (a->>'end_at')::timestamptz,
    (a->>'status')::text, (a->>'requester_person_id')::uuid, p_booking_id
  from jsonb_array_elements(p_plan->'asset_reservations') as a;

  -- 6. Insert order_line_items.
  -- ...similar pattern, with linked_asset_reservation_id resolved from plan FK...

  -- 7. Insert approvals.
  -- ...similar pattern, scope_breakdown stored as jsonb...

  -- 8. Update bookings.services_attached_at.
  update public.bookings
     set services_attached_at = now()
   where id = p_booking_id and tenant_id = p_tenant_id;

  -- 9. Consume the lease. Same tx as everything above.
  perform outbox.mark_consumed(p_idempotency_key, p_tenant_id, 'attached')
    into v_lease_consumed;
  -- v_lease_consumed = false is acceptable: it means create_booking emitted
  -- with p_expected_services_count = 0 (no lease), or a previous attach
  -- already consumed. Either way the attach is correct; we only need to
  -- guarantee mark_consumed RAN inside this tx.

  return jsonb_build_object(
    'order_ids',              (select coalesce(jsonb_agg(o->'id'), '[]'::jsonb) from jsonb_array_elements(p_plan->'orders') o),
    'order_line_item_ids',    (select coalesce(jsonb_agg(li->'id'), '[]'::jsonb) from jsonb_array_elements(p_plan->'order_line_items') li),
    'asset_reservation_ids',  (select coalesce(jsonb_agg(a->'id'), '[]'::jsonb) from jsonb_array_elements(p_plan->'asset_reservations') a),
    'approval_ids',           (select coalesce(jsonb_agg(ap->'target_entity_id'), '[]'::jsonb) from jsonb_array_elements(p_plan->'approvals') ap),
    'any_pending_approval',   (p_plan->>'any_pending_approval')::boolean
  );
end;
$$;
```

The function is SECURITY INVOKER. RLS still applies for any caller that isn't the service role; matches `create_booking` (00277:262). The service-role admin client (the only production caller) bypasses RLS but is constrained by `p_tenant_id` matching on every read/write inside.

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

1. **Aggregate state check** — load the aggregate; if it's already in the post-event state, return success. The watchdog handler does this via `delete_booking_with_guard`'s lock+re-check.
2. **Upsert** — `insert ... on conflict do nothing` keyed on a deterministic id derived from the event.
3. **Outbox dedup token in the side-effect** — when sending a Slack/email, include the event's outbox `id` as the message dedup token, so the recipient's inbound webhook can deduplicate even if our retry happens after their ACK.

Idempotency is not optional. The infrastructure delivers at-least-once; handlers convert that to effectively-once.

### 8.3 Plan idempotency on replay

If `attach_services_to_booking` is called twice with the same `p_idempotency_key` (e.g. a TS retry), the second call's tenant-validation passes, the orders/OLIs/asset_reservations inserts hit primary-key conflicts on the pre-generated UUIDs (23505), and the entire tx rolls back. The caller sees a 23505 and treats it as "already done" — the lease is already consumed by the first call's `mark_consumed`. This is acceptable because TS retries are guarded upstream by `runWithCompensation` (a true retry would re-build the plan with fresh UUIDs anyway). If we ever need true plan-level idempotency, add a `select services_attached_at from bookings ... for update` short-circuit at the top of the RPC — but YAGNI for v4.

---

## 9. Handler registration — decorator-based (unchanged from v3)

Same `@OutboxHandler` decorator + `OutboxHandlerRegistry` walking `DiscoveryService.getProviders()`. Carry forward unchanged from v3 §9.

---

## 10. Event versioning rollout — three deploys (unchanged from v3)

Same three-deploy cadence with observable verification queries between each. Carry forward unchanged from v3 §10.

---

## 11. Test infrastructure (unchanged scope; one addition)

Carry forward v3 §11. v4 adds:

- **Forced lease-expiry probe** (§5.2 above) — staging deploy gate. Implementation: a new `pnpm smoke:lease-recovery` script that:
  1. Sets `OUTBOX_LEASE_SECONDS=5` in the test env.
  2. Triggers `BookingFlowService.create` with a feature-flag injection that `process.exit(1)`s between `create_booking` and `attach_services_to_booking`.
  3. Polls `outbox.events` until `processed_reason='handler_ok'` for the lease event (timeout 30s).
  4. Asserts the booking row is gone.
  5. Exit 0 on success, 1 on timeout/wrong-state.

Hooked into the staging CI gate; not run on every PR (slow + needs a clean DB), but mandatory before each Phase A → B and Phase B → C deploy.

- **Atomic-attach RPC tests** — at least one integration test per row-type that the RPC inserts. Phase 6 scope.

---

## 12. Observability

Carry forward v3 §12. v4 changes:

- **`outbox_lease_recovery_total{event_type, recovery_reason}`** — labels: `compensated_watchdog | already_attached_via_watchdog | already_gone | partial_failure_blocker`. The `compensated_watchdog` count is the most important signal — every increment = a request that crashed mid-flight and was recovered durably. Should be 0–10/day in steady state. `already_attached_via_watchdog` should be 0 in steady state (it indicates a bug: the lease was emitted but `mark_consumed` didn't run inside the attach RPC). Any non-zero value triggers a P1.
- **`outbox_attach_rpc_duration_ms`** histogram — bucket histogram of `attach_services_to_booking` latency. The p99 bound informs lease window sizing. If p99 climbs above 60s sustained, raise the lease window.

---

## 13. Failure modes

Carry forward v3 §13.1 (purge cadence, unchanged). v4 deletes v3 §13.2 entirely:

### 13.1 Purge cadence (unchanged)

A separate `@Cron(CronExpression.EVERY_HOUR)` method on the worker runs `purgeProcessed` regardless of drain state. Cheap, narrow, decoupled.

### 13.2 The "watchdog races success path" failure mode (v3) — eliminated in v4

v3 §13.2 documented two race outcomes when the watchdog fired during a slow attach. Both are now structurally impossible:

- The success path's `mark_consumed` is no longer a separate TS call; it runs inside the attach RPC's transaction. The watchdog's `delete_booking_with_guard` takes `FOR UPDATE` on the same booking row, so it cannot proceed concurrently with the attach RPC. Either:
  - Watchdog acquires the lock first → re-checks `services_attached_at` → it's NULL (attach hasn't started or rolled back) → deletes. The attach RPC's eventual `FOR UPDATE` then sees `booking.not_found` and rolls back (with no work done — every insert is inside the locked tx). Correct.
  - Attach RPC acquires the lock first → completes (commits or rolls back) → watchdog's `FOR UPDATE` returns → re-checks see `services_attached_at IS NOT NULL` (success) → returns `already_attached`; or NULL (failure) → deletes. Correct.

The lock+re-check is the structural guarantee. v4's lease window can be 5 min, 30 min, or 1 hour — the race is gone regardless. We chose 5 min as the default to bound user-visible latency for a recovery-path 500 (the user's request crashed; they retry; the retry fails because the booking still exists; they wait 5 min and try again).

---

## 14. File locations

### Schema
- `supabase/migrations/00299_outbox_foundation.sql` — `outbox.events`, `outbox.events_dead_letter`, `outbox.emit()` + `outbox.mark_consumed()` helpers, `outbox_emit_via_rpc` + `outbox_mark_consumed_via_rpc` PostgREST wrappers, GRANTs (§2.6). **Already applied** as of v3 ship.
- `supabase/migrations/00300_outbox_shadow_results_fk_set_null.sql` — `outbox_shadow_results` table. **Already applied**.
- `supabase/migrations/00301_outbox_emit_revoke_authenticated.sql` — codex v3 follow-up. **Already applied**.
- `supabase/migrations/00302_bookings_services_attached_at.sql` — adds `bookings.services_attached_at` (no `mark_services_attached` RPC; the attach RPC handles it inline). **NEW in v4**.
- `supabase/migrations/00303_create_booking_emits_lease.sql` — REPLACEs `create_booking` (00277) to add `outbox.emit` for `booking.create_attempted` with configurable lease + `p_expected_services_count` parameter. **NEW in v4**.
- `supabase/migrations/00304_attach_services_to_booking_rpc.sql` — the new RPC (§X). **NEW in v4**.
- `supabase/migrations/00305_delete_booking_with_guard_lock_recheck.sql` — REPLACEs `delete_booking_with_guard` (00292) with the v4 lock+re-check version (§7.3). **NEW in v4**.

### TypeScript
- `apps/api/src/modules/outbox/outbox.service.ts` — fire-and-forget producer only. (`markConsumed` removed from the public surface.)
- `apps/api/src/modules/outbox/outbox.worker.ts` — drain loop with the §4.2 state machine.
- `apps/api/src/modules/outbox/outbox-handler.registry.ts` — decorator-driven registry.
- `apps/api/src/modules/outbox/outbox-handler.decorator.ts` — `@OutboxHandler(eventType, { version })`.
- `apps/api/src/modules/outbox/dead-letter.error.ts` — `DeadLetterError` sentinel.
- `apps/api/src/modules/outbox/handlers/booking-create-attempted.handler.ts` — the watchdog handler (§7.5).
- `apps/api/src/modules/booking-bundles/bundle.service.ts` — `attachServicesToBooking` becomes:
  - `buildAttachPlan(args)` — pure preflight; returns `AttachPlan`.
  - `attachServicesToBooking(args)` — calls `buildAttachPlan`, then `supabase.admin.rpc('attach_services_to_booking', { p_plan, p_booking_id, p_tenant_id, p_idempotency_key })`.
- `apps/api/src/modules/orders/approval-routing.service.ts` — gains a `assemblePlan(args)` method that returns the same shape as `assemble(args)` but does NOT write to `approvals` (the RPC does).
- `apps/api/src/modules/reservations/booking-compensation.service.ts` — outcome union expands per §C2 fold (`already_gone`, `already_attached`); add `markAttachedRecovery(event)` for the §7.5 reach-around case.

### Existing references
- Audit outbox service: `apps/api/src/modules/privacy-compliance/audit-outbox.service.ts:1-103`.
- Audit outbox worker: `apps/api/src/modules/privacy-compliance/audit-outbox.worker.ts:20-166`.
- Compensation today: `apps/api/src/modules/reservations/booking-transaction-boundary.ts:78-160`.
- Tenant context: `apps/api/src/common/tenant-context.ts:1-29`.
- `create_booking` RPC: `supabase/migrations/00277_create_canonical_booking_schema.sql:236-334`.
- `delete_booking_with_guard` RPC (current — pre-v4 amend): `supabase/migrations/00292_delete_booking_with_guard_rpc.sql:54-141`.
- Booking-flow producer: `apps/api/src/modules/reservations/booking-flow.service.ts:224-454`.
- BundleService attach today: `apps/api/src/modules/booking-bundles/bundle.service.ts:164-494`.
- BundleService Cleanup helper today: `apps/api/src/modules/booking-bundles/bundle.service.ts:1878-1972` (deleted in v4 — atomic RPC subsumes it).

---

## 15. Success criteria

Phase 6 is complete when:

1. v4's four NEW migrations (00302, 00303, 00304, 00305) applied to remote Supabase + `notify pgrst, 'reload schema'`.
2. `OutboxService` (emit-only) + `OutboxWorker` (§4.2 state machine) + decorator registry implemented + unit-tested.
3. `BundleService.buildAttachPlan` unit-tested against the survey of existing `attachServicesToBooking` writes (every row type covered).
4. `attach_services_to_booking` RPC integration-tested for: happy path, FK validation failure (catalog/asset/menu/cost_center/person), GiST asset conflict, deny short-circuit, tenant mismatch.
5. `delete_booking_with_guard` (v4) integration-tested for: `rolled_back`, `already_gone`, `already_attached`, `partial_failure` outcomes.
6. `BookingCreateAttemptedHandler` Phase A burn-in: 7 days, ≥10 samples, zero `outbox_shadow_results.matched=false`.
7. `pnpm smoke:lease-recovery` passes in staging — forced `process.exit(1)` between `create_booking` and `attach_services_to_booking`; watchdog fires; booking deleted.
8. Compensation cutover Phase A→B→C without incident; `outbox_lease_recovery_total{recovery_reason="compensated_watchdog"} > 0` in staging via the forced-crash probe; `recovery_reason="already_attached_via_watchdog"` remains 0.
9. Other six event types ship in shadow-first cadence (§5.3).
10. Tenant-mismatch counter zero for 30+ days post-cutover.
11. `pnpm smoke:work-orders` extended with the forced-compensation probe and passing.

---

## 16. Open questions remaining (post-v4)

Not blocking implementation; revisit before Phase 7 hardening.

1. **Per-tenant fairness** (still open) — sharded per-tenant worker vs today's FIFO drain. The optional `idx_outbox_events_per_tenant_pending` index supports it. Defer until a noisy-neighbor incident or a tenant >100x median emit rate.
2. **Cross-region replication** (still open) — probably "worker in primary DB region; cross-region events catch up in seconds." Confirm before we ship a multi-region tenant.
3. **Webhook delivery via outbox** (still open) — likely yes with a dedicated `webhook.deliver_required` event type; revisit in the webhook hardening sprint.
4. **`outbox_emit_via_rpc` PostgREST wrapper kept or dropped** (still open; v4 reduced the wrapper count by removing the `outbox_mark_consumed_via_rpc` call site from steady-state TS). Re-evaluate once we have ≥2 TS-side `emit` call sites in production.
5. **`outbox_shadow_results` retention** (still open) — needs a daily purge job; fold into the GDPR retention catalog when cutover lands.

**Resolved by v4:**

- ~~Lease window tuning~~ — v3's 30s was tight; v4 makes it 5 min default + GUC-configurable. The lock+re-check eliminates race risk regardless of window size, so tuning is now a latency-vs-recovery-time tradeoff, not a correctness one.
- ~~Watchdog races success path~~ — v3 §13.2's two cases. Both structurally impossible in v4 due to the FOR UPDATE serialisation between attach RPC and `delete_booking_with_guard`.
- ~~Compensation false-positive on slow attach~~ — codex's v3 finding. Eliminated by the lock+re-check; a slow attach holds the booking lock, the watchdog blocks, and on lock-acquire the re-check observes `services_attached_at IS NOT NULL` and returns `already_attached`.

---

## Document version

- v4 — 2026-05-04. Status: DESIGN (not implemented; investigation + spec only). Replaces v3 (commit `83f3ba0`).
- Next step: Phase 6 / Plan B.0 implementation — start with migrations 00302–00305 + `BundleService.buildAttachPlan` + `attach_services_to_booking` RPC integration tests + `BookingCreateAttemptedHandler` in shadow mode.
