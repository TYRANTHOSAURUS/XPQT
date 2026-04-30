-- Step 0 follow-up: hardening fixes from codex review of 00202.
-- Three issues addressed:
--   1. (HIGH) Direct PostgREST access to activities bypasses entity-aware
--      visibility — internal/system rows visible to any same-tenant user. Lock
--      down the table by revoking SELECT from anon + authenticated. All reads
--      go through the API (service_role), which gates by entity visibility.
--   2. (MED) Shadow trigger only handled inserts. Cascade deletes on
--      ticket_activities (e.g. seed resets, ticket deletion) leave activities
--      stale. Add a DELETE shadow trigger.
--   3. (LOW/MED) source_table and source_id should be all-or-nothing — the
--      partial unique index can't enforce that because NULLs aren't equal.
--      Add a check constraint.

-- ── 1. Lock down direct table access ──────────────────────────
revoke select, insert, update, delete on public.activities from anon, authenticated;
-- service_role retains full access via default; explicit grant for clarity.
grant select, insert, update, delete on public.activities to service_role;

comment on policy "tenant_isolation" on public.activities is
  'Tenant scope only. Direct access is revoked from anon/authenticated; reads go through the API which gates by entity visibility (ticket_visibility, reservation_visibility, etc).';

-- ── 2. Delete shadow trigger ─────────────────────────────────
create or replace function public.shadow_ticket_activity_delete_to_activities()
returns trigger
language plpgsql
as $$
begin
  delete from public.activities
   where source_table = 'ticket_activities'
     and source_id = old.id;
  return old;
end;
$$;

drop trigger if exists trg_ticket_activities_shadow_delete on public.ticket_activities;
create trigger trg_ticket_activities_shadow_delete
after delete on public.ticket_activities
for each row execute function public.shadow_ticket_activity_delete_to_activities();

comment on function public.shadow_ticket_activity_delete_to_activities() is
  'Step 0 dual-write delete shim. Drops alongside the insert shim in step 1.';

-- ── 3. source_table/source_id all-or-nothing constraint ──────
alter table public.activities
  add constraint activities_source_all_or_nothing
  check ((source_table is null) = (source_id is null));

notify pgrst, 'reload schema';
