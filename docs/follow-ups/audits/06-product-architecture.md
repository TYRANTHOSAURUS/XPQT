# 06 — Product Architecture / Best-in-Class Gap Audit

**Date:** 2026-05-13
**Author:** product-architecture audit agent
**Scope:** is XPQT's architecture sufficient to support a *best-in-class* workplace ops platform (Benelux primary, replacing Planon/Eptura, competing with deskbird/Robin/Envoy/ServiceNow), or only "good enough"?
**Frame:** product / strategy lens, not code lens. Code lens audits live elsewhere in this folder.

---

## Executive verdict (one page)

**The architecture is genuinely promising and the foundation is good, but the product surface is not yet best-in-class on a single dimension that matters for replacing the incumbents.** XPQT today is roughly a *strong MVP+ across many domains* with **two domains at production maturity** (routing/dispatch, ticket/case execution), **one wedge moat that competitors don't have** (composite event bundles + one predicate engine + per-line scheduling + per-occurrence overrides), and **zero domains at the bar set by the best-in-class competitor for that domain**.

The painful summary: every Tier A competitor (Planon, Eptura, deskbird) beats XPQT on at least one dimension that buyers explicitly evaluate on, and there is no buyer-evaluated dimension where XPQT beats all of them today. The wedge moats (composite events, one rule engine, hidden vendor, GiST exclusion, approval dedup) are real — but they are *demo magic*, not what wins RFP scorecards or G2 reviews. RFP scorecards are won on: Outlook depth, mobile depth, visitor depth, vendor scorecards, reporting, knowledge base, AI, email channel — and XPQT is **MVP-or-missing on every single one of those**.

**What does that mean concretely:**
1. **Data model is in good shape.** The booking canonicalization (`bookings` + `booking_slots`), four-axis routing (routing/ownership/execution/visibility), universal workflow polymorphism (Phase 1 complete, Phase 2 imminent), GDPR baseline retention engine, per-line `service_window_*` columns, and `scope_breakdown` approval dedup are all genuinely well-designed primitives that *do not need another rework*. This is the strongest part of the platform.
2. **Specs exist for the next 9 big things but only 2-3 are even started.** MS Graph (specced, ~5% built), vendor scorecards (specced, 0% built), requester rating (specced, 0% built), vendor portal Phase B (Sprint 1 shipped, 4/5 sprints remain), Phase C vendor execution UX/KDS (specced, 0% built), knowledge base (mentioned in Phase 4, 0% built), email channel (Phase 4, 0% built), approvals consolidation (specced, partial), Outlook add-in (deferred to Tier 2).
3. **The product is over-indexed on backend correctness vs operator-facing surfaces.** ~410 migrations, 46 API modules, 199 spec files, but only one full-shell persona surface is genuinely shipped at quality (desk operator). Reception, vendor, approver, requester-mobile, and admin-config-author surfaces are each missing >1 thing required to compete.
4. **Mobile is the largest single shipping-blocker.** No PWA manifest, no service worker, no offline queue except in the kiosk, no native app, ~10 responsive media-query files in the portal. deskbird and Robin both have 4.7+ App Store apps. Without a credible mobile story, XPQT cannot win the hybrid-work workplace buyer at all.
5. **MS Graph / Outlook is the second-largest shipping-blocker.** `calendar-sync` module exists (2222 LOC), implements OAuth + delta sync + reconciler + webhook renewal — but no Teams adaptive cards, no Outlook add-in, no Teams notification channel. The buyer who books from Outlook (~70% of NL/BE corporate HQ) cannot use the product day-to-day yet.

**The honest claim today:** "*best-in-class workplace ops platform for tenants who care about composite events, multi-vendor coordination, and an honest GDPR baseline; mid-market only; not yet credible for Outlook-first or mobile-first buyers; will require ~18-30 weeks of focused delivery against existing specs before broad RFP credibility.*"

**The dishonest claim:** "*best-in-class workplace ops platform.*" — full stop. We are not, on any single buyer-evaluated dimension, today.

---

## Best-in-class readiness scorecard by domain

Score legend:
- **MVP** — minimum viable; functions but loses to every Tier A competitor on this dimension by default.
- **Prod** — production-ready; beats Tier B/C; competitive but not the bar.
- **BIC** — best-in-class; matches or beats every Tier A on this dimension.

| Domain | Architecture | Code | UX | Ops | Score |
|---|---|---|---|---|---|
| **Routing / dispatch / fulfillment** | BIC | Prod | Prod | Prod | **Prod** (one of two strongest) |
| **Ticket / case execution** | Prod | Prod | Prod | Prod | **Prod** (other strongest) |
| **Composite event bundles** (`bookings` + slots + lines) | BIC | Prod | MVP | MVP | **Prod** |
| **Room booking** | Prod | Prod | Prod | MVP | **Prod-** (no Outlook add-in / Teams cards) |
| **Desk booking + floor maps** | Prod | Prod | MVP | MVP | **MVP+** (floor plans just shipped 2026-05-13) |
| **Service catalog + rules engine** | BIC | Prod | Prod | MVP | **Prod** |
| **Approvals** | Prod | Prod | MVP | MVP | **MVP+** (manager chain + Teams cards missing) |
| **SLA + escalation** | Prod | Prod | Prod | Prod | **Prod** |
| **Workflow editor (universal)** | BIC | Prod | Prod | Prod | **Prod+** (Phase 1 universal complete, Phase 2 imminent) |
| **Visitor management** | Prod | Prod | Prod | MVP | **Prod-** (v1 shipped 2026-05-04; vs Envoy = MVP+) |
| **Vendor portal + daglijst** | Prod | MVP | MVP | MVP | **MVP+** (Sprint 1 of Phase B, daglijst Sprint 1 shipped) |
| **Vendor scorecards** | — | — | — | — | **Missing** (spec exists, code 0%) |
| **Requester rating** | — | — | — | — | **Missing** (spec exists, code 0%) |
| **Vendor execution UX / KDS** | — | — | — | — | **Missing** (spec exists, code 0%) |
| **Calendar / MS Graph sync** | Prod | Prod | MVP | MVP | **MVP+** (OAuth + delta sync working; no Teams cards, no add-in) |
| **Teams adaptive cards** | — | — | — | — | **Missing** |
| **Outlook add-in** | — | — | — | — | **Missing** (Phase 5 deferred to Tier 2) |
| **Reporting / analytics** | MVP | MVP | MVP | MVP | **MVP** (251-LOC service; no dashboard builder, no scheduled delivery, no chargeback) |
| **Hybrid-work analytics** | — | — | — | — | **Missing** (only basic bookings overview reports) |
| **Knowledge base** | — | — | — | — | **Missing** |
| **Inbound email channel** | — | — | — | — | **Missing** (inbound webhooks shipped — different surface) |
| **AI / copilot / triage** | — | — | — | — | **Missing** |
| **Mobile (portal + ops)** | MVP | MVP | MVP | MVP | **MVP** (no PWA, no native app, no offline write queue except kiosk) |
| **Kiosk (visitor check-in)** | Prod | Prod | Prod | Prod | **Prod** (1820 LOC, offline-queue, NL translation pending) |
| **GDPR / compliance** | BIC | Prod | Prod | Prod | **Prod+** (rare strength — full baseline shipped Sprints 1-5) |
| **Audit / observability** | Prod | Prod | MVP | MVP | **Prod-** (events emit; no operator-facing audit explorer beyond admin/privacy.tsx) |
| **Floor plans / wayfinding** | Prod | MVP | MVP | MVP | **MVP+** (designer+render shipped 2026-05-13; clone + label tool deferred) |
| **CMDB / asset relationships** | MVP | MVP | — | — | **MVP-** (asset records exist; no relationship graph) |
| **Preventive maintenance** | Prod | Prod | MVP | MVP | **MVP+** (PM generator + maintenance plans shipped via migrations 00386-00398) |
| **Change management (ITIL)** | — | — | — | — | **Missing** |
| **Inbound webhooks** | Prod | Prod | Prod | Prod | **Prod** (shipped 2026-04-28) |
| **i18n (NL primary)** | MVP | MVP | MVP | MVP | **MVP** (en+nl error catalogs; visitor email English-only; no full pass) |
| **Native vendor scorecard data capture** | — | — | — | — | **Pre-req for scorecard spec** |
| **Hidden-vendor model (wedge)** | BIC | Prod | Prod | Prod | **BIC** (no competitor offers this) |
| **Per-occurrence recurrence overrides (wedge)** | BIC | Prod | Prod | Prod | **BIC** (no competitor offers this) |
| **GiST DB-level conflict prevention (wedge)** | BIC | Prod | Prod | Prod | **BIC** (no app-level race-condition) |
| **Approval dedup (`scope_breakdown`) (wedge)** | BIC | Prod | Prod | Prod | **BIC** (1 row per approver across N lines) |
| **One predicate engine across surfaces (wedge)** | BIC | Prod | Prod | MVP | **Prod+** (RuleResolverService + applies_when AST shared by room+service rules; UX is admin-heavy) |

**Counts:** BIC=5 (all wedges) · Prod or Prod+/Prod-=12 · MVP/MVP+=14 · Missing=10.

**Critical reading:** all 5 BIC scores are *wedges* the user has chosen to defend. None are scores on the *table-stakes dimensions* buyers evaluate on. On every buyer-evaluated dimension (Outlook depth, mobile, visitor depth vs Envoy, vendor scorecards, reporting, knowledge base, AI), XPQT is MVP or Missing.

---

## Product-architecture gaps, ranked

### P0 — blocks "best-in-class" claim today; lose deals on this dimension

1. **No mobile story.** No PWA manifest, no service worker, no offline queue for writes (except kiosk), no native app. ~10 portal files use responsive utilities. deskbird and Robin both have 4.7+ App Store apps; the hybrid-work buyer expects native-feeling mobile. *Reference:* `docs/competitive-benchmark.md` §3 "Mobile"; `apps/web/src/lib/kiosk-offline-queue.ts` is the only offline-aware code in the web app.
2. **No Teams adaptive cards + no Outlook add-in.** Calendar-sync ingests Outlook bookings (`apps/api/src/modules/calendar-sync/*.ts`, 2222 LOC, OAuth + delta sync + reconciler + webhook renewal — solid work), but downstream there is no `apps/api/src/modules/notifications/channels/teams.channel.ts` (only `email.channel.ts` exists) and no Outlook add-in manifest anywhere in the tree. Eptura/Condeco/Robin all ship Outlook add-ins. Approvers cannot approve from Teams. *Reference:* `docs/superpowers/specs/2026-04-27-microsoft-graph-integration-design.md` Phases 3+4 unbuilt; Phase 5 deferred.
3. **Vendor scorecards + requester rating + vendor execution UX (Phase C) all 0% built.** All three are specced (`docs/superpowers/specs/2026-04-27-vendor-{scorecards,…}-design.md`). Without scorecards, FM directors evaluating against ServiceChannel or Planon Insights fall back to anecdote. Without requester rating, no high-trust voluntary signal. Without Phase C KDS/field-tech UX, internal teams and catering vendors keep using their own tools.
4. **Reporting is MVP-only.** `reporting.service.ts` is 251 LOC; only 5 booking reports (overview / utilization / no-shows / services / demand) and 7 desk reports exist. No custom dashboard builder, no scheduled delivery, no PDF/CSV/Excel export, no cross-domain insights, no chargeback. Planon Insights + ServiceChannel scorecards is the bar; we are nowhere near it. *Reference:* `docs/phase-4.md` "Advanced Reporting & Exports" — listed as Phase 4 backlog, not started.
5. **No knowledge base.** Zero `kb` / `knowledge` files anywhere in the codebase. Every Tier A competitor has it. Reduces ticket volume on common questions. *Reference:* `docs/phase-4.md` "Knowledge Base / Self-Service" — Phase 4 backlog, not started.
6. **No inbound email channel.** Inbound webhooks shipped (different surface). Email-to-ticket is table stakes for every mid-market service desk (TOPdesk, Zendesk, Jira, ServiceNow all ship it). *Reference:* `docs/phase-4.md` "Email-to-Ticket"; inbound webhook plan is `docs/inbound-webhooks-plan-2026-04-23.md` — same plumbing but not the email parser.

### P1 — competitive parity at risk; loses dimension comparisons

7. **Approval surface is MVP.** Backend is strong (`approval.service.ts` 1064 LOC; `scope_breakdown` dedup; cost_centers; delegation table — *backed by* migrations 00012, 00028, 00146). But: no manager-chain resolver implementation (data exists in `persons.manager_person_id`, resolver doesn't walk it); no approver dashboard with batch-approve; no mobile-first approve; no Teams approve-in-place; no escalation-on-timeout. *Reference:* `docs/superpowers/specs/2026-04-28-approvals-design.md` lists all five as missing.
8. **Visitor module vs Envoy.** v1 shipped (38 commits, migrations 00248-00272, full desk + kiosk + reception flow). But: kiosk badge printing is not in the codebase; visitor watchlist screening is rudimentary; NL/FR translation deferred (`docs/follow-ups/visitors-v1-polish.md`); no lobby panel; no NDA flow. Envoy still beats us on Envoy's home turf. *Reference:* `docs/superpowers/specs/2026-04-27-visitor-management-design.md` envisions the v2 bar; v1 hit ~60%.
9. **Hybrid-work analytics nearly absent.** No "office attendance trends", no "team-cluster utilization", no anonymized "office days" reporting. The bookings overview reports are operator-facing, not workplace-strategy-facing. *Reference:* `docs/competitive-benchmark.md` §3 "Hybrid-work analytics".
10. **No CMDB / asset relationships.** `asset.service.ts` is 139 LOC. Single-table asset records, no relationships, no service map. Planon's 40-year moat is here; we can't beat it but we should at least not score Missing. *Reference:* `docs/competitive-gap-analysis-2026-04-20.md` "FMIS and Operations" matrix — PQT scored P on assets, M on CMDB.
11. **i18n pass not run.** Two locales (en, nl) for *error messages only* (`apps/{api,web}/src/.../errors/messages.{en,nl}.ts`). Visitor email English-only (acknowledged tech debt). No global i18n primitive in the web app. Benelux-primary positioning is at odds with this.
12. **No AI / copilot / triage anywhere.** ServiceNow, Zendesk, Jira, deskbird, and Robin all ship AI features at the platform tier (suggested resolutions, intent classification, predictive routing, summarization). XPQT scored M in the 2026-04-20 gap matrix; nothing has changed.

### P2 — important but not deal-blockers in current segment

13. **Floor plans + wayfinding just shipped; clone-floor + label-tool deferred** (`docs/follow-ups/floor-plan-deferred.md`). Tier 1 work shipped 2026-05-13; the deferred list is genuine UX gap vs Robin.
14. **Preventive maintenance basic but not depth.** Migrations 00386-00398 + `pm-generator.service.ts` (353 LOC) + `maintenance-plan.service.ts` (344 LOC). Functional but no condition-based maintenance, no asset-lifecycle tracking depth. Planon/Ultimo/Maximo win here by default.
15. **No change management (ITIL CAB).** Mid-market service desks all eventually need this. We score M; gap analysis flagged this in April.
16. **No dashboard / report builder.** Same root cause as P0 #4.
17. **No outbound webhooks framework.** Inbound webhooks shipped 2026-04-28; outbound (notifying external systems on ticket events) is a Tier 2-3 ask but absent.
18. **Floor-plan + map-booking deferred items.** `docs/follow-ups/floor-plan-deferred.md` lists ~19 items; most are real UX gaps but none block a Tier 1 claim.

### P3 — long-tail polish / nice-to-have

19. Curly-quote sweep on visitor kiosk copy.
20. Konva fallback for floor plans at 500+ polygons.
21. Kiosk view-transitions (240ms crossfade).
22. PWA installable for vendor surfaces (would partially mitigate P0 #1 for vendors specifically).
23. Audit-trail surface for tenant admin (events exist; no UI beyond `/admin/privacy.tsx`).

---

## Top 10 capabilities required before claiming "best-in-class" leadership

In rough sequencing order (each unblocks ones below it):

1. **MS Graph Phase 3 + Phase 4 — Teams notifications channel + adaptive-card approve-in-place.** Closes P0 #2 partially. Estimate per spec: 3-4 wks + 2-3 wks. Unblocks: approver mobile/Teams approve, requester rating delivery via Teams DM.
2. **Approvals consolidation — manager-chain resolver + approver dashboard + escalation-on-timeout.** Closes P1 #7. Spec: `2026-04-28-approvals-design.md` ~5-6 wks. Backend foundation is already there; this is mostly a focused finish.
3. **Mobile-first portal + PWA + offline write queue.** Closes P0 #1 for the *requester* surface (the largest persona). Probably 4-6 wks given the portal is React + Tailwind already; needs `manifest.webmanifest`, service worker, IndexedDB queue, responsive pass.
4. **Vendor portal Phase B sprints 2-5 + Phase C (KDS + field-tech UX) for at least the catering subset.** Closes P0 #3 for vendors and unblocks vendor scorecards. Estimate per specs: 4-5 wks (Phase B remaining) + 8-12 wks (Phase C catering-only).
5. **Vendor scorecards + requester rating.** Closes P0 #3 for FM directors. Both specced; ~3-4 wks each.
6. **Reporting / dashboard builder + scheduled delivery + chargeback.** Closes P0 #4. Probably 6-8 wks for a credible v1.
7. **Knowledge base v1 (CRUD + search + ticket deflection).** Closes P0 #5. Probably 4-6 wks for a credible v1; can be deferred behind P0 #2-4 because it doesn't block buyer evaluation as hard as Outlook/mobile/scorecards.
8. **Inbound email channel.** Closes P0 #6. Same plumbing as inbound webhooks + a mail parser. 2-3 wks.
9. **Outlook add-in (Phase 5 of MS Graph spec).** Closes the last meaningful Outlook-buyer gap. 4-6 wks; could be parallelized with #1 by a different engineer.
10. **i18n pass — global NL + FR primitives in the web app, NL visitor email, NL kiosk copy.** Closes P1 #11. ~3-4 wks if the architecture is set up cleanly.

**Total elapsed:** ~30-45 weeks of focused, sequenced engineering against existing specs. (Honest discount: per memory `feedback_discount_ai_timelines`, AI-authored spec estimates inflate 30×; if those specs are AI-authored, the floor is more like 12-18 weeks total with the same engineer count.)

---

## Recommended sequencing — 30 / 60 / 90 days

### 30-day window (1 calendar month)

**Goal:** close the two highest-velocity P0 gaps and stop losing deals on dimension #2.

- **MS Graph Phase 3 — Teams notifications channel.** Email channel exists at `apps/api/src/modules/notifications/channels/email.channel.ts`; add `teams.channel.ts` alongside it. Plumbs into existing OutboxService notification handlers.
- **Approvals manager-chain resolver.** Backend-only; data already exists in `persons.manager_person_id`. Unblocks approval dashboard work in the 60-day window.
- **Mobile sprint 1: PWA manifest + service worker + offline read cache for portal "my requests" / "my bookings".** This alone moves the requester mobile score from MVP to MVP+ and is shippable in 2-3 wks.
- **Reporting sprint 1: scheduled delivery via existing email channel + CSV export endpoint.** Cheap wins from the existing reporting service. Doesn't move us to Prod but addresses the loudest sales objection.

### 60-day window (2 calendar months)

**Goal:** ship Phase 4 of MS Graph + Approvals UI + Vendor Portal Phase B remaining + Visitor v1 → v1.1.

- **MS Graph Phase 4 — adaptive cards approve-in-place** (depends on Phase 3 channel).
- **Approver dashboard UI** + batch-approve + mobile approver layout (depends on resolver from 30-day).
- **Vendor Portal Phase B sprints 2-5** — finishes the order-inbox / status-updates / decline flow shipped via Sprint 1.
- **Visitor v1.1: kiosk badge printing + NL visitor email + lobby panel.** Closes Envoy parity gap by ~80%.
- **Mobile sprint 2: offline write queue + responsive pass on the 8 most-used portal flows.**

### 90-day window (3 calendar months)

**Goal:** vendor scorecards + requester rating + reporting v2 + KB v1.

- **Vendor scorecards** (depends on Phase B status events shipped in 60-day; depends on daglijst data already shipped).
- **Requester rating** (depends on MS Graph Phase 3 channel; minimal otherwise).
- **Reporting v2: dashboard builder + cross-domain insights + chargeback.**
- **Knowledge base v1.** Standalone — could start in 30-day window if an engineer is free.
- **i18n pass — global web-app NL primitives.** Standalone — could parallelize.

**By end of 90-day window:** XPQT moves from MVP+ to Prod on Mobile, Approvals, Vendor Portal, Visitor, Reporting. Lifts the platform-wide claim from "good MVP+ across many domains" to "credible Prod across all primary dimensions; BIC on the 5 wedges."

**Not in the 90-day window** but should be on the radar: Outlook add-in (Phase 5 of MS Graph spec), Phase C vendor execution UX (KDS / field tech mobile), AI/copilot, change management, CMDB depth, hybrid-work analytics, email-to-ticket. Each is a separate ~4-8 wk slice.

---

## Personas under-modeled

The platform claims to serve 8 personas (`docs/users.md`). Per-persona honest assessment:

| Persona | Shell shipped | Coverage | Gap |
|---|---|---|---|
| **Requester (employee)** | `/portal/*` | ~75% | Mobile is MVP; no KB self-service to reduce ticket volume; rating prompt missing; calendar attach to-do |
| **Service-desk operator** | `/desk/*` | ~85% | The best-shipped persona. Approver inbox missing (lives under approvals); knowledge base missing; AI assist missing |
| **Facility / FM operator** | `/desk/*` (shared with desk operator) | ~70% | PM depth thin; CMDB missing; field-tech mobile UX missing (Phase C); change management missing |
| **Vendor (external)** | `/vendor-portal/*` (api only; web shipped from separate codebase per memory `project_vendor_portal_separate_codebase`) | ~30% | Phase B sprints 2-5 unbuilt; scorecards missing; KDS missing |
| **Approver** | scattered across `/desk/approvals` + `/portal/portal-approvals-lane` | ~40% | **Most under-modeled persona.** No dedicated inbox; no batch-approve; no mobile flow; no Teams approve; no manager-chain; no delegation pre-bake; no escalation. |
| **Receptionist** | `/desk/visitors` (merged from old `/reception/*`) | ~60% | Badge print missing; NL email; lobby panel; multi-host invite polish |
| **Tenant admin (settings author)** | `/admin/*` | ~80% | Admin pages are well-shipped per `docs/admin-page-conventions.md`. Workflow editor + rule builder are wedge BIC. Gaps: visual rule builder partially shipped; release-safety (draft/publish/rollback) not consistent per `docs/competitive-gap-analysis-2026-04-20.md` |
| **Kiosk visitor (one-time)** | `/kiosk/*` | ~75% | NL/FR copy; view-transitions; badge print integration |

**Worst-under-modeled persona = approver.** The data model is strong, the resolver isn't shipped, and there's no dedicated inbox. Every other persona has at least one shipped surface they can be productive in.

---

## Does the data model support best-in-class workflows, or will it need another rework?

**Yes, it supports them.** The data model is the strongest part of the platform. Specifically:

- **Booking canonicalization (`bookings` + `booking_slots`, migrations 00309-00385+).** Composite events as first-class. Per-line scheduling via `service_window_*`. Per-occurrence overrides via `recurrence_overridden` / `recurrence_skipped` / `repeats_with_series`. GiST-exclusion DB-level conflict prevention.
- **Universal workflow polymorphism (Phase 0+1 complete; Phase 2 imminent; migrations 00368-00376).** `workflow_instances.entity_kind` polymorphic across ticket+work_order+booking; `workflow_instance_links` for cascade; producer→spawn-handler→engine→wake/cancel/timeout three-path resolution. This is the workflow architecture *no other competitor has*.
- **Four-axis routing (routing / ownership / execution / visibility).** Per `docs/assignments-routing-fulfillment.md`. Resolver-with-persisted-decisions pattern is genuinely well-designed.
- **Three-tier visibility (participants / operators / overrides) + `ticket_visibility_ids` SQL predicate.** Per `docs/visibility.md`. Clean enforcement at SQL layer.
- **Approval `scope_breakdown` dedup + partial unique index.** Migrations 00012, 00146. One row per (entity, approver) across N lines. This is a real moat against ServiceNow.
- **GDPR baseline (retention engine + LIA + audit_outbox + DSR + legal holds + departure cascade).** Sprints 1-5 shipped (migrations 00161-00166). Per-tenant retention. The strongest competitor-comparable infra in the whole platform.
- **Outbox + workflow events + audit_outbox + inbox_notifications.** Recently rounded out with B.4.A.5 (migrations 00391-00402). Real-time inbox + audit trail wired correctly.

**The model is good. The shipping problem is not the model.** This is the most important finding in this audit. Every gap above is a *surface*, *integration*, *UX*, or *missing feature class* — none of them are "we need another schema rework". The 2026-05-01 → 2026-05-12 data-model rework appears to have hit its objective. Defending it requires *not* adding new schemas casually — the existing primitives are general enough to absorb almost every Tier 1 backlog item.

**The one place a future rework could land:** CMDB / asset relationships (today single-table). If `asset_relationships` + service-map graph becomes a hard requirement (Planon-replacement deals), that's an addition rather than a rework.

---

## Honest one-line per domain that anchors the recommendation

- **Wedges (5 BIC scores)** — keep defending. Don't add features that violate hidden-vendor or fragment the rule engine.
- **Routing/ticket (2 Prod scores)** — done; resist temptation to over-invest here at the expense of shipping anywhere else.
- **MVP+/MVP (14 scores)** — pick the 6 above and finish them. Don't add a 7th half-finished surface.
- **Missing (10 scores)** — six of these (Outlook add-in, KDS/Phase C, KB, email channel, AI, change management) are *cost the user is signing up for over the next 12 months*. Five of those six already have specs. Sequence them.

---

## Cross-references

- `docs/competitive-benchmark.md` — per-domain quality bars + Tier A/B/C matrix.
- `docs/competitive-gap-analysis-2026-04-20.md` — 2026-04-20 feature-matrix vs 9 competitors; some items have since shipped (visitors v1, floor plans, GDPR baseline) but the strategic shape holds.
- `docs/booking-platform-roadmap.md` — every booking-surface feature with PARITY/WEDGE/TABLE STAKES gate annotations.
- `docs/booking-services-roadmap.md` — services subsystem deep dive.
- `docs/service-management-current-state-review-2026-04-20.md` + `docs/service-management-improvement-roadmap-2026-04-20.md` — service-mgmt side audits.
- `docs/superpowers/specs/2026-04-27-microsoft-graph-integration-design.md` — MS Graph Phase 1-5 spec; Phases 1-2 ~70% shipped, Phases 3-5 unbuilt.
- `docs/superpowers/specs/2026-04-27-vendor-scorecards-design.md` — scorecard model lifted from ServiceChannel.
- `docs/superpowers/specs/2026-04-27-requester-rating-design.md` — voluntary signal design.
- `docs/superpowers/specs/2026-04-27-vendor-execution-ux-design.md` — KDS + field tech (Phase C).
- `docs/superpowers/specs/2026-04-28-approvals-design.md` — manager-chain + dashboard + Teams + escalation.
- `docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md` — Phase 0+1 complete; Phase 2 next.
- `docs/follow-ups/visitors-v1-polish.md` + `docs/follow-ups/visitors-v1-tech-debt.md` — Envoy-parity gap.
- `docs/follow-ups/floor-plan-deferred.md` — wayfinding Tier 1+2 backlog.
- `docs/phase-4.md` — KB / email channel / advanced reporting / AI; nothing started.

---

*End of audit.*

---

## Closure Ledger

Every agent that closes, partially closes, or intentionally defers a finding in this audit must add a row here in the same change. Do not mark the audit as complete from docs alone; cite code, migrations, product surfaces, tests, or follow-up docs that prove the claim.

| Date | Agent / owner | Status | Evidence | Verification | Notes |
|---|---|---:|---|---|---|
| 2026-05-13 | Handoff prompt added | tracking | `docs/follow-ups/audits/06-product-architecture.md` | Not run | All findings remain open unless a later row says otherwise. |

## Agent Handoff Prompt

```text
You are the lead product-architecture remediation agent for Prequest.

Primary file:
- docs/follow-ups/audits/06-product-architecture.md

Goal:
Close every actionable product-architecture gap in this audit, or turn it into a sequenced implementation plan with explicit owner, acceptance criteria, and verification. The end state is not "docs updated"; the end state is that the shipped product architecture honestly supports or rejects the "best-in-class" claim with evidence.

Read before editing:
- AGENTS.md and CLAUDE.md
- docs/follow-ups/audits/06-product-architecture.md
- docs/follow-ups/audits/00-integrator-verdict.md
- docs/competitive-benchmark.md
- docs/competitive-gap-analysis-2026-04-20.md
- docs/booking-platform-roadmap.md
- docs/booking-services-roadmap.md
- docs/service-management-implementation-plan.md
- docs/service-management-gap-review.md
- docs/service-management-review-2026-04-27.md
- docs/phase-4.md
- Any code, migrations, or docs referenced by the audit sections you are closing.

Execution model:
1. Verify each product-architecture claim against actual code and database structure first. Do not rely on roadmap prose as evidence of shipped behavior.
2. Split the work into small reviewable slices. Good slice boundaries are: Microsoft 365 / Teams depth, mobile/PWA operations, vendor execution and scorecards, requester feedback, reporting/analytics, knowledge base, email-to-ticket, and AI/automation.
3. Use parallel agents only for independent read-only investigation or disjoint implementation areas. Tell them they are not alone in the codebase and that they must not revert other work.
4. For every shipped slice, update the product docs and the Closure Ledger in this file in the same change. Include code paths, migrations, tests, smoke scripts, or screenshots that prove the status.
5. If a finding depends on blockers in 01-data-model.md, 02-tickets-work-orders.md, 03-booking-reservation.md, 04-rls-security.md, or 05-rpc-transactions.md, link that dependency instead of duplicating the fix.
6. Do not claim "best-in-class" for a domain until the buyer-evaluated dimensions are covered: workflow depth, integration depth, mobile execution, vendor operations, reporting, governance, supportability, and tested failure paths.

Required output after each slice:
- Code and/or docs changed.
- Tests or smoke verification run, with exact command and result.
- One Closure Ledger row in this file.
- Any newly discovered follow-up added to the relevant audit doc, not hidden in chat.

Completion bar:
- Every P0/P1 product gap in this file is either shipped with evidence or converted into a concrete implementation ticket with owner, order, and acceptance criteria.
- The scorecard in this audit reflects the actual shipped product, not aspirational roadmap text.
- The integrator verdict can be updated without contradicting code, database, or smoke evidence.
```
