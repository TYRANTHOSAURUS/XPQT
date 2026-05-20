/**
 * PersonController unit tests — R1 (handoff-residuals 2026-05-20).
 *
 * Regression: `GET /api/persons/me` previously returned HTTP 500
 * `unknown.server_error` because no `@Get('me')` route existed; the
 * `:id` route captured `'me'` → Postgres invalid-UUID → unwrapped raw
 * throw → global filter wrapped as `unknown.server_error`.
 *
 * Fix: explicit `@Get('me')` declared BEFORE `@Get(':id')` that resolves
 * the caller's own person via `AuthGuard`-attached `platformUserId`. All
 * failure paths use `AppError` factories per the error-handling spec.
 *
 * Review folds (R1 follow-up, 2026-05-20):
 *   - FIX 2 (plan-review I4): the "no users row" path (`person.not_found`
 *     404) and the "user exists but no linked person" path
 *     (`person.no_profile_link` 422) are now distinct codes/statuses, so
 *     the frontend can render "URL bug" vs "your profile isn't linked"
 *     differently. Both are covered.
 *   - FIX 3 (code-review item 1): the mocked Supabase chain captures the
 *     two `.eq(...)` calls so a refactor that drops the
 *     `.eq('tenant_id', ...)` binding fails the suite. Without this, the
 *     mock chain accepted any arguments and tenant-binding regressions
 *     were silent.
 *   - FIX 4 (code-review item 2): the captured `.select(...)` string
 *     argument is asserted to contain the canonical
 *     `persons!person_id` substring so an alias drift that breaks
 *     hydration is caught.
 *
 * R1 tertiary fold (codex P0, 2026-05-20):
 *   - FIX A: split the original single-join read into a two-query
 *     sequence (users → persons), defense-in-depth against a bad/
 *     back-filled `users.person_id` FK pointing at a foreign-tenant
 *     `persons` row (the FK at 00003:38 is NOT composite-tenant-scoped
 *     and the service-role admin client bypasses RLS). The harness now
 *     wires TWO from-mocks (`users` then `persons`) and the
 *     FK-points-to-wrong-tenant defense test asserts the second persons
 *     query's `.eq('tenant_id', ...)` filter catches a row the bad FK
 *     points at.
 *   - FIX B: missing `platformUserId` now throws
 *     `auth.guard_contract_violation` 500 (NOT `auth.unauthorized` 401).
 *     If AuthGuard ran successfully it WILL be set; if it's missing the
 *     guard chain is broken — a server/config bug, not a credential bug.
 *     A 401 would loop the client through reauth forever.
 *
 * Coverage:
 *   1. Happy path — returns the joined person row.
 *   2. Missing `platformUserId` (defensive — AuthGuard would normally have
 *      already 401'd) → `auth.guard_contract_violation` 500 (FIX B).
 *   3. Supabase error on the users read → `person.lookup_failed` 500.
 *   4. `data.person_id` null (user exists, no linked person) →
 *      `person.no_profile_link` 422 (NOT `person.not_found`).
 *   5. No `users` row found (cross-tenant slip would normally never
 *      happen because AuthGuard already gated on this; defensive) →
 *      `person.not_found` 404.
 *   6. Bad FK / cross-tenant FK — `users.person_id` points at a `persons`
 *      row in a DIFFERENT tenant; the second query's `.eq('tenant_id', ...)`
 *      filter rejects → `person.no_profile_link` 422, not a 200 leak (FIX A).
 *   7. Tenant binding — users query: `.eq('tenant_id', TENANT_ID)`.
 *   8. Tenant binding — persons query: `.eq('tenant_id', TENANT_ID)` is
 *      called with the EXACT current tenant id (FIX A defense-in-depth).
 *   9. Select-string regression guard — the persons `.select(...)` argument
 *      literally contains `primary_membership` and does NOT contain `*`.
 *  10. Supabase error on the persons read → `person.lookup_failed` 500.
 */

import type { Request } from 'express';
import { AppError } from '../../common/errors';
import { TenantContext } from '../../common/tenant-context';
import { PersonController } from './person.controller';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PLATFORM_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_PERSON_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface HarnessOpts {
  /**
   * `usersRow`: shape returned by the users query.
   *   - `undefined` (default) → happy-path user with PERSON_ID linked.
   *   - explicit value → use as-is.
   *   - `null` → simulate "no users row".
   */
  usersRow?: { id: string; person_id: string | null } | null;
  usersError?: { message: string; code?: string } | null;
  /**
   * `personsRow`: shape returned by the persons query.
   *   - `undefined` (default) → happy-path person.
   *   - explicit value → use as-is.
   *   - `null` → simulate "row missing or in another tenant" (the
   *     post-`.eq('tenant_id', ...)` result for a cross-tenant FK).
   */
  personsRow?: Record<string, unknown> | null;
  personsError?: { message: string; code?: string } | null;
}

interface UserQueryCapture {
  select: jest.Mock;
  eqId: jest.Mock;
  eqTenant: jest.Mock;
  maybeSingle: jest.Mock;
}

interface PersonQueryCapture {
  select: jest.Mock;
  eqId: jest.Mock;
  eqTenant: jest.Mock;
  maybeSingle: jest.Mock;
}

function makeHarness(opts: HarnessOpts = {}) {
  jest
    .spyOn(TenantContext, 'current')
    .mockReturnValue({ id: TENANT_ID, slug: 'acme', tier: 'standard' });

  const usersRow =
    opts.usersRow === undefined
      ? { id: PLATFORM_USER_ID, person_id: PERSON_ID }
      : opts.usersRow;

  const personsRow =
    opts.personsRow === undefined
      ? {
          id: PERSON_ID,
          first_name: 'Otak',
          last_name: 'Batak',
          email: 'otakbatak@gmail.com',
          primary_membership: [],
        }
      : opts.personsRow;

  // Users query chain: from('users').select(...).eq('id', x).eq('tenant_id', y).maybeSingle()
  const usersMaybeSingle = jest.fn(async () => ({
    data: usersRow,
    error: opts.usersError ?? null,
  }));
  const usersEqTenant = jest.fn(() => ({ maybeSingle: usersMaybeSingle }));
  const usersEqId = jest.fn(() => ({ eq: usersEqTenant }));
  const usersSelect = jest.fn(() => ({ eq: usersEqId }));

  // Persons query chain: from('persons').select(...).eq('id', x).eq('tenant_id', y).maybeSingle()
  const personsMaybeSingle = jest.fn(async () => ({
    data: personsRow,
    error: opts.personsError ?? null,
  }));
  const personsEqTenant = jest.fn(() => ({ maybeSingle: personsMaybeSingle }));
  const personsEqId = jest.fn(() => ({ eq: personsEqTenant }));
  const personsSelect = jest.fn(() => ({ eq: personsEqId }));

  const userQuery: UserQueryCapture = {
    select: usersSelect,
    eqId: usersEqId,
    eqTenant: usersEqTenant,
    maybeSingle: usersMaybeSingle,
  };
  const personQuery: PersonQueryCapture = {
    select: personsSelect,
    eqId: personsEqId,
    eqTenant: personsEqTenant,
    maybeSingle: personsMaybeSingle,
  };

  const from = jest.fn((table: string) => {
    if (table === 'users') return { select: usersSelect };
    if (table === 'persons') return { select: personsSelect };
    return {};
  });

  const supabase = { admin: { from } };

  const permissions = { requirePermission: jest.fn() };
  const controller = new PersonController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (require('./person.service').PersonService)(supabase as any),
    permissions as never,
  );
  return { controller, userQuery, personQuery, from };
}

function makeReq(opts: { platformUserId?: string | null } = {}): Request {
  // `null` = caller wants `user.platformUserId` explicitly absent (defensive
  // path probe). `undefined` (or no arg) = use the happy-path default.
  const platformUserId =
    opts.platformUserId === undefined ? PLATFORM_USER_ID : opts.platformUserId;
  return {
    user:
      platformUserId === null
        ? { id: 'auth-uid' }
        : { id: 'auth-uid', platformUserId },
    headers: {},
  } as unknown as Request;
}

describe('PersonController.getMe (R1 + tertiary fold)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the joined person row on the happy path', async () => {
    const h = makeHarness();
    const result = await h.controller.getMe(makeReq());
    expect(result).toMatchObject({
      id: PERSON_ID,
      first_name: 'Otak',
      last_name: 'Batak',
    });
    // Both queries fired (users then persons).
    expect(h.userQuery.maybeSingle).toHaveBeenCalledTimes(1);
    expect(h.personQuery.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('throws auth.guard_contract_violation 500 when platformUserId is missing (FIX B — 500 not 401)', async () => {
    const h = makeHarness();
    const err = await h.controller.getMe(makeReq({ platformUserId: null })).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 500,
      code: 'auth.guard_contract_violation',
    });
    // No DB calls were made.
    expect(h.userQuery.maybeSingle).not.toHaveBeenCalled();
    expect(h.personQuery.maybeSingle).not.toHaveBeenCalled();
  });

  it('throws person.lookup_failed 500 when the users read errors', async () => {
    const h = makeHarness({
      usersError: { message: 'connection reset', code: 'PGRST500' },
    });
    const err = await h.controller.getMe(makeReq()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 500,
      code: 'person.lookup_failed',
    });
    // Persons query MUST NOT have fired — short-circuited on users error.
    expect(h.personQuery.maybeSingle).not.toHaveBeenCalled();
  });

  it('throws person.lookup_failed 500 when the persons read errors', async () => {
    const h = makeHarness({
      personsError: { message: 'pg dropped connection', code: 'PGRST500' },
    });
    const err = await h.controller.getMe(makeReq()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 500,
      code: 'person.lookup_failed',
    });
    // Both queries fired (users succeeded, persons errored).
    expect(h.userQuery.maybeSingle).toHaveBeenCalledTimes(1);
    expect(h.personQuery.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('throws person.no_profile_link 422 when the user row has person_id=null (FIX 2 — distinct from not_found)', async () => {
    const h = makeHarness({
      usersRow: { id: PLATFORM_USER_ID, person_id: null },
    });
    const err = await h.controller.getMe(makeReq()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 422,
      code: 'person.no_profile_link',
    });
    // The persons query MUST NOT have fired — no FK to follow.
    expect(h.personQuery.maybeSingle).not.toHaveBeenCalled();
  });

  it('throws person.not_found 404 when no users row matches (genuinely missing)', async () => {
    const h = makeHarness({ usersRow: null });
    await expect(h.controller.getMe(makeReq())).rejects.toMatchObject({
      status: 404,
      code: 'person.not_found',
    });
    // The persons query MUST NOT have fired — no users row to deref.
    expect(h.personQuery.maybeSingle).not.toHaveBeenCalled();
  });

  it('FIX A (codex P0) — bad FK / cross-tenant FK: users.person_id points at a row in another tenant, the persons .eq(tenant_id) filter catches it and surfaces as 422 (NOT a 200 leak)', async () => {
    // The bad-FK scenario: users.person_id = FOREIGN_PERSON_ID (which lives
    // in tenant FOREIGN_TENANT_ID). The persons query asks for
    //   id=FOREIGN_PERSON_ID AND tenant_id=TENANT_ID
    // → 0 rows → null. We simulate that here by returning null from the
    // persons read, then asserting:
    //  (a) the persons query DID fire with the bad FK as the id filter
    //      AND with the CURRENT tenant id (NOT the foreign one) — proving
    //      the defense-in-depth filter is what caught the leak,
    //  (b) the response surfaces as person.no_profile_link 422 — not a
    //      200 with a foreign person.
    const h = makeHarness({
      usersRow: { id: PLATFORM_USER_ID, person_id: FOREIGN_PERSON_ID },
      personsRow: null,
    });
    const err = await h.controller.getMe(makeReq()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 422,
      code: 'person.no_profile_link',
    });
    // The persons query DID fire (proves we attempted the second read).
    expect(h.personQuery.eqId).toHaveBeenCalledWith('id', FOREIGN_PERSON_ID);
    // CRITICAL: the tenant filter on the persons read was the CURRENT
    // tenant, NOT the foreign tenant. This is the defense — RLS doesn't
    // catch the leak under the admin client, but the explicit
    // .eq('tenant_id', current) does.
    expect(h.personQuery.eqTenant).toHaveBeenCalledWith('tenant_id', TENANT_ID);
    // Sanity: did NOT accidentally use FOREIGN_TENANT_ID as the filter.
    expect(h.personQuery.eqTenant).not.toHaveBeenCalledWith(
      'tenant_id',
      FOREIGN_TENANT_ID,
    );
  });

  it('binds the tenant filter on the users query (FIX 3 — tenant-binding regression guard)', async () => {
    const h = makeHarness();
    await h.controller.getMe(makeReq());
    // First .eq binds the user id; second .eq binds the tenant. Drop
    // either one and these assertions fail.
    expect(h.userQuery.eqId).toHaveBeenCalledWith('id', PLATFORM_USER_ID);
    expect(h.userQuery.eqTenant).toHaveBeenCalledWith('tenant_id', TENANT_ID);
  });

  it('binds the tenant filter on the persons query (FIX A — defense-in-depth)', async () => {
    const h = makeHarness();
    await h.controller.getMe(makeReq());
    expect(h.personQuery.eqId).toHaveBeenCalledWith('id', PERSON_ID);
    expect(h.personQuery.eqTenant).toHaveBeenCalledWith('tenant_id', TENANT_ID);
  });

  it('uses an explicit persons select projection (FIX 4 — select-string regression guard)', async () => {
    const h = makeHarness();
    await h.controller.getMe(makeReq());
    expect(h.personQuery.select).toHaveBeenCalledTimes(1);
    const personsSelectArg = h.personQuery.select.mock.calls[0]?.[0];
    expect(typeof personsSelectArg).toBe('string');
    // The persons projection MUST include primary_membership (alias drift
    // here breaks the canonical /admin/persons binding).
    expect(personsSelectArg as string).toContain('primary_membership');
    // DTO scrub (FIX 1): make sure we're NOT shipping the wildcard back.
    // If a future change re-introduces `*` this assertion catches it
    // before it leaks HR columns to the requester.
    expect(personsSelectArg as string).not.toContain('*');
    // The users query select MUST be a narrow projection — id + person_id
    // only. A regression that re-introduces a wildcard or a relational
    // hydration here also fails this guard.
    expect(h.userQuery.select).toHaveBeenCalledTimes(1);
    const usersSelectArg = h.userQuery.select.mock.calls[0]?.[0];
    expect(typeof usersSelectArg).toBe('string');
    expect(usersSelectArg as string).toContain('person_id');
    expect(usersSelectArg as string).not.toContain('persons!person_id');
    expect(usersSelectArg as string).not.toContain('*');
  });
});
