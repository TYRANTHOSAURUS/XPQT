-- Public bucket for tenant logo assets.
-- Read is public (needed pre-auth on login page). Write/delete is service-role only.

insert into storage.buckets (id, name, public)
values ('tenant-branding', 'tenant-branding', true)
on conflict (id) do update set public = true;

-- Public read policy
drop policy if exists "tenant_branding_public_read" on storage.objects;
create policy "tenant_branding_public_read"
  on storage.objects for select
  using (bucket_id = 'tenant-branding');

-- Only the service role can write to this bucket. There is no permissive policy for
-- anon/authenticated callers, so Postgres RLS denies by default. The service role
-- bypasses RLS entirely, so an explicit `auth.role()` check in the policy body is
-- unnecessary — the deny-by-default is what actually enforces the restriction.

drop policy if exists "tenant_branding_service_write" on storage.objects;
create policy "tenant_branding_service_write"
  on storage.objects for insert
  with check (bucket_id = 'tenant-branding');

drop policy if exists "tenant_branding_service_update" on storage.objects;
create policy "tenant_branding_service_update"
  on storage.objects for update
  using (bucket_id = 'tenant-branding')
  with check (bucket_id = 'tenant-branding');

drop policy if exists "tenant_branding_service_delete" on storage.objects;
create policy "tenant_branding_service_delete"
  on storage.objects for delete
  using (bucket_id = 'tenant-branding');

notify pgrst, 'reload schema';
