export interface OrderListFilters {
  scope?: 'all' | 'pending_approval' | 'fulfilled' | 'cancelled';
  bundle_id?: string;
  vendor_id?: string;
  cursor?: string | null;
  limit?: number | null;
}

export const orderKeys = {
  all: ['orders'] as const,
  lists: () => [...orderKeys.all, 'list'] as const,
  list: (filters: OrderListFilters) => [...orderKeys.lists(), filters] as const,
  details: () => [...orderKeys.all, 'detail'] as const,
  detail: (id: string) => [...orderKeys.details(), id] as const,
  lineItems: (orderId: string) => [...orderKeys.detail(orderId), 'line-items'] as const,
} as const;
