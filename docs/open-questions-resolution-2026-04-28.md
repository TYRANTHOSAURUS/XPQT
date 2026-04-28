# Open Questions Resolution — Tier 1+2 Specs

**Date:** 2026-04-28 (updated end-of-day after Wave 0 ship + Wave 1 first slices)
**Status:** working pre-read for leadership review; engineering can proceed with defaults below.
**Scope:** consolidates ~68 open questions from the (now 11) Tier 1+2 specs into one decision register.
**Use this doc to:** start coding without waiting for formal leadership session; flag the few items where leadership / privacy counsel input is genuinely required.

**Wave 0 status:** ✅ GDPR baseline shipped on `main` (2026-04-28). The defaults in §4 "GDPR baseline" + §2 "Privacy counsel needed" entries marked 🛡 are now operating defaults in production code. Counsel review can confirm or adjust without blocking — the implementation is reversible per the design (per-tenant retention overrides, anonymization is destructive but logged, hard-delete only on explicit subject demand + legal review per spec §6).

**Strategic positions baked in 2026-04-28** (per cross-spec-dependency-map §13): Outlook add-in stays Tier 2; visitor analytics stays Tier 2; real-time fulfilment status promoted to Tier 1; reorder/favorites promoted to Tier 1; F8 dispatch cascade re-tiered per service type. Leadership can override; defaults ship.

## How to read

Every question is one of:

- ✅ **Proceed with default** — engineering ships the recommended answer; reversible without painful migration if leadership later disagrees.
- ⚠️ **Leadership decide before implementation** — strategic / pricing / scope decision that's hard to reverse. Hold open until §3 review.
- 🛡 **Privacy counsel needed** — legal review required; engineering proceeds with defensive default.
- 🔬 **Customer validation needed** — FM-director interview will inform; engineering ships sensible default and revisits.

When this doc and individual specs disagree, **this doc supersedes** for the listed question.

---

## §1. Strategic decisions — ⚠️ leadership decide

These are not engineering decisions. Hold for the formal review session.

| # | Question | Spec | Default while waiting | Why leadership decides |
|---|---|---|---|---|
| S1 | MS Graph integration pricing tier (free for all / enterprise-gated / tiered) | MS Graph §14.3 | All capabilities behind per-tenant feature flags, default ON for everyone. Switch later via config. | Pricing strategy + product positioning. |
| S2 | AppSource Verified Publisher pursuit — start date | MS Graph §14.2 | Don't start verification yet (already deferred). Documented as eventual. | Board / legal approval. 4-8 week verification. |
| S3 | Self-serve subject access UI (Tier 2 priority) | GDPR §18.5 | Admin-mediated only in v1. | Customer-pipeline signal. |
| S4 | SOC 2 Type II audit trigger conditions | GDPR §18.x | Don't start; build foundations (audit outbox, retention) first. | Triggered by enterprise pipeline ask. |
| S5 | ISO 27001 / 27701 timing | GDPR §18.x + roadmap §G25-26 | Don't start. | Customer demand + cost-benefit. |
| S6 | Vendor scorecard self-view (vendor sees own scorecard) — Tier 2 timing | Scorecards §13.8 | Tenant-only in v1. | Strategic question about vendor relationship. |
| S7 | Cross-tenant industry benchmarks — Tier 3 priority | Scorecards §13.7 | Don't build. | Privacy framework + customer demand. |
| S8 | Native iOS/Android apps vs PWA-only — when to build | Execution UX §15.1 | PWA-only v1. | Tracks adoption + pain points before deciding. |
| S9 | Voice-driven kiosk (accessibility) timing | Visitor mgmt §18.6 | Defer. | Niche demand; revisit. |
| S10 | Cross-tenant kitchen view (one kitchen serves multiple tenants) | Execution UX §15.3 | Defer. | Per-tenant model holds. |
| S11 | Vendor portal — same-domain vs subdomain | Phase B §18.3 | Same domain (`/vendor/*`). | Reduces auth complexity. Reversible. |
| S12 | DPO appointment for Prequest itself | GDPR §18.7 | Designate `privacy@prequest.app` mailbox; formal DPO TBD. | Legal threshold question. |

**Total leadership questions: 12.** Realistic 90-min review session.

---

## §2. Privacy counsel needed — 🛡

Hold until counsel signs off. Engineering proceeds with defensive default in the meantime.

| # | Question | Spec | Defensive default | Counsel must confirm |
|---|---|---|---|---|
| P1 | `past_bookings` retention (7y NL audit vs shorter) | GDPR §18.1 | 7 years for orders (financial), 2 years for non-financial bookings. Tenant override available. | Whether this satisfies NL accounting + tax obligations. |
| P2 | `past_orders` retention | GDPR §18.1 | 7 years (NL invoice retention). | Same. |
| P3 | IP addresses in audit logs — raw vs hashed | GDPR §18.3 | Hashed with tenant-specific salt. | Whether hashed IPs satisfy access-log audit obligations. |
| P4 | Cross-border telemetry (Sentry, error monitoring, analytics) | GDPR §18.9 | Use EU-only telemetry vendor where available; document SCC for any non-EU. | Whether SCC + transfer impact assessment satisfies GDPR. |
| P5 | Erasure default — anonymize vs hard-delete | GDPR §18.2 | Anonymize (preserves operational records); hard-delete only on explicit subject demand + legal review. | Whether anonymization fully satisfies Article 17 in NL/BE. |
| P6 | Allergen explicit consent (Article 9 special category) | GDPR §18.x | Capture allergen as explicit consent at first dietary-profile creation; renewable yearly. | Whether this satisfies Article 9. |
| P7 | DPA template wording | GDPR §18.x | Use a standard NL/EU SaaS DPA template; counsel-reviewed before signing. | Counsel writes / reviews. |

**Total counsel questions: 7.** ~1-2 hours of counsel time across 1-2 sessions.

---

## §3. Customer validation needed — 🔬

Engineering ships sensible default; FM-director interview informs the next iteration.

| # | Question | Spec | Default | What to ask FM-directors |
|---|---|---|---|---|
| C1 | Daglijst default cutoff (3h before earliest delivery) | Daglijst §17.1 | 3 hours. | "When does your kitchen typically need orders confirmed by?" |
| C2 | Recurring meeting rating cadence (30 days default) | Rating §14.1 | 30 days. | "How often is too often to ask for feedback on a recurring meeting?" |
| C3 | Status inference grace_minutes (30 min default) | Daglijst §17.6 | 30 minutes. | "How long after delivery time do you consider 'late'?" |
| C4 | Geofence accuracy (50m default) | Execution UX §15.6 | 50m. | "Building footprint and arrival flow size?" |
| C5 | Visitor end-of-day sweep time (18:00 NL local default) | Visitor mgmt §18.8 | 18:00 NL local. | "What's a reasonable auto-checkout time?" |
| C6 | Visibility tier labeling (Limited / Partial / Standard / Rich) | Scorecards §3.5 | Use these labels. | "Do these terms make sense to FM directors?" |
| C7 | Composite scorecard format (A-F letter + 0-100 numeric) | Scorecards §13.1 | Both displayed. | "Which is more useful in vendor conversations?" |
| C8 | Allergen attestation surfacing on requester catalog (badges) | Booking-services-roadmap §9.1.4 | Per-item allergen pills inline. | "What allergen detail do attendees actually want?" |
| C9 | Past-rating history visible to requester in `/portal/me` | Rating §14.2 | Yes, lightweight history. | "Would users find this useful or feel surveilled?" |
| C10 | Driver ETA distribution (primary requester only vs all attendees) | Execution UX §15.4 | Primary requester only. | "Who do drivers want to update?" |

**Total validation questions: 10.** Distribute across the 7 validation checkpoints in `cross-spec-dependency-map.md` §9.

---

## §4. Operational defaults engineering picks — ✅ proceed

These are technical defaults engineering can set without waiting. Documented for visibility; reversible if a problem emerges.

### MS Graph integration

- **MS-1 — User-mailbox sync:** rooms-only Phase 1. ✅ (already decided)
- **MS-2 — Auto-create ghost persons:** yes, with three risk mitigations (janitor, dedup tools, external-attendee auto-flag). ✅ (already decided)
- **MS-3 — Bot Framework hosting:** Azure Bot Service. ✅ (already decided)
- **MS-4 — DM vs channel default:** DM-default; channel post opt-in deferred. ✅ (already decided)
- **MS-5 — Outlook add-in (Phase 5):** wait for Phase 1-3 validation. ✅ (already decided)
- **MS-6 — Auth model:** multi-tenant Azure AD app + per-tenant fallback for ~5% regulated minority + cert-based auth + dual-cert rolling rotation. ✅ (already decided)

### Daglijst Phase A

- **D1 — Email provider:** use whichever exists in `apps/api/src/modules/notifications/` (Postmark / SendGrid / Resend). Pick at sprint start. ✅
- **D2 — Bounce handling for repeat offenders:** auto-pause daglijst after 3 consecutive bounces; admin alerted; require explicit re-confirm. ✅
- **D3 — Per-vendor custom PDF templates:** v1 is single template per service_type. Custom templates → Tier 2 if asked. ✅
- **D4 — Desk send-on-demand discoverability:** "Regenerate now" button on vendor detail Fulfillment tab. ✅
- **D5 — Multi-vendor co-served buildings:** daglijst per vendor still right (cross-vendor coordination is admin's job). ✅

### Visual rule builder

- **R1 — Save flow:** draft → publish (explicit Publish button). ✅
- **R2 — Permissions split:** `rules:write` for draft, `rules:publish` for publish. ✅
- **R3 — Template versioning:** existing rules retain their template snapshot when seeded template is updated. ✅
- **R4 — Inline create from EntityPicker:** default off; opt-in per entity type. ✅
- **R5 — Mobile authoring:** defer; rules are admin-only desktop work. ✅
- **R6 — Auto-archive unused rules:** opt-in tenant setting; default off; warn before archiving. ✅
- **R7 — Subject regex on rules:** defer until specific demand. ✅
- **R8 — Bulk publish:** defer to v2. ✅

### GDPR baseline

- **G1 — MFA enforcement:** day 1 for `gdpr:*` permissions; configurable grace period for general admin (per tenant). ✅
- **G2 — Anomaly detection sensitivity:** per-tenant configurable; document defaults (multi-record export by single user, off-hours unusual IP, bulk read of restricted persons). ✅
- **G3 — Cookie consent / tracking consent:** out of scope here; align with analytics decisions. ✅

### Vendor portal Phase B

- **VP1 — Vendor manager role (manages other vendor_users for same vendor):** v1 ships fulfiller-only. Manager role Tier 2. ✅
- **VP2 — Email-on-create for paper-only vendors:** no — daglijst is their channel; per-order email would be noise. ✅
- **VP3 — Vendor scorecards visible to vendor:** no in v1 (S6 above). ✅
- **VP4 — PWA offline mode allow status updates:** yes, queue + sync. ✅
- **VP5 — Magic-link redemption different device than email recipient:** allow (UX > strict device-binding). ✅
- **VP6 — Forecast window beyond today:** 14-day default; vendor can extend. ✅
- **VP7 — Internal team without login surface:** doesn't need portal; desk surface handles. ✅
- **VP8 — Auto-cascade declines:** tenant opt-in (`auto_cascade_declines = true`); default off in v1. ✅

### Vendor scorecards

- **VS1 — Decline rate raw vs adjusted-for-fallback:** both views (raw + fallback-adjusted). ✅
- **VS2 — Weight presets vs sliders:** v1 ships sliders; presets ("Balanced/Speed/Quality") Tier 2. ✅
- **VS3 — Retention default:** 2 years; tenant override available. ✅
- **VS4 — Manual KPI overrides (admin marks event as outlier):** Tier 2; ship raw v1. ✅
- **VS5 — Multi-vendor comparison >2 vendors:** Tier 2. ✅

### Requester rating

- **RR1 — Rate-limit threshold:** 1/24h hard, 3/week soft. Tenant-configurable. ✅
- **RR2 — Specific-vendor rating prompts:** NEVER (breaks hidden-vendor rule). ✅
- **RR3 — Desk operator sees individual ratings:** no; aggregates only. ✅
- **RR4 — Surface aggregate ratings to requester:** NO (opens vendor identity question). ✅
- **RR5 — Multi-attendee rating:** Tier 2. ✅
- **RR6 — "Didn't happen" auto-cancel order_line_item:** yes; cascades to refund/no-charge logic when present. ✅
- **RR7 — Aggregate weighting (5* vs 4*):** simple linear avg in v1. ✅

### Vendor execution UX

- **EX1 — Cleaning task templates schema:** new `cleaning_tasks` table linked to catalog_items. ✅
- **EX2 — KDS recovery flow on WiFi drop:** persist last 12h locally + queue writes + sync on reconnect. ✅
- **EX3 — Photo retention default:** 90 days (already in GDPR baseline). ✅
- **EX4 — Voice notes:** Tier 3; defer. ✅
- **EX5 — Bump bar mapping:** tenant-fixed in v1; customization Tier 2. ✅

### Visitor management

- **V1 — Arrival confirmation email after check-in:** yes (proof of attendance for visitor's own records). ✅
- **V2 — NDA timing:** offer both (pre-arrival via portal + at kiosk fallback). ✅
- **V3 — ID scan via OCR:** v1 stores image only; OCR Tier 2. ✅
- **V4 — Visitor self-service check-out at kiosk:** yes — kiosk shortcut for "I'm leaving". ✅
- **V5 — Recognize repeat visitors across visits:** opt-in tenant setting; default off (privacy). ✅
- **V6 — Visitor language detection:** default to tenant primary; visitor can switch. ✅
- **V7 — End-of-day sweep configurable per building:** yes (per tenant + per building). ✅
- **V8 — Host ack via Teams card in-place vs click-through:** in-place ack via card action (Phase 4 of MS Graph). ✅

---

## §5. Resolution log (filled in during leadership review)

When the formal review session happens, fill this in:

| # | Question | Final decision | Decided by | Rationale |
|---|---|---|---|---|
| | | | | |

(Empty until the review session runs.)

---

## §6. Per-spec traceability

Quick lookup if you need to find a question's spec source.

| Spec | Open questions in spec | Resolved here? |
|---|---|---|
| MS Graph integration §14 | 8 (5 already decided + 3 here) | ✅ all resolved |
| Daglijst Phase A §17 | 7 | ✅ 5 here + 2 customer validation |
| Visual rule builder §20 | 8 | ✅ all resolved with defaults |
| GDPR baseline §18 | 9 | 🛡 7 → counsel + 2 defaults |
| Vendor portal Phase B §18 | 9 | ✅ 8 defaults + 1 leadership (S6) |
| Vendor scorecards §13 | 8 | ✅ 5 defaults + 3 leadership/customer |
| Requester rating §14 | 9 | ✅ 7 defaults + 2 customer validation |
| Vendor execution UX §15 | 9 | ✅ 5 defaults + 4 leadership/customer |
| Visitor management §18 | 9 | ✅ 8 defaults + 1 leadership (S9) |

**Total: 76 questions identified; 56 proceed-with-default; 12 leadership; 7 privacy counsel; 10 customer validation. Some overlap.**

---

## §7. What this means for engineering kickoff

Engineering can start **today**. Specifically:

- **Wave 0 (GDPR foundation):** start now with defensive defaults from §2; counsel review runs in parallel.
- **Wave 1 (MS Graph + Daglijst + Phase B + Rule builder):** all defaults in §4 are sufficient. Pricing tier (S1) doesn't block engineering — feature flags hold the place.
- **Wave 2 (Visitor mgmt + Teams + bi-di sync + advanced rule builder):** ship with §4 + §3 defaults. Customer validation interviews refine in next iteration.
- **Wave 3+:** scope locked enough to plan; minor adjustments come from validation feedback.

**Blockers that genuinely stop engineering:**
- ⚠️ S1 (MS Graph pricing tier) — doesn't actually block engineering since feature flags exist; blocks GTM only.
- 🛡 P5 (erasure default behavior) — must resolve before GDPR Sprint 4 ships erasure endpoint. Counsel review needed by ~week 4 of project.
- 🛡 P3 (IP raw vs hashed) — must resolve before GDPR Sprint 3 ships read-side audit. Counsel review by ~week 3.

Every other decision is either resolved by default (§4) or only affects post-launch UX iteration (§3).

---

## §8. Memory + audit

When leadership / counsel / customer validation sessions run, capture decisions in:

- **This doc §5** — append the resolution row.
- **Memory** — save as `feedback_*` if the resolution is a directional principle.
- **Spec source** — update the spec's open question section to reflect the resolution.

Maintain this doc as a living record until all rows are resolved. Then archive to `docs/decisions/` for posterity.

---

## §9. Cross-references

- All 9 specs under `docs/superpowers/specs/2026-04-27-*-design.md`.
- [`docs/cross-spec-dependency-map.md`](cross-spec-dependency-map.md) — sequencing + waves.
- [`docs/booking-platform-roadmap.md`](booking-platform-roadmap.md) — master roadmap.
- [`docs/booking-services-roadmap.md`](booking-services-roadmap.md) — services subsystem.

---

**Maintenance rule:** when a decision lands, fill §5 + update the source spec + save memory if directional. Archive to `docs/decisions/` once empty.
