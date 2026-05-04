# Domain Outbox Design Specification — Plan B.1 (v6)

> **Authored:** 2026-05-04
> **Phase:** 6 (Durable Infrastructure)
> **Scope:** Investigation + Design only. No implementation code beyond this spec.

---

## Revision history

- **v1** (commit `f5b96c5`, superseded): proposed a TS-side `OutboxService.emitTx(client)` claiming to share a transaction with the business write. Foundational mismatch — `BookingFlowService.create` calls `supabase.admin.rpc('create_booking', ...)`, which is a PostgREST HTTP call on its own PgBouncer-pooled connection, not the API process's `pg.PoolClient`. No shared transaction exists; v1's atomicity claim was unsatisfiable. Also: cross-tenant idempotency, mis-ordered cutover, RLS-as-defense for service-role workers.
- **v2** (commit `b38db4a`, superseded): moved atomicity into Postgres. Producers emit via row triggers or via an `outbox.emit(...)` SQL helper called from inside an RPC, in the same transaction as the business write. TS-side `OutboxService.emit()` reframed as fire-and-forget. Folded 5 criticals + 5 importants from v1.
- **v3** (commit `83f3ba0`, superseded): introduced a watchdog/lease pattern with a 30s destructive timeout. `create_booking()` emitted `booking.create_attempted` with a 30s lease; the success path consumed the lease via `outbox.mark_consumed`; the crash path was recovered by a watchdog handler that fired after the lease expired. Codex flagged a known false-compensation path: a slow attach (>30s) gets falsely compensated by the watchdog, then `mark_services_attached` throws and the user sees a 500.
- **v4** (commit `2c564f4`, superseded): replaced v3's destructive lease with **A-prime atomic attach**. TS kept the rule resolver / approval routing as a *plan-building* preflight; the WRITE phase became `attach_services_to_booking(p_plan jsonb)`. `delete_booking_with_guard` was amended to lock + re-check (`already_gone` / `already_attached`); the lease window was widened to 5 min and made GUC-configurable. Codex flagged 4 criticals on v4: **C1** GUC-based lease config doesn't reliably carry across PostgREST-pooled connections; **C2** the slow-preflight window between `create_booking` returning and the attach RPC starting can outlive the lease (TS preflight can take 10+ seconds on cold caches, and the lease only starts ticking inside the booking insert); **C3** operation idempotency is incomplete (a TS retry that rebuilds the plan with fresh UUIDs bypasses the per-UUID dedup); **C4** the FK validation matrix in §X.3 only listed catalog/asset/menu/cost_center/person — missing requester_person_id on orders, fulfillment_team_id and vendor_id on OLIs, host_person_id and attendee_person_ids on the booking, and approver_team_id on approvals.
- **v5** (commit `48048f6`, superseded): collapse the booking + services split write into ONE atomic RPC: `create_booking_with_attach_plan(booking_input, attach_plan, idempotency_key, tenant_id)`. TS keeps rule resolver + approval routing as plan-building (pure-SQL conversion isn't worth the cost — see §7.5). RPC takes the built plan and writes booking + slots + orders + asset_reservations + OLIs + approvals + outbox emissions in a single transaction. The `attach_operations` table provides retry idempotency. **No watchdog. No lease. No `booking.create_attempted` event.** Atomic = nothing to compensate. The outbox foundation stays for genuinely async durable work (setup work orders, SLA timers, notifications, escalations); the first cutover becomes setup-WO emitted atomically from inside the combined RPC, NOT best-effort post-commit. v5 dropped v4-C1 (GUC) and v4-C2 (preflight window) entirely as failure modes; folded v4-C3 (operation idempotency via `attach_operations`); folded v4-C4 (exhaustive FK matrix in §8); folded v4-I1/I3 (separate forced-probe mode for staging; no silent `mark_consumed=false`); folded v4-I2 (`approvals[].id` pre-generated TS-side along with every other UUID).
- **v6** (this revision): folds 4 criticals + 3 importants + 1 nit from the codex v5 review. Headline corrections: **(C1)** every plan UUID — booking, slots, orders, OLIs, asset_reservations, approvals — is now derived from `uuidv5(idempotency_key, row_kind, stable_index, NS_PLAN)` instead of `crypto.randomUUID()`. The previous random scheme defeated the very `attach_operations` mechanism v5 introduced, because a TS retry that rebuilt the plan with fresh UUIDs would hash to a different `payload_hash` and trip `payload_mismatch` instead of returning `cached_result`. **(C2)** the combined RPC takes a transaction-scoped `pg_advisory_xact_lock` keyed on `(tenant_id, idempotency_key)` *before* it reads `attach_operations`. v5's `SELECT FOR UPDATE` couldn't see uncommitted in-progress rows, so two racing retries both passed the gate and both `INSERT`-ed the marker — second got `23505` instead of cached_result. **(C3)** `SetupWorkOrderTriggerService` gains a strict-mode sibling (`triggerStrict`) that throws transient errors and returns typed terminal outcomes. The outbox handler calls `triggerStrict`, so transient DB failures retry through the worker instead of being swallowed by the legacy `trigger`'s outer try/catch. **(C4)** the approval-grant deferred-setup path (`bundle.service.ts:1523` calling `setupTrigger.triggerMany` directly) is replaced by a new `approve_booking_setup_trigger(p_oli_ids, p_tenant_id)` RPC that reads `pending_setup_trigger_args`, emits `setup_work_order.create_required` to outbox, and clears the args — all in one transaction. Approval grant becomes durable end-to-end. Folds **(I1)** `setup_work_order_emissions` dedup table replacing the racy `work_orders.linked_order_line_item_id` lookup; **(I2)** internal-graph FK validation helper alongside the tenant-FK matrix; **(I3)** drops `failed` and stale `in_progress` from the `attach_operations.outcome` enum (the marker insert lives inside the RPC tx — failures roll the row back, so persistent `failed` state was never produced); **(N1)** strips `OutboxService.markConsumed` and the `booking.create_attempted` references from `outbox.service.ts` (already retired from spec; implementation file lagged).

---

## 1. Architectural rule (NON-NEGOTIABLE)

> **Atomic outbox events MUST be created inside Postgres, in the same transaction as the business write.**
> **State changes that an outbox event represents MUST also be made in the same transaction (no split write).**
> **A user-visible command that requires N row writes to be correct MUST commit those N writes as one transaction. The outbox is for durable async work, not for repairing a split write that can be removed.**

The first half (event + write atomic) was settled in v2/v3. The second half was added in v4. The third half is new in v5 and is the headline correction over v4: a "split write" — TS does part of the work, then asks Postgres to mark it done — was the failure pattern v3's destructive lease tried to paper over and v4's locked re-check tried to serialise around. v5 removes the split.

Two acceptable mechanisms for emitting events:

1. **Row-lifecycle triggers** — `AFTER INSERT`/`AFTER UPDATE` on a domain table emits when the event truly is "this row reached state X." Same transaction as the writing statement.
2. **`outbox.emit(...)` helper called from inside an RPC** — when the payload carries semantic content the row alone doesn't capture. SECURITY INVOKER PL/pgSQL function called from inside another PL/pgSQL function (e.g. `create_booking_with_attach_plan`) that is itself running in a Postgres transaction.

**Excluded**: a TS-side `emitTx(client, ...)` pretending to share a transaction with a PostgREST RPC; generic per-table CDC firehose triggers; **split writes where TS performs side-effects and Postgres only stamps a "done" flag at the end**; lease/watchdog patterns used to "recover" a split write that can be collapsed into one transaction.

**TS-side `OutboxService.emit()`** survives only as a fire-and-forget post-commit helper for best-effort operations (notifications, webhook delivery hints) — operations where loss is bad UX, not corruption. **Setup work orders are NOT in this category.** See §7.6 + §10.

---

## 2. Schema

### 2.1 `outbox.events`

Foundation already shipped in `supabase/migrations/00299_outbox_foundation.sql` with the `outbox.events` + `outbox.events_dead_letter` + `outbox_shadow_results` tables, plus the `outbox.emit()` and `outbox.mark_consumed()` helpers. v5 keeps the foundation unchanged. The `available_at` column is still useful for genuine deferred work (retry backoff, scheduled emissions like SLA timer creation that fires N seconds after a window ends) — it's just no longer used as a destructive lease.

```sql
-- supabase/migrations/00299_outbox_foundation.sql (already shipped, unchanged)

create table if not exists outbox.events (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,

  event_type          text        not null,
  event_version       int         not null default 1,
  aggregate_type      text        not null,
  aggregate_id        uuid        not null,

  payload             jsonb       not null default '{}'::jsonb,
  payload_hash        text        not null,
  idempotency_key     text        not null,

  enqueued_at         timestamptz not null default now(),
  available_at        timestamptz not null default now(),
  processed_at        timestamptz,
  processed_reason    text,
  claim_token         uuid,
  claimed_at          timestamptz,
  attempts            int         not null default 0,
  last_error          text,
  dead_lettered_at    timestamptz,

  constraint outbox_events_attempts_nonneg check (attempts >= 0),
  constraint outbox_events_idem_unique unique (tenant_id, idempotency_key)
);
```

(Indexes, comments, RLS, dead-letter table, shadow results, grants — all already shipped in 00299. See the file for the full body.)

### 2.2 `outbox.emit()` helper (canonical producer; unchanged from foundation)

`outbox.emit(p_tenant_id, p_event_type, p_aggregate_type, p_aggregate_id, p_payload, p_idempotency_key, p_event_version, p_available_at)`. SECURITY INVOKER. Same-key/same-payload returns the existing id; same-key/different-payload raises 23505. Already shipped in 00299:132-196. v5 calls this from inside `create_booking_with_attach_plan` for setup-WO emissions (§7.6).

### 2.3 `outbox.mark_consumed()` — DROPPED FROM STEADY-STATE USE IN V5

The helper still exists in 00299 (it's harmless and may be useful for future deferred-work flows where a producer pre-creates a row and a separate path consumes it). But **no v5 producer or handler calls `mark_consumed` on the booking creation path** — the lease/watchdog pattern that needed it is gone. The helper stays in the schema as a dormant primitive; we'll re-evaluate when (if) a future event type genuinely needs lease consumption.

### 2.4 `attach_operations` — operation idempotency (NEW in v5; refined in v6)

The combined RPC commits everything as one transaction, but a TS retry can still call the RPC twice with the same business intent (e.g. network blip on the response, the user retries). v5 introduced a tenant-scoped operation table that the RPC locks at the very start and updates at the very end. **v6 simplifies the outcome contract — see "v6 change: drop `failed` and stale `in_progress`" below.**

```sql
-- supabase/migrations/00302_attach_operations.sql (NEW in v5; v6 contract)

create table public.attach_operations (
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  idempotency_key  text        not null,
  payload_hash     text        not null,
  outcome          text        not null
                     check (outcome in ('in_progress', 'success')),  -- v6: 'failed' dropped
  cached_result    jsonb,                            -- non-null when outcome='success'
  enqueued_at      timestamptz not null default now(),
  completed_at     timestamptz,
  primary key (tenant_id, idempotency_key)
);

alter table public.attach_operations enable row level security;
create policy tenant_isolation on public.attach_operations
  using (tenant_id = public.current_tenant_id());

revoke all on table public.attach_operations from public;
grant select, insert, update on table public.attach_operations to service_role;

comment on table public.attach_operations is
  'Operation-level idempotency for create_booking_with_attach_plan (§7 of the outbox spec). One row per (tenant_id, idempotency_key). The combined RPC takes a pg_advisory_xact_lock keyed on the same pair, then SELECTs the row, INSERTs an in_progress marker if absent, and UPDATEs to success+cached_result on commit. Same key + same payload_hash returns cached_result. Same key + different payload_hash raises ''attach_operations.payload_mismatch''.';
```

**v6 change: drop `failed` and stale `in_progress` from the contract.** The marker INSERT in §7.3 happens inside the combined RPC's transaction. If any subsequent statement fails, the whole tx — *including the marker* — rolls back. There is no execution path that produces a persistent `failed` row, and no path that produces a `in_progress` row that outlives the RPC's tx. The v5 prose around "stale in_progress means crashed RPC; nightly cron purges rows >5 min old" was describing a state that never materialises. v6 removes:
- `'failed'` from the `outcome` CHECK constraint
- The `error_message` column (only relevant to a state we never reach)
- The `attach_operations_in_progress` partial index (no rows for it to filter)
- The nightly purge cron documented in v5 §13.2

A failure inside the RPC raises an exception; Postgres rolls the transaction back; the row vanishes. A future retry with the same key sees an empty `attach_operations` and starts fresh — exactly the desired behaviour. For ops visibility into failures, the call site emits a structured log entry (and, where the failure is meaningful, an `audit_events` row) *outside* the rolled-back transaction; we don't try to make the rolled-back marker a persistent failure record.

**Why not just `INSERT ... ON CONFLICT DO NOTHING`?** Because we need to detect two distinct states: (a) no prior row OR rolled-back tx → start work; (b) existing successful row with same payload_hash → return cached result. ON CONFLICT collapses (a)+(b). Same key + different payload_hash also needs a distinct error path (`payload_mismatch`) that ON CONFLICT can't express.

### 2.5 `setup_work_order_emissions` — handler-side dedup (NEW in v6 — folds I1)

The setup-WO handler needs durable dedup so that re-handling the same outbox event is a no-op. v5 §7.7 used `select id from work_orders where linked_order_line_item_id = event.aggregate_id` as the dedup mechanism. Codex flagged that as racy: the index on `tickets.linked_order_line_item_id` is non-unique (`supabase/migrations/00145_tickets_bundle_columns.sql:12` — `idx_tickets_oli`, partial, **not** unique), and a stale-claim replay between two concurrent handler runs could produce two work orders. Closing the WO and replaying the event would also slip past the active-status filter and re-create.

v6 introduces an explicit dedup table:

```sql
-- supabase/migrations/00304_setup_work_order_emissions.sql (NEW in v6)

create table public.setup_work_order_emissions (
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  oli_id           uuid        not null,
  work_order_id    uuid        not null references public.tickets(id) on delete cascade,
  outbox_event_id  uuid        not null,                -- audit pointer; fk soft to outbox.events
  created_at       timestamptz not null default now(),
  primary key (tenant_id, oli_id)
);

create index setup_work_order_emissions_wo
  on public.setup_work_order_emissions (work_order_id);

alter table public.setup_work_order_emissions enable row level security;
create policy tenant_isolation on public.setup_work_order_emissions
  using (tenant_id = public.current_tenant_id());

revoke all on table public.setup_work_order_emissions from public;
grant select, insert on table public.setup_work_order_emissions to service_role;

comment on table public.setup_work_order_emissions is
  'Handler-side dedup for setup_work_order.create_required outbox events (§9 of the outbox spec). Primary key (tenant_id, oli_id) — at most one setup WO is emitted per OLI for the lifetime of the row. SELECT FOR UPDATE in the handler before triggerStrict; INSERT in the same tx as the WO create. Survives WO close/cancel and event replay.';
```

Handler logic (full version in §9.2):

1. `SELECT FOR UPDATE` on `setup_work_order_emissions` for `(event.tenant_id, event.aggregate_id)`.
2. If row found: idempotent re-handling — return success. Optionally include `work_order_id` in the success log for ops correlation. Even if that work order has since been cancelled or closed, we MUST NOT emit a fresh one — the booking lifecycle (cancel cascade) is responsible for end-of-line cleanup, not the outbox handler.
3. If no row: call `triggerStrict()`.
4. On `kind: 'created'`: INSERT into `setup_work_order_emissions` *in the same tx* as the WO create (the trigger service's WO insert tx). The dedup row commits with the WO or rolls back with it.
5. On `kind: 'no_op_terminal'` (e.g. routing not configured): do **not** insert into the dedup table. The handler returns success (the event is processed); a future replay will re-evaluate routing — which is the desired behaviour because admin reconfiguration between attempts should let the next replay create the WO. The terminal outcome is captured in `audit_events` (existing path) for ops visibility.
6. On throw: handler retries via the worker state machine; eventual dead-letter on max attempts.

**Why a separate table instead of a unique index on `tickets`?** Because:
- (a) WOs can be legitimately deleted (admin cleanup) without invalidating the "this event was already handled" signal. Coupling dedup to WO row existence reintroduces the replay-after-cancel hole.
- (b) The dedup row must commit *atomically with the WO insert*. A unique index on `tickets.linked_order_line_item_id` would enforce uniqueness but leak the race window between "lookup says no existing WO" and "insert says 23505" — handler then has to interpret the 23505, which is fragile. The explicit `SELECT FOR UPDATE` pattern is clearer and matches how `attach_operations` works.
- (c) `setup_work_order_emissions` carries `outbox_event_id` for ops triage. The lookup answers "was this specific event already handled?", not just "is there a WO for this OLI?".

### 2.6 SQL grants

`outbox.events` grants unchanged from 00299/00301. v5 added the combined RPC; v6 adds the approval-grant RPC:

```sql
-- supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql (NEW in v5)
grant execute on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text)
  to service_role;
revoke execute on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text)
  from authenticated;

-- supabase/migrations/00305_approve_booking_setup_trigger_rpc.sql (NEW in v6)
grant execute on function public.approve_booking_setup_trigger(uuid[], uuid)
  to service_role;
revoke execute on function public.approve_booking_setup_trigger(uuid[], uuid)
  from authenticated;
```

Both RPCs are service-role only — TS calls via `supabase.admin`. End users can still hit `BookingFlowService.create` and `BundleService.onApprovalDecided` (which check `actor.has_override_rules` etc. before calling the RPCs); they just can't reach into the RPCs directly to bypass app-layer authorization.

---

## 3. Producer API

### 3.1 The combined RPC — atomic emit + write

The two paths now in production:

| Caller need | RPC |
|---|---|
| Booking with NO services | `create_booking(...)` (00277:236, **unchanged** from canonical schema) |
| Booking WITH services | `create_booking_with_attach_plan(...)` (NEW; §7) |

The unchanged path stays for two reasons: (a) most simple bookings have no services, and the existing RPC is well-tested; (b) the standalone-order path (`OrderService.createStandaloneOrder` in `order.service.ts`) needs to attach services to a booking that may not exist yet OR may already exist — when it already exists, we don't re-create it. Splitting the two RPCs keeps each one focused.

For the WITH-services path, the combined RPC:

1. Takes a `pg_advisory_xact_lock` keyed on `(tenant_id, idempotency_key)` — serialises concurrent retries (v6-C2; see §7.3).
2. Reads `attach_operations` for the tenant + idempotency key (idempotency gate).
3. Validates every FK in both payloads against `tenant_id` (§8.1) and every internal cross-reference (§8.2).
4. Inserts the booking row + N slot rows.
5. Inserts orders, asset_reservations, OLIs, approvals.
6. Updates orders.status to `submitted | approved` based on `any_pending_approval`.
7. Emits outbox events (`setup_work_order.create_required` for each line that needs internal setup; future: `notification.send_required`, etc.).
8. Updates `attach_operations` to `success` with the cached result.

All inside one Postgres transaction. The booking's tenant_id is in the row from step 3; every subsequent insert uses the same `p_tenant_id` parameter the RPC was called with (validated against the row in §8).

**No `bookings.services_attached_at` column** — there's no longer a window during which a booking exists with services not yet attached. The booking is committed atomically with its services or not at all. The column proposed in v4 (migration 00302) is dropped from v5.

**No `booking.create_attempted` event** — there's no recovery to do.

### 3.2 TypeScript `OutboxService` — fire-and-forget emit only

```typescript
// apps/api/src/modules/outbox/outbox.service.ts
@Injectable()
export class OutboxService {
  private readonly log = new Logger(OutboxService.name);
  constructor(private readonly supabase: SupabaseService) {}

  /** Fire-and-forget emit. NOT transactional. Failures logged, never thrown.
   *  Use only where post-commit best-effort is acceptable (notifications etc).
   *  NOT for setup work orders, SLA timers, or anything where loss corrupts state. */
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

`OutboxService.markConsumed` is **dropped from the spec in v5 and from the implementation file in v6** (codex N1). The wrapper RPC `outbox_mark_consumed_via_rpc` stays in 00299 as dormant infra (cheap; future deferred-work flows may revive the lease primitive). Steady-state TS code never marks events consumed — atomic emission inside RPCs replaces lease consumption. v6 also strips the `booking.create_attempted` references from `apps/api/src/modules/outbox/outbox.service.ts:18-21` (the module-level docstring still describes the v3/v4 lease semantics that v5 retired). See §16 cleanup task.

---

## 4. Consumer / Worker

### 4.1 Drain query (unchanged from v3/v4)

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

### 4.2 Worker state machine (unchanged from v3/v4)

Every claimed event passes through exactly one of four transitions:
1. **Success** — handler returns. `set processed_at = now(), processed_reason = 'handler_ok', claim_token = null`.
2. **Retry** — handler throws non-`DeadLetterError`. `set claim_token = null, attempts = attempts + 1, available_at = now() + backoff_for(attempts), last_error = err.message`.
3. **Dead-letter** — handler throws `DeadLetterError` OR `attempts + 1 >= maxAttempts`. Insert into `outbox.events_dead_letter`; `set processed_at = now(), processed_reason = 'dead_lettered', dead_lettered_at = now()`.
4. **Stale-claim recovery** — separate sweep cron clears claims older than 60s with `processed_at IS NULL`: `set claim_token = null, claimed_at = null` (does NOT increment attempts).

Each transition guards by `claim_token = $token` so a stale-claim sweep racing the handler can't double-write.

### 4.3 Tenant context wrapping (unchanged from v3/v4)

Handlers run via `supabase.admin` (service role, bypasses RLS). The worker is not request-scoped and crosses tenants every drain. Tenant context is the explicit defense, not RLS. 30s TTL cache; positive-or-null cache; miss → `select id, slug, tier from public.tenants where id = $1`. Handlers MUST explicitly assert `aggregate.tenant_id === event.tenant_id` and dead-letter on mismatch.

### 4.4 Backoff schedule (unchanged from v3/v4)

| `attempts` | Base delay | With jitter | Realized window |
|---:|---:|---|---|
| 1 | 30s | ±10s | 20s – 40s |
| 2 | 2m | ±20s | 1m40 – 2m20 |
| 3 | 10m | ±90s | 8m30 – 11m30 |
| 4 | 1h | ±10m | 50m – 1h10m |
| 5 | dead-letter | — | — |

---

## 5. Cutover order — setup-WO FIRST, in shadow mode

v3/v4 staged the booking compensation cutover first. v5 removes booking compensation from outbox scope entirely (no compensation needed when the write is atomic). The first cutover becomes **setup work order creation**, which is the highest-value durable async event in the system: today it's a best-effort post-commit fire-and-forget call (`SetupWorkOrderTriggerService.triggerMany` from `bundle.service.ts:456`); when it fails, an audit row lands with `severity: 'high'` but no automatic retry happens. That's the failure mode the user direction explicitly called out: a missing setup work order means operational corruption (the kitchen doesn't know to prep, the AV team doesn't know to set up; the booking shows confirmed but fulfillment is silently broken).

### 5.1 Three-deploy cutover for `setup_work_order.create_required`

**Phase A — Shadow + comparison (deploy 1):** the combined RPC ships and emits `setup_work_order.create_required` events from inside the transaction, atomically with the booking + service writes (§7.6). The handler `SetupWorkOrderHandler` ships in **shadow / dry-run mode**: it loads the event, performs the routing matrix lookup, and writes a `outbox_shadow_results` row containing the WO it WOULD create — but it does NOT actually create the WO. Production WO creation continues via the existing best-effort `SetupWorkOrderTriggerService.triggerMany` post-commit call. **Gate to B**: see §5.2.

**Phase B — Activate handler (deploy 2):** handler flips from shadow to active. The existing best-effort post-commit call is removed in the same deploy. The outbox-emitted event becomes the only path. From this point forward, setup-WO creation is durable: handler crashes → retry; tenant misconfigured → audit + dead-letter.

**Phase C — Hardening (deploy 3, +14 days):** observe steady-state. If `outbox_dead_letter_total{event_type="setup_work_order.create_required"}` is non-zero, triage. If `attach_operations.outcome='failed'` count is non-zero, triage. If `setup_work_order_emissions` (§7.6) shows orphan rows (event emitted, handler never ran beyond max_attempts and dead-lettered), that's the production signal we're watching for.

### 5.2 The Phase A → Phase B gate (the I2 fold; same shape as v4 with the event renamed)

Two SQL conditions plus a forced-failure probe in CI/staging:

```sql
-- 1. Minimum sample count over 7 days
select count(*) >= 50
  from public.outbox_shadow_results
 where event_type = 'setup_work_order.create_required'
   and recorded_at > now() - interval '7 days';

-- 2. Zero mismatches over the same window
select count(*) = 0
  from public.outbox_shadow_results
 where event_type = 'setup_work_order.create_required'
   and recorded_at > now() - interval '7 days'
   and matched = false;
```

(Sample count raised from v4's 10 to 50 because setup-WO is a much more frequent event — every booking with internal-setup rules emits N events, where N can easily be 2-3 per booking. A 7-day production window in any non-trivial tenant should easily clear 50.)

PLUS a **forced-failure probe** (renamed from v4's "lease-expiry probe") that runs on every staging deploy:

- **Test scenario:** create a booking with services that trigger the matrix to a misconfigured location (no `internal_team_id`). The current best-effort code path emits an `audit_events` row with `severity: 'high'`. The shadow handler should compute the same `outbox_shadow_results` entry: `shadow_outcome = { kind: 'no_team_configured', would_audit: true }`.
- **Assert:** the shadow row matches the inline audit; no WO is created either way.
- **Second scenario:** create a booking with services where the matrix IS configured. The current path creates a WO; the shadow handler computes the same WO (assigned_team_id, target_due_at, sla_policy_id, audit_metadata) and writes it as `shadow_outcome = { kind: 'would_create', team_id, due_at, sla, ... }`.
- **Assert:** `inline_outcome` (the actual WO created) and `shadow_outcome` (what the handler would create) compare equal field-by-field.

**Different from v4's probe:** there's no longer a "kill the TS process between two RPCs" scenario because there's only one RPC. The probe is a comparison harness, not a crash-recovery test.

The `outbox_shadow_results` table itself is unchanged from 00299:296; only the `event_type` filter changes.

### 5.3 Other event types

After setup-WO ships:
- `sla_timer.create_required` — emitted from inside the dispatch RPC (same Phase A/B/C cadence; sample count threshold tuned to dispatch volume).
- `notification.send_required` — emitted from the combined RPC for "your booking was created" emails. Best-effort by design — loss is bad UX, not corruption. Phase A can be skipped (no inline path to compare).
- `escalation.fire_required` — emitted from the `pg_cron`-scheduled SLA-check function.

Each cutover follows the Phase A → B → C cadence with its own shadow rows.

---

## 6. Event taxonomy — mechanism per event type

| Event type | Mechanism |
|---|---|
| `setup_work_order.create_required` | RPC helper inside `create_booking_with_attach_plan` (§7.6). Payload: `booking_id`, `oli_id`, `service_category`, `service_window_start_at`, `location_id`, `rule_ids`, `lead_time_override`, `origin_surface`. Handler: `SetupWorkOrderHandler` (§7.6). One event per service line that has `outcome.requires_internal_setup = true`. |
| `sla_timer.create_required` | RPC helper inside the dispatch RPC (when dispatch becomes an RPC). |
| `notification.send_required` | Fire-and-forget post-commit OR RPC helper depending on whether the notification is best-effort or required. "Booking created → email requester" is best-effort (loss is bad UX, not corruption). "SLA breach → escalate to manager" is required (RPC-emitted). |
| `escalation.fire_required` | RPC helper inside the `pg_cron`-scheduled SLA-check function that mutates `sla_timers.escalated_at`. |
| `webhook.deliver_required` | Future. Likely RPC-emitted from inside business writes that customers subscribe to. Open question §11. |

**Removed in v5 (vs v4):**
- ~~`booking.create_attempted`~~ — no longer needed; atomic = nothing to compensate.
- ~~`booking.compensation_required`~~ — already deprecated in v4; permanently retired.
- ~~`booking.service_attached`~~ — no longer needed as a success ack; the booking row's existence with associated orders/lines IS the success state. If future subscribers genuinely need a "booking ready for fulfillment" event (e.g. analytics), add it as a row-trigger on the booking insert at that time.

**Why not a generic "every row change" firehose:** the RPC-helper entries carry payload context the row doesn't capture (input ids, original errors, computed plan deltas). Generic CDC triggers would force handlers to re-derive context. Domain events are intentional.

---

## 7. Atomic combined RPC for booking + services

The structural shift in v5. v3/v4's watchdog/lease pattern is replaced by `create_booking_with_attach_plan(p_booking_input, p_attach_plan, p_tenant_id, p_idempotency_key)`.

### 7.1 The bug v3/v4 still had — and v5 removes

v3 used a 30s lease + watchdog. v4 widened to 5min and locked the booking row so the watchdog couldn't race the success path. Both stratagems still treated the booking write and the attach write as **two separate transactions** that needed coordination — v3 via timeout, v4 via row lock.

The user direction explicitly rejects this framing:

> "If booking + services are one user-visible command, they should commit as one database operation. Outbox is for durable async work, not for repairing a split write we can remove."

v5 takes the direction at face value. There is no separate "attach" phase. The booking + slots + orders + asset_reservations + OLIs + approvals all commit atomically. Compensation logic, lease config, watchdog handler, slow-preflight race, GUC propagation — all gone. The remaining surface area is smaller, simpler, and structurally correct.

**What's retained from v4:** the AttachPlan shape (with `approvals[].id` added — see §7.4), the FK validation matrix (expanded — §8), TS-side rule resolver + approval routing (§7.5).

**What's dropped from v4:** `attach_services_to_booking` RPC (subsumed by combined RPC), `delete_booking_with_guard` lock+re-check additions (RPC kept for recurrence-blocker case but no v4 amendments), `bookings.services_attached_at` column, `mark_services_attached` (never shipped), the lease window GUC, `current_setting('outbox.lease_seconds')`, `BookingCreateAttemptedHandler`, `BookingCompensationService.markAttachedRecovery`, the forced lease-expiry probe (replaced by setup-WO comparison probe in §5.2), v4 §13.2 (already eliminated; section deleted).

**`delete_booking_with_guard` (00292) stays unchanged** for the recurrence-blocker case (a recurrence series exists with `parent_booking_id`; the booking can't be deleted without explicit handling). The compensation boundary in `booking-flow.service.ts:408-425` is removed because there's nothing to compensate — the combined RPC either commits both or rolls back both.

### 7.2 The TS preflight (unchanged shape; no DB writes)

```
PREFLIGHT (TS) — exactly today's logic in BundleService.attachServicesToBooking,
                 minus the inline DB writes:
  BundleService.buildAttachPlan(input) →
    - load the booking input (validation only; no insert)
    - hydrate lines (catalog/menu lookups, lead-time calc, vendor/team)
      (bundle.service.ts:1112-1208 — `hydrateLines`, unchanged)
    - resolve service rules (ServiceRuleResolverService.resolveBulk;
      bundle.service.ts:274-316, unchanged)
    - check any_deny short-circuit (bundle.service.ts:351-361):
        if any line has effect='deny', return AttachPlan with any_deny=true +
        deny_messages[...] — RPC will raise before any insert
    - look up asset existence + tenant ownership (single query for all
      asset_ids; no longer per-line as in bundle.service.ts:1302-1314)
    - assemble approvals (ApprovalRoutingService.assemblePlan — NEW method;
      §7.5) — pure function over per-line outcomes, returns the deduped row
      list with merged scope_breakdown WITHOUT writing to the approvals table
    - pre-generate DETERMINISTIC UUIDs in TS via uuidv5 for: booking, slots,
      orders, OLIs, asset_reservations, approvals (§7.4 — v6-C1)
    - compute order totals + per-line line_totals
    - returns AttachPlan jsonb (§7.4)

WRITE (Postgres, one transaction):
  create_booking_with_attach_plan(p_booking_input, p_attach_plan,
                                  p_tenant_id, p_idempotency_key) →
    1. pg_advisory_xact_lock on hash(tenant_id || ':' || idempotency_key) (§7.3 — v6-C2)
    2. Read attach_operations row; idempotency check (§7.3)
    3. Tenant-validate every FK in both payloads (§8.1)
    4. Validate internal cross-references in plan (§8.2 — v6-I2)
    5. Short-circuit on any_deny (raise '42P10' service_rule_deny)
    6. INSERT booking
    7. INSERT booking_slots
    8. INSERT orders
    9. INSERT asset_reservations (GiST exclusion fires here on conflict)
    10. INSERT order_line_items (with linked_asset_reservation_id stamped)
    11. INSERT approvals (deduped by approver_person_id; pre-merged in plan)
    12. UPDATE orders SET status = 'submitted'|'approved' (per any_pending_approval)
    13. For each line with requires_internal_setup=true AND any_pending_approval=false:
        PERFORM outbox.emit('setup_work_order.create_required', oli_id, payload, ...)
    14. UPDATE attach_operations SET outcome='success', cached_result=...
    Returns: { booking_id, slot_ids, order_ids, oli_ids,
               asset_reservation_ids, approval_ids, any_pending_approval }

POST-COMMIT (TS, same call site):
  - If RPC threw: re-throw the original error to the caller (no compensation
    needed — the whole tx rolled back)
  - If RPC succeeded: return the resulting booking + ids
  - The post-commit best-effort SetupWorkOrderTriggerService.triggerMany call
    is REMOVED in Phase B of the cutover (§5.1). During Phase A it stays
    alongside the shadow handler.
```

### 7.3 `attach_operations` idempotency — RPC-side flow (v6 — advisory lock + simplified outcomes)

v5 used `SELECT FOR UPDATE` as the mutual exclusion mechanism. Codex flagged the race: `FOR UPDATE` only locks rows that already exist and are visible. Two concurrent retries on the same `(tenant_id, idempotency_key)` both pass the FOR UPDATE (both see no row), then both fall through to `INSERT`. The PK constraint forces serialisation at the INSERT step — second caller gets `23505`, NOT `cached_result`. From the TS caller's perspective that's an unhandled error.

v6 fix: take a **transaction-scoped advisory lock** before reading `attach_operations`. The advisory lock is held until tx commit/rollback; subsequent waiters with the same key block, then re-read and see the committed marker (or no row, if the first call rolled back).

```sql
-- At the top of create_booking_with_attach_plan:

declare
  v_existing public.attach_operations;
  v_payload_hash text;
  v_lock_key bigint;
begin
  -- ── 1. Advisory lock — serialises concurrent retries (v6-C2) ─────────
  -- pg_advisory_xact_lock takes an int8. Compose a stable int8 from
  -- tenant_id + idempotency_key via hashtextextended (returns int8 from
  -- a string; standard Postgres hash function, collision-resistant for
  -- this scale).
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);
  -- Lock is released automatically at tx commit or rollback. Subsequent
  -- callers with the same (tenant_id, idempotency_key) wait here until
  -- the holder finishes, then re-read attach_operations and see the
  -- committed success row (or no row, if this tx rolled back).

  -- Hash the FULL request payload. md5 is fine here — collision space is
  -- per-tenant per-idempotency-key, not global, so the realistic collision
  -- count is approximately zero.
  v_payload_hash := md5(coalesce(p_booking_input::text, '') ||
                        '|' ||
                        coalesce(p_attach_plan::text, ''));

  -- ── 2. Read existing operation row (under advisory lock) ─────────────
  select * into v_existing
    from public.attach_operations
   where tenant_id = p_tenant_id
     and idempotency_key = p_idempotency_key;

  if found then
    -- v6 contract: only 'success' is persistent. The advisory lock above
    -- means the in_progress state can't outlive the holder's tx — if the
    -- prior tx rolled back, the marker rolled back with it. So 'found' +
    -- outcome='in_progress' is structurally impossible post-lock. We still
    -- branch on outcome defensively (in case a future migration introduces
    -- a different state machine), but mainline is success vs payload_mismatch.
    if v_existing.outcome = 'success' and v_existing.payload_hash = v_payload_hash then
      -- True idempotent retry. Return cached result.
      return v_existing.cached_result;
    elsif v_existing.payload_hash != v_payload_hash then
      -- Same key, different payload. Caller violated the idempotency
      -- contract. Raise loudly — this is a bug surfacing.
      raise exception 'attach_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different payload — TS retry must rebuild the plan deterministically (see §7.4 for plan UUID derivation)';
    else
      -- Defensive: outcome='in_progress' (shouldn't happen post-lock) or
      -- a future enum value. Treat as a bug; fail loud.
      raise exception 'attach_operations.unexpected_state outcome=% hash_match=%',
        v_existing.outcome,
        (v_existing.payload_hash = v_payload_hash)
        using errcode = 'P0001';
    end if;
  end if;

  -- ── 3. Insert in_progress marker (will commit with the rest, or roll
  -- back entirely on failure — leaving no row, which is the desired state
  -- for a true retry). ──────────────────────────────────────────────────
  insert into public.attach_operations
    (tenant_id, idempotency_key, payload_hash, outcome)
  values (p_tenant_id, p_idempotency_key, v_payload_hash, 'in_progress');

  -- ... §7.6 below — all the inserts + emits run here ...

  -- Final step before return:
  update public.attach_operations
     set outcome = 'success',
         cached_result = v_result,
         completed_at = now()
   where tenant_id = p_tenant_id
     and idempotency_key = p_idempotency_key;

  return v_result;
end;
```

**Why advisory lock instead of `SELECT FOR UPDATE` only?** Because `FOR UPDATE` requires a row to exist. Two concurrent first-time callers both see "no row", both fall through to `INSERT`, and the PK collision forces one of them to fail with `23505` instead of returning `cached_result`. The advisory lock makes the gate work for the no-row case too: the second caller waits *before* reading, so by the time it reads, the first caller's marker is committed (or rolled back, leaving no row to read — in which case the second caller is structurally identical to a first attempt and proceeds correctly).

**Why `hashtextextended` and not `pg_advisory_xact_lock(text)`?** Postgres' advisory lock primitives take `int8` (or two `int4`s); there's no built-in text overload. `hashtextextended` is a non-cryptographic Postgres builtin (stable across versions, returns `bigint`) and is the canonical way to derive a `bigint` lock key from a string. The collision space is large enough that two unrelated keys hashing to the same int8 is implausible at our scale; even if it did happen, the consequence would be one operation briefly waiting on an unrelated holder — harmless beyond a small latency hit.

**Caller's idempotency_key construction.** `BookingFlowService` should generate one per request: `booking.create:${actor.user_id}:${input.client_request_id ?? randomUUID()}`. The `client_request_id` (if the client supplies one) lets the client retry without changing the key. Specifying this is the caller's responsibility — the TS contract on `BookingFlowService.create` MUST require a stable key per logical attempt, not a `randomUUID()` per call (which would defeat the whole mechanism). The frontend's React Query mutation layer already supplies a `client_request_id` per mutation (cf. the `RequestIdProvider` in `apps/web/src/api/api-fetch.ts`); reuse the same value on automatic retries.

### 7.4 The `AttachPlan` jsonb shape (v6 — deterministic UUIDs)

Carries forward v4's enumeration with FOUR changes from v4 plus the v6 deterministic-UUID switch:
- `approvals[].id` is now pre-generated TS-side (was assigned by the RPC's INSERT default in v4) — folds v4-I2.
- `booking_input` becomes a separate top-level argument (was implicit in v4 because `attach_services_to_booking` took a pre-existing booking).
- `slots[]` is added (booking creation includes slots).
- All UUID arrays explicitly enumerated below for the FK matrix in §8.
- **v6: every UUID below is derived deterministically from the idempotency key + a row-kind + a stable index — see "Pre-generated UUIDs" at the bottom of this section.**

```typescript
// Conceptual TypeScript shape; serialized as jsonb for the RPC.

interface BookingInput {
  // Pre-generated DETERMINISTIC UUIDs — see "Pre-generated UUIDs" below.
  booking_id: string;                            // = planUuid(key, 'booking', '0')
  slot_ids: string[];                            // = planUuid(key, 'slot', display_order)

  // Booking-row columns (mirrors create_booking RPC params at 00277:236-292)
  requester_person_id: string;
  host_person_id: string | null;
  booked_by_user_id: string | null;
  location_id: string;
  start_at: string;                              // ISO timestamp
  end_at: string;
  timezone: string;                              // default 'UTC'
  status: 'draft' | 'pending_approval' | 'confirmed';
  source: 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence';
  title: string | null;
  description: string | null;
  cost_center_id: string | null;
  cost_amount_snapshot: number | null;
  policy_snapshot: Record<string, unknown>;      // computed by booking-flow rule resolver
  applied_rule_ids: string[];                    // matched booking-rule ids
  config_release_id: string | null;
  recurrence_series_id: string | null;
  recurrence_index: number | null;
  template_id: string | null;

  // Slots — one per resource being held (single-room = 1, multi-room = N)
  // (mirrors booking_slots columns at 00277:116-160)
  slots: Array<{
    id: string;                                  // = planUuid(key, 'slot', display_order); matches slot_ids[i]
    slot_type: 'room' | 'desk' | 'asset' | 'parking';
    space_id: string;
    start_at: string;
    end_at: string;
    attendee_count: number | null;
    attendee_person_ids: string[];               // tenant-validated as personIds
    setup_buffer_minutes: number;
    teardown_buffer_minutes: number;
    check_in_required: boolean;
    check_in_grace_minutes: number;
    display_order: number;
  }>;
}

interface AttachPlan {
  // Top-level meta
  version: 1;                                    // bump on shape change
  any_pending_approval: boolean;                 // pre-computed from outcomes
  any_deny: boolean;                             // if true, RPC raises before any insert
  deny_messages: string[];                       // joined for the error payload

  // Orders — one per service_type group (bundle.service.ts:213-220)
  orders: Array<{
    id: string;                                  // = planUuid(key, 'order', `${service_type}:${i}`)
    service_type: string;                        // catalog_menus.service_type
    requester_person_id: string;
    delivery_location_id: string;                // = booking.location_id
    delivery_date: string;                       // booking.start_at.slice(0, 10)
    requested_for_start_at: string;              // = booking.start_at
    requested_for_end_at: string;                // = booking.end_at
    initial_status: 'submitted' | 'approved';    // computed from any_pending_approval
    policy_snapshot: { service_type: string };   // bundle.service.ts:1246
  }>;

  // Asset reservations — one per line that has a linked_asset_id
  // (bundle.service.ts:228-238)
  asset_reservations: Array<{
    id: string;                                  // = planUuid(key, 'asset_reservation', oli_id)
    asset_id: string;                            // tenant-validated in §8
    start_at: string;                            // line.service_window_start_at
    end_at: string;                              // line.service_window_end_at
    requester_person_id: string;
    booking_id: string;                          // = booking_input.booking_id
    status: 'confirmed';                         // bundle.service.ts:1323
  }>;

  // Order line items (bundle.service.ts:1254-1289)
  order_line_items: Array<{
    id: string;                                  // = planUuid(key, 'oli', `${order_id}:${j}`)
    order_id: string;                            // FK into plan.orders[].id
    catalog_item_id: string;
    quantity: number;
    unit_price: number | null;
    line_total: number | null;                   // unit_price * quantity (or null)
    fulfillment_status: 'ordered';
    fulfillment_team_id: string | null;          // tenant-validated when non-null
    vendor_id: string | null;                    // = line.fulfillment_vendor_id; tenant-validated
    menu_item_id: string | null;                 // tenant-validated when non-null
    linked_asset_id: string | null;              // tenant-validated when non-null
    linked_asset_reservation_id: string | null;  // FK into plan.asset_reservations[].id
    service_window_start_at: string;
    service_window_end_at: string;
    repeats_with_series: boolean;
    pending_setup_trigger_args: object | null;   // persisted when any_pending_approval
                                                 // (bundle.service.ts:418-441)
    policy_snapshot: {
      menu_id: string | null;
      menu_item_id: string | null;
      unit: 'per_item' | 'per_person' | 'flat_rate' | null;
      service_type: string;
    };
    // Setup-WO emission hint — used by the RPC to construct the outbox event
    // payload for `setup_work_order.create_required`. Only present when the
    // line's rule outcome requires_internal_setup=true.
    setup_emit?: {
      service_category: string;
      rule_ids: string[];
      lead_time_override_minutes: number | null;
    };
  }>;

  // Approvals — pre-deduped by ApprovalRoutingService.assemblePlan (§7.5).
  // One row per (approver_person_id) with merged scope_breakdown.
  approvals: Array<{
    id: string;                                  // = planUuid(key, 'approval', `${approval_sequence}:${k}`)
    target_entity_type: 'booking';               // canonicalised; 00278:172
    target_entity_id: string;                    // = booking_input.booking_id
    approver_person_id: string;
    scope_breakdown: {
      reservation_ids: string[];                 // legacy field name; values are booking ids
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
    bundle_id: string;                           // = booking_input.booking_id
    booking_id: string;                          // = booking_input.booking_id
    order_ids: string[];                         // mirrors plan.orders[].id
    order_line_item_ids: string[];               // mirrors plan.order_line_items[].id
    asset_reservation_ids: string[];             // mirrors plan.asset_reservations[].id
    approval_ids: string[];                      // mirrors plan.approvals[].id (NEW shape)
    any_pending_approval: boolean;
  };
}
```

**Pre-generated DETERMINISTIC UUIDs (v6 — folds C1).** Booking, slot, order, OLI, asset_reservation, and approval IDs are derived from the idempotency key + a stable per-row index using `uuidv5`. The plan still self-references (e.g. `order_line_items[].order_id` → `orders[].id`); the difference is that two TS plan-builds for the same logical request produce **identical UUIDs**, so the `payload_hash` of the constructed plan is identical, so a retry hits the `attach_operations` cache instead of tripping `payload_mismatch`.

The bug being closed: v5 §7.4 said "Pre-generated UUIDs ... via `crypto.randomUUID()`". A retry of the same logical request rebuilds the plan and gets *fresh* UUIDs. Even with the same `idempotency_key`, the rebuilt plan hashes differently, and §7.3 raises `payload_mismatch` — the exact opposite of what idempotency is meant to do. Codex C1.

```typescript
// apps/api/src/modules/booking-bundles/plan-uuid.ts (NEW in v6)
import { v5 as uuidv5 } from 'uuid';

// Stable namespace UUID for the booking-with-attach plan family. Generated
// once and committed; never rotate (rotating breaks idempotency for any
// in-flight retry). Pick any UUID; document it in this file.
export const NS_PLAN_BOOKING_WITH_ATTACH =
  '8e7c1a32-4b6f-4a10-9d2e-6b9a2c4f7d10' as const;

/**
 * Derive a deterministic UUID for a row in the attach plan. Same
 * (idempotencyKey, rowKind, stableIndex) → same UUID, every retry.
 *
 *   rowKind:     'booking' | 'slot' | 'order' | 'oli' | 'asset_reservation' | 'approval'
 *   stableIndex: a string that is deterministic given the request input.
 *                Per row-kind:
 *                  booking            → '0' (always exactly one)
 *                  slot               → String(slot.display_order)
 *                  order              → `${service_type}:${stable_order_index}`
 *                                        where stable_order_index is the
 *                                        position in a deterministic ordering
 *                                        of service types (alphabetical by
 *                                        catalog_menus.service_type, ascending).
 *                  oli                → `${order_id}:${stable_line_index}`
 *                                        where stable_line_index is the
 *                                        position in a deterministic ordering
 *                                        of input lines for that order
 *                                        (sort by input.lines.indexOf — preserve
 *                                        the caller's order; if the caller's
 *                                        order can vary, sort by catalog_item_id).
 *                  asset_reservation  → the OLI id (1:1 — every line that
 *                                        needs one has exactly one)
 *                  approval           → `${approval_sequence}:${approver_person_id}`
 *                                        where approval_sequence is a stable
 *                                        ordering of approval rows after
 *                                        ApprovalRoutingService.assemblePlan
 *                                        dedup (sort by approver_person_id
 *                                        ascending; the index k is the
 *                                        position in that sorted list).
 */
export function planUuid(
  idempotencyKey: string,
  rowKind:
    | 'booking'
    | 'slot'
    | 'order'
    | 'oli'
    | 'asset_reservation'
    | 'approval',
  stableIndex: string,
): string {
  return uuidv5(`${idempotencyKey}:${rowKind}:${stableIndex}`, NS_PLAN_BOOKING_WITH_ATTACH);
}
```

**Stable-index discipline (mandatory).** The `stableIndex` MUST be a deterministic function of the *input*, not of the plan-build's internal ordering decisions. Examples:

- `slot.display_order` is set by the caller and is part of the input; deterministic.
- `service_type` ordering: sort the input lines by `service_type` ascending (alphabetical) before building orders. Two retries see the same input lines, sort identically, and produce identical order indices.
- `order_id` is itself derived from `(service_type, sorted_position)`, so by the time we compute the OLI's `stable_line_index`, `order_id` is already deterministic.
- `approver_person_id` is given by the resolver; sort ascending for the approval index.

Document the per-row-kind derivation **in the plan-builder code's docstring**, not just here, so a future change to the stable index is forced through review.

**Trust + safety.** The RPC trusts the TS-generated UUIDs and inserts them verbatim. UUIDv5 collisions across distinct namespaces are cryptographically implausible. Within a namespace, collisions only happen for identical `(idempotencyKey, rowKind, stableIndex)` triples — which is the exact behaviour we want for retry idempotency. A duplicate from a buggy retry (somehow constructing the same triple for two semantically distinct rows) would surface as `23505` and roll the whole RPC back.

**Deprecation:** drop `crypto.randomUUID()` from the plan-build path entirely. The only remaining `randomUUID()` callers in the booking flow are non-plan UUIDs (e.g. trace/correlation IDs) — those stay random.

### 7.5 Why we don't port the resolver / routing logic to SQL

A reviewer might ask: if everything else is in PL/pgSQL, why keep `ServiceRuleResolverService` and `ApprovalRoutingService` in TS?

- The rule resolver evaluates a tree of service rules against a context object with ~30 fields (line, requester, bundle, order, permissions). Half the predicates are TS-only library calls (date math, tz arithmetic, JSON path resolution). Porting is a multi-week project and would create two implementations to keep in sync.
- Approval routing's `derived` expressions (`cost_center.default_approver`, future `requester.manager`) involve table lookups today (cost_centers row read, future user_role_assignments expansion). The TS impl is ~20 lines per expression.
- The TS `assemblePlan` function (NEW for v5) returns the same shape as `assemble` but does NOT write to `approvals`. Same dedup logic, same `mergeBreakdown` reasoning, just no INSERT. ~30 lines of refactor; tests stay valid.

Concrete refactor sketch for `apps/api/src/modules/orders/approval-routing.service.ts`:

```typescript
// existing assemble(args) writes via this.upsertApproval. Refactor:

async assemblePlan(args: AssembleApprovalsArgs): Promise<AssembledApprovalRow[]> {
  const tenant = TenantContext.current();
  const tuples = await this.collectApproverTuples(args);  // unchanged — already in approval-routing.service.ts:140-192
  if (tuples.length === 0) return [];

  // Group by approver_person_id, build merged scope_breakdown — unchanged from
  // approval-routing.service.ts:104-120.
  const grouped = new Map<string, ...>();
  for (const t of tuples) { ... mergeScopeInto(...); }

  // v6: deterministic id derived from idempotency_key + sorted approver_person_id.
  // Sort approver ids ascending so the index is stable across retries.
  const sortedApproverIds = Array.from(grouped.keys()).sort();

  const out: AssembledApprovalRow[] = [];
  for (let k = 0; k < sortedApproverIds.length; k++) {
    const approverPersonId = sortedApproverIds[k];
    const entry = grouped.get(approverPersonId)!;
    out.push({
      id: planUuid(args.idempotencyKey, 'approval', `${k}:${approverPersonId}`),  // v6-C1
      target_entity_type: args.target_entity_type,
      target_entity_id: args.target_entity_id,
      approver_person_id: approverPersonId,
      scope_breakdown: { ...entry.scope, reasons: entry.reasons },
      status: 'pending',
    });
  }
  return out;
}

// Existing assemble(args) keeps its body for OrderService.createStandaloneOrder
// (which doesn't go through the combined RPC yet — see §11 future work).
```

**The key invariant:** TS produces a *plan* that the RPC can validate and apply atomically. TS reads the world; Postgres writes it.

### 7.6 The full RPC body

```sql
-- supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql (NEW in v5)

create or replace function public.create_booking_with_attach_plan(
  p_booking_input  jsonb,    -- BookingInput (§7.4)
  p_attach_plan    jsonb,    -- AttachPlan (§7.4); may be empty plan if no services
  p_tenant_id      uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_existing       public.attach_operations;
  v_payload_hash   text;
  v_lock_key       bigint;
  v_booking_id     uuid;
  v_slot           jsonb;
  v_order          jsonb;
  v_ar             jsonb;
  v_oli            jsonb;
  v_approval       jsonb;
  v_setup_emit     jsonb;
  v_event_payload  jsonb;
  v_result         jsonb;
begin
  if p_tenant_id is null then
    raise exception 'create_booking_with_attach_plan: p_tenant_id required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'create_booking_with_attach_plan: p_idempotency_key required';
  end if;

  -- ── 1. Advisory lock (v6-C2) — serialise concurrent retries ─────────
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_idempotency_key, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. attach_operations idempotency gate (§7.3) ─────────────────────
  v_payload_hash := md5(coalesce(p_booking_input::text, '') || '|' ||
                        coalesce(p_attach_plan::text, ''));

  select * into v_existing
    from public.attach_operations
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  if found then
    -- v6 contract: only 'success' is persistent (see §2.4 + §7.3).
    if v_existing.outcome = 'success' and v_existing.payload_hash = v_payload_hash then
      return v_existing.cached_result;
    elsif v_existing.payload_hash != v_payload_hash then
      raise exception 'attach_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different payload — see §7.4 for plan UUID derivation';
    else
      raise exception 'attach_operations.unexpected_state outcome=% hash_match=%',
        v_existing.outcome,
        (v_existing.payload_hash = v_payload_hash)
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.attach_operations
    (tenant_id, idempotency_key, payload_hash, outcome)
  values (p_tenant_id, p_idempotency_key, v_payload_hash, 'in_progress');

  -- ── 3. any_deny short-circuit ─────────────────────────────────────────
  if (p_attach_plan->>'any_deny')::boolean then
    raise exception 'service_rule_deny: %',
      coalesce(p_attach_plan->'deny_messages'->>0, 'A service rule denied this booking.')
      using errcode = '42P10';
  end if;

  -- ── 4. Validate every FK in both payloads (§8.1 tenant + §8.2 internal) ──
  perform public.validate_attach_plan_tenant_fks(p_tenant_id, p_booking_input, p_attach_plan);
  perform public.validate_attach_plan_internal_refs(p_booking_input, p_attach_plan);  -- v6-I2

  -- ── 5. INSERT booking ────────────────────────────────────────────────
  -- (mirrors create_booking RPC body at 00277:277-296, with the booking_id
  --  pre-generated TS-side instead of from the DEFAULT)
  v_booking_id := (p_booking_input->>'booking_id')::uuid;
  insert into public.bookings (
    id, tenant_id, title, description,
    requester_person_id, host_person_id, booked_by_user_id,
    location_id, start_at, end_at, timezone,
    status, source,
    cost_center_id, cost_amount_snapshot,
    policy_snapshot, applied_rule_ids, config_release_id,
    recurrence_series_id, recurrence_index, template_id
  ) values (
    v_booking_id, p_tenant_id,
    p_booking_input->>'title', p_booking_input->>'description',
    (p_booking_input->>'requester_person_id')::uuid,
    nullif(p_booking_input->>'host_person_id', '')::uuid,
    nullif(p_booking_input->>'booked_by_user_id', '')::uuid,
    (p_booking_input->>'location_id')::uuid,
    (p_booking_input->>'start_at')::timestamptz,
    (p_booking_input->>'end_at')::timestamptz,
    coalesce(p_booking_input->>'timezone', 'UTC'),
    p_booking_input->>'status',
    p_booking_input->>'source',
    nullif(p_booking_input->>'cost_center_id', '')::uuid,
    nullif(p_booking_input->>'cost_amount_snapshot', '')::numeric,
    coalesce(p_booking_input->'policy_snapshot', '{}'::jsonb),
    coalesce(
      (select array_agg(value::uuid)
         from jsonb_array_elements_text(p_booking_input->'applied_rule_ids')),
      '{}'),
    nullif(p_booking_input->>'config_release_id', '')::uuid,
    nullif(p_booking_input->>'recurrence_series_id', '')::uuid,
    nullif(p_booking_input->>'recurrence_index', '')::int,
    nullif(p_booking_input->>'template_id', '')::uuid
  );

  -- ── 6. INSERT booking_slots ──────────────────────────────────────────
  -- (mirrors 00277:301-329)
  for v_slot in select * from jsonb_array_elements(p_booking_input->'slots')
  loop
    insert into public.booking_slots (
      id, tenant_id, booking_id,
      slot_type, space_id, start_at, end_at,
      attendee_count, attendee_person_ids,
      setup_buffer_minutes, teardown_buffer_minutes,
      status, check_in_required, check_in_grace_minutes,
      display_order
    ) values (
      (v_slot->>'id')::uuid, p_tenant_id, v_booking_id,
      v_slot->>'slot_type',
      (v_slot->>'space_id')::uuid,
      (v_slot->>'start_at')::timestamptz,
      (v_slot->>'end_at')::timestamptz,
      nullif(v_slot->>'attendee_count', '')::int,
      coalesce(
        (select array_agg(value::uuid)
           from jsonb_array_elements_text(v_slot->'attendee_person_ids')),
        '{}'),
      coalesce((v_slot->>'setup_buffer_minutes')::int, 0),
      coalesce((v_slot->>'teardown_buffer_minutes')::int, 0),
      p_booking_input->>'status',                 -- slot status mirrors booking on create
      coalesce((v_slot->>'check_in_required')::boolean, false),
      coalesce((v_slot->>'check_in_grace_minutes')::int, 15),
      coalesce((v_slot->>'display_order')::int, 0)
    );
    -- The booking_slots_no_overlap GiST exclusion (00277:211-217) fires here
    -- on conflict, raising 23P01. Whole tx rolls back; idempotency row goes
    -- with it.
  end loop;

  -- ── 7. INSERT orders (one per service_type group; bundle.service.ts:213-220)
  for v_order in select * from jsonb_array_elements(p_attach_plan->'orders')
  loop
    insert into public.orders (
      id, tenant_id, requester_person_id, booking_id, linked_slot_id,
      delivery_location_id, delivery_date,
      requested_for_start_at, requested_for_end_at,
      status, policy_snapshot
    ) values (
      (v_order->>'id')::uuid, p_tenant_id,
      (v_order->>'requester_person_id')::uuid,
      v_booking_id,
      null,                                       -- multi-slot tracking deferred (bundle.service.ts:1240)
      (v_order->>'delivery_location_id')::uuid,
      (v_order->>'delivery_date')::date,
      (v_order->>'requested_for_start_at')::timestamptz,
      (v_order->>'requested_for_end_at')::timestamptz,
      v_order->>'initial_status',                 -- 'submitted' or 'approved' from plan
      coalesce(v_order->'policy_snapshot', '{}'::jsonb)
    );
  end loop;

  -- ── 8. INSERT asset_reservations (GiST exclusion fires here)
  -- (bundle.service.ts:1316-1330)
  for v_ar in select * from jsonb_array_elements(p_attach_plan->'asset_reservations')
  loop
    insert into public.asset_reservations (
      id, tenant_id, asset_id, start_at, end_at,
      status, requester_person_id, booking_id
    ) values (
      (v_ar->>'id')::uuid, p_tenant_id,
      (v_ar->>'asset_id')::uuid,
      (v_ar->>'start_at')::timestamptz,
      (v_ar->>'end_at')::timestamptz,
      v_ar->>'status',                            -- always 'confirmed' from plan
      (v_ar->>'requester_person_id')::uuid,
      v_booking_id
    );
  end loop;

  -- ── 9. INSERT order_line_items (bundle.service.ts:1260-1287)
  for v_oli in select * from jsonb_array_elements(p_attach_plan->'order_line_items')
  loop
    insert into public.order_line_items (
      id, order_id, tenant_id,
      catalog_item_id, quantity, unit_price, line_total,
      fulfillment_status, fulfillment_team_id, vendor_id,
      menu_item_id, linked_asset_id, linked_asset_reservation_id,
      service_window_start_at, service_window_end_at, repeats_with_series,
      pending_setup_trigger_args, policy_snapshot
    ) values (
      (v_oli->>'id')::uuid,
      (v_oli->>'order_id')::uuid,
      p_tenant_id,
      (v_oli->>'catalog_item_id')::uuid,
      (v_oli->>'quantity')::int,
      nullif(v_oli->>'unit_price', '')::numeric,
      nullif(v_oli->>'line_total', '')::numeric,
      v_oli->>'fulfillment_status',
      nullif(v_oli->>'fulfillment_team_id', '')::uuid,
      nullif(v_oli->>'vendor_id', '')::uuid,
      nullif(v_oli->>'menu_item_id', '')::uuid,
      nullif(v_oli->>'linked_asset_id', '')::uuid,
      nullif(v_oli->>'linked_asset_reservation_id', '')::uuid,
      (v_oli->>'service_window_start_at')::timestamptz,
      (v_oli->>'service_window_end_at')::timestamptz,
      coalesce((v_oli->>'repeats_with_series')::boolean, true),
      v_oli->'pending_setup_trigger_args',
      coalesce(v_oli->'policy_snapshot', '{}'::jsonb)
    );
  end loop;

  -- ── 10. INSERT approvals (deduped + pre-merged in TS plan; §7.5)
  for v_approval in select * from jsonb_array_elements(p_attach_plan->'approvals')
  loop
    insert into public.approvals (
      id, tenant_id, target_entity_type, target_entity_id,
      approver_person_id, status, scope_breakdown
    ) values (
      (v_approval->>'id')::uuid,                  -- pre-generated TS-side (v6: deterministic uuidv5)
      p_tenant_id,
      v_approval->>'target_entity_type',          -- 'booking' canonicalised
      (v_approval->>'target_entity_id')::uuid,
      (v_approval->>'approver_person_id')::uuid,
      v_approval->>'status',                      -- always 'pending' from plan
      coalesce(v_approval->'scope_breakdown', '{}'::jsonb)
    );
    -- The unique partial index on (target_entity_id, approver_person_id)
    -- WHERE status='pending' enforces dedup at insert time. Plan should
    -- already be deduped, so this should never fire — but if it does, the
    -- whole tx rolls back (correct behavior — better a clear failure than
    -- a silent merge that contradicts the plan).
  end loop;

  -- ── 11. UPDATE orders.status from 'draft' to 'submitted'/'approved'
  -- The plan's orders[].initial_status already carries the correct value;
  -- step 7 inserted with that. This step is a no-op in v5+ (kept for parity
  -- with the old TS sequence at bundle.service.ts:367-373, which inserted
  -- 'draft' first then UPDATED — we skip that because the plan tells us
  -- the right status from the start).

  -- ── 12. Emit setup_work_order.create_required outbox events ───────────
  -- One event per OLI that has setup_emit hint AND any_pending_approval=false.
  -- The emit is atomic with every other insert above; if any of them fails,
  -- none of the emits land either.
  --
  -- v6 defense-in-depth: we now explicitly skip emission when
  -- any_pending_approval is true. The TS plan-builder is responsible for
  -- omitting setup_emit on pending lines (§7.2), but a misbehaving
  -- preflight could send the hint anyway. The check here makes the gate
  -- non-bypassable. The pending_setup_trigger_args column on each OLI
  -- carries the snapshot for approve_booking_setup_trigger to re-emit on
  -- approval grant (§7.8 — v6-C4).
  if not coalesce((p_attach_plan->>'any_pending_approval')::boolean, false) then
  for v_oli in select * from jsonb_array_elements(p_attach_plan->'order_line_items')
  loop
    if v_oli ? 'setup_emit' and (v_oli->'setup_emit') is not null then
      v_setup_emit := v_oli->'setup_emit';
      v_event_payload := jsonb_build_object(
        'booking_id',                v_booking_id,
        'oli_id',                    (v_oli->>'id')::uuid,
        'service_category',          v_setup_emit->>'service_category',
        'service_window_start_at',   v_oli->>'service_window_start_at',
        'location_id',               p_booking_input->>'location_id',
        'rule_ids',                  v_setup_emit->'rule_ids',
        'lead_time_override_minutes', nullif(v_setup_emit->>'lead_time_override_minutes','')::int,
        'origin_surface',            'bundle',
        'requires_approval',         (p_attach_plan->>'any_pending_approval')::boolean
      );
      perform outbox.emit(
        p_tenant_id      => p_tenant_id,
        p_event_type     => 'setup_work_order.create_required',
        p_aggregate_type => 'order_line_item',
        p_aggregate_id   => (v_oli->>'id')::uuid,
        p_payload        => v_event_payload,
        p_idempotency_key => 'setup_work_order.create_required:' || (v_oli->>'id')::text,
        p_event_version  => 1,
        p_available_at   => null                  -- emit immediately; not deferred
      );
    end if;
  end loop;
  end if;  -- close any_pending_approval=false guard (v6)

  -- ── 13. Build cached result, mark operation success ───────────────────
  v_result := jsonb_build_object(
    'booking_id',             v_booking_id,
    'slot_ids',               (select coalesce(jsonb_agg(s->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_booking_input->'slots') s),
    'order_ids',              (select coalesce(jsonb_agg(o->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_attach_plan->'orders') o),
    'order_line_item_ids',    (select coalesce(jsonb_agg(li->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_attach_plan->'order_line_items') li),
    'asset_reservation_ids',  (select coalesce(jsonb_agg(a->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_attach_plan->'asset_reservations') a),
    'approval_ids',           (select coalesce(jsonb_agg(ap->'id'), '[]'::jsonb)
                                 from jsonb_array_elements(p_attach_plan->'approvals') ap),
    'any_pending_approval',   (p_attach_plan->>'any_pending_approval')::boolean
  );

  update public.attach_operations
     set outcome = 'success', cached_result = v_result, completed_at = now()
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;

  return v_result;
end;
$$;

comment on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text) is
  'Atomic booking + services creation. Single transaction commits booking + slots + orders + asset_reservations + OLIs + approvals + outbox emissions. Idempotent on (tenant_id, idempotency_key) via attach_operations table. Spec §7 of docs/superpowers/specs/2026-05-04-domain-outbox-design.md.';
```

The function is SECURITY INVOKER. RLS still applies for any caller that isn't the service role; matches `create_booking` (00277:262). The service-role admin client (the only production caller — `BookingFlowService.create` calls via `supabase.admin`) bypasses RLS but is constrained by `p_tenant_id` matching on every read/write inside.

### 7.7 `SetupWorkOrderTriggerService.triggerStrict` (NEW in v6 — folds C3)

Today's `SetupWorkOrderTriggerService.trigger` (`apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts:46-143`) catches **everything**: an outer `try` at line 50 wraps the whole body, and the inner `catch` at line 123 swallows `createBookingOriginWorkOrder` failures into an `audit_events` row + a `null` return. That posture was correct when the trigger ran best-effort post-commit — a failure logged + audited was the desired outcome because the alternative (turning a successful 201 into a 500) was worse. But now that the same logic runs from inside an outbox handler, the swallow becomes a hole: a transient DB failure (connection blip, statement_timeout) returns `null`, the handler thinks "no WO to create — terminal", the outbox marks the event processed, and the work order is permanently lost. The outbox's whole value proposition — "the handler crashes → retry; tenant misconfigured → audit + dead-letter" — depends on the handler distinguishing transient from terminal.

v6 adds a strict-mode sibling with typed terminal outcomes:

```typescript
// apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts (v6 additions)

export type SetupTriggerResult =
  | { kind: 'created'; work_order_id: string }
  | { kind: 'no_op_terminal'; reason: 'no_routing_match' | 'invalid_window' | 'config_disabled' };

export class SetupWorkOrderTriggerService {
  // ── Existing best-effort trigger() (lines 46-143) STAYS UNCHANGED ─────
  // Used by any non-outbox caller during the cutover (audit). Phase B
  // removes the only remaining caller (bundle.service.ts:1527 — the
  // approval-grant triggerMany) by routing it through the new
  // approve_booking_setup_trigger RPC (§7.8). After Phase B the
  // best-effort trigger() and triggerMany() are dead code; remove in
  // a follow-up cleanup commit.

  /**
   * Strict variant for the outbox handler path.
   *
   * Contract:
   *   - Returns { kind: 'created', work_order_id } on success.
   *   - Returns { kind: 'no_op_terminal', reason } when the inputs are
   *     valid but there is structurally nothing to create (routing matrix
   *     unconfigured, service window invalid, config disabled). The outbox
   *     handler treats these as "processed, do nothing".
   *   - THROWS on every other failure path (RPC error, TS-side date math
   *     fault, ticket insert error). The outbox worker treats throws as
   *     transient and retries with backoff per §4.4.
   *
   * Audit posture: terminal no-ops still emit the existing
   * audit_events rows (`*_routing_unconfigured`, etc.) so admin
   * triage tooling keeps working. Transient failures emit a high-severity
   * audit row before re-throwing — operators see both the audit row AND
   * the retry/dead-letter signal.
   */
  async triggerStrict(args: TriggerArgs): Promise<SetupTriggerResult> {
    // 1. Routing matrix lookup. RPC error → throw (transient). Empty
    //    result → terminal.
    const { data: routing, error: routingErr } = await this.supabase.admin.rpc(
      'resolve_setup_routing',
      {
        p_tenant_id: args.tenantId,
        p_location_id: args.locationId,
        p_service_category: args.serviceCategory,
      },
    );
    if (routingErr) {
      void this.audit(args, 'setup_routing_lookup_failed', {
        error: routingErr.message,
        severity: 'high',
      });
      throw new Error(`resolve_setup_routing: ${routingErr.message}`);
    }
    const row = (routing as Array<{
      internal_team_id: string | null;
      default_lead_time_minutes: number;
      sla_policy_id: string | null;
    }> | null)?.[0];
    if (!row || !row.internal_team_id) {
      void this.audit(args, 'setup_routing_unconfigured', { reason: 'no_matrix_match' });
      return { kind: 'no_op_terminal', reason: 'no_routing_match' };
    }

    // 2. Lead-time math. Invalid window is a terminal data fault; we
    //    can't make a WO with a NaN due_at and retrying won't help.
    const leadTime = args.leadTimeOverride ?? row.default_lead_time_minutes;
    const startMs = new Date(args.serviceWindowStartAt).getTime();
    if (!Number.isFinite(startMs)) {
      void this.audit(args, 'setup_work_order_create_failed', {
        error: `invalid service_window_start_at: ${args.serviceWindowStartAt}`,
        severity: 'high',
      });
      return { kind: 'no_op_terminal', reason: 'invalid_window' };
    }
    const targetDueAt = new Date(startMs - leadTime * 60_000).toISOString();

    // 3. Ticket insert. Errors here are transient — DB blip, lock contention,
    //    SLA policy dependency — outbox should retry. Re-throw without a
    //    catch.
    const { id } = await this.tickets.createBookingOriginWorkOrder({
      title: `Internal setup — ${args.serviceCategory}`,
      booking_bundle_id: args.bundleId,
      linked_order_line_item_id: args.oliId,
      assigned_team_id: row.internal_team_id,
      target_due_at: targetDueAt,
      sla_policy_id: row.sla_policy_id,
      location_id: args.locationId,
      audit_metadata: {
        triggered_by_rule_ids: args.ruleIds,
        lead_time_minutes: leadTime,
        service_window_start_at: args.serviceWindowStartAt,
        service_category: args.serviceCategory,
        sla_policy_id: row.sla_policy_id,
        origin: args.originSurface,
      },
    });
    void this.audit(args, 'setup_work_order_created', {
      ticket_id: id,
      assigned_team_id: row.internal_team_id,
      target_due_at: targetDueAt,
      lead_time_minutes: leadTime,
      sla_policy_id: row.sla_policy_id,
    });
    return { kind: 'created', work_order_id: id };
  }
}
```

**Phase A → Phase B migration of the trigger surface:**
- **Phase A (shadow):** the existing `trigger`/`triggerMany` callers (`bundle.service.ts:456` for create, `bundle.service.ts:1527` for approval grant) keep running unchanged. The outbox handler runs in shadow mode and uses `triggerStrict` *only inside the dryRun helper* — never against production state.
- **Phase B (handler active):** create-path call site (`bundle.service.ts:456`) is removed; the outbox event becomes the only path. Approval-grant call site (`bundle.service.ts:1527`) is replaced by the new `approve_booking_setup_trigger` RPC (§7.8). After Phase B, `trigger`/`triggerMany` have no production callers; they stay in the codebase as one cutover pass and get deleted in the v5/v6 cleanup commit (§16).

### 7.8 Setup work order handler (v6 — folds C3 + I1)

```typescript
// apps/api/src/modules/outbox/handlers/setup-work-order.handler.ts
@Injectable()
@OutboxHandler('setup_work_order.create_required', { version: 1 })
export class SetupWorkOrderHandler {
  constructor(
    private readonly setupTrigger: SetupWorkOrderTriggerService,
    private readonly supabase: SupabaseService,
    private readonly log = new Logger(SetupWorkOrderHandler.name),
  ) {}

  async handle(event: OutboxEventWithPayload<SetupWorkOrderPayload>): Promise<void> {
    // ── 1. Tenant smuggling defense (worker §4.3 already asserted on
    //   event.tenant_id; this also asserts the aggregate row matches). ──
    const oliRow = await this.supabase.admin
      .from('order_line_items')
      .select('id, tenant_id, order_id')
      .eq('id', event.aggregate_id)
      .maybeSingle();
    if (!oliRow.data) {
      // OLI was deleted (cancellation cascade beat us). Idempotent success.
      this.log.log(`oli_already_gone oli=${event.aggregate_id}`);
      return;
    }
    if (oliRow.data.tenant_id !== event.tenant_id) {
      throw new DeadLetterError(
        `tenant_mismatch: event.tenant_id=${event.tenant_id} oli.tenant_id=${oliRow.data.tenant_id}`,
      );
    }

    // ── 2. Approval-pending guard. The combined RPC already gates emission
    //   on any_pending_approval (§7.6 step 12), so this branch should only
    //   trigger for the approve_booking_setup_trigger path (§7.8) where
    //   requires_approval is always false on emit. Keep as defense-in-depth.
    if (event.payload.requires_approval) {
      this.log.log(`requires_approval_skip oli=${event.aggregate_id}`);
      return;
    }

    // ── 3. Durable dedup (v6-I1): SELECT FOR UPDATE on
    //   setup_work_order_emissions. If row exists, this event was already
    //   handled (regardless of whether the WO was later cancelled/closed).
    //   Idempotent re-handling — return without invoking triggerStrict.
    const { data: existing } = await this.supabase.admin
      .from('setup_work_order_emissions')
      .select('work_order_id')
      .eq('tenant_id', event.tenant_id)
      .eq('oli_id', event.aggregate_id)
      .maybeSingle();
    if (existing) {
      this.log.log(`already_emitted oli=${event.aggregate_id} wo=${existing.work_order_id}`);
      return;
    }

    // ── 4. Strict-mode trigger (v6-C3): typed terminal outcomes,
    //   thrown transients. ──────────────────────────────────────────────
    const result = await this.setupTrigger.triggerStrict({
      tenantId:               event.tenant_id,
      bundleId:               event.payload.booking_id,
      oliId:                  event.payload.oli_id,
      serviceCategory:        event.payload.service_category,
      serviceWindowStartAt:   event.payload.service_window_start_at,
      locationId:             event.payload.location_id,
      ruleIds:                event.payload.rule_ids,
      leadTimeOverride:       event.payload.lead_time_override_minutes,
      originSurface:          event.payload.origin_surface,
    });

    if (result.kind === 'no_op_terminal') {
      // Terminal: do NOT insert into setup_work_order_emissions. A future
      // replay (e.g. after admin reconfigures the routing matrix) will
      // re-evaluate and may produce a WO. The terminal outcome is captured
      // in audit_events (existing path inside triggerStrict).
      this.log.log(`no_op_terminal oli=${event.aggregate_id} reason=${result.reason}`);
      return;
    }

    // ── 5. Created. Insert dedup row. The trigger service already
    //   committed the WO (separate tx); the dedup row commits in the
    //   handler's wrapping tx. There's a small window between WO insert
    //   and dedup insert where a crash leaves a "WO with no dedup row" —
    //   on retry, the handler reads no dedup row, calls triggerStrict
    //   again, and gets a SECOND WO. Acceptable because:
    //     (a) p99 between the two writes is sub-millisecond;
    //     (b) the duplicate-WO failure mode is recoverable (admin closes
    //         one) whereas a missing-WO failure mode is silent corruption.
    //   For a tighter coupling, refactor triggerStrict to take a callback
    //   that runs inside the WO insert tx. Not done in v6 — the failure
    //   window is small enough that the simpler shape wins.
    await this.supabase.admin.from('setup_work_order_emissions').insert({
      tenant_id:        event.tenant_id,
      oli_id:           event.aggregate_id,
      work_order_id:    result.work_order_id,
      outbox_event_id:  event.id,
    });
  }

  /** Phase A shadow mode: never mutates; produces an outbox_shadow_results row. */
  async dryRun(event: OutboxEventWithPayload<SetupWorkOrderPayload>): Promise<ShadowOutcome> {
    // Replays the routing-matrix lookup + lead-time math from triggerStrict
    // but RETURNS instead of writing the WO. Compared to the inline-path's
    // actual outcome (audit_events / work_orders rows) by the gate query
    // in §5.2.
    /* implementation: replicate triggerStrict's lookup + lead-time math,
     *  return { kind: 'would_create' | 'no_team_configured' | 'invalid_window',
     *    team_id, due_at, sla, ... } */
  }
}
```

### 7.9 `approve_booking_setup_trigger` RPC (NEW in v6 — folds C4)

The approval-grant deferred-setup re-fire today (`bundle.service.ts:1523-1527` — `setupTrigger.triggerMany(triggerArgs)` after `claim_deferred_setup_trigger_args`) bypasses outbox durability entirely: TS reads the args, calls the trigger service inline, and if the API process crashes between claim and trigger, the WO is lost. This is the same failure mode the create-path cutover was designed to close — except for the post-approval branch.

v6 closes it by emitting the same outbox event from a new RPC. The TS call site collapses to "claim args + invoke RPC"; the RPC is responsible for the atomic emit + arg clear.

**Why an RPC and not direct TS-side `outbox.emit`?** Because the existing `claim_deferred_setup_trigger_args` (referenced at `bundle.service.ts:1452`) already runs as an RPC and atomically nulls `pending_setup_trigger_args`. To make the new flow durable without race windows, the claim + emit must be in one transaction. Two designs were considered:

- **(A) Single combined RPC:** `approve_booking_setup_trigger(p_oli_ids, p_tenant_id)` — reads `pending_setup_trigger_args` for the OLIs (still in JSONB on the OLI row), emits one `setup_work_order.create_required` per non-null args row, clears the args, returns a count. ONE round trip, ONE transaction, atomic semantics identical to `create_booking_with_attach_plan`.
- **(B) Two-step from TS:** TS calls existing `claim_deferred_setup_trigger_args`, then per-OLI calls `outbox_emit_via_rpc`. Atomicity exists per-emit (the wrapper RPC runs its own tx) but NOT across the claim + emit boundary — if TS crashes between claim and the first emit, the args are nulled but no event was emitted.

**v6 chooses (A).** Reasoning: the whole point of v5/v6 is "no split writes". Design B reintroduces exactly the failure mode v5 worked to remove. The marginal complexity of an extra RPC is small; the durability win is structural.

```sql
-- supabase/migrations/00305_approve_booking_setup_trigger_rpc.sql (NEW in v6)

create or replace function public.approve_booking_setup_trigger(
  p_oli_ids   uuid[],
  p_tenant_id uuid
) returns int
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_oli            record;
  v_args           jsonb;
  v_emit_count     int := 0;
  v_event_payload  jsonb;
begin
  if p_tenant_id is null then
    raise exception 'approve_booking_setup_trigger: p_tenant_id required';
  end if;
  if p_oli_ids is null or array_length(p_oli_ids, 1) is null then
    return 0;
  end if;

  -- Lock + read OLI rows for this tenant. The select-for-update prevents
  -- a concurrent cancel cascade from racing.
  for v_oli in
    select id, order_id, pending_setup_trigger_args, fulfillment_status,
           service_window_start_at, booking_id
      from public.order_line_items
     where id = any(p_oli_ids)
       and tenant_id = p_tenant_id
     for update
  loop
    -- Skip cancelled lines (race-guard equivalent of the TS code at
    -- bundle.service.ts:1572-1604).
    if v_oli.fulfillment_status = 'cancelled' then
      continue;
    end if;
    if v_oli.pending_setup_trigger_args is null then
      continue;
    end if;
    v_args := v_oli.pending_setup_trigger_args;

    -- Build event payload from the persisted args. Schema mirrors §7.6's
    -- v_event_payload — the handler is shape-agnostic across the create
    -- and approval-grant origins.
    v_event_payload := jsonb_build_object(
      'booking_id',                v_oli.booking_id,
      'oli_id',                    v_oli.id,
      'service_category',          v_args->>'serviceCategory',
      'service_window_start_at',   v_args->>'serviceWindowStartAt',
      'location_id',               v_args->>'locationId',
      'rule_ids',                  v_args->'ruleIds',
      'lead_time_override_minutes', nullif(v_args->>'leadTimeOverride','')::int,
      'origin_surface',            coalesce(v_args->>'originSurface', 'bundle'),
      'requires_approval',         false   -- approval already granted
    );

    perform outbox.emit(
      p_tenant_id      => p_tenant_id,
      p_event_type     => 'setup_work_order.create_required',
      p_aggregate_type => 'order_line_item',
      p_aggregate_id   => v_oli.id,
      p_payload        => v_event_payload,
      p_idempotency_key => 'setup_work_order.create_required:' || v_oli.id::text,
      p_event_version  => 1,
      p_available_at   => null
    );

    -- Clear the args atomically. Same idempotency key as the create-path
    -- emit — outbox.emit's same-key/same-payload no-op handles the case
    -- where this is somehow called twice for the same line.
    update public.order_line_items
       set pending_setup_trigger_args = null
     where id = v_oli.id;

    v_emit_count := v_emit_count + 1;
  end loop;

  return v_emit_count;
end;
$$;

comment on function public.approve_booking_setup_trigger(uuid[], uuid) is
  'Approval-grant emit path for setup_work_order.create_required (§7.9 of the outbox spec). Reads pending_setup_trigger_args, emits one outbox event per non-null OLI, clears the args — all in one transaction. Replaces the inline triggerMany call at bundle.service.ts:1527.';
```

**TS-side cutover:** `BundleService.onApprovalDecided` at `bundle.service.ts:1521-1527` changes from:

```typescript
const oliIds = claimedRows.map((r) => r.oli_id);
if (decision === 'approved') {
  const triggerArgs = claimedRows
    .map((r) => r.args)
    .filter((a): a is TriggerArgs => a !== null);
  await this.setupTrigger.triggerMany(triggerArgs);   // REMOVED in v6
}
```

to:

```typescript
const oliIds = claimedRows.map((r) => r.oli_id);
if (decision === 'approved') {
  const { error: emitErr } = await this.supabase.admin.rpc(
    'approve_booking_setup_trigger',
    { p_oli_ids: oliIds, p_tenant_id: tenantId },
  );
  if (emitErr) {
    // Throws bubble to the approval-grant caller; the surrounding tx
    // rolls back so the approval decision itself doesn't commit if the
    // emit can't be made durable.
    throw emitErr;
  }
}
```

The race-guard block at `bundle.service.ts:1550-1604` (cancel-after-approve cleanup) **stays unchanged** — it now runs against the dedup table's commitment instead of the inline triggerMany's WO inserts; the cancel cascade still needs to close any setup WOs the handler creates. Document this coupling in the new RPC's comment.

**Why `claim_deferred_setup_trigger_args` is NOT folded into the new RPC:** the existing claim RPC predates v6 and ships in production (`supabase/migrations/00198_*` per `bundle.service.ts:1450-1451`'s comment). Two reasons to leave it standalone: (a) it's well-tested and the v6 change is additive; (b) `approve_booking_setup_trigger` reads `pending_setup_trigger_args` directly, so it doesn't need the claim RPC's "atomic read-and-null" semantics — the new RPC has its own `for update` lock, which is functionally equivalent. Future cleanup may collapse them; out of v6 scope.

---

## 8. Validation — tenant FKs (§8.1) + internal cross-references (§8.2)

Two helpers run before any insert in the combined RPC. §8.1 is the v5 tenant-FK matrix (every UUID validated against `p_tenant_id`); §8.2 is the v6 internal-graph helper that validates plan rows reference each other consistently. Both must pass before the RPC's INSERT phase runs.

### 8.1 Exhaustive tenant FK validation matrix

Every UUID in `BookingInput` and `AttachPlan` is validated against `p_tenant_id` before any insert. The single-statement form uses `array` aggregation + `EXCEPT`:

```sql
-- supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql

create or replace function public.validate_attach_plan_tenant_fks(
  p_tenant_id     uuid,
  p_booking_input jsonb,
  p_attach_plan   jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_missing uuid;
begin
  -- BookingInput fields ──────────────────────────────────────────────────

  -- requester_person_id (required)
  perform 1 from public.persons
   where id = (p_booking_input->>'requester_person_id')::uuid
     and tenant_id = p_tenant_id;
  if not found then
    raise exception 'attach_plan.fk_invalid: requester_person_id'
      using errcode = '42501';
  end if;

  -- host_person_id (optional)
  if p_booking_input->>'host_person_id' is not null
     and length(p_booking_input->>'host_person_id') > 0 then
    perform 1 from public.persons
     where id = (p_booking_input->>'host_person_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: host_person_id'
        using errcode = '42501';
    end if;
  end if;

  -- booked_by_user_id (optional)
  if p_booking_input->>'booked_by_user_id' is not null
     and length(p_booking_input->>'booked_by_user_id') > 0 then
    perform 1 from public.users
     where id = (p_booking_input->>'booked_by_user_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: booked_by_user_id'
        using errcode = '42501';
    end if;
  end if;

  -- location_id (required) — bookings.location_id REFERENCES spaces(id) at 00277:41
  perform 1 from public.spaces
   where id = (p_booking_input->>'location_id')::uuid
     and tenant_id = p_tenant_id;
  if not found then
    raise exception 'attach_plan.fk_invalid: location_id'
      using errcode = '42501';
  end if;

  -- cost_center_id (optional)
  if p_booking_input->>'cost_center_id' is not null
     and length(p_booking_input->>'cost_center_id') > 0 then
    perform 1 from public.cost_centers
     where id = (p_booking_input->>'cost_center_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: cost_center_id'
        using errcode = '42501';
    end if;
  end if;

  -- template_id (optional)
  if p_booking_input->>'template_id' is not null
     and length(p_booking_input->>'template_id') > 0 then
    perform 1 from public.bundle_templates
     where id = (p_booking_input->>'template_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: template_id'
        using errcode = '42501';
    end if;
  end if;

  -- recurrence_series_id (optional)
  if p_booking_input->>'recurrence_series_id' is not null
     and length(p_booking_input->>'recurrence_series_id') > 0 then
    perform 1 from public.recurrence_series
     where id = (p_booking_input->>'recurrence_series_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.fk_invalid: recurrence_series_id'
        using errcode = '42501';
    end if;
  end if;

  -- Slots: space_id (required per slot)
  with plan_ids as (
    select distinct (s->>'space_id')::uuid as id
      from jsonb_array_elements(p_booking_input->'slots') s
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.spaces sp
        where sp.id = pi.id and sp.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: slots[].space_id %', v_missing
      using errcode = '42501';
  end if;

  -- Slots: attendee_person_ids (optional, array)
  with plan_ids as (
    select distinct attendee::uuid as id
      from jsonb_array_elements(p_booking_input->'slots') s,
           jsonb_array_elements_text(coalesce(s->'attendee_person_ids', '[]'::jsonb)) attendee
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.persons p
        where p.id = pi.id and p.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: slots[].attendee_person_ids %', v_missing
      using errcode = '42501';
  end if;

  -- AttachPlan fields ───────────────────────────────────────────────────

  -- orders[].requester_person_id
  with plan_ids as (
    select distinct (o->>'requester_person_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'orders') o
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.persons p where p.id = pi.id and p.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: orders[].requester_person_id %', v_missing
      using errcode = '42501';
  end if;

  -- orders[].delivery_location_id
  with plan_ids as (
    select distinct (o->>'delivery_location_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'orders') o
     where o->>'delivery_location_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.spaces sp where sp.id = pi.id and sp.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: orders[].delivery_location_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].catalog_item_id (required)
  with plan_ids as (
    select distinct (li->>'catalog_item_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'order_line_items') li
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.catalog_items ci where ci.id = pi.id and ci.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].catalog_item_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].fulfillment_team_id (optional)
  with plan_ids as (
    select distinct (li->>'fulfillment_team_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'order_line_items') li
     where li->>'fulfillment_team_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.teams t where t.id = pi.id and t.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].fulfillment_team_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].vendor_id (optional)
  with plan_ids as (
    select distinct (li->>'vendor_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'order_line_items') li
     where li->>'vendor_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.vendors v where v.id = pi.id and v.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].vendor_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].menu_item_id (optional)
  with plan_ids as (
    select distinct (li->>'menu_item_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'order_line_items') li
     where li->>'menu_item_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.menu_items mi where mi.id = pi.id and mi.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].menu_item_id %', v_missing
      using errcode = '42501';
  end if;

  -- order_line_items[].linked_asset_id (optional; canonical asset existence check)
  with plan_ids as (
    select distinct (li->>'linked_asset_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'order_line_items') li
     where li->>'linked_asset_id' is not null
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.assets a where a.id = pi.id and a.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: order_line_items[].linked_asset_id %', v_missing
      using errcode = '42501';
  end if;

  -- asset_reservations[].asset_id (required)
  with plan_ids as (
    select distinct (a->>'asset_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'asset_reservations') a
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.assets ast where ast.id = pi.id and ast.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: asset_reservations[].asset_id %', v_missing
      using errcode = '42501';
  end if;

  -- asset_reservations[].requester_person_id
  with plan_ids as (
    select distinct (a->>'requester_person_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'asset_reservations') a
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.persons p where p.id = pi.id and p.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: asset_reservations[].requester_person_id %', v_missing
      using errcode = '42501';
  end if;

  -- approvals[].approver_person_id (one per row in v5; team-target expansion
  -- happens TS-side in assemblePlan and produces person rows here)
  with plan_ids as (
    select distinct (ap->>'approver_person_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'approvals') ap
  ), missing as (
    select pi.id from plan_ids pi
     where not exists (
       select 1 from public.persons p where p.id = pi.id and p.tenant_id = p_tenant_id
     )
  )
  select id into v_missing from missing limit 1;
  if v_missing is not null then
    raise exception 'attach_plan.fk_invalid: approvals[].approver_person_id %', v_missing
      using errcode = '42501';
  end if;
end;
$$;
```

**Why the matrix matters.** The existing supabase-js sequence (bundle.service.ts:1302-1314 for assets, 1120-1127 for catalog items) does ad-hoc `.eq('tenant_id', tenant.id)` filters on each lookup. The plan can't rely on those filters because TS already did the lookups in preflight; without an explicit RPC-side check, a buggy (or compromised) preflight could pass a foreign-tenant id into the plan. CLAUDE.md #0 demands the gate at every layer.

**Tests added (Phase 6 scope):** for each FK type listed above, an integration test that constructs a payload with a known foreign-tenant id and asserts the RPC raises `42501 attach_plan.fk_invalid: <field>`.

### 8.2 Internal cross-reference validation (NEW in v6 — folds I2)

The §8.1 matrix only checks that every UUID *exists* in the right tenant. It does NOT check that plan rows reference each other consistently — e.g., that every `order_line_items[].order_id` resolves to a row in `plan.orders[]`, or that every `approvals[].target_entity_id` matches the `booking_input.booking_id`. A buggy plan-builder (or a compromised one) could pass internally-inconsistent ids that pass the tenant matrix but produce malformed rows.

```sql
-- supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql (v6 addition)

create or replace function public.validate_attach_plan_internal_refs(
  p_booking_input jsonb,
  p_attach_plan   jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_booking_id uuid;
  v_order_ids  uuid[];
  v_oli_ids    uuid[];
  v_ar_ids     uuid[];
  v_slot_ids   uuid[];
  v_bad        uuid;
  v_bad_text   text;
begin
  v_booking_id := nullif(p_booking_input->>'booking_id', '')::uuid;
  if v_booking_id is null then
    raise exception 'attach_plan.internal_refs: booking_id missing'
      using errcode = '22023';
  end if;

  -- Collect plan-row id sets once for cheap membership checks.
  v_slot_ids := coalesce(
    (select array_agg((s->>'id')::uuid)
       from jsonb_array_elements(p_booking_input->'slots') s),
    '{}'::uuid[]);
  v_order_ids := coalesce(
    (select array_agg((o->>'id')::uuid)
       from jsonb_array_elements(p_attach_plan->'orders') o),
    '{}'::uuid[]);
  v_oli_ids := coalesce(
    (select array_agg((li->>'id')::uuid)
       from jsonb_array_elements(p_attach_plan->'order_line_items') li),
    '{}'::uuid[]);
  v_ar_ids := coalesce(
    (select array_agg((ar->>'id')::uuid)
       from jsonb_array_elements(p_attach_plan->'asset_reservations') ar),
    '{}'::uuid[]);

  -- 1. order_line_items[].order_id must reference plan.orders[].id
  select (li->>'order_id')::uuid into v_bad
    from jsonb_array_elements(p_attach_plan->'order_line_items') li
   where (li->>'order_id')::uuid <> all(v_order_ids)
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: order_line_items[].order_id % not in plan.orders[]', v_bad
      using errcode = '22023';
  end if;

  -- 2. order_line_items[].linked_asset_reservation_id (when set) must
  --    reference plan.asset_reservations[].id
  select (li->>'linked_asset_reservation_id')::uuid into v_bad
    from jsonb_array_elements(p_attach_plan->'order_line_items') li
   where li->>'linked_asset_reservation_id' is not null
     and (li->>'linked_asset_reservation_id')::uuid <> all(v_ar_ids)
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: order_line_items[].linked_asset_reservation_id % not in plan.asset_reservations[]', v_bad
      using errcode = '22023';
  end if;

  -- 3. asset_reservations[].booking_id must equal booking_input.booking_id
  select (ar->>'booking_id')::uuid into v_bad
    from jsonb_array_elements(p_attach_plan->'asset_reservations') ar
   where (ar->>'booking_id')::uuid <> v_booking_id
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: asset_reservations[].booking_id % does not match booking_input.booking_id', v_bad
      using errcode = '22023';
  end if;

  -- 4. approvals[].target_entity_id must equal booking_input.booking_id
  --    (approvals target the booking; v5 §7.4 has target_entity_type='booking')
  select (ap->>'target_entity_id')::uuid into v_bad
    from jsonb_array_elements(p_attach_plan->'approvals') ap
   where (ap->>'target_entity_id')::uuid <> v_booking_id
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: approvals[].target_entity_id % does not match booking_input.booking_id', v_bad
      using errcode = '22023';
  end if;

  -- 5. bundle_audit_payload internal references (defense-in-depth — the
  --    audit row is part of the plan and downstream readers depend on it)
  select id_text into v_bad_text
    from jsonb_array_elements_text(coalesce(p_attach_plan->'bundle_audit_payload'->'order_ids', '[]'::jsonb)) id_text
   where id_text::uuid <> all(v_order_ids)
   limit 1;
  if v_bad_text is not null then
    raise exception 'attach_plan.internal_refs: bundle_audit_payload.order_ids % not in plan.orders[]', v_bad_text
      using errcode = '22023';
  end if;
  select id_text into v_bad_text
    from jsonb_array_elements_text(coalesce(p_attach_plan->'bundle_audit_payload'->'order_line_item_ids', '[]'::jsonb)) id_text
   where id_text::uuid <> all(v_oli_ids)
   limit 1;
  if v_bad_text is not null then
    raise exception 'attach_plan.internal_refs: bundle_audit_payload.order_line_item_ids % not in plan.order_line_items[]', v_bad_text
      using errcode = '22023';
  end if;

  -- 6. order_line_items[].pending_setup_trigger_args, when present, must
  --    reference the same OLI (no cross-contamination of args between lines).
  --    The args object is set up by TS preflight; defense-in-depth here.
  select (li->>'id')::uuid into v_bad
    from jsonb_array_elements(p_attach_plan->'order_line_items') li
   where li->'pending_setup_trigger_args' is not null
     and (li->'pending_setup_trigger_args'->>'oliId')::uuid is distinct from (li->>'id')::uuid
   limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: order_line_items[].pending_setup_trigger_args.oliId mismatch on %', v_bad
      using errcode = '22023';
  end if;
end;
$$;

comment on function public.validate_attach_plan_internal_refs(jsonb, jsonb) is
  'Validates internal cross-references in the AttachPlan + BookingInput payloads. Runs alongside validate_attach_plan_tenant_fks before any insert in create_booking_with_attach_plan. v6-I2 (codex review of v5).';
```

**What §8.1 vs §8.2 each catch:**
- §8.1 catches a *cross-tenant* leak: a UUID that exists but in a different tenant (CLAUDE.md #0 invariant).
- §8.2 catches an *internally-inconsistent plan*: UUIDs that all exist in the right tenant but reference each other wrong (a buggy plan-builder, an attacker mutating the plan in transit between TS and the RPC, a future contributor who misunderstands the plan shape).

The two together close the failure modes a per-table FK constraint would not: PostgreSQL's `REFERENCES` clause checks existence, not tenant scope, and not plan-internal consistency. Both helpers are SECURITY INVOKER and run in the RPC's tx; failures roll back the marker insert with the rest of the work.

**Snapshot UUIDs are NOT validated here.** `applied_rule_ids[]`, `config_release_id`, `setup_emit.rule_ids[]`, and approval-reason `rule_id` values are admin-time references to tenant-scoped rule/config tables. Cross-checking each against the rules tables is achievable but adds N more tenant-scoped lookups for every plan; the value is low because (a) those columns are write-once snapshots — nobody reads them as authoritative tenant boundaries; (b) a corrupt rule_id would be visible to the audit trail but cause no security or correctness harm in the booking write path. **Open question §11**: revisit if the rules tables ever become a cross-tenant boundary (e.g. shared template registry).

**Tests added (Phase 6 scope):** one integration test per check above (6 tests). Each constructs a plan that passes §8.1 but fails §8.2 and asserts `22023 attach_plan.internal_refs: <field>`.

---

## 9. Idempotency contracts

### 9.1 Operation idempotency (combined RPC)

Per §7.3 — `attach_operations` table. TS callers MUST construct deterministic idempotency keys. Recommended pattern:

```typescript
// In BookingFlowService.create
const idempotencyKey = `booking.create:${actor.user_id}:${input.client_request_id ?? randomUUID()}`;
```

`client_request_id` is a header the frontend sends on retry (already used by the request middleware for trace linking; documented in `apps/web/src/api/api-fetch.ts`). When present, retries reuse the same key. When absent, each attempt generates a fresh UUID — that's correct for "retry was a fresh user click" but means the idempotency mechanism can't dedupe automatic retries. The frontend's React Query mutation layer already supplies a client_request_id per mutation (cf. the `RequestIdProvider`); the Phase 6 integration sketches this for `BookingFlowService` first.

### 9.2 Event handler idempotency (setup-WO and future events) — v6 update

Every handler MUST be safe to invoke multiple times for the same event. v6 changes the setup-WO handler's mechanism (codex I1):

1. **Durable dedup table (preferred for state-changing handlers)** — a dedicated table keyed by `(tenant_id, aggregate_id)` with a row inserted in the same tx as the side-effect. Setup-WO uses `setup_work_order_emissions` (§2.5). The handler `SELECT FOR UPDATE`s the row; presence = "already handled, return"; absence = "perform side effect + insert dedup row". Survives state changes on the underlying aggregate (e.g. WO closed/cancelled), survives event replays.
2. **Aggregate state check** — load the aggregate; if it's already in the post-event state, return success. **v5 §7.7 used this for setup-WO via `work_orders.linked_order_line_item_id` lookup**; codex flagged the race (non-unique index, lookup-then-insert window, status-filter holes on cancelled WOs). v6 retires this approach for setup-WO. Still acceptable for handlers where the aggregate's state IS the dedup signal (e.g. an SLA timer where `sla_timers.created_at` is the once-per-event marker).
3. **Outbox dedup token in the side-effect** — when sending a Slack/email, include the event's outbox `id` as the message dedup token, so the recipient's inbound webhook can deduplicate even if our retry happens after their ACK.

The infrastructure delivers at-least-once; handlers convert that to effectively-once.

**v6 setup-WO dedup specifics:** §7.8 step 3 reads `setup_work_order_emissions` for `(tenant_id, oli_id)`. If found → return success (idempotent re-handling). If not found → call `triggerStrict()`. On `kind: 'created'` → INSERT into `setup_work_order_emissions` with `outbox_event_id`. On `kind: 'no_op_terminal'` → do NOT insert; future replays re-evaluate routing. On throw → handler retries via worker state machine.

### 9.3 Plan idempotency on RPC retry (the v6 fold of v4-C3)

If `create_booking_with_attach_plan` is called twice with the same `p_idempotency_key`:
- Same payload + previous outcome=success → `attach_operations` returns `cached_result` immediately. No work done.
- Same payload + previously rolled-back tx (no row visible) → second call starts fresh. The `pg_advisory_xact_lock` (§7.3 v6-C2) ensures the second caller sees the committed state of the first, never a half-committed view.
- Different payload → `payload_mismatch` raised. Bug surfacing.

The v4 C3 hole — "TS retries that rebuild the plan with fresh UUIDs bypass per-UUID dedup" — is closed because:
1. The dedup is on `(tenant_id, idempotency_key)` at the operation level, not on per-row UUIDs.
2. **v6** ensures the rebuilt plan has identical UUIDs to the original (deterministic uuidv5 — §7.4), so the `payload_hash` matches and `cached_result` is returned. Without v6's fix, even retries with the same idempotency_key would have hashed differently and tripped `payload_mismatch` — the exact opposite of idempotency.

The per-row UUIDs are still the disaster recovery mechanism (a 23505 collision would roll the whole tx back), but they're not the primary dedup gate.

---

## 10. Setup-WO is NOT best-effort — explicit framing

Per the user direction:

> "Don't call setup-WO 'best-effort' if missing it creates operational corruption. If a setup work order is required for a booking/service to be fulfilled, it belongs either inside the combined RPC or as a durable outbox event emitted from inside that RPC. 'Best-effort post-commit' is only acceptable for notifications, analytics, and non-critical side effects."

**Inside the RPC vs outbox event from RPC — the call:** outbox event from RPC.

Reasoning:
- The setup-WO creation logic in `SetupWorkOrderTriggerService.trigger` (setup-work-order-trigger.service.ts:46-143) is ~80 lines: routing matrix lookup via `resolve_setup_routing` RPC, lead-time math, ticket creation via `TicketService.createBookingOriginWorkOrder` (which itself spans 100+ lines of orchestration: SLA policy attachment, audit metadata, module number assignment, dispatch hooks). Porting that to PL/pgSQL is multi-week work and creates a second copy to keep in sync.
- Emitting the event atomically from the combined RPC gives full durability semantics: if the RPC commits, the event is durable; if the handler crashes, retry kicks in; if it dead-letters, audit + ops alert. That's the "either inside RPC or durable outbox event from RPC" condition the user direction allows.
- The cost of the outbox path: the WO is created ~100ms-1s after the booking commits (one drain cycle plus handler latency). For "internal setup work" specifically — not a customer-facing thing — that latency is invisible; the kitchen team's view of today's prep list refreshes on the order of minutes anyway.

**What changes vs today's best-effort (covering BOTH the create path AND the approval-grant path):**

| Today | v6 (outbox handler + approve_booking_setup_trigger RPC) |
|---|---|
| Create path: `bundle.service.ts:456` — `triggerMany` post-commit (best-effort fire-and-forget) | Durable retry with backoff via outbox event emitted inside `create_booking_with_attach_plan` (§7.6 step 12) |
| Approval path: `bundle.service.ts:1527` — `triggerMany` after `claim_deferred_setup_trigger_args` (best-effort fire-and-forget; **v5 left this unchanged — codex C4**) | Durable: `approve_booking_setup_trigger` RPC reads args + emits outbox event + clears args atomically (§7.9) |
| Failure logs + audits at `severity: 'high'` and stops | Failure logs + audits, retry up to 5 times, then dead-letter |
| Node process crash between booking commit (or approval-grant commit) and trigger fire = WO never created | Event durable in `outbox.events` from before commit; survives Node crash on either path |
| Tenant misconfigured (no team in matrix) = audit + manual recovery | Same audit; handler `triggerStrict` returns `kind: 'no_op_terminal'` and event is processed (admin reconfig + replay creates WO) |
| Transient DB errors silently swallowed by `trigger`'s outer try/catch — handler thinks "terminal", marks event processed, WO permanently lost | `triggerStrict` (v6-C3) re-throws transient errors → outbox retries with backoff |
| Idempotency: relies on `pending_setup_trigger_args` claim RPC for the deferred-on-approval case only; create path has no dedup | Idempotent on `(tenant_id, oli_id)` via `setup_work_order_emissions` table (§2.5 / §9.2 — v6-I1) — survives WO close + replay |

**During Phase A:** both paths run — old best-effort + new shadow handler. The shadow handler writes `outbox_shadow_results`; the old best-effort path actually creates the WO. The gate query in §5.2 confirms they agree before flipping in Phase B.

**Phase B cutover scope (v6 — both paths cut over together):**
- `bundle.service.ts:456` — remove `triggerMany` call (create path); the outbox emission inside `create_booking_with_attach_plan` becomes the only path.
- `bundle.service.ts:1527` — remove `triggerMany` call (approval-grant path); replace with `approve_booking_setup_trigger` RPC call.
- The race-guard block at `bundle.service.ts:1550-1604` (cancel-after-approve cleanup) stays — it now coordinates with handler-emitted WOs instead of inline triggerMany WOs.

After Phase B, `SetupWorkOrderTriggerService.trigger` and `triggerMany` have no production callers. They stay in the codebase for one cutover pass (audit) and are deleted in the v5/v6 cleanup commit (§16).

**Recovery from old orphans:** if any bookings exist in production with services that should have triggered setup-WOs but didn't (because the old best-effort path failed silently — it does happen; we have audit rows from past incidents), Phase B doesn't automatically backfill them. Backfill is a separate operation: a script that reads `audit_events` for `bundle.setup_work_order_create_failed` and re-emits the events through the outbox. Documented separately; out of v5/v6 spec scope.

---

## 11. Open questions remaining (post-v6)

Not blocking implementation; revisit during Phase 6 hardening or earlier if prod signals demand.

1. **Per-tenant fairness** (still open) — sharded per-tenant worker vs today's FIFO drain. The optional `idx_outbox_events_per_tenant_pending` index supports it. Defer until a noisy-neighbor incident or a tenant >100x median emit rate.
2. **Cross-region replication** (still open) — probably "worker in primary DB region; cross-region events catch up in seconds." Confirm before we ship a multi-region tenant.
3. **Webhook delivery via outbox** (still open) — likely yes with a dedicated `webhook.deliver_required` event type; revisit in the webhook hardening sprint.
4. **`outbox_emit_via_rpc` PostgREST wrapper kept or dropped** (still open; v5/v6 don't need it for the booking path because the combined RPC and `approve_booking_setup_trigger` emit via direct `outbox.emit()` calls). Re-evaluate once we have ≥2 TS-side `emit` call sites in production. Currently zero in steady state — the `OutboxService.emit()` fire-and-forget path is the only TS caller and could go through `outbox_emit_via_rpc` or a future direct-table path. Keep for now (cheap to maintain, low coupling).
5. **`outbox_shadow_results` retention** (still open) — needs a daily purge job; fold into the GDPR retention catalog when Phase B lands.
6. **Standalone-order path migration** (still open) — `OrderService.createStandaloneOrder` (the `/portal/order` flow with no booking) writes orders + OLIs + asset_reservations + approvals via supabase-js sequence (not yet ported). Same architectural concerns as the booking path; should be a separate `create_standalone_order_with_attach_plan` RPC in a follow-up slice. The existing `ApprovalRoutingService.assemble` (write-side) stays for that caller.
7. **Snapshot UUID validation in §8.2** (NEW open) — v6 §8.2 explicitly skips cross-checking `applied_rule_ids[]`, `config_release_id`, `setup_emit.rule_ids[]`, and approval-reason `rule_id` values against the rules tables. Low-value today (those columns are write-once snapshots, not enforcement boundaries). Revisit if shared/cross-tenant rule registries become a thing.
8. **Collapse `claim_deferred_setup_trigger_args` into `approve_booking_setup_trigger`** (NEW open) — v6 leaves the existing claim RPC standalone for backwards compatibility (§7.9 last paragraph). A follow-up cleanup could fold it into the approve RPC and remove one round trip from the approval-grant path. Out of v6 scope.

**Resolved by v6 (codex review of v5):**

- ~~v5 C1 (random UUIDs defeat operation idempotency)~~ — deterministic uuidv5 from `(idempotency_key, row_kind, stable_index)`, §7.4.
- ~~v5 C2 (FOR UPDATE doesn't see uncommitted rows; concurrent retries get 23505)~~ — `pg_advisory_xact_lock` at top of RPC, §7.3.
- ~~v5 C3 (handler called best-effort `trigger`; transient errors swallowed)~~ — `triggerStrict` with typed terminal outcomes + thrown transients, §7.7.
- ~~v5 C4 (approval-grant path bypassed outbox via direct `triggerMany`)~~ — `approve_booking_setup_trigger` RPC, §7.9.
- ~~v5 I1 (handler dedup via non-unique `work_orders.linked_order_line_item_id` was racy)~~ — `setup_work_order_emissions` table, §2.5 + §7.8.
- ~~v5 I2 (no internal-graph FK validation; v5 §8 only checked tenant)~~ — `validate_attach_plan_internal_refs` helper, §8.2.
- ~~v5 I3 (failed/stale in_progress states never produced; spec described unreachable states)~~ — `outcome` enum collapsed to `('in_progress', 'success')`; stale-row purge dropped, §2.4.
- ~~v5 N1 (`outbox.service.ts` still documents v3/v4 lease semantics)~~ — `markConsumed` removed; `booking.create_attempted` references removed, §3.2 + §16.

**Resolved by v5 (codex review of v4):**

- ~~Lease window tuning~~ — v3/v4 lease entirely removed.
- ~~Watchdog races success path~~ — v3/v4 watchdog entirely removed.
- ~~Compensation false-positive on slow attach~~ — no compensation = no false positive.
- ~~v4 C1 (GUC propagation)~~ — no GUC; lease config retired.
- ~~v4 C2 (slow preflight window)~~ — no preflight-vs-attach window; one transaction.
- ~~v4 C3 (operation idempotency hole)~~ — `attach_operations` table, §7.3.
- ~~v4 C4 (incomplete FK matrix)~~ — exhaustive matrix in §8.1.
- ~~v4 I2 (approvals[].id)~~ — pre-generated TS-side, §7.4.

---

## 12. File locations

### Schema
- `supabase/migrations/00299_outbox_foundation.sql` — `outbox.events`, `outbox.events_dead_letter`, `outbox.emit()` + `outbox.mark_consumed()` helpers, `outbox_emit_via_rpc` + `outbox_mark_consumed_via_rpc` PostgREST wrappers, GRANTs, `outbox_shadow_results`. **Already applied** (foundation).
- `supabase/migrations/00300_outbox_shadow_results_fk_set_null.sql` — `outbox_shadow_results.outbox_event_id` FK ON DELETE SET NULL. **Already applied**.
- `supabase/migrations/00301_outbox_emit_revoke_authenticated.sql` — codex v3 follow-up. **Already applied**.
- `supabase/migrations/00302_attach_operations.sql` — `attach_operations` table (§2.4). **NEW in v5; v6 contract drops `failed` from outcome enum**.
- `supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql` — `create_booking_with_attach_plan` RPC + `validate_attach_plan_tenant_fks` helper (§7.6 + §8.1) + `validate_attach_plan_internal_refs` helper (§8.2 — v6 addition). **NEW in v5; v6 adds advisory lock + internal-refs helper**.
- `supabase/migrations/00304_setup_work_order_emissions.sql` — `setup_work_order_emissions` dedup table (§2.5). **NEW in v6**.
- `supabase/migrations/00305_approve_booking_setup_trigger_rpc.sql` — `approve_booking_setup_trigger` RPC (§7.9). **NEW in v6**.

### TypeScript
- `apps/api/src/modules/outbox/outbox.service.ts` — fire-and-forget producer only. **v6 cleanup:** strip `markConsumed` method (lines 67-82) + `booking.create_attempted` references in the module-level docstring (lines 18-21).
- `apps/api/src/modules/outbox/outbox.worker.ts` — drain loop with the §4.2 state machine.
- `apps/api/src/modules/outbox/outbox-handler.registry.ts` — decorator-driven registry.
- `apps/api/src/modules/outbox/outbox-handler.decorator.ts` — `@OutboxHandler(eventType, { version })`.
- `apps/api/src/modules/outbox/dead-letter.error.ts` — `DeadLetterError` sentinel.
- `apps/api/src/modules/outbox/handlers/setup-work-order.handler.ts` — the setup-WO handler (§7.8). **NEW in v5; v6 swaps WO-row dedup for `setup_work_order_emissions` table + uses `triggerStrict`**.
- `apps/api/src/modules/booking-bundles/plan-uuid.ts` — `planUuid()` deterministic uuidv5 helper (§7.4). **NEW in v6**.
- `apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts` — adds `triggerStrict()` strict-mode method (§7.7). **v6 addition**. Best-effort `trigger`/`triggerMany` stay for one cutover pass; deleted in the v5/v6 cleanup commit (§16).
- `apps/api/src/modules/booking-bundles/bundle.service.ts` — `attachServicesToBooking` becomes:
  - `buildAttachPlan(args)` — pure preflight; returns `AttachPlan` (§7.4). Uses `planUuid()` for every UUID.
  - The combined-RPC call site moves into `BookingFlowService.create` (§file below).
  - The `Cleanup` class (bundle.service.ts:1878-1972) is **deleted** — no longer needed because every insert is inside the combined RPC's transaction; rollback is automatic.
  - `onApprovalDecided` at line 1521-1527 — `triggerMany` call replaced by `approve_booking_setup_trigger` RPC (§7.9). **v6 cutover**.
- `apps/api/src/modules/orders/approval-routing.service.ts` — gains a `assemblePlan(args)` method that returns the same shape as `assemble(args)` but does NOT write to `approvals` (the RPC does). v6: `assemblePlan` takes `idempotencyKey` and uses `planUuid()` for approval ids. `assemble` itself stays for the standalone-order path (§11 future work).
- `apps/api/src/modules/reservations/booking-flow.service.ts` — `create()` is refactored:
  - Build `BookingInput` from input params (where `create_booking` was called before).
  - Call `BundleService.buildAttachPlan` (when services are present) to build `AttachPlan`.
  - Call `create_booking_with_attach_plan` RPC with both payloads.
  - Drop the `txBoundary.runWithCompensation` wrapping (booking-flow.service.ts:408-425) — no compensation needed.
- `apps/api/src/modules/reservations/booking-transaction-boundary.ts` — kept for non-attach orphan recovery cases (e.g. a booking that gets stranded because a downstream cron failed); not the booking creation path.
- `apps/api/src/modules/reservations/booking-compensation.service.ts` — kept for `delete_booking_with_guard` callers that aren't the create path (admin tooling, manual cleanup); the `markAttachedRecovery` method proposed in v4 is deleted (no lease to recover).

### Existing references
- Audit outbox service: `apps/api/src/modules/privacy-compliance/audit-outbox.service.ts:1-103`.
- Audit outbox worker: `apps/api/src/modules/privacy-compliance/audit-outbox.worker.ts:20-166`.
- Setup-WO trigger today: `apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts:30-202` (kept for handler invocation; called by the new handler).
- Tenant context: `apps/api/src/common/tenant-context.ts:1-29`.
- `create_booking` RPC (no-services path): `supabase/migrations/00277_create_canonical_booking_schema.sql:236-334` (unchanged).
- `delete_booking_with_guard` RPC: `supabase/migrations/00292_delete_booking_with_guard_rpc.sql:54-141` (unchanged from current; v4's lock+re-check amendments dropped).
- Booking-flow producer: `apps/api/src/modules/reservations/booking-flow.service.ts:102-454` (`create` method; will be refactored to call combined RPC).
- BundleService attach today: `apps/api/src/modules/booking-bundles/bundle.service.ts:164-494` (`attachServicesToBooking` — body becomes `buildAttachPlan` + `create_booking_with_attach_plan` call).
- BundleService Cleanup helper today: `apps/api/src/modules/booking-bundles/bundle.service.ts:1878-1972` (**deleted in v5** — atomic RPC subsumes it).
- Approval routing (write-side): `apps/api/src/modules/orders/approval-routing.service.ts:96-353` (`assemble` stays for standalone-order path; new `assemblePlan` for combined-RPC path).

---

## 13. Failure modes

### 13.1 Purge cadence (unchanged)

A separate `@Cron(CronExpression.EVERY_HOUR)` method on the worker runs `purgeProcessed` regardless of drain state. Cheap, narrow, decoupled.

### 13.2 `attach_operations` stale-row purge — DROPPED IN V6

v5 specified a daily cron to purge stale `outcome='in_progress'` rows on the assumption that a crashed RPC could leave one behind. v6 establishes this is structurally impossible: the marker INSERT is inside the RPC's tx; any RPC failure rolls the marker back with the rest of the work. There is no execution path that produces a persistent `in_progress` row, so there is nothing for the cron to purge. Section retired in v6 alongside the `failed`/stale `in_progress` contract changes in §2.4.

If a future schema change reintroduces a path where `in_progress` could outlive a tx (e.g. an outer wrapping function that inserts before the inner work), this section comes back.

### 13.3 Cross-tenant smuggling defense (unchanged from v3/v4)

Handlers MUST explicitly load the aggregate row, assert `aggregate.tenant_id === event.tenant_id`, and dead-letter on mismatch via `DeadLetterError`. Tenant mismatch is not a transient error.

### 13.4 The "watchdog races success path" failure mode (v3/v4) — eliminated in v5

Both v3's "30s lease too tight" and v4's "5min lease + lock+re-check" failure modes are structurally impossible in v5+ because there is no separate watchdog and no separate attach phase. The booking + services commit as one transaction. If the transaction commits, both exist; if it rolls back, neither does.

### 13.5 Concurrent retry collision (v5 → v6)

v5's `SELECT FOR UPDATE` couldn't see uncommitted rows from a concurrent retry. Two callers with the same idempotency key both passed the gate, both INSERTed the marker, second got `23505`. v6's `pg_advisory_xact_lock` (§7.3) closes this: the second caller blocks at the lock, and by the time it acquires the lock + reads `attach_operations`, the first caller's marker is committed (or rolled back, leaving no row to read — in which case the second caller is structurally identical to a first attempt).

---

## 14. Observability

Carry forward the foundation metrics. v5/v6 changes:

- **`outbox_setup_wo_emissions_total{tenant_id, source, requires_approval}`** — counter incremented on each emission of `setup_work_order.create_required`. `source` label distinguishes `create_path` (combined RPC §7.6) vs `approval_grant_path` (approve_booking_setup_trigger §7.9). Phase A baseline. Phase B should match (same RPC bodies in both phases; the cutover is at the handler, not the producer).
- **`outbox_setup_wo_handler_outcomes_total{outcome}`** — labels: `created | already_emitted | no_routing_match | invalid_window | tenant_mismatch | dead_lettered`. The `dead_lettered` count is the most important production signal — every increment = a service line that should have a setup work order and doesn't. `already_emitted` = dedup table hit (v6-I1); high counts indicate at-least-once retries are working as designed.
- **`attach_operations_outcomes_total{outcome}`** — labels: `success | payload_mismatch | unexpected_state`. v6 dropped `failed` and `duplicate_in_flight` (impossible post-advisory-lock). `payload_mismatch` should be 0 in steady state (any non-zero = a TS bug constructing non-deterministic UUIDs or keys; v6's deterministic uuidv5 should keep this at zero).
- **`create_booking_with_attach_plan_duration_ms`** histogram — replaces v4's `outbox_attach_rpc_duration_ms`. p99 informs whether the RPC is acceptably fast for the synchronous request path. If p99 climbs above 2s sustained, profile + tune (likely candidates: the FK validation matrix's `EXCEPT` queries on cold caches, or the GiST exclusion check on heavy contention). v6 adds the advisory-lock wait time as part of this measurement; under contention the p99 will tick up but the lock holders are quick (sub-second RPC body), so saturation should be bounded.
- **`approve_booking_setup_trigger_duration_ms`** histogram — NEW in v6. p99 informs whether the approval-grant emit path is fast enough that approval-grant UX doesn't notice. Expected: well under 100ms for typical batches.
- **`setup_work_order_emissions_inserts_total{outcome}`** — NEW in v6. Labels: `inserted | duplicate`. `duplicate` indicates a handler retry where the previous attempt actually committed but the worker failed to mark `processed_at` (rare; see §13.x retry semantics).

Removed (vs v4):
- `outbox_lease_recovery_total` (no lease)
- `outbox_attach_rpc_duration_ms` (replaced by combined RPC duration)
- `compensated_watchdog`, `already_attached_via_watchdog`, etc. labels (no watchdog)

---

## 15. Test infrastructure

### 15.1 Unit tests (TS)

- `BundleService.buildAttachPlan` — every row type covered. Snapshot the produced plan against `bundle.service.ts:191-472` row-by-row to confirm parity.
- `ApprovalRoutingService.assemblePlan` — mirrors existing `assemble` tests but asserts no DB write happened (mock the supabase client; assert no calls). Same dedup behavior.

### 15.2 Integration tests (RPC)

- `create_booking_with_attach_plan` happy path — full payload with 2 orders, 3 OLIs, 1 asset reservation, 1 approval. Assert all rows landed; cached_result returned matches.
- Idempotent retry — call twice with same key, same payload. Second call returns cached_result without re-inserting. **v6:** assert UUID stability — TS plan-build twice for same input produces identical UUIDs (deterministic uuidv5).
- Payload mismatch — call twice with same key, different payload. Second call raises `attach_operations.payload_mismatch`.
- **v6: Concurrent retry with advisory lock** — two parallel calls with same `(tenant_id, idempotency_key)` and same payload. First commits, second waits at `pg_advisory_xact_lock`, then reads the success row and returns `cached_result`. Assert no `23505` surfaces. (Replaces v5's "duplicate in-flight" test, which exercised a state v6 makes impossible.)
- FK validation failure (§8.1 tenant matrix) for each FK type (16 tests). Each constructs a payload with one foreign-tenant id and asserts `42501 attach_plan.fk_invalid: <field>`.
- **v6: Internal-graph validation failure (§8.2)** — 6 tests, one per check in `validate_attach_plan_internal_refs`. Each constructs a plan that passes §8.1 but fails §8.2 (e.g., OLI with `order_id` not in plan, approval `target_entity_id` ≠ `booking_id`, asset_reservation `booking_id` mismatch). Assert `22023 attach_plan.internal_refs: <field>`.
- GiST asset conflict — two concurrent calls reserving overlapping asset windows. One succeeds, one rolls back with `23P01`.
- Slot overlap conflict — two concurrent calls on the same room/time. One succeeds, one rolls back with `23P01`.
- Deny short-circuit — plan with `any_deny=true`. RPC raises `42P10` before any insert; assert no rows landed.
- **v6: `approve_booking_setup_trigger` happy path** — pre-populate OLIs with `pending_setup_trigger_args`; call RPC; assert `outbox.events` rows for each non-null OLI; assert `pending_setup_trigger_args` are now NULL on those OLIs.
- **v6: `approve_booking_setup_trigger` idempotency** — call RPC twice for the same OLIs. Second call's `outbox.emit` returns the existing event id (same idempotency_key/payload); no duplicate events.
- **v6: `approve_booking_setup_trigger` cancel-race** — pre-populate OLIs with args, then mark one as `fulfillment_status='cancelled'`; call RPC; assert NO event emitted for the cancelled OLI.

### 15.3 Smoke gate extension

`pnpm smoke:work-orders` already covers the work-order command surface. Phase 6 extends it with:
- `pnpm smoke:booking-create-with-services` — creates a real booking with services through `BookingFlowService.create` against the running API. Asserts: booking row exists, slots exist, orders exist, OLIs exist, asset reservations exist (when applicable), approvals exist (when applicable), `outbox.events` row exists for each setup-WO emission. Idempotency probe: replays the same request with the same `client_request_id` and asserts identical row IDs returned (verifying deterministic-uuidv5 + advisory-lock + cached_result paths in concert).
- **v6:** `pnpm smoke:approve-booking-setup-trigger` — creates a booking with services that triggers approval; grants the approval; asserts `outbox.events` rows landed via the new RPC.

This replaces v4's "forced lease-expiry probe" — the failure mode it tested (crash between create_booking and attach_services_to_booking) doesn't exist in v5+.

### 15.4 Setup-WO comparison probe (Phase A gate)

Per §5.2. Two scenarios (configured matrix + misconfigured matrix); shadow handler vs inline best-effort path; assert outcomes match. Hooked into staging CI; mandatory before each Phase A → B deploy. **v6:** the shadow handler's `dryRun` replicates `triggerStrict` instead of `trigger`; expected outcomes are typed (`would_create | no_op_terminal{reason}`) rather than nullable.

### 15.5 Handler dedup test (NEW in v6)

- Insert a `setup_work_order_emissions` row manually for `(tenant_id, oli_id)`. Fire the same outbox event. Assert handler returns success WITHOUT calling `triggerStrict` (mock the trigger; assert zero calls).
- Concurrent handler dispatch: two workers somehow claim the same event (force via stale-claim recovery). Both reach the dedup `SELECT FOR UPDATE`. One blocks; the other inserts the dedup row + creates the WO; the blocked one reads the committed dedup row and returns. Assert exactly one WO created.
- Cancel-then-replay: handler creates WO + dedup row; admin cancels the WO; replay the same outbox event. Assert handler returns "already_emitted" without creating a second WO.

---

## 16. Rollout / Success criteria

### 16.1 v5/v6 cleanup commit (lands BEFORE B.0 implementation; folds N1)

The cleanup pass that closes the implementation-vs-spec drift identified by codex N1. **This commit is the prerequisite for any v6 work** — strip the dead lease-era code so subsequent commits are reasoning against an honest baseline.

Scope:

1. `apps/api/src/modules/outbox/outbox.service.ts`
   - Delete `markConsumed()` method (lines 67-82).
   - Update the module-level docstring (lines 5-21) — remove the v3/v4 lease semantics description, the "two methods, two semantics" framing, the `markConsumed` paragraph, the `booking.create_attempted` reference. Replace with a concise "fire-and-forget producer for best-effort emissions; durability comes from RPC-side `outbox.emit()` calls" summary.
   - Update the `emit()` method's docstring (lines 28-36) — drop the "same-payload re-emit is a no-op silent success in the SQL helper" if redundant; keep the "23505 caught and logged" sentence.

2. `apps/api/src/modules/outbox/__tests__/` — delete any tests that exercised `markConsumed` or `booking.create_attempted` event handling; they describe v3/v4 contracts that no longer exist.

3. `supabase/migrations/00299_outbox_foundation.sql` — `outbox_mark_consumed_via_rpc` PostgREST wrapper STAYS (per §2.3); it's dormant infra.

4. Search `apps/api/src/` for `booking.create_attempted` string occurrences — should be zero after the docstring update. Add a CI grep guard in the cleanup commit message.

5. Search the codebase for `OutboxService.markConsumed` callers — should be zero after the method deletion. Compiler will catch any miss.

This commit lands ahead of B.0 (§16.2) so the v6 implementation work isn't fighting against stale infrastructure.

### 16.2 Phase 6 (B.0 + cutover) is complete when:

1. v5/v6 NEW migrations applied to remote Supabase + `notify pgrst, 'reload schema'`:
   - 00302 (`attach_operations` — v6 contract: outcome enum collapsed to `('in_progress', 'success')`).
   - 00303 (`create_booking_with_attach_plan` RPC + `validate_attach_plan_tenant_fks` + v6 `validate_attach_plan_internal_refs`).
   - 00304 (`setup_work_order_emissions` — v6 NEW).
   - 00305 (`approve_booking_setup_trigger` RPC — v6 NEW).
2. `OutboxService` (emit-only — post-cleanup §16.1) + `OutboxWorker` (§4.2 state machine) + decorator registry implemented + unit-tested.
3. `planUuid()` helper (`apps/api/src/modules/booking-bundles/plan-uuid.ts`) implemented + unit-tested. Tests assert: same `(idempotencyKey, rowKind, stableIndex)` → same UUID across runs; different inputs → different UUIDs; namespace constant is committed and never rotated.
4. `BundleService.buildAttachPlan` unit-tested against the survey of existing `attachServicesToBooking` writes (every row type covered). Stable-index discipline asserted: `buildAttachPlan(input)` called twice produces a byte-identical jsonb plan.
5. `ApprovalRoutingService.assemblePlan` unit-tested; matches `assemble`'s dedup logic without writing; uses `planUuid` for approval ids.
6. `create_booking_with_attach_plan` RPC integration-tested per §15.2 (including v6 advisory-lock + internal-refs tests).
7. `SetupWorkOrderTriggerService.triggerStrict` unit-tested: terminal outcomes for `no_routing_match` / `invalid_window` / `config_disabled`; thrown errors for RPC failures + ticket-insert failures.
8. `SetupWorkOrderHandler` (using `triggerStrict` + `setup_work_order_emissions`) integration-tested per §15.5.
9. `approve_booking_setup_trigger` RPC integration-tested per §15.2 (3 v6 tests).
10. `BookingFlowService.create` refactored to call combined RPC for services-present paths; no-services path keeps calling `create_booking` (00277). Idempotency key constructed deterministically from `actor.user_id + client_request_id`.
11. `delete_booking_with_guard` boundary call removed from `BookingFlowService.create` (no compensation needed).
12. `Cleanup` class deleted from `bundle.service.ts`; `attachServicesToBooking` body simplified to `buildAttachPlan` + RPC call.
13. `BundleService.onApprovalDecided` line 1527 cutover from `triggerMany` to `approve_booking_setup_trigger` RPC.
14. Best-effort `SetupWorkOrderTriggerService.trigger`/`triggerMany` deleted in a follow-up commit after Phase B is fully cut over (§7.7 last paragraph).
15. `SetupWorkOrderHandler` Phase A burn-in: 7 days, ≥50 samples, zero `outbox_shadow_results.matched=false`.
16. `pnpm smoke:booking-create-with-services` and `pnpm smoke:approve-booking-setup-trigger` pass against staging.
17. Setup-WO cutover Phase A → B → C without incident; `outbox_setup_wo_handler_outcomes_total{outcome="dead_lettered"}` is 0 across the cutover window.
18. Tenant-mismatch counter zero for 30+ days post-cutover.
19. `attach_operations_outcomes_total{outcome="payload_mismatch"}` is 0 for 30+ days post-cutover (the C1 fix is working).
20. Other event types ship in shadow-first cadence (§5.3).

---

## Document version

- v6 — 2026-05-04. Status: DESIGN (not implemented; investigation + spec only). Replaces v5 (commit `48048f6`). Folds 4 criticals + 3 importants + 1 nit from codex v5 review.
- v5 — 2026-05-04. Status: superseded. Replaced v4 (commit `2c564f4`).
