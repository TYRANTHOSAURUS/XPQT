# Booking Services — Best-in-Class Analysis & Roadmap

**Status:** living reference — update as we ship.
**Owner:** product + workplace-ops engineering.
**Last reviewed:** 2026-04-27.
**Use this doc to:** scope work, brief contributors, justify priorities, brief sales / customer success on the product position. Other agents should read this before touching catering / AV / equipment / linked-services code.

---

## How to use this document

- Sections **§1–§4** are the strategic argument. Read these before scoping a feature.
- Sections **§5–§8** are operational details (current state, performance, architecture).
- Section **§9 (Roadmap)** is the actionable backlog, in priority order. Pick from the top.
- Section **§10** is the validation work that should run *in parallel* with engineering.
- Section **§11** is the inventory of what exists today — point of truth for "what's already built".
- Update the **Status** column in §9 as items ship. Don't delete items — strike through with `~~~` and link to the commit / PR.

When this doc and the code disagree, fix the doc first, then align the code. Same rule as `docs/assignments-routing-fulfillment.md` and `docs/visibility.md`.

## Quality bar — non-negotiable

**Best-in-class means better than competitors across UX, user journey, platform features, quality, performance, efficient flows, and architecture.** Not lean. Not minimal. Not "MVP we'll improve later". Comprehensive scope with excellent execution.

Implications for everyone working on this subsystem:

- Each Tier 1 item ships **complete + polished + production-quality** at first launch.
- Compare to the **best competitor per dimension** (Toast KDS for catering, Linear for app polish, ezCater for ordering, Uber for Business for mobile dispatch). Not to "average workplace tool".
- Performance benchmarks are mandatory: sub-second interactions, sub-2s page loads, offline-tolerant where applicable.
- Architecture must accommodate Tier 2 + Tier 3 items without rewrites.
- "We'll fix it later" is not acceptable for Tier 1 unless deferred explicitly with a return plan.

If a proposal feels lean / minimal / vertical-slice — it's wrong for this product. Re-scope to comprehensive, then optimize quality on the comprehensive scope.

(See [`feedback_quality_bar_comprehensive`](../../.claude/projects/-Users-x-Desktop-XPQT/memory/feedback_quality_bar_comprehensive.md) for the full directive.)

---

## Table of contents

1. [Executive verdict](#1-executive-verdict)
2. [The product wedge](#2-the-product-wedge)
3. [Strengths we have (and must defend)](#3-strengths-we-have-and-must-defend)
4. [Per-persona analysis](#4-per-persona-analysis)
   - 4.1 [Requester (employee booking)](#41-requester-employee-booking)
   - 4.2 [Admin (FM / workplace ops)](#42-admin-fm--workplace-ops)
   - 4.3 [Service desk operator](#43-service-desk-operator)
   - 4.4 [Vendor (the missing persona)](#44-vendor-the-missing-persona)
   - 4.5 [Approver](#45-approver)
   - 4.6 [Finance / cost-center owner](#46-finance--cost-center-owner)
5. [Competitor landscape](#5-competitor-landscape)
6. [Ranked risks](#6-ranked-risks)
7. [Performance & scale realities](#7-performance--scale-realities)
8. [Architectural inflections — choices we've made](#8-architectural-inflections--choices-weve-made)
9. [Implementation roadmap](#9-implementation-roadmap)
   - 9.1 [Tier 1 — MVP path to best-in-class](#91-tier-1--mvp-path-to-best-in-class)
   - 9.2 [Tier 2 — full best-in-class](#92-tier-2--full-best-in-class)
   - 9.3 [Tier 3 — long-tail polish](#93-tier-3--long-tail-polish)
10. [Customer validation work](#10-customer-validation-work)
11. [Current state inventory](#11-current-state-inventory)
12. [Glossary & invariants](#12-glossary--invariants)
13. [Cross-references](#13-cross-references)

---

## 1. Executive verdict

| Dimension | Maturity | Notes |
|---|---|---|
| Data model & abstractions | **80%** | Bundle, rules, recurrence, asset conflict — strong. Missing: vendor capacity, scorecards, allergen trail. |
| Requester UX | **90%** | Composite dialog, hidden-vendor, per-line scheduling. Missing: photos, real-time status, custom request, reorder. |
| Admin UX | **60%** | Coverage of CRUD is good. Killers: free-form JSON rule editor, UUID target picker, no bulk ops, no vendor scorecards, no catalog dedup tooling. |
| Operational backbone | **30%** | No vendor portal, no automated dispatch, no SLA / scorecard data, desk is SPOF for vendor failure. |
| Compliance / safety | **40%** | Tenant isolation enforced; allergen traceability is incomplete; audit is best-effort, not transactional. |

**Headline:** the model and the requester UX are genuinely differentiated and beat ServiceNow / Eptura / Robin on the dimensions that matter to a workplace-ops buyer. The system has a structural failure mode: when a vendor flakes, the desk absorbs it, with no automated dispatch, no accountability tools, no scorecards, no allergen trail. **Ship the operational backbone (Tier 1 in §9.1) before broad rollout** or the front-end promise will get reputation damage on the first vendor incident.

---

## 2. The product wedge

> **Workplaces don't think in vendors. They think in events. We model events, not vendors.**

This is the single line that should govern every product decision in this subsystem.

- **Wins** the workplace-experience-led buyer (CFO, HR, COO, FM director).
- **Loses** the procurement-led buyer who wants supplier-first transparency.
- **Loses** the marketplace-led buyer who wants brand choice.

These losses are *intended*. Don't try to win all three lanes — that's how you become ServiceNow.

The wedge is implemented through three concrete commitments:

1. **Bundle is the unit of work.** Room + lunch + AV is one event, not three coordinated tickets.
2. **One predicate engine governs room rules and service rules.** No sidecars.
3. **Vendor identity is hidden from requesters by default.** See [feedback memory](../../.claude/projects/-Users-x-Desktop-XPQT/memory/feedback_hide_vendor_from_requester.md). Tenant toggle exists for the small minority who need it.

Drift on any of these and the wedge collapses.

---

## 3. Strengths we have (and must defend)

Eight things this codebase already does well. Do not erode any of these without a deliberate decision.

| # | Strength | Why it matters | Where it lives |
|---|---|---|---|
| 1 | **Bundle as a first-class concept** | Most competitors model room and catering as separate tickets glued by IDs. We model the event. | `booking_bundles` table; `BundleService.attachServicesToReservation` |
| 2 | **Same predicate engine for room + service rules** | One mental model for admins. ServiceNow has six rule systems for the same problem. | `service_rules` mirrors `room_booking_rules`; shared `applies_when` AST |
| 3 | **Per-line scheduling (`service_window_*`)** | Lunch at 12:30 inside a 9-5 booking. Almost nobody handles this cleanly. | `order_line_items.service_window_start_at`, `service_window_end_at` |
| 4 | **Asset conflict via GiST exclusion** | Database-level prevention of double-booking, not app-level. Race-safe under load. | `EXCLUDE USING gist (asset_id, time_range)` on `asset_reservations` |
| 5 | **Approval dedup via `scope_breakdown`** | One approval covers N lines; approver doesn't see 12 emails for one event. | `approvals.scope_breakdown` jsonb, unique partial index `(target_entity_id, approver_person_id) WHERE status='pending'` |
| 6 | **Per-occurrence recurrence overrides** | "Repeat lunch weekly but skip July 4th." Model handles override, skip, revert. | `order_line_items.recurrence_overridden`, `recurrence_skipped`, `repeats_with_series`; `OrderService.{override,skip,revert}LineForOccurrence` |
| 7 | **Lazy bundle creation** | Room-only bookings stay simple. Bundle row only appears when there's actually composition. | `BundleService.lazyCreateBundle`, idempotent |
| 8 | **Cost-center driven approval routing** | FMIS-grade: approvers resolve from cost-center metadata, not static dropdowns. | `cost_centers.default_approver_person_id` consumed by predicate engine |

**Mandatory:** every new rule type, every new approval flow, every new event-orchestration feature must extend these mechanisms. Do not add a sidecar.

---

## 4. Per-persona analysis

### 4.1 Requester (employee booking)

**Today's flow.**
1. `/portal/rooms` → pick a date/time, see chip row of bundle templates above the time picker.
2. Click into time slot → booking-confirm dialog opens with collapsible Catering / AV / Setup sections.
3. Each section calls `GET /service-catalog/available-items?delivery_space_id=…&on_date=…&service_type=…`, lists items with name + image (if surfaced) + price + dietary tags. **Vendor not shown.**
4. Per-line: quantity, optional service-window picker, dietary notes.
5. Footer: subtotals, bundle total, approval status preview, Submit.
6. After submit: confirmation toast, drawer link to `/portal/me-bookings`.

**What works.**
- One dialog covers the whole event. No multi-step wizard.
- Sections are progressively disclosed; zero cost if not needed.
- Bundle template chips give one-click power-user paths.
- Hidden vendor → cohesive "your workplace, your brand" feel.
- `/portal/me-bookings` services drawer shows lifecycle clearly.

**Gaps that matter (priority within tier).**

| Gap | Cost of inaction | Tier |
|---|---|---|
| Allergen / dietary trust on food. Requester can't see kitchen certifications, allergen attestation, halal/kosher/vegan provenance. Hidden vendor breaks food-safety trust on regulated diets. | High — single food incident → reputation hit. | Tier 1 |
| No "custom request" path. Requester wants something not in catalog → silently Slacks the desk → bypasses the system. | Medium — undermines analytics, removes desk visibility. | Tier 2 |
| Per-person pricing on `/portal/order`. Falls back to qty × unit_price; no attendee count input. | Medium — visible pricing bug. | Tier 1 |
| Item images. `catalog_items.image_url` exists; not surfaced consistently. Catalogs without photos look like internal tools. | Medium — direct UX comparison loss vs ezCater / Sharebite. | Tier 2 |
| No "save as favorite" / "reorder last meeting". Frequent host re-builds the same setup weekly. | Low (delight feature) but high (retention/stickiness). | Tier 2 |
| No real-time fulfillment tracking. Status changes don't push to requester. Schema supports it (`fulfillment_status`); no realtime channel + no UI. | Medium — direct comparison loss vs ezCater. | Tier 2 |
| No requester-side review / rating loop. Cannot rate a delivery; vendor performance never feeds back from requesters. | High — without this, vendor scorecards are operator-only and miss employee voice. | Tier 1 |

**Acceptance criteria for "best-in-class requester":**
- Requester sees per-item allergen attestation + dietary certifications.
- Requester can submit a custom request that becomes a triaged ticket.
- Requester sees photos for ≥80% of catalog items.
- Requester gets real-time status updates (received → preparing → en route → delivered).
- Requester can reorder last meeting in one click.
- Requester can rate delivery 1-5 + free text post-event.

### 4.2 Admin (FM / workplace ops)

**Today's flow.**
- `/admin/booking-services` hub → vendors / menus & items / service rules.
- `/admin/vendors` — CRUD + service areas per vendor.
- `/admin/vendor-menus` — CRUD menus + nested items.
- `/admin/booking-services/rules` — CRUD service rules + simulator.
- `/admin/cost-centers` — CRUD cost centers + default approver.
- `/admin/bundle-templates` — CRUD bundle templates with services payload.

**What works.**
- Cost-center detail page is solid (clean SettingsRow pattern).
- Bundle template editor handles services correctly.
- Service area model with priority + space scope is sound.
- Service rule simulator is *conceptually* right.

**Gaps that matter.**

| Gap | Cost of inaction | Tier |
|---|---|---|
| **Free-form JSON predicate editor.** Admins won't author rules in raw JSON. Top source of future support tickets. | Critical — blocks self-service for non-technical admins. | Tier 1 |
| **UUID input for rule target.** Combobox with type-ahead is mandatory. | Critical (paired with above). | Tier 1 |
| **No vendor scorecards.** FM can't justify decisions with data. Loses competitive evals to ServiceChannel / Eptura. | Critical — direct deal-loss factor. | Tier 1 |
| **No catalog dedup / equivalence tooling.** Two vendors with overlapping items → catalog rot. | High — degrades requester experience over time. | Tier 1 |
| **No bulk operations.** Tolerable at 5 menus, miserable at 50. | High — blocks scale customers. | Tier 2 |
| **No vendor onboarding wizard.** New vendor → 4 separate pages. | Medium — friction at sales-handoff. | Tier 2 |
| **No "rule impact preview".** Publish rule with no idea how many drafts/orders it just affected. | High — fear-of-publishing → admins avoid touching rules. | Tier 2 |
| **No vendor capacity model.** Vendor says "500 lunches/day"; system doesn't know; 800 accepted on same day. | High — operational failure at scale. | Tier 1 |
| **No vendor blackout-window UI.** Schema partially supports; no surface. | Medium. | Tier 2 |
| **No tenant-level vendor visibility toggle.** Hard-coded "never show vendor". Some buyers will need food-only or always. | Medium — future deal flexibility. | Tier 1 |

**Acceptance criteria for "best-in-class admin":**
- Visual rule builder: pick template → fill named params → preview matched events.
- Combobox for every rule target / approver / cost-center / catalog-item picker.
- Vendor detail page surfaces SLA hit rate, on-time %, incident count, post-order rating, cost variance.
- Catalog dedup view: lists items with ≥2 menu offerings, with "merge into canonical" action.
- Capacity windows per vendor (per service_type, per day, per building).
- Tenant settings page exposes `vendor_visibility: never | food_only | always`.
- Bulk publish, bulk archive, bulk clone for menus.

### 4.3 Service desk operator

**Today's flow.**
- `/desk/bookings` list with reservation rows + bundle badge.
- Click row → detail drawer with services section.
- Per-line actions: cancel line, edit quantity, override price.
- Bundle cascade (cancel one or all).

**What works.**
- Three-tier visibility (participant / operator / admin).
- Bundle cascade handles messy cancellation paths.
- Per-line actions are right shape.

**Gaps that matter.**

| Gap | Cost of inaction | Tier |
|---|---|---|
| **Desk is SPOF for vendor failure.** No vendor portal → every vendor flake → manual desk routing. | Critical — operational scaling cliff. | Tier 1 |
| **No automated dispatch.** Order → ticket → ticket sits. | Critical — pairs with above. | Tier 1 |
| **No "at-risk" alerts.** Lunch in 4 hours; vendor unack'd → silence. | High — proactive ops surface. | Tier 2 |
| **No bulk reassignment.** Vendor cancels all day-of; one-by-one fix. | Medium. | Tier 2 |
| **Limited communication tools.** No in-context message to requester that becomes part of bundle audit. | Medium — current workaround is external email. | Tier 2 |
| **`/desk/bookings` "Bundles" filter is client-side.** Won't survive 200+ rows. | High — performance cliff. | Tier 1 |

**Acceptance criteria for "best-in-class desk":**
- Vendor portal exists and is the primary fulfillment channel; desk only handles exceptions.
- At-risk alerts appear at T-2h (yellow) and T-1h (red).
- Auto-fallback proposes a switch at T-30m if primary still unack'd.
- Bulk reassign across N orders for a single vendor.
- In-bundle message thread (visible to requester + desk + assigned vendor where relevant).
- All desk filters are server-side.

### 4.4 Vendor (the missing persona)

**Today's reality.** A `vendors` table, service areas, menus, items. **No vendor login, no portal, no notifications, no accept/decline, no fulfillment status feedback.**

This is the single largest gap in the subsystem. It is the difference between "best-in-class for workplace-experience" and "best-in-class for full FM ops" — and competitive evaluations will hinge on it.

#### 4.4.1 Operational reality — many vendors don't use software

**A meaningful portion of our clients' vendors do not log into platforms at all.** The dominant workflow in EU (especially NL) is a **printed daily list** ("*daglijst voor catering*" in Dutch) — operations prints or emails a structured PDF/list to the vendor each morning, the vendor works the list, and any later changes are communicated by phone or by reprinting. This pattern is not recommended (it kills real-time, blocks late-cycle order edits, creates stale-list errors) but it is current reality and will not change overnight.

**Implications for product strategy:**

1. **Vendor portal v1 cannot assume vendor adoption.** Some vendors will adopt; some won't; some will adopt and still rely on paper for kitchen-floor execution. The portal is one fulfillment channel, not the only one.
2. **Real-time status updates are unreachable for paper-based vendors.** We can model statuses, but with no vendor input, the desk has to update them manually — or the system has to *infer* status from time-of-day heuristics (e.g. auto-mark "delivered" at end of service window) with manual override.
3. **Order edits after print/cutoff are dangerous.** If desk takes a change at T-1h after the daily list was printed at T-3h, the vendor is working off stale paper. Either we forbid edits past cutoff, or we surface a loud "this change requires phone follow-up to vendor X" warning.
4. **The "daily list" itself must be a first-class product feature**, not a CSV export afterthought. Many clients have this as a hard requirement before they'll even consider switching from spreadsheets + email.

**Tier 1 must-haves (revised — paper-aware):**

A. **Daily list output (mandatory for all vendors, paper or digital).**
   - Structured PDF + plain-text email per vendor per day.
   - Auto-emailed to vendor's `daglijst_email` address at configurable cutoff time (default T-3h before earliest delivery for that vendor's earliest order).
   - One PDF per (vendor, building, service_type, date) — a vendor doing both catering and AV gets two lists; a vendor delivering to two buildings gets two lists.
   - Includes: order #, delivery time, location, headcount, items + quantities, dietary flags, requester name (first name only — privacy), notes, total.
   - Versioned: `daglijst_v1.pdf`, `daglijst_v2.pdf` etc., with diff highlights ("Order #1234 — quantity changed from 12 to 15").
   - Locked-state: once a daily list is sent, further edits to those orders go through a "post-cutoff change" workflow (see C below).

B. **Vendor portal v1 (read-only inbox + status updates) — the digital path.**
   - Vendor user model + auth (separate `vendor_users` table; cannot be Supabase Auth users in main user table).
   - Read-only inbox of incoming orders for vendors they're assigned to.
   - One-click acknowledge / decline.
   - Status update transitions: received → preparing → en route → delivered.
   - Email + webhook notification on order create.
   - **Vendors who use the portal don't need the daily list (or can opt out).**

C. **Post-cutoff change workflow.**
   - When a daily list has been emitted and an order changes (edit, cancel, new order added late):
     - System flags the change as `requires_phone_followup` on the order line.
     - Desk dashboard surfaces a "Today's late changes — call these vendors" widget grouped by vendor.
     - Audit event: `order.post_cutoff_change` + who was supposed to call + whether desk marked it confirmed.
     - Optional: regenerate `daglijst_v2.pdf` and re-email — but this only helps vendors who actually re-check email.

D. **Status inference for paper-based vendors.**
   - For vendors with `fulfillment_mode='paper_only'`: status auto-advances on time-of-day (received at delivery_time -1h, delivered at delivery_time + grace).
   - Desk can override at any point.
   - Vendor scorecard (Tier 1.3) for paper-only vendors derives on-time from desk-confirmed delivery, not from vendor input.

**This reframes Vendor portal v1 from "the solution" to "one channel". The daily list is the other channel and must ship in the same beat.**

#### 4.4.2 Long-term vision — vendors fully on platform

The end state is **every vendor on the platform**, with the daily list relegated to a fallback for the most resistant adopters. The migration path:

1. **Phase 1 (today):** all vendors paper-only by default. Daily list is the primary channel.
2. **Phase 2 (Tier 1):** introduce portal v1. Early-adopter vendors switch to portal; majority stays on paper. Hybrid mode supports both.
3. **Phase 3 (Tier 2):** ship vendor execution UX optimized per service type (see below). Lower the friction of going digital below the friction of staying paper.
4. **Phase 4 (Tier 3):** sunset paper-only mode for new clients; legacy clients keep it as exception.

**Optimized execution UX per service type — Tier 2 territory.** The portal v1 inbox is enough to *participate*; it isn't enough to make a vendor *prefer* the platform over paper. To actually win the migration, each service-type needs a domain-specific execution surface:

- **Catering — kitchen display system (KDS).** Inspired by Toast/Square KDS. Tablet-mounted in the kitchen. Orders shown as cards grouped by delivery time, color-coded by time-to-deadline (green = comfortable, yellow = soon, red = overdue). Card surfaces: items + quantities, dietary flags, delivery location, headcount. One-tap "preparing → en route → delivered" buttons. Audio + visual alert when new order arrives or T-30m fires. Optionally separate stations: cold prep, hot prep, packaging.
- **AV / equipment — field tech mobile UX.** Phone-first. Tech opens app, sees today's deliveries grouped by building + time, with map link, room number, equipment list with serial numbers, photo of the setup expected. One-tap "arrived → setup complete → broken down". Photo capture for proof-of-setup. Asset check-out / check-in tied to `asset_reservations`.
- **Cleaning / facilities services — checklist UX.** Geofenced check-in. Per-task checklist (sanitize whiteboard, restock water, vacuum). Photo proof per task. Time-stamped audit.
- **Transport / shuttle — ETA UX.** Driver-facing. Pickup queue, ETA per requester, one-tap "en route → arrived → completed".

**Responsiveness is mandatory across all of these — not a nice-to-have.** Vendors execute on phones and iPads, not desktops. Targets:

- **Catering KDS:** iPad portrait + landscape primary; large touch targets (≥44px), high-contrast for kitchen lighting, glanceable from 2 meters.
- **AV / cleaning / transport mobile:** phone primary (320-428px width); offline-tolerant (lossy network on basements, parking, in-transit); single-handed reachability for buttons.
- **Vendor inbox / portal:** responsive desktop + tablet + phone. Same component tree, breakpoint-driven layout.
- **Daily list (PDF) and emailed list:** print-quality + mobile-readable email body for vendors who scan on phone.

**Performance targets for vendor surfaces:**
- KDS: order updates land in <1s of desk action (Supabase realtime).
- Mobile field UX: page loads <2s on 3G; offline reads of today's queue.
- All vendor surfaces: PWA-installable; works in airplane mode after first load.

**Tier 2 nice-to-haves:**
- Vendor capacity self-service (set daily/weekly capacity by service_type + building).
- Blackout calendar (vacation, holidays, sick days).
- Vendor-side scorecard ("here's how you're performing").
- Invoice reconciliation (vendor uploads invoice, desk approves, GL posting).

**Tier 3:**
- Vendor SSO.
- Vendor self-onboarding (apply → admin approves → start fulfilling).
- POS / kitchen integration (Toast, Square, custom webhook).

### 4.5 Approver

**Today's reality.** Dedup works correctly via `scope_breakdown`. Unique partial index enforces "one approval per (entity, approver)". Approvers see one row per event.

**Gaps:**
- No "approve all" dashboard for batch handling on Monday morning.
- No delegation when approver is on vacation.
- No auto-escalation on stale approvals.
- No mobile-first approval UX (today's surface is desktop-shaped).

**Tier 1:**
- Approver inbox at `/portal/approvals` with batch-approve, smart sorting (urgent first), mobile-responsive.

**Tier 2:**
- Delegation: forward all approvals to person Y for date range.
- Auto-escalation: pending >48h → escalate to backup approver.
- Conditional auto-approve: "auto-approve catering under $200 from this cost center".

### 4.6 Finance / cost-center owner

**Today's reality.** Cost-center is a first-class concept. Linked to bundles + orders + line totals. Default approver per cost-center.

**Gaps:**
- No cost-roll-up reporting per cost center.
- No budget guardrails ("cost center X has $5k remaining; this $200 order would put it at 96%").
- No cost variance tracking (when fallback vendor charges more, who eats it?).

**Tier 1:**
- Cost center detail page surfaces YTD / QTD / MTD spend by service_type.
- Cost variance column in vendor scorecard (planned vs actual).

**Tier 2:**
- Budget guardrails with warning at 80%, soft-block at 100%, override-with-approval above.
- Department / org-node → cost-center mapping for auto-assignment.
- Monthly export to GL system (CSV / API).

---

## 5. Competitor landscape

### Where we win today

| Competitor | What we beat them on |
|---|---|
| **ServiceNow Workplace Service Delivery** | Lighter, faster, opinionated UX, native composite bundle, no consultant-hours. ServiceNow can't ship our requester UX without 6 months of implementation. |
| **Eptura / Condeco** | Unified rule engine, per-line scheduling, per-occurrence recurrence overrides. They have stronger vendor management but messier event modeling. |
| **Robin / Envoy** | Much deeper service modeling. They keep services shallow on purpose. |
| **EZCater for Business / Forkable** | We bundle. They don't. They're vendor-first; we're event-first. |
| **OfficeSpace / iOFFICE** | Stronger requester UX, opinionated event abstraction. |

### Where we lose today

| Competitor | What they beat us on | Why we lose |
|---|---|---|
| **ServiceChannel** | Real vendor portal, dispatch, scorecards, invoicing. | We have schema only, no UX. |
| **ServiceNow** (regulated buyers) | Allergen traceability, audit-grade vendor visibility, contract management. | Hidden-vendor model is opposite of what regulated buyers want. |
| **Robin + Sharebite / Forkable** | "Catering as a perk" — vendor brand IS the value. | Different lane; not trying to compete here. |
| **ezCater Direct** | Real-time order status, polished mobile, photos. | We have schema; no UX yet. |

### Lanes to stay out of

- **Marketplace.** ezCater / Caterspot. Their value prop is choice. Ours is invisibility. Don't compete.
- **Enterprise IT-flavored.** ServiceNow / BMC. Their value prop is configurability. Ours is opinionated UX. Don't bloat.
- **Catering-specialty SaaS.** Forkable / Cleo. Their value prop is food curation. Ours is workplace integration. Stay broad.

---

## 6. Ranked risks

In order of potential damage, lowest-bound estimates of customer impact.

| # | Risk | Damage if unaddressed | Mitigation tier |
|---|---|---|---|
| 1 | No vendor portal AND no daily list output | Desk SPOF; we exclude entire EU client segments who run on printed daglijst; first vendor failure → bad customer story → reference goes cold. | Tier 1 |
| 2 | Free-form JSON predicate editor | Top support-ticket source. Blocks self-service for non-technical admins. | Tier 1 |
| 3 | No vendor scorecards | FM can't justify decisions with data; loses ServiceChannel-style evals. | Tier 1 |
| 4 | No allergen / dietary safety trail | Real food incident → no traceability → reputation hit. Blocks EU expansion. | Tier 1 |
| 5 | No vendor capacity model | Operational failure at scale; over-acceptance, day-of failures. | Tier 1 |
| 6 | No catalog dedup / equivalence | Catalog rot; requester sees inconsistent items. | Tier 1 |
| 7 | No requester-side real-time status | Direct UX comparison loss vs ezCater; perceived "blackbox" period. | Tier 2 |
| 8 | No "custom request" path | Requesters bypass the system via Slack; analytics + ops visibility loss. | Tier 2 |
| 9 | No bulk admin operations | Friction compounds; satisfaction problem at 50+ menus. | Tier 2 |
| 10 | Approval inbox is single-event | Approvers want a dashboard. | Tier 2 |
| 11 | No tenant vendor-visibility toggle | Locks out buyers who require visibility (food-only, always). | Tier 1 |
| 12 | Audit log is best-effort try/catch | SOC 2 / GDPR risk. Audit must be transactional. | Tier 2 |

---

## 7. Performance & scale realities

### Where we're fine today

- **Asset conflict (GiST exclusion).** Scales linearly, no hot spots. ✅
- **Bundle list queries.** Indexed correctly for normal volumes. ✅
- **Service rule resolution per line.** Cached in `policy_snapshot`; doesn't re-evaluate on read. ✅

### Where we'll feel pain at 10x volume

| Bottleneck | Today's behavior | Fix |
|---|---|---|
| `resolve_menu_offer()` walks space ancestry per call | Fine at hundreds; expensive at 10k+ orders/day with deep building hierarchy | Cache resolution at `(delivery_space_id, on_date, service_type)` for 5-15 min in Redis or materialized view |
| `booking_bundle_status_v` computes status at read time | Fine for small bundles; expensive for 30-line recurring meeting | Memoize per-bundle in app cache, OR denormalize into `booking_bundles.status_rollup` column with triggers |
| `/desk/bookings` "Bundles" filter is client-side | Breaks past 200 rows | Push to backend; add `?has_bundle=true` query param + indexed `booking_bundle_id IS NOT NULL` partial |
| `BundleService.attachServicesToReservation` is sequential with try/catch cleanup | Race conditions; partial-failure data shapes possible | Move to single Postgres function (already deferred per spec) |
| Approval dedup partial-unique under high concurrency | Can deadlock | Test under load; consider advisory lock or queue |
| Audit events best-effort try/catch | Lost events under failure | Outbox pattern: log to `audit_outbox` in same transaction; background worker emits |

### What we should add proactively

- **Redis cache** for `resolve_menu_offer()` results. Invalidate on menu publish / item change.
- **Materialized view** for vendor scorecards (computed nightly).
- **Realtime channel** (`booking_bundles:tenant_<id>:requester_<id>`) for fulfillment status.
- **Background worker** for: vendor dispatch (email/webhook), at-risk alerts, audit outbox flush.
- **Read replica** for vendor scorecard reports (heavy aggregations).

---

## 8. Architectural inflections — choices we've made

These are decisions whose downside is invisible today but compounds. Don't reverse them silently.

| Decision | Trade made | Long-term cost |
|---|---|---|
| Hidden vendor as default, no toggle | Saves UX complexity now | Will need tenant toggle eventually; build now while surface is small |
| One predicate engine for room + service rules | Strong consistency | Mandatory religion: every new rule type must use this engine |
| Lazy bundle creation | Saves rows | Every read path needs "no bundle" branch — extra defensive code |
| Recurrence flags on lines (`repeats_with_series`, `recurrence_overridden`, `recurrence_skipped`) | Cleanly modeled | Large state space; bugs = operational nightmares; thorough test matrix mandatory |
| Approvals `scope_breakdown` jsonb | Right move | Backwards-compat cost if shape ever changes |
| `policy_snapshot` jsonb on orders + lines | Right for audit | Schema-on-read; future analytics painful unless documented |
| Asset reservations as separate table | Right (assets reservable without orders) | Costs a join |
| Status as view (`booking_bundle_status_v`), not column | Avoids trigger complexity | Computed at read time; expensive at scale |
| Standalone orders re-use bundle | Unifies paths | Slightly weird mental model ("bundle with no reservation") |

**Mandatory:** when proposing a change to any of these, link this section in the PR description and explain the trade.

---

## 9. Implementation roadmap

### Status legend

- 🟥 not started
- 🟧 in design
- 🟨 in progress
- 🟩 shipped
- ⬛ deferred (with rationale)
- ~~strikethrough~~ + commit/PR link when done

### 9.1 Tier 1 — MVP path to best-in-class

**Goal:** ship before broad market rollout. Without these, the front-end promise leaks.

#### 9.1.1 Vendor fulfillment channels — daily list + portal v1

**Status:** 🟥
**Owner:** TBD
**Estimate:** 6-8 weeks (combined; see split below)
**Depends on:** none.

**Why combined:** §4.4.1 establishes that a meaningful portion of EU clients' vendors don't log into platforms — they work off printed daily lists ("*daglijst voor catering*"). The portal is one channel; the daily list is the other. Both must ship in the same beat or we exclude entire customer segments.

**Sub-task split — Phase A (daily list, ~2-3 weeks):**

> **Full spec:** [`docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md`](superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md). Read before implementing.

- [ ] Schema: `vendors.fulfillment_mode ENUM('portal', 'paper_only', 'hybrid') DEFAULT 'paper_only'`.
- [ ] Schema: `vendors.daglijst_email TEXT`, `daglijst_cutoff_offset_minutes INTEGER DEFAULT 180` (3h default), `daglijst_send_time TIME` (alternative: fixed time-of-day like 07:00).
- [ ] Schema: `vendor_daily_lists` (id, vendor_id, building_id, service_type, list_date, version, generated_at, sent_at, recipient_email, pdf_url, payload jsonb).
- [ ] Backend: `DailyListService` — assembles list per (vendor, building, service_type, date); renders PDF (use puppeteer or pdfkit); uploads to storage; emails.
- [ ] Background worker: scans pending orders nightly + per-vendor cutoff; emits daily lists when threshold reached.
- [ ] Lock-state: when daily list emitted for an order, set `order_line_items.daglijst_locked_at`. Subsequent edits flag `requires_phone_followup=true`.
- [ ] Admin UI: vendor detail surfaces fulfillment mode + daglijst email + cutoff config + "preview today's list" + "regenerate now" buttons.
- [ ] Audit events: `daglijst.generated`, `daglijst.sent`, `daglijst.regenerated`, `order.post_cutoff_change`.

**Sub-task split — Phase B (vendor portal v1, ~3-4 weeks):**

> **Full spec:** [`docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md`](superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md). Read before implementing.

- [ ] Schema: `vendor_users` (vendor_id, email, role, last_login_at, active). Magic-link auth (no password initially).
- [ ] Auth flow: separate from main Supabase Auth pool; vendor JWT scoped to `vendor_user`.
- [ ] Backend module: `VendorPortalModule` with services `VendorAuthService`, `VendorOrderService`.
- [ ] Endpoints (vendor-scoped):
  - `GET /vendor/orders?status=…` — list orders for assigned vendor.
  - `GET /vendor/orders/:id` — order detail (no requester PII beyond first name).
  - `POST /vendor/orders/:id/acknowledge`
  - `POST /vendor/orders/:id/decline` (with reason)
  - `POST /vendor/orders/:id/status` (received | preparing | en_route | delivered)
  - `GET /vendor/daily-list?date=…` — vendor can pull their own daglijst (saves the email round-trip).
- [ ] Vendor UI: separate sub-app at `/vendor` or subdomain. Minimal: list + detail + status buttons + "download today's daily list" link.
- [ ] Email notification on order created → assigned vendor's contact_email (in addition to daily list cycle, for vendors with `fulfillment_mode='portal'`).
- [ ] Webhook trigger on order created → `vendors.webhook_url` (new column).
- [ ] Realtime channel for desk operators: vendor status changes push to `/desk/bookings` drawer.
- [ ] Audit events: `vendor.order_acknowledged`, `vendor.order_declined`, `vendor.order_status_updated`.

**Sub-task split — Phase C (post-cutoff workflow + status inference, ~1 week):**

- [ ] Desk UI: "Today's late changes — call these vendors" widget on `/desk` home, grouped by vendor + ordered by delivery time. Surfaces every order line where `requires_phone_followup=true AND desk_confirmed_phoned_at IS NULL`.
- [ ] Endpoint: `POST /orders/lines/:id/confirm-phoned` — desk records phone follow-up.
- [ ] Background worker: status inference for paper-only vendors. Auto-advances `received` at delivery_time -1h, `delivered` at delivery_time + grace_minutes. Desk can override at any point.
- [ ] Vendor scorecard (Tier 1.3) honors `fulfillment_mode`: portal vendors get scored on real input; paper vendors get scored on desk-confirmed delivery.

**Acceptance:**
- Paper-only vendor with `daglijst_cutoff_offset_minutes=180`: receives PDF email at T-3h before earliest order. PDF lists every order, items, quantities, delivery times, locations, totals.
- Late edit (post-cutoff): system flags `requires_phone_followup`. Desk widget shows it; desk calls vendor; marks confirmed-phoned. Audit captures the chain.
- Portal vendor: receives email + can log in via magic link; sees inbox; updates status; desk sees real-time.
- Hybrid vendor: gets daily list AND can log in; either path updates the same order.
- Vendor scorecards work for both modes.
- Declined orders auto-trigger fallback vendor (if coverage supports; else flag for desk).

#### 9.1.2 Visual rule builder for service rules

**Status:** 🟧 in design — see [`docs/superpowers/specs/2026-04-27-visual-rule-builder-design.md`](superpowers/specs/2026-04-27-visual-rule-builder-design.md)
**Owner:** TBD
**Estimate:** 6-8 weeks (compresses to ~6 with 2 engineers parallel)
**Depends on:** existing `service_rule_templates` seed data.

**Note:** spec covers the unified visual rule builder across ALL rule domains (services + room booking + future visitor + parking + asset), not just service rules. Same builder, same EntityPicker library, same template flow, same simulator/debugger/coverage/conflict-detection. This is where the "one predicate engine" wedge becomes visible to admins.

**Sub-tasks:**
- [ ] Frontend: rule editor at `/admin/booking-services/rules/:id` becomes template-driven by default.
- [ ] Step 1: pick template (lead-time, cost threshold, role-restricted item, blackout window, capacity threshold, category hidden, menu unavailable).
- [ ] Step 2: fill template params via typed UI inputs (combobox for items / roles / cost centers; date range picker; number input with units).
- [ ] Step 3: preview matched events from last 30 days (dry-run against historical orders).
- [ ] "Raw JSON" mode behind an "Advanced" toggle for power users.
- [ ] Combobox primitives for: catalog items, menus, categories, roles, cost centers, persons, vendors, asset types.
- [ ] Param-spec schema in `service_rule_templates.param_specs` consumed by UI.

**Acceptance:**
- Non-technical admin creates "Catering over $500 needs VP approval" without seeing JSON.
- Rule preview shows "12 events in last 30 days would have matched this rule."
- Power user can still drop into raw JSON for edge cases.

#### 9.1.3 Vendor scorecards (data model + admin UI)

**Status:** 🟧 in design — see [`docs/superpowers/specs/2026-04-27-vendor-scorecards-design.md`](superpowers/specs/2026-04-27-vendor-scorecards-design.md)
**Owner:** TBD
**Estimate:** 3-4 weeks (after Phase A + Phase B land)
**Depends on:** Phase A status inference + Phase B self-reported status events.

**Sub-tasks:**
- [ ] Schema: `vendor_scorecards_daily` (vendor_id, date, service_type, orders_received, orders_acknowledged, orders_delivered, orders_declined, on_time_count, late_count, avg_minutes_to_acknowledge, total_revenue, cost_variance).
- [ ] Materialized view, refreshed nightly via background job.
- [ ] Frontend: vendor detail page at `/admin/vendors/:id` adds "Performance" section.
- [ ] KPI tiles: on-time %, ack latency, decline rate, revenue, cost variance.
- [ ] Trendline charts (last 90 days).
- [ ] Comparison view: vendor X vs vendor Y for same service_type + building.
- [ ] CSV export for procurement / RE/FM directors.

**Acceptance:**
- FM director sees on-time % and ack latency per vendor.
- Comparison view ranks vendors covering same building / service_type.
- Data refreshes nightly; manual refresh button for desk leads.

#### 9.1.4 Allergen / dietary safety trail

**Status:** 🟥
**Owner:** TBD
**Estimate:** 2-3 weeks
**Depends on:** existing `catalog_items.dietary_tags`.

**Sub-tasks:**
- [ ] Schema: `vendor_certifications` (vendor_id, certification_type, document_url, issued_at, expires_at, verified_by_user_id).
- [ ] Schema: `catalog_item_allergen_attestations` (catalog_item_id, allergen, level: contains | may_contain | free, attestation_source: vendor | admin_override).
- [ ] Admin UI: vendor detail surfaces certifications upload + verification.
- [ ] Admin UI: catalog item detail surfaces per-allergen attestation editor.
- [ ] Requester UI: dietary filter chips ("Halal", "Kosher", "Nut-free", "Vegan") on catering section.
- [ ] Requester UI: per-item allergen badges (visible without revealing vendor).
- [ ] Internal audit trail: order detail (admin/desk-only view) shows full vendor + certification snapshot at order time.

**Acceptance:**
- Requester filters catering by "Halal" and sees only certified-Halal items.
- Allergen attestation visible per item to requester (no vendor identity).
- Internal audit query can answer "which kitchen produced this lunch on date X" within 30 seconds.

#### 9.1.5 Vendor capacity model

**Status:** 🟥
**Owner:** TBD
**Estimate:** 2-3 weeks
**Depends on:** vendor portal v1 (vendor self-service surface).

**Sub-tasks:**
- [ ] Schema: `vendor_capacity_windows` (vendor_id, service_type, space_id nullable, day_of_week, time_start, time_end, max_quantity_per_window).
- [ ] Schema: `vendor_blackouts` (vendor_id, start_at, end_at, reason).
- [ ] Backend: capacity check in `BundleService.attachServicesToReservation` — count existing orders in window, reject if at capacity.
- [ ] Backend: when primary at capacity, fall through to next vendor in `vendor_service_areas.default_priority`.
- [ ] Admin UI: vendor detail surfaces capacity-windows editor.
- [ ] Vendor portal: vendor can set own capacity + blackouts (later phase).

**Acceptance:**
- Vendor X can deliver max 200 lunches/day; the 201st order auto-routes to vendor Y.
- Vendor in blackout window from order routing automatically.
- Failover decision is logged in `routing_decisions` for audit.

#### 9.1.6 Catalog dedup / equivalence tooling

**Status:** 🟥
**Owner:** TBD
**Estimate:** 2 weeks
**Depends on:** none.

**Sub-tasks:**
- [ ] Schema: `catalog_item_equivalence_groups` (canonical_catalog_item_id, equivalent_catalog_item_id) + `display_name` override on canonical.
- [ ] Backend: `resolve_menu_offer` collapses equivalence group to canonical for requester view.
- [ ] Admin UI: `/admin/booking-services/dedup` view — lists items appearing in ≥2 menus across vendors, with "merge into canonical" + "mark as equivalent" actions.
- [ ] Audit: every merge is logged; reversible.

**Acceptance:**
- Two vendors both list "sandwich platter"; admin marks them equivalent; requester sees one line.
- Merge is reversible from audit history.
- Merge does not break existing orders (snapshot preserved in `order_line_items.catalog_item_id`).

#### 9.1.7 Tenant-level vendor-visibility toggle

**Status:** 🟥
**Owner:** TBD
**Estimate:** 1 week
**Depends on:** none.

**Sub-tasks:**
- [ ] Schema: `tenant_settings.vendor_visibility ENUM('never', 'food_only', 'always') DEFAULT 'never'`.
- [ ] Schema: `catalog_item_categories.vendor_visibility_override ENUM(...) NULLABLE` for per-category override.
- [ ] Frontend: tenant settings page exposes the toggle.
- [ ] Frontend: requester views check tenant + category overrides; show vendor name + logo when allowed.
- [ ] Document the rule in [feedback memory](../../.claude/projects/-Users-x-Desktop-XPQT/memory/feedback_hide_vendor_from_requester.md).

**Acceptance:**
- Tenant A with `vendor_visibility='never'` shows no vendor anywhere on requester surface.
- Tenant B with `food_only` shows vendor only on catering items.
- Tenant C with `always` exposes vendor on every item.
- Internal audit always retains vendor identity regardless.

#### 9.1.8 Automated vendor dispatch (email + webhook)

**Status:** 🟥 (subsumed by 9.1.1, but worth shipping standalone if vendor portal slips)
**Owner:** TBD
**Estimate:** 1 week (if portal not yet ready)

If vendor portal is delayed, ship dispatch independently:
- [ ] On order create: send templated email to vendor's `contact_email`.
- [ ] On order create: POST to `vendors.webhook_url` (new column) if set.
- [ ] Vendor email contains acknowledge link (one-time-token endpoint, no auth required).
- [ ] Acknowledge link records `order.acknowledged_at`.

#### 9.1.9 Server-side `/desk/bookings` filters

**Status:** 🟩 shipped (commit `77bb4a5`, migration 00199)

- [x] `GET /reservations?has_bundle=true` query param (controller + service).
- [x] Partial index `idx_reservations_with_bundle` on `reservations(tenant_id, start_at desc) WHERE booking_bundle_id IS NOT NULL` (00199).
- [x] Frontend: dropped client-side `filter((r) => Boolean(r.booking_bundle_id))` on /desk/bookings; threads `has_bundle: true` through `ReservationListFilters` + `useOperatorReservations` when the Bundles chip is selected.

#### 9.1.10 Per-person pricing on `/portal/order`

**Status:** 🟥
**Owner:** TBD
**Estimate:** 2 days

- [ ] Add attendee count input to `/portal/order` form.
- [ ] Compute line totals respecting `unit='per_person'` + attendee count.
- [ ] Validate min/max quantity against attendee count.

#### 9.1.11 Atomicity of `BundleService.attachServicesToReservation`

**Status:** 🟥
**Owner:** TBD
**Estimate:** 2 weeks

- [ ] Move multi-step orchestration into single Postgres function `bundle_attach_services_atomic(args jsonb) RETURNS jsonb`.
- [ ] Service layer becomes thin wrapper.
- [ ] Audit events emitted via `audit_outbox` inserts in same transaction.

#### 9.1.12 Audit outbox

**Status:** 🟥
**Owner:** TBD
**Estimate:** 2 weeks

- [ ] Schema: `audit_outbox` (id, tenant_id, event_type, payload, created_at, processed_at).
- [ ] Replace direct `audit_events` writes with outbox inserts.
- [ ] Background worker drains outbox, writes to `audit_events` + ships to external SIEM if configured.
- [ ] All bundle / order / approval / asset / vendor events go through outbox.

#### 9.1.0 Microsoft Graph integration (foundational — unlocks Outlook + Teams + calendar sync)

**Status:** 🟧 in design — see [`docs/superpowers/specs/2026-04-27-microsoft-graph-integration-design.md`](superpowers/specs/2026-04-27-microsoft-graph-integration-design.md)
**Owner:** TBD
**Estimated effort:** 16-22 weeks across Phases 1-4 (Phase 5 add-in deferred)
**Depends on:** none (greenfield)

**Why Tier 1, foundational:** without bi-directional Outlook sync, Teams notifications, and room mailbox sync, Prequest cannot win against Eptura/Condeco/Robin in NL/BE corporate HQ deals. This is the single integration that unlocks calendar sync, conflict prevention, Teams notifications, adaptive card approvals, and the Outlook add-in path. See [competitive benchmark](competitive-benchmark.md) for justification.

**Phases:**

- **Phase 1 (4-6 wks):** Foundation + Outlook → Prequest read-only sync. Tenant connects via 5-step wizard; room mailboxes mapped to spaces; Outlook bookings appear in Prequest within 30s with deep-link to add services.
- **Phase 2 (3-4 wks):** Bi-directional sync + conflict resolution. Cancellations + reschedules cascade. Conflicting Outlook events auto-declined. Recurrence sync.
- **Phase 3 (3-4 wks):** Teams notifications via Bot Framework. Adaptive cards for confirmed bundles, pending approvals, at-risk services.
- **Phase 4 (2-3 wks):** Approve-from-Teams adaptive card actions with HMAC validation + in-place card refresh.
- **Phase 5 (4-6 wks, deferred to Tier 2):** Office.js Outlook add-in for compose-pane services attachment. Wait until Phase 1 deep-link validates (covers 80% of value).

**Acceptance:** see spec doc §11.

**Open product questions** captured in spec §14.

#### 9.1.13 GDPR baseline — retention, erasure, access

**Status:** 🟧 in design — see [`docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md`](superpowers/specs/2026-04-27-gdpr-baseline-design.md)
**Owner:** TBD
**Estimate:** 5-6 weeks (engineering only; legal/DPA work in parallel)
**Depends on:** none — but every other spec depends on parts of THIS (calendar PII handling, daglijst PDF retention, ghost person erasure cascade, audit outbox).

**Why Tier 1:** every EU customer (mandatory regardless of size) requires DPA + retention + per-person access/erasure. This is a deal-blocker for any tenant doing procurement diligence. Build it before scaling marketing.

**A — Tenant-configurable retention + anonymization (visitor + person-level cleanup)**

Visitor data is personal data; legitimate-interest (security, incident response) IS a valid lawful basis but is **not unlimited**. Build retention as a tenant-configurable setting with sensible defaults + an upper cap. Anonymize rather than delete so operational analytics survive.

- [ ] Schema: `tenant_retention_settings` (tenant_id, data_category enum, window_days, capped_max_days, lia_text, updated_at, updated_by_user_id).
- [ ] Default windows:
  - Visitor name/email/host: 180 days (cap 365).
  - Visitor photo/ID scan: 90 days (cap 180).
  - Anonymized visit metadata: indefinite (no PII).
  - CCTV (if ever stored): 28 days, no cap extension without explicit toggle.
  - Person preferences (favorites, dietary, custom contacts): 30 days from `persons.left_at`.
  - Person reference in past bookings/orders: anonymize at 90 days from `left_at`; preserve booking record for tenant's audit window.
- [ ] Schema: `persons.left_at` timestamp; nullable; nightly job acts on it.
- [ ] Anonymization function: replace `persons.name`, `persons.email`, `persons.phone` with synthetic placeholder (`Former employee #<hash>`); preserve `id` so historical FKs hold.
- [ ] Background worker (nightly): scan visitors past retention → anonymize; scan `persons.left_at` → cascade cleanup per schedule.
- [ ] Audit event per anonymization / deletion (`gdpr.retention_anonymized`).
- [ ] Admin UI: tenant settings page surfaces retention windows per category + LIA text input field.

**B — Per-person right of access, erasure, portability**

- [ ] Endpoint: `GET /admin/gdpr/persons/:id/export` — admin-initiated full export of all data for a person (bookings, orders, audit events, preferences). JSON download.
- [ ] Endpoint: `POST /admin/gdpr/persons/:id/erase` — admin-initiated delete-or-anonymize. Honors legal-retention exceptions (preserve historical records but anonymize PII).
- [ ] Audit events: `gdpr.access_request_fulfilled`, `gdpr.erasure_request_fulfilled`.
- [ ] (Tier 2) self-serve subject access — employee initiates from `/portal/me`.

**C — Privacy-notice + sub-processor disclosure**

- [ ] Per-tenant privacy notice URL (settable in admin) linked from app footer. Default to a generic Prequest privacy notice if tenant doesn't set one.
- [ ] Sub-processor disclosure page (`/legal/sub-processors`): lists Supabase, email provider, etc. Versioned; tenants can subscribe to changes.
- [ ] `privacy@prequest.app` mailbox routing.

**D — Personal-data access audit (read audits, not just writes)**

- [ ] Extend audit log to capture *reads* of personal data: which user / IP / endpoint accessed which person's record.
- [ ] Tenant admin can run "who saw X's data in last 90 days" report.
- [ ] Hashed IP + pseudonymized user agent (don't store raw forensic data forever).

**E — Breach notification runbook (process, not feature)**

- [ ] Internal runbook: detection → triage → 72-hour AP notification → customer comms.
- [ ] Customer comms templates pre-drafted.
- [ ] Annual tabletop exercise.

**F — DPA template + EU residency confirmation (legal/policy, not engineering)**

- [ ] DPA template signed off by Dutch privacy counsel.
- [ ] Confirm Supabase project is in EU region (NL/DE preferred).
- [ ] Confirm all sub-processors are GDPR-compliant; document SCCs for any non-EU service.
- [ ] Document the lawful basis per data type (Records of Processing Activities, Art. 30).

**Acceptance:**
- Tenant admin can set visitor retention to 30 / 90 / 180 / 365 days; system enforces it nightly.
- Tenant admin can mark a person as "left" → preferences delete in 30 days, person ref anonymizes at 90 days, past bookings retained but anonymized.
- Tenant admin can export or erase a specific person on request.
- Audit log records all reads of personal data, not just writes.
- DPA template is procurement-ready; sales does not need engineering ad-hoc on every deal.
- Privacy notice + sub-processor list live in production.

**What this does NOT include (deferred or external):**
- SOC 2 Type II audit program (Tier 3, only if enterprise pipeline demands).
- ISO 27001 (Tier 3).
- Self-serve subject access for employees (Tier 2).
- Granular consent management for special categories (Tier 2 — needed for explicit allergen consent, Article 9).
- Health-data special handling for hospital sub-segment (Tier 3).

### 9.2 Tier 2 — full best-in-class

#### 9.2.0 Optimized vendor execution UX (per service type)

**Status:** 🟧 in design — see [`docs/superpowers/specs/2026-04-27-vendor-execution-ux-design.md`](superpowers/specs/2026-04-27-vendor-execution-ux-design.md)
**Owner:** TBD
**Estimated effort:** 12-16 weeks total across 4 phases (each phase parallelizable)
**Depends on:** Vendor portal Phase B (auth + inbox foundation).

**Goal:** lower friction of digital below friction of paper. Without this, portal adoption stalls and we stay paper-default forever.

**Critical principle:** these tools REPLACE existing manual workflows (paper, whiteboard, radio, phone dispatch) — voluntary adoption only, never forced. Vendor adopts because the tool is better than what they have today.

**Catering — Kitchen Display System (KDS)**
- Tablet-mounted view (iPad portrait + landscape).
- Order cards grouped by delivery time; color-coded by time-to-deadline (green/yellow/red).
- Card content: items + quantities, dietary flags, location, headcount, requester first name.
- One-tap status: preparing → en route → delivered.
- Audio + visual alert on new order, on T-30m countdown.
- Optional stations: cold prep / hot prep / packaging — each with its own filtered view.
- Realtime updates from desk edits land in <1s.
- Reference UX: Toast KDS, Square KDS.

**AV / equipment — Field tech mobile UX**
- Phone-first (320-428px primary).
- Today's deliveries grouped by building + time.
- Per-job: map link, room number, equipment list with serial numbers, expected-setup photo.
- One-tap: arrived → setup complete → broken down.
- Photo capture for proof-of-setup, attached to order line.
- Asset check-out / check-in tied to `asset_reservations`.
- Offline-tolerant (basements, parking).

**Cleaning / facilities services — Checklist UX**
- Geofenced check-in.
- Per-task checklist with photo proof.
- Time-stamped audit trail per task.

**Transport — ETA UX**
- Driver-facing pickup queue.
- One-tap: en route → arrived → completed.
- Live ETA shared with requester (real-time channel).

**Cross-cutting requirements**
- All surfaces PWA-installable.
- Single component tree; breakpoint-driven layout.
- Touch targets ≥44px; glanceable typography for KDS at 2m.
- Single-handed reachability for phone surfaces.
- Background sync when reconnected.

**Acceptance:**
- Catering vendor uses KDS on a tablet; receives a new order; it appears within 1s with audio alert; vendor taps preparing → en route → delivered; desk + requester see status update in real-time.
- AV tech receives morning push notification; offline-loads today's queue; completes setup on basement floor with no signal; status syncs when back online.
- Cleaning vendor cannot mark a task complete without geo + photo proof.

#### 9.2.1 Real-time fulfillment status for requesters
- Supabase realtime channel `booking_bundles:tenant_<id>:requester_<id>`.
- Push fulfillment status changes to `/portal/me-bookings` drawer.
- Status transitions: `received → preparing → en_route → delivered`.

#### 9.2.2 Custom request path
- New "Request something else" CTA on every service section.
- Creates a triaged ticket, not an order.
- Routes to desk for manual quoting.
- Once quoted, can be converted to a regular order line.

#### 9.2.3 Item images everywhere
- Audit `catalog_items.image_url` coverage.
- Bulk upload tool in admin.
- Default placeholder per category.
- Display in: requester sections, /portal/me-bookings drawer, /desk/bookings drawer.

#### 9.2.4 Reorder + favorites
- "Recent bundles" chip row on `/portal/rooms`.
- "Save as favorite" on bundle detail.
- "Reorder this booking" on past `/portal/me-bookings` rows.

#### 9.2.5 Requester rating loop

**Status:** 🟧 in design — see [`docs/superpowers/specs/2026-04-27-requester-rating-design.md`](superpowers/specs/2026-04-27-requester-rating-design.md)
**Owner:** TBD
**Estimate:** 3-4 weeks (after vendor scorecards spec; can run parallel to scorecards implementation)
**Depends on:** MS Graph integration Phase 3 (for Teams channel — email channel works without it).

**Note:** despite Tier 2 placement, this is the highest-trust voluntary signal feeding scorecards. May be elevated to Tier 1 if scorecards' data quality requires it. Single prompt at T+24h; opt-out always available; component-by-component rating; hidden vendor maintained; "didn't happen" workflow as separate escalation; recurring meeting suppression; 90-day anonymization.

#### 9.2.6 Approver inbox dashboard
- `/portal/approvals` page with: filter chips, batch-approve, smart sort (urgent/at-risk first).
- Mobile-responsive.
- Approval delegation: forward to person Y for date range.
- Auto-escalation: pending >48h → escalate to backup approver.

#### 9.2.7 Cost analytics
- `/admin/cost-centers/:id` adds spend-over-time chart.
- Dimensions: service_type, vendor, requester (top 10).
- CSV export.

#### 9.2.8 Bulk admin operations
- Bulk publish menus.
- Bulk archive expired menus.
- Clone menu (copy items into new dated window).
- Bulk reassign vendor service areas.
- Bulk update item prices (% increase / fixed amount).

#### 9.2.9 At-risk alerts on desk
- Background worker scans pending orders.
- T-2h: yellow flag on `/desk/bookings`.
- T-1h: red flag + email to desk lead.
- T-30m: auto-fallback proposed if vendor unack'd.

#### 9.2.10 In-bundle messaging
- `bundle_messages` table.
- Visible to: requester, host, desk operators in scope, vendor (if portal active).
- Message thread visible in bundle detail drawer.
- Each message becomes part of audit trail.

#### 9.2.11 Bulk dispatch / reassignment
- `/desk/bookings` bulk-select rows.
- "Reassign all to vendor Y" action.
- "Cancel all for vendor X" action.

#### 9.2.12 Rule impact preview at publish time
- Before publishing rule, run dry-run against last 30 days of orders.
- Show: "this rule would have affected N orders, of which M were approved, K denied."

#### 9.2.13 Vendor onboarding wizard
- Single-page flow: vendor info → service areas → first menu → first items → publish.
- Optional: invite vendor user to portal.

#### 9.2.14 Budget guardrails
- Cost-center spend warning at 80%.
- Soft-block at 100% (can override with extra approval).
- Monthly reset cycle.

### 9.3 Tier 3 — long-tail polish

- Mobile-first requester app (separate beat).
- AV/equipment specialty: setup + breakdown windows, technician assignment.
- Vendor SSO.
- Vendor self-onboarding (apply → admin approves).
- POS integration (Toast, Square, custom webhook).
- White-label "service brand" customization per tenant.
- Dynamic pricing (seasonal, peak hours).
- Inventory awareness (projector available 1 unit; reject orders for 2).
- Multi-leg delivery (coffee 9am, lunch 12pm, snacks 3pm — supported by schema, surface in UX).
- Recurring orders that scale with attendance ("lunch @ 15/person").
- Department / org-node → cost-center auto-mapping.
- Conditional auto-approve rules.
- Read replica for scorecard reports.
- Materialized space-closure cache for `resolve_menu_offer`.

---

## 10. Customer validation work

Run in parallel with Tier 1 engineering. Five customer interviews, three questions:

1. **"Would you ship a workplace app that hides which caterer made the food?"**
   - 5/5 yes → ship pure invisibility.
   - 3-4/5 yes → ship invisibility + tenant toggle.
   - <3/5 yes → reconsider the wedge.
2. **"How do you measure vendor performance today?"**
   - Look for: spreadsheets, ad-hoc complaints, no measurement.
   - Listen for: SLA, on-time %, post-event rating, cost variance.
3. **"What's the worst vendor failure you've had in the last 12 months?"**
   - Probe: what went wrong, who absorbed it, what would have helped.

**Decision points after interviews:**
- If allergen / dietary trust comes up unprompted → 9.1.4 is critical, not high.
- If 4+ admins have NEVER touched a JSON predicate → 9.1.2 is critical, not high.
- If desk team has burned out from vendor flake → 9.1.1 is do-or-die.

Document interview notes in `docs/research/booking-services-interviews-<date>.md`.

---

## 11. Current state inventory

Snapshot as of 2026-04-27. Update when migrations, modules, or pages change.

### 11.1 Tables

| Table | Purpose | Migration |
|---|---|---|
| `catalog_items` | Root product catalog (food/equipment/supplies/services) | 00013, extended later |
| `vendors` | External providers | 00023 |
| `vendor_service_areas` | Vendor coverage by space + service_type + priority | 00023 |
| `catalog_menus` | Per-vendor or per-team menus, date-bounded, optionally space-scoped | 00023, altered 00143 |
| `menu_items` | Priced offering rows (vendor + item + price + availability) | 00023 |
| `booking_bundles` | Orchestration parent for room + services | 00140, FK 00147 |
| `orders` | Service cart (food / equipment / supplies) | 00013, extended 00144 |
| `order_line_items` | Lines with provenance, scheduling, recurrence flags | 00013, extended 00144 |
| `service_rules` | Predicate engine for service-side rules | 00141 |
| `service_rule_versions` | Audit / revert trail | 00141 |
| `service_rule_templates` | Seeded read-only templates | 00141, seeded 00149 |
| `service_rule_simulation_scenarios` | Test cases for rule editor | 00141 |
| `cost_centers` | Cost / approval routing | 00140 |
| `bundle_templates` | Pre-filled composite shapes | 00140 |
| `asset_reservations` | Asset conflict guard via GiST exclusion | 00142 |
| `approvals` (extended) | scope_breakdown jsonb, unique partial index | 00146 |
| `booking_bundle_status_v` | Computed status view | 00148 |

**Indexes worth knowing:** `idx_vsa_space_service`, `idx_menus_active_window`, `idx_bundles_window`, `idx_orders_bundle`, `idx_oli_window`, `idx_service_rules_target`, `idx_service_rules_priority`, GiST on `asset_reservations.time_range`.

### 11.2 Backend modules

| Module | Path | Key services |
|---|---|---|
| BookingBundles | `apps/api/src/modules/booking-bundles/` | `BundleService`, `BundleVisibilityService`, `BundleCascadeService` |
| ServiceCatalog | `apps/api/src/modules/service-catalog/` | `ServiceRuleResolverService`, `ServiceRuleService`, `ServiceEvaluationContext` |
| Orders | `apps/api/src/modules/orders/` | `OrderService`, `ApprovalRoutingService` |
| BundleTemplates | `apps/api/src/modules/bundle-templates/` | `BundleTemplateService` |
| CostCenters | `apps/api/src/modules/cost-centers/` | `CostCenterService` |
| Vendors | `apps/api/src/modules/vendors/` | `VendorService` |
| CatalogMenus | `apps/api/src/modules/catalog-menus/` | `CatalogMenuService` |

### 11.3 Admin pages

| Path | File | Purpose |
|---|---|---|
| `/admin/booking-services` | `booking-services.tsx` | Hub (Vendors / Menus & items / Service rules) |
| `/admin/vendors` | `vendors.tsx` | Vendor CRUD + service areas |
| `/admin/vendor-menus` | `vendor-menus.tsx` | Menu CRUD with nested items |
| `/admin/booking-services/rules` | `service-rules.tsx` | Service rule list |
| `/admin/booking-services/rules/:id` | `service-rule-detail.tsx` | Rule editor + simulator |
| `/admin/cost-centers` | `cost-centers.tsx` | Cost center list |
| `/admin/cost-centers/:id` | `cost-center-detail.tsx` | Cost center detail |
| `/admin/bundle-templates` | `bundle-templates.tsx` | Template list |
| `/admin/bundle-templates/:id` | `bundle-template-detail.tsx` | Template detail |

### 11.4 Requester pages

| Path | File | Purpose |
|---|---|---|
| `/portal/rooms` | `pages/portal/rooms/*` | Room booking + bundle template chips |
| (booking-confirm dialog) | inline component | Catering / AV / Setup sections |
| `/portal/order` | `pages/portal/order/index.tsx` | Standalone services-only order |
| `/portal/me-bookings` | `pages/portal/me-bookings/*` | User booking list with services drawer |

### 11.5 Desk pages

| Path | File | Purpose |
|---|---|---|
| `/desk/bookings` | `pages/desk/bookings/*` | Reservation list with bundle badge + drawer |
| `/desk/scheduler` | `pages/desk/scheduler/*` | Calendar view (assets overlay future) |
| `/desk/reports/bookings/*` | `pages/desk/reports/bookings/*` | Five overview reports |

### 11.6 Specs and docs

- [`docs/superpowers/specs/2026-04-26-linked-services-design.md`](superpowers/specs/2026-04-26-linked-services-design.md) — schema + locked decisions.
- [`docs/room-booking.md`](room-booking.md) — operational reference.
- [`docs/service-catalog-live.md`](service-catalog-live.md) — current service-catalog model.
- [`docs/assignments-routing-fulfillment.md`](assignments-routing-fulfillment.md) — companion doc on routing.
- [`docs/visibility.md`](visibility.md) — companion doc on visibility tiers.

---

## 12. Glossary & invariants

### Invariants — never violate

1. **Bundle is the unit of orchestration.** New service-related features attach to bundle, not to reservation directly.
2. **One predicate engine.** All availability / approval / restriction logic flows through the same `applies_when` AST.
3. **Vendor identity is hidden from requesters by default.** Tenant toggle exists (Tier 1.7) for the minority who need otherwise.
4. **Audit trail retains vendor identity always.** Internal queries always answer "who fulfilled this".
5. **Asset conflicts are DB-enforced.** Never replace GiST exclusion with app-level checks.
6. **Approval dedup covers multi-line events.** One approver, one approval row, regardless of line count.
7. **Service rule resolution is cached at order time** (`policy_snapshot`). Reads never re-evaluate rules.
8. **Tenant isolation is RLS-enforced.** Service layer adds belt-and-braces `eq('tenant_id', …)` guards on by-id paths.
9. **Fulfillment is multi-channel.** Vendors fulfill via portal, daily list, or hybrid. Order state machine never assumes vendor-as-software-user. Status inference + desk override always available.

### Glossary

| Term | Definition |
|---|---|
| **Bundle** | The orchestration parent for an event (room + N services). Lazy-created. |
| **Order** | A service cart attached to a bundle. May or may not have a linked reservation. |
| **Order line item** | Individual offering on an order. Carries provenance (vendor_id, menu_item_id), pricing snapshot, recurrence flags, scheduling. |
| **Service rule** | Predicate-based rule applied to order lines for availability / approval / restriction. |
| **Coverage** | Vendor service area: which spaces this vendor serves for which service_type, with priority. |
| **Equivalence group** | (Tier 1.6) canonical mapping for items appearing in multiple vendor menus. |
| **Capacity window** | (Tier 1.5) max quantity of a service_type a vendor can fulfill in a given time window. |
| **Scorecard** | (Tier 1.3) aggregated vendor performance metrics over time. |
| **Allergen attestation** | (Tier 1.4) per-item allergen statement, sourced from vendor or admin. |
| **Vendor portal** | (Tier 1.1) vendor-facing UI for inbox, status updates, capacity. |

---

## 13. Cross-references

- [`docs/room-booking.md`](room-booking.md) — room booking + recurrence + room-side rule engine.
- [`docs/assignments-routing-fulfillment.md`](assignments-routing-fulfillment.md) — routing decisions, dispatch, SLA.
- [`docs/visibility.md`](visibility.md) — three-tier visibility model.
- [`docs/service-catalog-live.md`](service-catalog-live.md) — portal-side request type model (separate from booking services).
- [`docs/react-query-guidelines.md`](react-query-guidelines.md) — front-end data access patterns.
- [`docs/superpowers/specs/2026-04-26-linked-services-design.md`](superpowers/specs/2026-04-26-linked-services-design.md) — original design spec (locked decisions).

### Memory references (ambient context for agents)

- `feedback_hide_vendor_from_requester.md` — vendor-invisible-by-default rule.
- `project_linked_services_progress.md` — backend shipped; deferred items.
- `project_service_catalog_redesign_shipped.md` — 5-concept service catalog model.

---

**Maintenance rule:** when shipping any item from §9, update the row's status, link the commit/PR, and add a one-line note in §11 if inventory changed. When deferring an item, change status to ⬛ and add a one-sentence rationale. Don't delete shipped items — the strikethrough is the historical record.
