import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { DailyListFollowupService } from './daily-list-followup.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const USER = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const LINE = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';

interface FollowupRow {
  line_id: string;
  order_id: string;
  tenant_id: string;
  vendor_id: string | null;
  vendor_name: string;
  vendor_phone: string;
  catalog_item_id: string | null;
  catalog_item_name: string;
  quantity: number;
  dietary_notes: string | null;
  fulfillment_status: string | null;
  fulfillment_notes: string | null;
  locked_at: string | null;
  daglijst_id: string | null;
  service_window_start_at: string | null;
  requester_first_name: string | null;
  room_name: string;
}

function row(overrides: Partial<FollowupRow> = {}): FollowupRow {
  return {
    line_id: LINE,
    order_id: 'order-1',
    tenant_id: TENANT,
    vendor_id: 'vendor-1',
    vendor_name: 'Acme Catering',
    vendor_phone: '0123-456789',
    catalog_item_id: 'ci-1',
    catalog_item_name: 'Sandwiches',
    quantity: 12,
    dietary_notes: null,
    fulfillment_status: 'preparing',
    fulfillment_notes: null,
    locked_at: '2026-04-30T18:00:00Z',
    daglijst_id: 'dl-1',
    service_window_start_at: '2026-05-01T11:30:00Z',
    requester_first_name: 'Jan',
    room_name: 'Boardroom 4',
    ...overrides,
  };
}

interface FakeOptions {
  rows?: FollowupRow[];
  /**
   * Pre-state of the line as seen by the SELECT FOR UPDATE inside
   * confirmPhoned. Use null to model "row doesn't exist for this tenant".
   */
  preState?: {
    requires_phone_followup: boolean;
    desk_confirmed_phoned_at: string | null;
  } | null;
  /** Override the desk_confirmed_phoned_at returned by a successful UPDATE. */
  confirmedAt?: string;
}

function makeFakeDb(opts: FakeOptions = {}) {
  const captured: Array<{ sql: string; params?: unknown[]; tx?: boolean }> = [];

  const txClient = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params, tx: true });
      // SELECT … FOR UPDATE pre-state lookup.
      if (sql.includes('select id, requires_phone_followup')) {
        if (opts.preState === undefined) {
          // Default: the row exists and IS flagged.
          return {
            rows: [{ id: LINE, requires_phone_followup: true, desk_confirmed_phoned_at: null }],
            rowCount: 1,
          };
        }
        if (opts.preState === null) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{ id: LINE, ...opts.preState }],
          rowCount: 1,
        };
      }
      if (sql.includes('update public.order_line_items')) {
        return {
          rows: [{
            desk_confirmed_phoned_at: opts.confirmedAt ?? '2026-04-30T19:00:00Z',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('insert into audit_outbox')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    captured,
    txClient,
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      captured.push({ sql });
      if (sql.includes('insert into audit_outbox')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async () => null),
    queryMany: jest.fn(async (sql: string) => {
      captured.push({ sql });
      if (sql.includes('from public.order_line_items')) {
        return opts.rows ?? [];
      }
      return [];
    }),
    rpc: jest.fn(),
    tx: jest.fn(async (fn: (c: typeof txClient) => Promise<unknown>) => fn(txClient)),
  };
}

function buildSvc(opts: FakeOptions = {}) {
  const db = makeFakeDb(opts);
  const svc = new DailyListFollowupService(
    db as never,
    new AuditOutboxService(db as never),
  );
  return { db, svc };
}

describe('DailyListFollowupService.listPostCutoffChanges', () => {
  it('groups by vendor + counts lines', async () => {
    const { svc } = buildSvc({
      rows: [
        row({ line_id: 'L1', vendor_id: 'V1', vendor_name: 'Acme' }),
        row({ line_id: 'L2', vendor_id: 'V1', vendor_name: 'Acme' }),
        row({ line_id: 'L3', vendor_id: 'V2', vendor_name: 'Beta' }),
      ],
    });
    const groups = await svc.listPostCutoffChanges(TENANT);
    expect(groups).toHaveLength(2);
    const acme = groups.find((g) => g.vendor_name === 'Acme');
    const beta = groups.find((g) => g.vendor_name === 'Beta');
    expect(acme?.line_count).toBe(2);
    expect(beta?.line_count).toBe(1);
    expect(acme?.lines.map((l) => l.line_id)).toEqual(['L1', 'L2']);
  });

  it('returns empty array when nothing flagged', async () => {
    const { svc } = buildSvc({ rows: [] });
    expect(await svc.listPostCutoffChanges(TENANT)).toEqual([]);
  });

  it('preserves first-name-only privacy posture', async () => {
    const { svc } = buildSvc({
      rows: [row({ requester_first_name: 'Jan' })],
    });
    const groups = await svc.listPostCutoffChanges(TENANT);
    const line = groups[0].lines[0];
    expect(line.requester_first_name).toBe('Jan');
    expect(line).not.toHaveProperty('requester_last_name');
    expect(line).not.toHaveProperty('requester_email');
  });
});

describe('DailyListFollowupService.confirmPhoned', () => {
  it('stamps the line + emits OrderPhoneFollowupConfirmed audit + returns status=confirmed', async () => {
    const { svc, db } = buildSvc({ confirmedAt: '2026-04-30T19:30:00Z' });
    const r = await svc.confirmPhoned({ tenantId: TENANT, lineId: LINE, userId: USER });
    expect(r.status).toBe('confirmed');
    expect(r.confirmed_at).toBe('2026-04-30T19:30:00Z');
    const audit = db.captured.find((c) =>
      c.tx && c.sql.includes('insert into audit_outbox')
      && c.params?.[1] === 'order.phone_followup_confirmed',
    );
    expect(audit).toBeDefined();
  });

  it('idempotent on already-confirmed line — no audit, returns existing timestamp', async () => {
    // Codex Sprint 3A round-1 fix: a second confirm of the SAME edit
    // must not throw and must not re-emit audit. The DB trigger is the
    // mechanism that re-flags on subsequent edits.
    const { svc, db } = buildSvc({
      preState: {
        requires_phone_followup: false,
        desk_confirmed_phoned_at: '2026-04-30T19:30:00Z',
      },
    });
    const r = await svc.confirmPhoned({ tenantId: TENANT, lineId: LINE, userId: USER });
    expect(r.status).toBe('already_confirmed');
    expect(r.confirmed_at).toBe('2026-04-30T19:30:00Z');
    const audit = db.captured.find((c) =>
      c.tx && c.sql.includes('insert into audit_outbox')
      && c.params?.[1] === 'order.phone_followup_confirmed',
    );
    expect(audit).toBeUndefined();
  });

  it('re-confirms after a fresh edit (preState flagged again)', async () => {
    // The trigger flips requires_phone_followup back to true on edit
    // even when desk_confirmed_phoned_at carries a prior timestamp;
    // confirmPhoned re-stamps on the current timestamp + emits audit.
    const { svc, db } = buildSvc({
      preState: {
        requires_phone_followup: true,
        desk_confirmed_phoned_at: '2026-04-30T19:30:00Z',          // stale
      },
      confirmedAt: '2026-04-30T20:00:00Z',
    });
    const r = await svc.confirmPhoned({ tenantId: TENANT, lineId: LINE, userId: USER });
    expect(r.status).toBe('confirmed');
    expect(r.confirmed_at).toBe('2026-04-30T20:00:00Z');
    const audit = db.captured.find((c) =>
      c.tx && c.sql.includes('insert into audit_outbox')
      && c.params?.[1] === 'order.phone_followup_confirmed',
    );
    expect(audit).toBeDefined();
  });

  it('throws NotFound when the line does not exist for this tenant', async () => {
    const { svc } = buildSvc({ preState: null });
    await expect(
      svc.confirmPhoned({ tenantId: TENANT, lineId: LINE, userId: USER }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequest when the line exists, has never been flagged, and is not currently flagged', async () => {
    const { svc } = buildSvc({
      preState: { requires_phone_followup: false, desk_confirmed_phoned_at: null },
    });
    await expect(
      svc.confirmPhoned({ tenantId: TENANT, lineId: LINE, userId: USER }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
