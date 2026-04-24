# Locations & Spaces UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `/admin/locations` as a two-pane explorer (tree + detail) so admins can see, navigate, and bulk-edit hierarchical space graphs at real-world scale (1–100 buildings, thousands of nodes).

**Architecture:** Persistent virtualised tree in a resizable left pane, URL-synced detail pane on the right. Adds a `wing` space type and a DB-enforced parent→child taxonomy. Frontend migrates off the legacy `useApi` hook to React Query. Backend adds `move` + `bulk` endpoints and enriches `/spaces/hierarchy` with child counts.

**Tech Stack:** NestJS + Supabase (Postgres) on the API. React 19 + TanStack Query v5 + `@tanstack/react-virtual` + shadcn/ui + `react-resizable-panels` + `react-router-dom` v7 on the web.

**Source spec:** `docs/superpowers/specs/2026-04-24-locations-spaces-ux-design.md`. Read it before starting — this plan is the mechanical execution of that design.

**Testing posture:**
- API: Jest unit tests for the parent-validation helper and any new service method that has non-trivial branching. Existing module has no tests — don't backfill unrelated ones.
- Web: no test runner is configured. Verify every UI task by running `pnpm dev:web` and exercising the feature in a browser per CLAUDE.md. Type-check with `pnpm --filter web tsc --noEmit` before committing.
- DB: `pnpm db:reset` applies migrations locally; a psql smoke query validates the new trigger rejects invalid parent/child pairs.

---

## File Map

**Create (backend):**
- `supabase/migrations/00107_space_wing_and_parent_rule.sql`
- `apps/api/src/modules/space/space.parent-rules.ts` — the canonical `(parent_type, child_type) -> boolean` table, shared with the frontend via `packages/shared`.
- `apps/api/src/modules/space/space.parent-rules.spec.ts` — Jest unit tests.

**Modify (backend):**
- `apps/api/src/modules/space/space.service.ts` — parent-rule validation on create/update/move, enrich `getHierarchy` with `child_count`, add `move`, add `bulkUpdate`.
- `apps/api/src/modules/space/space.controller.ts` — `POST /spaces/:id/move`, `PATCH /spaces/bulk`.

**Create (shared):**
- `packages/shared/src/space-types.ts` — `SPACE_TYPES`, `SPACE_PARENT_RULES`, `SpaceType`, `isValidSpaceParent`. Re-exported from both API and web.

**Create (web — data layer):**
- `apps/web/src/api/spaces/types.ts`
- `apps/web/src/api/spaces/keys.ts`
- `apps/web/src/api/spaces/queries.ts`
- `apps/web/src/api/spaces/mutations.ts`
- `apps/web/src/api/spaces/index.ts`

**Create (web — shared components):**
- `apps/web/src/components/admin/space-type-icon.tsx`
- `apps/web/src/components/admin/space-type-picker.tsx`
- `apps/web/src/components/admin/space-parent-picker.tsx`
- `apps/web/src/components/admin/space-form.tsx`

**Create (web — tree rail):**
- `apps/web/src/components/admin/space-tree/use-space-tree-state.ts`
- `apps/web/src/components/admin/space-tree/space-tree-row.tsx`
- `apps/web/src/components/admin/space-tree/space-tree.tsx`
- `apps/web/src/components/admin/space-tree/space-tree-search.tsx`
- `apps/web/src/components/admin/space-tree/space-tree-flat-list.tsx`
- `apps/web/src/components/admin/space-tree/build-tree.ts`

**Create (web — detail pane):**
- `apps/web/src/components/admin/space-detail/space-detail.tsx`
- `apps/web/src/components/admin/space-detail/space-detail-header.tsx`
- `apps/web/src/components/admin/space-detail/space-metadata-strip.tsx`
- `apps/web/src/components/admin/space-detail/space-children-table.tsx`
- `apps/web/src/components/admin/space-detail/space-children-bulk-bar.tsx`
- `apps/web/src/components/admin/space-detail/space-detail-root-summary.tsx`

**Modify (web — page & routing):**
- `apps/web/src/pages/admin/locations.tsx` — full rewrite; drops the old dialog and flat table.
- `apps/web/src/App.tsx` — route becomes `/admin/locations/:spaceId?`.

**Boundary note:** the tree rail never imports from detail and vice versa; they coordinate only via URL params and React Query cache. `space-form` is the single source of truth for the create/edit dialog and is reused by bulk-edit.

---

## Task 1 — DB migration: add `wing` type and parent-rule trigger

**Files:**
- Create: `supabase/migrations/00107_space_wing_and_parent_rule.sql`
- Modify: `supabase/migrations/00049_request_type_location_granularity.sql` — **read only**; no edit, but note the comment there ("update this list in the same migration that extends spaces.type") drives step 3 below.

- [ ] **Step 1: Write the migration**

`supabase/migrations/00107_space_wing_and_parent_rule.sql`:

```sql
-- 00107_space_wing_and_parent_rule.sql
-- Adds `wing` as a valid space type (between building and floor) and enforces
-- the parent→child taxonomy at the DB. Mirrors the client-side constraint in
-- packages/shared/src/space-types.ts. If you change one, change the other.

-- 1. Extend the type check constraint.
alter table public.spaces
  drop constraint spaces_type_check;

alter table public.spaces
  add constraint spaces_type_check check (type in (
    'site', 'building', 'wing', 'floor',
    'room', 'desk', 'meeting_room',
    'common_area', 'storage_room', 'technical_room', 'parking_space'
  ));

-- 2. Extend the location_granularity allowlist in request_types. This function
-- is defined in 00049_request_type_location_granularity.sql; its body
-- hardcodes the valid space types. We recreate it with `wing` added.
create or replace function public.validate_request_type_location_granularity()
returns trigger
language plpgsql
as $$
declare
  valid_types text[] := array[
    'site', 'building', 'wing', 'floor',
    'room', 'desk', 'meeting_room',
    'common_area', 'storage_room', 'technical_room', 'parking_space'
  ];
begin
  if new.location_granularity is not null
     and not (new.location_granularity = any (valid_types)) then
    raise exception 'location_granularity % is not a valid spaces.type value (allowed: %)',
      new.location_granularity, valid_types;
  end if;
  return new;
end;
$$;

-- 3. Parent→child taxonomy. Returns true if `child_type` may be a child of
-- `parent_type` (or of null, meaning root).
create or replace function public.is_valid_space_parent(
  parent_type text,
  child_type text
) returns boolean
language sql
immutable
as $$
  select case
    when parent_type is null then child_type = 'site'
    when parent_type = 'site' then child_type in ('building', 'common_area', 'parking_space')
    when parent_type = 'building' then child_type in ('wing', 'floor', 'common_area')
    when parent_type = 'wing' then child_type in ('floor')
    when parent_type = 'floor' then child_type in (
      'room', 'meeting_room', 'common_area', 'storage_room', 'technical_room'
    )
    when parent_type = 'room' then child_type = 'desk'
    else false
  end;
$$;

-- 4. Trigger: enforce the rule on insert/update, and prevent cycles on update.
create or replace function public.enforce_space_parent_rule()
returns trigger
language plpgsql
as $$
declare
  parent_type text;
  cursor_id uuid;
begin
  if new.parent_id is null then
    parent_type := null;
  else
    select type into parent_type
    from public.spaces
    where id = new.parent_id and tenant_id = new.tenant_id;

    if parent_type is null then
      raise exception 'parent_id % not found in tenant', new.parent_id;
    end if;
  end if;

  if not public.is_valid_space_parent(parent_type, new.type) then
    raise exception 'space type % cannot be a child of %',
      new.type, coalesce(parent_type, '(root)');
  end if;

  -- Cycle check: walk up from new.parent_id; fail if we encounter new.id.
  if tg_op = 'UPDATE' and new.parent_id is not null then
    cursor_id := new.parent_id;
    while cursor_id is not null loop
      if cursor_id = new.id then
        raise exception 'moving space % under % would create a cycle', new.id, new.parent_id;
      end if;
      select parent_id into cursor_id from public.spaces where id = cursor_id;
    end loop;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_space_parent_rule on public.spaces;
create trigger enforce_space_parent_rule
  before insert or update of parent_id, type on public.spaces
  for each row execute function public.enforce_space_parent_rule();

-- 5. Notify PostgREST so schema cache reloads.
notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally and confirm it runs clean**

```bash
cd /Users/x/Desktop/XPQT
pnpm db:reset
```

Expected: all migrations apply with no errors, ending in "Finished supabase db reset".

- [ ] **Step 3: Smoke-test the trigger with psql**

```bash
PGPASSWORD=postgres psql "postgresql://postgres@127.0.0.1:54322/postgres" <<'SQL'
-- A: inserting a site with no parent must succeed.
insert into public.spaces (tenant_id, type, name)
  select id, 'site', 'Plan test site' from public.tenants limit 1
  returning id;

-- B: inserting a desk directly under a site must fail.
insert into public.spaces (tenant_id, type, name, parent_id)
  select t.id, 'desk', 'Plan test illegal desk', s.id
  from public.tenants t, public.spaces s
  where s.name = 'Plan test site'
  limit 1;
SQL
```

Expected: A returns a UUID. B raises `space type desk cannot be a child of site`.

Clean up:
```bash
PGPASSWORD=postgres psql "postgresql://postgres@127.0.0.1:54322/postgres" \
  -c "delete from public.spaces where name = 'Plan test site';"
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00107_space_wing_and_parent_rule.sql
git commit -m "feat(spaces): add wing type and DB-enforced parent→child rule"
```

---

## Task 2 — Shared taxonomy module

**Files:**
- Create: `packages/shared/src/space-types.ts`
- Modify: `packages/shared/src/index.ts` — re-export.

- [ ] **Step 1: Create the shared module**

`packages/shared/src/space-types.ts`:

```ts
/**
 * Canonical space-type taxonomy. Mirrors the DB check constraint in
 * supabase/migrations/00107_space_wing_and_parent_rule.sql. If you change
 * either, change both.
 */
export const SPACE_TYPES = [
  'site',
  'building',
  'wing',
  'floor',
  'room',
  'desk',
  'meeting_room',
  'common_area',
  'storage_room',
  'technical_room',
  'parking_space',
] as const;

export type SpaceType = (typeof SPACE_TYPES)[number];

/**
 * Parent → allowed children. `null` parent means the tenant root.
 * Mirrors `public.is_valid_space_parent` in the DB.
 */
export const SPACE_PARENT_RULES: Record<SpaceType | 'root', readonly SpaceType[]> = {
  root: ['site'],
  site: ['building', 'common_area', 'parking_space'],
  building: ['wing', 'floor', 'common_area'],
  wing: ['floor'],
  floor: ['room', 'meeting_room', 'common_area', 'storage_room', 'technical_room'],
  room: ['desk'],
  desk: [],
  meeting_room: [],
  common_area: [],
  storage_room: [],
  technical_room: [],
  parking_space: [],
};

export function isValidSpaceParent(
  parentType: SpaceType | null,
  childType: SpaceType,
): boolean {
  const key = parentType ?? 'root';
  return SPACE_PARENT_RULES[key].includes(childType);
}

export function allowedChildTypes(parentType: SpaceType | null): readonly SpaceType[] {
  return SPACE_PARENT_RULES[parentType ?? 'root'];
}
```

- [ ] **Step 2: Add the export**

Modify `packages/shared/src/index.ts` — add the line:

```ts
export * from './space-types';
```

- [ ] **Step 3: Type-check both apps**

```bash
pnpm --filter @prequest/shared build 2>/dev/null || true
pnpm --filter api tsc --noEmit
pnpm --filter web tsc --noEmit
```

Expected: no errors. (If the shared package uses a different build command, follow `packages/shared/package.json`.)

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/space-types.ts packages/shared/src/index.ts
git commit -m "feat(shared): space type taxonomy and parent rules"
```

---

## Task 3 — Backend: parent-rule validation + hierarchy enrichment + move + bulk

**Files:**
- Modify: `apps/api/src/modules/space/space.service.ts`
- Modify: `apps/api/src/modules/space/space.controller.ts`
- Create: `apps/api/src/modules/space/space.service.spec.ts` (or append to existing if present)

- [ ] **Step 1: Write the failing test for the service**

`apps/api/src/modules/space/space.service.spec.ts`:

```ts
import { isValidSpaceParent } from '@prequest/shared';

describe('isValidSpaceParent (shared taxonomy)', () => {
  it('allows site at the root', () => {
    expect(isValidSpaceParent(null, 'site')).toBe(true);
  });

  it('rejects site under any parent', () => {
    expect(isValidSpaceParent('building', 'site')).toBe(false);
  });

  it('allows wing under building', () => {
    expect(isValidSpaceParent('building', 'wing')).toBe(true);
  });

  it('rejects wing under site (wings live inside buildings)', () => {
    expect(isValidSpaceParent('site', 'wing')).toBe(false);
  });

  it('allows desk under room only', () => {
    expect(isValidSpaceParent('room', 'desk')).toBe(true);
    expect(isValidSpaceParent('floor', 'desk')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (taxonomy was implemented in Task 2)

```bash
pnpm --filter api test -- space.service.spec
```

Expected: 5 passing.

- [ ] **Step 3: Extend `SpaceService` — validate parent, enrich hierarchy, add move + bulk**

Modify `apps/api/src/modules/space/space.service.ts`. Full new file:

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { isValidSpaceParent, SpaceType } from '@prequest/shared';

export interface CreateSpaceDto {
  parent_id?: string | null;
  type: SpaceType;
  code?: string;
  name: string;
  capacity?: number;
  amenities?: string[];
  attributes?: Record<string, unknown>;
  reservable?: boolean;
}

export interface UpdateSpaceDto {
  name?: string;
  code?: string;
  capacity?: number;
  amenities?: string[];
  attributes?: Record<string, unknown>;
  reservable?: boolean;
  active?: boolean;
}

export interface MoveSpaceDto {
  parent_id: string | null;
}

export interface BulkUpdateDto {
  ids: string[];
  patch: UpdateSpaceDto;
}

@Injectable()
export class SpaceService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters?: {
    type?: string;
    types?: string[];
    parent_id?: string;
    reservable?: boolean;
    search?: string;
    active_only?: boolean;
  }) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('spaces')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');

    if (filters?.active_only) query = query.eq('active', true);
    if (filters?.type) query = query.eq('type', filters.type);
    if (filters?.types?.length) query = query.in('type', filters.types);
    if (filters?.parent_id) query = query.eq('parent_id', filters.parent_id);
    if (filters?.reservable !== undefined) query = query.eq('reservable', filters.reservable);
    if (filters?.search) query = query.ilike('name', `%${filters.search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error || !data) throw new NotFoundException('Space not found');
    return data;
  }

  /**
   * Returns the full active tree for this tenant, each node enriched with
   * `child_count` (direct children only). Used by the admin explorer.
   */
  async getHierarchy(rootId?: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('type')
      .order('name');

    if (error) throw error;

    const childCounts = new Map<string | null, number>();
    for (const s of data ?? []) {
      const key = (s.parent_id as string | null) ?? null;
      childCounts.set(key, (childCounts.get(key) ?? 0) + 1);
    }

    return this.buildTree(data ?? [], childCounts, rootId ?? null);
  }

  async create(dto: CreateSpaceDto) {
    const tenant = TenantContext.current();
    await this.assertValidParent(dto.parent_id ?? null, dto.type);

    const { data, error } = await this.supabase.admin
      .from('spaces')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateSpaceDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async move(id: string, dto: MoveSpaceDto) {
    const tenant = TenantContext.current();
    const current = await this.getById(id);
    await this.assertValidParent(dto.parent_id, current.type as SpaceType);

    const { data, error } = await this.supabase.admin
      .from('spaces')
      .update({ parent_id: dto.parent_id })
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Applies the same patch to every id. Returns per-id results. Tenant
   * isolation is enforced per-row (the eq('tenant_id', …) filter in update()).
   */
  async bulkUpdate(dto: BulkUpdateDto) {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of dto.ids) {
      try {
        await this.update(id, dto.patch);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    return { results };
  }

  private async assertValidParent(parentId: string | null, childType: SpaceType) {
    if (parentId === null) {
      if (!isValidSpaceParent(null, childType)) {
        throw new BadRequestException(`${childType} cannot be created at root`);
      }
      return;
    }

    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('type')
      .eq('id', parentId)
      .eq('tenant_id', tenant.id)
      .single();

    if (error || !data) {
      throw new BadRequestException('Parent space not found');
    }

    if (!isValidSpaceParent(data.type as SpaceType, childType)) {
      throw new BadRequestException(
        `${childType} cannot be a child of ${data.type}`,
      );
    }
  }

  private buildTree(
    spaces: Array<Record<string, unknown>>,
    childCounts: Map<string | null, number>,
    parentId: string | null,
  ): unknown[] {
    return spaces
      .filter((s) => (s.parent_id as string | null) === parentId)
      .map((s) => ({
        ...s,
        child_count: childCounts.get(s.id as string) ?? 0,
        children: this.buildTree(spaces, childCounts, s.id as string),
      }));
  }
}
```

- [ ] **Step 4: Extend `SpaceController` — add `move` and `bulk`**

Modify `apps/api/src/modules/space/space.controller.ts`. Full new file:

```ts
import { Controller, Get, Post, Patch, Param, Body, Query } from '@nestjs/common';
import {
  SpaceService,
  CreateSpaceDto,
  UpdateSpaceDto,
  MoveSpaceDto,
  BulkUpdateDto,
} from './space.service';

@Controller('spaces')
export class SpaceController {
  constructor(private readonly spaceService: SpaceService) {}

  @Get()
  async list(
    @Query('type') type?: string,
    @Query('types') types?: string,
    @Query('parent_id') parentId?: string,
    @Query('reservable') reservable?: string,
    @Query('search') search?: string,
    @Query('active_only') activeOnly?: string,
  ) {
    return this.spaceService.list({
      type,
      types: types ? types.split(',').filter(Boolean) : undefined,
      parent_id: parentId,
      reservable: reservable === 'true' ? true : reservable === 'false' ? false : undefined,
      search,
      active_only: activeOnly === 'true' || activeOnly === '1',
    });
  }

  @Get('hierarchy')
  async hierarchy(@Query('root_id') rootId?: string) {
    return this.spaceService.getHierarchy(rootId);
  }

  @Patch('bulk')
  async bulk(@Body() dto: BulkUpdateDto) {
    return this.spaceService.bulkUpdate(dto);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.spaceService.getById(id);
  }

  @Post()
  async create(@Body() dto: CreateSpaceDto) {
    return this.spaceService.create(dto);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateSpaceDto) {
    return this.spaceService.update(id, dto);
  }

  @Post(':id/move')
  async move(@Param('id') id: string, @Body() dto: MoveSpaceDto) {
    return this.spaceService.move(id, dto);
  }
}
```

> **Route order matters in Nest:** `@Patch('bulk')` must be declared **before** `@Get(':id')` / `@Patch(':id')`, otherwise "bulk" gets captured as an id. The order above is correct.

- [ ] **Step 5: Run API tests + type check**

```bash
pnpm --filter api test -- space.service.spec
pnpm --filter api tsc --noEmit
```

Expected: tests pass, no type errors.

- [ ] **Step 6: Smoke-test the new endpoints**

Start the API (`pnpm dev:api`), then:

```bash
# assumes you have a valid bearer token and tenant; replace <TOKEN> and <TENANT>.
curl -s -H "Authorization: Bearer <TOKEN>" -H "X-Tenant-Id: <TENANT>" \
  http://localhost:3000/api/spaces/hierarchy | head -c 500
```

Expected: JSON array of tree nodes, each with `child_count`.

Try a bulk update against two room ids:
```bash
curl -s -X PATCH -H "Authorization: Bearer <TOKEN>" -H "X-Tenant-Id: <TENANT>" \
  -H 'Content-Type: application/json' \
  -d '{"ids":["<id1>","<id2>"],"patch":{"reservable":true}}' \
  http://localhost:3000/api/spaces/bulk
```

Expected: `{"results":[{"id":"<id1>","ok":true},{"id":"<id2>","ok":true}]}`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/space/space.service.ts \
        apps/api/src/modules/space/space.controller.ts \
        apps/api/src/modules/space/space.service.spec.ts
git commit -m "feat(api/spaces): add move, bulk update, child_count; validate parent rules"
```

---

## Task 4 — Install `@tanstack/react-virtual`

**Files:**
- Modify: `apps/web/package.json` (via pnpm)

- [ ] **Step 1: Install**

```bash
cd /Users/x/Desktop/XPQT
pnpm --filter web add @tanstack/react-virtual
```

Expected: pnpm adds the dep, lockfile updates.

- [ ] **Step 2: Verify**

```bash
grep '@tanstack/react-virtual' apps/web/package.json
```

Expected: one match in dependencies.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "chore(web): add @tanstack/react-virtual"
```

---

## Task 5 — Frontend React Query module for spaces

**Files:**
- Create: `apps/web/src/api/spaces/types.ts`
- Create: `apps/web/src/api/spaces/keys.ts`
- Create: `apps/web/src/api/spaces/queries.ts`
- Create: `apps/web/src/api/spaces/mutations.ts`
- Create: `apps/web/src/api/spaces/index.ts`

- [ ] **Step 1: Create `types.ts`**

```ts
import type { SpaceType } from '@prequest/shared';

export interface Space {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  type: SpaceType;
  code: string | null;
  name: string;
  capacity: number | null;
  amenities: string[] | null;
  attributes: Record<string, unknown> | null;
  reservable: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SpaceTreeNode extends Space {
  child_count: number;
  children: SpaceTreeNode[];
}

export interface CreateSpacePayload {
  parent_id: string | null;
  type: SpaceType;
  name: string;
  code?: string;
  capacity?: number;
  amenities?: string[];
  reservable?: boolean;
}

export interface UpdateSpacePayload {
  name?: string;
  code?: string;
  capacity?: number | null;
  amenities?: string[];
  reservable?: boolean;
  active?: boolean;
}

export interface BulkUpdateResult {
  results: Array<{ id: string; ok: boolean; error?: string }>;
}
```

- [ ] **Step 2: Create `keys.ts`**

```ts
export const spaceKeys = {
  all: ['spaces'] as const,
  tree: () => [...spaceKeys.all, 'tree'] as const,
  lists: () => [...spaceKeys.all, 'list'] as const,
  list: (filters: Record<string, unknown> = {}) => [...spaceKeys.lists(), filters] as const,
  details: () => [...spaceKeys.all, 'detail'] as const,
  detail: (id: string) => [...spaceKeys.details(), id] as const,
  children: (parentId: string) => [...spaceKeys.all, 'children', parentId] as const,
} as const;
```

- [ ] **Step 3: Create `queries.ts`**

```ts
import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { spaceKeys } from './keys';
import type { Space, SpaceTreeNode } from './types';

export function spaceTreeQueryOptions() {
  return queryOptions({
    queryKey: spaceKeys.tree(),
    queryFn: ({ signal }) => apiFetch<SpaceTreeNode[]>('/spaces/hierarchy', { signal }),
    staleTime: 30_000,
  });
}

export function useSpaceTree() {
  return useQuery(spaceTreeQueryOptions());
}

export function spaceDetailQueryOptions(id: string | null | undefined) {
  return queryOptions({
    queryKey: id ? spaceKeys.detail(id) : [...spaceKeys.details(), 'none'],
    queryFn: ({ signal }) => apiFetch<Space>(`/spaces/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useSpaceDetail(id: string | null | undefined) {
  return useQuery(spaceDetailQueryOptions(id));
}
```

- [ ] **Step 4: Create `mutations.ts`**

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { spaceKeys } from './keys';
import type {
  BulkUpdateResult,
  CreateSpacePayload,
  Space,
  UpdateSpacePayload,
} from './types';

export function useCreateSpace() {
  const qc = useQueryClient();
  return useMutation<Space, Error, CreateSpacePayload>({
    mutationFn: (payload) =>
      apiFetch<Space>('/spaces', { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: spaceKeys.tree() });
      qc.invalidateQueries({ queryKey: spaceKeys.lists() });
    },
  });
}

export function useUpdateSpace(id: string) {
  const qc = useQueryClient();
  return useMutation<Space, Error, UpdateSpacePayload>({
    mutationFn: (payload) =>
      apiFetch<Space>(`/spaces/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    onSuccess: (updated) => {
      qc.setQueryData(spaceKeys.detail(id), updated);
      qc.invalidateQueries({ queryKey: spaceKeys.tree() });
    },
  });
}

export function useMoveSpace(id: string) {
  const qc = useQueryClient();
  return useMutation<Space, Error, { parent_id: string | null }>({
    mutationFn: (payload) =>
      apiFetch<Space>(`/spaces/${id}/move`, { method: 'POST', body: JSON.stringify(payload) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: spaceKeys.all });
    },
  });
}

export function useDeleteSpace() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiFetch<void>(`/spaces/${id}`, { method: 'PATCH', body: JSON.stringify({ active: false }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: spaceKeys.all });
    },
  });
}

export function useBulkUpdateSpaces() {
  const qc = useQueryClient();
  return useMutation<BulkUpdateResult, Error, { ids: string[]; patch: UpdateSpacePayload }>({
    mutationFn: (payload) =>
      apiFetch<BulkUpdateResult>('/spaces/bulk', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: spaceKeys.all });
    },
  });
}
```

> **Note on delete:** the backend doesn't expose a DELETE endpoint; existing convention is soft-delete via `active=false`. `useDeleteSpace` reflects that.

- [ ] **Step 5: Create `index.ts` barrel**

```ts
export * from './types';
export * from './keys';
export * from './queries';
export * from './mutations';
```

- [ ] **Step 6: Type-check**

```bash
pnpm --filter web tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/api/spaces
git commit -m "feat(web/spaces): React Query module (keys, queries, mutations)"
```

---

## Task 6 — Type icon + taxonomy display helpers

**Files:**
- Create: `apps/web/src/components/admin/space-type-icon.tsx`

- [ ] **Step 1: Create the icon component**

```tsx
import {
  Building2, Building, Layers, DoorOpen, Armchair, Presentation,
  Coffee, Archive, Wrench, Car, MapPin,
} from 'lucide-react';
import type { SpaceType } from '@prequest/shared';
import { cn } from '@/lib/utils';

const iconMap: Record<SpaceType, typeof Building2> = {
  site: MapPin,
  building: Building2,
  wing: Building,
  floor: Layers,
  room: DoorOpen,
  desk: Armchair,
  meeting_room: Presentation,
  common_area: Coffee,
  storage_room: Archive,
  technical_room: Wrench,
  parking_space: Car,
};

export const SPACE_TYPE_LABELS: Record<SpaceType, string> = {
  site: 'Site',
  building: 'Building',
  wing: 'Wing',
  floor: 'Floor',
  room: 'Room',
  desk: 'Desk',
  meeting_room: 'Meeting room',
  common_area: 'Common area',
  storage_room: 'Storage room',
  technical_room: 'Technical room',
  parking_space: 'Parking space',
};

export function SpaceTypeIcon({
  type,
  className,
}: {
  type: SpaceType;
  className?: string;
}) {
  const Icon = iconMap[type];
  return <Icon className={cn('size-4 text-muted-foreground', className)} aria-hidden />;
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-type-icon.tsx
git commit -m "feat(web/spaces): type icon + label map"
```

---

## Task 7 — Type picker (parent-aware)

**Files:**
- Create: `apps/web/src/components/admin/space-type-picker.tsx`

- [ ] **Step 1: Create the picker**

```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { allowedChildTypes, type SpaceType } from '@prequest/shared';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from './space-type-icon';

interface SpaceTypePickerProps {
  /** The parent's type, or `null` for tenant root. Constrains the options. */
  parentType: SpaceType | null;
  value: SpaceType | '';
  onChange: (type: SpaceType) => void;
  id?: string;
  disabled?: boolean;
}

export function SpaceTypePicker({ parentType, value, onChange, id, disabled }: SpaceTypePickerProps) {
  const options = allowedChildTypes(parentType);
  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => v && onChange(v as SpaceType)}
      disabled={disabled || options.length === 0}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={options.length === 0 ? 'No child types allowed' : 'Select a type'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((t) => (
          <SelectItem key={t} value={t}>
            <div className="flex items-center gap-2">
              <SpaceTypeIcon type={t} />
              <span>{SPACE_TYPE_LABELS[t]}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-type-picker.tsx
git commit -m "feat(web/spaces): parent-aware type picker"
```

---

## Task 8 — Parent picker (tree picker for Move + Create)

**Files:**
- Create: `apps/web/src/components/admin/space-parent-picker.tsx`
- Create: `apps/web/src/components/admin/space-tree/build-tree.ts`

- [ ] **Step 1: Extract tree-building helper (reused by rail and picker)**

`apps/web/src/components/admin/space-tree/build-tree.ts`:

```ts
import type { SpaceTreeNode } from '@/api/spaces';
import type { SpaceType } from '@prequest/shared';

export interface FlatNode {
  id: string;
  name: string;
  code: string | null;
  type: SpaceType;
  parentId: string | null;
  depth: number;
  childIds: string[];
  childCount: number;
}

/** Flatten a nested tree into a depth-annotated array (pre-order). */
export function flattenTree(
  roots: SpaceTreeNode[],
  collapsedIds?: Set<string>,
  depth = 0,
  acc: FlatNode[] = [],
): FlatNode[] {
  for (const node of roots) {
    acc.push({
      id: node.id,
      name: node.name,
      code: node.code,
      type: node.type,
      parentId: node.parent_id,
      depth,
      childIds: node.children.map((c) => c.id),
      childCount: node.child_count,
    });
    if (!collapsedIds?.has(node.id)) {
      flattenTree(node.children, collapsedIds, depth + 1, acc);
    }
  }
  return acc;
}

export function findNode(
  roots: SpaceTreeNode[],
  id: string,
): SpaceTreeNode | null {
  for (const n of roots) {
    if (n.id === id) return n;
    const child = findNode(n.children, id);
    if (child) return child;
  }
  return null;
}

export function pathTo(
  roots: SpaceTreeNode[],
  id: string,
): SpaceTreeNode[] {
  const path: SpaceTreeNode[] = [];
  const walk = (nodes: SpaceTreeNode[]): boolean => {
    for (const n of nodes) {
      path.push(n);
      if (n.id === id) return true;
      if (walk(n.children)) return true;
      path.pop();
    }
    return false;
  };
  walk(roots);
  return path;
}
```

- [ ] **Step 2: Create the parent picker**

`apps/web/src/components/admin/space-parent-picker.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { useSpaceTree, type SpaceTreeNode } from '@/api/spaces';
import { allowedChildTypes, type SpaceType } from '@prequest/shared';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from './space-type-icon';
import { flattenTree, pathTo } from './space-tree/build-tree';

interface Props {
  /** The type of the node we're moving/creating. Used to filter valid parents. */
  childType: SpaceType;
  value: string | null;
  onChange: (parentId: string | null) => void;
  /** IDs to exclude (e.g. self and descendants when moving). */
  excludeIds?: ReadonlySet<string>;
  disabled?: boolean;
}

function canAcceptChild(parentType: SpaceType, childType: SpaceType): boolean {
  return allowedChildTypes(parentType).includes(childType);
}

export function SpaceParentPicker({
  childType,
  value,
  onChange,
  excludeIds,
  disabled,
}: Props) {
  const { data: tree = [] } = useSpaceTree();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const label = useMemo(() => {
    if (value === null) return 'Root (no parent)';
    if (!value) return 'Select a parent';
    const node = pathTo(tree, value).at(-1);
    return node ? node.name : 'Select a parent';
  }, [value, tree]);

  const rows = useMemo(() => {
    const flat = flattenTree(tree);
    return flat
      .filter((n) => !excludeIds?.has(n.id))
      .filter((n) => canAcceptChild(n.type, childType))
      .filter((n) => (search ? n.name.toLowerCase().includes(search.toLowerCase()) : true));
  }, [tree, excludeIds, childType, search]);

  const rootAllowed = allowedChildTypes(null).includes(childType);

  return (
    <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger render={<Button variant="outline" className="justify-between w-full" />}>
        <span className="truncate">{label}</span>
        <ChevronRight className="size-4 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-[360px]">
        <div className="p-2 border-b">
          <Input
            placeholder="Search parents…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <ScrollArea className="max-h-[320px]">
          <ul className="py-1">
            {rootAllowed && (
              <li>
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/60',
                    value === null && 'bg-muted',
                  )}
                  onClick={() => { onChange(null); setOpen(false); }}
                >
                  <span className="text-muted-foreground">Root (tenant top-level)</span>
                </button>
              </li>
            )}
            {rows.length === 0 && (
              <li className="px-3 py-4 text-sm text-muted-foreground">No valid parents</li>
            )}
            {rows.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  style={{ paddingLeft: `${12 + n.depth * 16}px` }}
                  className={cn(
                    'flex w-full items-center gap-2 pr-3 py-1.5 text-left text-sm hover:bg-muted/60',
                    value === n.id && 'bg-muted',
                  )}
                  onClick={() => { onChange(n.id); setOpen(false); }}
                >
                  <SpaceTypeIcon type={n.type} className="size-3.5" />
                  <span className="truncate">{n.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {SPACE_TYPE_LABELS[n.type]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-tree/build-tree.ts \
        apps/web/src/components/admin/space-parent-picker.tsx
git commit -m "feat(web/spaces): parent picker and tree helpers"
```

---

## Task 9 — Space form (shared create/edit dialog)

**Files:**
- Create: `apps/web/src/components/admin/space-form.tsx`

- [ ] **Step 1: Install `shadcn` command component if missing** — skip; `popover`, `select`, `scroll-area`, `field`, `dialog`, `input`, `checkbox` are already installed (confirmed by `ls apps/web/src/components/ui/`).

- [ ] **Step 2: Create the form**

```tsx
import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldSeparator } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { SpaceType } from '@prequest/shared';
import { useCreateSpace, useUpdateSpace, type Space } from '@/api/spaces';
import { SpaceTypePicker } from './space-type-picker';
import { SpaceParentPicker } from './space-parent-picker';
import { SPACE_TYPE_LABELS } from './space-type-icon';

const amenityOptions = [
  { value: 'projector', label: 'Projector' },
  { value: 'whiteboard', label: 'Whiteboard' },
  { value: 'video_conferencing', label: 'Video Conferencing' },
  { value: 'standing_desk', label: 'Standing Desk' },
  { value: 'dual_monitor', label: 'Dual Monitor' },
  { value: 'wheelchair_accessible', label: 'Wheelchair Accessible' },
];

type Mode =
  | { kind: 'create'; parentType: SpaceType | null; parentId: string | null }
  | { kind: 'edit'; space: Space };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
}

export function SpaceFormDialog({ open, onOpenChange, mode }: Props) {
  const [type, setType] = useState<SpaceType | ''>('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [capacity, setCapacity] = useState('');
  const [reservable, setReservable] = useState(false);
  const [amenities, setAmenities] = useState<string[]>([]);

  const createMut = useCreateSpace();
  const updateMut = useUpdateSpace(mode.kind === 'edit' ? mode.space.id : '');

  useEffect(() => {
    if (!open) return;
    if (mode.kind === 'create') {
      setType('');
      setParentId(mode.parentId);
      setName(''); setCode(''); setCapacity(''); setReservable(false); setAmenities([]);
    } else {
      setType(mode.space.type);
      setParentId(mode.space.parent_id);
      setName(mode.space.name);
      setCode(mode.space.code ?? '');
      setCapacity(mode.space.capacity?.toString() ?? '');
      setReservable(mode.space.reservable);
      setAmenities(mode.space.amenities ?? []);
    }
  }, [mode, open]);

  const toggleAmenity = (value: string) =>
    setAmenities((prev) => (prev.includes(value) ? prev.filter((a) => a !== value) : [...prev, value]));

  const handleSave = async () => {
    if (!name.trim() || !type) return;
    try {
      if (mode.kind === 'create') {
        await createMut.mutateAsync({
          parent_id: parentId,
          type,
          name: name.trim(),
          code: code.trim() || undefined,
          capacity: capacity ? parseInt(capacity, 10) : undefined,
          reservable,
          amenities: amenities.length > 0 ? amenities : undefined,
        });
        toast.success('Space created');
      } else {
        await updateMut.mutateAsync({
          name: name.trim(),
          code: code.trim() || undefined,
          capacity: capacity ? parseInt(capacity, 10) : null,
          reservable,
          amenities,
        });
        toast.success('Space updated');
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save space');
    }
  };

  const isEdit = mode.kind === 'edit';
  // When editing, the parent + type cannot change here — use Move for re-parenting.
  const parentPickerDisabled = isEdit;
  const typePickerDisabled = isEdit;
  const parentTypeForTypePicker: SpaceType | null = (() => {
    if (isEdit) return null; // not used; picker is disabled
    // For create, we need the parent's type to constrain the type picker.
    // parentId === null means root → parentType is null.
    if (parentId === null) return null;
    // Read the parent type from the create mode descriptor.
    return mode.kind === 'create' ? mode.parentType : null;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit space' : 'New space'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? `Editing ${SPACE_TYPE_LABELS[(mode as { space: Space }).space.type]} — use "Move" to change the parent.`
              : 'Sites, buildings, wings, floors, rooms, desks and more.'}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {!isEdit && (
            <Field>
              <FieldLabel htmlFor="space-type">Type</FieldLabel>
              <SpaceTypePicker
                id="space-type"
                parentType={parentTypeForTypePicker}
                value={type}
                onChange={setType}
                disabled={typePickerDisabled}
              />
            </Field>
          )}

          {!isEdit && (
            <Field>
              <FieldLabel>Parent</FieldLabel>
              <SpaceParentPicker
                childType={(type || 'site') as SpaceType}
                value={parentId}
                onChange={setParentId}
                disabled={parentPickerDisabled}
              />
            </Field>
          )}

          <FieldSeparator />

          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="space-name">Name</FieldLabel>
              <Input id="space-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Room 302" />
            </Field>
            <Field>
              <FieldLabel htmlFor="space-code">Code</FieldLabel>
              <Input id="space-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. AMS-A-302" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4 items-end">
            <Field>
              <FieldLabel htmlFor="space-capacity">Capacity</FieldLabel>
              <Input id="space-capacity" type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="0" />
            </Field>
            <Field orientation="horizontal">
              <Checkbox id="space-reservable" checked={reservable} onCheckedChange={(c) => setReservable(c === true)} />
              <FieldLabel htmlFor="space-reservable" className="font-normal">Reservable</FieldLabel>
            </Field>
          </div>

          <FieldSet>
            <FieldLegend variant="label">Amenities</FieldLegend>
            <FieldGroup data-slot="checkbox-group" className="grid grid-cols-2 gap-2">
              {amenityOptions.map((opt) => (
                <Field key={opt.value} orientation="horizontal">
                  <Checkbox
                    id={`space-amenity-${opt.value}`}
                    checked={amenities.includes(opt.value)}
                    onCheckedChange={() => toggleAmenity(opt.value)}
                  />
                  <FieldLabel htmlFor={`space-amenity-${opt.value}`} className="font-normal">
                    {opt.label}
                  </FieldLabel>
                </Field>
              ))}
            </FieldGroup>
          </FieldSet>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || !type || createMut.isPending || updateMut.isPending}
          >
            {isEdit ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-form.tsx
git commit -m "feat(web/spaces): shared create/edit dialog using shadcn Field primitives"
```

---

## Task 10 — Tree rail: state hook (selection + URL sync + expanded set)

**Files:**
- Create: `apps/web/src/components/admin/space-tree/use-space-tree-state.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { SpaceTreeNode } from '@/api/spaces';
import { pathTo } from './build-tree';

export interface SpaceTreeState {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  expandedIds: Set<string>;
  toggleExpanded: (id: string) => void;
  expandPath: (ids: string[]) => void;
  collapseAllDeep: () => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  mode: 'tree' | 'flat';
  setMode: (m: 'tree' | 'flat') => void;
}

const INITIAL_EXPANDED_TYPES = new Set(['site', 'building']);

export function useSpaceTreeState(tree: SpaceTreeNode[]): SpaceTreeState {
  const { spaceId } = useParams<{ spaceId?: string }>();
  const navigate = useNavigate();

  const setSelectedId = useCallback((id: string | null) => {
    navigate(id ? `/admin/locations/${id}` : '/admin/locations', { replace: false });
  }, [navigate]);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [mode, setMode] = useState<'tree' | 'flat'>('tree');

  // Seed: expand all site + building nodes once, the first time the tree loads.
  useEffect(() => {
    if (tree.length === 0 || expandedIds.size > 0) return;
    const seed = new Set<string>();
    const walk = (nodes: SpaceTreeNode[]) => {
      for (const n of nodes) {
        if (INITIAL_EXPANDED_TYPES.has(n.type)) seed.add(n.id);
        walk(n.children);
      }
    };
    walk(tree);
    setExpandedIds(seed);
  }, [tree, expandedIds.size]);

  // When selectedId changes from URL, auto-expand the path to it.
  useEffect(() => {
    if (!spaceId || tree.length === 0) return;
    const path = pathTo(tree, spaceId);
    if (path.length === 0) return;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const n of path) if (n.id !== spaceId) next.add(n.id);
      return next;
    });
  }, [spaceId, tree]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const expandPath = useCallback((ids: string[]) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const collapseAllDeep = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  return useMemo(() => ({
    selectedId: spaceId ?? null,
    setSelectedId,
    expandedIds,
    toggleExpanded,
    expandPath,
    collapseAllDeep,
    searchQuery,
    setSearchQuery,
    mode,
    setMode,
  }), [spaceId, setSelectedId, expandedIds, toggleExpanded, expandPath, collapseAllDeep, searchQuery, mode]);
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-tree/use-space-tree-state.ts
git commit -m "feat(web/spaces): tree state hook with URL sync and path-auto-expand"
```

---

## Task 11 — Tree rail: row + orchestrator + virtualisation

**Files:**
- Create: `apps/web/src/components/admin/space-tree/space-tree-row.tsx`
- Create: `apps/web/src/components/admin/space-tree/space-tree.tsx`

- [ ] **Step 1: Create the row**

```tsx
import { ChevronRight, Plus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { FlatNode } from './build-tree';
import { SpaceTypeIcon } from '../space-type-icon';

interface Props {
  node: FlatNode;
  isExpanded: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  onAddChild: () => void;
}

export function SpaceTreeRow({
  node, isExpanded, isSelected, onSelect, onToggleExpand, onAddChild,
}: Props) {
  const hasChildren = node.childCount > 0;
  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={isSelected}
      tabIndex={isSelected ? 0 : -1}
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-2 pr-2 py-1.5 cursor-pointer select-none rounded-md',
        'hover:bg-muted/50',
        isSelected && 'bg-accent/40 border-l-2 border-l-primary',
      )}
      style={{ paddingLeft: `${8 + node.depth * 16}px` }}
    >
      <button
        type="button"
        aria-label={isExpanded ? 'Collapse' : 'Expand'}
        onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
        className={cn(
          'inline-flex size-4 items-center justify-center text-muted-foreground transition-transform',
          !hasChildren && 'invisible',
          isExpanded && 'rotate-90',
        )}
      >
        <ChevronRight className="size-4" />
      </button>
      <SpaceTypeIcon type={node.type} />
      <span className="flex-1 truncate text-sm">{node.name}</span>
      {node.code && (
        <Badge variant="outline" className="font-mono text-[11px] px-1.5 py-0">{node.code}</Badge>
      )}
      {hasChildren && (
        <span className="text-xs text-muted-foreground tabular-nums" aria-label={`${node.childCount} children`}>
          {node.childCount}
        </span>
      )}
      <button
        type="button"
        aria-label="Add child"
        onClick={(e) => { e.stopPropagation(); onAddChild(); }}
        className="inline-flex size-5 items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Create the tree orchestrator (virtualised)**

```tsx
import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SpaceTreeNode } from '@/api/spaces';
import { flattenTree } from './build-tree';
import { SpaceTreeRow } from './space-tree-row';
import type { SpaceTreeState } from './use-space-tree-state';

interface Props {
  tree: SpaceTreeNode[];
  state: SpaceTreeState;
  onAddChild: (parentId: string, parentType: SpaceTreeNode['type']) => void;
}

export function SpaceTree({ tree, state, onAddChild }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const collapsed = useMemo(() => {
    // Convert expandedIds → collapsedIds for flattenTree helper.
    const collapsed = new Set<string>();
    const walk = (nodes: SpaceTreeNode[]) => {
      for (const n of nodes) {
        if (!state.expandedIds.has(n.id)) collapsed.add(n.id);
        walk(n.children);
      }
    };
    walk(tree);
    return collapsed;
  }, [tree, state.expandedIds]);

  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 12,
  });

  return (
    <div
      ref={parentRef}
      role="tree"
      aria-label="Spaces"
      className="relative overflow-auto flex-1"
    >
      <div style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((vi) => {
          const node = rows[vi.index];
          return (
            <div
              key={node.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <SpaceTreeRow
                node={node}
                isExpanded={state.expandedIds.has(node.id)}
                isSelected={state.selectedId === node.id}
                onSelect={() => state.setSelectedId(node.id)}
                onToggleExpand={() => state.toggleExpanded(node.id)}
                onAddChild={() => onAddChild(node.id, node.type)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-tree/space-tree-row.tsx \
        apps/web/src/components/admin/space-tree/space-tree.tsx
git commit -m "feat(web/spaces): virtualised tree rail with row + orchestrator"
```

---

## Task 12 — Tree rail: search, filter chips, and flat-mode list

**Files:**
- Create: `apps/web/src/components/admin/space-tree/space-tree-search.tsx`
- Create: `apps/web/src/components/admin/space-tree/space-tree-flat-list.tsx`

- [ ] **Step 1: Create the search + mode toggle**

```tsx
import { Search, ListTree, List } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface Props {
  value: string;
  onChange: (v: string) => void;
  mode: 'tree' | 'flat';
  onModeChange: (m: 'tree' | 'flat') => void;
}

export function SpaceTreeSearch({ value, onChange, mode, onModeChange }: Props) {
  return (
    <div className="flex items-center gap-2 p-2 border-b">
      <div className="relative flex-1">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" aria-hidden />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search name or code…"
          className="h-8 pl-7 text-sm"
        />
      </div>
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(v) => v && onModeChange(v as 'tree' | 'flat')}
        size="sm"
      >
        <ToggleGroupItem value="tree" aria-label="Tree view"><ListTree className="size-3.5" /></ToggleGroupItem>
        <ToggleGroupItem value="flat" aria-label="Flat list view"><List className="size-3.5" /></ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
```

- [ ] **Step 2: Create the flat-mode list**

```tsx
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SpaceTreeNode } from '@/api/spaces';
import { flattenTree, pathTo } from './build-tree';
import { SpaceTypeIcon } from '../space-type-icon';

interface Props {
  tree: SpaceTreeNode[];
  query: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function SpaceTreeFlatList({ tree, query, selectedId, onSelect }: Props) {
  const rows = useMemo(() => {
    const flat = flattenTree(tree);
    const q = query.trim().toLowerCase();
    return flat.filter((n) => {
      if (!q) return true;
      return (
        n.name.toLowerCase().includes(q) ||
        (n.code ?? '').toLowerCase().includes(q)
      );
    });
  }, [tree, query]);

  if (rows.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No matches.</div>;
  }

  return (
    <ul className="flex-1 overflow-auto py-1">
      {rows.map((n) => {
        const path = pathTo(tree, n.id);
        const breadcrumb = path.slice(0, -1).map((p) => p.name).join(' › ');
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => onSelect(n.id)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50',
                selectedId === n.id && 'bg-accent/40',
              )}
            >
              <SpaceTypeIcon type={n.type} />
              <div className="flex-1 min-w-0">
                <div className="truncate text-sm">{n.name}</div>
                {breadcrumb && (
                  <div className="truncate text-[11px] text-muted-foreground">{breadcrumb}</div>
                )}
              </div>
              {n.code && <Badge variant="outline" className="font-mono text-[11px]">{n.code}</Badge>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-tree/space-tree-search.tsx \
        apps/web/src/components/admin/space-tree/space-tree-flat-list.tsx
git commit -m "feat(web/spaces): rail search + flat-mode list"
```

---

## Task 13 — Detail pane: header + breadcrumb + actions

**Files:**
- Create: `apps/web/src/components/admin/space-detail/space-detail-header.tsx`

- [ ] **Step 1: Create the header**

```tsx
import { ChevronRight, Pencil, MoveRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Space, SpaceTreeNode } from '@/api/spaces';
import { pathTo } from '../space-tree/build-tree';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from '../space-type-icon';

interface Props {
  space: Space;
  tree: SpaceTreeNode[];
  onNavigate: (id: string | null) => void;
  onEdit: () => void;
  onMove: () => void;
  onArchive: () => void;
}

export function SpaceDetailHeader({ space, tree, onNavigate, onEdit, onMove, onArchive }: Props) {
  const path = pathTo(tree, space.id).slice(0, -1);
  const truncated = path.length > 4;
  const visible = truncated ? [path[0], ...path.slice(-2)] : path;

  return (
    <div className="border-b px-6 py-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-muted-foreground">
        <button type="button" className="hover:text-foreground" onClick={() => onNavigate(null)}>All spaces</button>
        {visible.map((n, i) => (
          <span key={n.id} className="flex items-center gap-1">
            <ChevronRight className="size-3" />
            {truncated && i === 1 && <span className="text-muted-foreground">…</span>}
            {truncated && i === 1 && <ChevronRight className="size-3" />}
            <button type="button" className="hover:text-foreground truncate max-w-[160px]" onClick={() => onNavigate(n.id)}>
              {n.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="mt-2 flex items-start gap-3">
        <SpaceTypeIcon type={space.type} className="size-5 mt-1" />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold tracking-tight truncate">{space.name}</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="secondary">{SPACE_TYPE_LABELS[space.type]}</Badge>
            {space.code && <span className="font-mono">{space.code}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon" onClick={onEdit} />}>
              <Pencil className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Edit</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon" onClick={onMove} />}>
              <MoveRight className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Move</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon" onClick={onArchive} />}>
              <Trash2 className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Archive</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-detail/space-detail-header.tsx
git commit -m "feat(web/spaces): detail header with clickable breadcrumb and actions"
```

---

## Task 14 — Detail pane: metadata strip (inline-editable)

**Files:**
- Create: `apps/web/src/components/admin/space-detail/space-metadata-strip.tsx`

- [ ] **Step 1: Create the strip**

```tsx
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useUpdateSpace, type Space } from '@/api/spaces';

interface Props { space: Space }

export function SpaceMetadataStrip({ space }: Props) {
  const update = useUpdateSpace(space.id);
  const [capacityDraft, setCapacityDraft] = useState<string>(space.capacity?.toString() ?? '');
  const [capacityError, setCapacityError] = useState<string | null>(null);

  const saveCapacity = async () => {
    const next = capacityDraft ? Number.parseInt(capacityDraft, 10) : null;
    if (capacityDraft && Number.isNaN(next)) {
      setCapacityError('Must be a number');
      return;
    }
    setCapacityError(null);
    if (next === space.capacity) return;
    try {
      await update.mutateAsync({ capacity: next });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save capacity');
      setCapacityDraft(space.capacity?.toString() ?? '');
    }
  };

  const toggleReservable = async (v: boolean) => {
    try {
      await update.mutateAsync({ reservable: v });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update reservable');
    }
  };

  return (
    <div className="px-6 py-4 border-b flex items-center gap-6 flex-wrap text-sm">
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Capacity</span>
        <Input
          type="number"
          value={capacityDraft}
          onChange={(e) => setCapacityDraft(e.target.value)}
          onBlur={saveCapacity}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="h-7 w-20"
        />
        {capacityError && <span className="text-xs text-destructive">{capacityError}</span>}
      </label>

      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Reservable</span>
        <Switch
          checked={space.reservable}
          onCheckedChange={toggleReservable}
          disabled={update.isPending}
          aria-label="Reservable"
        />
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-muted-foreground">Amenities</span>
        {(space.amenities ?? []).length === 0 && <span className="text-muted-foreground">—</span>}
        {(space.amenities ?? []).map((a) => (
          <Badge key={a} variant="secondary" className="capitalize">{a.replace(/_/g, ' ')}</Badge>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Install Switch component if missing**

```bash
npx shadcn@latest add switch -y
```

If a prompt asks to overwrite — decline. Check `apps/web/src/components/ui/switch.tsx` exists after.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-detail/space-metadata-strip.tsx apps/web/src/components/ui/switch.tsx
git commit -m "feat(web/spaces): metadata strip with inline capacity + reservable toggle"
```

---

## Task 15 — Detail pane: children table + bulk-edit bar

**Files:**
- Create: `apps/web/src/components/admin/space-detail/space-children-bulk-bar.tsx`
- Create: `apps/web/src/components/admin/space-detail/space-children-table.tsx`

- [ ] **Step 1: Create the bulk bar**

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { useBulkUpdateSpaces } from '@/api/spaces';
import type { BulkUpdateResult } from '@/api/spaces';

interface Props {
  selectedIds: string[];
  onClear: () => void;
}

export function SpaceChildrenBulkBar({ selectedIds, onClear }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reservable, setReservable] = useState<boolean | null>(null);
  const bulk = useBulkUpdateSpaces();

  if (selectedIds.length === 0) return null;

  const apply = async () => {
    const patch: { reservable?: boolean } = {};
    if (reservable !== null) patch.reservable = reservable;
    if (Object.keys(patch).length === 0) {
      toast.error('Pick at least one change to apply');
      return;
    }
    try {
      const res: BulkUpdateResult = await bulk.mutateAsync({ ids: selectedIds, patch });
      const okCount = res.results.filter((r) => r.ok).length;
      const failed = res.results.filter((r) => !r.ok);
      if (failed.length === 0) toast.success(`Updated ${okCount} spaces`);
      else toast.warning(`Updated ${okCount}; ${failed.length} failed: ${failed.map((f) => f.error).join(', ')}`);
      setDialogOpen(false);
      onClear();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk update failed');
    }
  };

  return (
    <>
      <div className="sticky bottom-0 z-10 mt-2 flex items-center gap-3 rounded-md border bg-background px-3 py-2 shadow-sm">
        <span className="text-sm font-medium">{selectedIds.length} selected</span>
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>Bulk edit…</Button>
        <Button size="sm" variant="ghost" onClick={onClear}>Cancel</Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Bulk edit {selectedIds.length} spaces</DialogTitle>
          </DialogHeader>
          <FieldGroup>
            <Field orientation="horizontal">
              <Checkbox
                id="bulk-reservable"
                checked={reservable === true}
                onCheckedChange={(c) => setReservable(c === true ? true : c === false && reservable === true ? null : false)}
              />
              <FieldLabel htmlFor="bulk-reservable" className="font-normal">
                Reservable: set all to {reservable === null ? '…' : reservable ? 'Yes' : 'No'}
              </FieldLabel>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={apply} disabled={bulk.isPending}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 2: Create the children table**

```tsx
import { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import type { Space, SpaceTreeNode } from '@/api/spaces';
import { findNode } from '../space-tree/build-tree';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from '../space-type-icon';
import { SpaceChildrenBulkBar } from './space-children-bulk-bar';
import { allowedChildTypes } from '@prequest/shared';

interface Props {
  parent: Space;
  tree: SpaceTreeNode[];
  onSelectChild: (id: string) => void;
  onAddChild: () => void;
}

export function SpaceChildrenTable({ parent, tree, onSelectChild, onAddChild }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const node = useMemo(() => findNode(tree, parent.id), [tree, parent.id]);
  const children = node?.children ?? [];

  const canAdd = allowedChildTypes(parent.type).length > 0;

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAll = () => {
    if (selected.size === children.length) setSelected(new Set());
    else setSelected(new Set(children.map((c) => c.id)));
  };

  if (children.length === 0) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">No children yet.</p>
        {canAdd && (
          <Button className="mt-3" size="sm" onClick={onAddChild}>
            <Plus className="size-3.5" /> Add child
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Children ({children.length})</h3>
        {canAdd && (
          <Button size="sm" variant="outline" onClick={onAddChild}>
            <Plus className="size-3.5" /> Add child
          </Button>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40px]">
              <Checkbox
                checked={selected.size === children.length && children.length > 0}
                onCheckedChange={toggleAll}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Code</TableHead>
            <TableHead>Capacity</TableHead>
            <TableHead>Reservable</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {children.map((c) => (
            <TableRow
              key={c.id}
              onClick={() => onSelectChild(c.id)}
              className="cursor-pointer"
            >
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} />
              </TableCell>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  <SpaceTypeIcon type={c.type} />
                  {c.name}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">{SPACE_TYPE_LABELS[c.type]}</TableCell>
              <TableCell className="text-muted-foreground font-mono text-xs">{c.code ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground">{c.capacity ?? '—'}</TableCell>
              <TableCell>
                {c.reservable ? <Badge variant="default">Yes</Badge> : <span className="text-muted-foreground">No</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <SpaceChildrenBulkBar
        selectedIds={Array.from(selected)}
        onClear={() => setSelected(new Set())}
      />
    </div>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-detail/space-children-table.tsx \
        apps/web/src/components/admin/space-detail/space-children-bulk-bar.tsx
git commit -m "feat(web/spaces): children table with multi-select and bulk edit bar"
```

---

## Task 16 — Detail pane: orchestrator + root summary + move dialog

**Files:**
- Create: `apps/web/src/components/admin/space-detail/space-detail-root-summary.tsx`
- Create: `apps/web/src/components/admin/space-detail/space-detail.tsx`

- [ ] **Step 1: Create the root summary**

```tsx
import { Card, CardContent } from '@/components/ui/card';
import { useSpaceTree } from '@/api/spaces';
import { SPACE_TYPES, type SpaceType } from '@prequest/shared';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from '../space-type-icon';

function walk(tree: ReturnType<typeof useSpaceTree>['data'], cb: (type: SpaceType) => void) {
  for (const n of tree ?? []) {
    cb(n.type);
    walk(n.children as unknown as typeof tree, cb);
  }
}

export function SpaceDetailRootSummary() {
  const { data: tree = [] } = useSpaceTree();
  const counts = new Map<SpaceType, number>();
  walk(tree, (t) => counts.set(t, (counts.get(t) ?? 0) + 1));

  const summary: SpaceType[] = ['site', 'building', 'floor', 'room', 'meeting_room', 'desk'];

  return (
    <div className="p-8">
      <h2 className="text-lg font-semibold mb-4">Spaces overview</h2>
      <div className="grid grid-cols-3 gap-3 max-w-2xl">
        {summary.map((t) => (
          <Card key={t}>
            <CardContent className="p-4 flex items-center gap-3">
              <SpaceTypeIcon type={t} className="size-6" />
              <div>
                <div className="text-2xl font-semibold tabular-nums">{counts.get(t) ?? 0}</div>
                <div className="text-xs text-muted-foreground">{SPACE_TYPE_LABELS[t]}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-6 text-sm text-muted-foreground">Select a space in the tree to see its details.</p>
    </div>
  );
}
```

- [ ] **Step 2: Install `card` if missing**

```bash
ls apps/web/src/components/ui/card.tsx || npx shadcn@latest add card -y
```

- [ ] **Step 3: Create the detail orchestrator**

```tsx
import { useState, useMemo } from 'react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { useSpaceDetail, useSpaceTree, useDeleteSpace, useMoveSpace, type Space } from '@/api/spaces';
import { findNode, pathTo } from '../space-tree/build-tree';
import { SpaceParentPicker } from '../space-parent-picker';
import { SpaceFormDialog } from '../space-form';
import { SpaceDetailHeader } from './space-detail-header';
import { SpaceMetadataStrip } from './space-metadata-strip';
import { SpaceChildrenTable } from './space-children-table';
import { SpaceDetailRootSummary } from './space-detail-root-summary';

interface Props {
  spaceId: string | null;
  onNavigate: (id: string | null) => void;
}

export function SpaceDetail({ spaceId, onNavigate }: Props) {
  const { data: tree = [] } = useSpaceTree();
  const { data: space, isLoading, isError } = useSpaceDetail(spaceId);
  const deleteMut = useDeleteSpace();
  const moveMut = useMoveSpace(spaceId ?? '');

  const [editOpen, setEditOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [createUnder, setCreateUnder] = useState<{ id: string | null; type: Space['type'] | null } | null>(null);

  const descendantIds = useMemo(() => {
    if (!spaceId) return new Set<string>();
    const node = findNode(tree, spaceId);
    const ids = new Set<string>([spaceId]);
    const walk = (n: typeof node) => {
      if (!n) return;
      for (const c of n.children) { ids.add(c.id); walk(c); }
    };
    walk(node);
    return ids;
  }, [tree, spaceId]);

  if (!spaceId) return <SpaceDetailRootSummary />;

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  if (isError || !space) {
    return (
      <div className="p-8">
        <h2 className="text-lg font-semibold mb-2">This space no longer exists</h2>
        <Button variant="outline" onClick={() => onNavigate(null)}>Back to overview</Button>
      </div>
    );
  }

  const handleArchive = async () => {
    if (!confirm(`Archive "${space.name}"? It will no longer appear in the tree.`)) return;
    try {
      await deleteMut.mutateAsync(space.id);
      toast.success('Archived');
      // Navigate up to parent if present.
      const path = pathTo(tree, space.id);
      const parent = path.at(-2)?.id ?? null;
      onNavigate(parent);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive');
    }
  };

  const handleMoveSubmit = async () => {
    try {
      await moveMut.mutateAsync({ parent_id: moveTarget });
      toast.success('Moved');
      setMoveOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to move');
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <SpaceDetailHeader
        space={space}
        tree={tree}
        onNavigate={onNavigate}
        onEdit={() => setEditOpen(true)}
        onMove={() => { setMoveTarget(space.parent_id); setMoveOpen(true); }}
        onArchive={handleArchive}
      />
      <SpaceMetadataStrip space={space} />

      <Tabs defaultValue="children" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="mx-6 mt-2 self-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="children">Children</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="px-6 py-4 text-sm text-muted-foreground">
          Created {new Date(space.created_at).toLocaleDateString()}. Last updated {new Date(space.updated_at).toLocaleString()}.
        </TabsContent>

        <TabsContent value="children" className="flex-1 overflow-auto">
          <SpaceChildrenTable
            parent={space}
            tree={tree}
            onSelectChild={(id) => onNavigate(id)}
            onAddChild={() => setCreateUnder({ id: space.id, type: space.type })}
          />
        </TabsContent>

        <TabsContent value="activity" className="px-6 py-8 text-sm text-muted-foreground">
          Activity feed coming soon. For now: last updated {new Date(space.updated_at).toLocaleString()}.
        </TabsContent>
      </Tabs>

      <SpaceFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        mode={{ kind: 'edit', space }}
      />

      {createUnder && (
        <SpaceFormDialog
          open={Boolean(createUnder)}
          onOpenChange={(o) => !o && setCreateUnder(null)}
          mode={{ kind: 'create', parentId: createUnder.id, parentType: createUnder.type as Space['type'] | null }}
        />
      )}

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Move {space.name}</DialogTitle>
            <DialogDescription>Pick a new parent. Only types that can contain {space.type} are shown.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>New parent</FieldLabel>
              <SpaceParentPicker
                childType={space.type}
                value={moveTarget}
                onChange={setMoveTarget}
                excludeIds={descendantIds}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)}>Cancel</Button>
            <Button onClick={handleMoveSubmit} disabled={moveMut.isPending}>Move</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

- [ ] **Step 4: Install `tabs` component if missing**

```bash
ls apps/web/src/components/ui/tabs.tsx
```

Expected: file exists (confirmed earlier).

- [ ] **Step 5: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-detail/space-detail.tsx \
        apps/web/src/components/admin/space-detail/space-detail-root-summary.tsx
git commit -m "feat(web/spaces): detail orchestrator with tabs, move, archive, and root summary"
```

---

## Task 17 — Page rewrite + route change

**Files:**
- Modify: `apps/web/src/pages/admin/locations.tsx` (full rewrite)
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Update the route**

In `apps/web/src/App.tsx`, change:

```tsx
<Route path="locations" element={<LocationsPage />} />
```

to:

```tsx
<Route path="locations" element={<LocationsPage />} />
<Route path="locations/:spaceId" element={<LocationsPage />} />
```

(Both paths render the same component; React Router v7 reads `:spaceId` from `useParams`.)

- [ ] **Step 2: Rewrite `locations.tsx`**

Full new contents:

```tsx
import { useState, useMemo } from 'react';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { useSpaceTree } from '@/api/spaces';
import { SpaceTreeSearch } from '@/components/admin/space-tree/space-tree-search';
import { SpaceTree } from '@/components/admin/space-tree/space-tree';
import { SpaceTreeFlatList } from '@/components/admin/space-tree/space-tree-flat-list';
import { useSpaceTreeState } from '@/components/admin/space-tree/use-space-tree-state';
import { SpaceDetail } from '@/components/admin/space-detail/space-detail';
import { SpaceFormDialog } from '@/components/admin/space-form';

export function LocationsPage() {
  const { data: tree = [], isLoading } = useSpaceTree();
  const state = useSpaceTreeState(tree);
  const [rootCreateOpen, setRootCreateOpen] = useState(false);
  const [childCreate, setChildCreate] = useState<{ id: string; type: 'site' | 'building' | 'wing' | 'floor' | 'room' } | null>(null);

  const handleAddChild = (parentId: string, parentType: 'site' | 'building' | 'wing' | 'floor' | 'room') =>
    setChildCreate({ id: parentId, type: parentType });

  const matchCount = useMemo(() => {
    if (state.mode !== 'flat' || !state.searchQuery.trim()) return null;
    const q = state.searchQuery.toLowerCase();
    let count = 0;
    const walk = (nodes: typeof tree) => {
      for (const n of nodes) {
        if (n.name.toLowerCase().includes(q) || (n.code ?? '').toLowerCase().includes(q)) count++;
        walk(n.children);
      }
    };
    walk(tree);
    return count;
  }, [state.mode, state.searchQuery, tree]);

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col">
      <div className="flex items-center justify-between px-6 py-3 border-b">
        <div>
          <h1 className="text-lg font-semibold">Locations & Spaces</h1>
          <p className="text-xs text-muted-foreground">Sites, buildings, wings, floors, rooms, and desks</p>
        </div>
        <Button size="sm" onClick={() => setRootCreateOpen(true)}>
          <Plus className="size-3.5" /> Add site
        </Button>
      </div>

      <ResizablePanelGroup direction="horizontal" className="flex-1">
        <ResizablePanel defaultSize={28} minSize={20} maxSize={45} className="flex flex-col">
          <SpaceTreeSearch
            value={state.searchQuery}
            onChange={state.setSearchQuery}
            mode={state.mode}
            onModeChange={state.setMode}
          />
          {isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No spaces yet. <button type="button" className="underline" onClick={() => setRootCreateOpen(true)}>Add your first site</button>.
            </div>
          ) : state.mode === 'flat' ? (
            <>
              {matchCount !== null && (
                <div className="px-3 py-1.5 text-xs text-muted-foreground border-b">{matchCount} matches</div>
              )}
              <SpaceTreeFlatList
                tree={tree}
                query={state.searchQuery}
                selectedId={state.selectedId}
                onSelect={(id) => state.setSelectedId(id)}
              />
            </>
          ) : (
            <SpaceTree tree={tree} state={state} onAddChild={handleAddChild} />
          )}
        </ResizablePanel>

        <ResizableHandle />

        <ResizablePanel defaultSize={72} className="flex flex-col overflow-hidden">
          <SpaceDetail spaceId={state.selectedId} onNavigate={state.setSelectedId} />
        </ResizablePanel>
      </ResizablePanelGroup>

      <SpaceFormDialog
        open={rootCreateOpen}
        onOpenChange={setRootCreateOpen}
        mode={{ kind: 'create', parentId: null, parentType: null }}
      />

      {childCreate && (
        <SpaceFormDialog
          open={Boolean(childCreate)}
          onOpenChange={(o) => !o && setChildCreate(null)}
          mode={{ kind: 'create', parentId: childCreate.id, parentType: childCreate.type }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Install `resizable` component if missing**

```bash
ls apps/web/src/components/ui/resizable.tsx
```

Expected: file exists (confirmed earlier in the file listing).

- [ ] **Step 4: Type-check**

```bash
pnpm --filter web tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Smoke-test in browser**

```bash
pnpm dev
```

Open `http://localhost:5173/admin/locations` in a browser. Verify:
- Tree loads in left rail with chevrons + type icons.
- Clicking a row navigates to `/admin/locations/:spaceId` and shows the detail pane.
- Search narrows the flat list; toggle back to tree mode works.
- "Add site" at the top creates a site at root.
- Hovering a tree row shows `+` to add a child — types are filtered by parent.
- Moving a space via the Move dialog rejects invalid parents (test: try to move a floor under a room — should fail with a toast).
- Archiving a space removes it from the tree and navigates up.
- Inline capacity edit + reservable toggle on the metadata strip persists.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/admin/locations.tsx apps/web/src/App.tsx
git commit -m "feat(web/spaces): two-pane explorer replacing the flat table"
```

---

## Task 18 — Accessibility + keyboard nav sweep

**Files:**
- Modify: `apps/web/src/components/admin/space-tree/space-tree.tsx`
- Modify: `apps/web/src/pages/admin/locations.tsx`

- [ ] **Step 1: Add keyboard handler to the tree orchestrator**

In `space-tree.tsx`, wrap the tree container:

```tsx
const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
  if (!state.selectedId) return;
  const index = rows.findIndex((r) => r.id === state.selectedId);
  if (index === -1) return;

  switch (e.key) {
    case 'ArrowDown': {
      e.preventDefault();
      const next = rows[Math.min(index + 1, rows.length - 1)];
      if (next) state.setSelectedId(next.id);
      break;
    }
    case 'ArrowUp': {
      e.preventDefault();
      const prev = rows[Math.max(index - 1, 0)];
      if (prev) state.setSelectedId(prev.id);
      break;
    }
    case 'ArrowRight': {
      e.preventDefault();
      if (!state.expandedIds.has(state.selectedId)) state.toggleExpanded(state.selectedId);
      break;
    }
    case 'ArrowLeft': {
      e.preventDefault();
      if (state.expandedIds.has(state.selectedId)) state.toggleExpanded(state.selectedId);
      else {
        const parentId = rows[index].parentId;
        if (parentId) state.setSelectedId(parentId);
      }
      break;
    }
  }
};
```

Attach it: `<div ref={parentRef} role="tree" aria-label="Spaces" tabIndex={0} onKeyDown={onKeyDown} …>`.

- [ ] **Step 2: Add `⌘K` focus-search shortcut to the page**

In `locations.tsx`, add a ref to the search input (via SpaceTreeSearch accepting a forwardRef or a new prop). Simpler: use a global listener:

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      document.querySelector<HTMLInputElement>('input[placeholder="Search name or code…"]')?.focus();
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, []);
```

Add `import { useEffect } from 'react';`.

- [ ] **Step 3: Manual verification**

Run `pnpm dev`, open the page, click a tree row, then:
- ↓ moves down, ↑ moves up.
- → expands; ← collapses or jumps to parent.
- ⌘K focuses the search box.

- [ ] **Step 4: Type-check + commit**

```bash
pnpm --filter web tsc --noEmit
git add apps/web/src/components/admin/space-tree/space-tree.tsx apps/web/src/pages/admin/locations.tsx
git commit -m "feat(web/spaces): keyboard nav (arrows, ⌘K) in the tree rail"
```

---

## Task 19 — Push migration to remote and final smoke

**Files:** (no code changes)

- [ ] **Step 1: Confirm with the user before pushing**

**STOP.** Per CLAUDE.md: "Always confirm with the user before running `pnpm db:push` or `supabase db push`." Ask the user:

> "Ready to push migration 00107 to the remote Supabase project. This adds `wing` as a space type and installs the parent-rule trigger. Proceed?"

Wait for explicit "yes" / "go" / "do it" before continuing.

- [ ] **Step 2: Push the migration**

Preferred:

```bash
cd /Users/x/Desktop/XPQT
pnpm db:push
```

If that fails (per repo memory, it often does on this workspace), fall back to psql. Ask the user for the remote DB password, then:

```bash
PGPASSWORD='<pwd>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/migrations/00107_space_wing_and_parent_rule.sql
```

Expected: no errors. The migration file already ends with `notify pgrst, 'reload schema';`.

- [ ] **Step 3: Confirm on remote**

Hit `GET /spaces/hierarchy` via the running web app (which talks to remote per CLAUDE.md's remote-vs-local note). Expected: tree loads with `child_count` field populated.

- [ ] **Step 4: Full-page smoke test against remote**

Against the running dev app:
1. Tree loads with a tenant's actual data.
2. Create a site → appears in tree.
3. Create a building under it → only `wing | floor | common_area` offered in type picker (correct constraint).
4. Try to move a floor under a room → rejected with toast: "floor cannot be a child of room".
5. Bulk-select two rooms and set reservable → both update.
6. Deep-link: refresh `/admin/locations/<id>` → detail loads with the right path expanded.

- [ ] **Step 5: Final commit (if any docs or fixes came out of smoke)**

```bash
git status
# if there's anything to commit:
git add -A
git commit -m "chore(spaces): post-smoke polish"
```

- [ ] **Step 6: Update the file map in CLAUDE.md if relevant**

Review: does the space hierarchy change need a doc update in `docs/assignments-routing-fulfillment.md` or `docs/visibility.md`? The answer is almost certainly no — this is purely about `spaces` taxonomy, not routing or visibility. Skip unless review turns up something.

---

## Self-Review

**Coverage check:**
- ✅ Two-pane explorer layout → Task 17.
- ✅ Virtualised tree with search + filter chips + flat mode → Tasks 11–12.
- ✅ `wing` type + DB parent rule + allowlist update → Task 1.
- ✅ Shared taxonomy between API and web → Task 2.
- ✅ Enriched hierarchy with `child_count` → Task 3.
- ✅ Move endpoint + bulk endpoint → Task 3.
- ✅ React Query data layer (no `useApi`) → Task 5.
- ✅ Parent-aware type picker → Task 7.
- ✅ Parent picker for Move + Create → Task 8.
- ✅ Shared create/edit form built on shadcn `Field` primitives → Task 9.
- ✅ URL-synced selection, path-auto-expand, keyboard nav → Tasks 10, 18.
- ✅ Breadcrumb with middle-truncation → Task 13.
- ✅ Inline-editable metadata strip → Task 14.
- ✅ Children table + bulk bar → Task 15.
- ✅ Activity-tab stub → Task 16.
- ✅ Root summary empty state → Task 16.
- ✅ Route `/admin/locations/:spaceId?` → Task 17.
- ✅ Accessibility: tree roles, arrow nav, ⌘K → Tasks 11, 18.
- ✅ Remote migration push with user confirmation → Task 19.

**Consistency check:** Types are consistent across tasks (`SpaceType`, `SpaceTreeNode`, `Space`). Parent-rule functions share one source of truth (`isValidSpaceParent` from `@prequest/shared`), mirrored in `public.is_valid_space_parent` in SQL. Helpers `flattenTree` / `findNode` / `pathTo` are defined once in `build-tree.ts` and reused by rail, detail, and parent picker.

**Scope check:** Out-of-scope items (floor plans, CSV, drag-to-reparent, activity feed beyond stub, realtime) are all deferred in the spec's "Deferred" section and not referenced in any task.
