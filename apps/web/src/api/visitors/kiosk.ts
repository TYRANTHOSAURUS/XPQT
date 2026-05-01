/**
 * Kiosk-lite — React Query module.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8
 * Backend: apps/api/src/modules/visitors/kiosk.controller.ts
 *
 * Why this lives apart from `apps/web/src/api/visitors/index.ts`:
 *   - Different auth. Every kiosk endpoint demands a kiosk Bearer token,
 *     not the user's Supabase JWT. Reusing the global `apiFetch` would
 *     attach the wrong header (or none, on a kiosk that never logged in).
 *   - Different lifetime. The kiosk pages don't share a query cache with
 *     the rest of the app — a person who is both a host and a kiosk
 *     wouldn't open them in the same browser tab anyway, and we want the
 *     offline-queue paths to be 100% local without surprising rerenders
 *     from invalidations elsewhere.
 *
 * Pattern reference: `apps/web/src/api/visitors/reception.ts` (slice 7) for
 * the queryOptions / mutation shape.
 */

import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { readKioskToken } from '@/lib/kiosk-auth';
import { enqueueCheckin } from '@/lib/kiosk-offline-queue';

// ─── Types — mirror backend dto/kiosk.dto.ts ──────────────────────────────

export interface KioskExpectedRow {
  visitor_id: string;
  first_name: string;
  last_initial: string | null;
  company: string | null;
}

export interface KioskVisitorType {
  id: string;
  type_key: string;
  display_name: string;
  description: string | null;
}

export interface KioskHostRow {
  id: string;
  first_name: string;
  last_initial: string;
}

export interface KioskQrCheckinResult {
  visitor_id: string;
  host_first_name: string | null;
  has_reception_at_building: boolean;
}

export interface KioskNameCheckinResult {
  host_first_name: string | null;
  has_reception_at_building: boolean;
}

export interface KioskWalkupPayload {
  first_name: string;
  last_name?: string;
  email?: string;
  phone?: string;
  company?: string;
  visitor_type_id: string;
  primary_host_person_id: string;
}

// ─── Custom kiosk fetch — uses kiosk Bearer token, not user JWT ──────────

interface KioskFetchOptions extends RequestInit {
  query?: Record<string, string | undefined>;
}

async function kioskFetch<T>(
  path: string,
  options: KioskFetchOptions = {},
): Promise<T> {
  const token = readKioskToken();
  if (!token) {
    // We surface a synthetic 401 so the React Query error path treats it
    // like any other auth failure and the caller can navigate to /kiosk/setup.
    throw new ApiError({
      status: 401,
      message: 'Kiosk not provisioned',
    });
  }

  const { query, ...init } = options;
  let url = `/api${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      params.append(k, v);
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(init.headers as Record<string, string> | undefined),
  };

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    if (
      e instanceof Error &&
      (e.name === 'AbortError' || (init.signal as AbortSignal | undefined)?.aborted)
    ) {
      throw e;
    }
    throw new ApiError({
      status: 0,
      message: e instanceof Error ? e.message : 'Network error',
      isNetworkError: true,
    });
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message =
      body && typeof body === 'object' && 'message' in body &&
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `API error: ${res.status}`;
    throw new ApiError({ status: res.status, message, body });
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

// ─── Query keys ────────────────────────────────────────────────────────────

export const kioskKeys = {
  all: ['kiosk'] as const,
  expectedSearch: (q: string) => [...kioskKeys.all, 'expected', q] as const,
  visitorTypes: () => [...kioskKeys.all, 'visitor-types'] as const,
  hostSearch: (q: string) => [...kioskKeys.all, 'host-search', q] as const,
} as const;

// ─── Query options ────────────────────────────────────────────────────────

export function kioskExpectedSearchOptions(query: string) {
  const trimmed = query.trim();
  return queryOptions({
    queryKey: kioskKeys.expectedSearch(trimmed),
    queryFn: ({ signal }) =>
      kioskFetch<KioskExpectedRow[]>('/kiosk/expected/search', {
        signal,
        query: { q: trimmed },
      }),
    enabled: trimmed.length > 0,
    staleTime: 5_000,
  });
}

export function useKioskExpectedSearch(query: string) {
  return useQuery(kioskExpectedSearchOptions(query));
}

export function kioskVisitorTypesOptions() {
  return queryOptions({
    queryKey: kioskKeys.visitorTypes(),
    queryFn: ({ signal }) =>
      kioskFetch<KioskVisitorType[]>('/kiosk/visitor-types', { signal }),
    staleTime: 60_000,
  });
}

export function useKioskVisitorTypes() {
  return useQuery(kioskVisitorTypesOptions());
}

export function kioskHostSearchOptions(query: string) {
  const trimmed = query.trim();
  return queryOptions({
    queryKey: kioskKeys.hostSearch(trimmed),
    queryFn: ({ signal }) =>
      kioskFetch<KioskHostRow[]>('/kiosk/host-search', {
        signal,
        query: { q: trimmed },
      }),
    enabled: trimmed.length > 0,
    staleTime: 5_000,
  });
}

export function useKioskHostSearch(query: string) {
  return useQuery(kioskHostSearchOptions(query));
}

// ─── Mutations ─────────────────────────────────────────────────────────────

/**
 * QR check-in. The visitor scanned a QR code; we send the decoded string to
 * the backend which validates it via `validate_invitation_token`.
 *
 * Backend SQLSTATE error mapping (see `kiosk.service.ts`):
 *   - 401 "Invalid or unknown token" → unrecognized.
 *   - 403 "Token has already been used" → spent QR.
 *   - 403 "Token has expired" → expired invite.
 *
 * The kiosk page chooses copy based on `error.status` + `error.message`.
 */
export function useKioskQrCheckin() {
  return useMutation<KioskQrCheckinResult, ApiError, { token: string }>({
    mutationFn: ({ token }) =>
      kioskFetch<KioskQrCheckinResult>('/kiosk/check-in/qr', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
  });
}

/**
 * Name-typed check-in. Visitor selected an entry from the search list and
 * confirmed the host's first name. Backend verifies the host name match.
 *
 * Per spec §8.4 the visitor confirms by TAP. The backend currently expects
 * `host_first_name_confirmation` as a string — the kiosk obtains the host
 * first name from the search result's host context (held by the kiosk
 * after the user selects a row + confirms via tap), so the visitor never
 * types the host name directly. See `name-fallback.tsx` for the UI.
 */
export function useKioskNameCheckin() {
  return useMutation<
    KioskNameCheckinResult,
    ApiError,
    { visitorId: string; hostFirstNameConfirmation: string }
  >({
    mutationFn: ({ visitorId, hostFirstNameConfirmation }) =>
      kioskFetch<KioskNameCheckinResult>('/kiosk/check-in/by-name', {
        method: 'POST',
        body: JSON.stringify({
          visitor_id: visitorId,
          host_first_name_confirmation: hostFirstNameConfirmation,
        }),
      }),
  });
}

/** Walk-up at kiosk. Spec §8.5. */
export function useKioskWalkup() {
  const qc = useQueryClient();
  return useMutation<
    { visitor_id: string; status: 'arrived' },
    ApiError,
    KioskWalkupPayload
  >({
    mutationFn: (payload) =>
      kioskFetch<{ visitor_id: string; status: 'arrived' }>(
        '/kiosk/walk-up',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      ),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: kioskKeys.expectedSearch('') });
    },
  });
}

// ─── Offline-aware wrappers ────────────────────────────────────────────────

/**
 * QR check-in with offline fallback. If the network call fails (status 0
 * or a 5xx), we enqueue the payload to IndexedDB and resolve with a
 * neutral "queued" result so the UI can still show a friendly
 * confirmation. The visitor sees "Reception will be with you shortly"
 * either way (per spec §8.6).
 *
 * Tokens that the backend explicitly rejected (4xx) are NOT queued — they
 * would never succeed on retry.
 */
export async function checkInQrOrQueue(token: string): Promise<
  | { mode: 'live'; result: KioskQrCheckinResult }
  | { mode: 'queued' }
> {
  const liveToken = readKioskToken();
  if (!liveToken) throw new ApiError({ status: 401, message: 'Kiosk not provisioned' });
  try {
    const result = await kioskFetch<KioskQrCheckinResult>('/kiosk/check-in/qr', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    return { mode: 'live', result };
  } catch (err) {
    if (isOfflineError(err)) {
      await enqueueCheckin({
        kind: 'qr',
        capturedAt: new Date().toISOString(),
        payload: { token },
      });
      return { mode: 'queued' };
    }
    throw err;
  }
}

export async function walkupOrQueue(
  payload: KioskWalkupPayload,
): Promise<
  | { mode: 'live'; result: { visitor_id: string; status: 'arrived' } }
  | { mode: 'queued' }
> {
  try {
    const result = await kioskFetch<{ visitor_id: string; status: 'arrived' }>(
      '/kiosk/walk-up',
      { method: 'POST', body: JSON.stringify(payload) },
    );
    return { mode: 'live', result };
  } catch (err) {
    if (isOfflineError(err)) {
      await enqueueCheckin({
        kind: 'walkup',
        capturedAt: new Date().toISOString(),
        payload,
      });
      return { mode: 'queued' };
    }
    throw err;
  }
}

function isOfflineError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.isNetworkError() || err.status >= 500;
  }
  return err instanceof Error && err.name !== 'AbortError';
}

/** Health-check probe for `/kiosk/setup`. Uses a low-cost endpoint
 *  (`/kiosk/visitor-types`) since there is no dedicated health endpoint —
 *  if the token works on a real read, the kiosk is provisioned. */
export async function probeKioskToken(token: string): Promise<boolean> {
  try {
    const res = await fetch('/api/kiosk/visitor-types', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
