export type AvailabilityState = 'available' | 'partial' | 'booked' | 'mine' | 'pending' | 'not_bookable';

export const STATE_PALETTE: Record<AvailabilityState, { outline: string; fill: string; dot: string }> = {
  available:    { outline: '#86efac', fill: '#f0fdf4',                  dot: '#22c55e' },
  partial:      { outline: '#fcd34d', fill: 'url(#partial-stripes)',     dot: '#84cc16' },
  booked:       { outline: '#fca5a5', fill: '#fef2f2',                  dot: '#ef4444' },
  mine:         { outline: '#60a5fa', fill: '#eff6ff',                  dot: '#3b82f6' },
  pending:      { outline: '#fcd34d', fill: '#fffbeb',                  dot: '#f59e0b' },
  not_bookable: { outline: '#d6d3d1', fill: '#fafaf9',                  dot: '#d6d3d1' },
};
