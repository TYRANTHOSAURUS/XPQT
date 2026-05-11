# B.2.A interim retrospective — 2026-05-11

> **SUPERSEDED** by `b2-a-closing-retro-2026-05-11.md`. Kept for audit
> history. This is the Step-7 snapshot; the closing retro covers Steps
> 1–13 in full.

Status check after Step 7 (smoke probe extension) shipped. Steps 8–13 still
pending. This is not a closeout — it's a mid-workstream pulse so the next
slice starts with a clear picture of what's solid and what isn't.

## Scope shipped

Foundation (Step 1) + RPC blocks §3.1 / §3.2 / §3.3 / §3.0 + controller
cutover + smoke gate extension. Everything below is on `origin/main` and
all CI gates are 0-violation.

| Step | Subject | Commits | Range |
|---|---|---|---|
| 1 | Foundation migrations (00316–00322) + helpers | 7 | `d9f63f22…b0c2d32b` |
| 2 | `RequireClientRequestIdGuard` wave (I1) | 6 | `561c69bc…bdeb98bf` |
| 3 | §3.1 `transition_entity_status` RPC (00323–00325) | 4 | `909119bc…cda238c4` |
| 4 | §3.2 `set_entity_assignment` RPC (00326–00327) | 4 | `0142a16b…524fdfc5` |
| 5 | §3.3 `update_entity_sla` RPC (00328–00330) | 4 | `aa7a977e…1f2ba339` |
| 6 | §3.0 `update_entity_combined` orchestrator + controller cutover (00331–00335) | 10 | `bad140d3…aba4c3f7` |
| 7 | Smoke probe extension + retro (this doc) | — | (this commit) |

Migrations consumed: **20** in the range 00316–00335.

Spec line 3144 (v10 plan) earmarked the §3.0 orchestrator at 00329 and
budgeted the §3.4/§3.5/§3.10/§3.11 RPCs at 00330–00337. The actual
shipped numbering compressed by adding repeated v-revisions (00325 is
`transition_entity_status_v2`; 00327 is `set_entity_assignment_v2`;
00330 is `update_entity_sla_v3`; 00332–00335 are
`update_entity_combined_v2/v3/v4/v5`). v10 spec didn't model the
review-loop revision cadence in the migration plan — each `_vN.sql` is
an extra migration on the wire. Net: **20 actual migrations vs. the
v10 plan's nominal ~8 for the same scope** (Foundation + four §3.x
RPCs). The 12-migration delta is entirely revision overhead from the
self-review → codex review loop.

This is not a problem per se — every revision was load-bearing — but
it should be priced into the remaining steps. Step 8 (§3.4) realistically
ships at 00336–00338+; Steps 9–12 will each add 3–5 revisions of their
own. Expect the workstream to consume 00316–00355 by Step 13, not
00316–00338 as the v10 plan implies.

## Review-loop discipline observations

For every RPC slice (Steps 3 / 4 / 5 / 6) the pattern was:

1. **v1** — fresh slice, lands on remote with the concurrency harness scenarios.
2. **Self-review (v2)** — `/full-review` against the v1 diff; round of fixes shipped as `_v2.sql` + a single commit titled `fix(b2a-§X.Y): self-review remediation`.
3. **Codex review (v3)** — `codex exec` against v2 with a scoped prompt; round of fixes shipped as `_v3.sql` + `fix(b2a-§X.Y): codex remediation`.
4. **Step 6 only — second round of each** (v4 self-review, v5 codex) because the orchestrator's surface area is larger.

Bugs caught per round (from commit messages; I'm counting **labelled findings** F1–FN / CODEX-A-N / etc., not test-fixture churn):

| Slice | v2 self-review | v3 codex | v4 self-review | v5 codex | total |
|---|---|---|---|---|---|
| §3.1 transition_entity_status | 1 (terminal-stamp preservation) + 1 (race-safe child guard, 00324) | (none — passed clean) | — | — | **2** |
| §3.2 set_entity_assignment | 1 (domain_events INSERT + metadata shape) | — | — | — | **1** |
| §3.3 update_entity_sla | 1 (case branch reset parity + sla_id guard) | — | — | — | **1** |
| §3.0 update_entity_combined RPC | 4 (F1–F4: sentinel inner key, watcher dedup, cast error mapping, hoist actor_person_id) | 3 (F8–F10: null tags/watchers clear, watcher validation parity, order-preserving dedupe) | — | — | **7** |
| §3.0 controller cutover (TS) | 8 (F-CRIT-1 missing clientRequestId; F-CRIT-2 post-SLA recompute hook; F-IMP-1 not_found vs forbidden; F-IMP-2 case/WO undefined parity; F-IMP-3 stop mutating DTO; F-IMP-4 sla.policy_not_found preflight; F-IMP-6 attach cause; F-IMP-7 drop /i flag) | 3 (CODEX-B-1 stop leaking SQL raise tails; CODEX-B-2 gate hook on timers_inserted; CODEX-B-3 reject no-target SLA policies) | 4 (C-rem: dead code removal + timer mock fix + typed fixture + write-proof) | 3 (final pass: sla detail leak + zero-target guard + doc drift) | **18** |

Across all four RPC slices: **29 distinct labelled findings**. Roughly split:
- **Self-review caught ~60% (17/29)** — F1–F4, F-CRIT-1/2, F-IMP-1/2/3/4/6/7, C-rem ×4, plus the smaller slice-3/4/5 fixes.
- **Codex caught ~40% (12/29)** — F8–F10, CODEX-B-1/2/3, final-pass ×3, plus the codex C-rem findings.

The self-review-first-then-codex order is justified by signal density:
codex burned tokens proportional to diff size, so running it after
self-review meant codex was looking at a tighter diff and could spend
its budget on the harder-to-see issues. Reversing the order in earlier
attempts (codex first) gave noisier output and missed the obvious
bugs self-review catches in two minutes. Stick with this order for
Steps 8–13.

**The single highest-yield review move was the v3-stage codex pass on
Commit B (controller cutover).** CODEX-B-1 (SQL-raise-tail leak via
the `detail` field) was a wire-contract regression that the self-
review missed entirely — `mapRpcErrorToAppError` had been passing the
PostgrestError message through to the registered code as `detail`,
which the renderer prefers over registry copy. Users saw raw SQL
fragments (`kind=case id=<uuid>`, `case=<uuid> open_children=3`)
instead of curated copy. Self-review tested for the **happy path**;
codex tested for the **leak**. Different blast radius.

## Decisions that turned out important

**1. Inner-key sentinel `__combined__:`** (F1, Step 6 v2). The §3.0
orchestrator composes per-field RPCs (§3.1 / §3.2 / §3.3) and passes
each a nested idempotency key. v1 used the plain concatenation
`<outer_key>:<branch>:<kind>:<id>`, which would collide with a
standalone call that happened to use the same key shape. v2 added the
`__combined__:` sentinel as a non-user-supplyable prefix. Without
this, an `update_entity_combined` call followed by a direct
`transition_entity_status` call with a similarly-named key could
poison the inner command_operations cache. Cheap to add; impossible
to retrofit cleanly once the orchestrator ships.

**2. Hard-fail on missing `clientRequestId`** (F-CRIT-1, Step 6 v4).
v3 had a `clientRequestId ?? randomUUID()` fallback. The
controller's `RequireClientRequestIdGuard` makes the HTTP-layer
header mandatory, but the legacy fallback meant an internal caller
that bypassed the controller (workflow engine, cron) would mint a
fresh UUID per call — every "retry" is a new key, idempotency is
meaningless. v4 throws `command_operations.client_request_id_required`
when the value is missing. Step 9 (workflow-engine cutover) **must**
supply a stable id per node-fire; the new hard-fail guarantees we'll
catch it the first time we ship.

**3. Dead-code removal in Commit C** (`d23a9171`). Commit B left the
six per-field `WorkOrderService` methods (`updateSla`, `setPlan`,
`updateStatus`, `updatePriority`, `updateAssignment`, `updateMetadata`)
unused but in-tree. The C-remediation subagent's stated rationale —
"they validate preflight" — was false: preflight runs inline in
`update()`. Keeping them was a real maintenance hazard (engineers
seeing them and adding callers; new fields needing to be added in
two places). Deletion of 6 methods + 6 spec files (~59 tests) brought
the API test count from 1592 → 1533. The shipped surface is now
truthfully the §3.0 orchestrator and only the §3.0 orchestrator.

**4. Post-SLA recompute hook** (F-CRIT-2, Step 6 v4; CODEX-B-2, v5).
The orchestrator runs status and SLA branches atomically. If a call
both pauses the entity to `waiting` and re-points the SLA, the
freshly-inserted SLA timers are written with
`recompute_pending=false` by the standalone §3.3 sub-RPC — which is
correct in isolation but stale when the same tx changes status to
`waiting`. v4 added a post-SLA hook that, after both branches run,
bumps `recompute_pending=true` on the fresh active timers + emits a
single `sla.timer_recompute_required` outbox event with
`action='post_sla_install_in_waiting'`. v5 (codex) added the gate: the
hook fires only when the SLA sub-RPC actually inserted rows
(`timers_inserted > 0`) — under v4 it fired even when the SLA
branch was a no-op fast path, bumping `recompute_pending` on
unrelated timers and emitting a spurious outbox event. Both
revisions were necessary; neither alone was sufficient.

## What's still pending

- **Step 8 — §3.4 dispatch + batch variant (4–5 days).** Routing
  engine + workflow engine cutover. Closes the plan-C3 finding
  (workflow-engine.service.ts:273-278 + :355-365 currently bypass §3.0).
- **Step 9 — §1.21 workflow-engine `assign` + `update_ticket` cutover
  (2–3 days).** First real test of the §3.2 RPC from a non-controller
  call site; will exercise the F-CRIT-1 hard-fail.
- **Step 10 — §3.5 `grant_ticket_approval` RPC (3–4 days).**
- **Step 11 — §3.10 `reclassify_ticket` RPC (4–5 days).**
- **Step 12 — §3.11 `create_ticket_with_automation` RPC (3–4 days).**
- **Step 13 — Closing retro (1 day).** Will supersede this interim
  doc.

## Honest closeout — known gaps still in `b2-followups.md`

These are documented and deferred — not P0 — but worth surfacing here
so they don't slip:

- **Workflow engine bypass** (`workflow-engine.service.ts:273-278`,
  `:355-365`). The engine still writes to `tickets` directly via
  `supabase.admin.from('tickets').update(...)`. Spec §3.0 lines
  1870–1873 mandate this go through §3.2. Step 9 cutover. **Until
  Step 9 ships, §3.0 is the only HTTP write path, not the only
  write path absolutely.**
- **Case-side `TicketService.reassign` bypass** (`ticket.service.ts:1431`).
  Also a direct `.from('tickets').update(...)` write. Same Step 9 scope.
- **Satisfaction atomicity gap** (`ticket.service.ts:1162-1180`).
  `satisfaction_rating` and `satisfaction_comment` are not part of
  the §3.0 patches schema. They still go through a direct UPDATE
  after the RPC call. Today this means a multi-field PATCH that
  combines a satisfaction rating with other fields lands in two
  transactions, not one. Used only by the satisfaction-survey
  workflow today, but the gap is real.
- **Title-whitespace divergence**. The WO TS layer trims and rejects
  whitespace-only titles (`work-order.service.ts:594`); the case
  TS layer does not. The §3.0 RPC's `length(v_new_title) = 0` check
  passes `'   '`. Documented as a follow-up; not a security issue;
  fix is a one-line trim in `TicketService.update`.

These all live in `docs/follow-ups/b2-followups.md` with full citations.
Step 13's closing retro will sweep them.

## Smoke gate state after Step 7

`pnpm smoke:work-orders` — 49 probes, all pass. Now also asserts the
`command_operations` row materialised for every successful PATCH
(structural defense against an accidental regression to the
pre-cutover TS write path).

`pnpm smoke:tickets` — new sibling, 88 probes, all pass. Case-side
mutation matrix (status / waiting_reason / priority / assignment /
metadata) + concurrency probes (idempotent replay with response-body
identity, payload mismatch, missing X-Client-Request-Id) + cross-tenant
probes (ghost uuid + ghost team + cross-tenant assigned_user_id with
TENANT_B fixture) + state-machine probes (has_open_children gate,
resolve→close→reopen→re-resolve cycle, terminal-stamp clear-on-leave
+ stamp-fresh-on-reentry per 00325 v2 :199-209, documented whitespace-
title divergence vs WO trim) + RequireClientRequestIdGuard surface
coverage (8 endpoints: POST /tickets, /tickets/:id/reassign,
/tickets/:id/reclassify, /portal/tickets, /approvals/:id/respond,
/reservations, /reservations/multi-room, /reservations/:id/services) +
boundary probes (empty body short-circuit, sla_id immutable).

Run both before claiming any future WO/case-surface work shipped:

```bash
pnpm dev:api &
pnpm smoke:work-orders && pnpm smoke:tickets
```

Total: **137 probes** asserting the §3.0 surface end-to-end against
the live remote DB. This is the structural gate that catches the
recurring "tests-pass-but-RPC-was-bypassed" failure mode the WO smoke
script was originally written to defend against.

Idempotency-key shape is the same on both sides: shared constant
`PATCH_IDEMPOTENCY_KEY_PREFIX = 'patch'` + helper
`buildPatchIdempotencyKey(kind, id, cri)` in
`@prequest/shared/idempotency`. TS services + both smoke scripts
import / replicate the same shape — a future cutover that changes the
prefix touches one file in TS and one replica in each .mjs (search
`PATCH_IDEMPOTENCY_KEY_PREFIX`). The replicas carry cross-reference
comments so they don't drift.

## CI gate status at retro

- `pnpm errors:check-app-errors` — 0 raw throws across 34 modules.
- `pnpm naming:check-allowlist` — 403 api + 137 web refs, 0 unexpected.
- `pnpm b2:check-config-reads` — 32 entries, OK.
- `pnpm test:concurrency` — 47/47 across 8 RPCs.
- `pnpm --filter @prequest/api test` — 1533/1533 (3 skipped, 21 todo).
- `pnpm --filter @prequest/web test` — 186/186.

## Decay

This doc expires when Step 13 closing retro ships, OR when its
findings have all been folded into `b2-followups.md` + `_workstream-state`
memory. Delete then.
