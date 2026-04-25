import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface Announcement {
  id: string;
  location_id: string;
  title: string;
  body: string;
  published_at: string;
  expires_at: string | null;
  created_by: string | null;
}

export interface PublishAnnouncementPayload {
  location_id: string;
  title: string;
  body: string;
  expires_at?: string | null;
}

export const portalAnnouncementKeys = {
  all: ['portal-announcements'] as const,
  list: () => [...portalAnnouncementKeys.all, 'list'] as const,
} as const;

export function portalAnnouncementsListOptions() {
  return queryOptions({
    queryKey: portalAnnouncementKeys.list(),
    queryFn: ({ signal }) => apiFetch<Announcement[]>('/admin/portal-announcements', { signal }),
    staleTime: 30_000,
  });
}

export function usePortalAnnouncements() {
  return useQuery(portalAnnouncementsListOptions());
}

export function usePublishAnnouncement() {
  const qc = useQueryClient();
  return useMutation<Announcement, Error, PublishAnnouncementPayload>({
    mutationFn: (payload) =>
      apiFetch<Announcement>('/admin/portal-announcements', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: portalAnnouncementKeys.all }),
  });
}

export function useUnpublishAnnouncement() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) => apiFetch(`/admin/portal-announcements/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: portalAnnouncementKeys.all }),
  });
}
