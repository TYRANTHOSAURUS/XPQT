# Tenant Branding & Theming — Design

**Date:** 2026-04-17
**Status:** Approved
**Owner:** Platform config

## Goal

Let tenant admins customize the platform's visible identity — logos, colors, and default theme mode — without code changes. Branding applies across the portal, service desk, admin, and unauthenticated pages (login, signup).

## Non-goals

Explicitly out of scope (flagged to prevent creep):

- Custom fonts or font uploads.
- Per-module theming (different palettes for portal vs. desk vs. admin).
- Email template branding — tenant-scoped email templates are a separate feature with their own constraints.
- Theme import/export, preset themes, or theme A/B testing.
- A dedicated "brand manager" role separate from admin.
- Auto-generating light/dark logos from a single source; both are collected explicitly.

## Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Logo assets | Light logo + dark logo + favicon |
| Colors | Primary + accent |
| Theme mode | Tenant default + per-user override |
| Storage | Supabase Storage, public bucket |
| Permissions | Admin role only |

---

## 1. Data model

The existing `tenants.branding` jsonb column is reshaped. A migration replaces the default and backfills existing rows.

**New shape:**

```json
{
  "logo_light_url": null,
  "logo_dark_url": null,
  "favicon_url": null,
  "primary_color": "#2563eb",
  "accent_color": "#7c3aed",
  "theme_mode_default": "light"
}
```

**Key rules:**

- Colors stored as hex strings (`^#[0-9a-f]{6}$`). Converted to `oklch()` at runtime for CSS variable injection.
- `theme_mode_default ∈ {"light", "dark", "system"}`.
- Old keys replaced: `logo_url → logo_light_url`, `secondary_color` dropped, `theme_mode → theme_mode_default`.

**User-level override:** Stored on the `users` table in a `preferences` jsonb column (add the column if missing). Shape: `{ "theme_mode_override": "light" | "dark" | "system" | null }`. Browsers also cache the last-applied mode in `localStorage` under `pq.theme_mode` for instant pre-auth application.

**Migration:**

1. `alter table tenants alter column branding set default '{...new shape...}'::jsonb;`
2. Backfill: `update tenants set branding = jsonb_build_object(...)` merging old keys into new shape, preserving any non-null existing values.
3. `alter table users add column if not exists preferences jsonb not null default '{}'::jsonb;`

## 2. Storage + upload flow

**Bucket:** `tenant-branding` (created via migration).

**Policies:**

- **Read:** public (anyone, unauthenticated). Required because the login page renders logos pre-auth.
- **Write / delete:** service role only. The API is the sole writer; browsers never upload directly.

**Path convention:** `{tenant_id}/logo-light.{ext}`, `{tenant_id}/logo-dark.{ext}`, `{tenant_id}/favicon.{ext}`. Uploading overwrites; no orphans. Cache-busting via `?v={unix_timestamp}` appended to the stored public URL.

**Upload flow:**

1. Browser `POST`s multipart to `POST /tenants/branding/logo` with fields `file` and `kind` (`light` | `dark` | `favicon`).
2. API validates:
   - **MIME + extension:** SVG, PNG, WebP allowed for logos; SVG, PNG, ICO for favicon.
   - **Size cap:** 1 MB logos, 256 KB favicon.
   - **SVG sanitization:** strip `<script>`, all `on*` event handlers, and external `href`/`xlink:href` attributes. SVG served at `image/svg+xml` on a trusted origin is an XSS vector; the sanitizer is non-negotiable. Use `dompurify` server-side with the SVG profile, or an equivalent targeted sanitizer.
3. API uploads via service role, updates the corresponding URL field on `tenants.branding` with a cache-buster.
4. Returns the updated branding object.

**Why server-side, not signed URLs:** direct-to-storage upload skips the SVG sanitizer. The safety gain is worth the extra hop.

## 3. API surface

All endpoints live in the existing `apps/api/src/modules/tenant/` module.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/tenants/current/branding` | Public (tenant resolved from host/header by existing middleware) | Full branding object. Called on every page load, including pre-auth. |
| `PUT` | `/tenants/branding` | Admin | Update colors + `theme_mode_default`. Body: `{ primary_color, accent_color, theme_mode_default }`. |
| `POST` | `/tenants/branding/logo` | Admin | Multipart upload. Body: `file`, `kind`. Returns updated branding. |
| `DELETE` | `/tenants/branding/logo/:kind` | Admin | Removes a logo; sets URL field to `null` and deletes storage object. |

The existing `GET /tenants/current` continues to return only `{ id, slug, tier }`. Branding is a separate call so it can be cached independently and fetched pre-auth.

**Admin guard:** a new `AdminGuard` (NestJS) checks the caller's role in the existing roles table. Applied to the three mutating branding endpoints. Non-admin → 403.

**Validation on `PUT /tenants/branding`:**

- Hex colors match `^#[0-9a-f]{6}$` (case-insensitive).
- Primary-vs-white contrast ratio ≥ 3:1 (WCAG AA large-text / UI component threshold). Reject with 422 and a clear message if it fails — prevents unreadable buttons.
- `theme_mode_default ∈ {"light", "dark", "system"}`.

**Cache invalidation:** the frontend invalidates React Query key `['tenant', 'branding']` on every successful mutation. The backend `TenantService` in-memory cache (currently only holds `id/slug/tier/db_connection`) is not affected — branding is not in that cache.

**Audit:** every write writes an event to the existing events/audit table (`00019_events_audit.sql`) with type `tenant.branding.updated`, so "who changed our colors" is answerable.

## 4. Frontend

### ThemeProvider

A new component wraps the app in `apps/web/src/App.tsx`. Responsibilities:

1. **Fetch branding** via React Query (key `['tenant', 'branding']`, `staleTime: 5min`). Runs pre-auth.
2. **Inject CSS variables** by appending (or replacing) a `<style id="tenant-theme">` element in `<head>`:

   ```css
   :root {
     --primary: oklch(...from primary_color...);
     --primary-foreground: oklch(...auto white/black by WCAG luminance...);
     --accent: oklch(...from accent_color...);
     --accent-foreground: oklch(...);
     --sidebar-primary: var(--primary);
     --ring: var(--primary);
   }
   .dark {
     /* same vars with dark-mode-adjusted lightness (bump L by ~0.1) */
   }
   ```

3. **Apply theme mode:** precedence is `users.preferences.theme_mode_override` → `localStorage['pq.theme_mode']` → `tenants.branding.theme_mode_default`. Toggles `.dark` class on `<html>`.
4. **Set favicon** by mutating `<link rel="icon">` at runtime when `favicon_url` changes.

A small utility `hexToOklch(hex: string): string` (~20 lines) handles the conversion. `*-foreground` is auto-picked based on WCAG luminance of the background: white if background is dark, black if light.

### Logo consumption

A new reusable component:

```tsx
<TenantLogo variant="full" | "mark" | "favicon" />
```

Responsibilities: reads current theme (light/dark), picks `logo_light_url` or `logo_dark_url`, falls back to the hardcoded Prequest asset if the tenant hasn't uploaded one.

Consumers updated to use it:

- `apps/web/src/components/workspace-switcher.tsx` — sidebar header.
- `apps/web/src/pages/auth/login.tsx` — header + branded right panel.
- `apps/web/src/pages/auth/signup.tsx` — same pattern.

### Admin page: `/admin/branding`

New route added to the admin layout. Sidebar entry goes under the **Configuration** group, using the `Palette` icon from `lucide-react`.

**Page layout:**

```
Branding
├── Logo assets (Card)
│   ├── Light mode logo       [preview] [Upload] [Remove]
│   ├── Dark mode logo        [preview] [Upload] [Remove]
│   └── Favicon               [preview] [Upload] [Remove]
├── Colors (Card)
│   ├── Primary color         [<input type="color">] [hex Input]
│   ├── Accent color          [<input type="color">] [hex Input]
│   └── Live preview          (a button, a badge, a sidebar strip using live values)
├── Theme default (Card)
│   └── RadioGroup: Light / Dark / System
└── [Save changes]            (sticky footer, disabled until dirty)
```

Components: shadcn `Card`, `Button`, `Input`, `RadioGroup`, `Label`. No new dependency required — native `<input type="color">` paired with a hex `<Input>` is sufficient.

**Save behavior:**

- Uploads run immediately on Upload-click (no batch). Preview updates on success.
- Colors + theme mode are batched behind the `Save changes` button; the form tracks dirty state.

### React Query hooks

New hooks in `apps/web/src/hooks/`:

- `useTenantBranding()` — query.
- `useUpdateBranding()` — mutation for `PUT /tenants/branding`.
- `useUploadLogo()` — mutation for `POST /tenants/branding/logo`.
- `useRemoveLogo()` — mutation for `DELETE /tenants/branding/logo/:kind`.

All mutations invalidate `['tenant', 'branding']` on success.

## 5. Permissions

- **Route gate:** `/admin/branding` sits inside the existing admin layout, so the top-level `ProtectedRoute` handles authentication. A layer on top of that checks the admin role and hides the sidebar entry + redirects non-admins away from the route.
- **API gate:** `AdminGuard` on all three mutating endpoints. Non-admins get 403.
- **Same role source** on both sides — whatever lookup the API uses (roles table) is mirrored on the frontend so the UI doesn't show actions that will 403.

## 6. Build sequence

1. **Migration — data model.** Extend `tenants.branding` default + backfill. Add `users.preferences` column if missing.
2. **Migration — storage.** Create `tenant-branding` bucket + public-read / service-role-write policies.
3. **API.** `AdminGuard`; `GET /tenants/current/branding`; `PUT /tenants/branding` with validators; `POST /tenants/branding/logo` with MIME/size/SVG-sanitization; `DELETE /tenants/branding/logo/:kind`; audit events.
4. **Frontend — theme plumbing.** `hexToOklch` utility, `ThemeProvider`, `<TenantLogo>` component. Wire `ThemeProvider` into `App.tsx`. Update `WorkspaceSwitcher`, `LoginPage`, `SignupPage` to consume `<TenantLogo>`.
5. **Frontend — admin page.** `/admin/branding` route, React Query hooks, sidebar entry, save flow, upload flow, live preview.
6. **Smoke test on remote Supabase** after pushing migrations — confirm bucket exists, an upload round-trips, and the UI reflects changes in the live app (per `CLAUDE.md` requirement to validate against the remote DB).

## Risks

- **SVG XSS** — biggest risk. Sanitizer is mandatory; no shortcuts.
- **Pre-auth branding fetch latency** — the login page will briefly render with fallback Prequest branding before the tenant's logo swaps in. Mitigated by caching branding in `localStorage` alongside the theme mode, so repeat visits render correctly on first paint.
- **Contrast enforcement** — a 3:1 threshold is permissive; some tenants may still pick colors that look bad. Live preview is the main guardrail.
- **Remote-Supabase workflow** — per project `CLAUDE.md`, migrations must be pushed to the remote project (not just applied locally) before the app sees them. Factored into step 6.
