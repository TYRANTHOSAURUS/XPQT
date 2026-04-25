# Phase D — App.tsx routing changes

Two small changes inside the `<Route path="/portal" …>` block in
`apps/web/src/App.tsx`. All routes already nest under the protected portal
shell — no auth wrapping changes needed.

## 1. Add lazy imports (alongside existing portal imports near line 41)

```tsx
const BookRoomPage = lazyNamed(() => import('@/pages/portal/book-room'), 'BookRoomPage');
const MyBookingsPage = lazyNamed(() => import('@/pages/portal/me-bookings'), 'MyBookingsPage');
```

## 2. Replace the placeholder routes (currently lines 149 + 153)

**Replace this:**
```tsx
<Route path="rooms"    element={<Navigate to="/portal" replace />} />
<Route path="visitors" element={<Navigate to="/portal" replace />} />
<Route path="order"    element={<Navigate to="/portal" replace />} />
<Route path="account"  element={<Navigate to="/portal/profile" replace />} />
<Route path="book" element={<Navigate to="/portal/rooms" replace />} />
```

**With this:**
```tsx
<Route path="rooms"    element={<BookRoomPage />} />
<Route path="visitors" element={<Navigate to="/portal" replace />} />
<Route path="order"    element={<Navigate to="/portal" replace />} />
<Route path="account"  element={<Navigate to="/portal/profile" replace />} />
<Route path="book" element={<Navigate to="/portal/rooms" replace />} />
{/* My bookings — :id auto-opens the right-side detail drawer */}
<Route path="me/bookings" element={<MyBookingsPage />} />
<Route path="me/bookings/:id" element={<MyBookingsPage />} />
```

## 3. Optional follow-up

The bottom-tabs `Rooms` link (apps/web/src/components/portal/portal-bottom-tabs.tsx)
already points at `/portal/rooms`. After this routing change it goes live —
no edit needed there.

If you want a top-bar entry to "My bookings" too, add it to the portal top bar
or the user menu. Today the page is reachable from:
- `/portal/rooms` → "My bookings →" link in the page header
- `/portal/me/bookings` directly

---

# Phase F — Admin rule editor routes

Two new pages under `/admin` for the room-booking rule admin (index + detail).
Follows the canonical `/admin/webhooks` + `/admin/criteria-sets` pattern.

## 1. Add lazy imports (alongside existing admin imports)

```tsx
const RoomBookingRulesPage = lazyNamed(
  () => import('@/pages/admin/room-booking-rules/index'),
  'RoomBookingRulesPage',
);
const RoomBookingRuleDetailPage = lazyNamed(
  () => import('@/pages/admin/room-booking-rules/detail'),
  'RoomBookingRuleDetailPage',
);
```

## 2. Register routes inside the existing `<Route path="/admin">` block

```tsx
<Route path="room-booking-rules" element={<RoomBookingRulesPage />} />
<Route path="room-booking-rules/:id" element={<RoomBookingRuleDetailPage />} />
```

## 3. Admin nav entry

Add a row to `apps/web/src/lib/admin-nav.ts` under the closest existing group
("Operations" or "Routing"):

```ts
{
  title: 'Room booking rules',
  description: "Govern who can book what, when, and what triggers approval.",
  path: '/admin/room-booking-rules',
  icon: ShieldCheck, // from lucide-react
}
```

## 4. Notes for follow-up phases

- Phase E (desk scheduler) can reuse `<RuleRowEffectBadge>` and `<RuleScopeSummary>` from
  `apps/web/src/pages/admin/room-booking-rules/components/`.
- Phase G/Phase K: revisit the `target_id uuid` schema mismatch for `room_type` scope —
  the detail page currently maps fixed UUIDs to type-keys in `ROOM_TYPE_OPTIONS` (top of
  `apps/web/src/pages/admin/room-booking-rules/detail.tsx`). A clean migration switching
  `target_id` to `text` (or splitting it into `target_type_key` + `target_uuid`) would let
  us drop that map and use the type-key string directly.
