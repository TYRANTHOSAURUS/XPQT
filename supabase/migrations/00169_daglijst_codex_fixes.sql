-- Daglijst Phase A · Sprint 1 hardening (codex review fixes)
--
-- Two real issues from the codex review on commit 5096128:
--   1. RLS on vendor_daily_lists granted SELECT to anyone with vendors.read.
--      That's broader than the spec's admin-only access model and exposes
--      raw payloads (recipient_email, dietary_notes). Tighten to service-
--      role only — the API owns the access path via the service-role key
--      + controller permission gate.
--   2. vendors_daglijst_send_mode_chk did not actually express the spec's
--      "clock_time XOR offset" rule. Replace with a proper num_nonnulls
--      constraint so admin can pick exactly one send mode.

-- =====================================================================
-- 1. Tighten vendor_daily_lists RLS to service-role only
-- =====================================================================

drop policy if exists vendor_daily_lists_select on public.vendor_daily_lists;
drop policy if exists vendor_daily_lists_modify on public.vendor_daily_lists;

-- Single all-rows policy for service_role; authenticated users go through
-- the API controller which uses the service-role key.
create policy vendor_daily_lists_service_only on public.vendor_daily_lists
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.vendor_daily_lists is
  'Per-(vendor, building, service_type, date, version) snapshot of orders sent to a paper-mode vendor. RLS: service-role only — admin reads go through the API. See daglijst-design.md §3.';


-- =====================================================================
-- 2. Replace the broken send-mode CHECK with proper XOR
-- =====================================================================
-- Pre-fix: the constraint only said "if clock_time is set, offset must
-- still be 180" — which is meaningless. Now: paper_only/hybrid vendors
-- MUST have exactly one of (clock_time, offset_minutes) set.
--
-- Make daglijst_cutoff_offset_minutes nullable so admins who set
-- clock_time can null out the offset.

alter table public.vendors
  drop constraint if exists vendors_daglijst_send_mode_chk;

-- Allow the offset column to be nullable now (was NOT NULL DEFAULT 180).
alter table public.vendors
  alter column daglijst_cutoff_offset_minutes drop not null;

alter table public.vendors
  add constraint vendors_daglijst_send_mode_chk
    check (
      -- Portal vendors don't need either send mode.
      fulfillment_mode = 'portal'
      or num_nonnulls(daglijst_send_clock_time, daglijst_cutoff_offset_minutes) = 1
    );

comment on column public.vendors.daglijst_cutoff_offset_minutes is
  'Send the daglijst this many minutes before the bucket''s earliest delivery_time. Mutually exclusive with daglijst_send_clock_time (XOR enforced by vendors_daglijst_send_mode_chk).';
comment on column public.vendors.daglijst_send_clock_time is
  'Send the daglijst at this fixed time-of-day (NL local) the day before list_date. Mutually exclusive with daglijst_cutoff_offset_minutes.';

notify pgrst, 'reload schema';
