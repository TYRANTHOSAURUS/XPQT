import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Thread `X-Client-Request-Id` from the incoming request onto
 * `request.clientRequestId` so producer services (booking create, approval
 * grant, setup-WO emit) can use it as the `idempotency_key` argument to the
 * combined RPCs (B.0.B).
 *
 * Spec §3.3 of `docs/superpowers/specs/2026-05-04-domain-outbox-design.md`
 * (v8.1) — the contract:
 *
 *   - Header is generated at the **mutation-attempt scope** by the frontend
 *     (e.g. `useCreateBooking`, `useGrantBookingApproval`) — captured in
 *     closure before `mutate()` so React Query retries of the same attempt
 *     reuse the same id. `apiFetch` does NOT auto-stamp.
 *   - Backend middleware reads + validates UUID shape; missing/malformed
 *     values fall back to a server-generated UUID so `req.clientRequestId`
 *     is always set (no per-route branching).
 *   - `req.clientRequestIdSource` records whether the value came from the
 *     client or was server-defaulted — useful for ops triage of "client
 *     never sent the header" vs "client retried the same key".
 *
 * Wiring: applied globally in `AppModule.configure(consumer)` so every
 * controller route gets the property. No per-route guard at controller
 * level — the spec explicitly chose middleware over a header guard so
 * tests can hit `req.clientRequestId` directly without supabase / RPC
 * mocking.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RequestWithClientId extends Request {
  clientRequestId: string;
  clientRequestIdSource: 'client' | 'server_default';
}

@Injectable()
export class ClientRequestIdMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const r = req as RequestWithClientId;
    const raw = req.header('x-client-request-id');
    if (raw && UUID_RE.test(raw)) {
      r.clientRequestId = raw.toLowerCase();
      r.clientRequestIdSource = 'client';
    } else {
      r.clientRequestId = randomUUID();
      r.clientRequestIdSource = 'server_default';
    }
    next();
  }
}
