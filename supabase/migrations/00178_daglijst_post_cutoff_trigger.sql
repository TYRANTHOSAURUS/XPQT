-- Daglijst Sprint 3 — post-cutoff change workflow.
--
-- When an order_line_item is locked into a sent daglijst version
-- (daglijst_locked_at IS NOT NULL) and any fulfillment-affecting field
-- changes afterwards, requires_phone_followup must become true so the
-- desk dashboard surfaces it for phone follow-up with the vendor.
--
-- Spec: §7 "Lock state + post-cutoff change workflow".
--
-- Trigger over service-layer hook because:
--   1. The lock predicate must be checked on EVERY mutation path —
--      orders.service.ts edits, asset-reservation cascades, recurrence
--      reschedules, admin "edit line" UI, and any future writer. A
--      service-layer hook would have to be added to each of those.
--   2. Locked line edits via SQL migrations (rare but possible during
--      schema work) would also miss a service hook.
-- The trigger fails closed: edit blocked from rolling forward without
-- the followup flag.

create or replace function public.fn_daglijst_post_cutoff_followup()
  returns trigger language plpgsql as $$
declare
  /* Columns whose change after lock means the vendor's printed list is
     now wrong — desk must phone the vendor.

     NOT included (intentionally):
       - desk_confirmed_phoned_at / desk_confirmed_phoned_by_user_id
         (the desk-side confirm-phoned action; flipping followup back
          to false should NOT re-arm the trigger)
       - daglijst_locked_at / daglijst_id / requires_phone_followup
         (the lock metadata itself; otherwise this trigger would
          self-flip on the lock UPDATE)
       - updated_at (touched by every UPDATE for hygiene)
       - linked_ticket_id (ops bookkeeping, not vendor-visible)
       - fulfillment_team_id (assignee swap, not vendor-visible)
       - policy_snapshot (versioning artifact)
       - recurrence_* / repeats_with_series (recurrence bookkeeping;
          recurrence reschedule changes service_window_* which IS in
          the watch list)
   */
  v_changed boolean;
begin
  /* Only act on UPDATEs that occur AFTER the line was locked. Pre-lock
     edits are normal cart-edit traffic; we don't want to flag them. */
  if new.daglijst_locked_at is null then
    return new;
  end if;

  /* Distinct-from comparisons because some columns are nullable. */
  v_changed :=
       new.catalog_item_id          is distinct from old.catalog_item_id
    or new.menu_item_id             is distinct from old.menu_item_id
    or new.quantity                 is distinct from old.quantity
    or new.dietary_notes            is distinct from old.dietary_notes
    or new.fulfillment_status       is distinct from old.fulfillment_status
    or new.fulfillment_notes        is distinct from old.fulfillment_notes
    or new.service_window_start_at  is distinct from old.service_window_start_at
    or new.service_window_end_at    is distinct from old.service_window_end_at
    or new.unit_price               is distinct from old.unit_price
    or new.line_total               is distinct from old.line_total;

  if v_changed and new.requires_phone_followup is not true then
    new.requires_phone_followup        := true;
    /* Reset confirmed state — a fresh change resets the
       "I phoned the vendor" stamp; the desk must re-confirm. */
    new.desk_confirmed_phoned_at       := null;
    new.desk_confirmed_phoned_by_user_id := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_daglijst_post_cutoff_followup on public.order_line_items;

create trigger trg_daglijst_post_cutoff_followup
  before update on public.order_line_items
  for each row execute function public.fn_daglijst_post_cutoff_followup();

comment on function public.fn_daglijst_post_cutoff_followup is
  'Daglijst post-cutoff workflow trigger: when a locked order_line_item is '
  'edited (any fulfillment-affecting column), set requires_phone_followup=true '
  'so the desk dashboard surfaces it. Idempotent — re-edits keep the flag set.';

-- Detect order-level cancellation propagation: when an order is cancelled
-- the line items inherit the cancellation but their fulfillment_status
-- doesn't always change synchronously. Add a separate trigger on orders
-- so we don't miss "every line was implicitly cancelled" cases.
--
-- Defer to Sprint 4 if the orders-side cancel-cascade isn't ready yet
-- — for now the line-level trigger handles direct edits, which is the
-- common case (admin edits a line via the booking detail UI).

notify pgrst, 'reload schema';
