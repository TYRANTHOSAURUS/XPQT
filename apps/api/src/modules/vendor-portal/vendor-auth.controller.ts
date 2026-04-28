import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { VendorAuthService } from './vendor-auth.service';
import {
  VendorPortalGuard,
  type RequestWithVendorSession,
} from './vendor-portal.guard';

/**
 * Public auth endpoints for the vendor portal magic-link flow.
 *
 * - POST /api/vendor/auth/redeem   — exchange a one-time magic-link token
 *                                     for a session cookie.
 * - GET  /api/vendor/auth/me       — current session profile (used by the
 *                                     portal shell to gate routing).
 * - POST /api/vendor/auth/logout   — revoke + clear cookie.
 *
 * **All three endpoints opt out of the global tenant-Bearer `AuthGuard`
 * via the controller-level `@Public()`.** Vendors authenticate via the
 * session cookie (or, for /redeem, via a one-time magic-link token in the
 * body) — they never see a tenant Bearer token. Without this, the global
 * AuthGuard rejects vendor-cookie requests with 401 before VendorPortalGuard
 * ever runs and the portal shell can't bootstrap on /me.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §4.
 */
@Public()
@Controller('vendor/auth')
export class VendorAuthController {
  /** 30 days in seconds — matches VendorAuthService.sessionTtlMs. */
  private static readonly COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

  constructor(private readonly auth: VendorAuthService) {}

  // -------------------- POST /vendor/auth/redeem --------------------

  @Post('redeem')
  async redeem(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { token?: string },
  ) {
    if (!body?.token || typeof body.token !== 'string') {
      throw new BadRequestException('token is required');
    }

    const ipHash = hashOrNull(extractClientIp(req));
    const userAgentHash = hashOrNull(req.headers['user-agent'] ?? null);

    const result = await this.auth.redeem({
      token: body.token,
      ipHash,
      userAgentHash,
    });

    res.cookie(VendorPortalGuard.COOKIE_NAME, result.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      // 30 days; server enforces sliding refresh via VendorAuthService.touch.
      maxAge: VendorAuthController.COOKIE_MAX_AGE_SECONDS * 1000,
      // Narrow path to the vendor-portal API surface — the cookie never
      // ships on requests outside /api/vendor/*. Defense in depth on top of
      // HttpOnly + SameSite=Strict.
      path: '/api/vendor',
    });

    return {
      vendor_user: {
        id: result.vendorUser.id,
        email: result.vendorUser.email,
        display_name: result.vendorUser.display_name,
        role: result.vendorUser.role,
      },
      session: {
        expires_at: result.sessionExpiresAt,
        is_first_login: result.isFirstLogin,
      },
    };
  }

  // -------------------- GET /vendor/auth/me --------------------

  @UseGuards(VendorPortalGuard)
  @Get('me')
  async me(@Req() req: RequestWithVendorSession) {
    const s = req.vendorSession!;
    return {
      vendor_user: {
        id: s.vendor_user_id,
        email: s.email,
        display_name: s.display_name,
        role: s.role,
      },
      tenant_id: s.tenant_id,
      vendor_id: s.vendor_id,
      session: { expires_at: s.expires_at },
    };
  }

  // -------------------- POST /vendor/auth/logout --------------------

  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readCookie(req, VendorPortalGuard.COOKIE_NAME);
    if (token) {
      await this.auth.revoke({ sessionToken: token, reason: 'user_initiated' });
    }
    res.clearCookie(VendorPortalGuard.COOKIE_NAME, { path: '/api/vendor' });
    return { ok: true };
  }
}

// =====================================================================
// helpers
// =====================================================================

function readCookie(req: Request, name: string): string | null {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function extractClientIp(req: Request): string | null {
  // Prefer the first IP in X-Forwarded-For (front-proxy) — req.ip can be
  // the proxy's IP itself depending on how express trust-proxy is set.
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? null;
}

function hashOrNull(v: string | null): string | null {
  if (!v) return null;
  return createHash('sha256').update(v).digest('hex');
}
