export const SERVICE_CATEGORIES = [
  'catering',
  'av_equipment',
  'supplies',
  'facilities_services',
  'cleaning',
  'maintenance',
  'transport',
  'other',
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** Display labels for the closed enum. Kept here so the picker + table */
/** share one source of truth.                                          */
export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  catering: 'Catering',
  av_equipment: 'AV equipment',
  supplies: 'Supplies',
  facilities_services: 'Facilities services',
  cleaning: 'Cleaning',
  maintenance: 'Maintenance',
  transport: 'Transport',
  other: 'Other',
};

export interface ServiceRoutingRow {
  id: string;
  tenant_id: string;
  /** NULL = tenant default (applies wherever no per-location row matches). */
  location_id: string | null;
  service_category: ServiceCategory;
  internal_team_id: string | null;
  default_lead_time_minutes: number;
  sla_policy_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}
