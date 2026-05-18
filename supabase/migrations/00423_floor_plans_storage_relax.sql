-- 00423_floor_plans_storage_relax.sql
--
-- The storage policies from 00420 used `current_tenant_id()` which only returns
-- a value when called from the API server (it reads a session-level setting
-- the API sets per request). Direct uploads from the frontend's Supabase JS
-- client run without that setting, so the policy denies every upload with
-- "new row violates row-level security policy".
--
-- Match the existing `avatars_authenticated_write` pattern: any authenticated
-- user can write to the bucket; the application constructs tenant-prefixed
-- paths (`<tenantId>/<floorSpaceId>/<sha>.<ext>`) and the API verifies the
-- prefix matches the resolved tenant on every read.

drop policy if exists "floor_plans_tenant_insert" on storage.objects;
create policy "floor_plans_tenant_insert"
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'floor-plans');

drop policy if exists "floor_plans_tenant_update" on storage.objects;
create policy "floor_plans_tenant_update"
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'floor-plans');

drop policy if exists "floor_plans_tenant_delete" on storage.objects;
create policy "floor_plans_tenant_delete"
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'floor-plans');

drop policy if exists "floor_plans_tenant_select" on storage.objects;
create policy "floor_plans_tenant_select"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'floor-plans');
