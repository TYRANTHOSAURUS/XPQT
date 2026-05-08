/**
 * AllExceptionsFilter — global Nest filter that normalises every thrown
 * value to the wire shape.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md
 *   §3.2 (filter), §6.1 (traceId).
 *
 * Wired in `apps/api/src/main.ts` via `app.useGlobalFilters(...)`. The filter
 * runs at the HTTP layer, so service-level tests that catch HttpException
 * directly are unaffected. Legacy `throw new BadRequestException(string)`
 * call sites still work — they get mapped to `generic.bad_request` until
 * Phase 7.A.2 migrates each module.
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { normalize, randomTraceId } from './normalize';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(error: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();

    const traceId = req?.id ?? randomTraceId();
    const normalized = normalize(error, traceId);

    // Log with traceId; severity by status. Skip logs for cancelled requests.
    if (!normalized.silent) {
      const tag = `[${normalized.body.code} traceId=${traceId} status=${normalized.status}]`;
      if (normalized.status >= 500) {
        // Full stack on 5xx — this is the support path.
        this.logger.error(tag, normalized.cause as Error | undefined);
      } else if (normalized.status >= 400) {
        this.logger.warn(tag);
      }
    }

    // Echo the trace id on the response header too — apiFetch reads this.
    if (typeof res?.setHeader === 'function') {
      res.setHeader('X-Request-Id', traceId);
    }

    res.status(normalized.status).json(normalized.body);
  }
}
