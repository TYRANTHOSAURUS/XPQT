-- 00118_persons_avatar.sql
-- Profile-photo URL for persons. Image bytes live in the existing
-- public-read `portal-assets` bucket at:
--   {tenant_id}/avatar/{person_id}.{ext}
-- Writes are mediated by the API (service-role); the column simply stores
-- the resolved public URL plus a cache-bust query string.

alter table public.persons
  add column if not exists avatar_url text;

notify pgrst, 'reload schema';
