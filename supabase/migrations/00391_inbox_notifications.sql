-- B.4.A.5 sub-step A · 00391 · inbox_notifications
--
-- Per-(tenant, user) inbox surface for the notification dispatch pipeline.
-- Sub-step B's RPC v5/v3 amendments insert rows here atomically inside the
-- same transaction as the approval-chain insert (Hybrid C ordering — see
-- /tmp/b4a5-plan-v2.md §Locked decisions #5).
--
-- Citations (verified in current main):
--   - supabase/migrations/00002_rls_helpers.sql:5-14
--       public.current_tenant_id() — JWT-claim → uuid helper.
--   - supabase/migrations/00003_people_users_roles.sql:35-46
--       public.users (id, tenant_id, auth_uid) — auth.uid() bridges to
--       users.id via users.auth_uid.
--   - supabase/migrations/00167_gdpr_rls_hardening.sql:31-37
--       Canonical RLS bridge pattern (current_tenant_id + auth.uid →
--       users.auth_uid → users.id). Plan v2's "auth.uid() vs users.id
--       directly" warning at line 60-61 of the plan source.
--
-- Why no audit_events trigger here (per plan §Quality bar + architect N1
-- + plan-review I3): inbox is operational state (mutable read_at), not
-- compliance state. Polluting audit_events with N inbox INSERTs per
-- approval (+ N read flips) would bloat the 7-year retention table for
-- no compliance value. Read-receipt analytics, if needed later, use
-- count(*) where read_at is not null.
--
-- Why no audit_event_from_row() trigger function reference: that
-- function does NOT exist in this codebase. Audit writes are TS-layer
-- inserts into public.audit_events / public.audit_outbox (e.g.
-- apps/api/src/modules/tenant/branding.service.ts:226,
-- apps/api/src/modules/visitors/pass-pool.service.ts:487). The plan
-- v2 carried an erroneous reference to it for 00392's overrides
-- table — corrected there too.

create table if not exists public.inbox_notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  event_kind text not null,
  payload jsonb not null,
  read_at timestamptz null,
  created_at timestamptz not null default now()
);

comment on table public.inbox_notifications is
  'Per-(tenant, user) notifications inbox. Written atomically inside the same RPC tx as the originating domain mutation (approval insert, etc.). Operational state — not audited.';
comment on column public.inbox_notifications.event_kind is
  'Event family that produced the notification (e.g. booking.approval_required). Matches the outbox event_type when an outbox row is also produced.';
comment on column public.inbox_notifications.payload is
  'Arbitrary jsonb payload. When the notification belongs to a deduplicable chain (e.g. one approval chain → one notification per approver), payload MUST include "chain_id" so the partial unique index below catches RPC retry replays.';
comment on column public.inbox_notifications.read_at is
  'Null = unread. Flipped by POST /me/inbox/:id/read or /me/inbox/read-all. Operational state — never audited.';

-- Idempotency for atomic-RPC inserts. Sub-step B's RPC v5 uses
--   on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
--   where (payload ? 'chain_id') do nothing
-- to make command_operations cached_result replay safe (no double-write
-- of the same (tenant, user, event, chain) row). The WHERE clause on the
-- index MUST match the WHERE in the ON CONFLICT clause exactly (Postgres
-- partial-index conflict-target rule). See /tmp/b4a5-plan-v2.md R3.
create unique index if not exists uq_inbox_notifications_chain
  on public.inbox_notifications (
    tenant_id, user_id, event_kind, ((payload->>'chain_id'))
  ) where (payload ? 'chain_id');

-- Hot index for unread-count query (GET /me/inbox/count).
create index if not exists idx_inbox_notifications_unread
  on public.inbox_notifications (tenant_id, user_id, created_at desc)
  where read_at is null;

-- Hot index for paginated inbox list (GET /me/inbox?cursor=…).
create index if not exists idx_inbox_notifications_list
  on public.inbox_notifications (tenant_id, user_id, created_at desc);

alter table public.inbox_notifications enable row level security;

-- Tenant + auth-user isolation. Bridges auth.uid() → users.auth_uid →
-- users.id within the JWT-claimed tenant (00167 pattern). Service-role
-- bypass for the API's admin client; everything else must own the row.
drop policy if exists tenant_owner_isolation on public.inbox_notifications;

create policy tenant_owner_isolation on public.inbox_notifications
  for all using (
    auth.role() = 'service_role'
    or exists (
      select 1 from public.users u
       where u.tenant_id = public.current_tenant_id()
         and u.auth_uid  = auth.uid()
         and u.id        = inbox_notifications.user_id
    )
  )
  with check (
    auth.role() = 'service_role'
    or exists (
      select 1 from public.users u
       where u.tenant_id = public.current_tenant_id()
         and u.auth_uid  = auth.uid()
         and u.id        = inbox_notifications.user_id
    )
  );

-- ON CONFLICT smoke probe — PREPAREs an INSERT with the partial-index
-- ON CONFLICT target so 42P10 (no unique or exclusion constraint matching
-- the ON CONFLICT specification) trips at migration plan time, NOT at
-- first runtime use inside the edit_booking RPC. The probe does NOT
-- execute the INSERT — it only validates that the conflict-target syntax
-- round-trips against the partial unique index above. The PREPARE +
-- DEALLOCATE pair is non-destructive (no rows touched).
do $$
declare
  v_tenant uuid := gen_random_uuid();
  v_user   uuid := gen_random_uuid();
  v_count  integer;
begin
  -- Skip the FK-enforced INSERT path entirely; we only need to prove
  -- the ON CONFLICT clause parses + matches the partial index. Use a
  -- savepoint + rollback so no rows persist.
  begin
    -- Force-disable FK checks would need superuser. Instead, exercise
    -- the conflict-target by INSERT … SELECT FROM no-op, which still
    -- parses the conflict clause at plan time.
    perform 1
      from (values (1)) v(x)
     where false;

    -- Parse-only check: prepare a statement using the conflict target.
    -- If the WHERE clause doesn't match the partial index, Postgres
    -- raises 42P10 "no unique or exclusion constraint matching the
    -- ON CONFLICT specification" at PREPARE time.
    execute $sql$
      prepare _b4a5_probe(uuid, uuid, text, jsonb) as
        insert into public.inbox_notifications
          (tenant_id, user_id, event_kind, payload)
        values ($1, $2, $3, $4)
        on conflict (tenant_id, user_id, event_kind, ((payload->>'chain_id')))
          where (payload ? 'chain_id') do nothing
    $sql$;

    execute 'deallocate _b4a5_probe';

    raise notice 'b4a5: ON CONFLICT partial-index target syntax OK';
  exception when others then
    raise exception 'b4a5: ON CONFLICT smoke probe failed: % / %', sqlstate, sqlerrm;
  end;
end $$;

notify pgrst, 'reload schema';
