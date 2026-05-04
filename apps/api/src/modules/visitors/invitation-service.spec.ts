/**
 * InvitationService.create — visitor-first invite flow unit tests.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6
 *
 * The service depends on:
 *   - SupabaseService (admin) for tenant lookups (visitor types, dedup,
 *     persons row create/find, visitors INSERT, visitor_hosts INSERT,
 *     visit_invitation_tokens INSERT, location-scope check via
 *     portal_authorized_space_ids RPC).
 *   - PersonService for the persons row create.
 *
 * We mock the Supabase admin client at the .from(table) / .rpc(name)
 * boundary — the same pattern used by approval.service.spec.ts.
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { InvitationService } from './invitation.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACTOR_PERSON_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BUILDING_ID = '33333333-3333-4333-8333-333333333333';
const TYPE_GUEST = '44444444-4444-4444-8444-444444444444';
const TYPE_INTERVIEW = '55555555-5555-4555-8555-555555555555';
const VISITOR_ID = '66666666-6666-4666-8666-666666666666';
const VISITOR_PERSON_ID = '77777777-7777-4777-8777-777777777777';
const CO_HOST_PERSON_ID = '88888888-8888-4888-8888-888888888888';

interface FakeOptions {
  /** Spaces in the inviter's authorized closure. Defaults to [BUILDING_ID]. */
  authorizedSpaces?: string[];
  /** Visitor types this tenant has, keyed by id. */
  visitorTypes?: Record<
    string,
    {
      id: string;
      tenant_id: string;
      requires_approval: boolean;
      allow_walk_up: boolean;
      default_expected_until_offset_minutes: number;
      active: boolean;
    }
  >;
  /** tenant_settings row. */
  tenantSettings?: { visitor_dedup_by_email: boolean } | null;
  /** Existing dedup-match persons row. When set, `findExistingVisitorPerson` returns it. */
  existingVisitorPersonByEmail?: { id: string; email: string } | null;
  /**
   * Plan A.2 / Commit 5: which person ids count as in-tenant for the
   * assertTenantOwnedAll co_host validation. Defaults to "every id is
   * in-tenant" so existing tests pass; tests that want to simulate a
   * cross-tenant co-host set this to a narrowed list.
   */
  tenantOwnedPersonIds?: string[];
  /** Inserted persons rows captured for assertion. */
  insertedPersons?: Array<Record<string, unknown>>;
  /** Inserted visitor row captured. */
  insertedVisitor?: Record<string, unknown>;
  /** Inserted visitor_hosts rows captured. */
  insertedHostsRows?: Array<Record<string, unknown>>;
  /** Inserted token rows captured. */
  insertedTokens?: Array<Record<string, unknown>>;
  /** Inserted approvals rows captured (when type requires_approval). */
  insertedApprovals?: Array<Record<string, unknown>>;
  /** Inserted audit_events rows captured. */
  insertedAudit?: Array<Record<string, unknown>>;
  /** Inserted domain_events rows captured. */
  insertedDomainEvents?: Array<Record<string, unknown>>;
}

function makeService(opts: FakeOptions = {}) {
  const types = opts.visitorTypes ?? {
    [TYPE_GUEST]: {
      id: TYPE_GUEST,
      tenant_id: TENANT_ID,
      requires_approval: false,
      allow_walk_up: true,
      default_expected_until_offset_minutes: 240,
      active: true,
    },
    [TYPE_INTERVIEW]: {
      id: TYPE_INTERVIEW,
      tenant_id: TENANT_ID,
      requires_approval: true,
      allow_walk_up: false,
      default_expected_until_offset_minutes: 240,
      active: true,
    },
  };
  const tenantSettings = opts.tenantSettings ?? { visitor_dedup_by_email: false };

  const insertedPersons: Array<Record<string, unknown>> = opts.insertedPersons ?? [];
  const insertedHostsRows: Array<Record<string, unknown>> = opts.insertedHostsRows ?? [];
  const insertedTokens: Array<Record<string, unknown>> = opts.insertedTokens ?? [];
  const insertedApprovals: Array<Record<string, unknown>> = opts.insertedApprovals ?? [];
  const insertedAudit: Array<Record<string, unknown>> = opts.insertedAudit ?? [];
  const insertedDomainEvents: Array<Record<string, unknown>> = opts.insertedDomainEvents ?? [];

  // Wrap an arbitrary terminal value into a thenable PostgrestFilterBuilder-shaped chain.
  const term = (terminal: unknown) => {
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;
    chain.select = passthrough;
    chain.eq = passthrough;
    chain.single = () => Promise.resolve(terminal);
    chain.maybeSingle = () => Promise.resolve(terminal);
    chain.then = (resolve: (v: unknown) => unknown) => resolve(terminal);
    return chain;
  };

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        switch (table) {
          case 'visitor_types':
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      maybeSingle: async () => {
                        // Look up the type that matches the .eq()'d id. We
                        // can't introspect the eq args from this static fake;
                        // emit them by capturing recent .eq invocations.
                        // Simpler: parse via getMatchedType.
                        return { data: getMatchedType(), error: null };
                      },
                    }),
                  }),
                }),
              }),
            };
          case 'tenant_settings':
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: tenantSettings, error: null }),
                }),
              }),
            };
          case 'persons':
            return {
              // Plan A.2 / Commit 5: invitation.create now calls
              // assertTenantOwnedAll('persons', co_host_person_ids, ...)
              // which uses .select('id').eq('tenant_id', ...).in('id', ids).
              // Existing dedup-by-email path still uses the deeper .eq() chain.
              // The chain object below supports BOTH terminal shapes by carrying
              // the call mode through.
              select: () => {
                const eqChain: Record<string, unknown> = {
                  eq: () => eqChain,
                  in: (_col: string, ids: string[]) => ({
                    then: (onFulfilled: (v: { data: Array<{ id: string }>; error: null }) => unknown) => {
                      // Filter to opts.tenantOwnedPersonIds if provided; default is "all in-tenant".
                      const allowed = opts.tenantOwnedPersonIds;
                      const data = allowed
                        ? ids.filter((id) => allowed.includes(id)).map((id) => ({ id }))
                        : ids.map((id) => ({ id }));
                      return Promise.resolve({ data, error: null }).then(onFulfilled);
                    },
                  }),
                  maybeSingle: async () => ({
                    data: opts.existingVisitorPersonByEmail ?? null,
                    error: null,
                  }),
                };
                return eqChain;
              },
              insert: (row: Record<string, unknown>) => ({
                select: () => ({
                  single: async () => {
                    const inserted = { id: VISITOR_PERSON_ID, ...row };
                    insertedPersons.push(inserted);
                    return { data: inserted, error: null };
                  },
                }),
              }),
            };
          case 'visitors':
            return {
              insert: (row: Record<string, unknown>) => ({
                select: () => ({
                  single: async () => {
                    const inserted = { id: VISITOR_ID, ...row };
                    opts.insertedVisitor = inserted;
                    return { data: inserted, error: null };
                  },
                }),
              }),
            };
          case 'visitor_hosts':
            return {
              insert: (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
                const arr = Array.isArray(rows) ? rows : [rows];
                insertedHostsRows.push(...arr);
                return Promise.resolve({ data: arr, error: null });
              },
            };
          case 'visit_invitation_tokens':
            return {
              insert: (row: Record<string, unknown>) => {
                insertedTokens.push(row);
                return Promise.resolve({ data: row, error: null });
              },
            };
          case 'approvals':
            return {
              insert: (row: Record<string, unknown>) => ({
                select: () => ({
                  single: async () => {
                    const inserted = { id: 'approval-id', ...row };
                    insertedApprovals.push(inserted);
                    return { data: inserted, error: null };
                  },
                }),
              }),
            };
          case 'audit_events':
            return {
              insert: (row: Record<string, unknown>) => {
                insertedAudit.push(row);
                return Promise.resolve({ data: row, error: null });
              },
            };
          case 'domain_events':
            return {
              insert: (row: Record<string, unknown>) => {
                insertedDomainEvents.push(row);
                return Promise.resolve({ data: row, error: null });
              },
            };
          default:
            return term({ data: null, error: null });
        }
      }),
      rpc: jest.fn(async (name: string, _args: Record<string, unknown>) => {
        if (name === 'portal_authorized_space_ids') {
          return {
            data: (opts.authorizedSpaces ?? [BUILDING_ID]).map((id) => ({ id })),
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    },
  };

  // Capture which visitor_type_id is being queried so the visitor_types
  // .from('visitor_types') chain returns the right row. We hold a mutable
  // ref the chain reads on .maybeSingle.
  let askedForTypeId: string | null = null;
  function getMatchedType() {
    return askedForTypeId ? types[askedForTypeId] ?? null : null;
  }
  const originalFrom = supabase.admin.from;
  supabase.admin.from = jest.fn((table: string) => {
    if (table === 'visitor_types') {
      // Wrap the existing chain so we capture the id from .eq('id', X).
      return {
        select: () => ({
          eq: (col: string, val: string) => ({
            eq: (col2: string, _val2: string) => ({
              eq: (col3: string, _val3: boolean) => ({
                maybeSingle: async () => {
                  if (col === 'id') askedForTypeId = val;
                  return { data: getMatchedType(), error: null };
                },
              }),
            }),
          }),
        }),
      };
    }
    return originalFrom(table);
  });

  jest.spyOn(TenantContext, 'current').mockReturnValue({ id: TENANT_ID } as never);

  const personService = {
    create: jest.fn(async (dto: Record<string, unknown>) => {
      const inserted = { id: VISITOR_PERSON_ID, ...dto };
      insertedPersons.push(inserted);
      return inserted;
    }),
  };

  const svc = new InvitationService(supabase as never, personService as never);

  return {
    svc,
    supabase,
    personService,
    insertedPersons,
    insertedHostsRows,
    insertedTokens,
    insertedApprovals,
    insertedAudit,
    insertedDomainEvents,
    getInsertedVisitor: () => opts.insertedVisitor,
  };
}

const ACTOR = {
  user_id: ACTOR_USER_ID,
  person_id: ACTOR_PERSON_ID,
  tenant_id: TENANT_ID,
};

const baseDto = () => ({
  first_name: 'Marleen',
  last_name: 'de Jong',
  email: 'marleen@example.com',
  phone: null,
  company: 'Acme BV',
  visitor_type_id: TYPE_GUEST,
  expected_at: '2026-05-02T09:00:00.000Z',
  building_id: BUILDING_ID,
  co_host_person_ids: [] as string[],
});

describe('InvitationService.create', () => {
  afterEach(() => jest.restoreAllMocks());

  it('happy path: creates persons + visitor + visitor_hosts + cancel token', async () => {
    const ctx = makeService();
    const result = await ctx.svc.create(baseDto(), ACTOR);

    expect(result.visitor_id).toBe(VISITOR_ID);
    expect(result.status).toBe('expected');
    expect(result.cancel_token).toBeTruthy();
    expect(typeof result.cancel_token).toBe('string');

    // Persons row created via PersonService.
    expect(ctx.personService.create).toHaveBeenCalledTimes(1);
    expect(ctx.personService.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'visitor', first_name: 'Marleen' }),
    );

    // Primary host row.
    expect(ctx.insertedHostsRows.find((h) => h.person_id === ACTOR_PERSON_ID)).toBeTruthy();

    // Cancel token row.
    expect(ctx.insertedTokens).toHaveLength(1);
    expect(ctx.insertedTokens[0]).toMatchObject({ purpose: 'cancel', tenant_id: TENANT_ID });
    expect(ctx.insertedTokens[0].token_hash).toBeTruthy();
    expect(ctx.insertedTokens[0].token_hash).not.toBe(result.cancel_token);

    // Audit event.
    expect(ctx.insertedAudit.some((a) => a.event_type === 'visitor.invited')).toBe(true);
  });

  it('approval-required type: status=pending_approval, no email enqueue, approval row inserted', async () => {
    const ctx = makeService();
    const result = await ctx.svc.create({ ...baseDto(), visitor_type_id: TYPE_INTERVIEW }, ACTOR);

    expect(result.status).toBe('pending_approval');
    expect(ctx.insertedApprovals).toHaveLength(1);
    expect(ctx.insertedApprovals[0]).toMatchObject({
      target_entity_type: 'visitor_invite',
      target_entity_id: VISITOR_ID,
      status: 'pending',
    });
  });

  it('cross-building scope: actor without scope on building_id throws ForbiddenException', async () => {
    const ctx = makeService({ authorizedSpaces: ['SOME-OTHER-BUILDING-ID'] });
    await expect(ctx.svc.create(baseDto(), ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('multi-host: creates one visitor_hosts row per co_host + one for primary', async () => {
    const ctx = makeService();
    await ctx.svc.create(
      { ...baseDto(), co_host_person_ids: [CO_HOST_PERSON_ID, '99999999-9999-4999-8999-999999999999'] },
      ACTOR,
    );
    // Three rows: primary actor + 2 co-hosts.
    expect(ctx.insertedHostsRows).toHaveLength(3);
    const personIds = ctx.insertedHostsRows.map((h) => h.person_id);
    expect(personIds).toEqual(
      expect.arrayContaining([ACTOR_PERSON_ID, CO_HOST_PERSON_ID, '99999999-9999-4999-8999-999999999999']),
    );
  });

  // Plan A.2 / Commit 5 / gap map §invitation.service.ts:159-165.
  it('rejects when co_host_person_ids contains a foreign-tenant person', async () => {
    const FOREIGN_PERSON = '00000000-0000-4000-8000-0000000fffff';
    const ctx = makeService({
      // Only the in-tenant co-host is registered as owned by this tenant.
      tenantOwnedPersonIds: [CO_HOST_PERSON_ID],
    });
    let caught: unknown = null;
    try {
      await ctx.svc.create(
        { ...baseDto(), co_host_person_ids: [CO_HOST_PERSON_ID, FOREIGN_PERSON] },
        ACTOR,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as Error & { response?: Record<string, unknown> }).response).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'persons',
      missing_ids: [FOREIGN_PERSON],
    });
    // No visitor_hosts row should have been written when validation fails.
    expect(ctx.insertedHostsRows).toEqual([]);
  });

  it('dedup ON: existing persons row reused (no new persons.create)', async () => {
    const ctx = makeService({
      tenantSettings: { visitor_dedup_by_email: true },
      existingVisitorPersonByEmail: { id: 'EXISTING-PERSON-ID', email: 'marleen@example.com' },
    });
    await ctx.svc.create(baseDto(), ACTOR);

    expect(ctx.personService.create).not.toHaveBeenCalled();
  });

  it('dedup OFF: new persons row even when an existing match exists', async () => {
    const ctx = makeService({
      tenantSettings: { visitor_dedup_by_email: false },
      existingVisitorPersonByEmail: { id: 'EXISTING-PERSON-ID', email: 'marleen@example.com' },
    });
    await ctx.svc.create(baseDto(), ACTOR);
    expect(ctx.personService.create).toHaveBeenCalledTimes(1);
  });

  it('unknown visitor_type: throws NotFoundException', async () => {
    const ctx = makeService({ visitorTypes: {} });
    await expect(ctx.svc.create(baseDto(), ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('emits visitor.invitation.expected domain_event with plaintext cancel_token in payload', async () => {
    // Regression for post-shipping review C2: the email worker reads the
    // plaintext cancel_token from domain_events.payload to render the
    // cancel-link URL. Migration 00269 revokes SELECT/INSERT/UPDATE/DELETE
    // on public.domain_events from anon + authenticated, so the plaintext
    // is service-role-only on the wire. This test pins the contract on the
    // worker side: the payload MUST contain the same plaintext that
    // create() returns to its caller.
    const ctx = makeService();
    const result = await ctx.svc.create(baseDto(), ACTOR);

    const expectedEvent = ctx.insertedDomainEvents.find(
      (e) => e.event_type === 'visitor.invitation.expected',
    );
    expect(expectedEvent).toBeTruthy();
    const payload = expectedEvent!.payload as Record<string, unknown>;
    expect(payload.cancel_token).toBe(result.cancel_token);
    expect(payload.visitor_id).toBe(VISITOR_ID);
    // Sanity: the plaintext is high-entropy hex (not a sha256 hash from the token row).
    expect(typeof payload.cancel_token).toBe('string');
    expect((payload.cancel_token as string).length).toBe(64);
    expect(payload.cancel_token).not.toBe(ctx.insertedTokens[0].token_hash);
  });

  it('expected_until defaults from visitor_type.default_expected_until_offset_minutes', async () => {
    const ctx = makeService();
    await ctx.svc.create(baseDto(), ACTOR);
    const v = ctx.getInsertedVisitor();
    expect(v).toBeTruthy();
    // expected_at + 240 minutes = +4h.
    const expectedAt = new Date('2026-05-02T09:00:00.000Z').getTime();
    const got = new Date(v!.expected_until as string).getTime();
    expect(got - expectedAt).toBe(240 * 60 * 1000);
  });

  it('writes both primary_host_person_id and host_person_id (legacy adapter alignment)', async () => {
    const ctx = makeService();
    await ctx.svc.create(baseDto(), ACTOR);
    const v = ctx.getInsertedVisitor()!;
    expect(v.primary_host_person_id).toBe(ACTOR_PERSON_ID);
    expect(v.host_person_id).toBe(ACTOR_PERSON_ID);
  });

  it('writes visit_date derived from expected_at to satisfy legacy NOT NULL', async () => {
    // Regression: migration 00015 made `visit_date` (DATE) NOT NULL. The v1
    // rebuild moved to `expected_at` (TIMESTAMPTZ) but never dropped the
    // legacy column, so any insert that omits `visit_date` 500s with
    // `null value in column "visit_date" violates not-null constraint`.
    // Both POST /visitors/invitations (this path) and the booking-composer
    // flush (same path, populated by booking-composer.tsx) hit it.
    // The fix derives `visit_date` from expected_at::date and includes it
    // in the insert payload — kept in sync so the privacy adapter's
    // `coalesce(expected_at::date, visit_date)` filter is consistent.
    const ctx = makeService();
    await ctx.svc.create(baseDto(), ACTOR);
    const v = ctx.getInsertedVisitor()!;
    // expected_at = 2026-05-02T09:00:00.000Z → date = 2026-05-02 (UTC).
    expect(v.visit_date).toBe('2026-05-02');
  });
});
