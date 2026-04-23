import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export type ThresholdTimerScope = 'response' | 'resolution' | 'both';
export type ThresholdAction = 'notify' | 'escalate';
export type ThresholdTargetType = 'user' | 'team' | 'manager_of_requester';

export interface EscalationThreshold {
  at_percent: number;
  timer_type: ThresholdTimerScope;
  action: ThresholdAction;
  target_type: ThresholdTargetType;
  target_id: string | null;
}

export interface SlaPolicy {
  id: string;
  name: string;
  response_time_minutes: number | null;
  resolution_time_minutes: number | null;
  business_hours_calendar_id: string | null;
  pause_on_waiting_reasons: string[] | null;
  escalation_thresholds: EscalationThreshold[] | null;
  active: boolean;
}

export interface SlaPolicyUpsertBody {
  name?: string;
  response_time_minutes?: number | null;
  resolution_time_minutes?: number | null;
  business_hours_calendar_id?: string | null;
  pause_on_waiting_reasons?: string[];
  escalation_thresholds?: EscalationThreshold[];
  active?: boolean;
}

export interface BusinessHoursCalendar {
  id: string;
  name: string;
  time_zone: string;
}

export const slaPolicyKeys = {
  all: ['sla-policies'] as const,
  lists: () => [...slaPolicyKeys.all, 'list'] as const,
  list: () => [...slaPolicyKeys.lists(), {}] as const,
  details: () => [...slaPolicyKeys.all, 'detail'] as const,
  detail: (id: string) => [...slaPolicyKeys.details(), id] as const,
  calendars: () => ['business-hours', 'list'] as const,
} as const;

export function slaPoliciesListOptions() {
  return queryOptions({
    queryKey: slaPolicyKeys.list(),
    queryFn: ({ signal }) => apiFetch<SlaPolicy[]>('/sla-policies', { signal }),
    staleTime: 60_000,
  });
}

export function useSlaPolicies() {
  return useQuery(slaPoliciesListOptions());
}

export function businessHoursListOptions() {
  return queryOptions({
    queryKey: slaPolicyKeys.calendars(),
    queryFn: ({ signal }) => apiFetch<BusinessHoursCalendar[]>('/business-hours', { signal }),
    staleTime: 5 * 60_000,
  });
}

export function useBusinessHoursCalendars() {
  return useQuery(businessHoursListOptions());
}

export function useCreateSlaPolicy() {
  const qc = useQueryClient();
  return useMutation<SlaPolicy, Error, SlaPolicyUpsertBody>({
    mutationFn: (body) =>
      apiFetch<SlaPolicy>('/sla-policies', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: slaPolicyKeys.lists() }),
  });
}

export function useUpdateSlaPolicy(id: string) {
  const qc = useQueryClient();
  return useMutation<SlaPolicy, Error, SlaPolicyUpsertBody>({
    mutationFn: (body) =>
      apiFetch<SlaPolicy>(`/sla-policies/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: slaPolicyKeys.lists() }),
  });
}
