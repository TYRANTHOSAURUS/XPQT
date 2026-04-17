export const SERVICE_TYPES = [
  'catering',
  'av_equipment',
  'supplies',
  'facilities_services',
  'cleaning',
  'maintenance',
  'transport',
  'other',
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const UNITS = ['per_item', 'per_person', 'flat_rate'] as const;
export type UnitType = (typeof UNITS)[number];

export type MenuStatus = 'draft' | 'published' | 'archived';

export const MENU_STATUS_VARIANT: Record<MenuStatus, 'default' | 'secondary' | 'outline'> = {
  draft: 'outline',
  published: 'default',
  archived: 'secondary',
};

/** Turn `av_equipment` → `av equipment` for display. Capitalize yourself where needed. */
export const humanize = (s: string) => s.replaceAll('_', ' ');
