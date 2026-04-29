import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { serviceRuleKeys } from './keys';
import type { ServiceRule, ServiceRuleEffect, ServiceRuleTargetKind } from './types';

export interface ServiceRuleUpsertPayload {
  name: string;
  description?: string | null;
  target_kind: ServiceRuleTargetKind;
  target_id?: string | null;
  applies_when?: Record<string, unknown>;
  effect: ServiceRuleEffect;
  approval_config?: Record<string, unknown> | null;
  denial_message?: string | null;
  priority?: number;
  active?: boolean;
  template_id?: string | null;
  requires_internal_setup?: boolean;
  internal_setup_lead_time_minutes?: number | null;
}

export function useCreateServiceRule() {
  const qc = useQueryClient();
  return useMutation<ServiceRule, Error, ServiceRuleUpsertPayload>({
    mutationFn: (payload) =>
      apiFetch<ServiceRule>('/admin/booking-services/rules', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: serviceRuleKeys.lists() });
    },
  });
}

export function useUpdateServiceRule() {
  const qc = useQueryClient();
  return useMutation<ServiceRule, Error, { id: string; patch: Partial<ServiceRuleUpsertPayload> }>({
    mutationFn: ({ id, patch }) =>
      apiFetch<ServiceRule>(`/admin/booking-services/rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: serviceRuleKeys.detail(id) });
      qc.invalidateQueries({ queryKey: serviceRuleKeys.lists() });
    },
  });
}

/**
 * Sprint 1B — template-driven create. Admin picks a template, fills
 * params; backend substitutes `$.<paramKey>` placeholders, applies
 * effect_default + approval_config_template, inserts a fresh row.
 */
export interface CreateServiceRuleFromTemplatePayload {
  template_key: string;
  params: Record<string, unknown>;
  target_kind: ServiceRuleTargetKind;
  target_id?: string | null;
  name?: string;
  description?: string | null;
  priority?: number;
  active?: boolean;
}

export function useCreateServiceRuleFromTemplate() {
  const qc = useQueryClient();
  return useMutation<ServiceRule, Error, CreateServiceRuleFromTemplatePayload>({
    mutationFn: (payload) =>
      apiFetch<ServiceRule>('/admin/booking-services/rules/from-template', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: serviceRuleKeys.lists() });
    },
  });
}

export function useDeleteServiceRule() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (id) =>
      apiFetch<{ id: string }>(`/admin/booking-services/rules/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: serviceRuleKeys.detail(id) });
      qc.invalidateQueries({ queryKey: serviceRuleKeys.lists() });
    },
  });
}
