import { BadRequestException, Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { TenantContext } from '../../common/tenant-context';

/**
 * Wraps `email_delivery_events` for visitor invite emails.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.10
 *
 * Existing pattern (00183_mail_delivery_events.sql, 00263 extends it):
 *   - One event row per provider webhook (Postmark / Resend / etc).
 *   - Correlated by `(correlated_entity_type='visitor_invite',
 *     correlated_entity_id=visitor.id)`.
 *   - The webhook receiver writes the rows; this adapter wraps the
 *     reads and the explicit "we just sent / it bounced" writes that
 *     the email worker (slice 5) and bounce handler emit.
 *
 * Surfaces that consume:
 *   - ReceptionService.yesterdayLooseEnds — surfaces visitors whose latest
 *     event is `bounced` since the cutoff.
 *   - Slice 2d's today-view (potentially) — flagged inline.
 *
 * Cross-tenant: every read filters on `tenant_id`. The webhook receiver
 * sets tenant_id when it can correlate the event; events without a
 * tenant_id never feed this adapter (they sit in the table for the
 * reconcile sweep).
 */

export type DeliveryEventType =
  | 'sent'
  | 'queued'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed';

export interface DeliveryEvent {
  id: string;
  tenant_id: string | null;
  provider_message_id: string;
  correlated_entity_type: 'visitor_invite';
  correlated_entity_id: string;
  event_type: DeliveryEventType;
  bounce_type: 'hard' | 'soft' | 'block' | 'unknown' | null;
  recipient_email: string | null;
  reason: string | null;
  occurred_at: string;
}

export interface BouncedInviteRow {
  visitor_id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  primary_host_first_name: string | null;
  primary_host_last_name: string | null;
  recipient_email: string | null;
  bounce_type: string | null;
  reason: string | null;
  occurred_at: string;
  event_type: DeliveryEventType;
  expected_at: string | null;
  arrived_at: string | null;
  status: string;
  visitor_pass_id: string | null;
  pass_number: string | null;
  visitor_type_id: string | null;
}

@Injectable()
export class VisitorMailDeliveryAdapter {
  constructor(private readonly db: DbService) {}

  /**
   * Record a `sent` event when slice 5's email worker hands the email
   * to the provider. The provider webhook will eventually post a
   * `delivered` or `bounced` follow-up; for the cases where no webhook
   * fires (e.g. provider outage) `sent` is the floor record we use.
   *
   * `provider_message_id` is the provider-side id — required so the
   * downstream webhook can correlate. v1 uses Postmark which returns
   * a UUID-shaped `MessageID`.
   */
  async recordSent(
    visitorId: string,
    tenantId: string,
    providerMessageId: string,
    opts: { recipient_email?: string | null; occurred_at?: string } = {},
  ): Promise<void> {
    this.assertTenant(tenantId);
    const occurredAt = opts.occurred_at ?? new Date().toISOString();
    await this.db.query(
      `insert into public.email_delivery_events (
         tenant_id, provider_message_id, correlated_entity_type,
         correlated_entity_id, event_type, recipient_email,
         occurred_at, raw_payload
       ) values ($1, $2, 'visitor_invite', $3, 'sent', $4, $5, $6::jsonb)`,
      [
        tenantId,
        providerMessageId,
        visitorId,
        opts.recipient_email ?? null,
        occurredAt,
        JSON.stringify({ source: 'VisitorMailDeliveryAdapter.recordSent' }),
      ],
    );
  }

  async recordBounced(
    visitorId: string,
    tenantId: string,
    opts: {
      provider_message_id?: string;
      reason?: string;
      bounce_type?: 'hard' | 'soft' | 'block' | 'unknown';
      recipient_email?: string | null;
      occurred_at?: string;
    } = {},
  ): Promise<void> {
    this.assertTenant(tenantId);
    const occurredAt = opts.occurred_at ?? new Date().toISOString();
    await this.db.query(
      `insert into public.email_delivery_events (
         tenant_id, provider_message_id, correlated_entity_type,
         correlated_entity_id, event_type, bounce_type, recipient_email,
         reason, occurred_at, raw_payload
       ) values ($1, $2, 'visitor_invite', $3, 'bounced', $4, $5, $6, $7, $8::jsonb)`,
      [
        tenantId,
        // provider_message_id is NOT NULL in the table; bounce events
        // forwarded by the receiver always have one. For locally-emitted
        // bounce records (test fixtures), generate a synthetic id so the
        // INSERT succeeds.
        opts.provider_message_id ?? `local-${visitorId}-${Date.now()}`,
        visitorId,
        opts.bounce_type ?? 'unknown',
        opts.recipient_email ?? null,
        opts.reason ?? null,
        occurredAt,
        JSON.stringify({ source: 'VisitorMailDeliveryAdapter.recordBounced' }),
      ],
    );
  }

  async recordDelivered(
    visitorId: string,
    tenantId: string,
    opts: { provider_message_id?: string; occurred_at?: string } = {},
  ): Promise<void> {
    this.assertTenant(tenantId);
    const occurredAt = opts.occurred_at ?? new Date().toISOString();
    await this.db.query(
      `insert into public.email_delivery_events (
         tenant_id, provider_message_id, correlated_entity_type,
         correlated_entity_id, event_type, occurred_at, raw_payload
       ) values ($1, $2, 'visitor_invite', $3, 'delivered', $4, $5::jsonb)`,
      [
        tenantId,
        opts.provider_message_id ?? `local-${visitorId}-${Date.now()}`,
        visitorId,
        occurredAt,
        JSON.stringify({ source: 'VisitorMailDeliveryAdapter.recordDelivered' }),
      ],
    );
  }

  /**
   * Most recent delivery event for this visitor's invite (any event_type).
   * Reception's today-view uses this to badge a row "(bounced)" / "(delivered)".
   */
  async lastDeliveryStatusForVisitor(
    visitorId: string,
    tenantId: string,
  ): Promise<DeliveryEvent | null> {
    this.assertTenant(tenantId);
    const row = await this.db.queryOne<DeliveryEvent>(
      `select id, tenant_id, provider_message_id,
              correlated_entity_type::text as correlated_entity_type,
              correlated_entity_id, event_type::text as event_type,
              bounce_type::text as bounce_type,
              recipient_email, reason, occurred_at
         from public.email_delivery_events
        where tenant_id = $1
          and correlated_entity_type = 'visitor_invite'
          and correlated_entity_id = $2
        order by occurred_at desc, received_at desc
        limit 1`,
      [tenantId, visitorId],
    );
    return row;
  }

  /**
   * Visitors at this building whose most-recent invite delivery event is
   * `bounced` since the cutoff. Used by reception's "yesterday's loose
   * ends" tile.
   *
   * Implementation:
   *   - LATERAL `select … from email_delivery_events` per visitor pulls the
   *     latest event (one round trip).
   *   - Filters on `latest.event_type = 'bounced' AND latest.occurred_at >=
   *     since` so a bounce that was later "resolved" by a re-send +
   *     delivered event drops out of the loose-ends list.
   *   - Status filter: only pre-arrival visitors (`expected` /
   *     `pending_approval`) — once they're on-site the bounce is moot.
   */
  async bouncedInvitesForBuildingSince(
    buildingId: string,
    tenantId: string,
    since: Date,
  ): Promise<BouncedInviteRow[]> {
    this.assertTenant(tenantId);
    const sql = `
      select v.id                        as visitor_id,
             v.first_name                as first_name,
             v.last_name                 as last_name,
             v.company                   as company,
             hp.first_name               as primary_host_first_name,
             hp.last_name                as primary_host_last_name,
             latest.recipient_email      as recipient_email,
             latest.bounce_type::text    as bounce_type,
             latest.reason               as reason,
             latest.occurred_at          as occurred_at,
             latest.event_type::text     as event_type,
             v.expected_at               as expected_at,
             v.arrived_at                as arrived_at,
             v.status                    as status,
             v.visitor_pass_id           as visitor_pass_id,
             pp.pass_number              as pass_number,
             v.visitor_type_id           as visitor_type_id
        from public.visitors v
        left join public.persons hp
          on hp.id = v.primary_host_person_id
         and hp.tenant_id = v.tenant_id
        left join public.visitor_pass_pool pp
          on pp.id = v.visitor_pass_id
         and pp.tenant_id = v.tenant_id
        cross join lateral (
          select event_type, bounce_type, recipient_email, reason, occurred_at
            from public.email_delivery_events
           where tenant_id = v.tenant_id
             and correlated_entity_type = 'visitor_invite'
             and correlated_entity_id = v.id
           order by occurred_at desc, received_at desc
           limit 1
        ) latest
       where v.tenant_id = $1
         and v.building_id = $2
         and v.status in ('expected', 'pending_approval')
         and latest.event_type = 'bounced'
         and latest.occurred_at >= $3
       order by latest.occurred_at desc
    `;
    return this.db.queryMany<BouncedInviteRow>(
      sql,
      [tenantId, buildingId, since.toISOString()],
    );
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private assertTenant(tenantId: string): void {
    const ctx = TenantContext.current();
    if (ctx.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }
  }
}
