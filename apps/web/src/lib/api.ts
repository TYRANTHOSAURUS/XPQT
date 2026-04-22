import { supabase } from './supabase';

const API_BASE = '/api';

/**
 * Thrown by `apiFetch` when the server responds with a non-2xx status, or when
 * the request fails at the network layer. Consumers discriminate on `status`
 * (never on `message` — backend copy is not part of the API contract).
 */
export class ApiError extends Error {
  public readonly name = 'ApiError';
  constructor(
    /** HTTP status, or 0 for network/parse failures before a response arrived. */
    public readonly status: number,
    /** Machine-readable backend code when provided (NestJS `error` field), otherwise null. */
    public readonly code: string | null,
    message: string,
    /** Raw error body for field-level details (e.g. zod / class-validator output). */
    public readonly details?: unknown,
  ) {
    super(message);
  }

  isClientError(): boolean { return this.status >= 400 && this.status < 500; }
  isServerError(): boolean { return this.status >= 500; }
  isNetworkError(): boolean { return this.status === 0; }
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface ApiFetchOptions extends RequestInit {
  /**
   * Query string params. `null` and `undefined` values are omitted. Arrays are
   * repeated (`foo=1&foo=2`). Pass primitives — everything is coerced to string.
   */
  query?: Record<string, string | number | boolean | null | undefined | Array<string | number>>;
}

function buildQueryString(query: ApiFetchOptions['query']): string {
  if (!query) return '';
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
  return qs ? `?${qs}` : '';
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { query, ...init } = options;
  const authHeaders = await getAuthHeaders();
  const isFormData = typeof FormData !== 'undefined' && init.body instanceof FormData;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${buildQueryString(query)}`, {
      ...init,
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...authHeaders,
        ...init.headers,
      },
    });
  } catch (err) {
    // AbortError — propagate as-is so React Query's cancellation semantics work.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    const message = err instanceof Error ? err.message : 'Network error';
    throw new ApiError(0, null, message);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null) as
      | { message?: string | string[]; error?: string; code?: string; details?: unknown }
      | null;
    const message = Array.isArray(body?.message)
      ? body!.message.join(', ')
      : body?.message || body?.error || `Request failed with status ${res.status}`;
    const code = body?.code ?? body?.error ?? null;
    throw new ApiError(res.status, code, message, body?.details ?? body);
  }

  // 204 No Content, or empty-body success. Cast empty object to T — caller typed it.
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}
