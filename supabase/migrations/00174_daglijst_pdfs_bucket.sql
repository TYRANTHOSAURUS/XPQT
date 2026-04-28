-- Daglijst Phase A · Sprint 2
-- Storage bucket for generated daglijst PDFs.
--
-- Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §5.
--
-- Path layout:
--   <tenant_id>/<vendor_id>/<list_date>/<building_slug-or-tenant>/<service_type>-v<version>.pdf
--
-- Private bucket — every download flows through a signed URL minted by
-- DaglijstService.getDownloadUrl() with TTL ≤ 1 hour. Same shape as the
-- gdpr-exports bucket (00166).

insert into storage.buckets (id, name, public, file_size_limit)
values ('daglijst-pdfs', 'daglijst-pdfs', false, 52428800)               -- 50 MB cap; typical PDFs <2 MB
on conflict (id) do nothing;

-- Service-role only. The API mints signed URLs from server-side code; no
-- direct browser-side access. Same posture as gdpr-exports per the codex
-- review on Wave 0.
drop policy if exists daglijst_pdfs_service_only on storage.objects;
create policy daglijst_pdfs_service_only
  on storage.objects
  for all
  using (
    bucket_id = 'daglijst-pdfs'
    and auth.role() = 'service_role'
  )
  with check (
    bucket_id = 'daglijst-pdfs'
    and auth.role() = 'service_role'
  );
