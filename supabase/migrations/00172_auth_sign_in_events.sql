-- 00172 — auth_sign_in_events
-- Per-sign-in audit trail fed by Supabase Auth Hook webhook.
-- See docs/superpowers/specs/2026-04-28-people-and-users-surface-design.md.

create table public.auth_sign_in_events (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  event_kind      text not null check (event_kind in ('sign_in', 'sign_out', 'sign_in_failed')),
  signed_in_at    timestamptz not null default now(),
  session_id      text,
  ip_address      inet,
  user_agent      text,
  country         text,
  city            text,
  method          text,
  provider        text,
  mfa_used        boolean not null default false,
  success         boolean not null default true,
  failure_reason  text,
  created_at      timestamptz not null default now()
);

create unique index auth_sign_in_events_session_event_uniq
  on public.auth_sign_in_events (session_id, event_kind)
  where session_id is not null;

create index auth_sign_in_events_user_signed_in_at
  on public.auth_sign_in_events (tenant_id, user_id, signed_in_at desc);

create index auth_sign_in_events_tenant_signed_in_at
  on public.auth_sign_in_events (tenant_id, signed_in_at desc);

alter table public.auth_sign_in_events enable row level security;

create policy "tenant_isolation" on public.auth_sign_in_events
  for all
  using (tenant_id = public.current_tenant_id());

-- Register the retention category for all existing tenants. Picks up 24-month default.
-- The retention worker (privacy-compliance) purges rows past the policy.
insert into public.tenant_retention_settings (tenant_id, data_category, retention_days, cap_retention_days, legal_basis)
select id, 'auth_sign_in_events', 730, 1095, 'legitimate_interest'
  from public.tenants
on conflict (tenant_id, data_category) do nothing;

-- Extend seed_default_retention_for_tenant so new tenants automatically get
-- the auth_sign_in_events retention default.
-- Canonical base: 00162_gdpr_retention_settings.sql — all 16 original categories
-- preserved verbatim; new row appended at the end.
create or replace function public.seed_default_retention_for_tenant(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenant_retention_settings
    (tenant_id, data_category,                retention_days, cap_retention_days, legal_basis)
  values
    (p_tenant_id, 'visitor_records',                   180,                365, 'legitimate_interest'),
    (p_tenant_id, 'visitor_photos_ids',                 90,                180, 'legitimate_interest'),
    (p_tenant_id, 'cctv_footage',                       28,                 28, 'legitimate_interest'),
    (p_tenant_id, 'person_preferences',                 30,                 30, 'contract'),
    (p_tenant_id, 'person_ref_in_past_records',         90,                 90, 'contract'),
    (p_tenant_id, 'past_bookings',                    2555,               null, 'legal_obligation'),
    (p_tenant_id, 'past_orders',                      2555,               null, 'legal_obligation'),
    (p_tenant_id, 'audit_events',                     2555,               null, 'legal_obligation'),
    (p_tenant_id, 'personal_data_access_logs',         365,                730, 'legitimate_interest'),
    (p_tenant_id, 'calendar_event_content',              0,                  0, 'none'),
    (p_tenant_id, 'calendar_attendees_snapshot',        90,                365, 'legitimate_interest'),
    (p_tenant_id, 'daglijst_pdfs',                      90,                365, 'legitimate_interest'),
    (p_tenant_id, 'email_notifications',                30,                365, 'legitimate_interest'),
    (p_tenant_id, 'webhook_notifications',              30,                365, 'legitimate_interest'),
    (p_tenant_id, 'ghost_persons',                     365,                730, 'legitimate_interest'),
    (p_tenant_id, 'vendor_user_data',                  730,               1825, 'contract'),
    (p_tenant_id, 'auth_sign_in_events',               730,               1095, 'legitimate_interest')
  on conflict (tenant_id, data_category) do nothing;
end;
$$;

comment on function public.seed_default_retention_for_tenant(uuid) is
  'Idempotent. Seeds the canonical retention categories with defaults from gdpr-baseline-design.md §3. Call from tenant-create flow + use to backfill new categories on existing tenants.';

notify pgrst, 'reload schema';
