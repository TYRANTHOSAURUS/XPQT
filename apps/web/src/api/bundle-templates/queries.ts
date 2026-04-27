import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { bundleTemplateKeys } from './keys';
import type { BundleTemplate } from './types';

export function bundleTemplateListOptions(filters: { active?: boolean } = {}) {
  return queryOptions({
    queryKey: bundleTemplateKeys.list(filters),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (filters.active != null) params.set('active', String(filters.active));
      const qs = params.toString();
      return apiFetch<BundleTemplate[]>(
        `/admin/bundle-templates${qs ? `?${qs}` : ''}`,
        { signal },
      );
    },
    staleTime: 60_000,
  });
}

export function useBundleTemplates(filters: { active?: boolean } = {}) {
  return useQuery(bundleTemplateListOptions(filters));
}

export function bundleTemplateDetailOptions(id: string) {
  return queryOptions({
    queryKey: bundleTemplateKeys.detail(id),
    queryFn: ({ signal }) =>
      apiFetch<BundleTemplate>(`/admin/bundle-templates/${id}`, { signal }),
    staleTime: 30_000,
    enabled: Boolean(id),
  });
}

export function useBundleTemplate(id: string) {
  return useQuery(bundleTemplateDetailOptions(id));
}
