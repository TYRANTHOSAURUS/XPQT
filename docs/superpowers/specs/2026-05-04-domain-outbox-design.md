# Domain Outbox Design Specification — Plan B.1 (v8)

> **Authored:** 2026-05-04
> **Phase:** 6 (Durable Infrastructure)
> **Scope:** Investigation + Design only. No implementation code beyond this spec.
> **Status:** v8 is the FINAL design round before B.0 implementation begins. After v8 ships, B.0 starts immediately.

---

## Revision history

- **v1** (commit `f5b96c5`, superseded): proposed a TS-side `OutboxService.emitTx(client)` claiming to share a transaction with the business write. Foundational mismatch — `BookingFlowService.create` calls `supabase.admin.rpc('create_booking', ...)`, which is a PostgREST HTTP call on its own PgBouncer-pooled connection, not the API process's `pg.PoolClient`. No shared transaction exists; v1's atomicity claim was unsatisfiable. Also: cross-tenant idempotency, mis-ordered cutover, RLS-as-defense for service-role workers.
- **v2** (commit `b38db4a`, superseded): moved atomicity into Postgres. Producers emit via row triggers or via an `outbox.emit(...)` SQL helper called from inside an RPC, in the same transaction as the business write. TS-side `OutboxService.emit()` reframed as fire-and-forget. Folded 5 criticals + 5 importants from v1.
- **v3** (commit `83f3ba0`, superseded): introduced a watchdog/lease pattern with a 30s destructive timeout. `create_booking()` emitted `booking.create_attempted` with a 30s lease; the success path consumed the lease via `outbox.mark_consumed`; the crash path was recovered by a watchdog handler that fired after the lease expired. Codex flagged a known false-compensation path: a slow attach (>30s) gets falsely compensated by the watchdog, then `mark_services_attached` throws and the user sees a 500.
- **v4** (commit `2c564f4`, superseded): replaced v3's destructive lease with **A-prime atomic attach**. TS kept the rule resolver / approval routing as a *plan-building* preflight; the WRITE phase became `attach_services_to_booking(p_plan jsonb)`. `delete_booking_with_guard` was amended to lock + re-check (`already_gone` / `already_attached`); the lease window was widened to 5 min and made GUC-configurable. Codex flagged 4 criticals on v4: **C1** GUC-based lease config doesn't reliably carry across PostgREST-pooled connections; **C2** the slow-preflight window between `create_booking` returning and the attach RPC starting can outlive the lease (TS preflight can take 10+ seconds on cold caches, and the lease only starts ticking inside the booking insert); **C3** operation idempotency is incomplete (a TS retry that rebuilds the plan with fresh UUIDs bypasses the per-UUID dedup); **C4** the FK validation matrix in §X.3 only listed catalog/asset/menu/cost_center/person — missing requester_person_id on orders, fulfillment_team_id and vendor_id on OLIs, host_person_id and attendee_person_ids on the booking, and approver_team_id on approvals.
- **v5** (commit `48048f6`, superseded): collapse the booking + services split write into ONE atomic RPC: `create_booking_with_attach_plan(booking_input, attach_plan, idempotency_key, tenant_id)`. TS keeps rule resolver + approval routing as plan-building (pure-SQL conversion isn't worth the cost — see §7.5). RPC takes the built plan and writes booking + slots + orders + asset_reservations + OLIs + approvals + outbox emissions in a single transaction. The `attach_operations` table provides retry idempotency. **No watchdog. No lease. No `booking.create_attempted` event.** Atomic = nothing to compensate. The outbox foundation stays for genuinely async durable work (setup work orders, SLA timers, notifications, escalations); the first cutover becomes setup-WO emitted atomically from inside the combined RPC, NOT best-effort post-commit. v5 dropped v4-C1 (GUC) and v4-C2 (preflight window) entirely as failure modes; folded v4-C3 (operation idempotency via `attach_operations`); folded v4-C4 (exhaustive FK matrix in §8); folded v4-I1/I3 (separate forced-probe mode for staging; no silent `mark_consumed=false`); folded v4-I2 (`approvals[].id` pre-generated TS-side along with every other UUID).
- **v6** (commit `fd561fd`, superseded): folds 4 criticals + 3 importants + 1 nit from the codex v5 review. Headline corrections: **(C1)** every plan UUID — booking, slots, orders, OLIs, asset_reservations, approvals — is now derived from `uuidv5(idempotency_key, row_kind, stable_index, NS_PLAN)` instead of `crypto.randomUUID()`. The previous random scheme defeated the very `attach_operations` mechanism v5 introduced, because a TS retry that rebuilt the plan with fresh UUIDs would hash to a different `payload_hash` and trip `payload_mismatch` instead of returning `cached_result`. **(C2)** the combined RPC takes a transaction-scoped `pg_advisory_xact_lock` keyed on `(tenant_id, idempotency_key)` *before* it reads `attach_operations`. v5's `SELECT FOR UPDATE` couldn't see uncommitted in-progress rows, so two racing retries both passed the gate and both `INSERT`-ed the marker — second got `23505` instead of cached_result. **(C3)** `SetupWorkOrderTriggerService` gains a strict-mode sibling (`triggerStrict`) that throws transient errors and returns typed terminal outcomes. The outbox handler calls `triggerStrict`, so transient DB failures retry through the worker instead of being swallowed by the legacy `trigger`'s outer try/catch. **(C4)** the approval-grant deferred-setup path (`bundle.service.ts:1523` calling `setupTrigger.triggerMany` directly) is replaced by a new `approve_booking_setup_trigger(p_oli_ids, p_tenant_id)` RPC that reads `pending_setup_trigger_args`, emits `setup_work_order.create_required` to outbox, and clears the args — all in one transaction. Approval grant becomes durable end-to-end. Folds **(I1)** `setup_work_order_emissions` dedup table replacing the racy `work_orders.linked_order_line_item_id` lookup; **(I2)** internal-graph FK validation helper alongside the tenant-FK matrix; **(I3)** drops `failed` and stale `in_progress` from the `attach_operations.outcome` enum (the marker insert lives inside the RPC tx — failures roll the row back, so persistent `failed` state was never produced); **(N1)** strips `OutboxService.markConsumed` and the `booking.create_attempted` references from `outbox.service.ts` (already retired from spec; implementation file lagged).
- **v8** (this revision): folds 1 critical + 6 importants + 1 nit from the codex v7 review, plus an explicit "Not in B.0" deferral section. v8 is the FINAL design round — convergence, not redesign — and the spec is frozen for implementation. **(C1)** setup-WO RPC trusted `p_wo_row_data` for identity; v8 loads `outbox.events`, derives `v_oli_id` from `aggregate_id`, validates OLI→order→booking chain, and validates every tenant-owned FK via new `validate_setup_wo_fks` helper. §7.8.2. **(I1)** `X-Client-Request-Id` auto-stamp at fetch scope lost stability across React Query retries; v8 moves id generation to mutation-attempt scope (caller passes `requestId` in variables shape; `apiFetch` no longer auto-stamps). §3.3. **(I2)** `grant_booking_approval` mutated approval row before validating `target_entity_type`; v8 reorders to lock+select+validate first, CAS update last. §10.1. **(I3)** signature drift on `validate_attach_plan_internal_refs`; v8 canonicalises `(p_tenant_id, p_booking_input, p_attach_plan)` at both definition and call site. **(I4)** `setup_work_order_emissions.work_order_id` was ON DELETE CASCADE; admin WO delete cascaded the dedup signal. v8 changes to ON DELETE SET NULL with tombstone semantics + admin reset runbook. §2.5. **(I5)** canonical OLI sort used `_input_position` tie-breaker, contradicting shuffled-input invariant; v8 requires `client_line_id` on every input line and uses fully-immutable tuples per row-kind. §7.4. **(I6)** `approve_booking_setup_trigger` emitted persisted ruleIds without runtime tenant validation; v8 adds `validate_rule_ids_in_tenant` called inside the emit loop. §7.9.1. **(N1)** §15.5 mocked race tests can't simulate real Postgres advisory-lock acquisition; v8 mandates pgTAP or two-connection `pg.Pool` harness for cutover-blocking tests. §15.5-bis. **(NEW)** explicit §10X "Not in B.0" defers booking cancellation (`bundle-cascade.service.ts:115`) and standalone-order creation (`order.service.ts:752`) to a Phase 6 hardening sprint.
- **v7** (commit `e96bec5`, superseded): folded 3 criticals + 4 importants + 2 nits from the codex v6 review. Pattern: every TS-side multi-step write needs an atomic RPC. v6 closed the create path's split-write but introduced new ones in the approval-grant path and the WO-create-from-event path; v7 closes ALL remaining split-writes in the booking + approval + WO-creation surface area. **(C1)** the v6 cutover wired `approve_booking_setup_trigger` to consume `claimedRows` produced by the OLD `claim_deferred_setup_trigger_args` RPC (00198) — but 00198 already NULLs `pending_setup_trigger_args` before returning, so the new RPC reads null args and emits zero events. v7 retires the 00198 claim flow entirely; the new `approve_booking_setup_trigger(p_booking_id, p_tenant_id, p_actor_user_id, p_idempotency_key)` reads + emits + clears atomically in a single RPC, taking a `pg_advisory_xact_lock` keyed on `(tenant_id, booking_id)` for per-grant serialisation. The TS approval-decision path (`bundle.service.ts:1452-1527`) collapses from "claim RPC + branch + triggerMany / audit" to "call approve RPC". **(C2)** the v6 spec claimed approval-emit failure rolls back the approval decision, but `approval.service.ts:440` runs multiple supabase-js HTTP writes (approval row UPDATE + booking_slots UPDATE + bookings UPDATE + bundle cascade) — there is no transaction to roll back across separate HTTP calls. v7 introduces `grant_booking_approval(p_approval_id, p_tenant_id, p_actor_user_id, p_decision, p_comments, p_idempotency_key)` which atomically: locks the approval row + applies the CAS update + transitions linked booking_slots/bookings + clears `pending_setup_trigger_args` + emits `setup_work_order.create_required` outbox events for non-cancelled OLIs (when `p_decision='approved'`). The TS approval.service.ts becomes a planner/dispatcher: it validates auth + state machine, then calls the single RPC. Notifications + visitor-invite + ticket dispatch stay in TS, fired AFTER the RPC commits (best-effort by design). **(C3)** v6's setup-WO handler created the WO via `triggerStrict` in one supabase-js HTTP call, then INSERT-ed the dedup row in `setup_work_order_emissions` in a SECOND HTTP call. Crash between commits → duplicate WO on replay. v7 introduces `create_setup_work_order_from_event(p_event_id, p_tenant_id, p_wo_row_data, p_idempotency_key)` which inserts the WO row + dedup row atomically in one tx. The TS handler builds the WO row payload (using the existing routing/lead-time logic, now factored as `SetupWorkOrderRowBuilder.build`) and passes it to the RPC. Folds **(I1)** canonical sort discipline for plan UUIDs — every row-kind has a defined sort tuple before `stableIndex` assignment, so two equivalent retries with shuffled input produce identical UUIDs (closes a hole in v6 §7.4 where caller-iteration order leaked into the hash); **(I2)** real `X-Client-Request-Id` mechanism — `apiFetch` auto-generates a UUID per mutation request and threads it as a header; the API guard exposes `request.clientRequestId`; producers use it as the `p_idempotency_key` (closes the v6 reference to a non-existent `RequestIdProvider`); **(I3)** `setup_work_order_emissions.work_order_id` FK now references `public.work_orders(id)` not `public.tickets(id)` — the rewrite collapsed tickets into work_orders for booking-origin work, so the v6 schema would 23503 on insert; **(I4)** mandatory snapshot UUID validation — `applied_rule_ids[]`, `config_release_id`, `setup_emit.rule_ids[]`, and approval-reason `rule_id` are now batch-validated against tenant-scoped rule/config tables in `validate_attach_plan_internal_refs` (closes the explicit "skip" in v6 §8.2; cost is small, downside of a smuggled cross-tenant rule_id baking into the audit trail forever is permanent). Folds nits: **(N1)** §5.1 Phase C reference to `attach_operations.outcome='failed'` was stale (v6 collapsed the enum to `('in_progress', 'success')`) — replaced with the surviving signals (`payload_mismatch` count + dead-letter rate); **(N2)** §16.1 "CI grep guard" was prose only — v7 specifies the actual GitHub Actions step that fails the build on any reintroduced obsolete symbol (`markConsumed`, `booking.create_attempted`, `claim_deferred_setup_trigger_args`, `setupTrigger.triggerMany`).

---

## 1. Architectural rule (NON-NEGOTIABLE)

> **Atomic outbox events MUST be created inside Postgres, in the same transaction as the business write.**
> **State changes that an outbox event represents MUST also be made in the same transaction (no split write).**
> **A user-visible command that requires N row writes to be correct MUST commit those N writes as one transaction. The outbox is for durable async work, not for repairing a split write that can be removed.**
> **Every TS-side multi-step write that must be all-or-nothing belongs in a single PL/pgSQL RPC. supabase-js HTTP calls are SEPARATE transactions; "rollback across them" is not a thing the spec or the code can claim.**

The first half (event + write atomic) was settled in v2/v3. The second half was added in v4. The third half is new in v5 and is the headline correction over v4: a "split write" — TS does part of the work, then asks Postgres to mark it done — was the failure pattern v3's destructive lease tried to paper over and v4's locked re-check tried to serialise around. v5 removes the split. **The fourth half is new in v7.** It crystallises the recurring failure pattern across every codex review since v3: a spec describes "atomic" semantics that require coordination between two or more `supabase.admin.from(...)` HTTP calls in a `try { ... } catch { ... }` block. Those are separate transactions on separate pooled connections; the catch can compensate at the application layer but it cannot roll back the first commit. The only way to make N writes atomic is to do them inside one PL/pgSQL function. v7 extends this rule explicitly to: the approval-grant path (`grant_booking_approval` RPC, §10), the WO-create-from-event path (`create_setup_work_order_from_event` RPC, §7.8), and the deferred-setup approval path (the rewritten `approve_booking_setup_trigger` RPC, §7.9). Every codex round that surfaced a "C-class" finding has been a violation of this rule that the spec author missed.

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

### 2.5 `setup_work_order_emissions` — handler-side dedup (NEW in v6; v7 fixes FK + atomicity)

The setup-WO handler needs durable dedup so that re-handling the same outbox event is a no-op. v5 §7.7 used `select id from work_orders where linked_order_line_item_id = event.aggregate_id` as the dedup mechanism. Codex flagged that as racy: the index on `tickets.linked_order_line_item_id` is non-unique (`supabase/migrations/00145_tickets_bundle_columns.sql:12` — `idx_tickets_oli`, partial, **not** unique), and a stale-claim replay between two concurrent handler runs could produce two work orders. Closing the WO and replaying the event would also slip past the active-status filter and re-create.

v6 introduced an explicit dedup table; v7 corrects two errors in the v6 schema:

```sql
-- supabase/migrations/00304_setup_work_order_emissions.sql (NEW in v6; v7 contract)

create table public.setup_work_order_emissions (
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  oli_id           uuid        not null,
  -- v7-I3: was tickets(id) in v6 — the rewrite collapsed tickets into
  -- work_orders for booking-origin work (00288), and TicketService
  -- .createBookingOriginWorkOrder writes to public.work_orders directly
  -- (ticket.service.ts:1903). v6's tickets(id) FK would have raised 23503
  -- on the first INSERT.
  --
  -- v8-I4: FK is `ON DELETE SET NULL`, NOT `ON DELETE CASCADE`. Rationale:
  -- the dedup row's "this OLI was already handled" signal MUST survive an
  -- admin WO deletion. v7 used CASCADE, which meant a WO admin-cleanup
  -- cascaded the dedup row away, allowing a replayed event to recreate the
  -- WO — exactly the failure mode the dedup table was designed to prevent.
  -- v8 contract: a row with `work_order_id IS NULL` is a TOMBSTONE meaning
  -- "this OLI's setup-WO was created and later deleted by admin". The
  -- handler treats tombstones as already_handled (idempotent no-op). To
  -- explicitly reset setup-WO creation for an OLI, admins DELETE the
  -- dedup row (see §13.6 admin runbook).
  work_order_id    uuid        references public.work_orders(id) on delete set null,
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
  'Handler-side dedup for setup_work_order.create_required outbox events (§7.8 of the outbox spec). Primary key (tenant_id, oli_id) — at most one setup WO is emitted per OLI for the lifetime of the row. v7: rows are inserted by create_setup_work_order_from_event RPC in the SAME tx as the work_orders insert (atomic). v8: FK to work_orders is ON DELETE SET NULL (was CASCADE in v7) so the dedup signal survives admin WO cleanup. Survives WO close/cancel/delete and event replay; admins reset by DELETE-ing the dedup row.';
```

**v7 atomicity correction (folds C3).** v6 had the handler create the WO via `triggerStrict` (one supabase-js HTTP call → one tx commit) and then INSERT the dedup row via a second `supabase.admin.from('setup_work_order_emissions').insert(...)` (a second HTTP call → a second tx commit). v6 §7.8 explicitly acknowledged the gap as "small enough that the simpler shape wins". Codex v6 review pushed back: "small enough" and "atomic" are not the same thing, and a crash between the WO commit and the dedup commit produces a duplicate WO on replay, which is exactly the failure mode the dedup table was supposed to prevent. v7 closes the gap — the WO insert + dedup insert run in one PL/pgSQL function, `create_setup_work_order_from_event` (§7.8). The handler builds the row payload TS-side (using the existing routing matrix + lead-time logic) and passes it to the RPC; the RPC does the two inserts atomically.

**Handler logic (v7 — full version in §7.8):**

1. `SELECT` on `setup_work_order_emissions` for `(event.tenant_id, event.aggregate_id)` — read-side dedup. If row found: idempotent re-handling — return success.
2. If no row: call `SetupWorkOrderRowBuilder.build(event.payload)` to compute the WO row data (routing matrix lookup, lead-time math, audit metadata). On terminal misconfiguration (routing unmapped, invalid window) the builder returns `{ kind: 'no_op_terminal', reason }`; handler returns success without inserting.
3. On `kind: 'wo_data'`: call `create_setup_work_order_from_event(p_event_id, p_tenant_id, p_wo_row_data, p_idempotency_key)`. RPC inserts the WO + dedup row atomically; returns `{ kind: 'created' | 'already_created', work_order_id }`.
4. On `kind: 'already_created'`: a concurrent handler beat us; idempotent success (no second WO created).
5. On RPC throw: handler retries via worker state machine; eventual dead-letter.

**Why a separate table instead of a unique index on `work_orders`?** Same reasoning as v6:
- (a) WOs can be legitimately deleted (admin cleanup) without invalidating the "this event was already handled" signal. Coupling dedup to WO row existence reintroduces the replay-after-cancel hole. **v8 contract:** the FK is `ON DELETE SET NULL`. When an admin deletes the WO, the dedup row stays as a TOMBSTONE (`work_order_id IS NULL`); the handler treats tombstones as `already_handled` (idempotent no-op). Replay after WO delete does NOT recreate; admin must explicitly reset (see admin runbook below). v7's `ON DELETE CASCADE` made the dedup row go away with the WO and was the source of the replay-after-delete recreation bug — closed in v8.
- (b) The dedup row must commit *atomically with the WO insert*. v7 achieves this by doing both inserts in one PL/pgSQL function — see (a) above for why "unique index on work_orders.linked_order_line_item_id" doesn't help.
- (c) `setup_work_order_emissions` carries `outbox_event_id` for ops triage. The lookup answers "was this specific event already handled?", not just "is there a WO for this OLI?".

**Admin runbook — resetting setup-WO creation for an OLI (v8).** If an operator wants to allow setup-WO creation to re-fire for a specific OLI (e.g. routing matrix was misconfigured at first emit, has since been fixed, and the operator wants the handler to re-evaluate on the next replay), the procedure is:

```sql
-- 1. Confirm the OLI's current dedup row state.
select tenant_id, oli_id, work_order_id, created_at
  from public.setup_work_order_emissions
 where tenant_id = :tenant_id and oli_id = :oli_id;

-- 2. Delete the dedup row. This removes both the "already_created" record
--    AND the "tombstone" (NULL work_order_id) record. Replays of the
--    setup_work_order.create_required event will now re-evaluate.
delete from public.setup_work_order_emissions
 where tenant_id = :tenant_id and oli_id = :oli_id;

-- 3. (If needed) Re-emit the event. If the OLI's pending_setup_trigger_args
--    was already cleared on the original approval grant, the operator must
--    construct a fresh outbox.events row by hand or call a (future) admin
--    re-emit endpoint. The reset alone is NOT sufficient to re-fire — it
--    only un-blocks the next replay.
```

The reset is intentionally manual because "redo a setup WO" is not a routine operation — every reset implies operator-side investigation of what went wrong the first time.

### 2.6 SQL grants

`outbox.events` grants unchanged from 00299/00301. v5 added the combined RPC; v6 added the approval-grant RPC; v7 adds two more RPCs (the rewritten approve RPC takes `p_booking_id`, the WO-create RPC, and the booking-approval grant RPC) and retires the old claim RPC:

```sql
-- supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql (NEW in v5)
grant execute on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text)
  to service_role;
revoke execute on function public.create_booking_with_attach_plan(jsonb, jsonb, uuid, text)
  from authenticated;

-- supabase/migrations/00305_approve_booking_setup_trigger_rpc.sql
-- (NEW in v6; v7 REWRITES the signature — see §7.9)
-- v6 took (p_oli_ids uuid[], p_tenant_id uuid). v7 takes
-- (p_booking_id uuid, p_tenant_id uuid, p_actor_user_id uuid, p_idempotency_key text)
-- because v7 reads pending_setup_trigger_args directly instead of consuming
-- pre-claimed rows from 00198.
grant execute on function public.approve_booking_setup_trigger(uuid, uuid, uuid, text)
  to service_role;
revoke execute on function public.approve_booking_setup_trigger(uuid, uuid, uuid, text)
  from authenticated;

-- supabase/migrations/00306_create_setup_work_order_from_event_rpc.sql (NEW in v7)
-- Atomic WO insert + dedup row insert. Folds C3.
grant execute on function public.create_setup_work_order_from_event(uuid, uuid, jsonb, text)
  to service_role;
revoke execute on function public.create_setup_work_order_from_event(uuid, uuid, jsonb, text)
  from authenticated;

-- supabase/migrations/00307_grant_booking_approval_rpc.sql (NEW in v7)
-- Atomic approval CAS + booking_slots/bookings transition + setup-WO emit.
-- Folds C2.
grant execute on function public.grant_booking_approval(uuid, uuid, uuid, text, text, text)
  to service_role;
revoke execute on function public.grant_booking_approval(uuid, uuid, uuid, text, text, text)
  from authenticated;

-- supabase/migrations/00308_drop_claim_deferred_setup_args.sql (NEW in v7)
-- Retires the old claim RPC. v7 §7.9 explains why:
-- approve_booking_setup_trigger now reads pending_setup_trigger_args directly,
-- so the old claim-and-null primitive is dead. One-release deprecation:
-- 00308 stays as a no-op stub for one deploy cycle, then a follow-up drop
-- migration removes the function entirely. Document in the migration file.
drop function if exists public.claim_deferred_setup_trigger_args(uuid, uuid[]);
```

Both new RPCs are service-role only — TS calls via `supabase.admin`. End users can still hit `BookingFlowService.create`, `ApprovalService.respond`, and `BundleService.onApprovalDecided` (which check `actor.has_override_rules` etc. before calling the RPCs); they just can't reach into the RPCs directly to bypass app-layer authorization.

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

### 3.3 Frontend `X-Client-Request-Id` threading (v8 contract — folds v6-I2 + v7-I1)

**The v6 hole.** v6 §7.3 said: "BookingFlowService should generate one [idempotency_key] per request: `booking.create:${actor.user_id}:${input.client_request_id ?? randomUUID()}`. The frontend's React Query mutation layer already supplies a `client_request_id` per mutation (cf. the `RequestIdProvider` in `apps/web/src/api/api-fetch.ts`)." Both claims are wrong — `RequestIdProvider` does not exist, no header is sent, and the API has no guard reading it. A grep across `apps/web/src apps/api/src` returns zero hits for `client_request_id`, `RequestIdProvider`, or `X-Client-Request-Id`. The "key reuse on automatic retry" property the v6 idempotency story depends on is unimplemented.

**The v7 hole (codex v7-I1).** v7 said `apiFetch` auto-generates a UUID for any non-GET request. That sounds right, but it lives at the **fetch scope** — not the **mutation-attempt scope**. React Query's automatic retry logic re-runs `mutationFn`, which calls `apiFetch` again, which generates a **fresh** UUID on every retry. Two retries of the same logical attempt produce two different `X-Client-Request-Id` values, and the producer sees them as two different operations — defeating the very idempotency mechanism the header was added to enable. v7's "the key is reused for free" sentence is wrong about React Query's retry behaviour: the retry calls the mutation function again; it does not reuse the previous fetch's headers.

**v8 fix.** The id MUST be generated at the **mutation-attempt scope** (the caller's `mutate({ requestId, ... })` shape, captured in closure or generated once before the mutation enters the retry loop) and passed to `apiFetch` as an explicit header. `apiFetch` only forwards the header if the caller passes one — the auto-stamp from v7 is **dropped**. Producer-route hooks generate the id at form-submit time and thread it; routes that don't need idempotency can skip the header entirely (the backend middleware fills in a server default and the producer constructs a key that never collides with another client's).

**`apiFetch` v8 contract (no auto-stamp).**

```typescript
// apps/web/src/lib/api.ts (v8 contract — supersedes the v7 auto-stamp)

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { query, etag, onNotModified, etagOut, ...init } = options;
  const authHeaders = await getAuthHeaders();
  const url = buildUrl(path, query);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (etag) headers['If-None-Match'] = etag;

  // v8 — apiFetch does NOT generate an X-Client-Request-Id header. The id
  // belongs at the mutation-attempt scope, not the fetch scope, because
  // React Query retries call mutationFn → apiFetch again, which would
  // generate a fresh UUID per retry and defeat idempotency. Callers that
  // need the header pass it explicitly via options.headers.

  // ... rest unchanged ...
}
```

**Mutation hook contract (v8 — the canonical pattern producer routes follow).**

The hook accepts the request id as part of its variables (or as an external prop) and threads it as the `X-Client-Request-Id` header. The id is generated ONCE per logical attempt — by the form-submit handler, the page-level provider, or the call site — and is captured in closure for the duration of the mutation including any retries.

```typescript
// apps/web/src/api/<module>/mutations.ts (v8 contract)

interface CreateBookingVariables {
  input: CreateBookingInput;
  requestId: string;            // generated once per attempt by the caller
}

export function useCreateBooking() {
  return useMutation({
    mutationFn: async ({ input, requestId }: CreateBookingVariables) => {
      return apiFetch<Reservation>('/reservations', {
        method: 'POST',
        body: input,
        headers: { 'X-Client-Request-Id': requestId },
      });
    },
    // retry semantics are caller's choice; whatever they pick, retries reuse
    // the same `requestId` because it's captured in the mutation variables.
  });
}

// Caller — typical form-submit path:
//
//   const mutation = useCreateBooking();
//   const onSubmit = (input: CreateBookingInput) => {
//     // Generate ONCE per attempt. If React Query retries (or the user
//     // clicks Retry in a toast that re-uses the same handler), the same
//     // requestId rides along.
//     const requestId = crypto.randomUUID();
//     mutation.mutate({ input, requestId });
//   };
```

**Why "mutation-attempt scope" and not "component-mount scope".** Generating once at component mount and reusing across all submissions of the same form would produce the *opposite* bug: two distinct user clicks with the same key, the first commits, the second hits `attach_operations` cached_result and returns the first attempt's booking — the user thinks they made two bookings but only got one. Mutation-attempt scope is correct: one click, one `requestId`; one click + N React Query retries, one `requestId`; click again, fresh `requestId`. The "click Retry in a toast" case re-enters the form-submit handler so it gets a fresh id by construction (intentional — the user's intent is "fresh attempt", not "retry the in-flight one").

**No internal-helper shortcut.** A `useMutationWithRequestId(mutationFn)` wrapper that generates inside `mutationFn` re-runs on React Query retry — same bug class as v7's auto-stamp. There is no shorter pattern; producer hooks must accept the id in their variables shape and the caller must generate it once per attempt.

**Backend NestJS guard (`apps/api/src/common/middleware/client-request-id.middleware.ts` — NEW in v7).** A small middleware reads `X-Client-Request-Id`, validates it's a UUID-shaped string, and stamps it onto `request.clientRequestId`. Missing or malformed values default to a fresh server-generated UUID (so the property is always set; the producer doesn't need to branch).

```typescript
// apps/api/src/common/middleware/client-request-id.middleware.ts (NEW in v7)

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RequestWithClientId extends Request {
  clientRequestId: string;
  clientRequestIdSource: 'client' | 'server_default';
}

export function clientRequestIdMiddleware(
  req: RequestWithClientId,
  _res: Response,
  next: NextFunction,
): void {
  const raw = req.header('X-Client-Request-Id');
  if (raw && UUID_RE.test(raw)) {
    req.clientRequestId = raw.toLowerCase();
    req.clientRequestIdSource = 'client';
  } else {
    req.clientRequestId = randomUUID();
    req.clientRequestIdSource = 'server_default';
  }
  next();
}
```

Wire the middleware into `AppModule.configure(consumer)` so it runs ahead of every controller. The producer reads `req.clientRequestId` directly (no DI gymnastics). Audit-log emit calls in `BookingFlowService.create` / `ApprovalService.respond` should record `clientRequestIdSource` so ops can distinguish "client retried" from "client never sent the header".

**Producer wiring.** The three RPC call sites that take an `idempotency_key`:

| Producer | Idempotency key construction |
|---|---|
| `BookingFlowService.create` | `booking.create:${actor.userId}:${req.clientRequestId}` |
| `ApprovalService.respond` (v7 — calls `grant_booking_approval`) | `approval.grant:${approval.id}:${req.clientRequestId}` |
| `BundleService.onApprovalDecided` post-grant cascade — *not needed* | RPC keys off `(tenant_id, booking_id)` advisory lock; no client key reaches it (called from inside the booking-approval RPC's tx in v7's design — see §10) |

The setup-WO-from-event RPC (§7.8) keys off `(tenant_id, oli_id)` — bound to the event aggregate, not the client request — because the same event may be replayed many times by the worker, all sharing the same idempotency surface.

**Tests.** Cover the four states: (a) frontend sends a key, retry uses same key → cached_result; (b) frontend sends a key, two distinct user-clicks send different keys → both succeed independently; (c) frontend omits the key, server defaults → still safe (no idempotency benefit, but no failure); (d) frontend sends a malformed string → middleware overrides with a fresh UUID. (b)+(c) cover the realistic paths; (a) is the win.

**Why not a header guard at the controller level?** Tried that in earlier sketches; the middleware approach is cleaner because every mutation route gets the property without per-route boilerplate, and tests can hit `req.clientRequestId` directly without supabase / RPC mocking. Future hardening can add a route-level decorator if specific endpoints need stricter behaviour (e.g. require `clientRequestIdSource === 'client'` for mutation endpoints used by trusted internal tooling).

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

**Phase C — Hardening (deploy 3, +14 days):** observe steady-state. If `outbox_dead_letter_total{event_type="setup_work_order.create_required"}` is non-zero, triage. If `attach_operations_outcomes_total{outcome="payload_mismatch"}` is non-zero, triage (a non-zero `payload_mismatch` count means a producer is constructing non-deterministic UUIDs or non-deterministic idempotency keys — the v6 deterministic-uuidv5 + v7 canonical-sort fixes should keep this at zero). If `setup_work_order_emissions` (§2.5) shows orphan rows (event emitted, handler never ran beyond max_attempts and dead-lettered), that's the production signal we're watching for. **v7-N1:** the v6 spec referenced `attach_operations.outcome='failed'` here, but v6 §2.4 collapsed the enum to `('in_progress', 'success')` — there is no `'failed'` row to count. Replaced with the surviving signals.

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
    id: string;                                  // = planUuid(key, 'oli', `${order_id}:${client_line_id}`)
    client_line_id: string;                      // REQUIRED in v8 — caller-supplied stable id (form-row key
                                                 // or hash). Validated for non-empty + per-order uniqueness
                                                 // by buildAttachPlan before any UUID is generated.
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
 *                Per row-kind (v8 contract — supersedes v7):
 *                  booking            → '0' (always exactly one)
 *                  slot               → String(slot.display_order)
 *                  order              → `${service_type}` (one order per
 *                                        service_type group; service_type IS
 *                                        the unique key)
 *                  oli                → `${order_id}:${client_line_id}`
 *                                        where client_line_id is REQUIRED on
 *                                        the input line (rejected at validation
 *                                        time if missing or non-unique within
 *                                        an order). v8: no _input_position
 *                                        fallback — input order must not leak
 *                                        into the hash.
 *                  asset_reservation  → the OLI id (1:1 — every line that
 *                                        needs one has exactly one)
 *                  approval           → `${approver_person_id}`
 *                                        (unique per approval row after
 *                                        ApprovalRoutingService.assemblePlan
 *                                        dedup; the approver_person_id IS the
 *                                        stable index).
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

**Stable-index discipline (v8 mandatory canonical-sort table — folds v6-I1 + v7-I1 + v8-I5).** The v6 prose described "sort lines by service_type before building orders" as one example, but left the discipline informal. Codex v6 review pointed out that any caller iterating input in a different order on retry — `Object.values()` ordering, JSON parser quirks, async resolver returning lines in network-arrival order — would shift `stableIndex` and break idempotency. v7 promoted the discipline to a per-row-kind canonical sort table. **v7's table used `_input_position` as the OLI tie-breaker, which contradicted the shuffled-input invariant** — caller iteration order leaked back into the hash via the tie-breaker. v8 fixes this by mandating that every row-kind's sort tuple is composed of fully-immutable, caller-provided fields. For OLIs specifically, this means **`client_line_id` is required** on every input line: the caller MUST supply a stable per-line identifier (typically the form-row's React key, or a hashed concatenation of catalog_item + service_window if the form has no per-line key). Plans without `client_line_id` on every OLI are rejected at validation time before the RPC is called — see the "v8: required input fields" callout below.

| Row kind | Sort tuple (ascending) | `stableIndex` value |
|---|---|---|
| `booking` | n/a (always exactly one) | `'0'` |
| `slot` | `(display_order, space_id, start_at)` | `String(display_order)` (display_order is caller-supplied + unique per slot in a booking) |
| `order` | `(service_type)` (service_type is unique per order in v8 — one order per service_type group) | `${service_type}` |
| `oli` | `(client_line_id)` REQUIRED. Secondary sort never needed because client_line_id is unique per line within an order. | `${order_id}:${client_line_id}` |
| `asset_reservation` | derived from the OLI it's attached to | `${oli_id}` (1:1 with the OLI; OLI is already sorted by client_line_id) |
| `approval` | `(approver_person_id)` (after `assemblePlan` dedup; unique per approval row) | `${approver_person_id}` |

**Plan-builder contract (v8).** `BundleService.buildAttachPlan(input)` MUST:
1. Validate that every input line has a non-empty `client_line_id` and that `client_line_id` values are unique within each `(input.order_grouping, client_line_id)` scope. If validation fails, throw `BookingPlanError('client_line_id missing or non-unique')` BEFORE any UUID is generated.
2. Apply each canonical sort using ONLY the immutable fields in the tuple — no `_input_position` fallback, no `Array.prototype.indexOf` calls.
3. Assign `stableIndex` from the sorted position only when the tuple itself isn't already a sufficient identifier. For OLIs, the `stableIndex` IS the `client_line_id` (no positional component); for orders, the `stableIndex` IS the `service_type` (one order per service_type by construction); for approvals, the `stableIndex` IS the `approver_person_id`.

A unit test asserts: given two `input` objects that are equal modulo array-element ordering, `buildAttachPlan` returns byte-identical jsonb.

```typescript
// apps/api/src/modules/booking-bundles/plan-uuid.ts (v8 contract — supersedes v7)

/**
 * Canonical-sort comparators per row-kind. Sort BEFORE assigning stableIndex.
 * The plan-builder calls these directly; do not bypass.
 *
 * v8: every comparator uses ONLY fully-immutable, caller-provided fields.
 * No `_input_position` tie-breakers — that shape contradicted the
 * shuffled-input invariant in v7.
 */
export const planSort = {
  slots: (
    a: { display_order: number; space_id: string; start_at: string },
    b: { display_order: number; space_id: string; start_at: string },
  ) => {
    const c = a.display_order - b.display_order;
    if (c !== 0) return c;
    const d = a.space_id.localeCompare(b.space_id);
    return d !== 0 ? d : a.start_at.localeCompare(b.start_at);
  },

  orders: (a: { service_type: string }, b: { service_type: string }) =>
    a.service_type.localeCompare(b.service_type),

  // v8: `client_line_id` is REQUIRED on every input line. The plan-builder
  // validates presence + per-order uniqueness before this comparator runs.
  // No fallback, no _input_position — if client_line_id is missing, the
  // plan-builder throws.
  olis: (
    a: { client_line_id: string },
    b: { client_line_id: string },
  ) => a.client_line_id.localeCompare(b.client_line_id),

  // Asset reservations sort positionally by their attached OLI, which is
  // already sorted by client_line_id; the comparator is here only for
  // independent tests of the helper.
  assetReservations: (
    a: { client_line_id: string },
    b: { client_line_id: string },
  ) => a.client_line_id.localeCompare(b.client_line_id),

  approvals: (a: { approver_person_id: string }, b: { approver_person_id: string }) =>
    a.approver_person_id.localeCompare(b.approver_person_id),
} as const;
```

**v8: required input fields (closes v7-I5).** The combined-RPC input contract grows one mandatory field per OLI:

```typescript
interface AttachInputLine {
  client_line_id: string;              // REQUIRED (v8). Stable identifier for this line
                                       // within the request. Typically the React form-row
                                       // key, or a hash of (catalog_item_id, service_window).
                                       // Plan-builder rejects requests where any line is
                                       // missing this OR where two lines in the same order
                                       // have the same value.
  catalog_item_id: string;
  // ... existing fields ...
}
```

Frontend forms that call `useCreateBooking` must populate `client_line_id` before submission. The simplest pattern: when adding a service line to the form, generate `crypto.randomUUID()` and store it on the line; this id then survives across submit + retries. **This is unrelated to `X-Client-Request-Id` (§3.3)** — `client_line_id` is per-line; `X-Client-Request-Id` is per-mutation-attempt. Both are required for end-to-end retry idempotency on a multi-line booking.

**Document the per-row-kind derivation in the plan-builder code's docstring.** A future change to the canonical sort breaks idempotency for any in-flight retries, so the choice belongs in review-friendly code, not just spec prose.

**Pre-v8 stable-index examples below are now historical — see the table above for the v8 contract:**

- `slot.display_order` is set by the caller and is part of the input; deterministic.
- `service_type` ordering: sort the input lines by `service_type` ascending (alphabetical) before building orders. Two retries see the same input lines, sort identically, and produce identical order indices.
- `order_id` is itself derived from `(service_type)`, so by the time we compute the OLI's `stable_line_index`, `order_id` is already deterministic.
- `approver_person_id` is given by the resolver; sort ascending for the approval index.

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

  // v6: deterministic id derived from idempotency_key + approver_person_id.
  // Sort approver ids ascending for byte-stable plan output.
  // v8 (folds I5): the stableIndex IS the approver_person_id — no positional
  // index. The sort is for output determinism only; the hash input no longer
  // depends on sorted position.
  const sortedApproverIds = Array.from(grouped.keys()).sort();

  const out: AssembledApprovalRow[] = [];
  for (const approverPersonId of sortedApproverIds) {
    const entry = grouped.get(approverPersonId)!;
    out.push({
      id: planUuid(args.idempotencyKey, 'approval', approverPersonId),  // v6-C1, v8-I5
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
  perform public.validate_attach_plan_internal_refs(p_tenant_id, p_booking_input, p_attach_plan);  -- v6-I2 + v8-I3 (signature gained p_tenant_id in v7 §8.2; v8 aligns the call site)

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

### 7.7 `SetupWorkOrderRowBuilder.build` — TS-side row-data only (v7 — folds C3)

**v6 was wrong about atomicity.** v6 introduced `triggerStrict` as a typed-outcome wrapper around the existing best-effort `trigger`. It correctly distinguished transient throws from terminal no-ops, but it still INSERT-ed the WO via supabase-js (one HTTP call → one tx) and the dedup row in `setup_work_order_emissions` via a second supabase-js call (a second HTTP call → a second tx). v6 §7.8 acknowledged the gap as "small enough" — codex v6 disagreed. v7 closes it by moving the WO + dedup INSERT into one PL/pgSQL function (`create_setup_work_order_from_event`, §7.8) and reducing the TS-side responsibility to "build the row data, hand to the RPC".

The trade-off vs. fully porting WO creation to PL/pgSQL: `TicketService.createBookingOriginWorkOrder` (`ticket.service.ts:1829-1934`) is ~100 lines of orchestration including system-event audit log + domain-event emission. Porting it all to PL/pgSQL is multi-week work and creates a second copy of business logic to keep in sync with the audit/event-emission rules. v7 picks the middle path: TS builds the row payload (preserving all the existing logic) and passes it to a thin RPC that does only the two atomic INSERTs + the audit/event rows.

```typescript
// apps/api/src/modules/service-routing/setup-work-order-row-builder.service.ts
//   (NEW in v7; replaces the v6 triggerStrict role)

export type SetupWorkOrderRowBuildResult =
  | { kind: 'wo_data'; row: SetupWorkOrderRowData }
  | { kind: 'no_op_terminal'; reason: 'no_routing_match' | 'invalid_window' | 'config_disabled' };

export interface SetupWorkOrderRowData {
  // Row contents for public.work_orders (mirrors the insertRow at ticket.service.ts:1875-1900)
  parent_kind: 'booking';
  parent_ticket_id: null;
  booking_id: string;
  linked_order_line_item_id: string;
  title: string;
  description: string | null;
  priority: string;
  interaction_mode: 'internal';
  status: 'new';
  status_category: 'new' | 'assigned';
  requester_person_id: null;
  location_id: string | null;
  assigned_team_id: string | null;
  assigned_user_id: null;
  assigned_vendor_id: null;
  sla_id: string | null;
  sla_resolution_due_at: string | null;
  source_channel: 'system';

  // Audit/event metadata — RPC writes these alongside the WO row in the same tx.
  audit_metadata: {
    triggered_by_rule_ids: string[];
    lead_time_minutes: number;
    service_window_start_at: string;
    service_category: string;
    sla_policy_id: string | null;
    origin: string;
  };
}

@Injectable()
export class SetupWorkOrderRowBuilder {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly log = new Logger(SetupWorkOrderRowBuilder.name),
  ) {}

  /**
   * Pure builder: routing matrix lookup + lead-time math + row payload assembly.
   *
   *   - `kind: 'wo_data'` → all inputs valid, hand to create_setup_work_order_from_event RPC.
   *   - `kind: 'no_op_terminal'` → terminal misconfiguration; handler returns success.
   *   - THROWS on RPC errors (transient) — outbox worker retries.
   *
   * No INSERTs happen here. The atomic write is done by the RPC.
   */
  async build(payload: SetupWorkOrderPayload): Promise<SetupWorkOrderRowBuildResult> {
    const { data: routing, error: routingErr } = await this.supabase.admin.rpc(
      'resolve_setup_routing',
      {
        p_tenant_id: payload.tenant_id,
        p_location_id: payload.location_id,
        p_service_category: payload.service_category,
      },
    );
    if (routingErr) {
      throw new Error(`resolve_setup_routing: ${routingErr.message}`);
    }
    const row = (routing as Array<{
      internal_team_id: string | null;
      default_lead_time_minutes: number;
      sla_policy_id: string | null;
    }> | null)?.[0];
    if (!row || !row.internal_team_id) {
      return { kind: 'no_op_terminal', reason: 'no_routing_match' };
    }

    const leadTime = payload.lead_time_override_minutes ?? row.default_lead_time_minutes;
    const startMs = new Date(payload.service_window_start_at).getTime();
    if (!Number.isFinite(startMs)) {
      return { kind: 'no_op_terminal', reason: 'invalid_window' };
    }
    const targetDueAt = new Date(startMs - leadTime * 60_000).toISOString();

    return {
      kind: 'wo_data',
      row: {
        parent_kind: 'booking',
        parent_ticket_id: null,
        booking_id: payload.booking_id,
        linked_order_line_item_id: payload.oli_id,
        title: `Internal setup — ${payload.service_category}`,
        description: null,
        priority: 'medium',
        interaction_mode: 'internal',
        status: 'new',
        status_category: 'assigned',
        requester_person_id: null,
        location_id: payload.location_id,
        assigned_team_id: row.internal_team_id,
        assigned_user_id: null,
        assigned_vendor_id: null,
        sla_id: row.sla_policy_id,
        sla_resolution_due_at: targetDueAt,
        source_channel: 'system',
        audit_metadata: {
          triggered_by_rule_ids: payload.rule_ids,
          lead_time_minutes: leadTime,
          service_window_start_at: payload.service_window_start_at,
          service_category: payload.service_category,
          sla_policy_id: row.sla_policy_id,
          origin: payload.origin_surface,
        },
      },
    };
  }
}
```

`SetupWorkOrderTriggerService.trigger` and `triggerMany` (the legacy best-effort path at `setup-work-order-trigger.service.ts:46-202`) have NO callers after v7's Phase B cutover — they're deleted in the v6/v7 cleanup commit (§16.1). The v6 `triggerStrict` method is also deleted (it was only ever introduced to be the handler's call site; v7 replaces it with the row-builder + atomic RPC).

### 7.7-bis (legacy, retained as historical context) `SetupWorkOrderTriggerService.triggerStrict` (v6, REPLACED IN V7)

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

### 7.8 Setup work order handler (v7 — folds C3 atomicity)

```typescript
// apps/api/src/modules/outbox/handlers/setup-work-order.handler.ts
@Injectable()
@OutboxHandler('setup_work_order.create_required', { version: 1 })
export class SetupWorkOrderHandler {
  constructor(
    private readonly rowBuilder: SetupWorkOrderRowBuilder,
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

    // ── 2. Approval-pending guard (defense-in-depth — both producer paths
    //   gate emission on any_pending_approval=false). ─────────────────────
    if (event.payload.requires_approval) {
      this.log.log(`requires_approval_skip oli=${event.aggregate_id}`);
      return;
    }

    // ── 3. Read-side dedup (v6 + v7-I1). If a prior handler attempt already
    //   committed the WO + dedup row atomically (§2.5), this is an
    //   idempotent re-handling — return success. The RPC's INSERT is the
    //   write-side dedup; this read is just a fast path for the common
    //   "worker retried after partial commit" case so we don't pay the
    //   row-build + RPC round trip when we already know the answer. ──────
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

    // ── 4. Build the WO row payload TS-side (routing matrix + lead-time
    //   math). Terminal misconfiguration returns no_op_terminal; transient
    //   errors throw and the worker retries. ──────────────────────────────
    const built = await this.rowBuilder.build({
      tenant_id:                  event.tenant_id,
      booking_id:                 event.payload.booking_id,
      oli_id:                     event.payload.oli_id,
      service_category:           event.payload.service_category,
      service_window_start_at:    event.payload.service_window_start_at,
      location_id:                event.payload.location_id,
      rule_ids:                   event.payload.rule_ids,
      lead_time_override_minutes: event.payload.lead_time_override_minutes,
      origin_surface:             event.payload.origin_surface,
    });

    if (built.kind === 'no_op_terminal') {
      // Terminal: do NOT call the create RPC; do NOT insert dedup. A future
      // replay (e.g. after admin reconfigures the routing matrix) will
      // re-evaluate and may produce a WO. Capture the terminal outcome in
      // audit_events for ops triage.
      void this.audit(
        event.tenant_id,
        `setup_work_order.${built.reason}`,
        'order_line_item',
        event.aggregate_id,
        { event_id: event.id, reason: built.reason },
      );
      this.log.log(`no_op_terminal oli=${event.aggregate_id} reason=${built.reason}`);
      return;
    }

    // ── 5. Atomic write (v7-C3): single RPC inserts the WO + dedup row +
    //   audit row in one Postgres tx. On crash between this call's response
    //   and the worker marking processed_at, replay re-enters at step 3
    //   above; the read-side dedup or the RPC's own already_created path
    //   produces the same idempotent success. ────────────────────────────
    const { data: result, error } = await this.supabase.admin.rpc(
      'create_setup_work_order_from_event',
      {
        p_event_id:        event.id,
        p_tenant_id:       event.tenant_id,
        p_wo_row_data:     built.row,
        p_idempotency_key: `setup_work_order:${event.aggregate_id}`,
      },
    );
    if (error) {
      // Transient — outbox retries with backoff per §4.4.
      throw new Error(`create_setup_work_order_from_event: ${error.message}`);
    }

    const out = result as { kind: 'created' | 'already_created'; work_order_id: string };
    this.log.log(`${out.kind} oli=${event.aggregate_id} wo=${out.work_order_id}`);
  }

  /** Phase A shadow mode: never mutates; produces an outbox_shadow_results row. */
  async dryRun(event: OutboxEventWithPayload<SetupWorkOrderPayload>): Promise<ShadowOutcome> {
    // Replays the routing-matrix lookup + lead-time math from
    // SetupWorkOrderRowBuilder.build but RETURNS the row data instead of
    // calling the create RPC. Compared to the inline-path's actual outcome
    // (audit_events / work_orders rows) by the gate query in §5.2.
    const built = await this.rowBuilder.build(/* same args as handle() */);
    return built.kind === 'wo_data'
      ? { kind: 'would_create', team_id: built.row.assigned_team_id, due_at: built.row.sla_resolution_due_at, ... }
      : { kind: 'no_op_terminal', reason: built.reason };
  }

  private async audit(
    tenantId: string,
    eventType: string,
    entityType: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.supabase.admin.from('audit_events').insert({
      tenant_id: tenantId,
      event_type: eventType,
      entity_type: entityType,
      entity_id: entityId,
      details,
    });
  }
}
```

#### 7.8.1 `create_setup_work_order_from_event` RPC body (v7 baseline — SUPERSEDED BY §7.8.2 IN V8)

> **v8 note:** the body below is preserved for traceability of v7's C3 fix (atomic WO + dedup + audit in one tx). It is **NOT the v8 contract** — v8 changes the identity-derivation discipline (load `outbox.events` row, derive `v_oli_id` from `aggregate_id`, validate the chain, cross-check row JSON, validate every tenant-owned FK). See §7.8.2 below for the v8 RPC body that ships in 00306. The v7 listing here is reference-only; do not implement it as written.

```sql
-- supabase/migrations/00306_create_setup_work_order_from_event_rpc.sql (v7 baseline; superseded by v8 §7.8.2)

create or replace function public.create_setup_work_order_from_event(
  p_event_id        uuid,
  p_tenant_id       uuid,
  p_wo_row_data     jsonb,    -- SetupWorkOrderRowData (§7.7)
  p_idempotency_key text      -- 'setup_work_order:<oli_id>'
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_oli_id           uuid;
  v_existing_wo_id   uuid;
  v_lock_key         bigint;
  v_work_order_id    uuid;
  v_audit_metadata   jsonb;
begin
  if p_tenant_id is null then
    raise exception 'create_setup_work_order_from_event: p_tenant_id required';
  end if;

  v_oli_id := nullif(p_wo_row_data->>'linked_order_line_item_id', '')::uuid;
  if v_oli_id is null then
    raise exception 'create_setup_work_order_from_event: linked_order_line_item_id missing';
  end if;

  -- ── 1. Per-OLI advisory lock — serialises concurrent handler retries ──
  -- pg_advisory_xact_lock is held until tx commit/rollback. Two workers
  -- claiming the same event (e.g. via stale-claim recovery) both reach this
  -- lock; the second waits, then re-reads setup_work_order_emissions and
  -- sees the committed row from the first.
  v_lock_key := hashtextextended(p_tenant_id::text || ':setup_wo:' || v_oli_id::text, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. Already created? ──────────────────────────────────────────────
  select work_order_id into v_existing_wo_id
    from public.setup_work_order_emissions
   where tenant_id = p_tenant_id and oli_id = v_oli_id
   for update;
  if found then
    return jsonb_build_object(
      'kind',          'already_created',
      'work_order_id', v_existing_wo_id
    );
  end if;

  -- ── 3. INSERT the work order. The row payload is built TS-side; we insert
  -- it verbatim. Tenant_id is stamped from p_tenant_id (NOT trusted from the
  -- payload) — same defensive posture as create_booking_with_attach_plan. ──
  v_work_order_id := gen_random_uuid();
  v_audit_metadata := coalesce(p_wo_row_data->'audit_metadata', '{}'::jsonb);

  insert into public.work_orders (
    id, tenant_id,
    parent_kind, parent_ticket_id,
    booking_id, linked_order_line_item_id,
    title, description, priority,
    interaction_mode, status, status_category,
    requester_person_id, location_id,
    assigned_team_id, assigned_user_id, assigned_vendor_id,
    sla_id, sla_resolution_due_at,
    source_channel
  ) values (
    v_work_order_id, p_tenant_id,
    p_wo_row_data->>'parent_kind',
    nullif(p_wo_row_data->>'parent_ticket_id', '')::uuid,
    nullif(p_wo_row_data->>'booking_id', '')::uuid,
    v_oli_id,
    p_wo_row_data->>'title',
    nullif(p_wo_row_data->>'description', ''),
    coalesce(p_wo_row_data->>'priority', 'medium'),
    p_wo_row_data->>'interaction_mode',
    p_wo_row_data->>'status',
    p_wo_row_data->>'status_category',
    nullif(p_wo_row_data->>'requester_person_id', '')::uuid,
    nullif(p_wo_row_data->>'location_id', '')::uuid,
    nullif(p_wo_row_data->>'assigned_team_id', '')::uuid,
    nullif(p_wo_row_data->>'assigned_user_id', '')::uuid,
    nullif(p_wo_row_data->>'assigned_vendor_id', '')::uuid,
    nullif(p_wo_row_data->>'sla_id', '')::uuid,
    nullif(p_wo_row_data->>'sla_resolution_due_at', '')::timestamptz,
    p_wo_row_data->>'source_channel'
  );

  -- ── 4. INSERT the dedup row in the SAME tx. PK collision (concurrent
  -- handler somehow inserted before us, despite the advisory lock — would
  -- only happen if the lock keys hash differently for some reason) raises
  -- 23505 and rolls the WHOLE tx back, including the WO insert. The next
  -- replay reads the existing dedup row and returns 'already_created'. ──
  insert into public.setup_work_order_emissions (
    tenant_id, oli_id, work_order_id, outbox_event_id
  ) values (
    p_tenant_id, v_oli_id, v_work_order_id, p_event_id
  );

  -- ── 5. Domain event + audit row in same tx. The legacy
  -- TicketService.createBookingOriginWorkOrder writes a system_event
  -- activity row + a domain_events row + an audit_events row; we replicate
  -- those here so the RPC is a complete replacement for the legacy path. ──
  insert into public.domain_events (
    tenant_id, event_type, entity_type, entity_id, payload
  ) values (
    p_tenant_id,
    'booking_origin_work_order_created',
    'work_order',
    v_work_order_id,
    jsonb_build_object(
      'work_order_id',              v_work_order_id,
      'booking_id',                 nullif(p_wo_row_data->>'booking_id', '')::uuid,
      'linked_order_line_item_id',  v_oli_id,
      'audit_metadata',             v_audit_metadata
    )
  );

  insert into public.audit_events (
    tenant_id, event_type, entity_type, entity_id, details
  ) values (
    p_tenant_id,
    'setup_work_order_created',
    'work_order',
    v_work_order_id,
    jsonb_build_object(
      'event_id',   p_event_id,
      'oli_id',     v_oli_id,
      'team_id',    nullif(p_wo_row_data->>'assigned_team_id', '')::uuid,
      'due_at',     nullif(p_wo_row_data->>'sla_resolution_due_at', '')::timestamptz,
      'sla_policy_id', nullif(p_wo_row_data->>'sla_id', '')::uuid,
      'metadata',   v_audit_metadata
    )
  );

  return jsonb_build_object(
    'kind',          'created',
    'work_order_id', v_work_order_id
  );

exception
  when unique_violation then
    -- A concurrent handler raced past the advisory lock (theoretically
    -- impossible with a healthy hash; defensive). Re-read and return.
    select work_order_id into v_existing_wo_id
      from public.setup_work_order_emissions
     where tenant_id = p_tenant_id and oli_id = v_oli_id;
    if v_existing_wo_id is null then
      -- The unique_violation was on something else (work_orders constraint
      -- maybe). Re-raise so the worker retries.
      raise;
    end if;
    return jsonb_build_object(
      'kind',          'already_created',
      'work_order_id', v_existing_wo_id
    );
end;
$$;

comment on function public.create_setup_work_order_from_event(uuid, uuid, jsonb, text) is
  'Atomic WO insert + dedup row insert + audit/domain event for setup_work_order.create_required outbox events. Single tx; idempotent on (tenant_id, oli_id) via setup_work_order_emissions. Folds v7-C3 of the outbox spec.';
```

**Why TS builds the row payload + RPC inserts atomically (vs. fully porting WO creation to PL/pgSQL):** ~100 lines of TS-side row-builder logic stays in TS (routing-matrix RPC call, lead-time math, audit-metadata assembly); only the two atomic INSERTs + audit/event rows live in PL/pgSQL. The alternative (porting `TicketService.createBookingOriginWorkOrder` body to PL/pgSQL) duplicates business logic across the language boundary. The middle path keeps the row-building logic in one language while moving the atomic write into Postgres.

**Caveat: keep the RPC's audit/event rows in sync with the legacy `createBookingOriginWorkOrder`.** The legacy method writes `addActivity({ activity_type: 'system_event', ... })` and `logDomainEvent('booking_origin_work_order_created', ...)`. The RPC above inlines the equivalents (`domain_events` + `audit_events` rows). Validate parity in tests: a WO created via the RPC should produce the same downstream rows (modulo timestamps) as one created via the legacy method, otherwise the activity feed / audit timeline will fork.

#### 7.8.2 v8-C1 fix — derive identity from `outbox.events`, not row JSON

**The v7 hole.** v7's RPC body validates `event.aggregate_id` belongs to the tenant (via the worker's §4.3 guard) but then trusts `p_wo_row_data` for `linked_order_line_item_id`, `location_id`, `assigned_team_id`, `sla_id`, etc., and inserts those FK fields blind. A buggy row-builder or compromised handler could pass an OLI id from a different event's aggregate OR cross-tenant FK values.

**v8 fix:** the RPC stops trusting the row JSON for identity. It loads the `outbox.events` row, derives `v_oli_id` from `aggregate_id`, validates the OLI→order→booking chain under tenant (capturing `v_booking_id` from the chain), cross-checks the row JSON's identity fields against the derived ids (raises `setup_wo.row_oli_mismatch` / `setup_wo.row_booking_mismatch` on disagreement), and validates every tenant-owned FK in the row JSON via the new `validate_setup_wo_fks` helper. Identity values written to `public.work_orders` come from the chain; the row JSON keeps non-identity fields (title, description, priority, audit_metadata).

**v8 RPC body** (replaces the v7 body in §7.8.1):

```sql
-- supabase/migrations/00306_create_setup_work_order_from_event_rpc.sql (v8 contract)

create or replace function public.create_setup_work_order_from_event(
  p_event_id        uuid,
  p_tenant_id       uuid,
  p_wo_row_data     jsonb,    -- SetupWorkOrderRowData (§7.7); identity fields are CROSS-CHECKED, not trusted
  p_idempotency_key text      -- 'setup_work_order:<oli_id>'
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_event            outbox.events%rowtype;
  v_oli_id           uuid;
  v_order_id         uuid;
  v_booking_id       uuid;
  v_existing_wo_id   uuid;
  v_lock_key         bigint;
  v_work_order_id    uuid;
  v_audit_metadata   jsonb;
  v_row_oli_id       uuid;
begin
  if p_tenant_id is null then
    raise exception 'create_setup_work_order_from_event: p_tenant_id required';
  end if;

  -- ── 1. Load the outbox event row (canonical source of identity). v8-C1.
  -- The row's tenant_id MUST match p_tenant_id; the event_type MUST be the
  -- setup-WO type. Either failure is a bug in the worker (claimed the wrong
  -- event for this RPC) and aborts before any side effect. ────────────────
  select * into v_event
    from outbox.events
   where id = p_event_id
     and tenant_id = p_tenant_id
     and event_type = 'setup_work_order.create_required';
  if not found then
    raise exception 'setup_wo.event_not_found event_id=% tenant_id=%',
      p_event_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  v_oli_id := v_event.aggregate_id;
  if v_oli_id is null then
    raise exception 'setup_wo.event_missing_aggregate event_id=%', p_event_id
      using errcode = 'P0002';
  end if;

  -- ── 2. Validate OLI → order → booking chain under tenant. v_booking_id is
  -- DERIVED from the chain; we do not trust p_wo_row_data->>'booking_id'. ──
  select oli.order_id, o.booking_id
    into v_order_id, v_booking_id
    from public.order_line_items oli
    join public.orders            o on o.id = oli.order_id
   where oli.id        = v_oli_id
     and oli.tenant_id = p_tenant_id
     and o.tenant_id   = p_tenant_id;
  if not found then
    raise exception 'setup_wo.oli_chain_invalid oli_id=% tenant_id=%',
      v_oli_id, p_tenant_id
      using errcode = 'P0002',
            detail = 'OLI does not exist in tenant or order chain is broken';
  end if;

  -- ── 3. Cross-check the row JSON's identity fields against the derived
  -- ids. If they disagree, the row-builder is buggy/compromised — raise
  -- LOUDLY and roll back before any side effect. ─────────────────────────
  v_row_oli_id := nullif(p_wo_row_data->>'linked_order_line_item_id', '')::uuid;
  if v_row_oli_id is null then
    raise exception 'setup_wo.row_oli_missing'
      using errcode = 'P0001';
  end if;
  if v_row_oli_id <> v_oli_id then
    raise exception 'setup_wo.row_oli_mismatch row=% event_aggregate=%',
      v_row_oli_id, v_oli_id
      using errcode = 'P0001',
            hint = 'Row-builder produced an OLI id that does not match the event aggregate. Fix the builder.';
  end if;
  -- booking_id: if present in the row JSON, must agree with the chain.
  if p_wo_row_data ? 'booking_id'
     and p_wo_row_data->>'booking_id' is not null
     and length(p_wo_row_data->>'booking_id') > 0
     and (p_wo_row_data->>'booking_id')::uuid <> v_booking_id then
    raise exception 'setup_wo.row_booking_mismatch row=% chain=%',
      (p_wo_row_data->>'booking_id')::uuid, v_booking_id
      using errcode = 'P0001';
  end if;

  -- ── 4. Validate every tenant-owned FK field in the row JSON. v8-C1. ────
  perform public.validate_setup_wo_fks(p_tenant_id, v_booking_id, p_wo_row_data);

  -- ── 5. Per-OLI advisory lock — serialises concurrent handler retries ──
  v_lock_key := hashtextextended(p_tenant_id::text || ':setup_wo:' || v_oli_id::text, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 6. Already created? ──────────────────────────────────────────────
  -- v8-I4: ON DELETE SET NULL means a row with work_order_id IS NULL is a
  -- tombstone (admin deleted the WO). Treat as already_handled — admin must
  -- explicitly DELETE the dedup row to allow re-creation. See §2.5.
  select work_order_id into v_existing_wo_id
    from public.setup_work_order_emissions
   where tenant_id = p_tenant_id and oli_id = v_oli_id
   for update;
  if found then
    return jsonb_build_object(
      'kind',          case when v_existing_wo_id is null then 'already_handled_tombstone'
                            else 'already_created' end,
      'work_order_id', v_existing_wo_id  -- may be null (tombstone)
    );
  end if;

  -- ── 7. INSERT the work order. Identity fields use the DERIVED values
  -- (v_booking_id, v_oli_id), NOT p_wo_row_data. Tenant_id is stamped from
  -- p_tenant_id. The non-identity row fields (title, description, priority,
  -- assigned_team_id, sla_id, etc.) come from p_wo_row_data after step 4
  -- validated them. ──────────────────────────────────────────────────────
  v_work_order_id := gen_random_uuid();
  v_audit_metadata := coalesce(p_wo_row_data->'audit_metadata', '{}'::jsonb);

  insert into public.work_orders (
    id, tenant_id,
    parent_kind, parent_ticket_id,
    booking_id, linked_order_line_item_id,
    title, description, priority,
    interaction_mode, status, status_category,
    requester_person_id, location_id,
    assigned_team_id, assigned_user_id, assigned_vendor_id,
    sla_id, sla_resolution_due_at,
    source_channel
  ) values (
    v_work_order_id, p_tenant_id,
    p_wo_row_data->>'parent_kind',
    nullif(p_wo_row_data->>'parent_ticket_id', '')::uuid,
    v_booking_id,                                        -- DERIVED, v8-C1
    v_oli_id,                                            -- DERIVED, v8-C1
    p_wo_row_data->>'title',
    nullif(p_wo_row_data->>'description', ''),
    coalesce(p_wo_row_data->>'priority', 'medium'),
    p_wo_row_data->>'interaction_mode',
    p_wo_row_data->>'status',
    p_wo_row_data->>'status_category',
    nullif(p_wo_row_data->>'requester_person_id', '')::uuid,
    nullif(p_wo_row_data->>'location_id', '')::uuid,
    nullif(p_wo_row_data->>'assigned_team_id', '')::uuid,
    nullif(p_wo_row_data->>'assigned_user_id', '')::uuid,
    nullif(p_wo_row_data->>'assigned_vendor_id', '')::uuid,
    nullif(p_wo_row_data->>'sla_id', '')::uuid,
    nullif(p_wo_row_data->>'sla_resolution_due_at', '')::timestamptz,
    p_wo_row_data->>'source_channel'
  );

  -- ── 8. INSERT the dedup row in the SAME tx. ─────────────────────────
  insert into public.setup_work_order_emissions (
    tenant_id, oli_id, work_order_id, outbox_event_id
  ) values (
    p_tenant_id, v_oli_id, v_work_order_id, p_event_id
  );

  -- ── 9. Domain event + audit row in same tx (unchanged from v7). ───────
  insert into public.domain_events (
    tenant_id, event_type, entity_type, entity_id, payload
  ) values (
    p_tenant_id,
    'booking_origin_work_order_created',
    'work_order',
    v_work_order_id,
    jsonb_build_object(
      'work_order_id',              v_work_order_id,
      'booking_id',                 v_booking_id,
      'linked_order_line_item_id',  v_oli_id,
      'audit_metadata',             v_audit_metadata
    )
  );

  insert into public.audit_events (
    tenant_id, event_type, entity_type, entity_id, details
  ) values (
    p_tenant_id,
    'setup_work_order_created',
    'work_order',
    v_work_order_id,
    jsonb_build_object(
      'event_id',      p_event_id,
      'oli_id',        v_oli_id,
      'team_id',       nullif(p_wo_row_data->>'assigned_team_id', '')::uuid,
      'due_at',        nullif(p_wo_row_data->>'sla_resolution_due_at', '')::timestamptz,
      'sla_policy_id', nullif(p_wo_row_data->>'sla_id', '')::uuid,
      'metadata',      v_audit_metadata
    )
  );

  return jsonb_build_object(
    'kind',          'created',
    'work_order_id', v_work_order_id
  );

exception
  when unique_violation then
    select work_order_id into v_existing_wo_id
      from public.setup_work_order_emissions
     where tenant_id = p_tenant_id and oli_id = v_oli_id;
    if v_existing_wo_id is null then
      raise;
    end if;
    return jsonb_build_object(
      'kind',          'already_created',
      'work_order_id', v_existing_wo_id
    );
end;
$$;
```

**`validate_setup_wo_fks` helper (NEW in v8 — folds C1).**

```sql
-- supabase/migrations/00306_create_setup_work_order_from_event_rpc.sql (v8 addition)

create or replace function public.validate_setup_wo_fks(
  p_tenant_id   uuid,
  p_booking_id  uuid,
  p_wo_row_data jsonb
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- location_id (optional)
  v_id := nullif(p_wo_row_data->>'location_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.spaces where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: location_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- assigned_team_id (optional)
  v_id := nullif(p_wo_row_data->>'assigned_team_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.teams where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: assigned_team_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- assigned_user_id (optional)
  v_id := nullif(p_wo_row_data->>'assigned_user_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.users where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: assigned_user_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- assigned_vendor_id (optional)
  v_id := nullif(p_wo_row_data->>'assigned_vendor_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.vendors where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: assigned_vendor_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- sla_id (optional) — references public.sla_policies
  v_id := nullif(p_wo_row_data->>'sla_id', '')::uuid;
  if v_id is not null then
    perform 1 from public.sla_policies where id = v_id and tenant_id = p_tenant_id;
    if not found then
      raise exception 'setup_wo.fk_invalid: sla_id %', v_id
        using errcode = '42501';
    end if;
  end if;

  -- request_type_id (optional)
  if p_wo_row_data ? 'request_type_id' then
    v_id := nullif(p_wo_row_data->>'request_type_id', '')::uuid;
    if v_id is not null then
      perform 1 from public.request_types where id = v_id and tenant_id = p_tenant_id;
      if not found then
        raise exception 'setup_wo.fk_invalid: request_type_id %', v_id
          using errcode = '42501';
      end if;
    end if;
  end if;
end;
$$;

comment on function public.validate_setup_wo_fks(uuid, uuid, jsonb) is
  'Validates every tenant-owned FK in a setup WO row payload before INSERT. Folds v8-C1 of the outbox spec — closes the hole where create_setup_work_order_from_event trusted FK fields from p_wo_row_data without tenant validation.';
```

**Tests added (v8 — append to §15.5).**
- Cross-tenant `linked_order_line_item_id` in `p_wo_row_data` (different from `outbox.events.aggregate_id`) → raises `setup_wo.row_oli_mismatch` BEFORE any insert; verify by row-state assertion (no `work_orders` row, no `setup_work_order_emissions` row).
- Cross-tenant `assigned_team_id` (valid UUID, but in another tenant) → raises `setup_wo.fk_invalid: assigned_team_id` BEFORE any insert.
- Cross-tenant `location_id`, `sla_id` — same shape, one test each.
- `outbox.events` row has been deleted (race: worker held the row and event got purged) → raises `setup_wo.event_not_found`; no insert.
- Mismatched `booking_id` in `p_wo_row_data` (event chain → booking A; row JSON has booking B) → raises `setup_wo.row_booking_mismatch` (the chain is authoritative; row JSON is cross-checked).
- Happy path: identity derived from chain, FKs valid → success; assert `work_orders.booking_id` and `work_orders.linked_order_line_item_id` match the *chain-derived* values, not what the row JSON contained (mutate the row JSON's `booking_id` to match the chain so the test passes the §3 cross-check; verify the chain-derived values are what got persisted).

---

### 7.9 `approve_booking_setup_trigger` RPC (REWRITTEN IN V7 — folds v6-C4 + v7-C1)

**The v6 cutover was broken.** v6 §7.9 specified a new RPC `approve_booking_setup_trigger(p_oli_ids, p_tenant_id)` that read `pending_setup_trigger_args` for the given OLIs and emitted outbox events. But the TS call site (v6 §7.9 last paragraph) said: "`claim_deferred_setup_trigger_args` is NOT folded into the new RPC: ... the v6 change is additive". The v6 cutover left the existing claim flow in place — `bundle.service.ts:1452` calls `claim_deferred_setup_trigger_args(p_tenant_id, p_order_ids)` first (00198), which `for update`s the OLI rows and **NULLs `pending_setup_trigger_args` BEFORE returning**. Then v6 said TS should call the new RPC with `oliIds` from `claimedRows`. The new RPC re-reads `pending_setup_trigger_args` from those OLIs — and finds NULL on every row, because 00198 already cleared them. The `if v_oli.pending_setup_trigger_args is null then continue;` branch fires for every iteration; `v_emit_count` returns 0; no events land; the durability promise of v6-C4 is voided.

This bug is exactly the pattern the v7 architectural rule (§1, fourth half) calls out: TS orchestrating two separate RPCs to do "atomic" work. Two RPCs = two transactions = no atomicity, and in this specific case, the second RPC observes the *committed* state of the first and produces wrong output.

**v7 fix: retire the 00198 claim flow entirely. The new RPC reads + emits + clears in one transaction.** The TS approval path goes from "claim_deferred_setup_trigger_args + branch on result + triggerMany / audit" (~80 lines) to "call approve_booking_setup_trigger" (one line).

```sql
-- supabase/migrations/00305_approve_booking_setup_trigger_rpc.sql (REWRITTEN in v7)
-- supabase/migrations/00308_drop_claim_deferred_setup_args.sql (NEW in v7) drops the old function.

create or replace function public.approve_booking_setup_trigger(
  p_booking_id      uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_idempotency_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_oli            record;
  v_args           jsonb;
  v_emit_count     int := 0;
  v_skip_cancel    int := 0;
  v_skip_no_args   int := 0;
  v_event_payload  jsonb;
  v_lock_key       bigint;
begin
  if p_tenant_id is null then
    raise exception 'approve_booking_setup_trigger: p_tenant_id required';
  end if;
  if p_booking_id is null then
    raise exception 'approve_booking_setup_trigger: p_booking_id required';
  end if;

  -- ── 1. Per-grant advisory lock (v7-C1) — serialise concurrent grants on
  -- the same booking. Two approvers granting simultaneously across multiple
  -- API instances reach this lock; the second waits, then re-reads OLIs
  -- and finds pending_setup_trigger_args=NULL on every row (the first
  -- already cleared them) — emits zero, returns immediately. ────────────
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':approve_setup:' || p_booking_id::text, 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. Read + lock every OLI in this booking with non-null
  -- pending_setup_trigger_args. The `for update of oli` lock ensures that
  -- a concurrent cancel cascade can't race between our read and our update.
  -- (Note: the for-update is on order_line_items only, NOT on orders or
  -- bookings — the cancel cascade locks a different set, so we don't
  -- deadlock.) ──────────────────────────────────────────────────────────
  for v_oli in
    select oli.id, oli.order_id, oli.pending_setup_trigger_args,
           oli.fulfillment_status, oli.service_window_start_at, oli.booking_id
      from public.order_line_items oli
      join public.orders o on o.id = oli.order_id
     where o.booking_id = p_booking_id
       and o.tenant_id  = p_tenant_id
       and oli.tenant_id = p_tenant_id
     for update of oli
  loop
    -- Skip cancelled lines (race-guard equivalent of the TS code at
    -- bundle.service.ts:1550-1614 — but now in the same tx as the emit).
    if v_oli.fulfillment_status = 'cancelled' then
      v_skip_cancel := v_skip_cancel + 1;
      continue;
    end if;
    if v_oli.pending_setup_trigger_args is null then
      v_skip_no_args := v_skip_no_args + 1;
      continue;
    end if;
    v_args := v_oli.pending_setup_trigger_args;

    -- ── v8-I6: Emit-time ruleIds validation ──────────────────────────
    -- pending_setup_trigger_args.ruleIds was validated at plan time (§8.2,
    -- snapshot UUIDs in validate_attach_plan_internal_refs). But the value
    -- is then PERSISTED on order_line_items.pending_setup_trigger_args
    -- between plan time and approval grant. Admin tooling, a future bulk
    -- rule-rewrite migration, or a misbehaving cleanup job could mutate
    -- service_rules between plan-time and grant-time, leaving a stale or
    -- cross-tenant rule id baked into the persisted args. Validate here
    -- before the args land in an outbox event payload (which goes into
    -- audit_events on handle, where the bad id would persist forever).
    declare
      v_rule_ids uuid[];
    begin
      v_rule_ids := coalesce(
        (select array_agg(value::uuid)
           from jsonb_array_elements_text(coalesce(v_args->'ruleIds', '[]'::jsonb))),
        '{}'::uuid[]
      );
      if cardinality(v_rule_ids) > 0 then
        perform public.validate_rule_ids_in_tenant(p_tenant_id, v_rule_ids);
      end if;
    end;

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

    -- Clear the args ATOMICALLY in the same tx. v7 — no separate claim RPC
    -- means there's no "claimed but not emitted" intermediate state.
    update public.order_line_items
       set pending_setup_trigger_args = null
     where id = v_oli.id;

    v_emit_count := v_emit_count + 1;
  end loop;

  -- ── 3. Audit row in same tx for ops triage. Captures the per-grant
  -- counts so admins can spot misbehaviour (e.g. zero-emit on a grant
  -- that should have fired N events — likely a 00198-leftover bug
  -- recurring). ─────────────────────────────────────────────────────────
  insert into public.audit_events (
    tenant_id, event_type, entity_type, entity_id, details
  ) values (
    p_tenant_id,
    'booking.deferred_setup_emitted_on_approval',
    'booking',
    p_booking_id,
    jsonb_build_object(
      'actor_user_id',   p_actor_user_id,
      'idempotency_key', p_idempotency_key,
      'emitted',         v_emit_count,
      'skipped_cancel',  v_skip_cancel,
      'skipped_no_args', v_skip_no_args
    )
  );

  return jsonb_build_object(
    'emitted_count',      v_emit_count,
    'skipped_cancelled',  v_skip_cancel,
    'skipped_no_args',    v_skip_no_args
  );
end;
$$;

comment on function public.approve_booking_setup_trigger(uuid, uuid, uuid, text) is
  'Approval-grant emit path for setup_work_order.create_required (§7.9 of the outbox spec — v7 contract; v8 adds emit-time ruleIds validation via validate_rule_ids_in_tenant). Reads pending_setup_trigger_args for every OLI in the booking, validates persisted ruleIds against tenant service_rules (defense-in-depth against rule mutations between plan-time and grant-time), emits one outbox event per non-null OLI, clears the args — all in one transaction. Replaces the v6 (00198 claim + new RPC) two-step that broke because 00198 nulled the args before the new RPC could read them.';
```

#### 7.9.1 `validate_rule_ids_in_tenant` helper (NEW in v8 — folds I6)

Shared validator: every rule UUID in the input array MUST exist in `public.service_rules` under `p_tenant_id`. Raises `setup_wo.rule_id_invalid` on the first miss; the caller's tx rolls back, no outbox event is emitted, the audit_events row at the end of `approve_booking_setup_trigger` reflects the failure (it never lands because the tx rolls back — handled at the application layer through the absence of the row + the propagated exception).

```sql
-- supabase/migrations/00305_approve_booking_setup_trigger_rpc.sql (v8 addition)
-- (or split into a separate migration if 00305 is already applied to remote)

create or replace function public.validate_rule_ids_in_tenant(
  p_tenant_id uuid,
  p_rule_ids  uuid[]
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_missing uuid;
begin
  if p_rule_ids is null or cardinality(p_rule_ids) = 0 then
    return;
  end if;

  -- Find any id in the input that's NOT in service_rules under tenant.
  -- Single round-trip; planner picks an index scan on (tenant_id, id).
  with input_ids as (
    select unnest(p_rule_ids) as id
  )
  select i.id into v_missing
    from input_ids i
   where not exists (
     select 1 from public.service_rules sr
      where sr.id = i.id and sr.tenant_id = p_tenant_id
   )
   limit 1;

  if v_missing is not null then
    raise exception 'setup_wo.rule_id_invalid: % not in tenant service_rules', v_missing
      using errcode = '42501';
  end if;
end;
$$;

comment on function public.validate_rule_ids_in_tenant(uuid, uuid[]) is
  'Defense-in-depth helper for v8: validates a UUID[] of rule ids against tenant-scoped public.service_rules. Used by approve_booking_setup_trigger at emit time to catch stale or cross-tenant rule_ids that were persisted on order_line_items.pending_setup_trigger_args between plan time and grant time. Folds v8-I6 of the outbox spec.';
```

**v8 §15.5 test additions for v8-I6.** Pre-populate an OLI's `pending_setup_trigger_args.ruleIds` with `[<another-tenant's-rule-id>]`; call `approve_booking_setup_trigger`; assert the RPC raises `setup_wo.rule_id_invalid`; assert the OLI's pending_setup_trigger_args is STILL non-null (the rollback restored the args); assert no `outbox.events` row landed; assert no audit row for `booking.deferred_setup_emitted_on_approval` (the audit insert is in the same rolled-back tx).

This closes v7's open "verify with codex review" question on §15.5 — v8 commits to runtime validation as the right shape.

**Before (v6, broken):**

```typescript
// bundle.service.ts:1452-1527 (v6)
const { data: claimed } = await this.supabase.admin.rpc(
  'claim_deferred_setup_trigger_args',
  { p_tenant_id: tenantId, p_order_ids: orderIds },
);
//                          ↑ args are NULLed in this RPC's tx, BEFORE returning

const claimedRows = (claimed ?? []) as Array<{ oli_id; args: TriggerArgs | null }>;
const oliIds = claimedRows.map((r) => r.oli_id);

if (decision === 'approved') {
  await this.supabase.admin.rpc('approve_booking_setup_trigger', {
    p_oli_ids: oliIds,
    p_tenant_id: tenantId,
  });
  //                          ↑ RPC reads pending_setup_trigger_args from
  //                            each OLI — finds NULL because 00198 cleared
  //                            them in the previous tx. Emits ZERO events.
}
```

**After (v7):**

```typescript
// bundle.service.ts:1452-1527 (v7) — collapsed to one RPC call
if (decision === 'approved') {
  const { data, error } = await this.supabase.admin.rpc(
    'approve_booking_setup_trigger',
    {
      p_booking_id:      bundleId,                                       // = booking_id
      p_tenant_id:       tenantId,
      p_actor_user_id:   actorUserId,
      p_idempotency_key: `approval.setup:${bundleId}:${clientRequestId}`,
    },
  );
  if (error) throw error;
  // data = { emitted_count, skipped_cancelled, skipped_no_args }
}
```

**Cancel-race guard removal.** v6 left the TS-side cancel-race block at `bundle.service.ts:1550-1614` in place (closes setup WOs that landed for an OLI cancelled mid-grant). The v7 RPC subsumes it: the `for update of oli` lock + the `if v_oli.fulfillment_status = 'cancelled' then continue;` branch run *inside the tx that's clearing the args*, so a concurrent cancel cascade can't race the emit on a cancelled line. The TS-side block can be deleted in the cleanup commit (§16.1).

**Why drop 00198 entirely.** v6 said "leave 00198 in place; the new RPC is additive". That position is what produced C1. v7 takes the opposite position: 00198 has zero remaining callers after the cutover (`bundle.service.ts:1452` is the only one in the codebase per `git grep claim_deferred_setup_trigger_args` at v6), and a dormant function with a misleading name is worse than no function at all (someone reads the v6 spec, sees "leave it standalone", and uses it for a new flow — recreating the same bug). 00308 drops it. If a future migration wants the "atomic claim + null" primitive, the function can be re-added with a clearer name and a contract that doesn't conflict with the new approve RPC.

**Open follow-up (post-v7):** the `approve_booking_setup_trigger` RPC currently runs as a SEPARATE supabase-js call from `grant_booking_approval` (§10). v7 keeps them separate because `grant_booking_approval` has its own atomic responsibilities (CAS update + slot transition + bundle cascade) and cleanly emits the same outbox events from inside its body. Specifically, `grant_booking_approval` calls `approve_booking_setup_trigger` *internally* (via `perform`) so they DO commit in one tx. See §10 for the wiring; the standalone RPC stays available for any future caller that grants approvals via a non-`grant_booking_approval` path (e.g. admin batch tooling).

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

-- v8-I3: signature is `(p_tenant_id uuid, p_booking_input jsonb, p_attach_plan jsonb)`.
-- v7 added p_tenant_id implicitly in §8.2's snapshot-validation block but did
-- not update the function definition or the call site in §7.6. v8 makes both
-- consistent: the canonical signature is the three-arg form below; §7.6 step 4
-- calls it with `(p_tenant_id, p_booking_input, p_attach_plan)`.
create or replace function public.validate_attach_plan_internal_refs(
  p_tenant_id     uuid,
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

comment on function public.validate_attach_plan_internal_refs(uuid, jsonb, jsonb) is
  'Validates internal cross-references in the AttachPlan + BookingInput payloads. Runs alongside validate_attach_plan_tenant_fks before any insert in create_booking_with_attach_plan. v6-I2 (codex review of v5); v7 added snapshot UUID validation; v8 canonicalised the three-arg signature.';
```

**What §8.1 vs §8.2 each catch:**
- §8.1 catches a *cross-tenant* leak: a UUID that exists but in a different tenant (CLAUDE.md #0 invariant).
- §8.2 catches an *internally-inconsistent plan*: UUIDs that all exist in the right tenant but reference each other wrong (a buggy plan-builder, an attacker mutating the plan in transit between TS and the RPC, a future contributor who misunderstands the plan shape).

The two together close the failure modes a per-table FK constraint would not: PostgreSQL's `REFERENCES` clause checks existence, not tenant scope, and not plan-internal consistency. Both helpers are SECURITY INVOKER and run in the RPC's tx; failures roll back the marker insert with the rest of the work.

**Snapshot UUIDs are validated in v7 (folds I4).** v6 deliberately skipped cross-checking `applied_rule_ids[]`, `config_release_id`, `setup_emit.rule_ids[]`, and approval-reason `rule_id` against the rules tables, calling the value "low because those columns are write-once snapshots." Codex v6 review pushed back: the cost is small (one batched `IN` query per snapshot category — at most four extra round-trips per plan, all cacheable on warm tables), and the downside of letting a cross-tenant `rule_id` bake into an immutable audit trail is permanent. v7 extends `validate_attach_plan_internal_refs` to batch-validate every snapshot UUID against the appropriate tenant-scoped table:

```sql
-- supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql (v7 addition)
-- Append to validate_attach_plan_internal_refs body, after the existing checks.

  -- 7. Snapshot UUIDs (v7-I4) — applied_rule_ids[], config_release_id,
  -- setup_emit.rule_ids[], approval-reason rule_id. All four are
  -- references to per-tenant rule/config tables that admins write at
  -- configuration time. A buggy plan-builder or compromised input could
  -- smuggle a cross-tenant id into one of these snapshot fields; the
  -- audit trail then carries the wrong tenant's rule/config UUID
  -- forever. Cheap to validate; permanent if we don't.
  --
  -- Tables consulted:
  --   service_rules         (id, tenant_id) — applied_rule_ids[],
  --                                            setup_emit.rule_ids[],
  --                                            approvals[].scope_breakdown.reasons[].rule_id
  --   service_config_releases (id, tenant_id) — config_release_id

  -- 7a. booking_input.applied_rule_ids[]
  -- v8-I3: uses the canonical p_tenant_id parameter (the function takes
  -- (p_tenant_id, p_booking_input, p_attach_plan) — see top of §8.2). The
  -- v7 placeholder hack (`select tenant_id from public.bookings limit 0`)
  -- has been removed.
  with snap as (
    select distinct value::uuid as id
      from jsonb_array_elements_text(coalesce(p_booking_input->'applied_rule_ids', '[]'::jsonb))
  ), missing as (
    select s.id from snap s
     where not exists (
       select 1 from public.service_rules sr
        where sr.id = s.id and sr.tenant_id = p_tenant_id
     )
  )
  select id into v_bad from missing limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: applied_rule_ids[] % not in tenant service_rules', v_bad
      using errcode = '42501';
  end if;

  -- 7b. booking_input.config_release_id
  if p_booking_input->>'config_release_id' is not null
     and length(p_booking_input->>'config_release_id') > 0 then
    perform 1 from public.service_config_releases
     where id = (p_booking_input->>'config_release_id')::uuid
       and tenant_id = p_tenant_id;
    if not found then
      raise exception 'attach_plan.internal_refs: config_release_id not in tenant service_config_releases'
        using errcode = '42501';
    end if;
  end if;

  -- 7c. setup_emit.rule_ids[] across all OLIs
  with snap as (
    select distinct rule_id::uuid as id
      from jsonb_array_elements(p_attach_plan->'order_line_items') li,
           jsonb_array_elements_text(coalesce(li->'setup_emit'->'rule_ids', '[]'::jsonb)) rule_id
     where li->'setup_emit' is not null
  ), missing as (
    select s.id from snap s
     where not exists (
       select 1 from public.service_rules sr
        where sr.id = s.id and sr.tenant_id = p_tenant_id
     )
  )
  select id into v_bad from missing limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: setup_emit.rule_ids[] % not in tenant service_rules', v_bad
      using errcode = '42501';
  end if;

  -- 7d. approvals[].scope_breakdown.reasons[].rule_id across all approvals
  with snap as (
    select distinct (reason->>'rule_id')::uuid as id
      from jsonb_array_elements(p_attach_plan->'approvals') ap,
           jsonb_array_elements(coalesce(ap->'scope_breakdown'->'reasons', '[]'::jsonb)) reason
     where reason->>'rule_id' is not null
  ), missing as (
    select s.id from snap s
     where not exists (
       select 1 from public.service_rules sr
        where sr.id = s.id and sr.tenant_id = p_tenant_id
     )
  )
  select id into v_bad from missing limit 1;
  if v_bad is not null then
    raise exception 'attach_plan.internal_refs: approvals[].reasons[].rule_id % not in tenant service_rules', v_bad
      using errcode = '42501';
  end if;
```

**Implementation note (v8):** the canonical signature is `(p_tenant_id uuid, p_booking_input jsonb, p_attach_plan jsonb)`. v7 added `p_tenant_id` to the snapshot-validation block but neglected to update the function definition and the §7.6 call site, leaving a drift. v8 closes the drift: the function definition above takes the three-arg form; §7.6 step 4 calls it as `perform public.validate_attach_plan_internal_refs(p_tenant_id, p_booking_input, p_attach_plan);`.

**Tests added (Phase 6 scope, v7):** four integration tests, one per snapshot category. Each constructs a plan whose `applied_rule_ids[0]`, `config_release_id`, `setup_emit.rule_ids[0]`, or approval-reason `rule_id` is a valid UUID for a different tenant; assert `42501 attach_plan.internal_refs: <field> ... not in tenant service_rules` (or `service_config_releases` for category b).

**Why now (vs. defer to a future "shared template registry" world):** the failure mode of a cross-tenant `rule_id` baked into the audit trail is permanent — there is no easy backfill once the wrong UUID is in the audit row. The cost of validation is one round-trip per category on a warm cache (rules + config_releases tables are tiny per-tenant; planner picks an index scan; <1ms each). The asymmetry is decisive — validate now, never debug a cross-tenant audit-row leak in production.

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

## 10. Setup-WO is NOT best-effort — and approval-grant is now atomic too (v7 folds C2)

Per the user direction:

> "Don't call setup-WO 'best-effort' if missing it creates operational corruption. If a setup work order is required for a booking/service to be fulfilled, it belongs either inside the combined RPC or as a durable outbox event emitted from inside that RPC. 'Best-effort post-commit' is only acceptable for notifications, analytics, and non-critical side effects."

**Inside the RPC vs outbox event from RPC — the call:** outbox event from RPC.

Reasoning:
- The setup-WO creation logic in `SetupWorkOrderTriggerService.trigger` (setup-work-order-trigger.service.ts:46-143) is ~80 lines: routing matrix lookup via `resolve_setup_routing` RPC, lead-time math, ticket creation via `TicketService.createBookingOriginWorkOrder` (which itself spans 100+ lines of orchestration: SLA policy attachment, audit metadata, module number assignment, dispatch hooks). Porting that to PL/pgSQL is multi-week work and creates a second copy to keep in sync.
- Emitting the event atomically from the combined RPC gives full durability semantics: if the RPC commits, the event is durable; if the handler crashes, retry kicks in; if it dead-letters, audit + ops alert. That's the "either inside RPC or durable outbox event from RPC" condition the user direction allows.
- The cost of the outbox path: the WO is created ~100ms-1s after the booking commits (one drain cycle plus handler latency). For "internal setup work" specifically — not a customer-facing thing — that latency is invisible; the kitchen team's view of today's prep list refreshes on the order of minutes anyway.

### 10.1 Approval grant — `grant_booking_approval` RPC (NEW in v7 — folds C2)

**The v6 lie.** v6 §7.9 said: "Throws bubble to the approval-grant caller; the surrounding tx rolls back so the approval decision itself doesn't commit if the emit can't be made durable." That sentence assumed `ApprovalService.respond` ran inside a transaction that wraps the approval CAS update + the booking_slots transition + the bookings transition + the bundle cascade. It does not. Read `apps/api/src/modules/approval/approval.service.ts:359-487`:

- `approval.service.ts:390` — `supabase.admin.from('approvals').update({ status, ... }).eq('status', 'pending')` — HTTP call #1, its own tx, commits.
- `approval.service.ts:551` (inside `handleBookingApprovalDecided`) — `supabase.admin.from('booking_slots').update({ status: 'confirmed' })` — HTTP call #2, its own tx, commits.
- `approval.service.ts:570` — `supabase.admin.from('bookings').update({ status })` — HTTP call #3, its own tx, commits.
- `approval.service.ts:616` — `bundleService.onApprovalDecided(...)` — eventually calls `claim_deferred_setup_trigger_args` (HTTP call #4) and `approve_booking_setup_trigger` (HTTP call #5 — the v6 RPC, broken per §7.9).

Five separate transactions. There is nothing for the v6 "throws bubble + tx rolls back" claim to roll back. The only mechanism in `respond()` is the in-process `try/catch` at lines 418-422 + 443-445 + 480-484, all of which `console.error()` and then return — they specifically do NOT re-throw, so even at the application layer the failure is suppressed. The approval row has been UPDATED to `approved` regardless of whether the slot transition, booking transition, or setup-WO emit succeeded.

**v7 fix: introduce `grant_booking_approval` RPC. One transaction for the approval CAS + slot/booking transitions + setup-WO emit.** Notification fan-out + visitor-invite dispatch + ticket dispatch stay in TS, fired AFTER the RPC commits — those are genuinely best-effort by design (a notification failure shouldn't roll the approval back; the user already saw the success in their queue).

```sql
-- supabase/migrations/00307_grant_booking_approval_rpc.sql (NEW in v7)

create or replace function public.grant_booking_approval(
  p_approval_id     uuid,
  p_tenant_id       uuid,
  p_actor_user_id   uuid,
  p_decision        text,             -- 'approved' | 'rejected'
  p_comments        text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security invoker
set search_path = public, outbox
as $$
declare
  v_approval         record;
  v_lock_key         bigint;
  v_target_id        uuid;
  v_new_status       text;             -- 'confirmed' | 'cancelled'
  v_resolved         boolean;
  v_pending_count    int;
  v_unresolved_count int;
  v_slot_count       int;
  v_booking_changed  boolean := false;
  v_emit_summary     jsonb;
  v_result           jsonb;
begin
  if p_tenant_id is null then
    raise exception 'grant_booking_approval: p_tenant_id required';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'grant_booking_approval: p_decision must be approved or rejected';
  end if;

  -- ── 1. Per-approval advisory lock — serialise concurrent grants on the
  -- SAME approval row. (Concurrent grants on DIFFERENT approval rows for
  -- the same booking serialize on the booking-level advisory lock taken
  -- below.) ────────────────────────────────────────────────────────────
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':approval:' || p_approval_id::text, 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 2. Lock + read FIRST (v8-I2) — order matters. v7 ran the CAS update
  -- before checking target_entity_type, so a mistaken caller (passing a
  -- ticket or visitor_invite approval id) would mark the row as `approved`
  -- before the rejection. v8 reorders: select + FOR UPDATE first, validate
  -- the row's target_entity_type, validate the state machine (status =
  -- 'pending'), THEN apply the CAS update. The advisory lock above already
  -- serialises concurrent grants on the SAME row; the FOR UPDATE here gives
  -- us a full row to read and validate before any mutation. ─────────────
  select id, target_entity_type, target_entity_id, parallel_group, approval_chain_id, comments, status
    into v_approval
    from public.approvals
   where id        = p_approval_id
     and tenant_id = p_tenant_id
   for update;

  if not found then
    raise exception 'approval.not_found id=% tenant=%', p_approval_id, p_tenant_id
      using errcode = 'P0002';
  end if;

  -- Validate target_entity_type BEFORE any mutation. Bail out cleanly for
  -- non-booking branches; the caller (ApprovalService.respond) routes those
  -- through the existing TS-orchestrated paths (§11 open question 8). ───
  if v_approval.target_entity_type <> 'booking' then
    return jsonb_build_object(
      'kind',                'non_booking_approved',
      'approval_id',         p_approval_id,
      'target_entity_type',  v_approval.target_entity_type
    );
  end if;

  -- Validate state machine. If already responded (idempotent retry by the
  -- same caller, or a different caller's decision committed between the
  -- TS-side .single() read and this RPC), return cleanly. ────────────────
  if v_approval.status <> 'pending' then
    return jsonb_build_object(
      'kind',         'already_responded',
      'approval_id',  p_approval_id,
      'prior_status', v_approval.status
    );
  end if;

  -- ── 3. NOW apply the CAS update. The advisory lock + FOR UPDATE above
  -- mean no concurrent grant can interleave between the validation and the
  -- mutation, so the CAS guard is defensive (we expect it to always
  -- succeed); a `not found` here would be a bug, not a race. ─────────────
  update public.approvals
     set status        = p_decision,
         responded_at  = now(),
         comments      = p_comments
   where id            = p_approval_id
     and tenant_id     = p_tenant_id
     and status        = 'pending';

  if not found then
    raise exception 'approval.cas_lost id=%', p_approval_id
      using errcode = 'P0001',
            hint = 'CAS update missed despite advisory lock + FOR UPDATE — investigate concurrent path';
  end if;

  v_target_id := v_approval.target_entity_id;

  -- ── 4. Take a per-booking advisory lock so concurrent approvers grant
  -- in series at the booking level (slot transitions + bundle cascade
  -- don't race). ─────────────────────────────────────────────────────────
  v_lock_key := hashtextextended(
    p_tenant_id::text || ':booking_approval:' || v_target_id::text, 0
  );
  perform pg_advisory_xact_lock(v_lock_key);

  -- ── 5. Resolve the booking-level decision using v_approval.status as
  -- the just-committed gate (same logic as
  -- ApprovalService.areAllTargetApprovalsApproved at approval.service.ts:645). ─
  if p_decision = 'rejected' then
    v_resolved := true;
    v_new_status := 'cancelled';

    -- Expire sibling pending approvals to keep approver queues clean
    -- (mirrors bundle.service.ts:1428-1444). Same tx — no race.
    update public.approvals
       set status        = 'expired',
           responded_at  = now(),
           comments      = 'Sibling approval rejected; bundle no longer needs approval.'
     where tenant_id        = p_tenant_id
       and target_entity_id = v_target_id
       and status           = 'pending';
  else
    -- p_decision = 'approved'. Check if every other approval row on this
    -- booking is also approved/expired. If not, this RPC just CASed one
    -- row to approved; the next sibling's grant will re-enter and resolve.
    select count(*) filter (where status in ('pending', 'rejected'))
      into v_unresolved_count
      from public.approvals
     where tenant_id        = p_tenant_id
       and target_entity_id = v_target_id;
    if v_unresolved_count > 0 then
      return jsonb_build_object(
        'kind', 'partial_approved',
        'approval_id', p_approval_id,
        'remaining', v_unresolved_count
      );
    end if;
    v_resolved := true;
    v_new_status := 'confirmed';
  end if;

  -- ── 6. Transition booking_slots + bookings (mirrors
  -- approval.service.ts:551-579). All in same tx now. ────────────────────
  update public.booking_slots
     set status = v_new_status,
         cancellation_grace_until = case when v_new_status = 'cancelled' then null
                                         else cancellation_grace_until end
   where booking_id = v_target_id
     and tenant_id  = p_tenant_id
     and status     = 'pending_approval';
  get diagnostics v_slot_count = row_count;

  update public.bookings
     set status = v_new_status
   where id        = v_target_id
     and tenant_id = p_tenant_id
     and status    = 'pending_approval';
  get diagnostics v_pending_count = row_count;
  v_booking_changed := v_pending_count > 0;

  -- ── 7. Setup-WO emit on approval. Inline the §7.9 logic via perform —
  -- one tx, no separate RPC round trip. The standalone
  -- approve_booking_setup_trigger RPC stays callable for admin/batch tooling. ─
  if v_new_status = 'confirmed' then
    v_emit_summary := public.approve_booking_setup_trigger(
      v_target_id, p_tenant_id, p_actor_user_id, p_idempotency_key
    );
  else
    -- Cancellation path — clear pending_setup_trigger_args without emitting.
    update public.order_line_items oli
       set pending_setup_trigger_args = null
      from public.orders o
     where o.id = oli.order_id
       and o.booking_id = v_target_id
       and oli.tenant_id = p_tenant_id
       and oli.pending_setup_trigger_args is not null;
    v_emit_summary := jsonb_build_object('emitted_count', 0, 'reason', 'rejected');
  end if;

  -- ── 8. Domain event for the approval decision (mirrors
  -- ApprovalService.logDomainEvent at approval.service.ts:707). ──────────
  insert into public.domain_events (
    tenant_id, event_type, entity_type, entity_id, payload
  ) values (
    p_tenant_id,
    'approval_' || p_decision,
    'approval',
    v_target_id,
    jsonb_build_object(
      'approval_id',  p_approval_id,
      'responded_by', p_actor_user_id,
      'idempotency_key', p_idempotency_key
    )
  );

  v_result := jsonb_build_object(
    'kind',                'resolved',
    'approval_id',         p_approval_id,
    'booking_id',          v_target_id,
    'final_decision',      p_decision,
    'new_status',          v_new_status,
    'slots_transitioned',  v_slot_count,
    'booking_transitioned', v_booking_changed,
    'setup_emit',          v_emit_summary
  );

  return v_result;
end;
$$;

comment on function public.grant_booking_approval(uuid, uuid, uuid, text, text, text) is
  'Atomic approval grant for booking targets. CAS update on approvals + transition booking_slots + bookings + emit setup_work_order outbox events (or clear args on rejection) — all in one transaction. Folds v7-C2 of the outbox spec. The RPC also expires sibling pending approvals on rejection (mirroring bundle.service.ts:1428-1444). Notifications + visitor-invite + ticket dispatch are NOT in this RPC — they stay in TS, fired post-RPC, because they are genuinely best-effort.';
```

**TS-side cutover.** `ApprovalService.respond` becomes a planner/dispatcher:

```typescript
// apps/api/src/modules/approval/approval.service.ts (v7 cutover)

async respond(
  approvalId: string,
  dto: RespondDto,
  respondingPersonId: string,
  respondingUserId?: string,
  clientRequestId?: string,         // NEW: passed from controller (req.clientRequestId)
) {
  const tenant = TenantContext.current();

  // 1. Auth gate — unchanged from today (callerCanRespond etc.).
  const { data: approval } = await this.supabase.admin
    .from('approvals').select('*').eq('id', approvalId)
    .eq('tenant_id', tenant.id).single();
  if (!approval) throw new NotFoundException('Approval not found');
  if (approval.status !== 'pending') throw new BadRequestException('Approval already responded to');
  const allowed = await this.callerCanRespond(approval, respondingPersonId, respondingUserId);
  if (!allowed) throw new ForbiddenException('You are not an approver for this request');

  // 2. Booking branch: atomic RPC.
  if (approval.target_entity_type === 'booking') {
    const { data: result, error } = await this.supabase.admin.rpc('grant_booking_approval', {
      p_approval_id:     approvalId,
      p_tenant_id:       tenant.id,
      p_actor_user_id:   respondingUserId ?? null,
      p_decision:        dto.status,
      p_comments:        dto.comments ?? null,
      p_idempotency_key: `approval.grant:${approvalId}:${clientRequestId ?? randomUUID()}`,
    });
    if (error) throw error;

    // 3. Post-RPC, best-effort: notification fan-out (the requester email,
    //    via BookingNotificationsService.onApprovalDecided). Failure here
    //    does NOT roll back the grant — the approval is committed; the user
    //    sees it as decided in their queue. Logged for ops triage.
    try {
      // ... existing fan-out logic, unchanged from approval.service.ts:592-610 ...
    } catch (err) {
      console.error('[approval] booking notification fan-out failed', err);
    }

    return result;
  }

  // 3. Other target_entity_types (ticket / visitor_invite) — unchanged
  //    flow from approval.service.ts:418-485. No atomic RPC needed because
  //    those downstream effects don't have a slot/booking-level state
  //    transition to coordinate atomically.
  // ...
}
```

**Notifications stay in TS — explicitly.** The booking notification fan-out (`BookingNotificationsService.onApprovalDecided`) sends an email, which is a vendor call that can take 100ms-2s and can fail for vendor-side reasons (Resend rate limit, email-service outage). Including it in the RPC's tx would (a) hold the booking-level advisory lock for the duration of an external network call (catastrophic for tenants with concurrent grants), (b) couple Postgres availability to vendor availability, and (c) make rollback semantics user-hostile (the user clicked "Approve", saw the spinner, the email server was slow, the RPC timed out, the approval rolled back, the user clicks again and gets "already responded" — exactly the failure mode the §1 fourth half rule is supposed to avoid). Notifications are genuinely post-commit best-effort; the approval *decision* is not.

**v7 recommendation: pick Option A (atomic RPC) over Option B (best-effort post-commit + retry).** Reasoning:
- Option B (drop the rollback claim, document approval as best-effort) was workable when there were 1-2 split writes and the failure mode was "approval row updated but no setup WO emitted" (recoverable: admin re-approves; still ugly but tractable). With v7's full picture (slot transition + booking transition + bundle cascade + setup-WO emit), Option B's failure surface is "approval `approved`, slot still `pending_approval`, booking still `pending_approval`, no setup WO" — that's a four-way state divergence that no admin tooling can clean up reliably.
- Option A's complexity is bounded: one RPC, ~150 lines of PL/pgSQL, all the existing logic preserved. The cost of NOT doing Option A is operational corruption that surfaces weeks later when fulfillment teams discover bookings stuck in `pending_approval` with `approvals.status='approved'`.
- The only meaningful pushback against Option A — "what if a future approval-target-type needs different semantics?" — is handled by keeping `target_entity_type='booking'` as the only branch that goes through the atomic RPC. Ticket and visitor-invite stay in their existing TS-orchestrated paths because their downstream effects are individually atomic per-row.

### 10.2 What changes vs today's best-effort (v7 — covering create + approval-grant + handler paths)

| Today | v7 (atomic everywhere) |
|---|---|
| Create path: `bundle.service.ts:456` — `triggerMany` post-commit (best-effort fire-and-forget) | Durable retry with backoff via outbox event emitted inside `create_booking_with_attach_plan` (§7.6 step 12) |
| Approval path: `bundle.service.ts:1452` — claim RPC + `bundle.service.ts:1527` — `triggerMany` (best-effort fire-and-forget; **v6 left this broken — §7.9 explanation**) | Durable + atomic: `grant_booking_approval` RPC — CAS + slot/booking transitions + setup-WO emit, all in one tx (§10.1) |
| WO create from outbox event: `triggerStrict` HTTP call + dedup `INSERT` HTTP call (separate txs; v6 acknowledged the gap) | Atomic: `create_setup_work_order_from_event` RPC — WO INSERT + dedup INSERT + audit/event rows, all in one tx (§7.8) |
| Approval CAS + slot transition + booking transition: 3 separate supabase-js calls in `approval.service.ts:390-579` | One `grant_booking_approval` RPC; the v6 "rollback" claim is now true because there's an actual tx to roll back |
| Failure logs + audits at `severity: 'high'` and stops | Failure logs + audits, retry up to 5 times, then dead-letter |
| Node process crash mid-grant = approval row half-committed (varies by which HTTP call had committed) | Atomic — either the whole grant commits (slot + booking + emit) or none of it does |
| Tenant misconfigured (no team in matrix) = audit + manual recovery | Same audit; handler row-builder returns `kind: 'no_op_terminal'` and event is processed (admin reconfig + replay creates WO) |
| Transient DB errors silently swallowed by `trigger`'s outer try/catch — handler thinks "terminal", marks event processed, WO permanently lost | Row-builder + create RPC re-throw transient errors → outbox retries with backoff |
| Idempotency: relies on `pending_setup_trigger_args` claim RPC for the deferred-on-approval case only; create path has no dedup | Idempotent on `(tenant_id, oli_id)` via `setup_work_order_emissions` table (§2.5 / §9.2) — survives WO close + replay |
| Approval idempotency: none (a duplicate POST `respond` can land twice between the read-check and the CAS update if request hashes differ) | Idempotent on `(approval_id, client_request_id)` — `grant_booking_approval` returns `kind: 'already_responded'` for second-call shape |

**During Phase A:** both paths run — old best-effort + new shadow handler. The shadow handler writes `outbox_shadow_results`; the old best-effort path actually creates the WO. The gate query in §5.2 confirms they agree before flipping in Phase B.

**Phase B cutover scope (v7 — three paths cut over together):**
- `bundle.service.ts:456` — remove `triggerMany` call (create path); the outbox emission inside `create_booking_with_attach_plan` becomes the only path.
- `bundle.service.ts:1370-1642` — DELETE the entire `onApprovalDecided` method (claim RPC + branch + triggerMany + cancel-race-guard). Notification fan-out moves to `ApprovalService.respond` directly; the rest is subsumed by `grant_booking_approval` (§10.1).
- `approval.service.ts:359-487` — `respond` becomes a planner/dispatcher (§10.1 cutover code); booking branch goes through `grant_booking_approval` RPC; ticket/visitor_invite branches keep their existing TS-orchestrated paths.
- `apps/api/src/modules/outbox/handlers/setup-work-order.handler.ts` — handler calls `create_setup_work_order_from_event` RPC instead of `triggerStrict + insert`.

After Phase B, `SetupWorkOrderTriggerService.trigger`, `triggerMany`, and `triggerStrict` all have no production callers. Deleted in the §16.1 cleanup commit.

**Recovery from old orphans:** if any bookings exist in production with services that should have triggered setup-WOs but didn't (because the old best-effort path failed silently — it does happen; we have audit rows from past incidents), Phase B doesn't automatically backfill them. Backfill is a separate operation: a script that reads `audit_events` for `bundle.setup_work_order_create_failed` and re-emits the events through the outbox. Documented separately; out of v5/v6 spec scope.

---

## 10X. Not in B.0 scope — Phase 6 hardening backlog (NEW in v8)

The following split-writes EXIST in the codebase but are NOT addressed by B.0. They are deferred to a Phase 6 hardening sprint that runs AFTER B.0 lands. Codex v7 review acknowledged they're deferrable IF B.0 scope is "create + approval + setup-WO only"; v8 makes that scope-boundary explicit so the B.0 implementer doesn't pull them into scope mid-implementation. Deferral justification: **bounded failure mode + multi-week cost to fix**.

### 10X.1 Booking cancellation cascade

- **File:** `apps/api/src/modules/booking-bundles/bundle-cascade.service.ts:115` (`cancelLine` / `cancelBundle`).
- **Pattern:** cascading updates across `asset_reservations`, `work_orders`, `order_line_items`, `approvals` via separate supabase-js HTTP calls.
- **Failure mode:** partial-cancel — lines cancelled but approval still `pending`, or WOs cancelled but a sibling reservation still `confirmed`. Bounded: admin tooling can re-run.
- **Phase 6 plan:** `cancel_booking_atomic` RPC mirroring §10.1 with a per-booking advisory lock. Owner: TBD.

### 10X.2 Standalone-order creation

- **File:** `apps/api/src/modules/orders/order.service.ts:752` (`createStandalone` — `/portal/order` flow).
- **Pattern:** multi-step TS write for orders+OLIs+asset_reservations+approvals when there's no attached booking. Same class as the v4-pre booking attach split-write.
- **Failure mode:** half-created standalone order. Bounded: admin re-creation.
- **Phase 6 plan:** `create_standalone_order_with_attach_plan` RPC mirroring v5's combined-RPC pattern, with a `kind: 'standalone'` discriminator. Owner: TBD.

### 10X.3 Other known split-writes — same deferral

`TicketService.dispatch`, `VisitorPassService.assignFromPool`, recurrence-clone paths. All bounded failure modes; all out of B.0 scope. The Phase 6 hardening sprint applies the v5-onward "TS plans / PL/pgSQL writes" pattern to every multi-step write in the codebase — multi-month project, follows §1.

**B.0 scope-boundary contract:** B.0 implements create-booking-with-services + approval-grant + setup-WO-from-event. B.0 does NOT touch cancellation, standalone-order creation, dispatch, visitor-pass assignment, or recurrence cloning. PRs claiming to be "B.0" that touch those paths are out of scope.

---

## 11. Open questions remaining (post-v7; updated for v8)

Not blocking implementation; revisit during Phase 6 hardening or earlier if prod signals demand.

1. **Per-tenant fairness** (still open) — sharded per-tenant worker vs today's FIFO drain. The optional `idx_outbox_events_per_tenant_pending` index supports it. Defer until a noisy-neighbor incident or a tenant >100x median emit rate.
2. **Cross-region replication** (still open) — probably "worker in primary DB region; cross-region events catch up in seconds." Confirm before we ship a multi-region tenant.
3. **Webhook delivery via outbox** (still open) — likely yes with a dedicated `webhook.deliver_required` event type; revisit in the webhook hardening sprint.
4. **`outbox_emit_via_rpc` PostgREST wrapper kept or dropped** (still open; v7 doesn't need it for the booking path because the combined RPC + `grant_booking_approval` + `approve_booking_setup_trigger` + `create_setup_work_order_from_event` all emit via direct `outbox.emit()` calls inside their bodies). Re-evaluate once we have ≥2 TS-side `emit` call sites in production. Currently zero in steady state — the `OutboxService.emit()` fire-and-forget path is the only TS caller and could go through `outbox_emit_via_rpc` or a future direct-table path. Keep for now (cheap to maintain, low coupling).
5. **`outbox_shadow_results` retention** (still open) — needs a daily purge job; fold into the GDPR retention catalog when Phase B lands.
6. **Standalone-order path migration** (still open) — `OrderService.createStandaloneOrder` (the `/portal/order` flow with no booking) writes orders + OLIs + asset_reservations + approvals via supabase-js sequence (not yet ported). Same architectural concerns as the booking path; should be a separate `create_standalone_order_with_attach_plan` RPC in a follow-up slice. The existing `ApprovalRoutingService.assemble` (write-side) stays for that caller.
7. **Standalone-order approval grants need their own atomic RPC** (NEW open in v7) — `grant_booking_approval` (§10.1) covers `target_entity_type='booking'`. A future `OrderService.createStandaloneOrder` migration introduces `target_entity_type='standalone_order'` (or whatever post-canonicalisation calls it) and the approval-grant flow for that target type would have its own slot/booking-equivalent transitions. v7 leaves the standalone-order approval flow on the existing TS-orchestrated path because (a) standalone orders don't have booking_slots; (b) the transition surface is smaller (just `orders.status`); (c) the approval volume is lower than booking approvals. If it ever becomes a hotspot, mirror the v7 pattern with a dedicated `grant_standalone_order_approval` RPC.
8. **Ticket and visitor_invite approval branches** (NEW open in v7) — §10.1's `grant_booking_approval` covers booking approvals only. The ticket branch (`approval.service.ts:417-422`) and visitor_invite branch (`approval.service.ts:460-485`) keep their existing TS-orchestrated paths. Justification: the ticket dispatch is genuinely best-effort (an SLA-policy attachment failure shouldn't roll back the approval — the ticket is queued either way); visitor_invite has its own internal outbox emit (`visitor.invitation.expected`) that's already atomic on the visitors-side. Revisit if either becomes a corruption hotspot.
9. **Atomic snapshot UUID validation: shared rule registry implications** (NEW open in v7) — v7 §8.2 mandates that `applied_rule_ids[]`, `config_release_id`, `setup_emit.rule_ids[]`, and approval-reason `rule_id` are validated against tenant-scoped tables. If a future feature introduces a "shared rule registry" (cross-tenant rule definitions, e.g. industry-standard FIC allergen rules), the validation needs an explicit bypass for those rule rows. Document the bypass clearly when it's needed; don't silently relax the helper.
10. **`grant_booking_approval` parallel-group atomicity** (NEW open in v7) — the v7 RPC handles single-step + parallel-group + sequential-chain via the `v_unresolved_count` check at §10.1 step 5. Tested per `15.6` integration test (parallel group → first grant returns `partial_approved`; final grant returns `resolved`). Edge case: a parallel group with ≥3 approvers where the third grant lands while the second is still emitting setup-WOs. The advisory lock at §10.1 step 4 (`booking_approval:` keyed) serializes them, but the third grant's `v_unresolved_count` query needs to read AFTER the second's commit — verify the lock ordering is correct in tests. (Current design: yes; the second's CAS update + sibling-expire + slot transition happen before lock release; the third blocks at the advisory lock and reads committed state.)
11. **Real-DB concurrency test harness** (NEW open in v8) — the cutover-blocking concurrency tests in §15.5-bis require a real Postgres harness (pgTAP or two-connection `pg.Pool` in jest/vitest) that does not exist today in `apps/api/test/` or `supabase/tests/`. Building the harness is a B.0 → cutover prerequisite (NOT a B.0 foundation prerequisite). Status as of v8: not started. Owner: TBD — likely the engineer who lands the cutover commit, since the harness blocks Phase B in §5.1. Track in §16.2 as an explicit cutover gate distinct from the foundation gate.

**Resolved by v8 (codex review of v7):**

- ~~v7 C1 (setup-WO RPC trusted `p_wo_row_data` identity instead of deriving from event chain + chain validation)~~ — RPC now loads `outbox.events` row, derives `v_oli_id` from `aggregate_id`, validates OLI→order→booking chain under tenant, cross-checks row JSON, validates every tenant-owned FK via `validate_setup_wo_fks`. §7.8.2.
- ~~v7 I1 (X-Client-Request-Id auto-stamp at fetch scope lost stability across React Query retries)~~ — moved id generation to mutation-attempt scope; `apiFetch` no longer auto-stamps; producer hooks accept `requestId` in their variables shape and thread it as the header. §3.3.
- ~~v7 I2 (`grant_booking_approval` mutated approval row before checking target_entity_type)~~ — reordered: lock + read + validate target_entity_type + validate state machine FIRST, CAS update LAST. §10.1.
- ~~v7 I3 (signature drift on `validate_attach_plan_internal_refs` between §7.6 and §8.2)~~ — canonical signature `(p_tenant_id, p_booking_input, p_attach_plan)`; both sites aligned. §7.6 + §8.2.
- ~~v7 I4 (`setup_work_order_emissions.work_order_id` ON DELETE CASCADE allowed replay-after-delete to recreate)~~ — FK changed to ON DELETE SET NULL; tombstone semantics; admin runbook for explicit reset. §2.5.
- ~~v7 I5 (canonical OLI sort used `_input_position` tie-breaker, contradicted shuffled-input invariant)~~ — `client_line_id` now required on every input line; canonical sort uses fully-immutable, caller-provided fields per row-kind. §7.4.
- ~~v7 I6 (`approve_booking_setup_trigger` emitted persisted ruleIds without runtime tenant validation)~~ — `validate_rule_ids_in_tenant` helper called inside the emit loop; raises `setup_wo.rule_id_invalid` on cross-tenant id; whole tx rolls back. §7.9.1.
- ~~v7 N1 (§15.5 mocked race tests can't simulate real Postgres advisory-lock acquisition)~~ — §15.5-bis introduces a real-DB two-connection harness; cutover-blocking tests routed through it; harness shipping tracked as §11 open question 11.

**Resolved by v7 (codex review of v6):**

- ~~v6 C1 (`approve_booking_setup_trigger` consumed `claimedRows` from 00198 — args already nulled, zero events emitted)~~ — old claim flow retired; new RPC takes `p_booking_id` and reads + emits + clears in one tx, §7.9.
- ~~v6 C2 (approval grant claimed atomic rollback but ran across 5 separate supabase-js HTTP calls)~~ — `grant_booking_approval` RPC consolidates approval CAS + slot/booking transitions + setup-WO emit, §10.1.
- ~~v6 C3 (setup-WO handler created WO in one tx + dedup row in another)~~ — `create_setup_work_order_from_event` RPC inserts WO + dedup atomically, §7.8.
- ~~v6 I1 (caller iteration order leaked into plan UUID hash; unstable across retries)~~ — canonical-sort discipline in `planSort`, §7.4.
- ~~v6 I2 (`X-Client-Request-Id` mechanism referenced but unimplemented)~~ — `apiFetch` auto-stamps; middleware exposes `request.clientRequestId`; producers thread it as idempotency_key, §3.3.
- ~~v6 I3 (`setup_work_order_emissions.work_order_id` FK pointed at `tickets(id)` — would 23503 on first INSERT)~~ — FK now references `work_orders(id)`, §2.5.
- ~~v6 I4 (snapshot UUIDs unvalidated; cross-tenant `rule_id` could bake into audit trail forever)~~ — extended `validate_attach_plan_internal_refs` to batch-validate against tenant-scoped tables, §8.2.
- ~~v6 N1 (§5.1 Phase C reference to `attach_operations.outcome='failed'` was stale)~~ — replaced with `payload_mismatch` count + dead-letter rate, §5.1.
- ~~v6 N2 (CI grep guard was prose-only)~~ — actual GitHub Actions step shipped, §16.1.

**Resolved by v6 (codex review of v5):**

- ~~v5 C1 (random UUIDs defeat operation idempotency)~~ — deterministic uuidv5 from `(idempotency_key, row_kind, stable_index)`, §7.4.
- ~~v5 C2 (FOR UPDATE doesn't see uncommitted rows; concurrent retries get 23505)~~ — `pg_advisory_xact_lock` at top of RPC, §7.3.
- ~~v5 C3 (handler called best-effort `trigger`; transient errors swallowed)~~ — `triggerStrict` with typed terminal outcomes + thrown transients, §7.7 (now retired in v7 in favour of `SetupWorkOrderRowBuilder` + atomic RPC).
- ~~v5 C4 (approval-grant path bypassed outbox via direct `triggerMany`)~~ — `approve_booking_setup_trigger` RPC, §7.9 (signature rewritten in v7).
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
- `supabase/migrations/00303_create_booking_with_attach_plan_rpc.sql` — `create_booking_with_attach_plan` RPC + `validate_attach_plan_tenant_fks` helper (§7.6 + §8.1) + `validate_attach_plan_internal_refs` helper (§8.2). **NEW in v5; v6 adds advisory lock + internal-refs helper; v7 extends internal-refs with snapshot UUID validation (signature gains `p_tenant_id`)**.
- `supabase/migrations/00304_setup_work_order_emissions.sql` — `setup_work_order_emissions` dedup table (§2.5). **NEW in v6; v7 fixes FK to `work_orders` (was `tickets`)**.
- `supabase/migrations/00305_approve_booking_setup_trigger_rpc.sql` — `approve_booking_setup_trigger` RPC (§7.9). **NEW in v6; v7 REWRITES the signature to `(p_booking_id, p_tenant_id, p_actor_user_id, p_idempotency_key)` and reads `pending_setup_trigger_args` directly (no claim RPC dependency)**.
- `supabase/migrations/00306_create_setup_work_order_from_event_rpc.sql` — `create_setup_work_order_from_event` RPC (§7.8.2 in v8) + `validate_setup_wo_fks` helper (§7.8.2 in v8). **NEW in v7; v8 supersedes the body to load `outbox.events` row and derive identity from chain (folds C1).**
- `supabase/migrations/00307_grant_booking_approval_rpc.sql` — `grant_booking_approval` RPC (§10.1). **NEW in v7; v8 reorders body to lock + validate before CAS update (folds I2).**
- `supabase/migrations/00308_drop_claim_deferred_setup_args.sql` — drops `claim_deferred_setup_trigger_args` (00198). **NEW in v7**.
- `supabase/migrations/00309_validate_rule_ids_in_tenant_helper.sql` — `validate_rule_ids_in_tenant` helper called by `approve_booking_setup_trigger` at emit time (§7.9.1). **NEW in v8 (folds I6)**. Could equivalently be appended to 00305 if 00305 has not yet shipped to remote; if 00305 is already applied, ship as 00309.
- `supabase/migrations/00310_setup_work_order_emissions_fk_set_null.sql` — alters `setup_work_order_emissions.work_order_id` FK from ON DELETE CASCADE (v7) to ON DELETE SET NULL (v8). Required if 00304 already shipped to remote with the v7 contract; if 00304 has not yet shipped, fold the change directly into 00304 instead. **NEW in v8 (folds I4)**.

### TypeScript
- `apps/api/src/modules/outbox/outbox.service.ts` — fire-and-forget producer only. **v6 cleanup:** strip `markConsumed` method (lines 67-82) + `booking.create_attempted` references in the module-level docstring (lines 18-21).
- `apps/api/src/modules/outbox/outbox.worker.ts` — drain loop with the §4.2 state machine.
- `apps/api/src/modules/outbox/outbox-handler.registry.ts` — decorator-driven registry.
- `apps/api/src/modules/outbox/outbox-handler.decorator.ts` — `@OutboxHandler(eventType, { version })`.
- `apps/api/src/modules/outbox/dead-letter.error.ts` — `DeadLetterError` sentinel.
- `apps/api/src/modules/outbox/handlers/setup-work-order.handler.ts` — the setup-WO handler (§7.8). **NEW in v5; v6 swaps WO-row dedup for `setup_work_order_emissions` table; v7 calls `create_setup_work_order_from_event` RPC + uses `SetupWorkOrderRowBuilder` (replaces `triggerStrict`)**.
- `apps/api/src/modules/booking-bundles/plan-uuid.ts` — `planUuid()` deterministic uuidv5 helper + **v7: `planSort` canonical-sort comparators** (§7.4). **NEW in v6; v7 extends**.
- `apps/api/src/modules/service-routing/setup-work-order-row-builder.service.ts` — `SetupWorkOrderRowBuilder.build` (§7.7). **NEW in v7**. Replaces v6 `triggerStrict`.
- `apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts` — legacy `trigger`/`triggerMany`/`triggerStrict` deleted in the §16.1 cleanup commit; file may stay for shared types if anything is still referenced externally.
- `apps/api/src/modules/booking-bundles/bundle.service.ts` — `attachServicesToBooking` becomes:
  - `buildAttachPlan(args)` — pure preflight; returns `AttachPlan` (§7.4). Uses `planUuid()` for every UUID. **v7: applies canonical sorts before assigning `stableIndex`.**
  - The combined-RPC call site moves into `BookingFlowService.create` (§file below).
  - The `Cleanup` class (bundle.service.ts:1878-1972) is **deleted** — no longer needed because every insert is inside the combined RPC's transaction; rollback is automatic.
  - `onApprovalDecided` (lines 1370-1642) is **deleted in v7** — its responsibilities (claim args + branch + triggerMany + cancel-race-guard) are subsumed by `grant_booking_approval`. Notification fan-out moves into `ApprovalService.respond` directly. (See §16.2 step 18.)
- `apps/api/src/modules/orders/approval-routing.service.ts` — gains a `assemblePlan(args)` method that returns the same shape as `assemble(args)` but does NOT write to `approvals` (the RPC does). v6: `assemblePlan` takes `idempotencyKey` and uses `planUuid()` for approval ids. `assemble` itself stays for the standalone-order path (§11 future work).
- `apps/api/src/modules/approval/approval.service.ts` — `respond()` becomes a planner/dispatcher. **v7:** booking branch goes through `grant_booking_approval` RPC; ticket + visitor_invite branches keep their existing TS-orchestrated paths. Notification fan-out is post-RPC, best-effort. (See §10.1 cutover code.)
- `apps/api/src/modules/reservations/booking-flow.service.ts` — `create()` is refactored:
  - Build `BookingInput` from input params (where `create_booking` was called before).
  - Call `BundleService.buildAttachPlan` (when services are present) to build `AttachPlan`.
  - Call `create_booking_with_attach_plan` RPC with both payloads.
  - Drop the `txBoundary.runWithCompensation` wrapping (booking-flow.service.ts:408-425) — no compensation needed.
  - **v7:** receives `req.clientRequestId` (threaded by middleware) and uses it as the idempotency-key seed.
- `apps/api/src/modules/reservations/booking-transaction-boundary.ts` — kept for non-attach orphan recovery cases (e.g. a booking that gets stranded because a downstream cron failed); not the booking creation path.
- `apps/api/src/modules/reservations/booking-compensation.service.ts` — kept for `delete_booking_with_guard` callers that aren't the create path (admin tooling, manual cleanup); the `markAttachedRecovery` method proposed in v4 is deleted (no lease to recover).
- `apps/api/src/common/middleware/client-request-id.middleware.ts` — reads `X-Client-Request-Id`, exposes `req.clientRequestId` + `req.clientRequestIdSource`. **NEW in v7** (§3.3).
- `apps/web/src/lib/api.ts` — `apiFetch` auto-stamps `X-Client-Request-Id` on mutations. **v7 modification** (§3.3).

### Existing references
- Audit outbox service: `apps/api/src/modules/privacy-compliance/audit-outbox.service.ts:1-103`.
- Audit outbox worker: `apps/api/src/modules/privacy-compliance/audit-outbox.worker.ts:20-166`.
- Setup-WO trigger today: `apps/api/src/modules/service-routing/setup-work-order-trigger.service.ts:30-202` (deleted in v7 cleanup commit).
- Tenant context: `apps/api/src/common/tenant-context.ts:1-29`.
- `create_booking` RPC (no-services path): `supabase/migrations/00277_create_canonical_booking_schema.sql:236-334` (unchanged).
- `delete_booking_with_guard` RPC: `supabase/migrations/00292_delete_booking_with_guard_rpc.sql:54-141` (unchanged from current; v4's lock+re-check amendments dropped).
- Booking-flow producer: `apps/api/src/modules/reservations/booking-flow.service.ts:102-454` (`create` method; will be refactored to call combined RPC).
- BundleService attach today: `apps/api/src/modules/booking-bundles/bundle.service.ts:164-494` (`attachServicesToBooking` — body becomes `buildAttachPlan` + `create_booking_with_attach_plan` call).
- BundleService Cleanup helper today: `apps/api/src/modules/booking-bundles/bundle.service.ts:1878-1972` (**deleted in v5** — atomic RPC subsumes it).
- BundleService onApprovalDecided today: `apps/api/src/modules/booking-bundles/bundle.service.ts:1370-1642` (**deleted in v7** — `grant_booking_approval` RPC subsumes it).
- Approval routing (write-side): `apps/api/src/modules/orders/approval-routing.service.ts:96-353` (`assemble` stays for standalone-order path; new `assemblePlan` for combined-RPC path).
- Approval service: `apps/api/src/modules/approval/approval.service.ts:353-487` (`respond` body — v7 cutover described in §10.1).
- TicketService booking-origin WO creator: `apps/api/src/modules/ticket/ticket.service.ts:1829-1934` (`createBookingOriginWorkOrder` — v7 work moves to RPC; method may stay for non-outbox callers if any exist post-cutover, audit before delete).
- Old claim RPC: `supabase/migrations/00198_claim_deferred_setup_args.sql` (**dropped by 00308 in v7**).
- apiFetch: `apps/web/src/lib/api.ts:113-165` (v7 adds the `X-Client-Request-Id` auto-stamp).

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

Carry forward the foundation metrics. v5/v6/v7 changes:

- **`outbox_setup_wo_emissions_total{tenant_id, source, requires_approval}`** — counter incremented on each emission of `setup_work_order.create_required`. `source` label distinguishes `create_path` (combined RPC §7.6) vs `approval_grant_path` (the `approve_booking_setup_trigger` call inside `grant_booking_approval` §10.1). Phase A baseline. Phase B should match (same RPC bodies in both phases; the cutover is at the handler, not the producer).
- **`outbox_setup_wo_handler_outcomes_total{outcome}`** — labels: `created | already_created | no_routing_match | invalid_window | tenant_mismatch | dead_lettered`. The `dead_lettered` count is the most important production signal — every increment = a service line that should have a setup work order and doesn't. `already_created` = dedup table hit; high counts indicate at-least-once retries are working as designed.
- **`attach_operations_outcomes_total{outcome}`** — labels: `success | payload_mismatch | unexpected_state`. v6 dropped `failed` and `duplicate_in_flight` (impossible post-advisory-lock). `payload_mismatch` should be 0 in steady state (any non-zero = a TS bug constructing non-deterministic UUIDs or keys; v6's deterministic uuidv5 + v7's canonical sort should keep this at zero).
- **`create_booking_with_attach_plan_duration_ms`** histogram — replaces v4's `outbox_attach_rpc_duration_ms`. p99 informs whether the RPC is acceptably fast for the synchronous request path. If p99 climbs above 2s sustained, profile + tune (likely candidates: the FK validation matrix's `EXCEPT` queries on cold caches, or the GiST exclusion check on heavy contention). v6 adds the advisory-lock wait time as part of this measurement; under contention the p99 will tick up but the lock holders are quick (sub-second RPC body), so saturation should be bounded.
- **`approve_booking_setup_trigger_duration_ms`** histogram. p99 informs whether the approval-grant emit path is fast enough that approval-grant UX doesn't notice. Expected: well under 100ms for typical batches.
- **`grant_booking_approval_duration_ms`** histogram — NEW in v7. p99 informs whether the atomic approval-grant RPC is fast enough that approve-button UX is acceptable. Includes advisory-lock wait + slot/booking transition + setup emit. Expected p99 under 200ms; if it climbs, profile the slot transition (likely candidates: a tenant with hundreds of slots per booking).
- **`grant_booking_approval_outcomes_total{outcome}`** — NEW in v7. Labels: `resolved | partial_approved | already_responded | non_booking_approved`. `partial_approved` is informational (parallel groups). `already_responded` non-zero indicates client retries arriving after a previous grant committed — a healthy signal that the idempotency mechanism is working.
- **`create_setup_work_order_from_event_outcomes_total{outcome}`** — NEW in v7. Labels: `created | already_created`. `already_created` = handler retry after the prior attempt committed; healthy.
- **`setup_work_order_emissions_inserts_total{outcome}`** — Labels: `inserted | duplicate`. v7 makes this near-zero on the duplicate side because the dedup row is now inserted in the same tx as the WO; the only way to see `duplicate` is a non-blocking advisory-lock release between two concurrent handlers, which the read-side dedup at §7.8 step 3 catches.
- **`client_request_id_source_total{source}`** — NEW in v7. Labels: `client | server_default`. Surfaces how many mutations arrive without the header; high `server_default` counts indicate frontend code paths that aren't going through `apiFetch` (e.g. raw `fetch` calls). Alert at >5% sustained.
- **`setup_wo_rpc_validation_errors_total{kind}`** — NEW in v8. Labels: `event_not_found | oli_chain_invalid | row_oli_mismatch | row_booking_mismatch | fk_invalid | rule_id_invalid`. All should be ≈0 in steady state — any non-zero indicates a row-builder bug, a stale event, or admin tooling mutating rules without coordinating with in-flight grants. Alert on first occurrence in production.

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

### 15.5 Handler dedup test (v6 + v7 atomicity + v8 identity-from-chain + tombstones)

- Insert a `setup_work_order_emissions` row manually for `(tenant_id, oli_id)`. Fire the same outbox event. Assert handler returns success WITHOUT calling `SetupWorkOrderRowBuilder.build` (mock the builder; assert zero calls).
- **v8: tombstone case (folds I4)** — insert a dedup row with `work_order_id IS NULL` (tombstone — admin deleted the WO). Fire the same outbox event. Assert RPC returns `kind: 'already_handled_tombstone'` and `work_order_id: null`; assert NO new WO created; assert the tombstone row is unchanged.
- **v8: tombstone reset workflow** — insert a tombstone; admin runs `DELETE FROM setup_work_order_emissions WHERE oli_id = ?`; fire the same outbox event. Assert a fresh WO + dedup row are created (the dedup row's `work_order_id` is now non-null again).
- **v7:** Concurrent handler dispatch — two workers somehow claim the same event (force via stale-claim recovery). Both reach the read-side dedup; both miss; both call `create_setup_work_order_from_event` RPC. One acquires the per-OLI advisory lock first and inserts the WO + dedup row in one tx; the second blocks at the lock, then re-reads the committed dedup row and returns `kind: 'already_created'`. Assert exactly one WO created. **v8: this test is one of the "real-DB concurrency tests" — must run via the harness in §15.8 below, not via mocked race-injection.**
- Cancel-then-replay: handler creates WO + dedup row (atomically); admin closes the WO; replay the same outbox event. Assert handler returns success on the read-side dedup hit; no second WO.
- **v7:** Crash-between-WO-and-dedup is now structurally impossible — a unit test asserts that if `create_setup_work_order_from_event` is called and the WO INSERT succeeds but the dedup INSERT raises (impossible without an external constraint violation, but defensive), the WO INSERT rolls back. Confirms the atomicity claim is real, not aspirational.
- **v8 (folds C1): identity-from-chain validation tests.** See full list in §7.8.2 ("Tests added (v8 — append to §15.5)") — covers cross-tenant `linked_order_line_item_id`, cross-tenant FK fields (`assigned_team_id`, `location_id`, `sla_id`), event-not-found race, mismatched booking_id, and the happy path that verifies chain-derived values are persisted (not row-JSON values).
- **v8 (folds I6): emit-time ruleIds validation.** See §7.9.1 ("v8 §15.5 test additions for v8-I6") — covers the cross-tenant rule_id case and asserts rollback (args still non-null, no outbox event, no audit row). This test was an open question in v7 §15.5 ("verify with codex review whether this test fits §8.2 or needs a separate runtime guard"); v8 resolves it: separate runtime guard at §7.9.1, with the test living here.

### 15.5-bis Real-DB concurrency harness (NEW in v8 — folds the v7 nit)

v7's "concurrent handler dispatch" + "concurrent grant on same approval" tests described mocked race-injection. Mocks cannot simulate real Postgres advisory-lock acquisition order or commit timing.

**v8 contract: concurrency tests for cutover-blocking RPCs MUST use a real-DB harness.** Two acceptable shapes:

1. **pgTAP** via `pg_prove` against a real Postgres instance — `lives_ok` / `throws_ok` + `pg_locks` introspection.
2. **Node test runner with `pg` direct connections** — spawn two connections from `pg.Pool`; one BEGINs + acquires the advisory lock + holds; the second BEGINs + tries to acquire; assert via `pg_locks` that the second is blocked (`granted=false`); release the first; assert the second proceeds. Run with `--runInBand`.

**Mandatory tests routed through this harness:**
- Concurrent handler dispatch on the same `setup_work_order.create_required` event (§15.5).
- Concurrent grants on the same `approval_id` and on different approvals of the same booking (§15.6).
- Concurrent retries of `create_booking_with_attach_plan` with the same key (§15.2).

**B.0 cutover prerequisite** (NOT a foundation prerequisite): the harness must ship before Phase B of §5.1 flips. Tracked in §11 open question 11.

### 15.6 `grant_booking_approval` integration tests (NEW in v7)

- **Single-step happy path**: create a booking with services that triggers ONE single-step approval; pre-populate one OLI's `pending_setup_trigger_args`. Call `grant_booking_approval(approval_id, tenant_id, actor_user_id, 'approved', null, idempotency_key)`. Assert: approvals.status='approved', booking_slots.status='confirmed', bookings.status='confirmed', `outbox.events` row landed for the OLI, OLI's pending_setup_trigger_args is NULL, audit row `booking.deferred_setup_emitted_on_approval` exists with `emitted_count=1`. Single tx — verified by tearing down the connection mid-statement and asserting either all-or-nothing state.
- **Single-step rejection**: same setup as above, but `p_decision='rejected'`. Assert: approvals.status='rejected', booking_slots.status='cancelled', bookings.status='cancelled', NO outbox event landed, OLI's pending_setup_trigger_args is NULL (cleared by the rejection branch).
- **Parallel group, partial then resolved**: create a booking with TWO sibling pending approvals (parallel_group='cost_center'). Grant the first → assert `kind: 'partial_approved'`, slots/bookings still `pending_approval`, no outbox event. Grant the second → assert `kind: 'resolved'`, slots/bookings transitioned, outbox events landed.
- **Sibling-expire on rejection**: parallel group with three pending approvals. Reject the first → assert all three approvals are now non-pending (one `rejected`, two `expired`), slot/booking cancelled, no outbox events.
- **Idempotent retry**: call `grant_booking_approval` twice with the same approval_id + same idempotency_key. First call returns `kind: 'resolved'`; second call returns `kind: 'already_responded'` without raising. Assert no duplicate slot/booking transitions, no duplicate outbox events.
- **Concurrent grant on same approval**: two parallel calls on the same approval_id. The advisory lock at §10.1 step 1 serializes; first wins with `resolved`; second blocks, then reads committed state and returns `already_responded`.
- **Concurrent grant on different approvals, same booking**: two parallel calls on TWO sibling approvals (parallel group). The booking-level advisory lock at §10.1 step 3 serializes; first call returns `partial_approved` (or `resolved` depending on ordering); second waits, then re-reads `v_unresolved_count` after the first commits and resolves correctly.
- **Cancel-race during grant**: pre-populate OLI args; mark one OLI as `fulfillment_status='cancelled'` after the grant call begins (race-injection via test hook). The RPC's `for update of oli` lock makes this serialized; assert no event for the cancelled OLI.
- **Snapshot UUID validation (v7-I4 + v8-I6 RESOLVED)**: pre-populate an OLI with `pending_setup_trigger_args.ruleIds = [<another-tenant's-rule-id>]`. Call `grant_booking_approval`. Assert RPC raises `setup_wo.rule_id_invalid` from `validate_rule_ids_in_tenant` (called inside `approve_booking_setup_trigger` per §7.9.1); the whole tx rolls back; OLI args remain non-null; no outbox event landed. v8 resolves the v7 open question — the right shape is a runtime guard at `approve_booking_setup_trigger` emit time (NOT at `grant_booking_approval` ingress, NOT inside `outbox.emit`). The §8.2 plan-time validation catches rule_ids that are wrong at plan time; the §7.9.1 emit-time validation catches the (rare but possible) case where rules mutated between plan-time and grant-time.
- **Validation: ticket and visitor_invite branches don't enter the RPC**: call `grant_booking_approval` with an approval whose `target_entity_type` is `'ticket'` (manually inserted for the test). Assert the RPC returns `kind: 'non_booking_approved'` and does not touch booking_slots or bookings.

### 15.7 `X-Client-Request-Id` middleware tests (NEW in v7)

- **Client-supplied UUID round-trips**: send a request with `X-Client-Request-Id: <uuid>`; assert the producer's idempotency_key contains the same value.
- **Missing header → server default**: send a request with no `X-Client-Request-Id`; assert `req.clientRequestId` is set to a fresh UUID and `req.clientRequestIdSource = 'server_default'`.
- **Malformed header → server default**: send `X-Client-Request-Id: not-a-uuid`; assert middleware overrides with a server-generated UUID.
- **Case-insensitive header**: send `x-client-request-id: <uuid>` (lowercase); assert it's accepted.
- **`apiFetch` auto-stamp on POST**: monkey-patch `fetch` in a unit test, call `apiFetch('/foo', { method: 'POST' })`; assert the request includes `X-Client-Request-Id` with a UUID-shaped value.
- **`apiFetch` no auto-stamp on GET**: same setup but `method: 'GET'`; assert no `X-Client-Request-Id` header.
- **Caller-supplied header preserved**: `apiFetch('/foo', { method: 'POST', headers: { 'X-Client-Request-Id': 'fixed-uuid' } })`; assert the fixed value is sent unchanged.

---

## 16. Rollout / Success criteria

### 16.1 v5/v6/v7 cleanup commit (lands BEFORE B.0 implementation; folds N1 + v7-N2)

The cleanup pass that closes the implementation-vs-spec drift identified by codex N1 (v6) and N2 (v7). **This commit is the prerequisite for any B.0 work** — strip the dead lease-era code AND wire the CI grep guard so subsequent commits are reasoning against an honest baseline.

Scope:

1. `apps/api/src/modules/outbox/outbox.service.ts`
   - Delete `markConsumed()` method (lines 67-82).
   - Update the module-level docstring (lines 5-21) — remove the v3/v4 lease semantics description, the "two methods, two semantics" framing, the `markConsumed` paragraph, the `booking.create_attempted` reference. Replace with a concise "fire-and-forget producer for best-effort emissions; durability comes from RPC-side `outbox.emit()` calls" summary.
   - Update the `emit()` method's docstring (lines 28-36) — drop the "same-payload re-emit is a no-op silent success in the SQL helper" if redundant; keep the "23505 caught and logged" sentence.

2. `apps/api/src/modules/outbox/__tests__/` — delete any tests that exercised `markConsumed` or `booking.create_attempted` event handling; they describe v3/v4 contracts that no longer exist.

3. `supabase/migrations/00299_outbox_foundation.sql` — `outbox_mark_consumed_via_rpc` PostgREST wrapper STAYS (per §2.3); it's dormant infra.

4. **CI grep guard (v7-N2 — actual workflow step, not prose).** Add a step to `.github/workflows/ci.yml` that fails the build on any reintroduced obsolete symbol. The v6 spec said "add a CI grep guard in the cleanup commit message" — that's a one-shot reviewer-vigilance gate, not a durable defense. v7 specifies the actual workflow step:

```yaml
# .github/workflows/ci.yml — add as a job step ahead of typecheck
- name: Reject obsolete outbox / lease / claim symbols
  run: |
    set -euo pipefail
    declare -a banned=(
      "OutboxService\\.markConsumed"
      "outbox\\.mark_consumed"
      "outbox_mark_consumed_via_rpc"
      "booking\\.create_attempted"
      "BookingCreateAttemptedHandler"
      "claim_deferred_setup_trigger_args"
      "setupTrigger\\.triggerMany"
      "SetupWorkOrderTriggerService\\.triggerStrict"
      "BookingCompensationService\\.markAttachedRecovery"
      "outbox\\.lease_seconds"
    )
    fails=0
    for pat in "${banned[@]}"; do
      # Search runtime source only — exclude tests + migrations + spec docs.
      hits=$(grep -rEn "$pat" \
        apps/api/src apps/web/src packages \
        --include='*.ts' --include='*.tsx' \
        --exclude-dir='__tests__' --exclude-dir='node_modules' \
        || true)
      if [ -n "$hits" ]; then
        echo "::error title=Obsolete outbox symbol::pattern '$pat' found:"
        echo "$hits"
        fails=$((fails + 1))
      fi
    done
    if [ "$fails" -gt 0 ]; then
      echo "Found $fails reintroduced obsolete symbol(s). v5/v6/v7 retired these — see docs/superpowers/specs/2026-05-04-domain-outbox-design.md."
      exit 1
    fi
```

Notes on the script:
- Excludes `__tests__/` (mock arguments may legitimately reference banned symbols when verifying they're absent) and `supabase/migrations/` (00198 etc. are historical migrations that stay in the tree). The drop migration (00308) is allowed to mention the symbol because it's the migration that drops it.
- Allows references in markdown (`docs/`, `*.md`) — the spec MUST cite obsolete symbols to explain what was retired.
- Runs ahead of typecheck so the failure surfaces before slow steps.
- Treats `triggerStrict` as banned because v7 retires the v6 strict-mode method in favour of `SetupWorkOrderRowBuilder`. If this becomes too strict during the v6→v7 transition deploy window, add a temporary suppression with an expiry date in the PR description.

5. Search the codebase for `OutboxService.markConsumed` callers — should be zero after the method deletion. Compiler will catch any miss.

6. **Delete the legacy `SetupWorkOrderTriggerService.trigger` and `triggerMany`** after Phase B cutover lands. They have no callers post-§7.7-bis retirement; leaving them in the tree invites a regression. Same commit deletes the v6 `triggerStrict` method (replaced by `SetupWorkOrderRowBuilder.build`).

7. **Delete the v7 cancel-race block at `bundle.service.ts:1550-1614`** — the `grant_booking_approval` RPC's `for update of oli` lock + `if v_oli.fulfillment_status = 'cancelled' then continue;` branch makes it dead code. Verified by tests in §15.5 (handler dedup test) + §15.6 (parallel-group race).

This commit lands ahead of B.0 (§16.2) so the v7 implementation work isn't fighting against stale infrastructure.

### 16.2 Phase 6 (B.0 + cutover) is complete when:

1. v5/v6/v7/v8 NEW migrations applied to remote Supabase + `notify pgrst, 'reload schema'`:
   - 00302 (`attach_operations` — v6 contract: outcome enum collapsed to `('in_progress', 'success')`).
   - 00303 (`create_booking_with_attach_plan` RPC + `validate_attach_plan_tenant_fks` + `validate_attach_plan_internal_refs` — **v8 signature `(p_tenant_id, p_booking_input, p_attach_plan)`** for the internal-refs helper; matches §7.6 call site).
   - 00304 (`setup_work_order_emissions` — v7 FK to `work_orders`; **v8 contract: ON DELETE SET NULL**, see 00310 if 00304 shipped already).
   - 00305 (`approve_booking_setup_trigger` RPC — v7 SIGNATURE: `(p_booking_id, p_tenant_id, p_actor_user_id, p_idempotency_key)`; **v8 body adds emit-time `validate_rule_ids_in_tenant` call**).
   - 00306 (`create_setup_work_order_from_event` RPC — v7 NEW; **v8 body supersedes: loads `outbox.events` row, derives identity from chain, validates FKs via `validate_setup_wo_fks`**) + `validate_setup_wo_fks` helper.
   - 00307 (`grant_booking_approval` RPC — v7 NEW; **v8 body reorders lock+validate before CAS update**).
   - 00308 (drops `claim_deferred_setup_trigger_args` — v7 NEW).
   - 00309 (`validate_rule_ids_in_tenant` helper — **v8 NEW**; folds I6).
   - 00310 (alters `setup_work_order_emissions.work_order_id` FK to SET NULL — **v8 NEW**; folds I4; required only if 00304 already applied with v7 CASCADE contract).
2. `OutboxService` (emit-only — post-cleanup §16.1) + `OutboxWorker` (§4.2 state machine) + decorator registry implemented + unit-tested.
3. `planUuid()` helper + `planSort` comparators (`apps/api/src/modules/booking-bundles/plan-uuid.ts`) implemented + unit-tested. Tests assert: same `(idempotencyKey, rowKind, stableIndex)` → same UUID across runs; **v7: equivalent input objects with shuffled array elements produce byte-identical jsonb plans (canonical-sort discipline)**; namespace constant is committed and never rotated.
4. `BundleService.buildAttachPlan` unit-tested against the survey of existing `attachServicesToBooking` writes (every row type covered). Stable-index discipline asserted: `buildAttachPlan(input)` called twice produces a byte-identical jsonb plan; **v7: also asserts shuffled-input equivalence (test injects an identity-permutation noop and asserts identical output)**.
5. `ApprovalRoutingService.assemblePlan` unit-tested; matches `assemble`'s dedup logic without writing; uses `planUuid` for approval ids.
6. `create_booking_with_attach_plan` RPC integration-tested per §15.2 (including v6 advisory-lock + internal-refs tests + **v7 snapshot UUID validation tests**).
7. `SetupWorkOrderRowBuilder.build` (v7 — replaces `triggerStrict`) unit-tested: terminal outcomes for `no_routing_match` / `invalid_window` / `config_disabled`; thrown errors for RPC failures.
8. `create_setup_work_order_from_event` RPC integration-tested: idempotent re-handle on duplicate event; concurrent dispatch produces exactly one WO; cancel-then-replay returns `already_created` without creating a second WO.
9. `SetupWorkOrderHandler` (using `RowBuilder.build` + `create_setup_work_order_from_event`) integration-tested per §15.5.
10. `approve_booking_setup_trigger` RPC integration-tested per §15.2 (v7 tests: read+emit+clear in one tx; cancel-race-guard via `for update`; advisory lock against concurrent grants on same booking).
11. **v7: `grant_booking_approval` RPC integration-tested per §15.6**: single-step booking approval (CAS + slot transition + setup emit, all in one tx); parallel-group with N=3 (first two grants return `partial_approved`, third returns `resolved`); rejection path (slots → cancelled, args cleared, no emits); already-responded path returns `kind: 'already_responded'` without raising.
12. **v7: `X-Client-Request-Id` middleware** integration-tested: client-supplied UUID survives through `req.clientRequestId`; malformed value falls back to server-generated; producer constructs idempotency_key correctly.
13. **v7: `apiFetch` unit-tested**: GET requests don't get a header stamped; POST/PUT/PATCH/DELETE get an auto-generated UUID; caller-supplied header is preserved.
14. `BookingFlowService.create` refactored to call combined RPC for services-present paths; no-services path keeps calling `create_booking` (00277). Idempotency key constructed deterministically from `actor.user_id + req.clientRequestId`.
15. **v7: `ApprovalService.respond` refactored** — booking branch goes through `grant_booking_approval` RPC; ticket + visitor_invite branches keep their existing TS-orchestrated paths (per §11 open question 8).
16. `delete_booking_with_guard` boundary call removed from `BookingFlowService.create` (no compensation needed).
17. `Cleanup` class deleted from `bundle.service.ts`; `attachServicesToBooking` body simplified to `buildAttachPlan` + RPC call.
18. **v7: `BundleService.onApprovalDecided` collapsed** — claim RPC + branch logic + `triggerMany` call all replaced by a single call into `grant_booking_approval` from `ApprovalService.respond`. The `onApprovalDecided` method itself becomes vestigial after the cutover (its only job in v7 is the post-RPC notification fan-out, which `ApprovalService.respond` can do directly). Final cleanup: delete `bundle.service.ts:1370-1642`.
19. **v7: cancel-race block at `bundle.service.ts:1550-1614` deleted** — the RPC's `for update of oli` lock subsumes it.
20. Best-effort `SetupWorkOrderTriggerService.trigger`/`triggerMany`/`triggerStrict` deleted in the cleanup commit after Phase B is fully cut over (§16.1 step 6).
20a. **v8 cutover gate (NOT a foundation gate): real-DB concurrency harness** (§15.5-bis). Before Phase B can flip the SetupWorkOrderHandler to active, the cutover-blocking concurrency tests in §15.5/§15.6/§15.2 MUST run via the real-DB harness (pgTAP or two-connection `pg.Pool` with `pg_locks` introspection), not via mocks. The harness ships as a separate piece of test infrastructure; its absence does not block B.0 foundation work, but its presence is mandatory for cutover. Tracked in §11 open question 11.
20b. **v8 input-contract validation:** `BundleService.buildAttachPlan` rejects inputs missing `client_line_id` on any line, and rejects inputs where two lines in the same order have the same `client_line_id`. Unit-tested.
21. `SetupWorkOrderHandler` Phase A burn-in: 7 days, ≥50 samples, zero `outbox_shadow_results.matched=false`.
22. `pnpm smoke:booking-create-with-services` and `pnpm smoke:approve-booking-setup-trigger` pass against staging. **v7: `pnpm smoke:grant-booking-approval` covers the new RPC** — creates a booking that needs approval, approves, asserts slot/booking transitioned + outbox event landed.
23. Setup-WO cutover Phase A → B → C without incident; `outbox_setup_wo_handler_outcomes_total{outcome="dead_lettered"}` is 0 across the cutover window.
24. Tenant-mismatch counter zero for 30+ days post-cutover.
25. `attach_operations_outcomes_total{outcome="payload_mismatch"}` is 0 for 30+ days post-cutover (the C1 fix is working).
26. **v7: `audit_events` for `booking.deferred_setup_emitted_on_approval`** show `emitted > 0` for grants that should have fired events (sanity check that the v6 zero-emit bug is closed).
27. Other event types ship in shadow-first cadence (§5.3).

---

## Document version

- v8 — 2026-05-04. Status: DESIGN (not implemented; investigation + spec only) — **FINAL design round before B.0 implementation begins.** Replaces v7 (commit `e96bec5`). Folds 1 critical + 6 importants + 1 nit from codex v7 review, plus an explicit "Not in B.0" deferral section. After v8, B.0 implementation starts immediately; further design changes go through B.0 + Phase 6 hardening, not another spec round.
- v7 — 2026-05-04. Status: superseded (commit `e96bec5`). Folded 3 criticals + 4 importants + 2 nits from codex v6 review.
- v6 — 2026-05-04. Status: superseded (commit `fd561fd`). Folded 4 criticals + 3 importants + 1 nit from codex v5 review.
- v5 — 2026-05-04. Status: superseded. Replaced v4 (commit `2c564f4`).
