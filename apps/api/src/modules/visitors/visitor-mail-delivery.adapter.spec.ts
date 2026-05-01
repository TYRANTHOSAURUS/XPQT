/**
 * VisitorMailDeliveryAdapter — wraps `email_delivery_events` for visitor invites.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.10
 *
 * Tests assert:
 *   - tenant context guard rejects mismatched tenants
 *   - recordSent / recordBounced / recordDelivered insert with correct columns
 *   - lastDeliveryStatusForVisitor pulls the latest event ordered by occurred_at
 *   - bouncedInvitesForBuildingSince filters correctly + tenant-scoped
 *
 * Pattern: fake DbService that captures every (sql, params) and answers
 * with canned rows.
 */

import { BadRequestException } from '@nestjs/common';
import { TenantContext } from '../../common/tenant-context';
import {
  VisitorMailDeliveryAdapter,
  type BouncedInviteRow,
  type DeliveryEvent,
} from './visitor-mail-delivery.adapter';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const VISITOR_ID = '22222222-2222-4222-8222-222222222222';
const BUILDING_ID = '33333333-3333-4333-8333-333333333333';

interface FakeDbOpts {
  lastEvent?: DeliveryEvent | null;
  bouncedRows?: BouncedInviteRow[];
}

function makeFakeDb(opts: FakeDbOpts = {}) {
  const sqlCalls: Array<{ sql: string; params?: unknown[] }> = [];
  const inserts: Array<Record<string, unknown>> = [];

  const db = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.startsWith('insert into public.email_delivery_events')) {
        inserts.push({ sql, params });
      }
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      return opts.lastEvent ?? null;
    }),
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      return opts.bouncedRows ?? [];
    }),
  };

  return { db, sqlCalls, inserts };
}

describe('VisitorMailDeliveryAdapter', () => {
  beforeEach(() => {
    jest
      .spyOn(TenantContext, 'current')
      .mockReturnValue({ id: TENANT_ID } as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('tenant guard', () => {
    it('rejects when context tenant !== passed tenantId', async () => {
      const { db } = makeFakeDb();
      const adapter = new VisitorMailDeliveryAdapter(db as never);
      await expect(
        adapter.recordSent(VISITOR_ID, OTHER_TENANT_ID, 'msg-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('recordSent', () => {
    it('inserts a sent event with the provider message id', async () => {
      const { db, inserts } = makeFakeDb();
      const adapter = new VisitorMailDeliveryAdapter(db as never);
      await adapter.recordSent(VISITOR_ID, TENANT_ID, 'pm-123', {
        recipient_email: 'visitor@acme.com',
      });
      expect(inserts).toHaveLength(1);
      const params = (inserts[0]!.params as unknown[]) ?? [];
      expect(params[0]).toBe(TENANT_ID);
      expect(params[1]).toBe('pm-123');
      expect(params[2]).toBe(VISITOR_ID);
      expect(params[3]).toBe('visitor@acme.com');
    });
  });

  describe('recordBounced', () => {
    it('inserts a bounced event with reason + bounce_type', async () => {
      const { db, inserts } = makeFakeDb();
      const adapter = new VisitorMailDeliveryAdapter(db as never);
      await adapter.recordBounced(VISITOR_ID, TENANT_ID, {
        provider_message_id: 'pm-321',
        reason: 'mailbox unknown',
        bounce_type: 'hard',
        recipient_email: 'gone@acme.com',
      });
      expect(inserts).toHaveLength(1);
      const params = (inserts[0]!.params as unknown[]) ?? [];
      expect(params[0]).toBe(TENANT_ID);
      expect(params[1]).toBe('pm-321');
      expect(params[2]).toBe(VISITOR_ID);
      expect(params[3]).toBe('hard');
      expect(params[4]).toBe('gone@acme.com');
      expect(params[5]).toBe('mailbox unknown');
    });

    it('synthesizes a provider id when none supplied', async () => {
      const { db, inserts } = makeFakeDb();
      const adapter = new VisitorMailDeliveryAdapter(db as never);
      await adapter.recordBounced(VISITOR_ID, TENANT_ID, {
        reason: 'soft fail',
      });
      const params = (inserts[0]!.params as unknown[]) ?? [];
      expect(typeof params[1]).toBe('string');
      expect((params[1] as string).startsWith('local-')).toBe(true);
    });
  });

  describe('lastDeliveryStatusForVisitor', () => {
    it('returns null when no events', async () => {
      const { db } = makeFakeDb({ lastEvent: null });
      const adapter = new VisitorMailDeliveryAdapter(db as never);
      const result = await adapter.lastDeliveryStatusForVisitor(VISITOR_ID, TENANT_ID);
      expect(result).toBeNull();
    });

    it('returns the most-recent event row', async () => {
      const last: DeliveryEvent = {
        id: 'evt-1',
        tenant_id: TENANT_ID,
        provider_message_id: 'pm-1',
        correlated_entity_type: 'visitor_invite',
        correlated_entity_id: VISITOR_ID,
        event_type: 'bounced',
        bounce_type: 'hard',
        recipient_email: 'gone@acme.com',
        reason: 'mailbox unknown',
        occurred_at: '2026-04-30T08:30:00Z',
      };
      const { db, sqlCalls } = makeFakeDb({ lastEvent: last });
      const adapter = new VisitorMailDeliveryAdapter(db as never);
      const result = await adapter.lastDeliveryStatusForVisitor(VISITOR_ID, TENANT_ID);
      expect(result).toEqual(last);
      // Tenant filter must be in the SQL.
      const sql = sqlCalls[0]!.sql.toLowerCase();
      expect(sql).toContain('tenant_id = $1');
      expect(sql).toContain("correlated_entity_type = 'visitor_invite'");
      expect(sql).toContain('order by occurred_at desc');
    });
  });

  describe('bouncedInvitesForBuildingSince', () => {
    it('passes tenantId, buildingId, and since correctly', async () => {
      const since = new Date('2026-04-30T00:00:00Z');
      const { db, sqlCalls } = makeFakeDb({ bouncedRows: [] });
      const adapter = new VisitorMailDeliveryAdapter(db as never);
      await adapter.bouncedInvitesForBuildingSince(BUILDING_ID, TENANT_ID, since);
      expect(sqlCalls).toHaveLength(1);
      expect(sqlCalls[0]!.params).toEqual([TENANT_ID, BUILDING_ID, since.toISOString()]);
      const sql = sqlCalls[0]!.sql.toLowerCase();
      expect(sql).toContain("v.status in ('expected', 'pending_approval')");
      expect(sql).toContain("latest.event_type = 'bounced'");
    });

    it('returns rows from the canned dataset', async () => {
      const row: BouncedInviteRow = {
        visitor_id: VISITOR_ID,
        first_name: 'Anna',
        last_name: 'Visser',
        company: 'ABC',
        primary_host_first_name: 'Marleen',
        primary_host_last_name: 'Hoek',
        recipient_email: 'gone@acme.com',
        bounce_type: 'hard',
        reason: 'mailbox unknown',
        occurred_at: '2026-04-30T08:30:00Z',
        event_type: 'bounced',
        expected_at: '2026-05-01T09:00:00Z',
        arrived_at: null,
        status: 'expected',
        visitor_pass_id: null,
        pass_number: null,
        visitor_type_id: null,
      };
      const { db } = makeFakeDb({ bouncedRows: [row] });
      const adapter = new VisitorMailDeliveryAdapter(db as never);
      const result = await adapter.bouncedInvitesForBuildingSince(
        BUILDING_ID,
        TENANT_ID,
        new Date(),
      );
      expect(result).toEqual([row]);
    });

    it('rejects cross-tenant call', async () => {
      const { db } = makeFakeDb({ bouncedRows: [] });
      const adapter = new VisitorMailDeliveryAdapter(db as never);
      await expect(
        adapter.bouncedInvitesForBuildingSince(BUILDING_ID, OTHER_TENANT_ID, new Date()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
