-- Add a generic requester_notes column to order_line_items.
--
-- The existing dietary_notes column is overloaded — it's read by
-- daily-list, vendor-portal, post-cutoff, and the late-changes-widget,
-- all of which treat it as catering-specific dietary information
-- (rendered as "diet: …"). When the booking detail surface lets the
-- requester attach a free-text note for AV placement, setup
-- instructions, or anything non-dietary, those notes would leak into
-- the dietary widgets if we reused dietary_notes.
--
-- Splitting them: dietary_notes stays the catering-specific column
-- (untouched here); requester_notes is the new generic note slot
-- surfaced on the booking detail "Notes" textarea.
--
-- RLS coverage: order_line_items has a table-level "tenant_isolation"
-- policy (see 00013_orders_catalog.sql) that auto-applies to every
-- column on the table. requester_notes is therefore tenant-isolated
-- without a per-column declaration.
--
-- TODO (data-model-redesign Step 2): when `order_line_items` is renamed
-- / split per parent kind (`booking_services` vs `case_services`), this
-- column needs to follow — likely landing on both halves or on a shared
-- polymorphic `notes` table addressing `(entity_kind, entity_id)`.
-- Coordinate with `docs/data-model-redesign-2026-04-30.md` Step 2 before
-- the rename.
alter table public.order_line_items
  add column if not exists requester_notes text;

comment on column public.order_line_items.requester_notes is
  'Free-text note from the requester (AV placement, setup instructions, anything non-dietary). dietary_notes remains catering-specific.';

-- Reload PostgREST so the new column is visible to the API immediately.
notify pgrst, 'reload schema';
