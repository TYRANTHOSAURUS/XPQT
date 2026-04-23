# Service Catalog Collapse — Implementation Plan

**Source of truth:** [docs/service-catalog-live.md](../../service-catalog-live.md)
**Supersedes (historical only):** [docs/service-catalog-redesign.md](../../service-catalog-redesign.md)
**Related:** [docs/assignments-routing-fulfillment.md](../../assignments-routing-fulfillment.md), [docs/superpowers/specs/2026-04-17-workflows-visual-editor-design.md](../specs/2026-04-17-workflows-visual-editor-design.md)

**Goal:** Collapse the split `service_items` / `request_types` model back to a single `request_types`-centered architecture. One admin concept, no bridge, no mirror triggers, no compatibility wrappers.

**Mode:** Inline execution with codex review between phases. In-development product, no rollback/dual-run — legacy is deleted each phase.

**Remote DB:** password lives in `.env` as `SUPABASE_DB_PASS`. Push with the psql fallback; no need to ask per migration.

---

## 0. Current-state snapshot (audited 2026-04-23)

### 0.1 Migrations 00057–00074 that built the split (all will be reversed or recreated request-type-native)

| # | File | What it added |
|---|---|---|
| 00057 | `service_items.sql` | `service_items` table + `set_service_items_updated_at` trigger |
| 00058 | `service_item_categories.sql` | M2M table |
| 00059 | `service_item_offerings.sql` | Coverage table |
| 00060 | `criteria_sets.sql` | `criteria_sets` table + `criteria_matches(...)`, `_criteria_eval_node(...)` |
| 00061 | `service_item_criteria.sql` | Audience rules (visible_allow/deny, request_allow/deny) |
| 00062 | `service_item_form_variants.sql` | Form variants (priority + criteria) with `uniq_service_item_default_variant` partial index |
| 00063 | `service_item_on_behalf_rules.sql` | Actor/target on-behalf rules |
| 00064 | `request_type_service_item_bridge.sql` | 1:1 bridge |
| 00065 | `fulfillment_types_view.sql` | View over `request_types` exposing operational columns |
| 00066 | `tickets_requested_for.sql` | `tickets.requested_for_person_id` (keep — not split-specific) |
| 00067 | `seed_service_catalog_permissions.sql` | `service_catalog:manage`, `criteria_sets:manage` |
| 00068 | `backfill_service_catalog.sql` | Seeded service_items + bridge + categories + offerings + default form variants |
| 00069 | `service_catalog_predicates.sql` | `portal_visible_service_item_ids`, `portal_requestable_trace`, `portal_onboardable_space_ids_v2`, `service_item_offering_matches`; rewrote `portal_visible_request_type_ids` + `portal_availability_trace` as bridge wrappers |
| 00070 | `service_catalog_fixes.sql` | Updated `portal_requestable_trace`; added `auto_pair_service_item_for_request_type` INSERT trigger; category mirror triggers `trg_mirror_rtc_insert`/`_delete` |
| 00071 | `service_catalog_rt_update_mirror.sql` | `mirror_request_type_update_to_service_item` + `trg_mirror_rt_update_to_si` |
| 00072 | `rt_update_defensive_branch.sql` | Extended the mirror function (defensive branch seeding offerings + default variant) |
| 00073 | `service_catalog_phase5_deprecations.sql` | Deprecation column comments on `request_types` |
| 00074 | `form_variant_default_fallback.sql` | Form-variant tie-break order |

### 0.2 `request_types` columns already present on remote

Verified via `\d public.request_types` against remote DB (2026-04-23):
`id, tenant_id, config_entity_id, name, description, icon, domain, form_schema_id, workflow_definition_id, default_assignment_policy_id, sla_policy_id, active, created_at, updated_at, display_order, keywords, fulfillment_strategy, requires_asset, asset_required, asset_type_filter, requires_location, location_required, default_team_id, default_vendor_id, requires_approval, approval_approver_team_id, approval_approver_person_id, case_owner_policy_entity_id, child_dispatch_policy_entity_id, domain_id, location_granularity`

**Missing columns (from live-doc §4.1):** `kb_link`, `disruption_banner`, `on_behalf_policy`.

### 0.3 Backend files involved

- **Delete:** `apps/api/src/modules/service-catalog/service-item.controller.ts`, `service-item.service.ts`, `service-catalog.module.ts`.
- **Rewrite:** `apps/api/src/modules/portal/portal-submit.service.ts`, `portal-submit.types.ts`, `portal.service.ts`, `portal.controller.ts` (DTO change only).
- **Extend:** `apps/api/src/modules/config-engine/request-type.controller.ts` + its service to expose coverage / audience / form-variants / on-behalf / scope-overrides CRUD.
- **Touch (module wiring):** `apps/api/src/app.module.ts` (remove `ServiceCatalogModule` import).

### 0.4 Frontend files involved

- **Delete:** `apps/web/src/pages/admin/service-items.tsx`, `components/admin/service-item-dialog.tsx`, `components/admin/set-handler-dialog.tsx`.
- **Rewrite to request-type-native:** the `components/admin/catalog-*-tab.tsx` set, `catalog-service-panel.tsx`, `catalog-hierarchy.tsx` side-panel wiring; portal pages `pages/portal/home.tsx`, `catalog-category.tsx`, `submit-request.tsx`.
- **Touch:** `apps/web/src/App.tsx` (remove `/admin/service-items` route), admin sidenav (remove link), any react-query key factory that loads `service-items/*` endpoints.

### 0.5 Feature flags to purge

`service_catalog_read` — only actual caller is `PortalService.getCatalog`. `service_catalog_write` and `service_catalog_submit` were designed but never wired; no purge needed beyond docs.

---

## 1. Phased execution

Each phase ships a working state, is commit-worthy, pushes its migration to remote, and is **reviewed by codex before moving to the next**. No feature flags — we cut over at each phase boundary. Tests are written after phase B as a single pass (no pre-existing service-catalog tests to preserve).

---

## Phase A — Schema add (request-type-native tables + columns)

**Goal:** Make `request_types` able to carry everything `service_items` carries today, and create the five request-type-scoped satellite tables with data copied from the service_item_* equivalents. After this phase the legacy tables still exist and still serve traffic, but the new shape is present and populated.

**A.0 Preflight (hard gate — run before writing any migration)**

The backfill only copies bridged rows. Current admin allows creating standalone `service_items` (see `apps/api/src/modules/service-catalog/service-item.service.ts:90–115`) and multiple `service_items` per `fulfillment_type_id`. A live preflight on remote (2026-04-23) returned zero for all four checks, but **every phase-A run must re-run this preflight first** and refuse to proceed if any row returns non-zero.

```sql
select 'orphan_si' as kind, count(*) from public.service_items si
 where not exists (select 1 from public.request_type_service_item_bridge b where b.service_item_id = si.id)
union all
select 'dup_si_per_ft', count(*) from (
  select fulfillment_type_id from public.service_items group by fulfillment_type_id having count(*) > 1
) t
union all
select 'orphan_rt', count(*) from public.request_types rt
 where not exists (select 1 from public.request_type_service_item_bridge b where b.request_type_id = rt.id)
union all
select 'dup_default_variant', count(*) from (
  select service_item_id from public.service_item_form_variants
  where criteria_set_id is null group by service_item_id having count(*) > 1
) t;
```

If any count is non-zero: stop. Repair first (delete/merge orphan service_items or fix bridge), then resume.

1. **Migration `00085_request_types_portal_columns.sql`**
   - `alter table public.request_types` add: `kb_link text`, `disruption_banner text`, `on_behalf_policy text not null default 'self_only' check (on_behalf_policy in ('self_only','any_person','direct_reports','configured_list'))`.
   - Backfill from paired `service_items`:
     ```sql
     update public.request_types rt
     set kb_link = si.kb_link,
         disruption_banner = si.disruption_banner,
         on_behalf_policy = si.on_behalf_policy
     from public.service_items si
     join public.request_type_service_item_bridge b on b.service_item_id = si.id
     where b.request_type_id = rt.id;
     ```
   - Clear the deprecation column comments added in 00073 (`comment on column … is null`) — those are actively misleading now.
   - Index: `create index idx_rt_on_behalf_policy on public.request_types (on_behalf_policy) where on_behalf_policy <> 'self_only';`
   - `notify pgrst, 'reload schema';`

2. **Migration `00086_request_type_coverage_rules.sql`**
   - Create `request_type_coverage_rules` with columns from live-doc §5.1: `id, tenant_id, request_type_id, scope_kind, space_id, space_group_id, inherit_to_descendants, starts_at, ends_at, active, created_at`.
   - CHECK constraints on scope_kind/space_id/space_group_id XOR, starts_at<ends_at.
   - Indexes (live-doc §12.3): `(tenant_id, request_type_id, active)`, partial on `space_id`, partial on `space_group_id`.
   - RLS tenant_isolation policy.
   - Copy every row from `service_item_offerings` via the bridge:
     ```sql
     insert into public.request_type_coverage_rules (
       tenant_id, request_type_id, scope_kind, space_id, space_group_id,
       inherit_to_descendants, starts_at, ends_at, active, created_at
     )
     select o.tenant_id, b.request_type_id, o.scope_kind, o.space_id, o.space_group_id,
            o.inherit_to_descendants, o.starts_at, o.ends_at, o.active, o.created_at
     from public.service_item_offerings o
     join public.request_type_service_item_bridge b on b.service_item_id = o.service_item_id;
     ```

3. **Migration `00087_request_type_audience_rules.sql`**
   - Create `request_type_audience_rules` with columns from live-doc §5.2.
   - UNIQUE `(request_type_id, criteria_set_id, mode)`.
   - Index `(tenant_id, request_type_id, mode, active)`.
   - RLS.
   - Copy every row from `service_item_criteria` via bridge (same pattern).

4. **Migration `00088_request_type_form_variants.sql`**
   - Create `request_type_form_variants` with columns from live-doc §5.3.
   - Partial unique index: at most one default variant per request type (`criteria_set_id is null`).
   - Index `(tenant_id, request_type_id, active, priority desc)`.
   - RLS.
   - Copy every row from `service_item_form_variants` via bridge.

5. **Migration `00089_request_type_on_behalf_rules.sql`**
   - Create `request_type_on_behalf_rules` (live-doc §5.4).
   - RLS.
   - Copy every row from `service_item_on_behalf_rules` via bridge.

6. **Migration `00090_request_type_scope_overrides.sql`**
   - Create `request_type_scope_overrides` (live-doc §5.5): handler_kind, handler_team_id, handler_vendor_id, workflow_definition_id, case_sla_policy_id, case_owner_policy_entity_id, child_dispatch_policy_entity_id, executor_sla_policy_id, scope_kind/space_id/space_group_id XOR, inherit_to_descendants, active, starts_at/ends_at.
   - Indexes `(tenant_id, request_type_id, active, scope_kind)` + partials on space_id / space_group_id.
   - RLS.
   - No backfill — no existing table mapped to this; it's net new.

**Local validate + remote push per migration (sequential):**

```bash
pnpm db:reset                                      # local validate
PGPASSWORD="$(grep -E '^SUPABASE_DB_PASS=' .env | cut -d= -f2- | tr -d '\r\n')" \
  psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 -f supabase/migrations/00085_request_types_portal_columns.sql
# …repeat for 00086-00090
```

**Smoke checks after each push:**

```sql
select count(*) from public.request_type_coverage_rules;   -- should equal service_item_offerings count
select count(*) from public.request_type_audience_rules;   -- == service_item_criteria
select count(*) from public.request_type_form_variants;    -- == service_item_form_variants
select count(*) from public.request_type_on_behalf_rules;  -- == service_item_on_behalf_rules
select kb_link is not null as any_kb_link from public.request_types
  where id in (select request_type_id from public.request_type_service_item_bridge b
               join public.service_items si on si.id = b.service_item_id where si.kb_link is not null)
  limit 1;
```

**Commit boundary A.** Commit message: `feat(catalog): add request-type-native portal columns and satellite tables`.

**Codex review A** — prompt codex to review migrations 00085-00090 against live-doc §4–§5 and §12.3 indexing requirements. Ship corrections if any.

**Risk ledger for A:**
- Backfill from a bridge row that's missing on one side (shouldn't happen post-00068 + 00070, but exists as Gotcha #5). Mitigation: post-migration validation query `select id from public.request_types where id not in (select request_type_id from public.request_type_service_item_bridge)` — must return zero. If not, repair via the auto-pair trigger logic applied as a one-off backfill before running the copy.
- FK target mismatch: `request_type_form_variants.form_schema_id` points at `config_entities(id)` (same as service_item_form_variants). Preserve that FK exactly.
- Unique default-variant partial index will reject duplicates if any service_item has two default variants (00074 added tie-break but didn't enforce uniqueness at DB level for service_items). Pre-flight: `select service_item_id, count(*) from service_item_form_variants where criteria_set_id is null group by 1 having count(*) > 1` — must be empty. If not, fix before migration (deactivate duplicates).

---

## Phase B — Add request-type-native predicates (coexist with legacy)

**Goal:** Create the new predicate functions that answer directly off `request_type_*` tables, with **fresh distinct names** so the service-item-specific predicates and bridge wrappers stay live. Every current caller (`getCatalogV2`, `portal-submit.service.ts`, `simulator.service.ts`, `getOnboardableLocations`) keeps working. Phase C then migrates the callers, and Phase E drops the legacy set.

**Naming convention:** new functions start with `request_type_` to distinguish them from the service-item-backed `portal_*` set.

**Deliverables:**

1. **Migration `00091_request_type_predicates.sql`**
   - Create (do NOT drop anything yet):
     - `request_type_visible_ids(p_actor_person_id uuid, p_selected_space_id uuid, p_tenant_id uuid) returns setof uuid` — visibility rule from live-doc §6.1, reading `request_type_coverage_rules` + `request_type_audience_rules` + `request_types.active`. No bridge.
     - `request_type_offering_matches(p_request_type_id uuid, p_selected_space_id uuid, p_tenant_id uuid) returns table(id uuid, scope_kind text, space_id uuid, space_group_id uuid, created_at timestamptz)` — powers matched_coverage_rule on the trace.
     - `request_type_requestable_trace(p_actor_person_id uuid, p_request_type_id uuid, p_requested_for_person_id uuid, p_effective_space_id uuid, p_asset_id uuid, p_tenant_id uuid) returns jsonb` — port of 00070's function with four changes: (a) keyed by request_type_id; (b) reads audience/variants/on-behalf/coverage from `request_type_*` tables; (c) response jsonb includes `request_type_id` and `matched_coverage_rule_id` / `matched_form_variant_id` (no service_item_id or fulfillment_type_id); (d) intake columns (`location_required`, `location_granularity`, `requires_asset`, `asset_required`, `asset_type_filter`, `on_behalf_policy`) read directly from `request_types`.
     - `request_type_onboardable_space_ids(p_tenant_id uuid, p_actor_person_id uuid) returns setof uuid` — port of `portal_onboardable_space_ids_v2` answering against `request_type_coverage_rules` + `request_type_audience_rules`.
   - Keep as-is (do not touch): `criteria_matches`, `_criteria_eval_node`, `portal_request_type_has_eligible_descendant`, `portal_authorized_root_matches`, `portal_match_authorized_root`, `portal_authorized_space_ids`, `portal_submit_location_valid`. The service-item-backed `portal_visible_service_item_ids`, `portal_requestable_trace`, `portal_onboardable_space_ids_v2`, `service_item_offering_matches`, `portal_visible_request_type_ids` (bridge wrapper), `portal_availability_trace` (bridge wrapper) also stay live until Phase E.
   - `notify pgrst, 'reload schema';`

**Local validate + push to remote.**

**Smoke checks:**

```sql
-- Native count should equal the bridge-wrapped count for any known tenant/actor.
select (select count(*) from public.request_type_visible_ids('<person>','<space>','<tenant>')) as native,
       (select count(*) from public.portal_visible_request_type_ids('<person>','<space>','<tenant>')) as legacy;
-- Trace overall_valid true for a known-good combination.
select public.request_type_requestable_trace('<actor>','<rt>','<actor>','<space>',null,'<tenant>')->>'overall_valid';
```

Diff between native and legacy counts should be zero. Any drift = bug in the native predicate (likely in the audience or coverage CTE).

**Commit boundary B.** Commit message: `feat(catalog): add request-type-native predicates`.

**Codex review B** — against live-doc §6 runtime rules + §12 performance guardrails. Specifically: no N+1 via chained CTEs; indexing matches §12.3; trace shape is a superset of useful fields (matched_coverage_rule_id, matched_form_variant_id, criteria flags, on_behalf_ok, asset_type_filter_ok, failure_reason).

**Risk ledger for B:**
- Side-by-side signatures can drift from the legacy versions' semantics. Mitigation: the smoke-diff query above catches this before Phase C flips callers.
- Trace jsonb shape changes vs the legacy superset. Not a runtime issue since no caller reads the native trace yet; Phase C wires it up.

---

## Phase C — Rewire backend (portal + admin)

**Goal:** Every API path reads/writes request_type_* tables directly. Service-item admin controller and module are deleted. All callers switch from the legacy (service-item-backed or bridge-wrapped) predicates to the native `request_type_*` predicates created in Phase B.

**Deliverables:**

### C.1 Portal submit path
- `apps/api/src/modules/portal/portal-submit.types.ts` — `PortalSubmitDto` loses `service_item_id`; keeps `request_type_id` (required), `location_id`, `asset_id`, `requested_for_person_id`, `form_data`, etc. Drop `PortalRequestableTrace`; export `RequestTypeTrace` matching the `request_type_requestable_trace` jsonb shape.
- `apps/api/src/modules/portal/portal-submit.service.ts` — delete the bridge-lookup branch that resolved `request_type_id → service_item_id` (around line 167–178). Single path: call `request_type_requestable_trace(actor, request_type_id, requested_for, effective_space, asset, tenant)`. Continue to populate `tickets.requested_for_person_id` as today. Fix the doc-ref comment at line 22–23 (points at the superseded doc).
- `apps/api/src/modules/portal/portal.controller.ts` — controller already takes `request_type_id` via `PortalSubmitDto`; only DTO type changes propagate. Confirm no field validator still checks `service_item_id`.

### C.2 Portal read path (actual seam: `getCatalogV2`, not `getCatalog`)
The portal controller calls `PortalService.getCatalogV2(authUid, locationId)` directly at `portal.controller.ts:58`. There is NO `getCatalog()` in use. Plan targets:
- `apps/api/src/modules/portal/portal.service.ts`:
  - **Delete outright:** the `service_catalog_read` feature-flag cache and helper (`getServiceCatalogReadMode` around line 766), the `ServiceCatalogReadMode` type, the cached flag map, and every branch that consults it. Our direction is single-path — no legacy catalog mode.
  - **Delete outright:** `PortalCatalogResponseV2` and any `…V2` suffixed types (line 107+); replace with a single `PortalCatalogResponse` shape returning categories → request_types.
  - **Rewrite `getCatalogV2` → `getCatalog`** (rename to match live-doc §10): read via `request_type_visible_ids(actor, space, tenant)` + `request_type_form_variants` (for matched variant) + `request_types` (for intake/fulfillment summary). Drop `service_items[]` nesting — response is categories → request_types directly.
  - **Rewrite `getOnboardableLocations`** (around line 282–303): replace `portal_onboardable_space_ids_v2` RPC call with `request_type_onboardable_space_ids`. Drop any legacy `portal_onboardable_locations` fallback.
  - **Clean up stale comments** at lines 74, 540 that refer to feature-flag modes.
- `apps/api/src/modules/portal/portal.controller.ts`:
  - Rename the `getCatalogV2` call site to `getCatalog` (line 58). Remove any V2-suffixed endpoint path if one exists.

### C.3 Admin request-type CRUD extension
- `apps/api/src/modules/config-engine/request-type.controller.ts` (+ service): add endpoints matching live-doc §10:
  - `PUT /request-types/:id/coverage` — replace `request_type_coverage_rules`.
  - `PUT /request-types/:id/audience` — replace `request_type_audience_rules`.
  - `PUT /request-types/:id/form-variants` — replace `request_type_form_variants` (reject >1 default at service layer; DB partial unique index is the backstop).
  - `PUT /request-types/:id/on-behalf-rules` — replace `request_type_on_behalf_rules`.
  - `PUT /request-types/:id/scope-overrides` — replace `request_type_scope_overrides`.
  - `PUT /request-types/:id/categories` — replace `request_type_categories` (live-doc §10, missed in the initial plan). This replaces the current Basics tab path that writes `/admin/service-items/:id/categories`.
  - `GET /request-types/:id/coverage-matrix` — see C.5 below (net-new scope).
- **Remove the `service_catalog:manage` guard** from existing mutations (`request-type.controller.ts:51, 66, 76`). Keep the `request_types:manage` guard (already in place at lines 48, 63, 74). Do the same in the service-layer `createEntity` / `updateEntity` / `deleteEntity` paths in `request-type.service.ts` if they call `requirePermission` on `service_catalog:manage` (verify).
- All new endpoints guarded by `request_types:manage` only. No new permission created.

### C.4 Simulator (routing studio)
- `apps/api/src/modules/routing/simulator.service.ts` — the simulator wraps `portal_availability_trace` (line 233) with `{ service_item_id? | request_type_id? }` input. Rewire to call `request_type_requestable_trace` when a `request_type_id` is supplied; drop the service_item_id input entirely (unused after the portal cuts over). Update the trace-prefix display in `apps/web/src/components/admin/routing-studio/simulator.tsx` to match.

### C.5 Coverage matrix — **net-new backend + UI**
The current `ServiceItemService.getCoverageMatrix()` (lines ~198–410) only returns offering + handler reachability. Live-doc §8 requires every row to show:
- location / group
- offered-or-not
- effective handler + handler override
- effective case workflow + workflow override
- effective case SLA + SLA override
- effective child dispatch policy + dispatch override
- effective executor SLA + executor-SLA override

…with row-click opening a detail panel showing matched coverage rule, matched audience state, matched scoped override, effective routing trace, and inheritance path.

This is net-new work, not a rename. Scope it as:
- Server: SQL function `public.request_type_coverage_matrix(p_tenant uuid, p_request_type_id uuid)` that for each active site/building returns the effective stack resolved through `request_type_scope_overrides` (live-doc §6.3 precedence) + the routing chain (live-doc §6.4).
- Controller: `GET /request-types/:id/coverage-matrix` returns an array of those rows plus the inheritance trail.
- UI: see Phase D, `catalog-coverage-tab.tsx` rewrite.

### C.6 Delete legacy backend code
- Remove `apps/api/src/modules/service-catalog/` entirely (`service-item.controller.ts`, `service-item.service.ts`, `service-catalog.module.ts`).
- Unregister `ServiceCatalogModule` in `apps/api/src/app.module.ts`.
- Remove any `ServiceItemService` DI imports anywhere else (expect zero after C.1–C.5).

### C.7 Type-check + build
```bash
pnpm --filter @prequest/api typecheck
pnpm --filter @prequest/api build
```

**Commit boundary C.** Commit message: `refactor(catalog): rewire portal+admin APIs to request-type-native`.

**Codex review C** — against live-doc §6.1–6.4, §8, §10, and the existing portal/admin behavior contracts.

**Risk ledger for C:**
- The portal catalog response shape changes (no more `service_items[]`). Frontend expects the old shape until Phase D ships. **Order: C and D must merge as one coherent change** — inline-executed together in this branch before pushing to remote main.
- Removing `service_catalog:manage` guards: double-check that admin role still has `request_types:manage` seeded (it does per seed migrations). Otherwise admin gets 403.
- Simulator UI (`routing-studio/simulator.tsx:151, 180`) reads `.portal_availability` prefix — update to `.portal_requestable` or the new flat shape.

---

## Phase D — Rewire frontend (admin + portal)

**Goal:** Everything on screen talks to the request-type-native API; service_item pages/components are gone.

**Deliverables:**

### D.1 Admin
- Delete `apps/web/src/pages/admin/service-items.tsx`.
- Delete `apps/web/src/components/admin/service-item-dialog.tsx`.
- Delete `apps/web/src/components/admin/set-handler-dialog.tsx` (scope-override handler now lives in the coverage-matrix row detail; see live-doc §8).
- Rewrite, each using request_type_id as the prop + calling the new `PUT /request-types/:id/...` endpoints:
  - `components/admin/catalog-basics-tab.tsx` — fields: name, description, icon, keywords, kb_link, disruption_banner, display_order, active, on_behalf_policy. **Change the categories write** from `PUT /admin/service-items/:id/categories` to `PUT /request-types/:id/categories`.
  - `components/admin/catalog-audience-tab.tsx` — criteria-set bindings by mode against `/request-types/:id/audience`.
  - `components/admin/catalog-coverage-tab.tsx` — **net-new coverage matrix** (live-doc §8), not a rename of the current offering+reachability table. Columns per row: location/group, offered, effective handler, handler override, effective workflow, workflow override, effective case SLA, SLA override, effective child dispatch, dispatch override, effective executor SLA, executor-SLA override. Row click opens a detail drawer showing matched coverage rule, matched audience state, matched scoped override, effective routing trace, inheritance path. Scope-overrides editor invokes `PUT /request-types/:id/scope-overrides`; coverage rules editor invokes `PUT /request-types/:id/coverage`. Drops the `setHandlerAt` affordance (handlers now set via per-row scope-override).
  - `components/admin/catalog-form-tab.tsx` — form variants (default + conditional) against `/request-types/:id/form-variants`.
  - `components/admin/catalog-fulfillment-tab.tsx` — read-only summary of request_types.workflow_definition_id, sla_policy_id, domain, default_team_id, default_vendor_id. Edits continue via the existing request-type edit dialog / request-types page.
  - `components/admin/catalog-service-panel.tsx` — rename prop `serviceItemId` → `requestTypeId`; compose the five tabs.
  - `pages/admin/catalog-hierarchy.tsx` — tree stays (already categories → request_types); side panel opens the request-type service panel. Remove any "paired service item" affordance if present.
- Routes: remove `/admin/service-items` from `apps/web/src/App.tsx` and the admin sidenav component (search for the `service-items` string).
- React-query keys: remove `service-items` factory under `apps/web/src/api/` (if present); add `request-types` coverage/audience/form-variants/on-behalf/scope-overrides query keys aligned with [docs/react-query-guidelines.md](../../react-query-guidelines.md).

### D.2 Portal
- `pages/portal/home.tsx`, `pages/portal/catalog-category.tsx` — consume the new `/portal/catalog` shape (categories → request_types). Rename props / fields.
- `pages/portal/submit-request.tsx` — submit DTO takes `request_type_id` only; remove any `service_item_id` branch.
- Update trace-display components (if any) to read the new jsonb shape (`request_type_id` instead of `service_item_id`).

### D.3 Type-check + build + visually smoke
```bash
pnpm --filter @prequest/web typecheck
pnpm --filter @prequest/web build
pnpm dev                        # run both, hit /admin/catalog-hierarchy + /portal
```

Visual smoke checklist (live-doc §6 rules):
- [ ] `/admin/catalog-hierarchy` opens, tree renders, side-panel edits a request type end-to-end.
- [ ] Coverage matrix row click opens detail panel with effective handler trace.
- [ ] `/portal` home lists request types under categories with the expected intake gates.
- [ ] Submit a ticket end-to-end; `tickets.requested_for_person_id` lands on the row.

**Commit boundary D.** Commit message: `refactor(catalog): rewire admin+portal UI to request-type-native`.

**Codex review D** — against live-doc §8 admin UX and the matrix contract.

**Risk ledger for D:**
- Coverage-matrix row detail is net-new functionality per live-doc §8 (no equivalent in service-item admin today). Scope it to the required effective-value stack; do not reintroduce service-item-style offerings management as a secondary surface.
- React-query key migration: if any hook still keys on `'service-items'`, cache won't invalidate properly. Grep: `grep -r "service.items" apps/web/src/api/` — must return zero at end of D.

---

## Phase E — Hard cleanup (drop service_items infra)

**Goal:** Remove every artifact of the split. No legacy readers, no triggers, no wrapper functions, no feature flag.

**Pre-flight before running E:** `grep -r "service_item\|service-item\|serviceItem\|getCatalogV2\|service_catalog_read\|portal_availability_trace\|portal_visible_service_item_ids\|portal_onboardable_space_ids_v2\|portal_requestable_trace\|service_catalog:manage" apps/ packages/` must return zero hits. If any remain, fix them in a C/D follow-up commit before dropping.

**Deliverables:**

1. **Migration `00092_drop_service_catalog_split.sql`**
   - Drop triggers: `trg_mirror_rtc_delete`, `trg_mirror_rtc_insert`, `trg_auto_pair_service_item`, `trg_mirror_rt_update_to_si`, `set_service_items_updated_at`.
   - Drop functions:
     - `mirror_request_type_category_delete`, `mirror_request_type_category_insert`
     - `auto_pair_service_item_for_request_type`
     - `mirror_request_type_update_to_service_item`
     - `portal_visible_service_item_ids(uuid, uuid, uuid)`
     - `service_item_offering_matches(uuid, uuid, uuid)`
     - `portal_requestable_trace(uuid, uuid, uuid, uuid, uuid, uuid)` (service-item-backed)
     - `portal_onboardable_space_ids_v2(uuid, uuid)`
     - `portal_visible_request_type_ids(uuid, uuid, uuid)` (bridge wrapper)
     - `portal_availability_trace(uuid, uuid, uuid, uuid)` (bridge wrapper)
     - `portal_onboardable_locations(uuid)` (legacy, confirmed unused after Phase C)
   - Drop view: `fulfillment_types`.
   - Drop tables (cascade is OK — everything FK-targeting these goes with them): `service_item_on_behalf_rules`, `service_item_form_variants`, `service_item_criteria`, `service_item_offerings`, `service_item_categories`, `request_type_service_item_bridge`, `service_items`.
   - Remove permission `service_catalog:manage` from seeded role permissions (keep `criteria_sets:manage` — still valid; request_type_audience_rules / form_variants / on_behalf_rules all reference `criteria_sets`).
   - `notify pgrst, 'reload schema';`

2. Purge `service_catalog_read` references:
   - `apps/api/src/modules/portal/portal.service.ts` — ensure the flag check is gone (Phase C should have done this; double-check).
   - Grep repo: `grep -r service_catalog_read apps/ packages/` — must be empty.
   - If any tenants have the flag set in `tenants.feature_flags`, clear it in a short SQL UPDATE in the same migration (`update public.tenants set feature_flags = feature_flags - 'service_catalog_read' where feature_flags ? 'service_catalog_read';`).

3. Grep for leftover `service_item` / `service-item` / `serviceItem` references across the repo — expect zero in `apps/` and `packages/`.

4. Remove `docs/service-catalog-redesign.md` reference notes from CLAUDE.md if any (none expected; CLAUDE.md points at the live doc).

**Local validate + push to remote.**

**Smoke after push:** all the service-item tables are gone, request_type_* tables still have data, `/portal/catalog` + `/admin/catalog-hierarchy` still work.

**Commit boundary E.** Commit message: `chore(catalog): drop service_items tables, triggers, view, and wrappers`.

**Codex review E** — final sweep for leftover references, stale comments, and doc drift.

**Risk ledger for E:**
- Dropping tables before confirming Phase D is deployed is how data disappears. Invariant: **E runs only after D is merged and the app is verified working against request_type_* tables.**
- `criteria_sets` stays — confirm no attempt to drop it.
- `tickets.requested_for_person_id` stays — confirm no column drop.

---

## Phase F — Docs

**Goal:** Living docs reflect the shipped reality. `service-catalog-live.md` is the only forward-looking source.

**Deliverables:**

1. `docs/service-catalog-live.md` — replace §11 (Implementation Plan) with a short "Status: shipped" block referencing migrations 00085-00092, merged commits, and date.
2. `docs/service-catalog-redesign.md` — strengthen the top-of-file superseded note; add a one-line pointer "do not copy any schema from this doc."
3. `docs/assignments-routing-fulfillment.md` — §15/§18 triggers list: nothing in this collapse changed routing behavior, but the doc mentions `case_owner_policy_entity_id` and `child_dispatch_policy_entity_id` as columns on `request_types` — still accurate. Verify no drift; add a note that scope-overrides now also carry these policy IDs (live-doc §5.5).
4. `docs/visibility.md` — no change expected (visibility is orthogonal). Confirm no service_item reference.
5. CLAUDE.md — if it still references the split, update. Expected: already clean.

**Commit boundary F.** Commit message: `docs(catalog): mark collapse complete; refresh references`.

**No codex review needed for F** — it's doc hygiene; user will read the updated docs directly.

---

## 2. Sequencing recap

```
A (schema add) → push → codex review
                ↓
B (predicates) → push → codex review
                ↓
C (backend rewire) + D (frontend rewire) → commit together → codex review
                ↓
E (hard cleanup) → push → codex review
                ↓
F (docs)
```

C and D ship together because the API and UI contracts flip at the same boundary; splitting would leave the app broken for one commit.

## 3. Cross-phase risks

- **Auto-pair trigger still fires during A/B/C/D.** While service_items/bridge/mirror triggers still exist, every `INSERT into request_types` still creates a paired service_item + offerings + default form variant, and every `UPDATE` mirrors changes through. This is fine — we're reading the new shape, but the old shape stays consistent as a safety net. **Phase E removes all of this in one go.**
- **No tests to update.** Grep confirms no spec files under `apps/api/src/modules/service-catalog/` or `apps/api/src/modules/portal/` with service_item assertions. Add test coverage opportunistically during Phase C (at least one portal-submit flow + one catalog trace) — not a gate.
- **No other module imports `service_items`.** If one is found during A/B audit, stop and reassess.

## 4. Done criteria

- [ ] Migrations 00085-00092 applied on remote.
- [ ] Zero rows in `information_schema.tables` matching `service_item%` or `request_type_service_item_bridge`.
- [ ] Zero functions matching `service_item%` or `portal_onboardable_space_ids_v2`.
- [ ] `grep -r "service.item" apps/ packages/` returns nothing.
- [ ] `grep -r "service_catalog_read" apps/ packages/` returns nothing.
- [ ] `/admin/catalog-hierarchy` and `/portal` both work; ticket submit records `requested_for_person_id`.
- [ ] `docs/service-catalog-live.md` marked shipped.
- [ ] `docs/service-catalog-redesign.md` has superseded header.
