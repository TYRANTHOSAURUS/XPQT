-- GDPR baseline · post-Sprint 5 hardening (codex review fix)
--
-- Pre-fix issue: tenant-only RLS allowed any authenticated tenant user to
-- SELECT the GDPR control tables (retention, DSR, holds, access logs, the
-- raw anonymization_audit payload) via PostgREST/Supabase JS, bypassing
-- the GdprAdminController's permission gate. The export bucket had the
-- same shape — any authenticated tenant user could fetch any export
-- bundle by guessing/finding the path.
--
-- Fix shape:
--   - Service role bypass (the API uses the service-role key for admin work).
--   - Authenticated tenant users only when they hold the right gdpr.* perm
--     via public.user_has_permission(). This keeps Postgres RLS as the
--     defense-in-depth backstop for the application-layer PermissionGuard.
--
-- Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §14 Access control.

-- =====================================================================
-- helper: which auth user is calling, scoped to the current tenant
-- =====================================================================
-- Reuses public.user_has_permission(p_user_id, p_tenant_id, p_permission).
-- We resolve auth.uid() → users.id via auth_uid + tenant scope.

create or replace function public.gdpr_caller_has(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from users u
     where u.tenant_id = public.current_tenant_id()
       and u.auth_uid  = auth.uid()
       and public.user_has_permission(u.id, u.tenant_id, p_permission)
  );
$$;

comment on function public.gdpr_caller_has(text) is
  'True iff the current Supabase auth user has the named permission within the resolved tenant. Used in RLS policies to layer authZ on top of tenant scoping.';

grant execute on function public.gdpr_caller_has(text) to authenticated, service_role;

-- =====================================================================
-- tenant_retention_settings: gdpr.configure required for select/modify
-- =====================================================================

drop policy if exists tenant_isolation on public.tenant_retention_settings;

create policy retention_select on public.tenant_retention_settings
  for select using (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.configure')
    )
  );

create policy retention_modify on public.tenant_retention_settings
  for all using (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.configure')
    )
  ) with check (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.configure')
    )
  );

-- =====================================================================
-- data_subject_requests: gdpr.fulfill_request required
-- =====================================================================

drop policy if exists tenant_isolation on public.data_subject_requests;

create policy dsr_select on public.data_subject_requests
  for select using (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.fulfill_request')
    )
  );

create policy dsr_modify on public.data_subject_requests
  for all using (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.fulfill_request')
    )
  ) with check (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.fulfill_request')
    )
  );

-- =====================================================================
-- legal_holds: gdpr.place_legal_hold required
-- =====================================================================

drop policy if exists tenant_isolation on public.legal_holds;

create policy legal_holds_select on public.legal_holds
  for select using (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.place_legal_hold')
    )
  );

create policy legal_holds_modify on public.legal_holds
  for all using (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.place_legal_hold')
    )
  ) with check (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.place_legal_hold')
    )
  );

-- =====================================================================
-- personal_data_access_logs: gdpr.audit_reads required
-- =====================================================================
-- Note: writes to this table go through the service role (PDAL worker).
-- Authenticated reads are the audit query surface — gated by gdpr.audit_reads.

drop policy if exists tenant_isolation on public.personal_data_access_logs;

create policy pdal_select on public.personal_data_access_logs
  for select using (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.audit_reads')
    )
  );

create policy pdal_modify on public.personal_data_access_logs
  for all using (
    auth.role() = 'service_role'
  ) with check (
    auth.role() = 'service_role'
  );

-- =====================================================================
-- audit_outbox: service-role only (writers use service role; consumers go
-- through audit_events). Tenant users have no business reading the outbox.
-- =====================================================================

drop policy if exists tenant_isolation on public.audit_outbox;

create policy audit_outbox_service_only on public.audit_outbox
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- =====================================================================
-- anonymization_audit: gdpr.fulfill_request required (this stores the
-- 7-day restore-window payload — raw original PII). Service role bypass
-- is required for the retention worker.
-- =====================================================================

drop policy if exists tenant_isolation on public.anonymization_audit;

create policy anon_audit_select on public.anonymization_audit
  for select using (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or public.gdpr_caller_has('gdpr.fulfill_request')
    )
  );

create policy anon_audit_modify on public.anonymization_audit
  for all using (
    auth.role() = 'service_role'
  ) with check (
    auth.role() = 'service_role'
  );

-- =====================================================================
-- gdpr-exports storage bucket: service-role only.
-- Pre-fix: any authenticated tenant user could fetch any object under
-- their tenant prefix. The bucket is meant to be reachable only via
-- signed URLs minted by DataSubjectService — those use the service role
-- under the hood, so locking authenticated users out is correct.
-- =====================================================================

drop policy if exists gdpr_exports_tenant_isolation on storage.objects;

create policy gdpr_exports_service_only
  on storage.objects
  for all
  using (
    bucket_id = 'gdpr-exports'
    and auth.role() = 'service_role'
  )
  with check (
    bucket_id = 'gdpr-exports'
    and auth.role() = 'service_role'
  );

-- =====================================================================
-- visitors.person_id: drop NOT NULL so VisitorRecordsAdapter.anonymize
-- can break the identity chain. Pre-fix: NULLing badge_id but keeping
-- the FK left visitor identity fully recoverable via the persons row.
-- =====================================================================

alter table public.visitors alter column person_id drop not null;

notify pgrst, 'reload schema';
