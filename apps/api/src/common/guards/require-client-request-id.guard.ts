import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Producer-route guard — requires `X-Client-Request-Id` to be present
 * AND client-supplied (not server-defaulted) on the request.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §3.3 + §15.7
 *       (v8.1 — "Producer route requires header: booking/approval producer
 *       routes with no `X-Client-Request-Id` return 400 with a structured
 *       error; no business RPC runs.").
 *
 * The middleware (`ClientRequestIdMiddleware`, B.0.D.1) runs first and
 * always populates `req.clientRequestId` — falling back to a fresh
 * server-generated UUID when the header is missing or malformed. That
 * default is correct for non-producer routes (read endpoints, retry-safe
 * mutations) so they don't have to branch on the property.
 *
 * Producer routes — `POST /reservations`, `POST /reservations/multi-room`,
 * `POST /reservations/:id/services`, `POST /approvals/:id/respond` — need
 * a CLIENT-supplied id because that's what makes idempotency keys
 * deterministic across retries of the same logical attempt. A
 * server-defaulted id is per-request, never reused; the
 * `attach_operations.cached_result` path can never hit, and the user can
 * accidentally double-book on a network blip.
 *
 * The guard rejects with a structured 400 + `client_request_id.required`
 * error code so the frontend can map it to a friendly message + log it
 * as a contract violation (no fallback prose, no retry — the contract
 * was broken). The voice/format mirrors the rest of the AppErrors set
 * (see apps/api/src/common/errors/app-error.ts).
 */
@Injectable()
export class RequireClientRequestIdGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<
      Request & { clientRequestId?: string; clientRequestIdSource?: 'client' | 'server_default' }
    >();
    if (!req.clientRequestId || req.clientRequestIdSource !== 'client') {
      throw new BadRequestException({
        code: 'client_request_id.required',
        message:
          'X-Client-Request-Id header is required for this mutation. ' +
          'Generate a UUID per attempt on the client and thread it through ' +
          'your useMutation variables shape (see spec §3.3).',
      });
    }
    return true;
  }
}
