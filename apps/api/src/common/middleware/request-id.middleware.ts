import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * RequestIdMiddleware — stamps `req.id` (and alias `req.traceId`) with a
 * trace id used by `AllExceptionsFilter` for the `traceId` field on every
 * non-2xx wire body, and echoed back via the `X-Request-Id` response
 * header.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md
 *   §6.1 (traceId everywhere — same id in client toast + server log).
 *
 * Distinct from `ClientRequestIdMiddleware`:
 *   - `req.clientRequestId` is the **idempotency key** for combined RPCs
 *     (B.0.D.1). It comes from the producer's mutation-attempt scope and
 *     is reused across React Query retries of the same attempt. Spec:
 *     docs/superpowers/specs/2026-05-04-domain-outbox-design.md §3.3.
 *   - `req.id` is the **trace id** for THIS HTTP request — distinct per
 *     attempt + retry. Used for log/toast correlation, not idempotency.
 *
 * Acceptance shape:
 *   - Header `X-Request-Id` if present and ≤ 80 chars and non-empty after
 *     trim — accepted as-is. We don't enforce a strict regex because
 *     edge proxies (CloudFront, gateway) often forward their own
 *     UUID/ULID-shaped ids.
 *   - Otherwise generate `req_<uuid-no-dashes>`.
 *   - Always echoed on the response via `X-Request-Id` so apiFetch can
 *     read it on the client and surface in support recovery.
 *
 * Wiring: `AppModule.configure()` applies this BEFORE
 * `ClientRequestIdMiddleware` and `TenantMiddleware` so any error that
 * fires during early middleware processing still has a stable `req.id`
 * for the filter to pick up. Defensive `req?.id ?? req?.traceId ??
 * randomTraceId()` in the filter handles bootstrap edge cases.
 */

const MAX_HEADER_LEN = 80;

export interface RequestWithTraceId extends Request {
  id: string;
  traceId: string;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const r = req as RequestWithTraceId;
    const raw = req.header('x-request-id');
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    const accepted =
      trimmed.length > 0 && trimmed.length <= MAX_HEADER_LEN ? trimmed : '';
    const traceId = accepted || `req_${randomUUID().replace(/-/g, '')}`;
    r.id = traceId;
    r.traceId = traceId;
    if (typeof res?.setHeader === 'function') {
      res.setHeader('X-Request-Id', traceId);
    }
    next();
  }
}
