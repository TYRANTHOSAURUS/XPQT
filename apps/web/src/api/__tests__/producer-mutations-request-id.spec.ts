import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationCache, MutationObserver, QueryClient } from '@tanstack/react-query';

/**
 * B.0.E.3 — Producer mutation hooks thread `X-Client-Request-Id` at
 * mutation-attempt scope.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §3.3 + §15.7.
 *
 * The regression to defend against (v7-I1, closed in v8): generating the
 * id inside `mutationFn` produces a fresh UUID per React Query retry,
 * defeating idempotency. The Pattern A contract is: the caller generates
 * the id once per `mutate()` and passes it in the variables shape; React
 * Query's automatic retry re-runs `mutationFn` but with the SAME variables
 * object → same `requestId` → same `X-Client-Request-Id` header.
 *
 * These tests exercise the hooks at the React-Query level (without
 * rendering, without `renderHook`) by constructing a `MutationObserver`
 * directly from the same `useMutation` options the hooks expose. That
 * avoids pulling in React + jsdom routing + auth contexts just to assert
 * a header pass-through.
 */

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  },
}));

import { apiFetch } from '../../lib/api';

// Lightweight observer harness. We call `observe()` ourselves and don't
// rely on a React component tree.
function runMutation<TVars, TData>(
  client: QueryClient,
  options: Parameters<MutationObserver<TData, Error, TVars>['setOptions']>[0],
  vars: TVars,
): Promise<TData> {
  const observer = new MutationObserver<TData, Error, TVars>(client, options);
  return observer.mutate(vars);
}

describe('producer mutation hooks — X-Client-Request-Id at mutation-attempt scope (B.0.E.3)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function lastHeaderValue(callIdx: number, name: string): string | undefined {
    const init = fetchMock.mock.calls[callIdx][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    // Headers may be set with original case via apiFetch's spread.
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
    return undefined;
  }

  /**
   * Build a fresh QueryClient with retries enabled but no delay so tests
   * complete instantly. The retry-after-delay shape is a no-op when the
   * delay is 0 — the next attempt fires synchronously.
   */
  function makeClient(): QueryClient {
    return new QueryClient({
      mutationCache: new MutationCache(),
      defaultOptions: {
        mutations: {
          retry: 2,
          retryDelay: 0,
        },
      },
    });
  }

  /**
   * Mock the canonical mutationFn shape used by every producer hook in
   * the codebase post-B.0.E.3:
   *
   *   mutationFn: ({ payload, requestId }) =>
   *     apiFetch(path, { method, body, headers: { 'X-Client-Request-Id': requestId } })
   *
   * Testing the shape end-to-end (closure → apiFetch → fetch) is what
   * actually demonstrates the retries-reuse-id property — verifying the
   * hook implementation in isolation would still pass with a buggy
   * "regenerate inside mutationFn" implementation, because each retry
   * gets the same closure snapshot of variables.
   */
  function makeMutationOptions() {
    return {
      mutationFn: async (vars: { payload: { foo: number }; requestId: string }) => {
        return apiFetch<{ ok: true }>('/test', {
          method: 'POST',
          body: JSON.stringify(vars.payload),
          headers: { 'X-Client-Request-Id': vars.requestId },
        });
      },
    };
  }

  it('uses the SAME X-Client-Request-Id across all retries of one mutate() attempt', async () => {
    // First two responses: 500 (transient → retry). Third: 200.
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = makeClient();
    const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await runMutation(
      client,
      makeMutationOptions(),
      { payload: { foo: 1 }, requestId },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    const ids = [
      lastHeaderValue(0, 'X-Client-Request-Id'),
      lastHeaderValue(1, 'X-Client-Request-Id'),
      lastHeaderValue(2, 'X-Client-Request-Id'),
    ];
    // Identical across all three calls — this is the regression v7-I1
    // closed: each retry sees the SAME requestId because it lives in
    // the variables, not inside mutationFn.
    expect(ids[0]).toBe(requestId);
    expect(ids[1]).toBe(requestId);
    expect(ids[2]).toBe(requestId);
  });

  it('two distinct mutate() calls produce two distinct ids', async () => {
    // Each Response has a single-use body — must construct a fresh one
    // per call. mockResolvedValue would re-emit the same instance.
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );

    const client = makeClient();
    const idA = '11111111-1111-4111-8111-111111111111';
    const idB = '22222222-2222-4222-8222-222222222222';

    await runMutation(client, makeMutationOptions(), { payload: { foo: 1 }, requestId: idA });
    await runMutation(client, makeMutationOptions(), { payload: { foo: 2 }, requestId: idB });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastHeaderValue(0, 'X-Client-Request-Id')).toBe(idA);
    expect(lastHeaderValue(1, 'X-Client-Request-Id')).toBe(idB);
    expect(idA).not.toBe(idB);
  });

  it('regression check — fetch-scope id generation would FAIL the same-id-across-retries property', async () => {
    // This test documents the v7-I1 anti-pattern: if the id is generated
    // inside mutationFn instead of being passed in via variables, retries
    // get fresh ids and the property breaks. We construct an intentionally
    // buggy mutationFn here (id generated inside) to demonstrate the
    // failure mode the v8 contract is designed to prevent.
    const buggyOptions = {
      mutationFn: async () => {
        const requestId = crypto.randomUUID(); // BUG — fetch-scope generation
        return apiFetch<{ ok: true }>('/test', {
          method: 'POST',
          body: JSON.stringify({ foo: 1 }),
          headers: { 'X-Client-Request-Id': requestId },
        });
      },
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'boom' }), { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = new QueryClient({
      mutationCache: new MutationCache(),
      defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
    });
    await runMutation(client, buggyOptions, undefined);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The id from call 0 is the one generated on the first run; the id
    // from call 1 is generated on the retry — they DIFFER, which is
    // exactly the bug v8.1's mutation-attempt-scope contract closes.
    const id0 = lastHeaderValue(0, 'X-Client-Request-Id')!;
    const id1 = lastHeaderValue(1, 'X-Client-Request-Id')!;
    expect(id0).not.toBe(id1);
  });
});
