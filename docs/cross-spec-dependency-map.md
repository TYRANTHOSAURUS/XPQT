# Cross-Spec Dependency Map — Tier 1+2 Booking Platform

**Status:** living reference — update as specs evolve and work ships.
**Last reviewed:** 2026-04-28.
**Use this doc to:** sequence engineering work, identify shared infrastructure, brief contributors on what blocks what. Headcount math intentionally absent — execution is autonomous-agent-driven, the bottleneck is sequencing and review quality, not seat count.

This is the integration view across the 11 specs designed to deliver Tier 1+2 best-in-class booking platform per `docs/booking-platform-roadmap.md`. **When this doc and individual specs disagree, fix this doc first** — it's the orchestration view.

---

## §1. Executive summary

**11 specs. ~75-100 weeks of design + implementation work, sequenced not staffed.** Each spec breaks into ~1-week sprint slices that run as autonomous-agent runs with codex review at slice boundaries (per the established cadence — see `project_wave1_progress.md`).

**Wave 0 — shipped 2026-04-28.** GDPR baseline (Sprints 1-5) + the audit-outbox foundation are on `main` (commits `bbe68d0` → `581a1a7` and post-review hardening `c6fca58`). Migrations 00161-00167 on remote. Every other spec consumes:
- `AuditOutboxService.emit / emitTx` for cross-spec audits
- `DataCategoryAdapter` registration for any new PII-bearing entity
- `tenant_retention_settings` per-category retention defaults
- The 7-day anonymization restore window (skipped for erasure)
- `gdpr_caller_has(<perm>)` for permission-aware RLS

**Critical path remaining** (must land before first-customer rollout):
1. ✅ GDPR baseline (audit outbox, retention, DSR, legal holds, admin UI). Wave 0 complete.
2. MS Graph integration Phase 1 + 2 (Outlook/Teams baseline).
3. Vendor portal Phase A (daglijst) + Phase B (login). **Phase A Sprint 1 + Phase B Sprint 1 shipped** (commits `5096128` / `66cbe88` / `6649cc5` / `9132dfa`).
4. Visitor management Phase 1-3 (pre-reg + kiosk + host notify).
5. Visual rule builder Sprint 1-2 (EntityPicker + service rule template flow). **EntityPickerAsync primitive shipped** (commits `a36b6e2` / `cda747f`).
6. Approvals (manager-chain + delegation + Teams approve-in-place). **Spec added 2026-04-28 to close the codex-flagged coverage gap.**
7. Floor-plan + wayfinding engine. **Spec added 2026-04-28** — cross-cuts rooms / desks / visitors / execution UX.

After critical path lands, remaining work (scorecards, ratings, execution UX, advanced rule builder phases) layers on top with more flexibility.

---

## §2. Spec inventory

| # | Spec | Effort | Tier | Critical path? | Status |
|---|---|---|---|---|---|
| 1 | [MS Graph integration](superpowers/specs/2026-04-27-microsoft-graph-integration-design.md) | 16-22 wks | T1 (P1-P2) / T2 (P3-P5) | Phases 1-2 yes; 3-5 follow-up | Pending impl; Phase 1 partly seeded by existing `apps/api/src/modules/calendar-sync/` |
| 2 | [Daglijst Phase A](superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md) | ~3 wks | T1 | Yes | **Sprint 1 shipped (5096128 / 66cbe88)** |
| 3 | [Visual rule builder](superpowers/specs/2026-04-27-visual-rule-builder-design.md) | ~8 wks | T1 (S1-S2) / T2 (S3-S4) | Sprint 1-2 yes; 3-4 follow-up | **Sprint 1A primitive shipped (a36b6e2 / cda747f)** |
| 4 | [GDPR baseline](superpowers/specs/2026-04-27-gdpr-baseline-design.md) | ~5-6 wks | T1 | Yes (foundational) | **Wave 0 complete (bbe68d0 → 581a1a7 → c6fca58)** |
| 5 | [Vendor portal Phase B](superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md) | ~4-5 wks | T1 | Yes | **Sprint 1 shipped (6649cc5 / 9132dfa)** |
| 6 | [Vendor scorecards](superpowers/specs/2026-04-27-vendor-scorecards-design.md) | ~3-4 wks | T1 | After Phase A+B | Pending impl |
| 7 | [Requester rating](superpowers/specs/2026-04-27-requester-rating-design.md) | ~3-4 wks | T1/T2 | After scorecards | Pending impl |
| 8 | [Vendor execution UX](superpowers/specs/2026-04-27-vendor-execution-ux-design.md) | ~12-16 wks | T2 | After Phase B | Pending impl |
| 9 | [Visitor management](superpowers/specs/2026-04-27-visitor-management-design.md) | ~8-10 wks | T1 (P1-P3) / T2 (P4-P5) | Phase 1-3 yes | Pending impl; backend agent in flight per `project_visitors_track_split_off.md` |
| **10** | **[Approvals](superpowers/specs/2026-04-28-approvals-design.md)** | ~5-6 wks | T1 | Yes | **Spec added 2026-04-28** to close codex-flagged Tier 1 coverage gap |
| **11** | **[Floor-plan / wayfinding](superpowers/specs/2026-04-28-floor-plan-wayfinding-design.md)** | ~6-8 wks | T1 (rooms+desks) / T2 (visitor lobby panel) | Yes for rooms/desks (parity vs Robin/Eptura) | **Spec added 2026-04-28** to close cross-cutting parity gap |

---

## §3. Shared infrastructure registry

These components are referenced by multiple specs. **Build once, use everywhere.** Owner of each shared component should be assigned during sprint 0 of the first spec that uses it.

### 3.1 EntityPicker primitive library

**Owner:** Visual rule builder spec (Sprint 1).
**Used by:** rule builder + admin forms (vendor service area, cost center default approver, bundle template) + vendor portal admin pages + visitor management admin + everything that currently has UUID inputs.
**Pattern:** generic `<EntityPicker<T>>` + per-entity-type adapters (catalog_item, menu, category, role, cost_center, person, vendor, asset_type, space, building, visitor_type, etc.).
**Dependency:** none.
**Implementation timing:** Sprint 1 of rule builder; lock contract first; sweep replaces UUID inputs across admin in subsequent sprints.

### 3.2 Audit outbox

**Owner:** GDPR baseline spec (Sprint 1).
**Used by:** every spec for emitting audit events transactionally.
**Pattern:** `audit_outbox` table inside transaction → background worker drains to `audit_events` → ships to SIEM if configured.
**Dependency:** none.
**Implementation timing:** GDPR Sprint 1 — must ship before any spec emits production audits; otherwise we retrofit.

### 3.3 Personal data access logging

**Owner:** GDPR baseline spec (Sprint 3).
**Used by:** every spec returning PII data; instrumented via `@LogPersonalDataAccess` decorator.
**Pattern:** decorator on service methods returning person/visitor data → batched writes to `personal_data_access_logs`.
**Dependency:** audit outbox.
**Implementation timing:** GDPR Sprint 3; sweeping wrap of existing services in subsequent week.

### 3.4 Microsoft Graph auth + token cache

**Owner:** MS Graph integration spec (Phase 1).
**Used by:** Teams notifications (multiple specs) + Outlook calendar sync + room mailbox discovery.
**Pattern:** multi-tenant Azure AD app + cert-based auth + Redis token cache + auto-refresh.
**Dependency:** Azure AD multi-tenant app registration (legal + security review).
**Implementation timing:** MS Graph Phase 1; without this, Teams notifications across all specs unavailable.

### 3.5 Teams notification adapter

**Owner:** MS Graph integration spec (Phase 3).
**Used by:** vendor portal Phase B (status alerts), requester rating (T+24h prompt), visitor management (host notification), scorecard alerts.
**Pattern:** adaptive card builder + Bot Framework adapter + `TeamsNotificationService.send(personId, eventType, payload)`.
**Dependency:** MS Graph auth (3.4).
**Implementation timing:** MS Graph Phase 3.

### 3.6 PDF rendering (@react-pdf/renderer)

**Owner:** Daglijst Phase A spec (Sprint 2).
**Used by:** daglijst + GDPR data subject access exports + vendor scorecard PDF exports + future invoices.
**Pattern:** JSX templates per document type + Node-native PDF buffer generation + Supabase Storage upload.
**Dependency:** none.
**Implementation timing:** Daglijst Sprint 2; lock template structure for reuse.

### 3.7 Supabase Storage signed URLs + tenant-isolated buckets

**Owner:** GDPR baseline (Sprint 4) — though Phase A daglijst uses it first.
**Used by:** daglijst PDFs + GDPR export bundles + visitor photos + ID scans + field-tech setup photos + cleaning task photos + future invoice PDFs.
**Pattern:** per-category tenant-isolated buckets with RLS + signed URLs with TTL + retention worker for deletion.
**Dependency:** RLS policies for storage.
**Implementation timing:** Daglijst Sprint 1 establishes the pattern; GDPR formalizes per-category retention.

### 3.8 PWA service worker + offline write queue

**Owner:** Vendor portal Phase B spec (Sprint 4).
**Used by:** vendor portal Phase B + KDS + mobile field tech + cleaning checklist + driver app + visitor kiosk.
**Pattern:** service worker for cache + IndexedDB write queue + sync-on-reconnect.
**Dependency:** none.
**Implementation timing:** Phase B Sprint 4; locked patterns reused across vendor execution UX phases.

### 3.9 Realtime channels (Supabase Realtime)

**Owner:** existing infrastructure.
**Used by:** vendor portal Phase B (status push to desk) + vendor execution UX (instant status visibility) + visitor management (lobby panel auto-refresh) + requester rating (live update on submit).
**Pattern:** per-tenant + per-resource channels; standardized event payloads.
**Dependency:** existing.
**Implementation timing:** Phase B Sprint 3 establishes vendor-side patterns; visitor management reuses for lobby panel.

### 3.10 Status state machine

**Owner:** existing (extended by Phase B).
**Used by:** vendor portal Phase B + vendor execution UX (per-surface state extensions).
**Pattern:** existing `vendor_order_status_events` from Phase B; surfaces extend with metadata.
**Dependency:** Phase B core.
**Implementation timing:** Phase B Sprint 3.

### 3.11 Magic-link auth for non-tenant users

**Owner:** Vendor portal Phase B spec (Sprint 1).
**Used by:** vendor users (Phase B) + kiosk auth (visitor management) + future external surfaces.
**Pattern:** separate identity pool (`vendor_users`, `kiosks`) + magic-link tokens + JWT sessions.
**Dependency:** none.
**Implementation timing:** Phase B Sprint 1; visitor management Phase 2 reuses for kiosk authentication.

### 3.12 Bundle + linked services

**Owner:** existing — already shipped per `project_linked_services_progress.md`.
**Used by:** visitor management (visitor as bundle line) + vendor execution UX (per-surface lookups) + requester rating (rate components of bundle).
**Pattern:** existing `booking_bundles` + `BundleCascadeService`.
**Dependency:** existing.
**Implementation timing:** N/A (already exists).

### 3.13 i18n stack (NL/FR/EN strings)

**Owner:** distributed; first spec to invest defines the pattern.
**Used by:** every spec.
**Pattern:** per-module translation files at `apps/api/src/modules/<module>/i18n/{lang}.json`; CI lint catches missing keys; per-user/per-vendor language preference.
**Dependency:** none.
**Implementation timing:** Daglijst Sprint 4 first; subsequent specs follow pattern.

### 3.14 Tenant retention configuration

**Owner:** GDPR baseline (Sprint 1).
**Used by:** every spec emitting PII-bearing data (registers a `DataCategoryAdapter`).
**Pattern:** `tenant_retention_settings` per category + LIA text + nightly retention worker.
**Dependency:** audit outbox.
**Implementation timing:** GDPR Sprint 1-2; every other spec must register its data category before merging to production.

---

## §4. Dependency graph

### Forward dependencies (X depends on Y)

```
GDPR baseline (audit outbox + retention registry)
   ↑
   ├── MS Graph integration       (calendar PII handling)
   ├── Daglijst Phase A           (PDF retention category)
   ├── Visual rule builder        (admin permissions)
   ├── Vendor portal Phase B      (vendor user retention category)
   ├── Vendor scorecards           (rating data category)
   ├── Requester rating            (rating retention + anonymization)
   ├── Vendor execution UX         (photo + geofence retention)
   └── Visitor management          (visitor + photo retention categories)

MS Graph integration (auth + Teams adapter)
   ↑
   ├── Vendor portal Phase B       (Teams DM optional channel)
   ├── Requester rating            (Teams DM channel)
   ├── Visitor management          (Teams DM host notify)
   ├── Vendor execution UX         (Teams new-order push)
   └── Visual rule builder         (cost-center approval routing via Teams)

Visual rule builder (EntityPicker library)
   ↑
   ├── Vendor portal Phase B       (admin vendor user picker, etc.)
   ├── Vendor execution UX         (catalog item picker for cleaning task templates)
   ├── Visitor management          (visitor type picker, building picker)
   ├── Vendor scorecards           (vendor compare picker)
   └── Daglijst Phase A             (vendor email picker)

Daglijst Phase A (PDF rendering pattern + status inference)
   ↑
   ├── Vendor portal Phase B       (PDF download from portal)
   └── Vendor scorecards           (status inference for paper-only vendors)

Vendor portal Phase B (auth + inbox + status state machine)
   ↑
   ├── Vendor execution UX         (KDS, mobile, cleaning, driver build on top)
   ├── Vendor scorecards           (self-reported status events)
   └── Visitor management          (kiosk auth pattern reuse)

Vendor scorecards
   ↑
   └── Requester rating            (data routes into scorecards)

Vendor execution UX
   ↑
   └── (no downstream specs)

Visitor management
   ↑
   └── Visitor as bundle line       (existing bundle infrastructure)
```

### Reverse dependencies (Y unblocks X, X, X...)

| Spec | Unblocks |
|---|---|
| **GDPR baseline** | All other specs (foundational) |
| **MS Graph integration** | Vendor portal B, Requester rating, Visitor mgmt, Execution UX, Rule builder approvals |
| **Visual rule builder Sprint 1** | EntityPicker swept into all admin surfaces |
| **Daglijst Phase A** | Vendor scorecards (paper-vendor data source) |
| **Vendor portal Phase B** | Execution UX + Scorecards + Visitor kiosk auth |
| **Visitor management Phase 2** | (kiosk auth pattern reused for future external surfaces) |

### Hard blockers vs soft dependencies

**Hard blockers (must complete before dependent spec starts):**
- ✅ GDPR audit outbox → all other specs. **Shipped — every downstream spec consumes `AuditOutboxService`.**
- MS Graph auth → Teams adapter.
- Phase B core auth → Execution UX.
- Phase A status inference → Scorecards (data quality).
- **Phase B PWA pattern → Visitor mgmt Phase 2 kiosk** (codex: was labeled soft dep; it's hard. Visitor kiosk is a PWA with offline writes, reusing the Phase B service worker + IndexedDB queue patterns. If Phase B slips the kiosk forks the foundation. Treat as hard.)
- **Phase B magic-link auth pattern → Visitor mgmt Phase 2 kiosk auth** (same logic — kiosk login reuses the magic-link flow, not a separate identity pool).

**Soft dependencies (helpful but not blocking):**
- EntityPicker library → admin sweeps (admin surfaces work with UUID inputs initially; sweep is iterative).
- Teams adapter → email-only fallback acceptable for v1 of Visitor management host notify.
- Realtime → polling acceptable as fallback during transition.

---

## §5. Recommended sequencing

### Wave 0 — Foundation ✅ SHIPPED 2026-04-28

GDPR baseline (Sprints 1-5) — audit outbox, 16 retention adapters, DSR access + erasure, legal holds, admin UI at `/admin/settings/privacy`, breach runbook, RoPA. Migrations 00161-00167 on remote.

Every other spec consumes the audit outbox + adapter contract from here.

### Wave 1 — Primary infrastructure

**Status:** in flight. Three Sprint-1 slices shipped + codex-reviewed (`a36b6e2`/`cda747f` rule builder primitive · `5096128`/`66cbe88` daglijst · `6649cc5`/`9132dfa` Phase B auth).

Remaining Wave 1 slices, ordered by hard-dep + value:

1. **Visual rule builder Sprint 1B** — rule template form + dry-run + JSON-editor replacement. Consumes the EntityPickerAsync primitive that's already in.
2. **Daglijst Sprint 2** — `@react-pdf/renderer` template + Supabase Storage upload + email delivery (HTML + bounce tracking) + scheduling worker. Sprint 1 ships the data plane; Sprint 2 ships the user-visible "list landed in vendor inbox at 19:00."
3. **Daglijst Sprint 3** — admin Fulfillment tab + post-cutoff lock workflow + desk follow-up dashboard. Locks-on-send wired here per the codex-flagged spec correction.
4. **Vendor portal Sprint 2** — `/vendor/auth/redeem` controller + portal guard + `/vendor/inbox` + `/vendor/orders/:id` + `VendorOrderService` with PII-minimised projections.
5. **Vendor portal Sprint 3** — status updates + decline + Realtime push to desk. Hard-dep on this for Visitor mgmt Phase 2 kiosk PWA pattern.
6. **MS Graph Phase 1** — multi-tenant Azure AD app upgrade (single-tenant cert auth + room-mailbox read are already in `apps/api/src/modules/calendar-sync/`); ghost-person creation; deep-link UX.

### Wave 2 — Visitor + advanced builder + Teams

Once Wave 1 closes, these can run in any order — they share no remaining hard-deps with each other:

- **Visitor management Phases 1-3** — pre-registration + kiosk PWA + multi-host notify. Reuses Phase B service worker + magic-link auth (now classified as hard-deps in §4 of this doc).
- **Visual rule builder Sprints 2-3** — advanced AST + simulator + debugger; room booking domain extension.
- **MS Graph Phase 2** — bi-di sync + conflict prevention.
- **MS Graph Phase 3** — Teams adapter (notifications) — needed by Phase B order alerts, requester rating prompts, visitor host notify, scorecard alerts.

### Wave 3 — Approvals (1-3) + analytics + KDS + floor-plan

- **Approvals (spec #10) Sprints 1-3 + override surface** — manager-chain, dashboard, batch approve, override. **Critical path** — Tier 1 per benchmark and roadmap §G3-G6. **Sprint 4 (Teams approve-in-place) deferred to Wave 4** because it hard-deps on MS Graph Phase 4.
- **Floor-plan / wayfinding (spec #11) Phases 1-3** — rendering engine + rooms + desks + wayfinding directional pointer. **Critical path** for Robin/Eptura parity.
- **Vendor scorecards** — after Phase A + B + Sprint 3 status events provide enough data quality.
- **Requester rating** — feeds scorecards.
- **Visitor mgmt Phases 4-5** — lobby panel + bundle integration + analytics + GDPR retention worker (consumes the GDPR adapter from Wave 0; consumes floor-plan engine from this wave).
- **Vendor execution UX Phase 1 (KDS catering)** — biggest vendor adoption driver per memory `project_internal_team_modes.md`.

### Wave 4 — MS Graph Phase 3-4 + execution UX rollout + Teams approvals

- **MS Graph Phase 3 + 4** — Teams adapter (notifications) + adaptive-card approvals.
- **Approvals Sprint 4** — Teams approve-in-place (consumes MS Graph Phase 4 adaptive-card actions).
- **Floor-plan Phase 4** — visitor lobby-panel rendering + PDF reuse (consumes visitor mgmt Phase 1-3 from Wave 2).
- **Vendor execution UX Phases 2-4** — AV / cleaning / transport.

### Wave 5 — Tier 2 / optional iteration

- MS Graph Phase 5 (Outlook add-in) — Tier 2; defer unless customer demand confirms (see §13 strategic decisions).
- Visual rule builder Sprint 4 — i18n + a11y audit.
- Various Tier 2 items per individual spec backlogs.

---

## §6. Pacing notes (replacing engineer-count math)

Execution is autonomous-agent-driven with codex review at each sprint slice. Pacing is bounded by:

- **Slice quality**: each slice = ~1 calendar week of work in the spec ≈ ~30-90 minutes of autonomous-agent run + codex review + a fix commit, when scoped tightly. Bigger slices (e.g. full Phase 1 of MS Graph) need to break into 1-2 week sub-slices.
- **Codex review cadence**: every sprint slice gets a review. Reviews cost minutes, not days. Hit usage limits twice in this run; retried successfully.
- **Doc + spec drift**: when a slice ships, this doc + the underlying spec get updated in the same change. Drift is what causes long-tail rework.
- **Validation interviews** (§9): customer time is the only real bottleneck. 5-10 FM-director conversations per checkpoint compresses 4-6 weeks of validation work into a day.

The previous "30-week 4-engineer baseline" framing is removed because (a) we don't actually have 4 engineers, (b) autonomous-agent throughput has different scaling characteristics, and (c) it gave false precision. Sequencing > capacity.

---

## §7. Milestones (replacing the calendar)

| Milestone | Status | Date |
|---|---|---|
| Wave 0 — GDPR foundation live on `main` | ✅ Done | 2026-04-28 |
| First three Wave 1 sprint slices shipped | ✅ Done | 2026-04-28 |
| Wave 1 complete (all 6 remaining slices above) | Pending | — |
| First validation checkpoint (FM-director interviews on retention defaults + Outlook UX) | Pending — schedule when Wave 1 hits 50% | — |
| Wave 2 complete (visitor + builder + Teams) | Pending | — |
| Wave 3 complete (approvals + analytics + KDS) | Pending | — |
| Wave 4 complete (floor-plan + execution UX rollout) | Pending | — |
| Best-in-class baseline ready for first wave-1 customer migrations | Pending | — |

If we want to ship to first wave-1 customers in Q1 2027, we have some buffer for:
- Polish + integration testing.
- FM-director validation interviews informing Tier 2 priorities.
- Migration tooling for existing legacy customers.

---

## §8. Critical path

**Cannot ship to first customers without these.** Marked with ⭐.

```
GDPR baseline Sprint 1-2 (audit outbox + retention) ⭐  ✅ SHIPPED 2026-04-28
   ↓
Daglijst Phase A ⭐ (NL/BE adoption blocker)                  Sprint 1 ✅; 2-3 pending
Vendor portal Phase B Sprint 1-3 ⭐ (Phase B core)            Sprint 1 ✅; 2-3 pending
MS Graph Phase 1 ⭐ (Outlook gap closer)
Visual rule builder Sprint 1-2 ⭐ (replace unusable JSON editor)  Sprint 1A ✅; 1B-2 pending
   ↓
MS Graph Phase 2 ⭐ (conflict prevention)
Visitor management Phase 1-3 ⭐ (Envoy parity gate)
   ↓
Approvals Sprint 1-3 ⭐ (manager-chain + dashboard + override) — gates first-customer
                                                                 because cost-center
                                                                 approvals are core
                                                                 corporate HQ wedge
                                                                 (memory project_industry_mix.md)
Floor-plan / wayfinding Phase 1-3 ⭐ (Robin/Eptura parity gate; rooms + desks + visitor)
   ↓
GDPR Sprint 3-5 ⭐ (right of access + erasure + breach runbook)  ✅ SHIPPED 2026-04-28
Visual rule builder Sprint 2 (advanced)  ←←← deferrable
Vendor scorecards (after Phase B + Daglijst data) ⭐ (procurement gate)
   ↓
MS Graph Phase 3 + 4 (Teams notifications + adaptive-card actions) ⭐
   ↓
Approvals Sprint 4 ⭐ — Teams approve-in-place (gated by MS Graph Phase 4)
Floor-plan Phase 4 (visitor lobby panel + PDF reuse)
   ↓
[Ready for first customer migrations]
```

**Cross-spec sequencing constraints baked in (post-codex correction 2026-04-28):**
- Approvals Sprint 4 (Teams approve-in-place) is **after** MS Graph Phase 4. Earlier draft of approvals spec implied Sprint 4 lands in Wave 3; corrected to Wave 4 — Teams adaptive-card actions are a hard-dep.
- Floor-plan Phase 4 (visitor lobby panel) is **after** visitor management Phase 1-3 since it consumes the visitors data + Realtime channels.
- Approvals Sprint 1-3 + override surface are independent and ship in Wave 3.

**Items NOT on critical path (deferrable to post-launch iteration):**
- MS Graph Phase 5 (Outlook add-in) — explicitly Tier 2 per §13.1.
- Vendor execution UX Phase 2-4 (AV, cleaning, transport) — KDS Phase 1 is highest-payoff; others can roll out post-launch.
- Requester rating system — can ship a few weeks post-launch.
- Visitor management Phase 4-5 (lobby panel + analytics + bundle integration) — Phase 1-3 alone is shippable.
- Visual rule builder Sprint 3-4 (room domain + i18n) — Sprint 1-2 alone covers service rules.
- Floor-plan Tier 2 (CAD/BIM/IWMS ingestion + true turn-by-turn) — Phase 5+; deferrable.

---

## §9. Validation checkpoints

Schedule FM-director interviews at these milestones to inform downstream decisions:

| When | What to validate | Specs reviewed |
|---|---|---|
| **Wave 0 end** (week 2) | Confirm GDPR retention defaults; LIA template approach; data residency questions | GDPR baseline |
| **Wave 1 mid** (week 6) | Outlook integration UX preview (deep-link approach); visual rule builder template flow | MS Graph + Rule builder |
| **Wave 1 end** (week 9) | Daglijst format preview; vendor portal walkthrough | Daglijst + Phase B |
| **Wave 2 mid** (week 12) | Visitor management kiosk + lobby panel UX; Teams notification format | Visitor + MS Graph Phase 3 |
| **Wave 3 mid** (week 18) | Scorecard model + visibility tier framing; rating prompt UX | Scorecards + Rating |
| **Wave 3 end** (week 21) | KDS demo with real catering vendor (private beta) | Execution UX Phase 1 |
| **Wave 4 mid** (week 25) | Migration readiness review; first-customer cutover plan | All specs combined |

5-10 interviews per checkpoint = roughly 1 day of customer time per checkpoint. Compresses the validation work into manageable batches.

---

## §10. Risk areas

### Cross-spec integration risks

**EntityPicker contract drift** — multiple specs depend on it. Risk: rule builder defines an API; subsequent users (Phase B admin, visitor admin) want different shape. Mitigation: lock EntityPicker contract early in Wave 1; deferred enhancement requests batch into Sprint 4.

**Audit outbox event taxonomy** — every spec emits events. Risk: inconsistent event naming makes audit log queries painful. Mitigation: GDPR Sprint 1 publishes naming convention; review every spec's event types in checkpoint.

**MS Graph token rotation** — multi-tenant app secret breaks all customer connections. Mitigation: certificate-based auth + dual-cert rolling rotation from day 1 (per MS Graph spec §3).

**Realtime channel naming** — Phase B + Visitor + Execution UX all subscribe to per-tenant channels. Risk: collisions or auth gaps. Mitigation: namespace conventions documented; integration test verifies isolation.

### Capacity risks

**Wave 0 bottleneck on GDPR** — only 1 engineer ramping; if absent, all subsequent work blocked. Mitigation: pair-programming Wave 0; ensure two engineers know the audit outbox pattern.

**Wave 2 has 3 streams** — coordination overhead. Mitigation: weekly cross-stream sync; clear interface contracts at stream boundaries.

**Visitor management coordinates with parallel backend agent** (per `project_visitors_track_split_off.md`). Mitigation: explicit handoff at end of agent's work; spec ownership transferred or aligned.

### Validation risks

**FM-director interviews don't materialize** — pre-wave-1 means no real customer pressure. Mitigation: schedule interviews via existing legacy customer relationships; even 3 interviews is better than 0.

**Validation finds major UX issues mid-Wave 3** — could redo Wave 1 work. Mitigation: validation checkpoints scheduled to surface issues *before* downstream work compounds.

### Scope creep risks

**Each spec has open questions** — answering them mid-implementation expands scope. Mitigation: open questions resolved by checkpoint owner before implementation starts; deferred items go to next wave, not current.

---

## §11. Implementation kickoff guide

When engineering planning starts, do this once:

### Step 1 — Resolve all "open questions" in specs

Each spec has §14-§18 open questions. Resolve before implementation:
- Some are decisions (multi-tenant Azure AD app — already resolved).
- Some are pricing / strategy (MS Graph SKU — open).
- Some are leadership-level (Verified Publisher pursuit — open).

Resolution is a 2-hour leadership review of all open questions consolidated.

### Step 2 — Convert specs to Linear/Jira epics

Each spec becomes 1 epic. Per epic:
- Epic description = link to spec.
- Acceptance criteria = spec §X (varies).
- Sub-tasks = sprint breakdown from spec §15 / §10.
- Tags: tier (T1/T2), parity-gate (PARITY/WEDGE/TS), dependency (block/unblock).

### Step 3 — Build the dependency graph in tooling

Linear/Jira "blocks" relationships per §4 dep graph here.

### Step 4 — Assign sprint-0 owners

Each Wave 0 + Wave 1 stream gets a lead. Cross-stream coordination via weekly sync.

### Step 5 — Schedule validation interviews

Week 2 onward; calendar holds for the 7 checkpoints.

### Step 6 — Track progress against this dependency map

Every 2 weeks, update §5 sequencing with actual progress vs plan. Surface deltas to leadership.

---

## §12. Cross-references

- [`docs/booking-platform-roadmap.md`](booking-platform-roadmap.md) — master roadmap with parity gates.
- [`docs/booking-services-roadmap.md`](booking-services-roadmap.md) — services subsystem deep dive.
- [`docs/competitive-benchmark.md`](competitive-benchmark.md) — competitive analysis backing parity gates.
- All 11 specs under `docs/superpowers/specs/2026-04-{27,28}-*-design.md`.

---

## §13. Strategic decisions (post-Wave-0 codex review)

Codex flagged 8 plan-level issues on 2026-04-28. These are the resolutions baked into this doc + the underlying roadmap.

### 13.1 Tiering calls vs `competitive-benchmark.md`

| Item | Benchmark says | We say | Reasoning |
|---|---|---|---|
| MS Graph Phase 5 — Outlook add-in | Tier-A must-have for room booking | **Tier 2 — defer to Wave 5** | Phase 1-2 deep-link approach (already in Wave 1) covers the "create a room booking from Outlook" use case. The add-in embeds Prequest UI inline — nicer, but not foundational. Memory `project_outlook_integration.md` confirms deep-link-first. Promote when first enterprise customer asks. |
| Visitor analytics | Tier-A must-have | **Tier 2 — defer to visitor mgmt Phase 4-5** | Our wedge per `reference_visitor_management_spec.md` is visitor-as-bundle-line — bundle-level analytics is the moat. Standalone visitor analytics is parity-only; Tier 2 is correct. |
| Real-time fulfilment status (services F14) | Tier-A must-have | **Promoted to Tier 1 — Phase B Sprint 3** | Cost is low: Phase B Sprint 3 already wires Realtime push to desk via the existing Supabase Realtime infra. Memory `project_vendor_fulfillment_reality.md`: "Responsiveness mandatory." Roadmap §F14 retiered. |
| Reorder / favorites (services F16) | Tier-A must-have | **Promoted to Tier 1 — Wave 3 service polish slice** | One-click reorder + favorite booking templates remove friction for repeat orderers. Cost ≈ 1 sprint slice; value is daily-driver. Roadmap §F16 retiered. |

### 13.2 F8 dispatch-cascade tiering

Roadmap §F8 had multi-step primary→secondary→tertiary cascade as Tier 1 across all service types. Codex argued this is overfit to ServiceChannel's enterprise FM model.

Re-tier per memory `project_vendor_count_reality.md` (typical tenant has 1 catering vendor per building):

| Service type | Capacity ceilings + blackout | Multi-vendor cascade |
|---|---|---|
| Catering | **Tier 1** | **Tier 2** — most tenants have one catering vendor; cascade is rarely useful |
| AV / equipment | Tier 1 | **Tier 1** — substitutes are real; vendor A unavailable → fall through |
| Cleaning | Tier 1 | **Tier 1** — same as AV |
| Supplies | Tier 1 | **Tier 1** — same |

Roadmap §F8 retiered accordingly.

### 13.3 Coverage gaps closed by new specs

Codex flagged two genuine Tier 1 coverage gaps with no design spec:

- **Approvals** (manager-chain, delegation, dashboard, mobile/Teams approve-in-place) — `docs/superpowers/specs/2026-04-28-approvals-design.md` ships in this set.
- **Floor-plan + wayfinding** (rooms + desks + visitor lobby) — `docs/superpowers/specs/2026-04-28-floor-plan-wayfinding-design.md` ships in this set.

Other roadmap items not yet specced (§A5-A7 rooms detail, §B1-B7 desks detail, §D1-D5 parking, etc.) are **incremental enhancements to existing room/desk modules** in `apps/api/src/modules/reservations/` + `apps/web/src/pages/desk/`, not net-new subsystems requiring their own spec. Tracked in roadmap backlog.

### 13.4 Soft-deps reclassified hard

See §4 of this doc — Phase B PWA pattern + Phase B magic-link auth are hard-deps for visitor mgmt Phase 2 kiosk, not soft.

### Memory references (ambient context)

- `feedback_quality_bar_comprehensive.md` — comprehensive scope; not lean.
- `feedback_no_friction_for_data.md` — vendors managed outside platform; voluntary signals only.
- `feedback_hide_vendor_from_requester.md` — vendor identity hidden from requesters.
- `feedback_best_in_class_not_legacy.md` — design for best-in-class.
- `project_no_wave1_yet.md` — no customer pressure; sort by foundational dependency.
- `project_market_benelux.md` — NL primary; FR secondary.
- `project_legacy_replacement.md` — feature parity is migration concern, not design.

---

**Maintenance rule:** when actual progress diverges from §5 sequencing, update §5 + §7 milestones in this doc. When new specs are added or scope changes, update §2 inventory + §4 dependency graph + §13 if a strategic call shifts. Treat this doc as the orchestration view of all specs combined.
