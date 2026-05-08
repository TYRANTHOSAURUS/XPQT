import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';

import { AppError, AppErrors } from './app-error';
import { normalize, randomTraceId } from './normalize';

const TRACE = 'req_test_0000000000000000000000';

describe('normalize()', () => {
  describe('AppError passthrough', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('preserves code, status, and resolves title from messages.en', () => {
      const err = new AppError('booking.slot_conflict', 409, {
        detail: 'overrides messages.en',
      });
      const result = normalize(err, TRACE);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('booking.slot_conflict');
      expect(result.body.title).toBe("Couldn't book — time conflict");
      expect(result.body.detail).toBe('overrides messages.en');
      expect(result.body.traceId).toBe(TRACE);
    });

    it('falls back to messages.en detail when the AppError has no override', () => {
      const err = AppErrors.notFound('ticket', 'abc-123');
      const result = normalize(err, TRACE);
      expect(result.status).toBe(404);
      expect(result.body.code).toBe('ticket.not_found');
      // detail in AppError is "ticket abc-123 not found"; allowed because no
      // vendor / SQL leak; passes through.
      expect(result.body.detail).toBe('ticket abc-123 not found');
    });

    it('omits detail when neither override nor messages.en provides one', () => {
      const err = new AppError('outbox.idempotency_collision', 409);
      const result = normalize(err, TRACE);
      // outbox.idempotency_collision has no detail in messages.en.
      expect(result.body.detail).toBeUndefined();
    });

    it('preserves fields[] on validation errors', () => {
      const err = AppErrors.validation([
        { field: 'title', code: 'required', message: 'Title is required' },
      ]);
      const result = normalize(err, TRACE);
      expect(result.body.fields).toEqual([
        { field: 'title', code: 'required', message: 'Title is required' },
      ]);
    });

    it('preserves retryAfter on 429 only', () => {
      const err = AppErrors.rateLimited(47);
      const result = normalize(err, TRACE);
      expect(result.body.retryAfter).toBe(47);
      expect(result.status).toBe(429);

      const notFound = AppErrors.notFound('ticket');
      expect(normalize(notFound, TRACE).body.retryAfter).toBeUndefined();
    });

    it('preserves serverVersion / clientVersion on 409 conflict', () => {
      const err = AppErrors.conflict('reservation.version_conflict', {
        serverVersion: 'v23',
        clientVersion: 'v22',
      });
      const result = normalize(err, TRACE);
      expect(result.body.serverVersion).toBe('v23');
      expect(result.body.clientVersion).toBe('v22');
      expect(result.status).toBe(409);
    });

    it('drops detail override that looks like a vendor leak', () => {
      const err = new AppError('booking.slot_conflict', 409, {
        detail: 'Supabase RPC failed: insert into bookings...',
      });
      const result = normalize(err, TRACE);
      // Should fall back to messages.en detail, NOT echo the leak.
      expect(result.body.detail).toBe(
        'The selected room is already booked for that time.',
      );
      expect(JSON.stringify(result.body)).not.toContain('Supabase');
    });
  });

  describe('HttpException with { code, message } payload (legacy Phase 1)', () => {
    it('extracts the code, status, and detail from the response', () => {
      const err = new BadRequestException({
        code: 'reference.invalid_uuid',
        message: 'space reference is not a valid uuid: foo',
        reference_table: 'spaces',
      });
      const result = normalize(err, TRACE);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('reference.invalid_uuid');
      expect(result.body.detail).toBe(
        'space reference is not a valid uuid: foo',
      );
      expect(result.body.title).toBe(
        "Couldn't save — invalid reference",
      );
    });

    it('preserves fields[] when included in the legacy payload', () => {
      const err = new BadRequestException({
        code: 'validation.failed',
        fields: [
          { field: 'title', code: 'required', message: 'Title is required' },
        ],
      });
      const result = normalize(err, TRACE);
      expect(result.body.fields).toHaveLength(1);
      expect(result.body.fields![0].field).toBe('title');
    });

    it('coded ConflictException preserves 409 status', () => {
      const err = new ConflictException({
        code: 'booking.slot_conflict',
        message: 'overlap',
      });
      const result = normalize(err, TRACE);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('booking.slot_conflict');
    });

    // ─── Codex C1: leak-scrub on coded HttpException payload ────────────
    describe('codex C1 — coded payload leaks scrubbed centrally', () => {
      let warnSpy: jest.SpyInstance;

      beforeEach(() => {
        warnSpy = jest
          .spyOn(console, 'warn')
          .mockImplementation(() => undefined);
      });

      afterEach(() => {
        warnSpy.mockRestore();
      });

      it('scrubs SQL-fragment payload.message → falls back to messages.en', () => {
        const err = new BadRequestException({
          code: 'booking.slot_conflict',
          message:
            'INSERT INTO bookings VALUES (1, 2, 3) — duplicate key value violates unique constraint',
        });
        const result = normalize(err, TRACE);
        expect(result.body.code).toBe('booking.slot_conflict');
        // detail falls back to messages.en (booking.slot_conflict copy).
        expect(result.body.detail).toBe(
          'The selected room is already booked for that time.',
        );
        // Whole-body assertion — no SQL fragment anywhere.
        expect(JSON.stringify(result.body)).not.toContain('INSERT');
        expect(JSON.stringify(result.body)).not.toContain('duplicate key');
        expect(JSON.stringify(result.body)).not.toContain('VALUES');
        // Synthesized `body.message` mirrors detail → also clean.
        expect(JSON.stringify(result.body)).not.toContain('INSERT INTO');
      });

      it('scrubs vendor-named payload.detail → falls back to messages.en', () => {
        const err = new BadRequestException({
          code: 'booking.slot_conflict',
          detail: 'Resend complained about the room',
        });
        const result = normalize(err, TRACE);
        expect(result.body.detail).toBe(
          'The selected room is already booked for that time.',
        );
        expect(JSON.stringify(result.body)).not.toMatch(/resend/i);
      });

      it('scrubs leaky fields[].message → replaces with code-derived placeholder', () => {
        const err = new BadRequestException({
          code: 'validation.failed',
          fields: [
            {
              field: 'title',
              code: 'invalid',
              message:
                'duplicate key value violates unique constraint "tickets_pkey"',
            },
            // Non-leaky entry should pass through untouched.
            {
              field: 'priority',
              code: 'required',
              message: 'Priority is required',
            },
          ],
        });
        const result = normalize(err, TRACE);
        expect(result.body.fields).toHaveLength(2);
        // First entry was leaky → message replaced with `INVALID` placeholder.
        expect(result.body.fields![0].field).toBe('title');
        expect(result.body.fields![0].code).toBe('invalid');
        expect(result.body.fields![0].message).toBe('INVALID');
        // Second entry untouched.
        expect(result.body.fields![1].message).toBe('Priority is required');
        // No PG fragment anywhere in the body.
        expect(JSON.stringify(result.body)).not.toContain('duplicate key');
        expect(JSON.stringify(result.body)).not.toContain('tickets_pkey');
      });

      it('scrubs leaky AppError fields[].message similarly', () => {
        const err = new AppError('validation.failed', 422, {
          fields: [
            {
              field: 'x',
              code: 'invalid',
              message: 'PG error 42501: permission denied for table foo',
            },
          ],
        });
        const result = normalize(err, TRACE);
        // The leaky pg-shaped message is scrubbed → placeholder used.
        expect(result.body.fields![0].message).toBe('INVALID');
        expect(JSON.stringify(result.body)).not.toContain('42501');
        expect(JSON.stringify(result.body)).not.toContain('permission denied');
      });
    });
  });

  describe('HttpException with string response → generic.<class> (string DROPPED)', () => {
    it('400 BadRequestException(string) → generic.bad_request, detail from messages.en', () => {
      const err = new BadRequestException('Title is required');
      const result = normalize(err, TRACE);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('generic.bad_request');
      // Fix 3: original string is dropped; detail comes from messages.en.
      expect(result.body.detail).toBe('The request was rejected.');
      expect(JSON.stringify(result.body)).not.toContain('Title is required');
    });

    it('drops a Postgres-shaped string the regex would miss', () => {
      const err = new BadRequestException(
        'duplicate key value violates unique constraint "tickets_pkey"',
      );
      const result = normalize(err, TRACE);
      expect(result.body.code).toBe('generic.bad_request');
      // The PG string MUST NOT appear in the body.
      expect(JSON.stringify(result.body)).not.toContain('duplicate key');
      expect(JSON.stringify(result.body)).not.toContain('tickets_pkey');
    });

    it('drops JWT-malformed string on 500', () => {
      const err = new InternalServerErrorException('JWT malformed');
      const result = normalize(err, TRACE);
      expect(result.body.code).toBe('unknown.server_error');
      expect(JSON.stringify(result.body)).not.toContain('JWT');
      expect(JSON.stringify(result.body)).not.toContain('malformed');
    });

    it('401 UnauthorizedException → generic.unauthorized', () => {
      const err = new UnauthorizedException();
      const result = normalize(err, TRACE);
      expect(result.status).toBe(401);
      expect(result.body.code).toBe('generic.unauthorized');
    });

    it('403 ForbiddenException(string) → generic.forbidden', () => {
      const err = new ForbiddenException('Missing permission');
      const result = normalize(err, TRACE);
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('generic.forbidden');
      expect(JSON.stringify(result.body)).not.toContain('Missing permission');
    });

    it('404 NotFoundException(string) → generic.not_found', () => {
      const err = new NotFoundException('Ticket not in tenant');
      const result = normalize(err, TRACE);
      expect(result.status).toBe(404);
      expect(result.body.code).toBe('generic.not_found');
    });

    it('409 ConflictException(string) → generic.conflict', () => {
      const err = new ConflictException('Already exists');
      const result = normalize(err, TRACE);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('generic.conflict');
    });

    it('422 HttpException(string) → validation.failed', () => {
      const err = new HttpException('bad', HttpStatus.UNPROCESSABLE_ENTITY);
      const result = normalize(err, TRACE);
      expect(result.body.code).toBe('validation.failed');
    });

    it('500 InternalServerErrorException → unknown.server_error', () => {
      const err = new InternalServerErrorException('boom');
      const result = normalize(err, TRACE);
      expect(result.body.code).toBe('unknown.server_error');
      expect(result.status).toBe(500);
    });
  });

  describe('Fail-closed registry (Fix 2)', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('AppError with unregistered code → wire code unknown.server_error 500, detail dropped', () => {
      // Codex I2: AppError.code is now `KnownErrorCode` at the type level;
      // bypass with a double-cast for the runtime fail-closed test.
      const err = new (AppError as unknown as new (
        c: string,
        s: number,
        o?: { detail?: string },
      ) => AppError)('totally.invented_code', 418, {
        detail: 'this should never appear on the wire',
      });
      const result = normalize(err, TRACE);
      expect(result.status).toBe(500);
      expect(result.body.code).toBe('unknown.server_error');
      // The custom detail must be dropped — fail-closed strips override
      // when the code is unregistered. Wire body shows messages.en copy.
      expect(JSON.stringify(result.body)).not.toContain('this should never appear');
    });

    it('HttpException with unregistered { code } payload → unknown.server_error', () => {
      const err = new HttpException(
        { code: 'random.invented', message: 'leak.txt:42' },
        500,
      );
      const result = normalize(err, TRACE);
      expect(result.body.code).toBe('unknown.server_error');
      expect(JSON.stringify(result.body)).not.toContain('leak.txt');
      expect(JSON.stringify(result.body)).not.toContain('random.invented');
    });
  });

  describe('Legacy `message` field synthesis (Fix 6)', () => {
    it('validation.failed → message equals title', () => {
      const err = AppErrors.validation([
        { field: 'x', code: 'required', message: 'x is required' },
      ]);
      const result = normalize(err, TRACE);
      // validation.failed has no detail → message falls back to title.
      expect(result.body.message).toBe(result.body.title);
    });

    it('not_found → message equals detail', () => {
      const err = AppErrors.notFound('ticket', 'abc-123');
      const result = normalize(err, TRACE);
      expect(result.body.detail).toBe('ticket abc-123 not found');
      expect(result.body.message).toBe('ticket abc-123 not found');
    });

    it('permission.denied → message equals detail', () => {
      const err = AppErrors.permissionDenied('tickets:write_all');
      const result = normalize(err, TRACE);
      expect(result.body.message).toBe(result.body.detail);
    });

    it('500 fallback → message equals messages.en detail', () => {
      const result = normalize(new Error('boom'), TRACE);
      expect(result.body.code).toBe('unknown.server_error');
      // messages.en supplies detail for unknown.server_error.
      expect(result.body.message).toBe(result.body.detail);
    });
  });

  describe('ZodError → 422 + fields[]', () => {
    it('produces fields[] with field/code/message', () => {
      const schema = z.object({
        title: z.string().min(1),
        priority: z.enum(['low', 'normal']),
      });
      const result = schema.safeParse({ title: '', priority: 'high' });
      expect(result.success).toBe(false);
      if (result.success) return;

      const normalized = normalize(result.error, TRACE);
      expect(normalized.status).toBe(422);
      expect(normalized.body.code).toBe('validation.failed');
      expect(normalized.body.fields).toBeDefined();
      const fields = normalized.body.fields!;
      expect(fields.length).toBeGreaterThanOrEqual(2);
      expect(fields[0]).toMatchObject({
        field: expect.any(String),
        code: expect.any(String),
        message: expect.any(String),
      });
    });

    it('joins nested paths with "."', () => {
      const schema = z.object({
        meta: z.object({ ticket: z.object({ id: z.string().uuid() }) }),
      });
      const result = schema.safeParse({ meta: { ticket: { id: 'not-uuid' } } });
      if (result.success) throw new Error('expected failure');
      const normalized = normalize(result.error, TRACE);
      expect(normalized.body.fields![0].field).toBe('meta.ticket.id');
    });
  });

  describe('PostgrestError', () => {
    it('PGRST301 (RLS) → permission.denied 403', () => {
      const err = { code: 'PGRST301', message: 'Bearer auth invalid' };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('permission.denied');
    });

    it('PGRST301 with severity (forwarded by RPC diagnostic) → still permission.denied (Fix 5)', () => {
      // Real-world shape from supabase-js when an RLS policy raises inside an RPC.
      const err = {
        severity: 'ERROR',
        code: 'PGRST301',
        message: 'rls denied',
        details: '',
        hint: '',
        schema: 'public',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('permission.denied');
    });

    it('42501 (postgres permission denied) → permission.denied 403', () => {
      const err = { code: '42501', message: 'permission denied for table tickets' };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(403);
      expect(result.body.code).toBe('permission.denied');
    });

    it('PGRST116 → generic.not_found 404', () => {
      const err = { code: 'PGRST116', message: 'no rows' };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(404);
      expect(result.body.code).toBe('generic.not_found');
    });

    it('default postgrest → db.constraint 500 (no SQL leak)', () => {
      const err = {
        code: 'PGRST200',
        message: 'INSERT INTO tickets fails',
        details: 'select * from foo',
      };
      const result = normalize(err, TRACE);
      expect(result.body.code).toBe('db.constraint');
      // detail must come from messages.en — the SQL never appears.
      expect(result.body.detail).toBe('A data rule blocked this change.');
      expect(JSON.stringify(result.body)).not.toContain('INSERT');
    });
  });

  describe('pg native error', () => {
    it('22001 (string truncation) → db.constraint 400 (Fix 4)', () => {
      const err = {
        severity: 'ERROR',
        code: '22001',
        message: 'value too long for type character varying(50)',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('db.constraint');
      expect(JSON.stringify(result.body)).not.toContain('character varying');
    });

    it('22003 (numeric out-of-range) → db.constraint 400 (Fix 4)', () => {
      const err = {
        severity: 'ERROR',
        code: '22003',
        message: 'numeric field overflow',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('db.constraint');
    });

    it('22023 (invalid parameter value) → db.constraint 400 (Fix 4)', () => {
      const err = {
        severity: 'ERROR',
        code: '22023',
        message: 'invalid value',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('db.constraint');
    });

    it('22P02 (invalid text rep, e.g. uuid) → db.constraint 400 (Fix 4)', () => {
      const err = {
        severity: 'ERROR',
        code: '22P02',
        message: 'invalid input syntax for type uuid: "not-a-uuid"',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('db.constraint');
      expect(JSON.stringify(result.body)).not.toContain('not-a-uuid');
    });

    it('23502 (not-null violation) → db.constraint 400 (Fix 4)', () => {
      const err = {
        severity: 'ERROR',
        code: '23502',
        message: 'null value in column "title" violates not-null constraint',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('db.constraint');
    });

    it('40001 (serialization_failure) → db.deadlock 409 (Fix 4)', () => {
      const err = {
        severity: 'ERROR',
        code: '40001',
        message: 'could not serialize access due to concurrent update',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('db.deadlock');
    });

    it('23505 → db.unique_violation 409', () => {
      const err = {
        severity: 'ERROR',
        code: '23505',
        message:
          'duplicate key value violates unique constraint "tickets_pkey"',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('db.unique_violation');
      expect(result.body.detail).toBe(
        'Something with that identifier already exists.',
      );
      expect(JSON.stringify(result.body)).not.toContain('tickets_pkey');
    });

    it('23503 → db.fk_violation 409', () => {
      const err = {
        severity: 'ERROR',
        code: '23503',
        message: 'insert or update on table "tickets" violates foreign key',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('db.fk_violation');
    });

    it('23P01 (exclusion / GiST overlap) → db.constraint 409', () => {
      const err = { severity: 'ERROR', code: '23P01', message: 'overlap' };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('db.constraint');
    });

    it('23514 (check) → db.constraint 400', () => {
      const err = {
        severity: 'ERROR',
        code: '23514',
        message: 'check constraint violated',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('db.constraint');
    });

    it('40P01 (deadlock) → db.deadlock 409', () => {
      const err = { severity: 'ERROR', code: '40P01', message: 'deadlock detected' };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('db.deadlock');
    });

    it('unknown pg code → db.constraint 500 (no SQL leak)', () => {
      const err = {
        severity: 'ERROR',
        code: '99999',
        message: 'INSERT INTO tickets ... failed at line 12',
      };
      const result = normalize(err, TRACE);
      expect(result.status).toBe(500);
      expect(result.body.code).toBe('db.constraint');
      // Make sure the SQL never reaches the wire body.
      expect(JSON.stringify(result.body)).not.toContain('INSERT INTO');
    });
  });

  describe('AbortError', () => {
    it('Error with name AbortError → request.cancelled silent', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      const result = normalize(err, TRACE);
      expect(result.body.code).toBe('request.cancelled');
      expect(result.silent).toBe(true);
    });
  });

  describe('unknown fallback', () => {
    it('plain Error → unknown.server_error 500', () => {
      const result = normalize(new Error('totally unexpected'), TRACE);
      expect(result.status).toBe(500);
      expect(result.body.code).toBe('unknown.server_error');
      expect(result.body.title).toBe('Something went wrong on our end');
    });

    it('non-Error thrown value → unknown.server_error 500', () => {
      const result = normalize('a string', TRACE);
      expect(result.status).toBe(500);
      expect(result.body.code).toBe('unknown.server_error');
    });

    it('null → unknown.server_error 500', () => {
      const result = normalize(null, TRACE);
      expect(result.status).toBe(500);
      expect(result.body.code).toBe('unknown.server_error');
    });
  });

  describe('wire shape invariants', () => {
    it('always includes code, title, status, traceId', () => {
      const samples: unknown[] = [
        AppErrors.notFound('ticket'),
        new BadRequestException('bad'),
        new Error('boom'),
        { code: 'PGRST301', message: 'rls' },
        { severity: 'ERROR', code: '23505', message: 'dupe' },
      ];
      for (const error of samples) {
        const { body } = normalize(error, TRACE);
        expect(typeof body.code).toBe('string');
        expect(typeof body.title).toBe('string');
        expect(typeof body.status).toBe('number');
        expect(body.traceId).toBe(TRACE);
      }
    });

    it('detail is omitted when neither override nor messages.en supplies one', () => {
      const err = new AppError('outbox.idempotency_collision', 409);
      const { body } = normalize(err, TRACE);
      expect('detail' in body).toBe(false);
    });

    it('fields is only present on validation errors', () => {
      const ok = AppErrors.notFound('ticket');
      expect(normalize(ok, TRACE).body.fields).toBeUndefined();

      const bad = AppErrors.validation([
        { field: 'x', code: 'required', message: 'x is required' },
      ]);
      expect(normalize(bad, TRACE).body.fields).toHaveLength(1);
    });

    it('retryAfter is only present on AppError that supplied it', () => {
      const ok = AppErrors.notFound('ticket');
      expect(normalize(ok, TRACE).body.retryAfter).toBeUndefined();

      const limit = AppErrors.rateLimited(30);
      expect(normalize(limit, TRACE).body.retryAfter).toBe(30);
    });

    it('serverVersion / clientVersion only present on conflict with opts', () => {
      const plain = AppErrors.conflict('reservation.version_conflict');
      expect(normalize(plain, TRACE).body.serverVersion).toBeUndefined();

      const versioned = AppErrors.conflict('reservation.version_conflict', {
        serverVersion: 'v2',
        clientVersion: 'v1',
      });
      expect(normalize(versioned, TRACE).body.serverVersion).toBe('v2');
      expect(normalize(versioned, TRACE).body.clientVersion).toBe('v1');
    });

    it('legacy `message` field is always present (one-release shim)', () => {
      const samples: unknown[] = [
        AppErrors.notFound('ticket'),
        new BadRequestException('bad'),
        new Error('boom'),
        { code: 'PGRST301', message: 'rls' },
        { severity: 'ERROR', code: '23505', message: 'dupe' },
        AppErrors.validation([
          { field: 'x', code: 'required', message: 'x' },
        ]),
      ];
      for (const error of samples) {
        const { body } = normalize(error, TRACE);
        expect(typeof body.message).toBe('string');
        // message must equal detail-or-title.
        expect(body.message).toBe(body.detail ?? body.title);
      }
    });
  });

  describe('leak-prevention scrubs', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('does not echo a vendor name in the wire body', () => {
      const err = new BadRequestException('Resend rejected: 429');
      const { body } = normalize(err, TRACE);
      // Fix 3 drops the string entirely; messages.en supplies detail.
      expect(JSON.stringify(body)).not.toMatch(/resend/i);
      expect(JSON.stringify(body)).not.toContain('Resend');
    });

    it('does not echo SQL fragments in the wire body', () => {
      const err = new BadRequestException(
        'INSERT INTO tickets violated check',
      );
      const { body } = normalize(err, TRACE);
      expect(JSON.stringify(body)).not.toContain('INSERT INTO');
      expect(JSON.stringify(body)).not.toContain('tickets');
    });

    it('does not echo Supabase / Postgres in any wire body field', () => {
      const samples = [
        new BadRequestException('Supabase RPC error'),
        new InternalServerErrorException('postgres connection refused'),
        new ConflictException('PostgreSQL constraint X'),
      ];
      for (const err of samples) {
        const { body } = normalize(err, TRACE);
        const dump = JSON.stringify(body);
        expect(dump).not.toMatch(/supabase/i);
        expect(dump).not.toMatch(/postgres/i);
      }
    });
  });
});

describe('randomTraceId()', () => {
  it('returns a string starting with req_', () => {
    const id = randomTraceId();
    expect(id.startsWith('req_')).toBe(true);
  });

  it('returns a unique value each call', () => {
    expect(randomTraceId()).not.toBe(randomTraceId());
  });
});
