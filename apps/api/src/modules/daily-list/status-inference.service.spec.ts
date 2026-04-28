import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { DailyListStatusInferenceService } from './status-inference.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const VENDOR = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';

interface InferredRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  order_id: string;
  service_window_start_at: string;
  prev_status: 'ordered' | 'preparing';
  new_status: 'preparing' | 'delivered';
}

interface FakeOptions {
  /** Rows the 'ordered → preparing' UPDATE returns. */
  promoted?: InferredRow[];
  /** Rows the 'preparing → delivered' UPDATE returns. */
  delivered?: InferredRow[];
}

function makeFakeDb(opts: FakeOptions = {}) {
  const captured: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    captured,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      if (sql.includes('insert into audit_outbox')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async () => null),
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      if (sql.includes("set fulfillment_status   = 'preparing'")) {
        return opts.promoted ?? [];
      }
      if (sql.includes("set fulfillment_status   = 'delivered'")) {
        return opts.delivered ?? [];
      }
      return [];
    }),
    rpc: jest.fn(),
    tx: jest.fn(),
  };
}

function buildSvc(opts: FakeOptions = {}) {
  const db = makeFakeDb(opts);
  const svc = new DailyListStatusInferenceService(db as never, new AuditOutboxService(db as never));
  return { db, svc };
}

describe('DailyListStatusInferenceService.runOnce', () => {
  it('returns 0 + emits no audits when no rows transition', async () => {
    const { svc, db } = buildSvc();
    const n = await svc.runOnce();
    expect(n).toBe(0);
    const audits = db.captured.filter((c) =>
      c.sql.includes('insert into audit_outbox')
      && (c.params?.[1] === 'order_line_item.status_inferred'),
    );
    expect(audits).toHaveLength(0);
  });

  it('emits one OrderLineStatusInferred audit per promoted row', async () => {
    const promoted: InferredRow[] = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        tenant_id: TENANT,
        vendor_id: VENDOR,
        order_id: 'order-a',
        service_window_start_at: '2026-05-01T11:30:00Z',
        prev_status: 'ordered',
        new_status: 'preparing',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        tenant_id: TENANT,
        vendor_id: VENDOR,
        order_id: 'order-b',
        service_window_start_at: '2026-05-01T12:00:00Z',
        prev_status: 'ordered',
        new_status: 'preparing',
      },
    ];
    const { svc, db } = buildSvc({ promoted });
    const n = await svc.runOnce();
    expect(n).toBe(2);
    const audits = db.captured.filter((c) =>
      c.sql.includes('insert into audit_outbox')
      && c.params?.[1] === 'order_line_item.status_inferred',
    );
    expect(audits).toHaveLength(2);
    /* Each audit captures the from→to transition + the service window
       so scorecards can compute on-time on the inferred boundary. */
    const audit0 = audits[0];
    const details = JSON.parse(audit0.params?.[5] as string);
    expect(details.prev_status).toBe('ordered');
    expect(details.new_status).toBe('preparing');
    expect(details.event_source).toBe('inferred');
  });

  it('runs both passes in one tick', async () => {
    const { svc } = buildSvc({
      promoted: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          tenant_id: TENANT,
          vendor_id: VENDOR,
          order_id: 'order-a',
          service_window_start_at: '2026-05-01T11:30:00Z',
          prev_status: 'ordered',
          new_status: 'preparing',
        },
      ],
      delivered: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          tenant_id: TENANT,
          vendor_id: VENDOR,
          order_id: 'order-b',
          service_window_start_at: '2026-05-01T11:00:00Z',
          prev_status: 'preparing',
          new_status: 'delivered',
        },
      ],
    });
    const n = await svc.runOnce();
    expect(n).toBe(2);
  });

  it('emits with event_source=inferred so scorecards can distinguish from manual', async () => {
    const { svc, db } = buildSvc({
      delivered: [{
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        tenant_id: TENANT,
        vendor_id: VENDOR,
        order_id: 'order-c',
        service_window_start_at: '2026-05-01T10:00:00Z',
        prev_status: 'preparing',
        new_status: 'delivered',
      }],
    });
    await svc.runOnce();
    const audit = db.captured.find((c) =>
      c.sql.includes('insert into audit_outbox')
      && c.params?.[1] === 'order_line_item.status_inferred',
    );
    expect(audit).toBeDefined();
    const details = JSON.parse(audit!.params?.[5] as string);
    expect(details.event_source).toBe('inferred');
  });
});
