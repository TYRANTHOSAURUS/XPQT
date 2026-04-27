-- GDPR baseline · Wave 0 Sprint 1
-- Data subject requests, legal holds, and the read-side audit log.
--
-- Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §3.

-- =====================================================================
-- data_subject_requests
-- =====================================================================
-- Tracks Art. 15-22 fulfilment for SLA + audit. One row per request.

create table if not exists public.data_subject_requests (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references public.tenants(id) on delete cascade,
  request_type             text        not null,
  subject_person_id        uuid        not null references public.persons(id),
  initiated_by_user_id     uuid        references public.users(id),
  initiated_at             timestamptz not null default now(),
  completed_at             timestamptz,
  status                   text        not null default 'pending',
  decision_reason          text,
  scope_breakdown          jsonb,                                       -- per-category trace of what was processed
  output_storage_path      text,                                        -- Supabase Storage path for export bundle
  output_url_expires_at    timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint dsr_request_type_enum check (request_type in (
    'access','erasure','rectification','portability','objection'
  )),
  constraint dsr_status_enum check (status in (
    'pending','in_progress','completed','denied','partial'
  ))
);

create index if not exists idx_dsr_pending
  on public.data_subject_requests (tenant_id, status)
  where status in ('pending','in_progress');

create index if not exists idx_dsr_subject
  on public.data_subject_requests (tenant_id, subject_person_id);

alter table public.data_subject_requests enable row level security;

drop policy if exists tenant_isolation on public.data_subject_requests;
create policy tenant_isolation on public.data_subject_requests
  using (tenant_id = public.current_tenant_id());

drop trigger if exists set_dsr_updated_at on public.data_subject_requests;
create trigger set_dsr_updated_at before update on public.data_subject_requests
  for each row execute function public.set_updated_at();

comment on table public.data_subject_requests is
  'GDPR Art. 15-22 request log. SLA = 30 days max; goal <24h. See gdpr-baseline-design.md §6.';


-- =====================================================================
-- legal_holds
-- =====================================================================
-- Active holds that pause anonymization on specific persons or categories.

create table if not exists public.legal_holds (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references public.tenants(id) on delete cascade,
  hold_type                text        not null,
  subject_person_id        uuid        references public.persons(id),
  data_category            text,
  reason                   text        not null,
  initiated_by_user_id     uuid        not null references public.users(id),
  initiated_at             timestamptz not null default now(),
  expires_at               timestamptz,                                 -- null = until manually released
  released_at              timestamptz,
  released_by_user_id      uuid        references public.users(id),

  constraint legal_holds_type_enum check (hold_type in ('person','category','tenant_wide')),
  constraint legal_holds_scope_matches check (
    (hold_type = 'person'      and subject_person_id is not null and data_category is null) or
    (hold_type = 'category'    and data_category is not null     and subject_person_id is null) or
    (hold_type = 'tenant_wide' and subject_person_id is null     and data_category is null)
  )
);

create index if not exists idx_legal_holds_active
  on public.legal_holds (tenant_id, hold_type)
  where released_at is null;

create index if not exists idx_legal_holds_subject
  on public.legal_holds (tenant_id, subject_person_id)
  where released_at is null and subject_person_id is not null;

alter table public.legal_holds enable row level security;

drop policy if exists tenant_isolation on public.legal_holds;
create policy tenant_isolation on public.legal_holds
  using (tenant_id = public.current_tenant_id());

comment on table public.legal_holds is
  'Active legal holds checked by RetentionWorker before anonymizing/deleting. See gdpr-baseline-design.md §3, §4.';


-- =====================================================================
-- personal_data_access_logs (partitioned)
-- =====================================================================
-- High-write read-side audit log. Native monthly partitioning per
-- gdpr-baseline-design.md §13 — auto-drop oldest partition past retention.
-- Retention default 365d / cap 730d (its own category in tenant_retention_settings).

create table if not exists public.personal_data_access_logs (
  id                       uuid        not null default gen_random_uuid(),
  tenant_id                uuid        not null,
  accessed_at              timestamptz not null default now(),
  actor_user_id            uuid,
  actor_role               text,                                        -- admin | desk_operator | api | system | vendor_user
  actor_ip_hash            text,                                        -- pre-hashed; raw IP never stored
  actor_user_agent_hash    text,
  subject_person_id        uuid,
  data_category            text        not null,
  resource_type            text        not null,
  resource_id              uuid,
  access_method            text        not null,                       -- list_query | detail_view | export | search | api
  query_hash               text,                                        -- hash of query params for grouping
  primary key (id, accessed_at)                                         -- accessed_at is the partition key
)
partition by range (accessed_at);

-- Forward partitions for 6 months from migration date.
-- A monthly maintenance job (RetentionWorker §4) creates the next partition
-- ahead of time and drops partitions past the per-tenant retention window.
do $$
declare
  m  date;
  start_date date;
  end_date date;
  pname text;
begin
  for i in 0..6 loop
    m := date_trunc('month', current_date)::date + (i || ' months')::interval;
    start_date := m;
    end_date := (m + interval '1 month')::date;
    pname := 'personal_data_access_logs_' || to_char(m, 'YYYY_MM');
    execute format(
      'create table if not exists public.%I partition of public.personal_data_access_logs '
      'for values from (%L) to (%L)',
      pname, start_date, end_date
    );
  end loop;
end
$$;

create index if not exists idx_pdal_subject
  on public.personal_data_access_logs (tenant_id, subject_person_id, accessed_at desc);
create index if not exists idx_pdal_actor
  on public.personal_data_access_logs (tenant_id, actor_user_id, accessed_at desc);
create index if not exists idx_pdal_tenant_time
  on public.personal_data_access_logs (tenant_id, accessed_at desc);

alter table public.personal_data_access_logs enable row level security;

drop policy if exists tenant_isolation on public.personal_data_access_logs;
create policy tenant_isolation on public.personal_data_access_logs
  using (tenant_id = public.current_tenant_id());

comment on table public.personal_data_access_logs is
  'Read-side audit log. Service-layer instrumentation via @LogPersonalDataAccess decorator. '
  'See gdpr-baseline-design.md §7. Monthly partitions; oldest dropped past retention.';

-- Helper: ensure a partition exists for a given month. Idempotent.
-- Used by the monthly maintenance worker.
create or replace function public.ensure_pdal_partition(p_month date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  start_date date := date_trunc('month', p_month)::date;
  end_date   date := (start_date + interval '1 month')::date;
  pname      text := 'personal_data_access_logs_' || to_char(start_date, 'YYYY_MM');
begin
  execute format(
    'create table if not exists public.%I partition of public.personal_data_access_logs '
    'for values from (%L) to (%L)',
    pname, start_date, end_date
  );
end;
$$;

comment on function public.ensure_pdal_partition(date) is
  'Idempotent. Ensure a monthly partition of personal_data_access_logs exists. Called by RetentionWorker monthly maintenance.';

notify pgrst, 'reload schema';
