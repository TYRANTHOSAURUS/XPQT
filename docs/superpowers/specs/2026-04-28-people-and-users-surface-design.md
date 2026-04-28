# People & Users surface — design

**Date:** 2026-04-28
**Author:** owner
**Status:** Draft → ready for implementation plan

## Why this exists

The `/admin/persons` and `/admin/users` surfaces are the operational front door for everything that depends on identity — routing, ownership, scoping, requester history, DSR. Today they are noticeably thinner than every other admin surface we've shipped recently:

- `/admin/persons/:id` shows ~6 fields and a location-grants panel. It does **not** surface `default_location_id` (the foundational field for portal scoping), `manager_person_id`, `avatar_url`, the primary org-node membership, the linked user account, or any activity context (recent tickets/bookings/audit). DSR — which we shipped end-to-end in GDPR Sprint 5 — has no entry point from the person record it acts on.
- `/admin/users/:id` is **entirely read-only**. There is no inline edit for username or status, no way to change the linked person, no password reset, no suspend, no sign-in history (the schema column `users.last_login_at` exists but is never written), and no DSR link.
- `/admin/persons` uses an old "table + edit pencil → modal" pattern that pre-dates the split-view layout shipped on `/admin/users`, `/admin/tickets`, `/desk/bookings`. The edit modal duplicates the auto-save detail page, so the two paths drift.

This spec brings both surfaces up to the bar of the rest of the admin app, fills the well-defined gaps that have backend support today, and adds one small backend slice (login history) the user has explicitly asked for. It deliberately defers items that need significant new backend (sessions, MFA, API tokens, impersonate) to follow-up work.

## Goals

1. `/admin/persons` adopts the split-view (`TableInspectorLayout` + `InspectorPanel`) used by `/admin/users`. The legacy edit modal is removed; the auto-save detail page is the single source of edit truth.
2. Person detail surfaces every field the data model already supports, plus a recent-activity feed that pulls from tickets, reservations, and audit events.
3. User detail becomes editable for the small ops we can implement today (username, status, linked person, password reset, suspend, DSR) and gains a sign-in history section backed by a tiny new auth-callback hook.
4. Login history is captured by a Supabase Auth Hook webhook that writes one row per real sign-in into a dedicated `auth_sign_in_events` table. No in-process dedupe, no per-request work in the AuthGuard. Foundation for the next slice (active sessions list + revoke + new-device email alerts) lands without rewriting the data layer.

## Non-goals (deferred)

These are real product surfaces; bolting placeholders on now creates dead UI.

- **Sessions list & revoke** — uses `supabase.auth.admin.listUserSessions()` + `signOut(jti)`; the data foundation lands in this spec but the UI ships in a follow-up slice.
- **New-device email alerts** — webhook handler will have the data; the comparison against last 30 days of devices and the email send are a follow-up slice.
- **MFA / 2FA enrollment** — no MFA implemented anywhere; needs its own UX + backend.
- **API tokens / personal access tokens** — needs token issuance + revocation backend.
- **Impersonate** — needs an audited admin-as-user flow; separate trust-model design.
- **Notification preferences** — separate per-user settings surface; depends on the notification routing model still being firmed up.

## Architecture

### Component boundaries

```
apps/web/src/pages/admin/
├── persons.tsx                — split-view shell + add dialog
├── person-detail.tsx          — exports PersonDetailBody (used by both inspector and full page) + PersonDetailPage (route /admin/persons/:id)
├── users.tsx                  — unchanged shell; existing UserDetailBody pattern continues
└── user-detail.tsx            — UserDetailBody gains edit + sign-in + danger-zone sections; UserDetailPage unchanged shape

apps/web/src/components/admin/
├── person-activity-feed.tsx   — NEW: interleaves recent tickets + bookings + audit events for a person
├── user-sign-in-history.tsx   — NEW: last-N sign-ins table for a user
└── dsr-actions-card.tsx       — NEW: shared DSR card used by both detail pages

apps/web/src/api/
├── persons/index.ts           — extend with personActivityOptions(personId)
├── users/index.ts             — extend with userSignInsOptions(userId), useUpdateUser, useResetUserPassword
└── (no new modules)
```

The split between `*DetailBody` (sections only) and `*DetailPage` (shell + header + body) — already established for users — is extended to persons in the same way. The body is the unit that's reused across the inspector pane and the full-page route.

### Backend surface

```
apps/api/src/modules/
├── person/
│   ├── person.controller.ts   — GET /persons/:id/activity (returns mixed feed: tickets, reservations, audit)
│   └── person.service.ts      — getRecentActivity(personId, limit)
├── user-management/
│   ├── user.controller.ts     — GET /users/:id/sign-ins (reads auth_sign_in_events)
│   ├── user.service.ts        — listSignIns(userId, limit), resetPassword(userId)
│   └── (existing PATCH /users/:id is sufficient for inline edits)
└── auth/
    ├── auth.controller.ts     — POST /internal/auth/sign-in-webhook (Supabase Auth Hook receiver)
    └── auth-events.service.ts — recordSignIn(payload), recordSignOut(payload)
```

One schema change is required: a new `auth_sign_in_events` table that stores one row per real sign-in. We do **not** mix login data into the existing `audit_events` table because (a) sign-in events have a different shape (device fingerprint, geo, session_id, MFA factors, success/failure), (b) different retention policy (sign-in events typically live 12-24 months for compliance, audit events live indefinitely), and (c) we want clean indexes for common queries like "all sign-ins for this user" and "all sign-ins across the tenant in the last 24h". Activity feed is read-only and aggregates over existing tables.

### Data flow — person activity feed

```
GET /persons/:personId/activity?limit=20
  ├─ tickets WHERE requester_person_id = :personId, ORDER BY created_at DESC LIMIT 20
  ├─ reservations WHERE (requester_person_id = :personId OR host_person_id = :personId), ORDER BY created_at DESC LIMIT 20
  └─ audit_events WHERE entity_type = 'persons' AND entity_id = :personId, ORDER BY created_at DESC LIMIT 20
→ merge by created_at DESC, slice :limit, return as { items: ActivityItem[] }
```

`ActivityItem` is a discriminated union:

```ts
type ActivityItem =
  | { kind: 'ticket'; id: string; title: string; status: string; created_at: string }
  | { kind: 'booking'; id: string; space_name: string; starts_at: string; status: string; created_at: string }
  | { kind: 'audit'; id: string; event_type: string; details: Json; actor_name: string | null; created_at: string };
```

Visibility: the endpoint runs through `TicketVisibilityService` for tickets (so a person's tickets that the viewer can't see are filtered out). Reservations are not yet behind a visibility service; for v1 we filter by tenant only, matching how `/desk/bookings` behaves today. Audit events are admin-only by virtue of the existing `/admin` auth.

### Data flow — login history

```
Supabase Auth (real source of truth — handles password / SSO / magic link / MFA) →
  Auth Hook fires "sign_in" or "sign_out" event →
    POST https://<api>/internal/auth/sign-in-webhook
      Headers: Authorization: Bearer <SUPABASE_AUTH_HOOK_SECRET>
      Body: { type, event, user_id, session_id, ip_address, user_agent, ... }
  ↓
  AuthEventsService.recordSignIn(payload):
    - Verify HMAC signature against SUPABASE_AUTH_HOOK_SECRET
    - Resolve tenant_id from user_id (every Supabase user is linked to public.users.id → tenants table)
    - INSERT INTO auth_sign_in_events (...) ON CONFLICT (session_id, event_kind) DO NOTHING
    - UPDATE users SET last_login_at = now() WHERE id = :user_id (only for sign_in event)

GET /users/:userId/sign-ins?limit=10 →
  SELECT id, signed_in_at, ip_address, user_agent, country, city, method, mfa_used, success, failure_reason
    FROM auth_sign_in_events
   WHERE tenant_id = :tenant
     AND user_id = :userId
     AND event_kind = 'sign_in'
   ORDER BY signed_in_at DESC LIMIT :limit
```

**Why a webhook + dedicated table over in-process tracking.** The webhook fires exactly once per real sign-in (Supabase guarantees at-least-once delivery, and the `(session_id, event_kind)` unique index makes the insert idempotent). This means:

- **No dedupe state** in the API process — we don't need a `Map<jti, true>` or a Redis cache, the database itself is the dedupe boundary.
- **Multi-instance safe by construction** — any API instance can receive the webhook; the unique index handles concurrent retries cleanly.
- **Captures sign-outs too** — needed by the next slice for active-session lists ("when did this session end?") and for audit completeness.
- **Idempotent retries** — Supabase's at-least-once delivery means retries on transient 5xx; the unique index makes that safe.

**Why a dedicated table over reusing `audit_events`.** Sign-in events and admin-action audit events have different shapes, different retention curves, and different read patterns. Forcing them into one table would mean either (a) sparse columns that are mostly null for non-sign-in rows, or (b) stuffing critical fields like `ip_address` and `mfa_used` into the `details` jsonb where they can't be indexed. The dedicated table also lets us add geo and device fields incrementally without polluting the audit log.

**Schema:**

```sql
create table public.auth_sign_in_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  event_kind      text not null check (event_kind in ('sign_in', 'sign_out', 'sign_in_failed')),
  signed_in_at    timestamptz not null default now(),
  session_id      text,                                  -- Supabase session id; null for failed attempts
  ip_address      inet,
  user_agent      text,
  country         text,                                  -- ISO 3166-1 alpha-2; populated by geo lookup later, null for v1
  city            text,                                  -- populated later, null for v1
  method          text,                                  -- 'password' | 'oauth' | 'magic_link' | 'sso' — from Supabase event
  provider        text,                                  -- 'google' | 'azure' | etc. when method='oauth'/'sso'
  mfa_used        boolean not null default false,
  success         boolean not null default true,
  failure_reason  text,                                  -- populated when event_kind='sign_in_failed'
  created_at      timestamptz not null default now()
);

create unique index auth_sign_in_events_session_event_uniq
  on public.auth_sign_in_events (session_id, event_kind)
  where session_id is not null;

create index auth_sign_in_events_user_signed_in_at
  on public.auth_sign_in_events (tenant_id, user_id, signed_in_at desc);

create index auth_sign_in_events_tenant_signed_in_at
  on public.auth_sign_in_events (tenant_id, signed_in_at desc);

alter table public.auth_sign_in_events enable row level security;
create policy "tenant_isolation" on public.auth_sign_in_events
  using (tenant_id = public.current_tenant_id());
```

Retention is registered with the GDPR retention system (already shipped in Sprint 1-5) under the new data category `auth_sign_in_events`, with a tenant-configurable default of 24 months. The retention worker will purge rows past the policy.

### Webhook security

- The endpoint is mounted at `POST /internal/auth/sign-in-webhook` and is **not** behind the `AuthGuard` — Supabase calls it as a service-to-service request.
- A shared secret `SUPABASE_AUTH_HOOK_SECRET` (env var) is configured in the Supabase Auth Hook settings and verified on every request. Mismatch returns 401 immediately.
- The endpoint is rate-limited at the platform layer (Render → Cloudflare) to mitigate replay floods.
- The handler is idempotent: the `(session_id, event_kind)` unique index lets us upsert safely on retries.

## Surface details

### A. `/admin/persons` split-view

**Shell.** `TableInspectorLayout` with the same header/toolbar/list/inspector composition as `/admin/users`. URL state uses `?p=<id>` to mirror users' `?u=<id>`. The existing type-tabs (All / Employees / Contractors / Vendors) move into the toolbar strip.

**Table columns when no selection:** Name, Email, Type, Organisation, Default location, Platform access. When a row is selected, the table compacts to: Name, Type, Platform access (matching the users.tsx behaviour where extra columns hide to free space for the inspector).

**Empty state.** Same structural shape as users.tsx — centred icon + headline + paragraph + primary CTA.

**Add person dialog.** Stays as a `Dialog`. Fields collapse to the genuinely-required ones for creation: first name, last name, type. Email is shown but optional (the persons table allows null email — visitors and contractors without email addresses are valid records). Everything else (org, manager, default location, cost center, avatar) moves to the detail page where it auto-saves. This is a deliberate scope shrink — the existing dialog tries to be both a creation form and an editor, and the editor side is fully redundant once auto-save exists.

**Edit dialog.** Removed.

**Inspector content.** `PersonInspectorContent` mirrors `UserInspectorContent`: a header block (avatar + name + type + status badges) followed by `<PersonDetailBody personId={id} />`.

### B. Person detail body

The page uses `SettingsPageShell width="xwide"` for the full route; the body is rendered identically inside the inspector at `xwide` content width. Sections, in order:

1. **Identity** — `SettingsGroup` of `SettingsRow` (auto-save, current pattern preserved). Adds:
   - **Avatar** row — `PersonAvatar` preview + "Upload" / "Remove" actions. Upload posts to Supabase Storage `avatars/<tenant_id>/<person_id>.<ext>`, then PATCHes `avatar_url`. 2 MB cap, jpg/png/webp. Failure surfaces via `toastError`.
2. **Organisation & access** — new `SettingsGroup`:
   - **Primary organisation** — `OrgNodeCombobox`, auto-save calls `PATCH /persons/:id` with `primary_org_node_id` (the controller already handles this in the existing modal save path; lift that handling into the standard PATCH).
   - **Default work location** — `LocationCombobox` (sites + buildings only, matching today's restriction). Auto-save.
   - **Manager** — `PersonPicker` excluding self. Auto-save.
   - **Linked user account** — read row. If linked: status badge + "Open user" link + "Unlink" action (with confirm). If not linked and email present: "Invite as user" button (calls `POST /users` like persons.tsx does today). If no email: muted "Add an email to invite" hint.
3. **Location grants** — existing `<PersonLocationGrantsPanel />`, unchanged.
4. **Activity** — new `<PersonActivityFeed personId={id} />`. Shows last 20 items, mixed tickets / bookings / audit events, each row links to its source. Empty state: "No recent activity for this person."
5. **Danger zone** — existing Deactivate row, plus new DSR rows via `<DsrActionsCard subjectType="person" subjectId={id} />`:
   - **Request data export** — primary action, opens confirm with reason note → calls `useInitiateAccessRequest({ personId, fulfill: true })` → toast on success with link to the privacy page request detail.
   - **Initiate erasure** — destructive action, opens dialog requiring a reason field (per the existing `useInitiateErasureRequest` API) → confirm twice for safety.

### C. User detail body

The page keeps `SettingsPageShell width="xwide"` and the existing Identity / Roles / Effective permissions / Activity sections, but every section becomes editable where it makes sense. New shape, in order:

1. **Identity** — converted from a 4-field grid into a `SettingsGroup` of `SettingsRow` (auto-save, matching person-detail):
   - **Email** — read-only (changing the auth email is a separate flow).
   - **Username** — `Input`, debounced auto-save via `PATCH /users/:id`.
   - **Status** — `Select` with active / inactive / suspended. Save on change.
   - **Linked person** — `PersonPicker` value, saves `person_id` on change. "Clear" action.
2. **Sign-in** — new `SettingsGroup`:
   - **Last sign-in** — `formatRelativeTime(user.last_login_at)` with `formatFullTimestamp` tooltip; "Never" if null. Tabular nums.
   - **Recent sign-ins** — `<UserSignInHistory userId={id} limit={10} />`. Compact table: When (relative + full tooltip), IP, User agent (truncated). Empty: "No sign-ins recorded yet for this account."
   - **Send password reset** — button. Calls `POST /users/:id/password-reset` which forwards to Supabase Auth `admin.generateLink({ type: 'recovery' })` and emails it. Confirm before sending.
3. **Roles** — existing `<RolesList />`, unchanged.
4. **Effective permissions** — existing panel, unchanged.
5. **Activity** — existing `<RoleAuditFeed />`, unchanged.
6. **Danger zone** — new `SettingsGroup`:
   - **Suspend account** (or **Reactivate** if currently suspended) — destructive, with confirm.
   - **Request data export** / **Initiate erasure** — same `<DsrActionsCard subjectType="user" subjectId={id} />`. Internally it resolves the linked person via `user.person_id` and routes to the same DSR endpoints. If the user has no linked person, the card renders a muted explanation ("No linked person — data subject requests act on the person record") with a "Link a person" call-to-action that scrolls to the linked-person row in Identity. We do not invent a separate user-only DSR path; DSR is a per-natural-person operation by design.

### D. Backend — login history slice

**Migration `00168_auth_sign_in_events.sql`** — creates the table + indexes + RLS policy as defined in the Data flow section, plus registers the retention category.

**`AuthEventsService.recordSignIn(payload)`:**

- Verify HMAC signature (caller has already done this in the controller, but the service double-checks tenant resolution succeeded).
- Resolve `tenant_id` by joining `auth.users.id` → `public.users.id` → `public.users.tenant_id`. Reject (and log) if the user does not exist in `public.users` — that's a desync we want to catch.
- `INSERT INTO auth_sign_in_events (...) VALUES (...) ON CONFLICT (session_id, event_kind) WHERE session_id IS NOT NULL DO NOTHING`.
- For `event_kind = 'sign_in'` only: `UPDATE users SET last_login_at = greatest(coalesce(last_login_at, '-infinity'), :signed_in_at) WHERE id = :user_id`.

`recordSignOut` is the same shape with `event_kind='sign_out'`. `recordSignInFailed` writes a row with `success=false`, `session_id=null`, and `failure_reason` populated — these rows escape the unique index because the partial index excludes null session_ids, which is intentional (failures aren't dedupable).

**`AuthController.signInWebhook`:**

```ts
@Post('internal/auth/sign-in-webhook')
@Public()  // no AuthGuard — service-to-service
async signInWebhook(@Body() payload: unknown, @Headers('authorization') auth: string) {
  this.verifyWebhookSecret(auth);
  const event = parseSupabaseAuthEvent(payload);  // narrows to discriminated union
  switch (event.type) {
    case 'sign_in':         return this.events.recordSignIn(event);
    case 'sign_out':        return this.events.recordSignOut(event);
    case 'sign_in_failed':  return this.events.recordSignInFailed(event);
  }
}
```

Failures throw 5xx so Supabase retries; 4xx responses (bad payload, unknown user) are not retried.

**`UserService.listSignIns(userId, limit)`:**

```sql
SELECT id, signed_in_at, ip_address, user_agent, country, city, method, provider, mfa_used, success, failure_reason
  FROM auth_sign_in_events
 WHERE tenant_id = :tenant
   AND user_id = :userId
   AND event_kind = 'sign_in'
 ORDER BY signed_in_at DESC
 LIMIT :limit
```

Returns the rows with relative-time-friendly fields. The frontend never sees `event_kind` because the endpoint filters to sign-ins only.

**`UserController` additions:**

- `GET /users/:id/sign-ins?limit=10` → `listSignIns`
- `POST /users/:id/password-reset` → `resetPassword(userId)` → calls `supabase.auth.admin.generateLink({ type: 'recovery', email: user.email })` and triggers the existing tenant email template.

**Supabase configuration (one-time, in the Supabase dashboard or via CLI):**

- Enable Auth Hooks for `sign_in`, `sign_out`, and `sign_in_failed` events.
- Point hook URL at `https://<api>/internal/auth/sign-in-webhook`.
- Generate `SUPABASE_AUTH_HOOK_SECRET` and store in both Supabase Auth Hook config and our API env vars.

This is a deploy-time step, not code. The implementation plan will include a setup checklist.

### E. Person activity feed slice

**`PersonService.getRecentActivity(personId, limit = 20)`:**

Three parallel queries, merged in JS:

```ts
const [tickets, bookings, audits] = await Promise.all([
  this.tickets.listForPerson(personId, limit),       // requester_person_id = personId
  this.reservations.listForPerson(personId, limit),  // requester_person_id OR host_person_id = personId
  this.supabase.from('audit_events')
    .select('id, event_type, details, actor_user_id, created_at')
    .eq('entity_type', 'persons')
    .eq('entity_id', personId)
    .order('created_at', { ascending: false })
    .limit(limit),
]);
return mergeAndSlice(tickets, bookings, audits, limit);
```

Each list is mapped to the discriminated `ActivityItem` shape. Tickets pass through `TicketVisibilityService.getVisibleIds` to filter out items the viewer can't see; bookings filter by tenant only for v1.

**`PersonController` addition:**

- `GET /persons/:id/activity?limit=20` → returns `{ items: ActivityItem[] }`.

## Error handling

- **Avatar upload** — failures (over size, wrong type, network) surface via `toastError`. The Supabase Storage upload is the source of truth; we only PATCH `avatar_url` after upload succeeds.
- **Password reset** — failure surfaces as `toastError("Couldn't send reset email", { error })` with retry. Success is a `toastSuccess('Reset email sent')`.
- **Suspend / reactivate / unlink** — wraps existing PATCH with the standard error toast pattern.
- **DSR initiation** — both access and erasure return job results; we surface success with `toastCreated('Data export requested', { onView: () => navigate('/admin/settings/privacy') })`. Erasure failures (e.g. legal hold blocking) come back as 4xx with a structured reason and become a `toastError("Couldn't start erasure", { error })`.
- **Activity feed** — empty arrays render the empty state; a 5xx from the endpoint renders a single inline retry row, not a full page error.
- **Sign-in history** — same shape as activity feed.

## Testing

**Backend (Jest, existing test pattern):**

- `person.service.spec.ts` — `getRecentActivity` returns merged items in created_at order; respects limit; tickets honour visibility service.
- `user.service.spec.ts` — `listSignIns` filters by `user_id` + `event_kind='sign_in'` + tenant; `resetPassword` calls Supabase admin; status PATCH writes audit_events.
- `auth-events.service.spec.ts` — `recordSignIn` inserts into `auth_sign_in_events` and updates `last_login_at`; duplicate webhook with same `(session_id, 'sign_in')` is a no-op (idempotency); `recordSignOut` inserts a `sign_out` row but does NOT touch `last_login_at`; `recordSignInFailed` writes with `success=false` and bypasses dedupe.
- `auth.controller.spec.ts` — webhook with valid HMAC routes to the right service method; webhook with invalid HMAC returns 401; webhook with malformed payload returns 400 (no retry); webhook with unknown user logs and returns 4xx.

**Frontend (Vitest + RTL, existing test pattern):**

- `persons.tsx` — split-view selects via URL state; row click sets `?p=`; inspector renders `PersonDetailBody`.
- `person-detail.tsx` — auto-save fires on each new field (avatar, default location, manager, primary org, linked user); activity feed renders mixed items in order; DSR action opens confirm.
- `user-detail.tsx` — username inline edit auto-saves; status change auto-saves; linked-person clear works; password reset confirm path; sign-in history renders empty + populated states.

## Migration plan

1. **Backend foundation** —
   1.1 Migration `00168_auth_sign_in_events.sql` (table + indexes + RLS + retention category registration).
   1.2 `AuthEventsService` + `AuthController.signInWebhook` + HMAC verification.
   1.3 Configure Supabase Auth Hook in dashboard pointing at the new endpoint, set `SUPABASE_AUTH_HOOK_SECRET` in both places.
   1.4 Smoke test: log in via the dev app, verify a row lands in `auth_sign_in_events`.
2. **Backend read endpoints** — `GET /users/:id/sign-ins`, `GET /persons/:id/activity`, `POST /users/:id/password-reset`, plus the PATCH path for `primary_org_node_id` on persons (lift from modal save into the standard PATCH handler).
3. **Frontend chunk B + C in parallel** — both detail pages get their new sections behind the existing routes. No URL changes. Persons detail picks up `PersonDetailBody` extraction.
4. **Frontend chunk A** — flip `persons.tsx` to split-view and remove the edit dialog. This is the user-visible UX swap. Ship after B is in so the detail page is feature-complete.
5. **Cleanup** — drop the now-unused edit modal code, drop the `setEditId` / `openEdit` paths, narrow the persons.tsx state.

Each step is independently shippable. If chunk A is rolled back, B + C still improve both detail pages. If the webhook configuration in Supabase isn't done yet (step 1.3), the rest of the system functions normally — sign-in history just shows "No sign-ins recorded yet".

## Open questions resolved during brainstorming

- **Login event store?** → New dedicated table `auth_sign_in_events`. Reusing `audit_events` was the cheap option but mixes concerns and forces sparse columns; the dedicated table is the end-game shape.
- **Where to write the login event?** → Supabase Auth Hook webhook → POST to our API. Idempotent via `(session_id, event_kind)` unique index. No in-process dedupe, multi-instance safe by construction. Captures sign-outs and failed attempts as a side benefit.
- **Vendor lock-in?** → Webhook payload format and a few `supabase.auth.admin.*` calls are Supabase-specific. ~1-2 days of work in a months-long Supabase migration; noise relative to RLS, Storage, Realtime, and the auth identity model itself.
- **Booking visibility for the activity feed?** → Tenant-only filter for v1 (matches how `/desk/bookings` lists today). Tracked as deferred work alongside ticket visibility's planned visibility-layer extension.
- **Edit modal vs auto-save detail page?** → Drop the modal entirely. Single edit path.
- **Account-management depth?** → Small ops only (rename, status, password reset, suspend, DSR, login history). Sessions/MFA/tokens/impersonate explicitly deferred to follow-up slices that build on the data foundation laid here.
