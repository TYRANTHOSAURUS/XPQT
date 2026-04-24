import { queryOptions, useQuery } from '@tanstack/react-query';
import type { ModuleMeta } from '@prequest/shared';
import { apiFetch } from '@/lib/api';

export interface PermissionCatalogResponse {
  catalog: Record<string, ModuleMeta>;
}

export interface EffectivePermissionGrant {
  assignment_id: string;
  role_id: string;
  role_name: string;
  domain_scope: string[];
  location_scope: string[];
  source: 'exact' | 'module_wildcard' | 'action_wildcard' | 'full_wildcard';
  raw_token: string;
}

export interface EffectivePermissionItem {
  key: string;
  action: string;
  label: string;
  is_override: boolean;
  grants: EffectivePermissionGrant[];
}

export interface EffectivePermissionsModule {
  module: string;
  label: string;
  permissions: EffectivePermissionItem[];
}

export interface EffectivePermissionsResponse {
  user_id: string;
  assignments: Array<{
    id: string;
    role_id?: string;
    role_name?: string;
    role_type?: string;
    domain_scope: string[];
    location_scope: string[];
    starts_at: string | null;
    ends_at: string | null;
    raw_permissions: string[];
  }>;
  modules: EffectivePermissionsModule[];
}

export const permissionKeys = {
  all: ['permissions'] as const,
  catalog: () => [...permissionKeys.all, 'catalog'] as const,
  effectiveByUser: (userId: string) =>
    [...permissionKeys.all, 'effective', userId] as const,
} as const;

export function permissionCatalogOptions() {
  return queryOptions({
    queryKey: permissionKeys.catalog(),
    queryFn: ({ signal }) =>
      apiFetch<PermissionCatalogResponse>('/permissions/catalog', { signal }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function usePermissionCatalog() {
  return useQuery(permissionCatalogOptions());
}

export function effectivePermissionsOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: permissionKeys.effectiveByUser(userId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<EffectivePermissionsResponse>(
        `/permissions/users/${userId}/effective`,
        { signal },
      ),
    enabled: Boolean(userId),
    staleTime: 30_000,
  });
}

export function useEffectivePermissions(userId: string | undefined) {
  return useQuery(effectivePermissionsOptions(userId));
}
