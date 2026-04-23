import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface RequestTypeRuleCondition {
  path: string;
  operator: 'equals' | 'in' | 'exists';
  value?: unknown;
}

export interface RequestTypeRule {
  when: RequestTypeRuleCondition[];
  request_type_id: string;
}

export interface RequesterLookup {
  path: string;
  strategy: 'exact_email' | 'none';
}

export interface Webhook {
  id: string;
  tenant_id: string;
  name: string;
  workflow_id: string | null;
  active: boolean;
  ticket_defaults: Record<string, unknown>;
  field_mapping: Record<string, string>;
  default_request_type_id: string | null;
  request_type_rules: RequestTypeRule[];
  default_requester_person_id: string | null;
  requester_lookup: RequesterLookup | null;
  allowed_cidrs: string[];
  rate_limit_per_minute: number;
  last_used_at: string | null;
  created_at: string;
}

export interface WebhookUpsertBody {
  name: string;
  workflow_id?: string | null;
  active?: boolean;
  ticket_defaults?: Record<string, unknown>;
  field_mapping?: Record<string, string>;
  default_request_type_id?: string | null;
  request_type_rules?: RequestTypeRule[];
  default_requester_person_id?: string | null;
  requester_lookup?: RequesterLookup | null;
  allowed_cidrs?: string[];
  rate_limit_per_minute?: number;
}

export interface ValidationProblem {
  severity: 'error' | 'warning' | 'info';
  field?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: ValidationProblem[];
}

export interface WebhookCreateResponse {
  webhook: Webhook;
  api_key: string;
  validation: ValidationResult;
}

export interface WebhookUpdateResponse {
  webhook: Webhook;
  validation: ValidationResult;
}

export interface WebhookEvent {
  id: string;
  webhook_id: string;
  received_at: string;
  external_system: string | null;
  external_id: string | null;
  status: 'accepted' | 'deduplicated' | 'rejected' | 'error';
  ticket_id: string | null;
  workflow_instance_id: string | null;
  http_status: number;
  error_message: string | null;
  payload: Record<string, unknown>;
  headers: Record<string, unknown> | null;
}

export interface WebhookTestResult {
  ok: boolean;
  dto?: Record<string, unknown>;
  error?: string;
}

export const webhookKeys = {
  all: ['webhooks'] as const,
  lists: () => [...webhookKeys.all, 'list'] as const,
  list: () => [...webhookKeys.lists(), {}] as const,
  events: (id: string) => [...webhookKeys.all, 'events', id] as const,
} as const;

export function webhooksListOptions() {
  return queryOptions({
    queryKey: webhookKeys.list(),
    queryFn: ({ signal }) => apiFetch<Webhook[]>('/workflow-webhooks', { signal }),
    staleTime: 60_000,
  });
}

export function useWebhooks() {
  return useQuery(webhooksListOptions());
}

export function useCreateWebhook() {
  const qc = useQueryClient();
  return useMutation<WebhookCreateResponse, Error, WebhookUpsertBody>({
    mutationFn: (body) =>
      apiFetch<WebhookCreateResponse>('/workflow-webhooks', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: webhookKeys.lists() }),
  });
}

export function useUpdateWebhook(id: string) {
  const qc = useQueryClient();
  return useMutation<WebhookUpdateResponse, Error, Partial<WebhookUpsertBody>>({
    mutationFn: (body) =>
      apiFetch<WebhookUpdateResponse>(`/workflow-webhooks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: webhookKeys.lists() }),
  });
}

export function useDeleteWebhook() {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (id) => apiFetch<{ ok: true }>(`/workflow-webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: webhookKeys.lists() }),
  });
}

export function useRotateWebhookApiKey() {
  return useMutation<{ api_key: string }, Error, string>({
    mutationFn: (id) =>
      apiFetch<{ api_key: string }>(`/workflow-webhooks/${id}/api-key/rotate`, { method: 'POST' }),
  });
}

export function useTestWebhook() {
  return useMutation<WebhookTestResult, Error, { id: string; payload: Record<string, unknown> }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<WebhookTestResult>(`/workflow-webhooks/${id}/test`, {
        method: 'POST',
        body: JSON.stringify({ payload }),
      }),
  });
}

export function webhookEventsOptions(id: string) {
  return queryOptions({
    queryKey: webhookKeys.events(id),
    queryFn: ({ signal }) =>
      apiFetch<WebhookEvent[]>(`/workflow-webhooks/${id}/events?limit=50`, { signal }),
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}

export function useWebhookEvents(id: string) {
  return useQuery(webhookEventsOptions(id));
}
