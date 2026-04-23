# Organisations tree + reusable admin-page template — design

**Date:** 2026-04-22
**Status:** Draft, pending user review
**Owner:** Prequest platform

---

## 1. Problem

The employee portal relies on `person_location_grants` to decide which sites/buildings a person can make requests at. This is per-person. It does not scale.

A real in-flight tenant has:
- ~5000 employees
- 50 locations
- Different request types available at each location (via `request_types.availability_mode` + `location_granularity`, already shipped)
- Different fulfillment per request type (routing, already shipped)
- A requirement that catalog visibility depends on *where the employee works*

Today, onboarding one of these employees means setting `default_location_id` + clicking through N `person_location_grants`. Multiplied by 5000 employees, this is unworkable. There is also no structural representation of "which division/department an employee belongs to" — the `persons.division` and `persons.department` columns are free-text and carry no meaning beyond display.

We need:

1. A **structural representation of the tenant's requester-side organisation** — division → department → sub-department, arbitrary depth.
2. **Location grants that can be attached to an org node** and inherited by every person inside it (plus descendants).
3. A **reusable admin-page pattern** for building simple settings/CRUD screens (Linear-style centered 640px column with back-button navigation), starting with the Organisations pages as the reference implementation.

## 2. Scope

### In scope (v1)

**Stream A — Admin-page template primitives:**
- `SettingsPageShell`, `SettingsPageHeader`, `SettingsSection`, `SettingsFooterActions` layout components.
- Built on top of the existing shadcn `Field` primitives (per `CLAUDE.md`'s form rules).
- First reference implementations: the three Organisations pages below.

**Stream B — Organisations feature:**
- New tables: `org_nodes`, `person_org_memberships`, `org_node_location_grants`.
- New FK column: `teams.org_node_id` (nullable).
- Removed columns: `persons.division`, `persons.department` (free-text, test data only, no backfill).
- Portal scope resolver update: `portal_authorized_root_matches` unions in org-node grants walking ancestors.
- Three admin pages (all using the new template):
  - **Organisations list** — tree view, per-node member + location-grant counts, "Create" action.
  - **Create organisation** — back button + form (name, parent, code, description).
  - **Organisation detail** — back button + three sections: Members, Location grants, Teams attached.
- Person form: the two free-text fields collapse into one "Organisation" combobox (selects a node from the tree).
- Team form: new optional "Organisation" combobox (selects a node from the tree).

### Not in scope (v1)

- **Permission/role cascade through the tree.** Only *locations* cascade. Role assignment stays per-user via `user_role_assignments`.
- **Multi-membership UI.** The `person_org_memberships` join table supports many; the v1 person form picks one.
- **Per-person removal exceptions.** Grants are additive. "Inherit 30 locations from department, exclude one" is not supported in v1.
- **Historical data migration.** All current data is test data. `persons.division` and `persons.department` are dropped cold.
- **Org-node carrying other policies** (SLA defaults, approval routing, etc.). v1 only carries location grants.
- **Team→org transitive location grants.** A team attached to an org node does NOT grant its members the node's locations. Only direct person→org memberships do.
- **Importers / bulk CSV upload** for org tree or memberships.

## 3. Data model

### 3.1 `org_nodes`

```sql
create table public.org_nodes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  parent_id uuid references public.org_nodes(id) on delete restrict,
  name text not null,
  code text,                          -- optional short code, e.g. "FIN", "OPS"
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, parent_id, name) -- no siblings with identical names
);

create index idx_org_nodes_tenant on public.org_nodes (tenant_id);
create index idx_org_nodes_parent on public.org_nodes (parent_id);
```

**Constraints:**
- Parent must belong to the same tenant (enforced by trigger).
- No cycles (enforced by trigger — `parent_id` cannot be the node itself or any descendant).
- `on delete restrict` on `parent_id` — to delete a parent you must first move or delete its children.

**RLS:**
```sql
alter table public.org_nodes enable row level security;
create policy "tenant_isolation" on public.org_nodes
  using (tenant_id = public.current_tenant_id());
```

### 3.2 `person_org_memberships`

```sql
create table public.person_org_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  person_id uuid not null references public.persons(id) on delete cascade,
  org_node_id uuid not null references public.org_nodes(id) on delete cascade,
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  unique (person_id, org_node_id)
);

create index idx_pom_person on public.person_org_memberships (person_id);
create index idx_pom_node   on public.person_org_memberships (org_node_id);
create index idx_pom_tenant on public.person_org_memberships (tenant_id);
```

**Constraints:**
- Person, node, and membership must share a tenant (enforced by trigger).
- At most one `is_primary=true` per person, enforced by a partial unique index:

```sql
create unique index idx_pom_one_primary_per_person
  on public.person_org_memberships (person_id)
  where is_primary;
```

**Why a join table now if the UI only exposes one?** Matrixed orgs are a realistic later requirement. Starting with a join table costs nothing and avoids a migration when we unlock multi-membership. The UI in v1 shows/edits the single primary membership.

**RLS:** Tenant isolation, same pattern.

### 3.3 `org_node_location_grants`

```sql
create table public.org_node_location_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  org_node_id uuid not null references public.org_nodes(id) on delete cascade,
  space_id uuid not null references public.spaces(id),
  granted_by_user_id uuid references public.users(id),
  granted_at timestamptz not null default now(),
  note text,
  unique (org_node_id, space_id)
);

create index idx_ongl_node   on public.org_node_location_grants (org_node_id);
create index idx_ongl_space  on public.org_node_location_grants (space_id);
create index idx_ongl_tenant on public.org_node_location_grants (tenant_id);
```

**Constraints** (mirroring `person_location_grants` trigger — `enforce_org_node_location_grant_integrity`):
- Space must be type `site` or `building`.
- Space, node, and granter must share tenant.

**RLS:** Tenant isolation.

### 3.4 `teams.org_node_id`

```sql
alter table public.teams
  add column org_node_id uuid references public.org_nodes(id) on delete set null;

create index idx_teams_org_node on public.teams (org_node_id);
```

Nullable. A team can be attached to zero or one org node. This is a categorization/display relationship — it does NOT cause team members to inherit the node's location grants.

### 3.5 `persons` changes

```sql
alter table public.persons drop column if exists division;
alter table public.persons drop column if exists department;
```

Per user decision: current data is test-only, no backfill. Source of truth for a person's "department" is their primary `person_org_memberships` row. Display layers render the node's path (e.g., `Cairo → Finance → AP`).

`cost_center` and `manager_person_id` are untouched — they represent different concepts.

## 4. Portal scope resolver update

The existing function `public.portal_authorized_root_matches(person_id, tenant_id)` returns rows of `(root_id, source, grant_id)` with `source in ('default', 'grant')`. All downstream portal functions compose on top of it.

**New behaviour:** union in a third source — grants inherited through org-node membership, walking ancestors.

```sql
create or replace function public.portal_authorized_root_matches(
  p_person_id uuid,
  p_tenant_id uuid
) returns table (root_id uuid, source text, grant_id uuid) language sql stable as $$
  -- default location
  select p.default_location_id, 'default'::text, null::uuid
  from public.persons p
  join public.spaces s on s.id = p.default_location_id
  where p.id = p_person_id and p.tenant_id = p_tenant_id
    and s.active = true

  union all

  -- direct person grants
  select g.space_id, 'grant'::text, g.id
  from public.person_location_grants g
  join public.spaces s on s.id = g.space_id
  where g.person_id = p_person_id and g.tenant_id = p_tenant_id
    and s.active = true

  union all

  -- org-node grants (walking up ancestors from every node the person belongs to)
  select ongl.space_id, 'org_grant'::text, ongl.id
  from public.person_org_memberships pom
  cross join lateral public.org_node_ancestors(pom.org_node_id) as a(node_id)
  join public.org_node_location_grants ongl on ongl.org_node_id = a.node_id
  join public.spaces s on s.id = ongl.space_id
  where pom.person_id = p_person_id
    and pom.tenant_id = p_tenant_id
    and ongl.tenant_id = p_tenant_id
    and s.active = true;
$$;
```

Supporting function:

```sql
create or replace function public.org_node_ancestors(p_node_id uuid)
returns setof uuid language sql stable as $$
  with recursive walk(id, depth) as (
    select p_node_id, 0
    union all
    select n.parent_id, w.depth + 1
    from public.org_nodes n
    join walk w on n.id = w.id
    where n.parent_id is not null and w.depth < 20
  )
  select id from walk where id is not null;
$$;
```

**Tie-breaking in `portal_match_authorized_root`:** the current rule is "shortest walk wins; `default` wins ties." We extend:

1. Shortest walk wins.
2. On equal distance: `default` > `grant` > `org_grant`.

Rationale: the more specific source wins when two grants could equally explain a selection. A direct personal grant is more specific than one inherited via the tree.

**No changes needed** to `portal_authorized_space_ids`, `portal_match_authorized_root`, or the portal catalog/trace predicates beyond the tie-break extension above. They all compose on `portal_authorized_root_matches`. Post-2026-04-23 service-catalog collapse the canonical portal predicates are `public.request_type_visible_ids` + `public.request_type_requestable_trace` (the old `portal_visible_request_type_ids` / `portal_availability_trace` are bridge wrappers scheduled for Phase E deletion); the tie-break behavior above applies identically to the native versions.

### 4.1 Performance

Hot path (every portal catalog load). Back-of-envelope on the problem tenant:

- 5000 persons × avg 1 primary membership × tree depth ~4 × ~5 grants per node = O(20) rows per person to merge.
- Ancestor walk is bounded by depth (`< 20`) and indexed on `parent_id`.

Benchmark before shipping:
- `EXPLAIN ANALYZE portal_authorized_space_ids(:person_id, :tenant_id)` on a seeded tenant with 5000 persons, 50 org nodes in a 4-level tree, 100 grants total.
- Target: < 10 ms p95.

If the recursive CTE underperforms, fallback is a materialized `org_node_closure` table (many-to-many of node × ancestor), refreshed by trigger on `org_nodes` insert/update. Not building it upfront — YAGNI.

### 4.2 `scope_source` awareness

The project memory flags "known future work documented (scope_source preservation)" from the catalog redesign. The `source` column returned here is exactly that provenance field — this spec keeps it honest for three values (`default`, `grant`, `org_grant`) instead of two.

## 5. API surface

All endpoints tenant-scoped via existing `AsyncLocalStorage` middleware. All require the admin-side permissions (`people:manage` equivalent — see §7).

### 5.1 Org nodes

- `GET /org-nodes` → flat list with `{ id, name, code, parent_id, description, active, member_count, location_grant_count, team_count }`. The frontend assembles the tree.
- `GET /org-nodes/:id` → single node with the same fields plus nested `memberships`, `location_grants`, `teams`.
- `POST /org-nodes` → body `{ name, parent_id?, code?, description? }`.
- `PATCH /org-nodes/:id` → body subset of above. Rejects setting `parent_id` to self or descendant.
- `DELETE /org-nodes/:id` → rejects if node has children (must detach/move them first). Cascades to memberships and location grants (via FK).

### 5.2 Memberships

- `GET /org-nodes/:id/members` → `[{ person_id, person: { first_name, last_name, email }, is_primary, created_at }]`.
- `POST /org-nodes/:id/members` → body `{ person_id, is_primary? }`. If `is_primary=true`, demotes any existing primary for the person.
- `DELETE /org-nodes/:id/members/:personId`.
- Person form path: `PATCH /persons/:id` accepts `primary_org_node_id` (nullable) and handles the membership row upsert + primary-flag toggling server-side.

### 5.3 Org-node location grants

- `GET /org-nodes/:id/location-grants` → mirrors `person_location_grants` panel shape.
- `POST /org-nodes/:id/location-grants` → body `{ space_id, note? }`.
- `DELETE /org-nodes/:id/location-grants/:grantId`.

### 5.4 Teams

- Existing `PATCH /teams/:id` extended to accept `org_node_id` (nullable).
- Existing `POST /teams` extended similarly.

## 6. UI surface

### 6.1 Admin-page template primitives

Location: `apps/web/src/components/ui/settings-page.tsx` (new file).

```tsx
<SettingsPageShell>            // max-w-[640px] mx-auto, vertical padding, gap
  <SettingsPageHeader
    backTo="/admin/organisations"   // optional; renders a "← Back" link when set
    title="Create organisation"
    description="Add a new node to your organisation tree."
  />
  <SettingsSection
    title="Details"
    description="Core identifying information for this organisation."
  >
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="name">Name</FieldLabel>
        <Input id="name" ... />
      </Field>
      ...
    </FieldGroup>
  </SettingsSection>
  <SettingsSection title="Hierarchy">
    ...
  </SettingsSection>
  <SettingsFooterActions
    primary={{ label: "Create organisation", onClick: submit, loading }}
    secondary={{ label: "Cancel", href: "/admin/organisations" }}
  />
</SettingsPageShell>
```

**Rules (enforced by code review):**
- Form content inside a section uses `FieldGroup` + `Field` primitives from `apps/web/src/components/ui/field.tsx`. No hand-rolled `<div>`-with-Label-and-Input patterns.
- Section headings are rendered by `SettingsSection` — pages never style their own.
- `SettingsFooterActions` is right-aligned, primary action on the right, secondary on the left.
- The shell constrains column width; sections render full-width inside the shell.

Each primitive is ≤ 60 LOC and unit-testable in isolation. Exhaustive styling + spacing values match screenshot 1 + 2.

### 6.2 Organisations list page

Route: `/admin/organisations`.

- Uses `SettingsPageShell` + `SettingsPageHeader` (no back button; it's a top-level admin page).
- Below the header: a "Create organisation" primary button (top-right of the shell column).
- Tree rendered as an indented list. Each row: expand/collapse chevron, name, code badge (if set), member count, grant count, team count, row-level "⋯" menu with Edit/Delete.
- Clicking a row navigates to the detail page.
- Empty state: a centered illustration + "Create your first organisation" CTA inside the shell column.
- Uses React Query key factory `org-nodes.lists()` per `docs/react-query-guidelines.md`.

### 6.3 Create organisation sub-page

Route: `/admin/organisations/new`.

- Back button → `/admin/organisations`.
- Sections:
  - **Details**: Name (required), Code (optional), Description (optional).
  - **Hierarchy**: Parent organisation (combobox, optional — blank means top-level).
- Submit → `POST /org-nodes` → on success, navigate to detail page of the new node.

### 6.4 Organisation detail page

Route: `/admin/organisations/:id`.

- Back button → `/admin/organisations`.
- Title: the node's name. Subtitle: the node's path (e.g., `Cairo → Finance → AP`).
- Sections:
  - **Details** (editable inline; PATCH on blur/save): Name, Code, Description, Parent, Active toggle.
  - **Members**: table of persons (name, email, is-primary). Add via person combobox. Remove via row menu.
  - **Location grants**: table of granted sites/buildings. Add via location combobox. Remove via row menu. Mirrors the existing `PersonLocationGrantsPanel` shape for consistency.
  - **Teams attached**: read-mostly list of teams with `org_node_id = this.id`. Each row has a "Detach" menu item (clears `teams.org_node_id`). No "Attach" action here; teams are attached from the Teams admin.
  - **Danger zone**: Delete organisation (disabled if node has children; tooltip explains).
- Uses `SettingsSection` for each block.

### 6.5 Person form update

File: `apps/web/src/pages/admin/persons.tsx` (existing).

Changes:
- Remove `division` and `department` inputs.
- Add one new field: **Organisation** — `<Field>` containing an `OrgNodeCombobox` component (new; modelled after `LocationCombobox`/`PersonCombobox`). Selects any node from the tree; shows path in the dropdown.
- Form submit maps this to `primary_org_node_id` on the payload. Backend handles membership upsert.

### 6.6 Team form update

File: `apps/web/src/pages/admin/teams.tsx` (existing).

- Add a new optional **Organisation** field using `OrgNodeCombobox`.
- Wire to `org_node_id` on the submit payload.

### 6.7 Navigation

Add a new item to the admin sidebar: **Organisations** (icon: `Building2` from `lucide-react`). Placed near "Persons" and "Teams" in the menu, since they are conceptually related.

## 7. Permissions

Introduce a new permission key: `organisations:manage`. Granted to the same roles that currently have `people:manage` (tenant admins).

All `/org-nodes/*` endpoints check this permission via the existing `PermissionsGuard`. Reading is also gated — there is no public or portal-facing read endpoint for `org_nodes` in v1.

The portal scope resolver change is transparent to portal users — no new permission.

## 8. Migration plan

Sequential migrations (next available numeric prefix, starting at 00075):

1. **00075_create_org_nodes.sql** — table, indexes, RLS, cycle-prevention trigger, tenant-match trigger.
2. **00076_create_person_org_memberships.sql** — table, indexes, RLS, partial unique primary index, tenant-match trigger.
3. **00077_create_org_node_location_grants.sql** — table, indexes, RLS, integrity trigger.
4. **00078_teams_add_org_node_id.sql** — `alter table` + index.
5. **00079_drop_persons_division_department.sql** — `alter table ... drop column`.
6. **00080_portal_authorized_root_matches_org_grants.sql** — installs `org_node_ancestors(p_node_id)` helper (new), replaces `portal_authorized_root_matches` (adds `org_grant` source), and replaces `portal_match_authorized_root` (extends tie-break to `default > grant > org_grant`).
7. **00081_seed_organisations_permission.sql** — insert `organisations:manage` permission key into the permission registry; grant to existing admin roles.

Per `CLAUDE.md` the app runs against **remote** Supabase. Migrations are validated locally via `pnpm db:reset`, then pushed via `pnpm db:push` (or psql fallback) with user go-ahead. Project memory notes standing permission to push migrations for in-progress workstreams, but confirm at push time.

## 9. Testing

### 9.1 Backend

- Unit tests (Jest) for the org-nodes service: create/update/delete, parent-cycle rejection, tenant-isolation rejection.
- Unit test for `org_node_ancestors` SQL function: single node, 4-level chain, non-existent input.
- Integration test for updated `portal_authorized_root_matches`:
  - Person with `default_location` only → 1 root, source `default`.
  - Person with direct grant → 2 roots, sources `default` + `grant`.
  - Person in an org node with grants → 2 roots, sources `default` + `org_grant`.
  - Person in a deep org node where only ancestors have grants → `org_grant` via ancestor walk.
  - Tie-break: person has both direct `grant` and `org_grant` for the same effective space at equal distance → `match_authorized_root` returns `source=grant`.

### 9.2 Frontend

- Smoke test for each admin-template primitive (`SettingsPageShell`, `SettingsSection`, `SettingsFooterActions`): renders slots correctly, back button navigates.
- Component test for `OrgNodeCombobox`: lists nodes, filters by name, displays path.
- Manual UAT on the three pages against the screenshots provided (the Linear settings pages): 640px column, back button behaviour, section spacing.

## 10. Risks and open questions

| # | Risk | Mitigation |
|---|------|------------|
| 1 | Recursive CTE in `portal_authorized_root_matches` becomes a hot-path bottleneck. | Benchmark before ship (see §4.1). Fallback: materialized closure table. |
| 2 | Tie-break change in `portal_match_authorized_root` alters behaviour for existing fixtures. | Integration test covers all combinations. Review seed fixtures during implementation. |
| 3 | Cascade semantics surprise admins ("I deleted a node and all memberships went with it"). | UI shows member + grant counts on each node row; delete is blocked if children exist; delete of a childless node warns about cascading memberships + grants. |
| 4 | Dropping `persons.division`/`persons.department` breaks a consumer. | Grep workspace before migration. Update any list/detail views that read those fields to read node path via membership instead. |
| 5 | `OrgNodeCombobox` performance with large trees (50+ nodes × 5 levels). | Static tree fetched once via React Query; client-side filter. 50 nodes is trivial for client-side. |
| 6 | Cycle-prevention trigger can be bypassed by concurrent updates (classic race). | Use `SELECT ... FOR UPDATE` on the ancestor chain inside the trigger, or rely on the `on delete restrict` on `parent_id` which makes the race benign. |

### Open questions (to resolve during implementation, not blockers for spec approval)

- Should `OrgNodeCombobox` allow selecting *any* node, or only leaf nodes? → v1: any node. If operators find it confusing, add a prop.
- Should the detail-page inline edit of `parent_id` prompt "this will move all descendants with it"? → yes; implement as a confirm dialog.
- Do we want a "copy members from another org" affordance on create? → v1: no. YAGNI.

## 11. CLAUDE.md / documentation updates (same PR)

The project has a discipline: code changes that touch routing/visibility tables must update the relevant reference doc in the same PR. This work introduces a new subsystem (requester-side organisation structure) that behaves analogously:

- Add a short new section to `docs/portal-scope-slice.md` (or the newer portal-scope doc) describing org-node grants and the three-source `portal_authorized_root_matches` model. This is the doc of record for portal scope.
- Add `organisations:manage` to the permissions reference.
- Update `CLAUDE.md`'s data-model overview to mention `org_nodes` as a first-class tenant concept alongside `persons`, `teams`, and `spaces`.

## 12. Out of scope / follow-ups (explicitly)

- Multi-membership UI. Schema ready; UI unlocks with one additional page section and zero migrations.
- Per-person negative exceptions ("inherits X but exclude one"). Requires a new `person_location_denials` table — design separately.
- Role/permission cascade through the tree. Separate brainstorm.
- SLA or approval policies attached to org nodes. Separate brainstorm.
- Migrating the free-text `persons.division` / `persons.department` for real tenants. Not applicable — test data only.
- Derived "division / department" display. v1 shows node path; a tenant-configurable "department level" pointer (e.g. "treat level 2 as department") is a later ergonomic.
- Org-node closure materialization. Add only if benchmark fails in §4.1.

---

**Sign-off:** spec validated through brainstorming 2026-04-22. Implementation plan to be produced by `superpowers:writing-plans` once user approves this document.
