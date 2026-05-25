// Audit 02 / P1-5: getChildTasks must filter children through
// work_order_visibility_ids — not inherit parent-case visibility.
//
// This spec verifies:
//   1. A non-read_all actor who can read the parent but is NOT in
//      getVisibleWorkOrderIds result has that child excluded.
//   2. A has_read_all actor sees ALL children (rpc not used as filter).
//   3. SYSTEM_ACTOR bypasses all visibility (no loadContext / assertVisible).
import { TicketService, SYSTEM_ACTOR } from './ticket.service';

function makeSvc({
  childRows,
  visibleWoIds,
  hasReadAll = false,
}: {
  childRows: Array<{ id: string; title: string }>;
  visibleWoIds: string[] | null;  // null = has_read_all path (not called)
  hasReadAll?: boolean;
}) {
  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'work_orders') {
          return {
            select: jest.fn(() => ({
              eq: jest.fn(() => ({
                eq: jest.fn(() => ({
                  order: jest.fn(async () => ({ data: childRows, error: null })),
                })),
              })),
            })),
          };
        }
        return {} as unknown;
      }),
      rpc: jest.fn(async () => ({ data: false, error: null })),
    },
  };

  const getVisibleWorkOrderIds = jest.fn().mockResolvedValue(visibleWoIds);
  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: 'u1',
      tenant_id: 't1',
      has_read_all: hasReadAll,
    }),
    assertVisible: jest.fn().mockResolvedValue(undefined),
    getVisibleWorkOrderIds,
  };

  const svc = new TicketService(
    supabase as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    visibility as never,
    { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
  );

  return { svc, getVisibleWorkOrderIds, visibility };
}

describe('TicketService.getChildTasks — per-child visibility filter (audit02 P1-5)', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue({ id: 't1', subdomain: 't1' });
  });

  afterEach(() => jest.restoreAllMocks());

  it('excludes children whose id is not in getVisibleWorkOrderIds result', async () => {
    const { svc } = makeSvc({
      childRows: [
        { id: 'wo-visible', title: 'Visible WO' },
        { id: 'wo-hidden', title: 'Hidden WO' },
      ],
      visibleWoIds: ['wo-visible'],
      hasReadAll: false,
    });

    const result = await svc.getChildTasks('parent-1', 'auth-user');

    const ids = result.map((r) => r.id);
    expect(ids).toContain('wo-visible');
    expect(ids).not.toContain('wo-hidden');
  });

  it('includes all children when actor has_read_all (no per-child rpc filter)', async () => {
    const { svc, getVisibleWorkOrderIds } = makeSvc({
      childRows: [
        { id: 'wo-a', title: 'WO A' },
        { id: 'wo-b', title: 'WO B' },
      ],
      visibleWoIds: null,  // would be null for has_read_all
      hasReadAll: true,
    });

    const result = await svc.getChildTasks('parent-1', 'auth-admin');

    expect(result).toHaveLength(2);
    // getVisibleWorkOrderIds called but returns null → no filter applied
    expect(getVisibleWorkOrderIds).toHaveBeenCalled();
  });

  it('preserves ticket_kind=work_order on all returned children', async () => {
    const { svc } = makeSvc({
      childRows: [{ id: 'wo-1', title: 'WO' }],
      visibleWoIds: ['wo-1'],
      hasReadAll: false,
    });

    const result = await svc.getChildTasks('parent-1', 'auth-user');
    expect(result[0]).toMatchObject({ id: 'wo-1', ticket_kind: 'work_order' });
  });

  it('SYSTEM_ACTOR bypasses all visibility and returns all children', async () => {
    const { svc, visibility } = makeSvc({
      childRows: [
        { id: 'wo-a', title: 'A' },
        { id: 'wo-b', title: 'B' },
      ],
      visibleWoIds: null,
      hasReadAll: false,
    });

    const result = await svc.getChildTasks('parent-1', SYSTEM_ACTOR);

    expect(result).toHaveLength(2);
    expect(visibility.loadContext).not.toHaveBeenCalled();
    expect(visibility.assertVisible).not.toHaveBeenCalled();
  });

  it('returns [] immediately when no user_id and not has_read_all', async () => {
    const supabase = { admin: { from: jest.fn(), rpc: jest.fn() } };
    const visibility = {
      loadContext: jest.fn().mockResolvedValue({
        user_id: '',
        tenant_id: 't1',
        has_read_all: false,
      }),
      assertVisible: jest.fn().mockResolvedValue(undefined),
      getVisibleWorkOrderIds: jest.fn(),
    };
    const svc = new TicketService(
      supabase as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      visibility as never,
      { resolve: jest.fn().mockResolvedValue(null), resolveForLocation: jest.fn().mockResolvedValue(null), deriveEffectiveLocation: jest.fn().mockResolvedValue(null) } as never,
    );
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue({ id: 't1', subdomain: 't1' });

    const result = await svc.getChildTasks('parent-1', 'auth-no-user');
    expect(result).toEqual([]);
    expect(supabase.admin.from).not.toHaveBeenCalled();
  });
});
