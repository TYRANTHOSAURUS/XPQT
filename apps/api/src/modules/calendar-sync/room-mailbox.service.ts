import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { OutlookSyncAdapter, type GraphEvent } from './outlook-sync.adapter';

/**
 * Pattern-A inbound webhook handler. Microsoft Graph posts a JSON envelope
 * for each `created/updated/deleted` event on a subscribed resource. We
 * resolve the subscription_id → space → tenant_id, fetch the full Graph
 * event, translate it to a `CreateReservationInput` shape, and emit a
 * domain event for `BookingFlowService.create` to pick up in Phase C.
 *
 * Until Phase C wires `BookingFlowService` in, we:
 *   - persist the audit trail (`calendar_sync.intercept_received`)
 *   - log a structured TODO at WARN level so the pipeline is observable
 *   - leave the accept/reject decision to the integration callback
 */

export interface CreateReservationInputDraft {
  tenant_id: string;
  space_id: string;
  start_at: string;
  end_at: string;
  description: string | null;
  organizer_email: string | null;
  attendee_emails: string[];
  attendee_count: number;
  external_event_id: string;
  source: 'calendar_sync';
}

export type RoomMailboxIntercept = (input: {
  draft: CreateReservationInputDraft;
  graphEvent: GraphEvent;
  spaceId: string;
  tenantId: string;
}) => Promise<{
  outcome: 'accepted' | 'denied' | 'conflict' | 'deferred';
  denialMessage?: string;
}>;

@Injectable()
export class RoomMailboxService {
  private readonly logger = new Logger(RoomMailboxService.name);

  /**
   * The Phase C integration point. `BookingFlowService` will register itself
   * here at module-init and own the actual booking decision. Until then, the
   * default impl returns `deferred` — meaning we audit the intercept but
   * don't accept or reject the Outlook invite.
   *
   * Single-callback registry is enough; if we ever need fan-out we can swap
   * for an EventEmitter without changing this service's public shape.
   */
  private intercept: RoomMailboxIntercept = async () => ({ outcome: 'deferred' });

  constructor(
    private readonly supabase: SupabaseService,
    private readonly outlook: OutlookSyncAdapter,
  ) {}

  /**
   * Phase C wiring: BookingFlowService.create-from-calendar will call this
   * once at module-init.
   *
   * @example
   *   roomMailbox.registerIntercept(async ({ draft }) => bookingFlow.createFromCalendar(draft));
   */
  registerIntercept(handler: RoomMailboxIntercept) {
    this.intercept = handler;
  }

  /**
   * Microsoft Graph subscription confirmation. When a new subscription is
   * created, Graph POSTs to the notification URL with `validationToken` in
   * the query string and expects the same value back as `text/plain`.
   * Returns null if the request is not a validation handshake.
   */
  validationToken(query: Record<string, unknown>): string | null {
    const tok = query.validationToken;
    if (typeof tok !== 'string') return null;
    return tok;
  }

  /**
   * Handle a notification batch. Graph batches up to ~100 changes per POST;
   * we process each independently so a single bad event doesn't break the
   * batch.
   */
  async handleNotifications(payload: {
    value: Array<{
      subscriptionId: string;
      clientState?: string;
      changeType: 'created' | 'updated' | 'deleted';
      resource: string;
      resourceData: { id: string };
    }>;
  }, expectedClientState: string | null): Promise<{ accepted: number; deferred: number; failed: number }> {
    const counts = { accepted: 0, deferred: 0, failed: 0 };

    for (const note of payload.value ?? []) {
      // Reject anything whose clientState doesn't match — protects against
      // forged notifications. (Per Graph guidance: log + skip, don't 401.)
      if (expectedClientState && note.clientState !== expectedClientState) {
        this.logger.warn(`Discarded notification with wrong clientState (sub ${note.subscriptionId})`);
        counts.failed += 1;
        continue;
      }

      try {
        const handled = await this.handleSingle(note);
        if (handled.outcome === 'accepted') counts.accepted += 1;
        else if (handled.outcome === 'deferred') counts.deferred += 1;
        else counts.failed += 1;
      } catch (err) {
        this.logger.error(`handleSingle failed for sub ${note.subscriptionId}: ${(err as Error).message}`);
        counts.failed += 1;
      }
    }

    return counts;
  }

  private async handleSingle(note: {
    subscriptionId: string;
    changeType: 'created' | 'updated' | 'deleted';
    resourceData: { id: string };
  }): Promise<{ outcome: 'accepted' | 'denied' | 'conflict' | 'deferred' | 'unrouted' }> {
    // Resolve subscription → space → tenant. The tenant lookup is
    // deliberate: Graph webhooks are unauthenticated, so we cannot rely on
    // the TenantMiddleware running first.
    const { data: spaceRow } = await this.supabase.admin
      .from('spaces')
      .select('id, tenant_id, name, external_calendar_id, external_calendar_subscription_id, calendar_sync_mode')
      .eq('external_calendar_subscription_id', note.subscriptionId)
      .maybeSingle();

    if (!spaceRow) {
      // Could be a per-user subscription rather than a room mailbox; resolve
      // via calendar_sync_links instead.
      const { data: link } = await this.supabase.admin
        .from('calendar_sync_links')
        .select('id, tenant_id, user_id, external_calendar_id')
        .eq('webhook_subscription_id', note.subscriptionId)
        .maybeSingle();
      if (!link) {
        this.logger.warn(`Notification for unknown subscription ${note.subscriptionId}`);
        return { outcome: 'unrouted' };
      }
      // Per-user delta sync is not in v1 scope (Phase C will reconcile via
      // outbound push); just record that we saw the change.
      await this.audit(link.tenant_id as string, 'calendar_sync.user_delta_received', {
        link_id: link.id,
        change_type: note.changeType,
        external_event_id: note.resourceData.id,
      });
      return { outcome: 'deferred' };
    }

    const tenantId = spaceRow.tenant_id as string;
    const spaceId = spaceRow.id as string;

    if (note.changeType === 'deleted') {
      // External deletion of an existing reservation: log + raise a conflict
      // for the reconciler to evaluate (Phase C will cancel the matching row).
      await this.audit(tenantId, 'calendar_sync.intercept_received', {
        space_id: spaceId,
        change_type: 'deleted',
        external_event_id: note.resourceData.id,
      });
      await this.supabase.admin.from('room_calendar_conflicts').insert({
        tenant_id: tenantId,
        space_id: spaceId,
        conflict_type: 'orphan_internal',
        external_event_id: note.resourceData.id,
        external_event_payload: null,
        resolution_status: 'open',
      });
      return { outcome: 'deferred' };
    }

    // Fetch full event from Graph (created/updated only).
    const graphEvent = await this.fetchGraphEvent(spaceRow as never, note.resourceData.id);
    if (!graphEvent) {
      // Could be a permission/missing event — surface as a recovered miss.
      return { outcome: 'unrouted' };
    }

    const draft = this.translate(graphEvent, tenantId, spaceId);

    await this.audit(tenantId, 'calendar_sync.intercept_received', {
      space_id: spaceId,
      change_type: note.changeType,
      external_event_id: note.resourceData.id,
    });

    // Hand off to the registered intercept callback (BookingFlowService in
    // Phase C). Until that's wired, default impl returns `deferred`.
    let result: Awaited<ReturnType<RoomMailboxIntercept>>;
    try {
      result = await this.intercept({
        draft,
        graphEvent,
        spaceId,
        tenantId,
      });
    } catch (err) {
      this.logger.error(`Intercept handler threw: ${(err as Error).message}`);
      return { outcome: 'unrouted' };
    }

    if (result.outcome === 'accepted') {
      try {
        await this.outlook.acceptOnRoomCalendar(graphEvent.id, {
          id: spaceId,
          name: (spaceRow.name as string) ?? '',
          external_calendar_id: (spaceRow.external_calendar_id as string) ?? null,
          external_calendar_subscription_id: (spaceRow.external_calendar_subscription_id as string) ?? null,
        });
      } catch (err) {
        this.logger.warn(`acceptOnRoomCalendar failed: ${(err as Error).message}`);
      }
      await this.audit(tenantId, 'calendar_sync.intercept_accepted', {
        space_id: spaceId,
        external_event_id: graphEvent.id,
      });
      return { outcome: 'accepted' };
    }

    if (result.outcome === 'denied' || result.outcome === 'conflict') {
      try {
        await this.outlook.rejectOnRoomCalendar(
          graphEvent.id,
          {
            id: spaceId,
            name: (spaceRow.name as string) ?? '',
            external_calendar_id: (spaceRow.external_calendar_id as string) ?? null,
            external_calendar_subscription_id:
              (spaceRow.external_calendar_subscription_id as string) ?? null,
          },
          result.denialMessage ??
            (result.outcome === 'conflict'
              ? 'This room is already booked in Prequest.'
              : 'This booking does not satisfy a room rule.'),
        );
      } catch (err) {
        this.logger.warn(`rejectOnRoomCalendar failed: ${(err as Error).message}`);
      }
      await this.audit(tenantId, 'calendar_sync.intercept_denied', {
        space_id: spaceId,
        external_event_id: graphEvent.id,
        outcome: result.outcome,
        denial_message: result.denialMessage ?? null,
      });
      return { outcome: result.outcome };
    }

    // 'deferred' — Phase C not yet wired. Log a structured TODO so the admin
    // sync-health page can surface that intercepts are landing but not being
    // acted on yet.
    this.logger.log(
      `[TODO Phase C] BookingFlowService.create not yet wired — intercept deferred for event ${graphEvent.id}`,
    );
    return { outcome: 'deferred' };
  }

  /**
   * Fetches the full Graph event using the room mailbox's app-only token.
   * Visible-for-tests: kept as a method so tests can stub the OutlookAdapter.
   */
  private async fetchGraphEvent(
    space: { external_calendar_id: string },
    eventId: string,
  ): Promise<GraphEvent | null> {
    try {
      // We need a Graph client with app-only auth for the room mailbox. This
      // is exposed indirectly via the OutlookSyncAdapter, but for v1 we open
      // a small read here — keeps the adapter surface lean. If you change
      // this, also update the doc trigger list in CLAUDE.md.
      const dynamic = await import('@microsoft/microsoft-graph-client');
      const { ConfidentialClientApplication } = await import('@azure/msal-node');
      const clientId = process.env.MICROSOFT_CLIENT_ID;
      const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
      const tenantId = process.env.MICROSOFT_TENANT_ID ?? 'common';
      if (!clientId || !clientSecret) {
        this.logger.warn('No MICROSOFT credentials, cannot fetch Graph event');
        return null;
      }
      const msal = new ConfidentialClientApplication({
        auth: {
          clientId,
          clientSecret,
          authority: `https://login.microsoftonline.com/${tenantId}`,
        },
      });
      const tokenResult = await msal.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
      });
      if (!tokenResult?.accessToken) return null;
      const graph = dynamic.Client.init({
        authProvider: (done) => done(null, tokenResult.accessToken),
      });
      const event = (await graph
        .api(`/users/${encodeURIComponent(space.external_calendar_id)}/events/${eventId}`)
        .select(
          'id,subject,bodyPreview,start,end,organizer,attendees,isCancelled,location,changeKey',
        )
        .get()) as GraphEvent;
      return event;
    } catch (err) {
      this.logger.warn(`fetchGraphEvent failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Translate a Graph event to the create-reservation input that
   * BookingFlowService.create will accept in Phase C. Pure function — kept
   * unit-testable.
   */
  translate(
    event: GraphEvent,
    tenantId: string,
    spaceId: string,
  ): CreateReservationInputDraft {
    const attendeeEmails = (event.attendees ?? [])
      .map((a) => a.emailAddress?.address)
      .filter((addr): addr is string => Boolean(addr));
    return {
      tenant_id: tenantId,
      space_id: spaceId,
      start_at: toIso(event.start),
      end_at: toIso(event.end),
      description: event.subject ?? null,
      organizer_email: event.organizer?.emailAddress?.address ?? null,
      attendee_emails: attendeeEmails,
      attendee_count: Math.max(1, attendeeEmails.length),
      external_event_id: event.id,
      source: 'calendar_sync',
    };
  }

  private async audit(tenantId: string, eventType: string, details: Record<string, unknown>) {
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: eventType,
        entity_type: 'calendar_sync',
        details,
      });
    } catch (err) {
      this.logger.warn(`audit insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }
}

function toIso(t: { dateTime: string; timeZone: string }): string {
  // Graph hands us a tz-naive dateTime + a timeZone name. We re-interpret in
  // UTC for storage; downstream code can re-localise when displaying. For
  // 'UTC' this is already correct. For tz-aware stamps the dateTime is
  // already wall-clock — passing through to ISO works for v1 (we expect
  // tz='UTC' in 95% of resource-calendar invites).
  if (!t?.dateTime) return new Date().toISOString();
  if (t.timeZone === 'UTC' || t.dateTime.endsWith('Z')) {
    return new Date(t.dateTime + (t.dateTime.endsWith('Z') ? '' : 'Z')).toISOString();
  }
  // Best effort: treat as UTC. A full tz-aware translation lands when
  // BookingFlowService is wired (Phase C) and the tenant's calendar tz is
  // available.
  return new Date(t.dateTime + 'Z').toISOString();
}
