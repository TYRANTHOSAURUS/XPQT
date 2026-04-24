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
