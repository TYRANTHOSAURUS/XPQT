# Domain Outbox Design Specification — Plan B.1 (v5)

> **Authored:** 2026-05-04
> **Phase:** 6 (Durable Infrastructure)
> **Scope:** Investigation + Design only. No implementation code beyond this spec.

---

## Revision history

- **v1** (commit `f5b96c5`, superseded): proposed a TS-side `OutboxService.emitTx(client)` claiming to share a transaction with the business write. Foundational mismatch — `BookingFlowService.create` calls `supabase.admin.rpc('create_booking', ...)`, which is a PostgREST HTTP call on its own PgBouncer-pooled connection, not the API process's `pg.PoolClient`. No shared transaction exists; v1's atomicity claim was unsatisfiable. Also: cross-tenant idempotency, mis-ordered cutover, RLS-as-defense for service-role workers.
- **v2** (commit `b38db4a`, superseded): moved atomicity into Postgres. Producers emit via row triggers or via an `outbox.emit(...)` SQL helper called from inside an RPC, in the same transaction as the business write. TS-side `OutboxService.emit()` reframed as fire-and-forget. Folded 5 criticals + 5 importants from v1.
- **v3** (commit `83f3ba0`, superseded): introduced a watchdog/lease pattern with a 30s destructive timeout. `create_booking()` emitted `booking.create_attempted` with a 30s lease; the success path consumed the lease via `outbox.mark_consumed`; the crash path was recovered by a watchdog handler that fired after the lease expired. Codex flagged a known false-compensation path: a slow attach (>30s) gets falsely compensated by the watchdog, then `mark_services_attached` throws and the user sees a 500.
- **v4** (commit `2c564f4`, superseded): replaced v3's destructive lease with **A-prime atomic attach**. TS kept the rule resolver / approval routing as a *plan-building* preflight; the WRITE phase became `attach_services_to_booking(p_plan jsonb)`. `delete_booking_with_guard` was amended to lock + re-check (`already_gone` / `already_attached`); the lease window was widened to 5 min and made GUC-configurable. Codex flagged 4 criticals on v4: **C1** GUC-based lease config doesn't reliably carry across PostgREST-pooled connections; **C2** the slow-preflight window between `create_booking` returning and the attach RPC starting can outlive the lease (TS preflight can take 10+ seconds on cold caches, and the lease only starts ticking inside the booking insert); **C3** operation idempotency is incomplete (a TS retry that rebuilds the plan with fresh UUIDs bypasses the per-UUID dedup); **C4** the FK validation matrix in §X.3 only listed catalog/asset/menu/cost_center/person — missing requester_person_id on orders, fulfillment_team_id and vendor_id on OLIs, host_person_id and attendee_person_ids on the booking, and approver_team_id on approvals.
- **v5** (this revision): collapse the booking + services split write into ONE atomic RPC: `create_booking_with_attach_plan(booking_input, attach_plan, idempotency_key, tenant_id)`. TS keeps rule resolver + approval routing as plan-building (pure-SQL conversion isn't worth the cost — see §7.5). RPC takes the built plan and writes booking + slots + orders + asset_reservations + OLIs + approvals + outbox emissions in a single transaction. The `attach_operations` table provides retry idempotency. **No watchdog. No lease. No `booking.create_attempted` event.** Atomic = nothing to compensate. The outbox foundation stays for genuinely async durable work (setup work orders, SLA timers, notifications, escalations); the first cutover becomes setup-WO emitted atomically from inside the combined RPC, NOT best-effort post-commit. v5 drops C1 (GUC) and C2 (preflight window) entirely as failure modes; folds C3 (operation idempotency via `attach_operations`); folds C4 (exhaustive FK matrix in §8); folds I1/I3 (separate forced-probe mode for staging; no silent `mark_consumed=false`); folds I2 (`approvals[].id` pre-generated TS-side along with every other UUID).

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

### 2.4 `attach_operations` — operation idempotency (NEW in v5)

The combined RPC commits everything as one transaction, but a TS retry can still call the RPC twice with the same business intent (e.g. network blip on the response, the user retries). v5 introduces a tenant-scoped operation table that the RPC locks at the very start and updates at the very end:

```sql
-- supabase/migrations/00302_attach_operations.sql (NEW in v5)

create table public.attach_operations (
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  idempotency_key  text        not null,
  payload_hash     text        not null,
  outcome          text        not null
                     check (outcome in ('in_progress', 'success', 'failed')),
  cached_result    jsonb,                            -- non-null when outcome='success'
  enqueued_at      timestamptz not null default now(),
  completed_at     timestamptz,
  error_message    text,                             -- when outcome='failed' (audit only;
                                                     -- callers always re-raise the original error)
  primary key (tenant_id, idempotency_key)
);

-- Stale 'in_progress' rows are crashed RPCs that never completed.
-- A nightly cron (separate migration) clears rows older than the safety window.
create index attach_operations_in_progress
  on public.attach_operations (enqueued_at)
  where outcome = 'in_progress';

alter table public.attach_operations enable row level security;
create policy tenant_isolation on public.attach_operations
  using (tenant_id = public.current_tenant_id());

revoke all on table public.attach_operations from public;
grant select, insert, update on table public.attach_operations to service_role;

comment on table public.attach_operations is
  'Operation-level idempotency for create_booking_with_attach_plan (§7 of the outbox spec). One row per (tenant_id, idempotency_key). The combined RPC SELECTs FOR UPDATE on entry, INSERTs an in_progress row if absent, and UPDATEs to success+cached_result on commit. Same key + same payload_hash returns cached_result. Same key + different payload_hash raises ''attach_operations.payload_mismatch''.';
```

**Safety-window for stale `in_progress` rows.** A crashed RPC leaves an `in_progress` row that never resolves. Default safety window: **5 minutes**. The combined RPC's expected p99 is well under 1s — anything 5 minutes old is unambiguously a crashed transaction (Postgres tx timeout itself defaults to no limit, but any reasonable session-level statement_timeout will have killed the RPC long before 5 min). A nightly cron (`SELECT … FROM attach_operations WHERE outcome='in_progress' AND enqueued_at < now() - interval '5 minutes'`) deletes them. The deletion is safe because:

1. If the RPC was actually still running, the FOR UPDATE lock at the top of the RPC would block the cron's delete (the RPC holds the row lock).
2. If the RPC died, the row is unowned and stale; deleting it lets a future retry with the same key re-attempt.

**Why not just `INSERT ... ON CONFLICT DO NOTHING`?** Because we need to detect three distinct states: (a) no prior row → start work; (b) existing in-progress row with same payload_hash → another concurrent caller is doing the work, return "duplicate-in-flight" (let the caller poll or fail fast); (c) existing successful row with same payload_hash → return cached result. ON CONFLICT collapses (a)+(b)+(c).

### 2.5 SQL grants

`outbox.events` grants unchanged from 00299/00301. v5 adds:

```sql
-- supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql (NEW in v5)
grant execute on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text)
  to service_role;
revoke execute on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text)
  from authenticated;
```

The RPC is service-role only — TS calls it via `supabase.admin`. End users can still hit `BookingFlowService.create` (which checks `actor.has_override_rules` etc. before calling the RPC); they just can't reach into the RPC directly to bypass app-layer rule resolution.

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

1. Locks `attach_operations` for the tenant + idempotency key (idempotency gate).
2. Validates every FK in the payloads against `tenant_id` (§8).
3. Inserts the booking row + N slot rows.
4. Inserts orders, asset_reservations, OLIs, approvals.
5. Updates orders.status to `submitted | approved` based on `any_pending_approval`.
6. Emits outbox events (`setup_work_order.create_required` for each line that needs internal setup; future: `notification.send_required`, etc.).
7. Updates `attach_operations` to `success` with the cached result.

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

`OutboxService.markConsumed` is **dropped in v5** (the wrapper RPC `outbox_mark_consumed_via_rpc` stays in 00299 as dormant infra). Steady-state TS code never marks events consumed — atomic emission inside RPCs replaces lease consumption.

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
    - pre-generate UUIDs in TS for: booking, slots, orders, OLIs,
      asset_reservations, approvals (§7.4)
    - compute order totals + per-line line_totals
    - returns AttachPlan jsonb (§7.4)

WRITE (Postgres, one transaction):
  create_booking_with_attach_plan(p_booking_input, p_attach_plan,
                                  p_tenant_id, p_idempotency_key) →
    1. Lock attach_operations row; idempotency check (§7.3)
    2. Tenant-validate every FK in both payloads (§8)
    3. Short-circuit on any_deny (raise '42P10' service_rule_deny)
    4. INSERT booking
    5. INSERT booking_slots
    6. INSERT orders
    7. INSERT asset_reservations (GiST exclusion fires here on conflict)
    8. INSERT order_line_items (with linked_asset_reservation_id stamped)
    9. INSERT approvals (deduped by approver_person_id; pre-merged in plan)
    10. UPDATE orders SET status = 'submitted'|'approved' (per any_pending_approval)
    11. For each line with requires_internal_setup=true: PERFORM outbox.emit(
         'setup_work_order.create_required', oli_id, payload, ...)
    12. UPDATE attach_operations SET outcome='success', cached_result=...
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

### 7.3 `attach_operations` idempotency — RPC-side flow

```sql
-- At the top of create_booking_with_attach_plan:

declare
  v_existing public.attach_operations;
  v_payload_hash text;
  v_cached jsonb;
begin
  -- Hash the FULL request payload. md5 is fine here — collision space is
  -- per-tenant per-idempotency-key, not global, so the realistic collision
  -- count is approximately zero.
  v_payload_hash := md5(coalesce(p_booking_input::text, '') ||
                        '|' ||
                        coalesce(p_attach_plan::text, ''));

  -- Lock the row first. If it doesn't exist, the FOR UPDATE returns no
  -- rows and we fall through to insert; if it does exist, we see the
  -- existing state.
  select * into v_existing
    from public.attach_operations
   where tenant_id = p_tenant_id
     and idempotency_key = p_idempotency_key
   for update;

  if found then
    -- Existing operation. Three sub-cases:
    if v_existing.payload_hash = v_payload_hash and v_existing.outcome = 'success' then
      -- True idempotent retry. Return cached result.
      return v_existing.cached_result;
    elsif v_existing.payload_hash = v_payload_hash and v_existing.outcome = 'in_progress' then
      -- Another caller holds the row right now. With FOR UPDATE we shouldn't
      -- get here unless the other caller already committed but we read a
      -- stale snapshot — defensive.
      raise exception 'attach_operations.duplicate_in_flight'
        using errcode = 'P0001',
              hint = 'Another concurrent retry of this idempotency key is in progress';
    elsif v_existing.payload_hash = v_payload_hash and v_existing.outcome = 'failed' then
      -- Previous attempt failed. Allow retry: clear the failed marker and
      -- proceed. A retry of a failed payload is exactly what we want
      -- (idempotency keys are about deduping the user's intent, not pinning
      -- a previous failure).
      delete from public.attach_operations
       where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    else
      -- Same key, different payload. The caller violated the idempotency
      -- contract — payloads MUST be deterministic for a given key. This is
      -- a bug surfacing. Raise loudly.
      raise exception 'attach_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different payload — TS retry must rebuild the plan deterministically';
    end if;
  end if;

  -- Insert in_progress marker. The tx will UPDATE this to 'success' on
  -- successful commit, or get rolled back entirely on failure (which leaves
  -- no row at all — a future retry just sees no_existing and starts fresh).
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

**Why does the failed-row case `delete` rather than `update`?** Because the previous attempt's `payload_hash` might be wrong (the bug that caused the failure could be in the validator) or the previous tenant's state might have changed. A clean re-insert gives the retry a fresh slate; the original failure is preserved in audit events emitted from the failed attempt.

**Caller's idempotency_key construction.** `BookingFlowService` should generate one per request: `${actor.user_id}:${input.client_request_id ?? randomUUID()}:${stableHashOfInput()}`. The client_request_id (if the client supplies one) lets the client retry without changing the key. Specifying this is the caller's responsibility — TS contract on `BookingFlowService.create` MUST require a stable key, not a `randomUUID()` per call (which would defeat the whole mechanism).

### 7.4 The `AttachPlan` jsonb shape

Carries forward v4's enumeration with FOUR changes:
- `approvals[].id` is now pre-generated TS-side (was assigned by the RPC's INSERT default in v4) — folds I2.
- `booking_input` becomes a separate top-level argument (was implicit in v4 because `attach_services_to_booking` took a pre-existing booking).
- `slots[]` is added (booking creation includes slots).
- All UUID arrays explicitly enumerated below for the FK matrix in §8.

```typescript
// Conceptual TypeScript shape; serialized as jsonb for the RPC.

interface BookingInput {
  // Pre-generated UUIDs
  booking_id: string;                            // UUIDv4 from crypto.randomUUID()
  slot_ids: string[];                            // one per slot, pre-generated

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
    id: string;                                  // pre-generated; matches slot_ids[i]
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
    id: string;                                  // pre-generated UUIDv4
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
    id: string;                                  // pre-generated UUIDv4
    asset_id: string;                            // tenant-validated in §8
    start_at: string;                            // line.service_window_start_at
    end_at: string;                              // line.service_window_end_at
    requester_person_id: string;
    booking_id: string;                          // = booking_input.booking_id
    status: 'confirmed';                         // bundle.service.ts:1323
  }>;

  // Order line items (bundle.service.ts:1254-1289)
  order_line_items: Array<{
    id: string;                                  // pre-generated UUIDv4
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
    id: string;                                  // pre-generated UUIDv4 — NEW in v5 (I2)
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

**Pre-generated UUIDs.** Order, asset_reservation, OLI, approval, booking, and slot IDs are all pre-generated in TS via `crypto.randomUUID()` so the plan can self-reference (e.g. `order_line_items[].order_id` → `orders[].id`, `order_line_items[].linked_asset_reservation_id` → `asset_reservations[].id`, `approvals[].target_entity_id` → `booking_id`). The RPC trusts the TS-generated UUIDs and inserts them verbatim. Safe because UUIDv4 collisions are practically impossible AND the inserts run inside one transaction — a duplicate would surface as 23505 and roll the whole RPC back.

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

  // NEW: instead of upsertApproval, return the planned rows with pre-generated ids.
  const out: AssembledApprovalRow[] = [];
  for (const [approverPersonId, entry] of grouped) {
    out.push({
      id: crypto.randomUUID(),                              // NEW in v5 (I2)
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

  -- ── 1. attach_operations idempotency gate (§7.3) ─────────────────────
  v_payload_hash := md5(coalesce(p_booking_input::text, '') || '|' ||
                        coalesce(p_attach_plan::text, ''));

  select * into v_existing
    from public.attach_operations
   where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
   for update;

  if found then
    if v_existing.payload_hash = v_payload_hash and v_existing.outcome = 'success' then
      return v_existing.cached_result;
    elsif v_existing.payload_hash = v_payload_hash and v_existing.outcome = 'in_progress' then
      raise exception 'attach_operations.duplicate_in_flight'
        using errcode = 'P0001';
    elsif v_existing.payload_hash = v_payload_hash and v_existing.outcome = 'failed' then
      delete from public.attach_operations
       where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key;
    else
      raise exception 'attach_operations.payload_mismatch'
        using errcode = 'P0001',
              hint = 'Idempotency key reused with different payload';
    end if;
  end if;

  insert into public.attach_operations
    (tenant_id, idempotency_key, payload_hash, outcome)
  values (p_tenant_id, p_idempotency_key, v_payload_hash, 'in_progress');

  -- ── 2. any_deny short-circuit ─────────────────────────────────────────
  if (p_attach_plan->>'any_deny')::boolean then
    raise exception 'service_rule_deny: %',
      coalesce(p_attach_plan->'deny_messages'->>0, 'A service rule denied this booking.')
      using errcode = '42P10';
  end if;

  -- ── 3. Tenant-validate every FK in both payloads (§8) ────────────────
  perform public.validate_attach_plan_tenant_fks(p_tenant_id, p_booking_input, p_attach_plan);

  -- ── 4. INSERT booking ────────────────────────────────────────────────
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

  -- ── 5. INSERT booking_slots ──────────────────────────────────────────
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

  -- ── 6. INSERT orders (one per service_type group; bundle.service.ts:213-220)
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

  -- ── 7. INSERT asset_reservations (GiST exclusion fires here)
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

  -- ── 8. INSERT order_line_items (bundle.service.ts:1260-1287)
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

  -- ── 9. INSERT approvals (deduped + pre-merged in TS plan; §7.5)
  for v_approval in select * from jsonb_array_elements(p_attach_plan->'approvals')
  loop
    insert into public.approvals (
      id, tenant_id, target_entity_type, target_entity_id,
      approver_person_id, status, scope_breakdown
    ) values (
      (v_approval->>'id')::uuid,                  -- NEW in v5 (I2): pre-generated
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

  -- ── 10. UPDATE orders.status from 'draft' to 'submitted'/'approved'
  -- The plan's orders[].initial_status already carries the correct value;
  -- step 6 inserted with that. This step is a no-op in v5 (kept for parity
  -- with the old TS sequence at bundle.service.ts:367-373, which inserted
  -- 'draft' first then UPDATED — we skip that because the plan tells us
  -- the right status from the start).

  -- ── 11. Emit setup_work_order.create_required outbox events ───────────
  -- One event per OLI that has setup_emit hint (§7.4). The emit is atomic
  -- with every other insert above; if any of them fails, none of the
  -- emits land either.
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

  -- Approval-pending interlock (mirrors bundle.service.ts:382-454):
  -- if any line is pending approval, we DON'T emit setup-WO events at create
  -- time — the work shouldn't start while the order may still be rejected.
  -- Implementation: if (p_attach_plan->>'any_pending_approval')::boolean is
  -- true, skip the setup_emit loop entirely. The pending_setup_trigger_args
  -- column on each OLI carries the snapshot so onApprovalDecided can re-emit
  -- on grant.
  --
  -- NOTE: the loop above ran unconditionally; the plan's setup_emit hint
  -- should be NULL when any_pending_approval=true (TS responsibility). The
  -- RPC trusts the plan. If we want defense-in-depth, wrap the loop in
  -- `if not (p_attach_plan->>'any_pending_approval')::boolean then ... end if;`
  -- For v5: trust the plan. The TS preflight (§7.2 → bundle.service.ts:410)
  -- already gates this correctly; rebuilding the gate in PL/pgSQL is
  -- defense-in-depth that buys little for the readability cost.

  -- ── 12. Build cached result, mark operation success ───────────────────
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

### 7.7 Setup work order handler (§7.6 emission consumer)

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
    // Tenant assertion is pre-handler (worker §4.3 + tenantCache).
    // Also verify the OLI still belongs to event.tenant_id (smuggling defense).
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

    // Idempotency: handler must dedupe on retry.
    // (See §11 open question — exact mechanism is one of: (a) check
    // work_orders for an existing row with linked_order_line_item_id =
    // event.aggregate_id; (b) a setup_work_order_emissions tracking table.
    // Recommendation: (a) — work_orders is the truth, tracking table would
    // diverge on race or hand-recovery. The trigger service already returns
    // the existing id when the routing matrix lookup runs against a now-
    // -populated row, so this is mostly a no-op of an existing pattern.)
    const existing = await this.supabase.admin
      .from('work_orders')
      .select('id')
      .eq('tenant_id', event.tenant_id)
      .eq('linked_order_line_item_id', event.aggregate_id)
      .in('status_category', ['new', 'assigned', 'in_progress', 'waiting', 'pending_approval'])
      .maybeSingle();
    if (existing.data) {
      this.log.log(`already_created oli=${event.aggregate_id} wo=${existing.data.id}`);
      return;
    }

    // Skip when the OLI's parent order is still pending approval.
    // (mirrors the create-time gate at bundle.service.ts:410-454)
    if (event.payload.requires_approval) {
      // Persist trigger args on the OLI and wait — onApprovalDecided will
      // re-emit when approval lands. This handler is a no-op in that case.
      // The persist is idempotent (UPDATE ... where pending_setup_trigger_args is null).
      await this.persistTriggerArgs(event);
      return;
    }

    // Create the WO via the existing trigger service (unchanged shape;
    // already an ~80-line orchestration that we DON'T want to port to
    // PL/pgSQL — see the existing impl at setup-work-order-trigger.service.ts).
    await this.setupTrigger.trigger({
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
    // setupTrigger.trigger logs + audits internally on failure (returns null,
    // doesn't throw). For OUR retry semantics we want: a routing-matrix
    // not-configured outcome → idempotent success (don't retry forever);
    // a transient DB error → throw to retry. The trigger service today
    // catches everything; for the handler path we may want to wrap and
    // re-throw on connection errors. Concrete delta to the trigger service
    // is in the implementation phase (Phase B); spec doesn't pin it here
    // beyond noting the gap.
  }

  /** Phase A shadow mode: never mutates; produces an outbox_shadow_results row. */
  async dryRun(event: OutboxEventWithPayload<SetupWorkOrderPayload>): Promise<ShadowOutcome> {
    // Same routing-matrix lookup as trigger() but returns the planned WO
    // instead of inserting. Compared to the inline-path's actual outcome
    // (read from audit_events or work_orders) by the boundary.
    /* implementation: replay setupTrigger.trigger logic up to the
     *  this.tickets.createBookingOriginWorkOrder call, then return
     *  { kind: 'would_create' | 'no_team_configured' | 'invalid_window',
     *    team_id, due_at, sla, ... } */
  }

  private async persistTriggerArgs(event: OutboxEventWithPayload<SetupWorkOrderPayload>) {
    // Update OLI's pending_setup_trigger_args with the snapshot from event.payload.
    // Idempotent: the WHERE pending_setup_trigger_args is null clause keeps
    // a re-firing event from clobbering an already-claimed snapshot.
    // (Mirror bundle.service.ts:418-441.)
  }
}
```

---

## 8. Exhaustive tenant FK validation matrix

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

---

## 9. Idempotency contracts

### 9.1 Operation idempotency (combined RPC)

Per §7.3 — `attach_operations` table. TS callers MUST construct deterministic idempotency keys. Recommended pattern:

```typescript
// In BookingFlowService.create
const idempotencyKey = `booking.create:${actor.user_id}:${input.client_request_id ?? randomUUID()}`;
```

`client_request_id` is a header the frontend sends on retry (already used by the request middleware for trace linking; documented in `apps/web/src/api/api-fetch.ts`). When present, retries reuse the same key. When absent, each attempt generates a fresh UUID — that's correct for "retry was a fresh user click" but means the idempotency mechanism can't dedupe automatic retries. The frontend's React Query mutation layer already supplies a client_request_id per mutation (cf. the `RequestIdProvider`); the Phase 6 integration sketches this for `BookingFlowService` first.

### 9.2 Event handler idempotency (setup-WO and future events)

Every handler MUST be safe to invoke multiple times for the same event:

1. **Aggregate state check** — load the aggregate; if it's already in the post-event state, return success. The setup-WO handler does this via `select id from work_orders where linked_order_line_item_id = event.aggregate_id` (§7.7).
2. **Upsert** — `insert ... on conflict do nothing` keyed on a deterministic id derived from the event.
3. **Outbox dedup token in the side-effect** — when sending a Slack/email, include the event's outbox `id` as the message dedup token, so the recipient's inbound webhook can deduplicate even if our retry happens after their ACK.

The infrastructure delivers at-least-once; handlers convert that to effectively-once.

### 9.3 Plan idempotency on RPC retry (the C3 fold)

If `create_booking_with_attach_plan` is called twice with the same `p_idempotency_key`:
- Same payload + previous outcome=success → `attach_operations` returns `cached_result` immediately. No work done.
- Same payload + previous outcome=in_progress → the FOR UPDATE in §7.3 blocks until the first call commits or rolls back; if it commits, the second call reads the success row and returns cached_result; if it rolls back, the row is gone and the second call starts fresh.
- Same payload + previous outcome=failed → row deleted, retry proceeds (a true retry of a transient failure should succeed).
- Different payload → `payload_mismatch` raised. Bug surfacing.

The C3 hole in v4 — "TS retries that rebuild the plan with fresh UUIDs bypass per-UUID dedup" — is closed because the dedup is now on `(tenant_id, idempotency_key)` at the operation level, not on the per-row UUIDs. The per-row UUIDs are still the disaster recovery mechanism (a 23505 collision would roll the whole tx back), but they're not the primary dedup gate.

---

## 10. Setup-WO is NOT best-effort — explicit framing

Per the user direction:

> "Don't call setup-WO 'best-effort' if missing it creates operational corruption. If a setup work order is required for a booking/service to be fulfilled, it belongs either inside the combined RPC or as a durable outbox event emitted from inside that RPC. 'Best-effort post-commit' is only acceptable for notifications, analytics, and non-critical side effects."

**Inside the RPC vs outbox event from RPC — the call:** outbox event from RPC.

Reasoning:
- The setup-WO creation logic in `SetupWorkOrderTriggerService.trigger` (setup-work-order-trigger.service.ts:46-143) is ~80 lines: routing matrix lookup via `resolve_setup_routing` RPC, lead-time math, ticket creation via `TicketService.createBookingOriginWorkOrder` (which itself spans 100+ lines of orchestration: SLA policy attachment, audit metadata, module number assignment, dispatch hooks). Porting that to PL/pgSQL is multi-week work and creates a second copy to keep in sync.
- Emitting the event atomically from the combined RPC gives full durability semantics: if the RPC commits, the event is durable; if the handler crashes, retry kicks in; if it dead-letters, audit + ops alert. That's the "either inside RPC or durable outbox event from RPC" condition the user direction allows.
- The cost of the outbox path: the WO is created ~100ms-1s after the booking commits (one drain cycle plus handler latency). For "internal setup work" specifically — not a customer-facing thing — that latency is invisible; the kitchen team's view of today's prep list refreshes on the order of minutes anyway.

**What changes vs today's best-effort:**

| Today (`bundle.service.ts:456` — `triggerMany` post-commit) | v5 (outbox handler) |
|---|---|
| Best-effort fire-and-forget | Durable retry with backoff |
| Failure logs + audits at `severity: 'high'` and stops | Failure logs + audits, retry up to 5 times, then dead-letter |
| Node process crash between booking commit and trigger fire = WO never created | Event durable in `outbox.events` from before commit; survives Node crash |
| Tenant misconfigured (no team in matrix) = audit + manual recovery | Same audit, but handler treats as `dead_letter_reason='no_team_configured'` for ops triage |
| Idempotency none (relies on `pending_setup_trigger_args` claim RPC for the deferred-on-approval case only) | Idempotent on `(booking_id, oli_id)` per §9.2 |

**During Phase A:** both paths run — old best-effort + new shadow handler. The shadow handler writes `outbox_shadow_results`; the old best-effort path actually creates the WO. The gate query in §5.2 confirms they agree before flipping in Phase B.

**Recovery from old orphans:** if any bookings exist in production with services that should have triggered setup-WOs but didn't (because the old best-effort path failed silently — it does happen; we have audit rows from past incidents), Phase B doesn't automatically backfill them. Backfill is a separate operation: a script that reads `audit_events` for `bundle.setup_work_order_create_failed` and re-emits the events. Documented separately; out of v5 spec scope.

---

## 11. Open questions remaining (post-v5)

Not blocking implementation; revisit during Phase 6 hardening or earlier if prod signals demand.

1. **Per-tenant fairness** (still open) — sharded per-tenant worker vs today's FIFO drain. The optional `idx_outbox_events_per_tenant_pending` index supports it. Defer until a noisy-neighbor incident or a tenant >100x median emit rate.
2. **Cross-region replication** (still open) — probably "worker in primary DB region; cross-region events catch up in seconds." Confirm before we ship a multi-region tenant.
3. **Webhook delivery via outbox** (still open) — likely yes with a dedicated `webhook.deliver_required` event type; revisit in the webhook hardening sprint.
4. **`outbox_emit_via_rpc` PostgREST wrapper kept or dropped** (still open; v5 doesn't need it for the booking path because the combined RPC emits via direct `outbox.emit()` calls). Re-evaluate once we have ≥2 TS-side `emit` call sites in production. Currently zero in v5 steady state — the `OutboxService.emit()` fire-and-forget path is the only TS caller and could go through `outbox_emit_via_rpc` or a future direct-table path. Keep for now (cheap to maintain, low coupling).
5. **`outbox_shadow_results` retention** (still open) — needs a daily purge job; fold into the GDPR retention catalog when Phase B lands.
6. **Setup-WO handler idempotency design** — §7.7 picks "check work_orders.linked_order_line_item_id" as the dedup mechanism. Alternative: a `setup_work_order_emissions` tracking table keyed by `(booking_id, oli_id, event_id)` to absolutely guarantee one-WO-per-event even across edge cases (e.g. WO is created, then cancelled, then a duplicate event arrives — the work_orders check returns no active row, handler creates a new WO; a tracking table would refuse). Decision deferred to implementation: start with the simpler check; switch if duplicates surface in staging.
7. **Standalone-order path migration** (NEW open) — `OrderService.createStandaloneOrder` (the `/portal/order` flow with no booking) writes orders + OLIs + asset_reservations + approvals via supabase-js sequence (not yet ported). Same architectural concerns as the booking path; should be a separate `create_standalone_order_with_attach_plan` RPC in a follow-up slice. v5 does NOT fold this; the existing `ApprovalRoutingService.assemble` (write-side) stays for that caller.

**Resolved by v5:**

- ~~Lease window tuning~~ — v3/v4 lease entirely removed.
- ~~Watchdog races success path~~ — v3/v4 watchdog entirely removed.
- ~~Compensation false-positive on slow attach~~ — no compensation = no false positive.
- ~~v4 C1 (GUC propagation)~~ — no GUC; lease config retired.
- ~~v4 C2 (slow preflight window)~~ — no preflight-vs-attach window; one transaction.
- ~~v4 C3 (operation idempotency hole)~~ — `attach_operations` table, §7.3.
- ~~v4 C4 (incomplete FK matrix)~~ — exhaustive matrix in §8.
- ~~v4 I2 (approvals[].id)~~ — pre-generated TS-side, §7.4.

---

## 12. File locations

### Schema
- `supabase/migrations/00299_outbox_foundation.sql` — `outbox.events`, `outbox.events_dead_letter`, `outbox.emit()` + `outbox.mark_consumed()` helpers, `outbox_emit_via_rpc` + `outbox_mark_consumed_via_rpc` PostgREST wrappers, GRANTs, `outbox_shadow_results`. **Already applied** (foundation).
- `supabase/migrations/00300_outbox_shadow_results_fk_set_null.sql` — `outbox_shadow_results.outbox_event_id` FK ON DELETE SET NULL. **Already applied**.
- `supabase/migrations/00301_outbox_emit_revoke_authenticated.sql` — codex v3 follow-up. **Already applied**.
- `supabase/migrations/00302_attach_operations.sql` — `attach_operations` table (§2.4). **NEW in v5**.
- `supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql` — `create_booking_with_attach_plan` RPC + `validate_attach_plan_tenant_fks` helper (§7.6 + §8). **NEW in v5**.

### TypeScript
- `apps/api/src/modules/outbox/outbox.service.ts` — fire-and-forget producer only.
- `apps/api/src/modules/outbox/outbox.worker.ts` — drain loop with the §4.2 state machine.
- `apps/api/src/modules/outbox/outbox-handler.registry.ts` — decorator-driven registry.
- `apps/api/src/modules/outbox/outbox-handler.decorator.ts` — `@OutboxHandler(eventType, { version })`.
- `apps/api/src/modules/outbox/dead-letter.error.ts` — `DeadLetterError` sentinel.
- `apps/api/src/modules/outbox/handlers/setup-work-order.handler.ts` — the setup-WO handler (§7.7). **NEW in v5**.
- `apps/api/src/modules/booking-bundles/bundle.service.ts` — `attachServicesToBooking` becomes:
  - `buildAttachPlan(args)` — pure preflight; returns `AttachPlan` (§7.4).
  - The combined-RPC call site moves into `BookingFlowService.create` (§file below).
  - The `Cleanup` class (bundle.service.ts:1878-1972) is **deleted** — no longer needed because every insert is inside the combined RPC's transaction; rollback is automatic.
- `apps/api/src/modules/orders/approval-routing.service.ts` — gains a `assemblePlan(args)` method that returns the same shape as `assemble(args)` but does NOT write to `approvals` (the RPC does). `assemble` itself stays for the standalone-order path (§11 future work).
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

### 13.2 `attach_operations` stale-row purge (NEW)

Daily cron: `delete from public.attach_operations where outcome = 'in_progress' and enqueued_at < now() - interval '5 minutes'`. The 5-minute window matches the safety window in §2.4. Rows older than that are crashed RPCs that never resolved; deleting them lets a future retry with the same key proceed.

### 13.3 Cross-tenant smuggling defense (unchanged from v3/v4)

Handlers MUST explicitly load the aggregate row, assert `aggregate.tenant_id === event.tenant_id`, and dead-letter on mismatch via `DeadLetterError`. Tenant mismatch is not a transient error.

### 13.4 The "watchdog races success path" failure mode (v3/v4) — eliminated in v5

Both v3's "30s lease too tight" and v4's "5min lease + lock+re-check" failure modes are structurally impossible in v5 because there is no separate watchdog and no separate attach phase. The booking + services commit as one transaction. If the transaction commits, both exist; if it rolls back, neither does.

---

## 14. Observability

Carry forward the foundation metrics. v5 changes:

- **`outbox_setup_wo_emissions_total{tenant_id, requires_approval}`** — counter incremented on each emission of `setup_work_order.create_required` from inside the combined RPC. Phase A baseline. Phase B should match (same RPC body in both phases; the cutover is at the handler, not the producer).
- **`outbox_setup_wo_handler_outcomes_total{outcome}`** — labels: `created | already_exists | no_team_configured | tenant_mismatch | dead_lettered`. The `dead_lettered` count is the most important production signal — every increment = a service line that should have a setup work order and doesn't.
- **`attach_operations_outcomes_total{outcome}`** — labels: `success | failed | duplicate_in_flight | payload_mismatch`. `payload_mismatch` should be 0 in steady state (any non-zero = a TS bug constructing non-deterministic idempotency keys).
- **`create_booking_with_attach_plan_duration_ms`** histogram — replaces v4's `outbox_attach_rpc_duration_ms`. p99 informs whether the RPC is acceptably fast for the synchronous request path. If p99 climbs above 2s sustained, profile + tune (likely candidates: the FK validation matrix's `EXCEPT` queries on cold caches, or the GiST exclusion check on heavy contention).

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
- Idempotent retry — call twice with same key, same payload. Second call returns cached_result without re-inserting.
- Payload mismatch — call twice with same key, different payload. Second call raises `attach_operations.payload_mismatch`.
- Duplicate in-flight — concurrent calls with same key (use a transaction-suspending probe). Second blocks; first commits; second returns cached_result.
- FK validation failure for each FK type in §8 (16 tests). Each constructs a payload with one foreign-tenant id and asserts `42501 attach_plan.fk_invalid: <field>`.
- GiST asset conflict — two concurrent calls reserving overlapping asset windows. One succeeds, one rolls back with `23P01`.
- Slot overlap conflict — two concurrent calls on the same room/time. One succeeds, one rolls back with `23P01`.
- Deny short-circuit — plan with `any_deny=true`. RPC raises `42P10` before any insert; assert no rows landed.

### 15.3 Smoke gate extension

`pnpm smoke:work-orders` already covers the work-order command surface. Phase 6 extends it with:
- `pnpm smoke:booking-create-with-services` — creates a real booking with services through `BookingFlowService.create` against the running API. Asserts: booking row exists, slots exist, orders exist, OLIs exist, asset reservations exist (when applicable), approvals exist (when applicable), `outbox.events` row exists for each setup-WO emission. Idempotency probe: replays the same request with the same `client_request_id` and asserts identical row IDs returned.

This replaces v4's "forced lease-expiry probe" — the failure mode it tested (crash between create_booking and attach_services_to_booking) doesn't exist in v5.

### 15.4 Setup-WO comparison probe (Phase A gate)

Per §5.2. Two scenarios (configured matrix + misconfigured matrix); shadow handler vs inline best-effort path; assert outcomes match. Hooked into staging CI; mandatory before each Phase A → B deploy.

---

## 16. Success criteria

Phase 6 is complete when:

1. v5's two NEW migrations (00302, 00303) applied to remote Supabase + `notify pgrst, 'reload schema'`.
2. `OutboxService` (emit-only) + `OutboxWorker` (§4.2 state machine) + decorator registry implemented + unit-tested.
3. `BundleService.buildAttachPlan` unit-tested against the survey of existing `attachServicesToBooking` writes (every row type covered).
4. `ApprovalRoutingService.assemblePlan` unit-tested; matches `assemble`'s dedup logic without writing.
5. `create_booking_with_attach_plan` RPC integration-tested per §15.2.
6. `BookingFlowService.create` refactored to call combined RPC for services-present paths; no-services path keeps calling `create_booking` (00277).
7. `delete_booking_with_guard` boundary call removed from `BookingFlowService.create` (no compensation needed).
8. `Cleanup` class deleted from `bundle.service.ts`; `attachServicesToBooking` body simplified to `buildAttachPlan` + RPC call.
9. `SetupWorkOrderHandler` Phase A burn-in: 7 days, ≥50 samples, zero `outbox_shadow_results.matched=false`.
10. `pnpm smoke:booking-create-with-services` passes against staging.
11. Setup-WO cutover Phase A → B → C without incident; `outbox_setup_wo_handler_outcomes_total{outcome="dead_lettered"}` is 0 across the cutover window.
12. Tenant-mismatch counter zero for 30+ days post-cutover.
13. Other event types ship in shadow-first cadence (§5.3).

---

## Document version

- v5 — 2026-05-04. Status: DESIGN (not implemented; investigation + spec only). Replaces v4 (commit `2c564f4`).
