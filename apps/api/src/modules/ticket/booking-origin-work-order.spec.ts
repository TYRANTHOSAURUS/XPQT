import { TicketService } from './ticket.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';

interface InsertCapture {
  payload: Record<string, unknown>;
}

function makeTicketService() {
  const inserts: InsertCapture[] = [];
  const activityInserts: Array<Record<string, unknown>> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        // Step 1c.4: booking-origin now writes to work_orders directly.
        if (table === 'work_orders' || table === 'tickets') {
          return {
            insert: (payload: Record<string, unknown>) => {
              inserts.push({ payload });
              return {
                select: () => ({
                  single: async () => ({
                    data: { id: 'new-ticket-id' },
                    error: null,
                  }),
                }),
              };
            },
          } as unknown;
        }
        // ticket_activities + domain_events + anything else
        return {
          insert: (a: Record<string, unknown>) => {
            activityInserts.push(a);
            return {
              select: () => ({
                single: async () => ({ data: { id: 'gen' }, error: null }),
              }),
            };
          },
        } as unknown;
      }),
    },
  };

  const slaService = {
    startTimers: jest.fn().mockResolvedValue(undefined),
    restartTimers: jest.fn().mockResolvedValue(undefined),
    pauseTimers: jest.fn().mockResolvedValue(undefined),
    resumeTimers: jest.fn().mockResolvedValue(undefined),
  };

  const noop = jest.fn();
  const visibility = { loadContext: jest.fn(), assertVisible: jest.fn() };
  const routing = { evaluate: jest.fn() };
  const scopeOverrides = { resolve: jest.fn() };
  const workflow = { startForTicket: jest.fn() };
  const approval = { createSingleStep: jest.fn() };
  const reclassify = { reclassify: jest.fn() };

  // Minimal construction. TicketService takes many dependencies; we only
  // pass shapes that satisfy `any` casts. The booking-origin path doesn't
  // touch most of them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new TicketService(
    supabase as any,
    visibility as any,
    slaService as any,
    routing as any,
    scopeOverrides as any,
    workflow as any,
    approval as any,
    reclassify as any,
  );

  return { service, inserts, activityInserts, slaService, noop };
}

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run({ id: TENANT, subdomain: 't1' }, fn);
}

describe('TicketService.createBookingOriginWorkOrder', () => {
  it('inserts a work_orders row with parent_kind=booking_bundle and parent_ticket_id=null', async () => {
    const { service, inserts } = makeTicketService();

    await withTenant(() =>
      service.createBookingOriginWorkOrder({
        title: 'Internal setup — av_equipment',
        booking_bundle_id: 'bundle-1',
        linked_order_line_item_id: 'oli-1',
        assigned_team_id: 'team-facilities',
      }),
    );

    expect(inserts).toHaveLength(1);
    const row = inserts[0].payload;
    // Step 1c.4: parent_kind replaces ticket_kind as the discriminator.
    expect(row.parent_kind).toBe('booking_bundle');
    expect(row.parent_ticket_id).toBeNull();
    expect(row.booking_bundle_id).toBe('bundle-1');
    expect(row.linked_order_line_item_id).toBe('oli-1');
    expect(row.assigned_team_id).toBe('team-facilities');
  });

  it('does NOT carry requester_person_id (visibility hygiene)', async () => {
    const { service, inserts } = makeTicketService();

    await withTenant(() =>
      service.createBookingOriginWorkOrder({
        title: 'x',
        booking_bundle_id: 'b',
        linked_order_line_item_id: 'o',
        assigned_team_id: 'team-1',
      }),
    );

    // Booking-origin work orders intentionally have no requester. The
    // bundle's requester_person_id captures originator identity; setting
    // it on the work order would leak the internal task into the
    // requester's portal "My Requests" view.
    expect(inserts[0].payload.requester_person_id).toBeNull();
  });

  it('sets status_category=assigned when an assignee is provided', async () => {
    const { service, inserts } = makeTicketService();
    await withTenant(() =>
      service.createBookingOriginWorkOrder({
        title: 'x',
        booking_bundle_id: 'b',
        linked_order_line_item_id: 'o',
        assigned_team_id: 'team-1',
      }),
    );
    expect(inserts[0].payload.status_category).toBe('assigned');
  });

  it('sets status_category=new when no assignee is provided', async () => {
    const { service, inserts } = makeTicketService();
    await withTenant(() =>
      service.createBookingOriginWorkOrder({
        title: 'x',
        booking_bundle_id: 'b',
        linked_order_line_item_id: 'o',
      }),
    );
    expect(inserts[0].payload.status_category).toBe('new');
  });

  it('writes target_due_at directly to sla_resolution_due_at (no SLA timers)', async () => {
    const { service, inserts, slaService } = makeTicketService();
    const dueAt = '2026-04-30T13:30:00.000Z';

    await withTenant(() =>
      service.createBookingOriginWorkOrder({
        title: 'x',
        booking_bundle_id: 'b',
        linked_order_line_item_id: 'o',
        assigned_team_id: 'team-1',
        target_due_at: dueAt,
      }),
    );

    expect(inserts[0].payload.sla_resolution_due_at).toBe(dueAt);
    // No sla_id; SLA timers should NOT be started for booking-origin work
    // orders (deadline is service-window-anchored, not creation-anchored).
    expect(slaService.startTimers).not.toHaveBeenCalled();
  });

  it('returns the new ticket id', async () => {
    const { service } = makeTicketService();
    const result = await withTenant(() =>
      service.createBookingOriginWorkOrder({
        title: 'x',
        booking_bundle_id: 'b',
        linked_order_line_item_id: 'o',
        assigned_team_id: 'team-1',
      }),
    );
    expect(result.id).toBe('new-ticket-id');
  });

  it('emits a system event activity referencing the bundle + line', async () => {
    const { service, activityInserts } = makeTicketService();
    await withTenant(() =>
      service.createBookingOriginWorkOrder({
        title: 'x',
        booking_bundle_id: 'bundle-XYZ',
        linked_order_line_item_id: 'line-XYZ',
        assigned_team_id: 'team-1',
      }),
    );

    const sysEvent = activityInserts.find((a) => {
      const md = a.metadata as Record<string, unknown> | undefined;
      return md?.event === 'booking_origin_work_order_created';
    });
    expect(sysEvent).toBeDefined();
    const md = sysEvent?.metadata as Record<string, unknown>;
    expect(md.booking_bundle_id).toBe('bundle-XYZ');
    expect(md.linked_order_line_item_id).toBe('line-XYZ');
  });
});
