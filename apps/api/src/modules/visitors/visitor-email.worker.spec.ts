/**
 * VisitorEmailWorker — drives outbound visitor emails from domain_events.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6, §10.2, §11.3
 *
 * Tests:
 *   - processOne dispatches the right template per event type
 *   - dedup: a second pass over the same event is a no-op
 *   - missing recipient email is a clean skip (not crash)
 *   - declined email goes to host, not visitor
 *   - tenant context guard: each render runs under the event's tenant
 *   - send failure surfaces; bounce wiring is the webhook controller's job
 */

import {
  VisitorEmailWorker,
  type DomainEventRow,
} from './visitor-email.worker';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const VISITOR = '22222222-2222-4222-8222-222222222222';
const HOST_PERSON = '33333333-3333-4333-8333-333333333333';
const BUILDING = '44444444-4444-4444-8444-444444444444';
const ROOM = '55555555-5555-4555-8555-555555555555';
const VISITOR_TYPE = '66666666-6666-4666-8666-666666666666';

interface FakeSupabaseOpts {
  /** Visitor row by id. */
  visitor?: Record<string, unknown> | null;
  tenant?: Record<string, unknown> | null;
  building?: Record<string, unknown> | null;
  room?: Record<string, unknown> | null;
  host?: Record<string, unknown> | null;
  visitorType?: Record<string, unknown> | null;
}

function makeFakeSupabase(opts: FakeSupabaseOpts = {}) {
  const auditInserts: Array<Record<string, unknown>> = [];
  const tokenInserts: Array<Record<string, unknown>> = [];

  const builder = (table: string) => {
    const filters: Record<string, unknown> = {};
    type Q = {
      select: (_cols: string) => Q;
      eq: (col: string, val: unknown) => Q;
      maybeSingle: () => Promise<{ data: unknown; error: null }>;
      insert: (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
        select: () => { single: () => Promise<{ data: Record<string, unknown>; error: null }>; };
        // Bare-promise form for inserts where the caller doesn't .select() — used
        // by the email worker's mintFreshCancelToken (full-review I9).
        then?: (resolve: (v: { data: null; error: null }) => void) => void;
      };
    };

    /** Apply common eq-filters: if a row carries tenant_id/id, both must
     *  match the filters (defense in depth — the worker filters every
     *  visitor row on tenant_id). */
    const matches = (row: Record<string, unknown> | null | undefined): boolean => {
      if (!row) return false;
      for (const [k, v] of Object.entries(filters)) {
        if (k in row && row[k] !== v) return false;
      }
      return true;
    };

    const q: Q = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return q;
      },
      maybeSingle: async () => {
        let candidate: Record<string, unknown> | null = null;
        switch (table) {
          case 'visitors':
            candidate = (opts.visitor as Record<string, unknown> | undefined) ?? null;
            break;
          case 'tenants':
            candidate = (opts.tenant as Record<string, unknown> | undefined) ?? null;
            break;
          case 'spaces':
            // Distinguish building vs room by the `id` filter
            if (filters.id === BUILDING) {
              candidate = (opts.building as Record<string, unknown> | undefined) ?? null;
            } else if (filters.id === ROOM) {
              candidate = (opts.room as Record<string, unknown> | undefined) ?? null;
            }
            break;
          case 'persons':
            candidate = (opts.host as Record<string, unknown> | undefined) ?? null;
            break;
          case 'visitor_types':
            candidate = (opts.visitorType as Record<string, unknown> | undefined) ?? null;
            break;
        }
        const data = matches(candidate) ? candidate : null;
        return { data, error: null };
      },
      insert: (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
        if (table === 'audit_events') {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const r of arr) auditInserts.push(r);
        }
        if (table === 'visit_invitation_tokens') {
          const arr = Array.isArray(rows) ? rows : [rows];
          for (const r of arr) tokenInserts.push(r);
        }
        const result = {
          select: () => ({
            single: async () => ({ data: { id: 'inserted' }, error: null }),
          }),
          // Promise-shape thenable for `await ...insert(row)` without .select():
          then(resolve: (v: { data: null; error: null }) => void) {
            resolve({ data: null, error: null });
          },
        };
        return result as ReturnType<Q['insert']>;
      },
    };
    return q;
  };

  const supabase = {
    admin: {
      from: jest.fn((table: string) => builder(table)),
    },
  };

  return { supabase, auditInserts, tokenInserts };
}

interface FakeDbOpts {
  /** Override the dedup lookup result. By default: no prior send. */
  alreadySent?: boolean;
  /** Override the pending-events query result. */
  pendingEvents?: DomainEventRow[];
}

function makeFakeDb(opts: FakeDbOpts = {}) {
  const sqlCalls: Array<{ sql: string; params?: unknown[] }> = [];
  const adapterInserts: Array<Record<string, unknown>> = [];

  const db = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const t = sql.trim().toLowerCase();
      if (t.startsWith('insert into public.email_delivery_events')) {
        adapterInserts.push({ sql, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    queryOne: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const t = sql.trim().toLowerCase();
      if (t.includes('from public.email_delivery_events')) {
        // dedup lookup
        return opts.alreadySent ? { id: 'prior' } : null;
      }
      return null;
    }),
    queryMany: jest.fn(async (sql: string, params?: unknown[]) => {
      sqlCalls.push({ sql, params });
      const t = sql.trim().toLowerCase();
      if (t.includes('from public.domain_events')) {
        return opts.pendingEvents ?? [];
      }
      return [];
    }),
  };

  return { db, sqlCalls, adapterInserts };
}

interface SendCall {
  to: string;
  toName?: string | null;
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  idempotencyKey?: string;
  tags?: Record<string, string>;
  tenantId: string;
}

function makeFakeMail(opts: { fail?: boolean } = {}) {
  const calls: SendCall[] = [];
  const mail = {
    send: jest.fn(async (msg: SendCall) => {
      calls.push(msg);
      if (opts.fail) throw new Error('mail provider error');
      return { messageId: `pm-${calls.length}`, acceptedAt: new Date().toISOString() };
    }),
    verifyWebhook: jest.fn(),
  };
  return { mail, calls };
}

function makeFakeAdapter() {
  const sentCalls: Array<{ visitor_id: string; tenant_id: string; provider_message_id: string; recipient_email?: string | null }> = [];
  const bouncedCalls: Array<{ visitor_id: string; tenant_id: string }> = [];
  const adapter = {
    recordSent: jest.fn(async (vid: string, tid: string, pmid: string, opts?: { recipient_email?: string | null }) => {
      sentCalls.push({
        visitor_id: vid,
        tenant_id: tid,
        provider_message_id: pmid,
        recipient_email: opts?.recipient_email ?? null,
      });
    }),
    recordBounced: jest.fn(async (vid: string, tid: string) => {
      bouncedCalls.push({ visitor_id: vid, tenant_id: tid });
    }),
    recordDelivered: jest.fn(async () => undefined),
  };
  return { adapter, sentCalls, bouncedCalls };
}

function buildEvent(eventType: string, payload: Record<string, unknown> = {}): DomainEventRow {
  return {
    id: `de-${eventType}`,
    tenant_id: TENANT_A,
    event_type: eventType,
    entity_type: 'visitor',
    entity_id: VISITOR,
    payload,
    created_at: '2026-05-01T08:00:00Z',
  };
}

function defaultVisitorRow() {
  return {
    id: VISITOR,
    tenant_id: TENANT_A,
    status: 'expected',
    first_name: 'Marleen',
    last_name: 'Visser',
    email: 'marleen@example.com',
    phone: null,
    company: 'ABC',
    expected_at: '2026-05-01T09:00:00Z',
    expected_until: '2026-05-01T11:00:00Z',
    building_id: BUILDING,
    meeting_room_id: ROOM,
    primary_host_person_id: HOST_PERSON,
    visitor_type_id: VISITOR_TYPE,
    notes_for_visitor: null,
  };
}

function defaultSupabaseFixtures(): FakeSupabaseOpts {
  return {
    visitor: defaultVisitorRow(),
    tenant: { id: TENANT_A, name: 'Acme', branding: { logo_light_url: null, primary_color: '#0ea5e9' } },
    building: { id: BUILDING, name: 'HQ Amsterdam', address: 'Herengracht 100' },
    room: { id: ROOM, name: 'Amber 3' },
    host: { id: HOST_PERSON, first_name: 'Jan', last_name: 'Bakker', email: 'jan@acme.test' },
    visitorType: {
      id: VISITOR_TYPE,
      display_name: 'Guest',
      requires_id_scan: true,
      requires_nda: false,
      requires_photo: false,
    },
  };
}

describe('VisitorEmailWorker.processOne', () => {
  it('sends invitation.expected to the visitor', async () => {
    const { db } = makeFakeDb();
    const { supabase, auditInserts } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter, sentCalls } = makeFakeAdapter();

    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    const result = await worker.processOne(buildEvent('visitor.invitation.expected', {
      cancel_token: 'plaintext-abc',
    }));

    expect(result).toBe('sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('marleen@example.com');
    expect(calls[0]!.subject).toContain('HQ Amsterdam');
    expect(calls[0]!.textBody).toContain('Host: Jan');
    expect(calls[0]!.idempotencyKey).toBe('visitor-email:de-visitor.invitation.expected');
    expect(calls[0]!.tags).toMatchObject({
      entity_type: 'visitor_invite',
      visitor_id: VISITOR,
      template_kind: 'visitor.invitation.expected',
    });
    expect(sentCalls).toHaveLength(1);
    expect(sentCalls[0]!.recipient_email).toBe('marleen@example.com');
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0]!.event_type).toBe('visitor.email_sent');
  });

  it('skips when dedup hit (same event already sent)', async () => {
    const { db } = makeFakeDb({ alreadySent: true });
    const { supabase } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter, sentCalls } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    const result = await worker.processOne(buildEvent('visitor.invitation.expected'));

    expect(result).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect(sentCalls).toHaveLength(0);
  });

  it('skips when visitor email is null (no recipient)', async () => {
    const { db } = makeFakeDb();
    const fixtures = defaultSupabaseFixtures();
    fixtures.visitor = { ...defaultVisitorRow(), email: null };
    const { supabase } = makeFakeSupabase(fixtures);
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    const result = await worker.processOne(buildEvent('visitor.invitation.expected'));

    expect(result).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('declined email goes to host (not visitor)', async () => {
    const { db } = makeFakeDb();
    const { supabase } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    const result = await worker.processOne(buildEvent('visitor.invitation_declined'));

    expect(result).toBe('sent');
    expect(calls[0]!.to).toBe('jan@acme.test');
    expect(calls[0]!.subject).toContain('was declined');
  });

  it('cascade.moved → moved template', async () => {
    const { db } = makeFakeDb();
    const { supabase } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    await worker.processOne(buildEvent('visitor.cascade.moved', {
      old_expected_at: '2026-05-01T09:00:00Z',
      new_expected_at: '2026-05-01T14:00:00Z',
    }));

    expect(calls[0]!.subject).toContain('moved');
    expect(calls[0]!.textBody).toContain('Was:');
    expect(calls[0]!.textBody).toContain('Now:');
  });

  it('cascade.moved without payload.cancel_token mints a fresh token (I9)', async () => {
    const { db } = makeFakeDb();
    const { supabase, tokenInserts } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    // No `cancel_token` in payload — replicating BundleCascadeAdapter,
    // which doesn't have access to the original plaintext.
    await worker.processOne(buildEvent('visitor.cascade.moved', {
      old_expected_at: '2026-05-01T09:00:00Z',
      new_expected_at: '2026-05-01T14:00:00Z',
    }));

    // A fresh token row was inserted into visit_invitation_tokens.
    expect(tokenInserts).toHaveLength(1);
    const tokenRow = tokenInserts[0]!;
    expect(tokenRow.purpose).toBe('cancel');
    expect(tokenRow.tenant_id).toBe(TENANT_A);
    expect(tokenRow.visitor_id).toBe(VISITOR);
    expect(typeof tokenRow.token_hash).toBe('string');
    expect((tokenRow.token_hash as string).length).toBeGreaterThan(50); // sha256 hex = 64
    // 24h expiry from "now"; we just check it's in the future.
    expect(new Date(tokenRow.expires_at as string).getTime()).toBeGreaterThan(Date.now());
    // The email got a cancel link — implies the worker built a URL from the
    // minted plaintext.
    expect(calls[0]!.htmlBody).toContain('/visit/cancel/');
  });

  it('cascade.cancelled does NOT mint a cancel token (visit is terminal)', async () => {
    const { db } = makeFakeDb();
    const { supabase, tokenInserts } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    await worker.processOne(buildEvent('visitor.cascade.cancelled'));

    expect(tokenInserts).toHaveLength(0);
  });

  it('initial invitation event without payload.cancel_token does NOT mint (real bug, not regression)', async () => {
    // The first invite path is InvitationService's responsibility — if its
    // domain_event arrives without a cancel_token that's a real invariant
    // violation worth flagging, not papering over with a silent mint.
    const { db } = makeFakeDb();
    const { supabase, tokenInserts } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    await worker.processOne(buildEvent('visitor.invitation.expected', {
      // intentionally no cancel_token
    }));

    expect(tokenInserts).toHaveLength(0);
    // Email still goes out, just without a cancel URL — the visitor can
    // still cancel by reply / via reception.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.htmlBody).not.toContain('/visit/cancel/');
  });

  it('cascade.moved → moved template, embeds cancel_token from payload when present', async () => {
    const { db } = makeFakeDb();
    const { supabase, tokenInserts } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    await worker.processOne(buildEvent('visitor.cascade.moved', {
      old_expected_at: '2026-05-01T09:00:00Z',
      new_expected_at: '2026-05-01T14:00:00Z',
      cancel_token: 'existing-plaintext-token',
    }));

    // Existing token reused — no fresh mint.
    expect(tokenInserts).toHaveLength(0);
    expect(calls[0]!.htmlBody).toContain('/visit/cancel/existing-plaintext-token');
  });

  it('cascade.cancelled → cancellation template', async () => {
    const { db } = makeFakeDb();
    const { supabase } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    await worker.processOne(buildEvent('visitor.cascade.cancelled'));

    expect(calls[0]!.subject).toContain('cancelled');
  });

  it('skips moved-template event when visitor has already arrived (status drift)', async () => {
    const { db } = makeFakeDb();
    const fixtures = defaultSupabaseFixtures();
    fixtures.visitor = { ...defaultVisitorRow(), status: 'arrived' };
    const { supabase } = makeFakeSupabase(fixtures);
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    const result = await worker.processOne(buildEvent('visitor.cascade.moved'));

    expect(result).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('skips unknown event_type', async () => {
    const { db } = makeFakeDb();
    const { supabase } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    const result = await worker.processOne(buildEvent('visitor.completely_unknown'));

    expect(result).toBe('skipped');
    expect(calls).toHaveLength(0);
  });

  it('mail provider failure surfaces (does NOT silently succeed)', async () => {
    const { db } = makeFakeDb();
    const { supabase } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail } = makeFakeMail({ fail: true });
    const { adapter, sentCalls } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    await expect(worker.processOne(buildEvent('visitor.invitation.expected'))).rejects.toThrow(
      /mail provider error/i,
    );
    // Adapter must NOT have recorded a send when the provider failed.
    expect(sentCalls).toHaveLength(0);
  });

  it('passes the event tenant_id through to the mail provider', async () => {
    const { db } = makeFakeDb();
    const fixtures = defaultSupabaseFixtures();
    // Synthesise a visitor record under tenant B even though current
    // context is A — defense in depth.
    fixtures.visitor = { ...defaultVisitorRow(), tenant_id: TENANT_B };
    const { supabase } = makeFakeSupabase(fixtures);
    void TENANT_B;
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    // Event tenant is TENANT_A; the visitor row's tenant must match
    // for the worker to find it via .eq('tenant_id', TENANT_A). Since
    // we set the visitor tenant to B, the lookup returns null and we
    // skip — exactly the cross-tenant defence.
    const event = buildEvent('visitor.invitation.expected');
    const result = await worker.processOne(event);
    expect(result).toBe('skipped');
    expect(calls).toHaveLength(0);
  });
});

describe('VisitorEmailWorker.processBatch', () => {
  it('drains pending events and reports counts', async () => {
    const events: DomainEventRow[] = [
      { ...buildEvent('visitor.invitation.expected'), id: 'de-1' },
      { ...buildEvent('visitor.cascade.cancelled'), id: 'de-2' },
    ];
    const { db } = makeFakeDb({ pendingEvents: events });
    const { supabase } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail, calls } = makeFakeMail();
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    const result = await worker.processBatch(50);

    expect(result.processed).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it('continues past a single failure', async () => {
    const events: DomainEventRow[] = [
      { ...buildEvent('visitor.invitation.expected'), id: 'de-1' },
      { ...buildEvent('visitor.invitation.expected'), id: 'de-2' },
    ];
    const { db } = makeFakeDb({ pendingEvents: events });
    const { supabase } = makeFakeSupabase(defaultSupabaseFixtures());
    const { mail } = makeFakeMail();
    // Make first send fail, second succeed.
    let callNum = 0;
    mail.send.mockImplementation(async (msg: SendCall) => {
      callNum++;
      if (callNum === 1) throw new Error('first fails');
      return { messageId: `pm-${callNum}`, acceptedAt: new Date().toISOString() };
    });
    const { adapter } = makeFakeAdapter();
    const worker = new VisitorEmailWorker(db as never, supabase as never, mail as never, adapter as never);

    const result = await worker.processBatch(50);

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
  });
});
