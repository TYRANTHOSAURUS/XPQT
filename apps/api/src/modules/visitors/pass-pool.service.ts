import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../common/db/db.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * Visitor pass pool — physical pass tracking.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md
 *   §4.4 (table), §4.5 (inheritance), §7.6 (reception pass actions)
 *
 * The DB layer is the source of truth (per `visitor_pass_pool` CHECK +
 * composite FK constraints in migration 00249). This service:
 *
 *   - Wraps `pass_pool_for_space()` for inheritance-aware lookups.
 *   - Enforces application-layer state invariants BEFORE the DB raises:
 *     * assignPass: row must be 'available' or 'reserved' for THIS visitor.
 *     * returnPass: row must be 'in_use'.
 *     * markPassRecovered: row must be 'lost'.
 *     The DB CHECK constraints are the defense-in-depth — every state-write
 *     here is paired with a tenant + state guard so the caller gets a clean
 *     400/409 instead of a raw constraint error.
 *   - Cross-tenant: every method validates `pool.tenant_id = TenantContext`
 *     in app-layer before the DB-level composite FK enforces it.
 *   - Audit-emits per state change so the reception "yesterday's loose ends"
 *     and admin pass-history surfaces have a feed.
 *
 * `transitionStatus` on visitors is OUT OF SCOPE for this service. Pass +
 * visitor are sibling concerns — ReceptionService coordinates the two
 * (e.g. checkout: VisitorService.transitionStatus(checked_out) +
 * passPoolService.returnPass).
 */

export type VisitorPassStatus =
  | 'available'
  | 'reserved'
  | 'in_use'
  | 'lost'
  | 'retired';

export interface VisitorPassPool {
  id: string;
  tenant_id: string;
  space_id: string;
  space_kind: 'site' | 'building';
  pass_number: string;
  pass_type: string;
  status: VisitorPassStatus;
  current_visitor_id: string | null;
  reserved_for_visitor_id: string | null;
  last_assigned_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class VisitorPassPoolService {
  private readonly log = new Logger(VisitorPassPoolService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Resolve the pass pool that applies to a space (most-specific-wins
   * inheritance). Wraps `public.pass_pool_for_space(p_space_id)` from
   * migration 00254 / 00261 (null-safety fix).
   *
   * Returns null when:
   *   - No ancestor in the spaces tree has a pass pool, or
   *   - Some ancestor has `uses_visitor_passes=false` (explicit opt-out).
   */
  async passPoolForSpace(
    spaceId: string,
    tenantId: string,
  ): Promise<VisitorPassPool | null> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    // The SQL function returns `setof public.visitor_pass_pool` and is
    // tenant-scoped via `current_tenant_id()` in its WHERE clause.
    const rows = await this.db.queryMany<VisitorPassPool>(
      `select * from public.pass_pool_for_space($1)`,
      [spaceId],
    );
    return rows[0] ?? null;
  }

  /**
   * All available passes anchored at the resolved pool's space (sorted
   * by pass_number for stable UI ordering). Used by the reception
   * "Assign pass" affordance.
   *
   * Note: this returns ONLY pool rows whose direct space_id is the resolved
   * pool space_id — the inheritance walk produces a single anchor in
   * passPoolForSpace, then we list passes at that anchor.
   */
  async availablePassesForSpace(
    spaceId: string,
    tenantId: string,
  ): Promise<VisitorPassPool[]> {
    const anchor = await this.passPoolForSpace(spaceId, tenantId);
    if (!anchor) return [];

    return this.db.queryMany<VisitorPassPool>(
      `select * from public.visitor_pass_pool
        where tenant_id = $1
          and space_id = $2
          and status = 'available'
        order by pass_number asc`,
      [tenantId, anchor.space_id],
    );
  }

  /**
   * Assign a pass to a visitor. Allowed transitions:
   *   - status='available'                                       → in_use
   *   - status='reserved' AND reserved_for_visitor_id=visitorId  → in_use
   *
   * Rejects (ConflictException):
   *   - status='reserved' for a different visitor (slice 2d desk
   *     pre-assignment is the supported path; reception cannot steal
   *     someone else's pre-reservation).
   *   - status='in_use', 'lost', 'retired'.
   *
   * Side-effects in transaction:
   *   - pool.current_visitor_id = visitorId, status = 'in_use',
   *     last_assigned_at = now(), reserved_for_visitor_id = null
   *     (we always clear the reservation pointer on assignment).
   *   - visitors.visitor_pass_id = passId (so checkout finds the pass
   *     without re-querying the pool).
   *   - audit_events: visitor.pass_assigned.
   */
  async assignPass(
    passId: string,
    visitorId: string,
    tenantId: string,
  ): Promise<void> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    await this.db.tx(async (client) => {
      const pass = await this.lockPass(client, passId);
      if (pass.tenant_id !== tenantId) {
        // Cross-tenant defence — the composite FK would also block this on
        // the UPDATE, but we want a clean 400 before the DB raises.
        throw new BadRequestException('pass not in current tenant');
      }

      // Visitor must also be in this tenant. The composite FK
      // (tenant_id, current_visitor_id) → visitors(tenant_id, id)
      // rejects mismatched tenants at the SQL layer, but we surface
      // a clean 400 here.
      const visitor = await this.lockVisitor(client, visitorId, tenantId);
      void visitor;

      switch (pass.status) {
        case 'available':
          break;
        case 'reserved':
          if (pass.reserved_for_visitor_id !== visitorId) {
            throw new ConflictException(
              `pass ${pass.pass_number} is reserved for another visitor`,
            );
          }
          break;
        case 'in_use':
          throw new ConflictException(
            `pass ${pass.pass_number} is already in use`,
          );
        case 'lost':
        case 'retired':
          throw new BadRequestException(
            `pass ${pass.pass_number} is ${pass.status} and cannot be assigned`,
          );
      }

      const nowIso = new Date().toISOString();
      await client.query(
        `update public.visitor_pass_pool
            set status = 'in_use',
                current_visitor_id = $1,
                reserved_for_visitor_id = null,
                last_assigned_at = $2
          where id = $3 and tenant_id = $4`,
        [visitorId, nowIso, passId, tenantId],
      );

      // Mirror onto visitors.visitor_pass_id so checkout has a single
      // lookup. Composite FK guards tenant alignment.
      await client.query(
        `update public.visitors
            set visitor_pass_id = $1
          where id = $2 and tenant_id = $3`,
        [passId, visitorId, tenantId],
      );

      await this.emitAudit(client, 'visitor.pass_assigned', visitorId, {
        pass_id: passId,
        pass_number: pass.pass_number,
        visitor_id: visitorId,
        from_status: pass.status,
      });
    });
  }

  /**
   * Reserve a pass for a specific visitor (service-desk pre-assignment).
   * Pass must be 'available'. Slice 2d will expose the controller; the
   * service is callable from anywhere a desk-side preallocation needs
   * to happen (e.g. bundle approval flow allocating a pass).
   */
  async reservePass(
    passId: string,
    visitorId: string,
    tenantId: string,
  ): Promise<void> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    await this.db.tx(async (client) => {
      const pass = await this.lockPass(client, passId);
      if (pass.tenant_id !== tenantId) {
        throw new BadRequestException('pass not in current tenant');
      }
      const visitor = await this.lockVisitor(client, visitorId, tenantId);
      void visitor;

      if (pass.status !== 'available') {
        throw new ConflictException(
          `pass ${pass.pass_number} is ${pass.status}; only 'available' passes can be reserved`,
        );
      }

      await client.query(
        `update public.visitor_pass_pool
            set status = 'reserved',
                reserved_for_visitor_id = $1
          where id = $2 and tenant_id = $3`,
        [visitorId, passId, tenantId],
      );

      await this.emitAudit(client, 'visitor.pass_reserved', visitorId, {
        pass_id: passId,
        pass_number: pass.pass_number,
        visitor_id: visitorId,
      });
    });
  }

  /**
   * Return a pass at checkout. Pass must be 'in_use'. Side-effects:
   *   - pool.status = 'available', current_visitor_id = null,
   *     reserved_for_visitor_id = null.
   *   - visitors.visitor_pass_id = null on the previously-holding visitor
   *     (if present).
   *   - audit_events: visitor.pass_returned.
   */
  async returnPass(passId: string, tenantId: string): Promise<void> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    await this.db.tx(async (client) => {
      const pass = await this.lockPass(client, passId);
      if (pass.tenant_id !== tenantId) {
        throw new BadRequestException('pass not in current tenant');
      }
      if (pass.status !== 'in_use') {
        throw new BadRequestException(
          `pass ${pass.pass_number} is ${pass.status}; only 'in_use' passes can be returned`,
        );
      }

      const previousVisitorId = pass.current_visitor_id;

      await client.query(
        `update public.visitor_pass_pool
            set status = 'available',
                current_visitor_id = null,
                reserved_for_visitor_id = null
          where id = $1 and tenant_id = $2`,
        [passId, tenantId],
      );

      // Clear the back-reference on visitors so the row no longer points
      // at the now-available pass. Skipped if the pool row was somehow in
      // 'in_use' without a current_visitor_id — defensive (the DB CHECK
      // pool_state_consistency forbids it, but be safe).
      if (previousVisitorId) {
        await client.query(
          `update public.visitors
              set visitor_pass_id = null
            where id = $1 and tenant_id = $2`,
          [previousVisitorId, tenantId],
        );
      }

      await this.emitAudit(client, 'visitor.pass_returned', previousVisitorId, {
        pass_id: passId,
        pass_number: pass.pass_number,
        visitor_id: previousVisitorId,
      });
    });
  }

  /**
   * Mark a pass as 'lost'. Allowed from any non-retired status — most
   * commonly from 'in_use' (visitor walked off with the pass) but
   * reception can also log a lost pass that wasn't assigned (left on
   * the desk overnight).
   *
   * Sets current_visitor_id + reserved_for_visitor_id to null because
   * the pool_state_consistency CHECK only requires those fields when
   * status is 'in_use' or 'reserved'.
   */
  async markPassMissing(
    passId: string,
    tenantId: string,
    reason?: string,
  ): Promise<void> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    await this.db.tx(async (client) => {
      const pass = await this.lockPass(client, passId);
      if (pass.tenant_id !== tenantId) {
        throw new BadRequestException('pass not in current tenant');
      }
      if (pass.status === 'retired') {
        throw new BadRequestException(
          `pass ${pass.pass_number} is retired; cannot mark missing`,
        );
      }

      // Capture pre-update state for the audit payload before we mutate.
      const previousVisitorId = pass.current_visitor_id;
      const previousStatus = pass.status;
      const passNumber = pass.pass_number;

      await client.query(
        `update public.visitor_pass_pool
            set status = 'lost',
                current_visitor_id = null,
                reserved_for_visitor_id = null
          where id = $1 and tenant_id = $2`,
        [passId, tenantId],
      );

      // If the pass was 'in_use', clear the visitor's back-reference.
      if (previousVisitorId) {
        await client.query(
          `update public.visitors
              set visitor_pass_id = null
            where id = $1 and tenant_id = $2`,
          [previousVisitorId, tenantId],
        );
      }

      await this.emitAudit(client, 'visitor.pass_marked_missing', previousVisitorId, {
        pass_id: passId,
        pass_number: passNumber,
        from_status: previousStatus,
        reason: reason ?? null,
      });
    });
  }

  /**
   * Recover a previously-lost pass back to 'available'. Only valid on
   * 'lost' status — recovering an in_use or available pass would
   * silently no-op real concurrent activity.
   */
  async markPassRecovered(passId: string, tenantId: string): Promise<void> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    await this.db.tx(async (client) => {
      const pass = await this.lockPass(client, passId);
      if (pass.tenant_id !== tenantId) {
        throw new BadRequestException('pass not in current tenant');
      }
      if (pass.status !== 'lost') {
        throw new BadRequestException(
          `pass ${pass.pass_number} is ${pass.status}; only 'lost' passes can be recovered`,
        );
      }

      await client.query(
        `update public.visitor_pass_pool
            set status = 'available'
          where id = $1 and tenant_id = $2`,
        [passId, tenantId],
      );

      await this.emitAudit(client, 'visitor.pass_recovered', null, {
        pass_id: passId,
        pass_number: pass.pass_number,
      });
    });
  }

  /**
   * Pool rows currently lost AND whose last_assigned_at is recent (within
   * `since`) — for reception's "yesterday's loose ends" tile (spec §7.7).
   *
   * Scoped to the building's pool anchor only (we resolve the pool first
   * then list the rows there).
   */
  async unreturnedPassesForBuilding(
    buildingId: string,
    tenantId: string,
    since: Date,
  ): Promise<VisitorPassPool[]> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    const anchor = await this.passPoolForSpace(buildingId, tenantId);
    if (!anchor) return [];

    return this.db.queryMany<VisitorPassPool>(
      `select * from public.visitor_pass_pool
        where tenant_id = $1
          and space_id = $2
          and status = 'lost'
          and last_assigned_at is not null
          and last_assigned_at >= $3
        order by last_assigned_at desc`,
      [tenantId, anchor.space_id, since.toISOString()],
    );
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private async lockPass(
    client: PoolClient,
    passId: string,
  ): Promise<VisitorPassPool> {
    const result = await client.query<VisitorPassPool>(
      `select id, tenant_id, space_id, space_kind, pass_number, pass_type,
              status, current_visitor_id, reserved_for_visitor_id,
              last_assigned_at, notes, created_at, updated_at
         from public.visitor_pass_pool
        where id = $1
        for update`,
      [passId],
    );
    const pass = result.rows[0];
    if (!pass) {
      throw new NotFoundException(`visitor_pass_pool ${passId} not found`);
    }
    return pass;
  }

  private async lockVisitor(
    client: PoolClient,
    visitorId: string,
    tenantId: string,
  ): Promise<{ id: string; tenant_id: string }> {
    const result = await client.query<{ id: string; tenant_id: string }>(
      `select id, tenant_id from public.visitors where id = $1 for update`,
      [visitorId],
    );
    const v = result.rows[0];
    if (!v) {
      throw new NotFoundException(`visitor ${visitorId} not found`);
    }
    if (v.tenant_id !== tenantId) {
      throw new BadRequestException('visitor not in current tenant');
    }
    return v;
  }

  private async emitAudit(
    client: PoolClient,
    eventType: string,
    entityId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    const tenant = TenantContext.current();
    try {
      await client.query(
        `insert into public.audit_events
            (tenant_id, event_type, entity_type, entity_id, details)
          values ($1, $2, $3, $4, $5::jsonb)`,
        [
          tenant.id,
          eventType,
          'visitor_pass',
          // entity_id is the pass_id (in details) but for the rare
          // visitor.pass_recovered case where we don't have a holding
          // visitor, fall back to the pass_id from details.
          entityId ?? (details.pass_id as string),
          JSON.stringify(details),
        ],
      );
    } catch (err) {
      // Audit must never block a state transition — log + continue.
      this.log.warn(
        `audit insert failed for ${eventType}: ${(err as Error).message}`,
      );
    }
  }
}
