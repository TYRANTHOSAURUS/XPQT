# audit-02 best-in-class pass — cross-session items ROUTED (not absorbed)

**Date:** 2026-05-17
**Author:** audit-02 best-in-class continuation workstream (isolated worktree
`worktree-audit-02-best-in-class` off `origin/main` 34f82c0a).

These items surfaced during the audit-02 best-in-class pass but are **owned by
other workstreams**. They are routed here with evidence + owner + exact action.
audit-02 deliberately did NOT absorb them (doing so would rubber-stamp
unreviewed concurrent changes or perform cross-session-unsafe renumbers).

---

## 1. PR#16 / `origin/main` 34f82c0a CI is RED — corrected attribution

**The continuation brief stated the merge CI is RED on "B.2 config-reads",
caused by a concurrent workflow-phase1.5 change to
`workflow-engine.service.ts` lacking a `.b2-config-reads-allowlist.txt`
update, and instructed: do NOT regenerate the allowlist from audit-02.**

**Verified — that premise does NOT hold (evidence below). Do NOT regenerate
the allowlist: not because audit-02 must avoid it, but because there is
nothing to regenerate — the B.2 check is GREEN.**

Evidence (read-only, against `origin/main` 34f82c0a + audit-02's two commits):

- `bash scripts/check-b2-config-reads.sh` (= `pnpm b2:check-config-reads`,
  the exact CI step at `.github/workflows/ci.yml:55-61`) → **`B.2
  config-reads check: OK (30 entries)`, exit 0**. The committed allowlist
  `apps/api/src/modules/.b2-config-reads-allowlist.txt` matches current
  config-reads. The workflow-phase1.5 commits to `workflow-engine.service.ts`
  that ARE on this HEAD (`aab4f267`, `2a5f1af3`) did not break it.
- Actual failing CI jobs on merge commit `34f82c0a`
  (`gh api .../commits/34f82c0a/check-runs`):
  - **Design check + typecheck** — failure
  - **B.0 concurrency harness (advisory-lock RPCs)** — failure
  - **Migration smoke (db:reset + invariants)** — failure
  - **Deploy api (Render)** — failure
  - Validate (typecheck + build) — success · Deploy web (Vercel) — success
  - There is no "B.2 config-reads" job in the failure set.

**Routing of the ACTUAL red checks:**

| Red check | Most likely cause | Owner | Action |
|---|---|---|---|
| **Migration smoke (db:reset + invariants)** | The live duplicate-migration-prefix epidemic (§2 below). `pnpm db:reset` replays ALL migrations locally; duplicate/again-numbered prefixes break ordered apply + invariants. | integrator / data-model (verdict **blocker #8** / **P2-3**) | Historical renumber + `scripts/check-migration-prefix-unique.sh` CI guard. **Not audit-02's** (cross-session-unsafe to renumber from one worktree; audit-02's RPC bodies are codex-verified correct on remote — §3). |
| **Design check + typecheck** | Concurrent-workstream typecheck/design-polish breakage on main (fails in ~15s). audit-02's own slices are individually `tsc` + design-polish + `errors:check-app-errors` green (verified per commit aac61b7a / 53ea0c66). | whichever concurrent workstream's change broke main typecheck/design | Bisect main for the breaking commit; not audit-02. |
| **B.0 concurrency harness (advisory-lock RPCs)** | B.0 workstream surface (advisory-lock RPC harness) — unrelated to tickets/work-order. | B.0 workstream owner | Investigate B.0 harness; not audit-02. |
| **Deploy api (Render)** | Downstream of the above (build/migration failures) or infra. | infra / release owner | Re-evaluate after the migration-smoke + typecheck reds clear. |

**audit-02 is demonstrably not the cause of any of these** — its changes are
TS-only + two RPC migrations whose remote function bodies are codex-verified
backward-compatible for all callers (§3), and every audit-02 slice passes
`tsc` / `errors:check-app-errors` / design-polish / `b2:check-config-reads`
locally.

---

## 2. P2-3 — duplicate migration prefixes (LIVE, severe) → integrator/data-model

Already owned (verdict **blocker #8**, audit-02 ledger **P2-3**). Fresh
evidence as of 2026-05-17 — the collision is an **epidemic**, not isolated:

```
DUP prefixes on origin/main: 00367 00368 00369 00370 00371 00372 00373
                             00374 00376 00400 00406   (+ brief notes 00407 triple)
e.g. 00406_set_entity_assignment_v3_clear_routing_status.sql   (audit-02)
     00406_room_booking_rule_with_workflow_rpcs.sql            (other workstream)
```

- **Owner:** integrator / data-model migration owner.
- **Action:** historical renumber of the colliding files + a
  `scripts/check-migration-prefix-unique.sh` CI guard (the highest-leverage
  cheap fix; recommended in the verdict).
- **audit-02 self-mitigation (done):** its own `00406`/`00410` were
  unique-at-claim relative to each other; both pushed to remote; **codex Q1/Q2
  verified the remote function bodies are correct + backward-compatible for
  all callers** (the on-disk prefix collision does NOT mean the wrong body is
  on remote — the correct `set_entity_assignment` v3 / `update_entity_combined`
  v7 bodies were verified via `pg_get_functiondef`). The renumber is purely an
  on-disk / `db:reset` hygiene fix owned by the data-model owner.
- **Coupling:** the **Code-I1 prescription** (audit-02 ledger §2026-05-17) is
  also a DB-push-window item and MUST claim its migration number at write
  time per the collision protocol — bundle it with this renumber window.

---

## 3. audit-02 RPC surface is codex-clean (context for the owners above)

So owners don't re-investigate: codex tertiary review (2026-05-17, Q1–Q4)
confirmed `00406` v3 + `00410` v7 are **safe-as-merged for every current
caller**; reassign/bulkUpdate/getChildTasks clean; Code-I1 re-defer correct.
The only follow-ups are the registration NIT (folded, commit 53ea0c66) and a
forward-only `comment on function` correction on `00410` (no migration push
solely for a comment). The migration-smoke CI red is the prefix collision
(§2), NOT a bad audit-02 RPC body.

---

## 4. P1-5 FE follow-up — `SubIssueProgress` under-reports → FE workstream

- **What:** after P1-5 (`getChildTasks` filters children through
  `work_order_visibility_ids`), `apps/web/src/components/desk/ticket-meta-row.tsx`
  (`SubIssueProgress`) + `sub-issues-section.tsx` compute `done/total` + the
  ratio bar directly from `GET /tickets/:id/children`, which now legitimately
  under-reports for scoped-out actors (e.g. "1/1 done" while the parent is
  still open, because the actor can't see the other children). Safe (no leak)
  but misleading.
- **Owner:** FE workstream (the continuation brief explicitly said don't mix
  FE into the RPC slices).
- **Action (pick one):** (a) move the rollup server-side as a privileged count
  (return `done/total` computed with `read_all`, decoupled from the
  visibility-filtered child list), OR (b) label/suppress the badge for
  non-privileged actors ("partial view"). Option (a) is preferred — it keeps
  the badge meaningful for everyone without leaking the child rows.
- **Not absorbed here:** audit-02 is RPC/visibility scope; this is a FE
  presentation fix. Tracked in audit-02 ledger P1-5 row + this doc.

---

## 5. Pre-existing B.2 dispatch idempotency-replay defect → B.2 / dispatch owner

**Discovered 2026-05-18 by the audit-02 dispatch-replay probe re-run against
the actual merged `origin/main` (4c4ba587 = post-PR#20).** This is exactly
what a live-smoke gate is for — it caught a real-DB defect that unit tests +
code review miss. NOT audit-02's, NOT this continuation's, NOT a PR#20 *code*
regression — a latent B.2/dispatch defect that PR#20-era shared SLA-config
data flipped from dormant to active.

**Root cause (confirmed, not theorised):**
- `supabase/migrations/00341_dispatch_child_work_order_v3.sql:153` —
  `v_payload_hash := md5(coalesce(p_payload::text, ''))` hashes the **entire**
  payload with **no server-stamped-field stripping**.
- `apps/api/src/modules/ticket/dispatch.service.ts:309` includes `timers` in
  that payload; `timers[].due_at` is **call-time `now()`-derived**
  (business-hours-adjusted, lines 255-265 / `SlaService.buildTimersForRpc`).
- When the dispatched child resolves an SLA (tenant A has **9 sla_policies**),
  two sequential identical dispatch calls compute different `due_at` →
  different `md5(p_payload)` → the replay deterministically raises
  `command_operations.payload_mismatch` (HTTP 409) instead of returning the
  cached 201. Reproduced **3/3 deterministically**.
- **Dormant→active:** pre-PR#20 the probe's minimal team-only dispatch
  resolved to *no* SLA on the older shared-DB state (no `timers` → stable
  hash → 3× green); concurrent SLA-config changes on the shared remote now
  resolve an SLA for it.

**Severity: replay-ergonomics, NOT data-corruption.** The safety invariant
holds — deterministic `child_id = uuidv5(idempotency_key)`
(`dispatch.service.ts:291`) + the `command_operations` gate ⇒ **no duplicate
work_order** (hard-asserted, ✓ 3/3). A client retrying an identical dispatch
after a network blip gets a spurious 409 (must mint a fresh
X-Client-Request-Id to proceed) — annoying, not corrupting.

**Owner:** B.2 / dispatch subsystem owner (the `dispatch_child_work_order`
RPC + `DispatchService` idempotency-hash design — same area as B.2 spec
§3.4). NOT integrator/data-model, NOT audit-02.

**Fix prescription (proven pattern — PR#20 already did this for booking-edit):**
mirror `00407_booking_edit_idempotency_intent_hash.sql`'s
`booking_edit_strip_hash_server_fields` / `booking_edit_idempotency_payload_hash`:
add a `dispatch_idempotency_payload_hash(jsonb)` that strips the
non-deterministic server-stamped fields (`timers`, and any `due_at`) before
`md5`, and re-point 00341's `v_payload_hash := …` to it. (`timers` is
deterministically re-derivable from the already-hashed `sla_id` + resolved
row, so excluding it from the idempotency identity is safe and correct.)
Same DB-push-window + design-review constraints as the Code-I1 prescription —
do NOT hot-push into the active duplicate-prefix epidemic; bundle with the
P2-3 renumber window.

**Probe disposition (no-fake-green):** `smoke-work-orders.mjs` probe 8 now
hard-asserts the audit-02-relevant invariant (replay creates **no duplicate
work_order** + `command_operations` outcome=success) and downgrades only the
out-of-scope stricter "replay returns the cached id" sub-assertion to an
explicit, evidenced `[KNOWN-DEFECT b2-dispatch-replay-sla-due_at]` carve-out
(neither pass nor fail, loudly logged, fingerprint-scoped to exactly
`d1 2xx+id` ∧ `d2==409 payload_mismatch` — any other failure still hard-reds).
This mirrors the adversarially-validated SLA `CONTENTION-DEFER` mechanic; it
does not hide the defect (logged + routed + ledgered).

#### Update — 2026-05-18 — item #5 RESOLVED by migration 00428

The pre-existing B.2 dispatch idempotency-replay defect routed above is
**RESOLVED**. Closure evidence (the original §5 narrative + the table row
below are left intact — this is appended, not rewritten):

- **Fix on remote:** `supabase/migrations/00428_dispatch_idempotency_intent_hash.sql`
  pushed to the shared remote 2026-05-18 + `pg_get_functiondef`-verified
  live. Applies exactly the §5 fix prescription: a path-scoped
  `dispatch_strip_hash_server_fields(jsonb)` (strips `due_at` ONLY from
  elements of a key literally named `timers`, so an arbitrary
  `routing_context.due_at` is preserved) + `dispatch_idempotency_payload_hash(jsonb)`
  = `md5(coalesce(strip(p)::text,''))`, with both dispatch RPCs reproduced
  VERBATIM from the **verified-latest v3** sources (`00341` single,
  `00342` batch) and ONLY the `v_payload_hash` line re-pointed. Mirrors the
  `00407` booking-edit pattern as prescribed.
- **Caught regression (C1):** the batch RPC was initially reproduced from
  the STALE `00337` v1; because `create or replace` is last-writer-wins and
  00428 is numerically last, that would have silently clobbered `00342`
  v3's F-IMP-1 per-task `routing_rule_id` tenant-validate (a P0 cross-tenant
  guard) + F-CRIT-1 `sla_timers` polymorphic columns. Caught by
  `/full-review`, re-based on `00342` v3, live-verified preserved. (The §5
  prescription's "bundle with the P2-3 renumber window" caveat was honored
  in spirit by re-basing on the verified-latest body rather than a stale
  on-disk file.)
- **Probe carve-out removed — strict hard gate restored:** the
  `[KNOWN-DEFECT b2-dispatch-replay-sla-due_at]` carve-out in
  `smoke-work-orders.mjs` probe 8 (described in §5 "Probe disposition") is
  **removed**. Replay now MUST return 200/201 same WO id; replay
  `payload_mismatch` is a hard fail. Proven GREEN 3/3 deterministic with
  fresh isolated fixtures.
- **Runnable guard added:**
  `apps/api/src/modules/ticket/dispatch.idempotency.spec.ts` (static
  migration-text scan, mirrors 00407's guard; 4/4; demonstrably catches the
  C1 stale-source-clobber class).
- Review chain: codex pre-impl design-check → `/full-review` (2 agents) →
  codex tertiary, all GO-WITH-CHANGES (folded); lint +
  `errors:check-app-errors` green. Closure ledgered append-only in
  `docs/follow-ups/audits/02-tickets-work-orders.md` (2026-05-18 block +
  ledger row).

**Owner action on this item: none remaining — CLOSED.** The §5 routing was
correct and is now discharged.

## Summary for owners

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | PR#16 CI red — **NOT** B.2 config-reads (that's green); real reds = design/typecheck, B.0 harness, migration-smoke, Render deploy | per-check (table §1) | Routed w/ corrected attribution |
| 2 | Duplicate migration prefixes (11+ live, incl. 00406) | integrator / data-model | Owned (blocker #8 / P2-3); evidence refreshed |
| 4 | `SubIssueProgress` under-reports post-P1-5 | FE workstream | Routed w/ fix options |
| 5 | Pre-existing dispatch replay → spurious 409 when child resolves an SLA (server-stamped `timers.due_at` in the md5 idempotency hash) | B.2 / dispatch owner | Discovered by audit-02 gate; routed w/ confirmed root cause + 00407-pattern fix prescription; probe carve-out (safety still hard-asserted) |
| 6 | PR#20 merge dropped audit-02's `ticket.work_order_id_on_case_endpoint` runtime-array registration | this continuation (fixing) | Restored on `audit-02-pr20-reconcile-fix`; tsc/errors:check green |
| 7 | **I2** — sibling now()-in-hash on the WO + workflow-engine SLA-install path via `update_entity_combined` v7 (`sla.service.ts:219`→`work-order.service.ts:584`/`workflow-engine.service.ts:1907`, hashed @ `00427`:241-245 / `00330`:115). NOT the case path (verified phantom). Same bug-class as #5 (now fixed by 00428) | B.2 / SLA-restart path | Discovered by audit-02 `/full-review`, independently verified, **user-approved to ROUTE not fold** (smoke-gated mega-RPC, high blast radius). Precise coords + 00407-pattern fix prescription + required review cycle in `docs/follow-ups/i2-sla-install-idempotency-due_at-2026-05-18.md`. Risk if unfixed: spurious 409 on legitimate WO/workflow-engine SLA-install retries with a stable `X-Client-Request-Id` — correctness/ergonomics, no data corruption |
| 8 | **I3** — `set_entity_assignment` idempotency-key/payload-drift on an assignment-changing routing-eval retry → wrong `auto_routing_failed` audit + missing success breadcrumb. `routing-evaluation.handler.ts` L256-263 (`applyAssignment` + conditional `assigned_*` payload), L265-278 (`set_entity_assignment` call + `buildRoutingEvaluationIdempotencyKey(event.id)`), L280-294 (`rpcRes.error`→`markRoutingFailure`→`return`, BEFORE the §6 success audit insert); RPC gate `supabase/migrations/00425_set_entity_assignment_v3_clear_routing_status.sql:149`. Same idempotency-key-stability bug-class family as #5/#7 but a different mechanism (payload-shape drift across an `applyAssignment` flip, not now()-in-hash) | B.2 / `set_entity_assignment` + routing-eval handler | codex-tertiary NO-GO finding on Code-I1 ("item 3"); **verified PRE-EXISTING + orthogonal by reading handler L256-294** (Code-I1 only converts the `routing_decisions` insert and preserves the genuine-error-throw trigger — item 3 exists IDENTICALLY before/after Code-I1, NOT introduced or worsened). **User-approved to ROUTE not fold** ("Ship Code-I1 + route item 3"). Precise coords + exact mechanism + candidate fix approaches + required review cycle (codex design-check + `/full-review` + codex tertiary + smoke) + the explicit "why this is NOT a Code-I1 regression" section in `docs/follow-ups/i3-routing-eval-assignment-rpc-payload-drift-2026-05-18.md`. Risk if unfixed: on a partial-commit retry or a plain redelivery of an assignment-CHANGING routing-eval event, the assignment is correctly applied but the audit trail wrongly records `auto_routing_failed` and the success breadcrumb is missing — audit-integrity/ops-confusion only, NO wrong assignment, NO data corruption; pre-existing; not P0/P1 |

> **#5 status update (2026-05-18):** RESOLVED by migration `00428` —
> see the `#### Update — 2026-05-18` block under §5 above (original row left
> intact, append-only). #7 (I2) is the newly-routed sibling, still open.
>
> **#8 (I3) routed (2026-05-18):** the codex-tertiary NO-GO "item 3" on
> Code-I1 (closed by migration `00429` — see
> `docs/follow-ups/audits/02-tickets-work-orders.md` Closure Ledger +
> `#### Update — 2026-05-18 — Code-I1 CLOSED (00429) + I3 routed`) was
> verified PRE-EXISTING + orthogonal and routed (NOT folded) per user
> direction. Still open.

audit-02's own deliverables (P2-1 interim, codex gate, Code-I1 re-defer,
live-smoke) are tracked in `docs/follow-ups/audits/02-tickets-work-orders.md`
Closure Ledger (2026-05-17 rows) + §2026-05-17.
