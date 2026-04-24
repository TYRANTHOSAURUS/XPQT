-- 00111_role_audit_events.sql
--
-- Roles/permissions redesign, slice 4/10.
--
-- Audit log for role + role-assignment mutations. Emitted by the API on every
-- role create/update/delete and every assignment create/update/revoke. The
-- `payload` jsonb captures the before/after diff so admins can answer
-- "who changed what, when, and why" without log-diving.
--
-- RLS: tenant-scoped read + insert via the existing current_tenant_id() helper.

begin;

create table if not exists public.role_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_user_id uuid references public.users(id) on delete set null,
  event_type text not null check (event_type in (
    'role.created',
    'role.updated',
    'role.deleted',
    'role.permissions_changed',
    'assignment.created',
    'assignment.updated',
    'assignment.revoked'
  )),
  target_role_id uuid references public.roles(id) on delete set null,
  target_user_id uuid references public.users(id) on delete set null,
  target_assignment_id uuid references public.user_role_assignments(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.role_audit_events is
  'Append-only audit log of role + assignment mutations. Written by the API, never by clients directly.';

create index if not exists role_audit_events_tenant_created_idx
  on public.role_audit_events (tenant_id, created_at desc);
create index if not exists role_audit_events_target_role_idx
  on public.role_audit_events (target_role_id, created_at desc)
  where target_role_id is not null;
create index if not exists role_audit_events_target_user_idx
  on public.role_audit_events (target_user_id, created_at desc)
  where target_user_id is not null;

alter table public.role_audit_events enable row level security;

drop policy if exists role_audit_events_tenant_read on public.role_audit_events;
create policy role_audit_events_tenant_read on public.role_audit_events
  for select using (tenant_id = public.current_tenant_id());

-- Writes happen via service-role key (the API uses supabase.admin), so no
-- insert policy is exposed to authenticated users. RLS still enabled as a
-- defence-in-depth guard against future direct-client writes.

commit;

notify pgrst, 'reload schema';
