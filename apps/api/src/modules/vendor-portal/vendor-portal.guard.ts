import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { VendorAuthService, type ActiveSessionLookup } from './vendor-auth.service';

/**
 * Authenticates vendor-portal requests via the HttpOnly session cookie set
 * by `/api/vendor/auth/redeem`. Every protected route (`/api/vendor/*`
 * except `/api/vendor/auth/*`) goes through this guard.
 *
 * On success the validated session lookup is attached to `request.vendorSession`
 * so downstream services can scope queries by `(tenant_id, vendor_id)` without
 * re-doing the lookup. Side-effect: sliding-TTL touch on the session.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §4.
 */
@Injectable()
export class VendorPortalGuard implements CanActivate {
  /** Cookie name used by /vendor/auth/redeem and read here. */
  static readonly COOKIE_NAME = 'prequest_vendor_session';

  private readonly log = new Logger(VendorPortalGuard.name);

  constructor(private readonly auth: VendorAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithVendorSession>();
    const token = readCookie(req, VendorPortalGuard.COOKIE_NAME);
    if (!token) {
      throw new UnauthorizedException('Missing vendor session cookie');
    }

    const session = await this.auth.validate(token);
    if (!session) {
      throw new UnauthorizedException('Vendor session invalid or expired');
    }

    req.vendorSession = session;
    // Sliding-TTL refresh — fire-and-forget, never block the request. The
    // .catch() is non-negotiable: an unhandled rejection from this path
    // would terminate the Node process under modern defaults.
    void this.auth.touch(token).catch((err: unknown) => {
      this.log.warn(
        `vendor session touch failed (silent): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    return true;
  }
}

export interface RequestWithVendorSession extends Request {
  vendorSession?: ActiveSessionLookup;
}

/**
 * Pull a cookie value from the raw `Cookie` header. The repo doesn't ship
 * cookie-parser today; this is a 10-line replacement that handles only what
 * the vendor portal needs: a single, opaque, URL-safe-base64 session token.
 */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
