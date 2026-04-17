# Tenant Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let tenant admins upload logos (light / dark / favicon), pick primary + accent colors, and set a default theme mode; wire these into the running app for all users.

**Architecture:** Extend existing `tenants.branding` jsonb. New Supabase Storage bucket for logo uploads. New `BrandingService` + `BrandingController` in the `tenant` module, gated by a new `AdminGuard`. Frontend gets a `ThemeProvider` that fetches branding once and injects CSS variables at runtime, plus a `<TenantLogo>` component used by login, signup, and sidebar, and a new `/admin/branding` admin page.

**Tech Stack:** NestJS 11 + Supabase (server), React 19 + Vite + shadcn/ui + Tailwind v4 (client), Jest (API tests), hand-rolled `useApi`/`apiFetch` (no TanStack Query in this codebase).

**Reference spec:** `docs/superpowers/specs/2026-04-17-tenant-branding-design.md`.

---

## Divergences from the spec

The spec mentions React Query (`useQuery` keyed `['tenant','branding']`). This codebase does not use TanStack Query — it uses `apps/web/src/hooks/use-api.ts` + `apiFetch`. We follow the existing pattern: a module-level `BrandingProvider` fetches once, exposes a refetch, and mutation helpers call refetch on success. Functionality is identical; naming changes.

## File structure

**New files:**

- `supabase/migrations/00026_tenant_branding_reshape.sql` — reshape `tenants.branding` default, backfill, add `users.preferences`.
- `supabase/migrations/00027_tenant_branding_storage.sql` — create `tenant-branding` storage bucket + policies.
- `apps/api/src/modules/auth/admin.guard.ts` — new guard; checks the caller has an `admin`-type role.
- `apps/api/src/modules/auth/admin.guard.spec.ts` — unit test.
- `apps/api/src/modules/tenant/color-utils.ts` — hex regex, WCAG contrast check.
- `apps/api/src/modules/tenant/color-utils.spec.ts` — unit tests.
- `apps/api/src/modules/tenant/svg-sanitizer.ts` — DOMPurify wrapper for SVG.
- `apps/api/src/modules/tenant/svg-sanitizer.spec.ts` — unit tests.
- `apps/api/src/modules/tenant/branding.service.ts` — read/update branding, upload/delete logos.
- `apps/api/src/modules/tenant/branding.controller.ts` — REST endpoints.
- `apps/web/src/lib/color-utils.ts` — `hexToOklch`, `pickForeground`.
- `apps/web/src/providers/theme-provider.tsx` — fetches branding, injects CSS vars, sets favicon.
- `apps/web/src/components/tenant-logo.tsx` — theme-aware logo with fallback.
- `apps/web/src/hooks/use-branding.ts` — `useBranding()` + mutation helpers.
- `apps/web/src/pages/admin/branding.tsx` — admin page (logo uploads, color pickers, theme default).

**Modified files:**

- `apps/api/src/modules/auth/auth.module.ts` — export `AdminGuard`.
- `apps/api/src/modules/tenant/tenant.module.ts` — register new service + controller.
- `apps/api/src/modules/tenant/tenant.controller.ts` — unchanged (new endpoints live in `branding.controller.ts`).
- `apps/api/package.json` — add `isomorphic-dompurify` + `jsdom` + `multer` + `@types/multer` deps.
- `apps/web/src/App.tsx` — wrap with `ThemeProvider`, add `/admin/branding` route.
- `apps/web/src/layouts/admin-layout.tsx` — sidebar entry + page title entry.
- `apps/web/src/components/workspace-switcher.tsx` — use `<TenantLogo variant="mark" />`.
- `apps/web/src/pages/auth/login.tsx` — use `<TenantLogo />`.
- `apps/web/src/pages/auth/signup.tsx` — use `<TenantLogo />`.

---

## Task 1: Migration — reshape branding + add user preferences

**Files:**
- Create: `supabase/migrations/00026_tenant_branding_reshape.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Reshape tenants.branding to the new schema:
--   { logo_light_url, logo_dark_url, favicon_url, primary_color, accent_color, theme_mode_default }
-- Old keys migrated where possible; new keys default to sensible values.

-- 1. Update default for new rows
alter table public.tenants
  alter column branding set default '{
    "logo_light_url": null,
    "logo_dark_url": null,
    "favicon_url": null,
    "primary_color": "#2563eb",
    "accent_color": "#7c3aed",
    "theme_mode_default": "light"
  }'::jsonb;

-- 2. Backfill existing rows — merge old keys into new shape, preserving values where present
update public.tenants
set branding = jsonb_build_object(
  'logo_light_url',      coalesce(branding->>'logo_url',        null),
  'logo_dark_url',       null,
  'favicon_url',         null,
  'primary_color',       coalesce(branding->>'primary_color',   '#2563eb'),
  'accent_color',        coalesce(branding->>'secondary_color', '#7c3aed'),
  'theme_mode_default',  coalesce(branding->>'theme_mode',      'light')
);

-- 3. Add a user-level preferences column for theme override
alter table public.users
  add column if not exists preferences jsonb not null default '{}'::jsonb;

-- Ensure PostgREST picks up schema changes (no-op locally but fine to include)
notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally**

Run: `pnpm db:reset`
Expected: all migrations apply cleanly through `00026`.

- [ ] **Step 3: Verify shape**

Run:
```bash
PGPASSWORD=postgres psql "postgresql://postgres@127.0.0.1:54322/postgres" \
  -c "select branding from public.tenants limit 1;"
```
Expected: output contains all six new keys (`logo_light_url`, `logo_dark_url`, `favicon_url`, `primary_color`, `accent_color`, `theme_mode_default`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00026_tenant_branding_reshape.sql
git commit -m "feat: reshape tenants.branding and add users.preferences"
```

---

## Task 2: Migration — storage bucket for tenant branding

**Files:**
- Create: `supabase/migrations/00027_tenant_branding_storage.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Public bucket for tenant logo assets.
-- Read is public (needed pre-auth on login page). Write/delete is service-role only.

insert into storage.buckets (id, name, public)
values ('tenant-branding', 'tenant-branding', true)
on conflict (id) do update set public = true;

-- Public read policy
drop policy if exists "tenant_branding_public_read" on storage.objects;
create policy "tenant_branding_public_read"
  on storage.objects for select
  using (bucket_id = 'tenant-branding');

-- Service role only for write/update/delete (no matching policy for other roles → denied)
drop policy if exists "tenant_branding_service_write" on storage.objects;
create policy "tenant_branding_service_write"
  on storage.objects for insert
  with check (bucket_id = 'tenant-branding' and auth.role() = 'service_role');

drop policy if exists "tenant_branding_service_update" on storage.objects;
create policy "tenant_branding_service_update"
  on storage.objects for update
  using (bucket_id = 'tenant-branding' and auth.role() = 'service_role');

drop policy if exists "tenant_branding_service_delete" on storage.objects;
create policy "tenant_branding_service_delete"
  on storage.objects for delete
  using (bucket_id = 'tenant-branding' and auth.role() = 'service_role');

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply locally**

Run: `pnpm db:reset`
Expected: clean application through `00027`.

- [ ] **Step 3: Verify bucket**

Run:
```bash
PGPASSWORD=postgres psql "postgresql://postgres@127.0.0.1:54322/postgres" \
  -c "select id, public from storage.buckets where id = 'tenant-branding';"
```
Expected: one row, `public = t`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00027_tenant_branding_storage.sql
git commit -m "feat: add tenant-branding storage bucket and policies"
```

---

## Task 3: API — AdminGuard

**Files:**
- Create: `apps/api/src/modules/auth/admin.guard.ts`
- Create: `apps/api/src/modules/auth/admin.guard.spec.ts`
- Modify: `apps/api/src/modules/auth/auth.module.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/src/modules/auth/admin.guard.spec.ts`:

```typescript
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';

describe('AdminGuard', () => {
  const makeContext = (user: unknown) => ({
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  }) as any;

  const makeSupabase = (roles: { type: string }[] | null, error: unknown = null) => ({
    admin: {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: roles === null ? null : { role_assignments: roles.map((r) => ({ role: { type: r.type } })) },
              error,
            }),
          }),
        }),
      }),
    },
  }) as any;

  it('rejects requests with no user on the request', async () => {
    const guard = new AdminGuard(makeSupabase([]));
    await expect(guard.canActivate(makeContext(undefined))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects users with no admin role', async () => {
    const guard = new AdminGuard(makeSupabase([{ type: 'employee' }, { type: 'agent' }]));
    await expect(guard.canActivate(makeContext({ id: 'auth-uid-1' })))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows users with an admin role', async () => {
    const guard = new AdminGuard(makeSupabase([{ type: 'admin' }]));
    await expect(guard.canActivate(makeContext({ id: 'auth-uid-1' }))).resolves.toBe(true);
  });

  it('rejects when the user row is not found', async () => {
    const guard = new AdminGuard(makeSupabase(null));
    await expect(guard.canActivate(makeContext({ id: 'auth-uid-1' })))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @prequest/api test admin.guard`
Expected: FAIL — "Cannot find module './admin.guard'".

- [ ] **Step 3: Write the guard**

`apps/api/src/modules/auth/admin.guard.ts`:

```typescript
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: { id?: string } }>();
    const authUid = request.user?.id;
    if (!authUid) throw new UnauthorizedException('Missing user context');

    const tenant = TenantContext.current();

    const { data, error } = await this.supabase.admin
      .from('users')
      .select('id, role_assignments:user_role_assignments(role:roles(type))')
      .eq('auth_uid', authUid)
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    if (error) throw new ForbiddenException('Role lookup failed');
    if (!data) throw new ForbiddenException('User not found in tenant');

    const roleAssignments = (data as { role_assignments?: { role?: { type?: string } | null }[] })
      .role_assignments ?? [];
    const isAdmin = roleAssignments.some((ra) => ra.role?.type === 'admin');
    if (!isAdmin) throw new ForbiddenException('Admin role required');

    return true;
  }
}
```

- [ ] **Step 4: Export from auth module**

Modify `apps/api/src/modules/auth/auth.module.ts` — add `AdminGuard` to both `providers` and `exports`.

Find the existing module file and confirm current shape, then add:

```typescript
import { AdminGuard } from './admin.guard';
// ...
@Module({
  providers: [AuthGuard, AdminGuard],
  exports: [AuthGuard, AdminGuard],
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @prequest/api test admin.guard`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/admin.guard.ts apps/api/src/modules/auth/admin.guard.spec.ts apps/api/src/modules/auth/auth.module.ts
git commit -m "feat: add AdminGuard for admin-only endpoints"
```

---

## Task 4: API — color utilities (hex validation, contrast)

**Files:**
- Create: `apps/api/src/modules/tenant/color-utils.ts`
- Create: `apps/api/src/modules/tenant/color-utils.spec.ts`

- [ ] **Step 1: Write the failing test**

`apps/api/src/modules/tenant/color-utils.spec.ts`:

```typescript
import { isValidHex, contrastAgainstWhite, assertUsablePrimary } from './color-utils';

describe('isValidHex', () => {
  it('accepts lowercase 6-digit hex', () => expect(isValidHex('#2563eb')).toBe(true));
  it('accepts uppercase 6-digit hex', () => expect(isValidHex('#AABBCC')).toBe(true));
  it('rejects 3-digit hex', () => expect(isValidHex('#abc')).toBe(false));
  it('rejects missing hash', () => expect(isValidHex('2563eb')).toBe(false));
  it('rejects non-hex characters', () => expect(isValidHex('#zzzzzz')).toBe(false));
});

describe('contrastAgainstWhite', () => {
  it('returns 21 for black', () => {
    expect(contrastAgainstWhite('#000000')).toBeCloseTo(21, 0);
  });
  it('returns 1 for white', () => {
    expect(contrastAgainstWhite('#ffffff')).toBeCloseTo(1, 2);
  });
  it('returns > 3 for a typical blue', () => {
    expect(contrastAgainstWhite('#2563eb')).toBeGreaterThan(3);
  });
  it('returns < 3 for a very light yellow', () => {
    expect(contrastAgainstWhite('#ffff99')).toBeLessThan(3);
  });
});

describe('assertUsablePrimary', () => {
  it('passes for dark blue', () => {
    expect(() => assertUsablePrimary('#2563eb')).not.toThrow();
  });
  it('throws for very light colors', () => {
    expect(() => assertUsablePrimary('#ffff99')).toThrow(/contrast/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @prequest/api test color-utils`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the utility**

`apps/api/src/modules/tenant/color-utils.ts`:

```typescript
import { BadRequestException } from '@nestjs/common';

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isValidHex(value: string): boolean {
  return HEX_RE.test(value);
}

export function assertValidHex(value: string, field: string): void {
  if (!isValidHex(value)) {
    throw new BadRequestException(`${field} must be a 6-digit hex color (e.g. #2563eb)`);
  }
}

function srgbToLinear(c: number): number {
  const n = c / 255;
  return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastAgainstWhite(hex: string): number {
  const l = relativeLuminance(hex);
  return 1.05 / (l + 0.05);
}

export function assertUsablePrimary(hex: string): void {
  const ratio = contrastAgainstWhite(hex);
  if (ratio < 3) {
    throw new BadRequestException(
      `Primary color contrast against white is ${ratio.toFixed(2)}:1 (must be at least 3:1 for readability)`,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @prequest/api test color-utils`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/tenant/color-utils.ts apps/api/src/modules/tenant/color-utils.spec.ts
git commit -m "feat: add color validation and contrast utilities"
```

---

## Task 5: API — SVG sanitizer

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/modules/tenant/svg-sanitizer.ts`
- Create: `apps/api/src/modules/tenant/svg-sanitizer.spec.ts`

- [ ] **Step 1: Add dependencies**

Run from repo root:
```bash
pnpm --filter @prequest/api add isomorphic-dompurify
```

Verify `apps/api/package.json` now lists `isomorphic-dompurify` in `dependencies`.

- [ ] **Step 2: Write the failing test**

`apps/api/src/modules/tenant/svg-sanitizer.spec.ts`:

```typescript
import { sanitizeSvg } from './svg-sanitizer';

describe('sanitizeSvg', () => {
  it('strips <script> tags', () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="5"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/<script/i);
    expect(clean).toMatch(/<circle/);
  });

  it('strips on* event handlers', () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" width="10" height="10"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/onclick/i);
    expect(clean).toMatch(/<rect/);
  });

  it('strips external hrefs', () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.example/x.png"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/evil\.example/);
  });

  it('keeps basic shapes and styling', () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#2563eb"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toMatch(/<circle/);
    expect(clean).toMatch(/fill="#2563eb"/);
  });

  it('throws when the input is not valid SVG', () => {
    expect(() => sanitizeSvg('not svg at all')).toThrow(/svg/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @prequest/api test svg-sanitizer`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the sanitizer**

`apps/api/src/modules/tenant/svg-sanitizer.ts`:

```typescript
import { BadRequestException } from '@nestjs/common';
import DOMPurify from 'isomorphic-dompurify';

export function sanitizeSvg(input: string): string {
  if (!/<svg[\s>]/i.test(input)) {
    throw new BadRequestException('File does not appear to be an SVG');
  }

  const clean = DOMPurify.sanitize(input, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
  });

  // Extra belt-and-suspenders: strip any remaining href/xlink:href that points off-origin
  return clean.replace(/\s(?:xlink:)?href\s*=\s*"(?!data:|#)[^"]*"/gi, '');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @prequest/api test svg-sanitizer`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/package.json apps/api/src/modules/tenant/svg-sanitizer.ts apps/api/src/modules/tenant/svg-sanitizer.spec.ts ../../pnpm-lock.yaml
git commit -m "feat: add SVG sanitizer for tenant logo uploads"
```

(Adjust `pnpm-lock.yaml` path to wherever it lives — it's at repo root.)

---

## Task 6: API — BrandingService

**Files:**
- Create: `apps/api/src/modules/tenant/branding.service.ts`

This task has no unit test — the service is thin glue over Supabase admin client (already covered by Task 11's smoke verification). All non-glue logic (hex validation, contrast, SVG sanitization) is in utilities covered by Tasks 4 and 5.

- [ ] **Step 1: Create the service**

`apps/api/src/modules/tenant/branding.service.ts`:

```typescript
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { assertValidHex, assertUsablePrimary } from './color-utils';
import { sanitizeSvg } from './svg-sanitizer';

const BUCKET = 'tenant-branding';
const LOGO_MAX_BYTES = 1 * 1024 * 1024;
const FAVICON_MAX_BYTES = 256 * 1024;

const LOGO_MIMES = new Set(['image/svg+xml', 'image/png', 'image/webp']);
const FAVICON_MIMES = new Set(['image/svg+xml', 'image/png', 'image/x-icon', 'image/vnd.microsoft.icon']);

export type LogoKind = 'light' | 'dark' | 'favicon';

export interface Branding {
  logo_light_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  primary_color: string;
  accent_color: string;
  theme_mode_default: 'light' | 'dark' | 'system';
}

export interface UpdateBrandingDto {
  primary_color: string;
  accent_color: string;
  theme_mode_default: 'light' | 'dark' | 'system';
}

const KIND_TO_FIELD: Record<LogoKind, keyof Branding> = {
  light: 'logo_light_url',
  dark: 'logo_dark_url',
  favicon: 'favicon_url',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

@Injectable()
export class BrandingService {
  constructor(private readonly supabase: SupabaseService) {}

  async get(): Promise<Branding> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('tenants')
      .select('branding')
      .eq('id', tenant.id)
      .single();
    if (error || !data) throw new NotFoundException('Tenant not found');
    return data.branding as Branding;
  }

  async update(dto: UpdateBrandingDto): Promise<Branding> {
    assertValidHex(dto.primary_color, 'primary_color');
    assertValidHex(dto.accent_color, 'accent_color');
    assertUsablePrimary(dto.primary_color);
    if (!['light', 'dark', 'system'].includes(dto.theme_mode_default)) {
      throw new BadRequestException('theme_mode_default must be light, dark, or system');
    }

    const tenant = TenantContext.current();
    const current = await this.get();
    const next: Branding = {
      ...current,
      primary_color: dto.primary_color.toLowerCase(),
      accent_color: dto.accent_color.toLowerCase(),
      theme_mode_default: dto.theme_mode_default,
    };
    const { error } = await this.supabase.admin
      .from('tenants')
      .update({ branding: next })
      .eq('id', tenant.id);
    if (error) throw new InternalServerErrorException(error.message);

    await this.writeAuditEvent('tenant.branding.updated', { fields: Object.keys(dto) });
    return next;
  }

  async uploadLogo(
    kind: LogoKind,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<Branding> {
    this.assertLogoFile(kind, file);

    let bodyBuffer = file.buffer;
    if (file.mimetype === 'image/svg+xml') {
      const clean = sanitizeSvg(file.buffer.toString('utf8'));
      bodyBuffer = Buffer.from(clean, 'utf8');
    }

    const tenant = TenantContext.current();
    const ext = EXT_BY_MIME[file.mimetype];
    const path = `${tenant.id}/${kind === 'favicon' ? 'favicon' : `logo-${kind}`}.${ext}`;

    const { error: uploadError } = await this.supabase.admin.storage
      .from(BUCKET)
      .upload(path, bodyBuffer, {
        contentType: file.mimetype,
        upsert: true,
        cacheControl: '3600',
      });
    if (uploadError) throw new InternalServerErrorException(uploadError.message);

    const { data: pub } = this.supabase.admin.storage.from(BUCKET).getPublicUrl(path);
    const bustedUrl = `${pub.publicUrl}?v=${Date.now()}`;

    const current = await this.get();
    const next: Branding = { ...current, [KIND_TO_FIELD[kind]]: bustedUrl };
    const { error: updateError } = await this.supabase.admin
      .from('tenants')
      .update({ branding: next })
      .eq('id', tenant.id);
    if (updateError) throw new InternalServerErrorException(updateError.message);

    await this.writeAuditEvent('tenant.branding.updated', { uploaded: kind });
    return next;
  }

  async removeLogo(kind: LogoKind): Promise<Branding> {
    const tenant = TenantContext.current();
    const current = await this.get();

    // Best-effort delete — multiple possible extensions
    const baseName = kind === 'favicon' ? 'favicon' : `logo-${kind}`;
    const candidates = ['svg', 'png', 'webp', 'ico'].map((ext) => `${tenant.id}/${baseName}.${ext}`);
    await this.supabase.admin.storage.from(BUCKET).remove(candidates);

    const next: Branding = { ...current, [KIND_TO_FIELD[kind]]: null };
    const { error } = await this.supabase.admin
      .from('tenants')
      .update({ branding: next })
      .eq('id', tenant.id);
    if (error) throw new InternalServerErrorException(error.message);

    await this.writeAuditEvent('tenant.branding.updated', { removed: kind });
    return next;
  }

  private assertLogoFile(
    kind: LogoKind,
    file: { mimetype: string; size: number },
  ): void {
    const allowed = kind === 'favicon' ? FAVICON_MIMES : LOGO_MIMES;
    if (!allowed.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported MIME type for ${kind}: ${file.mimetype}. Allowed: ${[...allowed].join(', ')}`,
      );
    }
    const limit = kind === 'favicon' ? FAVICON_MAX_BYTES : LOGO_MAX_BYTES;
    if (file.size > limit) {
      throw new BadRequestException(
        `File too large: ${file.size} bytes (max ${limit} bytes for ${kind})`,
      );
    }
  }

  private async writeAuditEvent(type: string, detail: Record<string, unknown>): Promise<void> {
    const tenant = TenantContext.current();
    // Non-fatal — audit failures should not block the operation
    await this.supabase.admin.from('events').insert({
      tenant_id: tenant.id,
      type,
      detail,
    }).then(() => undefined, (err) => console.error('Audit insert failed:', err));
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/modules/tenant/branding.service.ts
git commit -m "feat: add BrandingService for tenant theming"
```

---

## Task 7: API — BrandingController + wire module

**Files:**
- Modify: `apps/api/package.json` (add `multer` + `@types/multer`)
- Create: `apps/api/src/modules/tenant/branding.controller.ts`
- Modify: `apps/api/src/modules/tenant/tenant.module.ts`

- [ ] **Step 1: Add multer**

```bash
pnpm --filter @prequest/api add multer
pnpm --filter @prequest/api add -D @types/multer
```

- [ ] **Step 2: Write the controller**

`apps/api/src/modules/tenant/branding.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import {
  BrandingService,
  LogoKind,
  UpdateBrandingDto,
} from './branding.service';

@Controller('tenants')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  // Public — called pre-auth by the login page
  @Get('current/branding')
  async getBranding() {
    return this.branding.get();
  }

  @Put('branding')
  @UseGuards(AuthGuard, AdminGuard)
  async updateBranding(@Body() dto: UpdateBrandingDto) {
    return this.branding.update(dto);
  }

  @Post('branding/logo')
  @UseGuards(AuthGuard, AdminGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  async uploadLogo(
    @Body('kind') kind: LogoKind,
    @UploadedFile() file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException('Missing file');
    if (!['light', 'dark', 'favicon'].includes(kind)) {
      throw new BadRequestException('kind must be light, dark, or favicon');
    }
    return this.branding.uploadLogo(kind, file);
  }

  @Delete('branding/logo/:kind')
  @UseGuards(AuthGuard, AdminGuard)
  async deleteLogo(@Param('kind') kind: LogoKind) {
    if (!['light', 'dark', 'favicon'].includes(kind)) {
      throw new BadRequestException('kind must be light, dark, or favicon');
    }
    return this.branding.removeLogo(kind);
  }
}
```

- [ ] **Step 3: Wire into TenantModule**

Modify `apps/api/src/modules/tenant/tenant.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../common/supabase/supabase.module';
import { AuthModule } from '../auth/auth.module';
import { TenantController } from './tenant.controller';
import { TenantService } from './tenant.service';
import { BrandingController } from './branding.controller';
import { BrandingService } from './branding.service';

@Module({
  imports: [SupabaseModule, AuthModule],
  controllers: [TenantController, BrandingController],
  providers: [TenantService, BrandingService],
  exports: [TenantService],
})
export class TenantModule {}
```

(If the existing module doesn't import `AuthModule`, add it — required so `AuthGuard` and `AdminGuard` are resolvable via DI.)

- [ ] **Step 4: Build and start API**

Run:
```bash
pnpm --filter @prequest/api build
```
Expected: clean build, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json apps/api/src/modules/tenant/branding.controller.ts apps/api/src/modules/tenant/tenant.module.ts pnpm-lock.yaml
git commit -m "feat: add branding controller with admin-gated endpoints"
```

---

## Task 8: Push migrations to remote Supabase + smoke test

**Before starting this task: ask the user for go-ahead.** Per project `CLAUDE.md`, migrations against the remote project are treated like deploys.

- [ ] **Step 1: Ask the user**

Present the migration files `00026_tenant_branding_reshape.sql` and `00027_tenant_branding_storage.sql`. Ask: "Ready to push these to the remote Supabase project? This modifies the shared dev DB."

- [ ] **Step 2: Push — preferred path**

Run (after user approval):
```bash
pnpm db:push
```

If this fails due to CLI auth (known issue per CLAUDE.md), fall back to step 3.

- [ ] **Step 3: Push — fallback via psql**

Ask user for the remote DB password, then:
```bash
PGPASSWORD='<password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/migrations/00026_tenant_branding_reshape.sql

PGPASSWORD='<password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/migrations/00027_tenant_branding_storage.sql

PGPASSWORD='<password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -c "notify pgrst, 'reload schema';"
```

- [ ] **Step 4: Smoke test via the running API**

Run in one terminal: `pnpm dev:api`.
In another, with the tenant slug resolvable by the dev app:
```bash
curl -s http://localhost:3000/api/tenants/current/branding -H "X-Tenant-Id: <tenant-id>" | jq .
```
Expected: JSON with all six keys (`logo_light_url`, `logo_dark_url`, `favicon_url`, `primary_color`, `accent_color`, `theme_mode_default`). No `PGRST205` errors.

- [ ] **Step 5: Commit (no-op if nothing staged)**

Nothing to commit — this task validates the deploy.

---

## Task 9: Frontend — color utilities

**Files:**
- Create: `apps/web/src/lib/color-utils.ts`

No unit test — the web codebase has no test harness and we're not adding one here. The utility is small and verified via the live theme preview in the admin page (Task 14).

- [ ] **Step 1: Write the utilities**

`apps/web/src/lib/color-utils.ts`:

```typescript
// Hex → oklch() conversion + WCAG-based foreground picker.
// Kept tiny and dependency-free. See https://bottosson.github.io/posts/oklab/ for the math.

function srgbToLinear(c: number): number {
  const n = c / 255;
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

function linearSrgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

export function hexToOklch(hex: string): string {
  const r = srgbToLinear(parseInt(hex.slice(1, 3), 16));
  const g = srgbToLinear(parseInt(hex.slice(3, 5), 16));
  const b = srgbToLinear(parseInt(hex.slice(5, 7), 16));
  const [L, a, bb] = linearSrgbToOklab(r, g, b);
  const C = Math.sqrt(a * a + bb * bb);
  let h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return `oklch(${L.toFixed(4)} ${C.toFixed(4)} ${h.toFixed(2)})`;
}

export function relativeLuminance(hex: string): number {
  const to = (c: number) => {
    const n = c / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * to(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * to(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * to(parseInt(hex.slice(5, 7), 16))
  );
}

// Picks a readable foreground (either white or near-black) for the given background hex.
export function pickForeground(bgHex: string): string {
  return relativeLuminance(bgHex) > 0.5 ? 'oklch(0.145 0 0)' : 'oklch(0.985 0 0)';
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/color-utils.ts
git commit -m "feat(web): add hex→oklch and foreground picker utilities"
```

---

## Task 10: Frontend — BrandingProvider (context + fetch)

**Files:**
- Create: `apps/web/src/hooks/use-branding.ts`

The spec calls this `ThemeProvider` but we split concerns: `use-branding.ts` holds the data layer (fetch, mutation helpers) as a React context; Task 11 handles CSS injection + favicon. This keeps each file focused.

- [ ] **Step 1: Write the hook + provider**

`apps/web/src/hooks/use-branding.ts`:

```typescript
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from '@/lib/api';
import { supabase } from '@/lib/supabase';

export interface Branding {
  logo_light_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  primary_color: string;
  accent_color: string;
  theme_mode_default: 'light' | 'dark' | 'system';
}

const DEFAULT_BRANDING: Branding = {
  logo_light_url: null,
  logo_dark_url: null,
  favicon_url: null,
  primary_color: '#2563eb',
  accent_color: '#7c3aed',
  theme_mode_default: 'light',
};

interface BrandingContextValue {
  branding: Branding;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  updateBranding: (dto: Pick<Branding, 'primary_color' | 'accent_color' | 'theme_mode_default'>) => Promise<void>;
  uploadLogo: (kind: 'light' | 'dark' | 'favicon', file: File) => Promise<void>;
  removeLogo: (kind: 'light' | 'dark' | 'favicon') => Promise<void>;
}

const BrandingContext = createContext<BrandingContextValue | undefined>(undefined);

const STORAGE_KEY = 'pq.branding';

function readCached(): Branding | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Branding) : null;
  } catch {
    return null;
  }
}

function writeCached(b: Branding): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    /* ignore quota */
  }
}

async function multipart(path: string, form: FormData): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(`/api${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(() => readCached() ?? DEFAULT_BRANDING);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Branding>('/tenants/current/branding');
      setBranding(data);
      writeCached(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load branding');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const updateBranding = useCallback(
    async (dto: Pick<Branding, 'primary_color' | 'accent_color' | 'theme_mode_default'>) => {
      const next = await apiFetch<Branding>('/tenants/branding', {
        method: 'PUT',
        body: JSON.stringify(dto),
      });
      setBranding(next);
      writeCached(next);
    },
    [],
  );

  const uploadLogo = useCallback(async (kind: 'light' | 'dark' | 'favicon', file: File) => {
    const form = new FormData();
    form.append('file', file);
    form.append('kind', kind);
    const res = await multipart('/tenants/branding/logo', form);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? `Upload failed (${res.status})`);
    }
    const next = (await res.json()) as Branding;
    setBranding(next);
    writeCached(next);
  }, []);

  const removeLogo = useCallback(async (kind: 'light' | 'dark' | 'favicon') => {
    const next = await apiFetch<Branding>(`/tenants/branding/logo/${kind}`, { method: 'DELETE' });
    setBranding(next);
    writeCached(next);
  }, []);

  const value = useMemo(
    () => ({ branding, loading, error, refetch, updateBranding, uploadLogo, removeLogo }),
    [branding, loading, error, refetch, updateBranding, uploadLogo, removeLogo],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error('useBranding must be used within a BrandingProvider');
  return ctx;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/hooks/use-branding.ts
git commit -m "feat(web): add BrandingProvider context and hook"
```

---

## Task 11: Frontend — ThemeProvider (CSS var injection + favicon)

**Files:**
- Create: `apps/web/src/providers/theme-provider.tsx`

- [ ] **Step 1: Write the provider**

`apps/web/src/providers/theme-provider.tsx`:

```typescript
import { useEffect, type ReactNode } from 'react';
import { hexToOklch, pickForeground } from '@/lib/color-utils';
import { useBranding } from '@/hooks/use-branding';

const STYLE_ID = 'tenant-theme';
const USER_OVERRIDE_KEY = 'pq.theme_mode';

function resolveThemeMode(tenantDefault: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  const userOverride = (() => {
    try {
      const v = localStorage.getItem(USER_OVERRIDE_KEY);
      return v === 'light' || v === 'dark' || v === 'system' ? v : null;
    } catch {
      return null;
    }
  })();
  const mode = userOverride ?? tenantDefault;
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

function injectStyle(primaryHex: string, accentHex: string) {
  const primary = hexToOklch(primaryHex);
  const accent = hexToOklch(accentHex);
  const primaryFg = pickForeground(primaryHex);
  const accentFg = pickForeground(accentHex);

  const css = `
    :root {
      --primary: ${primary};
      --primary-foreground: ${primaryFg};
      --accent: ${accent};
      --accent-foreground: ${accentFg};
      --ring: ${primary};
      --sidebar-primary: ${primary};
      --sidebar-primary-foreground: ${primaryFg};
    }
    .dark {
      --primary: ${primary};
      --primary-foreground: ${primaryFg};
      --accent: ${accent};
      --accent-foreground: ${accentFg};
      --ring: ${primary};
      --sidebar-primary: ${primary};
      --sidebar-primary-foreground: ${primaryFg};
    }
  `;

  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function setFavicon(url: string | null) {
  const fallback = '/assets/prequest-icon-color.svg';
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = url ?? fallback;
}

function applyThemeClass(mode: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', mode === 'dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { branding } = useBranding();

  useEffect(() => {
    injectStyle(branding.primary_color, branding.accent_color);
    setFavicon(branding.favicon_url);
    applyThemeClass(resolveThemeMode(branding.theme_mode_default));
  }, [branding]);

  // React to system preference changes when mode is "system"
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeClass(resolveThemeMode(branding.theme_mode_default));
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [branding.theme_mode_default]);

  return <>{children}</>;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/providers/theme-provider.tsx
git commit -m "feat(web): add ThemeProvider for CSS var injection and favicon"
```

---

## Task 12: Frontend — TenantLogo component

**Files:**
- Create: `apps/web/src/components/tenant-logo.tsx`

- [ ] **Step 1: Write the component**

`apps/web/src/components/tenant-logo.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { useBranding } from '@/hooks/use-branding';
import { cn } from '@/lib/utils';

const FALLBACK_MARK = '/assets/prequest-icon-color.svg';
const FALLBACK_WORDMARK = '/assets/prequest-icon-color.svg';

interface TenantLogoProps {
  variant?: 'full' | 'mark';
  className?: string;
  alt?: string;
}

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

export function TenantLogo({ variant = 'full', className, alt = 'Logo' }: TenantLogoProps) {
  const { branding } = useBranding();
  const isDark = useIsDark();

  const tenantLogo = isDark ? branding.logo_dark_url ?? branding.logo_light_url : branding.logo_light_url;
  const src = tenantLogo ?? (variant === 'mark' ? FALLBACK_MARK : FALLBACK_WORDMARK);

  return <img src={src} alt={alt} className={cn('object-contain', className)} />;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/tenant-logo.tsx
git commit -m "feat(web): add theme-aware TenantLogo component with fallback"
```

---

## Task 13: Frontend — wire providers into App + update logo consumers

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/workspace-switcher.tsx`
- Modify: `apps/web/src/pages/auth/login.tsx`
- Modify: `apps/web/src/pages/auth/signup.tsx`

- [ ] **Step 1: Wrap App.tsx with providers**

In `apps/web/src/App.tsx`, the structure should become:

```tsx
// ...existing imports...
import { BrandingProvider } from '@/hooks/use-branding';
import { ThemeProvider } from '@/providers/theme-provider';

export function App() {
  useTheme();

  return (
    <BrandingProvider>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            {/* ...existing Routes... */}
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrandingProvider>
  );
}
```

Note: `BrandingProvider` wraps `AuthProvider` because branding is fetched pre-auth.

- [ ] **Step 2: Update WorkspaceSwitcher**

Read `apps/web/src/components/workspace-switcher.tsx` to find where the Prequest icon is rendered. Replace that `<img src="/assets/prequest-icon-color.svg" ... />` with `<TenantLogo variant="mark" className="h-6 w-6" />`.

Add import: `import { TenantLogo } from '@/components/tenant-logo';`

- [ ] **Step 3: Update Login page**

In `apps/web/src/pages/auth/login.tsx`:
- Line 50 (approx): replace `<img src="/assets/prequest-icon-color.svg" alt="Prequest" className="h-7 w-7" />` with `<TenantLogo variant="mark" className="h-7 w-7" alt="Prequest" />`
- Line 131 (approx, in the right-side branded panel): replace the same asset with `<TenantLogo variant="mark" className="h-24 w-24 mx-auto mb-8 opacity-80" alt="Prequest" />`
- Add import: `import { TenantLogo } from '@/components/tenant-logo';`

- [ ] **Step 4: Update Signup page**

Mirror the login changes in `apps/web/src/pages/auth/signup.tsx` for any `prequest-icon-color.svg` references.

- [ ] **Step 5: Smoke test in browser**

Run: `pnpm dev` (starts both API + web).
Open the app, confirm:
- Page loads without error.
- The Prequest mark still appears in the sidebar, login, and signup (fallback path, since no tenant logo is uploaded yet).
- DevTools → Elements → `<head>` shows a `<style id="tenant-theme">` element with the CSS vars.

Any console errors → fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/components/workspace-switcher.tsx apps/web/src/pages/auth/login.tsx apps/web/src/pages/auth/signup.tsx
git commit -m "feat(web): wire BrandingProvider + ThemeProvider and TenantLogo consumers"
```

---

## Task 14: Frontend — admin branding page

**Files:**
- Create: `apps/web/src/pages/admin/branding.tsx`

- [ ] **Step 1: Check that all shadcn components we need are installed**

Run:
```bash
ls apps/web/src/components/ui/ | grep -E "card|button|input|label|radio"
```

If `radio-group.tsx` is missing, install:
```bash
cd apps/web && npx shadcn@latest add radio-group
```

- [ ] **Step 2: Write the page**

`apps/web/src/pages/admin/branding.tsx`:

```typescript
import { useEffect, useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useBranding, type Branding } from '@/hooks/use-branding';
import { toast } from 'sonner';

type LogoKind = 'light' | 'dark' | 'favicon';

const HEX_RE = /^#[0-9a-f]{6}$/i;

function LogoSlot({
  kind,
  label,
  hint,
  url,
  onUpload,
  onRemove,
  accept,
}: {
  kind: LogoKind;
  label: string;
  hint: string;
  url: string | null;
  onUpload: (file: File) => Promise<void>;
  onRemove: () => Promise<void>;
  accept: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      await onUpload(file);
      toast.success(`${label} uploaded`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    try {
      await onRemove();
      toast.success(`${label} removed`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4 py-3 border-b last:border-b-0">
      <div className="w-24 h-16 bg-muted rounded flex items-center justify-center overflow-hidden shrink-0">
        {url ? (
          <img src={url} alt={label} className="max-w-full max-h-full object-contain" />
        ) : (
          <span className="text-xs text-muted-foreground">No {kind}</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handlePick}
        className="hidden"
        data-testid={`logo-input-${kind}`}
      />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        Upload
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !url}
        onClick={handleRemove}
        aria-label={`Remove ${label}`}
      >
        Remove
      </Button>
    </div>
  );
}

export function BrandingPage() {
  const { branding, loading, updateBranding, uploadLogo, removeLogo } = useBranding();

  const [primary, setPrimary] = useState(branding.primary_color);
  const [accent, setAccent] = useState(branding.accent_color);
  const [mode, setMode] = useState<Branding['theme_mode_default']>(branding.theme_mode_default);
  const [saving, setSaving] = useState(false);

  // Re-sync local form state when upstream branding changes (e.g. after a logo upload refresh)
  useEffect(() => {
    setPrimary(branding.primary_color);
    setAccent(branding.accent_color);
    setMode(branding.theme_mode_default);
  }, [branding.primary_color, branding.accent_color, branding.theme_mode_default]);

  const dirty =
    primary.toLowerCase() !== branding.primary_color.toLowerCase() ||
    accent.toLowerCase() !== branding.accent_color.toLowerCase() ||
    mode !== branding.theme_mode_default;

  const canSave = dirty && HEX_RE.test(primary) && HEX_RE.test(accent) && !saving;

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateBranding({
        primary_color: primary.toLowerCase(),
        accent_color: accent.toLowerCase(),
        theme_mode_default: mode,
      });
      toast.success('Branding saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !branding.primary_color) {
    return <div className="p-6 text-muted-foreground">Loading branding…</div>;
  }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Logo assets</CardTitle>
          <CardDescription>
            SVG, PNG, or WebP up to 1 MB. Favicon: SVG, PNG, or ICO up to 256 KB.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LogoSlot
            kind="light"
            label="Light mode logo"
            hint="Shown on light backgrounds (sidebar, login page)"
            url={branding.logo_light_url}
            onUpload={(f) => uploadLogo('light', f)}
            onRemove={() => removeLogo('light')}
            accept="image/svg+xml,image/png,image/webp"
          />
          <LogoSlot
            kind="dark"
            label="Dark mode logo"
            hint="Shown on dark backgrounds"
            url={branding.logo_dark_url}
            onUpload={(f) => uploadLogo('dark', f)}
            onRemove={() => removeLogo('dark')}
            accept="image/svg+xml,image/png,image/webp"
          />
          <LogoSlot
            kind="favicon"
            label="Favicon"
            hint="Shown in the browser tab (32×32 recommended)"
            url={branding.favicon_url}
            onUpload={(f) => uploadLogo('favicon', f)}
            onRemove={() => removeLogo('favicon')}
            accept="image/svg+xml,image/png,image/x-icon"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Colors</CardTitle>
          <CardDescription>Changes preview live on the page.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Label htmlFor="primary-color" className="w-28 shrink-0">Primary</Label>
            <input
              id="primary-color-picker"
              type="color"
              value={HEX_RE.test(primary) ? primary : '#000000'}
              onChange={(e) => setPrimary(e.target.value)}
              className="w-10 h-10 rounded border cursor-pointer"
              aria-label="Primary color picker"
            />
            <Input
              id="primary-color"
              value={primary}
              onChange={(e) => setPrimary(e.target.value)}
              className="w-32 font-mono"
              aria-invalid={!HEX_RE.test(primary)}
            />
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="accent-color" className="w-28 shrink-0">Accent</Label>
            <input
              id="accent-color-picker"
              type="color"
              value={HEX_RE.test(accent) ? accent : '#000000'}
              onChange={(e) => setAccent(e.target.value)}
              className="w-10 h-10 rounded border cursor-pointer"
              aria-label="Accent color picker"
            />
            <Input
              id="accent-color"
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
              className="w-32 font-mono"
              aria-invalid={!HEX_RE.test(accent)}
            />
          </div>
          <div className="rounded border p-4 flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground mr-2">Preview (saved values):</span>
            <Button size="sm">Primary button</Button>
            <Button size="sm" variant="secondary">Secondary</Button>
            <span
              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
              style={{ backgroundColor: branding.accent_color, color: '#fff' }}
            >
              Accent
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default theme mode</CardTitle>
          <CardDescription>Each user can override their own preference.</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as Branding['theme_mode_default'])} className="flex gap-6">
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="light" id="mode-light" />
              <span>Light</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="dark" id="mode-dark" />
              <span>Dark</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <RadioGroupItem value="system" id="mode-system" />
              <span>System</span>
            </label>
          </RadioGroup>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 bg-background py-3 border-t flex justify-end gap-3">
        <Button variant="ghost" disabled={!dirty || saving} onClick={() => {
          setPrimary(branding.primary_color);
          setAccent(branding.accent_color);
          setMode(branding.theme_mode_default);
        }}>
          Discard
        </Button>
        <Button disabled={!canSave} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/admin/branding.tsx apps/web/src/components/ui/radio-group.tsx 2>/dev/null || true
git commit -m "feat(web): add admin branding page with logo uploads and color pickers"
```

(The `2>/dev/null || true` tolerates the case where `radio-group.tsx` was already installed and isn't new.)

---

## Task 15: Frontend — admin route + sidebar entry

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/layouts/admin-layout.tsx`

- [ ] **Step 1: Add the route**

In `apps/web/src/App.tsx`, import and add a route inside the admin layout:

```tsx
import { BrandingPage } from '@/pages/admin/branding';

// Inside the /admin <Route>:
<Route path="branding" element={<BrandingPage />} />
```

Place it alongside the other admin routes.

- [ ] **Step 2: Add sidebar entry**

In `apps/web/src/layouts/admin-layout.tsx`:

1. Add `Palette` to the `lucide-react` import.
2. Add to `configNav`:
   ```ts
   { title: 'Branding', path: '/admin/branding', icon: Palette },
   ```
3. Add to `pageTitles`:
   ```ts
   '/admin/branding': 'Branding',
   ```

- [ ] **Step 3: Gate sidebar entry on admin role**

Still in `admin-layout.tsx`, import and use the existing `hasRole`:

```tsx
import { useAuth } from '@/providers/auth-provider';

// Inside AdminLayout:
const { hasRole } = useAuth();
const visibleConfigNav = configNav.filter((item) =>
  item.path === '/admin/branding' ? hasRole('admin') : true,
);
```

Replace the `configNav.map(...)` call inside the Configuration group with `visibleConfigNav.map(...)`.

- [ ] **Step 4: Smoke test the full flow**

Run `pnpm dev`. As an admin user:
1. Navigate to `/admin/branding`. Page renders.
2. Upload an SVG light-mode logo. Preview updates, sidebar logo updates.
3. Change primary color to `#ff0000`. Save. Sidebar active item + buttons turn red.
4. Change primary color to `#fff333` (low contrast). Save. Error toast: "contrast against white is ..."
5. Toggle theme mode to Dark. Save. Page switches to dark mode.
6. Open an incognito window as a non-admin user. `/admin/branding` hidden from sidebar. Directly navigating calls the API → 403.

Any failure → fix before committing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/layouts/admin-layout.tsx
git commit -m "feat(web): wire /admin/branding route and sidebar entry"
```

---

## Task 16: Final verification

- [ ] **Step 1: End-to-end check against spec**

Verify the six decisions from the spec:
- Light + dark + favicon uploads work ✓ (test in Task 15).
- Primary + accent colors apply ✓.
- Tenant default theme mode + user override ✓ (user override via `localStorage['pq.theme_mode']`).
- Supabase public bucket ✓.
- Admin-only ✓ (non-admin receives 403).
- Audit log entry for each write (confirm by querying `events` table after a save):

```bash
PGPASSWORD='<password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -c "select type, detail, created_at from public.events where type = 'tenant.branding.updated' order by created_at desc limit 5;"
```
Expected: rows for each update/upload/remove performed during testing.

- [ ] **Step 2: Run all API tests**

Run: `pnpm --filter @prequest/api test`
Expected: all tests pass.

- [ ] **Step 3: Typecheck web**

Run: `pnpm --filter @prequest/web build`
Expected: clean build, no TypeScript errors.

- [ ] **Step 4: Final commit (if needed)**

If any fixes were made during verification, commit them:
```bash
git add -A
git commit -m "fix: address verification issues in tenant branding"
```

---

## Self-review notes

**Spec coverage — every section from the spec maps to a task:**
- §1 Data model → Task 1.
- §2 Storage + upload flow → Tasks 2, 5 (sanitizer), 6 (validation), 7 (controller).
- §3 API surface → Tasks 3 (AdminGuard), 6, 7.
- §4 Frontend ThemeProvider/TenantLogo/admin page → Tasks 9, 10, 11, 12, 13, 14.
- §5 Permissions → Tasks 3 (server), 15 (client).
- §6 Build sequence → Tasks 1–15 in order.

**Noted divergence:** React Query → `apiFetch` + context. Documented at the top of the plan. Net functionality equivalent.

**Open items deliberately left out:** the `events` table schema is assumed to exist (per `00019_events_audit.sql`). If its column names differ from `type`/`detail`/`tenant_id`/`created_at`, the audit insert in `branding.service.ts:writeAuditEvent` needs a one-line column rename. Verify when implementing Task 6 by reading `00019_events_audit.sql`.
