-- Vendor Portal Phase B · Sprint 1
-- Magic-link auth tables + status-events audit trail.
--
-- Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §3.
--
-- Why a separate identity pool: vendor users don't sign up with Supabase
-- Auth — tenants invite them by email and they redeem a magic link. We
-- mint our own session JWTs against vendor_user_sessions so vendors never
-- touch the tenant-side users table, the tenant_id RLS predicate, or the
-- gdpr.* permission space.

-- =====================================================================
-- vendor_users — separate identity pool for external vendor staff
-- =====================================================================

create table if not exists public.vendor_users (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  vendor_id           uuid        not null references public.vendors(id) on delete cascade,
  email               text        not null,
  display_name        text,
  role                text        not null default 'fulfiller',
  active              boolean     not null default true,
  invited_at          timestamptz not null default now(),
  invited_by_user_id  uuid        references public.users(id),
  first_login_at      timestamptz,
  last_login_at       timestamptz,
  failed_login_count  int         not null default 0,
  locked_until        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint vendor_users_role_chk check (role in ('fulfiller','manager')),
  constraint vendor_users_email_unique unique (tenant_id, vendor_id, email)
);

create index if not exists idx_vendor_users_email
  on public.vendor_users (tenant_id, lower(email));

create index if not exists idx_vendor_users_active
  on public.vendor_users (tenant_id, vendor_id)
  where active = true;

alter table public.vendor_users enable row level security;

-- Service-role only — admin reads go through the API, vendor self-reads
-- attach via vendor_user_sessions JWT (Phase B Sprint 2 introduces a
-- portal-side guard that authorizes per session, not per RLS).
drop policy if exists vendor_users_service on public.vendor_users;
create policy vendor_users_service on public.vendor_users
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

drop trigger if exists set_vendor_users_updated_at on public.vendor_users;
create trigger set_vendor_users_updated_at before update on public.vendor_users
  for each row execute function public.set_updated_at();


-- =====================================================================
-- vendor_user_sessions — active sessions; raw token stored client-side
-- =====================================================================

create table if not exists public.vendor_user_sessions (
  id                   uuid        primary key default gen_random_uuid(),
  vendor_user_id       uuid        not null references public.vendor_users(id) on delete cascade,
  tenant_id            uuid        not null,
  vendor_id            uuid        not null,
  session_token_hash   text        not null,                -- sha256(token); raw token never stored
  expires_at           timestamptz not null,
  ip_hash              text,                                -- pre-hashed (per gdpr-baseline §14)
  user_agent_hash      text,
  created_at           timestamptz not null default now(),
  revoked_at           timestamptz,

  constraint vendor_user_sessions_token_unique unique (session_token_hash)
);

create index if not exists idx_vendor_sessions_active
  on public.vendor_user_sessions (vendor_user_id, expires_at)
  where revoked_at is null;

create index if not exists idx_vendor_sessions_token
  on public.vendor_user_sessions (session_token_hash)
  where revoked_at is null;

alter table public.vendor_user_sessions enable row level security;

drop policy if exists vendor_user_sessions_service on public.vendor_user_sessions;
create policy vendor_user_sessions_service on public.vendor_user_sessions
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- =====================================================================
-- vendor_user_magic_links — issued one-time tokens awaiting redemption
-- =====================================================================

create table if not exists public.vendor_user_magic_links (
  id              uuid        primary key default gen_random_uuid(),
  vendor_user_id  uuid        not null references public.vendor_users(id) on delete cascade,
  token_hash      text        not null,                    -- sha256(token); raw token only in the email
  expires_at      timestamptz not null,                    -- typical 15 minutes
  redeemed_at     timestamptz,
  created_at      timestamptz not null default now(),

  constraint vendor_user_magic_links_token_unique unique (token_hash)
);

create index if not exists idx_magic_links_pending
  on public.vendor_user_magic_links (token_hash)
  where redeemed_at is null;

create index if not exists idx_magic_links_user
  on public.vendor_user_magic_links (vendor_user_id, created_at desc);

alter table public.vendor_user_magic_links enable row level security;

drop policy if exists vendor_user_magic_links_service on public.vendor_user_magic_links;
create policy vendor_user_magic_links_service on public.vendor_user_magic_links
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- =====================================================================
-- vendor_order_status_events — audit + analytics trail of vendor transitions
-- =====================================================================

create table if not exists public.vendor_order_status_events (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references public.tenants(id) on delete cascade,
  order_line_item_id       uuid        not null references public.order_line_items(id) on delete cascade,
  from_status              text,
  to_status                text        not null,
  actor_kind               text        not null,
  actor_vendor_user_id     uuid        references public.vendor_users(id),
  actor_tenant_user_id     uuid        references public.users(id),
  reason                   text,
  metadata                 jsonb,
  occurred_at              timestamptz not null default now(),

  constraint voe_actor_kind_chk check (actor_kind in
    ('vendor_user','tenant_user','system','inferred'))
);

create index if not exists idx_voe_oli
  on public.vendor_order_status_events (order_line_item_id, occurred_at);
create index if not exists idx_voe_vendor_user
  on public.vendor_order_status_events (actor_vendor_user_id, occurred_at)
  where actor_vendor_user_id is not null;
create index if not exists idx_voe_tenant
  on public.vendor_order_status_events (tenant_id, occurred_at desc);

alter table public.vendor_order_status_events enable row level security;

drop policy if exists vendor_order_status_events_service on public.vendor_order_status_events;
create policy vendor_order_status_events_service on public.vendor_order_status_events
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- =====================================================================
-- vendors: Phase B schema additions
-- =====================================================================

alter table public.vendors
  add column if not exists webhook_url                 text,
  add column if not exists webhook_secret_encrypted    text,
  add column if not exists portal_invitation_message   text,
  add column if not exists parent_vendor_account_id    uuid;

comment on column public.vendors.webhook_url is
  'Optional vendor-side webhook for portal/hybrid vendors. Sprint 4 wires HMAC-signed delivery.';
comment on column public.vendors.parent_vendor_account_id is
  'Escape hatch for cross-tenant vendor federation per project_vendors_per_tenant.md. Per-tenant vendors are the v1 model; this column lets a future product unify vendor accounts across tenants without a schema change.';

notify pgrst, 'reload schema';
