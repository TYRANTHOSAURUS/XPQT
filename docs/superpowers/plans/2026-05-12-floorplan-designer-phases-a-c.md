# Floor Plan Designer (Phases A–C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the admin-facing floor plan designer (Figma-style authoring tool + draft/publish flow) on top of the existing `floor_plans` (00127) and `spaces.floor_plan_polygon` (00120) primitives. Output: admins can upload a floor image, trace polygons over rooms/desks/parking, save drafts, and atomically publish. Data lands in the canonical schema so the booking surface (Plan 2, Phases D–F) can consume it next.

**Architecture:** Three layers. (1) **Schema** — six migrations: one column + CHECK on `spaces`, one `floor_plan_drafts` table, one labels column on both `floor_plans` and drafts, one PL/pgSQL publish RPC (atomic), one `floor_plan_publish_history` snapshot table (for rollback), one Storage bucket with full RLS. (2) **Backend** — new NestJS `floor-plan` module with one service, two controllers (per-floor + admin index), four endpoints (GET/PATCH/DELETE drafts + POST publish), `If-Match: updated_at` optimistic locking on PATCH, all multi-table writes routed through the `publish_floor_plan_draft` RPC per CLAUDE.md. (3) **Frontend** — `<FloorPlanCanvas>` SVG renderer (used in `view` mode by Plan 2, in `edit` mode here), wrapped by `<FloorPlanDesigner>` which adds tool dock, left-rail spaces tree, and right-rail inspector. Tools implement a common `Tool` interface; canvas dispatches pointer events to the active tool.

**Tech Stack:** NestJS, TypeScript, Supabase Postgres + Storage + RLS, React 19, Vite, Tailwind v4, shadcn/ui (Field primitives + ToggleGroup + Table mandatory), TanStack Query v5, Framer Motion, vitest + Testing Library, Lucide icons.

**Spec:** `docs/superpowers/specs/2026-05-12-floorplan-designer-and-map-booking-design.md` (commit `4d6b120a`). Read it end-to-end before starting.

**Plan-review remediation:** This plan integrates fixes from the adversarial plan review (full-review skill, 2026-05-12) — single `floor_plans.admin` permission key, no permission_catalog SQL table, correct `audit_events` schema, designer page without `SettingsPageShell`, polygon shape CHECK constraint, optimistic locking, publish history, take-over deferred. See "Plan-review delta" at end.

---

## Pre-flight

- [ ] **Step 0: Read the spec end-to-end**

Open `/Users/x/Desktop/XPQT/.claude/worktrees/floorplanner/docs/superpowers/specs/2026-05-12-floorplan-designer-and-map-booking-design.md`. The spec is the contract; this plan is the execution path.

- [ ] **Step 0b: Confirm baseline builds**

```bash
pnpm install
pnpm --filter @prequest/api build
pnpm --filter @prequest/web build
pnpm --filter @prequest/shared test
```
All must succeed. If anything fails, fix the baseline before starting Phase A.

- [ ] **Step 0c: Confirm latest migration is 00366**

```bash
ls supabase/migrations/ | tail -1
```
Expected: `00366_workflow_events_add_node_failed.sql`. If newer migrations have landed, bump every migration number in this plan by the delta and update cross-references.

- [ ] **Step 0d: Verify the actual schema of dependencies before writing migrations**

```bash
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "\d public.audit_events"
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "\d public.spaces"
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "\d public.floor_plans"
```
Confirm: `audit_events` columns are `event_type / details / actor_user_id / entity_type / entity_id / tenant_id / created_at`. `spaces.floor_plan_polygon` exists as jsonb (from 00120) with no CHECK. If any column has been renamed since this plan was written, adjust the RPC migration before applying.

- [ ] **Step 0e: Existing files to read (do not edit yet)**

For orientation:
- `supabase/migrations/00019_events_audit.sql` — actual audit_events schema
- `supabase/migrations/00120_spaces_room_booking_columns.sql` — `floor_plan_polygon` added
- `supabase/migrations/00127_floor_plans.sql` — existing `floor_plans` table
- `packages/shared/src/permissions.ts` — TS permission catalog SoT (no SQL table)
- `apps/api/src/common/errors/app-error.ts` — `AppErrors.*` factories
- `apps/api/src/common/permission-catalog.spec.ts` — TS catalog CI gate
- `apps/api/src/modules/space/space.module.ts` — sibling module shape
- `apps/web/src/components/ui/settings-page.tsx` — `SettingsPageShell` (props: `children`, `className`, `width`) and `SettingsPageHeader` (props: `title`, `description`, `backTo`, `actions`)
- `apps/web/src/components/ui/field.tsx` — shadcn Field primitives
- `apps/web/src/components/ui/toggle-group.tsx` — for segmented controls
- `apps/web/src/components/ui/table.tsx` — for the index table
- `apps/web/src/components/ui/settings-row.tsx` — for stat blocks
- `apps/web/src/lib/toast.ts` — toast wrappers
- `apps/web/src/lib/use-page-query.ts` — required for primary page queries
- `apps/api/scripts/smoke-work-orders.mjs` — smoke gate template

---

# Phase A — Schema + Draft API

Goal: six migrations land on remote, TS permission catalog updates, new `floor-plan` API module ships with draft CRUD endpoints + publish endpoint + tests + smoke gate. No frontend work. End state: API can store, fetch, and publish a floor plan draft. Optimistic locking enforced on PATCH. Audit + publish-history rows written on publish.

### Task A.1: Migration 00367 — `render_hint` column + polygon shape CHECK

**Files:**
- Create: `supabase/migrations/00367_spaces_floor_plan_render_hint.sql`

Background: `spaces.floor_plan_polygon` was added in 00120 as plain `jsonb` with no shape constraint. The spec mandates `{"points":[{x,y}, …]}`. No data exists yet (feature not used). Enforce the shape now to prevent the fallback-reader leak the plan review caught.

- [ ] **Step 1: Write the migration**

```sql
-- 00367_spaces_floor_plan_render_hint.sql
-- Adds render hint + canonicalizes polygon shape. Spec §3.2 + §3.4.

alter table public.spaces
  add column if not exists floor_plan_render_hint text not null default 'default'
    check (floor_plan_render_hint in ('default', 'seat', 'parking'));

-- Normalize any pre-existing rows: wrap bare arrays in {points:[…]}.
update public.spaces
   set floor_plan_polygon = jsonb_build_object('points', floor_plan_polygon)
 where floor_plan_polygon is not null
   and jsonb_typeof(floor_plan_polygon) = 'array';

alter table public.spaces
  add constraint floor_plan_polygon_shape
    check (
      floor_plan_polygon is null
      or (
        jsonb_typeof(floor_plan_polygon) = 'object'
        and floor_plan_polygon ? 'points'
        and jsonb_typeof(floor_plan_polygon->'points') = 'array'
        and jsonb_array_length(floor_plan_polygon->'points') >= 3
      )
    );

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally + verify**

```bash
pnpm db:reset
PGPASSWORD="$SUPABASE_DB_PASS_LOCAL" psql "$DATABASE_URL_LOCAL" -c "\d public.spaces" | grep floor_plan
```
Expected: both `floor_plan_polygon` and `floor_plan_render_hint` columns visible, plus the CHECK constraint listed.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00367_spaces_floor_plan_render_hint.sql
git commit -m "feat(floor-plan): 00367 render_hint + polygon shape CHECK on spaces"
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
  unique (floor_space_id),
  check (jsonb_typeof(polygons) = 'array')
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

- [ ] **Step 2: Apply + verify RLS**

```bash
pnpm db:reset
PGPASSWORD="$SUPABASE_DB_PASS_LOCAL" psql "$DATABASE_URL_LOCAL" -c "select policyname from pg_policies where tablename = 'floor_plan_drafts';"
```
Expected: `tenant_isolation`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00368_floor_plan_drafts.sql
git commit -m "feat(floor-plan): 00368 floor_plan_drafts table with RLS"
```

### Task A.3: Migration 00369 — `labels` jsonb on `floor_plans` + drafts

**Files:**
- Create: `supabase/migrations/00369_floor_plans_and_drafts_labels.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00369_floor_plans_and_drafts_labels.sql
-- Non-polygon annotations placed on the canvas (e.g. "Lounge", "Reception").
-- Shape: [{ "text": "Lounge", "x": 690, "y": 250, "size": 11 }]. Spec §5.6.

alter table public.floor_plans
  add column if not exists labels jsonb not null default '[]'::jsonb,
  add constraint floor_plans_labels_is_array
    check (jsonb_typeof(labels) = 'array');

alter table public.floor_plan_drafts
  add column if not exists labels jsonb not null default '[]'::jsonb,
  add constraint floor_plan_drafts_labels_is_array
    check (jsonb_typeof(labels) = 'array');

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply + commit**

```bash
pnpm db:reset
git add supabase/migrations/00369_floor_plans_and_drafts_labels.sql
git commit -m "feat(floor-plan): 00369 labels jsonb on floor_plans + drafts"
```

### Task A.4: Migration 00370 — `publish_floor_plan_draft` RPC

**Files:**
- Create: `supabase/migrations/00370_publish_floor_plan_draft_rpc.sql`

The RPC uses the **actual** `audit_events` schema: `(tenant_id, event_type, entity_type, entity_id, actor_user_id, details, created_at)`. NOT the `(kind, payload, created_by)` shape from the original plan. It also writes a snapshot row to `floor_plan_publish_history` (added in A.5) BEFORE wiping orphan polygons, so admins can restore.

- [ ] **Step 1: Write the migration**

```sql
-- 00370_publish_floor_plan_draft_rpc.sql
-- Atomic publish flow per CLAUDE.md ("multi-step writes via PL/pgSQL").
-- Single-execution guarantee via DELETE ... RETURNING * at the start (codex CRITICAL #1).
-- Writes a snapshot to floor_plan_publish_history (for rollback), updates floor_plans
-- + spaces.floor_plan_polygon, deletes the draft. Spec §6.2.

create or replace function public.publish_floor_plan_draft(p_draft_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_draft public.floor_plan_drafts%rowtype;
  v_tenant_id uuid;
  v_floor_id uuid;
  v_polygon jsonb;
  v_space_ids uuid[];
  v_history_id uuid;
  v_prev_image text;
  v_prev_w int;
  v_prev_h int;
  v_prev_labels jsonb;
  v_prev_polygons jsonb;
  v_invalid_count int;
begin
  -- Single-execution claim: DELETE atomically locks + removes the draft. A concurrent
  -- caller for the same draft_id sees 0 rows and the not_found branch fires.
  delete from public.floor_plan_drafts
   where id = p_draft_id
  returning * into v_draft;

  if v_draft.id is null then
    raise exception 'floor_plan.draft.not_found' using errcode = 'P0002';
  end if;

  v_tenant_id := v_draft.tenant_id;
  v_floor_id  := v_draft.floor_space_id;

  if v_tenant_id <> public.current_tenant_id() then
    raise exception 'floor_plan.draft.cross_tenant' using errcode = '42501';
  end if;

  -- Required-fields preflight: floor_plans canonical columns are NOT NULL in 00127.
  if v_draft.image_url is null or v_draft.width_px is null or v_draft.height_px is null then
    raise exception 'floor_plan.publish.image_required' using errcode = '23502';
  end if;

  -- Validate every polygon: non-empty uuid + child-of-floor + same tenant + non-duplicate.
  select count(*) into v_invalid_count
    from jsonb_array_elements(v_draft.polygons) p
   where (p->>'space_id') is null
      or (p->>'space_id') = ''
      or not (p->>'space_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      or (p->'points') is null
      or jsonb_typeof(p->'points') <> 'array'
      or jsonb_array_length(p->'points') < 3;
  if v_invalid_count > 0 then
    raise exception 'floor_plan.publish.invalid_polygons' using errcode = '22023';
  end if;

  -- Duplicate space_id check at the RPC layer (DTO catches it client-side too)
  if (select count(distinct (p->>'space_id')) <> count(*)
        from jsonb_array_elements(v_draft.polygons) p) then
    raise exception 'floor_plan.publish.duplicate_space_id' using errcode = '22023';
  end if;

  -- Verify every space_id is a child of this floor in this tenant
  if exists (
    select 1 from jsonb_array_elements(v_draft.polygons) p
     where not exists (
       select 1 from public.spaces s
        where s.id = (p->>'space_id')::uuid
          and s.tenant_id = v_tenant_id
          and s.parent_id = v_floor_id
     )
  ) then
    raise exception 'floor_plan.publish.polygon_not_child' using errcode = '22023';
  end if;

  -- 1. Snapshot the current published state (for rollback)
  select image_url, width_px, height_px, labels
    into v_prev_image, v_prev_w, v_prev_h, v_prev_labels
    from public.floor_plans
   where space_id = v_floor_id;

  select coalesce(
           jsonb_agg(jsonb_build_object(
             'space_id', s.id,
             'points',   s.floor_plan_polygon->'points',
             'render_hint', s.floor_plan_render_hint
           )),
           '[]'::jsonb
         )
    into v_prev_polygons
    from public.spaces s
   where s.tenant_id = v_tenant_id
     and s.parent_id = v_floor_id
     and s.floor_plan_polygon is not null;

  insert into public.floor_plan_publish_history
    (tenant_id, floor_space_id, image_url, width_px, height_px, labels, polygons, published_by, published_at)
  values
    (v_tenant_id, v_floor_id, v_prev_image, v_prev_w, v_prev_h,
     coalesce(v_prev_labels, '[]'::jsonb), v_prev_polygons, v_draft.created_by, now())
  returning id into v_history_id;

  -- 2. Upsert canonical floor_plans row
  insert into public.floor_plans (tenant_id, space_id, image_url, width_px, height_px, labels)
  values (v_tenant_id, v_floor_id, v_draft.image_url, v_draft.width_px, v_draft.height_px,
          coalesce(v_draft.labels, '[]'::jsonb))
  on conflict (space_id) do update
    set image_url  = excluded.image_url,
        width_px   = excluded.width_px,
        height_px  = excluded.height_px,
        labels     = excluded.labels,
        updated_at = now();

  -- 3. Collect space_ids referenced in the draft
  select coalesce(array_agg((p->>'space_id')::uuid), '{}'::uuid[])
    into v_space_ids
    from jsonb_array_elements(v_draft.polygons) p;

  -- 4. Detach orphans (spaces previously had a polygon on this floor but aren't in the new draft)
  update public.spaces
     set floor_plan_polygon = null,
         floor_plan_render_hint = 'default'
   where tenant_id = v_tenant_id
     and parent_id = v_floor_id
     and floor_plan_polygon is not null
     and id <> all(v_space_ids);

  -- 5. Apply new polygons. Re-wrap into {points:[…]} shape per CHECK constraint.
  for v_polygon in select jsonb_array_elements(v_draft.polygons) loop
    update public.spaces
       set floor_plan_polygon = jsonb_build_object('points', v_polygon->'points'),
           floor_plan_render_hint = coalesce(v_polygon->>'render_hint', 'default')
     where id = (v_polygon->>'space_id')::uuid
       and tenant_id = v_tenant_id
       and parent_id = v_floor_id;
  end loop;

  -- 6. Audit (correct audit_events shape per 00019)
  insert into public.audit_events
    (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
  values
    (v_tenant_id, 'floor_plan.published', 'floor_plan', v_floor_id, v_draft.created_by,
     jsonb_build_object(
       'draft_id', p_draft_id,
       'history_id', v_history_id,
       'polygon_count', jsonb_array_length(v_draft.polygons)
     ));

  -- 7. Draft already deleted at the top via DELETE ... RETURNING *.

  return jsonb_build_object('history_id', v_history_id);
end;
$$;

revoke all on function public.publish_floor_plan_draft(uuid) from public;
grant execute on function public.publish_floor_plan_draft(uuid) to authenticated;

notify pgrst, 'reload schema';
```

Note: this RPC depends on `floor_plan_publish_history` which lands in A.5. The migration applies cleanly without the table because PL/pgSQL bodies are parsed lazily, but the *first call* of the function will fail until A.5 applies. Implementer must apply A.5 before any smoke test invokes publish.

- [ ] **Step 2: Apply + commit**

```bash
pnpm db:reset
git add supabase/migrations/00370_publish_floor_plan_draft_rpc.sql
git commit -m "feat(floor-plan): 00370 publish_floor_plan_draft RPC (atomic + audited + snapshotted)"
```

### Task A.5: Migration 00371 — `floor_plan_publish_history` table

**Files:**
- Create: `supabase/migrations/00371_floor_plan_publish_history.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00371_floor_plan_publish_history.sql
-- One snapshot per publish. Enables "Restore previous publish" admin action.
-- Retention: app-level prunes to last N=5 per floor (UI surfaces all of them).

create table if not exists public.floor_plan_publish_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  floor_space_id uuid not null references public.spaces(id),
  image_url text,
  width_px int,
  height_px int,
  labels jsonb not null default '[]'::jsonb,
  polygons jsonb not null default '[]'::jsonb,
  published_by uuid references public.users(id),
  published_at timestamptz not null default now()
);

alter table public.floor_plan_publish_history enable row level security;

-- READ-ONLY policy for authenticated users. INSERTs come from the security-definer
-- publish RPC, which bypasses RLS. No tenant role should write directly to history.
drop policy if exists "tenant_isolation" on public.floor_plan_publish_history;
create policy "tenant_isolation_read" on public.floor_plan_publish_history
  for select
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_floor_plan_publish_history_floor
  on public.floor_plan_publish_history (floor_space_id, published_at desc);

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply + commit**

```bash
pnpm db:reset
git add supabase/migrations/00371_floor_plan_publish_history.sql
git commit -m "feat(floor-plan): 00371 publish history table for rollback"
```

### Task A.6: Migration 00372 — Storage bucket + full RLS

**Files:**
- Create: `supabase/migrations/00372_floor_plans_storage_bucket.sql`

The original plan had only an INSERT policy and made the bucket fully public. This is wrong: admins must be able to replace (UPDATE) or remove (DELETE) their own uploads, and public reads on a tenant-prefixed path leak cross-tenant URLs. Make the bucket private; read is allowed via signed URLs or authenticated session.

- [ ] **Step 1: Write the migration**

```sql
-- 00372_floor_plans_storage_bucket.sql
-- Private bucket, tenant-prefixed paths, RLS-enforced on every action.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('floor-plans', 'floor-plans', false, 10485760,
        array['image/png','image/jpeg','image/webp','image/svg+xml']::text[])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "floor_plans_tenant_insert" on storage.objects;
create policy "floor_plans_tenant_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'floor-plans'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists "floor_plans_tenant_update" on storage.objects;
create policy "floor_plans_tenant_update"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'floor-plans'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists "floor_plans_tenant_delete" on storage.objects;
create policy "floor_plans_tenant_delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'floor-plans'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists "floor_plans_tenant_select" on storage.objects;
create policy "floor_plans_tenant_select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'floor-plans'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );
```

Note: bucket is **private**. Frontend uses `supabaseClient.storage.from('floor-plans').createSignedUrl(path, 3600)` to get a temporary view URL after upload (one-hour TTL is plenty for the designer + booking session).

- [ ] **Step 2: Apply + commit**

```bash
pnpm db:reset
git add supabase/migrations/00372_floor_plans_storage_bucket.sql
git commit -m "feat(floor-plan): 00372 private storage bucket + tenant-scoped RLS (insert/update/delete/select)"
```

### Task A.7: TS permission catalog — single `floor_plans.admin` key

**Files:**
- Modify: `packages/shared/src/permissions.ts`
- Modify: `packages/shared/src/permission-role-defaults.ts` (if it exists; otherwise the file the role-defaults SoT actually lives in — search `grep -n "rooms.admin" packages/shared/src`)

Drop the original three-key split. Use one key matching the existing `rooms.admin` / `criteria_sets.admin` shape. There is **no `permission_catalog` SQL table** in this schema — TS is the only SoT, enforced by the existing `permission-catalog.spec.ts` CI gate.

- [ ] **Step 1: Add `floor_plans.admin` to the TS catalog**

In `packages/shared/src/permissions.ts`, find the existing `rooms.admin` entry. Add a sibling:

```ts
'floor_plans.admin': {
  description: 'Manage floor plans: open the designer, edit drafts, publish, delete.',
  category: 'floor_plans',
},
```

If the file uses a different shape (e.g. flat tuple list), mirror what's there.

- [ ] **Step 2: Add to role defaults**

Wherever `rooms.admin` is granted to default roles (likely `Workplace Admin` and any `Locations Admin`), add `floor_plans.admin` next to it.

- [ ] **Step 3: Run the catalog CI gate**

```bash
pnpm --filter @prequest/shared test
pnpm --filter @prequest/api test permission-catalog
```
All green. Orphan-key test must report zero orphans.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/permissions.ts packages/shared/src/permission-role-defaults.ts
git commit -m "feat(floor-plan): register floor_plans.admin in TS permission catalog"
```

### Task A.8: Push migrations to remote

**Files:** none

- [ ] **Step 1: Push (preferred)**

```bash
pnpm db:push
```

- [ ] **Step 2: Fallback if `db:push` fails (per memory `supabase_remote_push`)**

```bash
for f in supabase/migrations/0036{7,8,9}_*.sql supabase/migrations/0037{0,1,2}_*.sql; do
  PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
    -v ON_ERROR_STOP=1 -f "$f"
done
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -c "notify pgrst, 'reload schema';"
```

- [ ] **Step 3: Verify on remote**

```bash
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "
  select tablename from pg_tables where tablename in ('floor_plan_drafts','floor_plan_publish_history');
  select proname from pg_proc where proname = 'publish_floor_plan_draft';
  select column_name from information_schema.columns where table_name = 'spaces' and column_name = 'floor_plan_render_hint';
"
```
Expected: 2 tables, 1 function, 1 column.

- [ ] **Step 4: Save the new memory entry**

Create `~/.claude/projects/-Users-x-Desktop-XPQT/memory/feedback_db_push_floor_plan.md` mirroring `feedback_db_push_booking_modal`. Add a line to `MEMORY.md`.

### Task A.9: Backend module + draft CRUD + publish + optimistic locking

**Files:**
- Create: `apps/api/src/modules/floor-plan/floor-plan.module.ts`
- Create: `apps/api/src/modules/floor-plan/floor-plan.controller.ts`
- Create: `apps/api/src/modules/floor-plan/floor-plan-admin.controller.ts`
- Create: `apps/api/src/modules/floor-plan/floor-plan.service.ts`
- Create: `apps/api/src/modules/floor-plan/floor-plan-draft.service.ts`
- Create: `apps/api/src/modules/floor-plan/dto/polygon.dto.ts`
- Create: `apps/api/src/modules/floor-plan/dto/update-draft.dto.ts`
- Create: `apps/api/src/modules/floor-plan/dto/get-draft.dto.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Module file**

```ts
// apps/api/src/modules/floor-plan/floor-plan.module.ts
import { Module } from '@nestjs/common';
import { FloorPlanController } from './floor-plan.controller';
import { FloorPlanAdminController } from './floor-plan-admin.controller';
import { FloorPlanService } from './floor-plan.service';
import { FloorPlanDraftService } from './floor-plan-draft.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [FloorPlanController, FloorPlanAdminController],
  providers: [FloorPlanService, FloorPlanDraftService],
  exports: [FloorPlanService],
})
export class FloorPlanModule {}
```

- [ ] **Step 2: DTOs (Zod)**

```ts
// apps/api/src/modules/floor-plan/dto/polygon.dto.ts
import { z } from 'zod';

export const PolygonPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

// space_id may be empty for unlinked polygons in a draft. Publish RPC rejects empty.
export const PolygonSchema = z.object({
  space_id: z.union([z.string().uuid(), z.literal('')]),
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
}).superRefine((val, ctx) => {
  // Duplicate space_id rejection (only checks non-empty space_ids; '' is allowed for unlinked drafts).
  if (val.polygons) {
    const seen = new Set<string>();
    for (const p of val.polygons) {
      if (!p.space_id) continue;
      if (seen.has(p.space_id)) {
        ctx.addIssue({ code: 'custom', path: ['polygons'], message: `Duplicate space_id: ${p.space_id}` });
        return;
      }
      seen.add(p.space_id);
    }
  }
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

- [ ] **Step 3: Draft service (with optimistic locking + tenant filters)**

```ts
// apps/api/src/modules/floor-plan/floor-plan-draft.service.ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppErrors, throwZodError } from '../../common/errors/app-error';
import { UpdateDraftSchema } from './dto/update-draft.dto';
import type { DraftResponse } from './dto/get-draft.dto';
import type { TenantContext } from '../tenant/tenant-context'; // adjust to actual import

@Injectable()
export class FloorPlanDraftService {
  constructor(private readonly supabase: SupabaseService) {}

  async getOrCreate(floorSpaceId: string, userId: string, tenantId: string): Promise<DraftResponse> {
    const client = this.supabase.client();

    const { data: existing } = await client
      .from('floor_plan_drafts')
      .select('*')
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (existing) return existing as DraftResponse;

    // Seed from published state
    const { data: floor } = await client
      .from('floor_plans')
      .select('image_url, width_px, height_px, labels')
      .eq('space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const { data: spaces } = await client
      .from('spaces')
      .select('id, floor_plan_polygon, floor_plan_render_hint')
      .eq('parent_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .not('floor_plan_polygon', 'is', null);

    const seedPolygons = (spaces ?? []).map((s) => ({
      space_id: s.id,
      points: (s.floor_plan_polygon as { points: unknown[] }).points,
      render_hint: s.floor_plan_render_hint ?? 'default',
    }));

    const { data: created, error } = await client
      .from('floor_plan_drafts')
      .insert({
        tenant_id: tenantId,
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

  /** Optimistic locking: caller passes ifMatch=updated_at from their last GET. */
  async update(
    floorSpaceId: string,
    tenantId: string,
    ifMatch: string | undefined,
    body: unknown,
  ): Promise<DraftResponse> {
    const parsed = UpdateDraftSchema.safeParse(body);
    if (!parsed.success) throwZodError(parsed.error);

    const client = this.supabase.client();

    // Validate every polygon's space_id is in this floor's children (this tenant)
    if (parsed.data.polygons && parsed.data.polygons.length > 0) {
      const ids = parsed.data.polygons.map((p) => p.space_id);
      const { data: spaces } = await client
        .from('spaces')
        .select('id, parent_id')
        .in('id', ids)
        .eq('tenant_id', tenantId);
      const valid = new Set((spaces ?? []).filter((s) => s.parent_id === floorSpaceId).map((s) => s.id));
      const invalid = ids.filter((id) => !valid.has(id));
      if (invalid.length > 0) {
        throw AppErrors.validationFailed('floor_plan.draft.invalid_polygons', { spaceIds: invalid });
      }
    }

    // Atomic CAS: single UPDATE with updated_at filter. If ifMatch is provided
    // and doesn't match, the WHERE matches 0 rows → we know it's stale.
    // Without ifMatch (rare — only initial seed callers should skip it), we
    // unconditionally update and accept last-writer-wins for that one call.
    let query = client
      .from('floor_plan_drafts')
      .update({ ...parsed.data })
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId);
    if (ifMatch) query = query.eq('updated_at', ifMatch);

    const { data, error } = await query.select('*').maybeSingle();
    if (error) throw AppErrors.server('floor_plan.draft.update_failed');

    if (!data) {
      // Either the row doesn't exist OR our ifMatch was stale. Disambiguate.
      const { data: current } = await client
        .from('floor_plan_drafts')
        .select('updated_at')
        .eq('floor_space_id', floorSpaceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!current) throw AppErrors.notFoundWithCode('floor_plan.draft.not_found');
      throw AppErrors.conflict('floor_plan.draft.stale_update', {
        serverVersion: current.updated_at,
      });
    }
    return data as DraftResponse;
  }

  async discard(floorSpaceId: string, tenantId: string): Promise<void> {
    const client = this.supabase.client();
    const { error } = await client
      .from('floor_plan_drafts')
      .delete()
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId);
    if (error) throw AppErrors.server('floor_plan.draft.discard_failed');
  }
}
```

If `AppErrors.conflict` doesn't exist, mirror an existing pattern (e.g. `AppErrors.validation`). The 409 status mapping must be wired in the global error filter — verify it is.

- [ ] **Step 4: Plan service (read + publish)**

```ts
// apps/api/src/modules/floor-plan/floor-plan.service.ts
import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppErrors } from '../../common/errors/app-error';

@Injectable()
export class FloorPlanService {
  constructor(private readonly supabase: SupabaseService) {}

  async getPublished(floorSpaceId: string, tenantId: string) {
    const client = this.supabase.client();
    const { data: floor } = await client
      .from('floor_plans')
      .select('*')
      .eq('space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!floor) return null;

    const { data: spaces } = await client
      .from('spaces')
      .select('id, name, type, capacity, amenities, floor_plan_polygon, floor_plan_render_hint')
      .eq('parent_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .not('floor_plan_polygon', 'is', null);

    // floor.image_url is a STORAGE PATH (not a URL). Resolve to a fresh signed URL
    // here so consumers don't see stale signatures. 1h TTL is plenty for a page load
    // + reasonable user session; clients re-fetch via React Query on revisit.
    const signedImageUrl = await this.signFloorPlanImage(floor.image_url);

    return { floor: { ...floor, image_url: signedImageUrl }, spaces: spaces ?? [] };
  }

  /** Resolve a storage path stored in floor_plans.image_url into a fresh signed URL. */
  private async signFloorPlanImage(pathOrNull: string | null): Promise<string | null> {
    if (!pathOrNull) return null;
    // If somehow a full URL is stored (legacy), pass through.
    if (pathOrNull.startsWith('http://') || pathOrNull.startsWith('https://')) return pathOrNull;
    const client = this.supabase.client();
    const { data } = await client.storage.from('floor-plans').createSignedUrl(pathOrNull, 3600);
    return data?.signedUrl ?? null;
  }

  async publish(floorSpaceId: string, tenantId: string) {
    const client = this.supabase.client();
    const { data: draft } = await client
      .from('floor_plan_drafts')
      .select('id, image_url, width_px, height_px, polygons')
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!draft) throw AppErrors.notFoundWithCode('floor_plan.draft.not_found');

    // Server-side preflight — fail fast with structured errors before invoking RPC.
    if (!draft.image_url || !draft.width_px || !draft.height_px) {
      throw AppErrors.validationFailed('floor_plan.publish.image_required');
    }
    const polygons = draft.polygons as Array<{ space_id: string }>;
    const unlinked = polygons.filter((p) => !p.space_id);
    if (unlinked.length > 0) {
      throw AppErrors.validationFailed('floor_plan.publish.unlinked_polygons', { count: unlinked.length });
    }

    const { data, error } = await client.rpc('publish_floor_plan_draft', { p_draft_id: draft.id });
    if (error) {
      // Translate known PG error codes; everything else is server-class.
      const code = (error as any).code ?? '';
      if (code === '23502') throw AppErrors.validationFailed('floor_plan.publish.image_required');
      if (code === '22023') throw AppErrors.validationFailed('floor_plan.publish.invalid_polygons');
      if (code === '42501') throw AppErrors.forbidden('floor_plan.publish.cross_tenant');
      if (code === 'P0002') throw AppErrors.notFoundWithCode('floor_plan.draft.not_found');
      throw AppErrors.server('floor_plan.publish_failed');
    }
    return data as { history_id: string };
  }

  /** Direct query — no RPC needed (plan review I11). */
  async listForAdmin(tenantId: string) {
    const client = this.supabase.client();
    const { data, error } = await client
      .from('spaces')
      .select(`
        id, name,
        parent:parent_id (id, name),
        floor_plans (space_id, updated_at)
      `)
      .eq('type', 'floor')
      .eq('tenant_id', tenantId)
      .order('name');
    if (error) throw AppErrors.server('floor_plan.list_failed');
    return (data ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      building_name: row.parent?.name ?? '—',
      has_plan: Array.isArray(row.floor_plans) ? row.floor_plans.length > 0 : !!row.floor_plans,
      last_published_at: (Array.isArray(row.floor_plans) ? row.floor_plans[0]?.updated_at : row.floor_plans?.updated_at) ?? null,
    }));
  }

  async listPublishHistory(floorSpaceId: string, tenantId: string) {
    const client = this.supabase.client();
    const { data } = await client
      .from('floor_plan_publish_history')
      .select('id, published_at, published_by, image_url, width_px, height_px, polygons, labels')
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .order('published_at', { ascending: false })
      .limit(20);
    return data ?? [];
  }
}
```

- [ ] **Step 5: Per-floor controller (single `floor_plans.admin` permission)**

```ts
// apps/api/src/modules/floor-plan/floor-plan.controller.ts
import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionGuard, RequirePermission } from '../auth/permission.guard';
import { FloorPlanService } from './floor-plan.service';
import { FloorPlanDraftService } from './floor-plan-draft.service';

type ReqUser = { user: { id: string; tenant_id: string } };

@UseGuards(AuthGuard)
@Controller('floors/:floorSpaceId/plan')
export class FloorPlanController {
  constructor(
    private readonly plan: FloorPlanService,
    private readonly draft: FloorPlanDraftService,
  ) {}

  @Get()
  async getPublished(@Param('floorSpaceId') id: string, @Req() req: ReqUser) {
    return this.plan.getPublished(id, req.user.tenant_id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.admin')
  @Get('draft')
  async getDraft(@Param('floorSpaceId') id: string, @Req() req: ReqUser) {
    return this.draft.getOrCreate(id, req.user.id, req.user.tenant_id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.admin')
  @Patch('draft')
  async updateDraft(
    @Param('floorSpaceId') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
    @Req() req: ReqUser,
  ) {
    return this.draft.update(id, req.user.tenant_id, ifMatch, body);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.admin')
  @Delete('draft')
  async discardDraft(@Param('floorSpaceId') id: string, @Req() req: ReqUser) {
    await this.draft.discard(id, req.user.tenant_id);
    return { ok: true };
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.admin')
  @Post('draft/publish')
  async publish(@Param('floorSpaceId') id: string, @Req() req: ReqUser) {
    return this.plan.publish(id, req.user.tenant_id);
  }

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.admin')
  @Get('history')
  async history(@Param('floorSpaceId') id: string, @Req() req: ReqUser) {
    return this.plan.listPublishHistory(id, req.user.tenant_id);
  }
}
```

- [ ] **Step 6: Admin index controller (separate path to avoid collision)**

```ts
// apps/api/src/modules/floor-plan/floor-plan-admin.controller.ts
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { PermissionGuard, RequirePermission } from '../auth/permission.guard';
import { FloorPlanService } from './floor-plan.service';

type ReqUser = { user: { id: string; tenant_id: string } };

@UseGuards(AuthGuard)
@Controller('admin/floor-plans-index')
export class FloorPlanAdminController {
  constructor(private readonly plan: FloorPlanService) {}

  @UseGuards(PermissionGuard)
  @RequirePermission('floor_plans.admin')
  @Get()
  async indexForAdmin(@Req() req: ReqUser) {
    return this.plan.listForAdmin(req.user.tenant_id);
  }
}
```

- [ ] **Step 7: Register module**

Add `FloorPlanModule` to `imports` in `apps/api/src/app.module.ts`.

- [ ] **Step 8: Build + commit**

```bash
pnpm --filter @prequest/api build
```
Clean. Then:

```bash
git add apps/api/src/modules/floor-plan apps/api/src/app.module.ts
git commit -m "feat(floor-plan): backend module + draft CRUD + publish + If-Match locking + history list"
```

### Task A.10: Cross-tenant + RLS spec tests

**Files:**
- Create: `apps/api/src/modules/floor-plan/floor-plan-draft.service.spec.ts`
- Create: `apps/api/src/modules/floor-plan/publish.spec.ts`
- Modify: `apps/api/src/modules/cross-tenant-fk-leak-writes.spec.ts` (add floor_plan_drafts, floor_plan_publish_history)

- [ ] **Step 1: Draft service spec**

Cover: create-on-first-get, idempotent get, update with valid polygon, reject polygon with `space_id` from another floor, reject polygon with `space_id` from another tenant, reject duplicate `space_id`, 409 on stale `If-Match`, 200 on missing `If-Match` (no precondition), discard deletes the row.

Reuse existing test helpers (search `grep -rn "createTestSupabase" apps/api/src | head -5`). If none exist, write a thin helper in `apps/api/src/test-utils/supabase-test-helpers.ts` that creates a Supabase admin client bound to a unique tenant per test.

- [ ] **Step 2: Publish RPC spec**

Cover: publish writes audit_events row with `event_type='floor_plan.published'` + `entity_type='floor_plan'` + `entity_id=floorSpaceId`, publish writes a history row with the prior state, publish wipes orphan polygons, publish updates published polygons to canonical `{points:[…]}` shape, publish deletes the draft, publish twice → second call 404 (draft gone), publish from wrong tenant → 42501 error, publish with polygon referencing a space deleted between draft and publish → RPC ignores it silently (document this as known limitation, no smoke probe rejects it — covered by I4 probe 14 below).

- [ ] **Step 3: Cross-tenant harness**

Add `floor_plan_drafts` and `floor_plan_publish_history` to whichever list the harness iterates over. Confirm the generated tests pass.

- [ ] **Step 4: Run + commit**

```bash
pnpm --filter @prequest/api test floor-plan
pnpm --filter @prequest/api test cross-tenant
```
All green.

```bash
git add apps/api/src/modules/floor-plan apps/api/src/modules/cross-tenant-fk-leak-writes.spec.ts
git commit -m "test(floor-plan): draft service + publish RPC + cross-tenant coverage"
```

### Task A.11: smoke:floor-plans script

**Files:**
- Create: `apps/api/scripts/smoke-floor-plans.mjs`
- Modify: `package.json` (root) — `"smoke:floor-plans": "node apps/api/scripts/smoke-floor-plans.mjs"`
- Modify: `CLAUDE.md` — add smoke gate section

- [ ] **Step 1: Read the work-orders smoke**

```bash
cat apps/api/scripts/smoke-work-orders.mjs
```
Match its style: mint Admin JWT, hit live API, exit non-zero on regression.

- [ ] **Step 2: Write the script with 20 probes**

Required probes (number → behavior):
1. `GET /api/floors/<fake-uuid>/plan` → 404 / null.
2. `GET /api/floors/<real-floor>/plan/draft` → 200 (creates draft).
3. `PATCH /api/floors/<real-floor>/plan/draft` with valid polygon → 200.
4. `POST /api/floors/<real-floor>/plan/draft/publish` → 200 with `{history_id}`.
5. `GET /api/floors/<real-floor>/plan` → 200; `floor.image_url` is a fresh signed URL (starts with `https://*.supabase.co`), polygon in canonical `{points:[…]}` shape.
6. `GET /api/floors/<real-floor>/plan/history` → 200 with one row.
7. Validation: PATCH polygon with 1 point → 422.
8. PATCH polygon with empty `space_id` → 200 (draft tolerates unlinked); publish with same draft → 422 `floor_plan.publish.unlinked_polygons`.
9. Cross-tenant: tenant B reads tenant A's draft → 404 / RLS hides.
10. Permission: user without `floor_plans.admin` calls PATCH → 403.
11. PATCH polygon with `space_id` from another tenant → 422 (preflight).
12. PATCH polygon with `space_id` not a child of this floor → 422.
13. PATCH with duplicate `space_id` → 422 (DTO superRefine).
14. Publish when one polygon's `space_id` was just hard-deleted → 422 `polygon_not_child` (RPC validation, codex IMPORTANT — was silently dropped in v1).
15. Publish twice in quick succession on the same draft_id → first 200, second 404. Verified by hitting `/publish` twice with the same draft from two clients in parallel.
16. Concurrent PATCH atomic CAS: client A reads (updated_at=T0), client B PATCHes (server now T1), client A PATCHes with `If-Match: T0` → 409.
17. PATCH with polygon points outside image bounds → 422 (DTO superRefine requires image dimensions set, bound-checks points).
18. Publish with no image uploaded (image_url=null) → 422 `image_required` (codex IMPORTANT).
19. Storage signed URL refresh: GET plan immediately, save the signed URL, wait 3700s (or override TTL to 5s for the test), GET plan again — the returned URL differs and resolves (codex CRITICAL #4).
20. `floor_plan_publish_history`: authenticated user attempts INSERT directly via REST → 403/RLS-blocked (history is RPC-write only).

Exit 0 on all-pass, exit 1 on any regression.

- [ ] **Step 3: Add CLAUDE.md section**

Append under the existing "Smoke gate" section a new paragraph for `pnpm smoke:floor-plans` mirroring the work-orders language.

- [ ] **Step 4: Run + commit**

```bash
# terminal 1
pnpm dev:api
# terminal 2
pnpm smoke:floor-plans
```
Exit 0.

```bash
git add apps/api/scripts/smoke-floor-plans.mjs package.json CLAUDE.md
git commit -m "test(floor-plan): smoke harness with 20 probes (gate before claim-done)"
```

**Phase A done.** Backend draft CRUD + publish RPC works end-to-end against the real DB. No frontend yet. 20 smoke probes green. Cross-tenant harness covers two new tables.

---

# Phase B — Designer Canvas

Goal: ship the admin-facing designer at `/admin/floor-plans/:floorSpaceId`. End state: admin can upload an image, draw polygons with all 5 in-scope tools (select, draw-polygon, draw-rectangle, stamp-seat, image-upload), autosave to the draft (with optimistic locking → conflict prompt on 409), see issues in the left rail. Publishing button exists; the diff dialog is wired in Phase C.

Take-over flow is deferred to Plan 2 / followups per plan review I12. Two admins on the same draft: last save wins unless the second admin loaded after the first's autosave (in which case 409 surfaces).

Before starting frontend tasks: per memory `feedback_frontend_skill_not_antd_agent`, frontend work invokes `Skill('frontend-design:frontend-design')` for design polish. The implementation specifics in the tasks below are non-negotiable (shadcn primitives, autosave shape, optimistic locking); the frontend-design skill is for finish polish (motion, spacing, copy).

### Task B.1: React Query keys + hooks (usePageQuery + If-Match)

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
    floor_plan_polygon: { points: Point[] };  // canonical shape — no fallback
    floor_plan_render_hint: RenderHint;
  }>;
};

export type PublishHistoryEntry = {
  id: string;
  published_at: string;
  published_by: string | null;
  image_url: string | null;
  width_px: number | null;
  height_px: number | null;
  polygons: Polygon[];
  labels: Label[];
};
```

- [ ] **Step 2: Keys**

```ts
// apps/web/src/api/floor-plans/keys.ts
export const floorPlanKeys = {
  all: ['floor-plans'] as const,
  adminIndex: () => [...floorPlanKeys.all, 'admin-index'] as const,
  floor: (floorSpaceId: string) => [...floorPlanKeys.all, 'floor', floorSpaceId] as const,
  floorDraft: (floorSpaceId: string) => [...floorPlanKeys.floor(floorSpaceId), 'draft'] as const,
  floorPublished: (floorSpaceId: string) => [...floorPlanKeys.floor(floorSpaceId), 'published'] as const,
  floorHistory: (floorSpaceId: string) => [...floorPlanKeys.floor(floorSpaceId), 'history'] as const,
};
```

- [ ] **Step 3: Hooks (with `usePageQuery` for primary fetches and If-Match on PATCH)**

```ts
// apps/web/src/api/floor-plans/hooks.ts
import { useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api-fetch';
import { withErrorHandling, handleMutationError } from '../../lib/errors';
import { usePageQuery } from '../../lib/use-page-query';
import { floorPlanKeys } from './keys';
import type { DraftResponse, PublishedFloorPlan, PublishHistoryEntry } from './types';

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
  return usePageQuery(queryOptions({
    queryKey: floorPlanKeys.floorDraft(floorSpaceId),
    queryFn: async () => apiFetch<DraftResponse>(`/api/floors/${floorSpaceId}/plan/draft`),
    staleTime: 0,
  }));
}

export function useFloorPlanHistory(floorSpaceId: string) {
  return useQueryClient ? null : null; // placeholder, replaced below
}

/** Update draft with optimistic locking. Pass the last seen updated_at as `ifMatch`. */
export function useUpdateDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ patch, ifMatch }: { patch: Partial<DraftResponse>; ifMatch: string }) =>
      apiFetch<DraftResponse>(`/api/floors/${floorSpaceId}/plan/draft`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
        headers: { 'If-Match': ifMatch },
      }),
    onMutate: async ({ patch }) => {
      await qc.cancelQueries({ queryKey: floorPlanKeys.floorDraft(floorSpaceId) });
      const previous = qc.getQueryData<DraftResponse>(floorPlanKeys.floorDraft(floorSpaceId));
      if (previous) {
        qc.setQueryData<DraftResponse>(floorPlanKeys.floorDraft(floorSpaceId), {
          ...previous, ...patch,
        });
      }
      return { previous };
    },
    onSuccess: (data) => {
      // Sync server's authoritative updated_at into cache
      qc.setQueryData<DraftResponse>(floorPlanKeys.floorDraft(floorSpaceId), data);
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(floorPlanKeys.floorDraft(floorSpaceId), ctx.previous);
      handleMutationError(error, { actionTitle: "Couldn't save floor plan changes" });
    },
  });
}

export function useDiscardDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => apiFetch(`/api/floors/${floorSpaceId}/plan/draft`, { method: 'DELETE' }),
    onSuccess: () => qc.removeQueries({ queryKey: floorPlanKeys.floorDraft(floorSpaceId) }),
    ...withErrorHandling({ actionTitle: "Couldn't discard the draft" }),
  });
}

export function usePublishDraft(floorSpaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiFetch<{ history_id: string }>(`/api/floors/${floorSpaceId}/plan/draft/publish`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: floorPlanKeys.floor(floorSpaceId) });
    },
    ...withErrorHandling({ actionTitle: "Couldn't publish the floor plan" }),
  });
}
```

If `useFloorPlanHistory` is needed it's a plain `useQuery` — wire it in C.2 when we add the "Restore previous publish" UI. Leave out for now.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/api/floor-plans
git commit -m "feat(floor-plan): React Query hooks (usePageQuery + If-Match optimistic locking)"
```

### Task B.2: `<FloorPlanCanvas>` view-only renderer

**Files:**
- Create: `apps/web/src/components/floor-plan/floor-plan-canvas.tsx`
- Create: `apps/web/src/components/floor-plan/polygon-shape.tsx`
- Create: `apps/web/src/components/floor-plan/lib/polygon-geometry.ts`
- Create: `apps/web/src/components/floor-plan/lib/availability-state.ts`
- Create: `apps/web/src/components/floor-plan/__tests__/polygon-geometry.test.ts`

- [ ] **Step 1: Geometry + test**

```ts
// apps/web/src/components/floor-plan/lib/polygon-geometry.ts
import type { Point } from '../../../api/floor-plans/types';

export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area / 2);
}

export function polygonCentroid(points: Point[]): Point {
  let x = 0, y = 0, twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
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
  it('area of 10x10 square is 100', () => expect(polygonArea(square)).toBe(100));
  it('centroid of square is (5,5)', () => {
    const c = polygonCentroid(square);
    expect(c.x).toBeCloseTo(5); expect(c.y).toBeCloseTo(5);
  });
  it('svg path closes', () => expect(polygonToSvgPath(square)).toBe('M 0 0 L 10 0 L 10 10 L 0 10 Z'));
});
```

- [ ] **Step 2: Availability state palette**

```ts
// apps/web/src/components/floor-plan/lib/availability-state.ts
export type AvailabilityState = 'available' | 'partial' | 'booked' | 'mine' | 'pending' | 'not_bookable';

export const STATE_PALETTE: Record<AvailabilityState, { outline: string; fill: string; dot: string }> = {
  available:    { outline: '#86efac', fill: '#f0fdf4',                  dot: '#22c55e' },
  partial:      { outline: '#fcd34d', fill: 'url(#partial-stripes)',     dot: '#84cc16' },
  booked:       { outline: '#fca5a5', fill: '#fef2f2',                  dot: '#ef4444' },
  mine:         { outline: '#60a5fa', fill: '#eff6ff',                  dot: '#3b82f6' },
  pending:      { outline: '#fcd34d', fill: '#fffbeb',                  dot: '#f59e0b' },
  not_bookable: { outline: '#d6d3d1', fill: '#fafaf9',                  dot: '#d6d3d1' },
};
```

- [ ] **Step 3: PolygonShape (canonical points only — no fallback)**

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
          cx={centroid.x} cy={centroid.y} r={11}
          fill={palette.fill} stroke={palette.outline}
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
        fill={palette.fill} stroke={palette.outline}
        strokeWidth={selected ? 2 : 1.5}
      />
      <circle cx={points[0].x + 16} cy={points[0].y + 16} r={5} fill={palette.dot} />
      <text x={centroid.x} y={centroid.y} textAnchor="middle" fontSize={13} fontWeight={500} fill="#1c1917">{name}</text>
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
      <image href={plan.floor.image_url} x="0" y="0" width={plan.floor.width_px} height={plan.floor.height_px} decoding="async" />
      {plan.spaces.map((s) => (
        <PolygonShape
          key={s.id}
          spaceId={s.id}
          points={s.floor_plan_polygon.points}
          renderHint={s.floor_plan_render_hint}
          name={s.name}
          capacity={s.capacity}
          state={stateMap.get(s.id) ?? 'not_bookable'}
          selected={selectedSpaceId === s.id}
          onClick={onSpaceClick}
        />
      ))}
    </svg>
  );
}
```

- [ ] **Step 5: Run + commit**

```bash
pnpm --filter @prequest/web test polygon-geometry
pnpm --filter @prequest/web build
git add apps/web/src/components/floor-plan
git commit -m "feat(floor-plan): FloorPlanCanvas + PolygonShape view-mode renderer (canonical shape only)"
```

### Task B.3: `<ZoomPanLayer>` with scroll/pinch/drag

**Files:**
- Create: `apps/web/src/components/floor-plan/zoom-pan-layer.tsx`

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
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const delta = -e.deltaY * 0.0012;
    setTransform((prev) => {
      const next = Math.min(maxScale, Math.max(minScale, prev.scale * (1 + delta)));
      const ratio = next / prev.scale;
      return {
        scale: next,
        tx: cx - (cx - prev.tx) * ratio,
        ty: cy - (cy - prev.ty) * ratio,
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

Multi-touch pinch lands in Plan 2 with `use-gesture` if mobile QA finds gaps. Pointer Events handle single-touch pan natively.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan/zoom-pan-layer.tsx
git commit -m "feat(floor-plan): ZoomPanLayer (scroll-to-cursor zoom + drag-to-pan)"
```

### Task B.4: Designer shell + state hook + autosave with 409 handling

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx`
- Create: `apps/web/src/components/floor-plan-designer/use-designer-state.ts`
- Create: `apps/web/src/components/floor-plan-designer/types.ts`

- [ ] **Step 1: Types**

```ts
// apps/web/src/components/floor-plan-designer/types.ts
import type { Polygon, Label } from '../../api/floor-plans/types';

export type ToolKind = 'select' | 'draw-polygon' | 'draw-rectangle' | 'stamp-seat' | 'image-upload';

export type DesignerState = {
  draftId: string;
  updatedAt: string;           // server version for If-Match
  imageUrl: string | null;
  widthPx: number | null;
  heightPx: number | null;
  polygons: Polygon[];
  labels: Label[];
  selectedPolygonIndex: number | null;
  activeTool: ToolKind;
  inProgressPolygon: Polygon | null;
};
```

- [ ] **Step 2: State hook (autosave with optimistic lock; 409 → reload prompt)**

```ts
// apps/web/src/components/floor-plan-designer/use-designer-state.ts
import { useReducer, useEffect, useRef } from 'react';
import type { DesignerState, ToolKind } from './types';
import type { DraftResponse, Polygon, Label } from '../../api/floor-plans/types';
import { useUpdateDraft } from '../../api/floor-plans/hooks';
import { toast } from '../../lib/toast';

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
  | { type: 'cancel-drawing' }
  | { type: 'server-sync'; updatedAt: string };

function reducer(state: DesignerState, action: Action): DesignerState {
  switch (action.type) {
    case 'hydrate':
      return {
        draftId: action.draft.id,
        updatedAt: action.draft.updated_at,
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
    case 'server-sync':    return { ...state, updatedAt: action.updatedAt };
  }
}

const INITIAL: DesignerState = {
  draftId: '',
  updatedAt: '',
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
    if (!state.draftId || !state.updatedAt) return;
    const snapshot = JSON.stringify({
      polygons: state.polygons,
      labels: state.labels,
      imageUrl: state.imageUrl,
      widthPx: state.widthPx,
      heightPx: state.heightPx,
    });
    if (snapshot === lastSyncedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      lastSyncedRef.current = snapshot;
      try {
        const data = await updateDraft.mutateAsync({
          patch: {
            polygons: state.polygons,
            labels: state.labels,
            image_url: state.imageUrl,
            width_px: state.widthPx,
            height_px: state.heightPx,
          },
          ifMatch: state.updatedAt,
        });
        dispatch({ type: 'server-sync', updatedAt: data.updated_at });
      } catch (err: any) {
        if (err?.code === 'floor_plan.draft.stale_update' || err?.status === 409) {
          toast.warning('Another change happened', {
            description: 'This draft was modified elsewhere. Reload to see the latest.',
            action: { label: 'Reload', onClick: () => window.location.reload() },
          });
        }
        // other errors handled by mutation's onError
      }
    }, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [state.polygons, state.labels, state.imageUrl, state.widthPx, state.heightPx, state.draftId, state.updatedAt, updateDraft]);

  return { state, dispatch, isSaving: updateDraft.isPending } as const;
}
```

- [ ] **Step 3: Designer shell**

```tsx
// apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useFloorPlanDraft } from '../../api/floor-plans/hooks';
import { useDesignerState } from './use-designer-state';
import { SpacesTree } from './spaces-tree';
import { ToolDock } from './tool-dock';
import { PolygonInspector } from './polygon-inspector';
import { DesignerCanvas } from './designer-canvas';
import { PublishDialog } from './publish-dialog';
import { Button } from '../ui/button';
import { useState } from 'react';
import type { ToolKind } from './types';

type Props = { floorSpaceId: string; floorName: string; backTo: string };

export function FloorPlanDesigner({ floorSpaceId, floorName, backTo }: Props) {
  const draft = useFloorPlanDraft(floorSpaceId);
  const { state, dispatch, isSaving } = useDesignerState(floorSpaceId, draft.data);
  const [publishOpen, setPublishOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const tools: Record<string, ToolKind> = { v: 'select', p: 'draw-polygon', r: 'draw-rectangle', s: 'stamp-seat', i: 'image-upload' };
      const tool = tools[e.key.toLowerCase()];
      if (tool) { dispatch({ type: 'set-tool', tool }); return; }
      if (e.key === 'Enter' && state.inProgressPolygon && state.inProgressPolygon.points.length >= 3) dispatch({ type: 'commit-drawing' });
      if (e.key === 'Escape') dispatch({ type: 'cancel-drawing' });
      if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedPolygonIndex !== null) dispatch({ type: 'remove-polygon', index: state.selectedPolygonIndex });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.inProgressPolygon, state.selectedPolygonIndex]);

  if (draft.isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!draft.data) return <div className="p-6 text-sm text-muted-foreground">No draft.</div>;

  return (
    <div className="flex h-screen w-screen flex-col bg-background">
      {/* custom topbar — designer is shell-exempt per CLAUDE.md */}
      <header className="flex h-12 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-3">
          <Link to={backTo} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-4 w-4" />
            Floor plans
          </Link>
          <span className="text-sm text-muted-foreground">·</span>
          <span className="text-sm font-medium">{floorName}</span>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-full ${isSaving ? 'bg-amber-400' : 'bg-emerald-400'}`} />
            {isSaving ? 'saving…' : 'saved'}
          </span>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setPublishOpen(true)} size="sm">Publish</Button>
        </div>
      </header>

      <div className="grid grid-cols-[240px_1fr_244px] flex-1 overflow-hidden">
        <SpacesTree floorSpaceId={floorSpaceId} state={state} dispatch={dispatch} />
        <div className="relative flex flex-col">
          <ToolDock activeTool={state.activeTool} dispatch={dispatch} />
          <DesignerCanvas state={state} dispatch={dispatch} />
        </div>
        <PolygonInspector floorSpaceId={floorSpaceId} state={state} dispatch={dispatch} />
      </div>

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        floorSpaceId={floorSpaceId}
        draft={draft.data}
      />
    </div>
  );
}
```

The four sub-components (`SpacesTree`, `ToolDock`, `PolygonInspector`, `DesignerCanvas`, `PublishDialog`) are stubbed as empty divs until their respective tasks land. Stub them inline temporarily so this file compiles.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/floor-plan-designer
git commit -m "feat(floor-plan): designer shell + state hook + 409-aware autosave + keyboard (V/P/R/S/I/Enter/Esc/Delete)"
```

### Task B.5: `<SpacesTree>` left rail

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/spaces-tree.tsx`
- Modify (or create): GET `/api/spaces/:id/children` endpoint (see step 2)

- [ ] **Step 1: Component**

```tsx
// apps/web/src/components/floor-plan-designer/spaces-tree.tsx
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api-fetch';
import type { DesignerState } from './types';

type ChildSpace = { id: string; name: string; type: string; capacity: number | null };

type Props = { floorSpaceId: string; state: DesignerState; dispatch: React.Dispatch<any> };

export function SpacesTree({ floorSpaceId, state, dispatch }: Props) {
  const children = useQuery({
    queryKey: ['spaces', 'children', floorSpaceId],
    queryFn: () => apiFetch<ChildSpace[]>(`/api/spaces/${floorSpaceId}/children`),
    staleTime: 60_000,
  });
  const drawnIds = new Set(state.polygons.map((p) => p.space_id).filter(Boolean));

  return (
    <div className="border-r border-border bg-background p-4 overflow-y-auto">
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3">Spaces on this floor</div>
      {(children.data ?? []).map((s) => {
        const isDrawn = drawnIds.has(s.id);
        const idx = state.polygons.findIndex((p) => p.space_id === s.id);
        const selected = idx >= 0 && idx === state.selectedPolygonIndex;
        return (
          <button
            key={s.id}
            onClick={() => dispatch({ type: 'select-polygon', index: idx >= 0 ? idx : null })}
            className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${selected ? 'bg-muted' : 'hover:bg-muted/50'}`}
          >
            <span className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${isDrawn ? 'bg-emerald-400' : 'bg-muted-foreground/30'}`} />
              <span className={isDrawn ? 'text-foreground' : 'text-muted-foreground'}>{s.name}</span>
            </span>
            {s.capacity !== null && <span className="tabular-nums text-xs text-muted-foreground">{s.capacity}</span>}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Add `/spaces/:id/children` if missing**

```bash
grep -rn ":id/children" apps/api/src/modules/space
```

If absent, add to `SpaceController`:
```ts
@Get(':id/children')
async children(@Param('id') id: string, @Req() req: ReqUser) {
  return this.space.listChildren(id, req.user.tenant_id);
}
```
And to `SpaceService`:
```ts
async listChildren(parentId: string, tenantId: string) {
  const { data } = await this.supabase.client()
    .from('spaces')
    .select('id, name, type, capacity')
    .eq('parent_id', parentId)
    .eq('tenant_id', tenantId)
    .order('name');
  return data ?? [];
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/spaces-tree.tsx apps/api/src/modules/space
git commit -m "feat(floor-plan): SpacesTree + GET /spaces/:id/children"
```

### Task B.6: `<ToolDock>` with Lucide icons

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/tool-dock.tsx`

- [ ] **Step 1: Component**

```tsx
// apps/web/src/components/floor-plan-designer/tool-dock.tsx
import { MousePointer2, Pentagon, Square, Circle, Image as ImageIcon, type LucideIcon } from 'lucide-react';
import type { ToolKind } from './types';

const TOOLS: { kind: ToolKind; label: string; shortcut: string; Icon: LucideIcon }[] = [
  { kind: 'select',         label: 'Select',       shortcut: 'V', Icon: MousePointer2 },
  { kind: 'draw-polygon',   label: 'Draw polygon', shortcut: 'P', Icon: Pentagon },
  { kind: 'draw-rectangle', label: 'Rectangle',    shortcut: 'R', Icon: Square },
  { kind: 'stamp-seat',     label: 'Stamp seat',   shortcut: 'S', Icon: Circle },
  { kind: 'image-upload',   label: 'Image',        shortcut: 'I', Icon: ImageIcon },
];

type Props = { activeTool: ToolKind; dispatch: React.Dispatch<any> };

export function ToolDock({ activeTool, dispatch }: Props) {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-background px-3 py-2">
      {TOOLS.map((t) => (
        <button
          key={t.kind}
          title={`${t.label} (${t.shortcut})`}
          aria-label={t.label}
          onClick={() => dispatch({ type: 'set-tool', tool: t.kind })}
          className={`flex h-9 w-9 items-center justify-center rounded-md ${activeTool === t.kind ? 'bg-foreground text-background' : 'hover:bg-muted'}`}
        >
          <t.Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
```

Parking + label tools are out of scope for v1 — listed in followups. Save status moved to the topbar in B.4 step 3, no longer in the dock.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/tool-dock.tsx
git commit -m "feat(floor-plan): ToolDock with Lucide icons (5 tools v1)"
```

### Task B.7: `<PolygonInspector>` with ToggleGroup + SettingsRow

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/polygon-inspector.tsx`

- [ ] **Step 1: Component**

```tsx
// apps/web/src/components/floor-plan-designer/polygon-inspector.tsx
import { useState } from 'react';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { SettingsRow, SettingsRowValue } from '../ui/settings-row';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../confirm-dialog';
import { polygonArea } from '../floor-plan/lib/polygon-geometry';
import type { DesignerState } from './types';
import type { RenderHint } from '../../api/floor-plans/types';

type Props = { floorSpaceId: string; state: DesignerState; dispatch: React.Dispatch<any> };

export function PolygonInspector({ state, dispatch }: Props) {
  const idx = state.selectedPolygonIndex;
  const polygon = idx === null ? null : state.polygons[idx];
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (polygon === null) {
    return (
      <div className="border-l border-border bg-background p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Selection</div>
        <p className="mt-3 text-sm text-muted-foreground">Click a polygon to edit its properties.</p>
      </div>
    );
  }

  const hint: RenderHint = polygon.render_hint ?? 'default';

  return (
    <div className="border-l border-border bg-background overflow-y-auto">
      <div className="p-4 pb-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Selected polygon</div>
      </div>

      <FieldGroup className="p-4 pt-2">
        <Field>
          <FieldLabel htmlFor="render-hint">Render as</FieldLabel>
          <ToggleGroup
            id="render-hint"
            type="single"
            value={hint}
            onValueChange={(v: string) => v && dispatch({ type: 'update-polygon', index: idx!, patch: { render_hint: v as RenderHint } })}
            variant="outline"
          >
            <ToggleGroupItem value="default">Default</ToggleGroupItem>
            <ToggleGroupItem value="seat">Seat</ToggleGroupItem>
            <ToggleGroupItem value="parking">Parking</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </FieldGroup>

      <div className="border-t border-border" />

      <SettingsRow label="Vertices">
        <SettingsRowValue className="tabular-nums">{polygon.points.length}</SettingsRowValue>
      </SettingsRow>
      <SettingsRow label="Area">
        <SettingsRowValue className="tabular-nums">{polygonArea(polygon.points).toFixed(0)} px²</SettingsRowValue>
      </SettingsRow>

      <div className="border-t border-border" />

      <div className="p-4">
        <Button variant="ghost" className="text-destructive" onClick={() => setConfirmOpen(true)}>
          Detach from floor plan
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">Polygon only — space record stays.</p>
      </div>

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

If `<ToggleGroup>` isn't yet installed: `npx shadcn@latest add toggle-group`.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/polygon-inspector.tsx
git commit -m "feat(floor-plan): PolygonInspector with ToggleGroup (render hint) + SettingsRow (stats)"
```

### Task B.8: `<DesignerCanvas>` + tools

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/designer-canvas.tsx`
- Create: `apps/web/src/components/floor-plan-designer/tools/tool.ts`
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
}
```

- [ ] **Step 2: Tools**

```ts
// apps/web/src/components/floor-plan-designer/tools/select-tool.ts
import type { Tool } from './tool';
export const selectTool: Tool = {
  onPointerDown({ dispatch }) {
    dispatch({ type: 'select-polygon', index: null });
  },
};
```

```ts
// apps/web/src/components/floor-plan-designer/tools/draw-polygon-tool.ts
import type { Tool } from './tool';
export const drawPolygonTool: Tool = {
  onPointerDown({ state, dispatch, worldX, worldY }) {
    const inProgress = state.inProgressPolygon;
    if (!inProgress) {
      dispatch({ type: 'start-drawing', polygon: { space_id: '', points: [{ x: worldX, y: worldY }] } });
    } else {
      dispatch({ type: 'start-drawing', polygon: { ...inProgress, points: [...inProgress.points, { x: worldX, y: worldY }] } });
    }
  },
};
```

```ts
// apps/web/src/components/floor-plan-designer/tools/draw-rectangle-tool.ts
import type { Tool } from './tool';
export const drawRectangleTool: Tool = {
  onPointerDown({ dispatch, worldX, worldY }) {
    dispatch({ type: 'start-drawing', polygon: { space_id: '', points: [{ x: worldX, y: worldY }] } });
  },
  onPointerMove({ state, dispatch, worldX, worldY }) {
    const start = state.inProgressPolygon?.points[0];
    if (!start) return;
    const rect = [start, { x: worldX, y: start.y }, { x: worldX, y: worldY }, { x: start.x, y: worldY }];
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
  onPointerDown({ dispatch, worldX, worldY }) {
    const w = 60, h = 40;
    dispatch({
      type: 'add-polygon',
      polygon: {
        space_id: '', // inspector picker links the space (B.9)
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
import { useRef } from 'react';
import { ZoomPanLayer } from '../floor-plan/zoom-pan-layer';
import { PolygonShape } from '../floor-plan/polygon-shape';
import { polygonToSvgPath } from '../floor-plan/lib/polygon-geometry';
import { snap } from './lib/snapping';
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
  'image-upload':   selectTool, // upload triggered from B.10 button, not pointer
};

type Props = { state: DesignerState; dispatch: React.Dispatch<any> };

export function DesignerCanvas({ state, dispatch }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  const toWorld = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { worldX: 0, worldY: 0 };
    const inv = pt.matrixTransform(ctm.inverse());
    const snapped = snap({ x: inv.x, y: inv.y }, state.polygons);
    return { worldX: snapped.x, worldY: snapped.y };
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
            <image href={state.imageUrl} x="0" y="0" width={state.widthPx ?? 1000} height={state.heightPx ?? 1000} opacity={0.35} />
          )}
          {state.polygons.map((poly, i) => (
            <PolygonShape
              key={i}
              spaceId={poly.space_id || `pending-${i}`}
              points={poly.points}
              renderHint={poly.render_hint ?? 'default'}
              name={poly.space_id ? '' : `Polygon ${i + 1}`}
              capacity={null}
              state="available"
              selected={i === state.selectedPolygonIndex}
              onClick={() => dispatch({ type: 'select-polygon', index: i })}
            />
          ))}
          {state.inProgressPolygon && (
            <path
              d={polygonToSvgPath(state.inProgressPolygon.points)}
              fill="rgba(245, 158, 11, 0.1)" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4 3"
            />
          )}
        </svg>
      </ZoomPanLayer>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/floor-plan-designer
git commit -m "feat(floor-plan): DesignerCanvas + 4 tools (select/polygon/rect/stamp) with snapping"
```

### Task B.9: Link polygons to space rows

**Files:**
- Modify: `apps/web/src/components/floor-plan-designer/polygon-inspector.tsx`
- Reuse: `apps/web/src/components/space-select.tsx` (or `<SpaceCombobox>` — search `grep -rn "space-select\|SpaceCombobox" apps/web/src | head -5`)

- [ ] **Step 1: Add space picker to inspector**

In `polygon-inspector.tsx`, render a `<SpaceSelect>` (or analogous combobox) above the render-hint group, filtered to: children of the open floor, tenant-scoped, not yet linked to another polygon in this draft. On change, dispatch `{ type: 'update-polygon', index: idx!, patch: { space_id: nextId } }`.

If the existing combobox doesn't accept a `parentId` prop, add one (small change).

- [ ] **Step 2: Inline create-desk affordance**

If user just stamped a seat and there's no unlinked desk on this floor, the picker shows a "Create new desk and link" button. On click: POST `/api/spaces` with `{ type: 'desk', parent_id: <floorSpaceId>, name: 'Desk <next-sequence>', tenant_id: <currentTenant> }`. On success, dispatch update with the new space_id.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/polygon-inspector.tsx
git commit -m "feat(floor-plan): polygon → space picker + inline create-desk affordance"
```

### Task B.10: Image upload via private Supabase Storage + signed URL

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/use-image-upload.ts`
- Modify: `apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx` (hidden input + open-on-tool-select)

- [ ] **Step 1: Hook**

```ts
// apps/web/src/components/floor-plan-designer/use-image-upload.ts
import { useState } from 'react';
import { supabaseClient } from '../../lib/supabase';
import { toastError } from '../../lib/toast';

const BUCKET = 'floor-plans';
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 4096;
const SIGNED_URL_TTL_SECONDS = 3600;

export function useImageUpload(tenantId: string, floorSpaceId: string) {
  const [uploading, setUploading] = useState(false);

  async function upload(file: File): Promise<{ path: string; previewUrl: string | null; widthPx: number; heightPx: number } | null> {
    if (file.size > MAX_BYTES) {
      toastError("Image too large", { description: 'Max 10 MB.' });
      return null;
    }
    setUploading(true);
    try {
      const bitmap = await createImageBitmap(file);
      const widthPx = bitmap.width;
      const heightPx = bitmap.height;
      if (Math.max(widthPx, heightPx) > MAX_EDGE) {
        toastError("Image too large", { description: `Long edge must be <= ${MAX_EDGE}px.` });
        return null;
      }
      const ext = file.name.split('.').pop() ?? 'png';
      const sha = await fileSha256(file);
      const path = `${tenantId}/${floorSpaceId}/${sha}.${ext}`;
      const { error: upErr } = await supabaseClient.storage.from(BUCKET).upload(path, file, { upsert: true });
      if (upErr) throw upErr;
      // Return the storage PATH, not a signed URL. Backend stores the path in
      // floor_plans.image_url and resolves to a signed URL at every GET (codex CRITICAL #4).
      // The hook also returns a one-time signed URL for the designer's immediate preview.
      const { data: signed } = await supabaseClient.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      return { path, previewUrl: signed?.signedUrl ?? null, widthPx, heightPx };
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

Note: signed URLs expire in 1h. For the designer that's fine (session is shorter). For the booking surface (Plan 2), regenerate signed URLs server-side as part of the GET plan response.

- [ ] **Step 2: Trigger from tool**

In `floor-plan-designer.tsx`, mount a hidden `<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" />` ref. When `state.activeTool === 'image-upload'`, click the input. On change:

1. Call `upload(file)` → returns `{ path, previewUrl, widthPx, heightPx }`.
2. Dispatch `{ type: 'set-image', imagePath: path, previewUrl, widthPx, heightPx }`.
3. The reducer stores `imagePath` (canonical, persisted to draft) and `previewUrl` (in-memory, for the current designer session render only).
4. Autosave PATCH sends `image_url: imagePath` to the backend.
5. Backend stores the path in `floor_plans.image_url` on publish. On GET, the path is signed → returned as the `image_url` for renderer use.

The `set-image` action type must be updated accordingly in `use-designer-state.ts`. The `DesignerState` type adds a `previewUrl: string | null` field (non-persisted).

Show a banner if `state.polygons.length > 0`: "Image replaced. Verify polygon positions before publishing."

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan-designer apps/web/src/lib/supabase.ts
git commit -m "feat(floor-plan): image upload via private bucket + signed URL (1h TTL)"
```

### Task B.11: Snapping (vertex + grid)

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/lib/snapping.ts`
- (Already wired in B.8 via `snap(...)` call.)

- [ ] **Step 1: Snap helper**

```ts
// apps/web/src/components/floor-plan-designer/lib/snapping.ts
import type { Point, Polygon } from '../../../api/floor-plans/types';

const GRID = 10;
const SNAP_GRID = 4;
const SNAP_VERTEX = 8;

export function snap(point: Point, polygons: Polygon[]): Point {
  for (const poly of polygons) {
    for (const v of poly.points) {
      if (Math.hypot(v.x - point.x, v.y - point.y) <= SNAP_VERTEX) return { x: v.x, y: v.y };
    }
  }
  const gx = Math.round(point.x / GRID) * GRID;
  const gy = Math.round(point.y / GRID) * GRID;
  if (Math.abs(gx - point.x) <= SNAP_GRID && Math.abs(gy - point.y) <= SNAP_GRID) return { x: gx, y: gy };
  return point;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/lib/snapping.ts
git commit -m "feat(floor-plan): snap-to-vertex (8px) + snap-to-grid (4px)"
```

### Task B.12: Undo / redo

**Files:**
- Modify: `apps/web/src/components/floor-plan-designer/use-designer-state.ts`

- [ ] **Step 1: Add history**

Wrap the reducer with a history stack. State becomes:
```ts
type HistoryEntry = { polygons: Polygon[]; labels: Label[]; imageUrl: string | null; widthPx: number | null; heightPx: number | null };
type DesignerStateWithHistory = DesignerState & { history: HistoryEntry[]; historyIndex: number };
```
On every mutating action that's not `'hydrate'`/`'set-tool'`/`'select-polygon'`/`'start-drawing'`/`'server-sync'`, push the prior payload to history (truncate forward branch if doing-and-then-undoing). Cap at 50.

Add actions `{ type: 'undo' }` and `{ type: 'redo' }` that restore from history without triggering autosave debounce (autosave still fires from the undone/redone resulting state).

Wire `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z` in the global `keydown` handler in `floor-plan-designer.tsx`.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan-designer
git commit -m "feat(floor-plan): undo/redo via 50-deep history stack"
```

### Task B.13: `/admin/floor-plans` routes (index + designer)

**Files:**
- Create: `apps/web/src/pages/admin/floor-plans-index.tsx`
- Create: `apps/web/src/pages/admin/floor-plan-designer.tsx`
- Modify: `apps/web/src/App.tsx` (both routes wrapped in `<RouteErrorBoundary>`)

The index page uses `SettingsPageShell` (matches /admin/webhooks shape). The designer page does **not** use the shell — it claims the full viewport like the workflow editor.

- [ ] **Step 1: Index page (shadcn Table + empty state)**

```tsx
// apps/web/src/pages/admin/floor-plans-index.tsx
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Map as MapIcon } from 'lucide-react';
import { SettingsPageShell, SettingsPageHeader } from '../../components/ui/settings-page';
import { Button } from '../../components/ui/button';
import {
  Table, TableHeader, TableRow, TableHead, TableBody, TableCell,
} from '../../components/ui/table';
import { apiFetch } from '../../lib/api-fetch';

type FloorRow = {
  id: string;
  name: string;
  building_name: string;
  has_plan: boolean;
  last_published_at: string | null;
};

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
        description="Upload floor images and trace bookable spaces. Published plans appear on the portal and desk scheduler."
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/locations">Manage buildings & floors →</Link>
          </Button>
        }
      />

      {floors.isLoading && <div className="text-sm text-muted-foreground py-8">Loading…</div>}

      {floors.data && floors.data.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16">
          <MapIcon className="h-8 w-8 text-muted-foreground" />
          <h3 className="text-base font-medium">No floors yet</h3>
          <p className="text-sm text-muted-foreground max-w-sm text-center">
            Floors are created on the locations page. Once a floor exists, you can trace a plan for it here.
          </p>
          <Button asChild>
            <Link to="/admin/locations">Go to Locations</Link>
          </Button>
        </div>
      )}

      {floors.data && floors.data.length > 0 && (
        <Table className="mt-6">
          <TableHeader>
            <TableRow>
              <TableHead>Building</TableHead>
              <TableHead>Floor</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last published</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {floors.data.map((f) => (
              <TableRow key={f.id}>
                <TableCell>{f.building_name}</TableCell>
                <TableCell>
                  <Link to={`/admin/floor-plans/${f.id}`} className="hover:underline">{f.name}</Link>
                </TableCell>
                <TableCell>
                  <span className={`inline-flex items-center gap-1.5 text-xs ${f.has_plan ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                    <span className={`inline-block h-2 w-2 rounded-full ${f.has_plan ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
                    {f.has_plan ? 'Published' : 'No plan'}
                  </span>
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {f.last_published_at ? new Date(f.last_published_at).toLocaleDateString() : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SettingsPageShell>
  );
}
```

- [ ] **Step 2: Designer page (shell-exempt)**

```tsx
// apps/web/src/pages/admin/floor-plan-designer.tsx
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FloorPlanDesigner } from '../../components/floor-plan-designer/floor-plan-designer';
import { apiFetch } from '../../lib/api-fetch';

export function FloorPlanDesignerPage() {
  const { floorSpaceId } = useParams<{ floorSpaceId: string }>();
  const floor = useQuery({
    queryKey: ['spaces', 'one', floorSpaceId],
    queryFn: () => apiFetch<{ id: string; name: string }>(`/api/spaces/${floorSpaceId}`),
    enabled: !!floorSpaceId,
  });

  if (!floorSpaceId) return null;
  return (
    <FloorPlanDesigner
      floorSpaceId={floorSpaceId}
      floorName={floor.data?.name ?? 'Floor'}
      backTo="/admin/floor-plans"
    />
  );
}
```

If `GET /api/spaces/:id` doesn't exist, add a thin endpoint on `SpaceController` returning `{ id, name, tenant_id }` filtered by `tenant_id`.

- [ ] **Step 3: Routes (both wrapped per CLAUDE.md)**

In `apps/web/src/App.tsx`:
```tsx
<Route path="/admin/floor-plans" element={<RouteErrorBoundary><FloorPlansIndex /></RouteErrorBoundary>} />
<Route path="/admin/floor-plans/:floorSpaceId" element={<RouteErrorBoundary><FloorPlanDesignerPage /></RouteErrorBoundary>} />
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/admin apps/web/src/App.tsx apps/api/src/modules/space
git commit -m "feat(floor-plan): admin routes — index (shell) + designer (shell-exempt)"
```

### Task B.14: Admin sidebar entry

**Files:**
- Modify: `apps/web/src/components/app-sidebar.tsx` (or whichever file lists admin nav — search `grep -n "admin/locations" apps/web/src/components/app-sidebar.tsx`)

- [ ] **Step 1: Add "Floor plans" near "Locations"**

Use the `Map` Lucide icon. Visible only to users with `floor_plans.admin`. Mirror the existing visibility-gating pattern (search for `useHasPermission` or similar).

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/app-sidebar.tsx
git commit -m "feat(floor-plan): admin sidebar entry"
```

**Phase B done.** Designer is functional. Admin can open `/admin/floor-plans`, click a floor, upload an image, trace polygons, see autosave + 409 reload prompt, undo/redo, link spaces. Publish button exists; dialog wired in C.2.

---

# Phase C — Publish Flow

Goal: complete the publish path. End state: admin clicks Publish → diff dialog (red-flags large removals) → confirm → atomic write → audit + history rows created. Restore-from-history available in C.4 polish.

### Task C.1: Publish diff helper

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/lib/diff.ts`
- Create: `apps/web/src/components/floor-plan-designer/__tests__/diff.test.ts`

- [ ] **Step 1: Diff fn + test**

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
    points: s.floor_plan_polygon.points,
    render_hint: s.floor_plan_render_hint,
  }));
  const draftMap = new Map(draftPolygons.filter((p) => p.space_id).map((p) => [p.space_id, p]));
  const publishedMap = new Map(publishedPolygons.map((p) => [p.space_id, p]));

  const added: Polygon[] = [];
  const modified: PublishDiff['modified'] = [];
  for (const [id, draft] of draftMap) {
    const before = publishedMap.get(id);
    if (!before) { added.push(draft); continue; }
    if (
      JSON.stringify(before.points) !== JSON.stringify(draft.points) ||
      before.render_hint !== draft.render_hint
    ) {
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
    added, removed, modified,
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
    const d = computePublishDiff(
      [{ space_id: 'a', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }],
      null, null,
    );
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(0);
  });
  it('ignores polygons without a space_id', () => {
    const d = computePublishDiff(
      [{ space_id: '', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }],
      null, null,
    );
    expect(d.added).toHaveLength(0);
  });
  // add cases: removed, modified, imageChanged, no-op
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/lib/diff.ts apps/web/src/components/floor-plan-designer/__tests__/diff.test.ts
git commit -m "feat(floor-plan): computePublishDiff + tests (ignores unlinked polygons)"
```

### Task C.2: `<PublishDialog>` with diff + large-removal red flag

**Files:**
- Create: `apps/web/src/components/floor-plan-designer/publish-dialog.tsx`

- [ ] **Step 1: Dialog**

```tsx
// apps/web/src/components/floor-plan-designer/publish-dialog.tsx
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useFloorPlanPublished, usePublishDraft } from '../../api/floor-plans/hooks';
import { computePublishDiff } from './lib/diff';
import { toastUpdated } from '../../lib/toast';
import type { DraftResponse } from '../../api/floor-plans/types';

type Props = { open: boolean; onOpenChange: (open: boolean) => void; floorSpaceId: string; draft: DraftResponse };

const LARGE_REMOVAL_THRESHOLD = 5;

export function PublishDialog({ open, onOpenChange, floorSpaceId, draft }: Props) {
  const published = useFloorPlanPublished(floorSpaceId);
  const publish = usePublishDraft(floorSpaceId);
  const diff = computePublishDiff(draft.polygons, draft.image_url, published.data ?? null);
  const isLargeRemoval = diff.removed.length >= LARGE_REMOVAL_THRESHOLD;
  const [typedConfirm, setTypedConfirm] = useState('');
  const requiredConfirm = `remove ${diff.removed.length}`;
  const canPublish = !isLargeRemoval || typedConfirm === requiredConfirm;

  const handlePublish = async () => {
    await publish.mutateAsync();
    toastUpdated('Floor plan');
    onOpenChange(false);
  };

  const noChanges =
    !diff.imageChanged && diff.added.length === 0 && diff.modified.length === 0 && diff.removed.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish floor plan</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {noChanges && <p className="text-muted-foreground">No changes to publish.</p>}
          {diff.imageChanged && <p className="text-amber-700">Background image changed.</p>}
          {diff.added.length > 0 && (
            <p><strong className="text-emerald-700">{diff.added.length}</strong> polygon(s) added.</p>
          )}
          {diff.modified.length > 0 && (
            <p><strong className="text-blue-700">{diff.modified.length}</strong> polygon(s) modified.</p>
          )}
          {diff.removed.length > 0 && (
            <div>
              <p>
                <strong className={isLargeRemoval ? 'text-red-700' : 'text-amber-700'}>{diff.removed.length}</strong> polygon(s) removed
                {isLargeRemoval && ' — large removal'}:
              </p>
              <ul className="ml-4 list-disc text-muted-foreground">
                {diff.removed.slice(0, 10).map((r) => <li key={r.space_id}>{r.name}</li>)}
                {diff.removed.length > 10 && <li>… and {diff.removed.length - 10} more</li>}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Removing a polygon doesn't cancel existing bookings; they remain in list views. A snapshot is saved — you can restore it from the publish history.
              </p>
              {isLargeRemoval && (
                <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3">
                  <p className="text-xs text-red-900">
                    To confirm, type <code className="font-mono">{requiredConfirm}</code> below:
                  </p>
                  <Input
                    value={typedConfirm}
                    onChange={(e) => setTypedConfirm(e.target.value)}
                    placeholder={requiredConfirm}
                    className="mt-2"
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handlePublish} disabled={publish.isPending || noChanges || !canPublish}>
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan-designer/publish-dialog.tsx
git commit -m "feat(floor-plan): PublishDialog with diff + typed-confirm for large removals (>=5)"
```

### Task C.3: Publish history list + restore action

**Files:**
- Modify: `apps/web/src/components/floor-plan-designer/floor-plan-designer.tsx` (add "History" button → dialog)
- Create: `apps/web/src/components/floor-plan-designer/history-dialog.tsx`
- Modify: `apps/api/src/modules/floor-plan/floor-plan.controller.ts` (POST restore)
- Create: `supabase/migrations/00373_restore_floor_plan_publish_history_rpc.sql`

- [ ] **Step 1: Restore RPC**

```sql
-- 00373_restore_floor_plan_publish_history_rpc.sql
-- Restore a previous publish snapshot. Atomic. Creates its own history row
-- of the current state before applying the snapshot.

create or replace function public.restore_floor_plan_publish(p_history_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_h public.floor_plan_publish_history%rowtype;
  v_tenant_id uuid;
  v_floor_id uuid;
  v_polygon jsonb;
  v_space_ids uuid[];
  v_current_polygons jsonb;
  v_current_floor public.floor_plans%rowtype;
  v_new_history uuid;
begin
  -- Lock the history row to serialize concurrent restores of the same snapshot.
  select * into v_h from public.floor_plan_publish_history where id = p_history_id for update;
  if v_h.id is null then raise exception 'floor_plan.history.not_found' using errcode = 'P0002'; end if;
  if v_h.tenant_id <> public.current_tenant_id() then raise exception 'floor_plan.history.cross_tenant' using errcode = '42501'; end if;

  v_tenant_id := v_h.tenant_id;
  v_floor_id  := v_h.floor_space_id;

  -- snapshot current state first
  select * into v_current_floor from public.floor_plans where space_id = v_floor_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'space_id', s.id,
    'points',   s.floor_plan_polygon->'points',
    'render_hint', s.floor_plan_render_hint
  )), '[]'::jsonb)
    into v_current_polygons
    from public.spaces s
   where s.tenant_id = v_tenant_id and s.parent_id = v_floor_id and s.floor_plan_polygon is not null;

  insert into public.floor_plan_publish_history
    (tenant_id, floor_space_id, image_url, width_px, height_px, labels, polygons, published_by, published_at)
  values
    (v_tenant_id, v_floor_id,
     v_current_floor.image_url, v_current_floor.width_px, v_current_floor.height_px,
     coalesce(v_current_floor.labels, '[]'::jsonb), v_current_polygons,
     null, now())
  returning id into v_new_history;

  -- apply snapshot
  insert into public.floor_plans (tenant_id, space_id, image_url, width_px, height_px, labels)
  values (v_tenant_id, v_floor_id, v_h.image_url, v_h.width_px, v_h.height_px, v_h.labels)
  on conflict (space_id) do update
    set image_url = excluded.image_url,
        width_px = excluded.width_px,
        height_px = excluded.height_px,
        labels = excluded.labels,
        updated_at = now();

  select coalesce(array_agg((p->>'space_id')::uuid), '{}'::uuid[])
    into v_space_ids
    from jsonb_array_elements(v_h.polygons) p;

  update public.spaces
     set floor_plan_polygon = null, floor_plan_render_hint = 'default'
   where tenant_id = v_tenant_id and parent_id = v_floor_id
     and floor_plan_polygon is not null and id <> all(v_space_ids);

  for v_polygon in select jsonb_array_elements(v_h.polygons) loop
    update public.spaces
       set floor_plan_polygon = jsonb_build_object('points', v_polygon->'points'),
           floor_plan_render_hint = coalesce(v_polygon->>'render_hint', 'default')
     where id = (v_polygon->>'space_id')::uuid
       and tenant_id = v_tenant_id and parent_id = v_floor_id;
  end loop;

  insert into public.audit_events
    (tenant_id, event_type, entity_type, entity_id, actor_user_id, details)
  values
    (v_tenant_id, 'floor_plan.restored', 'floor_plan', v_floor_id, null,
     jsonb_build_object('source_history_id', p_history_id, 'new_history_id', v_new_history));
end;
$$;

revoke all on function public.restore_floor_plan_publish(uuid) from public;
grant execute on function public.restore_floor_plan_publish(uuid) to authenticated;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Controller endpoint**

```ts
// apps/api/src/modules/floor-plan/floor-plan.controller.ts (add)
@UseGuards(PermissionGuard)
@RequirePermission('floor_plans.admin')
@Post('history/:historyId/restore')
async restore(@Param('historyId') historyId: string, @Req() req: ReqUser) {
  return this.plan.restorePublish(historyId, req.user.tenant_id);
}
```

```ts
// apps/api/src/modules/floor-plan/floor-plan.service.ts (add)
async restorePublish(historyId: string, tenantId: string) {
  const client = this.supabase.client();
  // RPC will throw if cross-tenant
  const { error } = await client.rpc('restore_floor_plan_publish', { p_history_id: historyId });
  if (error) throw AppErrors.server('floor_plan.restore_failed');
  return { ok: true };
}
```

- [ ] **Step 3: History dialog (frontend)**

```tsx
// apps/web/src/components/floor-plan-designer/history-dialog.tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { apiFetch } from '../../lib/api-fetch';
import { floorPlanKeys } from '../../api/floor-plans/keys';
import { toastUpdated } from '../../lib/toast';
import { withErrorHandling } from '../../lib/errors';
import type { PublishHistoryEntry } from '../../api/floor-plans/types';

type Props = { open: boolean; onOpenChange: (open: boolean) => void; floorSpaceId: string };

export function HistoryDialog({ open, onOpenChange, floorSpaceId }: Props) {
  const qc = useQueryClient();
  const history = useQuery({
    queryKey: floorPlanKeys.floorHistory(floorSpaceId),
    queryFn: () => apiFetch<PublishHistoryEntry[]>(`/api/floors/${floorSpaceId}/plan/history`),
    enabled: open,
  });
  const restore = useMutation({
    mutationFn: (historyId: string) =>
      apiFetch(`/api/floors/${floorSpaceId}/plan/history/${historyId}/restore`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: floorPlanKeys.floor(floorSpaceId) });
      toastUpdated('Floor plan restored');
      onOpenChange(false);
    },
    ...withErrorHandling({ actionTitle: "Couldn't restore the floor plan" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Publish history</DialogTitle></DialogHeader>
        {history.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        <ul className="divide-y">
          {(history.data ?? []).map((h) => (
            <li key={h.id} className="flex items-center justify-between py-2 text-sm">
              <span className="tabular-nums">{new Date(h.published_at).toLocaleString()} · {h.polygons.length} polygons</span>
              <Button size="sm" variant="outline" onClick={() => restore.mutate(h.id)} disabled={restore.isPending}>
                Restore
              </Button>
            </li>
          ))}
          {history.data && history.data.length === 0 && (
            <li className="py-4 text-sm text-muted-foreground">No history yet.</li>
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Wire History button in designer topbar**

In `floor-plan-designer.tsx`, add a "History" button next to Publish that opens `<HistoryDialog>`.

- [ ] **Step 5: Apply migration + commit**

```bash
pnpm db:reset
pnpm db:push  # or psql fallback
git add supabase/migrations/00373_restore_floor_plan_publish_history_rpc.sql apps/api/src/modules/floor-plan apps/web/src/components/floor-plan-designer
git commit -m "feat(floor-plan): publish history list + restore RPC + history dialog"
```

### Task C.4: Audit + publish_history E2E test

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

  it('writes audit_events with correct schema + history row + canonical polygon shape', async () => {
    const { data: draft } = await supabase
      .from('floor_plan_drafts')
      .insert({
        tenant_id: tenantId,
        floor_space_id: floorId,
        image_url: 'https://example.com/plan.png',
        width_px: 1000, height_px: 800,
        polygons: [{ space_id: roomId, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
        created_by: userId,
      })
      .select('id').single();

    const { data: result } = await supabase.rpc('publish_floor_plan_draft', { p_draft_id: draft!.id });
    expect((result as any).history_id).toBeTruthy();

    // audit row with correct columns
    const { data: audit } = await supabase
      .from('audit_events')
      .select('*')
      .eq('event_type', 'floor_plan.published')
      .eq('entity_type', 'floor_plan')
      .eq('entity_id', floorId)
      .single();
    expect(audit).toBeTruthy();
    expect(audit!.details.polygon_count).toBe(1);
    expect(audit!.actor_user_id).toBe(userId);

    // canonical polygon shape
    const { data: room } = await supabase.from('spaces').select('floor_plan_polygon').eq('id', roomId).single();
    expect(room!.floor_plan_polygon).toEqual({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });

    // history row exists
    const { data: hist } = await supabase
      .from('floor_plan_publish_history')
      .select('*')
      .eq('floor_space_id', floorId)
      .single();
    expect(hist).toBeTruthy();

    // draft gone
    const { data: leftover } = await supabase.from('floor_plan_drafts').select('id').eq('id', draft!.id);
    expect(leftover).toEqual([]);
  });

  it('rejects cross-tenant publish', async () => {
    // tenant B tries to publish tenant A's draft
    // assuming createTestSupabase respects current_tenant_id from a config
    // …
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @prequest/api test publish-audit
git add apps/api/src/modules/floor-plan/publish-audit.spec.ts
git commit -m "test(floor-plan): publish RPC end-to-end (correct audit schema + history + canonical shape)"
```

### Task C.5: Final smoke + spec coverage + push

- [ ] **Step 1: Full build**

```bash
pnpm --filter @prequest/api build
pnpm --filter @prequest/web build
pnpm --filter @prequest/shared test
pnpm --filter @prequest/api test
pnpm --filter @prequest/web test
```
All green.

- [ ] **Step 2: Smoke gate**

```bash
# terminal 1: pnpm dev:api
pnpm smoke:floor-plans
pnpm smoke:work-orders
```
Both exit 0. The 17-probe floor-plan smoke is mandatory pre-claim.

- [ ] **Step 3: Manual happy path**

`pnpm dev` (both). As an admin with `floor_plans.admin`:
1. Open `/admin/floor-plans` — see the index.
2. Click a floor — see the designer.
3. Upload an image — see it as background.
4. Trace 2 rooms with Draw Polygon.
5. Stamp 6 seats; link 3 to existing desk rows via inspector picker.
6. Hit Publish — see diff dialog with 5 added.
7. Confirm — see toast.
8. Refresh — published state shows.
9. Hit History — see one entry.
10. Delete 3 polygons in the designer, hit Publish — diff dialog shows 3 removed (NOT >= 5, no typed confirm yet).
11. Delete 2 more, hit Publish — diff shows 5 removed, typed confirm appears.
12. Type `remove 5` — Publish enables.
13. Restore from history — original polygons return.

- [ ] **Step 4: Spec coverage scan**

Open the spec and confirm every Phase A–C requirement maps to a task:
- §3.1–§3.4 schema ✔ A.1–A.5 + canonical polygon shape via 00367 CHECK
- §3.5 parent_id enforcement ✔ A.9 service-level pre-flight + RPC tenant filter
- §3.6 realtime — Plan 2 (not in this plan)
- §4 renderer view mode ✔ B.2
- §5 designer ✔ B.3–B.13
- §6.1 module ✔ A.9
- §6.2 RPC ✔ A.4 (correct audit schema)
- §6.3 REST endpoints ✔ A.9 (GET/PATCH/DELETE drafts, POST publish, GET history, POST restore)
- §7.1 admin routes ✔ B.13
- §7.2–7.4 — Plan 2
- §8 permission `floor_plans.admin` ✔ A.7
- §9 edge cases ✔ A.9 preflight, A.10 cross-tenant, A.11 probes, C.2 diff red-flag, history+restore in C.3
- §10 testing ✔ A.10, A.11, B.2, C.1, C.4
- §11 perf — manual in step 5 below
- §12 GDPR ✔ audit in A.4 + history snapshots in A.5
- §13 migrations ✔ 00367–00373 (7 total)

- [ ] **Step 5: Performance sanity**

Seed a floor with 500 polygons (script via the smoke harness or stamp them manually). Confirm pan/zoom maintains ≥ 30fps. Below that target → file a followup to switch the polygon layer to Konva; do not block Plan 1.

- [ ] **Step 6: Push + PR**

```bash
git push origin worktree-floorplanner
gh pr create --title "feat: floor plan designer (Plan 1 — Phases A-C)" --body "$(cat <<'EOF'
## Summary
- Adds floor plan designer at /admin/floor-plans with trace-mode authoring (draw polygon, rectangle, stamp seat, image upload).
- Atomic draft + publish flow via publish_floor_plan_draft RPC; publish history snapshots enable rollback.
- Single floor_plans.admin permission key registered in TS catalog.
- 17-probe smoke gate (pnpm smoke:floor-plans) + cross-tenant coverage.

## Migrations
- 00367 spaces.floor_plan_render_hint + polygon shape CHECK
- 00368 floor_plan_drafts (tenant-scoped, RLS, optimistic-locking-ready)
- 00369 labels jsonb on floor_plans + drafts
- 00370 publish_floor_plan_draft RPC (audit + history snapshot)
- 00371 floor_plan_publish_history
- 00372 floor-plans Storage bucket (private, full RLS, signed URLs)
- 00373 restore_floor_plan_publish RPC

## Plan-review remediation
Adversarial plan review surfaced 5 CRITICALs + 15 IMPORTANTs before code; all addressed in the plan rewrite (see plan §"Plan-review delta" at end).

## Test plan
- [ ] pnpm smoke:floor-plans — 17/17 probes pass
- [ ] pnpm --filter @prequest/api test — green
- [ ] pnpm --filter @prequest/web test — green
- [ ] Manual: trace + publish + restore happy path
- [ ] Manual: 500-polygon perf check ≥ 30fps
EOF
)"
```

**Plan 1 done.** Designer + draft+publish ship. Plan 2 (booking surface, Phases D-F) is the next plan to write.

---

## Plan-review delta (what changed from v1)

Applied in two rounds: (1) full-review skill (Claude adversarial agent), (2) codex review (different training, catches Postgres semantics gaps). 2026-05-12.

### Round 2 — codex review (Postgres semantics)

| # | Severity | Fix |
|---|---|---|
| codex-C1 | CRITICAL | Publish RPC uses `DELETE ... RETURNING *` to atomically claim the draft — two concurrent calls cannot both succeed. |
| codex-C2 | CRITICAL | PATCH uses atomic CAS: single `UPDATE ... WHERE updated_at = $ifMatch RETURNING *`, not read-then-write. |
| codex-C3 | CRITICAL | Autosave race resolved by codex-C2's atomic CAS at the server. Out-of-order client requests with stale `updated_at` reject. |
| codex-C4 | CRITICAL | `floor_plans.image_url` stores the **storage path**, not the signed URL. Backend resolves to a fresh signed URL at every GET. Designer carries `previewUrl` (in-memory) for immediate session render only. Published plans no longer break after 1h. |
| codex-I1 | IMPORTANT | DTO accepts `space_id: ''` for unlinked polygons during draft; publish-time preflight + RPC validation reject empties. |
| codex-I2 | IMPORTANT | Publish RPC validates each polygon: non-empty UUID, child-of-floor, no duplicates. Hardened against direct table writes / future bugs. |
| codex-I3 | IMPORTANT | Publish RPC raises `floor_plan.publish.image_required` (errcode `23502`) when image_url/width/height are null. Server-side preflight catches it before invoking RPC. |
| codex-I4 | IMPORTANT | `floor_plan_publish_history` policy narrowed to `FOR SELECT`. INSERTs come only from security-definer RPCs. New smoke probe verifies REST writes are blocked. |
| codex-I5 | IMPORTANT | Both RPCs use `search_path = pg_catalog, public, pg_temp` and explicit qualified references. |

### Round 1 — full-review skill (CLAUDE.md compliance + plan integrity)

| # | Severity | Fix |
|---|---|---|
| C1 | CRITICAL | Dropped `permission_catalog` SQL table migration; permissions are TS-only (`packages/shared/src/permissions.ts`). |
| C2 | CRITICAL | RPC uses correct `audit_events` schema (`event_type/entity_type/entity_id/actor_user_id/details`). |
| C3 | CRITICAL | `backTo` moved from `SettingsPageShell` to `SettingsPageHeader`. |
| C4 | CRITICAL | Designer page does NOT wrap in `SettingsPageShell` — custom topbar like workflow editor. |
| C5 | CRITICAL | Storage bucket made PRIVATE; full RLS (insert/update/delete/select) all tenant-scoped; client uses signed URLs. |
| I1 | IMPORTANT | Migrations ordered linearly: 00367 → 00368 → 00369 (labels) → 00370 (RPC) → 00371 (history) → 00372 (bucket) → 00373 (restore RPC). No renumber dance. |
| I2 | IMPORTANT | Polygon shape canonicalized to `{points:[…]}` via CHECK constraint in 00367; readers no longer carry fallback logic. |
| I3 | IMPORTANT | All TS Supabase queries explicitly filter by `tenant_id`. |
| I4 | IMPORTANT | Smoke probe set expanded from 8 → 17 covering deleted-space-on-publish, image-bounds, concurrent publish, null fields, duplicate space_id, cross-tenant polygon, polygon-not-child-of-floor, optimistic-lock 409. |
| I5 | IMPORTANT | `If-Match: updated_at` optimistic locking on PATCH; 409 surfaces a toast prompting reload. |
| I6 | IMPORTANT | `floor_plan_publish_history` table snapshots each publish; restore RPC + UI added. PublishDialog red-flags large removals with typed confirmation. |
| I7 | IMPORTANT | Resolved via N4: single `floor_plans.admin` key, no half-shipped DELETE permission. |
| I8 | IMPORTANT | Frontend-design skill invocation flagged at top of Phase B. |
| I9 | IMPORTANT | Index page uses shadcn `<Table>`, has empty state with icon + CTA, header `actions` slot links to Locations. |
| I10 | IMPORTANT | PolygonInspector uses `<ToggleGroup>` for render hint and `<SettingsRow>` for stats. |
| I11 | IMPORTANT | Dropped `admin_floor_plans_index` RPC; `listForAdmin` uses a direct Supabase query. |
| I12 | IMPORTANT | Take-over flow deferred to followups; not in v1. |
| I13 | IMPORTANT | Keyboard accessibility expanded: V/P/R/S/I/Enter/Esc/Delete + Cmd-Z/Cmd-Shift-Z. Vertex nudge deferred. |
| I14 | IMPORTANT | `useFloorPlanDraft` uses `usePageQuery` (page primary). |
| I15 | IMPORTANT | Decided: skip per-PATCH audit (admins are trusted); publish + restore are the audited events. |
| N1 | NIT | Draft insert sets `tenant_id` explicitly. |
| N2 | NIT | Lucide icons used in ToolDock from the start. |
| N3 | NIT | Perf target = 500 polygons / 30fps. |
| N4 | NIT | One `floor_plans.admin` permission key. |
| N5 | NIT | Index page header has a link to /admin/locations; designer topbar has back link. |
| N6 | NIT | Stray `parent_vendor_account_id` line removed from followups. |

## Followups to track (do NOT block Plan 1)

1. Parking-slot tool (`render_hint: 'parking'` is supported but the dedicated drawing tool is deferred).
2. Label tool (positioned text annotations — schema + storage exist; UI not in v1).
3. Image-remap tool: when the background image is replaced, project existing polygons onto the new image via reference-point alignment.
4. Konva fallback for polygon layer if perf falls below 30fps at 500+ polygons.
5. Arrow-key vertex nudge in Select tool (1 px per press; Shift = 10 px).
6. Take-over flow when two admins open the same floor — currently last-writer-wins protected by optimistic lock; explicit take-over UI deferred.
7. Multi-touch pinch zoom on the designer (current ZoomPanLayer is single-touch + scroll).
