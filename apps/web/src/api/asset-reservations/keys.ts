export const assetReservationKeys = {
  all: ['asset-reservations'] as const,
  lists: () => [...assetReservationKeys.all, 'list'] as const,
  list: (params: { asset_id?: string; bundle_id?: string }) =>
    [...assetReservationKeys.lists(), params] as const,
  details: () => [...assetReservationKeys.all, 'detail'] as const,
  detail: (id: string) => [...assetReservationKeys.details(), id] as const,
} as const;
