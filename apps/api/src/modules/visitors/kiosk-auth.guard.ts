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
 *   - Hashes the token (sha256, hex) — that's how `kiosk_tokens.token_hash`
 *     is stored.
 *   - Looks up `kiosk_tokens` by hash. Requires `active=true` AND
 *     `expires_at > now()`.
 *   - On match, attaches `req.kioskContext = { tenantId, buildingId,
 *     kioskTokenId }`. NO `req.user` — kiosk is truly anonymous.
 *   - On mismatch / expired / inactive: 401.
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

    const tokenHash = hashToken(token);
    const row = await this.db.queryOne<{
      id: string;
      tenant_id: string;
      building_id: string;
      active: boolean;
      expires_at: string;
    }>(
      `select id, tenant_id, building_id, active, expires_at
         from public.kiosk_tokens
        where token_hash = $1
          and active = true
          and expires_at > now()`,
      [tokenHash],
    );

    if (!row) {
      throw new UnauthorizedException('Kiosk token invalid or expired');
    }

    req.kioskContext = {
      tenantId: row.tenant_id,
      buildingId: row.building_id,
      kioskTokenId: row.id,
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
