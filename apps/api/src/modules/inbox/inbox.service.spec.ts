/**
 * InboxService — unit tests.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step E.
 *
 * Coverage (7+ scenarios):
 *   1. resolveActor: bridges auth_uid → users.id within tenant.
 *   2. resolveActor: throws inbox.not_resolvable when no users row.
 *   3. list: happy path returns mapped items + nextCursor=null when no overflow.
 *   4. list: cursor pagination — limit+1 fetch peels off the trailing row,
 *           emits nextCursor for the LAST returned row.
 *   5. list: cursor decode round-trip — second call uses the cursor's
 *           (created_at, id) pair as the .or() predicate.
 *   6. list: garbage cursor degrades cleanly (returns first page, no throw).
 *   7. list: summary rendering for booking.approval_required.
 *   8. count: parallel HEAD COUNT for unread + total.
 *   9. markRead: idempotent — re-marking returns the existing read_at.
 *  10. markRead: 404 on foreign-tenant id (cross-tenant defense).
 *  11. markAllRead: returns count of newly-marked rows.
 *  12. tenant isolation: querying tenant A returns nothing for tenant B's user.
 *
 * The supabase admin client is faked with a configurable in-memory store +
 * a chainable query-builder factory. Filters are applied in JS so the
 * .eq/.is/.or contracts the service uses are exercised end-to-end.
 *
 * Citations:
 *   - apps/api/src/modules/booking-bundles/bundle-visibility.service.spec.ts:32-74
 *       canonical chained-builder mock pattern.
 *   - apps/api/src/modules/tenant/meal-windows.service.spec.ts:38-41
 *       TenantContext.run() wrapper pattern for service-layer specs.
 */

import { TenantContext } from '../../common/tenant-context';
import { AppError } from '../../common/errors';
import { InboxService } from './inbox.service';
import type { BookingApprovalRequiredPayload } from '../notifications/templates/types';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUTH_UID_A = 'auauauau-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ── Fake supabase store ───────────────────────────────────────────────────

interface InboxRow {
  id: string;
  tenant_id: string;
  user_id: string;
  event_kind: string;
  payload: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

interface UserRow {
  id: string;
  tenant_id: string;
  auth_uid: string;
}

interface FakeStore {
  inbox: InboxRow[];
  users: UserRow[];
}

interface Predicate {
  apply: (rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
}

function eqPred(col: string, val: unknown): Predicate {
  return {
    apply: (rows) => rows.filter((r) => r[col] === val),
  };
}

function isNullPred(col: string): Predicate {
  return {
    apply: (rows) => rows.filter((r) => r[col] === null || r[col] === undefined),
  };
}

/**
 * Cursor .or() predicate — mirrors the service's
 *   `created_at.lt.X,and(created_at.eq.X,id.lt.Y)`
 * Filters rows where `(created_at, id) < (X, Y)` lexicographically.
 */
function tupleLtPred(createdAt: string, id: string): Predicate {
  return {
    apply: (rows) => rows.filter((r) => {
      const rc = String(r.created_at);
      const ri = String(r.id);
      if (rc < createdAt) return true;
      if (rc === createdAt && ri < id) return true;
      return false;
    }),
  };
}

interface BuilderState {
  table: string;
  predicates: Predicate[];
  ordering: Array<{ col: string; ascending: boolean }>;
  limitN: number | null;
  isCountHead: boolean;
  selectCols: string;
}

function buildSupabaseFake(store: FakeStore) {
  const builderFor = (table: string) => {
    const state: BuilderState = {
      table,
      predicates: [],
      ordering: [],
      limitN: null,
      isCountHead: false,
      selectCols: '*',
    };

    const tableRows = (): Array<Record<string, unknown>> => {
      if (state.table === 'inbox_notifications') {
        return store.inbox as unknown as Array<Record<string, unknown>>;
      }
      if (state.table === 'users') {
        return store.users as unknown as Array<Record<string, unknown>>;
      }
      throw new Error(`unexpected table in fake: ${state.table}`);
    };

    const applyPredicates = (rows: Array<Record<string, unknown>>) =>
      state.predicates.reduce((acc, p) => p.apply(acc), rows);

    const applyOrdering = (rows: Array<Record<string, unknown>>) => {
      if (state.ordering.length === 0) return rows;
      const out = [...rows];
      out.sort((a, b) => {
        for (const o of state.ordering) {
          const av = a[o.col];
          const bv = b[o.col];
          if (av === bv) continue;
          if (av == null) return o.ascending ? -1 : 1;
          if (bv == null) return o.ascending ? 1 : -1;
          if (av < bv) return o.ascending ? -1 : 1;
          if (av > bv) return o.ascending ? 1 : -1;
        }
        return 0;
      });
      return out;
    };

    const resolve = () => {
      const filtered = applyPredicates(tableRows());
      if (state.isCountHead) {
        return Promise.resolve({ data: null, error: null, count: filtered.length });
      }
      const ordered = applyOrdering(filtered);
      const sliced = state.limitN === null ? ordered : ordered.slice(0, state.limitN);
      return Promise.resolve({ data: sliced, error: null });
    };

    const builder: Record<string, unknown> = {};
    // Promise-like surface — the head-count chain
    //   .from(...).select('id', { count: 'exact', head: true }).eq().eq().is()
    // ends without an explicit `.then()` and is `await`-ed directly. Make
    // every chained method return a builder that's also thenable (resolves
    // to the head-count payload).
    const thenable = (onFulfilled: (v: unknown) => unknown) => resolve().then(onFulfilled);
    Object.assign(builder, {
      then: thenable,
      select: (cols: string, opts?: { count?: 'exact'; head?: boolean }) => {
        state.selectCols = cols;
        if (opts?.head) state.isCountHead = true;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        state.predicates.push(eqPred(col, val));
        return builder;
      },
      is: (col: string, val: null) => {
        if (val === null) state.predicates.push(isNullPred(col));
        return builder;
      },
      or: (clause: string) => {
        // Match the exact .or() pattern the service emits:
        //   created_at.lt.<X>,and(created_at.eq.<X>,id.lt.<Y>)
        const match = clause.match(
          /^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/,
        );
        if (match && match[1] === match[2]) {
          state.predicates.push(tupleLtPred(match[1], match[3]));
        }
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        state.ordering.push({ col, ascending: opts?.ascending ?? true });
        return builder;
      },
      limit: (n: number) => {
        state.limitN = n;
        // Don't resolve eagerly — supabase-js stays a thenable builder until
        // awaited so post-`.limit()` methods like `.or()` still chain. The
        // builder's `then()` (defined above) handles the await.
        return builder;
      },
      maybeSingle: () => {
        const filtered = applyPredicates(tableRows());
        if (filtered.length === 0) {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: filtered[0], error: null });
      },
      // UPDATE chain: .update({...}).eq().eq().eq().is().select().maybeSingle()
      // OR .update({...}).eq().eq().is().select() — terminates with select() / maybeSingle().
      update: (patch: Record<string, unknown>) => {
        const upd: Record<string, unknown> = {};
        Object.assign(upd, {
          eq: (col: string, val: unknown) => {
            state.predicates.push(eqPred(col, val));
            return upd;
          },
          is: (col: string, val: null) => {
            if (val === null) state.predicates.push(isNullPred(col));
            return upd;
          },
          select: (_cols?: string) => {
            const sel: Record<string, unknown> = {};
            const doUpdate = () => {
              // Apply the update against the source store.
              const matched = applyPredicates(tableRows());
              const matchedIds = new Set(matched.map((r) => r.id as string));
              if (state.table === 'inbox_notifications') {
                store.inbox = store.inbox.map((row) =>
                  matchedIds.has(row.id)
                    ? { ...row, ...patch }
                    : row,
                );
              }
              return matched.map((r) => ({ ...r, ...patch }));
            };
            Object.assign(sel, {
              maybeSingle: () => {
                const updated = doUpdate();
                if (updated.length === 0) {
                  return Promise.resolve({ data: null, error: null });
                }
                return Promise.resolve({ data: updated[0], error: null });
              },
              then: (onFulfilled: (v: unknown) => unknown) => {
                // Allow `await select(...)` (promise-like) for the bulk path.
                const updated = doUpdate();
                return Promise.resolve({ data: updated, error: null }).then(onFulfilled);
              },
            });
            return sel;
          },
        });
        return upd;
      },
    });

    return builder;
  };

  return {
    admin: {
      from: jest.fn((table: string) => builderFor(table)),
    },
  } as unknown as ConstructorParameters<typeof InboxService>[0];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makePayload(over: Partial<BookingApprovalRequiredPayload> = {}): BookingApprovalRequiredPayload {
  return {
    bookingId: 'b1',
    chainId: 'c1',
    bookingTitle: 'Quarterly review',
    requesterName: 'Marleen Visser',
    spaceName: 'Boardroom 4',
    startAt: '2026-05-13T09:00:00Z',
    endAt: '2026-05-13T10:30:00Z',
    approvalCtaUrl: 'https://app.example.com/desk/approvals/abc',
    ...over,
  };
}

function rowFor(over: Partial<InboxRow>): InboxRow {
  return {
    id: 'row-id',
    tenant_id: TENANT_A,
    user_id: USER_A,
    event_kind: 'booking.approval_required',
    payload: makePayload() as unknown as Record<string, unknown>,
    read_at: null,
    created_at: '2026-05-12T10:00:00.000Z',
    ...over,
  };
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return TenantContext.run(
    { id: tenantId, slug: tenantId, tier: 'standard' },
    fn,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('InboxService', () => {
  describe('resolveActor', () => {
    it('bridges auth_uid → users.id within the current tenant', async () => {
      const store: FakeStore = {
        inbox: [],
        users: [{ id: USER_A, tenant_id: TENANT_A, auth_uid: AUTH_UID_A }],
      };
      const supabase = buildSupabaseFake(store);
      const svc = new InboxService(supabase);

      const actor = await withTenant(TENANT_A, () => svc.resolveActor(AUTH_UID_A));
      expect(actor).toEqual({ tenantId: TENANT_A, userId: USER_A });
    });

    it('throws inbox.not_resolvable when bridge is missing', async () => {
      const store: FakeStore = { inbox: [], users: [] };
      const supabase = buildSupabaseFake(store);
      const svc = new InboxService(supabase);

      await expect(
        withTenant(TENANT_A, () => svc.resolveActor(AUTH_UID_A)),
      ).rejects.toMatchObject({
        code: 'auth.unauthorized',
        detail: 'inbox.not_resolvable',
      } as Partial<AppError>);
    });

    it('does NOT bridge a foreign-tenant users row', async () => {
      // Same auth_uid but assigned to TENANT_B → must NOT resolve under TENANT_A.
      const store: FakeStore = {
        inbox: [],
        users: [{ id: USER_B, tenant_id: TENANT_B, auth_uid: AUTH_UID_A }],
      };
      const supabase = buildSupabaseFake(store);
      const svc = new InboxService(supabase);

      await expect(
        withTenant(TENANT_A, () => svc.resolveActor(AUTH_UID_A)),
      ).rejects.toMatchObject({ code: 'auth.unauthorized' });
    });
  });

  describe('list', () => {
    it('returns mapped items with nextCursor=null when no overflow', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', created_at: '2026-05-12T10:00:00.000Z' }),
        rowFor({ id: 'r2', created_at: '2026-05-12T09:00:00.000Z' }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.list({ tenantId: TENANT_A, userId: USER_A }, { limit: 20 }),
      );

      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe('r1'); // newest first
      expect(result.items[1].id).toBe('r2');
      expect(result.nextCursor).toBeNull();
      // Camel-cased on the wire shape.
      expect(result.items[0].eventKind).toBe('booking.approval_required');
      expect(result.items[0].readAt).toBeNull();
      expect(result.items[0].createdAt).toBe('2026-05-12T10:00:00.000Z');
    });

    it('emits a nextCursor when there is more than one page', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', created_at: '2026-05-12T11:00:00.000Z' }),
        rowFor({ id: 'r2', created_at: '2026-05-12T10:00:00.000Z' }),
        rowFor({ id: 'r3', created_at: '2026-05-12T09:00:00.000Z' }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.list({ tenantId: TENANT_A, userId: USER_A }, { limit: 2 }),
      );

      expect(result.items.map((i) => i.id)).toEqual(['r1', 'r2']);
      expect(result.nextCursor).not.toBeNull();
      // Cursor encodes the LAST returned row's (created_at, id) tuple.
      const decoded = Buffer.from(result.nextCursor!, 'base64url').toString('utf8');
      expect(decoded).toBe('2026-05-12T10:00:00.000Z:r2');
    });

    it('decodes a cursor and returns rows older than the (created_at, id) tuple', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', created_at: '2026-05-12T11:00:00.000Z' }),
        rowFor({ id: 'r2', created_at: '2026-05-12T10:00:00.000Z' }),
        rowFor({ id: 'r3', created_at: '2026-05-12T09:00:00.000Z' }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const cursor = Buffer.from('2026-05-12T10:00:00.000Z:r2', 'utf8').toString('base64url');
      const result = await withTenant(TENANT_A, () =>
        svc.list({ tenantId: TENANT_A, userId: USER_A }, { limit: 20, cursor }),
      );

      expect(result.items.map((i) => i.id)).toEqual(['r3']);
      expect(result.nextCursor).toBeNull();
    });

    it('treats a malformed cursor as no cursor (returns first page, no throw)', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', created_at: '2026-05-12T11:00:00.000Z' }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.list({ tenantId: TENANT_A, userId: USER_A }, { cursor: 'not-base64-junk!' }),
      );
      expect(result.items.map((i) => i.id)).toEqual(['r1']);
    });

    it('renders a friendly summary for booking.approval_required', async () => {
      const rows: InboxRow[] = [
        rowFor({
          id: 'r1',
          payload: makePayload({
            bookingTitle: 'Sprint planning',
            spaceName: 'Atrium A',
            startAt: '2026-05-13T09:00:00Z',
          }) as unknown as Record<string, unknown>,
        }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.list({ tenantId: TENANT_A, userId: USER_A }, {}),
      );
      expect(result.items[0].summary).toBe(
        'Approval needed: Sprint planning at Atrium A on 2026-05-13T09:00:00Z',
      );
    });

    it('falls back to the eventKind for unknown summaries', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', event_kind: 'booking.cancelled', payload: {} }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.list({ tenantId: TENANT_A, userId: USER_A }, {}),
      );
      expect(result.items[0].summary).toBe('booking.cancelled');
    });
  });

  describe('count', () => {
    it('returns separate unread + total counts', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', read_at: null }),
        rowFor({ id: 'r2', read_at: null }),
        rowFor({ id: 'r3', read_at: '2026-05-12T08:00:00.000Z' }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.count({ tenantId: TENANT_A, userId: USER_A }),
      );
      expect(result).toEqual({ unread: 2, total: 3 });
    });

    it('returns 0/0 when there are no rows', async () => {
      const store: FakeStore = { inbox: [], users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.count({ tenantId: TENANT_A, userId: USER_A }),
      );
      expect(result).toEqual({ unread: 0, total: 0 });
    });
  });

  describe('markRead', () => {
    it('flips read_at on first call', async () => {
      const rows: InboxRow[] = [rowFor({ id: 'r1', read_at: null })];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.markRead({ tenantId: TENANT_A, userId: USER_A }, 'r1'),
      );
      expect(result.id).toBe('r1');
      expect(result.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(store.inbox[0].read_at).toBe(result.readAt);
    });

    it('is idempotent — re-marking returns the existing read_at unchanged', async () => {
      const existingTs = '2026-05-12T08:30:00.000Z';
      const rows: InboxRow[] = [rowFor({ id: 'r1', read_at: existingTs })];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.markRead({ tenantId: TENANT_A, userId: USER_A }, 'r1'),
      );
      expect(result).toEqual({ id: 'r1', readAt: existingTs });
      // Underlying store untouched.
      expect(store.inbox[0].read_at).toBe(existingTs);
    });

    it('throws inbox_notification.not_found on a foreign-tenant id (cross-tenant defense)', async () => {
      // Row exists but belongs to TENANT_B — caller is TENANT_A.
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', tenant_id: TENANT_B, user_id: USER_B }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      await expect(
        withTenant(TENANT_A, () =>
          svc.markRead({ tenantId: TENANT_A, userId: USER_A }, 'r1'),
        ),
      ).rejects.toMatchObject({
        code: 'inbox_notification.not_found',
        status: 404,
      });
      // Source row untouched (read_at still null).
      expect(store.inbox[0].read_at).toBeNull();
    });

    it('throws inbox_notification.not_found on a foreign-user id (same tenant, different user)', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', tenant_id: TENANT_A, user_id: USER_B }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      await expect(
        withTenant(TENANT_A, () =>
          svc.markRead({ tenantId: TENANT_A, userId: USER_A }, 'r1'),
        ),
      ).rejects.toMatchObject({ code: 'inbox_notification.not_found' });
    });
  });

  describe('markAllRead', () => {
    it('marks every unread row for the actor and returns the count', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', read_at: null }),
        rowFor({ id: 'r2', read_at: null }),
        rowFor({ id: 'r3', read_at: '2026-05-12T08:00:00.000Z' }), // already read — not counted
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.markAllRead({ tenantId: TENANT_A, userId: USER_A }),
      );
      expect(result).toEqual({ marked: 2 });
      // Source-of-truth: all rows now have read_at populated.
      expect(store.inbox.every((r) => r.read_at !== null)).toBe(true);
    });

    it('returns marked=0 when every row is already read (idempotent)', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', read_at: '2026-05-12T08:00:00.000Z' }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.markAllRead({ tenantId: TENANT_A, userId: USER_A }),
      );
      expect(result).toEqual({ marked: 0 });
    });

    it('does NOT touch other tenants rows', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', tenant_id: TENANT_A, user_id: USER_A, read_at: null }),
        rowFor({ id: 'r2', tenant_id: TENANT_B, user_id: USER_B, read_at: null }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.markAllRead({ tenantId: TENANT_A, userId: USER_A }),
      );
      expect(result).toEqual({ marked: 1 });

      const tenantBRow = store.inbox.find((r) => r.id === 'r2');
      expect(tenantBRow?.read_at).toBeNull();
    });
  });

  describe('tenant isolation (cross-cutting)', () => {
    it('list returns nothing for tenant A when all rows belong to tenant B', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', tenant_id: TENANT_B, user_id: USER_B }),
        rowFor({ id: 'r2', tenant_id: TENANT_B, user_id: USER_B }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.list({ tenantId: TENANT_A, userId: USER_A }, {}),
      );
      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });

    it('count returns 0/0 for tenant A when all rows belong to tenant B', async () => {
      const rows: InboxRow[] = [
        rowFor({ id: 'r1', tenant_id: TENANT_B, user_id: USER_B, read_at: null }),
      ];
      const store: FakeStore = { inbox: rows, users: [] };
      const svc = new InboxService(buildSupabaseFake(store));

      const result = await withTenant(TENANT_A, () =>
        svc.count({ tenantId: TENANT_A, userId: USER_A }),
      );
      expect(result).toEqual({ unread: 0, total: 0 });
    });
  });
});
