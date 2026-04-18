export const BOUND_FIELDS = ['asset_id', 'location_id', 'impact', 'urgency'] as const;
export type BoundField = typeof BOUND_FIELDS[number];

export const BOUND_FIELD_LABELS: Record<BoundField, string> = {
  asset_id: 'Ticket Asset',
  location_id: 'Ticket Location',
  impact: 'Ticket Impact',
  urgency: 'Ticket Urgency',
};
