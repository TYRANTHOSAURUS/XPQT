-- Inbound webhooks v2
--
-- Replaces the token-in-URL auth model on workflow_webhooks with:
--   * API-key-hash auth (Authorization: Bearer <key>)
--   * Payload mapping to a request_type_id (rules + default)
--   * Requester lookup (default person or email resolution)
--   * IP allowlist + per-webhook rate limit
--
-- Adds on `tickets`:
--   * external_system / external_id for idempotent retry handling
--
-- Creates `webhook_events` for append-only audit.
--
-- Drops `workflow_webhooks.token` — the legacy POST /webhooks/:token path is
-- removed in the same PR. No shim, no dual-run (system in development).

-- ─────────────────────────────────────────────────────────────
-- 1. Additions on workflow_webhooks
-- ─────────────────────────────────────────────────────────────

alter table public.workflow_webhooks
  add column api_key_hash text,
  add column allowed_cidrs text[] not null default '{}',
  add column rate_limit_per_minute int not null default 60,
  add column default_request_type_id uuid references public.request_types(id),
  add column request_type_rules jsonb not null default '[]'::jsonb,
  add column default_requester_person_id uuid references public.persons(id),
  add column requester_lookup jsonb,
  add column last_used_at timestamptz;

-- Seed rows (and any demo rows) get throwaway hashes. Admins must rotate to
-- get a usable key. Acceptable for a system in development.
update public.workflow_webhooks
   set api_key_hash = encode(sha256((gen_random_uuid()::text)::bytea), 'hex')
 where api_key_hash is null;

alter table public.workflow_webhooks
  alter column api_key_hash set not null;

alter table public.workflow_webhooks
  add constraint workflow_webhooks_api_key_hash_key unique (api_key_hash);

-- workflow_id becomes optional. The request type's workflow_definition_id is
-- the primary driver; workflow_id on the webhook row is an override for
-- payloads that can't be mapped to a request type with a workflow.
alter table public.workflow_webhooks
  alter column workflow_id drop not null;

-- ─────────────────────────────────────────────────────────────
-- 2. Removals on workflow_webhooks (legacy token auth)
-- ─────────────────────────────────────────────────────────────

drop index if exists public.idx_wwh_token;
alter table public.workflow_webhooks drop column token;

-- ─────────────────────────────────────────────────────────────
-- 3. Additions on tickets (idempotency + provenance)
-- ─────────────────────────────────────────────────────────────

alter table public.tickets
  add column external_system text,
  add column external_id text;

create unique index idx_tickets_external_ref
  on public.tickets (tenant_id, external_system, external_id)
  where external_system is not null and external_id is not null;

-- ─────────────────────────────────────────────────────────────
-- 4. webhook_events — append-only audit
-- ─────────────────────────────────────────────────────────────

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  webhook_id uuid not null references public.workflow_webhooks(id) on delete cascade,
  received_at timestamptz not null default now(),
  external_system text,
  external_id text,
  status text not null check (status in ('accepted', 'deduplicated', 'rejected', 'error')),
  ticket_id uuid references public.tickets(id) on delete set null,
  workflow_instance_id uuid,
  http_status int not null,
  error_message text,
  payload jsonb not null,
  headers jsonb
);

create index idx_webhook_events_webhook on public.webhook_events (webhook_id, received_at desc);
create index idx_webhook_events_external
  on public.webhook_events (tenant_id, external_system, external_id)
  where external_system is not null;
create index idx_webhook_events_retention
  on public.webhook_events (received_at);

alter table public.webhook_events enable row level security;

create policy "tenant_isolation" on public.webhook_events
  using (tenant_id = public.current_tenant_id());

-- ─────────────────────────────────────────────────────────────
-- 5. PostgREST schema reload
-- ─────────────────────────────────────────────────────────────

notify pgrst, 'reload schema';
