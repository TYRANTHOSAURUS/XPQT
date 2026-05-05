import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { RequireClientRequestIdGuard } from './require-client-request-id.guard';

/**
 * B.0.E.4 — `RequireClientRequestIdGuard` rejects producer-route requests
 * that don't carry a CLIENT-supplied `X-Client-Request-Id`.
 *
 * Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §3.3 + §15.7.
 *
 * The middleware (`ClientRequestIdMiddleware`, B.0.D.1) always populates
 * `req.clientRequestId`, falling back to a server-default UUID when the
 * header is missing or malformed. Non-producer routes accept the
 * server-default; producer routes (booking create + approval grant)
 * REQUIRE a client-supplied id so retry idempotency is real, not
 * coincidental.
 */

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('RequireClientRequestIdGuard (B.0.E.4)', () => {
  const guard = new RequireClientRequestIdGuard();

  it('passes when clientRequestId is present AND source is "client"', () => {
    const ctx = makeContext({
      clientRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      clientRequestIdSource: 'client',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects (400) when clientRequestId is missing', () => {
    const ctx = makeContext({});
    try {
      guard.canActivate(ctx);
      throw new Error('expected guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as {
        code: string;
        message: string;
      };
      expect(body.code).toBe('client_request_id.required');
    }
  });

  it('rejects (400) when source is "server_default" (header missing → middleware filled in)', () => {
    const ctx = makeContext({
      clientRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      clientRequestIdSource: 'server_default',
    });
    try {
      guard.canActivate(ctx);
      throw new Error('expected guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as { code: string };
      expect(body.code).toBe('client_request_id.required');
    }
  });

  it('rejects (400) when source is missing/undefined entirely', () => {
    const ctx = makeContext({
      clientRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(() => guard.canActivate(ctx)).toThrow(BadRequestException);
  });

  it('error response carries the structured code (no prose-only message)', () => {
    const ctx = makeContext({});
    try {
      guard.canActivate(ctx);
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as {
        code: string;
        message: string;
      };
      expect(body).toMatchObject({
        code: 'client_request_id.required',
      });
      expect(body.message).toContain('X-Client-Request-Id');
    }
  });
});
