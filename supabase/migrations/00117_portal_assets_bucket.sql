-- 00117_portal_assets_bucket.sql
-- Supabase storage bucket for portal imagery: hero images + category covers.
-- Files are organized as: {tenant_id}/hero/{uuid}.{ext}
--                        {tenant_id}/category-cover/{uuid}.{ext}
-- Bucket is public-read (covers/hero images are tenant-visual only, never PII).
-- Writes are service-role only — the NestJS API mediates all uploads.

insert into storage.buckets (id, name, public)
  values ('portal-assets', 'portal-assets', true)
  on conflict (id) do nothing;
