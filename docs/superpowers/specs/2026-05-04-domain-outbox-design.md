# Domain Outbox Design Specification — Plan B.1 (v2)

> **Authored:** 2026-05-04
> **Phase:** 6 (Durable Infrastructure)
> **Scope:** Investigation + Design only. No implementation code beyond this spec.

---

## Revision history

- **v1** (commit `f5b96c5`, superseded): initial design proposing client-side `OutboxService.emitTx(client)` that would share a transaction with the business write. Adversarial review found a foundational architecture mismatch — `BookingFlowService.create` reaches Postgres via `supabase.admin.rpc('create_booking', ...)` which is a PostgREST HTTP call running on its own pooled connection, **not** a `pg.PoolClient` opened by the API process. There is no shared transaction the producer could enroll in, so v1's atomicity claim was unsatisfiable. v1 also tagged the unique-key as global (cross-tenant collision), led the drain index with `tenant_id` while the worker filters globally, claimed RLS would catch cross-tenant smuggling at handler dispatch (service role bypasses RLS), and ordered the cutover "easiest first" (compensation last) — exactly inverse of the risk profile.
- **v2** (this revision): atomicity moved into Postgres. Producers emit either via row-lifecycle triggers or via an `outbox.emit(...)` SQL helper called from inside an RPC, in the same transaction as the business write. TS-side `OutboxService.emit()` is reframed as fire-and-forget for non-critical operations only. Folds 5 criticals + 5 importants from the adversarial review.

---

## 1. Architectural rule (NON-NEGOTIABLE)

> **Atomic outbox events MUST be created inside Postgres, in the same transaction as the business write.**

There are exactly two acceptable mechanisms:

1. **Row-lifecycle triggers** — `AFTER INSERT`/`AFTER UPDATE` on a domain table emits a row in `outbox_events` when the event truly is "this row reached state X." The trigger runs inside the same transaction as the writing statement, so the event row is visible to the worker iff the business row commits.

2. **Explicit `outbox.emit(...)` helper called from inside an RPC** — when the event payload has semantic content that can't be reconstructed from the row alone (input ids, computed payloads, idempotency tokens supplied by the caller). The helper is a SECURITY INVOKER PL/pgSQL function that does the INSERT into `outbox_events`. It is called from inside another PL/pgSQL function (e.g. `create_booking`, `delete_booking_with_guard`) that is itself running in a Postgres transaction.

**What this rule excludes**:

- A TS-side `emitTx(client: PoolClient, ...)` that pretends to share a transaction with a PostgREST RPC call. `supabase.admin.rpc(...)` issues an HTTP request to PostgREST, which acquires its own connection from PgBouncer and commits independently. The `pg.PoolClient` the API holds is on a different connection. **There is no shared transaction.** This is the v1 architecture mismatch.
- A "every row change becomes an event" generic firehose driven by per-table CDC triggers. Domain events are intentional; the payload is designed for the consumer; firehose-style emission turns the outbox into a dumping ground and forces consumers to filter.

**TS-side `OutboxService.emit()` survives only as a fire-and-forget post-commit helper** for explicitly best-effort operations (notifications, webhook delivery hints). It is never the path for compensation, SLA timer creation, or anything where loss of the event corrupts state.

---

## 2. Schema

### 2.1 `outbox_events`

Single table with `event_type` discriminator. Mirrors the `audit_outbox` pattern (migration `00161_gdpr_audit_outbox.sql:12-50`) but with idempotency, backoff, dead-letter, and event versioning bolted on.

```sql
-- supabase/migrations/00XXX_domain_outbox.sql

create table if not exists public.outbox_events (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,

  -- Classification
  event_type          text        not null,                       -- 'booking.compensation_required', etc.
  event_version       int         not null default 1,             -- §11
  aggregate_type      text        not null,                       -- 'booking', 'work_order', 'sla_timer'
  aggregate_id        uuid        not null,

  payload             jsonb       not null default '{}'::jsonb,

  -- Idempotency: tenant-scoped (see §2.4 / C3)
  idempotency_key     text        not null,

  -- Processing state
  enqueued_at         timestamptz not null default now(),
  available_at        timestamptz not null default now(),
  processed_at        timestamptz,
  claim_token         uuid,
  claimed_at          timestamptz,
  attempts            int         not null default 0,
  last_error          text,

  constraint outbox_events_attempts_nonneg check (attempts >= 0),
  constraint outbox_events_idem_unique unique (tenant_id, idempotency_key)
);

-- Hot index: worker drain. Leads with available_at because the drain query
-- filters globally across tenants in a single sweep (the worker isn't sharded
-- per tenant in v2). C2: v1's lead-with-tenant_id index forced a full scan
-- across all tenant prefixes for every drain.
create index if not exists idx_outbox_events_drainable
  on public.outbox_events (available_at, enqueued_at)
  where processed_at is null and claim_token is null;

-- Optional: per-tenant drain support for future per-tenant workers / fairness.
-- Justified because tenant-scoped admin queries ("show pending events for tenant X")
-- and any future per-tenant worker pool will benefit. Not used by the default drain.
create index if not exists idx_outbox_events_per_tenant_pending
  on public.outbox_events (tenant_id, available_at)
  where processed_at is null;

-- Stale-claim sweep
create index if not exists idx_outbox_events_stale_claim
  on public.outbox_events (claimed_at)
  where processed_at is null and claimed_at is not null;

-- Cleanup index
create index if not exists idx_outbox_events_processed
  on public.outbox_events (processed_at)
  where processed_at is not null;

alter table public.outbox_events enable row level security;

drop policy if exists tenant_isolation on public.outbox_events;
create policy tenant_isolation on public.outbox_events
  using (tenant_id = public.current_tenant_id());

comment on table public.outbox_events is
  'Durable outbox for domain events. Producers MUST insert via outbox.emit() helper or row-triggers, inside the business write transaction. Worker drains asynchronously; at-least-once + idempotent handlers.';
comment on column public.outbox_events.idempotency_key is
  'Tenant-scoped (see unique constraint with tenant_id). Format: <event_type>:<aggregate_id>:<operation_id>.';

notify pgrst, 'reload schema';
```

### 2.2 `outbox_events_dead_letter`

Same shape as v1 (separate table, write-once, narrow main table). Not repeated in full here; carry forward v1's `outbox_events_dead_letter` definition and add `event_version` + `(tenant_id, idempotency_key)` unique to match.

### 2.3 The `outbox.emit(...)` SQL helper (the canonical producer entry point)

This is the function every transactional producer calls — both row-lifecycle triggers and RPC bodies. It's the only way an event lands in `outbox_events` in v2 (the TS `OutboxService.emit()` calls into it indirectly via PostgREST for the fire-and-forget case; see §3.2).

```sql
-- supabase/migrations/00XXX_domain_outbox.sql (continued)

-- Wrapper schema for outbox-internal helpers. Keeps the RPC surface clean
-- (callers don't see this in PostgREST's exposed schema unless we choose to).
create schema if not exists outbox;

create or replace function outbox.emit(
  p_tenant_id        uuid,
  p_event_type       text,
  p_aggregate_type   text,
  p_aggregate_id     uuid,
  p_payload          jsonb,
  p_idempotency_key  text,
  p_event_version    int  default 1,
  p_available_at     timestamptz default null
) returns uuid
language plpgsql
security invoker         -- callers run with their own privileges; RLS still applies
set search_path = public, outbox
as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null then
    raise exception 'outbox.emit: p_tenant_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'outbox.emit: p_idempotency_key required (no anonymous emits)';
  end if;

  insert into public.outbox_events
    (tenant_id, event_type, event_version, aggregate_type, aggregate_id,
     payload, idempotency_key, available_at)
  values
    (p_tenant_id, p_event_type, p_event_version, p_aggregate_type, p_aggregate_id,
     coalesce(p_payload, '{}'::jsonb), p_idempotency_key, coalesce(p_available_at, now()))
  on conflict (tenant_id, idempotency_key) do nothing
  returning id into v_id;

  return v_id;  -- nullable when conflict-skipped (idempotent re-emit)
end;
$$;

comment on function outbox.emit is
  'The canonical transactional emit. Call from row-lifecycle triggers or from inside an RPC. SECURITY INVOKER + tenant-scoped idempotency key. Idempotent: same (tenant, key) is a no-op.';
```

**Security model**:

- `SECURITY INVOKER`. The caller's privileges and RLS context apply. This matches `create_booking` (00277:262) and `delete_booking_with_guard` (00292:59).
- The function does no cross-tenant reads. The single INSERT is gated by RLS; service-role callers bypass RLS but pass `p_tenant_id` explicitly (matching the convention in `create_booking` 00277:271-275 and `delete_booking_with_guard` 00292:67-72).
- **Tenant id is required** (NOT NULL guarded at the start of the function). No fall-back to `current_tenant_id()` here, because triggers running on rows already have the tenant_id pinned and RPCs already do the JWT-or-explicit dance themselves.

### 2.4 Tenant-scoped idempotency (C3)

v1 had `idempotency_key text unique` (global). Two tenants picking the same idempotency token (e.g. a UUID derived from a request id, an entity id, anything) would silently `on conflict do nothing` against each other — one tenant's event would be **silently dropped** by another tenant's prior emit. That's a CLAUDE.md #0 violation: tenant_id is the ultimate rule, and a global unique constraint that crosses tenant boundaries is a leak.

v2: `unique (tenant_id, idempotency_key)`. Cross-tenant emits with the same logical key are independent. Within a tenant, idempotency works as before.

---

## 3. Producer API

### 3.1 Transactional emit — from RPCs and triggers

**From an RPC body** (e.g. inside `create_booking`):

```sql
-- Pseudocode showing the integration. Real change happens via a future
-- migration that wraps the existing INSERT block in 00277:236-334.
create or replace function public.create_booking(...)
returns table (booking_id uuid, slot_ids uuid[])
language plpgsql security invoker as $$
declare
  v_tenant_id  uuid;
  v_booking_id uuid;
  -- ...
begin
  v_tenant_id := coalesce(p_tenant_id, public.current_tenant_id());
  -- ...

  insert into public.bookings (...) values (...) returning id into v_booking_id;
  -- ...slot inserts...

  -- Atomic outbox emit. Same transaction as the booking insert above.
  perform outbox.emit(
    p_tenant_id       => v_tenant_id,
    p_event_type      => 'booking.create_attempted',
    p_aggregate_type  => 'booking',
    p_aggregate_id    => v_booking_id,
    p_payload         => jsonb_build_object(
      'requester_person_id', p_requester_person_id,
      'location_id',          p_location_id,
      'source',               p_source
    ),
    p_idempotency_key => 'booking.create_attempted:' || v_booking_id::text
  );

  return query select v_booking_id, v_slot_ids;
end;
$$;
```

The booking row + the outbox row commit atomically. If `outbox.emit` raises (e.g. constraint violation we didn't anticipate), the booking insert rolls back too — which is the desired semantic for "this event must accompany this state change."

**From a row-lifecycle trigger** (e.g. on `bookings`):

```sql
-- Used when the event is purely "this row reached state X" with no caller-supplied payload beyond the row itself.
create or replace function public.bookings_emit_compensation_required()
returns trigger language plpgsql as $$
begin
  if new.status = 'rolled_back' and (old.status is distinct from 'rolled_back') then
    perform outbox.emit(
      p_tenant_id       => new.tenant_id,
      p_event_type      => 'booking.compensation_required',
      p_aggregate_type  => 'booking',
      p_aggregate_id    => new.id,
      p_payload         => jsonb_build_object('previous_status', old.status),
      p_idempotency_key => 'booking.compensation_required:' || new.id::text
    );
  end if;
  return new;
end;
$$;
-- Note: this is illustrative; the actual compensation flow doesn't pivot on a
-- rolled_back column today (the boundary deletes the row outright). See §6 for
-- the real placement of compensation emit.
```

### 3.2 TypeScript `OutboxService.emit()` — fire-and-forget only

```typescript
// apps/api/src/modules/outbox/outbox.service.ts

@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Fire-and-forget emit. NOT transactional. Failures are logged, never thrown.
   * Use ONLY for events where post-commit best-effort is acceptable
   * (notifications, webhook delivery hints).
   *
   * For atomic emit, the producer is a Postgres function (RPC body or trigger)
   * that calls outbox.emit() in-transaction. There is no TS path that joins a
   * Postgres transaction with a PostgREST RPC call. (See spec §1.)
   */
  async emit(input: OutboxEventInput): Promise<void> {
    try {
      const { error } = await this.supabase.admin.rpc('outbox_emit_via_rpc', {
        p_tenant_id:       input.tenantId,
        p_event_type:      input.eventType,
        p_aggregate_type:  input.aggregateType,
        p_aggregate_id:    input.aggregateId,
        p_payload:         input.payload ?? {},
        p_idempotency_key: this.deriveIdempotencyKey(input),
        p_event_version:   input.eventVersion ?? 1,
      });
      if (error) {
        this.log.error(
          `outbox emit failed (event=${input.eventType} tenant=${input.tenantId}): ${error.message}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        `outbox emit threw (event=${input.eventType} tenant=${input.tenantId}): ${message}`,
      );
    }
  }

  private deriveIdempotencyKey(input: OutboxEventInput): string {
    return `${input.eventType}:${input.aggregateId}:${input.operationId}`;
  }
}

export interface OutboxEventInput {
  tenantId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  /** Required (I4). No anonymous fire-and-forget. */
  operationId: string;
  eventVersion?: number;
}
```

**I4: `operationId` is required.** v1 generated a random UUID when the caller forgot to pass one — so two retries of the same logical op would emit two non-deduplicated events. There is no business case where "I want best-effort emit AND I don't care about idempotency." The TypeScript signature now enforces it.

A thin SQL wrapper `public.outbox_emit_via_rpc(...)` exists purely so the TS service can call it through PostgREST; it is a one-liner that calls `outbox.emit(...)`. (We could expose `outbox.emit` directly, but a separate name keeps the schema-namespace boundary clean and lets us add audit/rate-limit guards later without touching the in-transaction signature.)

---

## 4. Consumer / Worker

### 4.1 Drain query (C2)

```typescript
// Step 2 of drainOnce — claim a batch atomically.
const claimToken = randomUUID();
const claimed = await this.db.query<{ id: string; event_type: string; tenant_id: string }>(
  `with cte as (
     select id from public.outbox_events
      where processed_at is null
        and claim_token is null
        and available_at <= now()
        and attempts < $3
      order by available_at, enqueued_at      -- N1: explicit ORDER BY
      limit $1
      for update skip locked
   )
   update public.outbox_events o
      set claim_token = $2, claimed_at = now()
      -- attempts NOT incremented here; see I2 below
     from cte
    where o.id = cte.id
    returning o.id, o.event_type, o.tenant_id`,
  [this.batchSize, claimToken, this.maxAttempts],
);
```

**Index alignment**: the drain filter is `processed_at is null and claim_token is null and available_at <= now()`, ordered by `(available_at, enqueued_at)`. The new `idx_outbox_events_drainable` covers that exactly; v1's `(tenant_id, processed_at NULLS FIRST, available_at)` did not, and forced a scan-and-filter across the leading `tenant_id` prefix.

### 4.2 Stale-claim recovery (I2)

v1 incremented `attempts` inside the claim CTE. A worker that crashed mid-batch left rows with `claim_token` set; the stale-claim sweep zeroed `claim_token` + `claimed_at` so the next drain reclaimed them — and the next drain's CTE incremented `attempts` again. Five stale-claim cycles → row dead-lettered without any handler ever running. That's the worst possible outcome: pure infrastructure flakiness produces dead-letter spam.

v2: **`attempts` is incremented only after handler invocation completes (success or failure), not at claim time.** The claim CTE moves the row from "drainable" to "claimed" without touching the attempt counter. If the worker crashes between claim and handler call, the stale-claim sweep restores the row to "drainable" with `attempts` unchanged — only handler-observed failures move the counter.

```typescript
// Inside processEvent(event), after handler.handle() runs (success or throw):
await this.db.query(
  `update public.outbox_events
      set attempts    = attempts + 1,
          last_error  = $2,
          available_at = $3
    where id = $1`,
  [event.id, errorMessage ?? null, nextAvailable],
);
```

### 4.3 Tenant context wrapping (C4)

Handlers run via `supabase.admin` (service role, bypasses RLS) by necessity — the worker is not request-scoped, has no JWT, and crosses tenants every drain. **Tenant context is the explicit defense, not RLS.**

```typescript
// In OutboxWorker.processEvent(event):
import { TenantContext } from '../../common/tenant-context';

await TenantContext.run(
  { id: event.tenant_id, slug: '<resolved-once-or-cached>', tier: 'standard' },
  async () => {
    await handler.handle(event);
  },
);
```

The handler now sees `TenantContext.current().id === event.tenant_id` everywhere it would in a normal request. Anywhere it forgets to scope a query by tenant is the exact same bug class as a missing scope in a request-handler — caught by the same review rules.

### 4.4 Cross-tenant smuggling defense (C5)

v1 §9.5 claimed: "Handlers query tenant-scoped tables. If a producer emits with the wrong tenant_id, RLS will reject the handler's insert." That is **wrong**. The handler runs against `supabase.admin` (service role). Service role bypasses RLS. RLS is not a defense at handler dispatch.

v2: **handlers MUST explicitly load the aggregate row, assert `aggregate.tenant_id === event.tenant_id`, and dead-letter on mismatch.** This is a structural defense — a missing assertion is a security bug, not a missing optimization.

```typescript
// Example: BookingCompensationHandler
async handle(event: OutboxEventWithPayload<...>): Promise<void> {
  const { data: booking, error } = await this.supabase.admin
    .from('bookings')
    .select('id, tenant_id')
    .eq('id', event.aggregate_id)
    .maybeSingle();

  if (error) throw error;                                    // transient → retry
  if (!booking) {
    // already deleted; idempotent no-op
    return;
  }
  if (booking.tenant_id !== event.tenant_id) {
    throw new DeadLetterError(
      `tenant mismatch: event.tenant_id=${event.tenant_id} aggregate.tenant_id=${booking.tenant_id}`,
    );
  }

  await this.supabase.admin.rpc('delete_booking_with_guard', {
    p_booking_id: event.aggregate_id,
    p_tenant_id:  event.tenant_id,
  });
}
```

`DeadLetterError` is a sentinel: the worker recognizes it and moves the row to dead-letter immediately (no retry, no backoff). Tenant mismatch is not a transient error.

This is identical in spirit to the LATERAL-projection-via-visibility-id rule (memory: `feedback_visibility_gate_lateral`): when service-role bypasses RLS, the tenant boundary becomes a **handler-level invariant** that has to be checked explicitly.

---

## 5. Event taxonomy — mechanism per event type

For each of the 7 initial event types, we lock the production mechanism (trigger vs RPC helper vs fire-and-forget):

| Event type | Mechanism | Rationale |
|---|---|---|
| `booking.create_attempted` | RPC helper inside `create_booking()` (00277:236-334) | Payload includes input ids the row alone doesn't capture (e.g. `requestId`). Atomic with the booking insert. |
| `booking.compensation_required` | RPC helper inside `delete_booking_with_guard()` (00292:54-141), emitted **before** the DELETE statement | The "compensation needed" signal must accompany the rollback decision atomically. Today's `BookingTransactionBoundary.runWithCompensation` (`booking-transaction-boundary.ts:82-158`) catches operation-failure in TS and calls compensate; the durable refactor moves the emit into the RPC so a TS-side process death between catch and compensate-call cannot orphan the booking. See §6 for the staged migration. |
| `booking.service_attached` | RPC helper inside a new `attach_services_to_booking()` RPC | Currently `BundleService.attachServicesToBooking` is a sequence of supabase-js calls (per `booking-transaction-boundary.ts:11-22`). Phase 6 wraps that into a single PL/pgSQL RPC, and emits inside it. Until that wrap is done, this event type is **not durable** and remains best-effort. |
| `setup_work_order.create_required` | RPC helper inside the bundle-commit RPC (when the bundle commit becomes an RPC) — until then, fire-and-forget post-commit | The current `SetupWorkOrderTriggerService.triggerMany` runs after commit. Moving it durable requires the bundle-commit path itself to be an RPC; this is in scope for Phase 6 but staged after compensation. |
| `sla_timer.create_required` | RPC helper inside the dispatch path (`POST /tickets/:id/dispatch` -> RPC) | Dispatch atomically advances the ticket; the SLA timer creation event must commit with it. If dispatch is not yet an RPC, this is a Phase 6 prerequisite — list under "test infrastructure / blockers" below. |
| `notification.send_required` | Fire-and-forget post-commit via `OutboxService.emit()` | Notifications are best-effort. Loss of a notification is bad UX, not corruption. The fire-and-forget path is correct and acceptable here. |
| `escalation.fire_required` | RPC helper from inside the SLA-check function (a scheduled `pg_cron` job that scans `sla_timers` and fires escalations) | The escalation decision is computed entirely from DB state; pushing the emit into the same function that mutates `sla_timers.escalated_at` is the natural fit. |

**Why not "every row change is an event":** the four entries that use RPC helpers each carry payload context the row doesn't capture (input ids, the original error, computed plan deltas). A generic `AFTER INSERT` trigger that always emits `<table>.row_inserted` would force handlers to re-derive that context — possibly wrong, possibly racing with subsequent updates. Domain events are intentional.

---

## 6. Cutover order — compensation FIRST, in shadow mode (I1)

v1 ordered the cutover "easiest first": SLA timers → setup work-orders → notifications → booking compensation last. This is exactly inverse of the risk profile. Booking compensation is **why this spec exists** — it's the headline durability gap (`booking-transaction-boundary.ts:69-77`: "if the Node process crashes between operation-throw and compensation-call, the booking is orphaned"). Validating outbox infrastructure on notifications (which are already best-effort) doesn't prove it can carry compensation.

v2 cutover order:

1. **`booking.compensation_required` (shadow mode)** — first cutover.
   - Phase A: emit the event from inside `delete_booking_with_guard` (or from the boundary, before the DELETE), but the new `BookingCompensationHandler` runs in **shadow** — it loads the booking, computes what it would do, logs the result, and exits without mutating. The existing inline `runWithCompensation` path keeps doing the actual rollback. CI/staging compares the shadow log with the inline outcome over a 1-week burn-in.
   - Phase B: flip the new path to active. The inline `runWithCompensation` keeps running (dual emission, see I5) but the inline RPC call becomes a no-op when the handler has already done the work — gated by the booking's existence (idempotent).
   - Phase C: remove the inline path. Boundary becomes a thin wrapper around the outbox emit.
2. **`sla_timer.create_required`** — second. Depends on dispatch becoming an RPC (or accepting the fire-and-forget gap).
3. **`setup_work_order.create_required`** — third.
4. **`notification.send_required`** — last. It's already best-effort; converting to outbox is a cleanup, not a hardening.

**Why shadow first**: a compensation event that fires twice (because dual-emit + inline both ran) without idempotency would double-delete the booking — except the second `delete_booking_with_guard` would hit "booking.not_found" and surface as a real error. We need the handler to be idempotent before we let it run live. Shadow mode proves equivalence without the failure mode.

### 6.1 Dual-emission double-effect risk (I5)

v1 didn't address what happens during the dual-emission window. v2: shadow mode is the answer. While the new handler is shadow, dual-effect is impossible because the new path doesn't act. The Phase B → Phase C transition is the brief window where both paths are active; the handler's idempotency proof (the booking either exists or doesn't; second delete is a `not_found` no-op) is the safety net.

Per-handler idempotency contract is mandatory before Phase B for that event type. SLA, setup work-order, notification flips follow the same shadow-first cadence.

---

## 7. Idempotency

### 7.1 Key format (per event type)

- `booking.create_attempted:<booking_id>` — one per booking, unique by construction.
- `booking.compensation_required:<booking_id>` — one per booking; if the same booking somehow needs compensation twice, the second is a no-op (the booking was already deleted on the first; second handler call hits `not_found` early-return).
- `sla_timer.create_required:<ticket_id>:<policy_id>:<timer_type>` — one per (ticket, policy, timer-kind) tuple.
- `setup_work_order.create_required:<line_item_id>` — one per line item.
- `notification.send_required:<recipient_id>:<event_id>` — one per (recipient, source-event) pair.

The format is documented per event type; the producer (RPC helper or trigger) constructs it deterministically. **No anonymous emits** — `outbox.emit` rejects null/empty `p_idempotency_key` (§2.3).

### 7.2 Handler idempotency contract

Every handler MUST be safe to invoke multiple times for the same event. Patterns:

1. **Aggregate state check** — load the aggregate; if it's already in the post-event state, return success. Compensation handler does this (booking already deleted → success).
2. **Upsert** — `insert ... on conflict do nothing` keyed on a deterministic id derived from the event.
3. **Outbox dedup token in the side-effect** — when sending a Slack/email, include the event's outbox `id` as the message dedup token, so the recipient's inbound webhook can deduplicate even if our retry happens after their ACK.

Idempotency is not optional. The infrastructure delivers at-least-once; handlers convert that to effectively-once.

### 7.3 N2: idempotency_key on `sla_timers`

v1's example called `insert into sla_timers (...) on conflict (ticket_id, timer_type, sla_policy_id) do nothing`. That's already in `sla_timers` (no schema change needed) — confirmed by reading the migration history. The example stays; no spec text needed about adding columns.

If a handler genuinely needs an `idempotency_key` column on its target table, the migration adding the handler ships the column at the same time. This is part of the handler's implementation scope, not the outbox-infra scope.

---

## 8. Handler registration — decorator-based (resolves §11 #5)

v1 deferred this to "explicit map for clarity; decorators premature." That's wrong. A central manual map turns into a merge-conflict hotspot the moment three engineers add handlers in parallel, and decoupling the handler class from its registration is a code-smell — the handler's identity (which event_type it serves) is part of its definition.

```typescript
// apps/api/src/modules/outbox/outbox-handler.decorator.ts
import 'reflect-metadata';
export const OUTBOX_HANDLER_META = Symbol('outbox.handler');

export function OutboxHandler(eventType: string, opts?: { version?: number }): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(
      OUTBOX_HANDLER_META,
      { eventType, version: opts?.version ?? 1 },
      target,
    );
  };
}
```

```typescript
// apps/api/src/modules/outbox/outbox-handler.registry.ts
@Injectable()
export class OutboxHandlerRegistry implements OnModuleInit {
  private readonly handlers = new Map<string, OutboxHandler>();

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly discovery: DiscoveryService,   // @nestjs/core
    private readonly metadataScanner: MetadataScanner,
  ) {}

  onModuleInit(): void {
    const providers = this.discovery.getProviders();
    for (const wrapper of providers) {
      if (!wrapper.metatype) continue;
      const meta = Reflect.getMetadata(OUTBOX_HANDLER_META, wrapper.metatype);
      if (!meta) continue;
      const instance = this.moduleRef.get(wrapper.metatype, { strict: false });
      this.handlers.set(`${meta.eventType}@v${meta.version}`, instance);
    }
  }

  get(eventType: string, version: number): OutboxHandler | null {
    return this.handlers.get(`${eventType}@v${version}`) ?? null;
  }
}
```

```typescript
// Example handler:
@Injectable()
@OutboxHandler('booking.compensation_required', { version: 1 })
export class BookingCompensationHandler { /* ... */ }
```

**Why decorators win here**:

- Handler identity lives with the handler class — not in a separate registration site that drifts.
- Adding a handler is a 1-file change.
- Version pairing (see §11) falls out naturally — the registry key is `eventType@vN`.
- Nest's `DiscoveryService` already does this at module init; no novel runtime machinery.

---

## 9. Event versioning (resolves §11 #6)

v1 punted: "minor version in event_type (e.g., `booking.compensation_required.v2`); old handlers continue processing v1; new handlers process both." That's worse than nothing — it requires every handler to know about every version forever.

v2: **`event_version` is a first-class column. The registry resolves `(event_type, event_version)` to a specific handler.**

Rules:

1. **Producers always emit at the schema version they were written for**. The version is a constant in the producer code (RPC helper or trigger).
2. **Handlers declare the exact version they handle** via `@OutboxHandler('foo.bar', { version: 2 })`.
3. **A schema change ships in three commits**, in this order:
   - Commit 1: deploy the new handler `v2` alongside the existing `v1`. Both registered. Producer still emits `v1`.
   - Commit 2: switch the producer to emit `v2`. New events flow to `v2` handler; in-flight `v1` events still drain via `v1` handler.
   - Commit 3 (after the in-flight queue empties — typically within minutes): remove the `v1` handler. The dead-letter monitor will surface any straggler `v1` events for manual replay if needed.
4. **Mismatch → dead-letter**. If the worker dispatches event_type `X` at version 2 and no `X@v2` handler is registered, the row moves to dead-letter immediately. No silent skip, no fall-back to v1.
5. **Breaking-change discipline**: bump the version when removing/renaming a payload field, changing a field's type, or changing the meaning of a field. Adding an optional field is **not** a version bump (the v1 handler ignores fields it doesn't read).

This puts the migration cost where it belongs — on the schema-change author, who has to ship three commits — and keeps every handler simple (one version, one shape).

---

## 10. Test infrastructure (acknowledges N3 + scope reality)

The audit-outbox subsystem has no integration tests today; v1's assumption that we already have test-DB wiring was wrong. Adding it is part of the Phase 6 implementation scope.

### 10.1 Unit tests — real jest patterns

v1's `mock(SupabaseService)` is invented (not a real jest helper). v2 uses `jest.Mocked<T>` or hand-rolled factory mocks:

```typescript
// apps/api/src/modules/outbox/handlers/__tests__/booking-compensation.handler.spec.ts

describe('BookingCompensationHandler', () => {
  let handler: BookingCompensationHandler;
  let supabase: jest.Mocked<SupabaseService>;

  beforeEach(() => {
    supabase = {
      admin: {
        rpc: jest.fn(),
        from: jest.fn(),
      },
    } as unknown as jest.Mocked<SupabaseService>;
    handler = new BookingCompensationHandler(supabase);
  });

  it('asserts tenant_id matches before calling the RPC', async () => {
    (supabase.admin.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq:     jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { id: 'b-1', tenant_id: 'OTHER-TENANT' },
        error: null,
      }),
    });

    await expect(
      handler.handle({
        id: 'e-1',
        tenant_id: 'TENANT-1',
        aggregate_id: 'b-1',
        event_type: 'booking.compensation_required',
        event_version: 1,
        payload: {},
      } as any),
    ).rejects.toBeInstanceOf(DeadLetterError);

    expect(supabase.admin.rpc).not.toHaveBeenCalled();
  });
});
```

### 10.2 Integration tests

These need real DB wiring. Scope: a `pnpm test:integration` command that spins up a dedicated Postgres (the existing local Supabase from `pnpm db:start`) with the migrations applied, runs a NestJS testing module against it, and tears down between tests. This is not novel — `apps/api/scripts/smoke-work-orders.mjs` already pattern-talks to a live API. Phase 6 implementation includes:

- A `TestDbModule` that opens a real connection to the local Supabase, with a `truncate-and-reseed` helper.
- One worker integration test (drain a batch end-to-end) and one per-handler integration test against real schemas.
- A stress test (1000 events, single drain, verify all processed exactly once + zero dead-letter).

If test-DB wiring slips, the handler unit tests + the live smoke-test gate (extended to include a forced-compensation probe) carry the reliability load.

---

## 11. Observability

Carry forward v1 §7 (metrics + admin dashboard endpoints + logging). Two adjustments:

- **Per-tenant emit/drain counters** — labels include `tenant_id` (cardinality concern noted; Prometheus handles it for the tenant counts XPQT targets in Wave 1).
- **Tenant-mismatch counter** — `outbox_dead_letter_tenant_mismatch_total{event_type}`. This tracks C5's defense — any non-zero value is a P0 (cross-tenant smuggling attempt or producer bug).

---

## 12. Failure modes

Carry forward v1 §9 with corrections:

- §9.5 (tenant isolation) replaced by §4.4 above. RLS is not a defense at handler dispatch.
- §9.2 (transactional emit) reframed: there is no TS-side transactional emit. The corresponding case is "RPC body emits → if `outbox.emit` raises, the entire RPC rolls back, including the business write." That's the real Postgres semantics; v1's description was correct in spirit but pointed at the wrong mechanism.

### 12.1 Purge cadence (I3)

v1 ran `purgeProcessed` only when a drain pass found nothing to claim. Under steady load, that's never. Solution: a **separate `@Cron(CronExpression.EVERY_HOUR)` method on the worker** runs `purgeProcessed` regardless of drain state. Cheap, narrow, decoupled. The "purge when idle" branch in the drain method goes away.

---

## 13. File locations

### Schema
- `supabase/migrations/00XXX_domain_outbox.sql` — `outbox_events`, `outbox_events_dead_letter`, `outbox.emit()` helper, `outbox_emit_via_rpc()` PostgREST wrapper.
- `supabase/migrations/00XXX_create_booking_emits_outbox.sql` — wraps `create_booking` (00277) to call `outbox.emit` for `booking.create_attempted`.
- `supabase/migrations/00XXX_compensation_emits_outbox.sql` — wraps `delete_booking_with_guard` (00292) to emit `booking.compensation_required` before the DELETE.

### TypeScript
- `apps/api/src/modules/outbox/outbox.service.ts` — fire-and-forget producer (TS).
- `apps/api/src/modules/outbox/outbox.worker.ts` — drain loop. Model: `audit-outbox.worker.ts:20-166`. Includes per-event `TenantContext.run` wrapping (C4).
- `apps/api/src/modules/outbox/outbox-handler.registry.ts` — decorator-driven registry.
- `apps/api/src/modules/outbox/outbox-handler.decorator.ts` — `@OutboxHandler(eventType, { version })`.
- `apps/api/src/modules/outbox/dead-letter.error.ts` — `DeadLetterError` sentinel.
- `apps/api/src/modules/outbox/handlers/booking-compensation.handler.ts` — replaces `InProcessBookingTransactionBoundary`'s compensation logic.

### Existing references
- Audit outbox service: `apps/api/src/modules/privacy-compliance/audit-outbox.service.ts:1-103` — emit pattern (no transactional `emitTx` in v2; v1 audit outbox's `emitTx` is being scoped down to RPC-internal use during this work).
- Audit outbox worker: `apps/api/src/modules/privacy-compliance/audit-outbox.worker.ts:20-166` — drain + retry + dead-letter logic.
- Compensation today: `apps/api/src/modules/reservations/booking-transaction-boundary.ts:78-160` — `InProcessBookingTransactionBoundary` (the in-process implementation v2 replaces).
- Tenant context: `apps/api/src/common/tenant-context.ts:1-29` — `TenantContext.run(tenant, fn)` pattern.
- `create_booking` RPC: `supabase/migrations/00277_create_canonical_booking_schema.sql:236-334` — model for the RPC-helper-emit pattern.
- `delete_booking_with_guard` RPC: `supabase/migrations/00292_delete_booking_with_guard_rpc.sql:54-141` — SECURITY INVOKER + p_tenant_id pattern.

---

## 14. Success criteria

Phase 6 (outbox infrastructure) is complete when:

1. Schema migration applied to remote Supabase (v2's three migrations + `notify pgrst, 'reload schema'`).
2. `OutboxService` (fire-and-forget) + `OutboxWorker` + decorator-driven registry implemented + unit tested.
3. `BookingCompensationHandler` deployed in shadow mode, producing comparison logs over a 1-week staging burn-in.
4. Compensation cutover completes Phase A → B → C without a production incident.
5. The other six event types ship in shadow-first cadence per §6.
6. Tenant-mismatch counter reads zero for 30+ days post-cutover.
7. Existing smoke test (`pnpm smoke:work-orders`) extended with an explicit force-compensation probe and still passes.

---

## 15. Open questions remaining (post-v2)

These are not blocking implementation but should be revisited before Phase 7 hardening:

1. **Per-tenant fairness** — under load, should the worker be sharded per tenant so a slow tenant doesn't block others? Today's drain is FIFO across tenants. The optional `idx_outbox_events_per_tenant_pending` index is in place to support a future sharded worker. Defer until we have a noisy-neighbor incident or a tenant >100x the median emit rate.

2. **Cross-region replication** — once Vercel + Supabase span regions, what's the read-after-write story for the outbox? Probably "the worker runs in the same region as the primary DB; events emitted in another region are picked up after replication catches up (seconds)." Confirm with a multi-region experiment before we ship a multi-region tenant.

3. **Webhook delivery** — should outbound webhook delivery go through this outbox? Probably yes, with a dedicated `webhook.deliver_required` event type. Out of scope for Phase 6; revisit in the webhook hardening sprint.

4. **`outbox_emit_via_rpc` vs direct `outbox.emit` exposure** — currently we wrap because PostgREST namespace exposure is finicky. Worth re-evaluating once we have one or two TS-side fire-and-forget call sites in production; the wrapper may not be earning its keep.

---

## Document version

- v2 — 2026-05-04. Status: DESIGN (not implemented; investigation + spec only). Replaces v1 (commit `f5b96c5`).
- Next step: Phase 6 implementation — start with schema migrations + `outbox.emit` helper + `BookingCompensationHandler` in shadow mode.
