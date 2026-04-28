# Microsoft Graph Integration — Design Spec

**Date:** 2026-04-27
**Status:** Design — pending implementation
**Owner:** TBD
**Estimated effort:** 16-22 weeks total across 4 phases (Phase 1: 4-6 wks, Phase 2: 3-4 wks, Phase 3: 3-4 wks, Phase 4: 2-3 wks; Phase 5 add-in deferred to Tier 2)

**Why this spec exists:** the user's competitive benchmark and product strategy identify Microsoft 365 / Outlook as the chokepoint for corporate HQ adoption in NL/BE. Without bi-directional Outlook sync, Teams notifications, and room mailbox sync, Prequest cannot win against Eptura/Condeco/Robin. This is the most foundational Tier 1 integration — a single investment that unlocks calendar sync, conflict prevention, Teams notifications, adaptive card approvals, and the Outlook add-in path.

**Context:**
- [Booking services roadmap](../../booking-services-roadmap.md) §9.1.13 + integration mentions throughout.
- [Outlook integration project memory](../../../../.claude/projects/-Users-x-Desktop-XPQT/memory/project_outlook_integration.md).
- [Teams integration project memory](../../../../.claude/projects/-Users-x-Desktop-XPQT/memory/project_teams_integration.md).
- [Competitive benchmark](../../competitive-benchmark.md) — Eptura/Condeco's Outlook add-in is the gold standard we must match.

---

## 1. Goals + non-goals

### Goals

1. **Tenant connects MS 365 once.** A workplace admin completes a guided 5-step setup; from then on, the integration "just works" with auto-renewing webhook subscriptions, token refresh, and health monitoring.
2. **Outlook bookings flow into Prequest as reservations.** When an employee books a room mailbox in Outlook (or via Teams), Prequest creates the matching reservation, lazy-creates a bundle stub, and appends a deep link to the event description so the user can attach catering / AV / services from inside Prequest.
3. **Prequest is source of truth for room availability + service status.** Conflicts are resolved in Prequest's favor: a double-booked Outlook event is auto-declined with a clear reason; cancelling in Prequest cascades to a Tracked-Changes notification in Outlook.
4. **Recurrence sync.** Recurring Outlook meetings (RRULE) translate to recurring Prequest reservations + per-occurrence override capability.
5. **Teams notifications + adaptive cards.** Service status, approvals, and at-risk alerts route to MS Teams via adaptive cards. Approver can approve/reject inline (Phase 4).
6. **Permission strategy: app-only by default, delegated as fallback.** Tenant IT grants admin consent once; Prequest operates with org-wide application permissions. Per-user delegated permissions remain a fallback for tenants whose IT refuses app-only.
7. **Performance + reliability at scale.** Per-tenant subscription quotas respected, webhook throughput buffered, retries on transient Graph errors, observability on every API call.
8. **GDPR-aligned by design.** Calendar content (subject, body) treated as personal data, fetched on-demand rather than warehoused, dropped on person erasure.

### Non-goals (this spec)

- **Google Calendar / Workspace integration.** Per project memory, Google is not needed for current customers.
- **Slack integration.** Per project memory, MS 365 dominance in NL/BE means Slack is tail.
- **Outlook add-in (Office.js compose-pane embed).** Phase 5; deferred to Tier 2 in roadmap. Deep-link approach covers Phase 1.
- **Teams Power Automate flows** — out of scope; covered by adaptive card approvals.
- **Bookings.com / Microsoft Bookings** — different product; out of scope.
- **Cross-tenant identity for vendor accounts** — separate workstream (vendor portal v1, see roadmap §9.1.1).

---

## 2. Architecture overview

### High-level data flow

```
Outlook (user) ─┐
Teams (user) ───┼─→ Microsoft 365 ─webhook→ Prequest API
Outlook (room) ─┘                              │
                                               ├─→ Reservation logic
                                               ├─→ Bundle creation
                                               ├─→ Conflict resolution
                                               └─→ Outbox (Graph API call back to MS 365)

Prequest UI ─────────────────────────────────→ MS Graph (write-back)
                                                ├─→ Update event description (deep link)
                                                ├─→ Decline conflicting event
                                                └─→ Update event status
```

### Module boundaries

Two new NestJS modules:

**`Ms365IntegrationModule`** (`apps/api/src/modules/ms365-integration/`)
- `Ms365AuthService` — OAuth flows, token cache, tenant credential management
- `Ms365GraphClient` — wrapped MS Graph SDK with retry, rate-limit handling, telemetry
- `Ms365SubscriptionService` — webhook subscription lifecycle (create / renew / validate / revoke)
- `Ms365WebhookController` — receives Graph notifications, validates `clientState`, queues
- `Ms365WebhookProcessor` — background worker draining the queue
- `Ms365CalendarSyncService` — bi-directional sync logic, conflict resolution
- `Ms365RoomMailboxService` — discovery + mapping of room mailboxes to Prequest spaces
- `Ms365HealthService` — per-tenant health checks, error aggregation

**`TeamsBotModule`** (`apps/api/src/modules/teams-bot/`)
- `TeamsBotAdapter` — Bot Framework adapter wiring
- `TeamsAdaptiveCardBuilder` — generates adaptive cards by event type
- `TeamsNotificationService` — high-level "send notification X to person Y" interface, falls back to email when Teams unavailable
- `TeamsActionController` — receives card-action callbacks (Phase 4)

Both modules sit under the existing `IntegrationsModule` umbrella in `apps/api/src/modules/integrations/` (create if not exists).

### Why two modules

- **Separate concerns:** calendar sync and chat/bot logic have different lifecycles, different rate limits, different failure modes.
- **Shared auth credentials** but separate operational surfaces; isolating the bot doesn't mean re-implementing OAuth.
- Each module independently testable, deployable, monitorable.

---

## 3. Authentication + permissions

### Permission model: app-only (default) + delegated (fallback)

**App-only (preferred — Application permissions in Azure AD):**

One Azure AD app per tenant (or one shared multi-tenant app — see decision below). Tenant admin grants admin consent once; Prequest gets organization-wide access without per-user OAuth dance.

**Required application permissions:**
- `Calendars.ReadWrite` — read + write calendar events on user mailboxes + room mailboxes.
- `Place.Read.All` — read room/place metadata (capacity, type, location, building).
- `User.Read.All` — read directory users (resolve attendees, hosts, approvers, manager chain for approvals).
- `MailboxSettings.Read` — read mailbox settings (timezone, working hours, OOO).
- `Subscription.ReadWrite` — manage Graph webhook subscriptions.
- `Mail.Send` — send notification emails (decline reasons, approval requests) — optional, can fall back to our SMTP.
- `ChannelMessage.Send` — post messages to Teams channels (for opt-in tenant-wide notifications).
- `Chat.ReadWrite` — DM with bot (Phase 3+).
- `OnlineMeetings.ReadWrite.All` — manage Teams meetings (read URLs for embedding; not creating new meetings via Prequest).

**Delegated permissions (fallback when IT refuses app-only):**

Per-user OAuth flow. Each user grants Prequest access to their own mailbox + calendar. Required scopes mirror app-only but scoped to user's resources. Friction is significant — recommend only when admin-consent is blocked.

### Multi-tenant app vs per-tenant app — decision

**Decision: shared multi-tenant Azure AD app, with per-Prequest-tenant credential rows.**

- Single app registration in Prequest's Azure AD tenant (or a dedicated Prequest publisher tenant).
- Each Prequest customer (workplace tenant) grants admin consent to this multi-tenant app.
- Per-tenant access tokens are minted using the workplace tenant's `tenant_id` + the shared app's `client_id` + `client_secret`.

Why:
- Single Azure AD app to maintain, version, audit.
- Simpler app registration story for sales (one consent URL, branded once).
- Future Microsoft AppSource publishing path (multi-tenant apps are required).
- Per-tenant app registration would be a deal-blocker (most customers won't agree to register a third-party app inside their own AAD).

Risks:
- App secret rotation affects all tenants — mitigated by certificate-based auth (preferred) and dual-secret rolling rotation.
- Compromise of Prequest's app secret = potential org-wide impact for every connected tenant — mitigated by encrypted storage, hardware-backed KMS, monitored admin consent revocation.

### Token caching + refresh

- App-only tokens valid ~1h.
- Cache tokens in Redis (`ms365:token:{tenant_id}`) with TTL = (token_expiry - 5min).
- Background worker pre-warms tokens for active tenants 10min before expiry.
- On 401 from Graph, single retry with fresh token; subsequent failures escalate to health check.

### Encryption at rest

- Client secrets / certificates: pgsodium-encrypted in `tenant_ms365_connections.client_secret_encrypted`.
- Tokens in Redis only (not persisted to Postgres).
- Webhook `clientState` (validation secret) encrypted in `ms365_subscriptions.client_state`.

---

## 4. Database schema

All tables tenant-isolated via RLS (`current_tenant_id()` policy).

### `tenant_ms365_connections`

One row per (workplace tenant) connecting to MS 365.

```sql
create table tenant_ms365_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id) on delete cascade,
  azure_tenant_id text not null,           -- the customer's Azure AD tenant GUID
  azure_app_client_id text not null,        -- shared multi-tenant app's client_id
  consent_granted_at timestamptz,
  consent_granted_by_user_id uuid references users(id),
  app_permissions_granted text[] not null default '{}',
  delegated_fallback_enabled boolean not null default false,
  status text not null default 'pending'    -- pending | active | error | revoked | expired
    check (status in ('pending','active','error','revoked','expired')),
  last_health_check_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_ms365_conn_status on tenant_ms365_connections (tenant_id, status);
```

### `ms365_subscriptions`

Webhook subscriptions; renewed every 3 days for calendars (Graph limit ~70h max).

```sql
create table ms365_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  graph_subscription_id text not null unique,
  resource text not null,                   -- /users/{id}/events, /communications/onlineMeetings, etc.
  resource_type text not null               -- calendar_user | calendar_room | meeting | bot_install
    check (resource_type in ('calendar_user','calendar_room','meeting','bot_install')),
  resource_external_id text,
  expires_at timestamptz not null,
  client_state text not null,
  notification_url text not null,
  created_at timestamptz not null default now(),
  last_renewed_at timestamptz,
  renewal_failure_count int not null default 0,
  status text not null default 'active'
    check (status in ('active','expired','failed','revoked'))
);

create index idx_ms365_sub_renewal on ms365_subscriptions (tenant_id, expires_at) where status = 'active';
create index idx_ms365_sub_resource on ms365_subscriptions (tenant_id, resource_type, resource_external_id);
```

### `ms365_webhook_notifications`

Idempotency + audit log. Retain ~30 days then prune.

```sql
create table ms365_webhook_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  graph_subscription_id text not null,
  change_type text not null check (change_type in ('created','updated','deleted')),
  resource_path text not null,
  resource_etag text,
  payload jsonb not null,
  idempotency_key text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  retry_count int not null default 0,
  unique (tenant_id, idempotency_key)
);

create index idx_ms365_notif_unprocessed on ms365_webhook_notifications (tenant_id, received_at) where processed_at is null;
create index idx_ms365_notif_retain on ms365_webhook_notifications (received_at);
```

### `ms365_room_mailboxes`

Maps Microsoft room mailboxes to Prequest spaces.

```sql
create table ms365_room_mailboxes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  space_id uuid not null references spaces(id) on delete cascade,
  azure_mailbox_id text not null,           -- the user/place GUID in Graph
  azure_mailbox_email text not null,
  display_name text,
  capacity int,
  building text,
  floor_label text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, azure_mailbox_id),
  unique (tenant_id, space_id)              -- one room mailbox per space
);

create index idx_ms365_room_email on ms365_room_mailboxes (tenant_id, azure_mailbox_email);
```

### `ms365_teams_installations`

Bot installed once per tenant (workplace + Teams personal scope + channel scope).

```sql
create table ms365_teams_installations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id) on delete cascade,
  azure_tenant_id text not null,
  bot_app_id text not null,
  installation_status text not null default 'pending'
    check (installation_status in ('pending','active','error','revoked')),
  installed_at timestamptz,
  installed_by_user_id uuid references users(id),
  last_health_check_at timestamptz,
  service_url text,                          -- per-tenant Teams service URL (for outbound)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### Schema additions to `booking_bundles`

```sql
alter table booking_bundles
  add column calendar_organizer_email text,
  add column calendar_organizer_external boolean not null default false,
  add column calendar_subject text,
  add column calendar_attendees jsonb;        -- denormalized snapshot at sync time

-- Existing columns already in place:
-- calendar_event_id, calendar_provider, calendar_etag, calendar_last_synced_at
```

`calendar_attendees` is a denormalized snapshot stored only as long as the booking is active; cleared on bundle cancellation per GDPR retention.

### Audit events

New event types in `audit_events`:
- `ms365.connection_initiated`, `connection_active`, `connection_revoked`, `connection_error`
- `ms365.subscription_created`, `subscription_renewed`, `subscription_expired`, `subscription_revoked`
- `ms365.calendar_event_received`, `calendar_event_processed`, `calendar_event_skipped`
- `ms365.calendar_event_declined` (when we auto-decline a conflicting Outlook event)
- `ms365.room_mailbox_mapped`, `room_mailbox_unmapped`
- `teams.installed`, `teams_uninstalled`
- `teams.notification_sent`, `notification_failed`
- `teams.card_action_received`

All emitted via the existing audit outbox pattern (see roadmap §9.1.12 for outbox spec).

---

## 5. Webhook subscription lifecycle

### Subscription topology

For a connected tenant, we maintain subscriptions on:

1. **Per-room-mailbox calendar.** One subscription per room mailbox to receive event create/update/delete. Resource: `/users/{room-mailbox-id}/events`.
2. **Per-active-user mailbox calendar.** Lazy-created — only after a user appears in our system as a host/requester/approver. Resource: `/users/{user-id}/events`.
3. **Channel-wide subscription** (alternative to per-mailbox) — Graph supports `/users` resource subscription with delta queries. Investigate but the per-mailbox model gives better filtering control.

### Subscription creation

On tenant connect:
1. Discover room mailboxes via Graph `/places` endpoint.
2. Show admin a mapping UI (room mailbox → Prequest space).
3. After admin commits mapping, create a subscription per mapped room mailbox.

On user activity:
- When a Prequest user is resolved who hasn't been MS-tracked yet, create a subscription for their mailbox.
- Lazy ensures we don't subscribe to inactive users (cost + churn).

### Subscription validation challenge

When creating a subscription, Graph POSTs a validation request to `notification_url` with `?validationToken=…`. Our endpoint must respond with the token (plain text, 200 OK) within 10 seconds. Any failure = subscription not created.

```typescript
// Pseudo-code
@Post('/webhooks/ms365')
async handleWebhook(@Query('validationToken') validationToken: string, @Body() body: any) {
  if (validationToken) {
    return new Response(validationToken, { status: 200, contentType: 'text/plain' });
  }
  // Normal notification flow below
}
```

### Subscription renewal

- Calendar subscriptions expire ~70h after creation.
- Cron worker runs every 12h: select subscriptions with `expires_at < now() + 24h AND status='active'`, renew via Graph PATCH.
- On renewal failure, increment `renewal_failure_count`. After 3 failures, mark `status='failed'`, surface to admin health view.
- After expiry, attempt one re-create; if that fails, escalate.

### Subscription validation per webhook

Every webhook payload includes `clientState`. We validate it against `ms365_subscriptions.client_state`. Mismatch = drop + alert (potential replay or compromise).

---

## 6. Bi-directional sync logic

### Outlook → Prequest (incoming)

#### Event created on a room mailbox

1. Webhook received → validated → queued in `ms365_webhook_notifications`.
2. Background worker fetches event via Graph `/users/{room-id}/events/{event-id}` (Graph notifications don't include payload by default; need explicit fetch).
3. Resolve organizer + attendees via `User.Read.All`.
4. Resolve room → Prequest space via `ms365_room_mailboxes` mapping.
5. **Conflict check:** does Prequest already have a reservation for this space + time window?
   - **Yes, and `calendar_event_id` matches** → skip (already synced).
   - **Yes, but different `calendar_event_id`** → conflict! Outlook event must be auto-declined (see §6.3).
   - **No** → proceed to create.
6. Create reservation in Prequest:
   - `space_id` from mapping.
   - `start_at`, `end_at`, `timezone` from event.
   - `requester_person_id` from organizer (resolve via email → person).
   - `host_person_id` same as requester unless we can identify a different host.
   - `source = 'calendar_sync'`.
   - `calendar_event_id`, `calendar_provider='ms365'`, `calendar_etag`, `calendar_organizer_email`, `calendar_subject`, `calendar_attendees` (JSON snapshot).
7. Lazy-create bundle stub (`booking_bundles` row) so the user can attach services. No services yet.
8. Update Outlook event description with deep link (see §6.4).
9. Audit event: `ms365.calendar_event_processed`.

#### Event updated on a room mailbox

1. Resolve event → Prequest reservation via `calendar_event_id`.
2. ETag check: if `event.etag == reservation.calendar_etag`, skip (we made this update).
3. If time changed:
   - Re-validate availability (no new conflict).
   - Update reservation `start_at` / `end_at`.
   - Cascade to asset reservations + service windows in the bundle (per linked-services design).
   - If service line had `service_window` set, shift it relative to new event window unless `service_window_pinned=true`.
4. If subject / attendees changed: update `calendar_subject`, `calendar_attendees` snapshot.
5. Update `calendar_etag`, `calendar_last_synced_at`.

#### Event deleted on a room mailbox

1. Resolve → reservation.
2. Cancel reservation + cascade bundle cancellation per existing `BundleCascadeService`.
3. Audit `ms365.calendar_event_processed` with change_type=deleted.

#### Recurrence handling

Outlook events have a `seriesMasterId` for recurring instances. Prequest already supports recurrence. Translation:

- Master event → Prequest `reservation_series` (master record) + first occurrence.
- Each instance webhook → Prequest occurrence row.
- "Modified" instances (single occurrence overrides) → Prequest per-occurrence override (existing model).
- "Deleted" instance → mark occurrence skipped.
- Series-level changes → cascade to all future occurrences not pinned.

Edge case: Outlook supports rules our recurrence engine doesn't (e.g. "first Monday of every month" with custom exceptions). Translate as best-effort; flag unsupported patterns in audit log + admin health view.

### Prequest → Outlook (outgoing)

#### Reservation cancelled in Prequest

1. Trigger via `BundleCascadeService.cancelBundle` or direct reservation cancel.
2. Resolve `calendar_event_id`.
3. Graph DELETE on the event OR PATCH with status (depending on policy).
4. Update event description to "Cancelled in Prequest" + cancellation reason.
5. Update `calendar_etag` from response.

#### Service line added/removed in Prequest

1. Update the event description body to reflect current services.
2. Append summary block:
   ```
   ─────────────────────────────────
   📋 Linked services
   • Lunch (12 people, arriving 11:45)
   • AV: Projector + clicker
   View / edit: https://app.prequest.com/portal/booking/{bundleId}
   ─────────────────────────────────
   ```
3. Preserve any pre-existing user-typed body content above the separator.

#### Auto-decline conflicting Outlook event

1. Compose a polite decline email body explaining the conflict + suggesting alternatives.
2. Graph: `POST /users/{room}/events/{eventId}/decline` with `comment` body.
3. Audit `ms365.calendar_event_declined`.
4. Send organizer a follow-up email via SMTP with same content (some clients suppress decline notes).

### Conflict resolution policy

**Hard rule:** Prequest is source-of-truth for room availability + service status. Outlook is source-of-truth for: meeting subject, body content, attendee list.

**On conflict:**
- Room booking conflict → Outlook event auto-declined; Prequest reservation wins.
- Subject mismatch → Outlook value wins (it's user intent).
- Attendees mismatch → Outlook list wins (we snapshot it).

This is configurable per-tenant for edge cases, but defaults are non-negotiable for shipped product.

### 6.5 Conflict PREVENTION strategy (architectural — not just reactive)

**The UX failure mode we cannot ship with:** user books a room in Outlook → Outlook says "accepted" → 30 seconds later, Prequest detects conflict → user gets a cancellation email. From the user's perspective, this is the new system breaking their already-confirmed meeting. **This pattern enrages employees and kills adoption.** We cannot rely on reactive auto-decline as the primary UX.

**Solution: Outlook room mailbox is a real-time mirror of Prequest reservations.** This makes Outlook's own native conflict detection (room shows as busy) catch the conflict at the user's very first click — before the event is even created.

#### Architectural principle

> The room mailbox calendar in Microsoft 365 must reflect the current Prequest reservations table at all times. When a user opens Outlook and views the room's availability, they see Prequest's truth, rendered by Microsoft's own UI.

This means:
- **Every Prequest reservation immediately creates a corresponding event on the room mailbox calendar** (via Graph POST). The user sees the room as busy in Outlook the same second the Prequest reservation is created.
- **Every Outlook event on the room mailbox arriving via webhook becomes a Prequest reservation** (we already had this). When user books in Outlook, both sides are updated.
- **Outlook's native room conflict detection becomes our first line of defense.** When user attempts to book a busy room, Outlook itself shows "Room not available" before the user can even submit. No webhook. No email. No "your booking was cancelled" surprise.

#### Implementation requirements

**1. Initial state mirroring on tenant connect.**
- During the 5-step connection wizard (§8), after room mailboxes are mapped to spaces, run a one-time **calendar mirror sync**:
  - Read all events on the room mailbox for the past 30 days + future 12 months via Graph.
  - Create matching Prequest reservations for events that don't yet have one.
  - For Prequest reservations that exist but have no corresponding room mailbox event, push to room mailbox.
  - Wizard step shows progress: "Mirroring 247 of 380 events..."
  - Wizard does NOT complete until mirror is verified consistent.

**2. Synchronous writeback on every Prequest reservation create.**
- Booking flow: user clicks Submit → Prequest creates reservation row → **same transaction (or tightly-coupled side-effect)** writes a corresponding event to the room mailbox via Graph.
- Store room mailbox event ID immediately as `calendar_event_id`.
- Acceptance latency budget: <500ms for the round-trip including Graph write.
- Failure handling: if Graph write fails, retry with exponential backoff up to 3 times; if still failing, mark reservation `calendar_sync_status='pending'` and queue for retry; show user a "Booking confirmed (calendar syncing)" subtle indicator. Reservation is still valid in Prequest.

**3. Fresh availability check at confirmation time.**
- When a Prequest user is about to confirm a booking, do a **Graph fresh-read** of the room mailbox calendar for the booking time window — don't trust local cache.
- This catches the race condition where Outlook event was just created but webhook hasn't arrived yet.
- Adds ~200-500ms to confirm. Acceptable for the UX guarantee.
- Implementation: `Ms365GraphClient.getEventsInWindow(roomMailboxId, start, end)` called synchronously in booking flow.

**4. Webhook delivery lag handling.**
- Microsoft's webhook SLA is "best-effort, typically seconds, occasionally minutes."
- During lag windows, Outlook room mailbox is the source of truth (Microsoft's own state, always current).
- Our fresh-read pattern (point 3) covers the lag.
- If we receive a webhook for an event that's already in our reservations table (matched by `calendar_event_id`), we no-op. Idempotency guard.

**5. Race condition fallback (extremely rare with above mitigations).**
- If a race somehow slips through — e.g. simultaneous bookings via different paths within the same 200ms window — respond within 5 seconds, not 5 minutes:
  - Prequest detects conflict on incoming webhook.
  - Prequest sends a structured Teams DM (Phase 3+) AND email immediately:
    - "Your room booking for [time/room] couldn't be confirmed because [room] was just booked by [other organizer]."
    - "Available alternatives: [list of similar rooms at same time]."
    - "Click to rebook: [deep link]."
  - The email goes within 5 seconds of webhook receipt. Not "your meeting was cancelled an hour ago, sorry."
  - Audit `ms365.race_condition_detected`.

**6. Prequest-only reservations (created via desk operator, no Outlook flow):**
- These ALSO push to the room mailbox immediately via Graph.
- Room mailbox always reflects truth, regardless of how the reservation was created.
- Outlook users see the room as busy even for "internal" Prequest bookings.

**7. Calendar drift detection (background).**
- Nightly worker compares Prequest reservations vs room mailbox state for next 30 days.
- Any mismatch (event in one but not the other) triggers reconciliation + alert.
- Health view in `/admin/integrations/microsoft-365/health` shows drift count.

#### What this changes vs the original spec

The original spec described conflict resolution as primarily reactive (webhook → check → decline). The new spec adds:
- **Synchronous Graph writeback on Prequest creates** (was described loosely; now explicit).
- **Fresh-read availability check at confirmation time** (new).
- **Initial state mirror on connect** (was described; now blocking the wizard).
- **5-second response time guarantee for race conflicts** (new).
- **Drift detection nightly worker** (new).

These are net-positive: more predictable UX, fewer "phantom cancellation" complaints, better trust in the integration.

#### Performance impact

- ~+500ms on every Prequest booking confirm (Graph write + fresh-read).
- ~+1 Graph API call per booking (writeback on create).
- Initial wizard mirror: 1 batch read + N batch writes (where N = events to mirror). Typically <30s for a 100-room tenant with a few hundred events.
- Drift detection: O(rooms × 30 days) nightly. Trivial at our scale.

The latency cost is the price of the UX guarantee. It's worth it.

#### Acceptance (extending Phase 1)

- User cannot create a Prequest reservation that conflicts with an existing room mailbox event (validated via fresh-read).
- User booking a Prequest-confirmed room in Outlook sees Outlook's native "Room not available" before they can submit.
- Tenant-connect wizard does not complete until calendar mirror sync verifies consistency.
- For the rare race condition, alternative suggestions arrive in user's email/Teams within 5 seconds, not minutes.
- Drift detection surfaces any state inconsistency to admin within 24h.

### Deep-link UX in event description

Strategy: append a structured signature block at the bottom of the event body (HTML email format). The block contains:
- A horizontal rule.
- An emoji + label "Add catering, AV, or services to this meeting".
- A deep link to `/portal/booking/{bundleId}/services`.
- A short label "Powered by Prequest" with logo.

If user later edits the body, our diff logic preserves the signature block and only updates if services have changed. We tag the block with HTML comments (`<!-- prequest:services-block:start -->` ... `<!-- prequest:services-block:end -->`) for reliable parsing.

---

## 7. Teams notifications + adaptive cards

### Bot Framework architecture

- Single Bot Framework app (Azure Bot Service) registered with the same multi-tenant Azure AD app.
- Bot identity used for: DMs to users, channel posts, adaptive card delivery.
- Inbound: bot adapter receives messages + card actions; routes to `TeamsActionController`.
- Outbound: `TeamsNotificationService.send(personId, eventType, payload)` → composes adaptive card → posts to user's chat (proactive messaging).

### Per-tenant installation

Tenant admin installs the Prequest Teams app:
- From the Teams admin center (preferred — silent rollout to all users).
- Or from the Teams Store (per-user install).

We track installation in `ms365_teams_installations`; status checked daily.

### Notification types (Phase 3)

Each notification has a `card_template_id` + payload:

| Event | Audience | Card content |
|---|---|---|
| Bundle confirmed | Requester + host | Event details + linked services + "View in Prequest" link |
| Bundle pending approval | Approvers | Event summary + lines + Approve/Reject buttons (Phase 4) |
| Service status: en route | Requester | Live status + estimated arrival |
| Service status: delivered | Requester | Confirmation + "Rate delivery" CTA |
| Bundle at-risk (vendor unack'd T-2h) | Desk lead | Event + service + vendor + "Phone follow-up" CTA |
| Approval request | Approver | Event summary + lines + manager-approve action |

### Adaptive card structure

Use Adaptive Cards 1.5 (Teams-supported subset). Standard layout:

```json
{
  "type": "AdaptiveCard",
  "version": "1.5",
  "body": [
    { "type": "TextBlock", "text": "${title}", "weight": "bolder", "size": "large" },
    { "type": "TextBlock", "text": "${subtitle}", "isSubtle": true },
    { "type": "FactSet", "facts": [...] },
    { "type": "Container", "items": [{ "type": "TextBlock", "text": "${services_summary}" }] }
  ],
  "actions": [
    { "type": "Action.OpenUrl", "title": "View in Prequest", "url": "${deep_link}" },
    { "type": "Action.Submit", "title": "Approve", "data": { "action": "approve", "approvalId": "${id}" } }
  ]
}
```

Card-action handler validates `data.action` + permissions before mutating Prequest state.

### Phase 4: approve-from-Teams

Adaptive card action `approve` triggers:
1. POST `/teams/actions/approval` with the `data` payload + signed token.
2. Validate token (HMAC of payload + card timestamp).
3. Resolve approver person → check authorization for this approval ID.
4. Apply approval transition.
5. Refresh card inline (Teams allows in-place card replacement) showing "Approved by [name] at [time]".
6. Audit `teams.card_action_received`.

### Notification fallback chain

Order: Teams DM → email → in-app inbox.

If Teams installation unhealthy or user has Teams disabled, fall back to email immediately. Don't block on Teams.

---

## 8. Frontend surfaces

### `/admin/integrations/microsoft-365` — connection wizard

Five-step wizard built using `SettingsPageShell` + `SettingsPageHeader`.

**Step 1 — Introduction.** Explain what Prequest will do (read calendars, create reservations, post Teams messages). Link to security / privacy notice. Single "Continue" button.

**Step 2 — Permissions list.** Show each Graph application permission we need with plain-language explanation:
- "Read & write calendar events on room mailboxes — so we can create reservations when a room is booked."
- "Read directory users — so we can resolve attendees and route approvals to the right person."
- etc.

Single "Connect to Microsoft 365" button → redirect to Azure admin consent URL with our multi-tenant app's client_id.

**Step 3 — Consent in Azure AD.** Admin sees Microsoft's standard consent dialog, clicks Accept. Browser redirects back to `/admin/integrations/microsoft-365/callback?tenant=…&admin_consent=True`.

**Step 4 — Health check + room mailbox discovery.**
- Auto-trigger health check (calls Graph `/me`, `/places`).
- Show green checks for permissions confirmed.
- Display discovered room mailboxes in a table (display name, capacity, location).
- Admin maps each room mailbox to a Prequest space via combobox.
- "Save & continue" creates `ms365_room_mailboxes` rows + per-room webhook subscriptions.

**Step 5 — Teams app install (optional).**
- "Install Prequest in Microsoft Teams" CTA → deep link to Teams admin center.
- Skip available; admin can install Teams later.
- Step 5 records installation when complete.

After step 5: redirect to ongoing health page.

### `/admin/integrations/microsoft-365/health`

Dashboard view:
- Connection status pill: Active / Error / Pending consent.
- Subscription summary: N active, N renewing soon, N failed.
- Recent webhook events: last 50 with status (processed / errored / skipped).
- Token health: last refresh timestamp.
- Re-run health check button.
- Disconnect button (with confirmation).

### `/admin/integrations/microsoft-365/rooms`

Room mailbox ↔ Prequest space mapping table:
- Mailbox display name, email, capacity (from Graph).
- Mapped Prequest space (combobox, change inline).
- Last synced timestamp.
- Bulk re-discover from Graph button.
- Add unmapped mailbox manually.

### Embedded surfaces

In booking-confirm dialog:
- When current user has MS 365 connected and bundle has services: button "Send to my calendar" creates the calendar event with services description block embedded.

In `/portal/me-bookings`:
- For bookings with `calendar_event_id`: show small Outlook icon + "Synced to your calendar".

In `/desk/bookings` detail drawer:
- Show Outlook event source + organizer + attendee list (denormalized snapshot for fast display).

---

## 9. Performance + scale

### Estimated load (realistic worst case)

For a 5000-employee tenant with 100 room mailboxes:
- Subscriptions: 100 (rooms) + 200 active users at peak = 300 subscriptions.
- Renewal volume: 300 / 3 days = ~100/day, well within Graph quotas.
- Webhook volume: assume 50 calendar events created/updated/deleted per minute peak = 75k notifications/day per tenant.
- Token refreshes: 1/h per tenant = trivial.
- Outbound Graph calls (writeback): ~10x webhook volume due to fetch-on-notify + writeback = 750k/day per tenant.

Across 100 tenants: ~7.5M Graph calls/day. Manageable but requires:

1. **Per-tenant request quota tracking.** Graph rate-limit is ~10k requests per 10 min per app per tenant. Implement quota-aware backoff at call site.
2. **Webhook queue with worker pool.** Don't process inline in webhook receiver; queue + drain. Workers parallelized per tenant, serialized within tenant (preserves event ordering).
3. **Batch Graph reads where possible.** $batch endpoint supports up to 20 requests in one call.
4. **Token cache in Redis.** Don't acquire tokens in hot path.
5. **Materialized view for room mailbox mapping** if mapping cardinality grows.

### Known bottlenecks

- **Subscription validation challenge:** must respond <10s. Keep webhook receiver minimal — validate clientState, enqueue, return 200 immediately. Do NOT call Graph from webhook receiver.
- **Recurrence series fan-out:** changing a series-level rule can fire N occurrence updates. Throttle to avoid Graph rate-limit hits.
- **Cold-start subscription creation on tenant connect:** 100 rooms = 100 sequential Graph calls = ~30s. Acceptable for one-time setup but show progress UI.

### Observability

- Per-call latency (p50/p95/p99) labeled by Graph endpoint.
- Per-tenant error rate.
- Webhook processing lag (received_at → processed_at distribution).
- Subscription health (active / renewing / failed counts).
- Token cache hit rate.
- Graph quota consumption per tenant (where headers expose it).

Log to existing telemetry pipeline; surface to admin in `/admin/integrations/microsoft-365/health`.

---

## 10. Security + GDPR

### Security

- App secret / certificate stored encrypted at rest (pgsodium).
- Client_state validated on every webhook.
- Webhook URL HTTPS only.
- HMAC signing of card-action callbacks (Phase 4) with rotating secrets.
- Per-tenant token isolation in Redis.
- No customer credentials shared between tenants.
- Prequest's Azure AD app credentials in HSM-backed KMS.
- Annual penetration test of integration endpoints.

### GDPR-aligned data handling

Per `project_gdpr_baseline.md`:

- **Calendar event content (subject + body) is personal data.** Don't warehouse permanently:
  - Subject: stored in `booking_bundles.calendar_subject` only as long as booking is active; cleared on cancellation.
  - Body: never persisted; fetched on-demand for description writeback.
  - Attendees: snapshotted in `calendar_attendees` JSONB; cleared on cancellation.
- **Person erasure cascade:** when a person is anonymized (`persons.left_at`), drop their attendee references in `calendar_attendees` and clear `calendar_organizer_email` for their bookings. Cascade also drops Teams DM history (Bot Framework supports this via Graph).
- **Per-tenant data residency:** Graph data flows through Microsoft's EU regions when tenant's Azure AD tenant is in EU. We don't replicate calendar content to non-EU stores.
- **Audit log of personal data access:** every Graph API call attributed to tenant + Prequest user (the actor on whose behalf the call ran). Stored in audit outbox.
- **Right of access:** when a person requests their data, include calendar event references and webhook notification log for their email.
- **Right of erasure:** when a person is erased, scrub their email from `ms365_webhook_notifications.payload` + clear `calendar_attendees` snapshots.

### Sub-processor disclosure

Microsoft (Graph API + Bot Framework) is a sub-processor. Add to `/legal/sub-processors` page with: data processed (calendar metadata, attendees), data residency (EU regions), DPA reference (Microsoft's DPA + standard contractual clauses).

---

## 11. Acceptance criteria

### Phase 1 — Foundation (4-6 weeks)

- Tenant admin walks through 5-step wizard, ends with green "Connected" status (≤10 min total).
- Room mailboxes auto-discovered from Graph; admin maps to existing Prequest spaces in one screen.
- User books a room mailbox in Outlook with attendees → reservation appears in Prequest within 30s.
- Outlook event description gains "Add catering, AV, or services →" link block.
- Click link → opens Prequest at `/portal/booking/{bundleId}/services` with bundle pre-selected + space + time-window pre-populated.
- All webhook notifications logged in `ms365_webhook_notifications`.
- Health view surfaces: subscription status, last sync time, error count.
- Subscription auto-renewal works (verified by accelerated-clock test).
- ETag-based dedup verified (round-trip update doesn't loop).

### Phase 2 — Bi-directional sync (3-4 weeks)

- Cancel reservation in Prequest → Outlook event marked cancelled (organizer notified).
- Reschedule Outlook event → reservation window updates + asset reservations re-validate + service windows shift.
- Book conflicting Outlook event → Outlook event auto-declined with explanation.
- Recurring meeting created in Outlook → recurring reservation in Prequest.
- Per-occurrence Outlook override → reflected in Prequest.

### Phase 3 — Teams notifications (3-4 weeks)

- Tenant installs Prequest Teams app via admin center.
- Bundle confirmed → requester gets Teams DM with adaptive card containing event details + linked services.
- Bundle pending approval → approver gets DM with adaptive card showing approve/reject buttons (read-only initially; click leads to Prequest).
- At-risk service (T-2h, vendor unack'd) → desk lead gets DM with phone-follow-up CTA.
- All notifications fall back to email when Teams unavailable.

### Phase 4 — Card-action approvals (2-3 weeks)

- Approver clicks Approve in Teams card → POST validated → approval applied → card refreshes inline showing "Approved by you at [time]".
- Reject path includes optional reason.
- HMAC validation rejects forged actions.
- Audit log captures action.

---

## 12. Phased delivery + dependencies

### Phase 1 (4-6 wks): Foundation + read-only sync
- Auth + connection setup
- Room mailbox discovery + mapping
- Webhook subscription lifecycle
- Outlook → Prequest one-way (read)
- Deep-link in event description
- No conflict resolution yet (just mirroring)

**Depends on:** none (greenfield).

**Unlocks:** can start onboarding pilot tenants who only need view-only sync.

### Phase 2 (3-4 wks): Bi-directional + conflict resolution
- Prequest → Outlook writeback (cancellation, status, description updates)
- Auto-decline conflicting Outlook events
- Recurrence sync (RRULE translation)

**Depends on:** Phase 1 + recurrence test infrastructure.

**Unlocks:** Prequest-as-source-of-truth pitch is real.

### Phase 3 (3-4 wks): Teams notifications
- Bot Framework app
- Adaptive cards (read-only initially)
- DM-first; channel posts opt-in

**Depends on:** Phase 1 (shares auth).

**Unlocks:** corporate HQ messaging story is complete.

### Phase 4 (2-3 wks): Card-action approvals
- Approve / reject inline in Teams cards
- HMAC signing of action callbacks
- In-place card refresh

**Depends on:** Phase 3.

**Unlocks:** approver experience is industry-best.

### Phase 5 (4-6 wks, deferred to Tier 2): Outlook add-in
- Office.js compose-pane integration
- Inline services attachment within Outlook compose
- AppSource publication

**Depends on:** Phases 1-3.

**Why deferred:** Phase 1 deep-link covers 80% of value. AppSource publishing is bureaucratic (6+ weeks) and the add-in distribution model has high friction. Revisit when validation proves the deep-link is insufficient.

---

## 13. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Customer IT refuses app-only consent | Medium | High | Delegated permissions fallback (per-user OAuth) — built-in from day 1, even if rarely activated |
| Multi-tenant app secret rotation breaks all tenants | Low | Critical | Certificate-based auth + dual-secret rolling rotation + alerting |
| Microsoft Graph rate-limit hit at scale | Medium | Medium | Per-tenant quota tracking + backoff + $batch usage |
| Subscription renewal cascade failure | Medium | High | Multi-tier alerting; auto-recreate with one retry; admin notification |
| Recurrence pattern translation edge cases | High | Medium | Best-effort with explicit "unsupported" flag in audit + admin health view; document gaps |
| Outlook event body parsing fragile | Medium | Medium | Use HTML comment markers for our signature block; preserve user content above; fall back to append-only |
| Teams card action replay attack | Low | High | HMAC signing + timestamp validation + nonce |
| Calendar event PII leakage | Low | Critical | Don't persist body content; treat subject/attendees as ephemeral; cascade erasure |
| Outlook user with no Prequest account books a room | High | Medium | Auto-create Prequest person record (lightweight) — they can later be linked or merged. Audit captures auto-creation. |
| Tenant disconnects partway through ops | Low | Medium | Graceful degradation: existing bundles remain valid; future writebacks queue + report |
| Microsoft AppSource publishing delay (Phase 5) | High | Low | Plan 6-8 weeks; deep-link covers Phase 1-4 value |

---

## 14. Open questions for product / leadership

1. ✅ **Multi-tenant Azure AD app vs per-tenant** — **DECIDED 2026-04-27**: multi-tenant Azure AD app + per-tenant fallback for the regulated-customer minority (~5% of pipeline). Certificate-based auth (HSM-backed, dual-cert rolling rotation every 90 days). Pursue Microsoft Verified Publisher status from week 1. Per-tenant fallback path documented but NOT default.
2. ✅ **AppSource publisher posture** — **DECIDED 2026-04-27**: Option A (Prequest as own Microsoft Verified Publisher) is the eventual choice. **Deferred** until board permission is granted to start the legal/administrative process. Until then, onboarding uses admin consent URL only (no AppSource listing). When approval lands, kick off the 4-8 week verification process — it should be in place before Phase 3 (Teams notifications) ships. AppSource listing itself can wait until Phase 4. Until verified, consent dialog will show app without verified-publisher blue checkmark — acceptable for pre-wave-1 phase.
3. ⏸ **Pricing tier for MS 365 integration** — **OPEN as of 2026-04-27**. Three real options (A: free for all, B: enterprise-only, C: tiered free baseline + premium advanced). Decision deferred to leadership / pricing strategy. **Engineering implication:** architect for per-tenant feature entitlements from day 1 so any of A/B/C can be activated later via configuration, not code change. Specifically: gate each capability (deep-link, Outlook bi-di sync, room mailbox auto-discovery, Teams DMs, Teams adaptive cards) behind `tenant_entitlements.ms365_*` flags. Default flags = all-on for now; pricing decision flips them per tier when ready.
4. ✅ **Outlook add-in (Phase 5) priority** — **DECIDED 2026-04-27**: Path A — wait for Phase 1-3 to ship and validate with real users before investing in the Office.js compose-pane add-in. Phase 1's deep-link in event description ("Add catering, AV, or services →") covers 80% of value. If users complain "I don't want to leave Outlook", Phase 5 is justified by real demand and can ramp at that point. Saves ~10 weeks of upfront engineering for an unvalidated bet.
5. ✅ **Channel post vs DM default** — **DECIDED 2026-04-27**: Option A — DM-only by default. Channel posts NOT built in Phase 3. Tenant-configurable channel-post opt-in deferred to a later phase if customer demand emerges. Reasoning: DM is privacy-safe and never noisy; channel posts are tenant-specific ops surfaces that should be opt-in.
6. ✅ **Bot Framework hosting** — **DECIDED 2026-04-27**: Azure Bot Service (managed). Saves 2-3 weeks of adapter plumbing. SLA + DDoS + EU regional failover included. Cost predictable (~€0.50 per 1000 messages, free tier covers tens of thousands/month). Marginal additional Azure dependency acceptable since we're already deep in MS 365 territory.
7. ✅ **Auto-create Prequest persons from Outlook attendees** — **DECIDED 2026-04-27**: Yes, auto-create lightweight "ghost" person records, with explicit mitigations for the three identified risks.

   **Implementation:**
   - For each unknown attendee email on a synced Outlook event, create a `persons` row with: `email`, `display_name` (from Outlook), `source = 'calendar_sync'`, `linked_user_id = null`, `is_external = false`, `kind = 'ghost'` (new column).
   - When the same email later authenticates / is invited / is matched against an SSO directory, link the existing ghost record (don't create a duplicate).
   - Audit event `person.ghost_created_from_calendar_sync` per ghost.

   **Risk mitigations (must ship as part of Phase 1):**

   **A. Ghost accumulation — janitor process.**
   - Schema: `persons.last_seen_in_active_booking_at` (timestamp, nullable). Updated on every booking sync that references this person.
   - Background worker (nightly): for ghost persons (`kind = 'ghost'` AND `linked_user_id IS NULL`) where `last_seen_in_active_booking_at < now() - tenant_retention_settings.ghost_person_window`:
     - Anonymize email + display_name (replace with `Former attendee #<hash>`).
     - Preserve `id` so historical FKs hold.
     - Audit event `person.ghost_anonymized`.
   - Default retention window: 365 days. Tenant-configurable per `tenant_retention_settings` (LIA-aware, see §9.1.13). Aligns with GDPR baseline.

   **B. Email typos / orphan ghosts — admin merge tools + bulk dedup.**
   - Admin UI: `/admin/persons/ghosts` — list all unlinked ghosts with sortable columns (email, last seen, booking count).
   - Per-row actions: "Link to existing person" (combobox over real persons, fuzzy match by name/email), "Mark as external", "Anonymize now" (manual erasure).
   - Bulk dedup tool: detect ghosts with similar emails (Levenshtein distance, common typo patterns like missing dot or `gmial`/`gmail`) and propose merges.
   - Audit on every merge / mark / erasure.

   **C. External attendees (clients, vendors invited to meetings) — explicit "external" affordance.**
   - Schema: `persons.is_external` boolean default false.
   - Heuristic at ghost creation time: if attendee's email domain doesn't match any of the tenant's known domains (stored in `tenants.domains` jsonb), flag `is_external = true` automatically.
   - Tenant-configurable known-domains list (admin UI under `/admin/organisations/domains`).
   - External persons hidden from default employee directory search; only surfaced when admin opts in or when they're explicitly referenced in a booking/order.
   - External persons get a stricter retention default (180 days vs 365) — they have less legitimate-interest justification for long retention.
   - Audit event `person.flagged_external` on auto-flag.

   **Acceptance:** ghost persons accumulate cleanly, are anonymized after retention window, can be merged manually, and external attendees are auto-flagged + retention-tightened. Admin has visibility + control via the `/admin/persons/ghosts` page.
8. ✅ **User-mailbox sync vs rooms-only** — **DECIDED 2026-04-27**: rooms-only in Phase 1. Evaluate user-mailbox sync (Option C — opt-in per user) in Phase 2 based on validated demand for "meetings without a room" use cases. Phase 1 covers ~90% of value cleanly.

   **CRITICAL ATTACHED CONCERN — conflict prevention, not just resolution.** User flagged the UX risk: "user books in Outlook, looks like it worked, then gets cancellation mails — this enrages employees." This is exactly the failure mode that kills adoption. Reactive auto-decline is insufficient; conflicts must be **prevented at booking time**, not detected after. See new §6.5.

---

## 15. Out of scope (this spec)

- Google Calendar / Workspace integration.
- Slack integration.
- Outlook add-in (Phase 5 only — separate spec when invoked).
- Microsoft Bookings interop.
- Power Automate flows.
- Microsoft Viva integration.
- Cross-tenant vendor identity (separate workstream — vendor portal v1).
- LDAP / on-prem AD sync (cloud Azure AD only).

---

## 16. References

- [`docs/booking-services-roadmap.md`](../../booking-services-roadmap.md) — Tier 1 backlog, including this integration as a foundational item.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — competitive justification.
- Project memories:
  - `project_outlook_integration.md` — Outlook is Tier 1 must.
  - `project_teams_integration.md` — Teams notifications Tier 1.
  - `project_market_benelux.md` — NL/BE primary market context.
  - `project_gdpr_baseline.md` — privacy requirements.
- Microsoft documentation (read in implementation):
  - Graph API permissions reference.
  - Webhook subscriptions + change notifications.
  - Bot Framework + adaptive cards documentation.
  - Teams app manifest schema.

---

**Maintenance rule:** when implementation diverges from this spec, update the spec first, then align the code. Same convention as `docs/assignments-routing-fulfillment.md` and `docs/visibility.md`.
