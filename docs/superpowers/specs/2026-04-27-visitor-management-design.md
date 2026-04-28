# Visitor Management — Design Spec

**Date:** 2026-04-27
**Status:** Design — pending implementation; coordinates with parallel visitors backend workstream (see `project_visitors_track_split_off.md`)
**Owner:** TBD
**Estimated effort:** 8-10 weeks total across 5 phases (parallelizable per surface)
**Roadmap location:** `docs/booking-platform-roadmap.md` §E (E1–E13).

**Why this spec exists:** visitor management is one of the largest competitive parity gaps vs Envoy — the gold standard for kiosk + badge + host-notify in workplace platforms. Without first-class visitor management, customers keep Envoy alongside Prequest, fragmenting their workflow. Beyond parity, this is also where Prequest's unique wedge applies: **visitor as a bundle line item** — visitor + meeting + room + parking spot + reception briefing as one orchestrated event. No competitor models this end-to-end.

**Coordination with parallel work:** A parallel agent is scoping the visitors backend module (per memory `project_visitors_track_split_off.md`). This spec is the **complete product surface** the backend supports — it should align with parallel backend work but defines what the full subsystem looks like end-to-end. Implementation phases dovetail: backend ships first, then surfaces layer on top.

**Context:**
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §E.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — Envoy gold standard.
- Memory: `feedback_no_friction_for_data.md` — voluntary; visitor doesn't have Prequest account; minimize what we ask of them.
- Memory: `feedback_quality_bar_comprehensive.md` — comprehensive scope.
- Memory: `project_visitors_track_split_off.md` — parallel backend workstream.
- Sibling specs:
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) — visitor data category (180d default + LIA).
  - [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) — Teams DM host notifications.
  - [Daglijst Phase A](2026-04-27-vendor-portal-phase-a-daglijst-design.md) — separate channel; not visitor-related but shares delivery infra.

---

## 1. Goals + non-goals

### Goals

1. **Pre-registration flow** — host invites visitor via Prequest portal; visitor receives email with QR pass; date + time + location; map; visitor's first name visible to reception.
2. **Kiosk check-in** — iPad-mounted kiosk in lobby; visitor arrives → scans QR or types name → kiosk captures photo + signs NDA if required → prints badge → notifies host.
3. **Host notification** — when visitor arrives, host gets Teams DM (if MS Graph connected) + email + in-app notification with visitor first name + arrival time.
4. **Reception lobby panel** — single-purpose-screen UX (Envoy benchmark) showing today's expected visitors + currently on-site + recent activity; reception team's primary surface.
5. **Watchlist + denied entry** — admin-configurable watchlist; pre-registration denies invitations matching watchlist; kiosk denies check-in matching watchlist; security alerted with full audit trail.
6. **Multi-host visitor invitation** — visitor coming for meeting with 3 hosts → all hosts notified; first to acknowledge owns the visitor; all see arrival.
7. **Custom visitor types** — contractor, interview candidate, delivery person, vendor — each with its own pre-registration + kiosk flow templates (NDA required for some, ID scan for others, etc.).
8. **Visitor as bundle line item** — visitor expectation + meeting + room + parking + reception briefing as one orchestrated event. Cancellation cascades; per-line scheduling preserved.
9. **Visitor analytics** — today's expected, currently on-site, history. Dashboard for reception team + admin.
10. **GDPR-compliant retention** — tenant-configurable retention (default 180d for visit records, 90d for photos/IDs); LIA documentation; auto-anonymization per GDPR baseline.
11. **PII-minimized UX** — visitors are external people; we capture only what's needed; show only first name to reception (not full PII) by default.

### Non-goals

- **Building access control hardware integration** (door locks, turnstiles, badge readers) — Tier 3; integrate via API later.
- **Facial recognition for check-in** — Tier 3; niche; Article 9 compliance heavy lift.
- **CCTV management** — out of scope; Prequest never stores video.
- **Visitor-side mobile app** — visitors don't install software; they receive QR via email.
- **Vendor delivery management** as visitor — overlaps with vendor portal; visitor type "delivery" handles light-touch; deep delivery management is separate.
- **Cross-tenant visitor identity** (same person visits multiple tenants) — Tier 3; complex privacy questions.
- **Real-time GPS tracking of visitors** — out of scope; we capture arrival, not movement.
- **Building-wide visitor badge revocation on the fly** — handled by check-out flow; not real-time door integration.

---

## 2. Architecture overview

### Module layout

**`VisitorsModule`** (`apps/api/src/modules/visitors/`) — coordinates with parallel backend workstream:
- `VisitorService` — visitor record CRUD + lifecycle.
- `PreRegistrationService` — invite flow + QR token generation.
- `CheckInService` — kiosk arrival + badge + NDA flow.
- `WatchlistService` — admin-configurable watchlist + match detection.
- `HostNotificationService` — multi-channel notifications.
- `VisitorAnalyticsService` — aggregations for lobby panel + dashboards.

**Frontend surfaces:**
- `/admin/visitors/*` — admin management (visitor types, watchlist, retention).
- `/admin/visitors/lobby-panel` — reception lobby display.
- `/portal/visitors/invite` — host pre-registration.
- `/portal/visitors/expected` — host's expected-visitor list.
- `/visitor/:token` — public landing page for QR redemption (kiosk-side).
- `/kiosk/:building` — public kiosk surface.

### Data flow

```
Host invites visitor via /portal/visitors/invite
   ↓
Visitor record created; QR token generated
   ↓
Visitor receives email with QR + meeting details + map
   ↓
Day of: visitor arrives at building lobby
   ↓
Visitor scans QR at kiosk OR types name
   ↓
Kiosk validates: QR matches expected visit OR fuzzy-match name
   ↓
Watchlist check
   ↓
NDA / ID prompt per visitor type rules
   ↓
Photo capture
   ↓
Badge prints
   ↓
Host notified (Teams DM + email + in-app)
   ↓
Visitor goes to meeting; meeting happens; visitor leaves
   ↓
Visitor checked out (manually at kiosk OR auto at end-of-day)
   ↓
Visit record closed; retention timer starts
```

### Bundle integration

When a host books a meeting and adds a visitor as part of the booking, the visitor expectation becomes a **bundle line item** — same model as catering / AV / cleaning. Cancellation cascade applies; per-line scheduling preserved (visitor expected at 09:00 even though meeting is 09:30-11:00).

---

## 3. Data model

### `visitors`

Core visitor record. Per-tenant; not personal data of an employee.

```sql
create table visitors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  visitor_type text not null check (visitor_type in
    ('guest','contractor','interview','delivery','vendor','other')),
  -- Identity (PII)
  first_name text not null,
  last_name text,
  email text,
  phone text,
  company text,
  -- Visit details
  expected_at timestamptz not null,
  expected_until timestamptz,
  building_id uuid not null references spaces(id),
  meeting_room_id uuid references spaces(id),                  -- specific room visit happens in
  parking_spot_id uuid references spaces(id),                   -- if parking reserved as part of visit
  -- Linked entities (Prequest's wedge)
  booking_bundle_id uuid references booking_bundles(id),       -- visitor as line in a bundle
  reservation_id uuid references reservations(id),              -- direct link to room reservation
  -- Hosts (multi-host supported)
  primary_host_person_id uuid not null references persons(id),
  -- Status
  status text not null default 'expected' check (status in
    ('expected','arrived','in_meeting','checked_out','denied','no_show','cancelled')),
  invited_at timestamptz not null default now(),
  invited_by_person_id uuid not null references persons(id),
  arrived_at timestamptz,
  arrival_kiosk_id uuid,
  badge_number text,
  checked_out_at timestamptz,
  -- Compliance
  nda_signed_at timestamptz,
  nda_template_id uuid,
  id_scan_storage_path text,                                    -- pgsodium-encrypted storage path
  photo_storage_path text,
  watchlist_match_at timestamptz,
  watchlist_match_id uuid,                                      -- denial reason
  -- Anonymization
  anonymized_at timestamptz,
  -- Audit
  notes text,                                                   -- reception notes
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_visitors_today on visitors (tenant_id, building_id, expected_at) where status in ('expected','arrived','in_meeting');
create index idx_visitors_host on visitors (primary_host_person_id, expected_at);
create index idx_visitors_anonymize on visitors (expected_until) where anonymized_at is null;
```

### `visitor_hosts` (multi-host)

```sql
create table visitor_hosts (
  visitor_id uuid not null references visitors(id) on delete cascade,
  person_id uuid not null references persons(id),
  is_primary boolean not null default false,
  notified_at timestamptz,
  acknowledged_at timestamptz,                                  -- first host to ack owns the visitor
  primary key (visitor_id, person_id)
);

create index idx_vh_person on visitor_hosts (person_id, acknowledged_at);
```

### `visitor_types`

Tenant-configurable visitor type templates.

```sql
create table visitor_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  type_key text not null,                                       -- guest | contractor | interview | delivery | vendor | other | custom
  display_name text not null,
  description text,
  -- Pre-registration requirements
  requires_email boolean not null default true,
  requires_phone boolean not null default false,
  requires_company boolean not null default false,
  requires_id_scan boolean not null default false,
  requires_nda boolean not null default false,
  requires_photo boolean not null default true,
  default_nda_template_id uuid references nda_templates(id),
  -- Notification settings
  notify_security boolean not null default false,
  notify_facilities boolean not null default false,
  -- Defaults
  default_expected_until_offset_minutes int default 240,        -- visit window default 4h
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, type_key)
);
```

Tenant-seeded with sensible defaults for common types; admin can customize.

### `nda_templates`

```sql
create table nda_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  body_html text not null,
  body_pdf_storage_path text,
  language text not null default 'nl',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
```

### `watchlist_entries`

Admin-configurable watchlist for security.

```sql
create table watchlist_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  match_type text not null check (match_type in ('email','name_company','phone','custom_id')),
  match_value text not null,                                    -- normalized for matching
  reason text not null,
  initiated_by_user_id uuid not null references users(id),
  initiated_at timestamptz not null default now(),
  expires_at timestamptz,
  active boolean not null default true,
  notify_security boolean not null default true
);

create index idx_watchlist_active on watchlist_entries (tenant_id, match_type) where active = true;
```

Watchlist matches are detected at pre-registration time AND at kiosk check-in time. Either trips the deny flow.

### `visit_pre_registrations`

Public-facing tokens for visitor's QR.

```sql
create table visit_pre_registrations (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references visitors(id) on delete cascade,
  tenant_id uuid not null,
  token_hash text not null,
  qr_code_data text not null,                                   -- the actual QR payload
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (token_hash)
);
```

### `kiosks`

Per-tenant kiosk devices.

```sql
create table kiosks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  building_id uuid not null references spaces(id),
  device_name text not null,
  device_token_hash text not null,                              -- for kiosk auth (not vendor_users)
  status text not null default 'active' check (status in ('active','offline','disabled')),
  last_seen_at timestamptz,
  language text not null default 'nl',
  branding_config jsonb,                                        -- per-kiosk customization
  created_at timestamptz not null default now()
);
```

### Audit events

- `visitor.invited` / `visitor.cancelled` / `visitor.expired`.
- `visitor.arrived` / `visitor.checked_out`.
- `visitor.denied` (watchlist match).
- `visitor.nda_signed` / `visitor.id_scanned` / `visitor.photo_captured`.
- `visitor.host_notified` / `visitor.host_acknowledged`.
- `visitor.anonymized` / `visitor.hard_deleted`.
- `kiosk.online` / `kiosk.offline`.
- `watchlist.entry_added` / `watchlist.entry_removed` / `watchlist.match_detected`.

---

## 4. Pre-registration flow

### Host UX — `/portal/visitors/invite`

```
┌─ Invite a visitor ──────────────────────────┐
│                                                │
│ Visitor type:                                  │
│   ◉ Guest    ◯ Contractor   ◯ Interview      │
│   ◯ Delivery ◯ Vendor                          │
│                                                │
│ Visitor first name:    [ Marleen        ]     │
│ Visitor last name:     [ Verschuren     ]     │
│ Visitor email:         [ marleen@…      ]     │
│ Visitor company:       [ ABC Bank       ]     │
│                                                │
│ Expected at:           [ Apr 30 · 09:00 ]     │
│ Expected until:        [ Apr 30 · 13:00 ]     │
│ Building:              [ HQ Amsterdam ▼ ]     │
│ Meeting room:          [ Boardroom 4A ▼ ]     │
│ Parking spot:          [ ☐ Reserve guest spot]│
│                                                │
│ Other hosts:           [ + Add host ]         │
│                                                │
│ Notes for visitor:     [ "Welcome - the recep- │
│                          tion has your details"│
│                          ]                     │
│                                                │
│ Notes for reception:   [ "VIP — please wait    │
│                          for me at lobby"      │
│                          ]                     │
│                                                │
│ [Cancel]                  [Send invitation]   │
└────────────────────────────────────────────────┘
```

Form composition uses mandatory `<Field>` primitives per `CLAUDE.md` rule.

**On submit:**
1. Validate against watchlist (immediate match → show deny dialog with admin contact).
2. Create `visitors` row + `visit_pre_registrations` row + `visitor_hosts` rows.
3. Generate QR code (signed token + visitor_id encoded).
4. Send email to visitor with branded invitation.
5. Audit event.

### Visitor email

Subject: `You're invited to visit [Tenant Name] on [date]`

Body (HTML branded):
- Tenant logo + greeting.
- "You're invited by [host first name] to visit [building name] on [date] at [time]."
- QR code prominent (large, clear).
- Map link to building.
- Meeting details (room name; ETA from public transport; arrival instructions).
- Visitor's contact info for the day (host's first name + reception phone).
- "What to bring: ID, etc." per visitor type rules.
- "If you can't make it, reply to cancel" — opt-out path.

The QR is the primary check-in mechanism; name typing is fallback.

### Visitor lands on `/visitor/:token`

If visitor opens email on their phone before arriving:
- Renders QR on screen (offline-cached).
- Shows visit details + map.
- Shows host's first name.
- "Show this QR at the kiosk when you arrive."
- Mobile-first; no auth needed.

### Bundle integration

If host invites visitor while creating a meeting bundle (composite event), visitor invite is a **line item** in the bundle:

- `booking_bundles.id` linked.
- Cancelling the meeting cascade-cancels the visitor expectation.
- Per-line scheduling: visitor expected at 09:00 even though meeting is 09:30-11:00.

This is Prequest's wedge — Envoy doesn't model meeting + visitor + room as a unit; we do.

---

## 5. Kiosk check-in flow

### Form factor

- iPad-mounted kiosk in lobby.
- Landscape orientation.
- Tenant brandable.
- Auto-locks after 30s idle; tap to wake.

### Default screen (idle)

```
┌─ Welcome to [HQ Amsterdam] ────────────────┐
│                                              │
│       [Tenant logo + welcome text]          │
│                                              │
│ ───────────────────────────────────────     │
│                                              │
│   ◉ Visiting? Scan your invitation QR.     │
│                                              │
│         [QR scan area — camera]             │
│                                              │
│   ◯ No QR? Tap to type your name.          │
│                                              │
└──────────────────────────────────────────────┘
```

### QR scan path

1. Visitor holds phone with QR code up to kiosk camera.
2. Kiosk captures QR → resolves token → loads visitor's pre-registration.
3. Validates visitor type rules (NDA needed? ID scan needed? Photo needed?).
4. Walks through required steps in sequence.
5. Prints badge.
6. Notifies host.

### Name-typed path (fallback)

1. Visitor taps "No QR".
2. Kiosk shows search field.
3. Visitor types first few letters of first name.
4. Kiosk shows fuzzy match against today's expected visitors at this building.
5. Visitor taps their name.
6. Kiosk validates (might require host first name as confirmation for security).
7. Same flow as QR path.

### Required steps per visitor type

(per `visitor_types` row config):

**Guest (default):**
- Photo capture (required by default; helps reception identify).
- Badge print.

**Contractor:**
- Photo capture.
- ID scan (driver's license / passport).
- NDA signing on-screen.
- Badge print.

**Interview candidate:**
- Photo capture.
- Optional NDA.
- Badge print.

**Delivery:**
- Photo capture.
- Badge print (limited access).
- Notify recipient.

**Vendor:**
- Photo capture.
- ID scan optional.
- Badge print.

### NDA signing

- NDA HTML displayed on screen.
- Visitor scrolls; "I agree" button appears at bottom only after scroll.
- Touch-signature capture on screen.
- PDF generated + stored.
- Audit captured.

### Photo capture

- Front-facing camera.
- "Look at the camera" prompt.
- Auto-capture or manual tap.
- Stored in tenant-isolated bucket; encrypted.
- Used for badge + reception desk reference.

### Badge print

- Bluetooth-connected badge printer (Brother QL-820NWB or similar).
- Badge content: visitor first name + last initial + photo + host first name + day + ID number.
- Tear-off design; visitor wears clip-on badge.

### Watchlist deny path

If watchlist match detected:
- Kiosk shows: "Please wait at reception. Someone will be with you shortly."
- Audit event `visitor.denied` + alert to security team (Teams DM + email).
- No further action; reception handles.

### Acceptance

- Visitor with QR can complete check-in in <60 seconds.
- Visitor without QR can complete check-in via name-typing in <90 seconds.
- Watchlist matches deny correctly; security notified.
- All required steps per visitor type captured + audited.

---

## 6. Host notification

### Multi-channel sequencing

When visitor arrives:

1. **Teams DM** (if MS Graph + Teams installation present): adaptive card with visitor first name, photo, arrival time. CTAs: "On my way" / "Tell them to wait at reception".
2. **Email** (always sent as fallback): same content as Teams card.
3. **In-app inbox** (logged-in host's portal): notification with deep link.
4. **Mobile push** (if PWA installed): brief alert.

Multi-host scenario:
- All hosts in `visitor_hosts` notified.
- First to acknowledge owns the visitor.
- Others see "Acknowledged by [host]" status.
- Visitor can be reassigned by clicking "I'll take this visitor" from a not-yet-acknowledged host's view.

### Acknowledgment flow

Host's response:
- "On my way" → status moves to `arrived → in_meeting` once visitor + host meet (auto-detected if host scans badge or manually).
- "Tell them to wait" → status stays `arrived`; reception sees status.
- No response within 5 min → reception sees "Host not yet acknowledged" + can manually reassign.

---

## 7. Reception lobby panel

### Form factor

- Wall-mounted display in reception area; iPad or larger.
- Single-purpose; auto-refreshing.
- Reception team's primary surface during their shift.

### Today's view

```
┌─ Reception · HQ Amsterdam · Apr 30 ──────────────┐
│                                                     │
│ ─── Currently arriving ──────────────────────      │
│   09:02 · Marleen V. (ABC Bank)                   │
│           Host: Jan B. → notified ⌛               │
│   09:05 · Pieter K. (Contractor — ABC Co)         │
│           Host: Anne L. → on the way ✓             │
│                                                     │
│ ─── Expected next 30 min ────────────────────      │
│   09:30 · Sarah V. (Interview · 1 of 3 today)     │
│   09:45 · Hans P. (Vendor — ISS)                   │
│                                                     │
│ ─── On site ─────────────────────────────────      │
│   3 visitors currently in meetings                 │
│                                                     │
│ ─── Alerts ──────────────────────────────────      │
│   ⚠ Watchlist denial pending intervention          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Reception team affordances

- Click any visitor row → see full details + photo + host info.
- Manually mark check-out (when visitor leaves).
- Manually re-route to alternate host.
- Add note ("Marleen requested coffee on arrival").

### End-of-day sweep

- All `arrived` or `in_meeting` visitors auto-marked `checked_out` at end-of-day (configurable per tenant; default 18:00 NL local).
- Reception can override.
- Audit captures end-of-day sweep.

---

## 8. Watchlist + denied entry

### Admin UX — `/admin/visitors/watchlist`

```
┌─ Watchlist ────────────────────────────────────┐
│                                                  │
│ [+ Add entry]                                    │
│                                                  │
│ Active entries:                                  │
│   1. email: john.doe@suspicious.com             │
│      Reason: "Past incident"                     │
│      Added 2026-03-15 by Jane S.                 │
│      [Edit] [Disable]                            │
│                                                  │
│   2. name+company: "Mike Smith @ XYZ Corp"      │
│      Reason: "NDA dispute"                       │
│      Added 2026-04-01 by Tom W.                  │
│      [Edit] [Disable]                            │
│                                                  │
│ Inactive entries (last 90 days):  3              │
│ [View history]                                   │
│                                                  │
└──────────────────────────────────────────────────┘
```

### Match detection

- Pre-registration time: when host invites visitor, check name+company / email / phone against active watchlist. If match, host sees: "This person matches our security watchlist. Contact security@tenant.com to proceed."
- Kiosk time: when visitor checks in, same check applied. If match, deny dialog displayed and security alerted.

### Audit + privacy

- Watchlist entries are admin-only.
- Visitor never sees they were denied.
- Audit captures all match detections.
- Watchlist entries automatically expire after 365 days (configurable); admin can re-activate.

### Permissions

- `visitors:manage_watchlist` — admin permission required.
- `visitors:read_watchlist_audit` — separate permission for compliance review.

---

## 9. Visitor as bundle line item

### The wedge

Most workplace platforms model visitor management as a separate flow from room booking. Envoy is visitor-first; room booking is a satellite. Eptura's Proxyclick is similar.

**Prequest's distinction:** visitor is a **line item in a composite event bundle**. When a host books a meeting:

```
Booking bundle: "Client meeting with ABC Bank"
├─ Reservation: Boardroom 4A · 09:00-11:00
├─ Visitor: Marleen V. (ABC Bank) · expected 08:50
├─ Parking: Guest spot 12 · 08:50-11:30
├─ Catering: lunch for 12 · 12:00 delivery
└─ AV: full conference setup · 08:30 setup
```

All five are part of the same orchestrated event. Cancellation cascades; per-line scheduling preserved (visitor expected before meeting starts; AV setup before that; parking spans whole event; catering at lunch end).

### How this manifests in UX

- Bundle creation flow `/portal/booking-create` adds "Visitor" as one of the line types alongside Catering / AV / Cleaning.
- Visitor section in the bundle composer lets host invite visitor as part of meeting creation.
- Edit / cancel on the bundle cascades to visitor expectation (visitor receives cancellation email if invited).
- `/portal/me-bookings` drawer shows visitor section per booking.

### Backend coordination

The parallel visitors backend agent ships:
- `visitors` table (per §3).
- `VisitorService` core CRUD.
- `visitor_hosts` for multi-host.

This spec adds:
- `booking_bundle_id` foreign key on `visitors`.
- Cascade behavior in `BundleCascadeService.cancelBundle()`.
- Frontend composer integration for visitor line.

---

## 10. Multi-host scenarios

### Use cases

- **Three interviewers for one candidate** — all three need to know visitor arrived; first to ack escorts.
- **Co-hosted client meeting** — primary + secondary host; primary assumed unless otherwise marked.
- **Teams in different buildings** — visitor at building A, host at building B → notification routes to nearest available colleague.

### Mechanism

- `visitor_hosts` table with `is_primary` flag.
- All hosts notified in parallel on visitor arrival.
- First to set `acknowledged_at` becomes "active host" for the visit.
- Other hosts see "Acknowledged by [name]" — their notifications are dismissed.
- Reception sees current active host in lobby panel.

### Reassignment

- Active host can hand off: "I'm in another meeting; @Jan, can you take Marleen?"
- Click "Reassign" → notify alternate host.
- Audit captures handoff chain.

---

## 11. Custom visitor types

### Per-tenant configuration `/admin/visitors/types`

Admin can:
- Add/edit/disable type templates.
- Configure required steps per type (NDA, ID, photo).
- Set NDA template per type.
- Set notification routing (security for contractors; facilities for delivery; etc.).

### Built-in types (seeded per tenant)

- **Guest** — basic; photo + badge.
- **Contractor** — photo + ID + NDA.
- **Interview** — photo + optional NDA.
- **Delivery** — photo + limited badge.
- **Vendor** — photo + optional ID.
- **Other** — custom catch-all.

### Custom types

Admin creates new type → defines requirements → gets default settings.

Example: a healthcare tenant might add a "Patient family member" type with specific NDA.

---

## 12. Visitor analytics

### Reception team — daily

- Today expected: count + names.
- Currently on-site: count + names.
- No-show rate today.
- Average wait time (visitor arrival → host acknowledgment).

### Admin — operational

- Weekly / monthly visitor volume.
- By visitor type.
- By building.
- By host.
- Watchlist match rate.
- NDA signing compliance.

### `/admin/visitors/analytics`

- KPI tiles + trendlines per metric.
- Export to CSV.
- Breakdowns by visitor type.

### Reporting integration

Existing `/desk/reports/*` reports gain visitor data (when relevant).

---

## 13. GDPR baseline integration

### Data category — `visitor_records`

Per GDPR baseline §3:
- Default retention: 180 days for visit records.
- Cap: 365 days (extendable with LIA documentation).
- Legal basis: legitimate_interest (security + incident response).
- LIA template: "we retain visitor records for incident response + security audit purposes, balanced against visitor's right to privacy."

### Data category — `visitor_photos_ids`

- Default retention: 90 days.
- Cap: 180 days.
- Legal basis: legitimate_interest.
- Higher sensitivity; shorter retention.

### Anonymization

- After retention window: replace `first_name`, `last_name`, `email`, `phone`, `company` with `[Anonymous]`.
- Photo + ID scan: hard delete (no anonymization possible).
- Visit timestamp + building retained for analytics.
- Audit event preserved.

### Right of erasure

- Visitor can request erasure via privacy@tenant.com or via admin.
- Admin invokes per-person erasure flow → cascade clears their visitor records.
- Aggregate stats preserved.

### Tenant-configurable

Per `tenant_retention_settings`, admin can set retention windows + LIA text per category.

---

## 14. Hardware considerations

### Kiosk

- iPad (12.9" or 11") mounted in lobby.
- Wall mount or stand.
- Bluetooth-connected badge printer.
- Front camera for photo + QR scan.
- Connected to building WiFi.
- Hardware NOT provided by Prequest; tenant procures.

### Lobby panel display

- Larger screen (24"+ or commercial display).
- Wall-mounted in reception area.
- Auto-refreshing browser to `/admin/visitors/lobby-panel`.

### Badge printer

- Brother QL-820NWB or equivalent (Bluetooth + WiFi).
- Adhesive-backed labels; clip-on badges typical for office settings.

---

## 15. Phased delivery

### Phase 1 (2 wks): Pre-registration + email + visitor record

- Visitors module backend (coordinates with parallel agent's work).
- `/portal/visitors/invite` host UI.
- Visitor email template.
- QR generation.
- Watchlist match detection at pre-registration.
- Audit events.

### Phase 2 (2 wks): Kiosk + check-in

- `/kiosk/:building` PWA-installable kiosk surface.
- QR scan + name-type fallback.
- Photo capture.
- NDA signing.
- ID scan upload.
- Badge print integration.
- Watchlist match at kiosk.

### Phase 3 (2 wks): Host notification + multi-host

- HostNotificationService.
- Multi-channel: Teams + email + in-app.
- Multi-host invite flow.
- Acknowledgment + reassignment.
- `visitor_hosts` table + UI.

### Phase 4 (1.5 wks): Lobby panel + reception team

- `/admin/visitors/lobby-panel` single-purpose-screen UX.
- Currently arriving + expected + on-site sections.
- Manual check-out + reassign actions.
- End-of-day sweep.

### Phase 5 (1.5 wks): Bundle integration + analytics + GDPR

- `booking_bundle_id` foreign key + cascade behavior.
- Composer integration (visitor as bundle line).
- `/admin/visitors/analytics` dashboard.
- GDPR retention worker integration.
- i18n: NL + FR + EN.

**Total: 8-10 weeks** elapsed; phases parallelizable.

---

## 16. Acceptance criteria

1. **Host invites visitor** via `/portal/visitors/invite` → visitor receives branded email with QR code + map + meeting details.
2. **Visitor opens email on phone**, sees QR + meeting details + host first name.
3. **Visitor arrives at building**, scans QR at kiosk → kiosk validates → photo + (NDA + ID per type) captured → badge prints → host notified within 2 seconds.
4. **Multi-host scenario:** 3 hosts on one visitor → all notified → first to acknowledge becomes active host → others see acknowledged status.
5. **Watchlist match at pre-registration** → host sees deny dialog → audit captured.
6. **Watchlist match at kiosk** → "wait at reception" message → security notified → audit captured.
7. **Visitor as bundle line item** → cancelling booking cascades to visitor expectation cancellation → visitor receives cancellation email.
8. **Reception lobby panel** auto-refreshing display shows currently arriving + expected + on-site visitors.
9. **End-of-day sweep** auto-checks-out remaining visitors at configurable time.
10. **GDPR retention** anonymizes visit records at 180 days; deletes photos at 90 days; tenant can configure.
11. **Visitor erasure** request: cascade removes their PII from visitor records + photos.
12. **PII minimization:** lobby panel shows visitor first name + photo only; full PII visible only to admin + reception with permission.
13. **Custom visitor types** configurable per tenant; required steps applied at kiosk.
14. **i18n:** kiosk, email, panel all translated NL + FR + EN.

---

## 17. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| QR scan fails on visitor's older phone | Medium | Medium | Name-type fallback always available; fallback flow tested |
| Photo capture in poor lighting | Medium | Low | Multiple capture attempts; manual override by reception |
| Badge printer offline | Medium | High | Reception-printed paper badge fallback; alert admin |
| NDA signing on screen too cumbersome | Medium | Medium | Pre-send NDA via email; visitor signs in advance via portal |
| Watchlist false positive | Medium | High | Manual override by admin; reason capture; audit always |
| Multi-host first-to-ack creates confusion | Medium | Low | Clear status indicators; reassign action; audit |
| Visitor email goes to spam | Medium | Medium | Sender reputation management; SPF/DKIM/DMARC |
| Kiosk WiFi disconnected | Low | High | Local cache of today's expected; queue events offline |
| Bundle cascade cancels visitor unexpectedly | Low | Medium | Confirmation dialog before cascading; visitor cancellation email is honest |
| GDPR anonymization breaks audit integrity | Low | Medium | Anonymize only PII fields; preserve audit timestamps + event types |
| Multi-tenant kiosk crosses contexts | Low | Critical | Each kiosk locked to one tenant + building; auth verified at boot |
| Photo storage costs grow | Medium | Low | Aggressive retention; cap on size; compress |

---

## 18. Open questions

1. **Should visitor receive arrival confirmation email after check-in** (proof of attendance)? Recommend yes — useful for visitors needing reimbursement reports.
2. **NDA signing on visitor's own phone before arrival vs at kiosk?** Recommend offer both; pre-arrival reduces kiosk dwell time.
3. **Should we capture id scan via OCR or just store image?** Recommend store image only in v1; OCR Tier 2 (privacy + accuracy concerns).
4. **Visitor self-service check-out** at kiosk vs manual reception check-out? Recommend both; kiosk shortcut for "I'm leaving".
5. **Same person visits multiple times — recognize?** Recommend opt-in tenant setting; defaults off (privacy).
6. **Voice-driven kiosk for accessibility?** Tier 2.
7. **Visitor language detection** based on IP / browser? Recommend default to tenant primary language; visitor can switch.
8. **End-of-day sweep time configurable per building?** Yes (per tenant + per building).
9. **Should host ack happen via Teams card in-place or click-through to Prequest?** Recommend in-place ack via card action (Phase 4 of MS Graph spec parallelism).

---

## 19. Out of scope

- Building access control hardware integration (Tier 3).
- Facial recognition (Tier 3).
- CCTV management (out of scope).
- Visitor mobile app (out of scope; web-based QR only).
- Cross-tenant visitor identity (Tier 3).
- Real-time GPS visitor tracking (out of scope).
- Building-wide badge revocation (out of scope; future API integration).
- Voice-driven check-in (Tier 2).
- ID OCR (Tier 2).

---

## 20. References

- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §E (E1–E13).
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — Envoy benchmark.
- Sibling specs:
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) — visitor data category retention.
  - [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) — Teams DM channel for host notifications.
  - [Vendor portal Phase B](2026-04-27-vendor-portal-phase-b-design.md) — auth pattern reuse for kiosk authentication.
- Memory:
  - `project_visitors_track_split_off.md` — parallel backend workstream.
  - `feedback_no_friction_for_data.md` — visitors are external; don't ask them more than necessary.
  - `feedback_quality_bar_comprehensive.md` — comprehensive scope.
  - `project_market_benelux.md` — NL primary language; FR Belgian secondary.
  - `project_industry_mix.md` — corporate HQ-led visitor patterns.

---

**Maintenance rule:** when implementation diverges from this spec, update spec first. When adding new visitor types, extend `visitor_types` table + kiosk flow per pattern, never duplicate architecture.
