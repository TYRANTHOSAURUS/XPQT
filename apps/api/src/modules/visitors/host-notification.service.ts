import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { NotificationService } from '../notification/notification.service';
import { VisitorEventBus } from './visitor-event-bus';

/**
 * Host notification fan-out on visitor arrival.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §9
 *
 * Design:
 *   - On `visitor.status → arrived`, fan out to every host in
 *     `visitor_hosts` (the primary host is included as a row there per
 *     migration 00251). Each host gets:
 *       1. Email job — enqueued via NotificationService (channel=email).
 *       2. In-app inbox row — NotificationService (channel=in_app).
 *       3. Browser Notification API event — emitted to VisitorEventBus
 *          for the open portal tab to pick up over SSE.
 *   - `notified_at` recorded per host on visitor_hosts row so reception's
 *     today-view can show "X notified, Y acknowledged".
 *   - First host to call `acknowledge` "owns" the visit. Subsequent
 *     acknowledgments are recorded too but don't change the first-owner
 *     for downstream UX (slice 2d uses min(acknowledged_at) as owner).
 *
 * Templates: the actual email body + subject is rendered by slice 5's
 * email worker subscribing to a `visitor.host_notify` job. Today we just
 * emit a placeholder NotificationService.send() with a basic subject so
 * the in-app inbox has something to display until slice 5 lands.
 *
 * Cross-tenant: every method validates the visitor belongs to
 * TenantContext.current() before touching visitor_hosts.
 */

interface VisitorRow {
  id: string;
  tenant_id: string;
  primary_host_person_id: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  building_id: string | null;
  expected_at: string | null;
}

interface HostRow {
  id: string;
  visitor_id: string;
  person_id: string;
  tenant_id: string;
  notified_at: string | null;
  acknowledged_at: string | null;
}

export interface PendingHost {
  host: { id: string; first_name: string | null; last_name: string | null };
  notified_at: string | null;
  acknowledged_at: string | null;
}

@Injectable()
export class HostNotificationService {
  private readonly log = new Logger(HostNotificationService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notifications: NotificationService,
    private readonly events: VisitorEventBus,
  ) {}

  /**
   * Fan out arrival to all hosts attached to the visitor. Idempotent
   * within reason — if `notified_at` is already set on a row, we skip
   * re-firing email/in-app/SSE for that row but still record the new
   * "notified_at" timestamp via UPSERT (latest wins). In practice this
   * is called exactly once on arrival, but reception can't easily
   * re-trigger if they think a notification was missed; expose it via
   * a controller in slice 2d only if real users ask for it.
   */
  async notifyArrival(visitorId: string, tenantId: string): Promise<void> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    const visitor = await this.loadVisitor(visitorId, tenantId);
    const hosts = await this.loadHosts(visitorId, tenantId);

    const now = new Date().toISOString();

    for (const host of hosts) {
      try {
        // Email + in-app inbox via NotificationService. Slice 5's email
        // worker will replace the rendered subject/body with a templated
        // version keyed off notification_type='visitor.host_notify'.
        const subject = this.placeholderSubject(visitor);
        const body = this.placeholderBody(visitor);

        await this.notifications.send({
          notification_type: 'visitor.host_notify',
          recipient_person_id: host.person_id,
          related_entity_type: 'visitor',
          related_entity_id: visitor.id,
          subject,
          body,
          channels: ['email', 'in_app'],
        });

        // SSE event — open portal tabs trigger Notification API.
        this.events.emit({
          tenant_id: tenantId,
          host_person_id: host.person_id,
          visitor_id: visitor.id,
          kind: 'visitor.arrived',
          occurred_at: now,
        });

        // Record the per-host notified_at on the junction row.
        await this.supabase.admin
          .from('visitor_hosts')
          .update({ notified_at: now })
          .eq('id', host.id)
          .eq('tenant_id', tenantId);

        // Audit per host so the GDPR adapter can resolve who got
        // pinged when (read-side audit is in scope per §4.11).
        await this.emitAudit('visitor.host_notified', visitor.id, {
          visitor_id: visitor.id,
          host_person_id: host.person_id,
          notified_at: now,
        });
      } catch (err) {
        // Single host failure should not block the rest of the fan-out.
        // Reception can re-page individual hosts from the desk surface
        // if needed (slice 2d controller will expose this).
        this.log.warn(
          `host notify failed for visitor ${visitor.id} host ${host.person_id}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  /**
   * A host acknowledges the visit. First-acknowledger wins for the
   * downstream "active host" badge but every host whose tab fires the
   * acknowledge endpoint records `acknowledged_at`. We do NOT mutate
   * other hosts' rows when one acknowledges — that would create an
   * audit-trail nightmare and the spec explicitly says "no further
   * pings" not "force-ack everyone".
   */
  async acknowledge(
    visitorId: string,
    hostPersonId: string,
    tenantId: string,
  ): Promise<void> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    const visitor = await this.loadVisitor(visitorId, tenantId);

    const { data: row, error: rowErr } = await this.supabase.admin
      .from('visitor_hosts')
      .select('id, visitor_id, person_id, tenant_id, notified_at, acknowledged_at')
      .eq('visitor_id', visitorId)
      .eq('person_id', hostPersonId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) {
      throw new NotFoundException('host is not attached to this visitor');
    }

    const hostRow = row as HostRow;
    if (hostRow.acknowledged_at) {
      // Idempotent — re-acks are a no-op, no audit churn.
      return;
    }

    const now = new Date().toISOString();
    const { error: updErr } = await this.supabase.admin
      .from('visitor_hosts')
      .update({ acknowledged_at: now })
      .eq('id', hostRow.id)
      .eq('tenant_id', tenantId);
    if (updErr) throw updErr;

    // Notify peer hosts via the event bus that this visitor has been
    // claimed. Their open tabs can dim the inbox row. We do NOT delete
    // their inbox notifications — leaving the audit trail intact.
    const peers = await this.loadHosts(visitorId, tenantId);
    for (const peer of peers) {
      if (peer.person_id === hostPersonId) continue;
      this.events.emit({
        tenant_id: tenantId,
        host_person_id: peer.person_id,
        visitor_id: visitor.id,
        kind: 'visitor.acknowledged_by_other_host',
        occurred_at: now,
      });
    }

    await this.emitAudit('visitor.host_acknowledged', visitor.id, {
      visitor_id: visitor.id,
      host_person_id: hostPersonId,
      acknowledged_at: now,
    });
  }

  /**
   * Hosts attached to the visitor with their notify/ack state — used by
   * reception's today-view (slice 2d controller will expose).
   */
  async pendingHostsForVisitor(
    visitorId: string,
    tenantId: string,
  ): Promise<PendingHost[]> {
    const ctxTenant = TenantContext.current();
    if (ctxTenant.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }

    await this.loadVisitor(visitorId, tenantId);

    const { data, error } = await this.supabase.admin
      .from('visitor_hosts')
      .select(
        'id, person_id, notified_at, acknowledged_at, person:persons!visitor_hosts_person_id_fkey(id, first_name, last_name)',
      )
      .eq('visitor_id', visitorId)
      .eq('tenant_id', tenantId);
    if (error) throw error;

    type JoinedRow = {
      person_id: string;
      notified_at: string | null;
      acknowledged_at: string | null;
      // PostgREST returns joined rows as either an object or an array of
      // objects depending on the FK shape. Handle both.
      person:
        | { id: string; first_name: string | null; last_name: string | null }
        | Array<{ id: string; first_name: string | null; last_name: string | null }>
        | null;
    };
    return ((data ?? []) as unknown as JoinedRow[]).map((row) => {
      const personData = Array.isArray(row.person) ? row.person[0] ?? null : row.person;
      return {
        host: personData ?? { id: row.person_id, first_name: null, last_name: null },
        notified_at: row.notified_at,
        acknowledged_at: row.acknowledged_at,
      };
    });
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private async loadVisitor(visitorId: string, tenantId: string): Promise<VisitorRow> {
    const { data, error } = await this.supabase.admin
      .from('visitors')
      .select('id, tenant_id, primary_host_person_id, first_name, last_name, company, building_id, expected_at')
      .eq('id', visitorId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException(`visitor ${visitorId} not found`);
    }
    const row = data as VisitorRow;
    if (row.tenant_id !== tenantId) {
      // Cross-tenant defence — present as not-found so we don't leak existence.
      throw new NotFoundException(`visitor ${visitorId} not found`);
    }
    return row;
  }

  private async loadHosts(visitorId: string, tenantId: string): Promise<HostRow[]> {
    const { data, error } = await this.supabase.admin
      .from('visitor_hosts')
      .select('id, visitor_id, person_id, tenant_id, notified_at, acknowledged_at')
      .eq('visitor_id', visitorId)
      .eq('tenant_id', tenantId);
    if (error) throw error;
    return (data ?? []) as HostRow[];
  }

  private placeholderSubject(visitor: VisitorRow): string {
    const name = [visitor.first_name, visitor.last_name].filter(Boolean).join(' ') || 'Your visitor';
    return `${name} has arrived`;
  }

  private placeholderBody(visitor: VisitorRow): string {
    const name = [visitor.first_name, visitor.last_name].filter(Boolean).join(' ') || 'Your visitor';
    const company = visitor.company ? ` from ${visitor.company}` : '';
    return `${name}${company} has checked in at reception.`;
  }

  private async emitAudit(
    eventType: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const tenant = TenantContext.current();
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenant.id,
        event_type: eventType,
        entity_type: 'visitor',
        entity_id: entityId,
        details,
      });
    } catch (err) {
      this.log.warn(
        `audit insert failed for ${eventType}: ${(err as Error).message}`,
      );
    }
  }
}
