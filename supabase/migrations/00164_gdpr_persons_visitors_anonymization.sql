-- GDPR baseline · Wave 0 Sprint 1
-- PII columns on persons + visitors, plus the 7-day anonymization restore window.
--
-- Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §3, §4.
--
-- Note: persons.kind from the spec is intentionally NOT added — public.persons
-- already has a `type` column that serves the same purpose. We extend `type`'s
-- value set in the data category adapter rather than introducing a parallel column.

-- =====================================================================
-- persons: lifecycle + PII columns
-- =====================================================================

alter table public.persons
  add column if not exists left_at                            timestamptz,
  add column if not exists is_external                        boolean not null default false,
  add column if not exists last_seen_in_active_booking_at     timestamptz,
  add column if not exists anonymized_at                      timestamptz,                  -- set when retention worker anonymizes name/email/phone
  add column if not exists anonymized_reason                  text;                          -- 'retention' | 'erasure_request' | 'departure_cleanup'

comment on column public.persons.left_at is
  'When the person ceased active relationship with the tenant. Triggers DepartureCleanupWorker cascade per gdpr-baseline-design.md §5.';
comment on column public.persons.anonymized_at is
  'When PII fields were replaced with placeholder. FK integrity preserved; id retained.';

-- Index supports DepartureCleanupWorker scanning today's leavers.
create index if not exists idx_persons_left_at
  on public.persons (tenant_id, left_at)
  where left_at is not null and anonymized_at is null;

create index if not exists idx_persons_anonymized
  on public.persons (tenant_id, anonymized_at)
  where anonymized_at is not null;


-- =====================================================================
-- visitors: anonymization tracking
-- =====================================================================

alter table public.visitors
  add column if not exists anonymized_at  timestamptz,
  add column if not exists hard_deleted_at timestamptz;

create index if not exists idx_visitors_pending_retention
  on public.visitors (tenant_id, visit_date)
  where anonymized_at is null and hard_deleted_at is null;


-- =====================================================================
-- anonymization_audit (7-day restore window)
-- =====================================================================
-- Per gdpr-baseline-design.md §4: "For 7 days after anonymization, the
-- original PII is recoverable from a temporary anonymization_audit table".
--
-- Sprint 1 ships the schema. Sprint 2 ships adapters that populate it
-- and the Sprint 4 admin UI exposes restore. Encryption-at-rest of the
-- payload column relies on Supabase Postgres encryption; pgsodium-based
-- field-level encryption is a Sprint 5 hardening item.

create table if not exists public.anonymization_audit (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  data_category       text        not null,
  resource_type       text        not null,                              -- e.g. 'persons', 'visitors', 'audit_events'
  resource_id         uuid        not null,
  anonymized_at       timestamptz not null default now(),
  expires_at          timestamptz not null default (now() + interval '7 days'),
  payload             jsonb       not null,                              -- original PII fields, by column name
  payload_format      text        not null default 'jsonb_v1',           -- bump when encryption is added
  reason              text        not null,                              -- 'retention' | 'erasure_request' | 'departure_cleanup'
  initiated_by_user_id uuid       references public.users(id),           -- null for retention worker (system)
  restored_at         timestamptz,
  restored_by_user_id uuid        references public.users(id),

  constraint anon_audit_reason_enum check (reason in (
    'retention','erasure_request','departure_cleanup'
  ))
);

create index if not exists idx_anon_audit_resource
  on public.anonymization_audit (tenant_id, resource_type, resource_id);
create index if not exists idx_anon_audit_expiry
  on public.anonymization_audit (expires_at)
  where restored_at is null;

alter table public.anonymization_audit enable row level security;

drop policy if exists tenant_isolation on public.anonymization_audit;
-- Tenant-scoping at RLS; gdpr.fulfill_request permission enforced at app layer.
create policy tenant_isolation on public.anonymization_audit
  using (tenant_id = public.current_tenant_id());

comment on table public.anonymization_audit is
  '7-day restore window for anonymization. Original PII recoverable until expires_at. '
  'After expiry, RetentionWorker hard-purges these rows. See gdpr-baseline-design.md §4.';

notify pgrst, 'reload schema';
