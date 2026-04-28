# Vendor Portal Phase B — Login, Inbox, Status Updates — Design Spec

**Date:** 2026-04-27
**Status:** Design — pending implementation
**Owner:** TBD
**Estimated effort:** 4-5 weeks
**Roadmap location:** `docs/booking-services-roadmap.md` §9.1.1 Phase B; `docs/booking-platform-roadmap.md` §F3.

**Why this spec exists:** Phase A (daglijst) ships the paper channel for vendors who don't use software. Phase B ships the digital channel for vendors who will adopt — login, order inbox, status updates, fulfillment self-service. These two together complete the multi-channel fulfillment story before vendor scorecards (F7) or KDS / mobile execution UX (Tier 2) layer on top. Phase B unblocks adoption progression: tenants can move vendors from paper to digital one at a time, no big-bang migration. Without Phase B, the desk team remains a SPOF for every vendor failure.

**Context:**
- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.1 Phase B.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §F3.
- Memory: `project_vendor_fulfillment_reality.md` — three modes (paper / portal / hybrid).
- Memory: `project_internal_team_modes.md` — internal teams need flexible auth (3 modes).
- Memory: `project_vendor_monetization.md` — free for vendors; tenant invites; no self-signup.
- Memory: `project_vendors_per_tenant.md` — per-tenant model; cross-tenant deferred with `parent_vendor_account_id` escape hatch.
- Sibling specs:
  - [Daglijst (Phase A)](2026-04-27-vendor-portal-phase-a-daglijst-design.md) — sibling fulfillment channel.
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md) — vendor user data category, data minimization.

---

## 1. Goals + non-goals

### Goals

1. **Vendors with `fulfillment_mode IN ('portal','hybrid')` can log in to a dedicated vendor portal** via magic-link emailed by tenant admin invite. No self-signup.
2. **Order inbox** showing assigned orders with filterable status; sortable by delivery time.
3. **Order detail** showing what the vendor needs to fulfill — items, quantities, delivery time, location, headcount, dietary, special instructions — with PII minimized (requester first name only, no broader meeting context).
4. **Status update flow:** received → preparing → en route → delivered. One-tap transitions; mobile-first.
5. **Decline workflow** with reason capture. Auto-cascade to a fallback vendor is **opt-in per tenant** (`tenant_settings.auto_cascade_declines`; default OFF per open-questions §VP8) — when off, declines flag for desk via `requires_phone_followup`. v1 ships manual desk handling; auto-cascade lands as a follow-up slice once a tenant enables it.
6. **Daily list download** from portal (saves the email round-trip; same PDF as Phase A).
7. **Email + webhook on order create** so vendors get notification through whichever channel they prefer.
8. **Realtime push to desk** when vendor updates status — desk sees changes instantly without refresh.
9. **Mobile-first responsive design + PWA-installable** — vendors use phones and tablets, not desktops.
10. **Internal team variant** — flexible auth supporting all three modes from memory (external vendor users, internal teams with login, internal teams without login).
11. **Audit-grade trail** of every vendor action (login, view, status update, decline).
12. **GDPR-aligned data minimization** — vendor sees only what's needed for fulfillment; no cross-vendor leakage; no broader booking context.

### Non-goals

- **Vendor self-signup** (admin invites only, per memory).
- **Vendor billing / payments** (free for vendors, tenant pays).
- **Vendor scorecards / performance dashboards** (separate spec — F7).
- **Catering KDS / kitchen-display tablet UI** (Tier 2 — see booking-services-roadmap §9.2.0).
- **Mobile field-tech UX for AV / cleaning** (Tier 2 — same).
- **Vendor self-managed capacity windows** (Tier 1.5 — separate; vendor portal can surface admin-set capacity in v1).
- **Vendor self-managed blackouts** (Tier 2; admin sets blackouts in v1).
- **POS integration** (Tier 3).
- **Cross-tenant vendor inbox** (deferred; spec doc preserves `parent_vendor_account_id` escape hatch).
- **Vendor SSO** (Tier 3).
- **Vendor scorecards visible to vendor** (Tier 2; data model exists, vendor view added later).

---

## 2. Architecture overview

### Module layout

**`VendorPortalModule`** (`apps/api/src/modules/vendor-portal/`):
- `VendorAuthService` — magic-link issuance + session management.
- `VendorOrderService` — vendor-scoped order queries + mutations (PII-minimized projections).
- `VendorNotificationService` — email + webhook on order create.
- `VendorPortalController` — REST endpoints under `/vendor/*`.
- `VendorPortalGuard` — NestJS guard validating vendor session JWT.

**Frontend sub-app** (`apps/web/src/vendor-portal/` or new package):
- Separate routing namespace `/vendor/*` — same domain, different layout.
- Mobile-first design; PWA-installable.
- Authentication flow distinct from main app.

### Two paths for vendor identity

Per `project_internal_team_modes.md`:

**Path 1 — External vendor user (`vendor_users` table):**
- Magic-link authentication.
- Separate identity pool from main `users`.
- JWT scoped to single vendor_user / vendor.

**Path 2 — Internal team member with login (existing tenant user):**
- Uses existing `users` row.
- Granted `fulfiller` role on a team via `team_members` table.
- Logs into main app; sees a "Fulfillment" surface scoped to their team.
- No separate auth; same SSO / Supabase Auth as employees.

**Path 3 — Internal team without login:**
- No auth at all.
- Status updates handled by desk operators on the team's behalf.
- Daglijst still emitted (if applicable) for paper workflow.

The vendor portal UI works for paths 1 and 2. Path 3 doesn't need the portal — desk surface handles fulfillment.

---

## 3. Data model

### `vendor_users`

Separate identity pool for external vendor users.

```sql
create table vendor_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'fulfiller'
    check (role in ('fulfiller','manager')),
  active boolean not null default true,
  invited_at timestamptz not null default now(),
  invited_by_user_id uuid references users(id),
  first_login_at timestamptz,
  last_login_at timestamptz,
  failed_login_count int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, vendor_id, email)
);

create index idx_vendor_users_email on vendor_users (tenant_id, email);
```

`role`:
- `fulfiller` — can read assigned orders + update status.
- `manager` — fulfiller + can manage other vendor_users for the same vendor (Tier 2).

### `vendor_user_sessions`

Active sessions for magic-link auth.

```sql
create table vendor_user_sessions (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid not null references vendor_users(id) on delete cascade,
  tenant_id uuid not null,
  vendor_id uuid not null,
  session_token_hash text not null,             -- pgcrypto hash; raw token stored client-side
  expires_at timestamptz not null,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (session_token_hash)
);

create index idx_vendor_sessions_active on vendor_user_sessions (vendor_user_id, expires_at) where revoked_at is null;
```

Session TTL: 30 days; refreshed on use; explicit logout revokes.

### `vendor_user_magic_links`

Issued magic links awaiting redemption. One-time-use.

```sql
create table vendor_user_magic_links (
  id uuid primary key default gen_random_uuid(),
  vendor_user_id uuid not null references vendor_users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,              -- typical 15 minutes
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_magic_links_token on vendor_user_magic_links (token_hash);
```

### `vendor_order_status_events`

Audit + analytics trail of every status transition by vendor.

```sql
create table vendor_order_status_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_line_item_id uuid not null references order_line_items(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_kind text not null check (actor_kind in
    ('vendor_user','tenant_user','system','inferred')),
  actor_vendor_user_id uuid references vendor_users(id),
  actor_tenant_user_id uuid references users(id),
  reason text,
  metadata jsonb,
  occurred_at timestamptz not null default now()
);

create index idx_voe_oli on vendor_order_status_events (order_line_item_id, occurred_at);
create index idx_voe_vendor_user on vendor_order_status_events (actor_vendor_user_id, occurred_at);
```

### Schema additions to `vendors`

```sql
alter table vendors
  add column webhook_url text,                  -- optional; tenant-set for vendors that integrate
  add column webhook_secret_encrypted text,     -- pgsodium-encrypted HMAC secret for webhook validation
  add column portal_invitation_message text,    -- tenant-customized invite copy
  add column parent_vendor_account_id uuid;     -- per project_vendors_per_tenant.md — escape hatch for cross-tenant federation
```

### Audit event types

- `vendor.invited` — admin issued magic link to a new vendor_user.
- `vendor_user.first_login` / `vendor_user.login` / `vendor_user.logout`.
- `vendor.order_acknowledged` (received).
- `vendor.order_status_updated` (preparing | en_route | delivered).
- `vendor.order_declined` — with reason.
- `vendor.order_viewed` — for read-side audit log (per GDPR baseline §7).
- `vendor.daglijst_downloaded` — vendor pulled their daglijst from portal.
- `vendor.webhook_delivered` / `vendor.webhook_failed`.

---

## 4. Authentication

### Magic-link flow

1. **Tenant admin invites vendor user** via `/admin/vendors/:id/users` page → form (email, display name, role) → backend creates `vendor_users` row + first magic link.
2. **Email sent** to vendor user containing magic link: `https://app.prequest.app/vendor/login?token=<one-time-token>`.
3. **Vendor clicks link** → frontend POSTs `/vendor/auth/redeem` with token → backend validates token (matches hash, not expired, not redeemed) → mints session JWT → sets HttpOnly secure cookie + returns 200.
4. **Vendor redirected** to `/vendor/inbox`.

### Subsequent logins

- "Sign in" page at `/vendor/login` → email input → backend issues new magic link → email sent.
- Magic link redeemed same way; new session JWT.
- Session valid 30 days; refreshed on each request.

### Session JWT structure

```json
{
  "iss": "prequest-vendor-portal",
  "aud": "vendor",
  "sub": "<vendor_user_id>",
  "tenant_id": "<tenant_id>",
  "vendor_id": "<vendor_id>",
  "role": "fulfiller",
  "iat": 1714200000,
  "exp": 1716792000
}
```

Signed with shared secret (rotated quarterly); claims validated on every request via `VendorPortalGuard`.

### Why separate from main user pool

- Vendor users should never confuse with tenant users — different role boundaries, different visibility.
- Email collisions OK (same person could be a vendor user for tenant A and a regular employee for tenant B).
- Easier to audit + sandbox.
- Aligns with `project_internal_team_modes.md` decision.

### Rate limiting + brute force protection

- Per-email rate limit on magic-link issuance: max 5/hour.
- Failed redemption increments `failed_login_count`; 5 failures → `locked_until = now() + 30 min`.
- Standard CAPTCHA on `/vendor/login` after 3 failed attempts (use existing infra if available; else Turnstile).

### MFA

- Not required for v1 (magic-link is 1-step + email-based which is itself a factor).
- Future: TOTP optional opt-in for high-trust vendor accounts.

---

## 5. Vendor-side data model — what they see

### PII minimization principle

The vendor sees only what's needed to fulfill their order. Specifically:
- **Visible:** order ID, delivery time, delivery location (room + floor + building name), headcount, items + quantities + modifiers, dietary tags / allergen flags, special instructions, requester first name only (so they can address them on arrival), desk contact for questions.
- **NOT visible:** requester full name, email, phone, attendee list, broader meeting context (subject, organizer details), other vendors working same booking, cross-tenant data, building full address details beyond what's needed for delivery navigation, cost / pricing details unless this vendor sets the prices.

### Endpoint projections

`GET /vendor/orders` — list of orders assigned to this vendor for today + future (configurable window):

```json
[
  {
    "id": "<order_id>",
    "external_ref": "<short-code>",
    "delivery_at": "2026-04-30T11:30:00+02:00",
    "delivery_location": "Boardroom 4A · 4th floor · HQ",
    "headcount": 12,
    "service_type": "catering",
    "fulfillment_status": "ordered",
    "requires_phone_followup": false,
    "lines_summary": "12× Lunch package · vegan: 3 · GF: 1"
  }
]
```

`GET /vendor/orders/:id` — order detail:

```json
{
  "id": "<order_id>",
  "external_ref": "PREQ-1234",
  "delivery_at": "2026-04-30T11:30:00+02:00",
  "delivery_location": {
    "room_name": "Boardroom 4A",
    "floor_label": "4th floor",
    "building_name": "HQ Amsterdam",
    "navigation_hint": "Reception desk on ground floor — they'll guide you up"
  },
  "headcount": 12,
  "requester_first_name": "Marleen",
  "lines": [
    {
      "id": "<line_id>",
      "name": "Lunch package — Mediterranean",
      "quantity": 12,
      "unit": "per_person",
      "modifiers": ["3× vegan", "1× gluten-free"],
      "allergen_flags": ["contains gluten", "may contain nuts"],
      "special_instructions": null
    }
  ],
  "fulfillment_status": "ordered",
  "service_window_start_at": "2026-04-30T11:30:00+02:00",
  "service_window_end_at": "2026-04-30T13:00:00+02:00",
  "desk_contact": {
    "phone": "+31-20-123-4567",
    "email": "facilities@example.com"
  },
  "policy": {
    "cancellation_cutoff_at": "2026-04-29T11:30:00+02:00"
  }
}
```

Notice what's absent: meeting subject, attendee list, cost data, organizer email, any other vendor's work for this booking.

### Cross-vendor isolation

- All vendor-scoped queries filter by `order_line_items.vendor_id = current_vendor_id`.
- Vendor cannot enumerate orders not assigned to them.
- Even within same booking_bundle, vendor only sees their own line items.
- No vendor can know which other vendors are involved.

### Daglijst access

`GET /vendor/daglijst?date=YYYY-MM-DD` returns signed URL to today's PDF (per Phase A spec). Saves the email round-trip; vendor opens portal → downloads list. Audit captures.

---

## 6. Inbox + detail UI

### Layout (mobile-first)

Phone primary (320-428px); tablet good; desktop functional.

```
┌─ Top bar ──────────────────────────────────────┐
│ Compass Catering   [Today ▾]   [Profile ▾]    │
└────────────────────────────────────────────────┘
┌─ Filters ──────────────────────────────────────┐
│ [All] [New] [In progress] [Done]    🔔 3 new  │
└────────────────────────────────────────────────┘
┌─ Order list ───────────────────────────────────┐
│                                                 │
│  11:30   Boardroom 4A · 12 people    [received]│
│  Lunch package · vegan: 3 · GF: 1              │
│  ─────────────────────────────                 │
│  12:00   Conference room 3B · 8 people [new]   │
│  Lunch + coffee + pastries                     │
│  ─────────────────────────────                 │
│  ...                                            │
└────────────────────────────────────────────────┘
```

### Filters

- **Status:** All / New / In progress / Delivered / Cancelled.
- **Time:** Today / Tomorrow / This week / Custom range.
- **Search:** by order ref or location.

### Order detail

Tap an order → full-screen detail page:

```
┌─ Detail ────────────────────────────────────────┐
│ ← Back                                          │
│                                                  │
│ PREQ-1234                                       │
│ Apr 30 · 11:30                                  │
│ Boardroom 4A · 4th floor · HQ Amsterdam        │
│ 12 people · Marleen                             │
│                                                  │
│ ─── Items ──────────────────────────────────── │
│ 12× Lunch package — Mediterranean              │
│   • 3× vegan                                    │
│   • 1× gluten-free                              │
│   • Contains gluten · May contain nuts          │
│                                                  │
│ ─── Status ───────────────────────────────────  │
│ [Mark as preparing →]                           │
│                                                  │
│ ─── Delivery ─────────────────────────────────  │
│ Service window: 11:30 — 13:00                  │
│ Reception will guide you up                     │
│                                                  │
│ ─── Questions? ────────────────────────────────│
│ 📞 +31-20-123-4567                              │
│ ✉ facilities@example.com                        │
│                                                  │
│ [Decline this order]                            │
└─────────────────────────────────────────────────┘
```

### Status transition UI

Single primary CTA showing next valid transition:
- `ordered` → "Acknowledge order" (transitions to `received`).
- `received` → "Mark as preparing".
- `preparing` → "Mark as en route".
- `en_route` → "Mark as delivered".
- `delivered` → no further action; "Mark issue with this delivery" secondary action.

Each tap immediately POSTs to `/vendor/orders/:id/status`; UI updates optimistically; rollback on server reject.

### Decline flow

Secondary action button "Decline this order" → modal → reason text + (optional) suggested time → submit:
- Backend creates `vendor_order_status_events` with `to_status = 'declined'`.
- Order routing logic (per `RoutingService`) tries fallback vendor if coverage rules support.
- If no fallback: flag `requires_phone_followup` for desk.
- Audit captures reason.
- Push notification to desk via realtime channel.

### Push notifications + sound

- New-order notification: chime + browser notification (if granted permission) + visible badge on top bar.
- Configurable per vendor user (mute hours, etc.).
- PWA-installable; supports OS-level push notifications via Web Push API.

---

## 7. Email + webhook on order create

### Email channel

Per Phase A, vendors with `fulfillment_mode IN ('paper_only','hybrid')` get daglijst emails at cutoff.

For `fulfillment_mode IN ('portal','hybrid')`, **additional** per-order email on creation:

- Subject: `New order · {service_type} · {delivery_time} · {building}`
- Body: minimal — date, time, location, headcount, "View in portal" CTA with deep link to `/vendor/orders/:id`.
- No PII beyond what the portal shows.

### Webhook channel

Vendors with structured integrations can configure `vendors.webhook_url`. When set:
- On order create: POST signed request to webhook URL with order payload.
- HMAC signature in `X-Prequest-Signature` header (vendor-side validates with `webhook_secret`).
- Retry on transient failures (3 retries with exponential backoff).
- Track delivery success in audit log.
- Vendor can use this to integrate with their own kitchen software (POS systems, etc.) — Tier 3 POS integration starts here.

Webhook payload:

```json
{
  "event": "order.created",
  "tenant_id": "<id>",
  "vendor_id": "<id>",
  "order_id": "<id>",
  "delivery_at": "ISO timestamp",
  "delivery_location": { ... },
  "lines": [ ... ],
  "headcount": 12
}
```

Update events (status changes, edits) optionally also pushed via webhook (configurable).

---

## 8. Realtime push to desk

When vendor updates status:

1. Vendor portal POSTs `/vendor/orders/:id/status` → backend validates + updates `order_line_items.fulfillment_status` + writes audit event.
2. Postgres LISTEN/NOTIFY triggers Supabase Realtime broadcast on channel `desk_orders:tenant_<id>`.
3. `/desk/bookings` + `/desk` home views subscribe to that channel and update in real-time.
4. Desk operator sees status change instantly without refreshing.

Same channel handles vendor decline events (with stronger visual treatment — red badge, alert tone).

---

## 9. Internal team variant

Per `project_internal_team_modes.md`:

### Path 2 — internal team with login (uses existing `users`)

- Internal catering / AV team gets a `users` row + `team_members` row with role `fulfiller`.
- They log in to main app at standard `/login`.
- Land on a "Fulfillment" surface (new) scoped to their team's incoming orders.
- Surface mirrors vendor portal layout — same components, different data source (filtered by `fulfillment_team_id` instead of `vendor_id`).

### Where this surface lives

- Path: `/desk/fulfillment` (new) — separate from `/desk/bookings` which is operator-oriented.
- Scoped to user's `team_members` record(s).
- Same status transitions, same UI components as vendor portal.
- KDS / mobile execution UX (Tier 2) becomes a richer alternative for catering teams later.

### Why same components

- Single component library for inbox + detail UI works for both external vendor users and internal team users.
- Code reuse; consistent UX.
- Difference is the data filter + auth pool.

### Path 3 — internal team without login

Per memory: status updates handled by desk operators on the team's behalf. Daglijst still emitted (if applicable). No portal surface needed for them.

---

## 10. Admin UI

### `/admin/vendors/:id/users` (new tab)

Table of `vendor_users` for this vendor:
- Display name, email, role, last login, status (active / locked / never logged in).
- Per-row actions: re-send invite, disable, edit role, delete.
- "Add vendor user" button opens dialog with email + display name + role.

When admin adds a user:
- Creates `vendor_users` row.
- Issues magic-link via email (15 min TTL).
- Admin can re-send invite if vendor doesn't redeem in time.

### `/admin/vendors/:id` — Fulfillment tab additions

Per Phase A: mode selector (portal / paper_only / hybrid) + daglijst email + cutoff config.

For Phase B, add:
- **Webhook configuration** — URL input + secret rotation.
- **Portal access** — link to `/admin/vendors/:id/users`.
- **Test access** — admin can simulate "view as vendor user" to verify what the vendor sees (Tier 2; useful debugging tool).

---

## 11. Frontend build

### Sub-app structure

`/vendor/*` is a separate routing namespace within the same web app. Layout differs from main app:
- No tenant admin nav.
- Vendor-scoped header (vendor name + logout).
- Mobile-first design.
- Restricted color palette (visually distinct from admin to avoid confusion).

### Components

Reuse where possible:
- `EntityPicker` — not needed in vendor portal (read-only mostly).
- `Field` primitives — reused for forms.
- `SettingsPageShell` — reused.
- New components: `VendorOrderCard`, `VendorStatusButton`, `VendorOrderTimeline`, `VendorDeclineDialog`.

### Routing

- `/vendor/login` — sign-in form (email input → magic-link issuance).
- `/vendor/login/redeem?token=<token>` — redemption endpoint.
- `/vendor/inbox` — order list (default landing).
- `/vendor/orders/:id` — order detail.
- `/vendor/daglijst` — daglijst download view (if vendor in hybrid mode).
- `/vendor/profile` — vendor user settings (notification prefs).
- `/vendor/help` — basic FAQ + contact tenant desk.

### PWA

- `manifest.json` per-tenant brandable.
- Service worker for offline read-only of today's queue.
- Add-to-home-screen prompt after first visit.
- Web Push API for new-order notifications.

### Internationalization

- Same i18n stack as Phase A.
- Languages: NL primary, FR secondary, EN baseline. `de` future.
- Per-vendor-user language preference.

### Design tokens

- Inherit existing design system (Geist font, motion tokens, color tokens).
- Distinct vendor-side accent color to differentiate from admin — but use the tenant's brand color where set.

---

## 12. Performance + scale

### Read patterns

- Order list: scoped to vendor + date range. Indexed (`order_line_items` already has indexes by vendor_id + delivery_at).
- Order detail: single record fetch + line items.
- Realtime updates: Supabase Realtime channel.

### Write patterns

- Status updates: 1 write per transition. Hot but bounded.
- Decline: 1 write + cascade routing logic (~5-50ms).

### Concurrency

- Two vendor users updating the same order simultaneously — last-write-wins per `updated_at`.
- Optimistic UI; rollback on conflict.

### Auth load

- Magic-link redemption: 1 DB read + 1 write. <50ms.
- Session validation: 1 DB read (cached in memory for 60s). <5ms.

### PWA + offline

- Today's queue cached in IndexedDB.
- Status updates queued offline; sync on reconnect.
- Banner displayed when offline.

---

## 13. Security

### Threat model

- **Vendor user account compromise.** Magic-link emails to wrong address. Mitigation: short TTL (15 min); rate-limit issuance; monitor for unusual login patterns.
- **Cross-tenant leakage.** Vendor of tenant A sees tenant B data. Mitigation: every query scopes by tenant + vendor; tested at unit + integration level; RLS enforces.
- **PII over-exposure.** Vendor sees more than needed. Mitigation: explicit PII-minimized projections in `VendorOrderService`; never return raw entity.
- **Brute-force on magic-link redemption.** Mitigation: token hashed, single-use; rate-limit per token; lock vendor user on N failures.
- **Webhook secret leak.** Mitigation: pgsodium-encrypted at rest; per-vendor secret; HMAC validation; rotate on suspicion.
- **Session token theft.** Mitigation: HttpOnly cookies; SameSite=Strict; HTTPS only; ~30 day TTL; logout revokes.

### Audit

- Every login + logout + order view + status update + decline + daglijst download captured.
- Cross-tenant audit reads gated by `tenant:audit_reads` permission (per GDPR baseline §7).

### Vendor user erasure

- When a `vendor_users` row is deleted (admin disable or vendor relationship ended):
  - Active sessions revoked.
  - Magic links invalidated.
  - Per `vendor_user_data` GDPR category, anonymize after 730 days from last login.
  - Audit log retains action history.

---

## 14. GDPR alignment

### Data category

Vendor portal data is its own GDPR category — `vendor_user_data` per GDPR baseline spec.

- Default retention: 730 days from last_login_at (or relationship end).
- Cap: 1825 days (5 years for contractual obligations).
- Legal basis: contract.
- LIA template: "we retain vendor user accounts for the duration of the vendor relationship + N years for audit and dispute resolution."

### Cross-cutting protections

- Vendor portal accesses to person data (requester first name) are logged in `personal_data_access_logs` per GDPR baseline §7.
- Anonymization cascades: when a tenant person is anonymized, vendors stop seeing their first name in past orders (revert to "Customer").
- Vendor cannot export bulk data — per-order detail only.

### Sub-processor

Microsoft (Bot Framework / Teams) and email provider already on disclosure page; no new sub-processors for vendor portal.

---

## 15. Phased delivery

### Sprint 1 (1 wk): Auth + invite

- `vendor_users`, `vendor_user_sessions`, `vendor_user_magic_links` migrations.
- `VendorAuthService` + magic-link issuance + redemption + JWT minting.
- `/admin/vendors/:id/users` page + invite dialog.
- Email infrastructure for magic-link delivery.
- Audit events.

### Sprint 2 (1 wk): Inbox + detail UI

- `/vendor/inbox` page with status filters + sorting.
- `/vendor/orders/:id` page with full detail.
- Mobile-first responsive design.
- `VendorOrderService` with PII-minimized projections.

### Sprint 3 (1 wk): Status updates + decline + realtime

- Status transition flow with one-tap UI.
- Decline workflow with reason capture. **v1 default = manual desk handling** (sets requires_phone_followup; flags for desk). Auto-cascade to fallback vendor is the opt-in path per tenant (`auto_cascade_declines` setting; default OFF per open-questions §VP8); ships as a follow-up slice once first tenant opts in.
- Supabase Realtime push to desk.
- `vendor_order_status_events` audit.

### Sprint 4 (1 wk): Email + webhook + PWA

- Per-order email channel for portal/hybrid vendors.
- Webhook channel with HMAC signing.
- PWA configuration (manifest + service worker).
- Push notifications via Web Push API.
- i18n: NL + FR + EN strings.

### Sprint 5 (~3 days): Internal team variant + polish

- Internal team /desk/fulfillment surface using same components.
- Path 2 auth alignment (existing user, fulfiller role).
- Daglijst download from portal.
- Accessibility audit + final UX pass.

**Total: ~4-5 weeks** (compressible to ~3 with two engineers parallel).

---

## 16. Acceptance criteria

1. **Tenant admin invites a new external vendor user** → vendor receives email with magic link → clicks link → lands on `/vendor/inbox` → sees today's orders for their vendor.
2. **Vendor user opens an order** → sees delivery time, location, headcount, items, dietary, requester first name only, desk contact.
3. **Vendor cannot see** other vendors' orders, requester full PII, meeting subject / attendees, cost data unless their own pricing.
4. **Vendor taps "Mark as preparing"** → status transitions → `vendor_order_status_events` row created → Supabase Realtime push → desk operator sees status change without refresh.
5. **Vendor declines an order with reason** → routing logic finds fallback vendor (if coverage supports) → audit captures full chain.
6. **Vendor receives email on order create** with deep link to portal.
7. **Vendor with `webhook_url` set** receives signed webhook on order create; HMAC validates.
8. **Vendor accesses daglijst PDF from portal** → signed URL → audit captures download.
9. **Vendor portal works on phone (320-428px width)** with single-handed reachability for status buttons.
10. **PWA installable**; status updates queue offline; sync on reconnect.
11. **Internal team member with login** lands on `/desk/fulfillment` and sees orders scoped to their team — same UX as external vendor.
12. **Cross-tenant isolation tested**: vendor of tenant A cannot enumerate orders for tenant B.
13. **Vendor session expires after 30 days** without use; magic-link re-auth required.
14. **Failed magic-link redemption** triggers rate-limit; admin alerted on suspicious patterns.

---

## 17. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Magic-link sent to wrong email (admin typo) | Medium | High | Email confirmation step before sending; admin can resend; vendor's email visible in invite UI |
| Vendor confused by separate-from-main-app login flow | Medium | Medium | Clear branding ("Vendor portal" header); deep links from email always land on right surface |
| Cross-tenant data leak via shared component code | Low | Critical | Strict scoping per VendorOrderService; integration tests; RLS enforcement |
| Status transitions create race conditions with desk overrides | Medium | Medium | Last-write-wins on `updated_at`; UI shows "Updated by [actor] at [time]"; audit captures both |
| Webhook secret leaks via misconfigured infra | Low | High | Pgsodium encryption at rest; per-vendor secret; rotate on suspicion; monitor for failed signatures |
| Vendor decline with no fallback floods desk | Medium | Medium | Coverage cascade tries alternatives; if exhausted, flag for desk; surface in real-time on /desk |
| Email delivery to vendor's daglijst_email bounces | Medium | Medium | Bounce tracking (per Phase A); admin alerted; in-portal fallback always available |
| Vendor user opens 100 sessions | Low | Low | Single-session-per-user enforced via session token revocation on new login (configurable) |
| Realtime channel high-volume floods clients | Low | Medium | Per-tenant channel scoping; batch updates if needed |
| PWA service worker bug breaks offline flow | Medium | Medium | Versioned service worker; graceful fallback to network-only on bug detection |
| Vendor IT blocks notifications / cookies | Low | Low | Email + webhook fallbacks; vendor portal works without cookies (token-in-URL fallback for stateless) |

---

## 18. Open questions

1. **Should vendor user roles include "manager" who can manage other vendor_users for their vendor?** Recommend yes but defer to Tier 2; v1 ships fulfiller-only role.
2. **Should email-on-order-create fire for paper-only vendors as well?** Recommend no — daglijst is their channel; per-order email would be noise.
3. **Vendor portal URL — same domain as main app (`/vendor/*`) or subdomain (`vendor.app.prequest.app`)?** Recommend same domain; reduces auth complexity. Subdomain only if branding strongly differs.
4. **Should we expose vendor scorecards (F7) to the vendor itself in v1?** Recommend no — tenant-only initially. Vendor-side scorecards Tier 2.
5. **Should PWA offline mode allow status updates or only reads?** Recommend allow updates (queue + sync); Important for vendors in basements / poor signal.
6. **Should magic-link redemption on a different device than the email recipient be allowed?** Recommend yes — vendor opens email on phone, types into kitchen tablet. UX > strict device-binding.
7. **Should we show vendor a forecast of upcoming orders beyond today (e.g. next week)?** Recommend yes — helps capacity planning. Default 14-day window; vendor can extend.
8. **How does internal team without login interact with this surface?** They don't — desk surface handles it. Already documented in §9.
9. **Should declines auto-cascade or always require desk approval?** Recommend auto-cascade if coverage rules support + tenant has `auto_cascade_declines = true` (default off in v1; opt-in).

---

## 19. Out of scope

- Vendor self-signup.
- Vendor billing / payments.
- Vendor scorecards visible to vendor.
- KDS / mobile field-tech UX (Tier 2 — separate spec).
- Vendor-managed capacity windows / blackouts (touched, not depth).
- POS integration (Tier 3 — webhook channel is the foundation).
- Vendor SSO.
- Multi-language support beyond NL / FR / EN.
- Vendor-to-vendor messaging / collaboration.
- Direct invoicing.
- Cross-tenant inbox.

---

## 20. References

- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) §9.1.1 Phase B.
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §F3.
- Sibling specs:
  - [Daglijst (Phase A)](2026-04-27-vendor-portal-phase-a-daglijst-design.md).
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md).
  - [Visual rule builder](2026-04-27-visual-rule-builder-design.md) — `EntityPicker` library reuse.
  - [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) — Teams notification cross-reference.
  - [Linked services](2026-04-26-linked-services-design.md) — order_line_items + status state machine.
- Memory:
  - `project_vendor_fulfillment_reality.md` — three modes.
  - `project_internal_team_modes.md` — auth flexibility.
  - `project_vendor_monetization.md` — free for vendors; admin invites.
  - `project_vendors_per_tenant.md` — per-tenant data model.
  - `project_market_benelux.md` — language + market context.

---

**Maintenance rule:** when implementation diverges from this spec, update spec first, then code. Same convention as `docs/assignments-routing-fulfillment.md`.
