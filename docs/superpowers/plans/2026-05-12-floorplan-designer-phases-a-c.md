# Floor Plan Designer (Phases A–C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the admin-facing floor plan designer (Figma-style authoring tool + draft/publish flow) on top of the existing `floor_plans` (00127) and `spaces.floor_plan_polygon` (00120) primitives. Output: admins can upload a floor image, trace polygons over rooms/desks/parking, save drafts, and atomically publish. Data lands in the canonical schema so the booking surface (Plan 2, Phases D–F) can consume it next.

**Architecture:** Three layers. (1) **Schema** — one new column on `spaces`, one new table `floor_plan_drafts`, one PL/pgSQL RPC for atomic publish, one column on `floor_plans` for labels, plus permission-catalog rows. All five migrations land in Phase A. (2) **Backend** — new NestJS `floor-plan` module with one service, one controller, four endpoints (GET/PATCH/DELETE drafts + POST publish), all writes routed through the `publish_floor_plan_draft` RPC per CLAUDE.md's "multi-step writes go through one PL/pgSQL function" rule. (3) **Frontend** — `<FloorPlanCanvas>` SVG renderer (used in `view` mode by the booking plan, in `edit` mode here), wrapped by `<FloorPlanDesigner>` which adds tool dock, left-rail spaces tree, and right-rail inspector. Tools are independent files implementing a common `Tool` interface; the canvas dispatches pointer events to the active tool.

**Tech Stack:** NestJS, TypeScript, Supabase Postgres + Storage + RLS, React 19, Vite, Tailwind v4, shadcn/ui (Field primitives mandatory), TanStack Query v5, Framer Motion, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-12-floorplan-designer-and-map-booking-design.md` (commit `4d6b120a`). Read it end-to-end before starting.

---

## Pre-flight

- [ ] **Step 0: Read the spec end-to-end**

Open `/Users/x/Desktop/XPQT/.claude/worktrees/floorplanner/docs/superpowers/specs/2026-05-12-floorplan-designer-and-map-booking-design.md`. The spec is the contract; this plan is the execution path. The numbered sections referenced below all live there.

- [ ] **Step 0b: Confirm baseline builds**

Run from the worktree root:
```bash
pnpm install
pnpm --filter @prequest/api build
pnpm --filter @prequest/web build
```
All must succeed. If anything fails, fix the baseline before starting Phase A.

- [ ] **Step 0c: Confirm latest migration is 00366**

```bash
ls supabase/migrations/ | tail -1
```
Expected: `00366_workflow_events_add_node_failed.sql`. If a newer migration has landed, bump every migration number in this plan by the delta (+1 or more) and update cross-references in the spec.

- [ ] **Step 0d: Existing files to read (do not edit yet)**

For orientation:
- `supabase/migrations/00120_spaces_room_booking_columns.sql` — where `floor_plan_polygon` was added
- `supabase/migrations/00127_floor_plans.sql` — existing `floor_plans` table
- `packages/shared/src/permission-catalog.ts` — permission registry (typed)
- `apps/api/src/modules/space/space.module.ts` — sibling module for shape reference
- `apps/web/src/components/ui/settings-page.tsx` — `SettingsPageShell` etc.
- `apps/web/src/components/ui/field.tsx` — shadcn Field primitives (mandatory for forms)
- `apps/web/src/lib/toast.ts` — toast helpers (mandatory wrapper)
- `apps/api/scripts/smoke-work-orders.mjs` — pattern for the new `smoke:floor-plans` script

---

# Phase A — Schema + Draft API

Goal: five migrations land on remote, TS permission catalog updates, new `floor-plan` API module ships with draft CRUD endpoints + tests + smoke gate. No frontend work in this phase. End state: API can store + fetch a floor plan draft, but nothing publishes yet.

### Task A.1: Migration 00367 — `spaces.floor_plan_render_hint`

**Files:**
- Create: `supabase/migrations/00367_spaces_floor_plan_render_hint.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00367_spaces_floor_plan_render_hint.sql
-- Optional per-polygon rendering override. Default lets the renderer decide
-- based on polygon area. 'seat' forces seat-circle rendering. 'parking' forces
-- the parking-slot glyph. Spec §3.2.

alter table public.spaces
  add column if not exists floor_plan_render_hint text not null default 'default'
    check (floor_plan_render_hint in ('default', 'seat', 'parking'));

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally**

```bash
pnpm db:reset
```
Expected: clean reset, no errors. `psql` query `\d public.spaces` shows the new column.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00367_spaces_floor_plan_render_hint.sql
git commit -m "feat(floor-plan): 00367 add floor_plan_render_hint to spaces"
```

### Task A.2: Migration 00368 — `floor_plan_drafts` table

**Files:**
- Create: `supabase/migrations/00368_floor_plan_drafts.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00368_floor_plan_drafts.sql
-- Per-floor in-progress edits. One draft per floor. Polygons stored as jsonb
-- so the booking surface keeps reading the published spaces.floor_plan_polygon
-- without ever seeing half-edited state. Spec §3.3.

create table if not exists public.floor_plan_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  floor_space_id uuid not null references public.spaces(id),
  image_url text,
  width_px int,
  height_px int,
  polygons jsonb not null default '[]'::jsonb,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (floor_space_id)
);

alter table public.floor_plan_drafts enable row level security;

drop policy if exists "tenant_isolation" on public.floor_plan_drafts;
create policy "tenant_isolation" on public.floor_plan_drafts
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create index if not exists idx_floor_plan_drafts_tenant
  on public.floor_plan_drafts (tenant_id);

create trigger set_floor_plan_drafts_updated_at
  before update on public.floor_plan_drafts
  for each row execute function public.set_updated_at();

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally + verify RLS**

```bash
pnpm db:reset
```
Then in psql confirm: `select policyname from pg_policies where tablename = 'floor_plan_drafts';` returns `tenant_isolation`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00368_floor_plan_drafts.sql
git commit -m "feat(floor-plan): 00368 floor_plan_drafts table with RLS"
```

### Task A.3: Migration 00369 — `publish_floor_plan_draft` RPC

**Files:**
- Create: `supabase/migrations/00369_publish_floor_plan_draft_rpc.sql`

- [ ] **Step 1: Write the migration**

Copy the full RPC body from spec §6.2 (the entire `create or replace function …` block) into this file. Wrap it with the standard NOTIFY at the bottom:

```sql
-- 00369_publish_floor_plan_draft_rpc.sql
-- Atomic publish flow per CLAUDE.md: any multi-table write with cross-table
-- invariants goes through one PL/pgSQL function. Spec §6.2.

create or replace function public.publish_floor_plan_draft(p_draft_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft public.floor_plan_drafts%rowtype;
  v_tenant_id uuid;
  v_floor_id uuid;
  v_polygon jsonb;
  v_space_ids uuid[];
begin
  select * into v_draft from public.floor_plan_drafts where id = p_draft_id;
  if v_draft.id is null then
    raise exception 'floor_plan_drafts.not_found' using errcode = 'P0002';
  end if;

  v_tenant_id := v_draft.tenant_id;
  v_floor_id  := v_draft.floor_space_id;

  if v_tenant_id <> public.current_tenant_id() then
    raise exception 'floor_plan_drafts.cross_tenant' using errcode = '42501';
  end if;

  insert into public.floor_plans (tenant_id, space_id, image_url, width_px, height_px, labels)
  values (v_tenant_id, v_floor_id, v_draft.image_url, v_draft.width_px, v_draft.height_px,
          coalesce(v_draft.labels, '[]'::jsonb))
  on conflict (space_id) do update
    set image_url  = excluded.image_url,
        width_px   = excluded.width_px,
        height_px  = excluded.height_px,
        labels     = excluded.labels,
        updated_at = now();

  select coalesce(array_agg((p->>'space_id')::uuid), '{}'::uuid[])
    into v_space_ids
    from jsonb_array_elements(v_draft.polygons) p;

  update public.spaces
     set floor_plan_polygon = null,
         floor_plan_render_hint = 'default'
   where tenant_id = v_tenant_id
     and parent_id = v_floor_id
     and floor_plan_polygon is not null
     and id <> all(v_space_ids);

  for v_polygon in select jsonb_array_elements(v_draft.polygons) loop
    update public.spaces
       set floor_plan_polygon     = v_polygon->'points',
           floor_plan_render_hint = coalesce(v_polygon->>'render_hint', 'default')
     where id = (v_polygon->>'space_id')::uuid
       and tenant_id = v_tenant_id
       and parent_id = v_floor_id;
  end loop;

  insert into public.audit_events (tenant_id, kind, payload, created_by)
  values (v_tenant_id, 'floor_plan.published',
          jsonb_build_object('floor_space_id', v_floor_id, 'draft_id', p_draft_id),
          v_draft.created_by);

  delete from public.floor_plan_drafts where id = p_draft_id;
end;
$$;

revoke all on function public.publish_floor_plan_draft(uuid) from public;
grant execute on function public.publish_floor_plan_draft(uuid) to authenticated;

notify pgrst, 'reload schema';
```

Note: this depends on `floor_plans.labels` (added in A.4 next). Migrations are applied in order, so the RPC won't run until A.4 lands — but in our order, A.3 ships before A.4 and the RPC body references `labels` which doesn't yet exist. **Reorder:** create A.4's labels migration as 00369 and the RPC as 00370. Reflect this in step 2.

- [ ] **Step 2: Renumber if needed**

Before committing, verify the labels migration (next task A.4) is numbered earlier than the RPC. Final numbering after this reorder:
- 00367: render_hint (A.1) ✔
- 00368: floor_plan_drafts (A.2) ✔
- 00369: labels (A.4 → renamed 00369)
- 00370: publish RPC (this task → renamed 00370)
- 00371: permissions (A.5 → still 00371)

Rename this file to `00370_publish_floor_plan_draft_rpc.sql`.

- [ ] **Step 3: Commit (after A.4 file lands as 00369)**

Defer the commit of this RPC migration until after Task A.4 commits. See Task A.4 for the labels migration, then come back and commit this one with:

```bash
git add supabase/migrations/00370_publish_floor_plan_draft_rpc.sql
git commit -m "feat(floor-plan): 00370 publish_floor_plan_draft RPC"
```

### Task A.4: Migration 00369 — `labels` jsonb on `floor_plans` + `floor_plan_drafts`

**Files:**
- Create: `supabase/migrations/00369_floor_plans_and_drafts_labels.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00369_floor_plans_and_drafts_labels.sql
-- Non-polygon annotations placed on the canvas (e.g. "Lounge", "Reception").
-- Shape: [{ "text": "Lounge", "x": 690, "y": 250, "size": 11 }]. Spec §5.6.

alter table public.floor_plans
  add column if not exists labels jsonb not null default '[]'::jsonb;

alter table public.floor_plan_drafts
  add column if not exists labels jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally**

```bash
pnpm db:reset
```
Expected: all four migrations (00367–00369) apply cleanly. RPC migration (00370) is not yet committed; it lands next.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00369_floor_plans_and_drafts_labels.sql
git commit -m "feat(floor-plan): 00369 add labels jsonb to floor_plans and drafts"
```

- [ ] **Step 4: Commit the RPC migration from A.3**

Now that `floor_plans.labels` exists, commit the RPC migration that references it (renamed to 00370 in A.3, step 2):

```bash
pnpm db:reset
git add supabase/migrations/00370_publish_floor_plan_draft_rpc.sql
git commit -m "feat(floor-plan): 00370 publish_floor_plan_draft RPC"
```

### Task A.5: Migration 00371 — permission catalog rows

**Files:**
- Create: `supabase/migrations/00371_floor_plans_permissions_catalog.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00371_floor_plans_permissions_catalog.sql
-- Register new permission keys in the catalog table. The TS source of truth
-- (packages/shared/src/permission-catalog.ts) is updated in the same PR via A.6.

insert into public.permission_catalog (key, description, category, created_at)
values
  ('floor_plans.author',  'Open the floor plan designer and edit drafts', 'floor_plans', now()),
  ('floor_plans.publish', 'Publish a floor plan draft',                    'floor_plans', now()),
  ('floor_plans.delete',  'Delete a published floor plan',                  'floor_plans', now())
on conflict (key) do nothing;

notify pgrst, 'reload schema';
```

If `permission_catalog` table doesn't carry `category` or `description` columns, drop those values to match the existing schema. Run `\d public.permission_catalog` in psql to confirm before writing the INSERT.

- [ ] **Step 2: Apply locally + verify**

```bash
pnpm db:reset
```
Then:
```bash
psql "$DATABASE_URL_LOCAL" -c "select key from public.permission_catalog where key like 'floor_plans.%' order by key;"
```
Expected: three rows: `floor_plans.author`, `floor_plans.delete`, `floor_plans.publish`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00371_floor_plans_permissions_catalog.sql
git commit -m "feat(floor-plan): 00371 register floor_plans.* permissions"
```

### Task A.6: TS permission catalog source of truth

**Files:**
- Modify: `packages/shared/src/permission-catalog.ts`
- Modify: `packages/shared/src/permission-role-defaults.ts`

- [ ] **Step 1: Find current shape**

```bash
grep -n "rooms.admin" packages/shared/src/permission-catalog.ts
grep -n "Workplace Admin" packages/shared/src/permission-role-defaults.ts
```
Copy the pattern used by `rooms.admin` (an existing module-scoped key). The catalog file should already have a typed array or record of all keys.

- [ ] **Step 2: Add the three keys**

In `permission-catalog.ts`, add three entries matching the existing pattern. Example assuming a `const PERMISSIONS = { ... } as const` shape:

```ts
'floor_plans.author':  { description: 'Open the floor plan designer and edit drafts', category: 'floor_plans' },
'floor_plans.publish': { description: 'Publish a floor plan draft',                   category: 'floor_plans' },
'floor_plans.delete':  { description: 'Delete a published floor plan',                category: 'floor_plans' },
```

Mirror in `permission-role-defaults.ts`:
- Workplace Admin role: add `'floor_plans.author'`, `'floor_plans.publish'`, `'floor_plans.delete'`
- Locations Admin role (if present): add `'floor_plans.author'`, `'floor_plans.publish'` only

- [ ] **Step 3: Run the 8-test CI gate**

```bash
pnpm --filter @prequest/shared test
```
Expected: all permission catalog enforcement tests pass. Specifically the orphan-key test must show no orphans.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/permission-catalog.ts packages/shared/src/permission-role-defaults.ts
git commit -m "feat(floor-plan): register floor_plans.* in TS permission catalog"
```

### Task A.7: Push migrations to remote

**Files:** none

- [ ] **Step 1: Push migrations to remote (standing auth for this workstream)**

Per CLAUDE.md, prefer `pnpm db:push`. Fallback to psql against the remote connection string if the CLI auth is broken (per memory `supabase_remote_push`). Try first:

```bash
pnpm db:push
```

If that fails, fall back:
```bash
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00367_spaces_floor_plan_render_hint.sql
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00368_floor_plan_drafts.sql
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00369_floor_plans_and_drafts_labels.sql
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00370_publish_floor_plan_draft_rpc.sql
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00371_floor_plans_permissions_catalog.sql
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "notify pgrst, 'reload schema';"
```

- [ ] **Step 2: Verify on remote**

```bash
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "select key from public.permission_catalog where key like 'floor_plans.%' order by key;"
```
Expected: three rows.

```bash
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "select proname from pg_proc where proname = 'publish_floor_plan_draft';"
```
Expected: one row.

- [ ] **Step 3: Save the new memory entry**

Add to auto-memory a new file `feedback_db_push_floor_plan.md` mirroring the existing `feedback_db_push_booking_modal` entry. Note the workstream name and date. Add a line to `MEMORY.md`.

### Task A.8: Backend module skeleton

**Files:**
- Create: `apps/api/src/modules/floor-plan/floor-plan.module.ts`
- Create: `apps/api/src/modules/floor-plan/floor-plan.controller.ts`
- Create: `apps/api/src/modules/floor-plan/floor-plan.service.ts`
- Create: `apps/api/src/modules/floor-plan/floor-plan-draft.service.ts`
- Create: `apps/api/src/modules/floor-plan/dto/get-draft.dto.ts`
- Create: `apps/api/src/modules/floor-plan/dto/update-draft.dto.ts`
- Create: `apps/api/src/modules/floor-plan/dto/polygon.dto.ts`
- Modify: `apps/api/src/app.module.ts` (register FloorPlanModule)

- [ ] **Step 1: Module file**

```ts
// apps/api/src/modules/floor-plan/floor-plan.module.ts
import { Module } from '@nestjs/common';
import { FloorPlanController } from './floor-plan.controller';
import { FloorPlanService } from './floor-plan.service';
import { FloorPlanDraftService } from './floor-plan-draft.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [FloorPlanController],
  providers: [FloorPlanService, FloorPlanDraftService],
  exports: [FloorPlanService],
})
export class FloorPlanModule {}
```

If the codebase uses different imports for Supabase/Auth, mirror the imports in a sibling module like `apps/api/src/modules/space/space.module.ts`.

- [ ] **Step 2: DTOs**

```ts
// apps/api/src/modules/floor-plan/dto/polygon.dto.ts
import { z } from 'zod';

export const PolygonPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const PolygonSchema = z.object({
  space_id: z.string().uuid(),
  points: z.array(PolygonPointSchema).min(3).max(200),
  render_hint: z.enum(['default', 'seat', 'parking']).optional(),
});

export type Polygon = z.infer<typeof PolygonSchema>;
```

```ts
// apps/api/src/modules/floor-plan/dto/update-draft.dto.ts
import { z } from 'zod';
import { PolygonSchema } from './polygon.dto';

export const LabelSchema = z.object({
  text: z.string().min(1).max(60),
  x: z.number().finite(),
  y: z.number().finite(),
  size: z.number().int().min(8).max(48).optional(),
});

export const UpdateDraftSchema = z.object({
  image_url: z.string().url().nullable().optional(),
  width_px: z.number().int().positive().max(8192).nullable().optional(),
  height_px: z.number().int().positive().max(8192).nullable().optional(),
  polygons: z.array(PolygonSchema).max(2000).optional(),
  labels: z.array(LabelSchema).max(200).optional(),
});

export type UpdateDraftDto = z.infer<typeof UpdateDraftSchema>;
```

```ts
// apps/api/src/modules/floor-plan/dto/get-draft.dto.ts
export type DraftResponse = {
  id: string;
  tenant_id: string;
  floor_space_id: string;
  image_url: string | null;
  width_px: number | null;
  height_px: number | null;
  polygons: unknown[];
  labels: unknown[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};
```

- [ ] **Step 3: Draft service**

```ts
// apps/api/src/modules/floor-plan/floor-plan-draft.service.ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppErrors, throwZodError } from '../../common/errors/app-error';
import { UpdateDraftSchema, UpdateDraftDto } from './dto/update-draft.dto';
import type { DraftResponse } from './dto/get-draft.dto';

@Injectable()
export class FloorPlanDraftService {
  constructor(private readonly supabase: SupabaseService) {}

  async getOrCreate(floorSpaceId: string, userId: string): Promise<DraftResponse> {
    const client = this.supabase.client();
    const { data: existing } = await client
      .from('floor_plan_drafts')
      .select('*')
      .eq('floor_space_id', floorSpaceId)
      .maybeSingle();

    if (existing) return existing as DraftResponse;

    // Seed from published state
    const { data: floor } = await client
      .from('floor_plans')
      .select('image_url, width_px, height_px, labels')
      .eq('space_id', floorSpaceId)
      .maybeSingle();

    const { data: spaces } = await client
      .from('spaces')
      .select('id, floor_plan_polygon, floor_plan_render_hint')
      .eq('parent_id', floorSpaceId)
      .not('floor_plan_polygon', 'is', null);

    const seedPolygons = (spaces ?? []).map((s) => ({
      space_id: s.id,
      points: (s.floor_plan_polygon as { points?: unknown[] })?.points ?? s.floor_plan_polygon,
      render_hint: s.floor_plan_render_hint ?? 'default',
    }));

    const { data: created, error } = await client
      .from('floor_plan_drafts')
      .insert({
        floor_space_id: floorSpaceId,
        image_url: floor?.image_url ?? null,
        width_px: floor?.width_px ?? null,
        height_px: floor?.height_px ?? null,
        polygons: seedPolygons,
        labels: floor?.labels ?? [],
        created_by: userId,
      })
      .select('*')
      .single();

    if (error || !created) throw AppErrors.server('floor_plan.draft.create_failed');
    return created as DraftResponse;
  }

  async update(floorSpaceId: string, body: unknown): Promise<DraftResponse> {
    const parsed = UpdateDraftSchema.safeParse(body);
    if (!parsed.success) throwZodError(parsed.error);

    const client = this.supabase.client();
    const { data, error } = await client
      .from('floor_plan_drafts')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('floor_space_id', floorSpaceId)
      .select('*')
      .single();

    if (error) throw AppErrors.server('floor_plan.draft.update_failed');
    if (!data) throw AppErrors.notFoundWithCode('floor_plan.draft.not_found');
    return data as DraftResponse;
  }

  async takeOver(floorSpaceId: string, userId: string): Promise<DraftResponse> {
    const client = this.supabase.client();
    const { data, error } = await client
      .from('floor_plan_drafts')
      .update({ created_by: userId, updated_at: new Date().toISOString() })
      .eq('floor_space_id', floorSpaceId)
      .select('*')
      .single();
    if (error || !data) throw AppErrors.server('floor_plan.draft.takeover_failed');
    return data as DraftResponse;
  }

  async discard(floorSpaceId: string): Promise<void> {
    const client = this.supabase.client();
    const { error } = await client
      .from('floor_plan_drafts')
      .delete()
      .eq('floor_space_id', floorSpaceId);
    if (error) throw AppErrors.server('floor_plan.draft.discard_failed');
  }
}
```

If `throwZodError` / `AppErrors.notFoundWithCode` / `AppErrors.server` don't exist with those exact names, match the existing pattern from `apps/api/src/common/errors/app-error.ts`.

- [ ] **Step 4: FloorPlanService (read side + publish wrapper)**

```ts
// apps/api/src/modules/floor-plan/floor-plan.service.ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppErrors } from '../../common/errors/app-error';

@Injectable()
export class FloorPlanService {
  constructor(private readonly supabase: SupabaseService) {}

  async getPublished(floorSpaceId: string) {
    const client = this.supabase.client();
    const { data: floor } = await client
      .from('floor_plans')
      .select('*')
      .eq('space_id', floorSpaceId)
      .maybeSingle();

    if (!floor) return null;

    const { data: spaces } = await client
      .from('spaces')
      .select('id, name, type, capacity, amenities, floor_plan_polygon, floor_plan_render_hint')
      .eq('parent_id', floorSpaceId)
      .not('floor_plan_polygon', 'is', null);

    return { floor, spaces: spaces ?? [] };
  }

  async publish(floorSpaceId: string, userId: string): Promise<void> {
    const client = this.supabase.client();
    const { data: draft } = await client
      .from('floor_plan_drafts')
      .select('id')
      .eq('floor_space_id', floorSpaceId)
      .maybeSingle();
    if (!draft) throw AppErrors.notFoundWithCode('floor_plan.draft.not_found');
    const { error } = await client.rpc('publish_floor_plan_draft', { p_draft_id: draft.id });
    if (error) throw AppErrors.server('floor_plan.publish_failed');
  }
}
```

- [ ] **Step 5: Controller**

```ts
// apps/api/src/modules/floor-plan/floor-plan.controller.ts
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionGuard, RequirePermission } from '../auth/permission.guard';
import { FloorPlanService } from './floor-plan.service';
import { FloorPlanDraftService } from './floor-plan-draft.service';

@UseGuards(AuthGuard)
@Controller('floors/:floorSpaceId/plan')
export class FloorPlanController {
  constructor(
    private readonly plan: FloorPlanService,
    private readonly draft: FloorPlanDraftService,
  ) {}

  @Get()
  async getPublished(@Param('floorSpaceId') id: string) {
    return this.plan.getPublished(id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.author')
  @Get('draft')
  async getDraft(@Param('floorSpaceId') id: string, @Req() req: { user: { id: string } }) {
    return this.draft.getOrCreate(id, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.author')
  @Patch('draft')
  async updateDraft(@Param('floorSpaceId') id: string, @Body() body: unknown) {
    return this.draft.update(id, body);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.author')
  @Post('draft/take-over')
  async takeOver(@Param('floorSpaceId') id: string, @Req() req: { user: { id: string } }) {
    return this.draft.takeOver(id, req.user.id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.author')
  @Delete('draft')
  async discardDraft(@Param('floorSpaceId') id: string) {
    await this.draft.discard(id);
    return { ok: true };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.publish')
  @Post('draft/publish')
  async publish(@Param('floorSpaceId') id: string, @Req() req: { user: { id: string } }) {
    await this.plan.publish(id, req.user.id);
    return { ok: true };
  }
}
```

If `PermissionGuard` / `RequirePermission` decorator names differ, match the existing pattern from a controller that already gates by permission (search: `grep -rn "RequirePermission" apps/api/src`).

- [ ] **Step 6: Register module**

In `apps/api/src/app.module.ts`, add `FloorPlanModule` to the `imports` array.

- [ ] **Step 7: Build + smoke**

```bash
pnpm --filter @prequest/api build
```
Expected: clean build.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/floor-plan apps/api/src/app.module.ts
git commit -m "feat(floor-plan): backend module skeleton + draft CRUD + publish endpoint"
```

### Task A.9: Cross-tenant + RLS spec tests

**Files:**
- Create: `apps/api/src/modules/floor-plan/floor-plan.service.spec.ts`
- Create: `apps/api/src/modules/floor-plan/floor-plan-draft.service.spec.ts`
- Modify: `apps/api/src/modules/cross-tenant-fk-leak-writes.spec.ts`

- [ ] **Step 1: Service spec — happy path**

```ts
// apps/api/src/modules/floor-plan/floor-plan-draft.service.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { FloorPlanDraftService } from './floor-plan-draft.service';
import { createTestSupabase, seedTenant, seedFloor } from '../../test-utils/supabase-test-helpers';

describe('FloorPlanDraftService', () => {
  let supabase: ReturnType<typeof createTestSupabase>;
  let service: FloorPlanDraftService;
  let tenantId: string;
  let floorId: string;
  let userId: string;

  beforeEach(async () => {
    supabase = createTestSupabase();
    service = new FloorPlanDraftService(supabase);
    ({ tenantId, userId } = await seedTenant(supabase));
    floorId = await seedFloor(supabase, tenantId);
  });

  it('creates a draft on first call', async () => {
    const draft = await service.getOrCreate(floorId, userId);
    expect(draft.floor_space_id).toBe(floorId);
    expect(draft.polygons).toEqual([]);
  });

  it('returns the existing draft on subsequent calls', async () => {
    const a = await service.getOrCreate(floorId, userId);
    const b = await service.getOrCreate(floorId, userId);
    expect(b.id).toBe(a.id);
  });

  it('updates polygons', async () => {
    await service.getOrCreate(floorId, userId);
    const updated = await service.update(floorId, {
      polygons: [{ space_id: floorId, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
    });
    expect(updated.polygons).toHaveLength(1);
  });

  it('rejects polygon with <3 points (zod)', async () => {
    await service.getOrCreate(floorId, userId);
    await expect(
      service.update(floorId, { polygons: [{ space_id: floorId, points: [{ x: 0, y: 0 }] }] }),
    ).rejects.toThrow();
  });
});
```

Replace the test-helper imports with whatever pattern this repo uses (search: `grep -rn "createTestSupabase\|test-utils" apps/api/src | head -10`). If no shared helpers exist, build a minimal one in this file.

- [ ] **Step 2: Cross-tenant test**

Add a test to `apps/api/src/modules/cross-tenant-fk-leak-writes.spec.ts` (or its sibling for reads) that:
1. Creates draft as tenant A.
2. Attempts to read/update/delete it as tenant B (sets a different `current_tenant_id`).
3. Expects 0 rows / RLS denial.

If the file already has a generated test loop over tables, add `floor_plan_drafts` to the list.

- [ ] **Step 3: Run tests**

```bash
pnpm --filter @prequest/api test floor-plan
pnpm --filter @prequest/api test cross-tenant
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/floor-plan/*.spec.ts apps/api/src/modules/cross-tenant-fk-leak-writes.spec.ts
git commit -m "test(floor-plan): draft service + cross-tenant RLS coverage"
```

### Task A.10: smoke:floor-plans script

**Files:**
- Create: `apps/api/scripts/smoke-floor-plans.mjs`
- Modify: `package.json` (root) — add `"smoke:floor-plans": "node apps/api/scripts/smoke-floor-plans.mjs"`

- [ ] **Step 1: Read the existing smoke pattern**

```bash
cat apps/api/scripts/smoke-work-orders.mjs | head -80
```
Note how it: mints an Admin JWT, hits the live API, asserts shape + exits non-zero on regression.

- [ ] **Step 2: Write the smoke script**

Mirror the work-orders pattern. Probes for floor-plans:
1. `GET /api/floors/:fakeFloor/plan` → expect 404 (not found) on a non-existent floor.
2. `POST /api/floors/:realFloor/plan/draft` via `GET` (creates draft) → 200 with draft.
3. `PATCH /api/floors/:realFloor/plan/draft` with one polygon → 200, polygon stored.
4. `POST /api/floors/:realFloor/plan/draft/publish` → 200, then `GET /api/floors/:realFloor/plan` → returns the polygon in `spaces[0].floor_plan_polygon`.
5. Validation probe: PATCH with polygon containing 1 point → 422.
6. Validation probe: PATCH with empty space_id → 422.
7. Cross-tenant probe: use tenant B token to read tenant A's draft → 404 (RLS hides it).
8. Permission probe: user without `floor_plans.publish` calls publish → 403.

Exit 0 on all-pass, exit 1 on any regression.

- [ ] **Step 3: Add script to root package.json**

- [ ] **Step 4: Run it**

```bash
# In another terminal: pnpm dev:api
pnpm smoke:floor-plans
```
Expected: exit 0, all probes pass.

- [ ] **Step 5: Commit + document**

Add a section to `CLAUDE.md` ("Smoke gate") describing `smoke:floor-plans` mirroring the existing work-orders smoke gate language. Then:

```bash
git add apps/api/scripts/smoke-floor-plans.mjs package.json CLAUDE.md
git commit -m "test(floor-plan): smoke harness with 8 probes (mandatory before claim-done)"
```

**Phase A done.** Backend draft CRUD + publish RPC works end-to-end against the real DB. No frontend yet. Tests + smoke green.

---

# Phase B — Designer Canvas

Goal: ship the admin-facing designer at `/admin/floor-plans/:floorSpaceId`. End state: admin can upload an image, draw polygons with all 7 tools, autosave to the draft, see issues in the left rail. Publishing still hits a TODO endpoint — the publish dialog is wired in Phase C.

### Task B.1: React Query keys + hooks

**Files:**
- Create: `apps/web/src/api/floor-plans/keys.ts`
- Create: `apps/web/src/api/floor-plans/hooks.ts`
- Create: `apps/web/src/api/floor-plans/types.ts`

- [ ] **Step 1: Types**

```ts
// apps/web/src/api/floor-plans/types.ts
export type Point = { x: number; y: number };
export type RenderHint = 'default' | 'seat' | 'parking';
export type Polygon = { space_id: string; points: Point[]; render_hint?: RenderHint };
export type Label = { text: string; x: number; y: number; size?: number };

export type DraftResponse = {
  id: string;
  tenant_id: string;
  floor_space_id: string;
  image_url: string | null;
  width_px: number | null;
  height_px: number | null;
  polygons: Polygon[];
  labels: Label[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PublishedFloorPlan = {
  floor: {
    space_id: string;
    image_url: string;
    width_px: number;
    height_px: number;
    labels: Label[];
  };
  spaces: Array<{
    id: string;
    name: string;
    type: string;
    capacity: number | null;
    amenities: string[];
    floor_plan_polygon: { points: Point[] } | Point[];
    floor_plan_render_hint: RenderHint;
  }>;
};
```

- [ ] **Step 2: Keys**

```ts
// apps/web/src/api/floor-plans/keys.ts
export const floorPlanKeys = {
  all: ['floor-plans'] as const,
  floor: (floorSpaceId: string) =>
    [...floorPlanKeys.all, 'floor', floorSpaceId] as const,
  floorDraft: (floorSpaceId: string) =>
    [...floorPlanKeys.floor(floorSpaceId), 'draft'] as const,
  floorPublished: (floorSpaceId: string) =>
    [...floorPlanKeys.floor(floorSpaceId), 'published'] as const,
};
```

- [ ] **Step 3: Hooks**

```ts
// apps/web/src/api/floor-plans/hooks.ts
import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api-fetch';
import { withErrorHandling, handleMutationError } from '../../lib/errors';
import { floorPlanKeys } from './keys';
import type { DraftResponse, PublishedFloorPlan } from './types';
import { usePageQuery } from '../../lib/use-page-query';

export function floorPlanPublishedOptions(floorSpaceId: string) {
  return queryOptions({
    queryKey: floorPlanKeys.floorPublished(floorSpaceId),
    queryFn: async () => apiFetch<PublishedFloorPlan | null>(`/api/floors/${floorSpaceId}/plan`),
    staleTime: 5 * 60_000,
  });
}

export function useFloorPlanPublished(floorSpaceId: string) {
  return usePageQuery(floorPlanPublishedOptions(floorSpaceId));
}

export function useFloorPlanDraft(floorSpaceId: string) {
  return useQuery({
    queryKey: floorPlanKeys.floorDraft(floorSpaceId),
    queryFn: async () => apiFetch<DraftResponse>(`/api/floors/${floorSpaceId}/plan/draft`),
    staleTime: 0,
  });
}

export function useUpdateDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<DraftResponse>) =>
      apiFetch<DraftResponse>(`/api/floors/${floorSpaceId}/plan/draft`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    ...withErrorHandling({ actionTitle: "Couldn't save floor plan changes" }),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: floorPlanKeys.floorDraft(floorSpaceId) });
      const previous = qc.getQueryData<DraftResponse>(floorPlanKeys.floorDraft(floorSpaceId));
      if (previous) {
        qc.setQueryData<DraftResponse>(floorPlanKeys.floorDraft(floorSpaceId), {
          ...previous,
          ...patch,
        });
      }
      return { previous };
    },
    onError: (error, _patch, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(floorPlanKeys.floorDraft(floorSpaceId), ctx.previous);
      }
      handleMutationError(error, { actionTitle: "Couldn't save floor plan changes" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: floorPlanKeys.floorDraft(floorSpaceId) });
    },
  });
}

export function useTakeOverDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiFetch<DraftResponse>(`/api/floors/${floorSpaceId}/plan/draft/take-over`, {
        method: 'POST',
      }),
    onSuccess: (data) => qc.setQueryData(floorPlanKeys.floorDraft(floorSpaceId), data),
    ...withErrorHandling({ actionTitle: "Couldn't take over the draft" }),
  });
}

export function useDiscardDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiFetch(`/api/floors/${floorSpaceId}/plan/draft`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: floorPlanKeys.floorDraft(floorSpaceId) });
    },
    ...withErrorHandling({ actionTitle: "Couldn't discard the draft" }),
  });
}

export function usePublishDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiFetch(`/api/floors/${floorSpaceId}/plan/draft/publish`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: floorPlanKeys.floor(floorSpaceId) });
    },
    ...withErrorHandling({ actionTitle: "Couldn't publish the floor plan" }),
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/floor-plans
git commit -m "feat(floor-plan): React Query keys + hooks for plan/draft"
```

### Task B.2: `<FloorPlanCanvas>` view-only renderer

**Files:**
- Create: `apps/web/src/components/floor-plan/floor-plan-canvas.tsx`
- Create: `apps/web/src/components/floor-plan/polygon-shape.tsx`
- Create: `apps/web/src/components/floor-plan/lib/polygon-geometry.ts`
- Create: `apps/web/src/components/floor-plan/lib/availability-state.ts`
- Create: `apps/web/src/components/floor-plan/__tests__/polygon-geometry.test.ts`

- [ ] **Step 1: Geometry helpers + test**

```ts
// apps/web/src/components/floor-plan/lib/polygon-geometry.ts
import type { Point } from '../../../api/floor-plans/types';

export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

export function polygonCentroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  }
  const factor = 1 / (3 * twiceArea);
  return { x: x * factor, y: y * factor };
}

export function polygonToSvgPath(points: Point[]): string {
  if (!points.length) return '';
  return `M ${points[0].x} ${points[0].y} ` +
    points.slice(1).map((p) => `L ${p.x} ${p.y}`).join(' ') + ' Z';
}
```

```ts
// apps/web/src/components/floor-plan/__tests__/polygon-geometry.test.ts
import { describe, it, expect } from 'vitest';
import { polygonArea, polygonCentroid, polygonToSvgPath } from '../lib/polygon-geometry';

describe('polygon geometry', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];

  it('computes square area', () => expect(polygonArea(square)).toBe(100));

  it('computes square centroid', () => {
    const c = polygonCentroid(square);
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(5);
  });

  it('serializes to svg path', () =>
    expect(polygonToSvgPath(square)).toBe('M 0 0 L 10 0 L 10 10 L 0 10 Z'));
});
```

- [ ] **Step 2: Availability state machine**

```ts
// apps/web/src/components/floor-plan/lib/availability-state.ts
export type AvailabilityState =
  | 'available'
  | 'partial'
  | 'booked'
  | 'mine'
  | 'pending'
  | 'not_bookable';

export const STATE_PALETTE: Record<AvailabilityState, { outline: string; fill: string; dot: string }> = {
  available:    { outline: '#86efac', fill: '#f0fdf4', dot: '#22c55e' },
  partial:      { outline: '#fcd34d', fill: 'url(#partial-stripes)', dot: '#84cc16' },
  booked:       { outline: '#fca5a5', fill: '#fef2f2', dot: '#ef4444' },
  mine:         { outline: '#60a5fa', fill: '#eff6ff', dot: '#3b82f6' },
  pending:      { outline: '#fcd34d', fill: '#fffbeb', dot: '#f59e0b' },
  not_bookable: { outline: '#d6d3d1', fill: '#fafaf9', dot: '#d6d3d1' },
};
```

- [ ] **Step 3: PolygonShape component**

```tsx
// apps/web/src/components/floor-plan/polygon-shape.tsx
import { polygonArea, polygonCentroid, polygonToSvgPath } from './lib/polygon-geometry';
import { STATE_PALETTE, type AvailabilityState } from './lib/availability-state';
import type { Point, RenderHint } from '../../api/floor-plans/types';

const LABEL_AREA_THRESHOLD = 6000;

type Props = {
  spaceId: string;
  points: Point[];
  renderHint: RenderHint;
  name: string;
  capacity: number | null;
  state: AvailabilityState;
  selected?: boolean;
  onClick?: (spaceId: string) => void;
};

export function PolygonShape({ spaceId, points, renderHint, name, capacity, state, selected, onClick }: Props) {
  const palette = STATE_PALETTE[state];
  const area = polygonArea(points);
  const renderAsSeat = renderHint === 'seat' || (renderHint === 'default' && area < LABEL_AREA_THRESHOLD);
  const centroid = polygonCentroid(points);

  if (renderAsSeat) {
    return (
      <g
        role="button"
        tabIndex={0}
        aria-label={`${name}: ${state}`}
        onClick={() => onClick?.(spaceId)}
        onKeyDown={(e) => e.key === 'Enter' && onClick?.(spaceId)}
        style={{ cursor: 'pointer' }}
      >
        <circle
          cx={centroid.x}
          cy={centroid.y}
          r={11}
          fill={palette.fill}
          stroke={palette.outline}
          strokeWidth={selected ? 2 : 1.4}
        />
        <circle cx={centroid.x} cy={centroid.y} r={3.5} fill={palette.dot} />
      </g>
    );
  }

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${name}: ${state}, capacity ${capacity ?? 'unknown'}`}
      onClick={() => onClick?.(spaceId)}
      onKeyDown={(e) => e.key === 'Enter' && onClick?.(spaceId)}
      style={{ cursor: 'pointer' }}
    >
      <path
        d={polygonToSvgPath(points)}
        fill={palette.fill}
        stroke={palette.outline}
        strokeWidth={selected ? 2 : 1.5}
        rx={3}
      />
      <circle cx={points[0].x + 16} cy={points[0].y + 16} r={5} fill={palette.dot} />
      <text x={centroid.x} y={centroid.y} textAnchor="middle" fontSize={13} fontWeight={500} fill="#1c1917">
        {name}
      </text>
    </g>
  );
}
```

- [ ] **Step 4: Canvas (view mode)**

```tsx
// apps/web/src/components/floor-plan/floor-plan-canvas.tsx
import { useMemo } from 'react';
import { PolygonShape } from './polygon-shape';
import type { PublishedFloorPlan } from '../../api/floor-plans/types';
import type { AvailabilityState } from './lib/availability-state';

type SpaceState = { spaceId: string; state: AvailabilityState };

type Props = {
  plan: PublishedFloorPlan;
  states?: SpaceState[];
  selectedSpaceId?: string | null;
  onSpaceClick?: (spaceId: string) => void;
};

export function FloorPlanCanvas({ plan, states, selectedSpaceId, onSpaceClick }: Props) {
  const stateMap = useMemo(() => {
    const m = new Map<string, AvailabilityState>();
    states?.forEach((s) => m.set(s.spaceId, s.state));
    return m;
  }, [states]);

  return (
    <svg
      viewBox={`0 0 ${plan.floor.width_px} ${plan.floor.height_px}`}
      role="img"
      aria-label="Floor plan"
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <pattern id="partial-stripes" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
          <rect width="8" height="8" fill="#f0fdf4" />
          <line x1="0" y1="0" x2="0" y2="8" stroke="#fca5a5" strokeWidth="3.5" />
        </pattern>
      </defs>
      <image
        href={plan.floor.image_url}
        x="0"
        y="0"
        width={plan.floor.width_px}
        height={plan.floor.height_px}
        decoding="async"
      />
      {plan.spaces.map((s) => {
        const points = Array.isArray(s.floor_plan_polygon)
          ? s.floor_plan_polygon
          : s.floor_plan_polygon.points;
        return (
          <PolygonShape
            key={s.id}
            spaceId={s.id}
            points={points}
            renderHint={s.floor_plan_render_hint}
            name={s.name}
            capacity={s.capacity}
            state={stateMap.get(s.id) ?? 'not_bookable'}
            selected={selectedSpaceId === s.id}
            onClick={onSpaceClick}
          />
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 5: Run tests + build**

```bash
pnpm --filter @prequest/web test polygon-geometry
pnpm --filter @prequest/web build
```
Expected: tests pass, build green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/floor-plan
git commit -m "feat(floor-plan): FloorPlanCanvas + PolygonShape (view mode) + geometry tests"
```

### Task B.3: `<ZoomPanLayer>` with scroll/pinch/drag

**Files:**
- Create: `apps/web/src/components/floor-plan/zoom-pan-layer.tsx`
- Create: `apps/web/src/components/floor-plan/__tests__/zoom-pan-layer.test.tsx`

- [ ] **Step 1: Component**

```tsx
// apps/web/src/components/floor-plan/zoom-pan-layer.tsx
import { useRef, useState, useCallback, type ReactNode, type WheelEvent, type PointerEvent } from 'react';

type Props = { children: ReactNode; minScale?: number; maxScale?: number };

export function ZoomPanLayer({ children, minScale = 0.25, maxScale = 8 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [{ scale, tx, ty }, setTransform] = useState({ scale: 1, tx: 0, ty: 0 });
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const handleWheel = useCallback((e: WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const delta = -e.deltaY * 0.0012;
    setTransform((prev) => {
      const next = Math.min(maxScale, Math.max(minScale, prev.scale * (1 + delta)));
      const ratio = next / prev.scale;
      return {
        scale: next,
        tx: cursorX - (cursorX - prev.tx) * ratio,
        ty: cursorY - (cursorY - prev.ty) * ratio,
      };
    });
  }, [minScale, maxScale]);

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    setTransform((prev) => ({
      ...prev,
      tx: dragRef.current!.tx + (e.clientX - dragRef.current!.x),
      ty: dragRef.current!.ty + (e.clientY - dragRef.current!.y),
    }));
  };

  const handlePointerUp = () => { dragRef.current = null; };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{ width: '100%', height: '100%', overflow: 'hidden', cursor: dragRef.current ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <div style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, transformOrigin: '0 0', width: '100%', height: '100%' }}>
        {children}
      </div>
    </div>
  );
}
```

For pinch on touch screens, the basic implementation above uses Pointer Events which handles single-finger pan. If multi-touch pinch becomes needed, swap to `use-gesture` library (add as dep in a follow-up task).

- [ ] **Step 2: Smoke test**

```tsx
// apps/web/src/components/floor-plan/__tests__/zoom-pan-layer.test.tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ZoomPanLayer } from '../zoom-pan-layer';

describe('ZoomPanLayer', () => {
  it('renders children', () => {
    const { getByTestId } = render(<ZoomPanLayer><div data-testid="child" /></ZoomPanLayer>);
    expect(getByTestId('child')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan/zoom-pan-layer.tsx apps/web/src/components/floor-plan/__tests__/zoom-pan-layer.test.tsx
git commit -m "feat(floor-plan): ZoomPanLayer with scroll-to-cursor + drag-to-pan"
```

### Task B.4: `<FloorPlanDesigner>` shell + draft state hook

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx`
- Create: `apps/web/src/components/floor-plan-designer/use-designer-state.ts`
- Create: `apps/web/src/components/floor-plan-designer/types.ts`

- [ ] **Step 1: Types**

```ts
// apps/web/src/components/floor-plan-designer/types.ts
import type { Polygon, Label } from '../../api/floor-plans/types';

export type ToolKind = 'select' | 'draw-polygon' | 'draw-rectangle' | 'stamp-seat' | 'parking' | 'label' | 'image-upload';

export type DesignerState = {
  draftId: string;
  imageUrl: string | null;
  widthPx: number | null;
  heightPx: number | null;
  polygons: Polygon[];
  labels: Label[];
  selectedPolygonIndex: number | null;
  activeTool: ToolKind;
  inProgressPolygon: Polygon | null; // when drawing
};
```

- [ ] **Step 2: useDesignerState hook**

```ts
// apps/web/src/components/floor-plan-designer/use-designer-state.ts
import { useReducer, useEffect, useRef } from 'react';
import type { DesignerState, ToolKind } from './types';
import type { DraftResponse, Polygon, Label } from '../../api/floor-plans/types';
import { useUpdateDraft } from '../../api/floor-plans/hooks';

type Action =
  | { type: 'hydrate'; draft: DraftResponse }
  | { type: 'select-polygon'; index: number | null }
  | { type: 'set-tool'; tool: ToolKind }
  | { type: 'add-polygon'; polygon: Polygon }
  | { type: 'update-polygon'; index: number; patch: Partial<Polygon> }
  | { type: 'remove-polygon'; index: number }
  | { type: 'set-image'; imageUrl: string; widthPx: number; heightPx: number }
  | { type: 'start-drawing'; polygon: Polygon }
  | { type: 'commit-drawing' }
  | { type: 'cancel-drawing' };

function reducer(state: DesignerState, action: Action): DesignerState {
  switch (action.type) {
    case 'hydrate':
      return {
        draftId: action.draft.id,
        imageUrl: action.draft.image_url,
        widthPx: action.draft.width_px,
        heightPx: action.draft.height_px,
        polygons: action.draft.polygons,
        labels: action.draft.labels,
        selectedPolygonIndex: null,
        activeTool: 'select',
        inProgressPolygon: null,
      };
    case 'select-polygon': return { ...state, selectedPolygonIndex: action.index };
    case 'set-tool':       return { ...state, activeTool: action.tool, inProgressPolygon: null };
    case 'add-polygon':    return { ...state, polygons: [...state.polygons, action.polygon] };
    case 'update-polygon': return {
      ...state,
      polygons: state.polygons.map((p, i) => i === action.index ? { ...p, ...action.patch } : p),
    };
    case 'remove-polygon': return {
      ...state,
      polygons: state.polygons.filter((_, i) => i !== action.index),
      selectedPolygonIndex: state.selectedPolygonIndex === action.index ? null : state.selectedPolygonIndex,
    };
    case 'set-image':      return { ...state, imageUrl: action.imageUrl, widthPx: action.widthPx, heightPx: action.heightPx };
    case 'start-drawing':  return { ...state, inProgressPolygon: action.polygon };
    case 'commit-drawing': return state.inProgressPolygon
      ? { ...state, polygons: [...state.polygons, state.inProgressPolygon], inProgressPolygon: null }
      : state;
    case 'cancel-drawing': return { ...state, inProgressPolygon: null };
  }
}

const INITIAL: DesignerState = {
  draftId: '',
  imageUrl: null,
  widthPx: null,
  heightPx: null,
  polygons: [],
  labels: [],
  selectedPolygonIndex: null,
  activeTool: 'select',
  inProgressPolygon: null,
};

export function useDesignerState(floorSpaceId: string, draft: DraftResponse | undefined) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const updateDraft = useUpdateDraft(floorSpaceId);
  const lastSyncedRef = useRef<string>('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (draft && draft.id !== state.draftId) dispatch({ type: 'hydrate', draft });
  }, [draft, state.draftId]);

  useEffect(() => {
    if (!state.draftId) return;
    const snapshot = JSON.stringify({ polygons: state.polygons, labels: state.labels, imageUrl: state.imageUrl, widthPx: state.widthPx, heightPx: state.heightPx });
    if (snapshot === lastSyncedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      lastSyncedRef.current = snapshot;
      updateDraft.mutate({
        polygons: state.polygons,
        labels: state.labels,
        image_url: state.imageUrl,
        width_px: state.widthPx,
        height_px: state.heightPx,
      });
    }, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [state.polygons, state.labels, state.imageUrl, state.widthPx, state.heightPx, state.draftId, updateDraft]);

  return { state, dispatch, isSaving: updateDraft.isPending } as const;
}
```

- [ ] **Step 3: Designer shell**

```tsx
// apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx
import { useFloorPlanDraft } from '../../api/floor-plans/hooks';
import { useDesignerState } from './use-designer-state';
import { SpacesTree } from './spaces-tree';        // TASK B.5
import { ToolDock } from './tool-dock';            // TASK B.6
import { PolygonInspector } from './polygon-inspector'; // TASK B.7
import { DesignerCanvas } from './designer-canvas';     // TASK B.8

type Props = { floorSpaceId: string };

export function FloorPlanDesigner({ floorSpaceId }: Props) {
  const draft = useFloorPlanDraft(floorSpaceId);
  const { state, dispatch, isSaving } = useDesignerState(floorSpaceId, draft.data);

  if (draft.isLoading) return <div className="text-sm text-muted-foreground p-6">Loading…</div>;
  if (!draft.data) return <div className="text-sm text-muted-foreground p-6">No draft.</div>;

  return (
    <div className="grid grid-cols-[240px_1fr_244px] h-[calc(100vh-48px)] gap-0 bg-muted/30">
      <SpacesTree floorSpaceId={floorSpaceId} state={state} dispatch={dispatch} />
      <div className="relative flex flex-col">
        <ToolDock activeTool={state.activeTool} dispatch={dispatch} isSaving={isSaving} />
        <DesignerCanvas state={state} dispatch={dispatch} />
      </div>
      <PolygonInspector floorSpaceId={floorSpaceId} state={state} dispatch={dispatch} />
    </div>
  );
}
```

This shell imports four sub-components written in subsequent tasks. Until those tasks land, stub each one as a placeholder div so this file compiles in isolation:

```tsx
// Temporary stubs in floor-plan-designer.tsx until B.5–B.8 land:
// const SpacesTree = () => <div className="bg-background border-r" />;
// const ToolDock = () => <div className="bg-background border-b h-12" />;
// const PolygonInspector = () => <div className="bg-background border-l" />;
// const DesignerCanvas = () => <div className="bg-background flex-1" />;
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/floor-plan-designer
git commit -m "feat(floor-plan): FloorPlanDesigner shell + useDesignerState reducer + autosave"
```

### Task B.5: `<SpacesTree>` left rail

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/spaces-tree.tsx`

- [ ] **Step 1: Component**

```tsx
// apps/web/src/components/floor-plan-designer/spaces-tree.tsx
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api-fetch';
import type { DesignerState } from './types';

type Props = {
  floorSpaceId: string;
  state: DesignerState;
  dispatch: React.Dispatch<any>;
};

type ChildSpace = { id: string; name: string; type: string; capacity: number | null };

export function SpacesTree({ floorSpaceId, state, dispatch }: Props) {
  const children = useQuery({
    queryKey: ['spaces', 'children', floorSpaceId],
    queryFn: () => apiFetch<ChildSpace[]>(`/api/spaces/${floorSpaceId}/children`),
    staleTime: 60_000,
  });

  const drawnIds = new Set(state.polygons.map((p) => p.space_id));

  return (
    <div className="bg-background border-r border-border p-4 overflow-y-auto">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
        Spaces on this floor
      </div>
      {(children.data ?? []).map((s) => {
        const isDrawn = drawnIds.has(s.id);
        const polygonIndex = state.polygons.findIndex((p) => p.space_id === s.id);
        const isSelected = polygonIndex === state.selectedPolygonIndex;
        return (
          <button
            key={s.id}
            onClick={() => dispatch({ type: 'select-polygon', index: polygonIndex >= 0 ? polygonIndex : null })}
            className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm ${isSelected ? 'bg-muted' : 'hover:bg-muted/50'}`}
          >
            <span className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${isDrawn ? 'bg-emerald-400' : 'bg-muted-foreground/30'}`} />
              <span className={isDrawn ? 'text-foreground' : 'text-muted-foreground'}>{s.name}</span>
            </span>
            {s.capacity !== null && (
              <span className="tabular-nums text-xs text-muted-foreground">{s.capacity}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

If `/api/spaces/:id/children` doesn't exist yet, either add it as a thin endpoint on `SpaceController` (5 lines) or use an existing endpoint that lists child spaces. Spec assumes the simple route.

- [ ] **Step 2: Add the `/spaces/:id/children` endpoint if missing**

In `apps/api/src/modules/space/space.controller.ts`:

```ts
@Get(':id/children')
async listChildren(@Param('id') id: string) {
  return this.space.listChildren(id);
}
```

In `space.service.ts`:

```ts
async listChildren(parentId: string) {
  const { data } = await this.supabase.client()
    .from('spaces')
    .select('id, name, type, capacity, parent_id, tenant_id')
    .eq('parent_id', parentId)
    .order('name');
  return data ?? [];
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/spaces-tree.tsx apps/api/src/modules/space
git commit -m "feat(floor-plan): SpacesTree left rail + GET /spaces/:id/children"
```

### Task B.6: `<ToolDock>`

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/tool-dock.tsx`

- [ ] **Step 1: Component**

```tsx
// apps/web/src/components/floor-plan-designer/tool-dock.tsx
import type { ToolKind } from './types';

const TOOLS: { kind: ToolKind; label: string; shortcut: string; glyph: string }[] = [
  { kind: 'select',         label: 'Select',        shortcut: 'V', glyph: '⌖' },
  { kind: 'draw-polygon',   label: 'Draw polygon',  shortcut: 'P', glyph: '▱' },
  { kind: 'draw-rectangle', label: 'Rectangle',     shortcut: 'R', glyph: '▭' },
  { kind: 'stamp-seat',     label: 'Stamp seat',    shortcut: 'S', glyph: '●' },
  { kind: 'parking',        label: 'Parking slot',  shortcut: 'K', glyph: 'P' },
  { kind: 'label',          label: 'Label',         shortcut: 'T', glyph: 'T' },
  { kind: 'image-upload',   label: 'Image',         shortcut: 'I', glyph: '⎙' },
];

type Props = {
  activeTool: ToolKind;
  dispatch: React.Dispatch<any>;
  isSaving: boolean;
};

export function ToolDock({ activeTool, dispatch, isSaving }: Props) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-background px-3 py-2">
      <div className="flex gap-1">
        {TOOLS.map((t) => (
          <button
            key={t.kind}
            title={`${t.label} (${t.shortcut})`}
            onClick={() => dispatch({ type: 'set-tool', tool: t.kind })}
            className={`h-9 w-9 rounded-md text-sm ${activeTool === t.kind ? 'bg-foreground text-background' : 'hover:bg-muted'}`}
          >
            {t.glyph}
          </button>
        ))}
      </div>
      <div className="text-xs text-muted-foreground flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${isSaving ? 'bg-amber-400' : 'bg-emerald-400'}`} />
        {isSaving ? 'saving…' : 'saved'}
      </div>
    </div>
  );
}
```

Replace glyph characters with proper Lucide icons (`MousePointer`, `Pentagon`, `Square`, `Circle`, `CarFront`, `Type`, `Image`) before shipping — keep this skeleton minimal for now.

- [ ] **Step 2: Keyboard shortcuts**

In `floor-plan-designer.tsx`, add a `useEffect` listening on `window` for `keydown`:

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const map: Record<string, ToolKind> = { v: 'select', p: 'draw-polygon', r: 'draw-rectangle', s: 'stamp-seat', k: 'parking', t: 'label', i: 'image-upload' };
    const tool = map[e.key.toLowerCase()];
    if (tool) dispatch({ type: 'set-tool', tool });
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [dispatch]);
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/tool-dock.tsx apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx
git commit -m "feat(floor-plan): ToolDock with keyboard shortcuts + save status"
```

### Task B.7: `<PolygonInspector>`

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/polygon-inspector.tsx`

- [ ] **Step 1: Component using shadcn Field primitives**

```tsx
// apps/web/src/components/floor-plan-designer/polygon-inspector.tsx
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldSeparator } from '../ui/field';
import { Button } from '../ui/button';
import type { DesignerState } from './types';
import { polygonArea } from '../floor-plan/lib/polygon-geometry';
import { ConfirmDialog } from '../confirm-dialog';
import { useState } from 'react';

type Props = {
  floorSpaceId: string;
  state: DesignerState;
  dispatch: React.Dispatch<any>;
};

export function PolygonInspector({ state, dispatch }: Props) {
  const idx = state.selectedPolygonIndex;
  const polygon = idx === null ? null : state.polygons[idx];
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (polygon === null) {
    return (
      <div className="bg-background border-l border-border p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Selection</div>
        <p className="mt-3 text-sm text-muted-foreground">Click a polygon to edit its properties.</p>
      </div>
    );
  }

  return (
    <div className="bg-background border-l border-border p-4 overflow-y-auto">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">Selected polygon</div>
      <FieldGroup className="mt-4">
        <Field>
          <FieldLabel htmlFor="render-hint">Render as</FieldLabel>
          <div className="flex gap-1">
            {(['default', 'seat', 'parking'] as const).map((h) => (
              <button
                key={h}
                id={`render-hint-${h}`}
                onClick={() => dispatch({ type: 'update-polygon', index: idx!, patch: { render_hint: h } })}
                className={`px-3 py-1.5 text-xs rounded-md ${polygon.render_hint === h || (h === 'default' && !polygon.render_hint) ? 'bg-foreground text-background' : 'bg-muted hover:bg-muted/70'}`}
              >
                {h}
              </button>
            ))}
          </div>
        </Field>
        <FieldSeparator />
        <Field>
          <FieldLabel>Shape</FieldLabel>
          <div className="text-sm space-y-1">
            <div className="flex justify-between"><span>Vertices</span><span className="tabular-nums text-muted-foreground">{polygon.points.length}</span></div>
            <div className="flex justify-between"><span>Area</span><span className="tabular-nums text-muted-foreground">{polygonArea(polygon.points).toFixed(0)} px²</span></div>
          </div>
        </Field>
      </FieldGroup>
      <FieldSeparator />
      <Button variant="ghost" className="mt-4 text-destructive" onClick={() => setConfirmOpen(true)}>
        Detach from floor plan
      </Button>
      <FieldDescription className="mt-1">Polygon only — space record stays.</FieldDescription>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Detach polygon?"
        description="The polygon will be removed from this floor plan. The space record stays."
        confirmLabel="Detach"
        destructive
        onConfirm={() => dispatch({ type: 'remove-polygon', index: idx! })}
      />
    </div>
  );
}
```

If shadcn `Field` exports don't include `FieldSeparator` exactly, match the actual filename. Search: `grep "export" apps/web/src/components/ui/field.tsx`.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/polygon-inspector.tsx
git commit -m "feat(floor-plan): PolygonInspector right rail using shadcn Field primitives"
```

### Task B.8: `<DesignerCanvas>` with tool dispatch

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/designer-canvas.tsx`
- Create: `apps/web/src/components/floor-plan-designer/tools/select-tool.ts`
- Create: `apps/web/src/components/floor-plan-designer/tools/draw-polygon-tool.ts`
- Create: `apps/web/src/components/floor-plan-designer/tools/draw-rectangle-tool.ts`
- Create: `apps/web/src/components/floor-plan-designer/tools/stamp-seat-tool.ts`

- [ ] **Step 1: Tool interface**

```ts
// apps/web/src/components/floor-plan-designer/tools/tool.ts
import type { DesignerState } from '../types';

export type ToolContext = {
  state: DesignerState;
  dispatch: React.Dispatch<any>;
  worldX: number;
  worldY: number;
};

export interface Tool {
  onPointerDown?(ctx: ToolContext): void;
  onPointerMove?(ctx: ToolContext): void;
  onPointerUp?(ctx: ToolContext): void;
  onKeyDown?(ctx: ToolContext & { key: string }): void;
}
```

- [ ] **Step 2: Tools**

```ts
// apps/web/src/components/floor-plan-designer/tools/select-tool.ts
import type { Tool } from './tool';
export const selectTool: Tool = {
  onPointerDown({ state, dispatch, worldX, worldY }) {
    // hit-test handled by individual polygon onClick; this tool only deselects on canvas click
    dispatch({ type: 'select-polygon', index: null });
  },
};
```

```ts
// apps/web/src/components/floor-plan-designer/tools/draw-polygon-tool.ts
import type { Tool } from './tool';
import type { Polygon } from '../../../api/floor-plans/types';

export const drawPolygonTool: Tool = {
  onPointerDown({ state, dispatch, worldX, worldY }) {
    const inProgress = state.inProgressPolygon;
    if (!inProgress) {
      const fresh: Polygon = { space_id: '', points: [{ x: worldX, y: worldY }] };
      dispatch({ type: 'start-drawing', polygon: fresh });
    } else {
      const points = [...inProgress.points, { x: worldX, y: worldY }];
      dispatch({ type: 'start-drawing', polygon: { ...inProgress, points } });
    }
  },
  onKeyDown({ state, dispatch, key }) {
    if (key === 'Enter' && state.inProgressPolygon && state.inProgressPolygon.points.length >= 3) {
      dispatch({ type: 'commit-drawing' });
    } else if (key === 'Escape') {
      dispatch({ type: 'cancel-drawing' });
    }
  },
};
```

```ts
// apps/web/src/components/floor-plan-designer/tools/draw-rectangle-tool.ts
import type { Tool } from './tool';

export const drawRectangleTool: Tool = {
  onPointerDown({ state, dispatch, worldX, worldY }) {
    dispatch({ type: 'start-drawing', polygon: { space_id: '', points: [{ x: worldX, y: worldY }] } });
  },
  onPointerMove({ state, dispatch, worldX, worldY }) {
    const start = state.inProgressPolygon?.points[0];
    if (!start) return;
    const rect = [
      start,
      { x: worldX, y: start.y },
      { x: worldX, y: worldY },
      { x: start.x, y: worldY },
    ];
    dispatch({ type: 'start-drawing', polygon: { space_id: '', points: rect } });
  },
  onPointerUp({ dispatch }) {
    dispatch({ type: 'commit-drawing' });
  },
};
```

```ts
// apps/web/src/components/floor-plan-designer/tools/stamp-seat-tool.ts
import type { Tool } from './tool';

export const stampSeatTool: Tool = {
  onPointerDown({ state, dispatch, worldX, worldY }) {
    const w = 60, h = 40;
    dispatch({
      type: 'add-polygon',
      polygon: {
        space_id: '', // designer will resolve next unlinked desk or auto-create one; see Task B.11
        points: [
          { x: worldX - w / 2, y: worldY - h / 2 },
          { x: worldX + w / 2, y: worldY - h / 2 },
          { x: worldX + w / 2, y: worldY + h / 2 },
          { x: worldX - w / 2, y: worldY + h / 2 },
        ],
        render_hint: 'seat',
      },
    });
  },
};
```

- [ ] **Step 3: Canvas dispatcher**

```tsx
// apps/web/src/components/floor-plan-designer/designer-canvas.tsx
import { useRef, useState } from 'react';
import { ZoomPanLayer } from '../floor-plan/zoom-pan-layer';
import { PolygonShape } from '../floor-plan/polygon-shape';
import { polygonToSvgPath } from '../floor-plan/lib/polygon-geometry';
import type { DesignerState, ToolKind } from './types';
import { selectTool } from './tools/select-tool';
import { drawPolygonTool } from './tools/draw-polygon-tool';
import { drawRectangleTool } from './tools/draw-rectangle-tool';
import { stampSeatTool } from './tools/stamp-seat-tool';
import type { Tool } from './tools/tool';

const TOOL_MAP: Record<ToolKind, Tool> = {
  'select':         selectTool,
  'draw-polygon':   drawPolygonTool,
  'draw-rectangle': drawRectangleTool,
  'stamp-seat':     stampSeatTool,
  'parking':        stampSeatTool, // placeholder; parking variant lands in task B.11
  'label':          selectTool,    // placeholder
  'image-upload':   selectTool,    // image triggered separately
};

type Props = { state: DesignerState; dispatch: React.Dispatch<any> };

export function DesignerCanvas({ state, dispatch }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  const toWorld = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { worldX: 0, worldY: 0 };
    const inv = pt.matrixTransform(ctm.inverse());
    return { worldX: inv.x, worldY: inv.y };
  };

  const tool = TOOL_MAP[state.activeTool];

  return (
    <div className="flex-1 relative">
      <ZoomPanLayer>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${state.widthPx ?? 1000} ${state.heightPx ?? 1000}`}
          className="w-full h-full"
          onPointerDown={(e) => tool.onPointerDown?.({ state, dispatch, ...toWorld(e) })}
          onPointerMove={(e) => tool.onPointerMove?.({ state, dispatch, ...toWorld(e) })}
          onPointerUp={(e) => tool.onPointerUp?.({ state, dispatch, ...toWorld(e) })}
        >
          {state.imageUrl && (
            <image
              href={state.imageUrl}
              x="0" y="0"
              width={state.widthPx ?? 1000}
              height={state.heightPx ?? 1000}
              opacity={0.35}
            />
          )}
          {state.polygons.map((poly, i) => (
            <PolygonShape
              key={i}
              spaceId={poly.space_id || `pending-${i}`}
              points={poly.points}
              renderHint={poly.render_hint ?? 'default'}
              name={`Polygon ${i + 1}`}
              capacity={null}
              state="available"
              selected={i === state.selectedPolygonIndex}
              onClick={() => dispatch({ type: 'select-polygon', index: i })}
            />
          ))}
          {state.inProgressPolygon && (
            <path
              d={polygonToSvgPath(state.inProgressPolygon.points)}
              fill="rgba(245, 158, 11, 0.1)"
              stroke="#f59e0b"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          )}
        </svg>
      </ZoomPanLayer>
    </div>
  );
}
```

- [ ] **Step 4: Wire keyboard for in-progress drawing**

In `floor-plan-designer.tsx`, extend the `keydown` handler to also call the active tool's `onKeyDown` for Enter/Escape.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/floor-plan-designer
git commit -m "feat(floor-plan): DesignerCanvas with tool dispatcher + 4 tools (select, polygon, rect, stamp)"
```

### Task B.9: Link polygons to spaces (combobox in inspector)

**Files:**
- Modify: `apps/web/src/components/floor-plan-designer/polygon-inspector.tsx`
- Reuse: `apps/web/src/components/space-select.tsx`

- [ ] **Step 1: Add space picker to inspector**

In `polygon-inspector.tsx`, render a `<SpaceSelect>` (reuse the existing component) inside a `<Field>` block above the render-hint group. The combobox should query for child spaces of the current floor that are not yet assigned to a polygon (frontend filter using `state.polygons.map(p => p.space_id)`).

If `<SpaceSelect>` doesn't support filtering by parent_id, add a `parentId` prop to it (small change to the existing component).

- [ ] **Step 2: When the stamp-seat tool runs and no unlinked desk exists**

In `stamp-seat-tool.ts`, the polygon is added with `space_id: ''`. After dispatch, if there's no unlinked desk on the floor, the inspector shows an inline "Create desk for this polygon?" affordance that POSTs to `/api/spaces` with `type='desk'`, `parent_id=<floorSpaceId>`, `name='Desk <next>'`. Wire this in `polygon-inspector.tsx`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/polygon-inspector.tsx apps/web/src/components/space-select.tsx
git commit -m "feat(floor-plan): polygon → space linking with inline create-desk affordance"
```

### Task B.10: Image upload via Supabase Storage

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/use-image-upload.ts`
- Modify: `apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx`

- [ ] **Step 1: Hook**

```ts
// apps/web/src/components/floor-plan-designer/use-image-upload.ts
import { useState } from 'react';
import { supabaseClient } from '../../lib/supabase';
import { toastError } from '../../lib/toast';

const BUCKET = 'floor-plans';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_EDGE = 4096;

export function useImageUpload(tenantId: string, floorSpaceId: string) {
  const [uploading, setUploading] = useState(false);

  async function upload(file: File): Promise<{ url: string; widthPx: number; heightPx: number } | null> {
    if (file.size > MAX_BYTES) {
      toastError("Image too large", { description: 'Max 10 MB.' });
      return null;
    }
    setUploading(true);
    try {
      // measure
      const bitmap = await createImageBitmap(file);
      const widthPx = bitmap.width;
      const heightPx = bitmap.height;
      if (Math.max(widthPx, heightPx) > MAX_EDGE) {
        toastError("Image too large", { description: `Long edge must be <= ${MAX_EDGE}px.` });
        return null;
      }
      const sha = await fileSha256(file);
      const path = `${tenantId}/${floorSpaceId}/${sha}.${file.name.split('.').pop()}`;
      const { error } = await supabaseClient.storage.from(BUCKET).upload(path, file, { upsert: false });
      if (error && error.message !== 'The resource already exists') throw error;
      const { data: pub } = supabaseClient.storage.from(BUCKET).getPublicUrl(path);
      return { url: pub.publicUrl, widthPx, heightPx };
    } catch (err) {
      toastError("Couldn't upload image", { error: err });
      return null;
    } finally {
      setUploading(false);
    }
  }

  return { upload, uploading };
}

async function fileSha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 2: Trigger from designer**

In `floor-plan-designer.tsx`, when `state.activeTool === 'image-upload'`, render a hidden `<input type="file">` and trigger it on tool selection. On upload success, dispatch `{ type: 'set-image', imageUrl, widthPx, heightPx }`.

Show a banner if there are already polygons: `"Image replaced. Polygons may need to be remapped."`

- [ ] **Step 3: Storage bucket migration**

Create `supabase/migrations/00372_floor_plans_storage_bucket.sql`:

```sql
-- 00372_floor_plans_storage_bucket.sql
-- Public bucket for floor plan background images. Tenant-prefixed paths.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('floor-plans', 'floor-plans', true, 10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']::text[])
on conflict (id) do nothing;

-- RLS policy: authenticated users can write only under their tenant prefix
create policy "floor_plans_tenant_write"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'floor-plans'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

create policy "floor_plans_public_read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'floor-plans');
```

Push this migration too (same procedure as A.7).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/floor-plan-designer apps/web/src/lib/supabase.ts supabase/migrations/00372_floor_plans_storage_bucket.sql
git commit -m "feat(floor-plan): image upload via Supabase Storage + tenant-scoped bucket"
```

### Task B.11: Snapping + grid

**Files:**
- Modify: `apps/web/src/components/floor-plan-designer/designer-canvas.tsx`
- Create: `apps/web/src/components/floor-plan-designer/lib/snapping.ts`

- [ ] **Step 1: Snapping helper**

```ts
// apps/web/src/components/floor-plan-designer/lib/snapping.ts
import type { Point, Polygon } from '../../../api/floor-plans/types';

const GRID = 10;
const SNAP_TO_GRID_PX = 4;
const SNAP_TO_VERTEX_PX = 8;

export function snap(point: Point, polygons: Polygon[]): Point {
  // try snap to existing vertex
  for (const poly of polygons) {
    for (const v of poly.points) {
      if (Math.hypot(v.x - point.x, v.y - point.y) <= SNAP_TO_VERTEX_PX) {
        return { x: v.x, y: v.y };
      }
    }
  }
  // then snap to grid
  const gx = Math.round(point.x / GRID) * GRID;
  const gy = Math.round(point.y / GRID) * GRID;
  if (Math.abs(gx - point.x) <= SNAP_TO_GRID_PX && Math.abs(gy - point.y) <= SNAP_TO_GRID_PX) {
    return { x: gx, y: gy };
  }
  return point;
}
```

- [ ] **Step 2: Apply in canvas**

In `designer-canvas.tsx`, before dispatching tool events, call `snap({ x: worldX, y: worldY }, state.polygons)` and pass the snapped coords instead.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan-designer
git commit -m "feat(floor-plan): snap-to-vertex (8px) + snap-to-grid (4px) for all drawing tools"
```

### Task B.12: Undo / redo

**Files:**
- Modify: `apps/web/src/components/floor-plan-designer/use-designer-state.ts`

- [ ] **Step 1: Wrap reducer with history stack**

Refactor `useDesignerState` to maintain `history: DesignerState[]` (capped at 50) and `historyIndex: number`. Add actions `'undo'` and `'redo'` that move the index without re-firing autosave for snapshots already on disk. Wire `Cmd/Ctrl-Z` and `Cmd/Ctrl-Shift-Z` in the global keydown handler.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan-designer
git commit -m "feat(floor-plan): undo/redo via in-memory history stack (50 deep)"
```

### Task B.13: Take-over chip

**Files:**
- Modify: `apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx`

- [ ] **Step 1: Detect foreign authorship**

When the draft loads, if `draft.created_by !== currentUserId` and `Date.now() - new Date(draft.updated_at).getTime() > 60_000` (untouched for 1 minute), render a chip at the top of the canvas: `"<name> started this draft <relative-time> ago"` with buttons `View read-only` (disables all tools) and `Take over` (calls `useTakeOverDraft`).

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx
git commit -m "feat(floor-plan): take-over chip for drafts owned by another admin"
```

### Task B.14: `/admin/floor-plans` index + designer routes

**Files:**
- Create: `apps/web/src/pages/admin/floor-plans-index.tsx`
- Create: `apps/web/src/pages/admin/floor-plan-designer.tsx`
- Modify: `apps/web/src/App.tsx` (add routes, both wrapped in `<RouteErrorBoundary>`)

- [ ] **Step 1: Index page**

```tsx
// apps/web/src/pages/admin/floor-plans-index.tsx
import { SettingsPageShell, SettingsPageHeader } from '../../components/ui/settings-page';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api-fetch';

type FloorRow = { id: string; name: string; building_name: string; has_plan: boolean; last_published_at: string | null };

export function FloorPlansIndex() {
  const floors = useQuery({
    queryKey: ['admin', 'floor-plans-index'],
    queryFn: () => apiFetch<FloorRow[]>(`/api/admin/floor-plans-index`),
    staleTime: 60_000,
  });

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        title="Floor plans"
        description="Upload floor images and trace bookable spaces. Published plans appear on the booking surfaces."
      />
      {floors.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
      <table className="w-full text-sm mt-6">
        <thead>
          <tr className="text-xs uppercase text-muted-foreground border-b">
            <th className="text-left py-2 px-3">Building</th>
            <th className="text-left py-2 px-3">Floor</th>
            <th className="text-left py-2 px-3">Status</th>
            <th className="text-left py-2 px-3">Last published</th>
          </tr>
        </thead>
        <tbody>
          {(floors.data ?? []).map((f) => (
            <tr key={f.id} className="border-b hover:bg-muted/30">
              <td className="py-2 px-3">{f.building_name}</td>
              <td className="py-2 px-3">
                <Link to={`/admin/floor-plans/${f.id}`} className="hover:underline">{f.name}</Link>
              </td>
              <td className="py-2 px-3">{f.has_plan ? 'Published' : 'No plan'}</td>
              <td className="py-2 px-3 tabular-nums text-muted-foreground">
                {f.last_published_at ? new Date(f.last_published_at).toLocaleDateString() : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SettingsPageShell>
  );
}
```

- [ ] **Step 2: Designer page**

```tsx
// apps/web/src/pages/admin/floor-plan-designer.tsx
import { useParams } from 'react-router-dom';
import { SettingsPageShell, SettingsPageHeader } from '../../components/ui/settings-page';
import { FloorPlanDesigner } from '../../components/floor-plan-designer/floor-plan-designer';

export function FloorPlanDesignerPage() {
  const { floorSpaceId } = useParams<{ floorSpaceId: string }>();
  if (!floorSpaceId) return null;
  return (
    <SettingsPageShell width="full" backTo="/admin/floor-plans">
      <SettingsPageHeader title="Floor plan editor" description="Trace polygons over the uploaded image." />
      <FloorPlanDesigner floorSpaceId={floorSpaceId} />
    </SettingsPageShell>
  );
}
```

- [ ] **Step 3: Backend index endpoint (separate controller — path collision)**

The existing `FloorPlanController` is decorated with `@Controller('floors/:floorSpaceId/plan')`, so an endpoint at `/admin/floor-plans-index` cannot live in that controller (it would resolve to `/floors/:id/plan/admin/floor-plans-index`). Add a sibling controller in the same module:

```ts
// apps/api/src/modules/floor-plan/floor-plan-admin.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionGuard, RequirePermission } from '../auth/permission.guard';
import { FloorPlanService } from './floor-plan.service';

@UseGuards(AuthGuard)
@Controller('admin/floor-plans-index')
export class FloorPlanAdminController {
  constructor(private readonly plan: FloorPlanService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.author')
  @Get()
  async indexForAdmin() {
    return this.plan.listForAdmin();
  }
}
```

Register both controllers in `floor-plan.module.ts`:

```ts
controllers: [FloorPlanController, FloorPlanAdminController],
```

```ts
// apps/api/src/modules/floor-plan/floor-plan.service.ts (add method)
async listForAdmin() {
  const client = this.supabase.client();
  const { data } = await client.rpc('admin_floor_plans_index'); // see migration below
  return data ?? [];
}
```

Migration `supabase/migrations/00373_admin_floor_plans_index_rpc.sql`:

```sql
create or replace function public.admin_floor_plans_index()
returns table (
  id uuid,
  name text,
  building_name text,
  has_plan boolean,
  last_published_at timestamptz
)
language sql
security invoker
set search_path = public
as $$
  select f.id,
         f.name,
         coalesce(b.name, '—') as building_name,
         fp.space_id is not null as has_plan,
         fp.updated_at as last_published_at
    from public.spaces f
    left join public.spaces b on b.id = f.parent_id and b.type = 'building'
    left join public.floor_plans fp on fp.space_id = f.id
   where f.type = 'floor'
     and f.tenant_id = public.current_tenant_id()
   order by b.name, f.name;
$$;
```

- [ ] **Step 4: Add to App.tsx (both routes wrapped in RouteErrorBoundary per CLAUDE.md)**

```tsx
<Route path="/admin/floor-plans" element={<RouteErrorBoundary><FloorPlansIndex /></RouteErrorBoundary>} />
<Route path="/admin/floor-plans/:floorSpaceId" element={<RouteErrorBoundary><FloorPlanDesignerPage /></RouteErrorBoundary>} />
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin apps/web/src/App.tsx apps/api/src/modules/floor-plan supabase/migrations/00373_admin_floor_plans_index_rpc.sql
git commit -m "feat(floor-plan): /admin/floor-plans routes + index RPC"
```

### Task B.15: Add to admin sidebar

**Files:**
- Modify: `apps/web/src/components/admin/sidebar.tsx` (or wherever the admin nav lives — find via `grep -rn "admin/locations" apps/web/src`)

- [ ] **Step 1: Add a "Floor plans" entry**

Place it near "Locations" / "Spaces". Use a relevant Lucide icon (`Map` or `LayoutGrid`).

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/admin/sidebar.tsx
git commit -m "feat(floor-plan): admin sidebar entry"
```

**Phase B done.** Designer is functional: admin can open `/admin/floor-plans`, click into a floor, upload an image, trace polygons with all tools, see autosave indicator, undo/redo, take over another admin's draft. Publish button exists but routes to a stub.

---

# Phase C — Publish Flow

Goal: complete the publish path. End state: admin clicks Publish → diff dialog → confirm → polygon state written to `spaces.floor_plan_polygon` atomically → audit event created → draft deleted. After this phase, downstream code (Plan 2) can read from the canonical schema.

### Task C.1: Publish diff computation

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/lib/diff.ts`
- Create: `apps/web/src/components/floor-plan-designer/__tests__/diff.test.ts`

- [ ] **Step 1: Diff function + test**

```ts
// apps/web/src/components/floor-plan-designer/lib/diff.ts
import type { Polygon, PublishedFloorPlan } from '../../../api/floor-plans/types';

export type PublishDiff = {
  added: Polygon[];
  removed: { space_id: string; name: string }[];
  modified: { space_id: string; before: Polygon; after: Polygon }[];
  imageChanged: boolean;
};

export function computePublishDiff(
  draftPolygons: Polygon[],
  draftImageUrl: string | null,
  published: PublishedFloorPlan | null,
): PublishDiff {
  const publishedPolygons: Polygon[] = (published?.spaces ?? []).map((s) => ({
    space_id: s.id,
    points: Array.isArray(s.floor_plan_polygon) ? s.floor_plan_polygon : s.floor_plan_polygon.points,
    render_hint: s.floor_plan_render_hint,
  }));
  const draftMap = new Map(draftPolygons.map((p) => [p.space_id, p]));
  const publishedMap = new Map(publishedPolygons.map((p) => [p.space_id, p]));

  const added: Polygon[] = [];
  const modified: PublishDiff['modified'] = [];
  for (const [id, draft] of draftMap) {
    const before = publishedMap.get(id);
    if (!before) {
      added.push(draft);
    } else if (JSON.stringify(before.points) !== JSON.stringify(draft.points) ||
               before.render_hint !== draft.render_hint) {
      modified.push({ space_id: id, before, after: draft });
    }
  }

  const removed: PublishDiff['removed'] = [];
  for (const [id] of publishedMap) {
    if (!draftMap.has(id)) {
      const sp = published?.spaces.find((s) => s.id === id);
      removed.push({ space_id: id, name: sp?.name ?? '(unknown)' });
    }
  }

  return {
    added,
    removed,
    modified,
    imageChanged: draftImageUrl !== (published?.floor.image_url ?? null),
  };
}
```

```ts
// apps/web/src/components/floor-plan-designer/__tests__/diff.test.ts
import { describe, it, expect } from 'vitest';
import { computePublishDiff } from '../lib/diff';

describe('computePublishDiff', () => {
  it('detects added polygons', () => {
    const draft = [{ space_id: 'a', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }];
    const diff = computePublishDiff(draft, null, null);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
  });
  // ... add cases for removed, modified, imageChanged
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @prequest/web test diff
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/lib/diff.ts apps/web/src/components/floor-plan-designer/__tests__/diff.test.ts
git commit -m "feat(floor-plan): compute publish diff (added/removed/modified/imageChanged) + tests"
```

### Task C.2: `<PublishDialog>` with diff preview

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/publish-dialog.tsx`
- Modify: `apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx` (wire button)

- [ ] **Step 1: Dialog**

```tsx
// apps/web/src/components/floor-plan-designer/publish-dialog.tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { useFloorPlanPublished, usePublishDraft } from '../../api/floor-plans/hooks';
import { computePublishDiff } from './lib/diff';
import { toastUpdated } from '../../lib/toast';
import type { DraftResponse } from '../../api/floor-plans/types';

type Props = { open: boolean; onOpenChange: (open: boolean) => void; floorSpaceId: string; draft: DraftResponse };

export function PublishDialog({ open, onOpenChange, floorSpaceId, draft }: Props) {
  const published = useFloorPlanPublished(floorSpaceId);
  const publish = usePublishDraft(floorSpaceId);
  const diff = computePublishDiff(draft.polygons, draft.image_url, published.data ?? null);

  const handlePublish = async () => {
    await publish.mutateAsync();
    toastUpdated('Floor plan');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish floor plan</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {diff.imageChanged && <p className="text-amber-700">Background image changed.</p>}
          {diff.added.length > 0 && (
            <p>
              <strong className="text-emerald-700">{diff.added.length}</strong> polygon(s) added.
            </p>
          )}
          {diff.modified.length > 0 && (
            <p>
              <strong className="text-blue-700">{diff.modified.length}</strong> polygon(s) modified.
            </p>
          )}
          {diff.removed.length > 0 && (
            <div>
              <p>
                <strong className="text-red-700">{diff.removed.length}</strong> polygon(s) removed:
              </p>
              <ul className="ml-4 list-disc text-muted-foreground">
                {diff.removed.map((r) => <li key={r.space_id}>{r.name}</li>)}
              </ul>
              <p className="text-xs text-muted-foreground mt-2">
                Removing a polygon does not cancel existing bookings. They'll still appear in list views.
              </p>
            </div>
          )}
          {diff.added.length === 0 && diff.modified.length === 0 && diff.removed.length === 0 && !diff.imageChanged && (
            <p className="text-muted-foreground">No changes to publish.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handlePublish} disabled={publish.isPending}>Publish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Wire from designer top bar**

Add a Publish button to the `<ToolDock>` or a top bar in `<FloorPlanDesigner>`, opening the dialog.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan-designer
git commit -m "feat(floor-plan): PublishDialog with diff preview + wired publish action"
```

### Task C.3: Backend publish — extra safety + smoke probe

**Files:**
- Modify: `apps/api/src/modules/floor-plan/floor-plan.service.ts`
- Modify: `apps/api/scripts/smoke-floor-plans.mjs`

- [ ] **Step 1: Add per-space tenant + parent_id checks before publish**

Before calling the RPC, do a server-side pre-flight: for each polygon in the draft, confirm `space.tenant_id === draftTenantId` AND `space.parent_id === floor_space_id`. Reject with `validation.failed` carrying the offending space_id.

```ts
// inside FloorPlanService.publish
async publish(floorSpaceId: string, userId: string): Promise<void> {
  const client = this.supabase.client();
  const { data: draft } = await client
    .from('floor_plan_drafts')
    .select('id, tenant_id, polygons')
    .eq('floor_space_id', floorSpaceId)
    .maybeSingle();
  if (!draft) throw AppErrors.notFoundWithCode('floor_plan.draft.not_found');

  const polygons = draft.polygons as Array<{ space_id: string }>;
  if (polygons.length > 0) {
    const ids = polygons.map((p) => p.space_id);
    const { data: spaces } = await client
      .from('spaces')
      .select('id, parent_id, tenant_id')
      .in('id', ids);
    const bad = (spaces ?? []).filter((s) => s.parent_id !== floorSpaceId || s.tenant_id !== draft.tenant_id);
    if (bad.length > 0) {
      throw AppErrors.validationFailed('floor_plan.publish.invalid_polygons', { spaceIds: bad.map((b) => b.id) });
    }
  }

  const { error } = await client.rpc('publish_floor_plan_draft', { p_draft_id: draft.id });
  if (error) throw AppErrors.server('floor_plan.publish_failed');
}
```

- [ ] **Step 2: Add smoke probes for publish edge cases**

Extend `apps/api/scripts/smoke-floor-plans.mjs` (8 → 12 probes):
- Probe 9: PATCH polygon with `space_id` from another tenant → 422.
- Probe 10: PATCH polygon with `space_id` not in this floor's children → 422.
- Probe 11: Publish empty draft (no polygons) → 200, then GET plan → spaces[] empty.
- Probe 12: Publish twice in quick succession → second call 404 (draft gone after first publish).

- [ ] **Step 3: Run smoke + commit**

```bash
pnpm smoke:floor-plans
```
Expected: all 12 probes pass.

```bash
git add apps/api/src/modules/floor-plan apps/api/scripts/smoke-floor-plans.mjs
git commit -m "feat(floor-plan): publish preflight validation + extended smoke probes (12 total)"
```

### Task C.4: Audit event end-to-end test

**Files:**
- Create: `apps/api/src/modules/floor-plan/publish-audit.spec.ts`

- [ ] **Step 1: Test**

```ts
// apps/api/src/modules/floor-plan/publish-audit.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestSupabase, seedTenant, seedFloor, seedRoom } from '../../test-utils/supabase-test-helpers';

describe('publish_floor_plan_draft RPC', () => {
  let supabase: ReturnType<typeof createTestSupabase>;
  let tenantId: string;
  let floorId: string;
  let roomId: string;
  let userId: string;

  beforeEach(async () => {
    supabase = createTestSupabase();
    ({ tenantId, userId } = await seedTenant(supabase));
    floorId = await seedFloor(supabase, tenantId);
    roomId = await seedRoom(supabase, tenantId, floorId);
  });

  it('writes audit event with diff payload', async () => {
    // create draft
    const { data: draft } = await supabase
      .from('floor_plan_drafts')
      .insert({
        tenant_id: tenantId,
        floor_space_id: floorId,
        image_url: 'https://example.com/plan.png',
        width_px: 1000,
        height_px: 800,
        polygons: [{ space_id: roomId, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
        created_by: userId,
      })
      .select('id')
      .single();

    // publish
    await supabase.rpc('publish_floor_plan_draft', { p_draft_id: draft!.id });

    // verify
    const { data: audit } = await supabase
      .from('audit_events')
      .select('*')
      .eq('kind', 'floor_plan.published')
      .eq('tenant_id', tenantId)
      .single();
    expect(audit).toBeTruthy();
    expect(audit!.payload.floor_space_id).toBe(floorId);

    const { data: room } = await supabase.from('spaces').select('floor_plan_polygon').eq('id', roomId).single();
    expect(room!.floor_plan_polygon).toBeTruthy();

    const { data: leftoverDraft } = await supabase.from('floor_plan_drafts').select('id').eq('id', draft!.id);
    expect(leftoverDraft).toEqual([]);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/floor-plan/publish-audit.spec.ts
git commit -m "test(floor-plan): publish RPC end-to-end with audit event check"
```

### Task C.5: Final smoke + self-review

- [ ] **Step 1: Full build**

```bash
pnpm --filter @prequest/api build
pnpm --filter @prequest/web build
pnpm --filter @prequest/shared test
```
All green.

- [ ] **Step 2: Smoke gate**

With `pnpm dev:api` running:
```bash
pnpm smoke:floor-plans
pnpm smoke:work-orders
```
Both must exit 0.

- [ ] **Step 3: Manual happy path in the browser**

`pnpm dev` (both). Log in as a tenant admin with `floor_plans.author` + `floor_plans.publish`. Navigate to `/admin/floor-plans`, click into a floor, upload an image, trace 2 rooms + stamp 6 desks, hit Publish, confirm the dialog shows the expected diff, hit Publish, see toast. Refresh — published state shows.

- [ ] **Step 4: Spec coverage scan**

Open the spec and confirm every Phase A–C requirement has a task:
- §3.1 floor_plans exists ✔ (pre-existing)
- §3.2 render_hint ✔ A.1
- §3.3 floor_plan_drafts table ✔ A.2 + labels in A.4
- §3.4 one polygon model adaptive ✔ B.2 (PolygonShape adaptive)
- §3.5 parent_id enforcement ✔ C.3
- §3.6 realtime — Plan 2 (booking surface)
- §4 renderer view mode ✔ B.2 (used by Plan 2)
- §5 designer ✔ B.4–B.14
- §6.1 module ✔ A.8
- §6.2 RPC ✔ A.3
- §6.3 REST endpoints — Phase A.8 has GET/PATCH/DELETE; availability is Plan 2
- §7.1 admin routes ✔ B.14
- §7.2–7.4 — Plan 2
- §8 permissions ✔ A.5/A.6
- §9 edge cases — design + tests cover; runtime checks in C.3
- §10 testing — A.9, A.10, B.1, B.2, B.11, C.1, C.4
- §11 perf — manual perf check in C.5 step 5
- §12 GDPR — audit event in C.4; storage prefix in B.10
- §13 migrations ✔ A.1, A.2, A.3 (renamed 00370), A.4 (renamed 00369), A.5, B.10 (00372), B.14 (00373)

- [ ] **Step 5: Performance sanity**

In dev tools, load a floor with 200 polygons (use a seed fixture or quickly stamp 200 seats in the designer). Confirm pan/zoom maintains > 50fps. If it drops, file a follow-up task to switch the polygon layer to Konva — don't block Plan 2.

- [ ] **Step 6: Final commit + push**

```bash
git push origin worktree-floorplanner
```

Open a PR with title: `feat: floor plan designer (Plan 1 — Phases A-C)`.

**Plan 1 done.** Designer ships. Booking surface (Plan 2 — Phases D-F) is the next plan to write once this one is reviewed.

---

## Followups to track (do NOT block Plan 1)

1. Replace placeholder glyphs in `<ToolDock>` with Lucide icons (B.6 step 1 footnote).
2. Implement parking tool as its own file (currently aliased to stamp-seat in TOOL_MAP — B.8 step 3 footnote).
3. Implement label tool (currently aliased to select).
4. Add Konva fallback for polygon layer if perf becomes an issue.
5. Add a "remap polygons after image replacement" tool (B.10 step 2 banner).
6. Add `parent_vendor_account_id` escape hatch is unrelated — ignore for floor plans.
