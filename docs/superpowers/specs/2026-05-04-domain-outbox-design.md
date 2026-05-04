# Domain Outbox Design Specification — Plan B.1

> **Authored:** 2026-05-04  
> **Phase:** 6 (Durable Infrastructure)  
> **Scope:** Investigation + Design only. No implementation code beyond this spec.

---

## Executive Summary

This specification defines a durable, multi-tenant-aware outbox infrastructure for XPQT's domain events. It replaces four best-effort/in-process side-effect patterns that risk orphaned data on node crashes:

1. **Booking compensation** (`InProcessBookingTransactionBoundary`) — compensation RPC can fail; orphan booking persists
2. **Setup work-order trigger** (`SetupWorkOrderTriggerService.triggerMany`) — fires post-commit; fire failure becomes manual recovery
3. **SLA timer creation** (`SlaService.startTimers`) — inline post-commit; failure orphans the timers
4. **Notifications + escalations** — pre-existing best-effort pattern

The pattern mirrors the existing `audit_outbox` + `AuditOutboxWorker` design (migration `00161`, `audit-outbox.service.ts`, `audit-outbox.worker.ts`) but generalizes it for domain events: producers emit structured events **within** their business transaction; a background worker drains them asynchronously, decoupling latency from durability. At-least-once semantics + idempotent handlers ensure correctness across node restarts.

---

## 1. Schema (Postgres)

### 1.1 Single Outbox Table

**Design decision:** One `outbox_events` table with `event_type` discriminator, not per-bounded-context tables. Rationale:

- Simpler operational model: one worker drain, one dead-letter queue, one admin dashboard
- Event routing is soft (via `event_type`, not table), enabling new event types without schema changes
- Query patterns are identical (`(tenant_id, processed_at NULLS FIRST, available_at)` index)
- Cite: audit_outbox model (migration `00161:12-50`)

```sql
-- supabase/migrations/00XXX_domain_outbox.sql

create table if not exists public.outbox_events (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,

  -- Event classification
  event_type          text        not null,  -- e.g. 'booking.compensation_required', 'sla_timer.create_required'
  aggregate_type      text        not null,  -- e.g. 'booking', 'work_order', 'sla_timer'
  aggregate_id        uuid        not null,  -- e.g. booking_id, work_order_id, sla_timer_id

  -- Payload: arbitrary JSON. Handlers parse event_type-specific shapes.
  payload             jsonb       not null,

  -- Idempotency: prevent double-processing of the same logical event.
  -- Format: `<event_type>:<aggregate_id>:<operation_id>` for at-least-once semantics.
  -- Example: `booking.compensation_required:550e8400-e29b-41d4-a716-446655440000:<operation_id>`
  -- Unique constraint + UPSERT pattern: handler re-runs with same idempotency_key are no-ops.
  idempotency_key     text        unique not null,

  -- Processing state
  enqueued_at         timestamptz not null default now(),
  processed_at        timestamptz,           -- null = pending; set on success
  claim_token         uuid,                  -- per-worker batch claim token
  claimed_at          timestamptz,
  attempts            int         not null default 0,
  last_error          text,
  available_at        timestamptz default now(),  -- for exponential backoff; next retry window
  
  constraint outbox_events_attempts_nonneg check (attempts >= 0)
);

-- Hot index: worker drain scans only unprocessed rows in arrival order
create index if not exists idx_outbox_events_unprocessed
  on public.outbox_events (tenant_id, processed_at NULLS FIRST, available_at)
  where processed_at is null;

-- Stale-claim sweep: workers may crash mid-batch leaving claim_token + claimed_at set
create index if not exists idx_outbox_events_stale_claim
  on public.outbox_events (claimed_at)
  where processed_at is null and claimed_at is not null;

-- Cleanup: nightly job purges fully-processed rows past their retention window
create index if not exists idx_outbox_events_processed
  on public.outbox_events (processed_at)
  where processed_at is not null;

alter table public.outbox_events enable row level security;

drop policy if exists tenant_isolation on public.outbox_events;
create policy tenant_isolation on public.outbox_events
  using (tenant_id = public.current_tenant_id());

comment on table public.outbox_events is
  'Durable outbox for domain events. Producers insert here within their business transaction; OutboxWorker drains asynchronously. At-least-once delivery + idempotent handlers ensure correctness.';
comment on column public.outbox_events.idempotency_key is
  'Unique key for deduplication. Format: <event_type>:<aggregate_id>:<operation_id>. Prevents double-processing on retry.';
comment on column public.outbox_events.available_at is
  'Backoff field. Set to now() on first emit; worker skips rows where available_at > now(). On retry, advance by exponential backoff (2^attempt_count seconds, capped).';

notify pgrst, 'reload schema';
```

### 1.2 Optional Dead-Letter Table

Recommend a separate `outbox_events_dead_letter` table (not a `status='dead'` on main). Rationale:

- Keeps the main table narrow and fast (no status overhead)
- Dead-letter is write-once, rare (only on `attempts >= MAX_ATTEMPTS`)
- Ops can query dead-letter independently for triage dashboards
- Matches audit pattern: `audit_events` is the success sink; dead-letter is a separate concern

```sql
create table if not exists public.outbox_events_dead_letter (
  id                  uuid        primary key,  -- copied from outbox_events.id
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  event_type          text        not null,
  aggregate_type      text        not null,
  aggregate_id        uuid        not null,
  payload             jsonb       not null,
  idempotency_key     text        unique not null,
  
  enqueued_at         timestamptz not null,
  moved_to_dead_letter_at timestamptz not null default now(),
  attempts            int         not null,
  last_error          text,
  
  -- Operator notes for manual recovery
  recovery_notes      text
);

create index if not exists idx_outbox_events_dead_letter_tenant
  on public.outbox_events_dead_letter (tenant_id, moved_to_dead_letter_at desc);

alter table public.outbox_events_dead_letter enable row level security;

drop policy if exists tenant_isolation on public.outbox_events_dead_letter;
create policy tenant_isolation on public.outbox_events_dead_letter
  using (tenant_id = public.current_tenant_id());
```

---

## 2. Producer API (TypeScript)

### 2.1 OutboxService Interface

```typescript
// apps/api/src/modules/outbox/outbox.service.ts

import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../common/db/db.service';

/**
 * Durable domain-event outbox. Producers emit events within their business
 * transaction; OutboxWorker drains asynchronously.
 *
 * Pattern reference: audit-outbox.service.ts for the emitTx + transactional
 * emit semantics.
 */
@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Emit a domain event WITHIN an existing transaction. The event row is
   * committed iff the surrounding business transaction commits. Use this
   * from the default service-method path when atomicity is required.
   *
   * @param client PoolClient from an open transaction (e.g. via db.transaction(...))
   * @param input Event details
   * @throws On database error (will abort the caller's transaction)
   */
  async emitTx(client: PoolClient, input: OutboxEventInput): Promise<void> {
    const idempotencyKey = this.deriveIdempotencyKey(input);
    
    await client.query(
      `insert into outbox_events
         (tenant_id, event_type, aggregate_type, aggregate_id,
          payload, idempotency_key, available_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       on conflict (idempotency_key) do nothing`,
      [
        input.tenantId,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(input.payload ?? {}),
        idempotencyKey,
        input.availableAt ?? new Date(),
      ],
    );
  }

  /**
   * Emit a domain event outside any transaction. Use this when the event
   * emission is best-effort (e.g., a notification that must not block
   * the main request if it fails).
   *
   * Failures are logged but never thrown — a failed outbox emit must not
   * break the user-visible request.
   */
  async emit(input: OutboxEventInput): Promise<void> {
    try {
      const idempotencyKey = this.deriveIdempotencyKey(input);
      
      await this.db.query(
        `insert into outbox_events
           (tenant_id, event_type, aggregate_type, aggregate_id,
            payload, idempotency_key, available_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)
         on conflict (idempotency_key) do nothing`,
        [
          input.tenantId,
          input.eventType,
          input.aggregateType,
          input.aggregateId,
          JSON.stringify(input.payload ?? {}),
          idempotencyKey,
          input.availableAt ?? new Date(),
        ],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(
        `outbox emit failed (event=${input.eventType} tenant=${input.tenantId}): ${message}`,
      );
    }
  }

  /**
   * Derive a deterministic idempotency key from the event.
   * Format: <event_type>:<aggregate_id>:<operation_id>
   * 
   * If input.operationId is not provided, a random UUID is used (best-effort only).
   * Callers MUST provide operationId for critical events where idempotency matters.
   */
  private deriveIdempotencyKey(input: OutboxEventInput): string {
    const opId = input.operationId ?? randomUUID();
    return `${input.eventType}:${input.aggregateId}:${opId}`;
  }
}

export interface OutboxEventInput {
  tenantId: string;
  eventType: string;           // e.g. 'booking.compensation_required'
  aggregateType: string;       // e.g. 'booking'
  aggregateId: string;         // e.g. booking_id (UUID)
  payload?: Record<string, unknown>;
  
  /** Operation ID for idempotency. If not provided, a random UUID is used (best-effort only). */
  operationId?: string;
  
  /** Backoff window: if set, worker skips this event until available_at >= now(). */
  availableAt?: Date;
}
```

### 2.2 Integration with Existing Services

**Booking compensation flow example:**

```typescript
// Before: InProcessBookingTransactionBoundary.runWithCompensation
// - Operation fails → compensation RPC called → orphan booking on RPC failure

// After: OutboxService within a transaction
async createWithCompensation(input: CreateBookingInput) {
  const client = await this.db.transaction();
  try {
    // Step 1: Create booking (atomic with outbox event)
    const booking = await this.rpc.createBooking(...);
    
    // Step 2: Emit a 'booking.create_attempted' event WITHIN the transaction
    // This ensures: booking INSERT + outbox emit both commit or both rollback
    await this.outbox.emitTx(client, {
      tenantId: input.tenantId,
      eventType: 'booking.create_attempted',
      aggregateType: 'booking',
      aggregateId: booking.id,
      payload: { services: input.services, ... },
      operationId: input.requestId,  // idempotency
    });

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }

  // Step 3: Attach services (app-side, can fail)
  try {
    await this.bundle.attachServices(booking.id, input.services);
  } catch (serviceErr) {
    // Emit a compensation event (best-effort, not transactional)
    await this.outbox.emit({
      tenantId: input.tenantId,
      eventType: 'booking.compensation_required',
      aggregateType: 'booking',
      aggregateId: booking.id,
      payload: { originalError: serviceErr.message, serviceGroups: input.services },
      operationId: `${input.requestId}:compensation`,
    });
    throw serviceErr;
  }
}
```

---

## 3. Consumer / Worker

### 3.1 OutboxWorker Pattern

Based on `AuditOutboxWorker` (audit-outbox.worker.ts:20-166):

```typescript
// apps/api/src/modules/outbox/outbox.worker.ts

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { DbService } from '../../common/db/db.service';
import { OutboxHandlerRegistry } from './outbox-handler.registry';

@Injectable()
export class OutboxWorker {
  private readonly log = new Logger(OutboxWorker.name);

  private readonly batchSize       = Number(process.env.OUTBOX_BATCH_SIZE ?? 100);
  private readonly staleClaimMs    = Number(process.env.OUTBOX_STALE_CLAIM_MS ?? 5 * 60 * 1000);
  private readonly purgeAfterDays  = Number(process.env.OUTBOX_PURGE_AFTER_DAYS ?? 30);
  private readonly maxAttempts     = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 5);
  private readonly enabled         = process.env.OUTBOX_WORKER_ENABLED !== 'false';

  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly handlers: OutboxHandlerRegistry,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async drain(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return;  // Serialize self to prevent overlap

    this.running = true;
    try {
      const drained = await this.drainOnce();
      if (drained > 0) this.log.debug(`outbox drained ${drained} events`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`outbox drain failed: ${message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Single drain pass. Returns the number of events successfully processed.
   */
  async drainOnce(): Promise<number> {
    // Step 1: Reclaim stale claims (cite: audit-outbox.worker.ts:57-64)
    await this.db.query(
      `update outbox_events
          set claim_token = null, claimed_at = null
        where processed_at is null
          and claimed_at is not null
          and claimed_at < now() - ($1 || ' milliseconds')::interval`,
      [this.staleClaimMs.toString()],
    );

    // Step 2: Claim a batch atomically (cite: audit-outbox.worker.ts:70-87)
    const claimToken = randomUUID();
    const claimed = await this.db.query<{ id: string; event_type: string }>(
      `with cte as (
         select id, event_type from outbox_events
          where processed_at is null
            and claim_token is null
            and available_at <= now()
            and attempts < $3
          order by enqueued_at
          limit $1
          for update skip locked
       )
       update outbox_events o
          set claim_token = $2, claimed_at = now(), attempts = o.attempts + 1
         from cte
        where o.id = cte.id
        returning o.id, o.event_type`,
      [this.batchSize, claimToken, this.maxAttempts],
    );

    if (claimed.rowCount === 0) {
      await this.purgeProcessed();
      await this.warnOnDeadLetter();
      return 0;
    }

    // Step 3: Process each claimed event
    const eventIds = claimed.rows.map(r => r.id);
    const events = await this.db.query<OutboxEventRow>(
      `select * from outbox_events where id = any($1)`,
      [eventIds],
    );

    let successCount = 0;
    for (const event of events.rows) {
      const handled = await this.processEvent(event);
      if (handled) successCount++;
    }

    // Step 4: Mark processed (cite: audit-outbox.worker.ts:123-128)
    await this.db.query(
      `update outbox_events
          set processed_at = now()
        where claim_token = $1 and processed_at is null`,
      [claimToken],
    );

    return successCount;
  }

  /**
   * Process a single event. Returns true if the handler succeeded or the
   * event was marked dead-letter. Returns false on transient error (retry).
   */
  private async processEvent(event: OutboxEventRow): Promise<boolean> {
    try {
      const handler = this.handlers.get(event.event_type);
      if (!handler) {
        this.log.warn(`no handler registered for event_type=${event.event_type}`);
        // Move to dead-letter: unhandled event type
        await this.moveToDeadLetter(event, `no handler registered`);
        return true;
      }

      // Call the handler. If it succeeds, the outbox row marked processed in drainOnce.
      await handler.handle(event);
      this.log.debug(`processed event ${event.id} (${event.event_type})`);
      return true;

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      
      // Transient error: will retry on next sweep
      this.log.warn(
        `event ${event.id} (${event.event_type}) handler failed: ${message}; will retry`,
      );

      // Update last_error for ops visibility
      await this.db.query(
        `update outbox_events set last_error = $1 where id = $2`,
        [message, event.id],
      );

      // If attempts exhausted, move to dead-letter
      if (event.attempts >= this.maxAttempts) {
        await this.moveToDeadLetter(event, message);
        return true;
      }

      // Schedule exponential backoff: 2^attempt_count seconds
      const backoffSeconds = Math.pow(2, event.attempts);
      const nextAvailable = new Date(Date.now() + backoffSeconds * 1000);
      await this.db.query(
        `update outbox_events set available_at = $1 where id = $2`,
        [nextAvailable.toISOString(), event.id],
      );

      return false;  // Not fully processed; will retry
    }
  }

  private async moveToDeadLetter(
    event: OutboxEventRow,
    errorMessage: string,
  ): Promise<void> {
    try {
      await this.db.query(
        `insert into outbox_events_dead_letter
           (id, tenant_id, event_type, aggregate_type, aggregate_id,
            payload, idempotency_key, enqueued_at, attempts, last_error)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          event.id,
          event.tenant_id,
          event.event_type,
          event.aggregate_type,
          event.aggregate_id,
          JSON.stringify(event.payload),
          event.idempotency_key,
          event.enqueued_at,
          event.attempts,
          errorMessage,
        ],
      );
      
      // Soft-delete from main table (mark processed to stop retrying)
      await this.db.query(
        `update outbox_events set processed_at = now() where id = $1`,
        [event.id],
      );
      
      this.log.warn(
        `moved event ${event.id} to dead-letter after ${event.attempts} attempts`,
      );
    } catch (err) {
      this.log.error(
        `failed to move event ${event.id} to dead-letter: ${(err as Error).message}`,
      );
    }
  }

  private async purgeProcessed(): Promise<void> {
    await this.db.query(
      `delete from outbox_events
        where processed_at is not null
          and processed_at < now() - ($1 || ' days')::interval`,
      [this.purgeAfterDays.toString()],
    );
  }

  private async warnOnDeadLetter(): Promise<void> {
    const r = await this.db.queryOne<{ count: string }>(
      `select count(*)::text as count from outbox_events_dead_letter
        where moved_to_dead_letter_at > now() - interval '1 hour'`,
    );
    const n = Number(r?.count ?? '0');
    if (n > 0) {
      this.log.warn(
        `outbox dead-letter: ${n} events in last hour; ` +
        `select id, event_type, last_error from outbox_events_dead_letter ` +
        `order by moved_to_dead_letter_at desc limit 10;`,
      );
    }
  }
}

interface OutboxEventRow {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  enqueued_at: Date;
  processed_at: Date | null;
  attempts: number;
  last_error: string | null;
}
```

### 3.2 Handler Registry

```typescript
// apps/api/src/modules/outbox/outbox-handler.registry.ts

import { Injectable, Logger } from '@nestjs/common';

export interface OutboxHandler<T = unknown> {
  handle(event: OutboxEventWithPayload<T>): Promise<void>;
}

export interface OutboxEventWithPayload<T = unknown> {
  id: string;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: T;
  idempotency_key: string;
  enqueued_at: Date;
}

@Injectable()
export class OutboxHandlerRegistry {
  private readonly log = new Logger(OutboxHandlerRegistry.name);
  private readonly handlers = new Map<string, OutboxHandler>();

  /**
   * Register a handler for a specific event_type.
   * @param eventType e.g. 'booking.compensation_required'
   * @param handler The handler instance
   */
  register(eventType: string, handler: OutboxHandler): void {
    if (this.handlers.has(eventType)) {
      this.log.warn(`handler for event_type ${eventType} already registered; replacing`);
    }
    this.handlers.set(eventType, handler);
  }

  /**
   * Get a handler by event_type. Returns null if not registered.
   * Handlers are responsible for parsing the event's payload.
   */
  get(eventType: string): OutboxHandler | null {
    return this.handlers.get(eventType) ?? null;
  }
}
```

---

## 4. Event Taxonomy

Initial event types for Phase 6:

| Event Type | Aggregate | Payload | Handler | Replaces |
|---|---|---|---|---|
| `booking.create_attempted` | booking | `{ services: ServiceGroup[], requestId: string }` | `BookingCompensationHandler` | (new; enables durable compensation) |
| `booking.compensation_required` | booking | `{ originalError: string, serviceGroups: ServiceGroup[] }` | `BookingCompensationHandler` | `InProcessBookingTransactionBoundary` |
| `booking.compensation_failed` | booking | `{ rpcError: string, bookingId: string }` | (audit only) | (audit logging) |
| `setup_work_order.create_required` | order_line_item | `{ triggerId: string, lineItemId: string, ... }` | `SetupWorkOrderHandler` | `SetupWorkOrderTriggerService.triggerMany` |
| `sla_timer.create_required` | ticket | `{ slaPolicyId: string, ticketId: string, responseMins: number?, resolutionMins: number? }` | `SlaTimerHandler` | `SlaService.startTimers` |
| `notification.send_required` | entity | `{ type: string, recipient: string, context: object }` | `NotificationHandler` | Pre-existing best-effort |
| `escalation.fire_required` | ticket | `{ escalationId: string, ticketId: string, threshold: string }` | `EscalationHandler` | (future) |

---

## 5. Migration Strategy

### 5.1 Cutover Order (Easiest to Hardest)

1. **SLA timer creation** — purely additive; no existing state change; lowest risk
   - `SlaService.startTimers` → emit `sla_timer.create_required` instead of inline insert
   - Existing inline insert wrapped in feature flag `FEATURE_SLA_TIMERS_OUTBOX`

2. **Setup work-order trigger** — idempotent by design; safe fire-and-forget
   - `SetupWorkOrderTriggerService.triggerMany` → emit instead of direct call
   - Existing service + feature flag

3. **Notifications** — already best-effort; no behavior change
   - Existing notification service → emit via outbox
   - Handler calls the real notification service

4. **Booking compensation** — critical path; requires validation that outbox + handler work correctly
   - `InProcessBookingTransactionBoundary` replaced by `BookingCompensationHandler` + outbox event
   - Feature flag `FEATURE_BOOKING_COMPENSATION_OUTBOX`
   - Full smoke test coverage before flag flip

### 5.2 Feature Flags

```typescript
// apps/api/src/common/config/feature-flags.ts

export const FEATURE_FLAGS = {
  // Phase 6: outbox infrastructure
  SLA_TIMERS_OUTBOX: process.env.FEATURE_SLA_TIMERS_OUTBOX === 'true',
  SETUP_WORK_ORDER_OUTBOX: process.env.FEATURE_SETUP_WORK_ORDER_OUTBOX === 'true',
  BOOKING_COMPENSATION_OUTBOX: process.env.FEATURE_BOOKING_COMPENSATION_OUTBOX === 'true',
  NOTIFICATIONS_OUTBOX: process.env.FEATURE_NOTIFICATIONS_OUTBOX === 'true',
};
```

Per-event feature flag allows independent cutover:

```typescript
// In booking-flow.service.ts
if (FEATURE_FLAGS.BOOKING_COMPENSATION_OUTBOX) {
  await this.outbox.emitTx(client, {
    eventType: 'booking.compensation_required',
    // ...
  });
} else {
  // Old: InProcessBookingTransactionBoundary.runWithCompensation
  // ...
}
```

---

## 6. Idempotency

### 6.1 Key Format

Per event type:

- **Booking compensation:** `booking.compensation_required:<booking_id>:<request_id>`
- **Setup work-order:** `setup_work_order.create_required:<line_item_id>:<request_id>`
- **SLA timer:** `sla_timer.create_required:<ticket_id>:<policy_id>:<timer_type>`
- **Notification:** `notification.send_required:<recipient>:<event_id>:<attempt>`

The producer MUST include a stable operation ID (request ID, correlation ID, etc.) so re-running the same request emits with the same key.

### 6.2 Handler Idempotency Contract

Handlers MUST be idempotent: re-running the same event multiple times must produce the same observable result. Strategies:

1. **Upsert logic:** `insert ... on conflict do nothing` (e.g., SLA timer creation)
2. **Idempotency token in child table:** when creating a ticket, include the outbox event's `id` in the ticket's row so a retry can SELECT to verify it already exists
3. **No side effects outside the database:** if a handler sends a Slack message, it MUST store proof of delivery in the DB so a retry can check before re-sending
4. **Soft idempotency:** for operations like "send notification," include a dedup-token in the notification payload so the recipient's consumer (webhook handler, etc.) can deduplicate on their end

### 6.3 Test Pattern

```typescript
// apps/api/src/modules/outbox/handlers/__tests__/sla-timer.handler.spec.ts

describe('SlaTimerHandler', () => {
  it('should be idempotent: re-processing the same event is a no-op', async () => {
    const event = {
      id: 'event-1',
      tenant_id: 'tenant-1',
      event_type: 'sla_timer.create_required',
      aggregate_id: 'ticket-1',
      payload: { slaPolicyId: 'policy-1', responseMins: 120 },
      idempotency_key: 'sla_timer.create_required:ticket-1:policy-1:response',
    };

    // First run
    await handler.handle(event);
    const timersAfter1 = await db.query(
      `select count(*) from sla_timers where idempotency_key = $1`,
      [event.idempotency_key],
    );
    expect(timersAfter1.rows[0].count).toBe(1);

    // Second run (duplicate event — should be no-op)
    await handler.handle(event);
    const timersAfter2 = await db.query(
      `select count(*) from sla_timers where idempotency_key = $1`,
      [event.idempotency_key],
    );
    expect(timersAfter2.rows[0].count).toBe(1);  // Still 1, not 2
  });
});
```

---

## 7. Observability

### 7.1 Metrics

Emit via a metrics client (e.g., Prometheus via `prom-client`):

```typescript
// apps/api/src/modules/outbox/outbox.metrics.ts

import { Counter, Histogram } from 'prom-client';

export const outboxMetrics = {
  eventsEmitted: new Counter({
    name: 'outbox_events_emitted_total',
    help: 'Total events emitted to outbox',
    labelNames: ['event_type', 'tenant_id'],
  }),

  eventsDrained: new Counter({
    name: 'outbox_events_drained_total',
    help: 'Total events drained from outbox',
    labelNames: ['event_type', 'status'],  // status: success, failed, dead_letter
  }),

  processingLatency: new Histogram({
    name: 'outbox_event_processing_seconds',
    help: 'Time to process an event from emit to processed_at',
    labelNames: ['event_type'],
    buckets: [0.1, 0.5, 1, 5, 10],
  }),

  deadLetterCount: new Counter({
    name: 'outbox_dead_letter_events_total',
    help: 'Events moved to dead-letter',
    labelNames: ['event_type', 'reason'],
  }),
};
```

### 7.2 Admin Dashboard Endpoints

Future (Phase 6 follow-up) — at minimum:

- `GET /admin/outbox/events` — list pending events, filterable by event_type, tenant, status
- `GET /admin/outbox/dead-letter` — list dead-letter events
- `POST /admin/outbox/events/:id/retry` — force retry of a dead-letter event
- `POST /admin/outbox/events/:id/cancel` — mark as processed to stop retrying
- `POST /admin/outbox/events/:id/replay` — requeue for processing

### 7.3 Logging

```typescript
// In OutboxWorker and handlers

this.log.debug(`event ${event.id} enqueued (${event.event_type})`);
this.log.debug(`processed event ${event.id} (${event.event_type})`);
this.log.warn(`event ${event.id} handler failed (attempt ${event.attempts}): ${message}`);
this.log.error(`moved event ${event.id} to dead-letter after ${event.attempts} attempts`);
```

---

## 8. Backward Compatibility & Cutover

### 8.1 Dual Emission (Old + New)

During migration, services emit to BOTH the outbox and the old path:

```typescript
// In booking-flow.service.ts

// New: emit to outbox
if (FEATURE_FLAGS.BOOKING_COMPENSATION_OUTBOX) {
  await this.outbox.emitTx(client, { /* ... */ });
}

// Old: in-process compensation (still runs for observability/rollback)
// This is only for backward compatibility; handlers are the source of truth
```

### 8.2 Validation

Before flipping a feature flag to `true`:

1. **Functional equivalence:** in a staging environment, run with both paths enabled and verify old + new produce identical results (logs, DB state, user-visible behavior)
2. **Load test:** run the handler under production-like load; measure latency, error rate
3. **Smoke test:** existing smoke test from Phase 1 still passes
4. **Dead-letter monitor:** deploy with the flag on; monitor dead-letter for 1+ business day; should be zero entries

### 8.3 Rollback Plan

If a flag flip reveals a bug:

1. Set `FEATURE_FLAG_*=false` to re-enable the old path
2. Restart the worker
3. Events already in outbox will be dead-lettered (they won't match any handler). Move them to a quarantine table for manual review.
4. The old code path remains safe since it was never disabled.

---

## 9. Failure Modes & Robustness

### 9.1 Worker Crash Mid-Batch

**Mechanism:** Claim token + stale-claim recovery (cite: audit-outbox.worker.ts:56-64)

1. Worker claims N rows with `claim_token = <worker_uuid>`
2. Worker crashes before `processed_at` update
3. Next worker sweep (after 5 min) sees `claimed_at < now() - 5min` and reclaims
4. Retry processing from the start (idempotency ensures safety)

**Tested by:** OutboxWorker unit test: claim a batch, simulate crash, verify next sweep reclaims

### 9.2 Business Write Succeeds; Outbox Emit Fails (Transactional Emit Only)

**Mechanism:** Transaction isolation

If using `emitTx(client, ...)` inside a transaction:
- Emit fails → exception thrown → caller's transaction rolls back → both business write + outbox emit roll back
- Both succeed or both fail

If using `emit(...)` outside a transaction:
- Business write succeeds
- Outbox emit fails (network, disk, etc.)
- Logged but not thrown; business transaction is not affected
- Result: work was done but the event wasn't queued
- **Mitigated by:** the original code path (SetupWorkOrderTriggerService, SlaService) still runs in parallel (feature flag), so the work eventually happens

### 9.3 Handler Fails Mid-Execution

**Mechanism:** Exponential backoff + max attempts + dead-letter

1. Handler throws on first attempt
2. Worker catches, increments attempts, sets `available_at` to 2^attempts seconds in future
3. On next sweep, worker skips the row (available_at > now())
4. After MAX_ATTEMPTS, row moves to dead-letter
5. Ops query dead-letter, investigate, trigger manual retry or cancel

### 9.4 Database Constraint Violation (Duplicate Key, etc.)

**Mechanism:** Handler must check before insert, or use `on conflict do nothing`

```typescript
// Example: SlaTimerHandler
await this.db.query(
  `insert into sla_timers (...)
   values (...) 
   on conflict (ticket_id, timer_type, sla_policy_id) do nothing`,
);
```

If a duplicate is detected, the insert is a no-op (idempotent). Handler returns success.

### 9.5 Tenant Isolation Violation

**Mechanism:** RLS on outbox_events + tenant_id field in every handler

Handlers query tenant-scoped tables. If a producer emits with the wrong tenant_id, RLS will reject the handler's insert. Move to dead-letter + ops investigates.

---

## 10. Test Infrastructure

### 10.1 Unit Tests

Each handler:

```typescript
// apps/api/src/modules/outbox/handlers/__tests__/booking-compensation.handler.spec.ts

describe('BookingCompensationHandler', () => {
  let handler: BookingCompensationHandler;
  let supabase: jest.Mocked<SupabaseService>;
  let outbox: jest.Mocked<OutboxService>;

  beforeEach(() => {
    supabase = mock(SupabaseService);
    outbox = mock(OutboxService);
    handler = new BookingCompensationHandler(supabase, outbox);
  });

  it('should call delete_booking_with_guard RPC', async () => {
    const event = {
      id: 'event-1',
      tenant_id: 'tenant-1',
      aggregate_id: 'booking-1',
      payload: { /* ... */ },
    };

    supabase.admin.rpc.mockResolvedValue({ data: { kind: 'rolled_back' }, error: null });

    await handler.handle(event);

    expect(supabase.admin.rpc).toHaveBeenCalledWith('delete_booking_with_guard', {
      p_booking_id: 'booking-1',
      p_tenant_id: 'tenant-1',
    });
  });

  it('should emit compensation_failed on RPC error', async () => {
    const event = { /* ... */ };
    supabase.admin.rpc.mockResolvedValue({ 
      data: null, 
      error: { message: 'RPC failed' } 
    });

    await handler.handle(event);

    expect(outbox.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'booking.compensation_failed',
        aggregate_id: 'booking-1',
      })
    );
  });
});
```

### 10.2 Integration Tests

```typescript
// apps/api/src/modules/outbox/__tests__/outbox.integration.spec.ts

describe('OutboxWorker (integration)', () => {
  let db: DbService;
  let worker: OutboxWorker;
  let registry: OutboxHandlerRegistry;

  beforeEach(async () => {
    // Real DB (test container), real worker
    db = testModule.get(DbService);
    worker = testModule.get(OutboxWorker);
    registry = testModule.get(OutboxHandlerRegistry);

    // Register a test handler
    registry.register('test.event', {
      handle: async (event) => {
        await db.query(`insert into test_table (id) values ($1)`, [event.id]);
      },
    });
  });

  it('should drain and process a batch of events', async () => {
    // Emit 3 events
    await db.query(
      `insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload, idempotency_key)
       values ($1, $2, $3, $4, $5, $6)`,
      ['tenant-1', 'test.event', 'test', 'agg-1', '{}', 'key-1'],
    );
    // ... 2 more

    // Run drain
    const drained = await worker.drainOnce();
    expect(drained).toBe(3);

    // Verify handler executed
    const rows = await db.query(`select count(*) from test_table`);
    expect(rows.rows[0].count).toBe(3);

    // Verify events marked processed
    const processed = await db.query(
      `select count(*) from outbox_events where processed_at is not null`,
    );
    expect(processed.rows[0].count).toBe(3);
  });

  it('should dead-letter on max attempts exceeded', async () => {
    registry.register('fail.event', {
      handle: async () => {
        throw new Error('Always fails');
      },
    });

    await db.query(
      `insert into outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload, idempotency_key, attempts)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      ['tenant-1', 'fail.event', 'test', 'agg-1', '{}', 'key-1', 5],  // Already 5 attempts
    );

    await worker.drainOnce();

    const deadLetter = await db.query(
      `select count(*) from outbox_events_dead_letter`,
    );
    expect(deadLetter.rows[0].count).toBe(1);
  });
});
```

### 10.3 Stress Test

Load 1000 events into outbox; run worker; verify all processed exactly once:

```bash
# apps/api/scripts/outbox-stress-test.mjs

const count = 1000;
const events = Array.from({ length: count }, (_, i) => [
  `tenant-1`,
  `test.event`,
  `test`,
  `agg-${i}`,
  JSON.stringify({}),
  `key-${i}`,
]);

await db.from('outbox_events').insert(events);

// Start worker
const drained = await worker.drainOnce();
console.log(`Drained ${drained} of ${count}`);

// Verify
const processed = await db.query(
  `select count(*) from outbox_events where processed_at is not null`,
);
const deadLetter = await db.query(
  `select count(*) from outbox_events_dead_letter`,
);

assert(processed.rows[0].count === count, 'All events processed');
assert(deadLetter.rows[0].count === 0, 'No dead-letter');
```

---

## 11. Open Questions for Implementation (Phase 6+)

1. **Multi-tenant prioritization:** Should slow handlers in one tenant block others? Recommend: per-tenant queue separation in the worker (future optimization).

2. **Tenant-aware partitioning:** For high-volume tenants, should outbox_events be partitioned by tenant_id? Recommend: defer to Phase 7 (ops optimization).

3. **Long-running handlers (>30s):** Should they checkpoint progress or report heartbeat? Recommend: current design handles these via `available_at` backoff; handlers that consistently timeout should be split into smaller units.

4. **Cross-region replication:** If Vercel deployment spans regions, how does outbox data replicate? Recommend: at implementation time, Supabase replication + RLS handle this transparently; no special design needed.

5. **Handler registration:** Should handlers auto-register via decorators, or explicit map? Recommend: explicit map (OutboxHandlerRegistry) for clarity; decorators are premature.

6. **Event versioning:** If event payload schema evolves, how do handlers adapt? Recommend: minor version in event_type (e.g., `booking.compensation_required.v2`); old handlers continue processing v1; new handlers process both.

7. **Webhook delivery:** Should webhooks go through outbox or a separate queue? Recommend: route through outbox with a dedicated `webhook.deliver_required` event type; same durability guarantees.

---

## 12. File Locations & Citations

### Domain Outbox Schema
- Migration: `supabase/migrations/00XXX_domain_outbox.sql` (next sequential #)
- Model: `audit_outbox` pattern (migration `00161:12-50`)

### TypeScript Services
- `apps/api/src/modules/outbox/outbox.service.ts` — producer API
- `apps/api/src/modules/outbox/outbox.worker.ts` — drain loop (model: `audit-outbox.worker.ts:20-166`)
- `apps/api/src/modules/outbox/outbox-handler.registry.ts` — handler dispatch
- `apps/api/src/modules/outbox/handlers/*.handler.ts` — one per event type

### Handlers (migrate existing services)
- `apps/api/src/modules/reservations/handlers/booking-compensation.handler.ts` (replaces logic in `booking-transaction-boundary.ts`)
- `apps/api/src/modules/service-routing/handlers/setup-work-order.handler.ts` (replaces `setup-work-order-trigger.service.ts`)
- `apps/api/src/modules/sla/handlers/sla-timer.handler.ts` (replaces inline in `sla.service.ts:73-125`)
- `apps/api/src/modules/notification/handlers/notification.handler.ts` (wraps existing NotificationService)

### Tests
- `apps/api/src/modules/outbox/__tests__/outbox.worker.spec.ts`
- `apps/api/src/modules/outbox/__tests__/outbox.integration.spec.ts`
- `apps/api/src/modules/outbox/handlers/__tests__/*.spec.ts` (one per handler)

### Existing References
- Audit outbox service: `apps/api/src/modules/privacy-compliance/audit-outbox.service.ts:20-89` — emitTx pattern
- Audit outbox worker: `apps/api/src/modules/privacy-compliance/audit-outbox.worker.ts:35-166` — drain + retry + dead-letter logic
- Booking compensation: `apps/api/src/modules/reservations/booking-transaction-boundary.ts:82-158` — failure mode reference
- SLA timers: `apps/api/src/modules/sla/sla.service.ts:73-125` — inline post-commit pattern to replace
- Setup work-order: `apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts:40-153` — best-effort trigger to replace

---

## 13. Success Criteria

**Phase 6 is complete when:**

1. ✅ Schema migration applied to remote Supabase (01 SQL file + notify pgrst)
2. ✅ `OutboxService` + `OutboxWorker` + handler registry implemented + unit tested
3. ✅ All 7 initial event types + handlers implemented + integration tested
4. ✅ Feature flags for each event type configured (all `false` by default)
5. ✅ Smoke test from Phase 1 still passes (backward compat verified)
6. ✅ One feature flag enabled in staging; 24-hour burn-down with zero dead-letter
7. ✅ This spec document reviewed + approved

**Phase 6 Implementation (future) will:**

1. Migrate each service to emit via outbox (per §5.1 order)
2. Implement handlers to replace old code paths
3. Feature-flag each migration independently
4. Validate equivalence before flipping flags to `true`
5. Remove old code once all flags are `true` (Phase 7+)

---

## Appendix: Design Rationale

### Why a Single `outbox_events` Table?

- **Operational simplicity:** One worker drain, one index, one RLS policy
- **Event type is soft routing:** new types don't require schema changes
- **Matches audit pattern:** `audit_outbox` uses the same single-table design (migration 00161)
- **Multi-tenant scale:** tenant_id + (processed_at, available_at) index scales to millions of rows per tenant

### Why Idempotency Keys Are Mandatory for Critical Events?

- **At-least-once delivery:** outbox + exponential backoff means handlers may run multiple times
- **Observable idempotence:** deterministic key (event_type + aggregate_id + operation_id) allows re-emitting the same request
- **Dedup via unique constraint:** `on conflict (idempotency_key) do nothing` in Postgres is atomic + race-safe

### Why Feature Flags During Migration?

- **Dual validation:** old + new code run in parallel; verify they produce identical results
- **Staged rollout:** one event type at a time; easy to rollback if a bug emerges
- **Zero downtime:** feature flag flip is a config change; no restart required (though monitor + eventually restart for safety)

### Why Separate Dead-Letter Table?

- **Query performance:** main table stays narrow; dead-letter is write-once, rarely queried
- **Operational clarity:** ops can query dead-letter independently; separate retention policy
- **Audit trail:** dead-letter rows are historical; never deleted (or deleted via separate purge job)

---

## Document Version

- v1.0 — 2026-05-04
- Status: DESIGN (not implemented; investigation + spec only)
- Next step: Phase 6 implementation + hands-on handler coding
