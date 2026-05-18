# I3 — `set_entity_assignment` idempotency-key/payload-drift on an assignment-changing routing-eval retry → wrong `auto_routing_failed` audit + missing success breadcrumb

**Date discovered:** 2026-05-18
**Discovered by:** the codex tertiary adversarial gate run on **Code-I1**
(the routing-eval handler `routing_decisions` non-idempotency fix, migration
`00429`). codex tertiary returned NO-GO on Code-I1 citing "item 3"; that
finding was then independently verified by reading the handler control flow.
**Disposition:** ROUTED (not folded). **User-approved** — the user
explicitly chose "Ship Code-I1 + route item 3" after the verification below.
**Owner:** B.2 / `set_entity_assignment` + routing-evaluation handler.
**Severity:** audit-integrity / ops-confusion — **NO wrong assignment, NO
data corruption**. Pre-existing. Not P0/P1 (same class/severity reasoning as
the original Code-I1 dup-audit-row).

---

## Summary

On the **outbox routing-evaluation handler path**, an
**assignment-CHANGING** `routing.evaluation_required` event whose first
delivery commits the assignment but then fails the post-RPC success audit
insert (or is plainly redelivered after a successful first delivery) hits a
**payload-shape drift across the retry**. The handler's
`set_entity_assignment` idempotency key is **stable across redeliveries**
(`routing-evaluation:<event.id>` — `event.id` is invariant), but the
`p_payload` it sends on the retry is **structurally different** (the
`assigned_*_id` keys are omitted because the ticket now already matches the
resolved target). `set_entity_assignment`'s `command_operations` gate keys
on `(tenant_id, idempotency_key)` and compares `payload_hash =
md5(p_payload::text)` → **same key, different payload hash** → it raises
`command_operations.payload_mismatch`.

The handler treats `rpcRes.error` as a routing failure: it calls
`markRoutingFailure` and `return`s **before** the §6 success audit insert.
Net outcome: **the assignment was correctly applied on the first delivery,
but the audit trail now records a `routing_status='failed'` ticket, a
`routing_evaluation_failed` activity breadcrumb, and an `auto_routing_failed`
`routing_decisions` row — and the success `routing_decisions` breadcrumb is
permanently missing.** The data (the assignment) is correct; the audit
record lies.

This is **not** the now()-in-hash bug-class of #5 (dispatch, fixed by
`00428`) or #7 (I2, SLA-install). It is a distinct **payload-shape-drift
across an `applyAssignment` flip** mechanism that shares only the broad
"server recomputes a non-stable component of the idempotency identity on
retry" family.

## The exact mechanism (verbatim)

On first delivery of an assignment-CHANGING `routing.evaluation_required`
event, the handler computes
`applyAssignment = target!==null && !targetMatchesCurrent(...)` and sends
`set_entity_assignment` a payload INCLUDING `assigned_*_id` keys, idempotency
key `buildRoutingEvaluationIdempotencyKey(event.id)`. If the RPC commits the
assignment but the §6 success audit insert then throws → the handler throws
→ outbox retries. On retry the ticket NOW matches the resolved target →
`applyAssignment` flips FALSE → payload becomes `{clear_routing_status:true}`
ONLY (`assigned_*` omitted) → SAME idempotency key, DIFFERENT `p_payload` →
`set_entity_assignment`'s `command_operations` gate (keys
`(tenant_id, idempotency_key)`, compares `payload_hash = md5(p_payload::text)`)
raises `command_operations.payload_mismatch` → handler `if (rpcRes.error)`
→ `markRoutingFailure` + `return` BEFORE the §6 success audit insert.
Result: the assignment WAS correctly applied, but the audit trail records an
`auto_routing_failed` row and the success `routing_decisions` breadcrumb is
permanently missing. Same exposure for a plain outbox redelivery of an
assignment-changing event whose first delivery applied the assignment.

## Precise coordinates

Brief-supplied approximate coordinates were verified against the tree as of
2026-05-18. The handler grew slightly vs. the brief's estimate; **both the
brief's stated ranges and the verified-exact line numbers are recorded**.

**Handler — `apps/api/src/modules/outbox/handlers/routing-evaluation.handler.ts`:**

| What | Brief estimate | Verified-exact (2026-05-18) |
|---|---|---|
| `applyAssignment` + conditional `assigned_*` payload | ~L256-263 | **L296-302** (`const applyAssignment = target !== null && !this.targetMatchesCurrent(target, ticket)` L296; `payload` built L297-302) |
| `set_entity_assignment` call + idempotency key | ~L265-278 | **L304-317** (`const idempotencyKey = buildRoutingEvaluationIdempotencyKey(event.id)` L304; `this.supabase.admin.rpc('set_entity_assignment', …)` L305-317) |
| `rpcRes.error` → `markRoutingFailure` → `return`, BEFORE the §6 success audit insert | ~L280-294 | **L319-333** (`if (rpcRes.error) { … markRoutingFailure(…); … return; }`); the §6 success audit insert begins **L336+** |
| idempotency-key helper | — | **L90-94** (`ROUTING_EVALUATION_IDEMPOTENCY_KEY_PREFIX = 'routing-evaluation'`; key = `routing-evaluation:<event.id>` — stable across redeliveries) |
| `markRoutingFailure` body (the wrong audit it writes) | — | **L479+** — sets `routing_status='failed'`, a `ticket_activities` row with `metadata.event='routing_evaluation_failed'`, and a `routing_decisions` row with `chosen_by='auto_routing_failed'` |

**RPC gate — `supabase/migrations/00425_set_entity_assignment_v3_clear_routing_status.sql`:**
- Brief cited `:149`. Verified: `:150` is
  `v_payload_hash := md5(coalesce(p_payload::text, ''))`; the surrounding
  `command_operations` idempotency gate (keyed on
  `(tenant_id, idempotency_key)`, comparing the payload hash) is the §3
  block at `:149-156`. (The `:149` line is that block's comment header
  `-- ── 3. command_operations idempotency gate (00316) ──`; the `md5`
  itself is `:150`. Functionally exactly as the brief described.)

## Why it is NOT a Code-I1 regression (pre-existing, orthogonal — verified by reading the handler)

This was verified by reading
`routing-evaluation.handler.ts` L256-294 (and the surrounding L248-333) on
the post-Code-I1 tree:

- The cited control flow — `applyAssignment` computation, the conditional
  `assigned_*` payload, the `set_entity_assignment` call with the
  `routing-evaluation:<event.id>` idempotency key, and the
  `if (rpcRes.error) { markRoutingFailure(...); return; }` that returns
  **before** the §6 success audit insert — is **ENTIRELY PRE-EXISTING**.
  None of it was introduced or moved by Code-I1.
- **Code-I1's scope was strictly the §6 success `routing_decisions` insert
  and the `markRoutingFailure` `routing_decisions` insert** — it converted
  those two supabase-js `.insert()` calls to raw parameterised
  `this.db.query(... ON CONFLICT (tenant_id,(context->>'outbox_event_id'),
  chosen_by) WHERE context ? 'outbox_event_id' DO NOTHING ...)` against the
  new partial unique index `uq_routing_decisions_outbox_event` (00429), and
  it **preserved** the genuine-error-throw trigger on the §6 success path
  (a real DB error there still THROWS the handler so the outbox retry
  contract is intact). Code-I1 did **not** touch `applyAssignment`, the
  payload construction, the `set_entity_assignment` call, the idempotency
  key, or the `rpcRes.error → markRoutingFailure → return` branch.
- Therefore item 3 (I3) exists **IDENTICALLY before and after Code-I1** —
  it is **NOT introduced or worsened** by the Code-I1 change. It is a
  separate defect in the `set_entity_assignment` idempotency-key /
  payload-stability **design**, orthogonal to the `routing_decisions`-dup
  that Code-I1 scopes and closes.
- The codex-tertiary NO-GO on Code-I1 citing "item 3" was therefore a
  **mis-scoped** verdict — it flagged a pre-existing, orthogonal defect as
  a blocker on an unrelated fix. Code-I1 shipped (00429, live-verified,
  smoke 3×); I3 is routed here for its own cycle. The user explicitly chose
  **"Ship Code-I1 + route item 3."**

## Why it is reachable by a real retry / redelivery

- The handler's `set_entity_assignment` idempotency key is
  `routing-evaluation:<event.id>` and `event.id` is **stable across outbox
  redeliveries and `sweepStaleClaims` re-claims** (the same property that
  makes Code-I1's `context.outbox_event_id`-keyed partial index work). So a
  retry necessarily reuses the same key.
- An assignment-CHANGING first delivery flips the ticket so it **now
  matches** the resolved target. Any second delivery (a §6-success-throw
  retry, a `sweepStaleClaims` re-claim, a multi-replica double-drain, or a
  plain at-least-once redelivery) recomputes `applyAssignment = FALSE` →
  the `assigned_*` keys are omitted → a structurally different `p_payload`
  → `md5` mismatch → `command_operations.payload_mismatch`.
- This is the same "stable key + server-recomputed non-stable identity
  component" reachability profile as the dispatch defect (#5) and I2 (#7) —
  not a theoretical race. It does NOT require a crash: a plain redelivery
  of an assignment-changing event is sufficient.

## Risk if unfixed

On a partial-commit retry or a plain redelivery of an **assignment-CHANGING**
`routing.evaluation_required` event, the assignment is **correctly applied**
(the RPC committed on the first delivery; `command_operations` prevents a
double-apply), but the audit trail wrongly records
`routing_status='failed'`, a `routing_evaluation_failed` activity, and an
`auto_routing_failed` `routing_decisions` row, and the success
`routing_decisions` breadcrumb is permanently missing. **Audit-integrity /
ops-confusion only — NO wrong assignment, NO data corruption.**
Pre-existing; not P0/P1 (identical severity profile to the original
Code-I1 dup-audit-row, which was itself re-deferred-then-closed at non-P0).

## Candidate fix approaches (for the owner — pick one in design-check)

Make the routing-eval → `set_entity_assignment` idempotency **stable across
a retry / redelivery of an assignment-changing event**:

- **(a) Payload-independent idempotency identity.** Key/hash the
  `command_operations` gate on a payload-INDEPENDENT *intent* (the resolved
  target identity), not the `applyAssignment`-conditional payload shape.
  Mirrors the strip-helper philosophy of `00407`/`00428`/I2 (exclude the
  non-stable component from the hashed identity) but applied to the
  *payload-shape* dimension rather than a `now()` field.
- **(b) Deterministic handler payload.** Make the handler payload
  deterministic regardless of current assignment state — always send the
  resolved `assigned_*` keys and rely on `set_entity_assignment`'s existing
  no-op fast path (00327:189-191 key-absent / matches-current) for the
  "already matches" case. This keeps `md5(p_payload::text)` stable across
  the `applyAssignment` flip. (Care: must not regress the v5/I4 invariant
  that an `unassigned` resolver outcome must NOT wipe a standing assignee —
  an `unassigned` target must still OMIT the keys, so this option needs the
  `unassigned` case handled explicitly.)
- **(c) RPC-internal audit.** Write the success `routing_decisions`
  breadcrumb in the **same atomic unit** as the assignment (move the audit
  insert inside `set_entity_assignment`) so a post-RPC audit failure can
  never desync the audit trail from the committed assignment, removing the
  retry-with-flipped-payload path entirely.

Whichever is chosen must preserve: the v5/I4 "unassigned must not wipe a
standing assignee" invariant; the audit-02 P1-2 atomic `clear_routing_status`
fold; the audit-02 P2-2 explicit `entity_kind='case'`/`case_id` at the
insert site; and the Code-I1 `ON CONFLICT DO NOTHING` idempotency on the
`routing_decisions` insert (00429).

## Required review cycle (do NOT short-cut)

`set_entity_assignment` is a smoke-gated canonical assignment RPC reached by
reassign (case + WO), SLA-escalation reassign, and the routing-eval handler
— high blast radius. The fix must go through the full cycle, exactly as
Code-I1 / 00428 did:

1. **codex pre-impl design-check** — pick (a)/(b)/(c); confirm no other
   `set_entity_assignment` caller's idempotency identity changes; confirm
   the v5/I4 + P1-2 + P2-2 + Code-I1 invariants above are preserved.
2. **`/full-review`** (2 adversarial agents) — hunt for an idempotency
   identity that is now too loose (a genuine intent change replaying as a
   cache hit) or still too tight (the flip still drifts), and for any
   `set_entity_assignment` caller whose hash identity shifts.
3. **codex tertiary** — final GO/NO-GO.
4. **Smoke:** `pnpm smoke:tickets` (the gate for the routing-evaluation
   handler / `set_entity_assignment` per `docs/smoke-gates.md` +
   `CLAUDE.md`). Add a probe that **redelivers an assignment-changing
   `routing.evaluation_required` event** and asserts the success
   `routing_decisions` breadcrumb is present and NO `auto_routing_failed`
   row was written. Run the final tickets gate in **isolation** —
   `smoke-tickets` has a documented FLAKE_INFRA characterization under
   concurrent shared-DB load (green in isolation; do NOT add a carve-out —
   weakening it would be fake-green).

If a migration is needed (approaches (a) or (c)), claim the migration
number at write time per `feedback_migration_number_collision`
(`ls supabase/migrations/ | tail -5` immediately before authoring; do not
bake a number into TS comments) and reproduce any altered RPC body
**VERBATIM from the verified-latest definition** with a byte-diff proof of
exactly the changed lines (the `create or replace` last-writer-wins
stale-source-clobber near-miss "C1" was caught in review during the
dispatch fix; do not repeat it).

## Cross-references

- Origin: codex-tertiary NO-GO "item 3" on **Code-I1** (CLOSED by migration
  `00429` — `docs/follow-ups/audits/02-tickets-work-orders.md` Closure
  Ledger + `#### Update — 2026-05-18 — Code-I1 CLOSED (00429) + I3 routed`).
- This item is row **#8** in
  `docs/follow-ups/audit-02-best-in-class-routing-2026-05-17.md`
  "Summary for owners".
- Sibling idempotency-key-stability follow-ups (different mechanisms, same
  broad family): `docs/follow-ups/i2-sla-install-idempotency-due_at-2026-05-18.md`
  (#7, now()-in-hash on the SLA-install path) and the FIXED dispatch defect
  (#5, `00428`).
- Living contract for the handler: `docs/assignments-routing-fulfillment.md`
  §3.9.3 (`RoutingEvaluationHandler`) — the Code-I1 idempotency note added
  there documents the `routing_decisions`-insert idempotency; this I3
  defect concerns the *upstream* `set_entity_assignment` idempotency
  identity and is intentionally NOT folded into that note (it is a separate
  routed item).
