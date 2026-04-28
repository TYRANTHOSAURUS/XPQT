# Vendor Execution UX — KDS, Mobile Field Tech, Cleaning Checklist, Driver App — Design Spec

**Date:** 2026-04-27
**Status:** Design — pending implementation (Tier 2 — after Phase A daglijst + Phase B portal land)
**Owner:** TBD
**Estimated effort:** 12-16 weeks total across four execution surfaces (parallelizable per surface)
**Roadmap location:** `docs/booking-services-roadmap.md` §9.2.0; `docs/booking-platform-roadmap.md` §F11–F13.

**Why this spec exists:** vendor adoption of digital tools is the lever that closes the operational data gap (per `feedback_no_friction_for_data.md`). Tools must REPLACE existing manual workflows (paper, whiteboard, radio dispatch) with friction-REDUCING alternatives. Vendors adopt because the tools are faster + better than what they do today, not because we force them. Per-service-type execution UX is the high-value product investment that vendor portal Phase B's generic inbox cannot achieve alone. **Toast/Square KDS is the world reference for catering kitchens; Uber for Business / Routific for driver apps; ServiceChannel field-tech mobile for AV/cleaning** — we benchmark against these.

**Critical framing:** these are **opt-in tools the vendor chooses to use** because they're better than the alternatives. They are NOT extra burden on top of existing workflows. We measure success by adoption rate, not by data-coverage rate. **A vendor who chooses paper over our tools is making a valid choice — we don't punish them; we improve our tools.**

**Context:**
- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.2.0.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §F11–F13.
- Memory: `feedback_no_friction_for_data.md` — voluntary adoption only; replace, don't add.
- Memory: `feedback_hide_vendor_from_requester.md` — vendor sees their work; never sees other vendors.
- Memory: `project_industry_mix.md` — corporate HQ event-driven catering (high-volume per event spike).
- Memory: `feedback_quality_bar_comprehensive.md` — comprehensive scope.
- Sibling specs:
  - [Vendor portal Phase B](2026-04-27-vendor-portal-phase-b-design.md) — auth + inbox foundation that all execution UX builds on.
  - [Vendor scorecards](2026-04-27-vendor-scorecards-design.md) — visibility tier consumes execution UX adoption.
  - [Daglijst Phase A](2026-04-27-vendor-portal-phase-a-daglijst-design.md) — fallback channel.
  - [Competitive benchmark](../../competitive-benchmark.md) — Toast/Square/ServiceChannel patterns.

---

## 1. Goals + non-goals

### Goals

1. **Catering KDS** — tablet-mounted kitchen display matching Toast/Square gold-standard, plus our wedge: meeting context propagated to every ticket (attendee dietary, room, headcount, requester first name).
2. **AV / equipment mobile field tech UX** — phone-first delivery flow for AV technicians + equipment installers; map links, setup specs, optional photo proof, offline tolerance.
3. **Cleaning / facilities mobile checklist** — phone-first task tracker for cleaning crews; per-task timestamps; replaces paper checklists in operations.
4. **Transport / shuttle driver app** — phone-first pickup queue + ETA flow; one-tap status; live ETA shared with requester.
5. **Each surface REPLACES an existing manual workflow** (paper, whiteboard, radio, phone dispatch) — voluntary adoption, not mandatory.
6. **Common foundation** across all four: PWA-installable, offline-tolerant for reads + writes, same vendor_user auth as Phase B, same status state machine, realtime push to desk.
7. **PII minimization maintained** per Phase B — vendor sees only fulfillment context.
8. **Hidden-vendor preserved** — when status updates flow to requesters via Teams/email, requester sees component status (not vendor name).
9. **Multi-language** — NL primary, FR + EN baseline; per-vendor-user override.
10. **Adoption-first metric** — track per-vendor + per-tenant adoption rate (orders delivered via execution UX vs other channels). Drives "Rich" visibility tier in scorecards.

### Non-goals

- **Replacing vendor's own POS / kitchen software** — KDS is for ORDERS we send them, not their general kitchen workflow. They keep using Toast/Square for retail; our KDS handles enterprise catering orders specifically.
- **Forced adoption** — vendor can choose to ignore execution UX entirely and stay on Phase A daglijst or Phase B inbox. We don't penalize.
- **Hardware sales** — we provide the software; tenant or vendor procures tablets/phones.
- **Native mobile apps** — PWA only in v1 (per `project_outlook_integration.md` precedent for not duplicating Apple/Google store overhead). Native iOS/Android apps deferred to Tier 3 if PWA proves insufficient.
- **In-app messaging between vendor and desk** (Tier 2 — separate item).
- **Vendor-vendor handoff workflows** (e.g. caterer hands off to cleaning crew) — out of scope.
- **Inventory tracking for vendor's own stock** — out of scope.
- **Vendor financials / invoicing in execution UX** — separate workstream (Tier 3).

---

## 2. Architecture overview

### Shared foundation

All four execution surfaces share:

- **Auth:** vendor_user JWT from Phase B (same magic-link flow). Internal team variant uses tenant `users` row + fulfiller role.
- **Routing:** `/vendor/execution/{kds|av|cleaning|transport}` paths within existing vendor sub-app.
- **Status state machine:** existing transitions from Phase B (`received → preparing → en_route → delivered`). Per surface adds intermediate states where needed.
- **PWA + offline:** IndexedDB cache + service worker; queue writes offline; sync on reconnect.
- **Realtime:** Supabase Realtime channel `desk_orders:tenant_<id>` propagates status events to desk in <1s.
- **PII minimization:** all surfaces inherit Phase B projections (no requester full PII; no cross-vendor data).
- **i18n:** NL + FR + EN strings; per-vendor-user language preference.
- **Audit:** every action emits `vendor_order_status_events` with appropriate `actor_kind` + `event_source`.

### Per-surface specialization

Each surface has its own:
- Layout optimized for its form factor (tablet vs phone).
- Task model (orders for KDS; deliveries for AV; tasks for cleaning; pickups for transport).
- Status state machine extensions (kitchen-specific transitions; field-tech-specific photo capture).
- Performance characteristics (KDS handles 30+ simultaneous tickets; phone handles 10-20 per shift).

### Module layout

**`VendorExecutionModule`** (`apps/api/src/modules/vendor-execution/`):
- `KdsService` — kitchen-display data preparation + station routing.
- `FieldTechService` — AV / equipment delivery scheduling + photo capture.
- `CleaningService` — task list + checklist flows.
- `TransportService` — pickup queue + ETA dispatch.
- `ExecutionEventService` — common audit + realtime + scorecard signal feeding.

**Frontend routing** (`apps/web/src/vendor-portal/execution/`):
- `KdsView.tsx` — full-screen tablet display.
- `FieldTechView.tsx` — phone delivery flow.
- `CleaningView.tsx` — phone task list.
- `TransportView.tsx` — phone driver app.

---

## 3. Catering KDS

### What it replaces

Today's typical catering kitchen workflow:
- Print daglijst PDF taped to wall.
- Whiteboard with today's deliveries.
- Sticky notes for modifications.
- Mental tracking of cook times.
- Phone calls for changes from desk.

KDS replaces all of this with a single iPad-mounted display.

### Form factor

- **Primary:** 12-15" Android or iPad tablet, wall-mounted in landscape orientation in the kitchen.
- **Secondary:** any browser at any size as fallback.
- **Bluetooth bump bar** support (Logic Controls / Bematech / generic USB HID) for kitchen muscle memory.

### Top bar

```
┌─────────────────────────────────────────────────────────────────┐
│ [Compass — HQ kitchen]   Tickets · All-day · Schedule    🔔  │
│                                                          ⚡ ●  │
└─────────────────────────────────────────────────────────────────┘
```

- Vendor + kitchen identity (left).
- Three view toggles (center): **Tickets** (default) / **All-day** (item totals across all open orders) / **Schedule** (8-hour timeline).
- Connectivity indicator: green = synced, amber = queueing, red = disconnected >30s.
- Audio mute toggle.

### Tickets view (default)

3-column ticket grid (320px wide tickets at 12"); reflows on resize.

**Each ticket card:**

```
┌─ #1234 ──────── 11:30 ──── 24min ──┐  ← header band: green/yellow/red
│ Boardroom 4A · 4th floor · HQ     │
│ 12 people · Marleen                │
├────────────────────────────────────┤
│ 12× Lunch package — Mediterranean  │
│   3× vegan                         │
│   1× gluten-free                   │
│   ⚠ Contains gluten · may have nuts│
├────────────────────────────────────┤
│ Dietary alert:                     │
│ Marleen V. — celiac (1× GF)        │
├────────────────────────────────────┤
│ [Bump]  [Hold]  [Recall]            │
└────────────────────────────────────┘
```

**Header band color cycles** by time-to-deadline:
- Green: T-deadline > 30 min.
- Yellow: T-deadline 30 to 10 min.
- Red: T-deadline < 10 min OR overdue.

**Configurable per vendor** via tenant_scorecard_settings clone.

**Item modifiers** indented; allergen flags prominent (red icon + text per Square's pattern, not Toast's red caps — less alarming, equally clear).

**Per-attendee dietary alert** (Prequest's wedge):
- When a meeting has attendees flagged with persistent dietary needs, those propagate to the ticket: "Marleen V. — celiac".
- The KDS knows what attending requires — Toast/Square don't have this context because they don't model meetings.
- Quietly displayed; doesn't shout.

**Footer actions:**
- Bump (tap or bump-bar 1-9 by ticket position): clears ticket from screen, fires next station.
- Hold: temporarily moves to a "hold" slot; common for "wait until prior course is bumped".
- Recall: brings back recently-bumped ticket if mistake.

### All-day view

Critical for batch-prep kitchens — Toast's killer feature.

```
12:00 lunch wave (next 90 min)
─────────────────────────────────
🥗 Mediterranean lunch package    × 47   (3 orders)
🌯 Wraps                           × 24   (2 orders)
🥘 Soup of the day                 × 35   (3 orders)
─────────────────────────────────
Vegan needs:        × 12
Gluten-free:        × 5
Nut-free:           × 8
─────────────────────────────────
```

Aggregates item quantities across all open tickets in the next configurable horizon (default 4h). Lets the kitchen batch-prep "I need 47 Mediterranean lunches" rather than read 8 individual tickets.

### Schedule view

Horizontal timeline of next 8 hours; tickets plotted at delivery time. Density bar shows load — when 6+ tickets cluster at the same time, the kitchen sees its spike risk.

### Station routing

- Each item carries `prep_station` tag (cold prep / hot prep / bakery / packaging) — set on `catalog_items` admin side.
- Each KDS screen configurable per station: only show items routed to that station.
- Same ticket appears on multiple screens with the appropriate items each.
- Bump on one screen marks that station's items done; ticket moves to next when all stations bumped.

### Audio + alerts

- New-order chime (configurable; default soft).
- Overdue escalation (silent → chime → continuous beep over 3 thresholds).
- Mute toggle in top bar; auto-unmute after 30 min.
- Per-station volume control.

### Bump bar hardware

- Day-1 support for Logic Controls + Bematech + generic USB HID.
- Mapping: 1-9 = ticket position; 0 = hold; * = recall; # = view toggle.

### Offline behavior

- Local IndexedDB cache of next 12 hours of tickets.
- Bump events queue locally; replay on reconnect.
- "Reconnecting…" banner when offline; "Synced" green flash on reconnect.

### Data flow

```
Order created in Prequest → assigned to vendor X
   ↓
Realtime push to KDS subscribed for vendor X
   ↓
New ticket appears with audio chime
   ↓
Kitchen taps individual items as made (strikethrough)
   ↓
Bump entire ticket → status_event 'preparing' → 'en route' → 'delivered'
   (state transitions configurable; common: bump-once = delivered, three-stage version available)
   ↓
Realtime push to desk dashboard + requester (if Teams/email subscribed)
```

### Acceptance

- Tablet-mounted KDS shows new orders within 1s of order creation.
- Color-coded urgency band updates in real time.
- All-day view aggregates correctly across stations.
- Bump-bar 1-9 correctly maps to ticket positions.
- Offline-queued events replay on reconnect with no loss.
- Per-attendee dietary alerts surface where applicable.

---

## 4. AV / equipment mobile field tech UX

### What it replaces

Today's typical AV technician workflow:
- Printed list of today's setups taped to clipboard.
- Phone calls to dispatcher for changes.
- Manual photo on personal phone (often not captured at all).
- Mental tracking of which sites are done.

Mobile UX replaces all of this with a single phone app (PWA).

### Form factor

- **Primary:** phone (320-428px width). One-handed reachability for primary actions.
- **Secondary:** tablet works fine.
- **PWA-installable** with home-screen icon.
- **Offline-tolerant** for read; queue writes.

### Today's deliveries view (default)

```
┌─ AV crew · Compass ──────── ⚡ ● ──┐
│                                      │
│ 09:00  Boardroom 4A · HQ            │
│        Projector + clicker · 20 ppl │
│        🔵 Setup pending              │
│                                      │
│ 11:00  Conference 3B · HQ           │
│        Full conference setup        │
│        🟢 Setup complete             │
│                                      │
│ 14:00  Auditorium · Branch Office   │
│        Wireless mic kit             │
│        🔵 Travel time: 45 min       │
│                                      │
└──────────────────────────────────────┘
```

**Each delivery card:**
- Time + location.
- One-line equipment summary.
- Status indicator.
- Tap → detail.

### Delivery detail

```
┌─ Boardroom 4A · HQ · 09:00 ────────┐
│                                       │
│ Equipment:                            │
│   • 1× HD projector                   │
│   • 1× wireless clicker (with backup) │
│   • Cable management                   │
│                                       │
│ Setup notes:                          │
│   "20 attendees; need backup clicker" │
│                                       │
│ Map:                                  │
│   [Open in Google Maps] [Apple Maps]  │
│                                       │
│ Location detail:                       │
│   HQ Amsterdam · 4th floor             │
│   Reception will buzz you in           │
│                                       │
│ ─── Actions ───                       │
│ [Mark arrived]                        │
│ (or tap when geofence detects)        │
│                                       │
│ [📷 Capture setup photo (optional)]   │
│                                       │
│ [Mark setup complete]                 │
│                                       │
│ [Mark teardown complete]              │
└───────────────────────────────────────┘
```

**Status transitions:**
- Tap "Mark arrived" or geofence auto-detects (within 50m of building lat/lng).
- Tap "Capture setup photo" — optional, never required.
- Tap "Mark setup complete" — captures done timestamp.
- Tap "Mark teardown complete" — captures end-of-event timestamp.

**Photo proof — optional, vendor-driven:**
- Tap → camera opens → photo captured + auto-uploaded.
- Stored in tenant-isolated `field_tech_photos` bucket.
- Photo URL attached to order_line_item; visible to desk operators.
- Vendor uses voluntarily (proof of "I did this in case anyone asks"). NEVER required.

**Geofencing — opt-in per vendor user:**
- User grants location permission.
- App detects when within 50m of delivery location.
- Auto-prompts "Mark arrived" — single tap.
- Tap dismiss if not actually there.
- NEVER mandatory; never silently records location.

### Equipment-specific affordances

For **assets that get reserved** (specific projector serial, etc.):
- Show asset number.
- "Equipment status: in service" badge.
- Photo proof links to that specific asset's history.

### Map integration

- Tap "Open in Maps" → deep links to Google Maps / Apple Maps.
- Doesn't try to embed map (keep app lightweight).

### Offline

- Today's queue cached locally.
- Writes (mark arrived, mark complete, photo upload) queue to IndexedDB.
- Sync on reconnect.
- Banner when offline; "All synced" message on reconnect.

### Acceptance

- Tech opens app at 7am, sees today's 5 setups + locations + equipment lists.
- Geofence prompts arrival when at site.
- Photo capture works in poor lighting (basement, parking).
- Status updates flow to desk in <2s when online.
- Offline mode persists writes; syncs reliably on reconnect.

---

## 5. Cleaning / facilities mobile checklist

### What it replaces

Today's typical cleaning crew workflow:
- Paper checklist of today's rooms + tasks.
- Supervisor sign-off via initials on paper.
- Photo proof rare (personal phone only, often not centralized).

Mobile checklist replaces this with phone-driven task tracker.

### Form factor

- Phone primary.
- PWA-installable.
- Offline-tolerant.

### Today's task list

```
┌─ Cleaning crew · BuildingOps ────────┐
│                                       │
│ Today · 14 rooms                      │
│                                       │
│ ─── To do ───                         │
│   Boardroom 4A · 09:00 (after meeting)│
│   Conference 3B · 09:30                │
│   Reception · 10:00                   │
│                                       │
│ ─── Done ───                          │
│   Floor 2 lobby · 08:00 ✓             │
│   Boardroom 1 · 08:30 ✓               │
└───────────────────────────────────────┘
```

### Per-task detail (per room)

```
┌─ Boardroom 4A · 09:00 ─────────────┐
│                                       │
│ Task list:                            │
│   ☐ Wipe down whiteboard               │
│   ☐ Empty waste bin                   │
│   ☐ Restock water                     │
│   ☐ Vacuum carpet                     │
│                                       │
│ ─── Optional ───                      │
│   📷 Photo proof of completion         │
│                                       │
│ [Mark all complete]                   │
└───────────────────────────────────────┘
```

**Task list per room** — defined by tenant admin in catalog_items / cleaning rules.

**Per-task checkbox:**
- Tap to mark done; timestamp recorded.
- Per-task timestamps drive cleaning scorecard ("how long does Vendor X take per room?").

**Photo proof — optional:**
- Vendor's discretion to capture.
- Useful for compliance audits.
- NEVER required.

**Mark all complete** — single tap when last task done; status transition to delivered.

### Geofencing — opt-in

- Same pattern as field tech: detect arrival at building; prompt "Mark arrived"; never silent.

### Replacement, not addition

The key principle: **cleaning checklists already exist** in most enterprise FM operations. Crews fill out paper checklists today. Our mobile version REPLACES the paper checklist — not as a new mandatory burden, but as a faster digital alternative.

If a tenant doesn't currently use cleaning checklists, they don't have to start using them. Mobile checklist becomes available for tenants who already use checklists; not pushed on those who don't.

### Acceptance

- Crew opens app, sees today's room queue.
- Per-room task list completable in <30s.
- Photo proof works offline; uploads on reconnect.
- Time-per-room tracked for vendor scorecards.

---

## 6. Transport / shuttle driver app

### What it replaces

Today's typical driver workflow:
- Pickup list from dispatcher (paper or text).
- Radio dispatch for changes.
- ETA tracking via dispatcher's mental model.

Driver app replaces this with phone-driven pickup queue.

### Form factor

- Phone primary.
- PWA-installable; one-handed reachability.

### Today's pickup queue

```
┌─ Driver · Compass shuttle ──────────┐
│                                       │
│ Now → 14:00                            │
│   Marleen V. (1 pax)                   │
│   HQ → Schiphol                        │
│   ETA: 12 min                          │
│                                       │
│ Next → 14:30                           │
│   Jan B. + 2 (3 pax)                   │
│   HQ → Sheraton                        │
│                                       │
│ Later → 15:30                          │
│   2 pickups queued                     │
│                                       │
└───────────────────────────────────────┘
```

### Trip detail

```
┌─ 14:00 pickup ──────────────────────┐
│                                       │
│ Pickup: HQ Amsterdam — main entrance  │
│ Drop: Schiphol Airport — Term 1       │
│ Passenger: Marleen V. (1 pax)         │
│ Notes: "luggage 2 medium suitcases"   │
│                                       │
│ ─── Map ───                           │
│ [Open in Google Maps]                 │
│                                       │
│ ─── Status ───                        │
│ [Mark en route to pickup]             │
│ [Mark arrived at pickup]              │
│ [Mark passenger boarded]              │
│ [Mark arrived at destination]          │
│ [Mark trip complete]                   │
└───────────────────────────────────────┘
```

**Live ETA:**
- App computes ETA from current GPS to destination via Google Maps API or Mapbox.
- ETA pushed in real-time to:
  - Requester (Teams DM or email update).
  - Desk dashboard.

**Status state machine** richer than other surfaces:
- Pending → en route to pickup → arrived at pickup → passenger boarded → arrived at destination → complete.

### Acceptance

- Driver sees today's queue ordered by pickup time.
- Live ETA propagates to requester.
- Status transitions work offline.
- Map deep-link works on iOS + Android.

---

## 7. Common foundation

### PWA configuration

- `manifest.json` per-tenant brandable (logo, theme color).
- Service worker for offline-first read; queue-on-write for writes.
- Add-to-home-screen prompt after first visit.
- Web Push API for new-task / new-order notifications.

### Auth (per Phase B)

- Same `vendor_users` table.
- Same magic-link flow.
- Session JWT scoped to vendor + role.
- Internal team variant: existing tenant `users` row with `fulfiller` role on team.

### Status state machine extensions

Existing `vendor_order_status_events` extended with optional metadata:
- KDS: `prep_station`, `bumped_at_screen_id`.
- Field tech: `setup_photo_url`, `geofence_arrival_lat`, `geofence_arrival_lng` (opt-in only).
- Cleaning: per-task completion + per-task photo URL.
- Transport: `pickup_lat`, `pickup_lng`, `dropoff_arrival_at`, `passenger_boarded_at`.

### Realtime push

Supabase Realtime channel `desk_orders:tenant_<id>` already in Phase B. Execution UX events route through same channel; desk sees status updates instantly regardless of which surface produced them.

### Audit + scorecards

Each event:
- `vendor_order_status_events` row with `actor_kind = 'vendor_user'` + `event_source = 'kds'` (or `'field_tech'` / `'cleaning'` / `'transport'`).
- Scorecard's "visibility tier" promoted to **Rich** for vendors using execution UX (per scorecard spec §3.5).
- Adoption metric tracked per (vendor, surface, period) — drives migration insights.

---

## 8. Adoption strategy

### The principle

**Vendors adopt because the tools are better than what they have today.** They don't adopt because we force them. We don't have leverage to force them — they're managed outside the platform.

### Concrete adoption levers

1. **Replace, don't add.** KDS replaces whiteboard + paper. Field-tech app replaces clipboard + phone. Cleaning checklist replaces paper checklist. Driver app replaces radio dispatch. Each is faster and better.
2. **Tenant-side champion.** Tenant admin shows their preferred vendor: "We rolled this out at HQ — our caterer says it cut their setup time by 30%." Word of mouth via tenant network.
3. **Free hardware not provided** but tenant can buy a tablet for their kitchen (~€300) and offer it as a perk.
4. **Per-vendor adoption rate visible** to tenant in scorecard — "Vendor X is at Limited tier; consider migrating." Drives the conversation.
5. **Migration friction is zero from our side** — vendor uses Phase B (just inbox) → adds KDS (just adds a tablet display) → optionally adds geofence. Each step is incremental.
6. **No punishment for staying.** A vendor who chooses paper over our tools is making a valid choice. Their scorecard reflects what we can passively measure; nothing prevents them from being scored fairly.

### Adoption metrics

Track per surface:
- % of vendor's orders fulfilled via KDS / field-tech / cleaning / transport (vs other channels).
- Time to first execution-UX event after Phase B adoption.
- Per-tenant aggregate adoption.

These feed the visibility tier in scorecard.

### What success looks like

- Within 12 months of launch, X% of catering vendors on portal use KDS.
- Adoption rate is itself a leading indicator of product quality — if KDS adoption is low, the tool isn't yet better than paper.

---

## 9. Hardware considerations

### Catering KDS

- 12-15" tablet (Android / iPad) ideal.
- Wall-mounted in kitchen.
- USB / Bluetooth bump bar (optional but recommended).
- Power outlet near mount point.
- WiFi connectivity recommended; ethernet via USB-C adapter as backup.
- Hardware NOT provided by Prequest; tenant or vendor procures.

### AV / cleaning / transport mobile

- Phone (any modern smartphone).
- No additional hardware.
- Personal device acceptable; vendor-issued device preferred for security.

### Maintenance + support

- KDS: vendor responsible for tablet maintenance.
- We provide PWA + browser-only — no native app maintenance burden.
- Auto-update via PWA service worker.

---

## 10. Performance + scale

### KDS

- Each kitchen tablet subscribes to `desk_orders:tenant_<id>:vendor_<id>` realtime channel.
- New orders propagate <1s.
- All-day view recomputed client-side as tickets update; <50ms re-render.
- Bump events processed locally first, then synced.

### Mobile field tech / cleaning / transport

- Today's queue cached locally.
- Updates via realtime channel.
- Photo upload: 100KB-2MB JPEG; compressed client-side; uploaded async.
- Map deep-links to native map app (no embedded map = lower bundle size).

### Offline

- IndexedDB cache for read.
- Queue for write.
- Conflict resolution on reconnect: last-write-wins for status; merge-no-conflict for photos.

---

## 11. GDPR alignment

### Data categories (per GDPR baseline)

- `field_tech_photos` (new) — proof-of-setup images. Default retention 90 days; cap 365.
- `geofence_arrival_events` (new) — vendor-side geofence telemetry; default retention 90 days; cap 180.
- `cleaning_task_completion_events` — operational; tenant audit window.
- `transport_telemetry` — driver location during active trip; retained 30 days; never longer.

### Privacy boundaries

- Geofence is opt-in per vendor user.
- Photos hidden from requesters; visible only to admin + desk operators.
- Driver GPS during trip retained 30 days for dispatch reconstruction; aggregate only after.
- Per-task photos for cleaning are tenant-internal; never shown to building occupants.

### Erasure

- When vendor relationship ends: photos retained per `field_tech_photos` retention; auto-deleted at window expiry.
- When person is anonymized: no impact on execution UX (vendor doesn't see person identity beyond first name).

---

## 12. Phased delivery

### Phase 1 (4-5 wks): Catering KDS

- Schema additions for prep_station + bump events.
- KDS view (tablet form factor).
- Tickets + all-day + schedule views.
- Audio + bump bar + station routing.
- Offline + realtime.

### Phase 2 (3-4 wks): AV / equipment field tech

- FieldTechView for phone form factor.
- Photo capture + upload.
- Geofence-arrival opt-in.
- Map deep-links.
- Offline writes.

### Phase 3 (3-4 wks): Cleaning checklist

- CleaningView for phone form factor.
- Per-task checklist.
- Per-task photo proof (optional).
- Tenant-side admin: catalog_items per cleaning task.

### Phase 4 (2-3 wks): Transport driver app

- TransportView for phone form factor.
- Live ETA via Google Maps API.
- Driver state machine.
- Requester + desk realtime push.

**Total: ~12-16 weeks** total. Each phase parallelizable from foundation.

---

## 13. Acceptance criteria

### Catering KDS (Phase 1)

1. Tablet mounted in kitchen → vendor user logs in → KDS view loads.
2. New order arrives → ticket appears within 1s + audio chime.
3. Color-coded urgency band updates as time-to-deadline passes thresholds.
4. All-day view aggregates ALL open ticket items by item type.
5. Schedule view shows next 8 hours with density bars.
6. Bump-bar 1-9 maps to ticket positions; bump clears ticket.
7. Per-attendee dietary alert visible when applicable.
8. Offline: bump events queue; replay on reconnect with no loss.
9. PWA installable on iPad; works in airplane mode after first load.

### AV mobile (Phase 2)

10. Tech opens app → today's queue (5+ deliveries) ordered by time.
11. Geofence (opt-in) prompts arrival at <50m from building; one-tap dismiss.
12. Photo capture in poor light works.
13. Status transitions queue offline; sync on reconnect.

### Cleaning mobile (Phase 3)

14. Crew opens app → today's room queue.
15. Per-task checkboxes + per-task timestamp.
16. Photo proof optional; never blocks completion.

### Transport (Phase 4)

17. Driver sees pickup queue.
18. Live ETA propagates to requester within 5s of GPS update.
19. State machine (en route → arrived → boarded → arrived dest → complete) works offline.

---

## 14. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| KDS doesn't actually feel faster than paper | Medium | High | Iterate fast in private beta; retention metric is signal; if low, redesign |
| PWA limitations (push notifications on iOS) | Medium | Medium | Web Push API works on iOS Safari 16.4+; gracefully degrade for older devices |
| Tablet hardware breakage in kitchen environment | Medium | Low | Document recommended ruggedized tablets; not our hardware burden |
| Vendor IT blocks PWA install | Low | Low | Browser-only fallback works; install is opt-in |
| Offline writes lost on app uninstall | Low | Medium | Persist queue across sessions; document limit |
| Geofence drains phone battery | Medium | Low | Opt-in only; off by default; phone OS-level controls available |
| Bluetooth bump bar compatibility issues | Medium | Low | Document tested models; broad-but-not-exhaustive support |
| Multi-language adoption lag | Low | Low | NL ships first; FR + EN immediately after |
| Map deep-link broken on rare devices | Low | Low | Fallback to address copy-paste |
| Photo upload fails on poor connectivity | Medium | Low | Retry with exponential backoff; surface "uploading" status |
| Driver-side over-recording GPS | Medium | Medium | Recording active only during trip; auto-stop at trip complete; configurable per tenant |

---

## 15. Open questions

1. **Native app vs PWA-only — when does PWA stop being enough?** Recommend PWA-only v1; reassess if push notification limitations or App Store discovery becomes critical for adoption.
2. **Cleaning task templates — built into catalog_items or a separate "cleaning_tasks" table?** Recommend cleaning_tasks table linked to catalog_items; cleaner data model.
3. **Should KDS support multi-tenant kitchens** (one kitchen serves multiple Prequest tenants)? Per `project_vendors_per_tenant.md`, vendor data is per-tenant; defer cross-tenant kitchen view.
4. **Driver ETA — do we share ETA with all attendees or just primary requester?** Recommend primary requester only (privacy + noise reduction).
5. **KDS recovery flow — what happens when WiFi drops mid-prep?** Recommend persist last 12h locally + queue writes + sync on reconnect; documented in §11.
6. **Geofence accuracy — 50m radius reasonable?** Recommend tenant-configurable; default 50m; some buildings need 100m+.
7. **Photo retention policy** — 90 days default appropriate? Validate.
8. **Should we offer "voice notes" instead of typed comments** for field tech / cleaning? Recommend Tier 3.
9. **Bump bar mapping — fixed (1-9) or customizable?** Recommend tenant-fixed in v1; customization Tier 2.

---

## 16. Out of scope

- Native iOS/Android apps (Tier 3).
- In-app vendor↔desk messaging (separate Tier 2 feature).
- Vendor-vendor handoff flows.
- Inventory/stock management for vendor's own supplies.
- Vendor financials / invoicing in execution UX.
- POS integration (Tier 3).
- Voice-driven status updates (Tier 3).
- Hardware sales / leasing.
- Custom KDS layouts per kitchen (single template per service_type v1).
- Multi-tenant kitchen view.

---

## 17. References

- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.2.0.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §F11–F13.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — Toast/Square KDS, ServiceChannel field-tech, ezCater patterns.
- Sibling specs:
  - [Vendor portal Phase B](2026-04-27-vendor-portal-phase-b-design.md) — auth + inbox foundation.
  - [Vendor scorecards](2026-04-27-vendor-scorecards-design.md) — visibility tier consumes execution UX adoption.
  - [Daglijst Phase A](2026-04-27-vendor-portal-phase-a-daglijst-design.md) — fallback channel.
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) — photos + geofence retention.
- Memory:
  - `feedback_no_friction_for_data.md` — voluntary adoption; replace existing workflows; never force.
  - `feedback_hide_vendor_from_requester.md` — vendor-side context only.
  - `project_industry_mix.md` — corporate HQ event-driven volume.
  - `feedback_quality_bar_comprehensive.md` — comprehensive scope.

---

**Maintenance rule:** when implementation diverges from this spec, update spec first. When adding new service types (e.g. medical waste, security, gardening), extend §3-§6 patterns rather than inventing new architecture.
