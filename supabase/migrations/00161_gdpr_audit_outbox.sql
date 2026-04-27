-- GDPR baseline · Wave 0 Sprint 1
-- Cross-spec shared infrastructure §3.2: audit outbox.
--
-- Pattern: services emit audit events into `audit_outbox` (cheap, transactional).
-- A background worker drains rows into `audit_events` (the durable, queryable log)
-- and optionally forwards to a SIEM. This decouples business-transaction latency
-- from audit-log durability and lets us batch-write + retry-on-failure.
--
-- Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §2 (architecture),
--       docs/cross-spec-dependency-map.md §3.2 (shared registry).

create table if not exists public.audit_outbox (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,

  -- Event payload (mirrors public.audit_events shape; stays compatible).
  event_type      text        not null,
  entity_type     text,
  entity_id       uuid,
  actor_user_id   uuid        references public.users(id),
  details         jsonb       not null default '{}'::jsonb,
  ip_address      text,                                                 -- caller MUST pre-hash; raw IP is not stored
  occurred_at     timestamptz not null default now(),

  -- Outbox processing state.
  enqueued_at     timestamptz not null default now(),
  claim_token     uuid,                                                 -- per-worker batch claim token
  claimed_at      timestamptz,
  processed_at    timestamptz,
  attempts        int         not null default 0,
  last_error      text,

  constraint audit_outbox_attempts_nonneg check (attempts >= 0)
);

-- Hot index: worker drain scans only unprocessed rows in arrival order.
create index if not exists idx_audit_outbox_unprocessed
  on public.audit_outbox (tenant_id, enqueued_at)
  where processed_at is null;

-- Stale-claim sweep: workers may crash mid-batch leaving claim_token + claimed_at set.
-- Recovery query reclaims rows where claimed_at < now() - interval '5 minutes'.
create index if not exists idx_audit_outbox_stale_claim
  on public.audit_outbox (claimed_at)
  where processed_at is null and claimed_at is not null;

-- Cleanup index: nightly job purges fully-processed rows past their retention window.
create index if not exists idx_audit_outbox_processed
  on public.audit_outbox (processed_at)
  where processed_at is not null;

alter table public.audit_outbox enable row level security;

drop policy if exists tenant_isolation on public.audit_outbox;
create policy tenant_isolation on public.audit_outbox
  using (tenant_id = public.current_tenant_id());

comment on table public.audit_outbox is
  'Transactional outbox for audit events. Producers insert here inside their business transaction; AuditOutboxWorker drains to audit_events asynchronously. See gdpr-baseline-design.md §2.';
comment on column public.audit_outbox.ip_address is
  'Caller MUST hash the IP before insert (per gdpr-baseline-design.md §3 personal_data_access_logs). Raw IP is never stored.';

notify pgrst, 'reload schema';
