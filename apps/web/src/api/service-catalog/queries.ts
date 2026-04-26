import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { serviceCatalogKeys } from './keys';
import type { AvailableServiceItem, ServiceType } from './types';

interface AvailableItemsResponse {
  items: AvailableServiceItem[];
}

/**
 * Probe consumed by the booking-confirm dialog and the standalone-order
 * page. Lazy: `enabled` defaults to true but the caller usually gates by
 * "section is open" so we don't fetch until the user expands. 30s
 * staletime keeps re-expand cheap inside one dialog session.
 */
export function availableServiceItemsOptions(args: {
  delivery_space_id: string | null | undefined;
  on_date: string | null | undefined;
  service_type: ServiceType;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: [
      ...serviceCatalogKeys.all,
      'available-items',
      args.delivery_space_id ?? null,
      args.on_date ?? null,
      args.service_type,
    ] as const,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        delivery_space_id: args.delivery_space_id ?? '',
        on_date: args.on_date ?? '',
        service_type: args.service_type,
      });
      return apiFetch<AvailableItemsResponse>(
        `/service-catalog/available-items?${params.toString()}`,
        { signal },
      );
    },
    staleTime: 30_000,
    enabled:
      Boolean(args.enabled ?? true) &&
      Boolean(args.delivery_space_id) &&
      Boolean(args.on_date),
  });
}

export function useAvailableServiceItems(args: Parameters<typeof availableServiceItemsOptions>[0]) {
  return useQuery(availableServiceItemsOptions(args));
}
