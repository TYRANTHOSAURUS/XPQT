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
