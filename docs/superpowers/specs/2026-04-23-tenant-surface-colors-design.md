# Tenant surface colors (background + sidepanel)

**Date:** 2026-04-23
**Status:** Approved — ready for implementation plan
**Builds on:** [`2026-04-17-tenant-branding-design.md`](2026-04-17-tenant-branding-design.md)

## Problem

Tenant branding currently exposes `primary_color` and `accent_color` only. Admins frequently want to also control:
- The **page background** (the canvas under cards/content).
- The **sidepanel** (left navigation surface).

Both should be optionally overridable per theme mode (light / dark) so a tenant can match the rest of their workplace tooling without forcing them to design two full palettes.

## Out of scope

- Card / popover / dialog backgrounds (`--card`, `--popover`) — kept neutral so content stays readable on top of any custom canvas.
- Right inspector / sheets / drawers — they should keep feeling distinct from primary nav.
- Foreground overrides — auto-derived from contrast. We can add explicit overrides later if a tenant hits a contrast issue.
- Sidebar primary (active item highlight) — already follows tenant primary today, no change.

## Data model

Add four optional fields to the `tenants.branding` JSON object:

```ts
interface Branding {
  // existing
  logo_light_url:     string | null;
  logo_dark_url:      string | null;
  favicon_url:        string | null;
  primary_color:      string;
  accent_color:       string;
  theme_mode_default: 'light' | 'dark' | 'system';

  // new
  background_light:   string | null;  // hex; null = use default
  background_dark:    string | null;
  sidebar_light:      string | null;
  sidebar_dark:       string | null;
}
```

All four new fields default to `null`. `null` is the explicit "use the baked-in default" signal — distinct from a missing key, so existing rows without the field still need to be backfilled.

### Migration

`supabase/migrations/<next>_tenant_branding_surface_colors.sql`:

1. Update the `tenants.branding` column default to include the four new keys (each `null`).
2. Backfill existing rows: rebuild `branding` so the four new keys are present (as `null`) without disturbing existing values. Use `coalesce(branding->>'background_light', null)` etc., and rebuild via `jsonb_build_object` to keep the same strict-shape pattern as `00083_tenant_branding_reshape.sql`.
3. `notify pgrst, 'reload schema'` at the end.

No constraints/checks at the DB level — validation lives in the API.

## Backend

`apps/api/src/modules/tenant/branding.service.ts`:

- Extend `Branding` interface with the four nullable fields.
- Extend `UpdateBrandingDto`:
  ```ts
  interface UpdateBrandingDto {
    primary_color: string;
    accent_color: string;
    theme_mode_default: 'light' | 'dark' | 'system';
    background_light: string | null;
    background_dark:  string | null;
    sidebar_light:    string | null;
    sidebar_dark:     string | null;
  }
  ```
- In `update()`:
  - For each surface field: if `null`, accept as-is. If a string, run `assertValidHex(value, fieldName)`.
  - Do **not** run `assertUsablePrimary` on surface colors — they don't have the same brand-button contrast requirement.
  - Persist into `tenants.branding` alongside existing fields.
- Audit event already records `fields: Object.keys(dto)` — automatically picks up the new keys.

No controller changes needed — the existing `PUT /tenants/branding` endpoint takes the DTO body.

## Frontend — hook

`apps/web/src/hooks/use-branding.tsx`:

- Extend `Branding` interface to mirror backend.
- Update `DEFAULT_BRANDING` so all four new fields default to `null`.
- Update the `updateBranding` signature to accept the four new fields:
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

## Frontend — theme provider

`apps/web/src/providers/theme-provider.tsx` rewires `injectStyle` to:

1. Resolve current mode → `light` or `dark`.
2. Build CSS for the active mode block, conditionally adding overrides:
   - If `branding.background_<mode>` is set:
     ```css
     --background: <hex>;
     --foreground: <pickForeground(hex)>;
     --border: color-mix(in oklch, <hex> 88%, <pickForeground(hex)> 12%);
     ```
   - If `branding.sidebar_<mode>` is set:
     ```css
     --sidebar: <hex>;
     --sidebar-foreground: <pickForeground(hex)>;
     --sidebar-accent: color-mix(in oklch, <hex> 92%, <pickForeground(hex)> 8%);
     --sidebar-accent-foreground: <pickForeground(hex)>;
     --sidebar-border: color-mix(in oklch, <hex> 90%, <pickForeground(hex)> 10%);
     ```
3. Existing primary/accent overrides remain in both `:root` and `.dark` blocks (mode-agnostic). Surface overrides only apply for the matching mode.

`color-mix` is supported in Chromium 111+, Safari 16.2+, Firefox 113+ — covers the browser baseline this project targets. No JS-side color math needed.

When a tenant sets only one mode (say only `background_light`), switching to dark mode just falls back to the default `--background` for `.dark`.

## Frontend — admin page

`apps/web/src/pages/admin/branding.tsx`:

Add a new `SettingsSection` titled **"Surfaces"** below the existing "Colors" section. Inside it, two `FieldSet`s built with the standard form primitives:

```
<FieldGroup>
  <FieldSet>
    <FieldLegend>Page background</FieldLegend>
    <FieldDescription>The main canvas color behind content.</FieldDescription>
    <FieldGroup>
      <SurfaceColorField label="Light mode" value={bgLight} onChange={...} onReset={...} />
      <SurfaceColorField label="Dark mode"  value={bgDark}  onChange={...} onReset={...} />
    </FieldGroup>
  </FieldSet>
  <FieldSeparator />
  <FieldSet>
    <FieldLegend>Sidepanel</FieldLegend>
    <FieldDescription>The left navigation surface.</FieldDescription>
    <FieldGroup>
      <SurfaceColorField label="Light mode" value={sbLight} onChange={...} onReset={...} />
      <SurfaceColorField label="Dark mode"  value={sbDark}  onChange={...} onReset={...} />
    </FieldGroup>
  </FieldSet>
</FieldGroup>
```

Where `SurfaceColorField` is a small local component (kept in the same file unless it grows) wrapping a `Field` with:
- A color picker swatch (native `<input type="color">`).
- A hex `<Input>` (font-mono, w-32).
- When value is `null`: show a muted "Default" pill in place of the swatch + a "Customize" ghost button. Clicking "Customize" seeds the picker with the corresponding baked-in default hex (`#ffffff` for light background, `#1a1a1f` for dark background, `#fafafa` for light sidebar, `#1e1e24` for dark sidebar — sourced from `index.css`) so the user has a sensible starting point to nudge from.
- When value is set: show "Use default" ghost button that sets back to `null`.

State management mirrors the existing pattern: `useEffect` syncs local state from `branding`, `dirty` calc compares lowercased hex / null, save / discard wired up. Hex validation: same `HEX_RE` already in the file. Save button stays disabled when any non-null value fails `HEX_RE`.

## Testing

- **Unit:** extend any existing branding service tests to cover the four new fields (null pass-through, hex validation when set, hex rejection when malformed).
- **Manual:**
  - Set `background_light` only → switch to dark → confirm dark stays default.
  - Set `sidebar_dark` to a deep navy → confirm sidebar text auto-flips to light.
  - Reset a field via "Use default" → confirm it serializes as `null` and the next page load shows the baked-in default.

## Risks & open questions

- **Contrast edge cases:** auto-derived foreground uses the existing simple-luminance pick. A mid-gray surface (e.g. `#808080`) will produce borderline contrast either way. We accept this — option B (explicit foreground override) is the documented escape hatch if it bites.
- **Color-mix browser support:** check the project's browserslist if it ever targets older Safari/Firefox; current target is fine.
- **Visual regression:** the existing branding preview block in the Colors section only previews primary/accent. We could extend it to preview surface colors, but that's optional polish — defer unless the user asks.
