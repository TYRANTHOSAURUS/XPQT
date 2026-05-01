import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { DbService } from '../../common/db/db.service';
import type { KioskContext } from './dto/kiosk.dto';

/**
 * Anonymous building-bound auth for `/kiosk/*` endpoints.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8.1
 *
 * Pattern reference: `apps/api/src/modules/vendor-portal/vendor-portal.guard.ts`.
 * Same shape — validate an opaque token, attach a context object, no
 * `req.user`. Vendor portal uses a session cookie; kiosk uses a Bearer
 * token because the device stores the token at provisioning time and
 * sends it in the `Authorization` header.
 *
 * What it does:
 *   - Reads `Authorization: Bearer <token>` from the request.
 *   - Calls the SECURITY DEFINER function `validate_kiosk_token(token)`
 *     (migration 00271). The function hashes + looks up + checks active/
 *     expires_at; the guard never reads `kiosk_tokens` directly. This
 *     keeps the table strictly service_role-only (00258) — anonymous
 *     callers reach the data only via the function, exactly as 00258's
 *     comment promised.
 *   - On match, attaches `req.kioskContext = { tenantId, buildingId,
 *     kioskTokenId }`. NO `req.user` — kiosk is truly anonymous.
 *   - On miss / expired / inactive: 401. Distinct SQLSTATEs (45011/45012/
 *     45013) are mapped to the same generic 401 so we don't leak which
 *     branch fired.
 *
 * Cross-tenant safety: KioskService methods take `KioskContext` as their
 * first arg. Every read filters on `kioskContext.tenantId` (and where
 * relevant `kioskContext.buildingId`); a stolen token from tenant A
 * cannot read or write data in tenant B because the queries themselves
 * never resolve a different tenant.
 */
@Injectable()
export class KioskAuthGuard implements CanActivate {
  constructor(private readonly db: DbService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithKioskContext>();
    const token = readBearer(req);
    if (!token) {
      throw new UnauthorizedException('Missing kiosk token');
    }

    let row: {
      tenant_id: string;
      building_id: string;
      kiosk_token_id: string;
    } | null = null;
    try {
      row = await this.db.queryOne(
        `select tenant_id, building_id, kiosk_token_id
           from public.validate_kiosk_token($1)`,
        [token],
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      // 45011 invalid / 45012 inactive / 45013 expired — all surface as 401.
      if (code === '45011' || code === '45012' || code === '45013') {
        throw new UnauthorizedException('Kiosk token invalid or expired');
      }
      throw err;
    }

    if (!row) {
      // Belt-and-braces: the function raises rather than returning empty,
      // but if a future change makes it return-empty we still 401 instead
      // of crashing on undefined.
      throw new UnauthorizedException('Kiosk token invalid or expired');
    }

    req.kioskContext = {
      tenantId: row.tenant_id,
      buildingId: row.building_id,
      kioskTokenId: row.kiosk_token_id,
    };
    return true;
  }
}

export interface RequestWithKioskContext extends Request {
  kioskContext?: KioskContext;
}

function readBearer(req: Request): string | null {
  const header = req.headers?.authorization;
  if (!header) return null;
  const parts = header.split(/\s+/);
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== 'bearer') return null;
  const token = parts[1]!.trim();
  return token.length > 0 ? token : null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
