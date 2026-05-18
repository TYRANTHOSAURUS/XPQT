-- 00420_floor_plans_storage_bucket.sql
-- Private bucket, tenant-prefixed paths, RLS-enforced on every action.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('floor-plans', 'floor-plans', false, 10485760,
        array['image/png','image/jpeg','image/webp','image/svg+xml']::text[])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "floor_plans_tenant_insert" on storage.objects;
create policy "floor_plans_tenant_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'floor-plans'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists "floor_plans_tenant_update" on storage.objects;
create policy "floor_plans_tenant_update"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'floor-plans'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists "floor_plans_tenant_delete" on storage.objects;
create policy "floor_plans_tenant_delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'floor-plans'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists "floor_plans_tenant_select" on storage.objects;
create policy "floor_plans_tenant_select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'floor-plans'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );
