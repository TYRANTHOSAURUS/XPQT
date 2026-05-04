// Internal types for the BookingBundles module.
// Filled in slice 2C.

export type BundleType = 'meeting' | 'event' | 'desk_day' | 'parking' | 'hospitality' | 'other';

export type BundleStatusRollup =
  | 'pending'
  | 'pending_approval'
  | 'confirmed'
  | 'partially_cancelled'
  | 'cancelled'
  | 'completed';

// /full-review v3 closure Nit (2026-05-04) — `'recurrence'` added to mirror
// BookingSource (apps/api/src/modules/reservations/dto/types.ts:28-37).
// Bundle source flows through from the booking source on the booking-flow
// / multi-room paths, so the union must stay aligned with BookingSource.
// Migration 00295 widens bookings.source CHECK; bundle rows don't have an
// enforced enum so the addition is type-only here.
export type BundleSource = 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception' | 'recurrence';
