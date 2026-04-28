# Booking & Order Platform — Master Roadmap with Competitive Parity Gates

**Status:** living reference doc. Update as items ship + competitive landscape shifts.
**Last reviewed:** 2026-04-27.
**Scope:** every feature in the booking and order process — rooms, desks, asset/equipment, parking/lockers/bikes/EV, visitors, service requests (catering/AV/cleaning/maintenance), and cross-cutting concerns (approvals, rules, reporting, mobile, compliance).
**Use this doc to:** scope work, justify priorities, brief contributors with the *why* behind each ticket.

## How to read this doc

Every roadmap item below carries a **Competitive parity gate** annotation:

- **PARITY** — closes a gap where one or more competitors already win. Without shipping it, we lose deals on this dimension by default.
- **WEDGE** — extends a Prequest moat. We're best-in-class on this; shipping deepens the lead.
- **TABLE STAKES** — basic capability that doesn't differentiate but must work. Failing here loses deals on credibility, not on dimension comparison.

Each item lists:
- Status (🟥 not started · 🟧 in design · 🟨 in progress · 🟩 shipped · ⬛ deferred)
- Tier (1 — must ship before broad migration; 2 — best-in-class polish; 3 — long-tail)
- Competitive parity gate (PARITY / WEDGE / TABLE STAKES + which competitors)
- Reference doc / spec link

When this doc and the competitive benchmark disagree, fix the doc first, then align decisions. Same rule as `docs/assignments-routing-fulfillment.md`.

## Cross-references

- [`docs/competitive-benchmark.md`](competitive-benchmark.md) — full competitive analysis (Tier A/B/C, per-dimension bars).
- [`docs/booking-services-roadmap.md`](booking-services-roadmap.md) — services subsystem deep dive (catering/AV/equipment/vendor).
- [`docs/superpowers/specs/2026-04-27-microsoft-graph-integration-design.md`](superpowers/specs/2026-04-27-microsoft-graph-integration-design.md) — MS 365 integration spec.
- [`docs/room-booking.md`](room-booking.md) — room booking operational reference.
- [`docs/visibility.md`](visibility.md) — three-tier visibility model.
- [`docs/assignments-routing-fulfillment.md`](assignments-routing-fulfillment.md) — routing engine reference.

---

# Table of contents

- [§A — Room booking](#a--room-booking)
- [§B — Desk booking / hot-desking](#b--desk-booking--hot-desking)
- [§C — Asset / equipment reservation (AV, projectors, mobile equipment)](#c--asset--equipment-reservation-av-projectors-mobile-equipment)
- [§D — Parking / lockers / bikes / EV charging](#d--parking--lockers--bikes--ev-charging)
- [§E — Visitor management](#e--visitor-management)
- [§F — Service requests (catering, AV setup, cleaning, maintenance)](#f--service-requests-catering-av-setup-cleaning-maintenance)
- [§G — Cross-cutting](#g--cross-cutting-approvals-rules-reporting-mobile-compliance-integrations)
- [§H — Per-feature parity gate matrix (summary)](#h--per-feature-parity-gate-matrix)

---

## §A — Room booking

### Tier 1

#### A1. Microsoft Graph integration (foundational)

**Status:** 🟧 in design — see [MS Graph integration spec](superpowers/specs/2026-04-27-microsoft-graph-integration-design.md)
**Estimated effort:** 16-22 weeks across 4 phases
**Competitive parity gate:** **PARITY** with Eptura/Condeco (Outlook add-in is gold standard) + ServiceNow WSD (Teams adaptive cards). Without this, we lose every "I live in Outlook" buyer in NL/BE corporate HQ — that's most of our target market. Phase 1 ships room mailbox sync + deep-link injection; Phase 2 ships bi-directional + conflict prevention; Phase 3 ships Teams notifications; Phase 4 ships Teams adaptive card actions; Phase 5 (Outlook add-in) deferred. The §6.5 conflict-prevention architecture (real-time room mailbox mirror) is what makes this *better* than competitor parity — we eliminate the "you booked, then got a cancellation email" failure mode.

#### A2. Composite booking dialog with bundle templates

**Status:** 🟩 shipped (sub-project 1 + 2)
**Competitive parity gate:** **WEDGE** — no major competitor models room+services as a single composite event. Eptura/Condeco gets to room+catering+AV in disconnected workflows; nobody else has bundle as a first-class concept. **Defend** by ensuring every new line type (visitor, parking, IT setup) attaches to bundle, never to reservation directly.

#### A3. Per-line scheduling within a booking

**Status:** 🟩 shipped (`order_line_items.service_window_*`)
**Competitive parity gate:** **WEDGE** — functionally absent across all major suites. "Catering at 12:30 inside a 9-5 booking" is not modelable in Eptura/Planon/ServiceNow without workflow scripting. **Defend** by making this the default authoring pattern in admin and requester surfaces.

#### A4. Per-occurrence recurrence overrides (skip / change / revert)

**Status:** 🟩 shipped (`recurrence_overridden`, `recurrence_skipped`, `repeats_with_series` flags)
**Competitive parity gate:** **WEDGE** — Eptura partial; Planon recurrence is series-level only; ServiceNow community-confirmed gap. **Defend** by extending to every line type (visitor on July 4? skip; parking on holiday? skip).

#### A5. Floor plan view with room status overlay

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Robin (gold standard for floor plans, drag-to-zoom, click-to-book) + deskbird (polish). Without floor plans, our requester UX feels less spatial than competitors. Bar: smooth drag/zoom, click-to-book, status colors (free/booked/mine/in-progress), responsive on mobile. Add interactive floor plan SVG export from CAD; or use Mappedin/Mazemap as backend.

#### A6. Slide-up sheet + chip-driven time selection

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with deskbird (this is the canonical pattern). Chips: "Now", "Lunch", "All day", "Custom". Reduces blank-slate friction. Implementation: shadcn Sheet component + chip row above DateTimePicker.

#### A7. Mobile-first booking flow

**Status:** 🟥 not started (current flow is desktop-shaped)
**Competitive parity gate:** **PARITY** with deskbird (best mobile in workplace category, 4.7+ App Store) + Sharebite. Phone-first design at 320-428px width. Single-handed reachability for primary actions. Native-feeling motion. Skeleton loaders. Full-screen sub-routes for nested flows on phone.

#### A8. Conflict prevention via real-time room mailbox mirror

**Status:** 🟧 in design (specced as part of MS Graph §6.5)
**Competitive parity gate:** **WEDGE** — no competitor has Prequest's level of conflict prevention discipline. Most rely on either "Outlook accepts, then conflicts resolve later" (fragile) or app-level pre-booking checks (race-conditions). Our DB-level GiST exclusion + room mailbox real-time mirror eliminates the "phantom cancellation" UX failure mode.

#### A9. GDPR baseline (booking metadata retention + audit reads)

**Status:** 🟥 not started — see [booking-services-roadmap §9.1.13](booking-services-roadmap.md)
**Competitive parity gate:** **PARITY** with Planon (NL/BE GDPR gold standard) + deskbird (EU-native). Required for every EU customer regardless of size. Tenant-configurable retention, right-of-erasure, audit log of personal-data access.

### Tier 2

#### A10. AI-suggested rooms based on attendee count, location, history

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — no major competitor offers this. ServiceNow has Now Assist but it's catalog-search-flavored, not room-suggesting. Bar: surface "Recommended for you: Boardroom B (you've used 3x in last month, fits 12 attendees)". Lift from Robin's "where's my team" pattern + add ML.

#### A11. Service availability filters in room search

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — "show me only rooms that can serve catering AND AV at this time" is not in any competitor's room-search UX. Lifts directly from our composite event model.

#### A12. Wayfinding / indoor mapping

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Eptura's Indoor Mapping. Niche but expected for >50,000 sqft HQs. Implementation: integrate Mappedin/Mazemap; mobile turn-by-turn from current location to room.

#### A13. Recurring meeting series with attendee-aware rebooking

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — when a recurring meeting attendee leaves the company, intelligently propose alternatives instead of breaking the series.

### Tier 3

#### A14. Predictive booking ("you usually book this room Tuesday morning")

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — long-tail polish. ML-driven personalization.

---

## §B — Desk booking / hot-desking

### Tier 1

#### B1. Per-desk reservation with conflict prevention

**Status:** 🟥 not started (only rooms today)
**Competitive parity gate:** **TABLE STAKES** — every workplace platform has this. Robin, Eptura, deskbird, Envoy, OfficeSpace all do desk booking. Without it, we don't compete in hybrid-work. Implementation: extend `reservations` schema to support `desk` resource type alongside rooms; reuse GiST exclusion for conflict prevention.

#### B2. "Where's my team sitting today" view

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Robin (this is their flagship feature). Find-a-desk-near-team. Mobile-first. Bar: tap a teammate → see their desk pinned on floor plan → book a desk near them in two more taps.

#### B3. Floor plan with desk status overlay

**Status:** 🟥 not started (overlaps with A5 — same floor plan engine)
**Competitive parity gate:** **PARITY** with Robin/deskbird. Status colors: available, booked, mine, blocked, neighborhood-restricted. Responsive on mobile.

#### B4. Hybrid-work attendance toggle ("am I in today?")

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with deskbird (their core product). One-tap "I'm in" / "I'm remote". Drives team visibility + analytics.

#### B5. Recurring desk bookings (every Tuesday + Thursday)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with deskbird + Eptura. Same recurrence engine as rooms.

#### B6. Mobile check-in via QR or geofence

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with deskbird + Robin. Reduces no-show fraud, validates capacity reporting.

#### B7. Desk as a bundle line item

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — extends our composite event model. "Office day = desk + locker + parking + lunch" as one orchestrated bundle. Nobody else can model this.

### Tier 2

#### B8. Neighborhood / team-cluster booking patterns

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Eptura (neighborhood occupancy is their analytics strength) + Robin. "Reserve a desk in the engineering neighborhood Tuesdays" pattern.

#### B9. Desk preferences (dual monitor, standing, sit-by-team)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with deskbird + Robin. Per-desk attribute tagging; per-user preference matching.

#### B10. No-show enforcement (auto-release after N minutes)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Robin/deskbird. Configurable per-tenant. Releases unused desks back to the pool.

#### B11. Desk utilization analytics + neighborhood demand

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Eptura (their bread and butter) + Robin. Daily/weekly/monthly trends, no-show rate, hot vs cold neighborhoods.

### Tier 3

#### B12. Predictive desk suggestion based on personal patterns

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — "Based on your last 4 weeks, you usually book desk 234 on Tuesdays" — preemptive booking suggestion. Long-tail polish.

#### B13. Sensor-based occupancy (IoT integration)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Eptura (sensor partnerships exist) + OfficeSpace. Defer — niche.

---

## §C — Asset / equipment reservation (AV, projectors, mobile equipment)

### Tier 1

#### C1. Asset records with serial, location, condition, lifecycle

**Status:** 🟨 partial (assets exist but lifecycle not modeled)
**Competitive parity gate:** **PARITY** with Planon (40-year hard-FM moat — strongest in category) + Eptura. Without serial-level tracking we can't compete in any FM-heavy buyer evaluation. Bar: photo, manual link, warranty expiry, last-serviced date, condition state machine.

#### C2. GiST conflict prevention on `asset_reservations`

**Status:** 🟩 shipped (migration 00142)
**Competitive parity gate:** **WEDGE** — DB-level race-safety. Most competitors rely on app-level checks. **Defend** by extending pattern to every new resource (parking spots, lockers, bikes).

#### C3. Asset reservation as bundle line item

**Status:** 🟩 shipped
**Competitive parity gate:** **WEDGE** — composite event model extension. AV reservation auto-cascades on booking cancellation; service window = "setup at 8:00 for 9:00 meeting; teardown at 11:00".

#### C4. Per-line scheduling for equipment (setup + teardown windows)

**Status:** 🟩 shipped (`service_window_*`)
**Competitive parity gate:** **WEDGE** — nobody else has this. Eptura supports asset-as-resource; service-window scheduling is open territory.

#### C5. AV technician dispatch flow

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Planon (field-services module is mature) + Eptura's iOFFICE half. Without dispatch, AV-as-bookable-resource is incomplete for enterprise. Bar: ticket auto-spawns when AV is reserved; tech assigned via routing rules; mobile field-tech UX.

#### C6. Photo proof of setup / teardown

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with ServiceChannel (geofenced check-in + photo evidence is their KDS-equivalent for FM). Bar: tech opens app, tap "arrived", capture photo, mark setup complete with photo attached to order line.

### Tier 2

#### C7. Asset check-out / check-in with QR

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with ServiceChannel + Planon. Mobile-first. Reduces "where's the projector?" tickets.

#### C8. Asset lifecycle tracking (purchase → maintenance → retirement)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Planon (40 years of model) + OfficeSpace (CMMS-lite). Required for hard-FM buyer alignment.

#### C9. AV vendor field-tech mobile UX

**Status:** 🟥 not started — see [booking-services-roadmap §9.2.0](booking-services-roadmap.md)
**Competitive parity gate:** **PARITY** with ServiceChannel + Planon's field-services app. Phone-first, offline-tolerant, photo proof, geofenced check-in.

#### C10. Predictive maintenance alerts based on usage

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — long-tail. Combines our usage analytics with maintenance schedules.

### Tier 3

#### C11. IoT integration for asset health (projector lamp hours, etc.)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Planon at extreme depth. Defer — niche.

---

## §D — Parking / lockers / bikes / EV charging

### Tier 1

#### D1. Reservable instances with conflict prevention

**Status:** 🟥 not started (parking is partial — see [parking-subsystem-scope spec](superpowers/specs/2026-04-26-parking-subsystem-scope.md))
**Competitive parity gate:** **TABLE STAKES** — Skedda, Spacewell, dedicated tools handle this. Our wedge is unifying with rest of platform. Implementation: same asset reservation pattern, new resource types (`parking_spot`, `locker`, `bike`, `ev_charger`).

#### D2. Recurring reservations (every Tuesday parking spot)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with deskbird (recurrence engine) + Skedda. Common request from corporate HQ users.

#### D3. Mobile QR check-in

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with deskbird + Skedda. No-show fraud prevention; capacity reporting.

#### D4. Parking/locker as bundle line ("office day" template)

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — composite event. Bundle template "Office day" = desk + locker + parking + bike-storage + lunch. Nobody else can model this end-to-end.

#### D5. Capacity awareness ("EV charger 1 of 4 available")

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with EV-specialty tools (PlugShare, ChargePoint enterprise). Capacity-aware UX critical for high-demand resources.

### Tier 2

#### D6. Day-pattern reservations (every Tuesday + Thursday Q2)

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — day-pattern is a step beyond simple recurrence; few tools do this cleanly.

#### D7. Wait-list when full (auto-promote)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with EV-specialty tools. Reasonable expectation for parking demand spikes.

#### D8. Time-of-day pricing / cost-center accounting

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — extends our cost-center routing to parking/EV consumption.

### Tier 3

#### D9. Bike maintenance scheduling

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with bike-specific tools. Niche.

#### D10. EV charging session telemetry (kWh, cost) integration

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with charging hardware vendors. Niche but increasingly expected for sustainability reporting.

---

## §E — Visitor management

### Tier 1

#### E1. Pre-registration with QR pass

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Envoy (gold standard). Host invites visitor → email with QR + map → visitor arrives, scans, enters. Without this, visitor management is clearly inferior to Envoy.

#### E2. Kiosk check-in (badge print, photo, NDA, watchlist)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Envoy. iPad-mounted kiosk in lobby. Single-flow polish — Envoy benchmark for "single-purpose-screen UX".

#### E3. Host notification (email + Teams)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Envoy + Eptura's Proxyclick. Real-time notification when visitor arrives.

#### E4. Visitor as bundle line item

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — composite event. Visitor + meeting + room + parking spot + reception briefing as one orchestrated event. Nobody can model this end-to-end.

#### E5. GDPR-compliant visitor retention with tenant LIA

**Status:** 🟥 not started — see [booking-services-roadmap §9.1.13](booking-services-roadmap.md)
**Competitive parity gate:** **PARITY** with Envoy (privacy-led product) + Planon (NL/BE government grade). Tenant-configurable retention (default 6 months / cap 12 months for visit records, 30-90 days for photos/IDs).

#### E6. Watchlist + denied entry workflow

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Envoy. Required for security-conscious tenants.

#### E7. Reception lobby panel ("today's visitors expected")

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Envoy. Single-purpose-screen UX matching kiosk-grade polish.

### Tier 2

#### E8. Visitor analytics (today expected, current on-site, history)

**Status:** 🟥 not started
**Tier confirmed Tier 2 (2026-04-28)** per cross-spec-dependency-map §13.1. Codex flagged this as a benchmark must-have, but our wedge per `reference_visitor_management_spec.md` is visitor-as-bundle-line — bundle-level analytics is the moat. Standalone visitor analytics is parity-only and can ship in visitor management Phase 4-5 alongside the lobby panel work, where the reception use case actually lives.
**Competitive parity gate:** **PARITY** with Envoy. Reception team dashboard + reporting.

#### E9. Multi-host visitor invitation (visitor coming for meeting with 3 hosts)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Envoy. All hosts notified; first to respond owns visitor.

#### E10. Self-serve pre-registration link for hosts

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Envoy. Host shares link without admin involvement.

#### E11. Custom visitor types with different flows (contractor / interview / delivery)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Envoy + Proxyclick. Flow templates per type.

### Tier 3

#### E12. Facial recognition opt-in (highly regulated tenants only)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** at niche depth. Defer until specific customer demand. GDPR Article 9 compliance gate.

#### E13. Integration with badge/access control hardware (HID, etc.)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Envoy at advanced depth.

---

## §F — Service requests (catering, AV setup, cleaning, maintenance)

This subsystem has its own deep roadmap at [`docs/booking-services-roadmap.md`](booking-services-roadmap.md). Summary with parity gates here; reference doc for sub-tasks + acceptance.

### Tier 1

#### F1. Catering catalog with photos, dietary filters, per-person pricing

**Status:** 🟨 partial — see booking-services-roadmap
**Competitive parity gate:** **PARITY** with ezCater (gold standard for B2B catering catalog) + Eptura/Condeco. Vendor card grid, dietary chips, per-person + per-item pricing modes.

#### F2. Vendor portal Phase A — daglijst (printed daily list)

**Status:** 🟥 not started — see booking-services-roadmap §9.1.1 Phase A
**Competitive parity gate:** **PARITY** with NL FM ops reality (vendor reality where many caterers don't use software). Without this, we exclude entire EU client segments running on printed lists. Not a direct competitor parity gap — a market reality gap. Critical Tier 1.

#### F3. Vendor portal Phase B — login + status updates

**Status:** 🟥 not started — see booking-services-roadmap §9.1.1 Phase B
**Competitive parity gate:** **PARITY** with Planon's Supplier Portal + ServiceChannel's vendor inbox. Without it, desk operators are SPOF for vendor failures.

#### F4. Visual rule builder for service rules

**Status:** 🟥 not started — see booking-services-roadmap §9.1.2
**Competitive parity gate:** **PARITY** with ServiceNow Flow Designer (visual rule UX) + ahead of Planon (which requires consultants per change) + ahead of Eptura (which has per-module rule surfaces, not a unified engine). This is also where our **WEDGE** lives — single predicate engine across rooms + services + visitors + parking is something nobody else has.

#### F5. Hidden vendor identity + tenant toggle

**Status:** 🟧 in design (rule documented; tenant toggle per booking-services-roadmap §9.1.7)
**Competitive parity gate:** **WEDGE** — no competitor offers this as first-class principle. Eptura hides vendors by accident; ServiceNow exposes them; ezCater is vendor-first. **Defend** religiously.

#### F6. EU FIC allergen / dietary safety trail

**Status:** 🟥 not started — see booking-services-roadmap §9.1.4
**Competitive parity gate:** **WEDGE** — *zero* competitors have proper EU FIC compliance. Planon scores 4/10, Eptura 5/10, Robin 2/10, ServiceNow 2/10, deskbird 2/10. Shipping this is genuine differentiation, not parity. Per-vendor certifications + per-item attestations + requester filter UI.

#### F7. Vendor scorecards data model + admin UI

**Status:** 🟥 not started — see booking-services-roadmap §9.1.3
**Competitive parity gate:** **PARITY** with ServiceChannel (best-in-class scorecard model anywhere in FM software) + Planon Insights. Data model lift directly from ServiceChannel: response time, on-time %, ack latency, decline rate, cost variance, post-order rating. Without this, FM directors can't justify decisions with data → loses competitive evals.

#### F8. Vendor capacity model + dispatch cascade

**Status:** 🟥 not started — see booking-services-roadmap §9.1.5
**Competitive parity gate:** split per service type (re-tiered 2026-04-28 per cross-spec-dependency-map §13.2; see also memory `project_vendor_count_reality.md`):

| Sub-feature | Catering | AV / equipment | Cleaning | Supplies |
|---|---|---|---|---|
| Capacity ceilings + blackout calendars | **Tier 1** | **Tier 1** | **Tier 1** | **Tier 1** |
| Multi-vendor primary→secondary→tertiary cascade | **Tier 2** | **Tier 1** | **Tier 1** | **Tier 1** |

The cascade is overfit to ServiceChannel's enterprise FM model for catering (typical tenant has one catering vendor per building per `project_vendor_count_reality.md`). For AV / cleaning / supplies, substitutes are real and cascade is genuine Tier 1.

#### F9. Catalog dedup / equivalence tooling

**Status:** 🟥 not started — see booking-services-roadmap §9.1.6
**Competitive parity gate:** **WEDGE** — no competitor has this. Two vendors offering "sandwich platter" → admin marks equivalent → requester sees one canonical line. Unique to our hidden-vendor model.

#### F10. Approval dedup via scope_breakdown

**Status:** 🟩 shipped (migration 00146)
**Competitive parity gate:** **WEDGE** — ServiceNow / Eptura / Planon all create N approvals for N-line events. We dedupe to one. **Defend** by extending pattern to every new approval surface.

### Tier 2

#### F11. Catering KDS for vendors (Toast/Square-tier)

**Status:** 🟥 not started — see booking-services-roadmap §9.2.0
**Competitive parity gate:** **PARITY** with Toast/Square KDS (gold standard for kitchen UX in restaurants). Translated to corporate catering with our wedge — meeting context (room, attendees, dietary profiles) on every ticket. Nobody currently does this.

#### F12. AV / equipment field tech mobile UX

**Status:** 🟥 not started — see booking-services-roadmap §9.2.0
**Competitive parity gate:** **PARITY** with ServiceChannel field-tech app + Planon mobile field-services. Phone-first, offline-tolerant, photo proof.

#### F13. Cleaning checklist UX (geofenced + photo proof)

**Status:** 🟥 not started — see booking-services-roadmap §9.2.0
**Competitive parity gate:** **PARITY** with ServiceChannel evidence-capture pattern. Geofenced check-in, per-task photo proof.

#### F14. Real-time fulfillment status to requester

**Status:** 🟥 not started — see booking-services-roadmap §9.2.1
**Tier:** **MOVED TO TIER 1 (2026-04-28)** per cross-spec-dependency-map §13.1. Codex review flagged this as a benchmark must-have. Cost is low: vendor portal Phase B Sprint 3 already wires Realtime push to desk via Supabase Realtime; extending to a per-requester subscription is incremental. Memory `project_vendor_fulfillment_reality.md` is explicit ("responsiveness mandatory").
**Competitive parity gate:** **PARITY** with ezCater (received → preparing → en route → arrived). Today's UX has a "blackbox" period; this closes it.

#### F15. Custom request path ("something not in the catalog")

**Status:** 🟥 not started — see booking-services-roadmap §9.2.2
**Competitive parity gate:** **WEDGE** — no competitor has this as a first-class flow. Routes to desk for manual quoting.

#### F16. Reorder + favorites for catering

**Status:** 🟥 not started — see booking-services-roadmap §9.2.4
**Tier:** **MOVED TO TIER 1 (2026-04-28)** per cross-spec-dependency-map §13.1. Codex review flagged this as a benchmark must-have. Cost ≈ 1 sprint slice; value is daily-driver — 80% of corporate catering is repeat orders, and this removes the friction that pushes admins back to email.
**Competitive parity gate:** **PARITY** with ezCater (their primary affordance). 80% of corporate catering is repeat orders.

#### F17. Approver inbox dashboard (batch approve, mobile)

**Status:** 🟥 not started — see booking-services-roadmap §9.2.6
**Competitive parity gate:** **PARITY** with ServiceNow approver UX. Smart sorting, mobile-responsive, batch approve.

### Tier 3

#### F18. POS integration (Toast / Square / custom webhook)

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — emerging differentiator. Direct integration with vendor's existing kitchen software bypasses the "vendor adoption" problem entirely.

#### F19. White-label "service brand" customization

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — extends hidden-vendor positioning to tenant's brand on requester surfaces.

---

## §G — Cross-cutting (approvals, rules, reporting, mobile, compliance, integrations)

### Tier 1 — approvals + rules

#### G1. One predicate engine across rooms + services + visitors + parking

**Status:** 🟩 shipped (rooms + services); 🟥 not started for visitors + parking
**Competitive parity gate:** **WEDGE** — ServiceNow has six rule systems for the same problem; Eptura has separate rule surfaces per module; Planon requires consultants per change. **Defend** religiously: every new rule type must extend the existing engine.

#### G2. Cost-center driven approval routing

**Status:** 🟩 shipped (`cost_centers.default_approver_person_id`)
**Competitive parity gate:** **PARITY** with ServiceNow Flow Designer + MRI Software's finance-grade modeling. **Wedge** vs Eptura/Robin/deskbird who treat approver as static dropdown.

#### G3. Multi-stage approval chains

**Status:** 🟨 partial
**Competitive parity gate:** **PARITY** with ServiceNow (10-year mature) + Planon. Manager → finance → facilities chain.

#### G4. Out-of-office delegation

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with ServiceNow. Approver away → forward to delegate for date range.

#### G5. Approval dashboard with batch approve

**Status:** 🟥 not started — see booking-services-roadmap §9.2.6
**Competitive parity gate:** **PARITY** with ServiceNow. Mobile-first. Smart sort.

#### G6. Approve from Teams adaptive cards (Phase 4 of MS Graph)

**Status:** 🟥 not started — see MS Graph spec
**Competitive parity gate:** **PARITY** with ServiceNow + Eptura/Condeco. Differentiator vs Planon (which is Outlook-only).

### Tier 1 — reporting + analytics

#### G7. Booking analytics (occupancy, no-shows, neighborhood demand)

**Status:** 🟨 partial — five reports shipped (`/desk/reports/bookings/*`)
**Competitive parity gate:** **PARITY** with Eptura (mature dashboards are their bread and butter) + Robin. Without this, we lose the workplace-experience analytics conversation.

#### G8. Vendor performance reporting (cost variance, on-time %, scorecards)

**Status:** 🟥 not started — see F7
**Competitive parity gate:** **PARITY** with Planon Insights (Qlik-backed) + ServiceChannel scorecards.

#### G9. Cost-center spend reporting

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with MRI Software (finance-grade lineage). Monthly export to GL system; YTD/QTD/MTD views.

### Tier 1 — mobile + design polish

#### G10. Mobile-first responsiveness across all surfaces

**Status:** 🟨 partial
**Competitive parity gate:** **PARITY** with deskbird (best mobile in workplace category) + Sharebite. Phone-first design at 320-428px, single-handed reachability.

#### G11. Linear-tier polish (motion, density, typography)

**Status:** 🟨 partial — design tokens in `apps/web/src/index.css`
**Competitive parity gate:** **PARITY** with deskbird (visual benchmark for hybrid-work tools). Skeleton loaders, 200ms `--ease-smooth`, restrained color, hairline dividers, tabular numerals, balanced text wrap.

#### G12. PWA-installable for vendor surfaces

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — KDS + field tech surfaces installable as PWA on iPad/phone. Offline-tolerant. Beyond what deskbird does.

#### G13. Offline queue for write actions

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — Robin and Envoy assume always-online; deskbird is close to phone-first but doesn't queue writes. Genuine differentiator for field-heavy users.

### Tier 1 — compliance

#### G14. GDPR baseline (DPA, retention, erasure, EU residency, audit reads)

**Status:** 🟥 not started — see booking-services-roadmap §9.1.13
**Competitive parity gate:** **PARITY** with Planon (NL/BE government-grade) + deskbird (EU-native). Required for every EU customer; deal-blocker if missing.

#### G15. Audit outbox (transactional event logging)

**Status:** 🟥 not started — see booking-services-roadmap §9.1.12
**Competitive parity gate:** **PARITY** with enterprise-grade tools. Required for SOC 2 / GDPR audit posture. Foundation for G14 + future G16.

#### G16. Sub-processor disclosure + breach runbook

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with enterprise procurement asks. Operational, not engineering-heavy.

### Tier 1 — integrations

#### G17. Microsoft Graph integration (calendar + Teams + room mailboxes)

See A1.

#### G18. Identity / SSO (Azure AD, Okta, Google Workspace SSO)

**Status:** 🟨 partial (Supabase Auth covers email/password; SSO depth unclear)
**Competitive parity gate:** **TABLE STAKES** — every enterprise buyer requires this. Without proper SSO, we don't get past procurement.

### Tier 2

#### G19. Out-of-office delegation across approval flows

See G4 — Tier 1 fundamental but extends with delegation rules.

#### G20. Conditional auto-approve rules

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with ServiceNow. "Auto-approve catering under €200 from this cost center."

#### G21. Reporting custom dashboards (admin-defined widgets)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Eptura Insights + ServiceNow Performance Analytics.

#### G22. SOC 2 Type II audit readiness

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with enterprise pipeline ask. 6-12 months program work; only triggered when first enterprise pipeline demands it.

#### G23. Slack integration (notifications + approve actions)

**Status:** ⬛ deferred — Slack rare in NL/BE corporate HQ
**Competitive parity gate:** **PARITY** with Robin/deskbird (both have it). Defer until customer demand emerges.

#### G24. Microsoft Bookings interop

**Status:** ⬛ deferred — niche
**Competitive parity gate:** **PARITY** at niche depth. Defer.

### Tier 3

#### G25. ISO 27001 certification

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Planon (NL/BE gold) + Eptura. Triggered by enterprise / government pipeline.

#### G26. ISO 27701 certification (privacy management)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with Planon (their crown jewel for NL/BE government). Long-tail enterprise differentiator.

#### G27. Stack-and-block / scenario planning (move management)

**Status:** 🟥 not started
**Competitive parity gate:** **PARITY** with OfficeSpace (their niche strength). Different buyer; defer unless pipeline demands.

#### G28. AI assistant for booking suggestions ("when's the best time to meet with these 5 people?")

**Status:** 🟥 not started
**Competitive parity gate:** **WEDGE** — emerging frontier. ServiceNow has Now Assist; nobody else has serious AI in workplace booking yet.

---

## §H — Per-feature parity gate matrix

Quick-reference summary. P = PARITY, W = WEDGE, TS = TABLE STAKES.

| ID | Feature | Tier | Gate | Primary competitor benchmark |
|---|---|---|---|---|
| **A — Room booking** | | | | |
| A1 | MS Graph integration | 1 | P | Eptura/Condeco Outlook + ServiceNow Teams |
| A2 | Composite booking dialog (bundle) | 1 | W | (none — unique) |
| A3 | Per-line scheduling | 1 | W | (none — unique) |
| A4 | Per-occurrence overrides | 1 | W | (none — unique) |
| A5 | Floor plan view | 1 | P | Robin (gold) + deskbird |
| A6 | Slide-up sheet + chip time selection | 1 | P | deskbird |
| A7 | Mobile-first booking flow | 1 | P | deskbird + Sharebite |
| A8 | Conflict prevention (room mailbox mirror) | 1 | W | (none — unique) |
| A9 | GDPR booking metadata retention | 1 | P | Planon + deskbird |
| A10 | AI room suggestions | 2 | W | (frontier) |
| A11 | Service availability filters | 2 | W | (none — unique) |
| A12 | Wayfinding / indoor mapping | 2 | P | Eptura |
| A13 | Recurring meeting attendee-aware rebooking | 2 | W | (none) |
| A14 | Predictive booking | 3 | W | (frontier) |
| **B — Desk booking** | | | | |
| B1 | Per-desk reservation | 1 | TS | All — table stakes |
| B2 | "Where's my team" view | 1 | P | Robin |
| B3 | Floor plan with desk status | 1 | P | Robin/deskbird |
| B4 | Hybrid-work attendance toggle | 1 | P | deskbird |
| B5 | Recurring desk bookings | 1 | P | deskbird + Eptura |
| B6 | Mobile QR check-in | 1 | P | deskbird + Robin |
| B7 | Desk as bundle line | 1 | W | (none — unique) |
| B8 | Neighborhood booking | 2 | P | Eptura + Robin |
| B9 | Desk preferences | 2 | P | deskbird + Robin |
| B10 | No-show enforcement | 2 | P | Robin/deskbird |
| B11 | Desk utilization analytics | 2 | P | Eptura + Robin |
| B12 | Predictive desk suggestion | 3 | W | (frontier) |
| B13 | Sensor-based occupancy | 3 | P | Eptura + OfficeSpace |
| **C — Asset / equipment** | | | | |
| C1 | Asset records with lifecycle | 1 | P | Planon (gold) + Eptura |
| C2 | GiST conflict prevention | 1 | W | (none — DB-level) |
| C3 | Asset reservation as bundle line | 1 | W | (none — unique) |
| C4 | Per-line scheduling for equipment | 1 | W | (none — unique) |
| C5 | AV technician dispatch | 1 | P | Planon + Eptura |
| C6 | Photo proof of setup | 1 | P | ServiceChannel |
| C7 | Asset check-out with QR | 2 | P | ServiceChannel + Planon |
| C8 | Asset lifecycle tracking | 2 | P | Planon + OfficeSpace |
| C9 | AV vendor field-tech mobile | 2 | P | ServiceChannel + Planon |
| C10 | Predictive maintenance | 2 | W | (frontier) |
| C11 | IoT integration | 3 | P | Planon (extreme depth) |
| **D — Parking / lockers / bikes / EV** | | | | |
| D1 | Reservable instances | 1 | TS | Skedda + Spacewell |
| D2 | Recurring reservations | 1 | P | deskbird + Skedda |
| D3 | Mobile QR check-in | 1 | P | deskbird + Skedda |
| D4 | Parking as bundle line | 1 | W | (none — unique) |
| D5 | Capacity awareness (EV) | 1 | P | EV-specialty |
| D6 | Day-pattern reservations | 2 | W | (rare elsewhere) |
| D7 | Wait-list when full | 2 | P | EV-specialty |
| D8 | Time-of-day pricing | 2 | W | (extends our cost-center) |
| D9 | Bike maintenance | 3 | P | bike-specialty |
| D10 | EV session telemetry | 3 | P | charging vendors |
| **E — Visitor management** | | | | |
| E1 | Pre-registration with QR pass | 1 | P | Envoy (gold) |
| E2 | Kiosk check-in | 1 | P | Envoy (gold) |
| E3 | Host notification | 1 | P | Envoy + Eptura/Proxyclick |
| E4 | Visitor as bundle line | 1 | W | (none — unique) |
| E5 | GDPR visitor retention with LIA | 1 | P | Envoy + Planon |
| E6 | Watchlist + denied entry | 1 | P | Envoy |
| E7 | Reception lobby panel | 1 | P | Envoy |
| E8 | Visitor analytics | 2 | P | Envoy |
| E9 | Multi-host visitor invitation | 2 | P | Envoy |
| E10 | Self-serve pre-registration | 2 | P | Envoy |
| E11 | Custom visitor types | 2 | P | Envoy + Proxyclick |
| E12 | Facial recognition opt-in | 3 | P | (niche) |
| E13 | Badge hardware integration | 3 | P | Envoy |
| **F — Service requests** | | | | |
| F1 | Catering catalog with photos + dietary | 1 | P | ezCater (gold) + Eptura |
| F2 | Vendor portal Phase A (daglijst) | 1 | P | NL FM ops reality (no software gap) |
| F3 | Vendor portal Phase B (login + status) | 1 | P | Planon + ServiceChannel |
| F4 | Visual rule builder | 1 | P+W | ServiceNow Flow + ahead of Planon/Eptura |
| F5 | Hidden vendor + tenant toggle | 1 | W | (none — unique) |
| F6 | EU FIC allergen trail | 1 | W | zero competitors |
| F7 | Vendor scorecards | 1 | P | ServiceChannel (gold) + Planon Insights |
| F8 | Vendor capacity + dispatch cascade | 1 (capacity) / 2 (catering cascade) / 1 (other cascade) | P | ServiceChannel — re-tiered 2026-04-28 (see §F8) |
| F9 | Catalog dedup tooling | 1 | W | (none — unique) |
| F10 | Approval dedup via scope_breakdown | 1 | W | (shipped — unique) |
| F11 | Catering KDS for vendors | 2 | P | Toast/Square (gold) |
| F12 | AV field-tech mobile UX | 2 | P | ServiceChannel + Planon |
| F13 | Cleaning checklist UX | 2 | P | ServiceChannel |
| F14 | Real-time fulfillment status | **1** (re-tiered 2026-04-28) | P | ezCater |
| F15 | Custom request path | 2 | W | (none — unique) |
| F16 | Reorder + favorites | **1** (re-tiered 2026-04-28) | P | ezCater |
| F17 | Approver inbox dashboard | 2 | P | ServiceNow |
| F18 | POS integration | 3 | W | (frontier) |
| F19 | White-label service brand | 3 | W | (extends hidden-vendor) |
| **G — Cross-cutting** | | | | |
| G1 | One predicate engine | 1 | W | (none — unique) |
| G2 | Cost-center approval routing | 1 | P | ServiceNow + MRI |
| G3 | Multi-stage approval chains | 1 | P | ServiceNow + Planon |
| G4 | Out-of-office delegation | 1 | P | ServiceNow |
| G5 | Approval dashboard with batch | 1 | P | ServiceNow |
| G6 | Approve from Teams cards | 1 | P | ServiceNow + Eptura |
| G7 | Booking analytics | 1 | P | Eptura + Robin |
| G8 | Vendor performance reporting | 1 | P | Planon Insights + ServiceChannel |
| G9 | Cost-center spend reporting | 1 | P | MRI |
| G10 | Mobile-first across surfaces | 1 | P | deskbird + Sharebite |
| G11 | Linear-tier polish | 1 | P | deskbird |
| G12 | PWA-installable | 1 | W | (extends mobile) |
| G13 | Offline queue for writes | 1 | W | (none — unique) |
| G14 | GDPR baseline | 1 | P | Planon + deskbird |
| G15 | Audit outbox | 1 | P | enterprise grade |
| G16 | Sub-processor disclosure | 1 | P | enterprise procurement |
| G17 | MS Graph integration | 1 | P | (see A1) |
| G18 | Identity / SSO | 1 | TS | All — table stakes |
| G19 | Delegation across approvals | 2 | P | ServiceNow |
| G20 | Conditional auto-approve | 2 | P | ServiceNow |
| G21 | Custom reporting dashboards | 2 | P | Eptura Insights + ServiceNow |
| G22 | SOC 2 Type II | 2 | P | enterprise pipeline |
| G23 | Slack integration | 2 | P (deferred) | Robin/deskbird |
| G24 | Microsoft Bookings interop | 2 | P (deferred) | (niche) |
| G25 | ISO 27001 | 3 | P | Planon + Eptura |
| G26 | ISO 27701 | 3 | P | Planon (NL/BE government gold) |
| G27 | Stack-and-block planning | 3 | P | OfficeSpace |
| G28 | AI booking assistant | 3 | W | (frontier) |

### Gate distribution summary

| Gate type | Tier 1 count | Tier 2 count | Tier 3 count | Total |
|---|---|---|---|---|
| WEDGE (extending moats) | 19 | 11 | 5 | 35 |
| PARITY (closing competitive gaps) | 30 | 15 | 6 | 51 |
| TABLE STAKES (basic credibility) | 3 | 0 | 0 | 3 |

**Read:** Tier 1 is roughly 1:2 wedge:parity. We're not just chasing competitors — but the parity work is essential to even be in the room.

---

## Maintenance

When a feature ships:
- Update its status (🟥 → 🟩) in the relevant section.
- If the parity-gate analysis changes (competitor catches up to a wedge, or new gap discovered), update the gate annotation.
- Cross-reference the change in `docs/competitive-benchmark.md`.

When competitive landscape shifts (Eptura ships a new feature, deskbird launches a new mobile flow):
- Update relevant rows in `docs/competitive-benchmark.md` first.
- Re-evaluate parity gates here second.
- Strikethrough + annotate when an old gate closes (e.g. ~~PARITY with Eptura~~ → "Caught up Q3 2026").

When a tier needs re-sorting (e.g. a Tier 2 item becomes urgent due to deal demand):
- Move the row, document the reason in the cell.
- Update the parent doc's roadmap (`booking-services-roadmap.md` for services, this doc for everything else).

This doc is the strategic backbone. Keep it current.
