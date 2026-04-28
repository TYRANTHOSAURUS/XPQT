-- Daily-list Sprint 3A codex review fix — trigger watches vendor_id.
--
-- The 00178 trigger missed the vendor-swap case: an admin reassigning a
-- locked line to a different vendor leaves both vendors' printed lists
-- wrong (the original vendor cooked the now-removed item, the new
-- vendor doesn't know it was added). Both need phone follow-up.
--
-- Add vendor_id to the watched-columns IS DISTINCT FROM list. Same
-- function, same trigger; just rebuild with the new check.

create or replace function public.fn_daglijst_post_cutoff_followup()
  returns trigger language plpgsql as $$
declare
  v_changed boolean;
begin
  if new.daglijst_locked_at is null then
    return new;
  end if;

  v_changed :=
       new.catalog_item_id          is distinct from old.catalog_item_id
    or new.menu_item_id             is distinct from old.menu_item_id
    or new.vendor_id                is distinct from old.vendor_id
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
    new.desk_confirmed_phoned_at       := null;
    new.desk_confirmed_phoned_by_user_id := null;
  end if;

  return new;
end;
$$;

comment on function public.fn_daglijst_post_cutoff_followup is
  'Daily-list post-cutoff workflow trigger: when a locked order_line_item is '
  'edited (any fulfillment-affecting column, INCLUDING vendor_id swap), set '
  'requires_phone_followup=true so the desk dashboard surfaces it.';

notify pgrst, 'reload schema';
