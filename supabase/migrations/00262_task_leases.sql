-- 00262_task_leases.sql
-- Generic per-(scope, key, date) lease table for idempotent scheduled workers.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §12.1
-- Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md task 2.8
--
-- Why a generic table (not the daglijst pattern):
--   00177_daglijst_lease_fence added a `sending_acquired_at` column on
--   `vendor_daily_lists` itself — that's a per-row CAS lease ON the domain
--   table. It works for daglijst because every list IS a discrete row.
--
--   Visitor EOD sweep has no per-row "should I run" entity — the question
--   is "did the sweep run for THIS building on THIS date?". The natural
--   key is `(tenant_id, building_id, sweep_date)`, with no domain row to
--   anchor it on. A separate lease table is cleaner than smuggling a
--   `last_swept_on` column onto `spaces`, and reusable for any future
--   building/date-keyed cron (occupancy report, retention sweep, etc.).
--
-- Row shape:
--   `lease_key`     — opaque application string. Example for visitor EOD:
--                     'visitor.eod.<building_id>.<YYYY-MM-DD>'.
--   `tenant_id`     — required. Lease is per-tenant; never spans tenants.
--   `acquired_at`   — when the worker took it. Used by the sweeper to
--                     reclaim stuck leases (TTL).
--   `acquired_by`   — opaque worker id (Node process pid + hostname is
--                     fine; only used in logs / ops dashboards).
--   `released_at`   — set on graceful release. `acquired_at IS NOT NULL
--                     AND released_at IS NULL` ⇒ "in-flight". The unique
--                     index on `lease_key` is what blocks concurrent
--                     acquires; a sweeper that re-runs against the same
--                     key on the same day finds a released row already
--                     present and bails — that IS the idempotency guard.
--
-- Re-acquire semantics: an attempt to insert a row with the same
-- `lease_key` returns "already taken". The application can:
--   - skip (default for cron sweeps — the lease IS the "did this run?" record)
--   - reclaim if `acquired_at < now() - interval '1 hour'` AND
--     `released_at IS NULL` (stuck lease; worker crashed mid-sweep). For
--     v1 we don't reclaim — the sweep cron runs every 15 min and a single
--     skipped tick is fine. Reclaim becomes important when the cron
--     window itself is short or the workload is critical.
--
-- This table is service-role only (cron workers run with the service-role
-- key). No tenant policy needed because no tenant-side caller ever reads.

create table if not exists public.task_leases (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  lease_key     text not null,
  acquired_at   timestamptz not null default now(),
  acquired_by   text not null,
  released_at   timestamptz,
  result        text,                         -- worker fills with 'ok' / 'failed' / 'partial' on release
  created_at    timestamptz not null default now()
);

-- Idempotency guard: one lease row per key, ever. Re-runs of the same
-- (key) just see the existing row and skip.
create unique index if not exists idx_task_leases_key
  on public.task_leases (lease_key);

-- Operational: list in-flight leases per tenant.
create index if not exists idx_task_leases_tenant_inflight
  on public.task_leases (tenant_id, acquired_at desc)
  where released_at is null;

alter table public.task_leases enable row level security;

-- service_role only. Cron workers use the service-role key; no other
-- caller has a reason to read or write this table.
revoke all on public.task_leases from public, anon, authenticated;
grant select, insert, update on public.task_leases to service_role;

comment on table public.task_leases is
  'Generic per-(scope, key, date) lease table for idempotent scheduled workers. lease_key is opaque (e.g. ''visitor.eod.<building>.<YYYY-MM-DD>''). Unique index on lease_key blocks concurrent acquires; a present row regardless of released_at means "already ran today" — that IS the idempotency guard. Service role only.';

notify pgrst, 'reload schema';
