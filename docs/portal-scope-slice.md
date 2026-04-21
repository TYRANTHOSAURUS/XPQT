# Portal Scope Slice — Design (LOCKED, codex-approved)

**Status:** **Locked design — codex-approved after 7 review rounds.** Ready for user sign-off → implementation.
**Scope:** Contract 0 for portal submissions. Feeds the **already-shipped** `IntakeContext` (`packages/shared/src/types/routing.ts`) + `IntakeScopingService.normalize()` (Contract 1).
**Source of truth:** the brief, codex's locked v1 decisions, and the existing Contract 1 code.

## Key realization (carried from v4)

Contract 1 **already ships**: `IntakeContext`, `ScopeSource`, `IntakeScopingService.normalize()`, and `pickScopeSource()` live in the repo today. This slice returns the shared `IntakeContext` type at the HTTP boundary — correctly populated for the portal — and lets the existing routing pipeline handle it. Preserving `scope_source='asset_location'` through the pipeline requires downstream changes outside this slice (see §2 and Changelog §1).

## Changelog from v5

v5 was rejected because the `scope_source='asset_location'` preservation claim doesn't hold through today's routing pipeline: `TicketService.runPostCreateAutomation` (lines 562-576) collapses `(location_id, asset_id)` into a single `context.location_id = asset.assigned_space_id` before routing, and `RoutingEvaluatorService` (line 181) builds `IntakeContext.selected_location_id = context.location_id`. So `pickScopeSource` sees `selected_location_id` set and returns `'selected'`, never `'asset_location'`. v6 is honest about this and scopes the fix.

1. **Provenance claim removed from this slice's scope.** Preserving `scope_source='asset_location'` through to routing requires editing `runPostCreateAutomation`'s `evalCtx` construction + `RoutingEvaluatorService`'s `IntakeContext` builder — outside this slice. Today, no shipped policy keys on `scope_source`, so the collapse is not a correctness issue *for routing outcomes*; it's only a diagnostic loss. Noted as a TODO for routing-studio Workstream B/D.
2. **Asset-only validation fix retained** (this was v5's real win, still valid). Portal resolves asset's `assigned_space_id` → `effective_location_id` at the service layer and validates auth/visibility/granularity against it. Validation works regardless of whether downstream preserves provenance.
3. **Tenant-scoped asset lookup in `resolvePortalSubmit`.** The asset read is constrained to the caller's tenant (codex v5 "Remaining gaps").
4. **Server-side `asset_required` and `asset_type_filter` enforcement** added to `PortalSubmitService` (codex v5 "Remaining gaps" — today enforced only client-side).
5. **`RoutingEvaluatorService` claim corrected.** The service IS wired into `TicketService` via `RoutingService.evaluate`. The accurate statement: under `routing_v2_mode='off'`, the evaluator falls through to the legacy resolver and does NOT call `normalize()`; under `dualrun/shadow/v2_only`, `normalize()` runs but receives the already-collapsed `(selected, asset)` context.
6. **`IntakeScopingService.normalize()` scope_source claim corrected.** `normalize()` does not resolve asset location. It materializes `location_id` only for `selected|manual`. For `asset_location` it sets `location_id = null` and leaves downstream resolution to the caller. This slice does not change that.
7. **Carried from v5:** effective/selected parameter separation, tenant filter on `portal_authorized_space_ids`, deterministic self-heal ordering, portal-local `PortalAvailabilityTrace` (not in `@prequest/shared`), depth cap 12, portal stops prefilling `selected_location_id` from asset.
8. **Open TODO for future slice (not this one):** teach `runPostCreateAutomation` and `RoutingEvaluatorService` to carry `(selected_location_id, asset_id)` separately through to `IntakeContext`, so `pickScopeSource` can return `'asset_location'` on asset-only portal submits. This is the correct long-term fix; the honest short-term state is "portal boundary is clean; downstream collapses to `selected`."

## Changelog from v3

1. **Contract-0/Contract-1 now real alignment** — `PortalSubmitService` returns the existing `IntakeContext` shape; drops the parallel `PortalSubmitContext` type and the redundant portal-side `scope_source` computation.
2. **Null-location + no-scope submit bypass closed** — `portal_availability_trace` now also fails when the person has zero active authorized roots, regardless of request-type null-location permissiveness.
3. **Inactive selected space rejected** — `portal_match_authorized_root` checks `spaces.active=true` on the selected space itself, not just closure membership.
4. **Deterministic root precedence** — most-specific matching root wins (shortest walk distance from root to selected); `source='default'` wins tiebreaks.
5. **`enforce_request_type_granularity` rewritten** — hardcoded allowlist mirrored from `00004_spaces.sql`, no brittle `pg_get_constraintdef` parsing. Comment points at the source migration so reviewers catch drift.
6. **`users.portal_current_location_id` tenant trigger added.**
7. **Grant trigger now validates `granted_by_user_id`** belongs to the same tenant when non-null.
8. **`spaces.parent_id` tenant-purity trigger added** (defensive hardening; data-model concern the routing-studio plan calls out).
9. **`current_location` self-healing** on `/portal/me` GET — stale unauthorized value resets to default/first-grant and persists.
10. **Parent-walk cap 12** to match the existing `MAX_SPACE_WALK=12` constant in `intake-scoping.service.ts`.
11. **Trace always returns all fields** — "request type not found" path no longer produces a partial JSONB.

---

## 1. What this slice delivers

A portal where:

- Every person has a **default work location** — `site` or `building` only.
- Every person can request at that default plus **explicit scope-root grants** (descendants included; inactive roots excluded).
- Every request type declares **location granularity** — `NULL` ("any") or a canonical `spaces.type` value, validated on write.
- `POST /portal/tickets` is **auth-bound** — `requester_person_id` always derived from authenticated user.
- The submit path produces an `IntakeContext` exactly as typed in `packages/shared/src/types/routing.ts`. No new Contract 0 type; no parallel normalization.
- The four simulator questions resolve deterministically via an extension to the existing `RoutingSimulatorService`.

Out of scope: role/department/time-window availability modes; full Routing Studio UI; workflow/dispatch reconciliation; promotion of new columns to config-engine policy entities.

---

## 2. The handoff to Contract 1

Today's `IntakeScopingService.normalize()`:

```ts
function pickScopeSource(intake: IntakeContext): ScopeSource {
  if (intake.selected_location_id) return 'selected';
  if (intake.asset_id) return 'asset_location';
  return 'requester_home';
}
```

Portal behavior to keep this correct:

| Portal input | `intake.selected_location_id` | `intake.asset_id` | → `scope_source` |
|---|---|---|---|
| User picked a location | set | optional | `selected` |
| User picked no location; asset present with known location | **null** | set | `asset_location` |
| No location, no asset | null | null | `requester_home` |

**Key rule: the portal must not prefill `selected_location_id` from the asset.** Doing so collapses `asset_location` into `selected` at the HTTP boundary. The portal instead sends `selected_location_id=null` and passes `asset_id` through. Note: `IntakeScopingService.normalize()` does NOT resolve the asset's location — it materializes `location_id` only for `selected|manual` scope sources. Asset-location resolution currently happens downstream in `TicketService.runPostCreateAutomation` (lines 562-576). That downstream path also collapses asset-only into `context.location_id` before routing, which means `pickScopeSource` classifies such submits as `'selected'` rather than `'asset_location'` today. Fixing that collapse is a separate slice (see Changelog §1).

### What `PortalSubmitService` returns

```ts
async resolvePortalSubmit(
  authUid: string,
  dto: PortalSubmitDto,
): Promise<{
  intake: IntakeContext;                     // from @prequest/shared
  portal_trace: PortalAvailabilityTrace;     // portal-local diagnostic type (apps/api/src/modules/ticket/portal-submit.types.ts)
}>
```

- `intake` is consumed by the existing `TicketService` path. That path does its own asset-location fallback for routing (`TicketService` around line 562). `RoutingEvaluatorService` is wired today via `RoutingService.evaluate`, but `routing_v2_mode='off'` skips `normalize()` and falls through to the legacy resolver. Under `dualrun/shadow/v2_only`, `normalize()` runs but receives the already-collapsed `context.location_id` (see Changelog §1). This slice does NOT change the wiring — it guarantees the HTTP-boundary intake is correct so the downstream collapse can be fixed in a future slice (routing-studio Workstream B/D) without portal rework.
- `portal_trace` is portal-local; returned for error UX; **not** stored on the ticket (the routing decision audit is the canonical record).

### Effective location vs selected location (the asset-only fix)

When the portal submits with `asset_id` and no `location_id`:

1. `PortalSubmitService` resolves the asset's `assigned_space_id` (tenant-scoped via `AssetService.getById`) → `effective_location_id`.
2. `portal_availability_trace(person_id, effective_location_id, request_type_id, tenant_id)` validates auth/visibility/granularity against the asset's location.
3. `intake.selected_location_id` **stays null** (user didn't pick one) and `intake.asset_id` is set.

**Downstream caveat (honest):** today `TicketService.runPostCreateAutomation` collapses `(null location_id, asset_id)` into `context.location_id = asset.assigned_space_id` before routing, and `RoutingEvaluatorService` builds `IntakeContext.selected_location_id = context.location_id`. So when `routing_v2_mode != 'off'`, `pickScopeSource` classifies asset-only portal submits as `'selected'`, not `'asset_location'`. This is not a routing correctness issue *today* (no shipped policy keys on `scope_source`), but it is a diagnostic/provenance loss. Fixing the collapse is explicitly out of this slice — tracked as a TODO for the routing-studio plan's Workstream B/D.

What this slice DOES guarantee: (a) the HTTP-boundary intake is correct; (b) asset-only submits are authorized against the right location; (c) ticket persistence preserves the `location_id` backfill that already happens at `runPostCreateAutomation` lines 587-588. If the asset has no location, `effective_location_id=null` and the request type must permit null-location.

### `PortalAvailabilityTrace` (portal-local type — not in `@prequest/shared`)

Lives in `apps/api/src/modules/ticket/portal-submit.types.ts`. Not exported from `@prequest/shared` because it's portal-only UX diagnostic, not part of any Contract.

```ts
interface PortalAvailabilityTrace {
  authorized: boolean;
  has_any_scope: boolean;                   // false when person has zero active roots
  effective_location_id: string | null;      // the location used for validation (asset-resolved or user-picked)
  matched_root_id: string | null;
  matched_root_source: 'default' | 'grant' | null;
  grant_id: string | null;
  visible: boolean;
  location_required: boolean;
  granularity: string | null;
  granularity_ok: boolean;
  overall_valid: boolean;
  failure_reason: string | null;
}
```

All fields always present. See §4.7 for the generating SQL.

---

## 3. Data model

### 3.1 `persons.default_location_id`

```sql
-- 00047_persons_default_location.sql
alter table public.persons
  add column default_location_id uuid references public.spaces(id);

create index idx_persons_default_location on public.persons (default_location_id);

create or replace function public.enforce_person_default_location_type()
returns trigger language plpgsql as $$
declare v_type text; v_tenant uuid;
begin
  if new.default_location_id is null then return new; end if;
  select type, tenant_id into v_type, v_tenant
  from public.spaces where id = new.default_location_id;

  if v_type is null then
    raise exception 'persons.default_location_id % does not exist', new.default_location_id;
  end if;
  if v_type not in ('site','building') then
    raise exception 'persons.default_location_id must be site or building (got %)', v_type;
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'tenant mismatch: persons.tenant=%, space.tenant=%', new.tenant_id, v_tenant;
  end if;
  return new;
end;
$$;

create trigger trg_persons_default_location_type
  before insert or update of default_location_id on public.persons
  for each row execute function public.enforce_person_default_location_type();
```

### 3.2 `person_location_grants`

```sql
-- 00048_person_location_grants.sql
create table public.person_location_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  person_id uuid not null references public.persons(id) on delete cascade,
  space_id uuid not null references public.spaces(id),
  granted_by_user_id uuid references public.users(id),
  granted_at timestamptz not null default now(),
  note text,
  unique (person_id, space_id)
);

alter table public.person_location_grants enable row level security;
create policy "tenant_isolation" on public.person_location_grants
  using (tenant_id = public.current_tenant_id());

create index idx_plg_person on public.person_location_grants (person_id);
create index idx_plg_space  on public.person_location_grants (space_id);
create index idx_plg_tenant on public.person_location_grants (tenant_id);

-- All tenants match, space is site/building, granter (if present) is same tenant.
create or replace function public.enforce_person_location_grant_integrity()
returns trigger language plpgsql as $$
declare v_space_type text; v_space_tenant uuid; v_person_tenant uuid; v_granter_tenant uuid;
begin
  select type, tenant_id into v_space_type, v_space_tenant
  from public.spaces where id = new.space_id;
  if v_space_type is null then
    raise exception 'grant space_id % does not exist', new.space_id;
  end if;
  if v_space_type not in ('site','building') then
    raise exception 'grant target must be site or building (got %)', v_space_type;
  end if;
  if v_space_tenant <> new.tenant_id then
    raise exception 'grant tenant mismatch: space.tenant=%, grant.tenant=%', v_space_tenant, new.tenant_id;
  end if;

  select tenant_id into v_person_tenant from public.persons where id = new.person_id;
  if v_person_tenant is null then
    raise exception 'grant person_id % does not exist', new.person_id;
  end if;
  if v_person_tenant <> new.tenant_id then
    raise exception 'grant tenant mismatch: person.tenant=%, grant.tenant=%', v_person_tenant, new.tenant_id;
  end if;

  if new.granted_by_user_id is not null then
    select tenant_id into v_granter_tenant from public.users where id = new.granted_by_user_id;
    if v_granter_tenant is null then
      raise exception 'grant granted_by_user_id % does not exist', new.granted_by_user_id;
    end if;
    if v_granter_tenant <> new.tenant_id then
      raise exception 'grant tenant mismatch: granter.tenant=%, grant.tenant=%', v_granter_tenant, new.tenant_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_plg_integrity
  before insert or update on public.person_location_grants
  for each row execute function public.enforce_person_location_grant_integrity();
```

### 3.3 Request type intake granularity

```sql
-- 00049_request_type_location_granularity.sql
alter table public.request_types
  add column location_granularity text;

comment on column public.request_types.location_granularity is
  'When non-null, submitted location must have an ancestor (inclusive) with spaces.type = this value. Valid values mirror the spaces.type check constraint in 00004_spaces.sql.';

-- Hardcoded allowlist mirrored from 00004_spaces.sql. If a new space type is added,
-- update this list in the same migration that extends spaces.type. Reviewers catch
-- drift in PR via this explicit reference.
create or replace function public.enforce_request_type_granularity()
returns trigger language plpgsql as $$
declare
  v_allowed constant text[] := array[
    'site','building','floor','room','desk','meeting_room',
    'common_area','storage_room','technical_room','parking_space'
  ];  -- MUST match 00004_spaces.sql spaces.type check constraint.
begin
  if new.location_granularity is null then return new; end if;
  if not (new.location_granularity = any(v_allowed)) then
    raise exception 'location_granularity % is not a valid spaces.type value (allowed: %)',
      new.location_granularity, v_allowed;
  end if;
  return new;
end;
$$;

create trigger trg_request_type_granularity
  before insert or update of location_granularity on public.request_types
  for each row execute function public.enforce_request_type_granularity();
```

### 3.4 `users.portal_current_location_id` with tenant trigger

```sql
-- 00051_users_portal_current_location.sql
alter table public.users
  add column portal_current_location_id uuid references public.spaces(id);

create or replace function public.enforce_user_portal_current_location_tenant()
returns trigger language plpgsql as $$
declare v_tenant uuid; v_active boolean;
begin
  if new.portal_current_location_id is null then return new; end if;
  select tenant_id, active into v_tenant, v_active
  from public.spaces where id = new.portal_current_location_id;
  if v_tenant is null then
    raise exception 'users.portal_current_location_id % does not exist', new.portal_current_location_id;
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'tenant mismatch: users.tenant=%, space.tenant=%', new.tenant_id, v_tenant;
  end if;
  if not v_active then
    raise exception 'users.portal_current_location_id must reference an active space';
  end if;
  return new;
end;
$$;

create trigger trg_users_portal_current_location_tenant
  before insert or update of portal_current_location_id on public.users
  for each row execute function public.enforce_user_portal_current_location_tenant();
```

**Authorization** (the location is in the caller's authorized set) is checked at the service layer in `PATCH /portal/me`. A DB-level check would need to walk the grants/default tree inside a constraint, which is slow to maintain as onboarding evolves.

### 3.5 Spaces tree tenant-purity

Defensive hardening: `spaces.parent_id` currently doesn't enforce same-tenant. Closure expansion trusts the tree.

```sql
-- 00053_spaces_tenant_purity.sql
create or replace function public.enforce_spaces_parent_tenant()
returns trigger language plpgsql as $$
declare v_parent_tenant uuid;
begin
  if new.parent_id is null then return new; end if;
  select tenant_id into v_parent_tenant from public.spaces where id = new.parent_id;
  if v_parent_tenant is null then
    raise exception 'spaces.parent_id % does not exist', new.parent_id;
  end if;
  if v_parent_tenant <> new.tenant_id then
    raise exception 'tenant mismatch: space.tenant=%, parent.tenant=%', new.tenant_id, v_parent_tenant;
  end if;
  return new;
end;
$$;

create trigger trg_spaces_parent_tenant
  before insert or update of parent_id on public.spaces
  for each row execute function public.enforce_spaces_parent_tenant();
```

### 3.6 Deprecation marker

```sql
-- 00050_request_type_deprecation_comments.sql
comment on column public.request_types.default_assignment_policy_id is
  'DEPRECATED — not authoritative at runtime. UI "Linked Routing Rule" and admin list column "routing_rule_id" are aliases. Removed from authored surfaces in portal-scope slice. Column dropped in routing-studio Workstream G.';
```

---

## 4. SQL primitives

Seven functions, all `stable`, tenant-aware, null-safe.

### 4.1 `portal_authorized_root_matches(p_person_id, p_tenant_id)`

```sql
create or replace function public.portal_authorized_root_matches(
  p_person_id uuid,
  p_tenant_id uuid
) returns table (root_id uuid, source text, grant_id uuid) language sql stable as $$
  select p.default_location_id, 'default'::text, null::uuid
  from public.persons p
  join public.spaces s on s.id = p.default_location_id
  where p.id = p_person_id and p.tenant_id = p_tenant_id
    and s.active = true
  union all
  select g.space_id, 'grant'::text, g.id
  from public.person_location_grants g
  join public.spaces s on s.id = g.space_id
  where g.person_id = p_person_id and g.tenant_id = p_tenant_id
    and s.active = true;
$$;
```

### 4.2 `portal_authorized_space_ids(p_person_id, p_tenant_id)`

Explicit tenant filter on the closure join (codex v4 §Remaining cascade risks) — not trusting closure expansion alone.

```sql
create or replace function public.portal_authorized_space_ids(
  p_person_id uuid,
  p_tenant_id uuid
) returns setof uuid language sql stable as $$
  with active_roots as (
    select root_id from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
  ),
  expanded as (
    select * from public.expand_space_closure(array(select root_id from active_roots))
  )
  select e.id
  from expanded e(id)
  join public.spaces s on s.id = e.id
  where s.tenant_id = p_tenant_id
    and s.active = true;
$$;
```

### 4.3 `portal_match_authorized_root(p_person_id, p_effective_space_id, p_tenant_id)`

Deterministic: most-specific root wins (shortest distance from root to selected); `source='default'` wins tiebreaks. Selected space must be active.

```sql
create or replace function public.portal_match_authorized_root(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_tenant_id uuid
) returns table (root_id uuid, source text, grant_id uuid) language plpgsql stable as $$
declare r record; best_root uuid; best_source text; best_grant uuid; best_distance int := null;
        v_selected_active boolean;
begin
  if p_effective_space_id is null then return; end if;

  -- Selected space itself must be active + same tenant.
  select active into v_selected_active
  from public.spaces where id = p_effective_space_id and tenant_id = p_tenant_id;
  if v_selected_active is null or v_selected_active = false then return; end if;

  for r in
    select * from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
  loop
    declare v_distance int;
    begin
      -- Walk from selected up to root, counting steps. Null if not reachable.
      with recursive chain(id, depth) as (
        select p_effective_space_id, 0
        union all
        select s.parent_id, c.depth + 1
        from public.spaces s
        join chain c on s.id = c.id
        where c.depth < 12 and s.parent_id is not null and s.tenant_id = p_tenant_id
      )
      select depth into v_distance from chain where id = r.root_id;

      if v_distance is not null then
        if best_distance is null
           or v_distance < best_distance
           or (v_distance = best_distance and r.source = 'default' and best_source <> 'default') then
          best_root := r.root_id;
          best_source := r.source;
          best_grant := r.grant_id;
          best_distance := v_distance;
        end if;
      end if;
    end;
  end loop;

  if best_root is not null then
    root_id := best_root; source := best_source; grant_id := best_grant;
    return next;
  end if;
end;
$$;
```

### 4.4 `portal_submit_location_valid(p_effective_space_id, p_granularity, p_tenant_id)`

Null-safe. Tenant-scoped. Parent-walk cap = 12 (matches `MAX_SPACE_WALK`).

```sql
create or replace function public.portal_submit_location_valid(
  p_effective_space_id uuid,
  p_granularity text,
  p_tenant_id uuid
) returns boolean language plpgsql stable as $$
declare v_found boolean;
begin
  if p_effective_space_id is null then
    return p_granularity is null;
  end if;

  if not exists (
    select 1 from public.spaces
    where id = p_effective_space_id and tenant_id = p_tenant_id and active = true
  ) then
    return false;
  end if;

  if p_granularity is null then
    return true;
  end if;

  with recursive chain(id, type, depth) as (
    select s.id, s.type, 0
    from public.spaces s
    where s.id = p_effective_space_id and s.tenant_id = p_tenant_id and s.active = true
    union all
    select s.id, s.type, c.depth + 1
    from public.spaces s
    join chain c on s.id = (select parent_id from public.spaces where id = c.id)
    where c.depth < 12 and s.tenant_id = p_tenant_id and s.active = true
  )
  select exists (select 1 from chain where type = p_granularity) into v_found;

  return coalesce(v_found, false);
end;
$$;
```

### 4.5 `portal_request_type_has_eligible_descendant(p_root_id, p_granularity, p_tenant_id)`

```sql
create or replace function public.portal_request_type_has_eligible_descendant(
  p_root_id uuid,
  p_granularity text,
  p_tenant_id uuid
) returns boolean language sql stable as $$
  select case
    when p_granularity is null then true
    when p_root_id is null then false
    else exists (
      select 1
      from public.expand_space_closure(array[p_root_id]) x(id)
      join public.spaces s on s.id = x.id
      where s.tenant_id = p_tenant_id
        and s.active = true
        and s.type = p_granularity
    )
  end;
$$;
```

### 4.6 `portal_visible_request_type_ids(p_person_id, p_effective_space_id, p_tenant_id)`

```sql
create or replace function public.portal_visible_request_type_ids(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_tenant_id uuid
) returns setof uuid language plpgsql stable as $$
declare v_root_id uuid; v_has_scope boolean;
begin
  -- Has any active authorized root?
  v_has_scope := exists (
    select 1 from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
  );

  if not v_has_scope then
    -- No scope at all → no visible request types, even null-location ones.
    return;
  end if;

  if p_effective_space_id is null then
    -- Null location path: only request types that allow null location.
    return query
      select rt.id
      from public.request_types rt
      where rt.tenant_id = p_tenant_id
        and rt.active = true
        and coalesce(rt.location_required, false) = false
        and rt.location_granularity is null;
    return;
  end if;

  -- Location picked: must resolve to an authorized root.
  select root_id into v_root_id
  from public.portal_match_authorized_root(p_person_id, p_effective_space_id, p_tenant_id);

  if v_root_id is null then return; end if;

  return query
    select rt.id
    from public.request_types rt
    where rt.tenant_id = p_tenant_id
      and rt.active = true
      and public.portal_request_type_has_eligible_descendant(v_root_id, rt.location_granularity, p_tenant_id);
end;
$$;
```

### 4.7 `portal_availability_trace(p_person_id, p_effective_space_id, p_request_type_id, p_tenant_id)`

**Parameter note:** `p_effective_space_id` is the location used for validation — either user-picked (when `selected_location_id` is set in the DTO) or asset-resolved (when `asset_id` is provided without `selected_location_id`). The intake's `selected_location_id` is a separate concern, populated only from user-picked values to preserve `scope_source` provenance.

All-fields-always, even for "not found" and "no scope." Single source of truth for submit + simulator.

```sql
create or replace function public.portal_availability_trace(
  p_person_id uuid,
  p_effective_space_id uuid,
  p_request_type_id uuid,
  p_tenant_id uuid
) returns jsonb language plpgsql stable as $$
declare
  v_root_id uuid; v_root_source text; v_grant_id uuid;
  v_location_required boolean; v_granularity text;
  v_authorized boolean; v_visible boolean; v_granularity_ok boolean;
  v_has_scope boolean; v_failure text; v_overall boolean;
  v_rt_exists boolean;
begin
  v_has_scope := exists (
    select 1 from public.portal_authorized_root_matches(p_person_id, p_tenant_id)
  );

  select location_required, location_granularity, true
    into v_location_required, v_granularity, v_rt_exists
  from public.request_types
  where id = p_request_type_id and tenant_id = p_tenant_id;
  v_rt_exists := coalesce(v_rt_exists, false);

  if not v_rt_exists then
    return jsonb_build_object(
      'authorized', false, 'has_any_scope', v_has_scope,
      'effective_location_id', p_effective_space_id,
      'matched_root_id', null, 'matched_root_source', null, 'grant_id', null,
      'visible', false,
      'location_required', false, 'granularity', null, 'granularity_ok', false,
      'overall_valid', false,
      'failure_reason', 'request type not found'
    );
  end if;

  -- Auth step.
  if not v_has_scope then
    v_authorized := false;
    v_root_id := null; v_root_source := null; v_grant_id := null;
  elsif p_effective_space_id is null then
    v_authorized := true;  -- null location is allowed; further checks gate the submit
    v_root_id := null; v_root_source := null; v_grant_id := null;
  else
    select root_id, source, grant_id into v_root_id, v_root_source, v_grant_id
    from public.portal_match_authorized_root(p_person_id, p_effective_space_id, p_tenant_id);
    v_authorized := v_root_id is not null;
  end if;

  -- Visibility step.
  v_visible := exists (
    select 1 from public.portal_visible_request_type_ids(p_person_id, p_effective_space_id, p_tenant_id) x(id)
    where x.id = p_request_type_id
  );

  -- Granularity + location_required step.
  if coalesce(v_location_required, false) and p_effective_space_id is null then
    v_granularity_ok := false;
  else
    v_granularity_ok := public.portal_submit_location_valid(p_effective_space_id, v_granularity, p_tenant_id);
  end if;

  v_overall := v_has_scope and v_authorized and v_visible and v_granularity_ok;

  v_failure := case
    when not v_has_scope                                        then 'no authorized scope — contact your admin to set your work location'
    when not v_authorized                                       then 'selected location is not in the requester''s authorized scope'
    when not v_visible and p_effective_space_id is null          then 'this request type requires a location'
    when not v_visible                                          then 'request type is not available at the selected location'
    when not v_granularity_ok and p_effective_space_id is null   then 'this request type requires a location'
    when not v_granularity_ok                                   then format('selected location does not satisfy required depth (%s)', v_granularity)
    else null
  end;

  return jsonb_build_object(
    'authorized', v_authorized,
    'has_any_scope', v_has_scope,
    'effective_location_id', p_effective_space_id,
    'matched_root_id', v_root_id,
    'matched_root_source', v_root_source,
    'grant_id', v_grant_id,
    'visible', v_visible,
    'location_required', coalesce(v_location_required, false),
    'granularity', v_granularity,
    'granularity_ok', v_granularity_ok,
    'overall_valid', v_overall,
    'failure_reason', v_failure
  );
end;
$$;
```

---

## 5. API surface

### 5.1 `GET /portal/me` — self-healing current_location

```jsonc
{
  "person": { "id": "…", "first_name": "Ali", "last_name": "…", "email": "…" },
  "user":   { "id": "…", "email": "…" },
  "default_location": { "id": "…", "name": "Amsterdam HQ", "type": "building" } | null,
  "authorized_locations": [
    { "id": "…", "name": "Amsterdam HQ", "type": "building", "source": "default" },
    { "id": "…", "name": "Dubai Campus", "type": "site",     "source": "grant",
      "grant_id": "…", "granted_at": "…", "note": "…" }
  ],
  "current_location": { "id": "…", "name": "…", "type": "…" } | null,
  "role_scopes": [ { "role_name": "Employee", "domain_scope": null, "location_scope": [] } ],
  "can_submit": true
}
```

**Self-healing:** before responding, the handler checks if `users.portal_current_location_id` is still in the caller's authorized set. If not (grants were revoked, default changed, space went inactive):
1. Reset `current_location_id` deterministically:
   - If `default_location_id` is set and active → use it.
   - Else the grant with the smallest `granted_at` whose space is active (oldest grant = most stable).
   - Else `null`.
2. Persist the reset in the same transaction.
3. Return the updated payload.

`can_submit = (default_location or any grant is active)` = `portal_authorized_root_matches` returns ≥1 row.

### 5.2 `PATCH /portal/me { current_location_id }`

Validates `current_location_id` against `portal_authorized_space_ids(person, tenant)`. 403 `location_not_authorized` otherwise.

### 5.3 `GET /portal/catalog?location_id=<space_id>`

Full payload (every field the submit form consumes). Dead-end request types filtered.

```jsonc
{
  "selected_location": { "id": "…", "name": "…", "type": "building" },
  "categories": [
    { "id": "…", "name": "Facilities", "icon": "…",
      "request_types": [
        {
          "id": "…", "name": "Fix broken toilet", "description": "…",
          "domain": "fm",
          "form_schema_id": "…",
          "requires_location": true,
          "location_required": true,
          "location_granularity": "room",
          "requires_asset": false,
          "asset_required": false,
          "asset_type_filter": []
        }
      ]
    }
  ]
}
```

Rejects with 403 if `location_id` is not in authorized set.

### 5.4 `GET /portal/spaces?under=<space_id>`

One-level lazy child list. Parent must be authorized.

```jsonc
{
  "parent":   { "id": "…", "name": "…", "type": "building" },
  "children": [
    { "id": "…", "name": "Floor 2", "type": "floor",  "has_children": true,  "active": true },
    { "id": "…", "name": "Server Room", "type": "technical_room", "has_children": false, "active": true }
  ]
}
```

### 5.5 `POST /portal/tickets` — frozen portal submit endpoint

```ts
// apps/api/src/modules/ticket/portal-submit.service.ts (new)
async resolvePortalSubmit(
  authUid: string,
  dto: PortalSubmitDto,
): Promise<{ intake: IntakeContext; portal_trace: PortalAvailabilityTrace }>
```

```ts
interface PortalSubmitDto {
  request_type_id: string;
  location_id?: string | null;   // user-picked; not prefilled from asset
  asset_id?: string | null;
  priority?: 'low'|'normal'|'high'|'urgent';
}
```

Method body:

1. Resolve `person_id` from `users.person_id` via `auth_uid`. 401 if no linked person.
2. **Enforce request-type intake constraints server-side** (today enforced only client-side):
   - Load `request_types { active, requires_asset, asset_required, asset_type_filter, requires_location, location_required, location_granularity }` for `dto.request_type_id`. Tenant-scoped. 404 if not found.
   - If `asset_required=true` and `dto.asset_id` is missing → reject with `asset_required`.
   - If `dto.asset_id` is set → load the asset via `AssetService.getById(dto.asset_id)` (tenant-scoped; throws if cross-tenant). If `asset_type_filter` is non-empty, reject when asset's type is not in the filter.
3. **Determine `effective_location_id`:**
   - If `dto.location_id` is set → `effective_location_id = dto.location_id`.
   - Else if `dto.asset_id` is set and asset has `assigned_space_id` → use that.
   - Else → `effective_location_id = null`.
4. Call `portal_availability_trace(person_id, effective_location_id, dto.request_type_id, tenant_id)`. On `overall_valid=false`, throw with the trace attached (HTTP 400, body includes the trace).
5. Build `IntakeContext`:
   ```ts
   {
     tenant_id,
     request_type_id: dto.request_type_id,
     requester_person_id: person_id,
     selected_location_id: dto.location_id ?? null,    // user-picked only; never asset-resolved
     asset_id: dto.asset_id ?? null,
     priority: dto.priority ?? 'normal',
     evaluated_at: new Date().toISOString(),
   }
   ```
6. Return `{ intake, portal_trace }` where `portal_trace.effective_location_id` echoes step 3.

`TicketService` inserts the ticket using `intake` as source of truth for `requester_person_id`, `selected_location_id` (stored as `tickets.location_id`), `asset_id`, etc. Downstream, `runPostCreateAutomation` handles asset-only tickets via its existing `assigned_space_id` fallback and patches `tickets.location_id` after routing (lines 587-588). This slice does not change that behavior.

`RoutingEvaluatorService` (wired today via `RoutingService.evaluate`) behavior by mode:
- `routing_v2_mode='off'` → legacy resolver runs; `normalize()` is not called; `scope_source` is not computed.
- `dualrun/shadow/v2_only` → `normalize()` runs but receives `context.location_id` already set to the effective (possibly asset-resolved) location, so `pickScopeSource` returns `'selected'`, not `'asset_location'`. Fixing this requires changing how `runPostCreateAutomation` builds `evalCtx` and how the evaluator builds `IntakeContext` — explicitly a future slice.

`POST /tickets` remains the admin/desk create-on-behalf-of path, unchanged.

### 5.6 Simulator — extend `RoutingSimulatorService`

```ts
export interface SimulatorInput {
  request_type_id: string;
  location_id?: string | null;             // LEGACY: pre-portal. Maps to acting_for_location_id.
  asset_id?: string | null;
  priority?: string | null;
  disabled_rule_ids?: string[];
  include_v2?: boolean;

  // NEW
  simulate_as_person_id?: string | null;
  current_location_id?: string | null;     // where the requester is
  acting_for_location_id?: string | null;  // where the request is for (routing)
}
```

Resolution:
- Legacy-only (`location_id` set, others null) → acting_for = location_id.
- `current_location_id` alone → acting_for = current.
- Both → acting_for drives routing; current echoed in trace.

`SimulatorResult.portal_availability`:

```ts
portal_availability?: {
  person_id: string;
  current_location_id: string | null;
  acting_for_location_id: string | null;
  trace: PortalAvailabilityTrace;
  authorized_locations_summary: Array<{
    id: string; name: string; type: string;
    source: 'default' | 'grant'; grant_id: string | null;
  }>;
}
```

One call path — `evaluatePortalAvailability()` — shared by `PortalSubmitService` and the simulator.

### 5.7 Admin write endpoints

- `PATCH /persons/:id { default_location_id }`.
- `POST /persons/:id/location-grants { space_id, note? }`.
- `DELETE /persons/:id/location-grants/:grant_id`.
- `PATCH /request-types/:id { location_granularity }`.

---

## 6. Frontend

### 6.1 Portal context provider

Extends `apps/web/src/providers/auth-provider.tsx`. Loads `/portal/me`. Current location is server-canonical; `localStorage` is not used (self-healing on server is enough).

### 6.2 Portal shell — location picker

Persistent header control. Lists `authorized_locations` scope roots. Switch → `PATCH /portal/me` → invalidate `/portal/catalog`.

`can_submit=false` renders a blocker card with a contact-admin message and the list of current grants (often empty).

### 6.3 Submit flow

`submit-request.tsx`:

- Replace tenant-global request-type fetch with `/portal/catalog?location_id=<current>`.
- On RT selection:
  - `location_granularity=null` → no drill-down.
  - `current.type === granularity` → no drill-down.
  - Else → drill-down via `/portal/spaces?under=<current>` (lazy one level at a time) until a space with `type = granularity` is picked.
  - Asset-prefill UX: when `asset_id` is set and asset has a known location, show "From asset: [location]" badge — **but do not substitute** `selected_location_id`. The backend leaves `selected_location_id` null so the HTTP-boundary intake preserves the asset-only distinction. Downstream routing (today) collapses asset-only into the asset's location before the resolver runs — see §2 caveat. Fixing that collapse is a future slice.
- Submit → `POST /portal/tickets`. On 400, render `portal_trace.failure_reason` in the error bar.

### 6.4 Category pages

`catalog-category.tsx`: stop passing `?domain=<categoryId>`. Categories are a client-side filter over `/portal/catalog`.

### 6.5 Admin UX for this slice (minimal)

- **Person detail admin:** default_location selector (site/building, active), grants table (add/remove).
- **Request type dialog (`request-type-dialog.tsx`):**
  - Add `Location granularity` Select (options: `(any)` + the 10 `spaces.type` values).
  - **Remove** the "Linked Routing Rule (override)" field.
- **Request type list (`admin/request-types.tsx`):**
  - **Remove** the `routing_rule_id` column header.
- **Admin simulator UI:** extend existing routing simulator with the new input fields; no new page.

All forms use shadcn `Field` per `CLAUDE.md`.

---

## 7. Operator vs portal scope — the firewall

Unchanged. `user_role_assignments.location_scope` governs operator visibility and routing. Portal uses **only** `persons.default_location_id + person_location_grants`. Dual-access operators configure both.

---

## 8. Migrations

1. `00047_persons_default_location.sql`
2. `00048_person_location_grants.sql`
3. `00049_request_type_location_granularity.sql`
4. `00050_request_type_deprecation_comments.sql`
5. `00051_users_portal_current_location.sql`
6. `00052_portal_functions.sql` — all seven functions (interdependent; one file).
7. `00053_spaces_tenant_purity.sql`

Remote push waits for user approval. No backfill; no new restriction tables.

---

## 9. Edge cases

| Case | Behavior |
|---|---|
| `default=null` and no grants | `can_submit=false`. `portal_availability_trace.has_any_scope=false`. Submit blocked for every request type. |
| `default=null`, has active grants | `can_submit=true`. `current_location` self-heals to first active grant. |
| Grant on inactive space | Excluded from `portal_authorized_root_matches`. Descendants not authorized. |
| Default is inactive | Same — excluded. |
| Selected space is inactive | `portal_match_authorized_root` returns zero rows; auth check fails. |
| Overlapping authorized roots (default inside a grant subtree) | Most-specific root wins (shortest walk distance); default wins ties. |
| `location_required=false`, `granularity=null` | Null location accepted. |
| `location_required=false`, `granularity='room'` | Null location rejected (granularity implies a location). |
| `location_required=true`, null submitted | Rejected with `failure_reason="this request type requires a location"`. |
| Deeper than granularity | Accepted. |
| Shallower than granularity | Drill-down forced; backend rejects otherwise. |
| Dead-end RT under scope root | Hidden from `/portal/catalog`. |
| Admin sets `location_granularity='elevator'` | Trigger rejects. |
| Asset location satisfies granularity, user picked a different location | User choice wins (`selected_location_id` set) → scope_source='selected'. |
| Asset location only (user picked nothing) | HTTP intake: `selected_location_id=null`, `asset_id` set. Validation runs against asset's location. Downstream routing today collapses into the asset's location and produces `scope_source='selected'` — future slice will preserve `'asset_location'`. |
| `users.portal_current_location_id` points at revoked grant | `/portal/me` self-heals to default or first grant. |
| `PATCH /portal/me` with unauthorized `current_location_id` | 403. |
| Someone tries to update `persons.default_location_id` to a space of another tenant | Trigger rejects. |
| Someone tries to point `spaces.parent_id` across tenants | Trigger rejects. |

---

## 10. Codex decisions (locked)

- Q1: keep `expand_space_closure`. ✓
- Q2: no `request_type_location_restrictions`. ✓
- Q3: no `default_location_only` mode. ✓
- Q4: block when no default/no grants; no `everyone` escape. ✓
- Q5: scope roots in API, expansion server-side. ✓
- Q6: no `explicit_locations` as exclusive; future restrictions AND with authorized. ✓

---

## 11. Proving the four simulator questions

1. **"Why can Ali request for Dubai?"** → `/portal/me.authorized_locations[i].source="grant"` or simulator `portal_availability.trace.matched_root_source="grant"` + `grant_id`.
2. **"Why can't Ali request for Berlin?"** → simulator `authorized=false`, `failure_reason="selected location is not in the requester's authorized scope"` + `authorized_locations_summary` for context.
3. **"Which request types are visible at X?"** → `/portal/catalog?location_id=X` authoritative. Admin simulator iterates per-type.
4. **"Valid for submit at this location?"** → `portal_availability_trace(person, space, rt, tenant)` — all fields always. Same code path as submit validation.

---

## 12. Implementation sequencing

1. Migrations 00047–00053 (local first; remote push awaits user).
2. `PortalSubmitService.resolvePortalSubmit` + `POST /portal/tickets`.
3. `RoutingSimulatorService` extension (new inputs + `portal_availability` result).
4. `/portal/me`, `PATCH /portal/me`, `/portal/catalog`, `/portal/spaces`.
5. Person admin page; request type dialog + list cleanup.
6. Portal frontend: context provider, location picker, submit flow drill-down, blocker state, asset-prefill badge.
7. Category page fix.
8. E2E smoke: portal submit edge cases, simulator four-questions, self-healing `/portal/me`, overlapping-root precedence.
