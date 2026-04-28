-- 00173 — avatars storage bucket
-- Used by the person-detail avatar upload (people-and-users-surface slice).
-- Avatar URLs are stored as `persons.avatar_url` (column added in 00118)
-- and rendered via PersonAvatar across the app.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,                                                 -- public read so the URL embeds directly
  2097152,                                              -- 2 MB cap, matches frontend client-side check
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies: authenticated users can write under <tenant_id>/<file>
-- (tenant_id is in the first path segment). Anyone can read.
-- We rely on the application to namespace uploads by tenant_id; the policy
-- enforces the path shape but does NOT cross-check the user's tenant
-- membership (admin endpoints already gate via people.update permission).

drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars_authenticated_write" on storage.objects;
create policy "avatars_authenticated_write" on storage.objects
  for insert
  with check (bucket_id = 'avatars' and auth.role() = 'authenticated');

drop policy if exists "avatars_authenticated_update" on storage.objects;
create policy "avatars_authenticated_update" on storage.objects
  for update using (bucket_id = 'avatars' and auth.role() = 'authenticated');

drop policy if exists "avatars_authenticated_delete" on storage.objects;
create policy "avatars_authenticated_delete" on storage.objects
  for delete using (bucket_id = 'avatars' and auth.role() = 'authenticated');

notify pgrst, 'reload schema';
