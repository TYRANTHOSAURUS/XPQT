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

export type BundleSource = 'portal' | 'desk' | 'api' | 'calendar_sync' | 'reception';
