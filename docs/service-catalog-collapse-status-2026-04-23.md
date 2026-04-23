# Service catalog collapse — end-of-session status (2026-04-23)

**Source of truth:** [docs/service-catalog-live.md](./service-catalog-live.md). **Operational reference:** [docs/assignments-routing-fulfillment.md](./assignments-routing-fulfillment.md) (§23 shipped log + §24 scope-override contract). **Superseded:** [docs/service-catalog-redesign.md](./service-catalog-redesign.md).

This doc is the hand-off snapshot — read it when resuming the catalog work.

## 1. What shipped

Phases A → G of the collapse are complete end-to-end: schema, runtime, admin, docs, destructive cleanup, and the runtime scope-override integration. Everything below is on `main` and on the remote Supabase project (`iwbqnyrvycqgnatratrk`).

### 1.1 Migrations (numeric order, remote-applied)

| # | File | Summary |
|---|---|---|
| 00085 | `request_types_portal_columns.sql` | add `kb_link`, `disruption_banner`, `on_behalf_policy` on `request_types`; backfill; clear 00073 deprecation comments |
| 00086 | `request_type_coverage_rules.sql` | create + backfill from `service_item_offerings` |
| 00087 | `request_type_audience_rules.sql` | create + backfill |
| 00088 | `request_type_form_variants.sql` | create + backfill; partial-unique default per RT |
| 00089 | `request_type_on_behalf_rules.sql` | create + backfill |
| 00090 | `request_type_scope_overrides.sql` | new table — handler/workflow/case-SLA/child-dispatch/executor-SLA per scope |
| 00091 | `scope_overrides_constraints.sql` | tightened CHECK constraints (dropped `handler_kind='user'`, added non-empty guard) + partial-uniques (later dropped in 00101) |
| 00092 | `request_type_predicates.sql` | `request_type_visible_ids`, `_offering_matches`, `_requestable_trace`, `_onboardable_space_ids` |
| 00093 | `predicates_perf_fix.sql` | ancestor-once walk + grouped audience pass |
| 00094 | `request_type_replace_fns.sql` | atomic replace-set plpgsql per satellite + coverage-rules active-unique |
| 00096 | `effective_scope_override.sql` | shared precedence walker (`request_type_effective_scope_override`) |
| 00097 | `drop_service_catalog_split.sql` | **Phase E** — dropped all `service_item_*`, bridge, view, mirror triggers, legacy predicates, `service_catalog:manage` permission, `service_catalog_read` feature flag |
| 00098 | `drop_rt_form_schema_id.sql` | dropped `request_types.form_schema_id` — default form now lives only on `request_type_form_variants` |
| 00099 | `criteria_sets_org_support.sql` | rewrote `criteria_matches` to use org membership (after `persons.department/division` columns were dropped in 00079) |
| 00101 | `scope_override_scheduled_handoffs.sql` | dropped 00091's `uniq_rt_override_active_*` partial uniques so admins can stage scheduled handoffs; service-layer `validateNoTemporalOverlap` is now the sole arbiter |

*(00095 and 00100 are unrelated features shipped in parallel: inbound webhooks seed, centralised example seed.)*

### 1.2 Canonical runtime RPCs (post-cleanup)

All request-type-native. Legacy `portal_*` wrappers were dropped in Phase E.

- `public.request_type_visible_ids(actor, selected_space, tenant)` → setof uuid
- `public.request_type_offering_matches(rt, selected_space, tenant)` → matched coverage rows
- `public.request_type_requestable_trace(actor, rt, requested_for, selected_space, asset, tenant)` → jsonb (full trace, used by submit + simulator)
- `public.request_type_onboardable_space_ids(tenant, actor)` → setof uuid
- `public.request_type_effective_scope_override(tenant, rt, selected_space)` → jsonb (precedence walker)
- `public.request_type_replace_{categories,coverage,audience,form_variants,on_behalf_rules,scope_overrides}(rt, tenant, rows)` — atomic replace-set per satellite
- `public.criteria_matches(set_id, person_id, tenant)` — org-aware person matcher

### 1.3 Backend

- **Portal:** `PortalSubmitService` + `PortalService.getCatalog` + `getOnboardableLocations` all call `request_type_*` RPCs directly. DTO is `request_type_id` only. `/portal/catalog` returns `{ categories: [{ request_types: [...] }] }`.
- **Admin CRUD on `/request-types/:id/*`:** categories, coverage, audience, form-variants, on-behalf-rules, scope-overrides. All guarded by `request_types:manage`. Every replace-set routes through the plpgsql RPCs so delete+insert is one transaction. Cross-tenant FK validation on every referenced UUID (`assertIdsInTenant`).
- **Criteria sets (`/criteria-sets`):** CRUD + preview. Guarded by `criteria_sets:manage`. Expression grammar validated server-side (depth ≤ 3, eq/neq/in/not_in, attr whitelist). Preview evaluates against all active persons in the tenant and returns count + sample.
- **Scope-override resolver integration (Phase G):** `ScopeOverrideResolverService` (`apps/api/src/modules/routing/scope-override-resolver.service.ts`) wraps the precedence walker and centralizes effective-location derivation (`locationId → asset.assigned_space_id → null`). Consumed by:
  - `ResolverService.resolve` — pre-step; `handler_kind='team'|'vendor'` terminal wins; `handler_kind='none'` = explicit unassign terminal (`chosen_by='scope_override'` / `'scope_override_unassigned'`).
  - `TicketService.runPostCreateAutomation` — overrides `workflow_definition_id` + `case_sla_policy_id`.
  - `DispatchService.resolveChildSla` — `executor_sla_policy_id` slots in between explicit DTO and vendor/team defaults (asset-only children covered).
  - `RoutingEvaluatorService` v2 hooks — overrides `case_owner_policy_entity_id` / `child_dispatch_policy_entity_id`.
- **Deletions:** `apps/api/src/modules/service-catalog/` removed; `ServiceCatalogModule` unregistered in `app.module.ts`.

### 1.4 Frontend

- `/admin/catalog-hierarchy` is the single admin entry point for request-type catalog config. Side panel has five writable tabs:
  - **Basics** — name, description, icon, keywords, kb_link, disruption_banner, display_order, on_behalf_policy, active. Writes categories via `PUT /request-types/:id/categories`.
  - **Coverage** — per-site offered/not-offered toggle + scope-overrides read/edit. Inline scope-override editor (Sheet) handles scope picker, handler_kind (team/vendor/none/null), workflow/SLA/policy overrides, active + dates, delete.
  - **Audience** — writable inline editor for four audience modes (visible_allow/deny, request_allow/deny) + on-behalf rules (actor/target). Binds to criteria sets via `/criteria-sets`.
  - **Form** — lists default + conditional variants. Default is authored via the RT dialog's Linked Form Schema select; conditional authoring is the last remaining gap (see §2).
  - **Fulfillment** — domain, strategy, SLA, workflow, default team/vendor, approval, on_behalf_policy, intake requirements.
- `/admin/request-types` — slim fulfillment-only list (no portal fields).
- `/admin/criteria-sets` — new CRUD page + dialog with JSON textarea + Preview matches button.
- `/portal` home, catalog, submit all consume `request_types[]` shape.
- Desk create-ticket + ticket-detail fetch default form variant via `/request-types/:id/form-variants` (no more `rt.form_schema_id`).
- `ChosenBy` union in `packages/shared/src/types/routing.ts` and in both routing-studio files (`simulator.tsx`, `audit-tab.tsx`) now includes `scope_override` + `scope_override_unassigned`.

### 1.5 Tests

- **Unit (Jest):** `apps/api/src/modules/routing/scope-override-resolver.spec.ts` (5 cases), `apps/api/src/modules/ticket/dispatch-scope-override.spec.ts` (4 cases), all prior resolver / dispatch / scenarios / ticket / evaluator specs updated with scope-override stubs. 242 pass, 0 fail, 1 skip.
- **SQL integration:** `supabase/tests/scope_override_precedence.test.sql` — 12 cases covering every precedence tier + null-space + disjoint space + inherit=false + all-inactive + starts_at future/past + same-tier id tie-break + multi-group. Run via `psql -f ...`; 12/12 PASS.

### 1.6 Commits (chronological)

```
c4ccc61 feat(catalog): add request-type-native portal columns and satellite tables         [Phase A schema]
29ddf0e fix(catalog): tighten request_type_scope_overrides constraints
5da85f1 feat(catalog): add request-type-native portal predicates                           [Phase B]
9e02e54 perf(catalog): ancestor-once + grouped audience pass on request-type predicates
720f6f2 refactor(portal): point submit, catalog, and simulator at request-type-native predicates  [Phase C]
d9ebc3a feat(request-types): add admin CRUD for categories, coverage, audience, variants, on-behalf, scope-overrides
f8619dc refactor(catalog): rewire admin + portal UI to request-type-native endpoints       [Phase D]
2523ac0 docs(catalog): sync living docs with the request-types collapse
d1404db fix(catalog): guard satellite GETs, tenant-validate writes, freeze legacy mutators [codex fix pass 1]
68383f9 fix(catalog): atomic replace-set via plpgsql + active-unique on coverage
1f653b3 fix(admin): retire stale RT-dialog fields, sync default form variant, surface scope overrides
fb22831 docs(catalog): refresh stale predicate names post-collapse
46fb94a feat(routing): consume request_type_scope_overrides at runtime (Phase G)
2521721 fix(routing): centralize effective-location derivation + asset-only child SLA + precedence tests
9f31d5c chore(catalog): drop service_items infrastructure (Phase E)
8ae6472 docs(catalog): mark Phase E + Phase G shipped
89df35c fix(catalog): close codex post-Phase-E review findings                              [codex fix pass 2]
5fe278b feat(catalog): drop request_types.form_schema_id; fix scope-override scheduled handoffs + simulator label
78035da feat(admin): inline scope-override editor in catalog coverage tab
1b7bdbd feat(config-engine): criteria sets — shared org + scope predicates                 [parallel tooling]
33dc7e2 chore(admin): wire criteria sets, SLA detail, and webhook admin routes             [parallel tooling]
d8fe186 feat(admin): writable audience + on-behalf editor in catalog panel
```

## 2. What's still pending

Ordered by practical priority. Nothing is a blocker — everything below is net-new capability or polish.

### 2.1 Conditional form-variant authoring (small)

The Form tab in the catalog panel is read-only for conditional variants (criteria_set_id != null). The default variant is authored via the RT dialog. Gap: there's no way to add / edit / remove priority-ranked conditional variants without SQL.

**Shape:** same as the audience tab pattern — a table with a list of active conditionals (criteria_set badge + form_schema badge + priority + active toggle), add row via two Selects + numeric priority, remove row. Reuses `PUT /request-types/:id/form-variants` (replace-set; must preserve default when editing conditionals and vice versa).

### 2.2 Coverage matrix UI (live-doc §8 — big net-new)

Admin UX debt. The coverage tab today shows "offered / not offered / inherited" per site. The live-doc §8 target adds columns for **effective handler**, **effective workflow**, **effective case SLA**, **effective child dispatch policy**, **effective executor SLA**, plus override drawers.

**Scope:**
- Backend: a new SQL function (or `GET /request-types/:id/coverage-matrix` endpoint) that for each active site/building runs the `request_type_effective_scope_override` lookup + the base routing-team lookup + the request_types defaults, and returns the composed row: `{ site_id, site_name, offered, handler_kind, handler_id, handler_name, handler_source: 'override'|'routing'|'default', workflow_id, workflow_source, case_sla_id, case_sla_source, child_dispatch_id, child_dispatch_source, executor_sla_id, executor_sla_source }`.
- Frontend: replace the simple per-site toggle table with the richer matrix. Row click opens a drawer explaining which rule won (the existing `scope-override-editor` could be reused when the row is an override-originated decision).

Worth building AFTER the form-variant authoring since it's a bigger diff and will merge with the ongoing admin UX direction.

### 2.3 Known deferred decisions / soft rough edges

- **`request_types.form_schema_id`** — dropped (00098). If external integrations referenced it, they need an update; none found in-repo.
- **Core `GET /request-types` + `GET /request-types/:id`** are unguarded today (any authenticated tenant user can read them). Codex flagged this as a product call. If tightened, pick a permission or add a read-only role.
- **Temporal overlap on scope overrides** — service-layer enforced (no overlapping active rows on same scope-target). DB-level now permissive; if that re-tightens later, use a tsrange-exclude constraint.
- **Non-handler-field "clear at scope" semantic** — currently null in an override means "fall through to request-type default." There's no way to say "override to null explicitly at this scope." Probably never needed; flagged by codex as a fork to decide only if asked.
- **Test coverage expansion** — the Jest suite doesn't yet cover the new request-type admin CRUD endpoints end-to-end with a real tenant; integration tests would need an MSW or test-DB harness.
- **`criteria_matches` grammar** — now org-aware (00099 rewrote it). If attr whitelist in `criteria-set.service.ts` drifts from what the plpgsql evaluator actually supports, preview/save behavior diverges. Keep them in sync.

## 3. Memory

Memory file `project_service_catalog_redesign_shipped.md` has been updated with the post-collapse shape and should be read at session start. CLAUDE.md reference to `docs/service-catalog-live.md` as the source of truth is correct.

## 4. Context-clearing note

When you resume:
1. Read this file first.
2. Read `docs/service-catalog-live.md` §11 for the shipped-vs-pending table.
3. For routing/runtime work, read `docs/assignments-routing-fulfillment.md` §24 (scope-override contract).
4. Memory auto-loads the project-shipped snapshot.
5. Next slice: pick between **conditional form-variant authoring** (quick, §2.1) or **coverage matrix UI** (bigger, §2.2).
