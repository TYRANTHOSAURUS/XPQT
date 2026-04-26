export interface BundleListFilters {
  scope?: 'all' | 'pending_approval' | 'cancelled' | 'today';
  location_id?: string;
  cursor?: string | null;
  limit?: number | null;
}

export const bundleKeys = {
  all: ['booking-bundles'] as const,
  lists: () => [...bundleKeys.all, 'list'] as const,
  list: (filters: BundleListFilters) => [...bundleKeys.lists(), filters] as const,
  details: () => [...bundleKeys.all, 'detail'] as const,
  detail: (id: string) => [...bundleKeys.details(), id] as const,
  audit: (id: string) => [...bundleKeys.all, 'audit', id] as const,
} as const;
