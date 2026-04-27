-- GDPR baseline · Wave 0 Sprint 3
-- Storage bucket for per-person export bundles (Art. 15 access requests).
--
-- Private bucket — every access goes through a 30-day signed URL.
-- Path layout: <tenant_id>/<request_id>/bundle.json
--              <tenant_id>/<request_id>/bundle.zip (Sprint 3+ optional)
--
-- Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §6.

insert into storage.buckets (id, name, public, file_size_limit)
values ('gdpr-exports', 'gdpr-exports', false, 524288000)            -- 500 MB cap per spec §13
on conflict (id) do nothing;

-- RLS on storage.objects: tenant-scoped read/write via service role.
-- The export bundle is sensitive PII so we deliberately do NOT add a
-- public-read policy — every download flows through a signed URL minted
-- by DataSubjectService.

-- Drop / recreate per-tenant policy (idempotent re-run).
drop policy if exists gdpr_exports_tenant_isolation on storage.objects;
create policy gdpr_exports_tenant_isolation
  on storage.objects
  for all
  using (
    bucket_id = 'gdpr-exports'
    and (
      -- service role bypass (worker uploads + signed URL minting)
      auth.role() = 'service_role'
      -- authenticated tenant users may only see their own tenant's prefix
      or (
        auth.role() = 'authenticated'
        and (storage.foldername(name))[1] = (
          select tenants.id::text from public.tenants
           where tenants.id = public.current_tenant_id()
          limit 1
        )
      )
    )
  );
