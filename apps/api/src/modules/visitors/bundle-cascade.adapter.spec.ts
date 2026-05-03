/**
 * BundleCascadeAdapter — translates BundleEventBus events into visitor-side
 * actions per spec §10.2.
 *
 * Slice 4 will wire BundleCascadeService to emit events on the bus; this
 * slice (2c) registers the subscriber and tests its branches in isolation.
 *
 * Tests use the adapter's `handle()` method directly so we don't depend
 * on Subject timing — the bus is integration-tested separately by simply
 * calling .emit() and asserting handle ran.
 */

import {
  BundleCascadeAdapter,
} from './bundle-cascade.adapter';
import {
  BundleEventBus,
  type BundleEvent,
} from '../booking-bundles/bundle-event-bus';
import { TenantContext } from '../../common/tenant-context';
import type { VisitorStatus } from './dto/transition-status.dto';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const BUNDLE_ID = '22222222-2222-4222-8222-222222222222';
const VISITOR_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_OLD = '44444444-4444-4444-8444-444444444444';
const ROOM_NEW = '55555555-5555-4555-8555-555555555555';

interface VisitorRow {
  id: string;
  tenant_id: string;
  status: VisitorStatus;
}

interface FakeOpts {
  visitorByIdAndTenant?: Record<string, VisitorRow | null>; // key: `${id}|${tenant}`
  visitorsForBundle?: Record<string, string[]>;             // bundle_id → visitor_ids
}

function makeHarness(opts: FakeOpts = {}) {
  const transitionCalls: Array<{
    visitor_id: string;
    to: VisitorStatus;
    actor: { user_id: string; person_id: string | null };
    txOpts?: Record<string, unknown>;
  }> = [];
  const sqlCalls: Array<{ sql: string; params?: unknown[] }> = [];
  const updates: Array<{ sql: string; params?: unknown[] }> = [];
  const intentInserts: Array<{
    event_type: string;
    payload: Record<string, unknown>;
    tenant_id: string;
  }> = [];

  const visitors = {
    transitionStatus: jest.fn(
      async (
        visitor_id: string,
        to: VisitorStatus,
        actor: { user_id: string; person_id: string | null },
        txOpts?: Record<string, unknown>,
      ) => {
        transitionCalls.push({ visitor_id, to, actor, txOpts });
      },
    ),
  };

  // Fake pg client used by `db.tx` for the FOR SHARE read inside the
  // adapter (full-review I6). Returns the visitor row scoped by tenant.
  const fakeClient = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.includes('select id, tenant_id, status') && trimmed.includes('for share')) {
        const id = params?.[0] as string;
        const tenant = params?.[1] as string;
        const row = opts.visitorByIdAndTenant?.[`${id}|${tenant}`] ?? null;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  const db = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.startsWith('update public.visitors')) {
        updates.push({ sql, params });
      }
      if (trimmed.startsWith('insert into public.domain_events')) {
        const tenantId = params?.[0] as string;
        const eventType = params?.[1] as string;
        const payload = JSON.parse(params?.[3] as string) as Record<string, unknown>;
        intentInserts.push({ tenant_id: tenantId, event_type: eventType, payload });
      }
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (_sql: string, _params?: unknown[]) => null),
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();
      // adapter (bundle-cascade.adapter.ts:320) selects on booking_id after
      // the canonicalization rename visitors.booking_bundle_id -> booking_id
      // (supabase/migrations/00278_retarget_sibling_tables.sql:41).
      if (trimmed.includes('booking_id = $2')) {
        const bundle = params?.[1] as string;
        return (opts.visitorsForBundle?.[bundle] ?? []).map((id) => ({ id }));
      }
      return [];
    }),
    tx: jest.fn(async <T>(fn: (c: typeof fakeClient) => Promise<T>): Promise<T> => fn(fakeClient)),
  };

  const bus = new BundleEventBus();
  const adapter = new BundleCascadeAdapter(
    db as never,
    visitors as never,
    bus as never,
  );

  return {
    adapter,
    bus,
    db,
    visitors,
    transitionCalls,
    updates,
    intentInserts,
    sqlCalls,
  };
}

describe('BundleCascadeAdapter', () => {
  beforeEach(() => {
    // No TenantContext needed; the adapter synthesizes one per event.
    jest.spyOn(TenantContext, 'currentOrNull').mockReturnValue(undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── line.moved ────────────────────────────────────────────────────────

  describe('bundle.line.moved (line_kind=visitor)', () => {
    it('updates expected_at + emits visitor email intent when status=expected', async () => {
      const { adapter, updates, intentInserts, transitionCalls } = makeHarness({
        visitorByIdAndTenant: {
          [`${VISITOR_ID}|${TENANT_ID}`]: {
            id: VISITOR_ID,
            tenant_id: TENANT_ID,
            status: 'expected',
          },
        },
      });
      const event: BundleEvent = {
        kind: 'bundle.line.moved',
        tenant_id: TENANT_ID,
        bundle_id: BUNDLE_ID,
        line_id: VISITOR_ID,
        line_kind: 'visitor',
        old_expected_at: '2026-05-01T09:00:00Z',
        new_expected_at: '2026-05-01T10:00:00Z',
        occurred_at: '2026-04-30T18:00:00Z',
      };
      await adapter.handle(event);

      expect(updates).toHaveLength(1);
      expect(updates[0]!.sql.toLowerCase()).toContain('set expected_at = $1');
      expect((updates[0]!.params as unknown[])[0]).toBe('2026-05-01T10:00:00Z');
      expect(intentInserts).toHaveLength(1);
      expect(intentInserts[0]!.event_type).toBe('visitor.cascade.moved');
      expect(intentInserts[0]!.payload.email_target).toBe('visitor');
      expect(transitionCalls).toHaveLength(0);
    });

    it('emits host_alert intent when status=arrived', async () => {
      const { adapter, updates, intentInserts } = makeHarness({
        visitorByIdAndTenant: {
          [`${VISITOR_ID}|${TENANT_ID}`]: {
            id: VISITOR_ID,
            tenant_id: TENANT_ID,
            status: 'arrived',
          },
        },
      });
      await adapter.handle({
        kind: 'bundle.line.moved',
        tenant_id: TENANT_ID,
        bundle_id: BUNDLE_ID,
        line_id: VISITOR_ID,
        line_kind: 'visitor',
        old_expected_at: null,
        new_expected_at: '2026-05-01T10:00:00Z',
        occurred_at: '2026-04-30T18:00:00Z',
      });
      expect(updates).toHaveLength(0);
      expect(intentInserts).toHaveLength(1);
      expect(intentInserts[0]!.event_type).toBe('visitor.cascade.host_alert');
      expect(intentInserts[0]!.payload.email_target).toBe('host');
    });

    it('no-ops on terminal statuses', async () => {
      for (const status of ['cancelled', 'no_show', 'checked_out', 'denied'] as VisitorStatus[]) {
        const { adapter, updates, intentInserts } = makeHarness({
          visitorByIdAndTenant: {
            [`${VISITOR_ID}|${TENANT_ID}`]: {
              id: VISITOR_ID,
              tenant_id: TENANT_ID,
              status,
            },
          },
        });
        await adapter.handle({
          kind: 'bundle.line.moved',
          tenant_id: TENANT_ID,
          bundle_id: BUNDLE_ID,
          line_id: VISITOR_ID,
          line_kind: 'visitor',
          old_expected_at: null,
          new_expected_at: '2026-05-01T10:00:00Z',
          occurred_at: '2026-04-30T18:00:00Z',
        });
        expect(updates).toHaveLength(0);
        expect(intentInserts).toHaveLength(0);
      }
    });

    it('skips non-visitor lines', async () => {
      const { adapter, sqlCalls } = makeHarness();
      await adapter.handle({
        kind: 'bundle.line.moved',
        tenant_id: TENANT_ID,
        bundle_id: BUNDLE_ID,
        line_id: 'some-other-id',
        line_kind: 'catering',
        old_expected_at: null,
        new_expected_at: '2026-05-01T10:00:00Z',
        occurred_at: '2026-04-30T18:00:00Z',
      });
      // No queryOne fired (we returned early for non-visitor kinds).
      expect(sqlCalls).toHaveLength(0);
    });
  });

  // ─── line.room_changed ──────────────────────────────────────────────────

  describe('bundle.line.room_changed', () => {
    it('updates meeting_room_id + emits visitor email intent when expected', async () => {
      const { adapter, updates, intentInserts } = makeHarness({
        visitorByIdAndTenant: {
          [`${VISITOR_ID}|${TENANT_ID}`]: {
            id: VISITOR_ID,
            tenant_id: TENANT_ID,
            status: 'expected',
          },
        },
      });
      await adapter.handle({
        kind: 'bundle.line.room_changed',
        tenant_id: TENANT_ID,
        bundle_id: BUNDLE_ID,
        line_id: VISITOR_ID,
        line_kind: 'visitor',
        old_room_id: ROOM_OLD,
        new_room_id: ROOM_NEW,
        occurred_at: '2026-04-30T18:00:00Z',
      });
      expect(updates).toHaveLength(1);
      expect(updates[0]!.sql.toLowerCase()).toContain('set meeting_room_id = $1');
      expect((updates[0]!.params as unknown[])[0]).toBe(ROOM_NEW);
      expect(intentInserts[0]!.event_type).toBe('visitor.cascade.room_changed');
      expect(intentInserts[0]!.payload.email_target).toBe('visitor');
    });

    it('emits host_alert when in_meeting', async () => {
      const { adapter, updates, intentInserts } = makeHarness({
        visitorByIdAndTenant: {
          [`${VISITOR_ID}|${TENANT_ID}`]: {
            id: VISITOR_ID,
            tenant_id: TENANT_ID,
            status: 'in_meeting',
          },
        },
      });
      await adapter.handle({
        kind: 'bundle.line.room_changed',
        tenant_id: TENANT_ID,
        bundle_id: BUNDLE_ID,
        line_id: VISITOR_ID,
        line_kind: 'visitor',
        old_room_id: ROOM_OLD,
        new_room_id: ROOM_NEW,
        occurred_at: '2026-04-30T18:00:00Z',
      });
      expect(updates).toHaveLength(0);
      expect(intentInserts[0]!.event_type).toBe('visitor.cascade.host_alert');
    });
  });

  // ─── line.cancelled ─────────────────────────────────────────────────────

  describe('bundle.line.cancelled', () => {
    it('transitions visitor to cancelled when status=expected', async () => {
      const { adapter, transitionCalls, intentInserts } = makeHarness({
        visitorByIdAndTenant: {
          [`${VISITOR_ID}|${TENANT_ID}`]: {
            id: VISITOR_ID,
            tenant_id: TENANT_ID,
            status: 'expected',
          },
        },
      });
      await adapter.handle({
        kind: 'bundle.line.cancelled',
        tenant_id: TENANT_ID,
        bundle_id: BUNDLE_ID,
        line_id: VISITOR_ID,
        line_kind: 'visitor',
        occurred_at: '2026-04-30T18:00:00Z',
      });
      expect(transitionCalls).toHaveLength(1);
      expect(transitionCalls[0]!.to).toBe('cancelled');
      expect(intentInserts[0]!.event_type).toBe('visitor.cascade.cancelled');
    });

    it('alerts host instead of cancelling when arrived', async () => {
      const { adapter, transitionCalls, intentInserts } = makeHarness({
        visitorByIdAndTenant: {
          [`${VISITOR_ID}|${TENANT_ID}`]: {
            id: VISITOR_ID,
            tenant_id: TENANT_ID,
            status: 'arrived',
          },
        },
      });
      await adapter.handle({
        kind: 'bundle.line.cancelled',
        tenant_id: TENANT_ID,
        bundle_id: BUNDLE_ID,
        line_id: VISITOR_ID,
        line_kind: 'visitor',
        occurred_at: '2026-04-30T18:00:00Z',
      });
      expect(transitionCalls).toHaveLength(0);
      expect(intentInserts[0]!.event_type).toBe('visitor.cascade.host_alert');
    });
  });

  // ─── bundle.cancelled ───────────────────────────────────────────────────

  describe('bundle.cancelled', () => {
    it('cancels each visitor linked to the bundle', async () => {
      const V1 = '11111111-1111-4111-8111-aaaaaaaaaaaa';
      const V2 = '11111111-1111-4111-8111-bbbbbbbbbbbb';
      const { adapter, transitionCalls } = makeHarness({
        visitorsForBundle: { [BUNDLE_ID]: [V1, V2] },
        visitorByIdAndTenant: {
          [`${V1}|${TENANT_ID}`]: { id: V1, tenant_id: TENANT_ID, status: 'expected' },
          [`${V2}|${TENANT_ID}`]: { id: V2, tenant_id: TENANT_ID, status: 'expected' },
        },
      });
      await adapter.handle({
        kind: 'bundle.cancelled',
        tenant_id: TENANT_ID,
        bundle_id: BUNDLE_ID,
        occurred_at: '2026-04-30T18:00:00Z',
      });
      expect(transitionCalls).toHaveLength(2);
      expect(new Set(transitionCalls.map((c) => c.visitor_id))).toEqual(new Set([V1, V2]));
      for (const call of transitionCalls) {
        expect(call.to).toBe('cancelled');
      }
    });
  });

  // ─── cross-tenant ───────────────────────────────────────────────────────

  describe('cross-tenant', () => {
    it('does not touch visitors when the event tenant has no matching row', async () => {
      const { adapter, transitionCalls, updates } = makeHarness({
        // Visitor exists in TENANT_ID; event arrives for OTHER_TENANT_ID.
        visitorByIdAndTenant: {
          [`${VISITOR_ID}|${TENANT_ID}`]: {
            id: VISITOR_ID,
            tenant_id: TENANT_ID,
            status: 'expected',
          },
        },
      });
      await adapter.handle({
        kind: 'bundle.line.cancelled',
        tenant_id: OTHER_TENANT_ID,
        bundle_id: BUNDLE_ID,
        line_id: VISITOR_ID,
        line_kind: 'visitor',
        occurred_at: '2026-04-30T18:00:00Z',
      });
      expect(transitionCalls).toHaveLength(0);
      expect(updates).toHaveLength(0);
    });
  });

  // ─── bus subscription ───────────────────────────────────────────────────

  describe('bus subscription', () => {
    it('handles events emitted on the bus', async () => {
      const { adapter, bus, transitionCalls } = makeHarness({
        visitorByIdAndTenant: {
          [`${VISITOR_ID}|${TENANT_ID}`]: {
            id: VISITOR_ID,
            tenant_id: TENANT_ID,
            status: 'expected',
          },
        },
      });
      try {
        adapter.resubscribe();
        bus.emit({
          kind: 'bundle.line.cancelled',
          tenant_id: TENANT_ID,
          bundle_id: BUNDLE_ID,
          line_id: VISITOR_ID,
          line_kind: 'visitor',
          occurred_at: '2026-04-30T18:00:00Z',
        });
        // Allow microtask queue to drain.
        await new Promise((r) => setImmediate(r));
        expect(transitionCalls).toHaveLength(1);
        expect(transitionCalls[0]!.to).toBe('cancelled');
      } finally {
        adapter.unsubscribe();
      }
    });
  });
});
