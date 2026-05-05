import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../api';

/**
 * B.0.E.2 — apiFetch contract: NO auto-stamp of `X-Client-Request-Id`.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §3.3 + §15.7
 *       (v8.1 — supersedes v7's auto-stamp).
 *
 * The id MUST be generated at the **mutation-attempt scope** (caller's
 * `mutate({ requestId, ... })` shape captured in closure) and threaded
 * through `apiFetch` as an explicit header. `apiFetch` only forwards the
 * header if the caller passes one — no auto-stamping at fetch scope,
 * because React Query retries call mutationFn → apiFetch again, which
 * would generate a fresh UUID per retry and defeat idempotency.
 */

vi.mock('../supabase', () => ({
  supabase: {
    auth: {
      // Default: no session → no Authorization header. Specific tests
      // override per-call when they need to exercise auth threading.
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  },
}));

describe('apiFetch — X-Client-Request-Id contract (B.0.E.2)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function lastRequestHeaders(): Record<string, string> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    return (init?.headers as Record<string, string>) ?? {};
  }

  it('does NOT add X-Client-Request-Id when caller does not provide one (POST)', async () => {
    await apiFetch('/test', { method: 'POST', body: JSON.stringify({}) });
    const headers = lastRequestHeaders();
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      'x-client-request-id',
    );
  });

  it('does NOT add X-Client-Request-Id on GET (no auto-stamp anywhere)', async () => {
    await apiFetch('/test');
    const headers = lastRequestHeaders();
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      'x-client-request-id',
    );
  });

  it('preserves caller-supplied X-Client-Request-Id verbatim (POST)', async () => {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await apiFetch('/test', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'X-Client-Request-Id': id },
    });
    const headers = lastRequestHeaders();
    expect(headers['X-Client-Request-Id']).toBe(id);
  });

  it('preserves caller-supplied X-Client-Request-Id verbatim (PATCH)', async () => {
    const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await apiFetch('/test/123', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'x' }),
      headers: { 'X-Client-Request-Id': id },
    });
    const headers = lastRequestHeaders();
    expect(headers['X-Client-Request-Id']).toBe(id);
  });

  it('does not normalise/lowercase a caller-supplied id (verbatim only)', async () => {
    const id = 'AAAAAAAA-aaaa-4AAA-8AAA-aaaaaaaaaaaa';
    await apiFetch('/test', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'X-Client-Request-Id': id },
    });
    const headers = lastRequestHeaders();
    // apiFetch passes the id through unchanged; the backend middleware
    // is the layer that lower-cases for storage on req.clientRequestId.
    expect(headers['X-Client-Request-Id']).toBe(id);
  });

  it('does not generate a fresh id across two successive calls (no auto-stamp)', async () => {
    await apiFetch('/test', { method: 'POST', body: JSON.stringify({}) });
    await apiFetch('/test', { method: 'POST', body: JSON.stringify({}) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = (init.headers as Record<string, string>) ?? {};
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
        'x-client-request-id',
      );
    }
  });
});
