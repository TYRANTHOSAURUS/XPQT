/**
 * Phase 7.A.4 — wire-shape smoke matrix.
 *
 * Drives every AppError factory + every legacy throw shape through
 * AllExceptionsFilter and asserts the wire body matches the contract in
 * docs/superpowers/specs/2026-05-02-error-handling-system-design.md §3.1.
 *
 * The point of this spec, separate from normalize.spec.ts and
 * all-exceptions.filter.spec.ts, is the END-TO-END pass: factory →
 * AppError → filter → wire body. Earlier specs unit-test the pieces;
 * this one pins the contract.
 *
 * Every assertion:
 *  - body.code is present and matches expectation
 *  - body.title is non-empty (resolved from messages.en, never raw code)
 *  - body.status === HTTP status
 *  - body.traceId is present (filter always stamps one)
 *  - body.message is non-empty (legacy compat synthesis per Phase 7.B
 *    deprecation plan)
 *  - body never contains vendor names / SQL / leaky strings
 *  - conditional fields (fields[] / retryAfter / versions / results) are
 *    present iff the variant calls for them
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppError, AppErrors } from './app-error';

type Capture = {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
};

function makeHost(req: { id?: string } = {}) {
  const captured: Capture = { status: 0, body: {}, headers: {} };
  const res = {
    headersSent: false,
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(s: number) {
      captured.status = s;
      return res;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return res;
    },
    end() {
      // no-op for the headers-sent guard test path
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  };
  return { host: host as never, captured };
}

const filter = new AllExceptionsFilter();

function run(error: unknown, req: { id?: string } = {}): Capture {
  const { host, captured } = makeHost(req);
  filter.catch(error, host);
  return captured;
}

function expectCommonShape(c: Capture, expected: { code: string; status: number }) {
  expect(c.status).toBe(expected.status);
  expect(c.body.code).toBe(expected.code);
  expect(c.body.status).toBe(expected.status);
  expect(typeof c.body.title).toBe('string');
  expect((c.body.title as string).length).toBeGreaterThan(0);
  expect(typeof c.body.traceId).toBe('string');
  expect((c.body.traceId as string).length).toBeGreaterThan(0);
  // Phase 7.B legacy compat: body.message must be present and non-empty.
  expect(typeof c.body.message).toBe('string');
  expect((c.body.message as string).length).toBeGreaterThan(0);
}

function expectNoLeaks(c: Capture) {
  const json = JSON.stringify(c.body);
  expect(json).not.toContain('Supabase');
  expect(json).not.toContain('Resend');
  expect(json).not.toContain('Stripe');
  expect(json).not.toContain('INSERT INTO');
  expect(json).not.toContain('SELECT FROM');
  expect(json).not.toContain('UPDATE SET');
  expect(json).not.toContain('PGRST301');
  expect(json).not.toMatch(/SQLSTATE\b/i);
}

describe('Phase 7.A.4 wire-shape matrix', () => {
  it('AppErrors.notFound → 404 wire shape', () => {
    const c = run(AppErrors.notFound('ticket', 'tk-123'));
    expectCommonShape(c, { code: 'ticket.not_found', status: 404 });
    expect(c.body.fields).toBeUndefined();
    expectNoLeaks(c);
  });

  it('AppErrors.permissionDenied → 403 wire shape', () => {
    const c = run(AppErrors.permissionDenied('tickets.read'));
    expectCommonShape(c, { code: 'permission.denied', status: 403 });
    expect(c.body.fields).toBeUndefined();
    expectNoLeaks(c);
  });

  it('AppErrors.unauthorized → 401 wire shape', () => {
    const c = run(AppErrors.unauthorized('No auth user'));
    expectCommonShape(c, { code: 'auth.unauthorized', status: 401 });
    expectNoLeaks(c);
  });

  it('AppErrors.validation → 422 wire shape with fields[]', () => {
    const c = run(
      AppErrors.validation([
        { field: 'title', code: 'required', message: 'Title is required' },
        { field: 'priority', code: 'invalid_enum', message: 'Pick low, normal, high or urgent' },
      ]),
    );
    expectCommonShape(c, { code: 'validation.failed', status: 422 });
    expect(Array.isArray(c.body.fields)).toBe(true);
    expect((c.body.fields as unknown[]).length).toBe(2);
    expectNoLeaks(c);
  });

  it('AppErrors.validationFailed → 400 with custom code', () => {
    const c = run(
      AppErrors.validationFailed('ticket.title_required', { detail: 'Title is required' }),
    );
    expectCommonShape(c, { code: 'ticket.title_required', status: 400 });
    expectNoLeaks(c);
  });

  it('AppErrors.conflict → 409 with version fields', () => {
    const c = run(
      AppErrors.conflict('booking.slot_conflict', {
        serverVersion: 'v23',
        clientVersion: 'v22',
      }),
    );
    expectCommonShape(c, { code: 'booking.slot_conflict', status: 409 });
    expect(c.body.serverVersion).toBe('v23');
    expect(c.body.clientVersion).toBe('v22');
    expectNoLeaks(c);
  });

  it('AppErrors.rateLimited → 429 with retryAfter', () => {
    const c = run(AppErrors.rateLimited(47));
    expectCommonShape(c, { code: 'rate_limit.exceeded', status: 429 });
    expect(c.body.retryAfter).toBe(47);
    expectNoLeaks(c);
  });

  it('AppErrors.server → 500 wire shape', () => {
    const c = run(AppErrors.server('booking.partial_failure'));
    expectCommonShape(c, { code: 'booking.partial_failure', status: 500 });
    expect(c.body.fields).toBeUndefined();
    expectNoLeaks(c);
  });

  it('AppErrors.forbidden → 403 with custom code', () => {
    const c = run(AppErrors.forbidden('ticket.write_forbidden', 'You cannot edit this'));
    expectCommonShape(c, { code: 'ticket.write_forbidden', status: 403 });
    expectNoLeaks(c);
  });

  it('AppErrors.notFoundWithCode → 404 with custom code', () => {
    const c = run(AppErrors.notFoundWithCode('reclassify.target_not_found'));
    expectCommonShape(c, { code: 'reclassify.target_not_found', status: 404 });
    expectNoLeaks(c);
  });

  it('AppErrors.badRequest → 400 with custom code', () => {
    const c = run(AppErrors.badRequest('ticket.tags_invalid', 'Tags must be strings'));
    expectCommonShape(c, { code: 'ticket.tags_invalid', status: 400 });
    expectNoLeaks(c);
  });

  // ─── legacy throws ──────────────────────────────────────────────────────

  it('legacy BadRequestException(string) → generic.bad_request 400', () => {
    const c = run(new BadRequestException('Something is off'));
    expectCommonShape(c, { code: 'generic.bad_request', status: 400 });
    expectNoLeaks(c);
  });

  it('legacy NotFoundException(string) → generic.not_found 404', () => {
    const c = run(new NotFoundException('Where did it go'));
    expectCommonShape(c, { code: 'generic.not_found', status: 404 });
    expectNoLeaks(c);
  });

  it('legacy ForbiddenException(string) → generic.forbidden 403', () => {
    const c = run(new ForbiddenException('Off limits'));
    expectCommonShape(c, { code: 'generic.forbidden', status: 403 });
    expectNoLeaks(c);
  });

  it('legacy UnauthorizedException(string) → generic.unauthorized 401', () => {
    const c = run(new UnauthorizedException('Sign in first'));
    expectCommonShape(c, { code: 'generic.unauthorized', status: 401 });
    expectNoLeaks(c);
  });

  it('legacy ConflictException(string) → generic.conflict 409', () => {
    const c = run(new ConflictException('Race lost'));
    expectCommonShape(c, { code: 'generic.conflict', status: 409 });
    expectNoLeaks(c);
  });

  it('legacy UnprocessableEntityException(string) → validation.failed 422', () => {
    const c = run(new UnprocessableEntityException('Cannot process'));
    expectCommonShape(c, { code: 'validation.failed', status: 422 });
    expectNoLeaks(c);
  });

  it('legacy InternalServerErrorException(string) → unknown.server_error 500', () => {
    const c = run(new InternalServerErrorException('Boom'));
    expectCommonShape(c, { code: 'unknown.server_error', status: 500 });
    expectNoLeaks(c);
  });

  // ─── Phase 1 coded HttpException (legacy structured form) ──────────────

  it('coded BadRequestException({code, message}) → preserved code', () => {
    const c = run(
      new BadRequestException({
        code: 'booking.slot_conflict',
        message: 'Already booked',
      }),
    );
    expectCommonShape(c, { code: 'booking.slot_conflict', status: 400 });
    expectNoLeaks(c);
  });

  it('coded HttpException with leaky message → message scrubbed from wire', () => {
    const c = run(
      new BadRequestException({
        code: 'booking.slot_conflict',
        message: 'duplicate key value violates unique constraint reservations_pkey; INSERT INTO reservations',
      }),
    );
    expect(c.body.code).toBe('booking.slot_conflict');
    expectNoLeaks(c);
    // detail must not contain the leaky pg-shaped message
    expect(JSON.stringify(c.body)).not.toContain('duplicate key value');
    expect(JSON.stringify(c.body)).not.toContain('INSERT INTO');
  });

  // ─── ZodError → 422 + fields[] ──────────────────────────────────────────

  it('ZodError → 422 with structured fields[]', () => {
    let zErr: ZodError;
    try {
      JSON.parse('{"x": 1}'); // dummy
      const z = require('zod') as typeof import('zod');
      const s = z.z.object({ title: z.z.string().min(1), priority: z.z.enum(['low', 'high']) });
      s.parse({ title: '', priority: 'urgent' });
      throw new Error('expected zod parse failure');
    } catch (e) {
      zErr = e as ZodError;
    }
    const c = run(zErr!);
    expectCommonShape(c, { code: 'validation.failed', status: 422 });
    expect(Array.isArray(c.body.fields)).toBe(true);
    expect((c.body.fields as unknown[]).length).toBeGreaterThan(0);
    expectNoLeaks(c);
  });

  // ─── traceId propagation ───────────────────────────────────────────────

  it('echoes req.id as traceId when middleware set it', () => {
    const c = run(AppErrors.notFound('ticket'), { id: 'req_test_abcdef0123456789' });
    expect(c.body.traceId).toBe('req_test_abcdef0123456789');
    expect(c.headers['X-Request-Id']).toBe('req_test_abcdef0123456789');
  });

  it('generates a fresh traceId when middleware is missing', () => {
    const c = run(AppErrors.notFound('ticket'));
    expect(typeof c.body.traceId).toBe('string');
    expect((c.body.traceId as string).length).toBeGreaterThan(4);
    expect(c.headers['X-Request-Id']).toBe(c.body.traceId);
  });

  // ─── unknown / pg-native fallback ──────────────────────────────────────

  it('pg-native unique violation 23505 → db.unique_violation 409', () => {
    const c = run({
      severity: 'ERROR',
      code: '23505',
      message: 'duplicate key value violates unique constraint "tickets_pkey"',
      detail: 'Key (id)=(123) already exists.',
    });
    expectCommonShape(c, { code: 'db.unique_violation', status: 409 });
    expectNoLeaks(c);
    expect(JSON.stringify(c.body)).not.toContain('duplicate key value');
  });

  it('pg-native fk violation 23503 → db.fk_violation 409', () => {
    const c = run({
      severity: 'ERROR',
      code: '23503',
      message: 'insert or update on table violates foreign key constraint',
    });
    expectCommonShape(c, { code: 'db.fk_violation', status: 409 });
    expectNoLeaks(c);
  });

  it('pg-native deadlock 40P01 → db.deadlock 409', () => {
    const c = run({
      severity: 'ERROR',
      code: '40P01',
      message: 'deadlock detected',
    });
    expectCommonShape(c, { code: 'db.deadlock', status: 409 });
    expectNoLeaks(c);
  });

  it('PostgREST RLS denial PGRST301 → permission.denied 403', () => {
    const c = run({
      code: 'PGRST301',
      message: 'new row violates row-level security policy',
      details: '',
      hint: '',
      schema: 'public',
    });
    expectCommonShape(c, { code: 'permission.denied', status: 403 });
    expectNoLeaks(c);
  });

  it('AbortError → request.cancelled', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const c = run(err);
    expect(c.body.code).toBe('request.cancelled');
    expect(c.status).toBe(499);
    expect(typeof c.body.traceId).toBe('string');
  });

  it('totally unknown error → unknown.server_error 500', () => {
    const c = run(new Error('something exploded inside Supabase'));
    expectCommonShape(c, { code: 'unknown.server_error', status: 500 });
    // The leaky message must not reach the wire body.
    expectNoLeaks(c);
    expect(JSON.stringify(c.body)).not.toContain('Supabase');
    expect(JSON.stringify(c.body)).not.toContain('something exploded');
  });
});
