import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface NotificationTemplate {
  id: string;
  key: string;
  display_name: string;
  channel: 'email' | 'sms' | 'in_app' | 'slack';
  subject_template?: string | null;
  body_template: string;
  active: boolean;
}

export const notificationKeys = {
  all: ['notification-templates'] as const,
  lists: () => [...notificationKeys.all, 'list'] as const,
  list: () => [...notificationKeys.lists(), {}] as const,
  details: () => [...notificationKeys.all, 'detail'] as const,
  detail: (id: string) => [...notificationKeys.details(), id] as const,
} as const;

export function notificationTemplatesListOptions() {
  return queryOptions({
    queryKey: notificationKeys.list(),
    queryFn: ({ signal }) => apiFetch<NotificationTemplate[]>('/notification-templates', { signal }),
    staleTime: 5 * 60_000,
  });
}
export function useNotificationTemplates() {
  return useQuery(notificationTemplatesListOptions());
}

export type UpsertNotificationPayload = Partial<Omit<NotificationTemplate, 'id'>> & { key: string };

export function useUpsertNotificationTemplate() {
  const qc = useQueryClient();
  return useMutation<NotificationTemplate, Error, { id: string | null; payload: UpsertNotificationPayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<NotificationTemplate>(
        id ? `/notification-templates/${id}` : '/notification-templates',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}

export function useDeleteNotificationTemplate() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/notification-templates/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all }),
  });
}
