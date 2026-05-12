// Controller-level operator gate on GET /work-orders/planning (full-review
// C1 — 2026-05-12). The planning service's lane derivation pulls team
// rosters + tenant vendors when `team_id` is filtered. The SQL-layer block
// predicate (`work_orders_planning_visible_for_actor` in 00380) only
// gates the planned[] / unscheduled[] arrays — it does NOT gate
// `deriveLanes`. A requester JWT hitting `?team_id=<uuid>` would leak the
// roster + vendor labels. This controller gate is the structural defense:
// non-operators fail-closed at 403 BEFORE the service runs any query.

import { WorkOrderController } from './work-order.controller';
import { AppError } from '../../common/errors';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';

interface FakeRequest {
  user?: { id: string };
}

function makeController(opts: {
  context: {
    user_id: string;
    team_ids?: string[];
    role_assignments?: unknown[];
    has_read_all?: boolean;
    has_write_all?: boolean;
  };
}) {
  const planningService = {
    getWindow: jest.fn().mockResolvedValue({ planned: [], unscheduled: [], lanes: [] }),
  };
  const workOrderService = {};
  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: opts.context.user_id,
      person_id: null,
      tenant_id: TENANT,
      team_ids: opts.context.team_ids ?? [],
      role_assignments: opts.context.role_assignments ?? [],
      vendor_id: null,
      has_read_all: opts.context.has_read_all ?? false,
      has_write_all: opts.context.has_write_all ?? false,
    }),
  };
  return {
    controller: new WorkOrderController(
      workOrderService as never,
      planningService as never,
      visibility as never,
    ),
    planningService,
    visibility,
  };
}

function runInTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run({ id: TENANT, slug: 't1', tier: 'standard' }, fn);
}

const validFrom = '2026-05-12T07:00:00.000Z';
const validTo = '2026-05-13T07:00:00.000Z';
const TEAM_UUID = '94000000-0000-0000-0000-000000000002';

describe('WorkOrderController.getPlanning — operator gate (full-review C1)', () => {
  it('throws planning.operator_only when the actor has no operator paths', async () => {
    const { controller, planningService } = makeController({
      context: { user_id: 'u-requester' },
    });
    const req: FakeRequest = { user: { id: 'auth-uid' } };
    await expect(
      runInTenant(() =>
        controller.getPlanning(req as never, validFrom, validTo, undefined, undefined),
      ),
    ).rejects.toMatchObject({
      code: 'planning.operator_only',
      status: 403,
    });
    expect(planningService.getWindow).not.toHaveBeenCalled();
  });

  it('throws planning.operator_only even when ?team_id is supplied (lane-roster leak)', async () => {
    const { controller, planningService } = makeController({
      context: { user_id: 'u-requester' },
    });
    const req: FakeRequest = { user: { id: 'auth-uid' } };
    await expect(
      runInTenant(() =>
        controller.getPlanning(req as never, validFrom, validTo, undefined, TEAM_UUID),
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(planningService.getWindow).not.toHaveBeenCalled();
  });

  it('throws planning.operator_only when the actor is unknown in the tenant (empty user_id)', async () => {
    const { controller, planningService } = makeController({
      context: { user_id: '' },
    });
    const req: FakeRequest = { user: { id: 'auth-uid' } };
    await expect(
      runInTenant(() =>
        controller.getPlanning(req as never, validFrom, validTo, undefined, undefined),
      ),
    ).rejects.toMatchObject({ code: 'planning.operator_only', status: 403 });
    expect(planningService.getWindow).not.toHaveBeenCalled();
  });

  it('passes through when the actor has team membership (operator path)', async () => {
    const { controller, planningService } = makeController({
      context: { user_id: 'u-op', team_ids: [TEAM_UUID] },
    });
    const req: FakeRequest = { user: { id: 'auth-uid' } };
    await runInTenant(() =>
      controller.getPlanning(req as never, validFrom, validTo, undefined, TEAM_UUID),
    );
    expect(planningService.getWindow).toHaveBeenCalledTimes(1);
  });

  it('passes through when the actor has a role assignment (operator path)', async () => {
    const { controller, planningService } = makeController({
      context: {
        user_id: 'u-op',
        role_assignments: [
          { domain_scope: [], location_scope_closure: [], read_only_cross_domain: false },
        ],
      },
    });
    const req: FakeRequest = { user: { id: 'auth-uid' } };
    await runInTenant(() =>
      controller.getPlanning(req as never, validFrom, validTo, undefined, undefined),
    );
    expect(planningService.getWindow).toHaveBeenCalledTimes(1);
  });

  it('passes through when the actor has tickets.read_all (admin override)', async () => {
    const { controller, planningService } = makeController({
      context: { user_id: 'u-admin', has_read_all: true },
    });
    const req: FakeRequest = { user: { id: 'auth-uid' } };
    await runInTenant(() =>
      controller.getPlanning(req as never, validFrom, validTo, undefined, undefined),
    );
    expect(planningService.getWindow).toHaveBeenCalledTimes(1);
  });
});
