# Prequest — Users & Personas

This is the living source of truth for **who uses Prequest**, what they're trying to do, and what they care about. Other agents (especially `ux-user-advocate` and `/design-review`) read this before reviewing or designing anything user-facing.

> **Update discipline:** any time you learn something new about a user — a workflow, a frustration, a goal, a new sub-segment — update the relevant persona section and append a dated entry to the changelog at the bottom. Don't let this rot. A stale persona doc is worse than none.

## How to use this file

- **Designing or reviewing a flow?** Identify which personas it touches, then walk through it from each of their perspectives. Underserved personas are red flags.
- **Tradeoff calls?** Use the *Pain Points* and *Jobs to Be Done* sections to break ties. Don't optimize for the persona you happen to be implementing for today.
- **New persona?** Add a new section using the structure below. Don't merge a genuinely-different user into an existing persona to avoid the work.

Each persona uses this structure:

- **Role** — one-sentence definition
- **Goals** — what success looks like for them
- **Desires** — what they wish the tool did, even if they wouldn't ask for it
- **Pain Points** — current frustrations (in Prequest, in legacy tools, in the day job)
- **Jobs to Be Done** — concrete tasks they hire software to do
- **Key Behaviors** — observable patterns that should shape UX
- **Industry Context** — market/regulatory/cultural backdrop
- **Trends** — what's changing for this persona right now

---

## 1. Requester (Corporate Employee)

**Role.** An employee at a corporate HQ or office who needs to book a room, request catering, register a visitor, or file a workplace ticket. Not a power user — Prequest is one of dozens of tools they touch.

**Goals.**
- Get the room/catering/service they need with the fewest clicks possible.
- Not get stuck waiting on approvals that block their meeting.
- Trust that "I booked it" means "it will happen."

**Desires.**
- Book from inside Outlook without context-switching (Outlook bi-directional sync is Tier 1 for a reason).
- See real availability instantly, not "submit and wait for confirmation."
- Get reminded the day before so they don't forget catering for tomorrow's all-hands.

**Pain Points.**
- Today's Outlook bookings cause double-bookings and silently miss catering attachment.
- Approval workflows that don't tell them *why* something is pending or *who* is holding it up.
- Re-entering attendee/dietary info they already gave last time.
- Mobile experience — many requesters book from their phone, not a desk.

**Jobs to Be Done.**
- "When my team grows from 6 to 9 people next Tuesday, I want to upgrade the room without losing my catering order."
- "When I'm hosting a client visit, I want to pre-register them, get coffee delivered, and know reception was notified — in one flow."
- "When I'm running late, I want to release my room one click without opening the app."

**Key Behaviors.**
- Books from Outlook calendar, Teams chat, mobile, and the portal — in that frequency order. Cross-channel parity matters.
- Will abandon a flow that takes more than ~30 seconds for a routine booking.
- Treats restrictions ("this room needs approval") as friction unless the *why* is obvious.

**Industry Context.**
- Corporate HQs in NL/BE primarily; English-speaking but Dutch-localized UI is required for non-HQ staff.
- Hybrid work norms — booking patterns peak Tue/Wed/Thu; many requesters book on behalf of teams who aren't in office that day.
- Cost-center-aware culture: requesters often need approver names and budget codes pre-filled.

**Trends.**
- Approve-in-Teams (adaptive cards) becoming table-stakes.
- Voice/chatbot booking entry points being trialed by competitors (deskbird, Robin).
- Personalization — "your usual room", "your usual dietary preferences" — going from delight to expectation.

---

## 2. Approver (Cost Center Owner / Manager)

**Role.** A manager, department head, or finance/cost-center owner who has to greenlight catering above a threshold, restricted-room bookings, or visitor visits with security implications.

**Goals.**
- Approve or deny in seconds without opening 5 different tools.
- Have enough context to decide without chasing the requester.
- Not be the bottleneck.

**Desires.**
- One-click approve from email or Teams adaptive card.
- Auto-approve recurring patterns they've already greenlit.
- A weekly digest of what they approved with spend totals — without having to ask.

**Pain Points.**
- Notifications without context ("Approval needed: Booking #4421" with no idea what it's for).
- Discovering after the fact that something they thought they'd approved hadn't actually been processed.
- Approvals stacking up while they're on holiday — no delegation flow.

**Jobs to Be Done.**
- "When a 50-person catering request comes in for next week, I want to see who's attending, what they've spent YTD, and approve in one tap."
- "When I'm OOO, I want my deputy to handle approvals automatically."

**Key Behaviors.**
- Decides from email or mobile, not the desktop app. Approval UX has to be channel-native.
- Reads the *summary*, not the request body. Surface the decision-relevant fields.

**Industry Context.**
- EU cost-center culture is strict; spend approvals are auditable.
- Larger tenants (1000+) expect role-based approval routing (chain of N approvers).

**Trends.**
- Threshold-based auto-approval ("under €X, approve silently") increasingly expected.
- AI-summarized approval requests ("This is similar to 12 prior approved requests") emerging.

---

## 3. Facilities Admin

**Role.** The person inside the tenant who configures Prequest — sets up spaces, request types, routing, vendors, integrations. Often a one-person FM team in mid-market tenants; a small ops crew in larger ones.

**Goals.**
- Make the system reflect their org's reality without engineering help.
- Diagnose "why didn't this route correctly?" in under a minute.
- Roll out a new request type / new building / new vendor without breaking what works.

**Desires.**
- A visual rule builder for routing and approvals — JSON editors are not their tool.
- Test mode: "show me what would happen if I changed this" without affecting live tickets.
- Templates: "set up a standard catering vendor" should be 3 clicks, not 30.

**Pain Points.**
- Legacy tools (Planon, Eptura, ServiceNow) require IT/admin training to configure simple things.
- No clear view of "what's currently configured and why" — config drifts and nobody knows when.
- Vendor onboarding is a paperwork dance, not a software flow.

**Jobs to Be Done.**
- "When a new catering vendor takes over building B, I want to switch traffic with one toggle and no broken bookings."
- "When my CEO asks why room 4.12 is unavailable next Tuesday, I want to find the answer in 10 seconds."
- "When we open a new floor, I want to clone an existing floor's setup, not rebuild from scratch."

**Key Behaviors.**
- Does most of the work in batches (quarterly config audits) plus reactive fixes when something breaks.
- Will tolerate a steeper learning curve for power features *if* the daily flow is fast.
- Lives in the admin portal — admin UX matters as much as portal UX, contra most platforms.

**Industry Context.**
- Tenant sizes range from 50 employees / 1 building / 1 vendor → 5000+ / multi-site / many vendors. Default-to-simple admin UX must work at both extremes.
- Migrating from legacy is a planned, multi-month exercise — feature parity + migration tooling are first-class, not afterthoughts.

**Trends.**
- Visual rule/workflow builders (n8n, Zapier-style) becoming baseline expectation.
- Self-service config replacing "submit a ticket to your vendor" patterns.
- AI-assisted setup ("describe your vendor; I'll configure routing") on the horizon.

---

## 4. Tenant Admin / Compliance Officer

**Role.** Super-admin role inside the tenant. Owns tenant-wide settings, integrations (Outlook, Teams), data residency, GDPR retention, audit trails, breach response.

**Goals.**
- Pass an audit without scrambling.
- Configure once, get reliable behavior thereafter.
- Be confident the system is doing the right thing when no one's watching.

**Desires.**
- Read-only audit views per category (visitors, bookings, vendor data) with retention timers visible.
- One place to handle DSR (data subject requests) end-to-end.
- Per-tenant retention policies that don't require a deploy to change.

**Pain Points.**
- Compliance asks for "what data do we have on person X?" and the answer is spread across 8 modules.
- Departures: when an employee leaves, cascading their data through 12 systems is mostly manual.
- EU residency requirements that competitors handle by region but their old tool didn't.

**Jobs to Be Done.**
- "When legal asks for a RoPA update, I want to export it from one place."
- "When an employee leaves, I want their PII anonymized across visitors/bookings/tickets within policy."
- "When a breach is suspected, I want a clear audit trail and a runbook."

**Key Behaviors.**
- Touches the system rarely but expects it to be unimpeachable when they do.
- Reads compliance docs end-to-end. Misleading copy or hidden behavior is a trust killer.

**Industry Context.**
- GDPR mandatory baseline; LIA-driven retention; data residency in EU.
- Enterprise customers (banks, insurers) ask for SOC 2 / ISO 27001 / DORA-readiness.
- Some tenants under DPIA obligations for visitor management or video kiosk usage.

**Trends.**
- AI processing of personal data is a new regulatory frontier — tenants want explicit controls.
- Anonymization-first erasure (vs. hard delete) becoming the legal default.

---

## 5. Service Desk Operator

**Role.** A workplace-services team member who works the inbound queue — tickets, dispatched work orders, escalations, SLA breaches. May be the same person as Facilities Admin in small tenants; a dedicated team in large ones.

**Goals.**
- Resolve cases fast without dropping anything.
- Always know what's owned by whom and what's about to breach SLA.
- Keep requesters informed without writing the same email 40 times.

**Desires.**
- A queue view that shows *what's at risk*, not just *what's open*.
- Bulk actions for routine triage (assign 12 similar tickets to the right team in one click).
- Templates for common requester replies, with smart-fill (requester name, location, ticket number).

**Pain Points.**
- Routing decisions that disagree with operator expectation, with no trace of *why*.
- Work orders that get assigned to vendors who can't see them clearly (or get them by paper at 7 AM).
- SLA timers that don't pause for requester-blocked states.

**Jobs to Be Done.**
- "When a ticket lands at 8:55 AM and the SLA breaches at 10 AM, I want it on the right desk by 9."
- "When a requester replies, I want the right team to see the new context without a manual reroute."
- "When I'm covering for a colleague, I want to see their queue and act on it without re-permissioning."

**Key Behaviors.**
- Works the queue in long focus blocks. Latency matters; every extra second is friction × 100 tickets/day.
- Memorizes routing rules — but trusts them only until they're wrong, then loses confidence fast.

**Industry Context.**
- Operator-side competes with ServiceNow, Jira Service Management, Freshservice — power-user expectations carry over.
- Increasingly expected to handle multi-domain (workplace + IT + HR) cases from one queue.

**Trends.**
- AI triage suggestions ("similar ticket resolved by team X") becoming common.
- Visibility into vendor-side execution status moving from "open the vendor portal" to "show inline in the operator view."

---

## 6. External Vendor (Catering / AV / Cleaning / Courier)

**Role.** A third-party service provider that fulfills work orders dispatched from Prequest. Many are SMBs; many work primarily off paper (the **daglijst** / printed daily list) today.

**Goals.**
- Know what to do today, in what order, with no surprises.
- Confirm/decline new orders without admin overhead.
- Keep the relationship with the tenant healthy (not get scored badly because of system noise).

**Desires.**
- The simplest possible mobile UI — they may be a kitchen prep cook with one hand free, an AV tech in a server room, a cleaner with gloves on.
- Honest info about who the requester is, what the constraint is (allergens, time window), where to deliver.
- Push notifications they can act on from the lock screen.

**Pain Points.**
- Vendor portals that require desktop login mid-shift.
- Last-minute changes that don't reach the right person on the vendor side.
- Performance scoring that punishes them for missed SLAs caused by tenant-side delays.

**Jobs to Be Done.**
- *Catering:* "When I get to work at 6 AM, I want today's deliveries in delivery-route order with allergens and special requests already extracted."
- *AV:* "When a meeting room needs a setup change, I want a pinned notification with the room number, time, and a photo of the layout."
- *Cleaning:* "When a meeting just ended, I want the cleaning task to appear in my queue with the room state at end-of-meeting."

**Key Behaviors.**
- Many won't log in if they don't have to. Magic-link auth + PWA + offline-tolerant UI is mandatory, not nice-to-have.
- Will print the daglijst even if a portal exists — daily life rhythm is paper-first for 1+ generation of catering ops.
- Decline + reassign loop is the most-used flow when capacity flexes.

**Industry Context.**
- Vendor data is per-tenant today; cross-tenant federation deferred. Most tenants have 1 catering vendor per building, < 10 vendors total.
- EU FIC (Food Information for Consumers) compliance is non-negotiable for catering — allergens must surface.
- Many internal/in-house catering teams are one team member's "second job" — UX has to respect that.

**Trends.**
- Voice-driven status updates ("Hey, mark the 10 AM delivery done") under exploration.
- KDS (Kitchen Display Systems) adoption increasing among in-house catering — shipping a great KDS is the wedge.
- Last-mile delivery apps (Wolt, Bolt) raising the bar for what a vendor mobile UX should feel like.

---

## 7. Internal Service Team

**Role.** A team employed *by the tenant* that fulfills the same kinds of work an external vendor would — in-house catering, in-house AV, internal facilities maintenance, IT desk-side support. Treated as a vendor in routing terms but with different auth + access.

**Goals.**
- Same as external vendors, but with the integration depth of being on the tenant's identity provider (SSO).
- Be visible to the operator team in the same view as external vendors.
- Pick up KDS and modern execution UX without being forced — adoption is opt-in for them.

**Desires.**
- Three auth modes (SSO / shared device / personal device) so the same team can use Prequest in the kitchen, on a tablet at the front desk, or on their phone in transit.
- Proxy booking — a desk operator books on someone's behalf, the team owns execution.
- Easy handoff between internal team and external vendor when capacity flexes.

**Pain Points.**
- Forced into one auth mode that doesn't fit the role (e.g., requiring SSO on a shared kiosk).
- Operator views that hide internal teams behind a different filter — visibility split harms coordination.

**Jobs to Be Done.**
- "When the in-house catering team can't cover an event, I want one click to dispatch to the backup external vendor."
- "When a new employee joins the IT support team, I want them in the queue same-day, no IT ticket."

**Key Behaviors.**
- KDS is opt-in — some teams will love it, some prefer paper. Don't force.
- Heavily proxy-booked: a desk admin or executive assistant books for them, they execute. The booking flow has to surface "for whom".

**Industry Context.**
- Wedge for KDS adoption — internal teams are easier first customers than external vendors.
- Often the migration path from "no platform" to Prequest goes via internal teams first; vendors second.

**Trends.**
- Hybrid in-house/outsource models common — software has to support both side-by-side.

---

## 8. Visitor

**Role.** A non-employee arriving at a tenant's office — client, candidate, contractor, courier. Pre-registered by an employee or walks in cold. Touches Prequest only at check-in and (optionally) pre-arrival.

**Goals.**
- Get to their host without standing in line.
- Not have to download an app for a 30-minute visit.
- Feel respected — not interrogated like the building thinks they're a threat.

**Desires.**
- Pre-arrival info: where to park, which entrance, what badge, who to ask for.
- One check-in, not three (badge + sign + photo + NDA + …).
- Quick wifi credentials handed to them on arrival, not on request.

**Pain Points.**
- Kiosks with bad UX (touch-keyboards from 2010, hidden language switchers, illegible NDAs).
- Calling the host because the system didn't notify them.
- Re-registering every visit — last month's data should be retrievable if they consent.

**Jobs to Be Done.**
- "When I arrive at HQ for a 9 AM meeting, I want to be checked in within 30 seconds and the host notified."
- "When my driver picks me up, I want them to know exactly where to go."

**Key Behaviors.**
- Will not install an app for a one-time visit. Web-first; QR code-friendly.
- Reads almost nothing on a kiosk screen. Visual hierarchy must do the work.

**Industry Context.**
- Envoy is the benchmark for visitor UX in mid-market. Beating Envoy is the bar.
- Watchlist + multi-host + lobby panel + GDPR retention are baseline; visitor-as-bundle-line (linking visitor to a booking) is a Prequest differentiator.
- LIA-driven retention — typical 90 days, but tenant-configurable.

**Trends.**
- Visitor pre-registration shifting to calendar invite-driven (host invites you → visitor link in invite).
- Identity verification (passport scan / liveness) becoming an option for high-security tenants.
- Driver/courier flows splitting from "visitor" into their own UX track.

---

## 9. Receptionist (Lobby Staff)

**Role.** A reception or front-desk worker at a corporate HQ or office building. Their primary job during their shift is greeting visitors, checking them in, handing out passes/badges, notifying hosts, and managing the physical/digital flow at the lobby. May be a dedicated reception specialist, a security officer with reception duties, or a service-desk operator wearing the reception hat at smaller tenants. Often shares a single front-desk terminal across shifts.

**Goals.**
- Process every arriving visitor in the time it takes them to walk from the door to the desk.
- Never miss a notification to a host. The host's first sign that their visitor arrived should not be the visitor calling them in frustration.
- Keep accurate records — who's in the building right now, by name, with a host attached.
- Handle peak-hour rushes (9am, 1pm post-lunch, all-staff event mornings) without losing composure.

**Desires.**
- A search field that finds Marleen by first letters of her name in under a second, without needing to type her last name or company.
- A "quick add" for walk-ups that doesn't make them open a 12-field form. First name + host + go.
- One place that shows: who's expected today, who's currently here, who left without checking out.
- Permission to **backdate arrivals** when they're catching up on entries written down on a notepad during a rush. Their reality is messier than the digital model assumes.
- A printable list at 7:30am of today's expected visitors (paper checklist alongside the digital screen — they trust paper for the rush).

**Pain Points.**
- Systems that demand they type a full name + email + company before they can mark a visitor "arrived". The visitor is standing in front of them.
- Notifications to hosts that quietly fail. Reception finds out 20 minutes later when the visitor is still seated.
- Having to switch between visitor management, ticketing, and security badge systems for one arrival.
- Software that assumes reception staff have user accounts; in reality the front desk often has a shared terminal that no one personally logs into. (We're choosing real auth in v1 anyway, but we know this is a friction point.)
- Bouncing between digital screens and paper sign-in books because the digital tool doesn't survive a 8-simultaneous-arrival rush.
- Lost visitor passes that drain the pool over time with no reconciliation workflow.

**Jobs to Be Done.**
- "When 8 people arrive at the same time at 09:00, I want to mark them all arrived in the same minute it would take to greet each one verbally."
- "When a courier walks in unannounced for 'someone in marketing', I want to find the right host without making the courier wait."
- "When the reception is too busy to enter visitors live, I want to write them on paper and batch-enter at 11am with the actual arrival times preserved."
- "When a visitor leaves without returning their pass, I want it flagged for tomorrow's shift so we don't bleed passes from the pool."
- "When the host hasn't acknowledged their visitor in 5 minutes, I want to know so I can call them and reroute the visitor."
- "When I print today's list, I want a real paper layout with names, hosts, and a sign-off column — not a screenshot of the screen."

**Key Behaviors.**
- **Under bandwidth pressure, batches entries.** This is the most-important observed pattern. When the lobby is crowded, reception writes visitor names on a notepad or scratch sheet, processes them into the digital system 30-60 minutes later when the rush passes. The system MUST support backdated arrival times (`arrived_at` settable, distinct from `logged_at`) and a fast quick-add form with form-clear-on-submit batch-entry mode. Treating this as a "system failure" is wrong; it's the resilient workflow that keeps reception from collapsing during peaks.
- Will not navigate through nested menus during a rush. Reception's primary tool is a single-screen today-view with a search input that always has focus.
- Greatly prefers keyboard-driven UX (arrow keys + Enter) over mouse-driven during peaks. Multi-tap-modal flows are a no.
- Mentally tracks visitors by first name and rough arrival window — "Marleen, around 9:00, here for Jan." Search must match this fuzzy mental model.
- Often the first to spot a no-show (host says "wasn't she supposed to come?"); needs a quick "mark no-show" action.
- Treats unreturned passes seriously; the pool is finite physical inventory.
- Often handles emergencies (medical event, fire alarm, lost child); needs the system to be ignorable in those moments — no modal that demands attention while reception is on a phone call to security.

**Industry Context.**
- Benelux corporate HQs: typical staffed reception 08:00-18:00; smaller offices have unstaffed reception with kiosk only.
- Reception roles increasingly bundled with security or service-desk duties at smaller tenants.
- Receptionists are often the unsung enforcer of GDPR at the lobby (they decide what visitor info goes on the lobby panel display, what gets shared with non-host employees).
- Dutch BHV regulations make reception staff responsible for fire roll-call coordination — they need to know who's in the building when alarms go off.
- Cultural norm in NL/BE: walk-ins are common in informal corporate culture, less common in security-conscious sectors (banking, pharma, defense).

**Trends.**
- Self-service kiosks reducing routine check-in load but increasing exception handling (visitor's QR doesn't scan, walk-ups, VIPs, disabled visitors).
- Hybrid receptionist roles (reception + facilities + security + concierge) becoming common at mid-sized tenants.
- Receptionist UX research consistently shows that "speed at the desk" beats every other UX metric. A 5-second delay during a rush is a 1-minute backup.
- Increasing demand for reception-tool features that survive offline (network drop at 9am rush is unforgiving).

---

## Connected roles (not full personas)

- **Host** — the employee receiving a Visitor. Mostly experiences the product as a notification + a "your visitor arrived" moment. Important *touchpoint* but few unique JTBD beyond what's covered by *Requester*.
- **Desk Scheduler Power User** — books rooms for execs, runs logistics for events. Subset of *Requester* with *Facilities Admin* tendencies. Promote to its own persona if/when its workflows diverge.

---

## Changelog

- 2026-04-30: Initial seed. 8 personas drafted from project memory and the existing spec docs (`competitive-benchmark.md`, `booking-platform-roadmap.md`, the 9 specs under `docs/superpowers/specs/`). No web research yet — all sourced from internal knowledge. First reviews should sanity-check personas 6–7 (vendor / internal team) since those drive the largest design decisions.
- 2026-05-01: Promoted **Receptionist (Lobby Staff)** to its own full persona (was a connected-roles stub). Driven by `2026-05-01-visitor-management-v1-design.md` and the UX research finding that receptionists batch-process entries during peak rushes — a workflow pattern the design must accommodate (backdated arrivals, fast quick-add, clear-on-submit batch entry).
- 2026-05-02: Reception surface **moved into the desk shell at `/desk/visitors`**. The original v1 shipped a standalone `/reception/*` workspace; that decision didn't survive first contact with users. Receptionists at smaller tenants ARE service-desk operators wearing the reception hat (per this persona's role description), and a separate workspace fragmented the surface area without adding capability the desk shell couldn't host. Old `/reception/*` paths redirect to the equivalent `/desk/visitors?view=…` view.
