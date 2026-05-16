import { WorkflowService } from './workflow.service';

/**
 * Phase 1.5 sub-step 6.A.Y coverage — `WorkflowService.start({...})`
 * polymorphic routing + the `engine.startForBooking` entry point.
 *
 * The `start` overload (commit f662d49c) shipped without unit coverage;
 * these tests pin the routing contract so a future entityKind change
 * can't silently send a booking down the case path (or vice-versa).
 *
 * Mocking style mirrors workflow-engine.service.spec.ts: hand-rolled
 * dependency stubs + `new WorkflowService(... as never)`, no Nest TestModule.
 */
function makeService() {
  const engine = {
    startForTicket: jest.fn(async (entityId: string, definitionId: string) => ({
      id: 'inst-ticket',
      entity_kind: 'case',
      ticket_id: entityId,
      workflow_definition_id: definitionId,
    })),
    startForBooking: jest.fn(async (entityId: string, definitionId: string) => ({
      id: 'inst-booking',
      entity_kind: 'booking',
      booking_id: entityId,
      workflow_definition_id: definitionId,
    })),
  };
  // supabase + validator are unused by `start`; stub as empty objects.
  const supabase = {} as unknown;
  const validator = {} as unknown;
  const service = new WorkflowService(
    supabase as never,
    validator as never,
    engine as never,
  );
  return { service, engine };
}

describe('WorkflowService.start (Phase 1.5 6.A.Y polymorphic routing)', () => {
  it('routes a non-booking (case) entity to engine.startForTicket', async () => {
    const { service, engine } = makeService();

    const result = await service.start({
      definitionId: 'def-1',
      entityKind: 'case',
      entityId: 'ticket-1',
      tenantId: 't1',
    });

    expect(engine.startForTicket).toHaveBeenCalledWith('ticket-1', 'def-1');
    expect(engine.startForBooking).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'inst-ticket', entity_kind: 'case' });
  });

  it('routes a booking entity to engine.startForBooking', async () => {
    const { service, engine } = makeService();

    const result = await service.start({
      definitionId: 'def-2',
      entityKind: 'booking',
      entityId: 'booking-9',
      tenantId: 't1',
    });

    expect(engine.startForBooking).toHaveBeenCalledWith('booking-9', 'def-2');
    expect(engine.startForTicket).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'inst-booking', entity_kind: 'booking' });
  });

  it('throws workflow.advance_failed for the work_order entity path (not implemented in Phase 1.5)', async () => {
    const { service, engine } = makeService();

    await expect(
      service.start({
        definitionId: 'def-3',
        entityKind: 'work_order',
        entityId: 'wo-1',
        tenantId: 't1',
      }),
    ).rejects.toMatchObject({ code: 'workflow.advance_failed' });

    expect(engine.startForTicket).not.toHaveBeenCalled();
    expect(engine.startForBooking).not.toHaveBeenCalled();
  });
});
