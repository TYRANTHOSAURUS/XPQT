import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface PortalAppearance {
  location_id: string;
  hero_image_url: string | null;
  welcome_headline: string | null;
  supporting_line: string | null;
  greeting_enabled: boolean;
}

export interface UpdatePortalAppearancePayload {
  location_id: string;
  welcome_headline?: string | null;
  supporting_line?: string | null;
  greeting_enabled?: boolean;
}

export const portalAppearanceKeys = {
  all: ['portal-appearance'] as const,
  lists: () => [...portalAppearanceKeys.all, 'list'] as const,
  list: () => [...portalAppearanceKeys.lists()] as const,
  detail: (locationId: string) => [...portalAppearanceKeys.all, 'detail', locationId] as const,
} as const;

export function portalAppearanceListOptions() {
  return queryOptions({
    queryKey: portalAppearanceKeys.list(),
    queryFn: ({ signal }) => apiFetch<PortalAppearance[]>('/admin/portal-appearance/list', { signal }),
    staleTime: 60_000,
  });
}

export function usePortalAppearanceList() {
  return useQuery(portalAppearanceListOptions());
}

export function useUpdatePortalAppearance() {
  const qc = useQueryClient();
  return useMutation<PortalAppearance, Error, UpdatePortalAppearancePayload>({
    mutationFn: (payload) =>
      apiFetch<PortalAppearance>('/admin/portal-appearance', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: portalAppearanceKeys.all }),
  });
}

export function useUploadPortalHero() {
  const qc = useQueryClient();
  return useMutation<PortalAppearance, Error, { location_id: string; file: File }>({
    mutationFn: async ({ location_id, file }) => {
      const form = new FormData();
      form.append('file', file);
      return apiFetch<PortalAppearance>(
        `/admin/portal-appearance/hero?location_id=${encodeURIComponent(location_id)}`,
        { method: 'POST', body: form },
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: portalAppearanceKeys.all }),
  });
}

export function useRemovePortalHero() {
  const qc = useQueryClient();
  return useMutation<PortalAppearance | null, Error, string>({
    mutationFn: (location_id) =>
      apiFetch(
        `/admin/portal-appearance/hero?location_id=${encodeURIComponent(location_id)}`,
        { method: 'DELETE' },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: portalAppearanceKeys.all }),
  });
}
