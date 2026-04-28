# Competitive Benchmark — Workplace Booking Platforms

**Status:** living reference doc. Update as products evolve and new research lands.
**Last reviewed:** 2026-04-27.
**Scope:** the *entire* workplace booking surface — rooms, desks, AV/equipment, visitors, parking/lockers/bikes, service requests (catering / AV / cleaning), wayfinding, hybrid-work analytics. Not just catering and vendors.
**Use this doc to:** calibrate Prequest's quality bar, justify positioning to sales / leadership, brief contributors before scoping work, validate roadmap priorities against what competitors actually do.

---

## How to read this doc

- **§1** is the strategic synthesis — where the bar is, where Prequest can win, where it loses by default.
- **§2** is per-competitor profiles, organized by category (full-suite, workplace-experience, FM-specialist, catering-specialist).
- **§3** is per-dimension quality bars — for each booking surface (rooms, desks, services, visitors, etc.), what does best-in-class actually look like?
- **§4** is Prequest-specific wedges — what we have that nobody else has, and how to defend it.
- **§5** is research gaps + follow-up work.
- **§6** is sources + methodology notes.

When this doc disagrees with the actual products, fix the doc. Same rule as `docs/booking-services-roadmap.md`.

---

## §1. Strategic synthesis

### The competitive set in NL/BE (today)

Tiered by threat level for Prequest:

| Tier | Product | Threat | Why |
|---|---|---|---|
| **Tier A — direct, every shortlist** | Planon | High | NL incumbent. Government, banking, enterprise. GDPR + hard-FM moats. |
| Tier A | Eptura (Condeco + iOFFICE) | High | UK/global enterprises with NL/BE offices. Strong booking + Outlook/Teams. |
| Tier A | deskbird | High | EU-native, polished, hybrid-work-led. Direct mid-market threat. |
| **Tier B — appears, not always wins** | ServiceNow WSD | Medium-high (rising) | Enterprise expansion play — bundled into existing Now estates. |
| Tier B | Robin | Medium | Anglo-leaning enterprises, strong Outlook + mobile. Less embedded in NL/BE. |
| Tier B | Envoy | Medium | Visitor-led, often co-deployed alongside our footprint. |
| **Tier C — adjacent / niche** | OfficeSpace | Low | FM-flavored, dated UX, slower in EU. |
| Tier C | MRI Software | Low | Property/lease-led; appears at multinational corporates. |
| Tier C | ServiceChannel | Very low | FM-vendor marketplace; not a workplace product. |
| **Specialty / pattern reference** | Toast/Square KDS | N/A — reference for kitchen UX |
| Specialty | ezCater/Sharebite/Forkable | N/A — reference for catering UX |

### The bar — overall

**No single competitor wins on every dimension.** The bar is a composite of best-of-each:

- **GDPR / EU posture:** Planon + deskbird set the bar. EU-native, ISO 27001/27701, retention configuration per tenant, sales-led right-of-erasure.
- **Outlook / MS 365 depth:** Condeco/Eptura + Robin set the bar. Outlook add-in inside compose pane, bi-directional sync, Teams adaptive cards.
- **Visual polish:** deskbird sets the bar. Linear-tier motion, restrained color, snappy interactions.
- **Mobile-first:** deskbird + Sharebite set the bar. Phone-native, offline-tolerant.
- **Approval workflow depth:** ServiceNow sets the bar. Flow Designer is 10-year mature, multi-stage, cost-center-driven.
- **Visitor management:** Envoy sets the bar. Kiosk + badge + host-notify is the reference implementation.
- **FM hard-services depth:** Planon sets the bar. Asset lifecycle, technician dispatch, 40 years of domain modeling.
- **Vendor scorecards:** ServiceChannel sets the bar. Best-in-class anywhere in FM software for vendor-performance KPI tracking.
- **FM-vendor portal + dispatch:** Planon (general FM) + ServiceChannel (multi-site retail). Mature, mobile, evidence capture.
- **Catering KDS execution UX:** Toast + Square set the bar. Card-per-ticket, color progression, station routing, all-day view, bump bar.
- **Catering ordering UX (B2B):** ezCater sets the bar. Marketplace catalog, dietary facets, per-person pricing, approval flows.
- **Catering inside booking:** Sharebite + Robin set the (low) bar — order from inside calendar event, status round-trip.
- **Booking analytics + occupancy:** Eptura sets the bar. Mature dashboards, neighborhood demand.
- **Stack-and-block / scenario planning:** OfficeSpace sets the bar. Niche but real strength.
- **Reporting / cost-center finance:** MRI Software sets the bar. Lease-grade cost reporting.

### Prequest's strategic position

**The wedge:** *workplaces don't think in rooms vs desks vs catering vs visitors. They think in events, days, and people.* We model events end-to-end (composite bundle = room + lunch + AV + visitor + parking + permission as one orchestrated unit). No mainstream competitor models this — they all expose the underlying separations.

**Where we can win by default:**

1. **Composite event modeling** across rooms + desks + services + visitors + parking. Nobody else does this. ServiceNow has the closest workflow shape but not the data model.
2. **One predicate engine** governing all booking rules across all surfaces. Eptura has separate rules per module; Planon requires consultants per change; ServiceNow uses Flow Designer per-flow.
3. **Per-line scheduling within an event** (catering at 12:30, AV teardown at 16:30, parking 8-18). Functionally absent across all four major suites.
4. **Per-occurrence overrides on recurring bookings** (skip lunch on July 4th, change AV needs for one occurrence). Functionally absent.
5. **Hidden vendor identity by default** with tenant toggle. None offer this as a first-class principle.
6. **EU-native + GDPR baseline + Outlook-first + Linear-tier polish** — assembling these into one product.
7. **Asset double-booking prevented at DB level** (GiST exclusion). Most competitors rely on app-level checks that race-condition.
8. **Approval dedup across multi-line events** (one approver row covers N lines). ServiceNow, Eptura, Planon all create N approvals.

**Where we lose by default unless we invest:**

1. **GDPR posture:** Planon's ISO 27701 + EU-only data residency is a deal-blocker bar we must match.
2. **Outlook/Teams add-in depth:** Condeco's add-in is the gold standard. We must ship a credible v1 (bi-directional sync + Teams adaptive cards) or lose every Outlook-anchored buyer.
3. **Visitor management depth:** Envoy's kiosk + badge + host-notify is mature. We need a credible v1 or buyers will keep Envoy alongside us.
4. **Reporting / vendor scorecards:** Planon Insights + ServiceChannel scorecards combined is the bar. Our roadmap §9.1.3 must deliver.
5. **Hard-FM depth (asset lifecycle, maintenance):** Planon's 40-year moat. We don't compete here; route around it.
6. **Stack-and-block / scenario planning:** OfficeSpace's niche. We don't compete.

### Headline message (for sales / leadership)

> Prequest is the workplace platform that models *events*, not modules. Every other tool gives you a room booking module + a desk module + a catering module + a visitor module that you stitch together. We give you the meeting / day / event as one object — with rooms, desks, AV, lunch, visitors, parking, IT setup orchestrated as line items, governed by one rule engine, with a hidden-vendor delivery promise and EU-native compliance.

---

## §2. Per-competitor profiles

### Tier A — direct competitors

#### Planon

**HQ:** Nijmegen, NL. Acquired by Schneider Electric (2024). NL FM incumbent.
**Buyer:** FM Director / Head of Real Estate at 1,000+ employee org. Procurement-led.
**Price:** Not public. 6-figure ARR mid-market, 7-figure enterprise. Implementation typically equals first-year license.
**Threat:** Maximum in NL/BE. Default RFP entrant for any large NL tender.

**What they do well (defend against):**
- GDPR posture (ISO 27001 + 27701, EU-only, NL-tuned, government-grade).
- Hard-FM depth: maintenance, asset lifecycle, hard-services field execution. 40 years.
- Reporting / Planon Insights (Qlik-backed, vendor scorecards, SLA tracking, cost variance).
- Real vendor portal (genuine login, mobile field-services app for technicians).

**What they do poorly (wedge):**
- Composite events not a concept — parent + linked records across modules.
- "Every change requires a consultant" is the most consistent reviewer complaint. Workflow Designer is consultant-territory.
- UX feels 2010s enterprise. Heavy. Slow page loads.
- Allergen / FIC / catering depth: form-field-driven, not first-class.
- Multi-vendor coverage: static per-location assignment; no capacity-aware routing.
- Per-line scheduling, per-occurrence service overrides: not documented anywhere.

**To beat them:** match-or-near on GDPR + reporting; lean hard on composite events + admin self-service + speed-of-implementation in every demo.

#### Eptura (Condeco + iOFFICE + SpaceIQ + Proxyclick)

**HQ:** Atlanta, US. Post-merger holding entity.
**Buyer:** Workplace Experience lead at large enterprise; finance / professional services / tech.
**Price:** ~€8–14/user/month for Workplace tier; asset/FM modules separate. 3-6 month implementation.
**Threat:** Medium-high in NL/BE via Condeco's UK enterprise footprint.

**What they do well (defend against):**
- Outlook / Teams integration on the booking side. Condeco's add-in is the gold standard. Adaptive cards in Teams. Genuinely good.
- Catering UX on the requester side — visual menu, photos, dietary tags, per-person pricing.
- Booking analytics + workplace utilization (mature dashboards, occupancy, neighborhood demand).
- Visitor management via Proxyclick (kiosk, badges, host-notify).

**What they do poorly (wedge):**
- Post-merger fragmentation. Booking side and FM/asset side are still two products. Two domain models.
- Vendor as a shallow concept on the booking side (mostly internal-service-category model). No multi-vendor coverage / capacity / fallback.
- Composite event modeling stops at room+catering+AV. Doesn't extend to visitor + parking + IT setup as one event.
- Per-occurrence service overrides: partial (skip occurrences works; skip "just the lunch on this one" not documented).

**To beat them:** Outlook/Teams add-in must be top-tier from day 1 (table stakes); lean on bundle as cross-module concept and multi-vendor coverage.

#### deskbird

**HQ:** Switzerland/Germany. EU-native. Series B.
**Buyer:** Mid-market hybrid-work buyer (HR/People Ops + IT). €2.50-6/user/month.
**Threat:** Highest in NL/BE mid-market. EU-native posture is a near-perfect match for our buyer.

**What they do well (defend against):**
- **Polish.** UI benchmark for hybrid-work tools. Linear-adjacent.
- **Mobile-first.** Best mobile in workplace category, 4.7+ App Store rating.
- EU-native GDPR posture, Swiss/German DC, German-language nuance.
- Strong Teams + Outlook integration; their Teams app is among the most-installed in category.
- Smooth motion budget (~200ms with smooth easing — exactly our `--ease-smooth` token).
- Skeleton loaders not spinners. Subtle background tints. Quiet empty states.
- Slide-up sheet + chip-driven time selection ("Now", "Lunch", "All day") — UX pattern to copy.

**What they do poorly (wedge):**
- Thin on services depth (catering, AV dispatch, vendor management — basically absent).
- Thin on multi-vendor coverage rules.
- Hybrid-work-anchored. If buyer isn't a hybrid-work shop, product feels light.
- No visitor management.

**To beat them:** match motion + density + mobile polish (mandatory); win on services depth and composite event modeling. Demo both products side by side: deskbird's "+ Add catering" placeholder vs Prequest's full composite booking dialog with allergen-aware vendor catalog.

### Tier B — significant but not always-shortlisted

#### ServiceNow Workplace Service Delivery (WSD)

**HQ:** Santa Clara. Available via existing ServiceNow contracts.
**Buyer:** CIO or Workplace Experience Director at 5,000+ employee enterprise *already running ServiceNow ITSM*.
**Price:** $8-15/employee/month on top of existing Now estate. Min ~$150k/year ARR.
**Implementation:** $400k-$1.5M services, 4-9 months greenfield, partner-led (Plat4mation, NTT, Devoteam).
**Threat:** Real and rising in NL/BE enterprise. Hard to beat on platform-consolidation pitch when buyer already owns ServiceNow.

**What they do well (defend against):**
- **Approval engine + workflow depth.** Flow Designer + Process Automation Designer. 10-year mature.
- **Single-platform story.** Unified ITSM/HRSD/CSM/CMDB/SSO. "One pane of glass" is real.
- **Performance Analytics.** Time-series KPIs, indicator scorecards, forecasting.
- Outlook + Teams integration is solid (thin web view feel but functional).
- GDPR via Privacy Management module (additional SKU).

**What they do poorly (wedge):**
- Composite events are independent tickets joined by reference. Cancellation cascade requires Flow scripting.
- No purpose-built vendor portal. Caterers/AV vendors get a watered-down CSM agent experience.
- Catalog UX is generic ServiceNow Service Catalog look. Allergen capture is DIY.
- Per-occurrence service overrides on recurring bundles are fragile (community-confirmed gap).
- 6-9 month implementation timeline; priced out below 2000 employees.

**To beat them:** demo composite event cascade in 30 seconds (cancel room → cascades to lunch + AV + visitor) vs their Flow Designer setup. Demo allergen filter chips. Demo time-to-first-booking in days, not quarters. For mid-market, win on price + speed.

#### Robin

**HQ:** Boston/NYC. Series C. Pivoting to hybrid-work analytics upsell.
**Buyer:** IT/Workplace at mid-market and enterprise; North America primary, EU growing.
**Price:** $4-12/user/month bands.
**Threat:** Medium in NL/BE, primarily Anglo-leaning enterprises.

**What they do well (defend against):**
- Best Outlook add-in in the category (gold standard for in-compose-pane booking).
- Floor-plan UX (drag-to-zoom, click-to-book, "where's my team sitting").
- Native iOS/Android mobile apps — among the few that don't feel like wrapped web views.
- 2024 redesigned dashboard is Linear-adjacent.

**What they do poorly (wedge):**
- Catering = partner integration with Sharebite/Forkable/EZCater. Partner-branded sub-flow. No native menu/allergen/vendor model.
- Services are an attachment, not a first-class line item.
- Approval flows are thin.
- Multi-vendor coverage rules basically absent.
- Allergen / FIC compliance: zero answer.

**To beat them:** match Outlook depth or accept losing the "I book everything from Outlook" persona. Beat on services-as-first-class + offline-tolerant mobile request creation + allergen-aware catalog.

#### Envoy

**HQ:** San Francisco. Visitor management leader.
**Buyer:** Reception / Security / IT.
**Price:** Visitor-led $99-500+/location/month (scales by location, expensive for multi-floor HQs).
**Threat:** Low for composite booking; high if a buyer is anchored on "we already use Envoy for visitors."

**What they do well (defend against):**
- **Visitor flow polish.** Kiosk + badge + host-notify is the reference implementation for the entire industry.
- Privacy posture (GDPR, watchlist, audit features).
- Onboarding speed — out-of-box deployable, low IT lift.

**What they do poorly (wedge):**
- Room booking is a second-class citizen.
- No catering / rich service-request modeling. Deliveries module ≠ catering.
- Pricing scales by location, expensive for multi-floor HQs.

**To beat them:** match kiosk-grade polish for our public surfaces (lobby panel, reception screens). Concede the visitor primacy if needed; integrate cleanly. Long-term: ship visitor management v1 that meets parity bar.

### Tier C — adjacent / niche

#### OfficeSpace

**HQ:** Vancouver. FM/space-planning origin.
**Buyer:** FM Director at 200,000+ sqft HQ.
**Threat:** Low-medium. Rarely wins on UX in NL/BE.

**Strengths:** stack-and-block scenario planning; asset/work-order depth (CMMS-lite); move management workflows.
**Weaknesses:** dated UX, mobile is afterthought, no catering concept.
**To beat:** trivial on requester polish; match asset depth.

#### MRI Software (Manhattan / FM:Systems)

**HQ:** Solon, Ohio. PE-backed. Property/lease-led.
**Buyer:** Real Estate / Lease Administration at large corporate occupier.
**Threat:** Low in NL/BE; appears at multinationals already running MRI for property.

**Strengths:** finance-grade reporting + lease/cost accounting; mature property vendor portals; cost-center / chargeback modeling.
**Weaknesses:** workplace experience is a satellite module; allergen / catering shallow; long implementation.
**To beat:** don't out-finance them; integrate cleanly with their cost data. Lean on requester UX + speed-to-value.

#### ServiceChannel (Fortive / Accruent)

**HQ:** New York. Multi-site retail/restaurant FM-vendor marketplace.
**Buyer:** VP Facilities at 50-5,000 site retail/restaurant chain.
**Price:** $50-200/location/month.
**Threat:** Very low for our segment (different product, different buyer, different geography). Worth studying for vendor-scorecard data modeling.

**Strengths (study, don't compete):**
- **Vendor scorecard model** — best-in-class anywhere in FM software. KPIs: response time, time-on-site, first-time-fix rate, NTE adherence, invoice accuracy, compliance currency, satisfaction. Used to drive automated vendor re-tiering.
- **Coverage rules + dispatch cascade** — primary/secondary/tertiary vendor selection with compliance gating + geographic radius.
- **Vendor mobile app** — geofenced check-in, photo/video evidence, signature capture.

**Lift for our roadmap:** copy the scorecard data model + KPI taxonomy directly. Adapt vocabulary for office services (catering, AV) instead of FM trades (HVAC, plumbing).

### Specialty references — patterns to copy

#### Toast KDS (kitchen display reference)

**Patterns to adopt for our catering KDS:**
- Card-per-order with prominent timer in ticket header. Color progression green → yellow → red.
- Item-level station tagging (cold prep / hot prep / packaging routing).
- All-day aggregation view (item totals across all pending orders for next time window).
- Modifier indentation + allergen-in-red as the visual standard.
- Bump-bar-first interaction model (every action reachable via numbered keys).

**Patterns to avoid:** "table/seat/course" data model (corporate catering destination = meeting room, not table). Don't force JSON-like rule editors for station routing — pre-bake station templates per cuisine type.

#### Square KDS (visual polish reference)

**Patterns to adopt:**
- Visual hierarchy via type weight, not just borders.
- Swipe-to-complete on touch (right gesture for tablet-only kitchens).
- Allergen icon + text rather than red caps (less alarming, equally clear).
- Connectivity status indicator (green dot when synced, amber when queueing, red when disconnected for >30s).

**Patterns to avoid:** cutting the all-day view. Single-threshold overdue color.

#### ezCater for Business (B2B catering ordering reference)

**Patterns to adopt:**
- Vendor card layout (hero photo + cuisine + rating + dietary chips + delivery estimate).
- First-class dietary facet filters at top of catalog.
- "Order again" as primary home-screen affordance.
- Multi-stage status tracking (confirmed → in prep → out for delivery → arrived) with email/SMS escalation.
- Per-person pricing as first-class mode.

**Patterns to avoid:** email + ICS as calendar integration (we can do dramatically better living inside the meeting booking dialog). Treating mobile as secondary.

#### Forkable (employee meal programs reference)

**Patterns to adopt:**
- Dietary preferences as per-person profile (enforced across all orders).
- Per-person budget enforcement (distinct from per-order budgets).
- Mobile-first employee selection UX.

**Patterns to avoid:** curation-only catalog; hiding vendor identity in catalog selection (Benelux buyers care about supporting specific local caterers; we hide vendor at the *requester* level for simplicity, not at the buyer/admin level).

#### Sharebite (catering-inside-booking reference)

**The Robin integration is the existence proof for Prequest's whole catering-inside-bookings thesis.** Order food directly from Robin meeting room booking; status round-trips to calendar event.

**To leapfrog Sharebite+Robin:** make catering a *first-class block inside the booking dialog*, not a sidecar embed. We own both sides; the integration is structural, not surface-level.

---

## §3. Per-dimension quality bars

For each booking surface, what does best-in-class look like? This is what Prequest must match or exceed.

### Room booking

**Bar set by:** Condeco (Outlook) + deskbird (polish) + Robin (floor plans).

**Must-haves:**
- Outlook add-in inside compose pane with bi-directional sync.
- Teams adaptive cards (notifications + approve-from-Teams).
- Floor-plan view with drag-to-zoom, click-to-book.
- Recurring bookings with calendar-aware conflict detection.
- Smooth ~200ms transitions; skeleton loaders.
- Mobile-first booking flow (full-screen sub-route on phone).
- Slide-up sheet + chip-driven time selection ("Now", "Lunch", "All day").

**Differentiators (Prequest's wedge):**
- Composite event abstraction (room is one line in a bundle).
- Bundle templates as chip row above time picker.
- Per-line scheduling within the booking.
- Per-occurrence overrides on recurring series.

### Desk booking

**Bar set by:** deskbird (mobile + polish) + Robin (floor plans + neighborhood).

**Must-haves:**
- "Where's my team sitting today" view (find-a-desk-near-team).
- Floor-plan view with status overlay (booked / available / mine).
- Office-day attendance toggle (hybrid-work pattern).
- Recurring desk bookings ("every Tuesday and Thursday").
- Mobile-first check-in via QR or geofence.
- Neighborhood / team-cluster booking patterns.

**Differentiators (Prequest's wedge):**
- Same predicate engine governs desk rules as room rules + service rules.
- Desk booking can be part of a bundle ("office day = desk + locker + parking + lunch").

### AV / equipment / asset reservation

**Bar set by:** Planon (asset lifecycle) + OfficeSpace (asset model) + Eptura (resource booking).

**Must-haves:**
- Asset records with serial number, location, condition, lifecycle.
- Conflict detection at reservation time (no double-booking).
- Technician dispatch flow.
- Photo proof of setup / tear-down.
- Asset check-in / check-out.
- Reservation by category ("any 4K projector") or specific instance.

**Differentiators (Prequest's wedge):**
- DB-level conflict prevention (GiST exclusion). Race-safe under load.
- Asset reservation as a line item in a composite bundle (auto-cascades on booking cancellation).
- Per-line scheduling (AV setup at 8:00 for 9:00 meeting; teardown at 11:00).

### Visitor management

**Bar set by:** Envoy (kiosk + badge + host-notify).

**Must-haves:**
- Pre-registration (host invites visitor with email, visitor gets QR pass).
- Kiosk check-in (badge print, photo, NDA, watchlist screening).
- Host notification (email + Teams/Slack).
- Visitor analytics (today's expected, current on-site, history).
- GDPR-compliant retention (configurable, defaults 6 months for visit records, 90 days for photos/IDs).
- Audit log of visitor data access.

**Differentiators (Prequest's wedge):**
- Visitor as a line item in a bundle (visitor + meeting + room + parking spot + reception briefing as one orchestrated event).
- Reception team sees the bundle, not isolated visitor records.

### Parking / lockers / bikes / shower / EV charging

**Bar set by:** mostly Tier C and specialty vendors (less competition here).

**Must-haves:**
- Reservable instances with conflict detection.
- Recurring reservations (Tuesday parking spot, locker for the day).
- Mobile check-in via QR or geofence.
- Capacity awareness ("EV charger 1 of 4 available").

**Differentiators (Prequest's wedge):**
- Same asset reservation model as AV equipment — one engine, many surfaces.
- Bundle template ("office day") includes parking + locker + desk + lunch.
- Day-pattern reservations (every Tuesday + Thursday, Q2).

### Service requests (catering, AV, cleaning, maintenance)

**Bar set by:** Planon (FM hard-services) + ezCater (catering UX) + Sharebite (catering-inside-booking) + ServiceChannel (vendor dispatch + scorecards).

**Must-haves:**
- Service catalog with photos, descriptions, dietary/allergen labels, per-person + per-item pricing.
- Per-vendor menus with date-bounded availability.
- Approval flows (cost-center driven, multi-stage).
- Vendor portal for fulfillment.
- Status tracking (received → preparing → en route → delivered).
- Mobile-first ordering UX.
- Reorder / favorites.

**Differentiators (Prequest's wedge):**
- Hidden vendor identity by default (tenant toggle for the minority who want it).
- Service rule engine = same predicate engine as room booking rules.
- Per-occurrence overrides on recurring bookings.
- Catering KDS execution UX (Toast/Square-tier).
- Approval dedup across multi-line bundles.
- Bundle abstraction: services are line items, not separate tickets.

### Catering — special focus

See `docs/booking-services-roadmap.md` for the full implementation roadmap. Quality bars (already covered in this doc, summarizing here):

- **Browse:** ezCater catalog card pattern (hero photo + cuisine + dietary chips + delivery estimate).
- **Filter:** dietary facets first-class at top; auto-apply attendee dietary needs.
- **Order:** per-person package + per-item à la carte both supported. Cart shows dietary-coverage indicator.
- **Approve:** cost-center driven, manager-chain, in-app + email + Teams adaptive cards.
- **Track:** real-time status inside booking dialog + calendar event description.
- **Fulfill:** Toast/Square-tier KDS for catering vendors with all-day view, station routing, color-coded urgency.

### Wayfinding

**Bar set by:** Robin (interactive floor plans) + OfficeSpace (mature space-planning).

**Must-haves:**
- Building > floor > room hierarchy navigation.
- "Where's [person/room/asset]" search.
- Interactive floor plan with current bookings overlay.
- Mobile turn-by-turn (rare; only Eptura's Indoor Mapping does this).

**Differentiators (Prequest's wedge):** same space hierarchy drives routing decisions, capacity rules, vendor coverage areas, visitor flow. One model, many uses.

### Hybrid-work analytics

**Bar set by:** Robin + Eptura + deskbird.

**Must-haves:**
- Office attendance trends (daily / weekly / monthly).
- Neighborhood / team-cluster utilization.
- No-show rate per booking type.
- Anonymized employee-level "office days" reporting.

**Differentiators (Prequest's wedge):** unified analytics across rooms + desks + services + visitors (one event-level data model).

### Approvals (cross-cutting)

**Bar set by:** ServiceNow Flow Designer.

**Must-haves:**
- Multi-stage approval chains.
- Cost-center driven routing.
- Manager-chain resolution (line manager, skip-level, dotted-line).
- Out-of-office delegation.
- Approval dashboard with batch-approve.
- Mobile + Teams adaptive card approve-in-place.

**Differentiators (Prequest's wedge):**
- One predicate engine governs approvals across all surfaces (no per-module rule sprawl).
- Approval dedup via `scope_breakdown` (one approver, one row, N lines covered).
- Cost-center default approver as first-class concept.

### Vendor management + scorecards

**Bar set by:** ServiceChannel (scorecards + dispatch cascade) + Planon (vendor portal + field-services).

**Must-haves:**
- Vendor portal with login + inbox + status updates.
- Vendor scorecard tracking: response time, on-time %, ack latency, decline rate, cost variance, post-order rating.
- Dispatch cascade: primary → secondary → tertiary with compliance gating.
- Coverage rules per (location, service_type) with priority.

**Differentiators (Prequest's wedge):** vendor identity hidden from requesters by default while remaining first-class to admins/desk. Vendor data model supports paper-only (daglijst), portal-only, hybrid modes.

### Compliance / GDPR / audit

**Bar set by:** Planon (NL government-grade) + deskbird (EU-native) + Envoy (privacy-first).

**Must-haves:**
- DPA template procurement-ready.
- Per-tenant retention configuration (with caps + LIA documentation).
- Right of access / erasure / portability endpoints.
- Read-side audit log (who accessed which person's data).
- EU data residency (NL/DE preferred).
- ISO 27001 minimum; ISO 27701 + SOC 2 for enterprise pipeline.
- Sub-processor disclosure page.
- Departure cleanup pattern (auth deactivated → preferences deleted at 30d → person ref anonymized at 90d → past records retained for tenant audit window).

**Differentiators (Prequest's wedge):** same retention engine across all data categories (visitor, booking, order, audit). Tenant-configurable LIA per category.

### Mobile

**Bar set by:** deskbird (best-in-class for hybrid-work) + Sharebite (catering-on-mobile).

**Must-haves:**
- Phone-first design at 320-428px width.
- Single-handed reachability for primary actions.
- Skeleton loaders, not spinners.
- Native-feeling motion (200ms, smooth easing).
- Offline-tolerant for read-only views (today's bookings, today's services).

**Differentiators (Prequest's wedge):**
- Offline queue for *write* actions (create request, attach service) — synced when reconnected. Robin and Envoy assume always-online; deskbird is close but doesn't queue writes.
- PWA-installable for vendor surfaces (KDS, field tech).

### Design polish

**Bar set by:** deskbird (in workplace category) + Linear (in tech tools generally).

**Must-haves:**
- Restrained color (subtle background tints, hairline dividers, not card shadows).
- Confident typography (tabular numerals, balanced headings).
- 200ms transitions, smooth easing (--ease-smooth), no over-animation.
- Skeleton loaders.
- Quiet empty states (line drawing + one-line copy + primary CTA).
- Press feedback = `translate-y-px`, not scale.
- Focus rings: visible, never on click.

(All of these are already in our `index.css` polish rules; mandate consistency across the new booking surfaces.)

---

## §4. Prequest's defensive moats

For each strategic moat, what we have, why it matters, and how to defend it.

### Moat 1 — Composite event modeling

**What we have:** `booking_bundles` as orchestration parent. Lazy-created. Cascade cancellation. Per-line scheduling.
**Why it matters:** No mainstream competitor does this. ServiceNow has the closest workflow shape; Eptura/Condeco gets to room+catering+AV but stops there.
**How to defend:** every new feature attaches to bundle, not to reservation directly. Cross-surface (visitor + desk + parking + room) bundle support is the long-term endgame.

### Moat 2 — One predicate engine

**What we have:** `applies_when` AST shared by `room_booking_rules` and `service_rules`. Service Rule Resolver caches results in `policy_snapshot`.
**Why it matters:** ServiceNow has six rule systems for the same problem; Eptura has separate rules per module; Planon requires consultants per change.
**How to defend:** when adding a new rule type (visitor approval, parking restriction, catering blackout), extend the existing engine — never sidecar. Add new template categories, not new engines.

### Moat 3 — Per-line scheduling + per-occurrence overrides

**What we have:** `service_window_*` columns; `recurrence_overridden`, `recurrence_skipped`, `repeats_with_series` flags.
**Why it matters:** Functionally absent across all four major suites. "Skip just the lunch on July 4th of a weekly meeting" is not modelable in their tools.
**How to defend:** treat per-line scheduling and per-occurrence overrides as core to every new line type (visitor arrival window, parking start/end, IT setup window).

### Moat 4 — Hidden vendor by default

**What we have:** rule documented; tenant toggle on roadmap.
**Why it matters:** No competitor offers this as a first-class principle. Eptura hides vendors by accident (because vendor isn't really modeled); ServiceNow exposes them; ezCater/Sharebite are vendor-first.
**How to defend:** `feedback_hide_vendor_from_requester.md` rule applies to every requester surface. Audit retains vendor identity always.

### Moat 5 — DB-level conflict prevention

**What we have:** `EXCLUDE USING gist` on `asset_reservations` + `reservations`.
**Why it matters:** Most competitors rely on app-level checks that race-condition under load.
**How to defend:** every new resource type uses GiST exclusion at the table level. No app-level conflict detection.

### Moat 6 — Approval dedup via scope_breakdown

**What we have:** `approvals.scope_breakdown` jsonb + unique partial index `(target_entity_id, approver_person_id) WHERE status='pending'`.
**Why it matters:** ServiceNow / Eptura / Planon all create N approvals for N-line events. Approver fatigue is real.
**How to defend:** every new approval type uses the same dedup mechanism. Test at high N (50+ line bundles) to validate.

### Moat 7 — EU-native + Outlook-first + Linear-tier polish

**What we have:** `docs/booking-services-roadmap.md` §9.1.13 (GDPR baseline), MS 365 integration plan, design polish rules in `apps/web/src/index.css`.
**Why it matters:** No single competitor combines all three. Planon is EU-native but UX-dated. Eptura is Outlook-strong but post-merger fragmented. deskbird is polished but services-thin.
**How to defend:** quality bar feedback rule (`feedback_quality_bar_comprehensive.md`) — comprehensive, not lean. Don't sacrifice any of the three for any of the others.

---

## §5. Research gaps + follow-up

### What's still uncertain

- **MRI Software** workplace UX is mostly behind sales gate. Hands-on demo would calibrate scoring.
- **Robin's catering depth** — confidence M-H that it's partner-only with no native menu/allergen/vendor model. Re-verify quarterly.
- **deskbird services roadmap** — low confidence on whether they're investing here. Monitor changelog + LinkedIn product launches monthly.
- **Eptura post-merger product unification timeline** — fluid; what's documented today may shift. Re-verify 2x/year.
- **All four major suites + allergen/FIC compliance** — low-medium confidence none have it (would be marketed if so).
- **Visitor management depth** at Proxyclick (now Eptura) post-merger — needs targeted research.
- **Parking / locker / bike** specialty vendors (Stratus.io, Spacewell, Skedda lockers) — minimal coverage today. Worth a future research pass.
- **Mail / package handling** (Notifii, Pitney Bowes) — not researched. Rare but adjacent.
- **Hybrid-work analytics depth** at Robin + Eptura — surface-known, not benchmarked deeply.
- **Wayfinding + indoor mapping** (Eptura Indoor Mapping, Mapsted) — surface-only research.

### Recommended follow-up research

| Priority | Topic | Source |
|---|---|---|
| High | deskbird hands-on trial for booking flow + mobile + Teams integration | Sign up + 4-week internal pilot |
| High | Eptura/Condeco + Proxyclick post-merger product walkthrough | Sales demo (record if permitted) |
| Medium | Robin services depth (catering native vs partner-only) | Quarterly G2/changelog review |
| Medium | Planon Insights + vendor scorecards | Sales demo or partner debrief |
| Low | OfficeSpace stack-and-block walkthrough | Sales demo (low priority since not direct competitor) |
| Low | Parking/locker specialty vendors (Skedda, Stratus.io) | Web research pass |

### Validation interview targets

Per `docs/booking-services-roadmap.md` §10, schedule 5-10 FM director interviews. Three core questions:

1. "Would you ship a workplace app that hides which caterer made the food?"
2. "How do you measure vendor performance today?"
3. "What's the worst vendor failure you've had in 12 months?"

Add for broader scope:

4. "What's your hybrid-work policy and how is it enforced today?"
5. "How do employees book parking / lockers / bikes today?"
6. "How does a visitor arrive at your office today, end-to-end?"
7. "If you could fix one thing about your current room booking, what?"

---

## §6. Sources + methodology

### Primary sources

- Vendor product pages (linked throughout).
- G2 + Capterra + Software Advice + Gartner Peer Insights reviews.
- YouTube product demos (Toast KDS especially well-documented).
- Trade press: Workplace Insider, GlobalFM, Realcomm, Workplace Insight.
- Public case studies on vendor websites (Banco Santander / Siemens / Walmart / Bloomin').
- Gartner Magic Quadrant for IT Service Management Platforms 2024 (ServiceNow leader).

### Confidence calibration

Each scoring cell carries implicit confidence:
- **High confidence** when public docs / demo videos / multiple cross-checked reviews exist.
- **Medium confidence** when inferred from changelog / partner pages / podcast mentions.
- **Low confidence** when extrapolated from competitive positioning + buyer-side reviews. Flagged in profiles.

### Refresh cadence

- **Quarterly (high-priority products):** Planon, Eptura, deskbird, ServiceNow WSD.
- **Half-yearly (medium-priority):** Robin, Envoy, OfficeSpace, MRI.
- **Yearly (specialty references):** Toast, Square, ezCater, Sharebite, Forkable, ServiceChannel.
- **Ad-hoc:** when a public product launch / re-architecture is announced (track LinkedIn, vendor blog, TechCrunch).

### How to update this doc

When you find new info that contradicts a scoring cell, updating it is mandatory. Same rule as `docs/booking-services-roadmap.md` and `docs/assignments-routing-fulfillment.md` — fix the doc first, then align decisions.

---

## Cross-references

- [`docs/booking-services-roadmap.md`](booking-services-roadmap.md) — Tier 1/2/3 implementation backlog.
- [`docs/assignments-routing-fulfillment.md`](assignments-routing-fulfillment.md) — routing engine reference.
- [`docs/visibility.md`](visibility.md) — three-tier visibility model.
- [`docs/room-booking.md`](room-booking.md) — room booking + recurrence reference.
- [`docs/service-catalog-live.md`](service-catalog-live.md) — service catalog model.
