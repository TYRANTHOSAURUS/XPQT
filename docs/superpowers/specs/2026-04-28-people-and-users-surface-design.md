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
4. Login history is captured by writing one `audit_events` row per successful sign-in plus updating `users.last_login_at`. No new tables, no new infra.

## Non-goals (deferred)

These are real product surfaces; bolting placeholders on now creates dead UI.

- **Sessions list & revoke** — needs backend control over Supabase JWT lifecycle; separate slice.
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
│   ├── user.controller.ts     — GET /users/:id/sign-ins (reads audit_events filtered by event_type)
│   ├── user.service.ts        — listSignIns(userId, limit), resetPassword(userId)
│   └── (existing PATCH /users/:id is sufficient for inline edits)
└── auth/
    └── auth.service.ts        — on successful sign-in: write audit_events row + update users.last_login_at
```

No schema changes are required for sign-in history. We use the existing `audit_events` table with a new `event_type = 'user.signed_in'` and `entity_type = 'users'`, `entity_id = user.id`, and stash `ip_address` from the request. Activity feed is read-only and aggregates over existing tables.

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
auth callback (Supabase JWT verified) →
  AuthService.recordSignIn(userId, ipAddress) →
    UPDATE users SET last_login_at = now() WHERE id = :userId
    INSERT INTO audit_events (event_type='user.signed_in', entity_type='users', entity_id=:userId, actor_user_id=:userId, ip_address, details={user_agent})

GET /users/:userId/sign-ins?limit=10 →
  SELECT * FROM audit_events
   WHERE event_type='user.signed_in' AND entity_id=:userId
   ORDER BY created_at DESC LIMIT :limit
```

We write the row from the `AuthGuard` on first request after a token is issued (via a "have we recorded this token's sign-in yet?" check using a short-lived in-memory dedupe keyed by `jti + user_id`). This avoids needing a Supabase Auth webhook and keeps the write path inside our own code where tenant context is already resolved. Misses (e.g. backend restart between login and first request) are acceptable — we accept some undercounting for v1 in exchange for zero new infrastructure.

**Caveat — multi-instance deployments.** The dedupe is per-process. If we ever run more than one API instance, the same login can record multiple sign-in events (one per instance the token first hits). Today the API runs single-instance, so this is fine. When we go multi-instance, the dedupe should move to Redis or be replaced by a Supabase Auth webhook — tracked as a follow-up, not in scope for this spec.

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

**`AuthService.recordSignIn(userId, ipAddress, userAgent)`:**

- Upsert in-memory dedupe key `${userId}:${jti}`. Skip if already recorded for this token.
- `UPDATE users SET last_login_at = now() WHERE id = :userId`
- Insert `audit_events` row: `event_type='user.signed_in'`, `entity_type='users'`, `entity_id=userId`, `actor_user_id=userId`, `ip_address`, `details={user_agent}`.

Called from the existing `AuthGuard` after token verification, before request handling continues. Failures are logged but do not block the request — sign-in history is observability, not a gate.

**`UserService.listSignIns(userId, limit)`:**

```sql
SELECT id, created_at, ip_address, details
  FROM audit_events
 WHERE tenant_id = :tenant
   AND event_type = 'user.signed_in'
   AND entity_id = :userId
 ORDER BY created_at DESC
 LIMIT :limit
```

Returns `{ id, signed_in_at, ip_address, user_agent }[]`.

**`UserController` additions:**

- `GET /users/:id/sign-ins?limit=10` → `listSignIns`
- `POST /users/:id/password-reset` → `resetPassword(userId)` → calls `supabase.auth.admin.generateLink({ type: 'recovery', email: user.email })` and triggers the existing tenant email template.

No migration needed.

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
- `user.service.spec.ts` — `listSignIns` filters by event_type + entity_id; `resetPassword` calls Supabase admin; status PATCH writes audit_events.
- `auth.service.spec.ts` — `recordSignIn` writes audit + updates last_login_at; second call with same jti is a no-op.

**Frontend (Vitest + RTL, existing test pattern):**

- `persons.tsx` — split-view selects via URL state; row click sets `?p=`; inspector renders `PersonDetailBody`.
- `person-detail.tsx` — auto-save fires on each new field (avatar, default location, manager, primary org, linked user); activity feed renders mixed items in order; DSR action opens confirm.
- `user-detail.tsx` — username inline edit auto-saves; status change auto-saves; linked-person clear works; password reset confirm path; sign-in history renders empty + populated states.

## Migration plan

1. **Backend slice first** — add the auth recordSignIn write, the GET endpoints, the PATCH path for `primary_org_node_id` on persons (lift from modal), and the DSR controllers (already exist).
2. **Frontend chunk B + C in parallel** — both detail pages get their new sections behind the existing routes. No URL changes. Persons detail picks up `PersonDetailBody` extraction.
3. **Frontend chunk A** — flip `persons.tsx` to split-view and remove the edit dialog. This is the user-visible UX swap. Ship after B is in so the detail page is feature-complete.
4. **Cleanup** — drop the now-unused edit modal code, drop the `setEditId` / `openEdit` paths, narrow the persons.tsx state.

Each step is independently shippable. If chunk A is rolled back, B + C still improve both detail pages.

## Open questions resolved during brainstorming

- **Login event store?** → `audit_events` with `event_type='user.signed_in'`. No new table.
- **Where to write the login event?** → AuthGuard with in-memory jti dedupe. Accepts some undercounting; defers Supabase Auth webhooks.
- **Booking visibility for the activity feed?** → Tenant-only filter for v1 (matches how `/desk/bookings` lists today). Tracked as deferred work alongside ticket visibility's planned visibility-layer extension.
- **Edit modal vs auto-save detail page?** → Drop the modal entirely. Single edit path.
- **Account-management depth?** → Small ops only (rename, status, password reset, suspend, DSR, login history). Sessions/MFA/tokens/impersonate explicitly deferred.
