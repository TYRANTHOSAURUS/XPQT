// Tests for the watcher uuid tenant-validation pass added to
// TicketService.update. Mirror of the WO-side test in
// work-order-update-metadata.spec.ts. Defends against within-tenant
// unauthorized share + ghost uuids in `tickets.watchers`.

import { TicketService, SYSTEM_ACTOR } from './ticket.service';

type Row = {
  id: string;
  tenant_id: string;
  status_category: string;
  watchers: string[] | null;
  title: string;
  description: string | null;
};

const TENANT = 't1';
const TICKET_ID = 'tk1';

function makeDeps(
  initial: Row,
  options: { persons_in_tenant?: string[] } = {},
) {
  // Default: every uuid the tests use exists in the tenant. Tests
  // exercising rejection override.
  const personsInTenant = new Set(options.persons_in_tenant ?? ['p1', 'p2', 'p3']);
  let row = { ...initial };
  const updates: Array<Record<string, unknown>> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'tickets') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: async () => ({ data: row, error: null }),
                  maybeSingle: async () => ({ data: row, error: null }),
                }),
                single: async () => ({ data: row, error: null }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
              row = { ...row, ...patch };
              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({ single: async () => ({ data: row, error: null }) }),
                  }),
                }),
              };
            },
          } as unknown;
        }
        if (table === 'work_orders') {
          // Parent close-guard query path — return empty.
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  not: () => ({
                    async then(cb: (v: { data: Array<{ id: string }>; error: null }) => unknown) {
                      return cb({ data: [], error: null });
                    },
                  }),
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'persons') {
          return {
            select: () => ({
              eq: () => ({
                in: (_col: string, ids: string[]) => ({
                  then: (
                    resolve: (v: { data: Array<{ id: string }>; error: null }) => unknown,
                    reject: (e: unknown) => unknown,
                  ) =>
                    Promise.resolve({
                      data: ids
                        .filter((id) => personsInTenant.has(id))
                        .map((id) => ({ id })),
                      error: null,
                    }).then(resolve, reject),
                }),
              }),
            }),
          } as unknown;
        }
        if (table === 'users') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          } as unknown;
        }
        // Catch-all (ticket_activities, domain_events, etc.).
        return {
          insert: (_a: Record<string, unknown>) => ({
            select: () => ({
              single: async () => ({ data: null, error: null }),
            }),
            then: (resolve: (v: { data: null; error: null }) => unknown) =>
              Promise.resolve({ data: null, error: null }).then(resolve),
          }),
        } as unknown;
      }),
      rpc: jest.fn(async () => ({ data: null, error: null })),
    },
  };

  const slaService = {
    applyWaitingStateTransition: jest.fn(),
    applyResolvedTransition: jest.fn(),
    applyClosedTransition: jest.fn(),
    applyReopenTransition: jest.fn(),
  };

  const visibility = {
    loadContext: jest.fn().mockResolvedValue({
      user_id: 'u1', person_id: 'p1', tenant_id: TENANT,
      team_ids: [], role_assignments: [], vendor_id: null,
      has_read_all: false, has_write_all: true,
    }),
    assertVisible: jest.fn().mockResolvedValue(undefined),
    assertCanPlan: jest.fn().mockResolvedValue(undefined),
  };

  return { row: () => row, updates, supabase, slaService, visibility };
}

function makeSvc(deps: ReturnType<typeof makeDeps>) {
  // TicketService takes more dependencies than WorkOrderService; the
  // gates we care about (assertVisible + the watchers select) only
  // touch supabase + visibility, so the rest can be no-op stubs.
  return new TicketService(
    deps.supabase as never,
    deps.slaService as never,
    deps.visibility as never,
    {} as never, // notifications
    {} as never, // mail
    {} as never, // attachments
    {} as never, // search
    {} as never, // privacy
    {} as never, // routing
    {} as never, // approval
    {} as never, // workflow
  );
}

describe('TicketService.update — watcher uuid tenant validation', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue({ id: TENANT, slug: TENANT });
  });

  afterEach(() => jest.restoreAllMocks());

  it('rejects watchers that include a uuid not in the tenant', async () => {
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: null,
        title: 't', description: null,
      },
      { persons_in_tenant: ['p1', 'p2'] }, // 'pX' missing.
    );
    const svc = makeSvc(deps);

    await expect(
      svc.update(TICKET_ID, { watchers: ['p1', 'pX'] }, SYSTEM_ACTOR),
    ).rejects.toThrow(/unknown person id\(s\)/);
    expect(deps.updates).toHaveLength(0);
  });

  it('accepts watchers that all reference real persons in the tenant', async () => {
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: null,
        title: 't', description: null,
      },
      { persons_in_tenant: ['p1', 'p2'] },
    );
    const svc = makeSvc(deps);

    await svc.update(TICKET_ID, { watchers: ['p1', 'p2'] }, SYSTEM_ACTOR);

    expect(deps.updates.find((u) => Array.isArray(u.watchers))).toBeDefined();
  });

  it('skips validation when watchers is unchanged (not in DTO)', async () => {
    // No watchers in DTO at all — validator must not even SELECT persons.
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: ['p1'],
        title: 't', description: null,
      },
      { persons_in_tenant: ['p1'] },
    );
    const svc = makeSvc(deps);

    await svc.update(TICKET_ID, { title: 'updated' }, SYSTEM_ACTOR);

    // No throw. Title write present.
    expect(deps.updates.find((u) => u.title === 'updated')).toBeDefined();
  });

  it('skips validation when watchers is set to empty array', async () => {
    // Empty watchers array = "no watchers" — nothing to validate.
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: ['p1'],
        title: 't', description: null,
      },
      { persons_in_tenant: ['p1'] },
    );
    const svc = makeSvc(deps);

    await svc.update(TICKET_ID, { watchers: [] }, SYSTEM_ACTOR);

    // Update fires with watchers=[]; no rejection.
    expect(deps.updates.find((u) => Array.isArray(u.watchers) && (u.watchers as unknown[]).length === 0)).toBeDefined();
  });
});
