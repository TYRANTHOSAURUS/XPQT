import { BadRequestException } from '@nestjs/common';
import { BundleService } from './bundle.service';
import { TenantContext } from '../../common/tenant-context';
import type { AttachPlan } from './attach-plan.types';

/**
 * B.0.C.4 — `BundleService.buildAttachPlan` tight-unit tests.
 *
 * These cover the validation gates (client_line_id, idempotency key) and
 * the empty-plan path. The full hydration path (catalog lookup → menu
 * offer → rule resolver → asset reservation tenant check → approval
 * routing) is covered indirectly via `BookingFlowService.buildAttachPlan`'s
 * delegation tests + via the existing `attachServicesToBooking` spec
 * scaffolding which shares the same helpers.
 */

describe('BundleService.buildAttachPlan (B.0.C.4)', () => {
  const TENANT = { id: 'tenant-1', slug: 'acme', tier: 'standard' as const };
  const BOOKING_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  function makeService(): BundleService {
    return new BundleService(
      // Supabase isn't reachable in these tests; the no-services path never
      // touches the admin client. Validation throws before any DB call.
      { admin: {} } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  function baseBooking() {
    return {
      booking_id: BOOKING_ID,
      tenant_id: TENANT.id,
      booking: {
        location_id: '22222222-2222-2222-2222-222222222222',
        requester_person_id: '11111111-1111-1111-1111-111111111111',
        host_person_id: null,
        start_at: '2026-05-04T10:00:00Z',
        end_at: '2026-05-04T11:00:00Z',
        attendee_count: 4 as number | null,
        source: 'portal' as const,
      },
      requester_person_id: '11111111-1111-1111-1111-111111111111',
      idempotency_key: 'idem-1',
    };
  }

  it('rejects an empty idempotency_key', async () => {
    const svc = makeService();
    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.buildAttachPlan({ ...baseBooking(), idempotency_key: '', services: [] }),
      ).rejects.toThrow(/idempotency_key required/);
    });
  });

  it('rejects a missing tenant_id', async () => {
    const svc = makeService();
    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.buildAttachPlan({ ...baseBooking(), tenant_id: '', services: [] }),
      ).rejects.toThrow(/tenant_id required/);
    });
  });

  it('returns an empty plan when services is empty', async () => {
    const svc = makeService();
    const result = await TenantContext.run(TENANT, () =>
      svc.buildAttachPlan({ ...baseBooking(), services: [] }),
    );
    const expected: AttachPlan = {
      version: 1,
      any_pending_approval: false,
      any_deny: false,
      deny_messages: [],
      orders: [],
      asset_reservations: [],
      order_line_items: [],
      approvals: [],
      bundle_audit_payload: {
        bundle_id: BOOKING_ID,
        booking_id: BOOKING_ID,
        order_ids: [],
        order_line_item_ids: [],
        asset_reservation_ids: [],
        approval_ids: [],
        any_pending_approval: false,
      },
    };
    expect(result).toEqual(expected);
  });

  it('rejects a service line with missing client_line_id', async () => {
    const svc = makeService();
    await TenantContext.run(TENANT, async () => {
      await expect(
        svc.buildAttachPlan({
          ...baseBooking(),
          services: [{ catalog_item_id: 'c-1', quantity: 1 } /* no client_line_id */],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  it('rejects a service line with empty client_line_id', async () => {
    const svc = makeService();
    await TenantContext.run(TENANT, async () => {
      try {
        await svc.buildAttachPlan({
          ...baseBooking(),
          services: [
            { catalog_item_id: 'c-1', quantity: 1, client_line_id: '   ' },
          ],
        });
        fail('expected throw');
      } catch (err) {
        const ex = err as BadRequestException;
        expect(ex).toBeInstanceOf(BadRequestException);
        expect((ex.getResponse() as { code: string }).code).toBe('client_line_id_required');
      }
    });
  });

  it('rejects two service lines with the same client_line_id', async () => {
    const svc = makeService();
    await TenantContext.run(TENANT, async () => {
      try {
        await svc.buildAttachPlan({
          ...baseBooking(),
          services: [
            { catalog_item_id: 'c-1', quantity: 1, client_line_id: 'line-a' },
            { catalog_item_id: 'c-2', quantity: 1, client_line_id: 'line-a' },
          ],
        });
        fail('expected throw');
      } catch (err) {
        const ex = err as BadRequestException;
        expect(ex).toBeInstanceOf(BadRequestException);
        expect((ex.getResponse() as { code: string }).code).toBe('client_line_id_not_unique');
      }
    });
  });
});
