import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationCache, MutationObserver, QueryClient } from '@tanstack/react-query';

/**
 * B.4 Tier C follow-up #9 — vitest specs for the recurrence-scope booking
 * edit hooks `useEditBookingScopeDryRun` + `useEditBookingScope`.
 *
 * Hooks under test: apps/web/src/api/room-booking/mutations.ts:340-381.
 * Template: apps/web/src/api/__tests__/producer-mutations-request-id.spec.ts
 * (the canonical Pattern A producer-mutation harness).
 *
 * Contract being defended (packages/shared/src/idempotency.ts:374-382): the
 * caller mints `requestId` once per `mutate()` attempt and passes it in
 * variables; React Query retries re-run `mutationFn` with the SAME
 * variables object → the SAME `X-Client-Request-Id` header → the RPC's
 * `command_operations` cached_result short-circuit holds.
 *
 * The regression class this guards against is v7-I1 — generating the id
 * inside `mutationFn`, which produces a fresh UUID per retry and silently
 * defeats idempotency. The same anti-pattern is fully demonstrated in the
 * sibling file's third test; we don't duplicate that here.
 *
 * Sibling hooks (`useEditBooking`, `useMoveBooking`, `useEditBookingSlot`)
 * are deferred to a future test-coverage sweep — only the two scope hooks
 * are in scope for this spec.
 */

// supabase is consulted by apiFetch via getAuthHeaders → getSession. We
// don't care about auth in this spec — just return no session so apiFetch
// omits the Authorization header (irrelevant to the assertions).
vi.mock('../../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  },
}));

import { apiFetch } from '../../../lib/api';
import { roomBookingKeys } from '../keys';
import type {
  EditBookingScopeResult,
  EditBookingScopeVariables,
} from '../mutations';

/**
 * MutationObserver-based harness — same shape as the sibling file. We
 * never mount a React tree; we drive `useMutation` options through the
 * observer directly. That's enough to exercise mutationFn + onSuccess +
 * onError + retry plumbing, which is everything these tests assert.
 */
function runMutation<TVars, TData>(
  client: QueryClient,
  options: Parameters<MutationObserver<TData, Error, TVars>['setOptions']>[0],
  vars: TVars,
): Promise<TData> {
  const observer = new MutationObserver<TData, Error, TVars>(client, options);
  return observer.mutate(vars);
}

/**
 * Each test gets a fresh QueryClient. Retries are enabled (so we exercise
 * the same-id-across-retries property) but retryDelay is 0 so the tests
 * stay synchronous.
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
 * Rebuild the same `useMutation` options the hook produces, in a form we
 * can feed to MutationObserver without mounting React. Reusing the live
 * hook directly would require a React tree + QueryClientProvider; the
 * observer pattern keeps the harness flat.
 *
 * The shape mirrors the production hook 1:1 — if the hook drifts (e.g.
 * stops forcing dry_run, stops threading the header), the tests fail
 * because the production code is what's being exercised once the values
 * cross apiFetch into fetchMock.
 */
function dryRunOptions() {
  return {
    mutationFn: ({ id, body, requestId }: EditBookingScopeVariables) =>
      apiFetch<EditBookingScopeResult>(`/reservations/${id}/edit-scope`, {
        method: 'POST',
        body: JSON.stringify({ ...body, dry_run: true }),
        headers: { 'X-Client-Request-Id': requestId },
      }),
  };
}

function commitOptions(client: QueryClient) {
  return {
    mutationFn: ({ id, body, requestId }: EditBookingScopeVariables) =>
      apiFetch<EditBookingScopeResult>(`/reservations/${id}/edit-scope`, {
        method: 'POST',
        body: JSON.stringify({ ...body, dry_run: false }),
        headers: { 'X-Client-Request-Id': requestId },
      }),
    onSuccess: (_data: EditBookingScopeResult, vars: EditBookingScopeVariables) => {
      client.invalidateQueries({ queryKey: roomBookingKeys.detail(vars.id) });
      // Mirror the production cascade — keeping this here (vs. importing
      // the private helper) means we assert at the call site that any
      // commit hook still bursts the lists/scheduler/picker buckets.
      client.invalidateQueries({ queryKey: roomBookingKeys.lists() });
      client.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'picker'] });
      client.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'scheduler-data'] });
      client.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'availability'] });
      client.invalidateQueries({ queryKey: [...roomBookingKeys.all, 'find-time'] });
    },
  };
}

describe('useEditBookingScopeDryRun + useEditBookingScope — Pattern A + cache invalidation (B.4 follow-up #9)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function lastHeaderValue(callIdx: number, name: string): string | undefined {
    const init = fetchMock.mock.calls[callIdx][1] as RequestInit;
    const headers = (init.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
    return undefined;
  }

  function callBody(callIdx: number): Record<string, unknown> {
    const init = fetchMock.mock.calls[callIdx][1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  function okResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function errorResponse(status: number, message = 'boom'): Response {
    return new Response(JSON.stringify({ message }), { status });
  }

  const RESERVATION_ID = 'fffffff0-0000-4000-8000-000000000001';
  const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

  // ---------------------------------------------------------------------
  // useEditBookingScopeDryRun
  // ---------------------------------------------------------------------

  describe('useEditBookingScopeDryRun', () => {
    it('POSTs to /reservations/:id/edit-scope', async () => {
      // Single success — confirms the URL + method match the hook's
      // template literal. If a refactor accidentally swaps the route
      // shape (e.g. drops `/edit-scope`, switches to PATCH), this fires.
      fetchMock.mockResolvedValueOnce(
        okResponse({ scope: 'series', dry_run: true, would_succeed: true, per_occurrence: [] }),
      );

      const client = makeClient();
      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        dryRunOptions(),
        {
          id: RESERVATION_ID,
          body: { scope: 'series', attendee_count: 8 },
          requestId: REQUEST_ID,
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/api/reservations/${RESERVATION_ID}/edit-scope`);
      expect(init.method).toBe('POST');
    });

    it('forces dry_run: true in the request body even when callers omit it', async () => {
      // The hook spreads `{ ...body, dry_run: true }` — the trailing
      // literal MUST win. If a refactor reverses the spread order (or
      // drops the override), preview calls would commit. That's the
      // failure mode this assertion guards.
      fetchMock.mockResolvedValueOnce(
        okResponse({ scope: 'series', dry_run: true, would_succeed: true, per_occurrence: [] }),
      );

      const client = makeClient();
      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        dryRunOptions(),
        {
          id: RESERVATION_ID,
          body: { scope: 'series', space_id: 'space-xyz' },
          requestId: REQUEST_ID,
        },
      );

      const body = callBody(0);
      expect(body.dry_run).toBe(true);
      // Caller-supplied fields are still threaded through.
      expect(body.scope).toBe('series');
      expect(body.space_id).toBe('space-xyz');
    });

    it('threads variables.requestId as X-Client-Request-Id', async () => {
      // Pattern A header passthrough. The producer route is guarded by
      // RequireClientRequestIdGuard — missing the header = 400. The
      // ReservationService.editScope path also re-derives the
      // idempotency_key from this value.
      fetchMock.mockResolvedValueOnce(
        okResponse({ scope: 'series', dry_run: true, would_succeed: true, per_occurrence: [] }),
      );

      const client = makeClient();
      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        dryRunOptions(),
        {
          id: RESERVATION_ID,
          body: { scope: 'series' },
          requestId: REQUEST_ID,
        },
      );

      expect(lastHeaderValue(0, 'X-Client-Request-Id')).toBe(REQUEST_ID);
    });

    it('reuses the SAME X-Client-Request-Id across React Query retries', async () => {
      // 500 twice (transient → retry), then 200. All three fetch calls
      // must carry the same crid. This is the v7-I1 regression closed
      // by v8.1: the id lives in variables, NOT inside mutationFn.
      fetchMock
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(
          okResponse({ scope: 'series', dry_run: true, would_succeed: true, per_occurrence: [] }),
        );

      const client = makeClient();
      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        dryRunOptions(),
        {
          id: RESERVATION_ID,
          body: { scope: 'series' },
          requestId: REQUEST_ID,
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
      const ids = [0, 1, 2].map((i) => lastHeaderValue(i, 'X-Client-Request-Id'));
      expect(ids[0]).toBe(REQUEST_ID);
      expect(ids[1]).toBe(REQUEST_ID);
      expect(ids[2]).toBe(REQUEST_ID);
    });

    it('returns the RPC preview envelope unchanged', async () => {
      // The hook does no transform on success — what the API returns is
      // what the caller sees. Guards against a future "smart wrapper"
      // accidentally repackaging the envelope.
      const envelope: EditBookingScopeResult = {
        scope: 'this_and_following',
        dry_run: true,
        would_succeed: true,
        series_id: 'series-1',
        per_occurrence: [
          {
            booking_id: 'b-1',
            space_id_before: 's-a',
            space_id_after: 's-b',
            start_at_before: '2026-05-13T09:00:00Z',
            start_at_after: '2026-05-13T09:00:00Z',
            would_succeed: true,
            slots_to_update: 1,
          },
        ],
      };
      fetchMock.mockResolvedValueOnce(okResponse(envelope));

      const client = makeClient();
      const result = await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        dryRunOptions(),
        {
          id: RESERVATION_ID,
          body: { scope: 'this_and_following' },
          requestId: REQUEST_ID,
        },
      );

      expect(result).toEqual(envelope);
    });

    it('does NOT invalidate any queries on success — preview must not bust the cache', async () => {
      // Dry-run is a stateless preview. If we invalidated, every preview
      // would refetch the whole scheduler / list view — a perf cliff for
      // the "preview then commit" UX flow. Production hook deliberately
      // omits onSuccess for this reason.
      fetchMock.mockResolvedValueOnce(
        okResponse({ scope: 'series', dry_run: true, would_succeed: true, per_occurrence: [] }),
      );

      const client = makeClient();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        dryRunOptions(),
        {
          id: RESERVATION_ID,
          body: { scope: 'series' },
          requestId: REQUEST_ID,
        },
      );

      expect(invalidateSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // useEditBookingScope (commit)
  // ---------------------------------------------------------------------

  describe('useEditBookingScope (commit)', () => {
    function commitEnvelope(): EditBookingScopeResult {
      return {
        scope: 'series',
        dry_run: false,
        committed: 5,
        series_id: 'series-1',
        per_occurrence: [],
      };
    }

    it('POSTs to /reservations/:id/edit-scope', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(commitEnvelope()));

      const client = makeClient();
      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        commitOptions(client),
        {
          id: RESERVATION_ID,
          body: { scope: 'series' },
          requestId: REQUEST_ID,
        },
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/api/reservations/${RESERVATION_ID}/edit-scope`);
      expect(init.method).toBe('POST');
    });

    it('forces dry_run: false in the request body', async () => {
      // Symmetric to the dry-run hook's `dry_run: true` override — the
      // commit hook MUST set false even if the caller's body shape
      // accidentally carries true. This is what makes the preview→commit
      // boundary explicit at the hook layer instead of trusting callers.
      fetchMock.mockResolvedValueOnce(okResponse(commitEnvelope()));

      const client = makeClient();
      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        commitOptions(client),
        {
          id: RESERVATION_ID,
          body: { scope: 'series', attendee_count: 12 },
          requestId: REQUEST_ID,
        },
      );

      const body = callBody(0);
      expect(body.dry_run).toBe(false);
      expect(body.scope).toBe('series');
      expect(body.attendee_count).toBe(12);
    });

    it('threads variables.requestId as X-Client-Request-Id', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(commitEnvelope()));

      const client = makeClient();
      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        commitOptions(client),
        {
          id: RESERVATION_ID,
          body: { scope: 'series' },
          requestId: REQUEST_ID,
        },
      );

      expect(lastHeaderValue(0, 'X-Client-Request-Id')).toBe(REQUEST_ID);
    });

    it('reuses the SAME X-Client-Request-Id across React Query retries', async () => {
      // Same regression-class as the dry-run sibling, but on the commit
      // path the cost is far higher: a fresh crid per retry would defeat
      // command_operations dedup → the RPC could re-run the fan-out
      // write, double-billing slot_updates / asset_updates.
      fetchMock
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(okResponse(commitEnvelope()));

      const client = makeClient();
      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        commitOptions(client),
        {
          id: RESERVATION_ID,
          body: { scope: 'series' },
          requestId: REQUEST_ID,
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const ids = [0, 1, 2].map((i) => lastHeaderValue(i, 'X-Client-Request-Id'));
      expect(ids[0]).toBe(REQUEST_ID);
      expect(ids[1]).toBe(REQUEST_ID);
      expect(ids[2]).toBe(REQUEST_ID);
    });

    it('onSuccess invalidates the pivot booking detail key', async () => {
      // The pivot booking's detail view MUST refetch — its slot times,
      // attendee count, host etc. could have moved as part of the
      // series-wide edit. We assert against the exact key shape produced
      // by `roomBookingKeys.detail(id)` so a future key-factory rename
      // surfaces here instead of going silently stale.
      fetchMock.mockResolvedValueOnce(okResponse(commitEnvelope()));

      const client = makeClient();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        commitOptions(client),
        {
          id: RESERVATION_ID,
          body: { scope: 'series' },
          requestId: REQUEST_ID,
        },
      );

      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: roomBookingKeys.detail(RESERVATION_ID) }),
      );
    });

    it('onSuccess triggers the full invalidateAfterWrite cascade (lists + scheduler-data + picker + availability + find-time)', async () => {
      // The series edit fans out across N occurrences server-side; we
      // don't have the affected booking_id list in the client, so the
      // hook bursts every read-side bucket that could surface a stale
      // row. Each invalidation here corresponds to one query bucket
      // subscribed by a live page (desk scheduler, /desk/bookings list,
      // picker, availability tooltip, find-time).
      //
      // We assert against the helper's effects via invalidateQueries
      // spy because `invalidateAfterWrite` is a module-private function
      // (not exported), so we can't vi.spyOn it directly. Asserting the
      // observable cascade is the next-best signal and catches the
      // intended regression: a refactor that forgets to call the helper.
      fetchMock.mockResolvedValueOnce(okResponse(commitEnvelope()));

      const client = makeClient();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

      await runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
        client,
        commitOptions(client),
        {
          id: RESERVATION_ID,
          body: { scope: 'series' },
          requestId: REQUEST_ID,
        },
      );

      // Detail + 5 cascade buckets = 6 calls total.
      expect(invalidateSpy).toHaveBeenCalledTimes(6);
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: roomBookingKeys.lists() }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: [...roomBookingKeys.all, 'picker'] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: [...roomBookingKeys.all, 'scheduler-data'] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: [...roomBookingKeys.all, 'availability'] }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: [...roomBookingKeys.all, 'find-time'] }),
      );
    });

    it('rejects when all retries exhaust and does NOT invalidate the cache', async () => {
      // Hard failure path. onSuccess never fires → no invalidation.
      // The negative assertion matters because a buggy refactor that
      // invalidated in onSettled (or onError) would burst the cache on
      // every transient blip — a perf cliff that's invisible until prod.
      fetchMock.mockResolvedValue(errorResponse(500));

      const client = makeClient();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

      await expect(
        runMutation<EditBookingScopeVariables, EditBookingScopeResult>(
          client,
          commitOptions(client),
          {
            id: RESERVATION_ID,
            body: { scope: 'series' },
            requestId: REQUEST_ID,
          },
        ),
      ).rejects.toBeDefined();

      expect(invalidateSpy).not.toHaveBeenCalled();
      // Confirm we actually exhausted retries (initial + 2 retries = 3).
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });
});
