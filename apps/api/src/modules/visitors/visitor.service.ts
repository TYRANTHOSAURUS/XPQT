import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DbService } from '../../common/db/db.service';
import { TenantContext } from '../../common/tenant-context';
import type {
  CheckoutSource,
  TransitionStatusActor,
  TransitionStatusOpts,
  VisitorStatus,
} from './dto/transition-status.dto';

/**
 * Visitor record + lifecycle.
 *
 * `transitionStatus` is the only function in the codebase that writes
 * `visitors.status`. Bundle cascade, approval grant, EOD sweep, reception
 * check-in, kiosk check-in, host cancel — all route through here so the
 * §5 transition matrix is enforced exactly once. The DB trigger
 * `assert_visitor_status_transition` (migration 00253) is defense-in-depth.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §5
 */

const ALLOWED_TRANSITIONS = new Map<VisitorStatus, ReadonlySet<VisitorStatus>>([
  ['pending_approval', new Set(['expected', 'denied', 'cancelled'])],
  ['expected', new Set(['arrived', 'no_show', 'cancelled', 'denied'])],
  ['arrived', new Set(['in_meeting', 'checked_out'])],
  ['in_meeting', new Set(['checked_out'])],
  // Terminal states (checked_out / no_show / cancelled / denied) have no outgoing edges.
]);

interface VisitorRow {
  id: string;
  tenant_id: string;
  status: VisitorStatus;
  arrived_at: string | null;
  logged_at: string | null;
  checked_out_at: string | null;
  checkout_source: string | null;
  auto_checked_out: boolean;
  visitor_pass_id: string | null;
}

@Injectable()
export class VisitorService {
  private readonly log = new Logger(VisitorService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Apply a status transition. The only function in the codebase that
   * writes visitors.status — every other path (reception, kiosk, EOD,
   * approval, cascade) routes through here.
   *
   * Behavior:
   *   1. Open transaction.
   *   2. SELECT FOR UPDATE the visitor row (locks against concurrent writes).
   *   3. Tenant guard: row.tenant_id must match TenantContext.current() —
   *      defends against a stale/escalated context calling into another
   *      tenant's row.
   *   4. Validate transition against the §5 matrix (idempotent same-status
   *      is a no-op; anything else throws BadRequestException).
   *   5. Apply audit field side-effects per target status.
   *   6. UPDATE the row with new status + side-effect columns.
   *   7. Insert audit_event with metadata.
   *   8. Insert downstream domain_event(s) for slices 2b/2c hooks (host
   *      notification on `arrived`, pass return on `checked_out`).
   *   9. COMMIT.
   *
   * Returns the post-update row.
   */
  async transitionStatus(
    visitorId: string,
    toStatus: VisitorStatus,
    actor: TransitionStatusActor,
    opts: TransitionStatusOpts = {},
  ): Promise<VisitorRow> {
    const tenant = TenantContext.current();

    // Pre-flight: the visitors_checkout_source_required CHECK requires a
    // checkout_source whenever status='checked_out'. Catch missing input at
    // the app layer with a clear 400 rather than leaking the DB error.
    if (toStatus === 'checked_out' && !opts.checkout_source) {
      throw new BadRequestException(
        'checkout_source is required when transitioning to checked_out',
      );
    }

    return this.db.tx(async (client: PoolClient) => {
      const lockResult = await client.query<VisitorRow>(
        `select id, tenant_id, status, arrived_at, logged_at, checked_out_at,
                checkout_source, auto_checked_out, visitor_pass_id
           from public.visitors
          where id = $1
          for update`,
        [visitorId],
      );
      const row = lockResult.rows[0];
      if (!row) {
        throw new NotFoundException(`visitor ${visitorId} not found`);
      }

      if (row.tenant_id !== tenant.id) {
        // Cross-tenant defence — same shape as a missing row to the caller.
        // Logging is intentionally omitted so we don't leak the existence of
        // a visitor in another tenant.
        throw new BadRequestException('visitor not in current tenant');
      }

      // Idempotent same-status: no UPDATE, no audit, no downstream events.
      if (row.status === toStatus) {
        return row;
      }

      const allowed = ALLOWED_TRANSITIONS.get(row.status);
      if (!allowed || !allowed.has(toStatus)) {
        throw new BadRequestException(
          `invalid_transition: ${row.status} -> ${toStatus}`,
        );
      }

      // Build the SET clause incrementally per target status. Order matters
      // because the test fixture introspects the param positions to apply
      // updates in order — keep `status` first so $1 is always the new
      // status, with the remaining columns pushed sequentially.
      const setCols: string[] = ['status'];
      const setValues: unknown[] = [toStatus];

      const nowIso = new Date().toISOString();

      if (toStatus === 'arrived') {
        setCols.push('arrived_at');
        setValues.push(opts.arrived_at ?? nowIso);
        // logged_at is when reception keyed the visitor in (always now); the
        // visitors_logged_after_arrived CHECK enforces logged_at >= arrived_at.
        setCols.push('logged_at');
        setValues.push(nowIso);
      }

      if (toStatus === 'checked_out') {
        setCols.push('checked_out_at');
        setValues.push(nowIso);
        setCols.push('checkout_source');
        setValues.push(opts.checkout_source as CheckoutSource);
        setCols.push('auto_checked_out');
        setValues.push(opts.checkout_source === 'eod_sweep');
      }

      // UPDATE — `id` and `tenant_id` both pinned; defends against any path
      // accidentally targeting another tenant's row even after the FOR UPDATE
      // lock. The DB trigger validates the transition again here; if the app
      // layer ever bypasses this method, the trigger still raises.
      const updateSql =
        `update public.visitors set ` +
        setCols.map((c, i) => `${c} = $${i + 1}`).join(', ') +
        ` where id = $${setCols.length + 1} and tenant_id = $${setCols.length + 2}` +
        ` returning id, tenant_id, status, arrived_at, logged_at, checked_out_at,` +
        ` checkout_source, auto_checked_out, visitor_pass_id`;
      const updateParams = [...setValues, visitorId, tenant.id];
      const updated = await client.query<VisitorRow>(updateSql, updateParams);
      const next = updated.rows[0];
      if (!next) {
        // Should never happen — the FOR UPDATE lock means the row is still
        // there. If it does (e.g. row was deleted between lock and update by
        // a privileged direct-SQL caller), surface as BadRequest.
        throw new BadRequestException('visitor disappeared during transition');
      }

      // Audit. Best-effort: an audit failure should NOT roll back the
      // transition itself — that would let an audit blip block a real
      // check-in. We log and continue.
      try {
        await client.query(
          `insert into public.audit_events
              (tenant_id, event_type, entity_type, entity_id, details)
            values ($1, $2, $3, $4, $5::jsonb)`,
          [
            tenant.id,
            this.auditEventName(toStatus),
            'visitor',
            visitorId,
            JSON.stringify({
              from_status: row.status,
              to_status: toStatus,
              actor_user_id: actor.user_id,
              actor_person_id: actor.person_id,
              ...(toStatus === 'arrived' ? { arrived_at: opts.arrived_at ?? nowIso } : {}),
              ...(toStatus === 'checked_out'
                ? {
                    checkout_source: opts.checkout_source,
                    auto_checked_out: opts.checkout_source === 'eod_sweep',
                  }
                : {}),
            }),
          ],
        );
      } catch (err) {
        this.log.warn(
          `audit insert failed for visitor.${toStatus} ${visitorId}: ${
            (err as Error).message
          }`,
        );
      }

      // Downstream domain events. These are queued for picker-up services
      // in slices 2b (HostNotificationService, VisitorPassPoolService) and
      // 4 (BundleCascadeAdapter). For now they're inert hooks — the worker
      // landing in 2b will subscribe.
      if (toStatus === 'arrived') {
        await this.emitDomainEvent(client, 'visitor.arrived', visitorId, {
          visitor_id: visitorId,
          actor_user_id: actor.user_id,
        });
      }
      if (toStatus === 'checked_out' && row.visitor_pass_id) {
        await this.emitDomainEvent(client, 'visitor.pass_return_requested', visitorId, {
          visitor_id: visitorId,
          visitor_pass_id: row.visitor_pass_id,
          checkout_source: opts.checkout_source,
        });
      }
      if (toStatus === 'cancelled') {
        await this.emitDomainEvent(client, 'visitor.cancelled', visitorId, {
          visitor_id: visitorId,
          from_status: row.status,
          actor_user_id: actor.user_id,
        });
      }

      return next;
    });
  }

  private auditEventName(status: VisitorStatus): string {
    switch (status) {
      case 'expected':
        return 'visitor.expected';
      case 'arrived':
        return 'visitor.arrived';
      case 'in_meeting':
        return 'visitor.in_meeting';
      case 'checked_out':
        return 'visitor.checked_out';
      case 'no_show':
        return 'visitor.no_show';
      case 'cancelled':
        return 'visitor.cancelled';
      case 'denied':
        return 'visitor.denied';
      case 'pending_approval':
        return 'visitor.pending_approval';
    }
  }

  private async emitDomainEvent(
    client: PoolClient,
    eventType: string,
    entityId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const tenant = TenantContext.current();
    try {
      await client.query(
        `insert into public.domain_events
            (tenant_id, event_type, entity_type, entity_id, payload)
          values ($1, $2, $3, $4, $5::jsonb)`,
        [tenant.id, eventType, 'visitor', entityId, JSON.stringify(payload)],
      );
    } catch (err) {
      // Best-effort. Never block a status transition because the event log
      // failed; downstream slices will reconcile from visitors.status itself
      // if events are missing.
      this.log.warn(`domain_events insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }
}
