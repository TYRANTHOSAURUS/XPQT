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
alter table public.order_line_items
  add column if not exists requester_notes text;

comment on column public.order_line_items.requester_notes is
  'Free-text note from the requester (AV placement, setup instructions, anything non-dietary). dietary_notes remains catering-specific.';

-- Reload PostgREST so the new column is visible to the API immediately.
notify pgrst, 'reload schema';
