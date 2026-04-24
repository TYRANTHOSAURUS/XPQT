# Portal visual redesign — Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the foundation + home page of the portal redesign: new top-nav shell (desktop + mobile bottom tabs), data model + admin surfaces for hero images / category covers / announcements, and the new home page with hero + activity panel + announcements.

**Architecture:** Swap the `/portal/*` layout from the operator sidebar shell to a dedicated top-nav shell with mobile bottom tabs. Add three new pieces of content config (portal_appearance, portal_announcements, catalog_categories cover columns) driven by admin surfaces that extend `/admin/branding` and the existing catalog category dialog. Redesign the home page to use the new config (hero image or gradient fallback + greeting + search overlay, two-column body with catalog + activity panel, announcement card).

**Tech Stack:** React 19 + Vite + Tailwind v4 + shadcn/ui (frontend); NestJS 11 + Supabase (backend); Supabase PostgreSQL migrations; React Query 5; Jest (API tests); manual browser + TS build for web (per repo norms — no existing web test runner).

**Spec:** [`docs/superpowers/specs/2026-04-24-portal-visual-redesign-design.md`](../specs/2026-04-24-portal-visual-redesign-design.md)

**Scope note — what this plan covers:**

- Spec Slice 1 — New portal shell
- Spec Slice 2 — Data model + admin surfaces
- Spec Slice 3 — Home redesign

**Out of scope for this plan (follow-up Wave 2):**

- Spec Slice 4 — Catalog detail + request form redesign
- Spec Slice 5 — My Requests redesign
- Spec Slices 6/7 — Phase 2 flows + KB slot activation

---

## File structure

### Frontend — create

Portal shell:
- `apps/web/src/components/portal/portal-top-bar.tsx` — desktop top nav (logo + centered links + location pill + account)
- `apps/web/src/components/portal/portal-bottom-tabs.tsx` — mobile bottom tab bar (5 flows)
- `apps/web/src/components/portal/portal-account-menu.tsx` — account avatar popover with "Switch to Service Desk" link for agents/admins
- `apps/web/src/components/portal/portal-page.tsx` — `<PortalPage>` wrapper (`max-w-[1600px]` content container)
- `apps/web/src/components/portal/portal-nav-link.tsx` — individual desktop nav link + active underline

Home page:
- `apps/web/src/components/portal/portal-home-hero.tsx` — big hero with image or gradient fallback + greeting + search
- `apps/web/src/components/portal/portal-category-card.tsx` — category tile with cover image or icon fallback
- `apps/web/src/components/portal/portal-activity-panel.tsx` — right-side panel: open tickets + empty slots for Phase 2 flows
- `apps/web/src/components/portal/portal-announcement-card.tsx` — announcement tile with dismiss

Admin surfaces:
- `apps/web/src/components/admin/portal/portal-appearance-section.tsx` — wrapper for the three SettingsGroups on /admin/branding
- `apps/web/src/components/admin/portal/portal-hero-slot.tsx` — per-location hero image row
- `apps/web/src/components/admin/portal/portal-hero-upload-dialog.tsx` — upload + crop/preview dialog
- `apps/web/src/components/admin/portal/announcement-dialog.tsx` — publish/edit announcement
- `apps/web/src/components/admin/catalog/category-cover-picker.tsx` — cover vs icon toggle + default grid + upload + live preview

API / hooks:
- `apps/web/src/api/portal-appearance/index.ts` — query keys + `queryOptions` + `useUpdatePortalAppearance` + `useUploadPortalHero`
- `apps/web/src/api/portal-announcements/index.ts` — keys + options + publish/unpublish mutations

Utilities:
- `apps/web/src/lib/portal-greeting.ts` — time-of-day greeting helper (returns `"Good morning" | "Good afternoon" | "Good evening"`)

### Frontend — modify

- `apps/web/src/layouts/portal-layout.tsx` — replace `SidebarProvider` shell with new top-nav + bottom-tabs layout
- `apps/web/src/layouts/admin-layout.tsx` and `apps/web/src/layouts/desk-layout.tsx` — add symmetric "Switch to Portal" link in the account menu
- `apps/web/src/pages/portal/home.tsx` — rewrite using new components, reads from portal_appearance + /portal/me
- `apps/web/src/pages/admin/branding.tsx` — mount `<PortalAppearanceSection />` at the bottom of the page
- `apps/web/src/pages/admin/catalog-hierarchy.tsx` — add `<CategoryCoverPicker />` to the category edit dialog
- `apps/web/src/providers/portal-provider.tsx` — extend `usePortal()` payload to include `appearance` + `announcement`

### Backend — create

- `apps/api/src/modules/portal-appearance/portal-appearance.module.ts`
- `apps/api/src/modules/portal-appearance/portal-appearance.controller.ts`
- `apps/api/src/modules/portal-appearance/portal-appearance.service.ts`
- `apps/api/src/modules/portal-appearance/portal-appearance.service.spec.ts`
- `apps/api/src/modules/portal-appearance/dto.ts`
- `apps/api/src/modules/portal-announcements/portal-announcements.module.ts`
- `apps/api/src/modules/portal-announcements/portal-announcements.controller.ts`
- `apps/api/src/modules/portal-announcements/portal-announcements.service.ts`
- `apps/api/src/modules/portal-announcements/portal-announcements.service.spec.ts`
- `apps/api/src/modules/portal-announcements/dto.ts`

### Backend — modify

- `apps/api/src/app.module.ts` — register the two new modules
- `apps/api/src/modules/portal/portal.service.ts` — extend the portal/me response to include appearance + announcement (resolver walk-up)
- `apps/api/src/modules/portal/portal.controller.ts` — (no changes — existing /portal/me handler stays)
- `apps/api/src/modules/config-engine/service-catalog.controller.ts` — accept `cover_image_url` + `cover_source` on PATCH (existing `@Patch('categories/:id')`); add a new `@Post('categories/:id/cover')` route

### Migrations — create

- `supabase/migrations/00114_portal_appearance.sql`
- `supabase/migrations/00115_portal_announcements.sql`
- `supabase/migrations/00116_catalog_category_covers.sql`
- `supabase/migrations/00117_portal_assets_bucket.sql`

---

## Phases

- **Phase A — Data + backend** (Tasks 1–9): migrations, new modules, extensions to /portal/me + catalog.
- **Phase B — Portal shell** (Tasks 10–14): new top-nav + bottom tabs, account menu, layout rewrite, symmetric "switch" links.
- **Phase C — Admin surfaces** (Tasks 15–19): React Query hooks, /admin/branding Portal section, category cover picker.
- **Phase D — Home redesign** (Tasks 20–23): hero + category cards + activity panel + announcement + page rewrite.

---

## Phase A — Data + backend

### Task 1: Migration `00114_portal_appearance`

**Files:**
- Create: `supabase/migrations/00114_portal_appearance.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00114_portal_appearance.sql
-- Per-location visual settings for the employee portal. A hero image + greeting
-- copy + time-of-day greeting toggle, resolved by walking up the spaces tree
-- (see apps/api/src/modules/portal-appearance/portal-appearance.service.ts).

create table public.portal_appearance (
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  location_id     uuid        not null references public.spaces(id)  on delete cascade,
  hero_image_url    text,
  welcome_headline  text,
  supporting_line   text,
  greeting_enabled  boolean   not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, location_id)
);

create index portal_appearance_tenant_idx
  on public.portal_appearance (tenant_id);

-- updated_at trigger
create trigger portal_appearance_set_updated_at
  before update on public.portal_appearance
  for each row execute function public.set_updated_at();

-- RLS: tenant-scoped read for any authenticated caller of that tenant.
-- Writes go through the NestJS API under the service role, so no write policy
-- is required for anon/auth.
alter table public.portal_appearance enable row level security;

create policy "portal_appearance tenant read"
  on public.portal_appearance for select
  using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
  );

comment on table public.portal_appearance is
  'Per-location portal appearance: hero image, greeting copy, time-of-day toggle. Resolver walks up spaces.parent_id.';
```

- [ ] **Step 2: Verify `set_updated_at()` exists**

Run: `grep -r 'function public.set_updated_at' supabase/migrations/ | head -3`
Expected: at least one `create function public.set_updated_at` match (reused from earlier migrations).

If no match, replace the trigger with inline pseudocode that sets `updated_at = now()` — but with 113 migrations it almost certainly exists.

- [ ] **Step 3: Apply locally**

Run: `pnpm db:reset`
Expected: migration applies without error; table `public.portal_appearance` exists.

- [ ] **Step 4: Verify with psql**

Run: `psql "$SUPABASE_LOCAL_DB_URL" -c "\\d+ public.portal_appearance"`
Expected: all columns visible, RLS enabled.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00114_portal_appearance.sql
git commit -m "feat(portal): add portal_appearance table for per-location hero+greeting"
```

### Task 2: Migration `00115_portal_announcements`

**Files:**
- Create: `supabase/migrations/00115_portal_announcements.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00115_portal_announcements.sql
-- Per-location announcements surfaced on the portal home. One active
-- announcement per location at a time, enforced by a unique partial index.

create table public.portal_announcements (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  location_id  uuid        not null references public.spaces(id)  on delete cascade,
  title        text        not null check (length(title) between 1 and 120),
  body         text        not null check (length(body)  between 1 and 1000),
  published_at timestamptz not null default now(),
  expires_at   timestamptz,
  created_by   uuid        references public.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- "One active per location": an announcement is active iff expires_at is
-- null OR expires_at > now(). Enforce via a partial unique index.
create unique index portal_announcements_one_active_per_location
  on public.portal_announcements (tenant_id, location_id)
  where (expires_at is null or expires_at > now());

create index portal_announcements_tenant_location_published_idx
  on public.portal_announcements (tenant_id, location_id, published_at desc);

alter table public.portal_announcements enable row level security;

create policy "portal_announcements tenant read"
  on public.portal_announcements for select
  using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
  );

comment on table public.portal_announcements is
  'Per-location announcements for the portal home. One active per location at a time.';
```

- [ ] **Step 2: Apply locally**

Run: `pnpm db:reset`
Expected: migration applies cleanly.

- [ ] **Step 3: Sanity-test the partial unique index**

Run (in psql, as a smoke test):
```bash
psql "$SUPABASE_LOCAL_DB_URL" <<'SQL'
do $$
declare
  t uuid;
  loc uuid;
begin
  select id into t from public.tenants limit 1;
  select id into loc from public.spaces where tenant_id = t and type = 'building' limit 1;
  insert into public.portal_announcements (tenant_id, location_id, title, body)
    values (t, loc, 'A', 'body A');
  begin
    insert into public.portal_announcements (tenant_id, location_id, title, body)
      values (t, loc, 'B', 'body B');
    raise exception 'partial unique index did not fire';
  exception when unique_violation then
    raise notice 'OK: unique_violation fired as expected';
  end;
  rollback;
end$$;
SQL
```
Expected: `NOTICE: OK: unique_violation fired as expected`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00115_portal_announcements.sql
git commit -m "feat(portal): add portal_announcements with one-active-per-location constraint"
```

### Task 3: Migration `00116_catalog_category_covers`

**Files:**
- Create: `supabase/migrations/00116_catalog_category_covers.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00116_catalog_category_covers.sql
-- Adds cover image + source toggle to catalog_categories. 'icon' is the default
-- visual mode (current behaviour); switching to 'image' requires cover_image_url.

alter table public.catalog_categories
  add column cover_image_url text,
  add column cover_source    text not null default 'icon'
    check (cover_source in ('image', 'icon'));

-- Invariant: if cover_source='image', cover_image_url must not be null.
-- Use a check constraint so both API and direct DB edits fail loudly.
alter table public.catalog_categories
  add constraint catalog_categories_cover_consistent
  check (cover_source <> 'image' or cover_image_url is not null);

comment on column public.catalog_categories.cover_source is
  'How the category is visualized on the portal: icon (default) or image (requires cover_image_url).';
```

- [ ] **Step 2: Apply locally, verify defaults**

Run:
```bash
pnpm db:reset
psql "$SUPABASE_LOCAL_DB_URL" -c "select count(*) filter (where cover_source='icon') from public.catalog_categories;"
```
Expected: count equals total categories (all default to 'icon').

- [ ] **Step 3: Sanity-test the check constraint**

Run:
```bash
psql "$SUPABASE_LOCAL_DB_URL" <<'SQL'
do $$
begin
  begin
    update public.catalog_categories set cover_source='image' where id = (select id from public.catalog_categories limit 1);
    raise exception 'check constraint did not fire';
  exception when check_violation then
    raise notice 'OK: check_violation fired as expected';
  end;
end$$;
SQL
```
Expected: NOTICE line confirms the constraint.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00116_catalog_category_covers.sql
git commit -m "feat(catalog): add cover_image_url + cover_source to categories"
```

### Task 4: Migration `00117_portal_assets_bucket`

**Files:**
- Create: `supabase/migrations/00117_portal_assets_bucket.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 00117_portal_assets_bucket.sql
-- Supabase storage bucket for portal imagery: hero images + category covers.
-- Files are organized as: {tenant_id}/hero/{uuid}.{ext}
--                        {tenant_id}/category-cover/{uuid}.{ext}
-- Bucket is public-read (cover images appear in unauthenticated admin previews
-- are not a concern — they're tenant-visual only, never PII).

insert into storage.buckets (id, name, public)
  values ('portal-assets', 'portal-assets', true)
  on conflict (id) do nothing;

-- Writes are service-role only — the NestJS API mediates all uploads.
-- Public read is allowed (same pattern as tenant-branding).
```

- [ ] **Step 2: Apply locally**

Run: `pnpm db:reset`
Expected: bucket exists in `storage.buckets`.

Run: `psql "$SUPABASE_LOCAL_DB_URL" -c "select id, public from storage.buckets where id='portal-assets';"`
Expected: one row, `public = true`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/00117_portal_assets_bucket.sql
git commit -m "feat(portal): add portal-assets storage bucket for hero + category covers"
```

### Task 5: Push migrations 114-117 to remote

**Files:** none (this is a deploy step)

Per memory `supabase_remote_push`, `pnpm db:push` has failed in practice and user wants an explicit prompt before pushing. Per memory `feedback_db_push_authorized`, the user has granted standing permission for portal-scope migration pushes — still prefer `db:push` over destructive ops.

- [ ] **Step 1: Confirm with user**

Message the user:
> "Ready to push migrations 00114–00117 to the remote Supabase project. These add portal_appearance, portal_announcements, catalog_categories cover columns, and the portal-assets storage bucket. Confirm to proceed with `pnpm db:push`, or ask me to use the psql fallback."

Wait for explicit confirmation. Do NOT proceed without it.

- [ ] **Step 2: Push**

Try `pnpm db:push` first.
If it fails (auth/privilege error), fall back to:
```bash
PGPASSWORD='<user-provided>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/00114_portal_appearance.sql \
  -f supabase/migrations/00115_portal_announcements.sql \
  -f supabase/migrations/00116_catalog_category_covers.sql \
  -f supabase/migrations/00117_portal_assets_bucket.sql
```

Then run:
```bash
PGPASSWORD='<user-provided>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "NOTIFY pgrst, 'reload schema';"
```

- [ ] **Step 3: Verify remote**

Fire a smoke query via the running API:
```bash
curl -sS "$VITE_API_URL/portal/me" -H "Authorization: Bearer $TEST_JWT" | jq '.can_submit'
```
Expected: still returns true — the existing endpoint was not broken by the migrations.

- [ ] **Step 4: Commit if any small tweak was needed**

(Usually nothing to commit here. This task is a deploy.)

### Task 6: `PortalAppearanceService` + controller + spec

**Files:**
- Create: `apps/api/src/modules/portal-appearance/portal-appearance.module.ts`
- Create: `apps/api/src/modules/portal-appearance/portal-appearance.controller.ts`
- Create: `apps/api/src/modules/portal-appearance/portal-appearance.service.ts`
- Create: `apps/api/src/modules/portal-appearance/portal-appearance.service.spec.ts`
- Create: `apps/api/src/modules/portal-appearance/dto.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write `dto.ts`**

```ts
// apps/api/src/modules/portal-appearance/dto.ts
export interface PortalAppearance {
  location_id: string;
  hero_image_url: string | null;
  welcome_headline: string | null;
  supporting_line: string | null;
  greeting_enabled: boolean;
}

export interface UpdatePortalAppearanceDto {
  location_id: string;
  welcome_headline?: string | null;
  supporting_line?: string | null;
  greeting_enabled?: boolean;
}
```

- [ ] **Step 2: Write the failing spec**

```ts
// apps/api/src/modules/portal-appearance/portal-appearance.service.spec.ts
import { resolveAppearance } from './portal-appearance.service';

describe('resolveAppearance (pure walk-up)', () => {
  // Walk-up: start at location_id, walk up spaces.parent_id until we find a
  // row in portal_appearance, else fall back to tenant root, else null.
  it('returns the row for the exact location when present', () => {
    const rows = [
      { location_id: 'floor-4', hero_image_url: 'a.jpg', welcome_headline: null, supporting_line: null, greeting_enabled: true },
    ];
    const spaces = [
      { id: 'floor-4', parent_id: 'building' },
      { id: 'building', parent_id: 'site' },
      { id: 'site', parent_id: null },
    ];
    expect(resolveAppearance('floor-4', rows, spaces)?.hero_image_url).toBe('a.jpg');
  });

  it('walks up to an ancestor when the exact location has no row', () => {
    const rows = [
      { location_id: 'building', hero_image_url: 'b.jpg', welcome_headline: null, supporting_line: null, greeting_enabled: true },
    ];
    const spaces = [
      { id: 'floor-4', parent_id: 'building' },
      { id: 'building', parent_id: 'site' },
      { id: 'site', parent_id: null },
    ];
    expect(resolveAppearance('floor-4', rows, spaces)?.hero_image_url).toBe('b.jpg');
  });

  it('returns null when no ancestor has a row', () => {
    const rows: unknown[] = [];
    const spaces = [
      { id: 'floor-4', parent_id: 'building' },
      { id: 'building', parent_id: null },
    ];
    expect(resolveAppearance('floor-4', rows as any, spaces)).toBeNull();
  });

  it('stops at cycles (defensive)', () => {
    const rows: unknown[] = [];
    const spaces = [
      { id: 'a', parent_id: 'b' },
      { id: 'b', parent_id: 'a' },
    ];
    expect(resolveAppearance('a', rows as any, spaces)).toBeNull();
  });
});
```

- [ ] **Step 3: Run and verify failure**

Run: `pnpm --filter @prequest/api test -- portal-appearance.service.spec`
Expected: FAIL — `resolveAppearance` doesn't exist yet.

- [ ] **Step 4: Implement `portal-appearance.service.ts`**

```ts
// apps/api/src/modules/portal-appearance/portal-appearance.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { PortalAppearance, UpdatePortalAppearanceDto } from './dto';

const BUCKET = 'portal-assets';
const HERO_MAX_BYTES = 2 * 1024 * 1024;
const HERO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface AppearanceRow {
  location_id: string;
  hero_image_url: string | null;
  welcome_headline: string | null;
  supporting_line: string | null;
  greeting_enabled: boolean;
}

interface SpaceRow { id: string; parent_id: string | null }

/**
 * Walk up the spaces tree from `startId` looking for a portal_appearance row
 * whose location_id matches the walked id. Returns the first match, else null.
 * Exported for unit testing (pure function, no I/O).
 */
export function resolveAppearance(
  startId: string,
  rows: AppearanceRow[],
  spaces: SpaceRow[],
): AppearanceRow | null {
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const byLoc = new Map(rows.map((r) => [r.location_id, r]));
  const seen = new Set<string>();
  let cur: string | null = startId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const hit = byLoc.get(cur);
    if (hit) return hit;
    cur = byId.get(cur)?.parent_id ?? null;
  }
  return null;
}

@Injectable()
export class PortalAppearanceService {
  constructor(private readonly supabase: SupabaseService) {}

  async get(locationId: string): Promise<PortalAppearance | null> {
    const tenant = TenantContext.current();
    const [{ data: rows, error: rowsErr }, { data: spaces, error: spacesErr }] =
      await Promise.all([
        this.supabase.admin
          .from('portal_appearance')
          .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
          .eq('tenant_id', tenant.id),
        this.supabase.admin
          .from('spaces')
          .select('id, parent_id')
          .eq('tenant_id', tenant.id),
      ]);
    if (rowsErr) throw new InternalServerErrorException(rowsErr.message);
    if (spacesErr) throw new InternalServerErrorException(spacesErr.message);

    const resolved = resolveAppearance(locationId, rows ?? [], spaces ?? []);
    return resolved;
  }

  async list(): Promise<AppearanceRow[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('portal_appearance')
      .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
      .eq('tenant_id', tenant.id);
    if (error) throw new InternalServerErrorException(error.message);
    return data ?? [];
  }

  async update(dto: UpdatePortalAppearanceDto): Promise<PortalAppearance> {
    if (!dto.location_id) throw new BadRequestException('location_id is required');
    const tenant = TenantContext.current();

    const payload: Record<string, unknown> = { tenant_id: tenant.id, location_id: dto.location_id };
    if (dto.welcome_headline !== undefined) payload.welcome_headline = dto.welcome_headline;
    if (dto.supporting_line !== undefined) payload.supporting_line = dto.supporting_line;
    if (dto.greeting_enabled !== undefined) payload.greeting_enabled = dto.greeting_enabled;

    const { data, error } = await this.supabase.admin
      .from('portal_appearance')
      .upsert(payload, { onConflict: 'tenant_id,location_id' })
      .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Upsert returned no row');
    return data as PortalAppearance;
  }

  async uploadHero(
    locationId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<PortalAppearance> {
    if (!locationId) throw new BadRequestException('location_id is required');
    if (!file) throw new BadRequestException('Missing file');
    if (!HERO_MIMES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported mime: ${file.mimetype}`);
    }
    if (file.buffer.byteLength > HERO_MAX_BYTES) {
      throw new BadRequestException(`File too large: ${file.buffer.byteLength} (max ${HERO_MAX_BYTES})`);
    }

    const tenant = TenantContext.current();
    const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const)[file.mimetype];
    const path = `${tenant.id}/hero/${locationId}.${ext}`;

    const { error: uploadErr } = await this.supabase.admin.storage
      .from(BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: true, cacheControl: '3600' });
    if (uploadErr) throw new InternalServerErrorException(uploadErr.message);

    const { data: pub } = this.supabase.admin.storage.from(BUCKET).getPublicUrl(path);
    const bustedUrl = `${pub.publicUrl}?v=${Date.now()}`;

    const { data, error } = await this.supabase.admin
      .from('portal_appearance')
      .upsert(
        { tenant_id: tenant.id, location_id: locationId, hero_image_url: bustedUrl },
        { onConflict: 'tenant_id,location_id' },
      )
      .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Upsert returned no row');
    return data as PortalAppearance;
  }

  async removeHero(locationId: string): Promise<PortalAppearance | null> {
    const tenant = TenantContext.current();
    const paths = ['jpg', 'png', 'webp'].map((e) => `${tenant.id}/hero/${locationId}.${e}`);
    await this.supabase.admin.storage.from(BUCKET).remove(paths);

    const { data, error } = await this.supabase.admin
      .from('portal_appearance')
      .update({ hero_image_url: null })
      .eq('tenant_id', tenant.id)
      .eq('location_id', locationId)
      .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? null) as PortalAppearance | null;
  }
}
```

- [ ] **Step 5: Re-run spec**

Run: `pnpm --filter @prequest/api test -- portal-appearance.service.spec`
Expected: PASS (all 4 tests).

- [ ] **Step 6: Write the controller**

```ts
// apps/api/src/modules/portal-appearance/portal-appearance.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { PortalAppearanceService } from './portal-appearance.service';
import { UpdatePortalAppearanceDto } from './dto';

@Controller('admin/portal-appearance')
@UseGuards(AuthGuard, AdminGuard)
export class PortalAppearanceController {
  constructor(private readonly service: PortalAppearanceService) {}

  @Get('list')
  async list() {
    return this.service.list();
  }

  @Get()
  async get(@Query('location_id') locationId: string) {
    if (!locationId) throw new BadRequestException('location_id is required');
    return this.service.get(locationId);
  }

  @Patch()
  async update(@Body() dto: UpdatePortalAppearanceDto) {
    return this.service.update(dto);
  }

  @Post('hero')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadHero(
    @Query('location_id') locationId: string,
    @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    return this.service.uploadHero(locationId, file);
  }

  @Delete('hero')
  async removeHero(@Query('location_id') locationId: string) {
    if (!locationId) throw new BadRequestException('location_id is required');
    return this.service.removeHero(locationId);
  }
}
```

- [ ] **Step 7: Write the module**

```ts
// apps/api/src/modules/portal-appearance/portal-appearance.module.ts
import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { PortalAppearanceController } from './portal-appearance.controller';
import { PortalAppearanceService } from './portal-appearance.service';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [PortalAppearanceController],
  providers: [PortalAppearanceService],
  exports: [PortalAppearanceService],
})
export class PortalAppearanceModule {}
```

- [ ] **Step 8: Register in `app.module.ts`**

Add import + include in the `imports` array:

```ts
import { PortalAppearanceModule } from './modules/portal-appearance/portal-appearance.module';
// ...
imports: [
  // ...existing...
  PortalAppearanceModule,
],
```

- [ ] **Step 9: Build + commit**

Run: `pnpm --filter @prequest/api build`
Expected: builds clean.

```bash
git add apps/api/src/modules/portal-appearance apps/api/src/app.module.ts
git commit -m "feat(portal): add portal-appearance module (CRUD + hero upload)"
```

### Task 7: `PortalAnnouncementsService` + controller + spec

**Files:**
- Create: `apps/api/src/modules/portal-announcements/portal-announcements.module.ts`
- Create: `apps/api/src/modules/portal-announcements/portal-announcements.controller.ts`
- Create: `apps/api/src/modules/portal-announcements/portal-announcements.service.ts`
- Create: `apps/api/src/modules/portal-announcements/portal-announcements.service.spec.ts`
- Create: `apps/api/src/modules/portal-announcements/dto.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write `dto.ts`**

```ts
// apps/api/src/modules/portal-announcements/dto.ts
export interface Announcement {
  id: string;
  location_id: string;
  title: string;
  body: string;
  published_at: string;
  expires_at: string | null;
  created_by: string | null;
}

export interface PublishAnnouncementDto {
  location_id: string;
  title: string;
  body: string;
  expires_at?: string | null;
}
```

- [ ] **Step 2: Write `portal-announcements.service.ts`**

```ts
// apps/api/src/modules/portal-announcements/portal-announcements.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { Announcement, PublishAnnouncementDto } from './dto';

@Injectable()
export class PortalAnnouncementsService {
  constructor(private readonly supabase: SupabaseService) {}

  /** Walk-up resolver: the first ancestor with an active announcement wins. */
  async getActiveForLocation(locationId: string): Promise<Announcement | null> {
    const tenant = TenantContext.current();
    const [{ data: anns, error: aErr }, { data: spaces, error: sErr }] = await Promise.all([
      this.supabase.admin
        .from('portal_announcements')
        .select('id, location_id, title, body, published_at, expires_at, created_by')
        .eq('tenant_id', tenant.id)
        .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString()),
      this.supabase.admin
        .from('spaces')
        .select('id, parent_id')
        .eq('tenant_id', tenant.id),
    ]);
    if (aErr) throw new InternalServerErrorException(aErr.message);
    if (sErr) throw new InternalServerErrorException(sErr.message);

    const byLoc = new Map<string, Announcement>();
    for (const a of anns ?? []) byLoc.set(a.location_id, a as Announcement);
    const byId = new Map((spaces ?? []).map((s) => [s.id, s.parent_id]));
    const seen = new Set<string>();
    let cur: string | null = locationId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const hit = byLoc.get(cur);
      if (hit) return hit;
      cur = byId.get(cur) ?? null;
    }
    return null;
  }

  async listAll(): Promise<Announcement[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('portal_announcements')
      .select('id, location_id, title, body, published_at, expires_at, created_by')
      .eq('tenant_id', tenant.id)
      .order('published_at', { ascending: false });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as Announcement[];
  }

  /** Publish retires any existing active announcement for the same location. */
  async publish(dto: PublishAnnouncementDto, authUserId: string): Promise<Announcement> {
    if (!dto.location_id || !dto.title?.trim() || !dto.body?.trim()) {
      throw new BadRequestException('location_id, title, body are required');
    }
    const tenant = TenantContext.current();

    // Retire existing active: expire at now()
    const nowIso = new Date().toISOString();
    await this.supabase.admin
      .from('portal_announcements')
      .update({ expires_at: nowIso })
      .eq('tenant_id', tenant.id)
      .eq('location_id', dto.location_id)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

    const { data, error } = await this.supabase.admin
      .from('portal_announcements')
      .insert({
        tenant_id: tenant.id,
        location_id: dto.location_id,
        title: dto.title.trim(),
        body: dto.body.trim(),
        expires_at: dto.expires_at ?? null,
        created_by: authUserId,
      })
      .select('id, location_id, title, body, published_at, expires_at, created_by')
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Insert returned no row');
    return data as Announcement;
  }

  async unpublish(id: string): Promise<void> {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('portal_announcements')
      .update({ expires_at: new Date().toISOString() })
      .eq('tenant_id', tenant.id)
      .eq('id', id);
    if (error) throw new InternalServerErrorException(error.message);
  }
}
```

- [ ] **Step 3: Write the controller**

```ts
// apps/api/src/modules/portal-announcements/portal-announcements.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { PortalAnnouncementsService } from './portal-announcements.service';
import { PublishAnnouncementDto } from './dto';

@Controller('admin/portal-announcements')
@UseGuards(AuthGuard, AdminGuard)
export class PortalAnnouncementsController {
  constructor(private readonly service: PortalAnnouncementsService) {}

  @Get()
  async list() {
    return this.service.listAll();
  }

  @Post()
  async publish(@Req() req: Request, @Body() dto: PublishAnnouncementDto) {
    const uid = (req as { user?: { id: string } }).user?.id ?? null;
    return this.service.publish(dto, uid as string);
  }

  @Delete(':id')
  async unpublish(@Param('id') id: string) {
    await this.service.unpublish(id);
    return { ok: true };
  }
}
```

- [ ] **Step 4: Write the module**

```ts
// apps/api/src/modules/portal-announcements/portal-announcements.module.ts
import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { PortalAnnouncementsController } from './portal-announcements.controller';
import { PortalAnnouncementsService } from './portal-announcements.service';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [PortalAnnouncementsController],
  providers: [PortalAnnouncementsService],
  exports: [PortalAnnouncementsService],
})
export class PortalAnnouncementsModule {}
```

- [ ] **Step 5: Register in `app.module.ts`**

```ts
import { PortalAnnouncementsModule } from './modules/portal-announcements/portal-announcements.module';
// add to imports array
```

- [ ] **Step 6: Build + commit**

Run: `pnpm --filter @prequest/api build`
Expected: clean build.

```bash
git add apps/api/src/modules/portal-announcements apps/api/src/app.module.ts
git commit -m "feat(portal): add portal-announcements module (publish/unpublish)"
```

### Task 8: Extend catalog category PATCH + add cover upload endpoint

**Files:**
- Modify: `apps/api/src/modules/config-engine/service-catalog.controller.ts` — exposes `@Patch('categories/:id')` today; add cover fields to its DTO and add a new cover upload route
- Modify: the paired service file (same module, find via `grep -n 'updateCategory\|patch' apps/api/src/modules/config-engine/*.ts`)

- [ ] **Step 1: Confirm the exact service method name**

Run: `grep -n "updateCategory\|patch.*category\|categories/:id" apps/api/src/modules/config-engine/service-catalog.controller.ts`
Expected: finds the `@Patch('categories/:id')` decorator and the service method it delegates to (likely `updateCategory` or similar on a nearby service).

- [ ] **Step 2: Extend the update DTO**

Add `cover_image_url?: string | null` and `cover_source?: 'image' | 'icon'` to the existing `UpdateCategoryDto`:

```ts
export interface UpdateCategoryDto {
  name?: string;
  description?: string | null;
  icon?: string | null;
  parent_category_id?: string | null;
  cover_image_url?: string | null;
  cover_source?: 'image' | 'icon';
}
```

- [ ] **Step 3: Extend the service update method**

In the service, add the new fields to the whitelist of updatable columns. Example:

```ts
const payload: Record<string, unknown> = {};
if (dto.name !== undefined)                payload.name = dto.name;
if (dto.description !== undefined)         payload.description = dto.description;
if (dto.icon !== undefined)                payload.icon = dto.icon;
if (dto.parent_category_id !== undefined)  payload.parent_category_id = dto.parent_category_id;
if (dto.cover_image_url !== undefined)     payload.cover_image_url = dto.cover_image_url;
if (dto.cover_source !== undefined) {
  if (!['image', 'icon'].includes(dto.cover_source)) {
    throw new BadRequestException(`invalid cover_source: ${dto.cover_source}`);
  }
  payload.cover_source = dto.cover_source;
}
```

- [ ] **Step 4: Add a cover upload endpoint**

In the controller, add:

```ts
@Post('categories/:id/cover')
@UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
async uploadCover(
  @Param('id') id: string,
  @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
) {
  return this.service.uploadCover(id, file);
}
```

In the service:

```ts
async uploadCover(
  categoryId: string,
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
) {
  const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!ALLOWED.has(file.mimetype)) throw new BadRequestException(`Unsupported mime: ${file.mimetype}`);
  if (file.buffer.byteLength > 2 * 1024 * 1024) throw new BadRequestException('File too large');

  const tenant = TenantContext.current();
  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const)[file.mimetype];
  const path = `${tenant.id}/category-cover/${categoryId}.${ext}`;

  const { error: upErr } = await this.supabase.admin.storage
    .from('portal-assets')
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: true, cacheControl: '3600' });
  if (upErr) throw new InternalServerErrorException(upErr.message);

  const { data: pub } = this.supabase.admin.storage.from('portal-assets').getPublicUrl(path);
  const url = `${pub.publicUrl}?v=${Date.now()}`;

  const { data, error } = await this.supabase.admin
    .from('catalog_categories')
    .update({ cover_image_url: url, cover_source: 'image' })
    .eq('id', categoryId)
    .eq('tenant_id', tenant.id)
    .select()
    .single();
  if (error) throw new InternalServerErrorException(error.message);
  return data;
}
```

- [ ] **Step 5: Build + commit**

Run: `pnpm --filter @prequest/api build`

```bash
git add apps/api/src/modules/catalog-menu
git commit -m "feat(catalog): category PATCH accepts cover_image_url/cover_source + cover upload endpoint"
```

### Task 9: Extend `/portal/me` to include appearance + announcement

**Files:**
- Modify: `apps/api/src/modules/portal/portal.service.ts`
- Modify: `apps/api/src/modules/portal/portal.module.ts` (inject new services)

- [ ] **Step 1: Update `PortalMeResponse`**

In `portal.service.ts`, extend the interface:

```ts
export interface PortalMeResponse {
  // ...existing fields unchanged...
  appearance: {
    hero_image_url: string | null;
    welcome_headline: string | null;
    supporting_line: string | null;
    greeting_enabled: boolean;
  } | null;
  announcement: {
    id: string;
    title: string;
    body: string;
    published_at: string;
    expires_at: string | null;
  } | null;
}
```

- [ ] **Step 2: Inject the new services**

In the existing `PortalService` constructor, add:

```ts
constructor(
  private readonly supabase: SupabaseService,
  private readonly appearance: PortalAppearanceService,
  private readonly announcements: PortalAnnouncementsService,
) {}
```

Update `portal.module.ts` imports to include both new modules.

- [ ] **Step 3: Wire into `getMe`**

In `getMe(authUid)`, after the existing current_location resolution:

```ts
// ... existing code that yields currentLocation ...

let appearance = null;
let announcement = null;
if (currentLocation) {
  const [app, ann] = await Promise.all([
    this.appearance.get(currentLocation.id),
    this.announcements.getActiveForLocation(currentLocation.id),
  ]);
  appearance = app
    ? {
        hero_image_url: app.hero_image_url,
        welcome_headline: app.welcome_headline,
        supporting_line: app.supporting_line,
        greeting_enabled: app.greeting_enabled,
      }
    : null;
  announcement = ann
    ? {
        id: ann.id,
        title: ann.title,
        body: ann.body,
        published_at: ann.published_at,
        expires_at: ann.expires_at,
      }
    : null;
}

return {
  // ...existing fields...
  appearance,
  announcement,
};
```

- [ ] **Step 4: Smoke test via curl**

Restart dev:
```bash
pnpm dev:api &
sleep 4
curl -sS "http://localhost:3000/api/portal/me" -H "Authorization: Bearer $TEST_JWT" | jq '{has_appearance: (.appearance != null), has_announcement: (.announcement != null)}'
```
Expected: a valid JSON object, both fields present (even if null).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/portal
git commit -m "feat(portal): include appearance + active announcement in /portal/me"
```

---

## Phase B — Portal shell

### Task 10: `PortalAccountMenu` component

**Files:**
- Create: `apps/web/src/components/portal/portal-account-menu.tsx`

- [ ] **Step 1: Scaffold the component**

```tsx
// apps/web/src/components/portal/portal-account-menu.tsx
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { ArrowRightLeft, LogOut, User } from 'lucide-react';

export function PortalAccountMenu() {
  const navigate = useNavigate();
  const { user, profile, signOut, hasRole } = useAuth();

  const showSwitchLink = hasRole('agent') || hasRole('admin');
  const initials = profile?.first_name
    ? `${profile.first_name[0] ?? ''}${profile.last_name?.[0] ?? ''}`.toUpperCase()
    : (user?.email?.[0] ?? 'U').toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className="size-8 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Avatar className="size-8">
            <AvatarImage src={profile?.avatar_url ?? undefined} alt="" />
            <AvatarFallback className="bg-gradient-to-br from-indigo-500 to-pink-500 text-white text-xs font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">
            {profile?.first_name} {profile?.last_name}
          </div>
          <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/portal/account')}>
          <User className="mr-2 size-4" />
          Account
        </DropdownMenuItem>
        {showSwitchLink && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('/desk')}>
              <ArrowRightLeft className="mr-2 size-4" />
              Switch to Service Desk
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut()}>
          <LogOut className="mr-2 size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @prequest/web build`
Expected: no TS errors.

- [ ] **Step 3: Manual smoke (browser deferred to Task 14)**

No separate step — the menu will get real integration testing once the layout wires it in.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/portal/portal-account-menu.tsx
git commit -m "feat(portal): add PortalAccountMenu with agent/admin switch link"
```

### Task 11: `PortalTopBar` + `PortalNavLink`

**Files:**
- Create: `apps/web/src/components/portal/portal-nav-link.tsx`
- Create: `apps/web/src/components/portal/portal-top-bar.tsx`

- [ ] **Step 1: `PortalNavLink`**

```tsx
// apps/web/src/components/portal/portal-nav-link.tsx
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

interface Props {
  to: string;
  label: string;
  matchExact?: boolean;
}

export function PortalNavLink({ to, label, matchExact }: Props) {
  return (
    <NavLink
      to={to}
      end={matchExact}
      className={({ isActive }) =>
        cn(
          'relative px-1 py-2 text-sm font-medium transition-colors',
          'text-muted-foreground hover:text-foreground',
          'focus-visible:outline-none focus-visible:text-foreground',
          isActive && 'text-foreground',
          isActive &&
            'after:absolute after:inset-x-0 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-foreground',
        )
      }
    >
      {label}
    </NavLink>
  );
}
```

- [ ] **Step 2: `PortalTopBar`**

```tsx
// apps/web/src/components/portal/portal-top-bar.tsx
import { Link } from 'react-router-dom';
import { PortalNavLink } from './portal-nav-link';
import { PortalLocationPicker } from './portal-location-picker';
import { PortalAccountMenu } from './portal-account-menu';
import { useBranding } from '@/hooks/use-branding';
import { usePortal } from '@/providers/portal-provider';

export function PortalTopBar() {
  const { branding } = useBranding();
  const { data: portal } = usePortal();

  const workplaceName = portal?.current_location?.name ?? branding?.logo_light_url ? '' : 'Prequest';

  return (
    <header
      className="sticky top-0 z-40 h-14 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/75"
      style={{ transitionTimingFunction: 'var(--ease-smooth)' }}
    >
      {/* Desktop: 3-col grid (brand / nav / account) */}
      <div className="hidden md:grid h-full grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 md:px-6 lg:px-8 mx-auto max-w-[1600px]">
        <Link to="/portal" className="flex items-center gap-2 min-w-0">
          {branding?.logo_light_url ? (
            <img src={branding.logo_light_url} alt="" className="h-6 w-auto" />
          ) : (
            <div className="size-6 rounded-md bg-gradient-to-br from-indigo-500 to-pink-500" aria-hidden />
          )}
          <span className="truncate font-semibold tracking-tight text-sm">
            {portal?.current_location?.name ?? 'Portal'}
          </span>
        </Link>

        <nav className="flex items-center gap-6" aria-label="Portal navigation">
          <PortalNavLink to="/portal"          label="Home"     matchExact />
          <PortalNavLink to="/portal/requests" label="Requests" />
          <PortalNavLink to="/portal/rooms"    label="Rooms"    />
          <PortalNavLink to="/portal/visitors" label="Visitors" />
          <PortalNavLink to="/portal/order"    label="Order"    />
        </nav>

        <div className="flex items-center gap-3 justify-end">
          <PortalLocationPicker />
          <PortalAccountMenu />
        </div>
      </div>

      {/* Mobile: brand + location chip + account */}
      <div className="md:hidden flex h-full items-center gap-2 px-4">
        <Link to="/portal" className="flex items-center gap-2 min-w-0 flex-1">
          {branding?.logo_light_url ? (
            <img src={branding.logo_light_url} alt="" className="h-5 w-auto" />
          ) : (
            <div className="size-5 rounded bg-gradient-to-br from-indigo-500 to-pink-500" aria-hidden />
          )}
          <span className="truncate font-semibold tracking-tight text-sm">
            {portal?.current_location?.name ?? 'Portal'}
          </span>
        </Link>
        <PortalLocationPicker compact />
        <PortalAccountMenu />
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Add `compact` prop to `PortalLocationPicker`**

Inspect `apps/web/src/components/portal/portal-location-picker.tsx`. Add an optional `compact` boolean prop. When `compact`, the trigger shows only the shortest label (`current_location.name` truncated to 2 words, or just the level identifier). If the component already supports it, skip this step.

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @prequest/web build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/portal/portal-top-bar.tsx apps/web/src/components/portal/portal-nav-link.tsx apps/web/src/components/portal/portal-location-picker.tsx
git commit -m "feat(portal): add PortalTopBar (desktop 3-col + mobile compact)"
```

### Task 12: `PortalBottomTabs`

**Files:**
- Create: `apps/web/src/components/portal/portal-bottom-tabs.tsx`

- [ ] **Step 1: Component**

```tsx
// apps/web/src/components/portal/portal-bottom-tabs.tsx
import { NavLink } from 'react-router-dom';
import { Home, FileText, CalendarDays, UserPlus, ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { to: '/portal',          label: 'Home',     icon: Home,         matchExact: true },
  { to: '/portal/requests', label: 'Requests', icon: FileText,     matchExact: false },
  { to: '/portal/rooms',    label: 'Rooms',    icon: CalendarDays, matchExact: false },
  { to: '/portal/visitors', label: 'Visitors', icon: UserPlus,     matchExact: false },
  { to: '/portal/order',    label: 'Order',    icon: ShoppingCart, matchExact: false },
] as const;

export function PortalBottomTabs() {
  return (
    <nav
      aria-label="Portal primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 h-16 border-t bg-background/95 backdrop-blur
                 supports-[backdrop-filter]:bg-background/85
                 pb-[env(safe-area-inset-bottom)]
                 grid grid-cols-5"
    >
      {tabs.map(({ to, label, icon: Icon, matchExact }) => (
        <NavLink
          key={to}
          to={to}
          end={matchExact}
          aria-label={label}
          className={({ isActive }) =>
            cn(
              'flex flex-col items-center justify-center gap-1 text-[11px] transition-colors',
              'text-muted-foreground active:translate-y-px',
              isActive && 'text-foreground font-medium',
            )
          }
          style={{ transitionTimingFunction: 'var(--ease-swift-out)', transitionDuration: '160ms' }}
        >
          <Icon className="size-5" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @prequest/web build`

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/portal/portal-bottom-tabs.tsx
git commit -m "feat(portal): add PortalBottomTabs (mobile 5-tab bar)"
```

### Task 13: `PortalPage` wrapper

**Files:**
- Create: `apps/web/src/components/portal/portal-page.tsx`

- [ ] **Step 1: Component**

```tsx
// apps/web/src/components/portal/portal-page.tsx
import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  children: ReactNode;
  /** Optional class to apply to the inner content wrapper. */
  className?: string;
  /** When true, the page renders with no horizontal padding (edge-to-edge). Used when the first child is a full-bleed hero. */
  bleed?: boolean;
}

/**
 * Content wrapper for portal pages. Matches the SettingsPageWidth.ultra (1600px)
 * but with portal-appropriate padding. Full-bleed heroes can break out with
 * `-mx-4 md:-mx-6 lg:-mx-8`.
 */
export function PortalPage({ children, className, bleed }: Props) {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[1600px]',
        !bleed && 'px-4 md:px-6 lg:px-8',
        'pb-24 md:pb-10', // space for bottom tabs on mobile
        className,
      )}
    >
      {children}
    </div>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/portal/portal-page.tsx
git commit -m "feat(portal): add PortalPage (1600px content wrapper)"
```

### Task 14: Rewrite `portal-layout.tsx` + add "Switch to Portal" link in operator shells

**Files:**
- Modify: `apps/web/src/layouts/portal-layout.tsx` (full rewrite — no sidebar)
- Modify: `apps/web/src/layouts/desk-layout.tsx` + `apps/web/src/layouts/admin-layout.tsx` (add symmetric switch link)
- Modify: `apps/web/src/components/nav-user.tsx` or wherever the operator account menu lives (find it)

- [ ] **Step 1: Rewrite `portal-layout.tsx`**

```tsx
// apps/web/src/layouts/portal-layout.tsx
import { Outlet } from 'react-router-dom';
import { PortalProvider, usePortal } from '@/providers/portal-provider';
import { PortalTopBar } from '@/components/portal/portal-top-bar';
import { PortalBottomTabs } from '@/components/portal/portal-bottom-tabs';
import { PortalNoScopeBlocker } from '@/components/portal/portal-no-scope-blocker';

export function PortalLayout() {
  return (
    <PortalProvider>
      <PortalLayoutInner />
    </PortalProvider>
  );
}

function PortalLayoutInner() {
  const { data: portal, loading } = usePortal();

  return (
    <div className="min-h-screen bg-background">
      <PortalTopBar />
      <main>
        {!loading && portal && !portal.can_submit ? <PortalNoScopeBlocker /> : <Outlet />}
      </main>
      <PortalBottomTabs />
    </div>
  );
}
```

- [ ] **Step 2: Find the operator account menu**

Run: `grep -rn "nav-user\|NavUser" apps/web/src/components apps/web/src/layouts | head -10`
Expected: `apps/web/src/components/nav-user.tsx` exists — that's the operator account dropdown.

- [ ] **Step 3: Add "Switch to Portal" link in `NavUser`**

Read `apps/web/src/components/nav-user.tsx`. In the dropdown menu items, add a new item *before* "Sign out":

```tsx
import { ArrowRightLeft } from 'lucide-react';
// ...
<DropdownMenuSeparator />
<DropdownMenuItem onSelect={() => navigate('/portal')}>
  <ArrowRightLeft className="mr-2 size-4" />
  Switch to Portal
</DropdownMenuItem>
```

Make sure `useNavigate` is imported.

- [ ] **Step 4: Start both servers and manually verify**

Run: `pnpm dev`

Test these in a browser:
1. Visit `/portal` — should show the new top nav, no sidebar, location picker + account avatar on the right. On narrow viewport, bottom tab bar appears.
2. Click the account avatar — "Switch to Service Desk" appears when the account is an agent/admin.
3. Navigate between Home / Requests / Rooms / Visitors / Order — active underline moves.
4. Mobile (devtools, iPhone 14): bottom tab bar sticky, active state correct.
5. Visit `/desk` — operator layout loads. Open NavUser → "Switch to Portal" link exists, navigates to `/portal`.

Document any issues + fix before proceeding.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/layouts/portal-layout.tsx apps/web/src/components/nav-user.tsx
git commit -m "feat(portal): swap layout to top-nav shell with bottom tabs; add symmetric switch link"
```

---

## Phase C — Admin surfaces

### Task 15: React Query hooks — `portal-appearance` + `portal-announcements`

**Files:**
- Create: `apps/web/src/api/portal-appearance/index.ts`
- Create: `apps/web/src/api/portal-announcements/index.ts`

- [ ] **Step 1: `portal-appearance`**

```ts
// apps/web/src/api/portal-appearance/index.ts
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface PortalAppearance {
  location_id: string;
  hero_image_url: string | null;
  welcome_headline: string | null;
  supporting_line: string | null;
  greeting_enabled: boolean;
}

export interface UpdatePortalAppearancePayload {
  location_id: string;
  welcome_headline?: string | null;
  supporting_line?: string | null;
  greeting_enabled?: boolean;
}

export const portalAppearanceKeys = {
  all: ['portal-appearance'] as const,
  lists: () => [...portalAppearanceKeys.all, 'list'] as const,
  list: () => [...portalAppearanceKeys.lists()] as const,
  detail: (locationId: string) => [...portalAppearanceKeys.all, 'detail', locationId] as const,
} as const;

export function portalAppearanceListOptions() {
  return queryOptions({
    queryKey: portalAppearanceKeys.list(),
    queryFn: ({ signal }) => apiFetch<PortalAppearance[]>('/admin/portal-appearance/list', { signal }),
    staleTime: 60_000,
  });
}

export function usePortalAppearanceList() {
  return useQuery(portalAppearanceListOptions());
}

export function useUpdatePortalAppearance() {
  const qc = useQueryClient();
  return useMutation<PortalAppearance, Error, UpdatePortalAppearancePayload>({
    mutationFn: (payload) =>
      apiFetch<PortalAppearance>('/admin/portal-appearance', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: portalAppearanceKeys.all }),
  });
}

export function useUploadPortalHero() {
  const qc = useQueryClient();
  return useMutation<PortalAppearance, Error, { location_id: string; file: File }>({
    mutationFn: async ({ location_id, file }) => {
      const form = new FormData();
      form.append('file', file);
      return apiFetch<PortalAppearance>(
        `/admin/portal-appearance/hero?location_id=${encodeURIComponent(location_id)}`,
        { method: 'POST', body: form },
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: portalAppearanceKeys.all }),
  });
}

export function useRemovePortalHero() {
  const qc = useQueryClient();
  return useMutation<PortalAppearance | null, Error, string>({
    mutationFn: (location_id) =>
      apiFetch(
        `/admin/portal-appearance/hero?location_id=${encodeURIComponent(location_id)}`,
        { method: 'DELETE' },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: portalAppearanceKeys.all }),
  });
}
```

- [ ] **Step 2: `portal-announcements`**

```ts
// apps/web/src/api/portal-announcements/index.ts
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Announcement {
  id: string;
  location_id: string;
  title: string;
  body: string;
  published_at: string;
  expires_at: string | null;
  created_by: string | null;
}

export interface PublishAnnouncementPayload {
  location_id: string;
  title: string;
  body: string;
  expires_at?: string | null;
}

export const portalAnnouncementKeys = {
  all: ['portal-announcements'] as const,
  list: () => [...portalAnnouncementKeys.all, 'list'] as const,
} as const;

export function portalAnnouncementsListOptions() {
  return queryOptions({
    queryKey: portalAnnouncementKeys.list(),
    queryFn: ({ signal }) => apiFetch<Announcement[]>('/admin/portal-announcements', { signal }),
    staleTime: 30_000,
  });
}

export function usePortalAnnouncements() {
  return useQuery(portalAnnouncementsListOptions());
}

export function usePublishAnnouncement() {
  const qc = useQueryClient();
  return useMutation<Announcement, Error, PublishAnnouncementPayload>({
    mutationFn: (payload) =>
      apiFetch<Announcement>('/admin/portal-announcements', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: portalAnnouncementKeys.all }),
  });
}

export function useUnpublishAnnouncement() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) => apiFetch(`/admin/portal-announcements/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: portalAnnouncementKeys.all }),
  });
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/api/portal-appearance apps/web/src/api/portal-announcements
git commit -m "feat(portal): add React Query hooks for portal-appearance + portal-announcements"
```

### Task 16: Admin — `<PortalAppearanceSection />` + hero upload dialog

**Files:**
- Create: `apps/web/src/components/admin/portal/portal-hero-upload-dialog.tsx`
- Create: `apps/web/src/components/admin/portal/portal-hero-slot.tsx`
- Create: `apps/web/src/components/admin/portal/portal-appearance-section.tsx`

- [ ] **Step 1: `portal-hero-upload-dialog.tsx`**

```tsx
// apps/web/src/components/admin/portal/portal-hero-upload-dialog.tsx
import { useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUploadPortalHero } from '@/api/portal-appearance';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  locationId: string;
  locationName: string;
  currentUrl: string | null;
}

export function PortalHeroUploadDialog({ open, onOpenChange, locationId, locationName, currentUrl }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const upload = useUploadPortalHero();

  const preview = file ? URL.createObjectURL(file) : currentUrl;

  const handleSubmit = async () => {
    if (!file) return;
    try {
      await upload.mutateAsync({ location_id: locationId, file });
      toast.success('Hero uploaded');
      onOpenChange(false);
      setFile(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload hero — {locationName}</DialogTitle>
          <DialogDescription>
            Recommended 2400 × 800 px. JPG/PNG/WebP, max 2 MB. An overlay gradient is applied automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="aspect-[3/1] w-full overflow-hidden rounded-md border bg-muted">
          {preview ? (
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              No image
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button variant="outline" onClick={() => inputRef.current?.click()}>
            Choose file
          </Button>
          {file && <span className="text-sm text-muted-foreground truncate">{file.name}</span>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!file || upload.isPending} onClick={handleSubmit}>
            {upload.isPending ? 'Uploading…' : 'Upload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: `portal-hero-slot.tsx`**

```tsx
// apps/web/src/components/admin/portal/portal-hero-slot.tsx
import { useState } from 'react';
import { SettingsRow, SettingsRowValue } from '@/components/ui/settings-row';
import { Button } from '@/components/ui/button';
import { PortalHeroUploadDialog } from './portal-hero-upload-dialog';
import { useRemovePortalHero } from '@/api/portal-appearance';
import { toast } from 'sonner';

interface Props {
  locationId: string;
  locationName: string;
  currentUrl: string | null;
}

export function PortalHeroSlot({ locationId, locationName, currentUrl }: Props) {
  const [open, setOpen] = useState(false);
  const remove = useRemovePortalHero();

  const handleRemove = async () => {
    try {
      await remove.mutateAsync(locationId);
      toast.success('Hero removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Remove failed');
    }
  };

  return (
    <>
      <SettingsRow
        label={`Hero — ${locationName}`}
        description={
          currentUrl
            ? 'Uploaded. Click to replace.'
            : 'Not uploaded — using default gradient with your logo.'
        }
      >
        <div className="flex items-center gap-3">
          {currentUrl ? (
            <img src={currentUrl} alt="" className="h-10 w-20 rounded border object-cover" />
          ) : (
            <div className="h-10 w-20 rounded border border-dashed bg-muted" aria-hidden />
          )}
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {currentUrl ? 'Replace' : 'Upload'}
          </Button>
          {currentUrl && (
            <Button variant="ghost" size="sm" onClick={handleRemove} disabled={remove.isPending}>
              Remove
            </Button>
          )}
        </div>
      </SettingsRow>
      <PortalHeroUploadDialog
        open={open}
        onOpenChange={setOpen}
        locationId={locationId}
        locationName={locationName}
        currentUrl={currentUrl}
      />
    </>
  );
}
```

- [ ] **Step 3: `portal-appearance-section.tsx`**

```tsx
// apps/web/src/components/admin/portal/portal-appearance-section.tsx
import { useEffect, useState } from 'react';
import { SettingsGroup, SettingsRow } from '@/components/ui/settings-row';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { usePortalAppearanceList, useUpdatePortalAppearance } from '@/api/portal-appearance';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { useSpaceTree } from '@/api/spaces';
import type { SpaceTreeNode } from '@/api/spaces/types';
import { PortalHeroSlot } from './portal-hero-slot';
import { toast } from 'sonner';

// Flatten the tree into a list of sites + buildings. Hero config lives at
// that level — rooms/floors/desks inherit via the resolver walk-up.
function flattenSitesAndBuildings(nodes: SpaceTreeNode[]): SpaceTreeNode[] {
  const out: SpaceTreeNode[] = [];
  const visit = (n: SpaceTreeNode) => {
    if (n.type === 'site' || n.type === 'building') out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  for (const n of nodes) visit(n);
  return out;
}

export function PortalAppearanceSection() {
  const { data: rows } = usePortalAppearanceList();
  const { data: tree } = useSpaceTree();
  const update = useUpdatePortalAppearance();

  const heroLocations = flattenSitesAndBuildings(tree ?? []);

  // Pick the first building (or site) as the "primary" location for greeting + announcement edits.
  // The per-location greeting settings live under each building but for v1, edit the primary only.
  const primary = heroLocations[0];
  const primaryRow = rows?.find((r) => r.location_id === primary?.id);

  const [headline, setHeadline] = useState('');
  const [sub, setSub] = useState('');
  const [greeting, setGreeting] = useState(true);

  useEffect(() => {
    setHeadline(primaryRow?.welcome_headline ?? '');
    setSub(primaryRow?.supporting_line ?? '');
    setGreeting(primaryRow?.greeting_enabled ?? true);
  }, [primaryRow?.location_id]);

  const saveField = async (field: 'welcome_headline' | 'supporting_line' | 'greeting_enabled', value: string | boolean | null) => {
    if (!primary) return;
    try {
      await update.mutateAsync({ location_id: primary.id, [field]: value } as any);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  useDebouncedSave(headline, (v) => saveField('welcome_headline', v || null));
  useDebouncedSave(sub, (v) => saveField('supporting_line', v || null));

  return (
    <div className="mt-10 space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Portal appearance</h2>
        <p className="text-sm text-muted-foreground mt-1 max-w-xl">
          How the employee portal looks. Skip anything and the portal falls back to a branded default — gradient hero, no announcements.
        </p>
      </div>

      <SettingsGroup title="Workplace hero">
        {heroLocations.map((loc) => {
          const row = rows?.find((r) => r.location_id === loc.id);
          return (
            <PortalHeroSlot
              key={loc.id}
              locationId={loc.id}
              locationName={loc.name}
              currentUrl={row?.hero_image_url ?? null}
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup title="Greeting & voice">
        <SettingsRow label="Welcome headline" description="Shown below the time-of-day greeting. Under 50 chars.">
          <Input value={headline} onChange={(e) => setHeadline(e.target.value)} placeholder="How can we help you today?" className="max-w-sm" />
        </SettingsRow>
        <SettingsRow label="Supporting line" description="One sentence beneath the headline.">
          <Input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Submit a request, book a room…" className="max-w-sm" />
        </SettingsRow>
        <SettingsRow label="Time-of-day greeting" description='Prefix with "Good morning / afternoon / evening, [name]".'>
          <Switch checked={greeting} onCheckedChange={(v) => { setGreeting(v); void saveField('greeting_enabled', v); }} />
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
```

- [ ] **Step 4: Verify `useDebouncedSave` exists**

Run: `ls apps/web/src/hooks/use-debounced-save.ts`
Expected: file exists (referenced in CLAUDE.md). If not, stub a minimal implementation or adapt to an existing debounce helper in the repo.

- [ ] **Step 5: Type-check + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/admin/portal
git commit -m "feat(admin): add PortalAppearanceSection (hero slots + greeting + switch)"
```

### Task 17: Announcements — dialog + section integration

**Files:**
- Create: `apps/web/src/components/admin/portal/announcement-dialog.tsx`
- Modify: `apps/web/src/components/admin/portal/portal-appearance-section.tsx` (append an Announcements SettingsGroup)

- [ ] **Step 1: `announcement-dialog.tsx`**

```tsx
// apps/web/src/components/admin/portal/announcement-dialog.tsx
import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { usePublishAnnouncement, type Announcement } from '@/api/portal-announcements';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  locationId: string;
  locationName: string;
  editing?: Announcement | null;
}

export function AnnouncementDialog({ open, onOpenChange, locationId, locationName, editing }: Props) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [expires, setExpires] = useState('');
  const publish = usePublishAnnouncement();

  useEffect(() => {
    setTitle(editing?.title ?? '');
    setBody(editing?.body ?? '');
    setExpires(editing?.expires_at?.slice(0, 10) ?? '');
  }, [editing, open]);

  const submit = async () => {
    if (!title.trim() || !body.trim()) return;
    try {
      await publish.mutateAsync({
        location_id: locationId,
        title: title.trim(),
        body: body.trim(),
        expires_at: expires ? new Date(expires).toISOString() : null,
      });
      toast.success('Announcement published');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Publish failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit' : 'Publish'} announcement — {locationName}</DialogTitle>
          <DialogDescription>Shown on the portal home until it expires. One active per location.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="ann-title">Title</FieldLabel>
            <Input id="ann-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ann-body">Body</FieldLabel>
            <Textarea id="ann-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} rows={4} />
          </Field>
          <Field>
            <FieldLabel htmlFor="ann-expires">Expires (optional)</FieldLabel>
            <Input id="ann-expires" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            <FieldDescription>Leave blank to keep it active until manually unpublished.</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!title.trim() || !body.trim() || publish.isPending}>
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Add an Announcements SettingsGroup to `portal-appearance-section.tsx`**

Append after the existing groups:

```tsx
import { usePortalAnnouncements, useUnpublishAnnouncement } from '@/api/portal-announcements';
import { AnnouncementDialog } from './announcement-dialog';
// ...

const { data: announcements } = usePortalAnnouncements();
const unpublish = useUnpublishAnnouncement();
const [annDialogOpen, setAnnDialogOpen] = useState(false);
const [annEditing, setAnnEditing] = useState<Announcement | null>(null);
const active = (announcements ?? []).filter(
  (a) => !a.expires_at || new Date(a.expires_at) > new Date(),
);

// ... inside the rendered JSX, append:
<div className="flex items-end justify-between gap-4">
  <div>
    <h2 className="text-base font-medium">Announcements</h2>
    <p className="text-sm text-muted-foreground">One active per location. Edit replaces the current one.</p>
  </div>
  <Button size="sm" onClick={() => { setAnnEditing(null); setAnnDialogOpen(true); }}>
    Publish announcement
  </Button>
</div>
<SettingsGroup>
  {heroLocations.map((loc) => {
    const ann = active.find((a) => a.location_id === loc.id);
    return (
      <SettingsRow
        key={loc.id}
        label={loc.name}
        description={ann ? `"${ann.title}"` : 'No active announcement.'}
      >
        {ann ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => { setAnnEditing(ann); setAnnDialogOpen(true); }}>Edit</Button>
            <Button variant="ghost"   size="sm" onClick={() => unpublish.mutate(ann.id)}>Unpublish</Button>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => { setAnnEditing({ id: '', location_id: loc.id } as Announcement); setAnnDialogOpen(true); }}>
            Publish
          </Button>
        )}
      </SettingsRow>
    );
  })}
</SettingsGroup>

{annEditing !== null && (
  <AnnouncementDialog
    open={annDialogOpen}
    onOpenChange={setAnnDialogOpen}
    locationId={annEditing?.location_id ?? primary?.id ?? ''}
    locationName={heroLocations.find((l) => l.id === annEditing?.location_id)?.name ?? ''}
    editing={annEditing?.id ? annEditing : null}
  />
)}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/admin/portal
git commit -m "feat(admin): add portal announcements section + publish dialog"
```

### Task 18: Wire `<PortalAppearanceSection />` into `/admin/branding`

**Files:**
- Modify: `apps/web/src/pages/admin/branding.tsx`

- [ ] **Step 1: Import + render at page bottom**

At the bottom of the rendered JSX (before the closing `</SettingsPageShell>` or equivalent), add:

```tsx
import { PortalAppearanceSection } from '@/components/admin/portal/portal-appearance-section';
// ...
<PortalAppearanceSection />
```

- [ ] **Step 2: Browser smoke**

Run: `pnpm dev`

1. Navigate to `/admin/branding`.
2. Scroll down — new "Portal appearance" block visible with three SettingsGroups.
3. Click "Upload" on a hero slot — dialog appears, upload works.
4. Edit welcome headline — auto-saves (check network panel for PATCH on blur).
5. Click "Publish announcement" — dialog appears, publish works, row updates.

Fix any issues before commit.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/admin/branding.tsx
git commit -m "feat(admin): mount PortalAppearanceSection under /admin/branding"
```

### Task 19: `<CategoryCoverPicker />` + wire into catalog dialog

**Files:**
- Create: `apps/web/src/components/admin/catalog/category-cover-picker.tsx`
- Modify: `apps/web/src/pages/admin/catalog-hierarchy.tsx` (add to category edit dialog)

- [ ] **Step 1: Default cover assets**

Seed 4 platform-default cover URLs. For v1 these can be static gradient files under `apps/web/public/covers/default-{1..4}.jpg` — or just CSS gradient strings used by `<div style>` in the admin picker and also stored as URLs like `"platform:default-1"` in `cover_image_url` to signal "render the gradient." For v1, use static files so the same URL can render in both admin preview and portal home. Generate four 1200×600 gradient JPGs via any quick method (or reuse existing background assets) and drop under `apps/web/public/covers/`.

- [ ] **Step 2: `category-cover-picker.tsx`**

```tsx
// apps/web/src/components/admin/catalog/category-cover-picker.tsx
import { useRef, useState } from 'react';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const PLATFORM_DEFAULTS = [
  '/covers/default-1.jpg',
  '/covers/default-2.jpg',
  '/covers/default-3.jpg',
  '/covers/default-4.jpg',
];

interface Props {
  categoryId: string | null;
  categoryName: string;
  coverSource: 'image' | 'icon';
  coverImageUrl: string | null;
  icon: string | null;
  onChange: (next: { cover_source: 'image' | 'icon'; cover_image_url: string | null }) => void;
}

export function CategoryCoverPicker({ categoryId, categoryName, coverSource, coverImageUrl, icon, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (file: File) => {
    if (!categoryId) {
      toast.error('Save the category first, then upload a cover.');
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch<{ cover_image_url: string }>(
        `/service-catalog/categories/${categoryId}/cover`,
        { method: 'POST', body: form },
      );
      onChange({ cover_source: 'image', cover_image_url: res.cover_image_url });
      toast.success('Cover uploaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Field>
        <FieldLabel>Visual</FieldLabel>
        <RadioGroup
          value={coverSource}
          onValueChange={(v: 'image' | 'icon') => onChange({ cover_source: v, cover_image_url: coverImageUrl })}
          className="flex gap-4"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cs-image" value="image" />
            <Label htmlFor="cs-image" className="font-normal">Cover image</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="cs-icon" value="icon" />
            <Label htmlFor="cs-icon" className="font-normal">Icon only</Label>
          </div>
        </RadioGroup>
        <FieldDescription>
          Choose how this category appears on the portal home.
        </FieldDescription>
      </Field>

      {coverSource === 'image' && (
        <Field>
          <FieldLabel>Cover</FieldLabel>
          <div className="grid grid-cols-5 gap-2">
            {PLATFORM_DEFAULTS.map((url) => (
              <button
                key={url}
                type="button"
                onClick={() => onChange({ cover_source: 'image', cover_image_url: url })}
                className={cn(
                  'aspect-[2/1] overflow-hidden rounded-md border-2 bg-muted',
                  coverImageUrl === url ? 'border-ring' : 'border-transparent',
                )}
              >
                <img src={url} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className={cn(
                'aspect-[2/1] flex items-center justify-center rounded-md border-2 border-dashed',
                'text-muted-foreground hover:bg-muted/50',
              )}
              aria-label="Upload custom cover"
            >
              <Plus className="size-5" />
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); }}
            />
          </div>
          <FieldDescription>Pick a default or upload a custom image (1200 × 600 px).</FieldDescription>
        </Field>
      )}

      {/* Live preview */}
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2 font-semibold">
          Preview on the portal home
        </div>
        <div className="w-48 overflow-hidden rounded-md border bg-card">
          <div className="aspect-[2.1/1] flex items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
            {coverSource === 'image' && coverImageUrl ? (
              <img src={coverImageUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-2xl">{iconEmoji(icon)}</span>
            )}
          </div>
          <div className="p-3">
            <div className="text-sm font-semibold">{categoryName || 'Category name'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Tiny fallback for emoji/icon rendering in the preview. Real icons render via lucide in the portal.
function iconEmoji(icon: string | null): string {
  switch (icon) {
    case 'Monitor': return '🖥️';
    case 'Wrench':  return '🔧';
    case 'MapPin':  return '📍';
    case 'Users':   return '👥';
    case 'Utensils':return '🍽️';
    case 'ShieldCheck': return '🛡️';
    case 'CalendarDays': return '📅';
    default: return '❓';
  }
}
```

- [ ] **Step 3: Wire into `catalog-hierarchy.tsx` dialog**

In the dialog JSX, after the icon picker, add:

```tsx
<FieldSeparator />
<CategoryCoverPicker
  categoryId={form.id}
  categoryName={form.name}
  coverSource={form.cover_source ?? 'icon'}
  coverImageUrl={form.cover_image_url ?? null}
  icon={form.icon}
  onChange={({ cover_source, cover_image_url }) =>
    setForm((prev) => ({ ...prev, cover_source, cover_image_url }))
  }
/>
```

Extend `CategoryFormState` with `cover_source: 'image' | 'icon'` + `cover_image_url: string | null`. Initialise from `item` in `openEdit`, and include in `handleSave`'s body.

- [ ] **Step 4: Manual smoke**

Run: `pnpm dev`

1. Go to `/admin/catalog-hierarchy`.
2. Edit a category. Dialog shows Visual block. Toggle works. Clicking a default tile selects it. Live preview updates.
3. Upload works (requires category to be saved first — toast guides you).
4. Save → category in DB has `cover_source='image'` and `cover_image_url` set.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/admin/catalog apps/web/src/pages/admin/catalog-hierarchy.tsx apps/web/public/covers
git commit -m "feat(admin): add CategoryCoverPicker with defaults + upload + live preview"
```

---

## Phase D — Home redesign

### Task 20: `PortalHomeHero`

**Files:**
- Create: `apps/web/src/lib/portal-greeting.ts`
- Create: `apps/web/src/components/portal/portal-home-hero.tsx`

- [ ] **Step 1: `portal-greeting.ts`**

```ts
// apps/web/src/lib/portal-greeting.ts
export function timeOfDayGreeting(now: Date = new Date()): 'Good morning' | 'Good afternoon' | 'Good evening' {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
```

- [ ] **Step 2: `portal-home-hero.tsx`**

```tsx
// apps/web/src/components/portal/portal-home-hero.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { usePortal } from '@/providers/portal-provider';
import { useAuth } from '@/providers/auth-provider';
import { useBranding } from '@/hooks/use-branding';
import { timeOfDayGreeting } from '@/lib/portal-greeting';

export function PortalHomeHero() {
  const navigate = useNavigate();
  const { data: portal } = usePortal();
  const { profile } = useAuth();
  const { branding } = useBranding();
  const [q, setQ] = useState('');

  const appearance = portal?.appearance;
  const firstName = profile?.first_name ?? '';
  const eyebrow =
    appearance?.greeting_enabled !== false
      ? `${timeOfDayGreeting()}${firstName ? `, ${firstName}` : ''}`
      : null;
  const headline = appearance?.welcome_headline?.trim() || 'How can we help you today?';
  const supporting = appearance?.supporting_line?.trim()
    ?? (portal?.current_location?.name
      ? `Submit a request, book a room, or invite a visitor at ${portal.current_location.name}.`
      : 'Submit a request, book a room, or invite a visitor.');

  const heroUrl = appearance?.hero_image_url ?? null;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed) navigate(`/portal?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <section
      className="relative -mx-4 md:-mx-6 lg:-mx-8 overflow-hidden"
      style={{ minHeight: 'clamp(180px, 32vw, 340px)' }}
    >
      <div className="absolute inset-0" aria-hidden>
        {heroUrl ? (
          <img src={heroUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div
            className="h-full w-full"
            style={{
              background: `radial-gradient(ellipse at 25% 15%, ${branding?.primary_color ?? '#6366f1'}44, transparent 55%),
                           radial-gradient(ellipse at 80% 80%, ${branding?.accent_color ?? '#ec4899'}22, transparent 55%),
                           linear-gradient(135deg, #312e81 0%, #4c1d95 40%, #1e1b4b 100%)`,
            }}
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/40 to-black/70" />
      </div>

      <div className="relative mx-auto max-w-[1600px] px-4 md:px-6 lg:px-8 py-10 md:py-14">
        <div className="max-w-2xl text-white">
          {eyebrow && (
            <div className="text-xs md:text-sm uppercase tracking-widest opacity-80">{eyebrow}</div>
          )}
          <h1 className="mt-2 text-3xl md:text-5xl font-semibold tracking-tight text-balance">
            {headline}
          </h1>
          <p className="mt-2 text-sm md:text-base opacity-80 text-pretty">{supporting}</p>

          <form onSubmit={onSubmit} className="mt-6 max-w-lg">
            <label htmlFor="portal-hero-search" className="sr-only">Search</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 size-4 text-white/70" />
              <input
                id="portal-hero-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search services, rooms, or people…"
                className="h-11 w-full rounded-lg border border-white/20 bg-white/15 pl-11 pr-4 text-sm text-white placeholder:text-white/60 backdrop-blur focus:outline-none focus-visible:ring-3 focus-visible:ring-white/40"
              />
            </div>
          </form>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/portal/portal-home-hero.tsx apps/web/src/lib/portal-greeting.ts
git commit -m "feat(portal): add PortalHomeHero with image/gradient fallback + greeting"
```

### Task 21: `PortalCategoryCard`

**Files:**
- Create: `apps/web/src/components/portal/portal-category-card.tsx`

- [ ] **Step 1: Component**

```tsx
// apps/web/src/components/portal/portal-category-card.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  cover_source: 'image' | 'icon';
  cover_image_url: string | null;
  className?: string;
}

export function PortalCategoryCard({ id, name, description, icon, cover_source, cover_image_url, className }: Props) {
  const IconCmp = icon && (Icons as Record<string, unknown>)[icon] as React.ComponentType<{ className?: string }> | undefined;

  return (
    <Link
      to={`/portal/catalog/${id}`}
      className={cn(
        'group block overflow-hidden rounded-xl border bg-card transition-colors hover:bg-accent/40',
        className,
      )}
      style={{ transitionTimingFunction: 'var(--ease-smooth)', transitionDuration: '200ms' }}
    >
      <div className="relative aspect-[2.1/1] bg-muted">
        {cover_source === 'image' && cover_image_url ? (
          <img src={cover_image_url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-primary/20 to-primary/5 text-primary">
            {IconCmp ? <IconCmp className="size-7" /> : <Icons.HelpCircle className="size-7" />}
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="text-sm font-semibold tracking-tight">{name}</div>
        {description && (
          <div className="mt-1 text-xs text-muted-foreground line-clamp-2">{description}</div>
        )}
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/portal/portal-category-card.tsx
git commit -m "feat(portal): add PortalCategoryCard (cover image or icon fallback)"
```

### Task 22: `PortalActivityPanel` + `PortalAnnouncementCard`

**Files:**
- Create: `apps/web/src/components/portal/portal-activity-panel.tsx`
- Create: `apps/web/src/components/portal/portal-announcement-card.tsx`

- [ ] **Step 1: `PortalActivityPanel`**

For v1, this reads from the existing `/tickets?mine=1&status=open,in_progress` (or equivalent). Phase 2 items (bookings/visitors/orders) render as empty slots for now.

```tsx
// apps/web/src/components/portal/portal-activity-panel.tsx
import { Link } from 'react-router-dom';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { FileText, Calendar, UserPlus, ShoppingCart } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';

interface MineTicket {
  id: string;
  title: string;
  status: string;
  created_at: string;
  request_type_name: string | null;
}

const mineTicketsOptions = () =>
  queryOptions({
    queryKey: ['portal', 'my-open-tickets'],
    queryFn: ({ signal }) =>
      apiFetch<MineTicket[]>('/tickets?mine=1&status=open,in_progress&limit=4', { signal }),
    staleTime: 30_000,
  });

export function PortalActivityPanel() {
  const { data: tickets = [], isPending } = useQuery(mineTicketsOptions());

  const anyActivity = tickets.length > 0;

  return (
    <aside className="rounded-xl border bg-card">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="text-sm font-semibold">Your activity</div>
        <Link to="/portal/requests" className="text-xs text-muted-foreground hover:text-foreground">View all</Link>
      </div>

      {isPending && (
        <div className="px-4 py-6 text-xs text-muted-foreground">Loading…</div>
      )}

      {!isPending && !anyActivity && (
        <div className="px-4 py-6 text-xs text-muted-foreground">
          Nothing open. Click a service to get started.
        </div>
      )}

      {tickets.map((t) => (
        <Link
          key={t.id}
          to={`/portal/requests/${t.id}`}
          className="flex items-start gap-3 border-t px-4 py-3 hover:bg-accent/40"
        >
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-blue-500/15 text-blue-500">
            <FileText className="size-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{t.title}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {t.request_type_name ?? 'Request'} · {formatRelativeTime(t.created_at)}
            </div>
          </div>
          <span className="shrink-0 rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
            Open
          </span>
        </Link>
      ))}
    </aside>
  );
}
```

- [ ] **Step 2: `PortalAnnouncementCard`**

```tsx
// apps/web/src/components/portal/portal-announcement-card.tsx
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { usePortal } from '@/providers/portal-provider';
import { formatRelativeTime } from '@/lib/format';

const DISMISS_KEY_PREFIX = 'portal.announcement.dismissed:';

export function PortalAnnouncementCard() {
  const { data: portal } = usePortal();
  const ann = portal?.announcement;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!ann) return;
    setDismissed(localStorage.getItem(DISMISS_KEY_PREFIX + ann.id) === '1');
  }, [ann?.id]);

  if (!ann || dismissed) return null;

  const onDismiss = () => {
    localStorage.setItem(DISMISS_KEY_PREFIX + ann.id, '1');
    setDismissed(true);
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="text-sm font-semibold">{ann.title}</div>
          <div className="mt-1 text-xs text-muted-foreground">{ann.body}</div>
          <div className="mt-2 text-[11px] text-muted-foreground">{formatRelativeTime(ann.published_at)}</div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/portal/portal-activity-panel.tsx apps/web/src/components/portal/portal-announcement-card.tsx
git commit -m "feat(portal): add PortalActivityPanel + PortalAnnouncementCard"
```

### Task 23: Rewrite `portal/home.tsx` + extend `PortalProvider`

**Files:**
- Modify: `apps/web/src/providers/portal-provider.tsx` (extend type with `appearance`, `announcement`)
- Modify: `apps/web/src/pages/portal/home.tsx` (full rewrite)

- [ ] **Step 1: Extend `PortalProvider` type**

In `apps/web/src/providers/portal-provider.tsx`, find the `PortalMeResponse`-like type. Add:

```ts
appearance: {
  hero_image_url: string | null;
  welcome_headline: string | null;
  supporting_line: string | null;
  greeting_enabled: boolean;
} | null;
announcement: {
  id: string;
  title: string;
  body: string;
  published_at: string;
  expires_at: string | null;
} | null;
```

The provider already fetches `/portal/me`; the new fields come through automatically since the backend now emits them (Task 9).

- [ ] **Step 2: Rewrite `portal/home.tsx`**

```tsx
// apps/web/src/pages/portal/home.tsx
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCatalogCategories, type Category } from '@/api/catalog';
import { usePortal } from '@/providers/portal-provider';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalHomeHero } from '@/components/portal/portal-home-hero';
import { PortalCategoryCard } from '@/components/portal/portal-category-card';
import { PortalActivityPanel } from '@/components/portal/portal-activity-panel';
import { PortalAnnouncementCard } from '@/components/portal/portal-announcement-card';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

interface PortalCatalogCategory {
  id: string;
  name: string;
  icon: string | null;
  parent_category_id: string | null;
  request_types: Array<{ id: string }>;
  cover_image_url: string | null;
  cover_source: 'image' | 'icon';
  description: string | null;
}

interface PortalCatalogResponse {
  selected_location: { id: string; name: string; type: string };
  categories: PortalCatalogCategory[];
}

const portalCatalogOptions = (locationId: string | undefined) =>
  queryOptions({
    queryKey: ['portal', 'catalog', locationId],
    queryFn: ({ signal }) =>
      apiFetch<PortalCatalogResponse>(
        `/portal/catalog?location_id=${encodeURIComponent(locationId ?? '')}`,
        { signal },
      ),
    enabled: Boolean(locationId),
    staleTime: 60_000,
  });

export function PortalHome() {
  const { data: portal } = usePortal();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim().toLowerCase();

  const currentLocationId = portal?.current_location?.id;
  const { data: catalog } = useQuery(portalCatalogOptions(currentLocationId));
  const { data: dbCategories } = useCatalogCategories() as { data: (Category & {
    description: string | null;
    icon: string | null;
    cover_image_url: string | null;
    cover_source: 'image' | 'icon';
  })[] | undefined };

  const topLevel = useMemo(() => {
    if (!dbCategories || !catalog) return [];
    const visibleIds = new Set(catalog.categories.map((c) => c.id));
    return dbCategories
      .filter((c) => !c.parent_category_id && visibleIds.has(c.id))
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [dbCategories, catalog, q]);

  return (
    <PortalPage bleed>
      <PortalHomeHero />
      <div className="px-4 md:px-6 lg:px-8 mt-8 md:mt-10">
        <div className="grid gap-8 md:gap-10 md:grid-cols-[1.8fr_1fr]">
          <section>
            <div className="mb-3 text-xs uppercase tracking-widest text-muted-foreground font-semibold">
              Browse services
            </div>
            <div className="grid gap-3 grid-cols-2 md:grid-cols-3">
              {topLevel.map((c) => (
                <PortalCategoryCard
                  key={c.id}
                  id={c.id}
                  name={c.name}
                  description={c.description}
                  icon={c.icon}
                  cover_source={c.cover_source ?? 'icon'}
                  cover_image_url={c.cover_image_url ?? null}
                />
              ))}
            </div>
          </section>

          <section className="order-last md:order-none space-y-4">
            <div className="mb-3 text-xs uppercase tracking-widest text-muted-foreground font-semibold">
              Your activity
            </div>
            <PortalActivityPanel />
          </section>
        </div>

        <div className="mt-10 mb-10">
          <PortalAnnouncementCard />
        </div>
      </div>
    </PortalPage>
  );
}
```

- [ ] **Step 3: Extend `/portal/catalog` response**

The portal catalog endpoint (`apps/api/src/modules/portal/portal.service.ts`, `getCatalog`) needs to return `cover_image_url` and `cover_source` on each category, AND populate `/service-catalog/categories` (already used by `useCatalogCategories`) with those fields too.

Find the category SELECT in each place and add the two columns:

```ts
.select('id, name, icon, parent_category_id, cover_image_url, cover_source, description, display_order')
```

- [ ] **Step 4: Manual smoke — end-to-end**

Run: `pnpm dev`

Run through the whole home experience:
1. Hero renders with default gradient (no hero set yet). Greeting shows "Good morning, [name]" per time of day.
2. Upload a hero via `/admin/branding` — return to `/portal` — hero image appears.
3. Edit welcome headline + supporting line — return to `/portal` — new copy appears.
4. Toggle time-of-day off — eyebrow disappears.
5. Publish an announcement — appears on `/portal` at bottom. Dismiss — stays dismissed on reload.
6. Open a category detail page — still uses the old layout (Wave 2 work).
7. Set a category cover in `/admin/catalog-hierarchy` — return to `/portal` — card shows the cover.
8. Open a ticket so the activity panel has content — it renders.
9. On mobile viewport: hero shrinks, two-column collapses, bottom tabs visible.

Fix any issues before commit.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/portal/home.tsx apps/web/src/providers/portal-provider.tsx apps/api/src/modules/portal
git commit -m "feat(portal): redesign home page — hero + cards + activity panel + announcement"
```

---

## Self-review

After completing all tasks, the reviewer should verify:

1. **Spec coverage:**
   - Shell (spec §4.1, §4.2) — Tasks 10-14.
   - Home page (spec §5.1) — Tasks 20-23.
   - Admin branding extensions (spec §6.1) — Tasks 16-18.
   - Category cover picker (spec §6.2) — Task 19.
   - Data model (spec §7) — Tasks 1-4.
   - Backend endpoints (spec §6.3) — Tasks 6-9.

2. **Out of scope — confirm unchanged:**
   - No changes to `/portal/catalog/:id`, `/portal/submit`, `/portal/my-requests` page bodies.
   - No new routes for Phase 2 flows (Rooms/Order/Visitors) — only the nav labels pointing to them (404s OK until Wave 2).

3. **Non-goals respected:**
   - Operator shell unchanged.
   - No new fonts / palette / easing tokens.
   - No AI or stock imagery.

---

## Execution

After all tasks land, run a full browser pass on desktop + mobile viewports and attach screenshots to the PR. Commit a "Wave 1 complete" tag or a final empty commit describing the ship before opening Wave 2.
