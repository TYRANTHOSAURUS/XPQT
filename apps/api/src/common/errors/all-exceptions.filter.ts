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
 *
 * Phase 7.A.1 self-review fixes:
 *   - host.getType() guard so RPC/WS contexts re-throw instead of crashing.
 *   - res.headersSent guard so a partially-sent response doesn't double-write.
 *   - Defensive read of req.id ?? req.traceId so bootstrap errors before
 *     RequestIdMiddleware ran still get a (fresh) trace id.
 *   - Structured `cause` serialisation in the error log (no [object Object]).
 *   - Logger context renamed to `http.errors` for grep-friendlier prod logs.
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
  private readonly logger = new Logger('http.errors');

  catch(error: unknown, host: ArgumentsHost): void {
    // Only HTTP requests get the wire-shape rewrite. RPC / WebSocket /
    // microservice contexts re-throw so their own transport handles it.
    if (host.getType() !== 'http') {
      throw error;
    }

    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string; traceId?: string }>();
    const res = ctx.getResponse<Response>();

    const traceId = req?.id ?? req?.traceId ?? randomTraceId();
    const normalized = normalize(error, traceId);

    // Log with traceId; severity by status. Skip logs for cancelled requests.
    if (!normalized.silent) {
      const tag = `[${normalized.body.code} traceId=${traceId} status=${normalized.status}]`;
      if (normalized.status >= 500) {
        // Full stack on 5xx — this is the support path. Serialise `cause` so
        // downstream errors don't print as `[object Object]`.
        this.logger.error(tag, formatCause(normalized.cause));
      } else if (normalized.status >= 400) {
        this.logger.warn(tag);
      }
    }

    // Codex I1: `headersSent` MUST be checked BEFORE `setHeader`. On real
    // Express, calling `setHeader` after the response has been written
    // throws `ERR_HTTP_HEADERS_SENT` synchronously — the original
    // ordering only worked because the test mock didn't enforce it. End
    // the partial stream gracefully and return; never call status/json
    // when headers have already gone out.
    if (res?.headersSent) {
      try {
        res.end();
      } catch {
        // ignore — connection may already be torn down
      }
      return;
    }

    // Echo the trace id on the response header too — apiFetch reads this.
    // Wrap defensively: a stream may transition to "sent" between the
    // check above and this call (race on connection-reset writes).
    if (typeof res?.setHeader === 'function') {
      try {
        res.setHeader('X-Request-Id', traceId);
      } catch {
        // best-effort — header write failed because the response already
        // moved on; the body write below will surface the real condition.
      }
    }

    res.status(normalized.status).json(normalized.body);
  }
}

/**
 * Serialise an error (including chained `cause`) to a string the
 * Logger.error second-arg accepts. NestJS Logger prints `[object Object]`
 * if you hand it a non-string non-Error, which happens for structured
 * causes — explicitly walk the chain and produce a readable trail.
 */
function formatCause(value: unknown): string | Error | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Error) {
    const parts: string[] = [];
    let cur: unknown = value;
    let depth = 0;
    while (cur && depth < 5) {
      if (cur instanceof Error) {
        parts.push(cur.stack ?? `${cur.name}: ${cur.message}`);
        cur = (cur as { cause?: unknown }).cause;
      } else if (typeof cur === 'object' && cur !== null) {
        // Plain object cause (e.g. PostgrestError).
        try {
          parts.push(JSON.stringify(cur, getCircularReplacer()));
        } catch {
          parts.push('[unserialisable cause]');
        }
        break;
      } else {
        parts.push(String(cur));
        break;
      }
      depth += 1;
    }
    // First entry is an Error stack; return as Error so Nest's Logger
    // prints it natively, but append `cause` chain to message via string
    // join in subsequent entries.
    if (parts.length === 1) return value;
    const wrapped = new Error(value.message);
    wrapped.stack = parts.join('\n  caused by:\n');
    wrapped.name = value.name;
    return wrapped;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, getCircularReplacer());
    } catch {
      return '[unserialisable cause]';
    }
  }
  return String(value);
}

function getCircularReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, val: unknown): unknown => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val as object)) return '[Circular]';
      seen.add(val as object);
    }
    return val;
  };
}
