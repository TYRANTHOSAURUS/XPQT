# Docs Drift / Follow-Up Closure Audit — 2026-05-13

Read-only audit of `docs/follow-ups/**`, `docs/superpowers/specs/**`,
`docs/superpowers/plans/**`, and `docs/*.md` against the live tree at
HEAD `e8b5db44` (main, post floor-plan production hygiene).

## Executive verdict

The follow-up corpus is **substantially accurate** — the bulk of the
"shipped" / "deferred" claims survive a spot-check against code and
migrations. But the corpus is also **load-bearing** (it is the only
running narrative for ~5 multi-month workstreams: B.0, B.2.A, B.4, B.4.A.5,
floor-plan, universal-workflow), and the rot is concentrated in the
high-signal places:

1. **The canonical operational doc `docs/assignments-routing-fulfillment.md`
   still names `edit_booking_slot` (00291) as the slot-edit RPC** in its
   §4 mutation matrix (lines 1206, 1209, 1242–1243, 1269) — that RPC was
   dropped in migration 00379. The "Update the doc when X changes" rule
   on §0 was violated by the B.4 + Phase 8.D cutovers.
2. **`AGENTS.md` is a near-duplicate of `CLAUDE.md`** (same 202 lines,
   same prose). No clue why both exist; one is going to silently drift
   from the other. Pick one or merge.
3. **`docs/phase-1.md` → `docs/phase-4.md` are stale roadmap artifacts**
   (timeline estimates in "months", checkbox-style lists with most
   checkboxes empty). Memory note `feedback_discount_ai_timelines`
   explicitly says these timeline scales are 30× inflated. They contradict
   `docs/booking-platform-roadmap.md` (the 2026-04-28 roadmap reset).
4. **`docs/room-booking.md` still uses the legacy `reservations.time_range`
   GiST constraint name** (line 14). The table was renamed to
   `booking_slots` in migration 00277. 1 stale ref, 0 canonical refs.
5. **No drift in B.0 / B.2.A / B.4 follow-up files themselves** — they
   each carry "SHIPPED" markers with commit hashes, and the file:line
   citations are accurate enough that spot-checks land. The B.4 closing
   retro is exceptional.
6. **The universal-workflow Phase 1.B.x followup has line-number drift**
   (says `:959, :1149`; live engine file has the matching code at `:1024,
   :1202–1205, :1362`). Not a status drift — the deferral is real and
   accurate — just bad line numbers from a since-edited file.

The corpus is in better shape than typical "docs/follow-ups" folders.
The drift is **outside** the follow-ups folder, in the supposedly-canonical
operational reference docs that the project rule says must be updated in
the same PR.

## Follow-up closure table

| Item | Doc claim (file:line) | Code/schema reality | Verdict | Evidence |
|---|---|---|---|---|
| B.0 outbox foundation shipped | `b0-shipped.md:14-52` — 4 RPCs (00309–00312), TS cutover, smoke probe, 14 migrations 00299–00315 | All 4 RPCs in tree as migrations 00309/00310/00311/00312; `apps/api/scripts/smoke-outbox-roundtrip.mjs` exists; `pnpm smoke:outbox` wired in `apps/api/package.json` | **closed** | grep + ls confirm |
| B.0 markConsumed @deprecated | `b0-legacy-cleanup.md:22` — tagged @deprecated, deletion in cleanup commit | `outbox.service.ts:10,17,72` carries @deprecated tag; method still defined; zero non-test callers in `apps/api/src` | **closed-as-tagged** (cleanup deletion still deferred per doc) | grep `markConsumed apps/api/src --include="*.ts" \| grep -v spec` |
| B.0 InProcessBookingTransactionBoundary @deprecated | `b0-legacy-cleanup.md:35` — kept for multi-room flow | `booking-transaction-boundary.ts` still exported + registered at `reservations.module.ts:24,70` | **closed-as-tagged** | grep |
| B.0 real-DB concurrency harness | `b0-real-db-concurrency-harness.md:2-13` — "SHIPPED 2026-05-06"; root script `pnpm test:concurrency`; 4 spec files | All 4 spec files exist under `apps/api/test/concurrency/`; harness directory has 18 spec files + pool.ts + helpers.ts + jest.config.cjs | **closed** | ls |
| B.0 outbox integration test wiring | `outbox-integration-tests.md:11-22` — `pnpm test:integration` deferred | Zero `*.int.spec.ts` files in apps/api; no `test:integration` script in package.json | **open as deferred** (matches doc) | grep |
| Phase 7.A error-code registry | `phase-7-error-codes.md:11-16` — "STATUS 2026-05-09: All Phase 1 codes registered in 7.A.1 foundation" | `apps/api/src/common/errors/app-error.ts` + factories + `messages.en.ts`; `pnpm errors:check-app-errors` gate live | **closed** | grep + scripts/ |
| Phase 7.A `tenant-validation.ts` migration | `phase-7-error-codes.md:14-15` — "sites in tenant-validation.ts remain as BadRequestException; tracked as Phase 7 follow-up" | `tenant-validation.ts` still has 4× `BadRequestException` etc | **open as deferred** (matches doc) | grep |
| B.0 §16.1 cleanup commit | `b0-legacy-cleanup.md:51-90` — pending Phase 6 + 30-day burn-in | All @deprecated symbols still present (markConsumed, SetupWorkOrderTriggerService, InProcessBookingTransactionBoundary); no §16.1 deletion commit | **open** (matches doc) | grep |
| B.2.A workstream complete (13 steps) | `b2-a-closing-retro-2026-05-11.md:1-35` — all 13 steps on main; 42 migrations 00316–00358 | All 42 migrations in tree; `transition_entity_status`, `set_entity_assignment`, `update_entity_combined`, `dispatch_child_work_order(_batch)`, `grant_ticket_approval`, `reclassify_ticket`, `create_ticket_with_automation` migrations all present | **closed** | ls |
| B.2.A §1.22 reassign cutover | `b2-a-closing-retro-2026-05-11.md:70` — DEFERRED | Still uses direct UPDATEs per the retro | **open as deferred** | (matches doc) |
| B.4 workstream complete | `b4-closing-retro-2026-05-12.md:1-15` — HEAD 71618510, 10 sub-steps, 8 migrations 00359/00360/00361/00362/00363/00364/00367/00371 | All 8 migrations in tree; `assemble-edit-plan.service.ts` exists; both smoke scripts present | **closed** | ls |
| B.4 Phase 8.D drop dead RPC | `b4-followups.md:41-54` — CLOSED 2026-05-12 via 00379 | `supabase/migrations/00379_drop_edit_booking_slot_rpc.sql` present and verified `drop function if exists public.edit_booking_slot` | **closed** | Read |
| B.4 smoke:edit-booking sibling probe | `b4-followups.md:27-39` — CLOSED 2026-05-12 | `apps/api/scripts/smoke-edit-booking.mjs` present; wired in api package.json + root package.json | **closed** | ls |
| B.4 visitor cascade batch optimization | `b4-followups.md:516-548` — CLOSED 2026-05-12 (`emitVisitorCascadesForBundles`) | Not spot-verified in this audit (would require reading reservation.service.ts at depth) | **closed pending re-verify** | trust the followup file unless told otherwise |
| B.4 directory rename `reservations/` → `bookings/` | `b4-followups.md:144-163` — pending Phase 8 sweep | Directory still `apps/api/src/modules/reservations/`; no `bookings/` peer dir | **open** (matches doc) | ls |
| B.4 plan-builder helpers read tenant from ALS | `b4-followups.md:386-445` — Phase 8 refactor; assertions in place as mitigation | Not re-verified | **open** (matches doc) | trust |
| B.4.A.5 — C1 + C2 inbox triggers | `b4a5-followups.md:159-211` — Shipped 2026-05-13 via migration 00402 | `00402_inbox_notifications_triggers.sql` present; 3 triggers verified (`trg_inbox_notify_on_approval_insert`, `trg_inbox_backfill_on_team_member_insert`, `trg_inbox_cleanup_on_team_member_delete`) | **closed** | grep |
| B.4.A.5 notification dispatch substrate (sub-step C) | `b4a5-followups.md:7-43` — substrate landed; I7 + CTA URL + per-user locale all deferred | `apps/api/src/modules/notifications/` exists with 4 service files + templates dir + 2 React-email templates | **closed (substrate); open (deferrals)** | ls |
| B.4.A.5 CTA URL swap to /desk/approvals/<chainId> | `b4a5-followups.md:47-65` — deferred | Not verified; trust the doc | **open** (matches doc) | — |
| B.4.A.5 per-user `users.locale_preference` | `b4a5-followups.md:94-115` — deferred | Not verified; trust the doc | **open** (matches doc) | — |
| Universal Workflow Phase 1.A | memory `project_universal_workflow_phase1a_shipped` — 00372, 00373 + WorkflowSpawnWakeHandler | Both migrations present (00372_create_booking_emit_lifecycle.sql, 00373_delete_booking_emit_cancelled.sql); `WorkflowSpawnWakeHandler` not spot-checked | **closed** | ls |
| Universal Workflow Phase 1.B — engine polymorphization (emit-site) | `universal-workflow-phase1bx-followups.md:1-7` — shipped | `workflow-engine.service.ts` has `WorkflowEntityKind`, `polymorphicIdColumn`, `cancelInstance(entityKind, …)` signatures | **closed** | grep at :261-301 |
| Universal Workflow Phase 1.B.x — dispatch-layer polymorphization | `universal-workflow-phase1bx-followups.md:36-86` — deferred; cites lines 959, 1149 | Code at `workflow-engine.service.ts:1024, 1202-1205, 1362` (file edited since doc written; deferral still valid) | **open + line-numbers drifted** | grep |
| Universal Workflow Phase 1.C — cron backstop | `universal-workflow-phase1bx-followups.md:9-34` — SHIPPED 2026-05-12 | `workflow-wait-sweeper.cron.ts` + `.spec.ts` present in `apps/api/src/modules/workflow/` | **closed** | ls |
| Visitors v1 — `host_person_id` denormalization | `visitors-v1-tech-debt.md:106-124` — v2 cleanup deferred | `privacy-compliance/adapters/visitor-records.adapter.ts:57-100` still reads `host_person_id` | **open** (matches doc) | grep |
| Visitors v1 — Cancel/Resend invite endpoints | `visitors-v1-polish.md:119-125` — backend gap; "coming soon" kebab items | Not verified; trust doc | **open** (matches doc) | — |
| Routing-studio cutover (slice 1 of WIP pickup) | `wip-pickup-2026-04-28.md:13-87` — flag retired, 4 legacy pages deleted | `apps/web/src/lib/features.ts` absent; only `routing-studio.tsx` + `service-routing.tsx` under admin pages | **closed** | ls |
| RoutingDecisionPill (slice 1 bonus) | `wip-pickup-2026-04-28.md:42-44` — REVERTED 2026-04-29 | `useTicketRoutingDecision` + `RoutingDecisionPill` grep yields 0 hits in `apps/web/src` | **closed-as-reverted** (matches doc) | grep |
| Data-model rework Step 1c.10c | `data-model-overnight-handoff.md:13-14` — destructive cutover gated on user; later landed | `00233_step1c10c_destructive_cutover.sql` present + follow-up 00234, 00235 | **closed** | ls |
| Data-model P0 work_orders 42501 | `data-model-rework-full-handoff.md:8-40` — RESOLVED via 00275 + A12 gate in `scripts/ci-migration-asserts.sql` | `00275_restore_work_orders_service_role_writes.sql` present; gate file exists | **closed** | ls |
| Phase 1.3 booking compensation | `phase-1-3-blocker-map.md` describes `delete_booking_with_guard` design | `00292_delete_booking_with_guard_rpc.sql` present | **closed** | ls |
| Phase 1.3 manual smoke | `phase-1-booking-smoke.md` — manual probe runbook | Manual only; no automated gate; matches doc | **open as deferred (manual)** | — |
| Phase 2 — `GET /reservations` split into booking-grain + slot-grain | `phase-2-list-split.md:42-49` — deferred (separate endpoint plan) | `reservation.controller.ts:47` still `@Get()` calling `listMine`/`listForOperator`; no `GET /bookings` route; `bookings-list.tsx:55` still has `seen.add(r.booking_id)` dedup | **open** (matches doc) | grep |
| Vendor portal B Sprint 4/5 — Resend mailer | `vendor-portal-phase-b-sprint4-5.md:27-52` — B "Wire VendorMailer onto MailProvider" open | Zero `ResendVendorMailer` / `ProviderVendorMailer` / `MAIL_PROVIDER` refs in `vendor-portal/`; only `vendor-mailer.service.ts` (LoggingVendorMailer) | **open** (matches doc) | grep |
| CI invariants YAML migration | `ci-assertion-strategy.md:5-7` — "NOT yet implemented" | `scripts/ci-invariants.yml` does not exist; `ci-migration-asserts.sql` still hand-rolled | **open** (matches doc) | ls |
| Phase 8.A.1 naming audit | `phase-8-naming-audit.md` + `apps/api/src/.naming-allowlist.txt` | Both files present; web allowlist also at `apps/web/src/.naming-allowlist.txt` | **closed (audit)** | ls |
| Phase 8.A — backend naming sweep | `phase-8-canonical-naming.md:20-25` — pending | Directory still `reservations/`; allowlist has 420 api refs per closing retro | **open** | grep |
| Phase 8.D drop dead RPC | `phase-8-canonical-naming.md:36-38` — pending | Shipped (00379) — see B.4 entry above | **drifted** — phase-8 doc should now mark "Phase 8.D shipped 2026-05-12" |
| Floor-plan production hygiene | memory `project_floor_plan_production_hygiene_shipped` (HEAD bf7674cf); `floor-plan-deferred.md` Tier 1/2/3 open | bf7674cf commit on main; `00400_floor_availability_mine_booking_id.sql` present; designer code in apps/web/src/components/floor-plan/ | **closed (hygiene); open (Tier 1+)** | git log |
| Smoke gate matrix complete | `docs/smoke-gates.md` references 4 probes | All 4 (`smoke-work-orders`, `smoke-edit-booking`, `smoke-edit-booking-scope`, `smoke-floor-plans`) + `smoke-outbox-roundtrip` + `smoke-tickets` present | **closed-with-omission** — `smoke-outbox-roundtrip` + `smoke-tickets` exist but are NOT documented in smoke-gates.md |

## Stale docs (must be revised before another engineer trusts them)

1. **`docs/assignments-routing-fulfillment.md`** — §4 mutation matrix (lines 1205–1269) names `edit_booking_slot` (00291) as the live slot-edit RPC. Migration 00379 dropped it 2026-05-12. Fix shape: replace `edit_booking_slot` references with `edit_booking` (00364) and `edit_booking_scope` (00371); update the "Slot-edit mirror invariant" subsection citation (`(00291 edit_booking_slot RPC)` → `(00364 edit_booking RPC v4)`). The b4-closing-retro file calls this out implicitly but never names assignments-routing-fulfillment.md as the doc to fix. **High priority — this is the canonical operator-facing reference per CLAUDE.md.**

2. **`docs/room-booking.md:14`** — "reservations.time_range GiST exclusion constraint". The `reservations` table was renamed to `booking_slots` in migration 00277 (post-canonicalisation). 1 stale ref, 0 canonical refs in the entire file. Either rename to `booking_slots.time_range` or, if the constraint is `booking_slots_no_overlap`, name it correctly. **Medium priority — the file is otherwise good.**

3. **`docs/phase-1.md` → `docs/phase-4.md`** — Original phase plans from project inception. Timeline estimates in "months" (e.g. "4–5 months for 2 people" on phase-1). Per memory `feedback_discount_ai_timelines` these scales are wrong. Most checkbox items are unchecked even though many have shipped (e.g. phase-1 RLS, phase-2 booking, phase-3 workflow editor). **The B.0 / B.2.A / B.4 corpus has retired phase-1/2/3 as the operational unit of work; the booking-platform-roadmap.md is the current truth.** Either delete phase-{1..4}.md and link to booking-platform-roadmap.md from the README, or mark each one "SUPERSEDED 2026-04-28 by docs/booking-platform-roadmap.md".

4. **`AGENTS.md`** — 202-line near-duplicate of CLAUDE.md (also 202 lines). Same prose, same section headers, same content. Either this is meant for non-Claude agents (codex, etc.) and should be a thin redirect to CLAUDE.md, or it's accidental duplication. **Decide and consolidate.** Silent drift is guaranteed if both keep evolving.

5. **`docs/data-model-redesign-2026-04-30.md`** — "Recommendation, not committed" framing. Step 1a/1b/1c.10c have all shipped (data-model-overnight-handoff.md, full-handoff.md, project memory `project_b2_workstream_state` confirms). The "Recommendation" framing is no longer accurate. Either mark "Recommendation SHIPPED" with the migration trail, or delete and rely on the followups corpus.

6. **`docs/service-catalog-redesign.md:3-5`** — `"Superseded on 2026-04-23 by docs/service-catalog-live.md"`. This is a docs-graveyard pattern that's actually well-handled (the file has a clear redirect at the top). **No action needed; reference for pattern.**

7. **`docs/portal-scope-slice.md:3`** — has a 2026-04-23 update-note redirecting predicates. Same well-handled pattern.

8. **`docs/follow-ups/universal-workflow-phase1bx-followups.md:39-50`** — citations `workflow-engine.service.ts:959` and `:1149` are wrong (live file has the matching code around `:1024, :1202-1205, :1362`). The deferral is still real and correctly described; line numbers are off. **Cosmetic — but the file's value drops as a reference if line cites are wrong.**

## Missing docs (code shipped, no doc captures it)

1. **`apps/api/scripts/smoke-outbox-roundtrip.mjs`** and **`apps/api/scripts/smoke-tickets.mjs`** — both exist + wired in package.json (`pnpm smoke:outbox`, `pnpm smoke:tickets`). Not listed in `docs/smoke-gates.md`. **smoke-gates.md is the canonical reference per CLAUDE.md; missing two probes is silent drift.**

2. **`apps/api/src/modules/notifications/`** — B.4.A.5 sub-step C shipped the notifications module (4 services, 2 React-email templates, template-overrides controller, etc.). No top-level operational doc like `docs/notifications.md` exists. The b4a5-followups.md describes the deferred items but does NOT describe the SHIPPED architecture for a fresh engineer to pick up.

3. **`supabase/migrations/00391_inbox_notifications.sql` + `00401` + `00402` triggers** — the inbox-notification trigger-based fan-out (C1 + C2 from b4a5-followups.md) is real production infra. Worth a one-pager `docs/inbox-notifications.md` explaining the trigger fan-out + person/team path + ON CONFLICT dedup contract before the next engineer hits a bug here.

4. **Floor-plan operational reference** — Floor-plan designer + portal + map shipped over the last week (per memory `project_floor_plan_production_hygiene_shipped`). The `floor-plan-deferred.md` is good but it's a deferral index, not an operational reference. Should there be a `docs/floor-plans.md` next to `docs/room-booking.md`?

5. **Notifications module spec** — `b4a5-followups.md` is the only artifact about template overrides, locale resolution, dispatch trigger contract, etc. There's no `docs/superpowers/specs/2026-05-XX-notifications-design.md` to point a fresh engineer at.

## Contradicting docs

1. **`docs/assignments-routing-fulfillment.md:1206-1269`** vs **`docs/follow-ups/b4-followups.md:41-54`** — first says `edit_booking_slot` is the slot-edit RPC; second says it was dropped 2026-05-12 via 00379. Live code confirms b4-followups is right. Doc A must be fixed.

2. **`docs/phase-2.md`** ("6–8 weeks for 2 people, primarily frontend work — backend APIs already exist") vs **`docs/follow-ups/b4-followups.md`** + **`b2-a-closing-retro-2026-05-11.md`** (the whole B.2.A workstream, 42 migrations, was *backend orchestrator work*, plus B.4 is another 8 migrations of backend). The phase-2 framing is from project inception and never updated.

3. **`docs/phase-3.md`** ("Visual Workflow Builder" — proposed feature) vs **memory `project_universal_workflow_phase1_complete`** + Phase 1.5 plan-review followups (universal-workflow architecture is being built; visual editor already partially exists). Phase 3 doc is stale.

4. **`AGENTS.md`** vs **`CLAUDE.md`** — both claim to be the project agent instructions. Same content today; one will drift.

## Recommended doc-cleanup PR scope

A single hygiene PR with these changes — sequenced so nothing depends on a later step:

1. **Update `docs/assignments-routing-fulfillment.md` §4 mutation matrix** to name `edit_booking` (00364) + `edit_booking_scope` (00371) as the live RPCs; flag 00291 as dropped via 00379. Cite the b4 closing retro + b4-followups.md Phase 8.D section.
2. **Rename `reservations.time_range` → `booking_slots.time_range`** in `docs/room-booking.md:14` (plus any other one-off `reservations.` refs in the file).
3. **Decide on AGENTS.md** — either delete (with a redirect comment), or mark it as the codex/non-Claude agent file with diverged scope. If kept, link CLAUDE.md → AGENTS.md "for codex/other agents see…".
4. **Add `smoke-outbox-roundtrip` and `smoke-tickets`** to `docs/smoke-gates.md`'s probe matrix.
5. **Update `docs/phase-{1,2,3,4}.md`** with a `> **SUPERSEDED 2026-04-28 by docs/booking-platform-roadmap.md and the docs/follow-ups/ corpus.**` header. Don't delete (history value), but stop the timeline-estimate harm.
6. **Update `docs/data-model-redesign-2026-04-30.md`** with a "SHIPPED through Step 1c.10c, see data-model-rework-archive/" header.
7. **Fix the line citations** in `docs/follow-ups/universal-workflow-phase1bx-followups.md:39-50` (`:959` → `:1024`, `:1149` → `:1202-1205`).
8. **Mark Phase 8.D as shipped** in `docs/follow-ups/phase-8-canonical-naming.md:36-38` (cite b4-followups.md + migration 00379).

Out of scope (would need real backend work, not docs):
- The integration-test wiring deferral in `outbox-integration-tests.md`.
- The vendor-mailer Resend wiring in `vendor-portal-phase-b-sprint4-5.md`.
- The Phase 8.A backend rename sweep.

## Audit notes

- **B.4 closing retro is exemplary.** It carries 13 sections (scope, shipped, spec adherence, approval reconciliation, sequencing, review-loop, gate counts, migration count, latency, open follow-ups, lessons, NOT-do list, final state). It's the model the other workstreams should follow.
- **B.0 + B.2.A retros are equally rigorous.** Their "deferred" lists are honest (markConsumed still in tree; reassign cutover still direct UPDATEs; satisfaction atomicity bypassed; etc.).
- **The biggest hidden risk in the follow-up corpus is *bait* — pieces marked "SHIPPED" that haven't been re-verified since.** This audit spot-checked code paths for ~30 follow-up claims; ~28 held up. Two had drift (assignments-routing-fulfillment.md's edit_booking_slot citation; the universal-workflow line numbers). If the spot-check rate generalised, ~10% of "SHIPPED" claims in the corpus may have silent drift that would only surface during a real cutover or incident.
- **Project memory is the most current truth.** When memory says "shipped 2026-05-12 at HEAD X" and a follow-up says the same — both agree. Where the docs disagree with memory (rare in this audit), memory tends to win because it's smaller + churns less.

---

## Closure Ledger

Every agent that closes, partially closes, or intentionally defers a finding in this audit must add a row here in the same change. Do not mark the audit as complete from docs alone; cite code, migrations, tests, or corrected docs that prove the claim.

| Date | Agent / owner | Status | Evidence | Verification | Notes |
|---|---|---:|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/07-docs-drift.md` | Not run | All findings remain open unless a later row says otherwise. |

## Agent Handoff Prompt

```text
You are the documentation-drift remediation agent for Prequest.

Primary file:
- docs/follow-ups/audits/07-docs-drift.md

Goal:
Close every documentation-drift finding in this audit and keep the audit itself current while you work. The end state is that operators and future agents can trust the docs because each "done", "open", or "deferred" claim is backed by current code, migrations, tests, or another authoritative document.

Read before editing:
- AGENTS.md and CLAUDE.md
- docs/follow-ups/audits/07-docs-drift.md
- docs/follow-ups/audits/00-integrator-verdict.md
- Every source document named in the finding you are fixing.
- The relevant code or migration path before changing any status language.

Execution model:
1. Work finding by finding. For each item, first verify whether the code/database has moved since the audit was written.
2. Fix stale references such as deprecated RPC/function names, removed columns, inaccurate smoke-gate lists, outdated phase status, and obsolete line references.
3. Add historical/status banners where old phase docs remain useful but are no longer the current implementation contract.
4. If a docs finding reveals missing code rather than stale prose, do not paper over it. Add the implementation dependency to the relevant audit doc and mark this item as blocked in the Closure Ledger.
5. Keep canonical docs aligned with code in the same change. For routing/assignment changes, update docs/assignments-routing-fulfillment.md. For ticket visibility changes, update docs/visibility.md. For smoke gates, update docs/smoke-gates.md and the root agent instructions if applicable.
6. Use parallel agents only for independent doc families. Tell them to verify against code and not to mark anything shipped from another doc alone.

Required output after each slice:
- Corrected docs in the working tree.
- Exact code, migration, or test evidence used to justify the correction.
- One Closure Ledger row in this file with status: closed, partially_closed, blocked, or deferred.
- Any newly discovered drift added to this file or the integrator verdict.

Completion bar:
- Every drift item in this file has a ledger row.
- Canonical docs no longer contradict current code, migrations, package scripts, or smoke gates.
- Old roadmap/phase docs are clearly labelled as historical, superseded, shipped, or still active.
- The audit file itself is no longer a stale snapshot; it is the current tracking surface.
```
