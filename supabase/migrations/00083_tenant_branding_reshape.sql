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
-- Strict rebuild: any extra keys added out-of-band (e.g. via Supabase dashboard) are discarded.
-- This is intentional — the branding object has a fixed schema owned by the app.
update public.tenants
set branding = jsonb_build_object(
  'logo_light_url',      branding->>'logo_url',
  'logo_dark_url',       null,
  'favicon_url',         null,
  'primary_color',       coalesce(branding->>'primary_color',   '#2563eb'),
  'accent_color',        coalesce(branding->>'secondary_color', '#7c3aed'),
  'theme_mode_default',  coalesce(branding->>'theme_mode',      'light')
)
where branding ? 'logo_url'
   or not (branding ? 'logo_light_url');

-- 3. Add a user-level preferences column for theme override
alter table public.users
  add column if not exists preferences jsonb not null default '{}'::jsonb;

-- Ensure PostgREST picks up schema changes (no-op locally but fine to include)
notify pgrst, 'reload schema';
