# Roles & Permissions Redesign — Design Plan

**Status:** Draft for codex review
**Owner:** (user)
**Date:** 2026-04-24

## 1. Problem

Today's roles/permissions model is too coarse for an ITSM/FMIS platform:

- `roles.permissions` uses colon-separated strings (`tickets:read_all`, `people:manage`) that mix scoped actions with visibility overrides and lack module-level granularity.
- Only ~8 permission keys exist across the product; most modules (`assets`, `workflows`, `sla`, `vendors`, `reports`, etc.) have no permissions at all.
- The role editor UI (`apps/web/src/pages/admin/users.tsx`) collects `name/description/type` but has no permission picker — permissions can only be seeded via SQL migration.
- Person detail pages don't show what a person can do on the platform. Users only show role names, not effective permissions.
- No audit trail on role or assignment changes. No time-bounds on assignments. No role templates.

Goal: ship a best-in-class authorization layer competitive with ServiceNow, Jira Service Management, and Freshservice Pro.

## 2. Existing model (confirmed)

- **Roles attach to `users`** via `user_role_assignments.user_id`. Persons do not have roles directly.
- **`users.person_id`** is the nullable FK bridging a person to their platform account. A person can exist without a user (external requester, visitor, vendor contact).
- **Scope** (`domain_scope text[]`, `location_scope uuid[]`) lives on the assignment, not the role.
- **Permission check** = `public.user_has_permission(user_id, tenant_id, key)` — simple JSONB `?` containment.
- **Three-tier visibility** (Participant / Operator / Override) is documented in `docs/visibility.md` and depends on two override permissions: `tickets:read_all`, `tickets:write_all`.

**Decision:** keep the user-side attachment. Persons stay identity-only; roles grant platform access. Person detail pages will resolve roles via the linked user.

## 3. Design decisions (locked)

### 3.1 Grammar — resource.action with wildcards

- Format: `<resource>.<action>` (dot, not colon — matches Google IAM / ServiceNow).
- Wildcards allowed in either position:
  - `tickets.*` — all actions on tickets
  - `*.read` — read everything (auditor)
  - `*.*` — super admin
- Colon-separated legacy keys are rewritten in a data migration.

### 3.2 Overrides kept as distinct permissions

- Scoped action: `tickets.read` + `domain_scope`/`location_scope` on assignment = "read tickets within my scope".
- Override: `tickets.read_all` = "bypass scope filter, see every ticket in tenant".
- Rendered in UI as a distinct **Overrides (bypass scoping)** group with danger styling.
- Auditable: "who can see everything?" = `select user_id from user_role_assignments ura join roles r on r.id=ura.role_id where r.permissions ? 'tickets.read_all'`.

### 3.3 Scope stays on assignment

- Roles = reusable recipes. Assignments = where the recipe applies.
- "FM Supervisor" used in London and Dubai = one role, two assignments, not two roles.
- No scope embedded inside permission strings.

### 3.4 Catalog lives in TypeScript, not the DB

- `packages/shared/src/permissions.ts` is the single source of truth.
- API guards import the typed `PermissionKey` union for compile-time safety.
- UI iterates the catalog to render the grouped picker.
- DB stores opaque strings; no per-tenant custom permissions (not a requirement today, and adding a catalog table just adds sync burden).

### 3.5 Multi-role stacking, no inheritance

- A user may have multiple active role assignments. Their permission set = union of role permissions, with wildcard resolution.
- No "role inherits from role" feature — stacking already solves the composition use case with a simpler mental model.

### 3.6 Time-bound assignments

- `user_role_assignments` gains `starts_at timestamptz null`, `ends_at timestamptz null`.
- `user_has_permission` filters assignments where `(starts_at is null or starts_at <= now())` and `(ends_at is null or ends_at > now())`.
- UI: "Temporary access" toggle in assign-role dialog revealing both fields.

### 3.7 Audit log

- New table `role_audit_events` (tenant_id, actor_user_id, event_type, target_role_id, target_user_id, target_assignment_id, payload jsonb, created_at).
- Event types: `role.created`, `role.updated`, `role.deleted`, `assignment.created`, `assignment.updated`, `assignment.revoked`, `permissions.changed`.
- Written by API on every mutation. Exposed as a feed on role detail and user detail.

### 3.8 Pre-built role templates

Seeded once per tenant via migration. Editable afterwards.

| Template | Permissions |
|---|---|
| Tenant Admin | `*.*` |
| IT Agent | `tickets.*` (domain_scope=['it']), `request_types.read`, `assets.read`, `people.read` |
| FM Agent | `tickets.*` (domain_scope=['fm']), `assets.*`, `spaces.read`, `people.read` |
| Service Desk Lead | IT/FM Agent permissions + `people.update`, `teams.*`, `reports.read` |
| Requester | `tickets.create`, `tickets.read` (own only via participant tier), `service_catalog.read` |
| Auditor | `*.read` |

## 4. Schema changes

### 4.1 Migration: `user_has_permission` v2

```sql
create or replace function public.user_has_permission(
  p_user_id uuid,
  p_tenant_id uuid,
  p_permission text
) returns boolean
language sql stable
as $$
  with parts as (
    select split_part(p_permission, '.', 1) as resource,
           split_part(p_permission, '.', 2) as action
  )
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.roles r on r.id = ura.role_id
    cross join parts
    where ura.user_id = p_user_id
      and ura.tenant_id = p_tenant_id
      and ura.active = true
      and r.active = true
      and (ura.starts_at is null or ura.starts_at <= now())
      and (ura.ends_at is null or ura.ends_at > now())
      and (
        r.permissions ? p_permission
        or r.permissions ? (parts.resource || '.*')
        or r.permissions ? ('*.' || parts.action)
        or r.permissions ? '*.*'
      )
  );
$$;
```

### 4.2 Migration: time-bound assignments + audit

```sql
alter table public.user_role_assignments
  add column starts_at timestamptz,
  add column ends_at timestamptz;

create index on public.user_role_assignments (ends_at) where ends_at is not null;

create table public.role_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_user_id uuid references public.users(id),
  event_type text not null,
  target_role_id uuid references public.roles(id),
  target_user_id uuid references public.users(id),
  target_assignment_id uuid references public.user_role_assignments(id),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index on public.role_audit_events (tenant_id, created_at desc);
create index on public.role_audit_events (target_role_id);
create index on public.role_audit_events (target_user_id);

-- RLS
alter table public.role_audit_events enable row level security;
create policy audit_tenant_read on public.role_audit_events
  for select using (tenant_id = public.current_tenant_id());
create policy audit_tenant_insert on public.role_audit_events
  for insert with check (tenant_id = public.current_tenant_id());
```

### 4.3 Data migration — rewrite legacy keys

```sql
-- Remap every permissions array, replacing colon keys with dot equivalents.
update public.roles
set permissions = (
  select jsonb_agg(
    case
      when v::text = '"tickets:read_all"'  then '"tickets.read_all"'::jsonb
      when v::text = '"tickets:write_all"' then '"tickets.write_all"'::jsonb
      when v::text = '"people:manage"'     then '"people.*"'::jsonb
      when v::text = '"request_types:manage"' then '"request_types.*"'::jsonb
      when v::text = '"routing_studio:access"' then '"routing.*"'::jsonb
      when v::text = '"organisations:manage"'  then '"organisations.*"'::jsonb
      when v::text = '"service_catalog:manage"' then '"service_catalog.*"'::jsonb
      when v::text = '"criteria_sets:manage"'  then '"criteria_sets.*"'::jsonb
      else v
    end
  )
  from jsonb_array_elements(permissions) v
)
where permissions is not null and jsonb_typeof(permissions) = 'array';
```

Callers in `apps/api/**` are updated in lockstep to emit the new keys.

### 4.4 Seed — default role templates

A migration that, for every existing tenant, ensures the six default roles exist (insert-if-missing).

## 5. Catalog (`packages/shared/src/permissions.ts`)

17 modules × ~5–8 actions ≈ ~120 permission keys.

```ts
type ActionMeta = { label: string; description?: string; danger?: boolean };
type ModuleMeta = {
  label: string;
  icon: string;
  actions: Record<string, ActionMeta>;
  overrides?: Record<string, ActionMeta>;
};

export const PERMISSION_CATALOG: Record<string, ModuleMeta> = {
  tickets: { /* read, create, update, assign, close, reopen, delete; overrides: read_all, write_all */ },
  people: { /* read, create, update, delete, invite */ },
  users: { /* read, create, update, suspend */ },
  roles: { /* read, create, update, delete, assign */ },
  teams: { /* read, create, update, delete, manage_members */ },
  request_types: { /* read, create, update, delete, publish */ },
  routing: { /* read, create, update, delete, simulate */ },
  service_catalog: { /* read, create, update, delete, publish */ },
  organisations: { /* read, create, update, delete, manage_grants */ },
  spaces: { /* read, create, update, delete, manage_grants */ },
  assets: { /* read, create, update, delete, transfer, retire */ },
  criteria_sets: { /* read, create, update, delete */ },
  workflows: { /* read, create, update, delete, publish */ },
  sla: { /* read, create, update, delete, pause */ },
  vendors: { /* read, create, update, delete, manage_contacts */ },
  reports: { /* read, create, update, delete, export */ },
  settings: { /* read, update, danger: tenant-wide config */ },
};

export type PermissionKey =
  | `${keyof typeof PERMISSION_CATALOG}.${string}`
  | `${keyof typeof PERMISSION_CATALOG}.*`
  | `*.${string}`
  | '*.*';
```

Validator helper rejects any string not matching the catalog or wildcard forms when POSTing a role.

## 6. API changes

### 6.1 `user-management.service.ts`

- `createRole(input)`: validate each permission key against catalog + wildcards. Write `role_audit_events` with event_type=`role.created`.
- `updateRole(id, input)`: same validation; diff old vs new `permissions`; write `permissions.changed` event if differ.
- `addUserRole(input)`: accepts `starts_at`, `ends_at`. Writes `assignment.created` event.
- `updateUserRoleAssignment(id, input)`: new method for editing scope or time bounds. Writes `assignment.updated`.
- `removeUserRoleAssignment(id)`: soft-delete (active=false) + `assignment.revoked` event.
- `listRoleAuditEvents(roleId?, userId?, limit)`: new method powering the feed.

### 6.2 New endpoints

- `GET /permissions/catalog` — returns the TS catalog as JSON for the UI.
- `GET /roles/:id/audit` — paginated audit feed for a role.
- `GET /users/:id/audit` — paginated audit feed for a user.
- `GET /users/:id/effective-permissions` — resolves all active assignments, returns `{ key, grantedBy: [roleId], scope: {domain, location}, source: 'exact'|'wildcard' }[]`.
- `POST /persons/:id/invite` — creates a user tied to the person, sends Supabase Auth invite, optionally pre-assigns roles.

### 6.3 Guard helpers

- Replace hardcoded string literals in controllers (`'tickets.read_all'`, etc.) with imports from the shared catalog so typos fail at compile time.

## 7. Frontend changes

### 7.0 Settings page width standard

The existing `SettingsPageShell` template (`apps/web/src/components/ui/settings-page.tsx`) exposes three widths:
- `narrow` 480px — short forms.
- `default` 640px — single-column settings (Linear-style).
- `wide` 960px — rule builders, dense tables.

None of these are right for the role editor (needs grouped picker + live preview panel side-by-side) or the users/roles list (needs multi-column table + filters + actions) or the effective-permissions panel (dense, module-grouped).

**Add a new `xwide` option at 1180px.** This matches Linear project views, Vercel dashboard, and the ServiceNow/JSM admin width conventions — enough for two-column layouts with breathing room, without feeling stretched on ultrawide monitors.

```ts
// settings-page.tsx
export type SettingsPageWidth = 'narrow' | 'default' | 'wide' | 'xwide';
const WIDTH_CLASS: Record<SettingsPageWidth, string> = {
  narrow: 'max-w-[480px]',
  default: 'max-w-[640px]',
  wide: 'max-w-[960px]',
  xwide: 'max-w-[1180px]',
};
```

Pages using `xwide`:
- `/admin/users` (list with tabs).
- `/admin/users/roles/:id` (role editor with two-column picker + preview).
- `/admin/users/:id` (user detail with effective permissions + audit tab).
- Person detail *Platform Access* section stays inline on the existing person page (no width change there).

### 7.1 Role editor (`apps/web/src/pages/admin/users.tsx` → split)

Extract a dedicated page `/admin/users/roles/:id` using `SettingsPageShell width="xwide"` + `SettingsPageHeader` + `SettingsSection` blocks. No more dialog — the permission picker is too rich for a modal.

- Header: back link to `/admin/users`, title (role name), description, type chip, right-aligned actions (Duplicate, Delete).
- **Basics** section (`SettingsSection`, bordered): name, description, type — built with `FieldGroup` / `Field` (per project mandate).
- **Permissions** section (`SettingsSection`, `density="tight"`):
  - Left column (≈ 720px): search bar + collapsible module sections. Each module shows:
    - Module-level "All actions" toggle → adds `module.*`.
    - Per-action checkboxes with labels + tooltips from catalog.
    - Separate "Overrides (bypass scoping)" subsection, amber-tinted.
  - Right column (≈ 380px, sticky): live preview of the raw string array that will be saved, "effectively grants" summary with wildcards expanded, and a count badge ("X permissions, Y wildcards").
- **Audit** section: recent role audit events, scroll-contained.
- Danger permissions (catalog `danger: true`) show a shield icon; selecting them raises a confirm.
- `SettingsFooterActions` at page bottom: Save (primary), Cancel (secondary).
- Create flow (`/admin/users/roles/new`): identical page with a "Start from template" picker rendered above the Basics section (ghost dropdown); selecting a template prefills permissions.

### 7.2 Users / Roles list (`/admin/users`)

`SettingsPageShell width="xwide"` containing two tabs:
- **Users** tab: existing table, new column showing a stack of role chips per user.
- **Roles** tab: table + new columns — "Users" count (click drills to filtered user list), "Permissions" count, "Last updated". Row-level actions: Edit (navigates to role page), Duplicate (clones into `/admin/users/roles/new?from=:id`), Delete (confirm; blocks if users still assigned).
- Empty state on Roles tab: cards showing the six template roles ("Seed recommended roles").

### 7.3 Assign-role dialog (unchanged container, richer body)

Still a dialog on the user detail page — this is a single-shot decision, doesn't need a full page.

- Role select, domain_scope, location_scope (existing).
- New collapsible "Temporary access" section revealing `starts_at` / `ends_at` pickers.
- Preview chip at the bottom: "Bob will have X permissions, scoped to Y domains and Z locations, until {ends_at or 'indefinitely'}".

### 7.4 User detail page (`/admin/users/:id`)

`SettingsPageShell width="xwide"` with `SettingsSection` blocks:
- **Identity** — linked person, email, status.
- **Roles** — assigned roles with scope + time-bound chips; "Assign role" button opens dialog 7.3.
- **Effective Permissions** — grouped-by-module view:
  - Each granted permission key.
  - Which role(s) granted it (chips).
  - Scope summary (domains + locations).
  - Wildcard indicator (e.g. "via `tickets.*`").
- **Activity** — role audit events for this user, scroll-contained list.

### 7.5 Person detail page

No width change (person page is its own template). Add a **Platform Access** `SettingsSection`:
- If no linked user → "No platform access" + `[Invite to platform]` button opening an invite dialog (email, optional role pre-assignment).
- If linked user → compact view of their active roles with scope chips, link to user detail.

### 7.6 API layer

- New React Query module: `apps/web/src/api/permissions/`
  - `permissionsKeys` factory, `catalogQueryOptions`, `roleAuditQueryOptions(roleId)`, `userAuditQueryOptions(userId)`, `effectivePermissionsQueryOptions(userId)`.
  - Mutations: `useCreateRole`, `useUpdateRole`, `useDeleteRole`, `useAssignRole`, `useUpdateAssignment`, `useRevokeAssignment`, `useInvitePersonToPlatform`.
  - Follows `docs/react-query-guidelines.md`.

## 8. Build order

Sliced for review between each step (codex at each slice boundary).

1. **Catalog + types** (`packages/shared/src/permissions.ts`, `PermissionKey`).
2. **Evaluator + time bounds migration** (migration + update `user_has_permission`).
3. **Data rewrite migration** + API caller updates (colon → dot).
4. **Audit table + API writes** (`role_audit_events`, audit emitters in service).
5. **API endpoints** (`GET /permissions/catalog`, `/effective-permissions`, audit endpoints, invite endpoint).
6. **Role editor UI** (picker, search, preview, templates).
7. **Assign-role dialog** (time bounds + scope).
8. **User detail** (effective permissions + audit tab).
9. **Person detail** (platform access + invite flow).
10. **Seed templates migration** (six default roles per tenant).

Push to remote after each slice (per the standing DB-push permission for this workstream).

## 8.1 Review findings (self-review against codebase; codex quota exhausted)

**Verdict:** Approve with changes. Plan is sound; the following corrections are applied in the updated sections above / below.

1. **Evaluator must be backward-compatible during rollout (blocker).** If the new `user_has_permission` ships before every colon-literal is rewritten, every auth check using `:` will fail. Fix: normalize `p_permission` inside the function — `replace(lower(p_permission), ':', '.')` — and rewrite data in the same migration. API callers can be converted to dot-form at leisure; compatibility layer drops after slice 5.

2. **Null + malformed permission guards (major).** Add `coalesce(r.permissions, '[]'::jsonb)` and reject tokens with `array_length(regexp_split_to_array(norm, '\.'), 1) <> 2` or with an empty segment. Prevents `.read` or `tickets.read.own` from accidentally matching `*.read` / `tickets.*`.

3. **GIN index on `roles.permissions` (major).** None exists today. With 6 templates × N tenants each holding ~10–50 keys plus wildcards, `?` scans are fine now but degrade once custom roles proliferate. Add `create index on public.roles using gin (permissions jsonb_path_ops);` in the same migration.

4. **Existing seed migrations re-emit colon-form on `pnpm db:reset` (major).** Migrations 00034, 00054, 00067, 00081, 00097, 00102, 00108 all write colon keys. On a local reset, they apply before our new rewrite, so end state is still correct — but the churn is ugly and a dev reading any of those files sees wrong grammar. Fix: edit those files in place to emit dot-form (they're idempotent `on conflict` seeds, so editing is safe), and keep one defensive rewrite migration for remote DBs already holding colon data.

5. **Override permissions stay distinct — confirmed sound (no change).** `ticket_visibility_ids` (migration 00035) does NOT reference the override strings; they're checked only in `TicketVisibilityService.loadContext` via `user_has_permission('tickets:read_all'|'tickets:write_all')`. Collapsing would force the SQL function to also know about scope bypass, a worse abstraction.

6. **React Query invalidation strategy (major).** When a role's permissions change, every user carrying that role needs their effective-permissions cache invalidated. Strategy:
   - On mutation success, invalidate `roles.detail(roleId)`, `roles.list`, `roles.users(roleId)`, and iterate the cached `roles.users(roleId)` list to invalidate `users.effectivePermissions(userId)` for each.
   - Add a `/me/permissions` endpoint + `meQueryOptions` invalidation so the current session's UI gating updates immediately.

7. **Missing RLS verification on existing tables (minor).** Before shipping time-bound columns, verify `user_role_assignments` has RLS policies (it does per 00003). Ensure new columns are covered by existing `using (tenant_id = current_tenant_id())` clauses.

8. **Catalog additions (minor).** Grep of `apps/api/src/modules/` surfaces additional admin surfaces not in the plan's module list: `notifications` (user prefs — probably tenant-admin scope), `tags` (ticket + asset tagging), `activity/comments` (ticket comments — but scope flows from tickets), `attachments`. Decision: add `notifications`, `tags`; skip `comments`/`attachments` (they inherit from parent ticket's permission).

9. **Enterprise features deferred to Phase 2 (not blockers for initial ship).** Impersonation, API-keys / service accounts, separation-of-duties, role-change approval workflows, delegation. Called out separately as a Phase 2 addendum — the Phase 1 design doesn't preclude any of them.

## 8.2 Corrected evaluator SQL

Replaces section 4.1:

```sql
create or replace function public.user_has_permission(
  p_user_id uuid,
  p_tenant_id uuid,
  p_permission text
) returns boolean
language sql stable
as $$
  with
    norm as (
      select lower(replace(coalesce(p_permission, ''), ':', '.')) as key
    ),
    parts as (
      select
        key,
        split_part(key, '.', 1) as resource,
        split_part(key, '.', 2) as action,
        array_length(regexp_split_to_array(key, '\.'), 1) as segment_count
      from norm
    )
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.roles r on r.id = ura.role_id
    cross join parts p
    where ura.user_id = p_user_id
      and ura.tenant_id = p_tenant_id
      and ura.active = true
      and r.active = true
      and (ura.starts_at is null or ura.starts_at <= now())
      and (ura.ends_at is null or ura.ends_at > now())
      and p.segment_count = 2
      and p.resource <> '' and p.action <> ''
      and coalesce(r.permissions, '[]'::jsonb) ?| array[
        p.key,
        p.resource || '.*',
        '*.' || p.action,
        '*.*'
      ]
  );
$$;
```

Uses `?|` (match any key in array) to collapse the four OR checks into one index-friendly operation.

## 9. Risks and open questions

- **Legacy caller sweep.** Every hardcoded permission literal in `apps/api/**` must be rewritten. Risk of missing a caller → dev user loses access after migration. Mitigation: grep for `:read_all`, `:write_all`, `:manage`, `:access` in `apps/api/src/` before shipping.
- **RLS policies referencing old keys.** If any RLS policy calls `user_has_permission` with a colon-form string, it will silently return false after rewrite. Mitigation: grep `user_has_permission(` across migrations and update any string args.
- **PostgREST schema cache.** New function signature + new table → `notify pgrst, 'reload schema';` after every remote push.
- **Requester tier.** The "Requester" template grants `tickets.read` but requesters see only their own tickets via the Participant tier of `ticket_visibility_ids`, not via the role permission. Ensure the evaluator change doesn't accidentally broaden requester visibility. Mitigation: add an integration test covering "requester with only `tickets.read` + no scope" sees only their own tickets.
- **Catalog drift.** If a new permission is added in TS but not seeded in any template, existing roles can't grant it until someone clicks "Edit role". Accept as expected — no DB action needed.
- **Multi-tenant seeding.** The template migration loops all tenants; must be idempotent (ON CONFLICT DO NOTHING on role name within tenant).
