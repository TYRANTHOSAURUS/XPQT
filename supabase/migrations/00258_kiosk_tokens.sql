-- 00258_kiosk_tokens.sql
-- Visitor Management v1 — anonymous, building-bound kiosk auth.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.1, §8.6
-- Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md task 2.7a
--
-- Each lobby kiosk holds a long-lived rotating token bound to a tenant +
-- building. The plaintext token lives only on the device + admin one-time
-- setup URL; the database stores sha256 of the token. KioskAuthGuard
-- validates incoming Bearer tokens against this table. Anonymous lookups
-- happen via a SECURITY DEFINER function (added in slice 2 alongside the
-- guard); this table itself is service_role only.

create table public.kiosk_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  building_id uuid not null references public.spaces(id),
  token_hash text not null unique,                                  -- sha256(token); raw token only at provisioning
  active boolean not null default true,
  rotated_at timestamptz,
  expires_at timestamptz not null default (now() + interval '90 days'),
  created_at timestamptz not null default now()
);

alter table public.kiosk_tokens enable row level security;

-- service_role only — anonymous lookups must go through a SECURITY DEFINER
-- function (added in slice 2). No anon/authenticated/tenant policy here.
revoke all on public.kiosk_tokens from public, anon, authenticated;
grant select, insert, update on public.kiosk_tokens to service_role;

create index idx_kiosk_tokens_active
  on public.kiosk_tokens (token_hash)
  where active = true;
create index idx_kiosk_tokens_tenant_building
  on public.kiosk_tokens (tenant_id, building_id);

comment on table public.kiosk_tokens is
  'Anonymous kiosk auth tokens, bound to (tenant_id, building_id). 90-day rotation. Validated via SECURITY DEFINER lookup; never exposed to anon/authenticated. See visitor-management-v1-design.md §8.1.';

notify pgrst, 'reload schema';
