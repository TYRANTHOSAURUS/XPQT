import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { serviceRuleKeys } from './keys';
import type { ServiceRule, ServiceRuleTemplate } from './types';

export function serviceRuleListOptions(filters: { active?: boolean } = {}) {
  return queryOptions({
    queryKey: serviceRuleKeys.list(filters),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (filters.active != null) params.set('active', String(filters.active));
      const qs = params.toString();
      return apiFetch<ServiceRule[]>(
        `/admin/booking-services/rules${qs ? `?${qs}` : ''}`,
        { signal },
      );
    },
    staleTime: 30_000,
  });
}

export function useServiceRules(filters: { active?: boolean } = {}) {
  return useQuery(serviceRuleListOptions(filters));
}

export function serviceRuleDetailOptions(id: string) {
  return queryOptions({
    queryKey: serviceRuleKeys.detail(id),
    queryFn: ({ signal }) =>
      apiFetch<ServiceRule>(`/admin/booking-services/rules/${id}`, { signal }),
    staleTime: 30_000,
    enabled: Boolean(id),
  });
}

export function useServiceRule(id: string) {
  return useQuery(serviceRuleDetailOptions(id));
}

export function serviceRuleTemplatesOptions() {
  return queryOptions({
    queryKey: serviceRuleKeys.templates(),
    queryFn: ({ signal }) =>
      apiFetch<ServiceRuleTemplate[]>('/admin/booking-services/rule-templates', { signal }),
    staleTime: 5 * 60_000, // templates rarely change
  });
}

export function useServiceRuleTemplates() {
  return useQuery(serviceRuleTemplatesOptions());
}
