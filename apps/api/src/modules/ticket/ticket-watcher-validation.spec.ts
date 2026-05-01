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
  // TicketService takes seven deps; for the watcher-validation gate we
  // only exercise supabase + visibility + slaService, so the rest are
  // no-op stubs. Constructor order must match — see ticket.service.ts.
  return new TicketService(
    deps.supabase as never,         // 1. supabase
    {} as never,                     // 2. routingService
    deps.slaService as never,        // 3. slaService
    {} as never,                     // 4. workflowEngine
    {} as never,                     // 5. approvalService
    deps.visibility as never,        // 6. visibility
    {} as never,                     // 7. scopeOverrides
  );
}

// Real auth uid — validation runs (SYSTEM_ACTOR bypasses by design).
const REAL_PERSON = '11111111-1111-1111-1111-111111111111';
const OTHER_REAL_PERSON = '22222222-2222-2222-2222-222222222222';
const GHOST_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('TicketService.update — watcher uuid tenant validation', () => {
  beforeEach(() => {
    jest
      .spyOn(require('../../common/tenant-context').TenantContext, 'current')
      .mockReturnValue({ id: TENANT, slug: TENANT });
  });

  afterEach(() => jest.restoreAllMocks());

  it('rejects watchers that include a ghost uuid (well-formed but unknown)', async () => {
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: null,
        title: 't', description: null,
      },
      { persons_in_tenant: [REAL_PERSON, OTHER_REAL_PERSON] },
    );
    const svc = makeSvc(deps);

    await expect(
      svc.update(TICKET_ID, { watchers: [REAL_PERSON, GHOST_UUID] }, 'real-uid'),
    ).rejects.toThrow(/unknown person id\(s\)/);
    expect(deps.updates).toHaveLength(0);
  });

  it('rejects watchers with malformed uuid (clean 400 with offending value)', async () => {
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: null,
        title: 't', description: null,
      },
      { persons_in_tenant: [REAL_PERSON] },
    );
    const svc = makeSvc(deps);

    await expect(
      svc.update(TICKET_ID, { watchers: [REAL_PERSON, 'not-a-uuid'] }, 'real-uid'),
    ).rejects.toThrow(/malformed uuid/);
    expect(deps.updates).toHaveLength(0);
  });

  it('accepts watchers that all reference real persons in the tenant', async () => {
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: null,
        title: 't', description: null,
      },
      { persons_in_tenant: [REAL_PERSON, OTHER_REAL_PERSON] },
    );
    const svc = makeSvc(deps);

    await svc.update(
      TICKET_ID,
      { watchers: [REAL_PERSON, OTHER_REAL_PERSON] },
      'real-uid',
    );

    expect(deps.updates.find((u) => Array.isArray(u.watchers))).toBeDefined();
  });

  it('skips validation when watchers is unchanged (not in DTO)', async () => {
    // No watchers in DTO at all — validator must not even SELECT persons.
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: [REAL_PERSON],
        title: 't', description: null,
      },
      { persons_in_tenant: [REAL_PERSON] },
    );
    const svc = makeSvc(deps);

    await svc.update(TICKET_ID, { title: 'updated' }, 'real-uid');

    // No throw. Title write present.
    expect(deps.updates.find((u) => u.title === 'updated')).toBeDefined();
  });

  it('skips validation when watchers is set to empty array', async () => {
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: [REAL_PERSON],
        title: 't', description: null,
      },
      { persons_in_tenant: [REAL_PERSON] },
    );
    const svc = makeSvc(deps);

    await svc.update(TICKET_ID, { watchers: [] }, 'real-uid');

    expect(
      deps.updates.find(
        (u) => Array.isArray(u.watchers) && (u.watchers as unknown[]).length === 0,
      ),
    ).toBeDefined();
  });

  it('SYSTEM_ACTOR bypasses watcher validation (gate convention)', async () => {
    const deps = makeDeps(
      {
        id: TICKET_ID, tenant_id: TENANT,
        status_category: 'new', watchers: null,
        title: 't', description: null,
      },
      { persons_in_tenant: [] }, // intentionally empty.
    );
    const svc = makeSvc(deps);

    // GHOST_UUID would reject for real-uid; SYSTEM_ACTOR bypasses entirely.
    await svc.update(TICKET_ID, { watchers: [GHOST_UUID] }, SYSTEM_ACTOR);

    expect(
      deps.updates.find((u) => Array.isArray(u.watchers)),
    ).toBeDefined();
  });
});
