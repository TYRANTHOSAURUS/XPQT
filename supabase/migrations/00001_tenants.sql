-- Tenant registry — platform-level table, NOT behind RLS
-- This table is queried by the tenant resolution middleware before RLS context is set

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'active' check (status in ('active', 'inactive', 'provisioning')),
  tier text not null default 'standard' check (tier in ('standard', 'enterprise')),
  db_connection text, -- only for enterprise tier with dedicated DB
  branding jsonb not null default '{
    "logo_url": null,
    "primary_color": "#2563eb",
    "secondary_color": "#1e40af",
    "theme_mode": "light"
  }'::jsonb,
  feature_flags jsonb not null default '{}'::jsonb,
  release_ring text not null default 'stable' check (release_ring in ('stable', 'canary')),
  timezone_default text not null default 'UTC',
  locale_default text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- No RLS on tenants — it's a platform-level registry accessed by the service role
-- The middleware reads this before any user context exists

create index idx_tenants_slug on public.tenants (slug);
create index idx_tenants_status on public.tenants (status);
