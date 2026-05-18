# I2 — sibling `now()`-in-hash on the SLA-install path → spurious 409 on legitimate replay

**Date discovered:** 2026-05-18
**Discovered by:** audit-02 best-in-class continuation `/full-review` (the
same adversarial review that shipped the dispatch fix 00428), independently
verified before routing.
**Disposition:** ROUTED (not folded). User-approved to route — this surface
is the smoke-gated `update_entity_combined` v7 mega-RPC (latest `00427`),
high blast radius; it needs its own full review + smoke cycle, not a fold
into the dispatch slice.
**Owner:** B.2 / SLA-restart path.
**Severity:** replay-ergonomics, NOT data-corruption (identical severity
profile to the now-fixed B.2 dispatch defect).

---

## Summary

This is a genuine NEW sibling bug, **exactly the same idempotency-hash
bug-class** as the B.2 dispatch idempotency-replay defect that was fixed and
shipped 2026-05-18 (migration `00428`,
`docs/follow-ups/audit-02-best-in-class-routing-2026-05-17.md` §5 + its
2026-05-18 closure update).

A call-time `now()`-derived `due_at` is baked into the SLA `timers` payload
on the **work-order PATCH SLA-install path** and the **workflow-engine
SLA-install path**, then folded into the `update_entity_combined`
idempotency hash. Two identical-intent calls (e.g. a retry after a network
blip with the same `X-Client-Request-Id`) compute different `due_at` →
different hash → the replay deterministically raises
`command_operations.payload_mismatch` (HTTP 409) instead of returning the
cached result.

No data corruption: the `command_operations` gate still prevents a duplicate
write. The cost is a spurious 409 on a legitimate retry — the client must
mint a fresh `X-Client-Request-Id` to proceed. Annoying, not corrupting.

## The exact bug class

Server-stamped, non-deterministic `due_at` is part of the hashed
idempotency identity. The fix pattern is the established
`00407`/`00428` one: a path-scoped strip helper that removes `due_at` from
the hashed portion **before** `md5`, while keeping the deterministic SLA
identity fields (`timer_type`, `target_minutes`,
`business_hours_calendar_id`, `sla_id`) in the hash. `timers[].due_at` is
deterministically re-derivable from the already-hashed SLA identity + the
resolved row, so excluding it from the idempotency identity is safe and
correct.

## Verified surface (precise coordinates)

All line numbers verified against the tree as of 2026-05-18.

**Producer (the `now()` source):**
- `apps/api/src/modules/sla/sla.service.ts:219` — `const now = new Date()`
- `apps/api/src/modules/sla/sla.service.ts:236` /
  `apps/api/src/modules/sla/sla.service.ts:250` —
  `due_at: ...toISOString()` (business-hours-adjusted)

**Consumers (where the `now()`-stamped `timers` enters the hashed payload):**
- `apps/api/src/modules/work-orders/work-order.service.ts:584` — assigned;
  `:589` — placed on `patches.sla.timers` (the **work-order PATCH
  SLA-install** path)
- `apps/api/src/modules/workflow/workflow-engine.service.ts:1907` — the
  **workflow-engine SLA-install** path

**Where it gets hashed:**
- `update_entity_combined` v7 — latest definition
  `supabase/migrations/00427_update_entity_combined_v7_satisfaction.sql:241-245`:
  `v_payload_hash := md5(coalesce(p_patches::text,'') || '|' || coalesce(p_activity_source,''))`.
  SLA branch reads `p_patches->'sla'->'timers'`
  (`00427`:225, `00427`:434-441).
- Inner `update_entity_sla` — latest definition
  `supabase/migrations/00330_*.sql:115` — also affected via the
  `update_entity_combined` → `update_entity_sla` delegation. Direct callers
  of `update_entity_sla` are affected the same way.

## Phantom clarification — the CASE path is NOT affected

The originally-flagged `PATCH /tickets/:id` **case** SLA path is **NOT**
affected and must not be "fixed":

- `buildPatchesPayloadForCase` never emits an `sla` branch — case SLA is
  immutable (`apps/api/src/modules/ticket/ticket.service.ts:1252-1255`).
- There is no `buildTimersForRpc` call on the case path.

Verified. The fix must be scoped to the WO + workflow-engine SLA-install
paths only; touching the case path would be churn against a surface that
has no `timers` payload.

## Why it's reachable by a real replay

The work-order PATCH path uses a **stable** idempotency key:
`apps/api/src/modules/work-orders/work-order.service.ts:470` →
`packages/shared/src/idempotency.ts:65`. An identical-intent retry (same
`X-Client-Request-Id`) recomputes a new `due_at` (`now()` advanced) →
different `p_patches` text → different `md5` → spurious
`command_operations.payload_mismatch` 409. This is the same reachability
profile as the dispatch defect — not a theoretical race.

## Fix prescription

Apply the **same `00407`/`00428` pattern**:

- Path-scope-strip `due_at` from the hashed portion:
  - `update_entity_combined`: strip `p_patches.sla.timers[].due_at` before
    the `md5` (a path-scoped recursive strip helper, NOT a flat/neutered
    strip — preserve any non-`timers` `due_at`).
  - `update_entity_sla` direct callers: strip `p_payload->timers[].due_at`
    on the equivalent inner hash.
- Keep `timer_type` / `target_minutes` / `business_hours_calendar_id` /
  `sla_id` in the hash identity (they ARE part of the intent — a genuine
  SLA-config change must still fail-closed, exactly as 00428's I1 accepted
  non-goal for the dispatch path).
- Reproduce the affected RPC bodies **VERBATIM from the verified-latest
  definitions** (`00427` for `update_entity_combined`, `00330` for
  `update_entity_sla`) with ONLY the `v_payload_hash` line re-pointed.
  Byte-diff to prove exactly one changed line per function. **Do NOT
  reproduce from an older on-disk migration** — `create or replace` is
  last-writer-wins; reproducing from a stale source silently clobbers every
  intervening fix (this exact stale-source-clobber near-miss, "C1", was
  caught in review during the dispatch fix; do not repeat it).
- Claim the migration number at write time per
  `feedback_migration_number_collision` (parallel workstreams claim slots
  concurrently — `ls supabase/migrations/ | tail -5` immediately before
  authoring; do not bake a number into TS comments).
- Add a runnable structural guard mirroring
  `apps/api/src/modules/ticket/dispatch.idempotency.spec.ts` /
  `assemble-edit-plan.idempotency.spec.ts` (static migration-text scan:
  resolve the numerically-highest migration defining the RPC, assert the
  hash routes through the strip helper, assert path-scoped not flat/identity).
  Verify it goes red on a regression before shipping
  (`feedback_runnable_guards_mandate`).

## Required review cycle (do NOT short-cut)

`update_entity_combined` v7 is the smoke-gated mega-RPC (latest `00427`) —
high blast radius (it is on the `pnpm smoke:tickets` gate and is reached by
the bulk-update, satisfaction, plan, reassign, and SLA branches). The fix
must go through the full cycle:

1. **codex pre-impl design-check** — scope the strip to the SLA branch
   only; confirm no other branch's hash identity changes; confirm
   backward-compat for every `update_entity_combined` + `update_entity_sla`
   caller.
2. **`/full-review`** (2 adversarial agents) — hunt for the stale-source
   clobber, an over-broad strip that weakens a genuine-change 409, and any
   caller whose hash identity shifts.
3. **codex tertiary** — final GO/NO-GO.
4. **Smoke:** `pnpm smoke:tickets` (the gate for `update_entity_combined`
   v7 — see `docs/smoke-gates.md` + `CLAUDE.md` Smoke gates matrix) +
   `pnpm smoke:work-orders` (the WO PATCH SLA-install path). Run the final
   tickets gate in **isolation** — `smoke-tickets` has a documented
   FLAKE_INFRA characterization (client-side `fetch failed`/`ECONNRESET`)
   when run interleaved with concurrent shared-DB load; it is 5/5 green in
   isolation. Do not add a `smoke-tickets` carve-out for that flake — it is
   green isolated; weakening it would be fake-green.

## Blast-radius warning

`update_entity_combined` v7 carries: the P0-1 bulk-update path, the P1-3
satisfaction fold, the plan branch, the reassign metadata branch, and the
SLA branch. A bad strip helper or a verbatim-reproduction error here
reverts audit-02 P1-3 + every B.2.A SLA/plan/satisfaction guarantee in one
`create or replace`. This is precisely why the audit-02 dispatch fix was
scoped to the dispatch RPCs only and I2 was routed rather than folded — the
SLA-install fix is a separate, carefully-reviewed change against a far
larger surface. Treat the verbatim-reproduction discipline + byte-diff
proof as non-negotiable.

## Risk if unfixed

Spurious `command_operations.payload_mismatch` (HTTP 409) on legitimate
work-order PATCH SLA-install retries and workflow-engine SLA-install
retries that reuse a stable `X-Client-Request-Id` (e.g. a client retry
after a network blip; a workflow resume re-running the same node).
Correctness/ergonomics only — **no data corruption** (the
`command_operations` gate still prevents a duplicate write; the safety
invariant holds). Workaround for an affected caller: mint a fresh
`X-Client-Request-Id`. Not P0/P1.

## Cross-references

- Sibling (FIXED) defect:
  `docs/follow-ups/audit-02-best-in-class-routing-2026-05-17.md` §5 + its
  `#### Update — 2026-05-18` closure block (migration `00428`).
- This item is row #7 in that doc's "Summary for owners" table.
- Closure ledger context (append-only):
  `docs/follow-ups/audits/02-tickets-work-orders.md`
  `#### Update — 2026-05-18 — B.2 dispatch idempotency-replay FIXED (00428)
  + C1 caught + I2 routed`.
- Fix pattern reference: `supabase/migrations/00407_booking_edit_idempotency_intent_hash.sql`
  and `supabase/migrations/00428_dispatch_idempotency_intent_hash.sql`
  (path-scoped strip helper + `*_idempotency_payload_hash`).
