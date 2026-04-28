import { PersonActivityService } from './person-activity.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-1111-1111-111111111111';
const PERSON = '33333333-3333-3333-3333-333333333333';

function makeSupabase(returns: { tickets?: unknown[]; bookings?: unknown[]; audits?: unknown[] }) {
  const from = (table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      or: () => builder,
      order: () => builder,
      limit: () => {
        if (table === 'tickets')        return Promise.resolve({ data: returns.tickets ?? [], error: null });
        if (table === 'reservations')   return Promise.resolve({ data: returns.bookings ?? [], error: null });
        if (table === 'audit_events')   return Promise.resolve({ data: returns.audits ?? [], error: null });
        return Promise.resolve({ data: [], error: null });
      },
    };
    return builder;
  };
  return { admin: { from } };
}

describe('PersonActivityService', () => {
  it('merges and orders by created_at desc, returns kind + key fields per item', async () => {
    const supabase = makeSupabase({
      tickets: [
        { id: 't1', title: 'Broken light', status: 'open', created_at: '2026-04-28T08:00:00Z' },
      ],
      bookings: [
        { id: 'b1', space: { name: 'Conf A' }, starts_at: '2026-04-28T11:00:00Z', status: 'confirmed', created_at: '2026-04-28T09:00:00Z' },
      ],
      audits: [
        { id: 'a1', event_type: 'role_changed', details: {}, actor: null, created_at: '2026-04-28T10:00:00Z' },
      ],
    });

    const items = await TenantContext.run({ id: TENANT, slug: 't' } as never, async () => {
      const svc = new PersonActivityService(supabase as never);
      return svc.getRecentActivity(PERSON, 10);
    });

    // Sorted by created_at desc → booking (09:00) wait that's not right; let me reorder:
    // ticket created 08:00, booking created 09:00, audit created 10:00
    // desc: audit, booking, ticket
    expect(items.map((i) => i.kind)).toEqual(['audit', 'booking', 'ticket']);

    const ticket = items.find((i) => i.kind === 'ticket')!;
    expect(ticket).toMatchObject({ id: 't1', title: 'Broken light', status: 'open' });

    const booking = items.find((i) => i.kind === 'booking')!;
    expect(booking).toMatchObject({ id: 'b1', space_name: 'Conf A', status: 'confirmed' });

    const audit = items.find((i) => i.kind === 'audit')!;
    expect(audit).toMatchObject({ id: 'a1', event_type: 'role_changed', actor_name: null });
  });

  it('respects the limit when more rows are available across sources', async () => {
    const supabase = makeSupabase({
      tickets: Array.from({ length: 30 }, (_, i) => ({
        id: `t${i}`, title: 'x', status: 'open',
        created_at: `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
      })),
    });

    const items = await TenantContext.run({ id: TENANT, slug: 't' } as never, async () => {
      const svc = new PersonActivityService(supabase as never);
      return svc.getRecentActivity(PERSON, 5);
    });

    expect(items).toHaveLength(5);
    // newest first → t29, t28, t27, t26, t25
    expect(items.map((i) => (i as any).id)).toEqual(['t29', 't28', 't27', 't26', 't25']);
  });

  it('flattens actor.person to actor_name "First Last" when present', async () => {
    const supabase = makeSupabase({
      audits: [
        {
          id: 'a1',
          event_type: 'updated',
          details: {},
          actor: { person: { first_name: 'Jane', last_name: 'Smith' } },
          created_at: '2026-04-28T00:00:00Z',
        },
      ],
    });

    const items = await TenantContext.run({ id: TENANT, slug: 't' } as never, async () => {
      const svc = new PersonActivityService(supabase as never);
      return svc.getRecentActivity(PERSON);
    });

    expect((items[0] as any).actor_name).toBe('Jane Smith');
  });

  it('returns empty array when all sources are empty', async () => {
    const supabase = makeSupabase({});
    const items = await TenantContext.run({ id: TENANT, slug: 't' } as never, async () => {
      const svc = new PersonActivityService(supabase as never);
      return svc.getRecentActivity(PERSON);
    });
    expect(items).toEqual([]);
  });
});
