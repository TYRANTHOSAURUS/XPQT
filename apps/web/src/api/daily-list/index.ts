import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * Vendor daily-list (Dutch "daglijst") API client.
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md.
 *
 * Module surface (drives the /admin/vendors/:id Fulfillment tab):
 *   - useDailyListHistory(vendorId)
 *   - useDailyListPreview()                — POST mutation; returns assembled payload
 *   - useDailyListRegenerate()             — POST mutation; mints v_n+1 + sends
 *   - useDailyListResend(daglijstId)       — POST mutation; force=true resend
 *   - useDailyListDownload()               — GET; mints short admin-TTL signed URL
 *
 * Backend conventions:
 *   - History list strips the full payload (admins only need totals).
 *   - Preview returns the same payload shape the PDF renderer consumes.
 *   - Regenerate auto-sends after generating; ListCancelled comes back
 *     as a 400 with `{ code: 'list_cancelled' }`.
 */

export type ServiceType = 'catering' | 'av_equipment' | 'supplies' | string;

export interface DailyListHistoryItem {
  id: string;
  vendor_id: string;
  building_id: string | null;
  service_type: ServiceType;
  list_date: string;
  version: number;
  email_status:
    | 'never_sent' | 'queued' | 'sending' | 'sent'
    | 'delivered' | 'bounced' | 'failed' | null;
  recipient_email: string | null;
  generated_at: string;
  sent_at: string | null;
  email_error: string | null;
  pdf_storage_path: string | null;
  total_lines: number | null;
  total_quantity: number | null;
  building_name: string | null;
  generated_by_user_id: string | null;
}

/**
 * Same shape as the backend DailyListPayload. Only the bits the admin
 * preview surface renders are typed strictly; the rest stays passthrough.
 */
export interface DailyListPayload {
  tenant_id: string;
  vendor: { id: string; name: string; language?: string | null };
  building: { id: string; name: string } | null;
  service_type: ServiceType;
  list_date: string;
  assembled_at: string;
  total_lines: number;
  total_quantity: number;
  lines: Array<{
    line_id: string;
    order_id: string;
    catalog_item_id: string;
    catalog_item_name: string;
    quantity: number;
    dietary_notes: string | null;
    requester_notes: string | null;
    delivery_time: string | null;
    delivery_window: { start: string | null; end: string | null } | null;
    delivery_location_name: string | null;
    requester_first_name: string | null;
    headcount: number | null;
  }>;
}

export interface DailyListSendOutcome {
  status: 'sent' | 'already_sent' | 'skipped_in_flight' | 'lease_revoked';
  row: DailyListHistoryItem & { payload?: DailyListPayload };
  providerMessageId?: string;
}

export const dailyListKeys = {
  all: ['daily-list'] as const,
  byVendor: (vendorId: string) => [...dailyListKeys.all, 'vendor', vendorId] as const,
  history: (vendorId: string, since?: string) =>
    [...dailyListKeys.byVendor(vendorId), 'history', since ?? null] as const,
  download: (vendorId: string, daglijstId: string) =>
    [...dailyListKeys.byVendor(vendorId), 'download', daglijstId] as const,
} as const;

// =====================================================================
// History
// =====================================================================

export function dailyListHistoryOptions(vendorId: string | undefined, since?: string) {
  return queryOptions({
    queryKey: dailyListKeys.history(vendorId ?? '', since),
    queryFn: ({ signal }) => {
      const qs = since ? `?since=${encodeURIComponent(since)}` : '';
      return apiFetch<DailyListHistoryItem[]>(
        `/admin/vendors/${vendorId}/daily-list/history${qs}`,
        { signal },
      );
    },
    enabled: Boolean(vendorId),
    /* History updates whenever a new version sends. 30s stale keeps the
       admin tab fresh without hammering the endpoint. */
    staleTime: 30_000,
  });
}

export function useDailyListHistory(vendorId: string | undefined, since?: string) {
  return useQuery(dailyListHistoryOptions(vendorId, since));
}

// =====================================================================
// Preview / Regenerate / Resend
// =====================================================================

export interface PreviewArgs {
  vendorId: string;
  listDate: string;          // YYYY-MM-DD
  buildingId?: string | null;
  serviceType: ServiceType;
}

export function useDailyListPreview() {
  return useMutation({
    mutationFn: async (args: PreviewArgs): Promise<DailyListPayload> =>
      apiFetch<DailyListPayload>(
        `/admin/vendors/${args.vendorId}/daily-list/preview`,
        {
          method: 'POST',
          body: JSON.stringify({
            listDate: args.listDate,
            buildingId: args.buildingId ?? null,
            serviceType: args.serviceType,
          }),
        },
      ),
  });
}

export function useDailyListRegenerate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: PreviewArgs): Promise<{ row: DailyListHistoryItem; send: DailyListSendOutcome }> =>
      apiFetch(
        `/admin/vendors/${args.vendorId}/daily-list/regenerate`,
        {
          method: 'POST',
          body: JSON.stringify({
            listDate: args.listDate,
            buildingId: args.buildingId ?? null,
            serviceType: args.serviceType,
          }),
        },
      ),
    onSuccess: (_, args) => {
      qc.invalidateQueries({ queryKey: dailyListKeys.byVendor(args.vendorId) });
    },
  });
}

export interface ResendArgs {
  vendorId: string;
  daglijstId: string;
  force?: boolean;
}

export function useDailyListResend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: ResendArgs): Promise<DailyListSendOutcome> =>
      apiFetch(
        `/admin/vendors/${args.vendorId}/daily-list/${args.daglijstId}/send`,
        {
          method: 'POST',
          body: JSON.stringify({ force: args.force ?? true }),
        },
      ),
    onSuccess: (_, args) => {
      qc.invalidateQueries({ queryKey: dailyListKeys.byVendor(args.vendorId) });
    },
  });
}

// =====================================================================
// Download
// =====================================================================

export interface DownloadResult {
  url: string;
  expiresAt: string;
}

export function dailyListDownloadOptions(
  vendorId: string | undefined,
  daglijstId: string | undefined,
) {
  return queryOptions({
    queryKey: dailyListKeys.download(vendorId ?? '', daglijstId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<DownloadResult>(
        `/admin/vendors/${vendorId}/daily-list/${daglijstId}/download`,
        { signal },
      ),
    enabled: Boolean(vendorId && daglijstId),
    /* Signed URL TTL is 1h; refresh ~half before expiry. */
    staleTime: 30 * 60_000,
    gcTime:    60 * 60_000,
  });
}

export function useDailyListDownload(
  vendorId: string | undefined,
  daglijstId: string | undefined,
) {
  return useQuery(dailyListDownloadOptions(vendorId, daglijstId));
}
