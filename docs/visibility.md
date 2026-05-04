# Visibility

This document is the operational reference for **who can see which records** in Prequest. Tickets are the canonical case (and most of this document is written from that lens), but visitor management adds a second tier-1 visibility predicate that follows the same three-tier shape — see §9.

Visibility is the fourth axis of the routing model (routing / ownership / execution / **visibility**) and is enforced independently of routing.

## 1. Mental model — three tiers

| Tier | Who it covers | Can write? |
|---|---|---|
| **Participants** | Requester · personal assignee · watcher · dispatched vendor | Yes (subject to the specific write's own semantics) |
| **Operators** | Team member of assigned team · user whose role's `domain_scope` covers the ticket's domain · user whose role's `location_scope` covers the ticket's location (hierarchically) | Team: yes. Role: yes unless `read_only_cross_domain = true`. |
| **Overrides** | `roles.permissions` contains `tickets:read_all` (see everything) or `tickets:write_all` (modify everything) | Yes |

A user can read a ticket if **any** tier matches. Can write if participant or (non-readonly operator) or write-all.

## 2a. How a user enters each tier

- **Participants** — becomes the `requester_person_id`, gets dispatched as `assigned_user_id` / `assigned_vendor_id`, is added to `watchers` manually, OR is the previous user-assignee on a reclassified ticket (reclassify automatically promotes the previous user-assignee to the watchers array — this is a non-manual path into the Participants tier). See `docs/assignments-routing-fulfillment.md` §12a.
- **Operators** — is a `team_members` row on the ticket's `assigned_team_id`, OR has a `user_role_assignments` row whose `domain_scope` + `location_scope` covers the ticket.
- **Overrides** — has a role whose `permissions` jsonb contains `tickets:read_all` / `tickets:write_all`.

## 2. Core entities

| Table / column | Role |
|---|---|
| `users.id`, `users.person_id`, `users.auth_uid` | Identity; the Supabase auth uid maps to a `users` row per tenant. |
| `team_members(team_id, user_id)` | Team path source. |
| `user_role_assignments(user_id, role_id, domain_scope[], location_scope[], read_only_cross_domain)` | Operator path source; controls domain + location scope and whether it grants write. |
| `roles.permissions jsonb` | Override source. |
| `tickets.requester_person_id`, `assigned_user_id`, `assigned_team_id`, `assigned_vendor_id`, `watchers uuid[]` | Participant + team paths. |
| `request_types.domain` | Role-domain match is against the ticket's request type's domain. |
| `spaces.parent_id` | Hierarchical location closure walk. |

## 3. The SQL predicate

`public.ticket_visibility_ids(p_user_id uuid, p_tenant_id uuid)` returns `SETOF uuid` — the set of ticket ids visible to a user. It's the single source of truth for read visibility.

`public.tickets_visible_for_actor(p_user_id uuid, p_tenant_id uuid, p_has_read_all boolean default false)` (migration 00187) wraps the predicate in a `SETOF tickets` RPC so the API can chain PostgREST filters/sort/pagination directly on visible rows. This is the preferred path for set-based reads (`TicketService.list`, `listDistinctTags`, `getChildTasks`) — it pushes the visibility join into Postgres instead of materializing the full visible-ticket-id set in Node and feeding it back as `.in('id', ids)`. The latter pattern is pathological for tenants with large visible sets (megabytes of UUIDs over the wire + a giant IN list for the planner). When `p_has_read_all = true` the wrapper short-circuits the predicate join entirely.

`public.expand_space_closure(p_roots uuid[])` — recursive CTE over `spaces.parent_id`. Used both inside `ticket_visibility_ids` (for role location matches) and by the application (to precompute `role.location_scope_closure` on load).

`public.user_has_permission(p_user_id, p_tenant_id, p_permission)` — checks the `roles.permissions` jsonb for any active role assigned to the user.

## 4. The enforcement helpers (TypeScript)

`TicketVisibilityService` in `apps/api/src/modules/ticket/ticket-visibility.service.ts`:

| Method | Purpose |
|---|---|
| `loadContext(authUid, tenantId)` | Resolves the Supabase auth uid → full `VisibilityContext` (user_id, person_id, teams, roles with expanded location closure, permissions). Call once per request. |
| `getVisibleIds(ctx)` | Returns `string[] | null` — the list of visible ticket ids, or `null` if the user has `tickets:read_all` (meaning: no filter). **Avoid for set-based reads** — prefer `tickets_visible_for_actor` (§3) so the predicate stays in SQL. Still available for paths that genuinely need the id list in TS (counts, dedup against another set). |
| `assertVisible(ticketId, ctx, mode)` | Loads the ticket and evaluates paths. `mode = 'read'` or `'write'`. Throws `ForbiddenException` on denial. Called by every per-ticket endpoint (detail, PATCH, reassign, dispatch, addActivity, attachments). |
| `assertCanPlan(ticketId, ctx)` | Narrower than write. Allows: WO assignee, assigned vendor, member of the WO's or parent case's `assigned_team_id`, role operator with non-readonly write scope, or `tickets.write_all`. **Excludes** requester, watcher, and readonly cross-domain roles. Used by `PATCH /tickets/:id/plan` (plandate) and exposed read-only via `GET /tickets/:id/can-plan` so the UI can gate the affordance. |
| `trace(ticketId, ctx)` | Explainer for the debug endpoint. |

## 5. Debug recipe

As a user with `tickets:read_all`, call:

```
GET /tickets/:id/visibility-trace
```

Response:
```json
{
  "user_id": "u1",
  "ticket_id": "tk-123",
  "visible": true,
  "matched_paths": ["team", "role[0]"],
  "readonly_role": false,
  "has_read_all": false,
  "has_write_all": false
}
```

## 6. System actors

Internal service-to-service calls (workflow engine, approvals, resolver callbacks) pass the exported `SYSTEM_ACTOR` constant instead of a real auth uid. `TicketService` methods bypass the visibility check in that case. This keeps background jobs working without a user context.

## 7. What's intentionally not solved yet

- **Reporting service.** `reporting.service.ts` queries tenant-wide for dashboard counts. Admin-facing; not yet filtered.
- **Bulk updates.** `PATCH /tickets/bulk/update` doesn't call `assertVisible`. Rare and typically admin — follow-up.
- **Search endpoint.** Not yet built; when added, use `getVisibleIds`.
- **Vendor-participant path (Phase 4).** Currently returns no rows. The schema doesn't link a person to their specific vendor; Phase 4 will formalize. Users with `persons.external_source='vendor'` must rely on team membership or role scope for now.
- **RLS defense-in-depth.** Possible Phase 2 addition. The tenant-isolation RLS stays; a per-user visibility RLS policy can be added later that calls `ticket_visibility_ids` from a `SECURITY DEFINER` function.
- **Per-activity visibility.** `ticket_activities.visibility` (internal/external/system) is a separate concern and remains unchanged.

## 9. Visitor visibility

Visitor management ships its own three-tier predicate that mirrors the ticket model. Same shape, different population paths.

### 9.1 The SQL predicate

`public.visitor_visibility_ids(p_user_id uuid, p_tenant_id uuid)` returns `SETOF uuid` — the set of visitor ids visible to a user. It's the single source of truth for read visibility on the `visitors` table.

Canonical predicate file: `supabase/migrations/00255_visitor_visibility_ids_function.sql` (initial), with bug-fix follow-ups in `00259_fix_visitor_visibility_ids.sql` (and any later `*_fix_visitor_visibility_ids*` migration — check `git log` for the latest before editing).

### 9.2 Three tiers

| Tier | Who it covers | How they enter the tier |
|---|---|---|
| **Hosts** | `visitors.primary_host_person_id` is the user's `person_id`, OR a row in `visitor_hosts` with `person_id = user.person_id` | Created at invite time (primary host) or added via the multi-host UI (co-hosts). |
| **Operators** | Has `roles.permissions` containing `visitors.reception` AND the visitor's `building_id` is inside their `location_scope` (via `org_node_location_grants` + `user_role_assignments`) | Tenant admin grants the role at `/admin/users/roles`. Defaults OFF — opt-in per the v1 spec §13.1. |
| **Read-all override** | Has `roles.permissions` containing `visitors.read_all` | Admin role only. Sees every visitor in the tenant regardless of building scope. |

A user can read a visitor row if **any** tier matches. Write paths (check-in, check-out, status transitions) are gated by service-level checks — see `VisitorService` for the per-action authorization rules.

### 9.3 Permissions are dot-form

The visitor permission keys in `roles.permissions` are stored dot-form: `visitors.invite`, `visitors.reception`, `visitors.read_all`. The v1 design spec narrative occasionally used colon-form (`visitors:reception`); that was a documentation bug. The actual stored shape is dot-form, matching the rest of the catalog. The function `public.user_has_permission` accepts the stored shape verbatim.

### 9.4 What this section does NOT yet cover

- **Vendor-as-host.** External vendors are not first-class hosts in v1. If a tenant invites a vendor as a contractor visitor, the vendor is the *visitor*, not a host. Vendor visibility for vendor-side surfaces (vendor portal Phase B) follows the vendor module's separate model.
- **Per-building lens for desk users.** `/desk/visitors` filters to visitors tied to active tickets the user can see (intersect with ticket visibility) — that intersection is enforced at the API layer, not in the SQL predicate.

## 10. When to update this document

Update this document in the same PR as any change to:

- `apps/api/src/modules/ticket/ticket-visibility.service.ts`
- `apps/api/src/modules/ticket/ticket.service.ts` (read/write methods or their signatures)
- `apps/api/src/modules/ticket/ticket.controller.ts` (routing of `req.user.id` into the service)
- `apps/api/src/modules/ticket/reclassify.service.ts` — because reclassify mutates `watchers` (Participants tier).
- `apps/api/src/modules/visitors/visitor.service.ts` — read paths use `visitor_visibility_ids` as the canonical predicate; changes to the read shape or the supplementary scope filters belong here.
- Any migration that alters: `ticket_visibility_ids`, `visitor_visibility_ids`, `expand_space_closure`, `user_has_permission`, `users`, `user_role_assignments`, `team_members`, `roles`, or the tickets/visitors columns used by either predicate.
- New permission strings on `roles.permissions` (especially the `visitors.*` family).

## 11. Slot vs. booking visibility

Phase 1.4 (slot-first scheduler, 2026-05-04) introduced a slot-targeted edit path (`PATCH /reservations/:bookingId/slots/:slotId`) but did NOT introduce a slot-level visibility gate. Slot-level visibility derives entirely from booking-level: a user who passes `assertVisible(reservation, ctx)` against the parent booking can read all of its slots, and a user who passes `canEdit(reservation, ctx)` can `editSlot` on any of its slots — the booking is the unit of authorisation.

Concretely, `ReservationService.editSlot(bookingId, slotId, actor, patch)` runs the auth gate against the parent booking (via `findByIdOrThrow(bookingId, tenantId)` + `assertVisible` + `canEdit`) BEFORE the RPC fires. There is no per-slot ACL or per-slot read filter — and we don't expect to add one: multi-room bookings are designed to be atomic, so a user who can edit "the booking" can edit any of its slots.

The slot-edit RPC (`edit_booking_slot`, 00291) double-checks tenant scope at the row level (the `tenant_id` filter on the `booking_slots` update), but tenant scope is not a visibility gate — it's the cross-tenant isolation invariant. The reservation visibility gate (`rooms.read_all` / `rooms.write_all` / `rooms.admin` / requester / host / booker) is the visibility model and applies booking-wide.
