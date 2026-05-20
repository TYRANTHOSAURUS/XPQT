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
 * Coverage:
 *   1. Happy path — returns the joined person row.
 *   2. Missing `platformUserId` (defensive — AuthGuard would normally have
 *      already 401'd) → `auth.unauthorized` 401.
 *   3. Supabase error → `person.lookup_failed` 500.
 *   4. `data.person_id` null (user has no linked person record) →
 *      `person.not_found` 404.
 *   5. No `users` row found (cross-tenant slip would normally never
 *      happen because AuthGuard already gated on this; defensive) →
 *      `person.not_found` 404.
 *   6. Persons join returned as a single-element array (PostgREST
 *      cardinality variance) is still unwrapped correctly.
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

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'users') {
          return {
            select: () => ({
              eq: () => ({ eq: () => ({ maybeSingle }) }),
            }),
          };
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
  return { controller, maybeSingle };
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

  it('throws person.not_found 404 when the user row has no linked person', async () => {
    const h = makeHarness({
      usersRow: {
        id: PLATFORM_USER_ID,
        person_id: null,
        persons: null,
      },
    });
    await expect(h.controller.getMe(makeReq())).rejects.toMatchObject({
      status: 404,
      code: 'person.not_found',
    });
  });

  it('throws person.not_found 404 when no users row matches', async () => {
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
});
