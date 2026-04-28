-- Vendor Portal Phase B · Sprint 3
-- Extend order_line_items.fulfillment_status with 'en_route' for the
-- vendor status-transition flow (received → preparing → en_route → delivered).
--
-- Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md
-- §1 goal #4 + §6 inbox + detail UI status state machine.
--
-- Mapping decisions:
--   - Spec "received"   = existing 'confirmed'  (vendor acknowledged the order)
--   - Spec "preparing"  = existing 'preparing'
--   - Spec "en_route"   = NEW value added here
--   - Spec "delivered"  = existing 'delivered'
--   - Spec "decline"    = existing 'cancelled'  (vendor cannot fulfill;
--                          requires_phone_followup gets set so desk picks
--                          it up)
--
-- We deliberately do NOT rename 'confirmed' → 'received'; the existing
-- value is referenced by older code paths and the rename would break
-- backward compatibility. The vendor-portal UI layer maps the label.

alter table public.order_line_items
  drop constraint if exists order_line_items_fulfillment_status_check;

alter table public.order_line_items
  add constraint order_line_items_fulfillment_status_check
    check (fulfillment_status = any (array[
      'ordered'::text,
      'confirmed'::text,
      'preparing'::text,
      'en_route'::text,
      'delivered'::text,
      'cancelled'::text
    ]));

comment on column public.order_line_items.fulfillment_status is
  'Vendor-facing fulfillment state. Transitions managed by VendorOrderStatusService '
  '(ordered → confirmed → preparing → en_route → delivered) + cancelled (decline path). '
  'See vendor-portal-phase-b-design.md §6.';

notify pgrst, 'reload schema';
