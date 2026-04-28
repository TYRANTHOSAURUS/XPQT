-- GDPR retention category rename — `daglijst_pdfs` → `daily_list_pdfs`.
--
-- Codex Sprint 3A round-2 review caught that the frontend label map +
-- the in-code adapter (concrete-adapters.ts) were renamed to
-- `daily_list_pdfs`, but:
--   1. The seed function `seed_default_retention_for_tenant` (migration
--      00162) still inserts `daglijst_pdfs` for new tenants.
--   2. Any tenants already seeded carry a row with `daglijst_pdfs`.
-- Result: UI showed "daglijst_pdfs" as a raw key for live tenants, and
-- new tenants would do the same.
--
-- Fix here:
--   A. Migrate live rows to the new key.
--   B. Replace the seed function so future tenants get the new key.
--
-- Safe because the category name is internal (no FK references; UI
-- looks up via the renamed concrete-adapters list, which already uses
-- `daily_list_pdfs`).

-- (A) Live data rename — idempotent (no rows match on second run).
update public.tenant_retention_settings
   set data_category = 'daily_list_pdfs'
 where data_category = 'daglijst_pdfs';

-- (B) Re-create the seed function with the renamed default. The full
--     body is replicated from 00162 with the single literal flipped;
--     keeping it as one CREATE OR REPLACE keeps the function signature
--     identical for downstream callers.
create or replace function public.seed_default_retention_for_tenant(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenant_retention_settings
    (tenant_id, data_category, default_retention_days, max_retention_days, legal_basis)
  values
    (p_tenant_id, 'person_basic',                      730,               1825, 'contract'),
    (p_tenant_id, 'person_preferences',                 30,                 30, 'contract'),
    (p_tenant_id, 'person_ref_in_past_records',         90,                 90, 'contract'),
    (p_tenant_id, 'past_bookings',                    2555,               null, 'legal_obligation'),
    (p_tenant_id, 'past_orders',                      2555,               null, 'legal_obligation'),
    (p_tenant_id, 'audit_events',                     2555,               null, 'legal_obligation'),
    (p_tenant_id, 'personal_data_access_logs',         365,                730, 'legitimate_interest'),
    (p_tenant_id, 'calendar_event_content',              0,                  0, 'none'),
    (p_tenant_id, 'calendar_attendees_snapshot',        90,                365, 'legitimate_interest'),
    (p_tenant_id, 'daily_list_pdfs',                    90,                365, 'legitimate_interest'),
    (p_tenant_id, 'email_notifications',                30,                365, 'legitimate_interest'),
    (p_tenant_id, 'webhook_notifications',              30,                365, 'legitimate_interest'),
    (p_tenant_id, 'ghost_persons',                     365,                730, 'legitimate_interest'),
    (p_tenant_id, 'vendor_user_data',                  730,               1825, 'contract')
  on conflict (tenant_id, data_category) do nothing;
end;
$$;

comment on function public.seed_default_retention_for_tenant(uuid) is
  'Idempotent. Seeds the canonical retention categories with defaults from '
  'gdpr-baseline-design.md §3. Renamed daglijst_pdfs → daily_list_pdfs in 00180.';

notify pgrst, 'reload schema';
