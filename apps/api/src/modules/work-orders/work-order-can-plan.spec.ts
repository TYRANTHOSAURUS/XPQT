// Tests for WorkOrderService.canPlan — the read-side gate that powers the
// FE's "show or hide the Plan affordance" decision (GET /work-orders/:id/can-plan).
//
// Three branches must be locked in:
//   1. SYSTEM_ACTOR short-circuits to {canPlan: true} without a visibility round-trip
//      (cron / workflow callers don't need permission checks).
//   2. assertCanPlan throws ForbiddenException → {canPlan: false} (the affordance hides).
//   3. assertCanPlan throws any OTHER error → propagate (don't let a real schema bug
//      silently degrade into a hidden affordance — codex round 1 finding #6 lock-in).
//
// Mock pattern mirrors work-order-set-plan.spec.ts (hand-rolled supabase chain),
// but most of it is unused here — canPlan only touches the visibility service.

import { ForbiddenException } from '@nestjs/common';
import { WorkOrderService, SYSTEM_ACTOR } from './work-order.service';

const TENANT = 't1';

function makeDeps(opts: { canPlanThrows?: Error | null } = {}) {
  const supabase = {
    admin: {
      from: jest.fn(() => {
        throw new Error('canPlan should not touch the database');
      }),
      rpc: jest.fn(() => {
        throw new Error('canPlan should not call any RPC');
      }),
    },
  };

  const slaService = {};

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: 'u1', person_id: 'p1', tenant_id: TENANT,
      team_ids: [], role_assignments: [], vendor_id: null,
      has_read_all: false, has_write_all: false,
    }),
    assertCanPlan: jest.fn(async () => {
      if (opts.canPlanThrows) throw opts.canPlanThrows;
    }),
  };

  return { supabase, slaService, visibility };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  return new WorkOrderService(
    deps.supabase as never,
    deps.slaService as never,
    deps.visibility as never,
  );
}

describe('WorkOrderService.canPlan', () => {
  beforeEach(() => {
    jest.spyOn(
      require('../../common/tenant-context').TenantContext,
      'current',
    ).mockReturnValue({ id: TENANT, slug: TENANT });
  });

  it('returns canPlan: true for SYSTEM_ACTOR without invoking visibility', async () => {
    const deps = makeDeps();
    const svc = makeSvc(deps);

    const result = await svc.canPlan('wo1', SYSTEM_ACTOR);

    expect(result).toEqual({ canPlan: true });
    // SYSTEM_ACTOR shortcut means no auth round-trip happens.
    expect(deps.visibility.loadContext).not.toHaveBeenCalled();
    expect(deps.visibility.assertCanPlan).not.toHaveBeenCalled();
  });

  it('returns canPlan: false when assertCanPlan throws ForbiddenException', async () => {
    const deps = makeDeps({
      canPlanThrows: new ForbiddenException('not allowed'),
    });
    const svc = makeSvc(deps);

    const result = await svc.canPlan('wo1', 'auth-uid-non-admin');

    expect(result).toEqual({ canPlan: false });
    // Confirm we DID try the gate (this isn't a SYSTEM_ACTOR shortcut path).
    expect(deps.visibility.loadContext).toHaveBeenCalledTimes(1);
    expect(deps.visibility.assertCanPlan).toHaveBeenCalledTimes(1);
  });

  it('propagates non-ForbiddenException errors instead of silently hiding the affordance', async () => {
    // Codex round 1 finding #6 lock-in: a bare `catch {}` would silently
    // turn schema bugs into "affordance is hidden, no error visible." The
    // implementation deliberately catches ONLY ForbiddenException so real
    // failures surface as 500s the FE can render.
    const deps = makeDeps({
      canPlanThrows: new Error('database connection broken'),
    });
    const svc = makeSvc(deps);

    await expect(svc.canPlan('wo1', 'auth-uid-non-admin')).rejects.toThrow(
      'database connection broken',
    );
  });
});
