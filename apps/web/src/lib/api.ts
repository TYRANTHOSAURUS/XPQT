import { supabase } from './supabase';

const API_BASE = '/api';

/**
 * Thrown by `apiFetch` for any non-2xx response. The runtime body is
 * preserved so callers can decode validation problem details (RFC 9457),
 * 401 / 403 messages, etc. without re-issuing the request.
 *
 * Many callers do `error instanceof ApiError ? error.message : 'fallback'`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /**
   * Alias for `body`. Most call sites read `error.details` for the structured
   * error payload (e.g. picker 409 conflict alternatives). Kept as a separate
   * getter so the contract is clear at the boundary.
   */
  get details(): unknown {
    return this.body;
  }
  private readonly _isNetworkError: boolean;

  constructor(opts: {
    status: number;
    message: string;
    body?: unknown;
    isNetworkError?: boolean;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.body = opts.body;
    this._isNetworkError = opts.isNetworkError ?? false;
  }

  isNetworkError(): boolean {
    return this._isNetworkError;
  }

  isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  isServerError(): boolean {
    return this.status >= 500;
  }
}

export type QueryParam =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number>;

export interface ApiFetchOptions extends RequestInit {
  /**
   * Object encoded as a URL query string. `null` / `undefined` values are
   * dropped so callers can pass partial filter objects without manually
   * scrubbing them. Arrays are repeated (`?status=open&status=in_progress`).
   */
  query?: Record<string, QueryParam>;

  /**
   * Conditional GET / POST support. Pass an `etag` (read from a previous
   * response) to send `If-None-Match`; on a 304 reply, `apiFetch` resolves
   * with the result of `onNotModified()` instead of attempting to parse an
   * empty body.
   *
   * Example:
   * ```ts
   * apiFetch<T>('/foo', {
   *   etag: cached.etag,
   *   onNotModified: () => cached.body,
   * }).then((res) => {
   *   // res is either the new body OR the cached body
   * });
   * ```
   *
   * The `etagOut` callback receives the server's ETag from a 200 response
   * so the caller can persist it alongside the body.
   */
  etag?: string | null;
  onNotModified?: () => unknown;
  etagOut?: (etag: string | null) => void;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function buildUrl(path: string, query?: Record<string, QueryParam>): string {
  const base = `${API_BASE}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { query, etag, onNotModified, etagOut, ...init } = options;
  const authHeaders = await getAuthHeaders();
  const url = buildUrl(path, query);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (etag) headers['If-None-Match'] = etag;

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    // Aborts (React Query cancelling a stale query) bubble unchanged so the
    // query layer can recognise them.
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

  // Conditional 304 path — caller passed an ETag and the server confirmed
  // the resource is unchanged. Fall back to the cached body without
  // attempting to parse an empty response.
  if (res.status === 304 && onNotModified) {
    return onNotModified() as T;
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

  if (etagOut) etagOut(res.headers.get('ETag'));

  if (res.status === 204) return undefined as T;
  return res.json();
}
