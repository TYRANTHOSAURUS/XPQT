# Visibility Scoping — Design Spec

**Status:** Draft for implementation.
**Date:** 2026-04-20.
**Scope:** Pass 3 (the fourth routing-related axis: *visible by policy*). Closes the documented gap where `GET /tickets` returns all tenant rows.
**Non-goals:** Reporting service scoping, bulk-update scoping, search endpoint, RLS defense-in-depth (all deferred — see §9).

---

## 1. Goal

Every ticket read and every per-ticket write must verify that the current user is allowed to see (and, for writes, modify) the ticket. Policy is layered, admin-configurable, and extensible to the Phase 4 vendor portal without redesign.

## 2. Background

Today `GET /tickets` returns every row in the tenant. The data model already has:

- `user_role_assignments` with `domain_scope text[]`, `location_scope uuid[]`, and `read_only_cross_domain boolean`.
- `teams` with `domain_scope` / `location_scope`; `team_members` mapping users to teams.
- `tickets` with `requester_person_id`, `assigned_team_id`, `assigned_user_id`, `assigned_vendor_id`, `watchers uuid[]`.
- `roles.permissions jsonb` for role-level permission flags.
- `spaces.parent_id` for the location tree.

What's missing is the **policy** that joins these signals into "can this user see / modify this ticket?"

The existing tenant-isolation RLS stays as-is — it's an unconditional `tenant_id` predicate and not what this pass changes.

## 3. Policy model — three tiers

### 3.1 Participants (always visible)

A user sees any ticket where **any** of the following is true:

| Signal | Column / source |
|---|---|
| Requester | `tickets.requester_person_id = user.person_id` |
| Personal assignee | `tickets.assigned_user_id = user.id` |
| Watcher | `user.person_id = ANY(tickets.watchers)` |
| Dispatched vendor | user is linked to a vendor via `persons.external_source='vendor'` (existing convention) AND `tickets.assigned_vendor_id = that vendor` — Phase 4 will refine |

These paths never narrow. A participant can always see their ticket regardless of role or scope. Participants can always write *their* participant actions (e.g., requester can comment externally, watcher can unsubscribe). Stricter write gates (status change, reassignment) still apply below.

### 3.2 Operators (scope-configurable)

A user additionally sees a ticket if **any** of:

| Signal | Condition |
|---|---|
| Team member | `user.id IN team_members.user_id WHERE team_id = tickets.assigned_team_id` |
| Role domain match | `tickets.domain (or request_type.domain) ∈ any active user_role_assignments.domain_scope` (empty array = all domains) |
| Role location match | `tickets.location_id` is a descendant of (or equal to) any space in `user_role_assignments.location_scope`. Empty array = all locations. Hierarchical — walk `spaces.parent_id` chain. |

Role matches compose by intersection within a single role row (domain AND location), union across role rows (this role grants OR that role grants). If a user has a role with `location_scope = []` (all locations) and another with `location_scope = [Building A]`, they see tickets everywhere because the first covers everything.

### 3.3 Overrides (permissions)

`roles.permissions jsonb` can carry:

| Permission | Effect |
|---|---|
| `tickets:read_all` | Bypass the visibility clause entirely. See every ticket in the tenant. Intended for platform admins, central desk leads, compliance/audit. |
| `tickets:write_all` | Bypass the `read_only_cross_domain` write gate. Can modify anything you can see. |

A user has a permission if it appears in the `permissions` array of ANY active role assigned to them. Permissions are tenant-scoped (they live on `roles` which are tenant-scoped).

### 3.4 Read vs write

**Read:** Participant OR Operator OR `tickets:read_all`.

**Write** (per-ticket, i.e., endpoints on `/tickets/:id/*`): stricter:

- Participant path → write allowed.
- Operator path → write allowed **only if** no active role assignment that grants the match has `read_only_cross_domain = true`.
- `tickets:write_all` → bypass the read_only gate.

This matches spec §30 "least privilege" and the schema's `read_only_cross_domain` signal: you can see for awareness, but modifying requires explicit authority.

## 4. Enforcement layer — API, not RLS (for Phase 1)

### 4.1 Decision

Enforce in `TicketService` via two shared helpers. Keep the existing tenant RLS (`tenant_id = current_tenant_id()`) unchanged.

### 4.2 Why API-layer over RLS

- **Performance.** The visibility predicate is a 6-way OR with array/descendant checks. Multi-join RLS policies on every `tickets` query are slow, opaque, and fight the planner. API-layer lets us index and shape queries deliberately.
- **Debuggability.** "Why do I see this ticket?" in TypeScript is a readable code path; in plpgsql it's an opaque trace.
- **Extensibility.** The Phase 4 vendor portal needs a different scope source (vendor users). Extending one helper function beats adding more RLS conditions.
- **Spec alignment.** §4.2 argues for RLS because tenant isolation can't be forgotten. That argument is about tenant_id, a simple unconditional predicate — which stays RLS. Per-user visibility is a different shape; the spec doesn't mandate it be RLS.
- **Defense in depth** (Phase 2 option). If an audit or breach demands it, we can add a tickets RLS policy later that calls the same helpers via a plpgsql SECURITY DEFINER function. No schema change; the app keeps working.

### 4.3 The two helpers

```typescript
// In apps/api/src/modules/ticket/ticket-visibility.service.ts (new).

export interface VisibilityContext {
  user_id: string;
  person_id: string | null;
  tenant_id: string;
  team_ids: string[];
  role_assignments: Array<{
    domain_scope: string[];          // empty = all
    location_scope_closure: string[]; // expanded via space tree
    read_only_cross_domain: boolean;
  }>;
  vendor_id: string | null;           // if linked via person external_source
  has_read_all: boolean;
  has_write_all: boolean;
}

export class TicketVisibilityService {
  // Loads the user's context once per request (cached in AsyncLocalStorage or request-scoped).
  loadContext(userId: string): Promise<VisibilityContext>;

  // Builds a Supabase filter applied to any list/detail/children/activities query.
  // Takes the base query, attaches: .or('requester_person_id.eq.X,assigned_user_id.eq.Y,...')
  // as a single OR clause.
  applyReadFilter<Q>(query: Q, ctx: VisibilityContext): Q;

  // Per-ticket write gate. Throws ForbiddenException if the user can't write this ticket.
  // `mode: 'read'` = visibility only. `mode: 'write'` = visibility + read_only_cross_domain honored.
  async assertVisible(ticketId: string, ctx: VisibilityContext, mode: 'read' | 'write'): Promise<void>;
}
```

### 4.4 Location-scope closure

On `loadContext`, for each `user_role_assignments.location_scope`, walk the space tree and return the union of all descendant space ids. Cap depth at the same 10-hop limit the resolver uses. Cache the result per-request (the same user's role_scopes don't change mid-request).

```typescript
async function expandLocationScope(rootIds: string[]): Promise<string[]> {
  // Single recursive CTE or iterative breadth walk over spaces.
  // Returns a deduplicated array including the roots themselves.
}
```

### 4.5 Read-filter shape

For Supabase JS client, `applyReadFilter` attaches a `.or()` with the list of OR conditions. For `has_read_all = true`, return the query unchanged. Otherwise:

```typescript
const conditions = [
  `requester_person_id.eq.${ctx.person_id}`,
  `assigned_user_id.eq.${ctx.user_id}`,
  `watchers.cs.{${ctx.person_id}}`, // contains, Postgres array operator
  ctx.team_ids.length > 0 ? `assigned_team_id.in.(${ctx.team_ids.join(',')})` : null,
  ctx.vendor_id ? `assigned_vendor_id.eq.${ctx.vendor_id}` : null,
];
// Role paths: flatten domain x location across role_assignments into a single OR.
for (const role of ctx.role_assignments) {
  // domain condition, location condition — combine with AND inside one group
}
query.or(conditions.filter(Boolean).join(','));
```

Because Supabase's `.or()` doesn't compose AND within nested groups cleanly, the role paths expand to a UNION query via a view OR we do a two-stage query: one to select ticket ids the user can see, then fetch. For Phase 1 we'll use **option B** (a SQL function `user_visible_ticket_ids(user_id)` called from TS) to keep the complex predicate in SQL where it belongs, while the app still owns the decision.

### 4.6 Actual implementation choice

**A SECURITY DEFINER SQL function** `public.ticket_visibility_ids(p_user_id uuid, p_tenant_id uuid)` that returns `SETOF uuid`. API calls it via `.rpc()` or inlines as an `.in(...)` filter:

```sql
-- In a new migration.
create or replace function public.ticket_visibility_ids(p_user_id uuid, p_tenant_id uuid)
returns setof uuid
language sql stable security definer
as $$
  -- The one canonical predicate. Returns ticket ids the user can READ.
  -- Write authorization uses a separate function (see §4.7).
  select t.id
  from public.tickets t
  ...
$$;
```

Why a SQL function over an inline `.or()`:
- Single place to maintain the predicate. Every caller gets it right.
- Postgres can optimize the UNION of simple predicates.
- If we ever add RLS, the policy calls the same function.

The service's `applyReadFilter` becomes `.in('id', supabase.rpc('ticket_visibility_ids', {...}))` — trivial.

### 4.7 Write gate

`assertVisible(ticketId, ctx, 'write')`:

1. Check `has_write_all` → allow.
2. Load the ticket (single row).
3. Evaluate Participant paths (requester/assignee/watcher/vendor) → if any match, allow.
4. Evaluate Operator paths. For each matching role assignment, require `read_only_cross_domain = false`. Any single non-readonly match allows. Team membership is treated as operator-level with `read_only_cross_domain = false` by default (team members act on their team's tickets).
5. No match → `ForbiddenException`.

This is called from every per-ticket endpoint before the mutation runs.

## 5. Endpoints in scope

| Endpoint | Enforcement |
|---|---|
| `GET /tickets` | `applyReadFilter` on the list query |
| `GET /tickets/:id` | `assertVisible(id, ctx, 'read')` before returning |
| `GET /tickets/:id/children` | `assertVisible(parentId, ctx, 'read')`, then filter children the same way |
| `GET /tickets/:id/activities` | `assertVisible(id, ctx, 'read')` |
| `GET /tickets/tags` | `applyReadFilter` on the underlying distinct-tags query |
| `PATCH /tickets/:id` | `assertVisible(id, ctx, 'write')` |
| `POST /tickets/:id/reassign` | `assertVisible(id, ctx, 'write')` |
| `POST /tickets/:id/dispatch` | `assertVisible(id, ctx, 'write')` |
| `POST /tickets/:id/activities` | `assertVisible(id, ctx, 'write')` (adding internal note = write) |
| `POST /tickets/:id/attachments` | `assertVisible(id, ctx, 'write')` |

Existing endpoints that don't touch tickets directly (teams, spaces, request types, etc.) are out of scope.

`POST /tickets` (create) is unaffected — users always create as themselves; becoming the requester immediately makes it visible via the Participant path.

## 6. Admin and operator experience

### 6.1 Debug endpoint

`GET /tickets/:id/visibility-trace` (read-only; requires `tickets:read_all`) returns:

```json
{
  "user_id": "…",
  "ticket_id": "…",
  "visible": true,
  "matched_paths": ["team", "role:role-fm-east"],
  "read_only": false,
  "has_read_all": false,
  "has_write_all": false
}
```

Used for support ("why can I see this?" / "why can't I?").

### 6.2 Seed behavior

Existing tenant seed scripts must grant the default admin role `tickets:read_all` + `tickets:write_all`. This is a one-line permissions update in the seed migration. Without it, the admin who owns a fresh tenant sees nothing until they configure scope.

### 6.3 Frontend impact

No frontend code change is strictly required — the list endpoint simply returns fewer rows. However:

- The sidebar's filter chips (`status_category`, `priority`, `team`, etc.) continue to work within the visibility subset.
- If a user drills into a ticket via a saved URL they no longer have access to, they get a 403 instead of a row — frontend should render "You don't have access to this ticket" rather than a generic error.
- Add that one error state in `ticket-detail.tsx`. Otherwise no UI changes.

## 7. Living documentation

Create `docs/visibility.md` mirroring the shape of `docs/assignments-routing-fulfillment.md`:

1. Mental model (three tiers).
2. Entities table.
3. Read algorithm.
4. Write algorithm.
5. Location-scope closure (hierarchical).
6. Permissions (`tickets:read_all`, `tickets:write_all`).
7. Debug recipes (SQL + API).
8. What's intentionally not solved yet (reporting, bulk, vendor portal).
9. When to update (trigger list of files).

Update `CLAUDE.md`:
- Add a short "Visibility" section pointing at the new doc.
- Extend the existing "always update this file" rule to include the trigger list for visibility.

## 8. Testing

### 8.1 Backend

New test file `apps/api/src/modules/ticket/ticket-visibility.service.spec.ts`. One test per policy path, using stubbed context:

- Participant: requester sees own, non-requester doesn't.
- Participant: watcher sees, non-watcher doesn't.
- Participant: personal assignee sees.
- Operator: team member sees team's ticket.
- Operator: role domain match sees; non-matching doesn't.
- Operator: role location scope covers descendant space.
- Operator: role location scope = empty means all locations.
- Override: `has_read_all` bypasses predicates.
- Write gate: operator with `read_only_cross_domain = true` is blocked on write, allowed on read.
- Write gate: `has_write_all` bypasses read-only.
- Assert: `assertVisible('write')` throws ForbiddenException when user has no matching path.

Also update existing `ticket.controller.spec.ts` to stub the new visibility service and verify each endpoint calls it.

### 8.2 Manual

Run `pnpm dev`. Log in as three different users representing three paths (a regular requester, a team member, an admin with `read_all`). Verify each sees only what they should. Switch to a work order they don't own and confirm the detail route returns a 403 that the UI renders cleanly.

## 9. Non-goals (explicit deferrals)

- **Reporting service visibility.** `reporting.service.ts` queries tenant-wide for dashboard counts. Admin-facing today; deferred.
- **Bulk update visibility.** `PATCH /tickets/bulk/update` is not gated. Will be a follow-up; low risk because bulk ops are rare and typically admin-only.
- **Search endpoint.** No user-facing global search exists yet; when it's added, it filters through `applyReadFilter`.
- **Vendor portal (Phase 4).** Same helper will be extended — vendor users get a context with `vendor_id` set and no team memberships. No changes needed to the policy model now.
- **RLS defense-in-depth.** Add later by wrapping the same SQL function in an RLS policy. No app change.
- **Per-activity visibility (internal vs external notes).** The `ticket_activities.visibility` column already restricts internal notes on the portal side. This spec doesn't change that — only adds the ticket-level gate above it.

## 10. Success criteria

- `GET /tickets` with no `read_all` permission returns only tickets the user matches via at least one of the 6 paths.
- `PATCH /tickets/:id` for a ticket the user can't see returns 403, not 200 or 404.
- Admin users with `tickets:read_all` see and modify everything as before.
- A user with a `read_only_cross_domain = true` role can read cross-domain tickets and gets 403 on write.
- New `docs/visibility.md` exists and is linked from CLAUDE.md.
- Existing API test suite stays green (add new tests for the new paths).
- Web build stays clean; `ticket-detail.tsx` renders a friendly 403 state.

## 11. File map

| File | New / Modified | Responsibility |
|---|---|---|
| `supabase/migrations/0003X_visibility_fns.sql` | New | `ticket_visibility_ids(user_id, tenant_id)` SQL function + supporting indexes. |
| `apps/api/src/modules/ticket/ticket-visibility.service.ts` | New | `TicketVisibilityService` — `loadContext`, `applyReadFilter`, `assertVisible`. |
| `apps/api/src/modules/ticket/ticket-visibility.service.spec.ts` | New | Unit tests, one per path. |
| `apps/api/src/modules/ticket/ticket.service.ts` | Modified | Every read + write method calls the new helpers. |
| `apps/api/src/modules/ticket/ticket.controller.ts` | Modified | Add `GET /tickets/:id/visibility-trace` (optional, gated by `tickets:read_all`). |
| `apps/api/src/modules/ticket/ticket.module.ts` | Modified | Register `TicketVisibilityService`. |
| `apps/api/src/modules/ticket/ticket.controller.spec.ts` | Modified | Stub visibility service in existing tests. |
| `apps/api/src/common/auth/` (existing) | Possibly modified | If `loadContext` needs current `user_id` / `person_id`, use whatever pattern the existing auth guard exposes. |
| `apps/web/src/components/desk/ticket-detail.tsx` | Modified | Render a 403 state when the detail fetch returns forbidden. |
| `docs/visibility.md` | New | Living reference. |
| `CLAUDE.md` | Modified | Add Visibility section + update trigger list. |
| Tenant seed migration (existing) | Modified | Grant `tickets:read_all` + `tickets:write_all` to default admin role. |

## 12. Open points

- **Vendor linking.** The Participant path "dispatched vendor" presumes a user is linked to a vendor via the `persons.external_source` field. This isn't rigorously implemented today; Phase 4 vendor portal will formalize it. For Phase 1 visibility, the path is wired but effectively dormant.
- **Watcher data type.** `tickets.watchers uuid[]` stores person ids (the type comment in the schema says so). `applyReadFilter` uses the user's `person_id` against it — confirm during implementation.
- **Team scope as read-only.** The spec doesn't say team membership is ever read-only. Plan assumes write is always permitted when you're in the assigned team. If clients later want read-only team viewers, add `team_members.read_only` column; out of scope now.
