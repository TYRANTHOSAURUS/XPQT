# Assignments, Routing & Fulfillment

This document is the operational reference for how Prequest decides **who handles a ticket**, **under which SLA**, and **how work is split between a coordinating team and the actual executor** (internal person or external vendor).

Keep four axes separate in your head. Mixing them is how ticketing systems turn into ServiceNow:

| Axis | Answers | Where it lives |
|---|---|---|
| **Routing** | Given this request type, location, asset, priority — where does the ticket go? | `ResolverService` + `routing_rules` |
| **Ownership** | Which team is accountable to the requester? | Parent case's `assigned_team_id` |
| **Execution** | Who actually does the work? | Child work orders' assignees (user/vendor) |
| **Visibility** | Who is allowed to read / act on this ticket? | Query-layer scoping (RLS, list filters) — *separate concern, not covered here* |

---

## 1. Core entities

### Database

| Table | Purpose |
|---|---|
| `tickets` | Central operational row. `ticket_kind` ∈ (`case`, `work_order`). `parent_ticket_id` links a work order to its case. |
| `request_types` | Catalog entry that configures *how a ticket is handled*: domain, fulfillment strategy, defaults, SLA, workflow. |
| `teams` | Internal groups (service desks, FM squads, etc.). Primary assignees for cases. |
| `vendors` | External providers. First-class assignees alongside teams. |
| `location_teams` | `(space_id XOR space_group_id) × domain → team_id or vendor_id`. The location-based routing map. |
| `space_groups` / `space_group_members` | Lets admins treat a set of unrelated spaces as one routing target. |
| `domain_parents` | Per-tenant `(domain → parent_domain)` rows. Enables cross-domain fallback (e.g. `doors → fm`). |
| `routing_rules` | Condition-based overrides evaluated **before** the resolver chain. First active match wins. |
| `routing_decisions` | Immutable audit log of every resolver run: trace, chosen path, rule ID, context snapshot. |
| `sla_policies` | Response/resolution minutes, business hours calendar, pause reasons, escalation config. |
| `asset_types` / `assets` | Asset type carries `default_team_id` / `default_vendor_id`. A specific asset can override with `override_team_id` / `override_vendor_id`. |

### Services

| Service | Role |
|---|---|
| `ResolverService` (`apps/api/src/modules/routing/resolver.service.ts`) | The fulfillment engine. Runs the rules pre-step + strategy-based resolution chain. Returns a `ResolverDecision`. |
| `ResolverRepository` (same folder) | Thin DB layer: loads request type, asset, location chain, space group hits, domain chain, routing rules. |
| `RoutingService` (same folder) | Façade: calls the resolver, writes `routing_decisions`. Not where logic lives. |
| `TicketService.runPostCreateAutomation` | Auto-routes a **newly created case** when no assignee was passed in the DTO. Skips for work orders. |
| `DispatchService` (`apps/api/src/modules/ticket/dispatch.service.ts`) | Creates a child **work order** from a parent case. Copies context, optionally runs the resolver, starts SLA timers, logs a `dispatched` activity on the parent. |
| `SlaService` (`apps/api/src/modules/sla/...`) | Starts, pauses, and breaches SLA timers based on the request type's `sla_policy_id`. |

---

## 2. `request_types` is the center of the model

Every operational decision derives from the ticket's request type. Key columns:

| Column | Drives |
|---|---|
| `domain` | Which `location_teams(space, domain)` rows are candidates. Also the seed of the **domain fallback chain**. |
| `fulfillment_strategy` | Which branches of the resolver are active: `fixed` \| `asset` \| `location` \| `auto`. |
| `default_team_id` / `default_vendor_id` | Terminal fallback assignee when every other branch misses. |
| `sla_policy_id` | SLA applied on ticket creation (and on dispatch-created work orders). |
| `workflow_definition_id` | Workflow that orchestrates approvals, notifications, sub-task fan-out. |
| `form_schema_id` | Form fields on the requester-facing portal. |
| `requires_asset` / `requires_location` (+ `_required`) | Portal form gates. |

A single request type can therefore say: *"This is a `doors` request. Route by location (with `fm` fallback). If nothing specific, goes to Facilities. SLA is 4h response / 24h resolution. Start the door-repair workflow."*

---

## 3. The resolver algorithm

`ResolverService.resolve(context)` always runs this sequence, in order, first match wins:

```
1. Routing rules pre-step
2. Asset branch           (when strategy ∈ {asset, auto})
3. Location branch        (when strategy ∈ {location, auto})
4. Request type default
5. Unassigned
```

Every step appends a `TraceEntry` to the decision's trace — whether it matched or not — so debugging later is always possible.

### 3.0 When the resolver runs

| Trigger | Where | Notes |
|---|---|---|
| Ticket create | `TicketService.runPostCreateAutomation` | Skipped if `ticket_kind = 'work_order'` or if the ticket already has an assignee in the DTO. |
| Approval granted | `TicketService.onApprovalDecision('approved')` | Delegates to `runPostCreateAutomation`. |
| Manual reassign with rerun | `TicketService.reassign({ rerun_resolver: true })` | Clears current assignment, re-evaluates, records a new `routing_decisions` row. |
| Workflow-spawned child | `WorkflowEngineService.create_child_tasks` → `DispatchService.dispatch` | Goes through the full resolver + SLA + audit pipeline, same as manual dispatch. |
| Manual dispatch | `DispatchService.dispatch` (called by `POST /tickets/:id/dispatch`) | Runs when the DTO doesn't supply an assignee. |

The resolver does **not** run on generic `PATCH /tickets/:id`. Changing priority, status, tags, watchers, cost, etc. does not re-route.

### 3.1 Routing rules pre-step

Loads all active `routing_rules` for the tenant, ordered by `priority DESC`. For each rule, checks its `conditions[]` against the resolver context:

```json
[{ "field": "priority", "operator": "equals", "value": "urgent" },
 { "field": "domain",   "operator": "in",     "value": ["it", "security"] }]
```

Supported operators: `equals`, `not_equals`, `in`, `not_in`, `exists`.
Context fields available: `ticket_type_id`, `request_type_id`, `domain`, `location_id`, `priority`, `asset_id`.

First rule whose conditions all match and which has a non-null assignee (`action_assign_team_id` or `action_assign_user_id`) wins. Decision emits `chosen_by: 'rule'` + `rule_id` + `rule_name`. **No further branches run.**

Rules cannot currently assign vendors — `action_assign_vendor_id` is not in the schema. This is a tracked gap.

### 3.2 Asset branch (when strategy is `asset` or `auto`)

With the asset loaded via `ResolverRepository.loadAsset`:

1. `assets.override_team_id` / `override_vendor_id` (per-asset exception). Emits `asset_override`.
2. `asset_types.default_team_id` / `default_vendor_id` (the asset type's class default). Emits `asset_type_default`.

If both are null, the branch misses and the resolver proceeds.

### 3.3 Location branch (when strategy is `location` or `auto`)

This branch is a **2D walk** over the *domain chain* (outer) × *location chain* (inner):

- **Location chain:** `ResolverRepository.locationChain(primaryLocation)` — the space and its parents, up to 10 hops. Example: `[room-101, floor-3, building-A, campus-north]`. Primary location is `context.location_id` or, if null, `asset.assigned_space_id`.
- **Domain chain:** `ResolverRepository.domainChain(tenant, domain)` — the domain and its ancestors via `domain_parents`. Example: `[doors, fm]`. Cycle-safe, capped at 10.

The inner loop at each `(domain, space)` tuple checks **two** sources:

1. `location_teams(space_id = X, domain = Y)` — the direct scope match.
2. `space_group_members(space_id = X)` → `location_teams(space_group_id IN (...), domain = Y)` — the group-based match.

The first hit wins. The emitted `chosen_by` depends on where we were:

| Domain index | Space index | Hit source | `chosen_by` |
|---|---|---|---|
| 0 (exact) | 0 (primary) | `location_teams` direct | `location_team` |
| 0 (exact) | >0 (parent) | `location_teams` direct | `parent_location_team` |
| 0 (exact) | any | `space_group_members` route | `space_group_team` |
| >0 (parent domain) | any | either | `domain_fallback` |

This is how scenarios B (shared team across unrelated locations) and E (cross-domain fallback) are solved without seeding one row per (space, domain) combination.

### 3.4 Request type default

If every prior branch missed, the resolver uses `request_types.default_team_id` / `default_vendor_id`. Emits `request_type_default`.

For `strategy = fixed`, branches 3.2 and 3.3 don't run — this step is the only assignment path.

### 3.5 Unassigned

Nothing matched. `target = null`, `chosen_by = 'unassigned'`. The ticket still gets created; a human must pick someone up.

---

## 4. Fulfillment strategies — which branches run

| Strategy | Rules | Asset | Location | RT default | Notes |
|---|---|---|---|---|---|
| `fixed` | ✓ | — | — | ✓ | "Always goes to X." Catering always → Catering Desk. |
| `asset` | ✓ | ✓ | — | ✓ | Asset-centric. Elevator repair → elevator vendor. |
| `location` | ✓ | — | ✓ | ✓ | Building-scoped. IT helpdesk per floor. |
| `auto` | ✓ | ✓ | ✓ | ✓ | Try asset first; fall back to location. For request types that *can* attach to an asset but don't require one. |

---

## 5. Scope hierarchies

### 5.1 Space hierarchy (built-in)

`spaces.parent_id` forms a tree: organization → campus → building → floor → room. The resolver walks this chain naturally — a ticket on floor 3 finds the building's FM team when no floor-specific team is seeded.

### 5.2 Space groups (for unrelated locations)

`space_groups` + `space_group_members` let an admin say: *"Buildings A, C, and F share one FM team, even though they have no common ancestor."*

- Create a `space_groups` row (`name`, `description`).
- Add one `space_group_members` row per participating `space_id`.
- Create ONE `location_teams` row with `space_group_id = <group>`, `domain = <domain>`, assignee columns set. `space_id` stays null.
- The resolver consults the group map at every step of the location chain.

### 5.3 Domain hierarchy (for cross-domain fallback)

`domain_parents(domain, parent_domain)` — one row per child domain. Example seed:

```sql
insert into domain_parents (tenant_id, domain, parent_domain) values
  (t, 'doors',    'fm'),
  (t, 'hvac',     'fm'),
  (t, 'plumbing', 'fm');
```

Now a `doors` ticket at a location that only has an `fm` team will resolve via `domain_fallback`. The chain is walked top-down: exact first, then parents. 10-hop cap. Cycle-safe.

---

## 6. Case vs Work Order — the two-level ticket model

A **case** (`ticket_kind = 'case'`) is the requester-facing ticket. One case per request.
A **work order** (`ticket_kind = 'work_order'`) is a child of a case, representing a specific unit of executor work. A case can have **zero, one, or many** work orders.

### 6.1 When each is created

- **Case** — created by `TicketService.create` from the portal or the desk. Auto-routed via the resolver to a service desk team.
- **Work order** — created by `DispatchService.dispatch(parentId, dto)` OR by a workflow's `create_child_tasks` node. Never created directly through `POST /tickets`.

### 6.2 Why this split

1. One real job can fan out to multiple executors: "broken window" → (replace pane → glazier) + (supply glass → supplier) + (cleanup → janitorial). Three work orders, one case.
2. Service desk manages the case (owner). Vendors receive only their work orders (executor). Visibility, SLA, and cost track at the work-order level.
3. `interaction_mode` and activity visibility compose naturally: requester comments on the case, internal notes on the case, external comments on the vendor's work order.

### 6.3 What `DispatchService.dispatch` does

1. Validates the parent:
   - Parent must exist (via `TicketService.getById`, throws `NotFoundException` if missing).
   - Parent must **not** be a `work_order` (cannot dispatch from a work order).
   - Parent must **not** be in `status_category = 'pending_approval'` (would bypass the approval gate).
   - DTO must have a non-empty `title`.
2. Copies parent context into the child row: `ticket_type_id`, `location_id`, `asset_id`, `priority`, `requester_person_id`. DTO fields override each.
3. Loads `(domain, sla_policy_id)` from `request_types` in a single query.
4. If DTO has no assignee AND a `ticket_type_id` is set, runs the resolver exactly once. Applies the target to the insert row (`assigned_team_id` / `assigned_user_id` / `assigned_vendor_id`) and sets `status_category = 'assigned'`.
5. Inserts the child with `ticket_kind = 'work_order'`, `parent_ticket_id = parentId`, `sla_id` already populated.
6. Post-insert (wrapped in try/catch so a partial failure doesn't orphan the child):
   - Writes the `routing_decisions` audit row (reusing the single `evaluate` result — the trace matches the assignment).
   - Starts SLA timers via `slaService.startTimers(childId, tenantId, sla_policy_id)`.
   - Appends a `system_event` activity on the **parent** with metadata `{ event: 'dispatched', child_id, assigned_* }`.

### 6.4 Parent-status rollup trigger

Migration `00030` installs `rollup_parent_status()` on `tickets AFTER INSERT OR UPDATE OF status_category WHEN ticket_kind = 'work_order' AND parent_ticket_id IS NOT NULL`. For every child status change, it:

1. Aggregates all sibling work orders under the same parent:
   - `any_in_progress` = at least one child in `in_progress`
   - `any_open` = at least one child not in `('resolved', 'closed')`
2. Decides the parent's new status:
   - `any_in_progress` → parent becomes `in_progress` (unless already terminal)
   - else `any_open` → parent becomes `assigned` (unless already terminal)
   - else (all children done) → parent becomes `resolved`, `resolved_at = coalesce(resolved_at, now())`
3. The parent **never** auto-transitions backward from `resolved`/`closed`. A human reopens explicitly.
4. `bool_or` NULLs are coalesced to `false` defensively.

This means: service desk sees the parent case move from `new` → `assigned` when dispatched, → `in_progress` when any vendor picks up, → `resolved` automatically when all vendors finish.

### 6.5 Skip auto-routing for work orders

`TicketService.runPostCreateAutomation` guards with `isWorkOrder = data.ticket_kind === 'work_order'`. Work orders carry their assignee from `DispatchService` — the generic create-path resolver must not double-route them.

### 6.6 Workflow-spawned children

Workflows with a `create_child_tasks` node also insert `ticket_kind = 'work_order'` rows. This ensures the rollup trigger fires and clients that filter `?kind=case` get clean case lists.

### 6.7 Parent close guard

A case cannot move to `status_category = 'resolved'` or `'closed'` while it has any child with `status_category` not in (`resolved`, `closed`). `TicketService.update` enforces this and returns `400 Bad Request` with the open child IDs listed in the message. Children continue to roll up into the parent via the existing `rollup_parent_status()` trigger — that's the intended path for a parent to move state, not a direct user close while vendor work is still open.

Workflows or background jobs that programmatically close cases must close children first; the guard will refuse otherwise.

---

## 7. SLA timers

**Two SLAs, two clocks, two audiences.**

| | Case (`ticket_kind = 'case'`) | Child (`ticket_kind = 'work_order'`) |
|---|---|---|
| Audience | Requester (employee) | Service desk |
| Promised by | Service desk team | Executor (vendor or internal team) |
| Source of `sla_id` | `request_types.sla_policy_id` | Resolution order below — **never** `request_types.sla_policy_id` |
| Set when | Case is created | Child is dispatched (manual or workflow) |
| Mutable when | Locked on reassign | Editable in the child's properties sidebar (timers restart) |

### Case SLA — from `request_types.sla_policy_id`

Attached at case creation. `TicketService.runPostCreateAutomation` reads `request_types.sla_policy_id` and calls `SlaService.startTimers(caseId, tenantId, slaPolicyId)` to open `sla_timers` rows for `response` and `resolution` timers, each with their own `target_minutes`, `due_at`, `business_hours_calendar_id`. Locked on reassign per the rule below.

### Child SLA — resolution order at dispatch

When a child is created (manual `POST /tickets/:id/dispatch` or workflow `create_child_tasks`), `DispatchService.resolveChildSla(dto, row)` picks the policy, first match wins:

1. **Explicit:** `dto.sla_id` was supplied (manual UI pick, or workflow node's per-task `sla_policy_id`). Pass `null` explicitly to mean "No SLA — no timer runs".
2. **Vendor default:** `assigned_vendor_id` → `vendors.default_sla_policy_id`.
3. **Team default:** `assigned_team_id` → `teams.default_sla_policy_id`.
4. **User's team default:** `assigned_user_id` → that user's `team_id` → `teams.default_sla_policy_id`.
5. **None.** `sla_id = null`. No `sla_timers` rows are created. UI surfaces this state as "No SLA".

If both `assigned_vendor_id` and `assigned_team_id` are set on the child row, the **vendor** default wins (vendor SLA is contractual; team default is internal convention).

Resolution runs after routing fills in assignees, so routing-derived assignees produce the same default behavior as manual ones.

`request_types.sla_policy_id` is **never** consulted for children — it is exclusively the case's policy.

### SLA on reassignment (both layers)

**Nothing changes on SLA when an assignee is reassigned** — via silent PATCH or `POST /tickets/:id/reassign`, manual or rerun mode. `due_at`, `sla_response_due_at`, `sla_resolution_due_at`, `sla_at_risk`, and breach timestamps all persist unchanged on both parent cases and children.

This is intentional and matches standard ITSM behavior: SLA is a promise to the requester (for cases) or to the service desk (for children), not to the specific assignee. Shuffling ownership does not reset the clock.

### Changing a child's SLA policy

To change a child's `sla_id` after dispatch: PATCH the child with `{ sla_id: '<new-policy-id>' | null }`. `TicketService.update`:
- Refuses the change on cases (`ticket_kind = 'case'` → `BadRequestException`).
- For children: calls `SlaService.restartTimers(ticketId, tenantId, newSlaPolicyId)`, which stops existing `sla_timers`, clears computed breach/due fields on `tickets`, and starts new timers from the new policy. Logs a `sla_changed` system-event activity with `from_sla_id` / `to_sla_id`.

### Shared mechanics

`sla_policies.pause_on_waiting_reasons` controls which `tickets.waiting_reason` values pause the clock. `sla_policies.escalation_thresholds` trigger notifications at % elapsed.

SLA pause/resume fires **only** on `status_category` or `waiting_reason` changes (`applyWaitingStateTransition` in `ticket.service.ts`). The per-minute `checkBreaches` cron in `sla.service.ts` is team-agnostic — it only looks at `due_at` and `paused` flags.

**Edge case worth knowing:** the business-hours calendar is attached to the **SLA policy** (`sla_policies.business_hours_calendar_id`), not the team. A 9–5 team and a 24/7 team working the same policy share the same business-minute calculation. There is no per-team calendar override today. If that matters for a product decision, it's a schema change.

### Schema additions (migration `00036`)

- `vendors.default_sla_policy_id uuid references public.sla_policies(id)` — nullable, no backfill.
- `teams.default_sla_policy_id uuid references public.sla_policies(id)` — nullable, no backfill.

---

## 8. Approval gates

A case can sit in `status_category = 'pending_approval'` while an approver weighs in (via `ApprovalService`). During that state:

- `DispatchService.dispatch` **refuses** — you cannot spawn work orders until the approval is settled. This prevents the rollup trigger from flipping the parent away from `pending_approval` prematurely.
- The resolver still runs at case creation; assignment itself is not blocked, only dispatch.

---

## 8a. Changing an assignee — audited paths

Two endpoints can change a ticket's assignee. They differ in audit trail, not in effect.

### Silent `PATCH /tickets/:id`

`UpdateTicketDto` accepts `assigned_team_id`, `assigned_user_id`, `assigned_vendor_id`. On change:
- Writes the ticket row.
- Posts a `system_event` activity (`assignment_changed`) and a `domain_events` row (`ticket_assigned`).
- **Does not** write a `routing_decisions` row.
- **Does not** require a reason.

Use when: bulk tooling, background jobs, trusted system actions where a reason is meaningless.

### Audited `POST /tickets/:id/reassign`

`ReassignDto` requires a `reason` string. Two modes:

- **Manual** (`rerun_resolver: false | undefined`): caller supplies the target assignee directly. Clears previous assignment, sets the new one.
- **Rerun resolver** (`rerun_resolver: true`): clears assignment, re-invokes `ResolverService.resolve()` with the current `{location, asset, request_type, priority, domain}` (falls back to `asset.assigned_space_id` if `location_id` is null).

Either mode:
- Writes a `routing_decisions` row with `chosen_by: 'manual_reassign'` or `'rerun_resolver'`. In rerun mode, the resolver's own trace is appended after a `manual_reassign` step so both the human reason and the machine decision are captured.
- Posts an **internal-visibility** activity (not `system_event`) with the reason in the `content` field — it shows up in the ticket timeline as a note.

Use when: a human is making the call and the reason matters for audit / ops review.

### Frontend behavior (today)

The desk sidebar's `useTicketMutation` hook (`apps/web/src/hooks/use-ticket-mutation.ts`) uses a tiered approach:

- **First-time assignment** (no previous assignee) → silent `PATCH`. No audit row — there's no previous state to explain.
- **Reassignment** (replacing an existing assignee) → `POST /tickets/:id/reassign` with a synthesized reason (`"Reassigned <kind> from X to Y by <actor> via ticket sidebar"`). Audit row captured.

This mirrors the intent of the endpoints: PATCH for initial state, reassign for state changes.

## 8b. Scope fields — not editable today

`UpdateTicketDto` deliberately omits `location_id`, `asset_id`, `ticket_type_id`, `requester_person_id`. There is no endpoint to change any of them on an existing ticket. Changing them would have cascading effects:

| Field | Cascade if changed |
|---|---|
| `location_id` | Resolver result changes (location chain differs). SLA/workflow unaffected. |
| `asset_id` | Resolver result changes (asset override path differs). SLA/workflow unaffected. |
| `ticket_type_id` | Resolver **and** SLA **and** workflow all tied to request type. SLA policy, workflow definition, approval gate, fulfillment strategy all change. High-impact. |
| `requester_person_id` | No resolver impact but changes who receives external notifications. Probably should not be mutable — effectively recreating the ticket. |

Until a scope-rerouting flow is built, these fields remain read-only in the UI. If/when we build it:

- New endpoint (probably `POST /tickets/:id/rescope`) that accepts the new field(s) + a reason, re-runs the resolver, and for `ticket_type_id` changes, restarts SLA timers and potentially the workflow instance.
- `routing_decisions` row with `chosen_by: 'rescope'` so the audit trail explains why the assignee changed.

---

## 9. Audit — `routing_decisions`

Every resolver run that goes through `RoutingService.recordDecision` writes one row:

```sql
select decided_at, strategy, chosen_by, rule_id,
       chosen_team_id, chosen_vendor_id, chosen_user_id,
       trace, context
from routing_decisions
where ticket_id = '<ticket-uuid>'
order by decided_at desc;
```

- `strategy` — `fixed` | `asset` | `location` | `auto` | `rule`.
- `chosen_by` — `rule` | `asset_override` | `asset_type_default` | `location_team` | `parent_location_team` | `space_group_team` | `domain_fallback` | `request_type_default` | `unassigned`.
- `trace` — full ordered list of every step the resolver considered, with match/miss reasons.
- `context` — snapshot of request_type / domain / priority / asset / location used.

The trace is the single source of truth for "why did this ticket land where it did?"

---

## 10. Vendors as first-class assignees

Everywhere an assignment can be a `team_id`, it can also be a `vendor_id`:

- `tickets.assigned_team_id` / `assigned_user_id` / `assigned_vendor_id` — all three exist; exactly one is typically set per ticket.
- `asset_types.default_team_id` / `default_vendor_id`
- `assets.override_team_id` / `override_vendor_id`
- `location_teams.team_id` / `vendor_id`
- `request_types.default_team_id` / `default_vendor_id`

The resolver's `pickTarget(team, vendor)` helper prefers `team` when both are set on the same source row — the case owner is always a team, vendors get dispatched children. If only a vendor is set, the vendor flows through.

Current gap: `routing_rules` cannot produce a vendor target (no `action_assign_vendor_id` column). Rules assign teams or users only.

---

## 11. Debugging recipes

### Why did this ticket land on team X?

```sql
select chosen_by, strategy, rule_id, trace
from routing_decisions
where ticket_id = '<uuid>'
order by decided_at;
```

Read `trace` top-to-bottom — each entry says which step was tried, whether it matched, and why.

### Why didn't my new `location_teams` row fire?

Common causes:
1. Migration wasn't pushed to remote. Check `tickets.ticket_kind` on remote: `select column_name from information_schema.columns where table_name='tickets' and column_name='ticket_kind'`.
2. `request_type.fulfillment_strategy` is `fixed` — the location branch never runs.
3. `request_type.domain` doesn't match your `location_teams.domain`.
4. A `routing_rules` entry is matching first — check the `chosen_by` in `routing_decisions`.
5. An asset override / asset type default resolved first (for `asset` or `auto` strategies).

### Walk the effective chain for a candidate ticket (dry-run)

```sql
-- Does the space have a direct team for this domain?
select * from location_teams where space_id = '<space>' and domain = '<domain>';

-- Any group-based team?
select lt.* from location_teams lt
join space_group_members sgm on sgm.space_group_id = lt.space_group_id
where sgm.space_id = '<space>' and lt.domain = '<domain>';

-- Parent chain
with recursive chain(id, parent_id, depth) as (
  select id, parent_id, 0 from spaces where id = '<space>'
  union all
  select s.id, s.parent_id, c.depth + 1 from spaces s
  join chain c on s.id = c.parent_id
  where c.depth < 10
)
select c.id, c.depth, lt.team_id, lt.vendor_id
from chain c
left join location_teams lt on lt.space_id = c.id and lt.domain = '<domain>'
order by c.depth;

-- Domain chain
with recursive dchain(domain, depth) as (
  select '<domain>'::text, 0
  union all
  select dp.parent_domain, d.depth + 1
  from dchain d join domain_parents dp on dp.domain = d.domain
  where d.depth < 10
)
select * from dchain;
```

### Children of a case

```sql
select id, title, ticket_kind, status_category, assigned_team_id, assigned_vendor_id, created_at
from tickets
where parent_ticket_id = '<case-uuid>'
order by created_at;
```

API: `GET /tickets/:id/children` returns the same shape including `ticket_kind` and `assigned_vendor_id`.

---

## 12. Frontend surface (today)

- `POST /tickets` — creates a case (or a work order if DTO sets `ticket_kind = 'work_order'`, though dispatch is the proper path).
- `POST /tickets/:id/dispatch` — body = `DispatchDto`. Creates a child work order, returns it.
- `GET /tickets?kind=case` / `?kind=work_order` — filters by ticket kind. No default filter applied; clients must pass `kind` to separate cases from work orders in queue views.
- `GET /tickets/:id/children` — returns all direct children (work orders + any workflow-spawned sub-tasks).

---

## 13. What's intentionally not solved here

- **Visibility scoping** — `GET /tickets` returns everything in the tenant. Per-user / per-team / per-location visibility belongs in its own plan (list-endpoint filters + RLS tightening).
- **Vendor assignment via routing rules** — schema doesn't carry a vendor action column yet (`action_assign_vendor_id` is absent).
- **Auto-dispatch on request type** — no declarative "this request type always spawns a child WO to Vendor X." Dispatches are manual or workflow-driven today.
- **Case status re-open on child reopen** — rollup never moves a parent out of `resolved` or `closed`. Intentional; a human decides.
- **Scope-rerouting endpoint** — see §8b. No `POST /tickets/:id/rescope` exists.
- **Workflow impact on request-type change** — if/when rescoping lands, must decide whether in-flight workflow instances are terminated and restarted or migrated.
- **Bulk update does not re-route or audit.** `PATCH /tickets/bulk/update` accepts the same DTO as single update — silent. Audited bulk reassign would need a `/tickets/bulk/reassign` wrapping `/reassign`.
- **Overrides are not re-evaluated on ticket updates.** If an admin adds a `routing_rules` row that would have matched an existing ticket, the existing ticket is unaffected until someone calls `/reassign` with `rerun_resolver: true`. This is intentional — know it when debugging "why didn't my new rule fire."

---

## 14. File map (where to look)

| Concern | File |
|---|---|
| Resolver core | `apps/api/src/modules/routing/resolver.service.ts` |
| Resolver data access | `apps/api/src/modules/routing/resolver-repository.ts` |
| Resolver types | `apps/api/src/modules/routing/resolver.types.ts` |
| Routing façade + audit | `apps/api/src/modules/routing/routing.service.ts` |
| Routing rules CRUD | `apps/api/src/modules/routing/routing.controller.ts` |
| Case auto-routing | `apps/api/src/modules/ticket/ticket.service.ts` (`runPostCreateAutomation`) |
| Dispatch | `apps/api/src/modules/ticket/dispatch.service.ts` |
| Dispatch endpoint | `apps/api/src/modules/ticket/ticket.controller.ts` (`POST /tickets/:id/dispatch`) |
| SLA timers | `apps/api/src/modules/sla/sla.service.ts` |
| Schema — tickets, routing_decisions | `supabase/migrations/00011_tickets.sql`, `00027_routing_foundation.sql` |
| Schema — case/work order, space groups, domain parents, rollup | `supabase/migrations/00030_case_workorder_and_scope_hierarchy.sql` |
| Schema — routing rules | `supabase/migrations/00018_routing_rules.sql` |
| Schema — SLA policies | `supabase/migrations/00008_sla_policies.sql` |
| Resolver unit tests | `apps/api/src/modules/routing/resolver.service.spec.ts` |
| Scenario tests | `apps/api/src/modules/routing/scenarios.spec.ts` |
| Dispatch tests | `apps/api/src/modules/ticket/dispatch.service.spec.ts` |

---

## 15. When to update this document

**Update this document in the same PR as any change to the following.** If the code and this doc drift, the doc wins — fix the doc first, then re-align code.

Trigger list:

- Any file under `apps/api/src/modules/routing/`.
- `apps/api/src/modules/ticket/dispatch.service.ts`.
- `apps/api/src/modules/ticket/ticket.service.ts` — specifically `runPostCreateAutomation`, the auto-routing guard, the create/list DTOs, `getChildTasks`, or anything under the "reassignment" flow.
- `apps/api/src/modules/ticket/ticket.controller.ts` — adding, removing, or changing routing-adjacent endpoints.
- `apps/api/src/modules/sla/` — SLA attachment, timer start, pause/breach logic.
- `apps/api/src/modules/approval/` — anything that changes the `pending_approval` state semantics.
- `apps/api/src/modules/workflow/workflow-engine.service.ts` — especially the `create_child_tasks` node and anything that inserts `tickets` rows.
- Any migration that adds or alters: `tickets`, `request_types`, `routing_rules`, `routing_decisions`, `location_teams`, `space_groups`, `space_group_members`, `domain_parents`, `sla_policies`, `sla_timers`, `teams`, `vendors`, `assets`, `asset_types`.

Also update this doc if you add a **new** behavior (e.g. auto-dispatch, vendor-capable rules, visibility scoping) — entry in Section 13 should move from "not solved" to a new detailed section.

---

## 16. Resolved gaps

Move items here with a date when a gap from §13 is closed. Keeps the doc honest about what was once broken and when it was fixed.

- **2026-04-20 — Two-track SLA model.** Children no longer inherit `request_types.sla_policy_id` (that was the *case* policy bleeding into child rows). `DispatchService.resolveChildSla` now resolves child `sla_id` via explicit DTO → `vendors.default_sla_policy_id` → `teams.default_sla_policy_id` → user→team default → none. New schema in migration `00036`. Existing children keep their (incorrectly-inherited) `sla_id` — no backfill, future dispatches are correct. Cases also gain a close guard that refuses `resolved`/`closed` while any child is still open, and children's `sla_id` is now editable post-dispatch via `PATCH /tickets/:id` which calls `SlaService.restartTimers`. Workflow `create_child_tasks` node now forwards per-task `sla_policy_id` through to dispatch.
- **2026-04-18 — Sidebar reassign now audits.** The desk sidebar's `useTicketMutation.updateAssignment` hook now calls `POST /tickets/:id/reassign` (with a synthesized reason) whenever an existing assignee is replaced. First-time assignment still uses silent `PATCH`. `routing_decisions` captures every sidebar reassignment going forward.
- **2026-04-18 — Workflow-spawned children reach parity with manual dispatch.** `WorkflowEngineService.create_child_tasks` now calls `DispatchService.dispatch` per task. Children receive SLA timer start, a `routing_decisions` row, and a `dispatched` parent activity — same as manual dispatch via `POST /tickets/:id/dispatch`.
