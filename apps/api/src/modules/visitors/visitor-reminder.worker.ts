import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { hostname } from 'node:os';
import { DbService } from '../../common/db/db.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import {
  MAIL_PROVIDER,
  type MailProvider,
} from '../../common/mail/mail-provider';
import { renderDayBeforeReminder, type VisitorEmailContext } from './templates/visitor-emails';
import { VisitorMailDeliveryAdapter } from './visitor-mail-delivery.adapter';

/**
 * Day-before-visit reminder cron.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6, §10.3
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 5 task 5.3
 *
 * Behavior:
 *   - Every hour: find visitors with status='expected' AND
 *     expected_at IN [now+24h, now+25h), no prior day-before reminder
 *     in `email_delivery_events`.
 *   - For each: render the reminder template and dispatch via
 *     MAIL_PROVIDER. Record delivery via VisitorMailDeliveryAdapter.
 *
 * Why a 1-hour window:
 *   - The cron ticks every hour; each tick covers a 1-hour band so
 *     a visitor whose expected_at falls into that band is reminded
 *     at exactly one tick.
 *   - The dedup guard (provider_message_id starts with `visitor-reminder:`)
 *     ensures a re-tick — or a clock skew that puts the same visitor
 *     into two adjacent bands — doesn't double-send.
 *
 * Idempotency:
 *   - The `provider_message_id` for a reminder send is shaped
 *     `visitor-reminder:<visitor_id>:<expected_at_iso>`. Each visit
 *     occurrence reminds at most once. Recurring booking occurrences
 *     each get their own visitor row (per slice 4 plan + spec §10.3),
 *     so each occurrence reminds independently.
 *
 * Cross-tenant: query is global across tenants (no tenant filter at the
 * top level — the cron runs platform-wide). Each candidate row carries
 * `tenant_id` and we set TenantContext.run accordingly per visitor for
 * downstream Supabase access. A tenant A reminder cannot trigger a B
 * lookup because the assemble step filters by tenant.
 *
 * Env knobs:
 *   - VISITOR_REMINDER_WORKER_ENABLED=false disables the cron.
 *   - VISITOR_REMINDER_BATCH_SIZE limits per-tick work (default 200).
 */
@Injectable()
export class VisitorReminderWorker {
  private readonly log = new Logger(VisitorReminderWorker.name);
  private readonly enabled =
    process.env.VISITOR_REMINDER_WORKER_ENABLED !== 'false';
  private readonly fromEmail =
    process.env.VISITOR_EMAIL_FROM ??
    process.env.POSTMARK_DEFAULT_FROM_EMAIL ??
    'visitors@prequest.io';
  private readonly fromName = process.env.VISITOR_EMAIL_FROM_NAME ?? 'Prequest';
  // Reminder cancel URL is intentionally null (see assembleContext docstring);
  // we don't reconstruct it from the hash. The visitor falls back to replying
  // to the email if they need to cancel.
  private readonly batchSize = Number.parseInt(
    process.env.VISITOR_REMINDER_BATCH_SIZE ?? '200',
    10,
  );
  private readonly workerId = `visitor-reminder@${hostname()}/${process.pid}`;
  private running = false;

  constructor(
    private readonly db: DbService,
    @Optional() private readonly supabase: SupabaseService | null,
    @Optional() @Inject(MAIL_PROVIDER) private readonly mail: MailProvider | null,
    @Optional() private readonly mailDelivery: VisitorMailDeliveryAdapter | null,
  ) {}

  /** Hourly tick — top of the hour. */
  @Cron('0 0 * * * *')
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.log.warn(
        `VisitorReminderWorker tick failed: ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Public entry — find candidate visitors + send reminders. Tests
   * call this directly. Returns counts.
   */
  async runOnce(): Promise<{ candidates: number; sent: number; skipped: number; failed: number }> {
    const now = new Date();
    const lower = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const upper = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    const candidates = await this.findCandidates(lower, upper, this.batchSize);
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        const result = await this.processCandidate(c);
        if (result === 'sent') sent++;
        else skipped++;
      } catch (err) {
        failed++;
        this.log.warn(
          `processCandidate failed visitor=${c.id} tenant=${c.tenant_id}: ${(err as Error).message}`,
        );
      }
    }
    return { candidates: candidates.length, sent, skipped, failed };
  }

  /**
   * Find visitors due for a reminder.
   *
   * Filter:
   *   - status = 'expected' (not pending_approval — the approval gate
   *     might still be open; we wait until it grants)
   *   - expected_at in [now+24h, now+25h)
   *   - email is non-null (otherwise no recipient — same skip rule as
   *     the email worker)
   *   - no prior reminder send recorded
   *
   * The "prior send" check is a NOT EXISTS against
   * `email_delivery_events` keyed by `provider_message_id` shape
   * `visitor-reminder:<visitor_id>:<expected_at_iso>`. The reminder
   * idempotency key is built deterministically from the visit
   * occurrence so a clock-skew re-fire dedups at the DB layer.
   */
  private async findCandidates(
    lower: Date,
    upper: Date,
    limit: number,
  ): Promise<ReminderCandidate[]> {
    const sql = `
      select v.id, v.tenant_id, v.expected_at
        from public.visitors v
       where v.status = 'expected'
         and v.email is not null
         and v.expected_at >= $1
         and v.expected_at <  $2
         and not exists (
           select 1 from public.email_delivery_events ede
            where ede.tenant_id = v.tenant_id
              and ede.correlated_entity_type = 'visitor_invite'
              and ede.correlated_entity_id = v.id
              and ede.provider_message_id = 'visitor-reminder:' || v.id::text
                                          || ':' || to_char(v.expected_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         )
       order by v.expected_at asc
       limit $3
    `;
    return this.db.queryMany<ReminderCandidate>(sql, [
      lower.toISOString(),
      upper.toISOString(),
      limit,
    ]);
  }

  private async processCandidate(c: ReminderCandidate): Promise<'sent' | 'skipped'> {
    if (!this.mail || !this.mailDelivery || !this.supabase) {
      throw new Error(
        'VisitorReminderWorker requires MAIL_PROVIDER, VisitorMailDeliveryAdapter, and SupabaseService',
      );
    }

    const idempotencyKey = `visitor-reminder:${c.id}:${normaliseExpectedAt(c.expected_at)}`;

    // Belt-and-braces dedup: even with the NOT EXISTS in findCandidates,
    // a concurrent tick could pick up the same row. Re-check before send.
    const dup = await this.db.queryOne<{ id: string }>(
      `select id from public.email_delivery_events
        where provider_message_id = $1
        limit 1`,
      [idempotencyKey],
    );
    if (dup) return 'skipped';

    return TenantContext.run(
      { id: c.tenant_id, slug: 'visitor_reminder_worker', tier: 'standard' },
      async () => {
        const ctx = await this.assembleContext(c.id, c.tenant_id);
        if (!ctx || !ctx.visitor.email) {
          this.log.warn(
            `cannot assemble reminder ctx for visitor=${c.id}; skipping`,
          );
          return 'skipped';
        }

        const rendered = renderDayBeforeReminder(ctx);

        await this.mail!.send({
          tenantId: c.tenant_id,
          from: this.fromEmail,
          fromName: this.fromName,
          to: ctx.visitor.email,
          toName: [ctx.visitor.first_name, ctx.visitor.last_name].filter(Boolean).join(' '),
          subject: rendered.subject,
          textBody: rendered.textBody,
          htmlBody: rendered.htmlBody,
          idempotencyKey,
          messageStream: 'transactional',
          tags: {
            entity_type: 'visitor_invite',
            visitor_id: c.id,
            tenant_id: c.tenant_id,
            template_kind: 'visitor.invitation.day_before_reminder',
          },
        });

        await this.mailDelivery!.recordSent(c.id, c.tenant_id, idempotencyKey, {
          recipient_email: ctx.visitor.email,
        });

        // Best-effort audit.
        try {
          await this.supabase!.admin.from('audit_events').insert({
            tenant_id: c.tenant_id,
            event_type: 'visitor.email_sent',
            entity_type: 'visitor',
            entity_id: c.id,
            details: {
              visitor_id: c.id,
              kind: 'visitor.invitation.day_before_reminder',
              recipient_email: ctx.visitor.email,
              expected_at: c.expected_at,
              worker_id: this.workerId,
            },
          });
        } catch (err) {
          this.log.warn(
            `audit visitor.email_sent (reminder) failed for visitor=${c.id}: ${(err as Error).message}`,
          );
        }

        return 'sent';
      },
    );
  }

  /**
   * Build the reminder template's render context.
   *
   * Mirrors VisitorEmailWorker.assembleContext but trimmed — the
   * reminder template uses the same `VisitorEmailContext` shape but
   * doesn't need move/room_change extras. We don't share the worker's
   * private `assembleContext` because (a) it's logically separate
   * — the reminder cron may run in a different process boundary in
   * future; (b) sharing forces optional supabase + tight coupling
   * between the two workers.
   */
  private async assembleContext(
    visitorId: string,
    tenantId: string,
  ): Promise<VisitorEmailContext | null> {
    if (!this.supabase) return null;
    const sb = this.supabase.admin;

    const { data: visitorRow } = await sb
      .from('visitors')
      .select(
        'id, tenant_id, status, first_name, last_name, email, expected_at, expected_until, building_id, meeting_room_id, primary_host_person_id, visitor_type_id, notes_for_visitor',
      )
      .eq('id', visitorId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!visitorRow) return null;

    const { data: tenantRow } = await sb
      .from('tenants')
      .select('id, name, branding')
      .eq('id', tenantId)
      .maybeSingle();
    const tenantName = (tenantRow as { name?: string } | null)?.name ?? 'Workplace';
    const branding = ((tenantRow as { branding?: Record<string, unknown> } | null)
      ?.branding ?? {}) as { logo_light_url?: string | null; primary_color?: string };

    let buildingName = 'the office';
    let buildingAddress: string | null = null;
    const buildingId = (visitorRow as { building_id: string | null }).building_id;
    if (buildingId) {
      const { data: spaceRow } = await sb
        .from('spaces')
        .select('id, name, address')
        .eq('id', buildingId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (spaceRow) {
        buildingName = (spaceRow as { name: string }).name;
        buildingAddress = (spaceRow as { address: string | null }).address ?? null;
      }
    }

    let meetingRoom: { name: string } | null = null;
    const meetingRoomId = (visitorRow as { meeting_room_id: string | null }).meeting_room_id;
    if (meetingRoomId) {
      const { data: roomRow } = await sb
        .from('spaces')
        .select('id, name')
        .eq('id', meetingRoomId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (roomRow) meetingRoom = { name: (roomRow as { name: string }).name };
    }

    let hostFirstName = 'your host';
    const hostPersonId = (visitorRow as { primary_host_person_id: string | null })
      .primary_host_person_id;
    if (hostPersonId) {
      const { data: hostRow } = await sb
        .from('persons')
        .select('id, first_name')
        .eq('id', hostPersonId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (hostRow) {
        hostFirstName = (hostRow as { first_name: string | null }).first_name ?? 'your host';
      }
    }

    let visitorType: VisitorEmailContext['visitor_type'] = {
      display_name: 'Guest',
      requires_id_scan: false,
      requires_nda: false,
      requires_photo: false,
    };
    const visitorTypeId = (visitorRow as { visitor_type_id: string | null }).visitor_type_id;
    if (visitorTypeId) {
      const { data: vtRow } = await sb
        .from('visitor_types')
        .select('id, display_name, requires_id_scan, requires_nda, requires_photo')
        .eq('id', visitorTypeId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (vtRow) {
        visitorType = {
          display_name: (vtRow as { display_name: string }).display_name,
          requires_id_scan: !!(vtRow as { requires_id_scan: boolean }).requires_id_scan,
          requires_nda: !!(vtRow as { requires_nda: boolean }).requires_nda,
          requires_photo: !!(vtRow as { requires_photo: boolean }).requires_photo,
        };
      }
    }

    // Reminder cancel URL: the day-before reminder is the only place where
    // we know the visitor still has a valid token (issued at create time
    // with expires_at = expected_at + 24h). We CAN'T construct a fresh
    // plaintext URL from the hash; we surface no URL in the reminder
    // (the visitor can still cancel by replying or contacting reception).
    // This is consistent with the email worker's same behaviour for cascade
    // events that don't carry a fresh plaintext token in their payload.
    const cancelUrl: string | null = null;

    const v = visitorRow as {
      first_name: string;
      last_name: string | null;
      email: string | null;
      expected_at: string;
      expected_until: string | null;
      notes_for_visitor: string | null;
    };

    return {
      tenant: {
        name: tenantName,
        logo_url: branding.logo_light_url ?? null,
        primary_color: branding.primary_color ?? '#0f172a',
      },
      visitor: {
        first_name: v.first_name,
        last_name: v.last_name,
        email: v.email,
      },
      host: {
        first_name: hostFirstName,
      },
      building: {
        name: buildingName,
        address: buildingAddress,
        reception_phone: null,
      },
      meeting_room: meetingRoom,
      expected_at: v.expected_at,
      expected_until: v.expected_until,
      visitor_type: visitorType,
      cancel_url: cancelUrl,
      notes_for_visitor: v.notes_for_visitor,
    };
  }
}

/* ─── helpers ───────────────────────────────────────────────────────────── */

/**
 * Stable string for embedding the expected_at into a dedup key. Postgres
 * returns the timestamp in different precision than `new Date(...).toISOString()`
 * — normalise to second precision UTC so the key matches what the SQL
 * NOT EXISTS clause computes via to_char.
 */
function normaliseExpectedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

interface ReminderCandidate {
  id: string;
  tenant_id: string;
  expected_at: string;
}
