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
 *     `persons:persons!person_id` substring so an alias drift (e.g.
 *     `person:persons!person_id`) — which would silently break the
 *     hydration path under the mock since the mock fakes `data.persons`
 *     unconditionally — fails the suite.
 *
 * Coverage:
 *   1. Happy path — returns the joined person row.
 *   2. Missing `platformUserId` (defensive — AuthGuard would normally have
 *      already 401'd) → `auth.unauthorized` 401.
 *   3. Supabase error → `person.lookup_failed` 500.
 *   4. `data.person_id` null (user exists, no linked person) →
 *      `person.no_profile_link` 422 (NOT `person.not_found`).
 *   5. No `users` row found (cross-tenant slip would normally never
 *      happen because AuthGuard already gated on this; defensive) →
 *      `person.not_found` 404.
 *   6. Persons join returned as a single-element array (PostgREST
 *      cardinality variance) is still unwrapped correctly.
 *   7. Tenant binding — the `.eq('tenant_id', TENANT_ID)` call happens
 *      with the exact tenant id from `TenantContext.current()`. Fails if
 *      the tenant filter is dropped or replaced.
 *   8. Select-string regression guard — the `.select(...)` argument
 *      literally contains `persons:persons!person_id`. Fails on alias
 *      drift.
 *   9. `persons` resolves to an empty array (PostgREST returned no
 *      embedded row even though person_id is set) → also
 *      `person.no_profile_link` 422.
 */

import type { Request } from 'express';
import { AppError } from '../../common/errors';
import { TenantContext } from '../../common/tenant-context';
import { PersonController } from './person.controller';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PLATFORM_USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSON_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface HarnessOpts {
  usersRow?: {
    id: string;
    person_id: string | null;
    persons:
      | Record<string, unknown>
      | Record<string, unknown>[]
      | null;
  } | null;
  supabaseError?: { message: string; code?: string } | null;
}

function makeHarness(opts: HarnessOpts = {}) {
  jest
    .spyOn(TenantContext, 'current')
    .mockReturnValue({ id: TENANT_ID, slug: 'acme', tier: 'standard' });

  const usersRow =
    opts.usersRow === undefined
      ? {
          id: PLATFORM_USER_ID,
          person_id: PERSON_ID,
          persons: {
            id: PERSON_ID,
            first_name: 'Otak',
            last_name: 'Batak',
            email: 'otakbatak@gmail.com',
            primary_membership: [],
          },
        }
      : opts.usersRow;

  const maybeSingle = jest.fn(async () => ({
    data: usersRow,
    error: opts.supabaseError ?? null,
  }));

  // FIX 3 + FIX 4 (R1 review folds, 2026-05-20): observable `.select(...)`
  // + `.eq(...)` capture. The chain has to STAY a chain (the impl does
  // `.from('users').select(...).eq(...).eq(...).maybeSingle()`), so each
  // step returns the next link — but every step is now a real `jest.fn`
  // we can introspect afterwards. This is what catches both:
  //   - tenant-binding drops (FIX 3): if `.eq('tenant_id', ...)` is
  //     removed, the second `eq` call disappears from the call log and
  //     the dedicated assertion fails.
  //   - select-string alias drift (FIX 4): if the projection is renamed
  //     from `persons:persons!person_id` to `person:persons!person_id`,
  //     the runtime mock still hydrates `data.persons` (which is fake),
  //     so the legacy spec passed. The substring assertion below catches
  //     that silently-broken case.
  const eqTenant = jest.fn(() => ({ maybeSingle }));
  const eqId = jest.fn(() => ({ eq: eqTenant }));
  const select = jest.fn(() => ({ eq: eqId }));

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'users') {
          return { select };
        }
        return {};
      }),
    },
  };

  const permissions = { requirePermission: jest.fn() };
  const controller = new PersonController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new (require('./person.service').PersonService)(supabase as any),
    permissions as never,
  );
  return { controller, maybeSingle, select, eqId, eqTenant };
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

describe('PersonController.getMe (R1)', () => {
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
    expect(h.maybeSingle).toHaveBeenCalledTimes(1);
  });

  it('throws auth.unauthorized 401 when platformUserId is missing', async () => {
    const h = makeHarness();
    await expect(
      h.controller.getMe(makeReq({ platformUserId: null })),
    ).rejects.toMatchObject({
      status: 401,
      code: 'auth.unauthorized',
    });
    expect(h.maybeSingle).not.toHaveBeenCalled();
  });

  it('throws person.lookup_failed 500 when supabase returns an error', async () => {
    const h = makeHarness({
      supabaseError: { message: 'connection reset', code: 'PGRST500' },
    });
    const err = await h.controller.getMe(makeReq()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 500,
      code: 'person.lookup_failed',
    });
  });

  it('throws person.no_profile_link 422 when the user row has person_id=null (FIX 2 — distinct from not_found)', async () => {
    const h = makeHarness({
      usersRow: {
        id: PLATFORM_USER_ID,
        person_id: null,
        persons: null,
      },
    });
    const err = await h.controller.getMe(makeReq()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 422,
      code: 'person.no_profile_link',
    });
  });

  it('throws person.no_profile_link 422 when persons join is an empty array (FIX 2 — embedded miss)', async () => {
    const h = makeHarness({
      usersRow: {
        id: PLATFORM_USER_ID,
        person_id: PERSON_ID,
        persons: [],
      },
    });
    const err = await h.controller.getMe(makeReq()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 422,
      code: 'person.no_profile_link',
    });
  });

  it('throws person.not_found 404 when no users row matches (genuinely missing)', async () => {
    const h = makeHarness({ usersRow: null });
    await expect(h.controller.getMe(makeReq())).rejects.toMatchObject({
      status: 404,
      code: 'person.not_found',
    });
  });

  it('unwraps the persons join when PostgREST returns a single-element array', async () => {
    const h = makeHarness({
      usersRow: {
        id: PLATFORM_USER_ID,
        person_id: PERSON_ID,
        persons: [
          {
            id: PERSON_ID,
            first_name: 'Array',
            last_name: 'Shape',
            primary_membership: [],
          },
        ],
      },
    });
    const result = (await h.controller.getMe(makeReq())) as {
      id: string;
      first_name: string;
    };
    expect(result.id).toBe(PERSON_ID);
    expect(result.first_name).toBe('Array');
  });

  it('binds the tenant filter on the users query (FIX 3 — tenant-binding regression guard)', async () => {
    const h = makeHarness();
    await h.controller.getMe(makeReq());
    // First .eq binds the user id; second .eq binds the tenant. Drop
    // either one and this assertion fails.
    expect(h.eqId).toHaveBeenCalledWith('id', PLATFORM_USER_ID);
    expect(h.eqTenant).toHaveBeenCalledWith('tenant_id', TENANT_ID);
  });

  it('uses the canonical persons:persons!person_id select alias (FIX 4 — alias regression guard)', async () => {
    const h = makeHarness();
    await h.controller.getMe(makeReq());
    expect(h.select).toHaveBeenCalledTimes(1);
    const selectArg = h.select.mock.calls[0]?.[0];
    expect(typeof selectArg).toBe('string');
    expect(selectArg as string).toContain('persons:persons!person_id');
    // DTO scrub (FIX 1): make sure we're NOT shipping the wildcard back.
    // If a future change re-introduces `*` inside the persons join this
    // assertion catches it before it leaks HR columns to the requester.
    expect(selectArg as string).not.toMatch(/persons!person_id\(\*/);
  });
});
