import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

// ====================================================================
// Types — mirror apps/api/src/modules/privacy-compliance/*.ts
// ====================================================================

export interface RetentionSetting {
  id: string;
  tenant_id: string;
  data_category: string;
  retention_days: number;
  cap_retention_days: number | null;
  lia_text: string | null;
  lia_text_updated_at: string | null;
  lia_text_updated_by_user_id: string | null;
  legal_basis: 'legitimate_interest' | 'consent' | 'legal_obligation' | 'contract' | 'none';
  created_at: string;
  updated_at: string;
}

export interface UpdateRetentionBody {
  retention_days?: number;
  lia_text?: string | null;
  reason: string;
}

export interface DataSubjectRequest {
  id: string;
  tenant_id: string;
  request_type: 'access' | 'erasure' | 'rectification' | 'portability' | 'objection';
  subject_person_id: string;
  initiated_by_user_id: string | null;
  initiated_at: string;
  completed_at: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'denied' | 'partial';
  decision_reason: string | null;
  scope_breakdown: Record<string, unknown> | null;
  output_storage_path: string | null;
  output_url_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccessRequestResult {
  request: DataSubjectRequest;
  download_url?: string;
  download_expires_at?: string;
  breakdown?: Record<string, { count: number; description: string }>;
}

export interface ErasureRequestResult {
  request: DataSubjectRequest;
  breakdown?: Record<string, { anonymized: number; hardDeleted: number; description: string }>;
  total_processed?: number;
  status?: 'completed' | 'partial';
}

export interface LegalHold {
  id: string;
  tenant_id: string;
  hold_type: 'person' | 'category' | 'tenant_wide';
  subject_person_id: string | null;
  data_category: string | null;
  reason: string;
  initiated_by_user_id: string;
  initiated_at: string;
  expires_at: string | null;
  released_at: string | null;
  released_by_user_id: string | null;
}

export interface PlaceHoldBody {
  hold_type: 'person' | 'category' | 'tenant_wide';
  subject_person_id?: string;
  data_category?: string;
  reason: string;
  expires_at?: string;
}

// ====================================================================
// Query keys
// ====================================================================

export const gdprKeys = {
  all: ['gdpr'] as const,
  retention: () => [...gdprKeys.all, 'retention'] as const,
  retentionList: () => [...gdprKeys.retention(), 'list'] as const,
  retentionDetail: (category: string) => [...gdprKeys.retention(), 'detail', category] as const,
  requests: () => [...gdprKeys.all, 'requests'] as const,
  requestsList: (filter: { subject_person_id?: string; status?: string }) =>
    [...gdprKeys.requests(), 'list', filter] as const,
  requestDetail: (id: string) => [...gdprKeys.requests(), 'detail', id] as const,
  legalHolds: () => [...gdprKeys.all, 'legal-holds'] as const,
  legalHoldsList: (includeReleased: boolean) =>
    [...gdprKeys.legalHolds(), 'list', { includeReleased }] as const,
} as const;

// ====================================================================
// Retention
// ====================================================================

export function retentionListOptions() {
  return queryOptions({
    queryKey: gdprKeys.retentionList(),
    queryFn: ({ signal }) => apiFetch<RetentionSetting[]>('/admin/gdpr/retention', { signal }),
    staleTime: 60_000,
  });
}

export function useRetentionList() {
  return useQuery(retentionListOptions());
}

export function useUpdateRetention(category: string) {
  const qc = useQueryClient();
  return useMutation<RetentionSetting, Error, UpdateRetentionBody>({
    mutationFn: (body) =>
      apiFetch<RetentionSetting>(`/admin/gdpr/retention/${category}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gdprKeys.retention() }),
  });
}

// ====================================================================
// Data subject requests
// ====================================================================

export function dsrListOptions(filter: { subject_person_id?: string; status?: string } = {}) {
  const params = new URLSearchParams();
  if (filter.subject_person_id) params.set('subject_person_id', filter.subject_person_id);
  if (filter.status) params.set('status', filter.status);
  const qs = params.toString();
  // `qs` is derived from `filter`, which is already in the queryKey via
  // gdprKeys.requestsList. Adding it would duplicate the same data in a
  // different shape and break stability.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return queryOptions({
    queryKey: gdprKeys.requestsList(filter),
    queryFn: ({ signal }) =>
      apiFetch<DataSubjectRequest[]>(`/admin/gdpr/requests${qs ? `?${qs}` : ''}`, { signal }),
    staleTime: 30_000,
  });
}

export function useDsrList(filter: { subject_person_id?: string; status?: string } = {}) {
  return useQuery(dsrListOptions(filter));
}

export function useInitiateAccessRequest() {
  const qc = useQueryClient();
  return useMutation<AccessRequestResult, Error, { personId: string; fulfill?: boolean }>({
    mutationFn: ({ personId, fulfill }) =>
      apiFetch<AccessRequestResult>(`/admin/gdpr/persons/${personId}/access`, {
        method: 'POST',
        body: JSON.stringify({ fulfill: fulfill ?? true }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gdprKeys.requests() }),
  });
}

export function useInitiateErasureRequest() {
  const qc = useQueryClient();
  return useMutation<
    ErasureRequestResult,
    Error,
    { personId: string; reason: string; hardDelete?: boolean; fulfill?: boolean }
  >({
    mutationFn: ({ personId, reason, hardDelete, fulfill }) =>
      apiFetch<ErasureRequestResult>(`/admin/gdpr/persons/${personId}/erase`, {
        method: 'POST',
        body: JSON.stringify({
          reason,
          hard_delete: hardDelete ?? false,
          fulfill: fulfill ?? true,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gdprKeys.requests() }),
  });
}

// ====================================================================
// Legal holds
// ====================================================================

export function legalHoldsOptions(includeReleased = false) {
  return queryOptions({
    queryKey: gdprKeys.legalHoldsList(includeReleased),
    queryFn: ({ signal }) =>
      apiFetch<LegalHold[]>(
        `/admin/gdpr/legal-holds${includeReleased ? '?include_released=true' : ''}`,
        { signal },
      ),
    staleTime: 30_000,
  });
}

export function useLegalHolds(includeReleased = false) {
  return useQuery(legalHoldsOptions(includeReleased));
}

export function usePlaceLegalHold() {
  const qc = useQueryClient();
  return useMutation<LegalHold, Error, PlaceHoldBody>({
    mutationFn: (body) =>
      apiFetch<LegalHold>('/admin/gdpr/legal-holds', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gdprKeys.legalHolds() }),
  });
}

export function useReleaseLegalHold() {
  const qc = useQueryClient();
  return useMutation<LegalHold, Error, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) =>
      apiFetch<LegalHold>(`/admin/gdpr/legal-holds/${id}/release`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gdprKeys.legalHolds() }),
  });
}

// ====================================================================
// Helpers
// ====================================================================

export function describeLegalBasis(basis: RetentionSetting['legal_basis']): string {
  switch (basis) {
    case 'legitimate_interest': return 'Legitimate interest';
    case 'consent':              return 'Consent';
    case 'legal_obligation':     return 'Legal obligation';
    case 'contract':             return 'Contractual necessity';
    case 'none':                 return 'Not warehoused';
  }
}

export function describeCategory(category: string): string {
  // Mirrors the descriptions on the backend adapters.
  const map: Record<string, string> = {
    visitor_records:                'Visitor check-in records',
    visitor_photos_ids:             'Visitor photos & ID scans',
    cctv_footage:                   'CCTV recordings',
    person_preferences:             'Personal preferences & settings',
    person_ref_in_past_records:     'Person identity in retained records',
    past_bookings:                  'Historical reservations (accounting)',
    past_orders:                    'Historical orders (accounting)',
    audit_events:                   'Compliance audit log',
    personal_data_access_logs:      'Read-side audit log',
    calendar_event_content:         'Calendar event content',
    calendar_attendees_snapshot:    'Calendar attendee snapshots',
    daily_list_pdfs:                'Daily-list PDF exports',
    email_notifications:            'Outbound notification log',
    webhook_notifications:          'Inbound webhook event log',
    ghost_persons:                  'Auto-created Outlook attendees',
    vendor_user_data:               'Vendor portal accounts',
  };
  return map[category] ?? category;
}
