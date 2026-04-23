# Service Catalog Redesign — v3 (LOCKED, codex-approved)

> Superseded on 2026-04-23 by [docs/service-catalog-live.md](./service-catalog-live.md).
> Do not continue implementation from this split `service_items` / `request_types` model.
> The live architecture has collapsed back to a single request-type-centered model.

**Status:** v3 locked. v1 rejected → v2 approved-with-changes → v3 closes the three remaining items (form-variant backfill, onboardable-compat path, criteria effective-dating) and applies codex's §13 answers. Ready for implementation.
**Scope:** Replace request-type-as-portal-card with a 5-concept model (employee context · location auth · service item · coverage · fulfillment type). Derives from ServiceNow catalog items + user criteria, Jira request-type-vs-work-type, TOPdesk service catalogue.

---

## Changelog v2 → v3

1. **Form-variant backfill.** Phase 1 backfill now seeds a default variant into `service_item_form_variants` for every RT that has `form_schema_id` set. Post-cutover, the catalog always resolves a form.
2. **Onboardable-locations compat resolved.** The legacy `portal_onboardable_locations(p_tenant_id)` function is kept but deprecated. The `/portal/me/onboard-locations` controller resolves `authUid → person_id` and calls the v2 function directly. No ambiguous "hypothetical actor" path.
3. **Criteria effective-dating implemented.** `service_item_criteria` and `service_item_form_variants` get `starts_at`, `ends_at`, `active`. Predicates filter at render time (no cron).
4. **Grammar: drop `is_manager`.** Only `type, department, division, cost_center, manager_person_id` in phase 1. `manager_person_id` is referenced solely by the built-in `direct_reports` on-behalf policy.
5. **Simulator naming:** `portal_availability` retained on compat surfaces (already-shipped simulator response shape); `portal_requestable` used only on v2-native endpoints/traces.

## Changelog v1 → v2

1. **Back-compat via wrapper functions, not views.** Shipped contracts (`portal_visible_request_type_ids(uuid, uuid, uuid)`, `portal_availability_trace(uuid, uuid, uuid, uuid)`) are parameterized RPCs — can't be wrapped by a view. Compat layer = legacy functions that delegate to the new ones via the bridge table (§3.9). No fabricated view.
2. **Phase 5 no longer drops `request_types` columns.** Dropping name/description/icon/form_schema_id breaks `TicketService.runPostCreateAutomation`, desk ticket-detail rendering, and request-type CRUD. Phase 5 stops using them as source-of-truth but leaves them populated for legacy readers. A "sunset" phase (6, out of this slice) can drop them after legacy callers migrate.
3. **Phase-1 backfill preserves current visibility semantics — not widens them.** Backfill creates **per-space offerings** under every active site/building that currently has granularity-eligible descendants for each RT, mirroring today's `portal_visible_request_type_ids` behavior. No tenant-scope offerings auto-created in phase 1. Tenant scope is an admin choice, not a migration default.
4. **Categories stay M2M.** New `service_item_categories(service_item_id, category_id)` join table mirrors existing `request_type_categories`. No collapse to a single FK.
5. **Offering scopes trimmed to `tenant + space + space_group` in phase 1.** `country / business_unit / legal_entity` are actor-attribute restrictions, which is what criteria already does — modeling them in two places creates drift. Those can become a criteria-extension later when `persons` gets normalized country/legal-entity fields.
6. **`fulfillment_types` alias fully projects internal fields** including `domain_id`, `case_owner_policy_entity_id`, `child_dispatch_policy_entity_id`. Read-only alias in phase 1, promoted to a real table in phase 5.
7. **`portal_requestable_trace` is a strict superset of the shipped `portal_availability_trace`.** All auth-provenance fields (matched_root_id, matched_root_source, grant_id, has_any_scope, effective_location_id, failure_reason, etc.) retained. Trace remains portal-local — not stored on tickets (contradicting v1).
8. **Subset relation corrected: `requestability ⊆ visibility`.** You can never submit what you can't see; you can see things you can't submit (e.g., announcements).
9. **RLS added to every new table.** No silent gap for `service_item_on_behalf_lists`.
10. **Three feature flags, not two.** `service_catalog_read` / `service_catalog_write` / `service_catalog_submit` — admin can cut read over first, verify, then flip submit.
11. **Request-type-id ↔ service-item-id bridge table is explicit** (§3.9) so legacy clients/bookmarks/API callers using the old id continue to resolve. Many-service-items-per-fulfillment is unambiguous because the bridge records the *canonical paired* service item.
12. **Requester vs requested-for split** — a ticket now records both (§6.2). Requester = who submitted (auth-bound). requested_for = who the service is for.
13. **Effective dating on offerings and criteria** (optional `starts_at / ends_at`) so admins can schedule services/outages without manual on/off toggles.
14. **Form variant tie-breaks** — priority desc, then created_at asc. Explicit default variant per item (1 row with `criteria_set_id IS NULL`, at most one).
15. **Criteria grammar — absent-attribute semantics stated.** Missing attr on actor → `eq` false, `neq` true, `in` false, `not_in` true. Prevents null-coercion ambiguity.
16. **`on_behalf_policy` split into actor + target criteria.** The policy specifies both who may act-on-behalf and who they may act for.

---

## 1. The five concepts

Mixing these is what makes ServiceNow's admin UX painful. Keep them strictly separated.

### 1.1 Employee context (shipped, extended)
`persons` + `users` + `user_role_assignments`. Attributes we reference: `type`, `department`, `division`, `cost_center`, `manager_person_id`, plus (future) `employment_type`, `preferred_language`. **Not yet** `country`, `legal_entity`, `business_unit` — deferred until the `persons` schema gets normalized fields for them.

Used for: criteria evaluation (§3.3), on-behalf-of, form variant selection, audit.

### 1.2 Location authorization (shipped, unchanged)
`persons.default_location_id` + `person_location_grants`. Sole question: *where may this actor submit from?*

Used for: authorizing the selected location at submit.

### 1.3 Service item (new)
Portal-facing card. Title, description, icon, categories (M2M), search terms, KB link, disruption banner, fulfillment type, on-behalf policy.

### 1.4 Coverage (new)
`service_item_offerings`. Scope kinds in phase 1: **tenant, space, space_group**. `space` scope can inherit to descendants. No actor-attribute offerings in phase 1 — those live in criteria.

### 1.5 Fulfillment type (rename of request_types)
Internal operational definition. Workflow, SLA, routing domain (+ `domain_id` FK), case/work-order strategy, intake requirements, v2 policy-entity FKs. **Multiple service items can share one fulfillment type.**

---

## 2. Relationships

```
Employee ──┬─ authorized_locations (scope set)
           └─ attributes → criteria evaluation

Service Item
  ├── service_item_categories (M2M)
  ├── offerings (N) ──▶ coverage
  ├── criteria (N: visible_allow|visible_deny|request_allow|request_deny)
  ├── form_variants (N, priority desc, created_at asc tiebreak)
  ├── on_behalf_policy (with optional actor_criteria + target_criteria)
  └── fulfillment_type_id (N→1)

Fulfillment Type
  ├── workflow_definition_id
  ├── sla_policy_id
  ├── domain_id (FK to domains) + legacy domain text (kept during migration)
  ├── case_owner_policy_entity_id, child_dispatch_policy_entity_id (routing v2)
  ├── intake: requires_location, location_required, location_granularity,
  │           requires_asset, asset_required, asset_type_filter
  └── defaults: default_team_id, default_vendor_id
```

**Invariant:** `requestability ⊆ visibility`. Submit always re-checks visibility.

---

## 3. Data model

All tables tenant-scoped. RLS `tenant_isolation` policy on every one.

### 3.1 `service_items`

```sql
create table public.service_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  key text not null,                     -- stable machine key, e.g. 'fix-broken-laptop'
  name text not null,
  description text,
  icon text,
  search_terms text[] not null default '{}',
  kb_link text,
  disruption_banner text,
  on_behalf_policy text not null default 'self_only'
    check (on_behalf_policy in ('self_only','any_person','direct_reports','configured_list')),
  fulfillment_type_id uuid not null,     -- FK enforced at service layer in phase 1; hard FK in phase 5
  display_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);
alter table public.service_items enable row level security;
create policy "tenant_isolation" on public.service_items
  using (tenant_id = public.current_tenant_id());
create index idx_service_items_tenant on public.service_items (tenant_id);
create index idx_service_items_fulfillment on public.service_items (fulfillment_type_id);
```

### 3.2 `service_item_categories` (M2M)

Mirrors `request_type_categories`. One service item can appear in multiple portal categories.

```sql
create table public.service_item_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  category_id uuid not null references public.service_catalog_categories(id) on delete cascade,
  display_order int not null default 0,
  unique (service_item_id, category_id)
);
alter table public.service_item_categories enable row level security;
create policy "tenant_isolation" on public.service_item_categories
  using (tenant_id = public.current_tenant_id());
```

### 3.3 `service_item_offerings` (phase-1 scopes)

```sql
create table public.service_item_offerings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  scope_kind text not null check (scope_kind in ('tenant','space','space_group')),
  space_id uuid references public.spaces(id),
  space_group_id uuid references public.space_groups(id),
  inherit_to_descendants boolean not null default true,
  starts_at timestamptz,                 -- effective dating
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (
    (scope_kind = 'tenant'       and space_id is null and space_group_id is null) or
    (scope_kind = 'space'        and space_id is not null and space_group_id is null) or
    (scope_kind = 'space_group'  and space_id is null and space_group_id is not null)
  ),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);
alter table public.service_item_offerings enable row level security;
create policy "tenant_isolation" on public.service_item_offerings
  using (tenant_id = public.current_tenant_id());
create index idx_offerings_item on public.service_item_offerings (service_item_id);
create index idx_offerings_space on public.service_item_offerings (space_id) where space_id is not null;
create index idx_offerings_group on public.service_item_offerings (space_group_id) where space_group_id is not null;
```

### 3.4 `criteria_sets`

```sql
create table public.criteria_sets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  description text,
  expression jsonb not null,             -- see §3.4a
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table public.criteria_sets enable row level security;
create policy "tenant_isolation" on public.criteria_sets
  using (tenant_id = public.current_tenant_id());
```

**§3.4a Expression grammar (MVP, bounded depth = 3):**

Supported composites: `all_of` (AND), `any_of` (OR), `not` (NOT, single child).
Supported leaf ops: `eq`, `neq`, `in`, `not_in`.
Supported actor attrs (phase 1): `type`, `department`, `division`, `cost_center`, `manager_person_id`. `is_manager` dropped pending manager-chain materialization; use `direct_reports` on-behalf policy if you need manager-relationship gating in phase 1.

**Absent-attribute semantics** (no ambiguity):
- `eq` / `in` → **false** when the attr is null on the actor.
- `neq` / `not_in` → **true** when the attr is null.
- `not(expr)` flips the result of `expr` (not the attr check).

Example:

```jsonc
{
  "all_of": [
    { "attr": "department", "op": "eq", "value": "Engineering" },
    {
      "any_of": [
        { "attr": "type", "op": "eq", "value": "employee" },
        { "attr": "type", "op": "eq", "value": "contractor" }
      ]
    }
  ]
}
```

Evaluated by `public.criteria_matches(p_set_id, p_person_id, p_tenant_id)` → `boolean`. Loads the person attributes **once** per call; does not rely on Postgres request-level caching (codex Q7 answer). For multi-item catalog renders, the calling service preloads the actor's attrs into a map once and passes it into a batched variant (`criteria_matches_batch(set_ids[], person_id, tenant)`).

### 3.5 `service_item_criteria`

```sql
create table public.service_item_criteria (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  criteria_set_id uuid not null references public.criteria_sets(id),
  mode text not null check (mode in ('visible_allow','visible_deny','request_allow','request_deny')),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (service_item_id, criteria_set_id, mode),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);
alter table public.service_item_criteria enable row level security;
create policy "tenant_isolation" on public.service_item_criteria
  using (tenant_id = public.current_tenant_id());
```

**Mode semantics (subset relation corrected):**
- Set of visible items = all items passing `visible_allow` (if any) minus `visible_deny`.
- Set of requestable items = (visible items) intersected with items passing `request_allow` (if any) minus `request_deny`.
- Therefore **`requestable ⊆ visible`** strictly.
- `*_allow` rows: if zero are configured → default allow. If ≥1 configured → actor must match at least one.
- `*_deny` rows: if any match → reject.

### 3.6 `service_item_form_variants`

```sql
create table public.service_item_form_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  criteria_set_id uuid references public.criteria_sets(id),  -- NULL = default variant
  form_schema_id uuid not null references public.config_entities(id),
  priority int not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (starts_at is null or ends_at is null or starts_at < ends_at)
);
alter table public.service_item_form_variants enable row level security;
create policy "tenant_isolation" on public.service_item_form_variants
  using (tenant_id = public.current_tenant_id());
-- At most one default variant per service_item
create unique index uniq_service_item_default_variant
  on public.service_item_form_variants (service_item_id)
  where criteria_set_id is null;
```

**Match rule:** consider only variants with `active=true` AND `(starts_at is null OR starts_at <= now())` AND `(ends_at is null OR ends_at > now())`. Order by `priority desc, created_at asc`. First variant whose `criteria_set_id` matches actor wins. A variant with `criteria_set_id = null` is the fallback default.

### 3.7 On-behalf-of split

Actor (can request on behalf) vs target (who they can request for).

```sql
create table public.service_item_on_behalf_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  role text not null check (role in ('actor','target')),
  criteria_set_id uuid not null references public.criteria_sets(id),
  created_at timestamptz not null default now()
);
alter table public.service_item_on_behalf_rules enable row level security;
create policy "tenant_isolation" on public.service_item_on_behalf_rules
  using (tenant_id = public.current_tenant_id());
```

Evaluation when `on_behalf_policy = 'configured_list'`:
- Actor must satisfy at least one `role='actor'` criteria (if any configured).
- Target (the `requested_for` person) must satisfy at least one `role='target'` criteria (if any configured).
- If `configured_list` with zero rules, equivalent to `any_person` behavior. (Explicit; admin should attach criteria.)

For the other policies:
- `self_only` — actor == target only.
- `any_person` — any active person in the tenant.
- `direct_reports` — target's `manager_person_id = actor.person_id` (one level; can extend to chain later).

### 3.8 `fulfillment_types` alias (phase 1 view, phase 5 table)

Projects EVERY internal operational column from `request_types`. Read-only for phase 1. Callers migrate to this alias; the flip in phase 5 swaps the view for a real table.

```sql
create view public.fulfillment_types as
  select
    id, tenant_id,
    domain,                                  -- legacy text domain
    domain_id,                                -- FK added by 00039
    workflow_definition_id,
    sla_policy_id,
    default_assignment_policy_id,             -- legacy; deprecated marker already set
    case_owner_policy_entity_id,              -- routing v2
    child_dispatch_policy_entity_id,          -- routing v2
    fulfillment_strategy,
    requires_asset, asset_required, asset_type_filter,
    requires_location, location_required, location_granularity,
    default_team_id, default_vendor_id,
    requires_approval, approval_approver_team_id, approval_approver_person_id,
    active, created_at, updated_at
  from public.request_types;
```

### 3.9 Bridge: `request_type_service_item_bridge`

Explicit mapping from legacy `request_type_id` to its canonical paired `service_item_id`. Unblocks legacy API callers / deep links / tickets that reference `ticket_type_id`.

```sql
create table public.request_type_service_item_bridge (
  tenant_id uuid not null references public.tenants(id),
  request_type_id uuid not null references public.request_types(id) on delete cascade,
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  primary key (request_type_id),
  unique (service_item_id)   -- one canonical service item per RT (the backfilled 1:1 pair)
);
alter table public.request_type_service_item_bridge enable row level security;
create policy "tenant_isolation" on public.request_type_service_item_bridge
  using (tenant_id = public.current_tenant_id());
```

Backfill migration seeds this 1:1. Admins who later create additional service items for the same fulfillment type do NOT add bridge rows — the bridge is only for the legacy pair. New service items have their own ids; legacy clients using the old RT id only resolve to the paired canonical service item.

### 3.10 `tickets` — requester vs requested-for

New column `requested_for_person_id` (nullable → defaults to requester). Existing `requester_person_id` continues to mean *who submitted* (auth-bound).

```sql
alter table public.tickets
  add column if not exists requested_for_person_id uuid references public.persons(id);

comment on column public.tickets.requester_person_id is
  'Who submitted the ticket (auth-bound on portal path).';
comment on column public.tickets.requested_for_person_id is
  'Who the service is for. Equals requester_person_id when on_behalf_policy=self_only or when requester acts for self.';
```

---

## 4. Core predicates

Single source of truth for every "can X see/submit Y" decision.

### 4.1 `portal_visible_service_item_ids(actor_person_id, selected_space_id, tenant_id)`

```sql
create or replace function public.portal_visible_service_item_ids(
  p_actor_person_id uuid,
  p_selected_space_id uuid,         -- may be null
  p_tenant_id uuid
) returns setof uuid language sql stable as $$
  with
    -- Preload actor attributes once per invocation (codex Q7).
    actor as (
      select type, department, division, cost_center, manager_person_id
      from public.persons where id = p_actor_person_id and tenant_id = p_tenant_id
    ),
    -- Items active in tenant
    items as (
      select si.* from public.service_items si
      where si.tenant_id = p_tenant_id and si.active = true
    ),
    -- Items whose offerings cover (selected_space, now)
    offer_match as (
      select distinct o.service_item_id
      from public.service_item_offerings o
      where o.tenant_id = p_tenant_id and o.active = true
        and (o.starts_at is null or o.starts_at <= now())
        and (o.ends_at   is null or o.ends_at   >  now())
        and (
          -- tenant scope: always matches (including null selected)
          o.scope_kind = 'tenant'
          or (
            -- space scope: selected space equals offering space, or is a descendant when inherit
            o.scope_kind = 'space'
            and p_selected_space_id is not null
            and (
              (o.inherit_to_descendants = true
                and p_selected_space_id in (
                  select * from public.expand_space_closure(array[o.space_id])
                )
              )
              or (o.inherit_to_descendants = false and o.space_id = p_selected_space_id)
            )
          )
          or (
            -- space group scope: selected space is a member
            o.scope_kind = 'space_group'
            and p_selected_space_id is not null
            and exists (
              select 1 from public.space_group_members m
              where m.space_group_id = o.space_group_id
                and m.space_id = p_selected_space_id
            )
          )
        )
    ),
    -- Deny criteria: any visible_deny match → hide
    deny_hit as (
      select sic.service_item_id
      from public.service_item_criteria sic
      where sic.tenant_id = p_tenant_id and sic.mode = 'visible_deny'
        and sic.active = true
        and (sic.starts_at is null or sic.starts_at <= now())
        and (sic.ends_at   is null or sic.ends_at   >  now())
        and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
    ),
    -- Allow criteria: item has any allow rows? actor must match one.
    allow_required as (
      select sic.service_item_id
      from public.service_item_criteria sic
      where sic.tenant_id = p_tenant_id and sic.mode = 'visible_allow'
        and sic.active = true
        and (sic.starts_at is null or sic.starts_at <= now())
        and (sic.ends_at   is null or sic.ends_at   >  now())
    ),
    allow_hit as (
      select sic.service_item_id
      from public.service_item_criteria sic
      where sic.tenant_id = p_tenant_id and sic.mode = 'visible_allow'
        and sic.active = true
        and (sic.starts_at is null or sic.starts_at <= now())
        and (sic.ends_at   is null or sic.ends_at   >  now())
        and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
    )
  select i.id
  from items i
  where i.id in (select service_item_id from offer_match)
    and i.id not in (select service_item_id from deny_hit)
    and (
      i.id not in (select service_item_id from allow_required)
      or i.id in (select service_item_id from allow_hit)
    );
$$;
```

### 4.2 `portal_requestable_trace(...)` — superset of shipped `portal_availability_trace`

Returns all shipped fields + new ones. All fields always present.

```ts
interface PortalRequestableTrace {
  // Carried forward from portal_availability_trace (unchanged semantics)
  authorized: boolean;
  has_any_scope: boolean;
  effective_location_id: string | null;
  matched_root_id: string | null;
  matched_root_source: 'default' | 'grant' | null;
  grant_id: string | null;
  visible: boolean;                 // was: "RT visible at location"; now: service item visible
  location_required: boolean;
  granularity: string | null;
  granularity_ok: boolean;
  overall_valid: boolean;
  failure_reason: string | null;

  // New for service catalog v2
  service_item_id: string;
  fulfillment_type_id: string;
  matched_offering_id: string | null;
  matched_form_variant_id: string | null;
  criteria: {
    visible_allow_required: boolean;
    visible_allow_ok: boolean;
    visible_deny_ok: boolean;
    request_allow_required: boolean;
    request_allow_ok: boolean;
    request_deny_ok: boolean;
  };
  on_behalf_ok: boolean;
  asset_type_filter_ok: boolean;
}
```

### 4.3 Back-compat wrapper functions (NOT views)

```sql
-- Phase 2 ships these alongside the new ones. Legacy callers keep working.
-- When service_catalog_read flag flips to v2_only (phase 4), the wrappers route
-- through the bridge so request_type_id inputs still resolve.

create or replace function public.portal_visible_request_type_ids(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_tenant_id uuid
) returns setof uuid language sql stable as $$
  -- Returns request_type_ids whose paired service_item is visible.
  select b.request_type_id
  from public.request_type_service_item_bridge b
  where b.tenant_id = p_tenant_id
    and b.service_item_id in (
      select * from public.portal_visible_service_item_ids(p_person_id, p_effective_space_id, p_tenant_id)
    );
$$;

create or replace function public.portal_availability_trace(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_request_type_id uuid,
  p_tenant_id uuid
) returns jsonb language plpgsql stable as $$
declare
  v_service_item_id uuid;
  v_trace jsonb;
begin
  select service_item_id into v_service_item_id
  from public.request_type_service_item_bridge
  where request_type_id = p_request_type_id and tenant_id = p_tenant_id;
  if v_service_item_id is null then
    -- RT has no paired service item (shouldn't happen post-backfill) → request type not found.
    return jsonb_build_object(
      'authorized', false, 'has_any_scope', false, 'effective_location_id', p_effective_space_id,
      'matched_root_id', null, 'matched_root_source', null, 'grant_id', null,
      'visible', false, 'location_required', false, 'granularity', null, 'granularity_ok', false,
      'overall_valid', false, 'failure_reason', 'request type not found'
    );
  end if;
  v_trace := public.portal_requestable_trace(p_person_id, v_service_item_id, p_person_id, p_effective_space_id, null, p_tenant_id);
  -- Project to the shipped shape (drop new-only fields for legacy callers).
  return v_trace - 'service_item_id' - 'fulfillment_type_id' - 'matched_offering_id'
                 - 'matched_form_variant_id' - 'criteria' - 'on_behalf_ok' - 'asset_type_filter_ok';
end;
$$;
```

### 4.4 `portal_onboardable_space_ids_v2(tenant_id, actor_person_id)`

Replaces `portal_onboardable_locations(tenant_id)` shipped today. Returns sites/buildings where at least one **visible** service item has an offering covering that space, assuming the hypothetical actor hasn't scoped yet. Actor_person_id is used only for criteria eval; does not consult authorized_locations (the whole point of onboarding is the actor has none yet).

```sql
create or replace function public.portal_onboardable_space_ids_v2(
  p_tenant_id uuid,
  p_actor_person_id uuid
) returns setof uuid language sql stable as $$
  -- Sites/buildings covered by a visible service item offering. Deny criteria
  -- applied; allow criteria defaulted to true when none configured.
  select distinct s.id
  from public.spaces s
  where s.tenant_id = p_tenant_id
    and s.active = true
    and s.type in ('site','building')
    and exists (
      select 1 from public.service_items si
      where si.tenant_id = p_tenant_id and si.active = true
        -- item has an offering matching this space
        and (
          exists (
            select 1 from public.service_item_offerings o
            where o.service_item_id = si.id and o.tenant_id = p_tenant_id and o.active = true
              and (o.starts_at is null or o.starts_at <= now())
              and (o.ends_at   is null or o.ends_at   >  now())
              and (
                o.scope_kind = 'tenant'
                or (o.scope_kind = 'space' and (
                  (o.inherit_to_descendants and s.id in (select * from public.expand_space_closure(array[o.space_id])))
                  or (not o.inherit_to_descendants and o.space_id = s.id)
                ))
                or (o.scope_kind = 'space_group' and exists (
                  select 1 from public.space_group_members m
                  where m.space_group_id = o.space_group_id and m.space_id = s.id
                ))
              )
          )
        )
        -- criteria pass (deny short-circuits, allow defaults to true) — effective-dating filtered
        and not exists (
          select 1 from public.service_item_criteria sic
          where sic.service_item_id = si.id and sic.mode = 'visible_deny'
            and sic.active = true
            and (sic.starts_at is null or sic.starts_at <= now())
            and (sic.ends_at   is null or sic.ends_at   >  now())
            and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
        )
        and (
          not exists (
            select 1 from public.service_item_criteria sic
            where sic.service_item_id = si.id and sic.mode = 'visible_allow'
              and sic.active = true
              and (sic.starts_at is null or sic.starts_at <= now())
              and (sic.ends_at   is null or sic.ends_at   >  now())
          )
          or exists (
            select 1 from public.service_item_criteria sic
            where sic.service_item_id = si.id and sic.mode = 'visible_allow'
              and sic.active = true
              and (sic.starts_at is null or sic.starts_at <= now())
              and (sic.ends_at   is null or sic.ends_at   >  now())
              and public.criteria_matches(sic.criteria_set_id, p_actor_person_id, p_tenant_id)
          )
        )
    );
$$;
```

**Legacy `portal_onboardable_locations(p_tenant_id)`:** deprecated in place. Kept for any external callers that still invoke it, retaining pre-v2 semantics (site/building with a granularity-eligible descendant, no per-person criteria). The `/portal/me/onboard-locations` controller is rewired to resolve `authUid → person_id` and call `portal_onboardable_space_ids_v2(tenant, person)` directly — not the legacy function. Two code paths, non-overlapping: the deprecated SQL function serves legacy SQL clients only, the new controller serves the portal UI.

---

## 5. API contracts

### 5.1 `GET /portal/catalog?location_id=X`

Response shape v2. Categories are plural per item because of the M2M.

```jsonc
{
  "selected_location": { "id":"…", "name":"Amsterdam HQ", "type":"building" },
  "categories": [
    {
      "id":"…", "name":"Facilities",
      "service_items": [
        {
          "id":"…", "key":"fix-broken-toilet", "name":"Fix a broken toilet",
          "description":"…", "icon":"wrench", "kb_link": null, "disruption_banner": null,
          "search_terms": [],
          "on_behalf_policy":"self_only",
          "form_schema_id":"…",
          "fulfillment": {
            "id":"…",
            "requires_location": true, "location_required": true,
            "location_granularity": "room",
            "requires_asset": false, "asset_required": false, "asset_type_filter": []
          }
        }
      ]
    }
  ]
}
```

Read-flag gates whether this endpoint queries `portal_visible_request_type_ids` (legacy) or `portal_visible_service_item_ids` (v2).

### 5.2 `POST /portal/tickets`

DTO v2:
```ts
interface PortalSubmitDto {
  service_item_id?: string;   // preferred
  request_type_id?: string;   // legacy; resolved via bridge when set
  location_id?: string | null;
  asset_id?: string | null;
  requested_for_person_id?: string | null;  // defaults to requester
  priority?: 'low'|'normal'|'high'|'urgent';
  impact?: string;
  urgency?: string;
  title: string;
  description?: string;
  form_data?: Record<string, unknown>;
}
```

Submit-flag gates which validator runs. Ticket is created with both `requester_person_id` (auth-bound) and `requested_for_person_id` (DTO; defaults to requester).

### 5.3 Admin — service items CRUD

- `GET/POST/PATCH/DELETE /admin/service-items`
- `PUT /admin/service-items/:id/categories` — replaces category bindings
- `PUT /admin/service-items/:id/offerings` — replaces offerings
- `PUT /admin/service-items/:id/criteria` — replaces criteria bindings
- `PUT /admin/service-items/:id/form-variants`
- `PUT /admin/service-items/:id/on-behalf-rules`
- `GET /admin/service-items/:id/coverage-linter` — routing reachability report (warnings, not gate)

All guarded by `service_catalog:manage` permission (new). Seeded on admin role in phase 1 migration.

### 5.4 Admin — criteria sets CRUD

- `GET/POST/PATCH/DELETE /admin/criteria-sets`
- `GET /admin/criteria-sets/:id/preview` — returns count + sample of matching persons

Guarded by `criteria_sets:manage` (seeded on admin).

### 5.5 Simulator (already shipped, extend)

`/routing/studio/simulate` accepts:
- `service_item_id` (preferred) OR `request_type_id` (legacy; resolved via bridge).
- Existing `simulate_as_person_id`, `current_location_id`, `acting_for_location_id`.
- New `requested_for_person_id` (for on-behalf simulation).

Returns `portal_requestable_trace` verbatim alongside the routing trace.

---

## 6. Migration strategy (5 phases + optional sunset)

**Invariant for every phase:** legacy portal + desk + admin continue to function. No flag-day.

### Phase 1 — additive schema + backfill
1. Migrations create: `service_items`, `service_item_categories`, `service_item_offerings`, `criteria_sets`, `service_item_criteria`, `service_item_form_variants`, `service_item_on_behalf_rules`, `request_type_service_item_bridge`. Add `tickets.requested_for_person_id`. Seed `service_catalog:manage` + `criteria_sets:manage` permissions on admin role.
2. Create `fulfillment_types` view (§3.8).
3. Backfill migration: for every active `request_types` row, insert paired `service_items` row + bridge row + `service_item_categories` rows mirroring existing `request_type_categories`. Insert `service_item_offerings` rows matching current visibility: for each site/building with granularity-eligible descendants under it, insert a `space`-scope offering. This preserves today's portal_visible_request_type_ids behavior *exactly* at the location the RT would currently appear.
4. Backfill default form variants: for every paired service_item whose request_type has `form_schema_id IS NOT NULL`, insert exactly one `service_item_form_variants` row with `criteria_set_id=NULL`, `form_schema_id=<rt.form_schema_id>`, `priority=0`, `active=true`. This guarantees post-cutover catalogs resolve to the same form the old RT pointed at.
5. No portal/admin code changes in phase 1 — the new tables populated but unused.

**Rollback:** delete new tables. Schema additive; no destructive changes to request_types.

### Phase 2 — backend predicates + wrapper functions
1. Ship `criteria_matches`, `portal_visible_service_item_ids`, `portal_requestable_trace`, `portal_onboardable_space_ids_v2`.
2. Rewrite the legacy `portal_visible_request_type_ids` and `portal_availability_trace` as wrappers over the v2 functions (via bridge). `portal_onboardable_locations` stays as-is with pre-v2 semantics (deprecation comment only); the `/portal/me/onboard-locations` controller is rewired to call `portal_onboardable_space_ids_v2` with the auth-resolved person.
3. Feature flag check: if `service_catalog_read` is `off`, the wrappers delegate to the old inline SQL (kept alongside under a `_legacy` name). If `dualrun` or `v2_only`, they delegate to v2.

**Rollback:** flip flag to `off`; legacy path intact.

### Phase 3 — admin UI
1. New admin pages for service_items, offerings, criteria, form variants, on-behalf rules.
2. Existing Request Types admin stays but gains a "Paired service item" link + warns admins to manage coverage from the new page.
3. `service_catalog_write` flag controls whether editing an RT also edits its paired service_item (`bridged` mode) or is read-only (legacy mode).

**Rollback:** flip write flag; admin editing returns to legacy-only.

### Phase 4 — portal cutover
1. `GET /portal/catalog` + `POST /portal/tickets` honor `service_catalog_read` and `service_catalog_submit` flags independently. Admin flips read first; verify nothing regresses; flip submit.
2. Submit path accepts both `service_item_id` and legacy `request_type_id`; converts internally.
3. Simulator gets the new inputs.

**Rollback:** flip either flag back; portal reverts per-flag.

### Phase 5 — cutover + cleanup
1. Promote `fulfillment_types` from view to real table. Backfill rows from `request_types`. Add hard FK `service_items.fulfillment_type_id → fulfillment_types.id`.
2. Bridge stays in place indefinitely for legacy `request_type_id` resolution.
3. `request_types` gets deprecation comments on `name`, `description`, `form_schema_id`, `catalog_category_id` — but **columns stay populated** by bridged writes. Legacy code paths that read these still work.
4. `portal_visible_request_type_ids` and `portal_availability_trace` stay as the wrapper functions from phase 2 (don't rip them out — legacy API contracts depend on them).

**Rollback:** table→view is the only risky step; can be reversed by dropping the table and recreating the view from a snapshot.

### Optional Phase 6 (future, out of this slice) — legacy sunset
- After 6+ months of bridged operation with no legacy readers detected in logs, drop the deprecated columns on `request_types`. Not in this plan.

---

## 7. Admin UX (phases 3+)

### 7.1 Service Catalog
Lists service items with columns: name, categories, coverage summary (e.g. "3 spaces"), audience criteria count, active. Row → detail tabs:
- **Portal** — name, description, icon, categories (multi-select), search terms, KB, disruption banner, on-behalf policy.
- **Coverage** — offerings table with scope_kind, space/group, inherit toggle, effective dates, active. Reachability linter badge per row.
- **Audience** — criteria bindings by mode. Inline criteria-set preview.
- **Form** — default variant + conditional variants.
- **Fulfillment** — read-only summary of linked fulfillment type's intake requirements.

### 7.2 Criteria Sets
Reusable rule library with a visual composer for the grammar in §3.4a. Matching-persons preview (count + sample).

### 7.3 Fulfillment Types
Renamed from Request Types. Shows internal-operational fields only.

### 7.4 Routing Map (unchanged plan)
Coverage linter surfaces warnings on service-item Coverage tab but doesn't gate.

---

## 8. Employee UX

Portal home + submit flow as shipped, with service_items-shaped data. New: on-behalf control when `on_behalf_policy != 'self_only'`; shows the eligible target pool per policy. Form variants transparent to the user (best-matching picked).

---

## 9. Rollout flags

```sql
-- tenants.feature_flags keys:
-- service_catalog_read   : 'off' | 'dualrun' | 'v2_only'  (catalog GET path)
-- service_catalog_write  : 'legacy' | 'bridged' | 'v2_only'  (admin authoring)
-- service_catalog_submit : 'legacy' | 'v2_only'  (POST /portal/tickets validation)
```

Admin sequencing: `read=dualrun` → observe → `read=v2_only` → `submit=v2_only` → `write=bridged` → `write=v2_only`. Each step independently reversible.

---

## 10. Interaction with the portal-scope slice (shipped)

| Shipped artifact | Change |
|---|---|
| `persons.default_location_id` + `person_location_grants` | Unchanged |
| `portal_authorized_space_ids` | Unchanged; still answers "where can actor submit from" |
| `users.portal_current_location_id` + self-heal | Unchanged |
| `can_self_onboard` + `POST /portal/me/claim-default-location` | Unchanged; onboard list swaps to `portal_onboardable_space_ids_v2` |
| `portal_availability_trace` | Becomes wrapper over `portal_requestable_trace` (same shape, subset of fields) |
| `PortalAvailabilityTrace` frontend type | Kept; extended-fields version also available when calling the new endpoints |
| `PortalSubmitService` | Reads `service_item_id` (or `request_type_id` via bridge); calls portal_requestable_trace |
| `RoutingSimulatorService` | New optional input `service_item_id`; compat surface keeps `portal_availability` field name, v2-native endpoints may expose `portal_requestable` with the superset shape |

---

## 11. Open questions answered (codex round 1)

1. **Grammar depth:** bounded MVP only. ✓
2. **Offering scopes phase 1:** tenant + space + space_group only. ✓
3. **fulfillment_types view or table in phase 1:** view, fully projected, read-only. Phase 5 promotes to table. ✓
4. **Form variant matching:** first-match by (priority desc, created_at asc). ✓
5. **`inherit_to_descendants=true` default:** kept. ✓
6. **Visibility vs requestability split:** kept. ✓
7. **Criteria caching:** explicit per-invocation preload, not Postgres-level. ✓
8. **Deletion semantics:** soft-delete via `active=false`. DELETE tombstones. ✓

---

## 12. Additions from codex round 1

- Requester vs requested-for split (§3.10).
- Effective dating on offerings + criteria bindings (§3.3, §3.5 via implicit per-binding `active`).
- Explicit RT→service-item bridge table (§3.9).
- `fulfillment_types` view projects every internal field including routing v2 policy FKs.
- Back-compat via wrapper functions, not views (§4.3).
- Three feature flags (read / write / submit) — separately reversible.
- Criteria grammar absent-attribute semantics (§3.4a).
- On-behalf actor-vs-target split (§3.7).

---

## 13. Resolved decisions (locked after rounds 2 + 3)

- **Criteria attribute set (phase 1):** `type, department, division, cost_center, manager_person_id`. `is_manager` deferred until manager-chain materialization.
- **Offering-level criteria:** NOT in phase 1. Global `service_item_criteria` is sufficient; narrowing an individual offering would make reachability debugging materially harder.
- **Effective-dating enforcement:** render-time only. No cron. A scheduled job will only be added later if side effects (notifications / reporting) demand it.
- **Bridge ambiguity post-phase-5:** unambiguous. Bridge stays 1:1 on `request_type_id` and unique on `service_item_id`, independent of many-service-items-per-fulfillment.
- **Simulator naming:** `portal_availability` retained on already-shipped compat surfaces; `portal_requestable` reserved for v2-native endpoints/fields.
