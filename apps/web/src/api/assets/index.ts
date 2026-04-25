import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Asset {
  id: string;
  name: string;
  asset_type_id?: string | null;
  asset_type?: { id: string; name: string; domain?: string | null } | null;
  serial_number?: string | null;
  space_id?: string | null;
  override_team_id?: string | null;
  override_vendor_id?: string | null;
  active?: boolean;
}

export interface AssetType {
  id: string;
  name: string;
  domain?: string | null;
  default_team_id?: string | null;
  default_vendor_id?: string | null;
}

export const assetKeys = {
  all: ['assets'] as const,
  lists: () => [...assetKeys.all, 'list'] as const,
  list: () => [...assetKeys.lists(), {}] as const,
  details: () => [...assetKeys.all, 'detail'] as const,
  detail: (id: string) => [...assetKeys.details(), id] as const,
  types: () => [...assetKeys.all, 'types'] as const,
  typesList: () => [...assetKeys.types(), 'list'] as const,
} as const;

export interface AssetListFilters {
  roleFilter?: string | null;
  /** Picker filters (asset-combobox). */
  assetTypeIds?: string[] | null;
  spaceId?: string | null;
  search?: string | null;
}

export function assetsListOptions(filters: AssetListFilters = {}) {
  const role = filters.roleFilter && filters.roleFilter !== 'all' ? filters.roleFilter : null;
  const normalized = {
    role,
    assetTypeIds: filters.assetTypeIds?.length ? [...filters.assetTypeIds].sort() : undefined,
    spaceId: filters.spaceId || undefined,
    search: filters.search || undefined,
  };
  return queryOptions({
    queryKey: [...assetKeys.lists(), normalized] as const,
    queryFn: ({ signal }) =>
      apiFetch<Asset[]>('/assets', {
        signal,
        query: {
          asset_role: normalized.role ?? undefined,
          asset_type_ids: normalized.assetTypeIds?.join(','),
          space_id: normalized.spaceId,
          search: normalized.search,
        },
      }),
    staleTime: 60_000, // T2 — more volatile than teams/vendors.
  });
}
export function useAssets(filters: AssetListFilters = {}) {
  return useQuery(assetsListOptions(filters));
}
export function useAssetsFiltered(roleFilter: string | null) {
  return useQuery(assetsListOptions({ roleFilter }));
}

export function assetTypesListOptions() {
  return queryOptions({
    queryKey: assetKeys.typesList(),
    queryFn: ({ signal }) => apiFetch<AssetType[]>('/asset-types', { signal }),
    staleTime: 5 * 60_000, // T3 — admin-edited.
  });
}
export function useAssetTypes() {
  return useQuery(assetTypesListOptions());
}

export type UpsertAssetPayload = Partial<Omit<Asset, 'id' | 'asset_type'>> & { name: string };

export function useUpsertAsset() {
  const qc = useQueryClient();
  return useMutation<Asset, Error, { id: string | null; payload: UpsertAssetPayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<Asset>(
        id ? `/assets/${id}` : '/assets',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: (_data, _err, vars) => {
      const tasks: Promise<unknown>[] = [qc.invalidateQueries({ queryKey: assetKeys.lists() })];
      if (vars.id) tasks.push(qc.invalidateQueries({ queryKey: assetKeys.detail(vars.id) }));
      return Promise.all(tasks);
    },
  });
}

export function useDeleteAsset() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/assets/${id}`, { method: 'DELETE' }),
    onSettled: (_data, _err, id) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: assetKeys.lists() }),
        qc.removeQueries({ queryKey: assetKeys.detail(id) }),
      ]),
  });
}
