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

## Summary for owners

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | PR#16 CI red — **NOT** B.2 config-reads (that's green); real reds = design/typecheck, B.0 harness, migration-smoke, Render deploy | per-check (table §1) | Routed w/ corrected attribution |
| 2 | Duplicate migration prefixes (11+ live, incl. 00406) | integrator / data-model | Owned (blocker #8 / P2-3); evidence refreshed |
| 4 | `SubIssueProgress` under-reports post-P1-5 | FE workstream | Routed w/ fix options |

audit-02's own deliverables (P2-1 interim, codex gate, Code-I1 re-defer,
live-smoke) are tracked in `docs/follow-ups/audits/02-tickets-work-orders.md`
Closure Ledger (2026-05-17 rows) + §2026-05-17.
