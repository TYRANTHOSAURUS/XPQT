# Audit 02 — Assignment Atomicity Remediation Implementation Plan (v3 — post full-review + codex)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Anti-hallucination override (project CLAUDE.md "Citation discipline"):** the v3 RPC body is NOT inlined as speculative SQL. The executor MUST `Read supabase/migrations/00327_set_entity_assignment_v2.sql` in full first and produce v3 as a payload-extension (see Slice A), gated by a mandatory post-write SQL-diff **+ semantic-spec** review gate (Slice A Step 6-7) before the remote push. Override authorized by the higher-priority project rule; mitigated by the gate.
>
> **Plan history — do not regress:** v1's four forks were defended on a *summary* of the RPC → plan-gate (2 adversarial reviewers) caught 3 broken premises → v2 resolved them against literal source + discovered bug D-A02-1. Codex then caught 3 BLOCKING Postgres/idempotency-semantics flaws v2 still had (param-append creates a function overload not a replacement; new params outside the idempotency hash; the no-op fast path skips the new work). **v3 fixes all three by carrying the new behavior as optional keys inside the existing `p_payload` (signature UNCHANGED) — not as new RPC parameters.** This collapses 3 BLOCKING + the rollback-safety concern into one strictly-better change.

**Goal:** Close Audit 02 open findings P0-2, P1-1, P1-2, P1-5 + add live smoke, so every ticket/work_order assignment-changing path is atomic, idempotent-where-required, audited, visibility-safe — and fix the pre-existing `users.id`→`persons.id` watcher type bug (D-A02-1) discovered during the gate.

**Architecture:** One backward-compatible migration replaces `set_entity_assignment` **in place — identical 6-arg signature** (00327 v2 → v3) and recognizes three new OPTIONAL keys inside the existing `p_payload jsonb`: `watchers` (persons-validated full-replacement set), `decision` (allowlist-validated resolver-sourced routing-decision metadata), `clear_routing_status` (folds the routing-status clear into the same tx, case-arm only). Because the signature is unchanged there is no overload and the existing 3 callers are unaffected; because the new keys live in `p_payload` they are automatically covered by v2's payload-hash idempotency gate (F16). v3's no-op early-return is tightened so any new directive forces the full write path (F17). Observable writes are byte-identical to v2 when none of the three keys are present, proven by a SQL-diff **and semantic specs**. Reused by SLA escalation, both `reassign()` paths, and the routing-evaluation handler. P1-5 is pure TS.

**Tech Stack:** NestJS + supabase-js (admin), PL/pgSQL RPC (Supabase Postgres), jest specs, `.mjs` live-API smoke probes, `packages/shared/src/idempotency.ts`.

---

## Resolved facts (literal source — supersede all earlier assumptions)

| # | Fact | Citation |
|---|---|---|
| F1 | `tickets.watchers uuid[]` comment "person IDs following this ticket"; `work_orders.watchers uuid[]` | `00011_tickets.sql:26`, `00213_step1c1_work_orders_new_table.sql:81` |
| F2 | `update_entity_combined` watcher validator: JSON-type + UUID-string-shape + stable dedup/order + `c_max_watchers` cap + persons predicate (tenant, `active`, `anonymized_at is null`, `left_at is null`) + mismatch-error semantics — the WHOLE block, not just the persons lookup | `00384_update_entity_combined_v6_plan_version_lock.sql:596-652` |
| F3 | SLA `applyReassignment` appends `ticket.assigned_user_id` (a **users.id**) into `newWatchers` then writes `updates.watchers` | `sla.service.ts:788,794` → **pre-existing type bug D-A02-1** |
| F4 | v2 sig: `(p_entity_id uuid, p_entity_kind text, p_tenant_id uuid, p_actor_user_id uuid, p_idempotency_key text, p_payload jsonb)`; `security invoker`. **v3 keeps this signature byte-identical.** | `00327:64-74` |
| F5 | v2 `FOR UPDATE` selects only `id, assigned_team_id, assigned_user_id, assigned_vendor_id, status_category`; separate case/WO arms | `00327:164-176` |
| F6 | v2 UPDATE (both arms) sets only `assigned_*`, `status_category`, `updated_at` — never `routing_status`/`watchers` | `00327:240-256` |
| F7 | v2 routing_decisions insert gated `if v_reason is not null`; hardcodes `strategy='manual'`, `chosen_by='manual_reassign'`; sets `entity_kind`/`case_id`/`work_order_id` polymorphically | `00327:258-288` |
| F8 | No DB CHECK/enum on `routing_decisions.strategy`/`chosen_by` (plain text) | `00026_routing_foundation.sql` (grep: none) |
| F9 | v2 activity metadata = fixed 4-key `{event,previous,next,reason}`; domain_events `entity_type='ticket'` for BOTH kinds, `event_type='ticket_assigned'` | `00327:361-376,387-410` |
| F10 | v2 advisory lock `hashtextextended(p_tenant_id||':'||p_idempotency_key,0)`; v2 never references `watchers` | `00327:129` |
| F11 | ALL 5 producers of `routing.evaluation_required` are case/ticket-only; **no WO producer exists** | `00354:544`,`00355:459`,`00356:504`,`00357:389`,`00358:326` |
| F12 | `work_order_visibility_ids(p_user_id uuid, p_tenant_id uuid)` — same arg shape as `ticket_visibility_ids`; WO inherits `tickets.read_all` by design | `00374_work_orders_visibility.sql:35-39,108-114` |
| F13 | `getVisibleIds`: `null` if `ctx.has_read_all`, `[]` if no user, else rpc→string[]; `has_read_all` ← `tickets.read_all` | `ticket-visibility.service.ts:206-215,151-156,184` |
| F14 | `getChildTasks` returns a bare array, no pagination/count; controller returns it raw | `ticket.service.ts:1566-1594` |
| F15 | `buildPatchIdempotencyKey` = `` `${PREFIX}:${kind}:${entityId}:${clientRequestId}` ``; named exports; PREFIX const | `packages/shared/src/idempotency.ts:65-71` |
| **F16** | **v2 idempotency hash covers ONLY `p_payload` (`md5(coalesce(p_payload::text,''))`).** New behavior MUST live in `p_payload` or it escapes the `payload_mismatch` gate | `00327:132-141` |
| **F17** | **v2 has a no-op early-return** before the UPDATE/audit/event path when assignment is unchanged AND `reason` is null. v3 MUST extend this guard so presence of `watchers`/`decision`/`clear_routing_status` forces the full path | `00327:208-237` |
| **F18** | Outgoing-assignee user→person lookup is concrete: `select person_id from users where id = <ticket.assigned_user_id> and tenant_id = <ticket.tenant_id>`. (v2 maps auth_uid→person at `00327:293-298`; SLA maps personId→users.id at `sla.service.ts:779-784` — the reverse is symmetric, tenant-scoped) | `00327:293-298`, `sla.service.ts:779-784` |

---

## Design decisions (forks — resolved against literal source, codex-corrected)

**Mechanism (codex BLOCKING 1/2/6, supersedes v2's "new params"):** v3 keeps the **exact v2 6-arg signature** (F4). The three new behaviors are OPTIONAL keys read from the existing `p_payload`: `p_payload->'watchers'` (jsonb array | absent), `p_payload->'decision'` (jsonb object | absent), `p_payload->>'clear_routing_status'` (`'true'` | absent). Rationale: appending parameters to `create or replace function` creates a *new overload* leaving the old 6-arg body live for the 3 existing callers (workflow engine / dispatch / routing handler) — a production-breaking footgun; payload-keys are signature-stable, automatically covered by v2's payload-hash idempotency gate (F16), and make the remote push genuinely backward-compatible (forward-only `create or replace` is then a true in-place replacement, not an overload split).

**Fork 1 — P0-2 watchers (+ discovered bug D-A02-1):** v3 reads `p_payload->'watchers'`; when present, validate by transplanting the **entire** F2 block (00384:596-652) — JSON-type guard, UUID-string-shape regex, stable dedup+order, `c_max_watchers` cap, the `public.persons` predicate (tenant/active/not-anonymized/not-off-boarded), and the mismatch-error semantics — not merely the persons lookup. SLA's intent ("outgoing assignee now watches") is preserved but corrected: per F1+F3 the column is `persons.id`-referent and SLA appends a `users.id`. Slice B resolves the outgoing `assigned_user_id`→`person_id` via the concrete F18 query before appending, logs the pre-existing bug as discovered finding **D-A02-1**, then passes the corrected set in `p_payload.watchers`. Historically-polluted arrays may fail validation — acceptable & correct per the project "no production data / clean foundation" invariant. Residual **R-A02-1** (documented, accepted): v3 `p_payload.watchers` and `update_entity_combined`'s metadata watcher write are both full-replace under different advisory-lock keys (F10) → last-writer-wins on concurrent writers; SLA escalation is a rare cron event, tolerable.

**Fork 2 — P1-1 (narrowed by F7, codex-verified):** v2 ALREADY writes a correct `routing_decisions` row whenever `reason` is non-null (F7, codex-confirmed at 00327:258-288 incl. explicit entity_kind/case_id/work_order_id). Manual reassign passes `reason` ⇒ already audited. **`p_payload.decision` is needed ONLY for the case-side `rerun_resolver` branch + the routing-evaluation handler**, to make the audit row reflect the real resolver `strategy`/`chosen_by`/`trace`/`rule_id`/`context` instead of hardcoded `'manual'`. v3's routing_decisions guard becomes `if v_reason is not null OR p_payload ? 'decision'`. No DB CHECK exists (F8) so v3 MUST validate `decision->>'strategy'` and `decision->>'chosen_by'` are non-null strings drawn from the application sets (`apps/api/src/modules/routing/routing.service.ts:13-20` + `resolver.types.ts:1-27`) and raise a registered error otherwise (trace/context remain trusted service metadata). When `decision` is absent, F7 behavior is byte-identical.

**Fork 3 — P1-2 (confirmed case-only by F11):** v3 reads `p_payload->>'clear_routing_status'`; when `'true'`, the **case-arm** UPDATE (F6) additionally sets `routing_status='idle', routing_failure_reason=null`. WO arm untouched (no WO routing_status; no WO producer per F11). Absent ⇒ all existing callers byte-identical. The handler keeps `p_entity_kind:'case'` + a fail-closed guard (safe — F11 proves zero WO events). Slice D **removes** the handler's own TS `routing_decisions.insert` and passes `p_payload.decision`, so v3 owns the audit row atomically (stated, not an executor "decide").

**Fork 4 — P1-5 (confirmed safe by F12-F14):** Add `getVisibleWorkOrderIds(ctx)` to `TicketVisibilityService` mirroring F13 exactly but calling `work_order_visibility_ids` (F12, arg-compatible). `ctx.has_read_all` (=`tickets.read_all`) is the *intended* WO bypass per F12 (WO inherits it by design; cite the 00374 comment). `getChildTasks` returns a bare array (F14) ⇒ post-fetch TS filter is integrity-safe. No new service (audit P2-1 split out of scope; YAGNI).

**Scope fence:** P1-3, P1-4, all P2-*, the optional cross-id `bulk_update_entity_combined` RPC are OUT. Slice C *reads* the WO `assertCanPlan` floor but does not change it (documents the deferral). D-A02-1 IS fixed here — it is a precondition for correctly closing Fork 1, not scope creep.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `supabase/migrations/004XX_set_entity_assignment_v3.sql` | in-place replacement, identical 6-arg sig; new `p_payload` keys `watchers`/`decision`/`clear_routing_status`; output = v2 when all absent; no-op guard extended (F17) | Create (claim next free slot — Slice A Step 1) |
| `packages/shared/src/idempotency.ts` | add prefix consts + `buildReassignIdempotencyKey` + `buildSlaEscalationIdempotencyKey` (match F15) | Modify |
| `apps/api/src/modules/sla/sla.service.ts` | `applyReassignment` → v3 via `p_payload.watchers`; resolve user→person (F18, fix D-A02-1); key `sla:escalation:<timer>:<pct>:<type>` | Modify (~754-799, helper ~35-59, `fireThreshold` ~866-952) |
| `apps/api/src/modules/ticket/ticket.service.ts` | `reassign` (manual=reason only; rerun_resolver=evaluate-first + `p_payload.decision`); `getChildTasks` child filter | Modify (~1231-1414, ~1566-1594) |
| `apps/api/src/modules/work-orders/work-order.service.ts` | `reassign` → v3 (reason); drop swallowed try/catch; refetch-miss → `notFound` | Modify (~887-1062) |
| `apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts` | `p_payload.clear_routing_status:true` + `p_payload.decision`; drop 2nd raw write + TS routing_decisions.insert; fail-closed case guard | Modify (~200-294) |
| `apps/api/src/modules/ticket/ticket-visibility.service.ts` | add `getVisibleWorkOrderIds` | Modify |
| `smoke-work-orders.mjs` / `smoke-tickets.mjs` | new probes (Slice F) | Modify |
| `docs/assignments-routing-fulfillment.md` · `docs/visibility.md` · `docs/smoke-gates.md` | living-contract sync, same change as behavior | Modify |
| `docs/follow-ups/audits/02-tickets-work-orders.md` | Codex Deep Review status + Closure Ledger + D-A02-1 + R-A02-1 | Modify |
| relevant `*.spec.ts` | TDD specs per slice | Modify/Create |

---

## Slice A — Migration: `set_entity_assignment` v3 (in-place payload extension)

Unblocks B/C/D. Identical signature; output-identical to v2 when new keys absent.

**Files:** Create `supabase/migrations/004XX_set_entity_assignment_v3.sql`; Modify `packages/shared/src/idempotency.ts`.

- [ ] **Step 1: Claim migration number.** `ls supabase/migrations/ | tail -3`; take the next free slot NOW (parallel workstreams advance it — memory `feedback_migration_number_collision`).

- [ ] **Step 2: Read literal source.** `Read 00327_set_entity_assignment_v2.sql` (full — esp. the F16 hash 132-141 and F17 no-op early-return 208-237). `Read 00384...:596-652` (the WHOLE watcher validator to transplant per F2). `Read routing.service.ts:13-20` + `resolver.types.ts:1-27` (the strategy/chosen_by allowlist). Record exact anchors.

- [ ] **Step 3: Write v3 — in-place, identical signature, payload-key extension.** `create or replace function public.set_entity_assignment(p_entity_id uuid, p_entity_kind text, p_tenant_id uuid, p_actor_user_id uuid, p_idempotency_key text, p_payload jsonb)` — **signature byte-identical to F4; do NOT add parameters.** Header comment: cite `00327:<lines>` per branch + the verbatim safety contract: *"v3 in-place replacement, identical signature. Observable writes byte-identical to v2 iff p_payload has none of keys {watchers, decision, clear_routing_status}. New keys are read from p_payload (covered by the existing payload hash, F16). The no-op early-return is extended (F17) so any new directive forces the full write path."* Additive changes only:
  - Add `watchers` to BOTH `FOR UPDATE` arms (F5) into `v_prev_watchers` (inert when key absent).
  - **Extend the F17 no-op early-return guard:** the early return now fires only when assignment unchanged AND `v_reason is null` AND `not (p_payload ? 'watchers')` AND `not (p_payload ? 'decision')` AND `coalesce(p_payload->>'clear_routing_status','') <> 'true'`. (Codex BLOCKING 3 — without this, a resolver re-picking the current assignee skips the status-clear/decision write.)
  - `watchers` branch: when `p_payload ? 'watchers'`, transplant the ENTIRE F2 validator (00384:596-652) — JSON-type guard, UUID-string regex, dedup+order, `c_max_watchers`, persons predicate, mismatch error — then set `watchers` in the SAME assignment UPDATE (both arms). Reflect in activity metadata `previous.watchers`/`next.watchers` + domain-event payload.
  - `decision` branch: guard becomes `if v_reason is not null or p_payload ? 'decision'`. When `decision` present: validate `decision->>'strategy'` & `->>'chosen_by'` are non-null strings ∈ the Step-2 allowlist → registered error if not; use `decision`'s strategy/chosen_by/rule_id/trace/context. When absent: F7 byte-identical.
  - `clear_routing_status` branch: when `p_payload->>'clear_routing_status'='true'`, the **case arm** UPDATE (F6) also sets `routing_status='idle', routing_failure_reason=null`. WO arm untouched.
  - Idempotency: NO change to the F16 hash line — the new keys are inside `p_payload` so they are already covered (this is the point of the payload-extension mechanism; verify the hash still reads the full `p_payload`).
  - Copy v2's `grant execute` lines verbatim.

- [ ] **Step 4: Local SQL validation.** `pnpm db:reset` → clean (local only).

- [ ] **Step 5: Idempotency builders.** `packages/shared/src/idempotency.ts` (match F15): add `REASSIGN_IDEMPOTENCY_KEY_PREFIX='reassign'`, `SLA_ESCALATION_IDEMPOTENCY_KEY_PREFIX='sla:escalation'`, `buildReassignIdempotencyKey(kind,entityId,crid)=>\`reassign:${kind}:${entityId}:${crid}\``, `buildSlaEscalationIdempotencyKey(timerId,atPercent,timerType)=>\`sla:escalation:${timerId}:${atPercent}:${timerType}\``.

- [ ] **Step 6: SQL-DIFF GATE.** Produce `git diff --no-index 00327_set_entity_assignment_v2.sql 004XX_set_entity_assignment_v3.sql`. MUST show ONLY: header comment, `v_prev_watchers`/decision vars, `watchers` in the FOR UPDATE selects, the extended no-op guard condition, and the three guarded branches — ZERO change to any line reachable when all three keys are absent AND no signature change. Keep the diff as a review artifact for the code-review gate. Any non-guarded change ⇒ STOP and rework.

- [ ] **Step 7: Semantic specs (codex IMPORTANT 5 — the diff alone can't prove the contract).** Add specs:
  1. **Backward-compat:** v3 with `p_payload` lacking all 3 keys ⇒ identical writes to v2 (assignment + command_operations + reason-gated routing_decisions + activity + domain event).
  2. **Idempotency-mismatch:** same `p_idempotency_key`, `p_payload` differing only by `watchers` (or `decision`, or `clear_routing_status`) ⇒ `command_operations.payload_mismatch` (proves F16 coverage).
  3. **No-op-with-directive:** assignment unchanged + `clear_routing_status:true` (and separately + `decision`) ⇒ the full write path still runs (routing_status cleared / decision recorded), NOT the early return (proves F17 extension).
  `pnpm -C apps/api test <file>` → PASS.

- [ ] **Step 8: lint + commit.** `pnpm -C apps/api lint && pnpm errors:check-app-errors` → pass.
```bash
git add supabase/migrations packages/shared/src/idempotency.ts apps/api
git commit -m "feat(audit02 sliceA): set_entity_assignment v3 — in-place payload extension (watchers/decision/clear_routing_status keys), extended no-op guard, idempotency builders, SQL-diff+semantic gate"
```

> **No remote push here.** Push moves to AFTER the code-review gate. Because the signature is unchanged (codex BLOCKING 1 fix), `create or replace` is a true in-place replacement — no overload, existing 3 callers unaffected (they pass a `p_payload` without the new keys ⇒ v2 behavior). Rollback = forward-only `create or replace` to v4. Forks lock at push time, which is after code-review.

---

## Slice B — P0-2: SLA escalation through v3 (+ fix discovered bug D-A02-1)

**Files:** Modify `sla.service.ts` (`applyReassignment` ~754-799, helper ~35-59, `fireThreshold` ~866-952). Test: `sla.service.spec.ts`.

- [ ] **Step 1: Verify the cron idempotency boundary.** Read `fireThreshold` (~866-952): record the exact ORDER of `applyReassignment` / `writeActivity` / `notifications.send` / `writeCrossing` (the `sla_threshold_crossings` unique-constraint insert, 00043) / `emitEvent`. Determine whether the crossing-insert dedup precedes notification/activity. Precise claim: v3 makes the **assignment+watchers+audit write** idempotent via `sla:escalation:<timer>:<pct>:<type>`; the crossing unique constraint governs crossing/notification dedup. State the exact boundary in the Closure Ledger — do NOT claim full-tick idempotency. If the crossing gate does NOT precede notification, log residual **R-A02-2** — do not overclaim.

- [ ] **Step 2: Failing test.** On an `escalate` threshold: `applyReassignment` calls `rpc('set_entity_assignment',…)` with the correct `p_entity_kind` (reuse `loadTicketForFire` dispatch), `p_idempotency_key===buildSlaEscalationIdempotencyKey(timer.id, threshold.at_percent, threshold.timer_type)`, and `p_payload` containing resolved assignment + non-null `reason` + a `watchers` array whose appended outgoing assignee is a **person_id** (NOT `assigned_user_id`); and the raw `updateTicketOrWorkOrder` is NOT used for the assignment/watchers write. → FAIL.

- [ ] **Step 3: Implement D-A02-1 fix + v3 routing.** In `applyReassignment`: before adding the outgoing assignee to watchers, resolve `ticket.assigned_user_id`→`person_id` via the concrete F18 query (`select person_id from users where id = ticket.assigned_user_id and tenant_id = ticket.tenant_id`; skip if null). Replace the raw assignment+watchers write with one `set_entity_assignment` call: `p_entity_id`=ticket.id, `p_entity_kind`=resolved kind, `p_tenant_id`=ticket.tenant_id, `p_actor_user_id`=null, `p_idempotency_key`=`buildSlaEscalationIdempotencyKey(...)`, `p_payload`={assigned_*, reason:'SLA escalation: <policy> <pct>% <timer_type>', actor_person_id:null, watchers:<corrected person-id array>}. `mapRpcErrorToAppError` (no raw throws — `errors:check-app-errors` gates `sla`). Leave legitimate SLA-internal column writes on the raw helper. Preserve the `changed`/no-op return.

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Docs.** `docs/assignments-routing-fulfillment.md`: add the SLA-escalation reassign path (audit drift-finding #2), the deterministic key, the emitted command_operations/routing_decisions/activity/domain-event, and the precise idempotency boundary from Step 1.

- [ ] **Step 6: Closure Ledger.** P0-2 row; register **D-A02-1** (pre-existing users.id→persons.id watcher write, fixed), **R-A02-1** (cross-RPC watcher last-writer-wins, accepted), **R-A02-2** if Step 1 found the notification gap.

- [ ] **Step 7: lint + commit.**
```bash
pnpm -C apps/api lint && pnpm errors:check-app-errors
git add apps/api docs
git commit -m "fix(audit02 sliceB P0-2): SLA escalation through set_entity_assignment v3 — idempotent+audited; fix discovered users.id->persons.id watcher bug (D-A02-1)"
```

---

## Slice C — P1-1: both `reassign()` paths through v3

**Files:** Modify `ticket.service.ts` (`reassign` ~1231-1414), `work-order.service.ts` (`reassign` ~887-1062). Tests: both specs.

- [ ] **Step 1: Failing tests.** (a) case manual: one `set_entity_assignment`, `p_idempotency_key===buildReassignIdempotencyKey('case',id,crid)`, `p_payload` has target+reason+actor_person_id, **no `decision` key**; NO raw `.from('tickets').update`, NO standalone routing_decisions/addActivity. (b) case rerun_resolver: exactly one `routingService.evaluate(evalCtx)` then one `set_entity_assignment` with `p_payload.decision={strategy,chosen_by,rule_id,trace,context}`; NO pre-clear of the 3 columns. (c) WO: `p_entity_kind:'work_order'`, key `buildReassignIdempotencyKey('work_order',id,crid)`; NO raw `.from('work_orders').update`, NO swallowed try/catch; refetch-miss → `notFound`. → FAIL.

- [ ] **Step 2: Implement case-side.** Keep gate (`assertVisible('write')` + `tickets.assign`) + tenant resolution. Replace body from rerun-clear (~1290-1296) through final raw update+routing_decisions+addActivity (~1375-1411): if `dto.rerun_resolver` → build `evalCtx` as today, `routingService.evaluate(evalCtx)` ONCE (no clear), derive `nextTarget` + `decision` from result; else manual `nextTarget` (no `decision` — F7 reason-gated insert audits it). One `set_entity_assignment`: `p_entity_kind:'case'`, key `buildReassignIdempotencyKey('case',id,clientRequestId)`, `p_payload`={assigned_*, reason:dto.reason, actor_person_id:dto.actor_person_id, decision?:<resolver result|omitted>}. `mapRpcErrorToAppError`. Rename `_clientRequestId`→`clientRequestId` (now USED). Delete the standalone recordDecision/routing_decisions.insert/addActivity for this path.

- [ ] **Step 3: Implement WO-side.** Keep `assertAssignPermission` (WO floor `assertCanPlan` by design — P1-4 OUT; add a one-line code comment + `docs/visibility.md` note that floors differ deliberately, P1-4 tracks it). rerun_resolver stays `validationFailed('work_order.rerun_resolver_unsupported')`. Replace the raw manual write block (~978-1050) with one `set_entity_assignment` (`p_entity_kind:'work_order'`, key via `buildReassignIdempotencyKey('work_order',…)`, `p_payload` reason+actor_person_id, no `decision`). Delete the swallowed try/catch routing_decisions+activity inserts. Refetch-miss → `notFound`.

- [ ] **Step 4: Run tests → PASS.**

- [ ] **Step 5: Docs.** `docs/assignments-routing-fulfillment.md`: flip atomic-write-matrix rows for case+WO reassign to "yes (set_entity_assignment v3)"; note rerun_resolver=evaluate-first+`decision`, manual=reason path. `docs/visibility.md`: reassign-floor-asymmetry note (P1-4 deferred).

- [ ] **Step 6: Closure Ledger.** P1-1 row; residual: WO rerun_resolver unsupported (unchanged, documented), P1-4 deferred.

- [ ] **Step 7: lint + commit.**
```bash
pnpm -C apps/api lint && pnpm errors:check-app-errors
git add apps/api docs
git commit -m "fix(audit02 sliceC P1-1): case+WO reassign through v3 — atomic+idempotent (crid now used); manual=reason, rerun_resolver=evaluate-first+decision; no swallowed audit"
```

---

## Slice D — P1-2: routing-evaluation handler fold + case-only contract

**Files:** Modify `routing-evaluation.handler.ts` (~200-294). Test: the handler spec.

- [ ] **Step 1: Failing test.** Handler calls `set_entity_assignment` with `p_payload.clear_routing_status:true` AND `p_payload.decision` (resolver result) and performs NO subsequent raw `.from('tickets').update({routing_status…})` and NO standalone TS `routing_decisions.insert`; non-case resolved entity → fail-closed registered AppError. → FAIL.

- [ ] **Step 2: Implement.** Put `clear_routing_status:true` and `decision` ({strategy,chosen_by,rule_id,trace,context} — allowlist-safe per Slice A) into `p_payload`. Delete the 2nd raw write block (~282-294) + its codex-S11-I1 comment (failure mode now structurally impossible — same tx). Delete the handler's own `routing_decisions.insert` (~246-264) — v3 owns it via `p_payload.decision` (guard fires on decision-present per Fork 2). Add a fail-closed guard asserting the entity is a case before the RPC (F11 proves only case events are produced). Keep `p_entity_kind:'case'`.

- [ ] **Step 3: Run test → PASS.**

- [ ] **Step 4: Docs.** `docs/assignments-routing-fulfillment.md`: handler is **case-only by contract** (5 producers all case/ticket-only per F11 — cite 00354/55/56/57/58), routing_status clear in-tx, routing_decisions owned by v3, WO re-routing a deferred separate future event.

- [ ] **Step 5: Closure Ledger.** P1-2 row.

- [ ] **Step 6: lint + commit.**
```bash
pnpm -C apps/api lint && pnpm errors:check-app-errors
git add apps/api docs
git commit -m "fix(audit02 sliceD P1-2): fold routing_status clear + routing_decisions into v3 (p_payload.clear_routing_status + .decision); fail-closed case-only handler"
```

---

## Slice E — P1-5: `getChildTasks` child work_order visibility filter

**Files:** Modify `ticket-visibility.service.ts` (add `getVisibleWorkOrderIds`), `ticket.service.ts` (`getChildTasks` ~1566-1594). Tests: both specs.

- [ ] **Step 1: Failing test.** `getChildTasks(parentId, requesterUid)` where requester sees the parent case but NOT a child WO (dispatched outside `work_order_visibility_ids`) returns case-visible children MINUS the non-visible child; a `has_read_all` actor still gets all. → FAIL.

- [ ] **Step 2: Implement `getVisibleWorkOrderIds`** in `TicketVisibilityService`, mirroring F13 EXACTLY: `null` if `ctx.has_read_all`; `[]` if no `ctx.user_id`; else `rpc('work_order_visibility_ids',{p_user_id:ctx.user_id,p_tenant_id:ctx.tenant_id})` → string[] with the same row-shape mapping/error handling as `getVisibleIds`.

- [ ] **Step 3: Implement filter** in `getChildTasks`: after the fetch (~1583-1588), if not `ctx.has_read_all`, `const v = await this.visibility.getVisibleWorkOrderIds(ctx)`; when `v !== null` keep only children with `id ∈ v` (bare-array return per F14 ⇒ no count/pagination desync). Replace the "children inherit parent visibility … future 1c.9" comment with one stating children are independently filtered through `work_order_visibility_ids`.

- [ ] **Step 4: Run test → PASS.**

- [ ] **Step 5: Docs.** `docs/visibility.md`: remove text implying child WOs inherit parent-case visibility; document the independent filter; cite that WO visibility intentionally shares the `tickets.read_all` bypass (F12, 00374 comment) — by design, not a leak (resolves audit drift-finding #7).

- [ ] **Step 6: Closure Ledger.** P1-5 row; residual: one extra cheap predicate RPC per `getChildTasks`.

- [ ] **Step 7: lint + commit.**
```bash
pnpm -C apps/api lint && pnpm errors:check-app-errors
git add apps/api docs
git commit -m "fix(audit02 sliceE P1-5): getChildTasks filters children through work_order_visibility_ids — no parent-inheritance leak"
```

---

## Code-review gate + remote push (between Slice E and Slice F)

Per memory `feedback_review_loop_protocol` + the push-after-review sequencing:

- [ ] **CR1:** `/full-review` on the real cumulative diff `git diff origin/main...HEAD` (Slices A–E) — explicitly including the Slice A Step 6 SQL-diff artifact + the Step 7 semantic specs. Self-review first (memory `feedback_self_review_in_long_spec_loops`). Fold findings.
- [ ] **CR2:** codex on the same diff (assignment/RPC/visibility — required, not trivial/frontend). Prompt to `/tmp/codex-audit02-cr.md`, short "Read this file" ARGV (memory `feedback_codex_long_argv_hang`). Fold findings.
- [ ] **CR3 (push authorization):** NO standing push grant for audit-02 (memory grants are portal-scope / booking-modal only). **STOP, ask the user to authorize the remote push.** On approval: push via the psql fallback (project CLAUDE.md), `NOTIFY pgrst, 'reload schema';`, then a smoke query confirming v3 is callable with the new `p_payload` keys AND that a 6-arg call without them still behaves as v2. Rollback = forward-only `create or replace` v4 (never `DROP`).

---

## Slice F — Live smoke + docs + Codex Deep Review close-out

Completion bar requires the fixed paths proven against the live API (post-push).

**Files:** Modify `smoke-work-orders.mjs`, `smoke-tickets.mjs`, `docs/smoke-gates.md`, `docs/follow-ups/audits/02-tickets-work-orders.md`.

- [ ] **Step 1:** Re-read harness conventions (`assertCommandOpRow`, current-row-XOR-sentinel, `ensureTenantBFixture`, dispatch probe, `runCrossTenantProbes`). Reassign assertions use key `reassign:<kind>:<id>:<crid>`; SLA uses `sla:escalation:<timer>:<pct>:<type>`. Domain-event assertions key on `entity_id` NOT `entity_type` (F9).
- [ ] **Step 2:** Probe — case+WO reassign command-op/audit + idempotency replay: seed; `POST /:id/reassign` with crid; assert 2xx + `command_operations.outcome='success'` + a `routing_decisions` row (explicit `entity_kind`) + a `reassigned` activity. Replay same crid → idempotent (cached, no dup rows). Same crid + different `p_payload` (incl. a differing `watchers`/`decision`) → `command_operations.payload_mismatch` (regression guard for codex F16/BLOCKING-2).
- [ ] **Step 3:** Probe — rerun_resolver (case): one resulting assignment; a `routing_decisions` row whose `strategy`/`chosen_by`/`trace` reflect the resolver (NOT `'manual'`); never observed in a transient all-null state; AND a same-assignment rerun that still clears routing_status / records the decision (regression guard for codex BLOCKING-3 / F17).
- [ ] **Step 4:** Probe — SLA escalation reassign: seed near-breach `sla_timers` (psql `session_replication_role='replica'`) with an `escalate` threshold; trigger escalation (service entrypoint or single-tick `due_at` advance). Assert assignment changed, `command_operations.outcome='success'` for `sla:escalation:…`, a `routing_decisions` row, watchers updated atomically AND containing a **person_id** (D-A02-1 regression guard). Re-run tick → idempotent replay. If deterministic clock-advance is infeasible, invoke the service method directly and document why — no silent skip.
- [ ] **Step 5:** Probe — routing-status: after a v3 call with `clear_routing_status`, assert `tickets.routing_status='idle'` + `routing_failure_reason=null` in the SAME state as the assignment.
- [ ] **Step 6:** Probe — getChildTasks cross-visibility: requester + a child WO dispatched outside `work_order_visibility_ids` → excluded; `read_all` actor sees all.
- [ ] **Step 7:** Probe — vendor assignment through v3 end-to-end (`assigned_vendor_id`): command_operations + routing_decisions + assignment landed (smoke-gap #5).
- [ ] **Step 8:** Probe — dispatch replay + payload mismatch + terminal-parent rejection (smoke-gap #8).
- [ ] **Step 9:** Run `pnpm -C apps/api smoke:work-orders` + tickets probes against the running server. :3001 may be shared with concurrent audit-03 — confirm exclusive use / dedicated port first; capture full output; exit 0 required. Red probe → fix code not probe; re-run.
- [ ] **Step 10:** `docs/smoke-gates.md` — add probes to the matrix; honestly state new coverage + residual gaps.
- [ ] **Step 11:** `docs/follow-ups/audits/02-tickets-work-orders.md` — dated Codex Deep Review status flipping P0-2/P1-1/P1-2/P1-5 to CLOSED with evidence (files, migration #, specs, smoke summary); update atomic-write matrix; strike closed smoke-gaps; finalize Closure Ledger incl. verification + explicit residuals/deferrals (P1-3, P1-4, P2-*, cross-id bulk RPC, WO rerun_resolver unsupported, D-A02-1 fixed, R-A02-1, R-A02-2 if any).
- [ ] **Step 12: commit.**
```bash
git add apps/api docs
git commit -m "test(audit02 sliceF): live smoke for SLA escalation, case/WO reassign idempotency+audit, no-op+directive, routing-status, child visibility, vendor, dispatch replay; close P0-2/P1-1/P1-2/P1-5"
```

---

## Review gates

- **Plan-gate: COMPLETE.** `/full-review` (2 adversarial reviewers, 2026-05-18) → 7 findings folded (forks resolved against literal source F1-F15; D-A02-1 discovered; push resequenced; SQL-diff gate added). Codex (2026-05-18) → 3 BLOCKING (function-overload, idempotency-hash escape, no-op-skips-new-work) + 5 importants/nits folded into THIS v3 (mechanism changed to in-place payload-key extension F16/F17/F18; full F2 validator transplant; semantic specs added; concrete user→person lookup). Codex independently verified Fork 2 against source. No remaining BLOCKING. Slice A may begin (subagent-driven).
- **Code-review gate:** CR1/CR2/CR3 above (between Slice E and Slice F) — `/full-review` then codex on the real diff incl. the SQL-diff + semantic specs.
- **Base re-verification before final proof/merge** (memory `feedback_verify_branch_base_shared_tree`): re-check `HEAD...origin/main`, intentional D-files, dup-prefix on origin tree, migration-slot not stolen, on the real final diff.

## Self-review (writing-plans checklist)

1. **Spec coverage:** P0-2→B (+D-A02-1). P1-1 (case manual=reason / rerun_resolver=decision / WO)→C. P1-2→D. P1-5→E. Smoke (SLA escalation, reassign command-op/audit+replay+payload-mismatch, rerun_resolver trace + no-op-with-directive, routing-status, child x-vis, vendor, dispatch replay/mismatch)→F. v3 enabling all→A. crid-now-used→C. Docs sync→every slice. Ledger+Codex section+D-A02-1+R-A02-1/2→B/C/D/E + F11. No prompt finding unmapped.
2. **Placeholder scan:** only the v3 SQL body is non-inlined — authorized override, backed by the SQL-diff gate (Step 6) + semantic specs (Step 7) so it IS reviewable. No "decide during execution" (Slice D resolved). All TS contracts concrete + citation-backed (F1-F18).
3. **Type/contract consistency:** v3 signature is identical to v2 across A/B/C/D (codex BLOCKING-1 fix — NO new params anywhere; behavior carried in `p_payload` keys `watchers`/`decision`/`clear_routing_status` uniformly). `buildReassignIdempotencyKey`/`buildSlaEscalationIdempotencyKey` defined A, consumed B/C/F identically. `getVisibleWorkOrderIds` defined+consumed E. `decision` key only manual-absent / rerun+handler-present — consistent C+D. No "p_watchers param" residue from v2 framing remains.
