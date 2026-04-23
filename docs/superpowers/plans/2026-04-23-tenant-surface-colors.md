# Tenant Surface Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow tenants to optionally override the page background and left sidepanel colors per theme mode (light/dark), with auto-derived foreground/border/accent tones.

**Architecture:** Extend `tenants.branding` JSON with four nullable hex fields (`background_light`, `background_dark`, `sidebar_light`, `sidebar_dark`). Backend validates hex-or-null in the existing `PUT /tenants/branding` flow. The frontend theme provider injects the overrides only for the resolved mode and uses CSS `color-mix(in oklch, ...)` to derive foregrounds, accents, and borders so no JS color math is added.

**Tech Stack:** PostgreSQL (Supabase), NestJS, React 19 + TypeScript, Tailwind v4, shadcn/ui, Vite.

**Spec:** [`docs/superpowers/specs/2026-04-23-tenant-surface-colors-design.md`](../specs/2026-04-23-tenant-surface-colors-design.md)

---

## File Structure

**Created:**
- `supabase/migrations/00105_tenant_branding_surface_colors.sql` — adds the four new keys to the `tenants.branding` default + backfills existing rows.

**Modified:**
- `apps/api/src/modules/tenant/branding.service.ts` — extends `Branding` interface, `UpdateBrandingDto`, and `update()` validation/persistence.
- `apps/api/src/modules/tenant/color-utils.ts` — adds `assertValidHexOrNull` helper.
- `apps/api/src/modules/tenant/color-utils.spec.ts` — tests for the new helper.
- `apps/web/src/hooks/use-branding.tsx` — extends `Branding` interface, `DEFAULT_BRANDING`, and the `updateBranding` DTO type.
- `apps/web/src/providers/theme-provider.tsx` — emits per-mode CSS overrides for `--background` and `--sidebar` (and derived tokens) when the matching surface field is non-null.
- `apps/web/src/pages/admin/branding.tsx` — adds the "Surfaces" `SettingsSection` with `SurfaceColorField` rows.

---

## Task 1: Migration — add four nullable surface fields to `tenants.branding`

**Files:**
- Create: `supabase/migrations/00105_tenant_branding_surface_colors.sql`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/00105_tenant_branding_surface_colors.sql` with:

```sql
-- Add four optional surface-color fields to tenants.branding:
--   background_light, background_dark, sidebar_light, sidebar_dark
-- All default to null ("use the baked-in app default for this mode").

-- 1. Update the default for new rows to include the four new keys
alter table public.tenants
  alter column branding set default '{
    "logo_light_url": null,
    "logo_dark_url": null,
    "favicon_url": null,
    "primary_color": "#2563eb",
    "accent_color": "#7c3aed",
    "theme_mode_default": "light",
    "background_light": null,
    "background_dark": null,
    "sidebar_light": null,
    "sidebar_dark": null
  }'::jsonb;

-- 2. Backfill existing rows — rebuild branding with the new keys present (null
--    where unset), preserving every existing value. Same strict-rebuild pattern
--    as 00083_tenant_branding_reshape.sql.
update public.tenants
set branding = jsonb_build_object(
  'logo_light_url',     branding->'logo_light_url',
  'logo_dark_url',      branding->'logo_dark_url',
  'favicon_url',        branding->'favicon_url',
  'primary_color',      coalesce(branding->>'primary_color',      '#2563eb'),
  'accent_color',       coalesce(branding->>'accent_color',       '#7c3aed'),
  'theme_mode_default', coalesce(branding->>'theme_mode_default', 'light'),
  'background_light',   branding->'background_light',
  'background_dark',    branding->'background_dark',
  'sidebar_light',      branding->'sidebar_light',
  'sidebar_dark',       branding->'sidebar_dark'
);

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Apply the migration locally**

Run: `pnpm db:reset`
Expected: All migrations replay without error; final output ends with `Finished supabase db reset`.

- [ ] **Step 3: Verify the new shape locally**

Run:
```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "select branding from public.tenants limit 1;"
```
Expected: JSON output contains `"background_light"`, `"background_dark"`, `"sidebar_light"`, `"sidebar_dark"` keys, all `null`.

- [ ] **Step 4: Ask user before pushing to remote**

Before running `pnpm db:push`, post in the conversation:
> "Migration applies cleanly locally. OK to push to remote Supabase (`pnpm db:push`)? Per CLAUDE.md this writes to a shared/production DB — needs your go-ahead."

Wait for user approval. If `pnpm db:push` fails (memory: "Supabase remote push" — CLI auth has historically failed on this workspace), fall back to:
```bash
PGPASSWORD='<db_password from user>' psql \
  "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 \
  -f supabase/migrations/00105_tenant_branding_surface_colors.sql
```
…then run `notify pgrst, 'reload schema';` against the same connection.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00105_tenant_branding_surface_colors.sql
git commit -m "feat(branding): migration adds surface color fields"
```

---

## Task 2: Backend — `assertValidHexOrNull` helper + tests

**Files:**
- Modify: `apps/api/src/modules/tenant/color-utils.ts`
- Test: `apps/api/src/modules/tenant/color-utils.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/modules/tenant/color-utils.spec.ts`:

```ts
import { assertValidHexOrNull } from './color-utils';

describe('assertValidHexOrNull', () => {
  it('accepts null', () => {
    expect(() => assertValidHexOrNull(null, 'background_light')).not.toThrow();
  });
  it('accepts a valid hex', () => {
    expect(() => assertValidHexOrNull('#1a1a1f', 'background_dark')).not.toThrow();
  });
  it('throws for an invalid hex', () => {
    expect(() => assertValidHexOrNull('not-a-color', 'sidebar_light')).toThrow(/hex color/i);
  });
  it('throws for undefined (not the same as null)', () => {
    // Treat undefined as a missing field — the DTO must explicitly send null to clear.
    expect(() => assertValidHexOrNull(undefined as unknown as null, 'sidebar_dark')).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @prequest/api test -- color-utils`
Expected: FAIL with `assertValidHexOrNull is not exported` or similar.

- [ ] **Step 3: Implement the helper**

Append to `apps/api/src/modules/tenant/color-utils.ts`:

```ts
export function assertValidHexOrNull(value: string | null, field: string): void {
  if (value === null) return;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a hex color string or null`);
  }
  assertValidHex(value, field);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @prequest/api test -- color-utils`
Expected: PASS — all `assertValidHexOrNull` cases green, plus the existing `isValidHex`, `contrastAgainstWhite`, `assertUsablePrimary` cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/tenant/color-utils.ts apps/api/src/modules/tenant/color-utils.spec.ts
git commit -m "feat(branding): add assertValidHexOrNull helper"
```

---

## Task 3: Backend — extend `Branding` + `UpdateBrandingDto` + service `update()`

**Files:**
- Modify: `apps/api/src/modules/tenant/branding.service.ts`

- [ ] **Step 1: Extend the `Branding` interface**

In `apps/api/src/modules/tenant/branding.service.ts`, replace the current `Branding` interface with:

```ts
export interface Branding {
  logo_light_url:     string | null;
  logo_dark_url:      string | null;
  favicon_url:        string | null;
  primary_color:      string;
  accent_color:       string;
  theme_mode_default: 'light' | 'dark' | 'system';
  background_light:   string | null;
  background_dark:    string | null;
  sidebar_light:      string | null;
  sidebar_dark:       string | null;
}
```

- [ ] **Step 2: Extend `UpdateBrandingDto`**

Replace the existing `UpdateBrandingDto` with:

```ts
export interface UpdateBrandingDto {
  primary_color: string;
  accent_color: string;
  theme_mode_default: 'light' | 'dark' | 'system';
  background_light: string | null;
  background_dark:  string | null;
  sidebar_light:    string | null;
  sidebar_dark:     string | null;
}
```

- [ ] **Step 3: Update the import line at the top of the file**

Change the existing import:

```ts
import { assertValidHex, assertUsablePrimary } from './color-utils';
```

to:

```ts
import { assertValidHex, assertUsablePrimary, assertValidHexOrNull } from './color-utils';
```

- [ ] **Step 4: Extend the `update()` method**

Replace the body of `update()` with:

```ts
async update(dto: UpdateBrandingDto): Promise<Branding> {
  assertValidHex(dto.primary_color, 'primary_color');
  assertValidHex(dto.accent_color, 'accent_color');
  assertUsablePrimary(dto.primary_color);
  if (!['light', 'dark', 'system'].includes(dto.theme_mode_default)) {
    throw new BadRequestException('theme_mode_default must be light, dark, or system');
  }
  assertValidHexOrNull(dto.background_light, 'background_light');
  assertValidHexOrNull(dto.background_dark,  'background_dark');
  assertValidHexOrNull(dto.sidebar_light,    'sidebar_light');
  assertValidHexOrNull(dto.sidebar_dark,     'sidebar_dark');

  const tenant = TenantContext.current();
  const current = await this.get();
  const next: Branding = {
    ...current,
    primary_color:      dto.primary_color.toLowerCase(),
    accent_color:       dto.accent_color.toLowerCase(),
    theme_mode_default: dto.theme_mode_default,
    background_light:   dto.background_light?.toLowerCase() ?? null,
    background_dark:    dto.background_dark?.toLowerCase()  ?? null,
    sidebar_light:      dto.sidebar_light?.toLowerCase()    ?? null,
    sidebar_dark:       dto.sidebar_dark?.toLowerCase()     ?? null,
  };
  const { error } = await this.supabase.admin
    .from('tenants')
    .update({ branding: next })
    .eq('id', tenant.id);
  if (error) throw new InternalServerErrorException(error.message);

  await this.writeAuditEvent('tenant.branding.updated', { fields: Object.keys(dto) });
  return next;
}
```

- [ ] **Step 5: Verify the API typechecks**

Run: `pnpm --filter @prequest/api typecheck`
Expected: No TS errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/tenant/branding.service.ts
git commit -m "feat(branding): persist + validate surface colors in API"
```

---

## Task 4: Frontend hook — extend `Branding`, `DEFAULT_BRANDING`, `updateBranding` DTO

**Files:**
- Modify: `apps/web/src/hooks/use-branding.tsx`

- [ ] **Step 1: Extend the `Branding` interface**

In `apps/web/src/hooks/use-branding.tsx`, replace the current `Branding` interface with:

```ts
export interface Branding {
  logo_light_url:     string | null;
  logo_dark_url:      string | null;
  favicon_url:        string | null;
  primary_color:      string;
  accent_color:       string;
  theme_mode_default: 'light' | 'dark' | 'system';
  background_light:   string | null;
  background_dark:    string | null;
  sidebar_light:      string | null;
  sidebar_dark:       string | null;
}
```

- [ ] **Step 2: Extend `DEFAULT_BRANDING`**

Replace `DEFAULT_BRANDING` with:

```ts
const DEFAULT_BRANDING: Branding = {
  logo_light_url: null,
  logo_dark_url: null,
  favicon_url: null,
  primary_color: '#2563eb',
  accent_color: '#7c3aed',
  theme_mode_default: 'light',
  background_light: null,
  background_dark: null,
  sidebar_light: null,
  sidebar_dark: null,
};
```

- [ ] **Step 3: Extend the `updateBranding` signature in `BrandingContextValue`**

Replace the `updateBranding` line in the `BrandingContextValue` interface with:

```ts
  updateBranding: (
    dto: Pick<
      Branding,
      | 'primary_color'
      | 'accent_color'
      | 'theme_mode_default'
      | 'background_light'
      | 'background_dark'
      | 'sidebar_light'
      | 'sidebar_dark'
    >,
  ) => Promise<void>;
```

- [ ] **Step 4: Update the `updateBranding` implementation parameter type**

In the `updateBranding` callback, replace the `dto` parameter type with:

```ts
async (
  dto: Pick<
    Branding,
    | 'primary_color'
    | 'accent_color'
    | 'theme_mode_default'
    | 'background_light'
    | 'background_dark'
    | 'sidebar_light'
    | 'sidebar_dark'
  >,
) => {
  const next = await apiFetch<Branding>('/tenants/branding', {
    method: 'PUT',
    body: JSON.stringify(dto),
  });
  setBranding(next);
  writeCached(next);
},
```

- [ ] **Step 5: Verify the web app typechecks**

Run: `pnpm --filter @prequest/web typecheck`
Expected: No TS errors. (Other callers of `updateBranding` will fail typecheck — fixed in Task 6.)

If typecheck fails ONLY in `apps/web/src/pages/admin/branding.tsx`, that's expected — leave it for Task 6.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/hooks/use-branding.tsx
git commit -m "feat(branding): extend Branding type with surface fields"
```

---

## Task 5: Theme provider — inject per-mode surface overrides with `color-mix`

**Files:**
- Modify: `apps/web/src/providers/theme-provider.tsx`

- [ ] **Step 1: Replace `injectStyle` to take the resolved mode and emit per-mode overrides**

In `apps/web/src/providers/theme-provider.tsx`, replace the existing `injectStyle` function with:

```ts
function buildSurfaceBlock(opts: {
  bg: string | null;
  sidebar: string | null;
}): string {
  const lines: string[] = [];

  if (opts.bg) {
    const fg = pickForeground(opts.bg);
    lines.push(`--background: ${opts.bg};`);
    lines.push(`--foreground: ${fg};`);
    lines.push(`--border: color-mix(in oklch, ${opts.bg} 88%, ${fg} 12%);`);
  }

  if (opts.sidebar) {
    const fg = pickForeground(opts.sidebar);
    lines.push(`--sidebar: ${opts.sidebar};`);
    lines.push(`--sidebar-foreground: ${fg};`);
    lines.push(`--sidebar-accent: color-mix(in oklch, ${opts.sidebar} 92%, ${fg} 8%);`);
    lines.push(`--sidebar-accent-foreground: ${fg};`);
    lines.push(`--sidebar-border: color-mix(in oklch, ${opts.sidebar} 90%, ${fg} 10%);`);
  }

  return lines.join('\n      ');
}

function injectStyle(branding: {
  primary_color: string;
  accent_color: string;
  background_light: string | null;
  background_dark:  string | null;
  sidebar_light:    string | null;
  sidebar_dark:     string | null;
}) {
  const primary = hexToOklch(branding.primary_color);
  const accent = hexToOklch(branding.accent_color);
  const primaryFg = pickForeground(branding.primary_color);
  const accentFg = pickForeground(branding.accent_color);

  const lightSurfaces = buildSurfaceBlock({
    bg: branding.background_light,
    sidebar: branding.sidebar_light,
  });
  const darkSurfaces = buildSurfaceBlock({
    bg: branding.background_dark,
    sidebar: branding.sidebar_dark,
  });

  const css = `
    :root {
      --primary: ${primary};
      --primary-foreground: ${primaryFg};
      --accent: ${accent};
      --accent-foreground: ${accentFg};
      --ring: ${primary};
      --sidebar-primary: ${primary};
      --sidebar-primary-foreground: ${primaryFg};
      ${lightSurfaces}
    }
    .dark {
      --primary: ${primary};
      --primary-foreground: ${primaryFg};
      --accent: ${accent};
      --accent-foreground: ${accentFg};
      --ring: ${primary};
      --sidebar-primary: ${primary};
      --sidebar-primary-foreground: ${primaryFg};
      ${darkSurfaces}
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
```

- [ ] **Step 2: Update the `useEffect` call site to pass the full branding shape**

In the same file, replace the first `useEffect` body with:

```ts
useEffect(() => {
  injectStyle({
    primary_color:    branding.primary_color,
    accent_color:     branding.accent_color,
    background_light: branding.background_light,
    background_dark:  branding.background_dark,
    sidebar_light:    branding.sidebar_light,
    sidebar_dark:     branding.sidebar_dark,
  });
  setFavicon(branding.favicon_url);
  applyThemeClass(resolveThemeMode(branding.theme_mode_default));
}, [branding]);
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @prequest/web typecheck`
Expected: No new errors in `theme-provider.tsx`.

- [ ] **Step 4: Smoke check in the browser**

If the dev server isn't running: `pnpm dev:web`.

Open the app in Chrome, log in as an admin tenant, then in DevTools console run:

```js
const ss = document.getElementById('tenant-theme');
ss.textContent.includes('--background:') // expect: false (no surfaces set yet)
```

Expected: `false` — nothing changed visually because none of the four new fields are set yet.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/providers/theme-provider.tsx
git commit -m "feat(branding): inject per-mode surface overrides with color-mix"
```

---

## Task 6: Admin page — `Surfaces` section with `SurfaceColorField`

**Files:**
- Modify: `apps/web/src/pages/admin/branding.tsx`

- [ ] **Step 1: Add the surface-default constants and the `SurfaceColorField` component**

In `apps/web/src/pages/admin/branding.tsx`, add the following just below the `LogoSlot` component (above `export function BrandingPage`):

```tsx
type SurfaceKind = 'bg-light' | 'bg-dark' | 'sb-light' | 'sb-dark';

const SURFACE_DEFAULT_HEX: Record<SurfaceKind, string> = {
  'bg-light': '#ffffff',
  'bg-dark':  '#1a1a1f',
  'sb-light': '#fafafa',
  'sb-dark':  '#1e1e24',
};

function SurfaceColorField({
  id,
  label,
  kind,
  value,
  onChange,
  onReset,
}: {
  id: string;
  label: string;
  kind: SurfaceKind;
  value: string | null;
  onChange: (next: string) => void;
  onReset: () => void;
}) {
  const seed = SURFACE_DEFAULT_HEX[kind];
  const hexValid = value === null ? true : HEX_RE.test(value);

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {value === null ? (
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center px-2 py-1 rounded-md text-xs bg-muted text-muted-foreground">
            Default
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(seed)}
          >
            Customize
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <input
            id={`${id}-picker`}
            type="color"
            value={hexValid ? value : '#000000'}
            onChange={(e) => onChange(e.target.value)}
            className="w-10 h-10 rounded border cursor-pointer shrink-0"
            aria-label={`${label} color picker`}
          />
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-32 font-mono"
            aria-invalid={!hexValid}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
          >
            Use default
          </Button>
        </div>
      )}
    </Field>
  );
}
```

- [ ] **Step 2: Add the field-import additions**

At the top of the file, replace the `Field, FieldDescription, FieldGroup, FieldLabel` import with:

```tsx
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
```

- [ ] **Step 3: Add local state for the four surface fields**

Inside `BrandingPage`, just below the existing `const [mode, setMode] = ...` line, add:

```tsx
const [bgLight, setBgLight] = useState<string | null>(branding.background_light);
const [bgDark,  setBgDark]  = useState<string | null>(branding.background_dark);
const [sbLight, setSbLight] = useState<string | null>(branding.sidebar_light);
const [sbDark,  setSbDark]  = useState<string | null>(branding.sidebar_dark);
```

- [ ] **Step 4: Sync local state when branding changes**

Replace the existing sync `useEffect` with:

```tsx
useEffect(() => {
  setPrimary(branding.primary_color);
  setAccent(branding.accent_color);
  setMode(branding.theme_mode_default);
  setBgLight(branding.background_light);
  setBgDark(branding.background_dark);
  setSbLight(branding.sidebar_light);
  setSbDark(branding.sidebar_dark);
}, [
  branding.primary_color,
  branding.accent_color,
  branding.theme_mode_default,
  branding.background_light,
  branding.background_dark,
  branding.sidebar_light,
  branding.sidebar_dark,
]);
```

- [ ] **Step 5: Extend `dirty` and `canSave` to account for surface fields**

Replace the existing `dirty` and `canSave` lines with:

```tsx
const surfaceEqual = (local: string | null, server: string | null) =>
  (local?.toLowerCase() ?? null) === (server?.toLowerCase() ?? null);

const dirty =
  primary.toLowerCase() !== branding.primary_color.toLowerCase() ||
  accent.toLowerCase() !== branding.accent_color.toLowerCase() ||
  mode !== branding.theme_mode_default ||
  !surfaceEqual(bgLight, branding.background_light) ||
  !surfaceEqual(bgDark,  branding.background_dark) ||
  !surfaceEqual(sbLight, branding.sidebar_light) ||
  !surfaceEqual(sbDark,  branding.sidebar_dark);

const surfaceValid = (v: string | null) => v === null || HEX_RE.test(v);

const canSave =
  dirty &&
  HEX_RE.test(primary) &&
  HEX_RE.test(accent) &&
  surfaceValid(bgLight) &&
  surfaceValid(bgDark) &&
  surfaceValid(sbLight) &&
  surfaceValid(sbDark) &&
  !saving;
```

- [ ] **Step 6: Extend `handleSave` to include the surface fields**

Replace the existing `handleSave` with:

```tsx
const handleSave = async () => {
  setSaving(true);
  try {
    await updateBranding({
      primary_color: primary.toLowerCase(),
      accent_color:  accent.toLowerCase(),
      theme_mode_default: mode,
      background_light: bgLight?.toLowerCase() ?? null,
      background_dark:  bgDark?.toLowerCase()  ?? null,
      sidebar_light:    sbLight?.toLowerCase() ?? null,
      sidebar_dark:     sbDark?.toLowerCase()  ?? null,
    });
    toast.success('Branding saved');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Save failed');
  } finally {
    setSaving(false);
  }
};
```

- [ ] **Step 7: Extend `handleDiscard` to reset the surface fields**

Replace the existing `handleDiscard` with:

```tsx
const handleDiscard = () => {
  setPrimary(branding.primary_color);
  setAccent(branding.accent_color);
  setMode(branding.theme_mode_default);
  setBgLight(branding.background_light);
  setBgDark(branding.background_dark);
  setSbLight(branding.sidebar_light);
  setSbDark(branding.sidebar_dark);
};
```

- [ ] **Step 8: Add the `Surfaces` `SettingsSection` to the JSX**

Insert the following `SettingsSection` between the existing `Colors` section and the `Default theme mode` section:

```tsx
<SettingsSection
  title="Surfaces"
  description="Optionally override the page background and sidepanel colors per theme mode. Foreground, border, and hover tones are derived automatically."
>
  <FieldGroup>
    <FieldSet>
      <FieldLegend>Page background</FieldLegend>
      <FieldDescription>The main canvas color behind content.</FieldDescription>
      <FieldGroup>
        <SurfaceColorField
          id="bg-light"
          label="Light mode"
          kind="bg-light"
          value={bgLight}
          onChange={setBgLight}
          onReset={() => setBgLight(null)}
        />
        <SurfaceColorField
          id="bg-dark"
          label="Dark mode"
          kind="bg-dark"
          value={bgDark}
          onChange={setBgDark}
          onReset={() => setBgDark(null)}
        />
      </FieldGroup>
    </FieldSet>
    <FieldSeparator />
    <FieldSet>
      <FieldLegend>Sidepanel</FieldLegend>
      <FieldDescription>The left navigation surface.</FieldDescription>
      <FieldGroup>
        <SurfaceColorField
          id="sb-light"
          label="Light mode"
          kind="sb-light"
          value={sbLight}
          onChange={setSbLight}
          onReset={() => setSbLight(null)}
        />
        <SurfaceColorField
          id="sb-dark"
          label="Dark mode"
          kind="sb-dark"
          value={sbDark}
          onChange={setSbDark}
          onReset={() => setSbDark(null)}
        />
      </FieldGroup>
    </FieldSet>
  </FieldGroup>
</SettingsSection>
```

- [ ] **Step 9: Verify typecheck**

Run: `pnpm --filter @prequest/web typecheck`
Expected: No TS errors anywhere in the project.

- [ ] **Step 10: Manual smoke test**

If the dev server isn't running: `pnpm dev`.

1. Navigate to `/admin/branding` as an admin user.
2. Confirm the new "Surfaces" section renders with two `FieldSet`s, each containing two "Default" rows.
3. Click "Customize" on **Page background → Light mode**, change the picker to a soft blue (e.g. `#e7efff`), click **Save changes**.
4. Confirm a "Branding saved" toast.
5. Refresh the page — the value persists and the page background visibly shifts to the chosen color (in light mode).
6. Switch to dark mode (via user theme toggle if present, or `localStorage.setItem('pq.theme_mode','dark')` + reload). Confirm dark stays at the default `#1a1a1f` (no override leakage across modes).
7. On the admin page, click **Use default** under Page background → Light mode → Save. Confirm the field reverts to "Default" and the page background returns to white.
8. Repeat 3 with **Sidepanel → Dark mode** set to a deep navy (e.g. `#0b1e3b`). Switch to dark mode → confirm sidebar uses navy + foreground auto-inverts to light + hover state is a slightly lighter navy.

If any step fails, fix and re-run. Do **not** mark the task complete until all eight smoke steps pass.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/pages/admin/branding.tsx
git commit -m "feat(branding): admin UI for background + sidepanel colors"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck` (or `pnpm --filter @prequest/api typecheck && pnpm --filter @prequest/web typecheck` if there's no root script).
Expected: No errors anywhere.

- [ ] **Step 2: Test suite**

Run: `pnpm --filter @prequest/api test`
Expected: All tests green; the new `assertValidHexOrNull` cases included.

- [ ] **Step 3: Confirm migration is on remote**

Reload the running dev app (which talks to remote Supabase). Visit `/admin/branding`, change a surface color, save. If you get `PGRST205` or "could not find column" errors, the remote DB is missing the migration — return to Task 1 Step 4.

- [ ] **Step 4: Update spec doc with any deviations**

If anything in the implementation diverged from `docs/superpowers/specs/2026-04-23-tenant-surface-colors-design.md`, edit the spec to match reality. Keep spec ↔ code in sync (per CLAUDE.md philosophy on living docs).

- [ ] **Step 5: Final commit (if anything was touched in Step 4)**

```bash
git add docs/superpowers/specs/2026-04-23-tenant-surface-colors-design.md
git commit -m "docs(branding): align surface-colors spec with implementation"
```
