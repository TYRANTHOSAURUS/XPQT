-- Vendor Portal Phase B · Sprint 3 codex fix
--
-- Sprint 3's commit message claimed Realtime push was "implicit via
-- Supabase Realtime auto-replication of vendor_order_status_events
-- INSERTs." That was wrong on two counts (codex flagged both):
--
--   1. The table was never added to the supabase_realtime publication.
--      Postgres-changes broadcasts ONLY include tables in that publication.
--   2. The table's RLS was service-role only — even if the publication
--      delivered the row, a desk-side browser session subscribing with
--      its tenant JWT could not READ the row, so Realtime would silently
--      drop the change.
--
-- This migration fixes both. Status events are still service-role-write;
-- desk users with vendors.read can SELECT (so Realtime delivers + the
-- detail page can render the audit-of-self timeline).

-- =====================================================================
-- 1. Add table to the supabase_realtime publication
-- =====================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'vendor_order_status_events'
  ) then
    alter publication supabase_realtime add table public.vendor_order_status_events;
  end if;
end
$$;

-- =====================================================================
-- 2. Add tenant-scoped SELECT policy for desk users with vendors.read
-- =====================================================================
-- Existing policy: vendor_order_status_events_service (service role only).
-- Add a parallel SELECT policy for authenticated tenant users with the
-- vendors.read permission. This is the same pattern as the GDPR baseline
-- RLS hardening (00167) — composite predicate combining tenant scope +
-- permission check.

drop policy if exists vendor_order_status_events_select_perm on public.vendor_order_status_events;

create policy vendor_order_status_events_select_perm on public.vendor_order_status_events
  for select using (
    tenant_id = public.current_tenant_id()
    and (
      auth.role() = 'service_role'
      or exists (
        select 1
          from public.users u
         where u.tenant_id = public.current_tenant_id()
           and u.auth_uid  = auth.uid()
           and public.user_has_permission(u.id, u.tenant_id, 'vendors.read')
      )
    )
  );

-- The service-role write policy stays in place untouched. Net policy set:
--   - vendor_order_status_events_service       (FOR ALL  service_role)
--   - vendor_order_status_events_select_perm   (FOR SELECT  service_role OR vendors.read)

comment on table public.vendor_order_status_events is
  'Per-line vendor status transition audit. Realtime-replicated; desk users '
  'with vendors.read can SELECT for live updates. Writes are service-role only '
  'and originate from VendorOrderStatusService. See vendor-portal-phase-b-design.md §6 + §8.';

notify pgrst, 'reload schema';
