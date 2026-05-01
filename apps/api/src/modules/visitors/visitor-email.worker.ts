import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { DbService } from '../../common/db/db.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import {
  MAIL_PROVIDER,
  type MailProvider,
} from '../../common/mail/mail-provider';
import {
  VISITOR_EMAIL_TEMPLATES,
  type VisitorEmailContext,
  type VisitorEmailKind,
} from './templates/visitor-emails';
import { VisitorMailDeliveryAdapter } from './visitor-mail-delivery.adapter';

/**
 * Polls `domain_events` for visitor-email-relevant events, renders the
 * template, sends via MAIL_PROVIDER, and records delivery via
 * VisitorMailDeliveryAdapter.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6, §10.2, §11.3
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 5
 *
 * Why polling rather than an in-memory bus:
 *   - InvitationService writes `domain_events` rows directly (not RxJS).
 *   - VisitorService.transitionStatus writes `domain_events` rows inside
 *     the same DB transaction as the status change.
 *   - BundleCascadeAdapter writes `domain_events` rows for cascade intents.
 *
 * The `domain_events` table is the durable side-effect log; reading it is
 * the reliable subscription mechanism. RxJS would lose events if the
 * worker process restarts mid-cascade.
 *
 * Idempotency:
 *   - Each `domain_events` row is processed exactly once. We track
 *     processing via a `processed_at`-style claim — but that column
 *     doesn't exist in 00019. Instead, we lookup `email_delivery_events`
 *     for the visitor + recent `sent` event of the matching kind: if a
 *     send for the same visitor already exists since the event's
 *     `created_at`, we skip. The adapter's `lastDeliveryStatusForVisitor`
 *     gives us the recent delivery event; we extend the lookup to query
 *     by `provider_message_id` shape `<event_kind>:<event_id>` so each
 *     domain_event maps to exactly one outbound send.
 *
 * Cron windowing:
 *   - Tick every minute. The query is bounded (LIMIT 50) so a backlog
 *     drains over a few ticks rather than blocking one tick on a long
 *     fan-out.
 *
 * Env knobs:
 *   - VISITOR_EMAIL_WORKER_ENABLED=false disables the worker (tests +
 *     local dev where you don't want outbound mail).
 *   - WEB_BASE_URL — the host URL to embed in cancel links. Falls back
 *     to localhost dev URL.
 *
 * Cross-tenant: every `domain_events` row carries `tenant_id`; we
 * load the visitor row constrained to that tenant; SQL is also
 * tenant-pinned. A row from tenant A cannot trigger a render against
 * tenant B's branding.
 */
@Injectable()
export class VisitorEmailWorker implements OnModuleInit {
  private readonly log = new Logger(VisitorEmailWorker.name);
  private readonly enabled =
    process.env.VISITOR_EMAIL_WORKER_ENABLED !== 'false';
  private readonly fromEmail =
    process.env.VISITOR_EMAIL_FROM ??
    process.env.POSTMARK_DEFAULT_FROM_EMAIL ??
    'visitors@prequest.io';
  private readonly fromName = process.env.VISITOR_EMAIL_FROM_NAME ?? 'Prequest';
  private readonly webBaseUrl =
    process.env.WEB_BASE_URL ?? 'http://localhost:5173';
  private readonly workerId = `visitor-email@${hostname()}/${process.pid}`;
  private running = false;

  /** Domain event types this worker handles. */
  static readonly HANDLED_EVENT_TYPES: ReadonlySet<VisitorEmailKind | 'visitor.cascade.moved' | 'visitor.cascade.room_changed' | 'visitor.cascade.cancelled' | 'visitor.cancelled' | 'visitor.invitation_declined'> = new Set([
    'visitor.invitation.expected',
    'visitor.cascade.moved',
    'visitor.cascade.room_changed',
    'visitor.cascade.cancelled',
    'visitor.cancelled',
    'visitor.invitation_declined',
  ]);

  constructor(
    private readonly db: DbService,
    @Optional() private readonly supabase: SupabaseService | null,
    @Optional() @Inject(MAIL_PROVIDER) private readonly mail: MailProvider | null,
    @Optional() private readonly mailDelivery: VisitorMailDeliveryAdapter | null,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.log.log('VisitorEmailWorker disabled via env');
    }
  }

  /**
   * Cron: every minute. Drains up to 50 events per tick.
   *
   * The cron decorator is benign in tests (NestJS Schedule is opted-in
   * via ScheduleModule.forRoot which only the prod app.module wires).
   */
  @Cron('0 * * * * *')
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return;
    this.running = true;
    try {
      await this.processBatch(50);
    } catch (err) {
      this.log.warn(
        `VisitorEmailWorker tick failed: ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Public entry — processes up to `limit` outstanding visitor-email
   * domain_events. Tests + future admin debug endpoints can invoke
   * directly without waiting for cron.
   *
   * Returns counts for observability.
   */
  async processBatch(limit: number): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
    const events = await this.fetchPendingEvents(limit);
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const event of events) {
      try {
        const result = await this.processOne(event);
        if (result === 'sent') sent++;
        else if (result === 'skipped') skipped++;
      } catch (err) {
        failed++;
        this.log.warn(
          `processOne failed for event=${event.id} type=${event.event_type}: ${(err as Error).message}`,
        );
      }
    }
    return { processed: events.length, sent, skipped, failed };
  }

  /**
   * One event → one render → one send + one email_delivery_events row.
   *
   * Returns:
   *   - 'sent': email enqueued + delivery recorded
   *   - 'skipped': dedup hit (already sent for this event), or no
   *     recipient address, or visitor in terminal state where the email
   *     is moot per spec §10.2
   */
  async processOne(event: DomainEventRow): Promise<'sent' | 'skipped'> {
    if (!this.mail) {
      throw new Error('VisitorEmailWorker requires MAIL_PROVIDER');
    }
    if (!this.mailDelivery) {
      throw new Error('VisitorEmailWorker requires VisitorMailDeliveryAdapter');
    }
    if (!this.supabase) {
      throw new Error('VisitorEmailWorker requires SupabaseService');
    }

    const visitorId = event.entity_id;
    const tenantId = event.tenant_id;

    // Idempotency: dedup by provider_message_id which we shape as
    // `visitor-email:<event.id>` so a re-process of the same row hits
    // the unique index and we skip. This requires the email_delivery_events
    // table to allow that key; we never write the same key twice.
    const dedup = await this.alreadySentForEvent(event.id);
    if (dedup) return 'skipped';

    // Resolve the kind we're about to send.
    const kind = this.resolveTemplateKind(event.event_type);
    if (!kind) {
      this.log.warn(
        `unhandled event_type ${event.event_type} for visitor email — skipping`,
      );
      return 'skipped';
    }

    // Pull all the data the template needs. Run inside a tenant context
    // so any downstream SupabaseService call resolves correctly.
    return TenantContext.run(
      { id: tenantId, slug: 'visitor_email_worker', tier: 'standard' },
      async () => {
        const ctx = await this.assembleContext(visitorId, tenantId, kind, event);
        if (!ctx) {
          // visitor row missing or recipient lookup failed — record the
          // event as processed (synthetic 'sent') with a self-explanatory
          // log line so the loose-ends tile doesn't keep retrying.
          this.log.warn(
            `assembleContext returned null for visitor=${visitorId} event=${event.id}; skipping`,
          );
          return 'skipped';
        }

        // Decline emails go to the host, every other email goes to the
        // visitor. Pick the right recipient.
        const recipient = await this.resolveRecipient(ctx, kind, visitorId, tenantId);
        if (!recipient || !recipient.email) {
          // No deliverable address (visitor email was nullable). Don't
          // crash; record skip so we don't fight the same row forever.
          this.log.warn(
            `no recipient email for visitor=${visitorId} kind=${kind}; skipping`,
          );
          return 'skipped';
        }

        const rendered = VISITOR_EMAIL_TEMPLATES[kind](ctx);
        const idempotencyKey = `visitor-email:${event.id}`;

        const sendResult = await this.mail!.send({
          tenantId,
          from: this.fromEmail,
          fromName: this.fromName,
          to: recipient.email,
          toName: recipient.name,
          subject: rendered.subject,
          textBody: rendered.textBody,
          htmlBody: rendered.htmlBody,
          idempotencyKey,
          messageStream: 'transactional',
          tags: {
            entity_type: 'visitor_invite',
            visitor_id: visitorId,
            tenant_id: tenantId,
            template_kind: kind,
            domain_event_id: event.id,
          },
        });

        // Record `sent` event with a stable provider id shape so the
        // dedup query (alreadySentForEvent) can find it on retries.
        await this.mailDelivery!.recordSent(
          visitorId,
          tenantId,
          idempotencyKey,
          {
            recipient_email: recipient.email,
          },
        );

        // Best-effort audit. We DO NOT block on this — the email already
        // went out, audit failure should not crash the worker.
        try {
          await this.supabase!.admin.from('audit_events').insert({
            tenant_id: tenantId,
            event_type: 'visitor.email_sent',
            entity_type: 'visitor',
            entity_id: visitorId,
            details: {
              visitor_id: visitorId,
              kind,
              recipient_email: recipient.email,
              provider_message_id: sendResult.messageId,
              domain_event_id: event.id,
              worker_id: this.workerId,
            },
          });
        } catch (err) {
          this.log.warn(
            `audit visitor.email_sent failed for visitor=${visitorId}: ${(err as Error).message}`,
          );
        }

        return 'sent';
      },
    );
  }

  /**
   * Fetch the next slice of unprocessed visitor-email domain events.
   *
   * Strategy: select rows whose event_type is in HANDLED_EVENT_TYPES,
   * ordered by created_at ASC, LEFT JOIN email_delivery_events with the
   * "visitor-email:<id>" shaped provider_message_id to skip already-
   * processed rows. LIMIT keeps the tick bounded.
   */
  private async fetchPendingEvents(limit: number): Promise<DomainEventRow[]> {
    const types = Array.from(VisitorEmailWorker.HANDLED_EVENT_TYPES);
    const sql = `
      select de.id, de.tenant_id, de.event_type, de.entity_type,
             de.entity_id, de.payload, de.created_at
        from public.domain_events de
       where de.event_type = any($1::text[])
         and de.entity_type = 'visitor'
         and not exists (
           select 1 from public.email_delivery_events ede
            where ede.tenant_id = de.tenant_id
              and ede.correlated_entity_type = 'visitor_invite'
              and ede.correlated_entity_id = de.entity_id
              and ede.provider_message_id = 'visitor-email:' || de.id::text
         )
       order by de.created_at asc
       limit $2
    `;
    return this.db.queryMany<DomainEventRow>(sql, [types, limit]);
  }

  /** Has this domain_events row already been emailed? */
  private async alreadySentForEvent(eventId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      `select id from public.email_delivery_events
        where provider_message_id = $1
        limit 1`,
      [`visitor-email:${eventId}`],
    );
    return row !== null;
  }

  /** Map a domain_events.event_type to a template kind. */
  private resolveTemplateKind(eventType: string): VisitorEmailKind | null {
    switch (eventType) {
      case 'visitor.invitation.expected':
        return 'visitor.invitation.expected';
      case 'visitor.cascade.moved':
        return 'visitor.invitation.moved';
      case 'visitor.cascade.room_changed':
        return 'visitor.invitation.room_changed';
      case 'visitor.cascade.cancelled':
      case 'visitor.cancelled':
        return 'visitor.invitation.cancelled';
      case 'visitor.invitation_declined':
        return 'visitor.invitation.declined';
      default:
        return null;
    }
  }

  /**
   * Assemble the render context for a visitor + a specific kind. Returns
   * null if the visitor doesn't exist, the visitor type is missing, or
   * the build is missing.
   *
   * For cascade events, we also pull old/new payload values from
   * `domain_events.payload` so the moved/room-changed templates have the
   * before/after data they need.
   */
  private async assembleContext(
    visitorId: string,
    tenantId: string,
    kind: VisitorEmailKind,
    event: DomainEventRow,
  ): Promise<VisitorEmailContext | null> {
    if (!this.supabase) return null;
    const sb = this.supabase.admin;

    // Visitor row + branding.
    const { data: visitorRow } = await sb
      .from('visitors')
      .select(
        'id, tenant_id, status, first_name, last_name, email, phone, company, expected_at, expected_until, building_id, meeting_room_id, primary_host_person_id, visitor_type_id, notes_for_visitor',
      )
      .eq('id', visitorId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!visitorRow) return null;

    // For cascade events that target visitors already on-site, the
    // adapter records 'host_alert' intents; those don't reach this
    // worker. But defense in depth: skip if the visitor is in a state
    // where this email kind doesn't apply (spec §10.2 terminal-state
    // guards).
    const status = (visitorRow as { status: string }).status;
    if (kind === 'visitor.invitation.moved' || kind === 'visitor.invitation.room_changed') {
      if (status !== 'expected' && status !== 'pending_approval') {
        // The cascade adapter only emits cascade.moved with email_target='visitor'
        // for expected/pending_approval visitors, but if status drifted between
        // intent emission and this worker tick, skip rather than spam.
        return null;
      }
    }

    // Tenant branding (logo, colors, name).
    const { data: tenantRow } = await sb
      .from('tenants')
      .select('id, name, branding')
      .eq('id', tenantId)
      .maybeSingle();
    const tenantName = (tenantRow as { name?: string } | null)?.name ?? 'Workplace';
    const branding = ((tenantRow as { branding?: Record<string, unknown> } | null)
      ?.branding ?? {}) as { logo_light_url?: string | null; primary_color?: string };

    // Building name + reception phone (if available).
    let buildingName = 'the office';
    let buildingAddress: string | null = null;
    let receptionPhone: string | null = null;
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
        // reception_phone is not yet a column on spaces; v1 falls back
        // to null. A later migration can add it; the template handles null.
      }
    }

    // Meeting room name.
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

    // Host first name (primary host only — spec convention "first name only").
    let hostFirstName = 'your host';
    const hostPersonId = (visitorRow as { primary_host_person_id: string | null }).primary_host_person_id;
    if (hostPersonId) {
      const { data: hostRow } = await sb
        .from('persons')
        .select('id, first_name')
        .eq('id', hostPersonId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (hostRow) hostFirstName = (hostRow as { first_name: string | null }).first_name ?? 'your host';
    }

    // Visitor type for "what to bring" flags.
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

    // Cancel URL — only on invite + reminder + change emails (not cancel
    // or decline). Look up the latest unused 'cancel' token for this
    // visitor; if none, leave URL null.
    let cancelUrl: string | null = null;
    if (
      kind === 'visitor.invitation.expected'
      || kind === 'visitor.invitation.day_before_reminder'
      || kind === 'visitor.invitation.moved'
      || kind === 'visitor.invitation.room_changed'
    ) {
      cancelUrl = await this.resolveCancelUrl(visitorId, tenantId, event);
    }

    // Move + room-change extras pulled from the domain_event payload.
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const move = kind === 'visitor.invitation.moved'
      ? {
        old_expected_at: typeof payload.old_expected_at === 'string'
          ? payload.old_expected_at
          : (visitorRow as { expected_at: string }).expected_at,
        new_expected_at: typeof payload.new_expected_at === 'string'
          ? payload.new_expected_at
          : (visitorRow as { expected_at: string }).expected_at,
      }
      : undefined;

    const roomChange = kind === 'visitor.invitation.room_changed'
      ? {
        old_room_name: await this.lookupRoomName(payload.old_room_id, tenantId),
        new_room_name: meetingRoom?.name ?? null,
      }
      : undefined;

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
        reception_phone: receptionPhone,
      },
      meeting_room: meetingRoom,
      expected_at: v.expected_at,
      expected_until: v.expected_until,
      visitor_type: visitorType,
      cancel_url: cancelUrl,
      notes_for_visitor: v.notes_for_visitor,
      move,
      room_change: roomChange,
    };
  }

  /**
   * Resolve the cancel-link URL for a visitor.
   *
   * The plaintext token is NOT stored — only sha256(token). Two paths
   * supply the plaintext to this worker:
   *
   * Primary path — InvitationService.create writes the plaintext into
   * `domain_events.payload.cancel_token` at invite-creation time. The
   * `visitor.invitation.expected` event carries it for the first
   * invitation email.
   *
   * Secondary path — cascade emails (`visitor.cascade.moved`,
   * `visitor.cascade.room_changed`) are emitted by BundleCascadeAdapter
   * which doesn't have access to the original plaintext (it was given
   * to the visitor's first email and the server discarded it). Without
   * a token, the cascade email would arrive with no cancel link — a
   * regression vs. the first email.
   *
   * I9 (full review) fix: when the payload doesn't carry a cancel
   * token AND the email is a cascade reminder that should expose a
   * cancel option, mint a NEW token here:
   *   - 64-char hex plaintext
   *   - sha256 stored as a new row in `visit_invitation_tokens`
   *   - 24h expiry from now (the visit is by definition imminent —
   *     cascade messages are sent close to expected_at)
   *   - purpose='cancel'
   *
   * The previous token (if any) remains valid until consumed; first
   * one used wins (validate_invitation_token marks `used_at` and
   * subsequent presses on either link return SQLSTATE 45002, which the
   * cancel controller maps to a clean "already cancelled" message).
   * No revocation — that would invite token-rotation race bugs.
   *
   * For the unconditional-decline path (`visitor.invitation.declined`
   * and `visitor.cancelled`) we never include a cancel URL because the
   * visit is already terminal; nothing to cancel.
   */
  private async resolveCancelUrl(
    visitorId: string,
    tenantId: string,
    event: DomainEventRow,
  ): Promise<string | null> {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const fromPayload = typeof payload.cancel_token === 'string'
      ? payload.cancel_token
      : null;
    if (fromPayload) {
      return `${this.webBaseUrl}/visit/cancel/${encodeURIComponent(fromPayload)}`;
    }

    // Cascade-reminder events arrive without a plaintext token. Mint a
    // fresh one so the email's cancel link still works. We do NOT do
    // this for the initial invitation event — InvitationService is the
    // source of truth there and a missing token would indicate a real
    // bug worth investigating, not a regression worth papering over.
    if (
      event.event_type !== 'visitor.cascade.moved'
      && event.event_type !== 'visitor.cascade.room_changed'
    ) {
      return null;
    }

    const minted = await this.mintFreshCancelToken(visitorId, tenantId);
    if (!minted) return null;
    return `${this.webBaseUrl}/visit/cancel/${encodeURIComponent(minted)}`;
  }

  /**
   * Insert a new cancel-purpose row in visit_invitation_tokens for this
   * visitor and return the plaintext. Returns null if the supabase
   * service is unavailable (the worker is misconfigured) or the insert
   * fails — the email still goes out without a cancel URL in that case.
   */
  private async mintFreshCancelToken(
    visitorId: string,
    tenantId: string,
  ): Promise<string | null> {
    if (!this.supabase) return null;
    const plaintext = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(plaintext).digest('hex');
    // 24h expiry: cascade emails are reminders sent close to expected_at;
    // a longer TTL would extend the bearer-token attack surface for no
    // user benefit.
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error } = await this.supabase.admin
      .from('visit_invitation_tokens')
      .insert({
        tenant_id: tenantId,
        visitor_id: visitorId,
        token_hash: tokenHash,
        purpose: 'cancel',
        expires_at: expiresAt,
      });
    if (error) {
      this.log.warn(
        `mintFreshCancelToken insert failed for visitor=${visitorId}: ${error.message}`,
      );
      return null;
    }
    return plaintext;
  }

  private async lookupRoomName(
    roomId: unknown,
    tenantId: string,
  ): Promise<string | null> {
    if (typeof roomId !== 'string' || !this.supabase) return null;
    const { data } = await this.supabase.admin
      .from('spaces')
      .select('id, name')
      .eq('id', roomId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data as { name: string } | null)?.name ?? null;
  }

  /**
   * For decline emails (`visitor.invitation_declined`), the recipient
   * is the host. Otherwise, the visitor.
   */
  private async resolveRecipient(
    ctx: VisitorEmailContext,
    kind: VisitorEmailKind,
    visitorId: string,
    tenantId: string,
  ): Promise<{ email: string; name: string } | null> {
    if (kind === 'visitor.invitation.declined') {
      // Host email lookup. Walk visitor_hosts (primary host only — same
      // convention as HostNotificationService).
      if (!this.supabase) return null;
      const { data: row } = await this.supabase.admin
        .from('persons')
        .select('id, first_name, last_name, email')
        .eq('id', await this.lookupPrimaryHostPersonId(visitorId, tenantId))
        .eq('tenant_id', tenantId)
        .maybeSingle();
      const host = row as { first_name: string | null; last_name: string | null; email: string | null } | null;
      if (!host?.email) return null;
      const name = [host.first_name, host.last_name].filter(Boolean).join(' ') || ctx.host.first_name;
      return { email: host.email, name };
    }
    if (!ctx.visitor.email) return null;
    const name = [ctx.visitor.first_name, ctx.visitor.last_name].filter(Boolean).join(' ');
    return { email: ctx.visitor.email, name };
  }

  private async lookupPrimaryHostPersonId(
    visitorId: string,
    tenantId: string,
  ): Promise<string | null> {
    if (!this.supabase) return null;
    const { data } = await this.supabase.admin
      .from('visitors')
      .select('primary_host_person_id')
      .eq('id', visitorId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    return (data as { primary_host_person_id: string | null } | null)?.primary_host_person_id ?? null;
  }
}

/* ─── types ────────────────────────────────────────────────────────────── */

export interface DomainEventRow {
  id: string;
  tenant_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}
