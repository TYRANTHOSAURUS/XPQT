import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfidentialClientApplication, type Configuration } from '@azure/msal-node';
import { Client as GraphClient } from '@microsoft/microsoft-graph-client';
import { randomBytes, createHash } from 'crypto';

/**
 * Calendar sync port — adapter-agnostic interface. Phase H ships only the
 * Outlook implementation; a future Google adapter can satisfy the same shape
 * (the v1 schema's `provider IN ('outlook')` CHECK constraint is the explicit
 * scope guard until Google ships).
 */
export interface CalendarSyncLinkLite {
  id: string;
  user_id: string;
  provider: 'outlook';
  external_calendar_id: string;
  webhook_subscription_id?: string | null;
}

export interface SpaceLite {
  id: string;
  name: string;
  external_calendar_id?: string | null;
  external_calendar_subscription_id?: string | null;
}

export interface ReservationLite {
  id: string;
  tenant_id: string;
  space_id: string;
  start_at: string;
  end_at: string;
  description?: string | null;
  external_event_id?: string | null;
  attendee_emails?: string[];
  organizer_email?: string | null;
}

export interface PushResult {
  externalEventId: string;
  etag: string | null;
}

export interface DeltaResult {
  events: GraphEvent[];
  deltaToken: string | null;
}

export interface GraphEvent {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  organizer: { emailAddress: { address: string; name: string } };
  attendees: Array<{ emailAddress: { address: string; name: string }; type: string }>;
  isCancelled: boolean;
  responseStatus?: { response: string; time: string };
  changeKey?: string;
  /**
   * Where the room mailbox sits — used by inbound translation to identify
   * which Prequest space the invite was sent to.
   */
  location?: { displayName?: string; locationEmailAddress?: string };
}

export interface CalendarSyncPort {
  // User-side
  connect(state: string): { authUrl: string; codeVerifier: string };
  finishConnect(code: string, codeVerifier: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
    externalCalendarId: string;
    userPrincipalEmail: string;
  }>;
  pushEvent(reservation: ReservationLite, link: CalendarSyncLinkLite, accessToken: string): Promise<PushResult>;
  updateEvent(reservation: ReservationLite, link: CalendarSyncLinkLite, accessToken: string): Promise<PushResult>;
  cancelEvent(reservation: ReservationLite, link: CalendarSyncLinkLite, accessToken: string): Promise<void>;
  pullDelta(link: CalendarSyncLinkLite, accessToken: string, since?: string): Promise<DeltaResult>;
  subscribeWebhook(
    link: CalendarSyncLinkLite,
    accessToken: string,
  ): Promise<{ subscriptionId: string; expiresAt: Date }>;
  renewWebhook(
    subscriptionId: string,
    accessToken: string,
  ): Promise<{ expiresAt: Date }>;

  // Room-mailbox side (Pattern A)
  configureRoomMailbox(space: SpaceLite): Promise<{ subscriptionId: string; expiresAt: Date }>;
  acceptOnRoomCalendar(externalEventId: string, space: SpaceLite): Promise<{ etag: string | null }>;
  rejectOnRoomCalendar(externalEventId: string, space: SpaceLite, denialMessage: string): Promise<void>;
  unconfigureRoomMailbox(space: SpaceLite): Promise<void>;
}

/**
 * Microsoft Graph implementation. Reads credentials from env:
 *   - MICROSOFT_CLIENT_ID
 *   - MICROSOFT_CLIENT_SECRET
 *   - MICROSOFT_TENANT_ID    (multi-tenant: 'common' for personal+work; otherwise tenant guid)
 *   - MICROSOFT_REDIRECT_URI (e.g. https://app.example.com/portal/calendar-sync/callback)
 *   - MICROSOFT_GRAPH_WEBHOOK_URL (public HTTPS URL to /api/webhooks/outlook)
 *   - MICROSOFT_GRAPH_WEBHOOK_CLIENT_STATE (shared secret echoed by Graph)
 *
 * Notes:
 *  - Pattern-A room-mailbox operations require the Prequest app to have
 *    Calendars.ReadWrite + MailboxSettings.ReadWrite *application* permissions
 *    on the room mailbox itself, granted by the tenant admin during onboarding.
 *  - Per-user operations use delegated permissions: Calendars.ReadWrite and
 *    offline_access (refresh tokens).
 */
@Injectable()
export class OutlookSyncAdapter implements OnModuleInit, CalendarSyncPort {
  private readonly logger = new Logger(OutlookSyncAdapter.name);

  private clientId!: string;
  private clientSecret!: string;
  private tenantId!: string;
  private redirectUri!: string;
  private webhookUrl!: string;
  private webhookClientState!: string;

  private msal!: ConfidentialClientApplication;

  constructor(private readonly config: ConfigService) {}

  // The delegated scopes we ask the user to consent to. Calendars.ReadWrite
  // gives us read + write to their primary calendar; offline_access gives us
  // a refresh token so we can keep syncing without re-prompting.
  static readonly DELEGATED_SCOPES = [
    'Calendars.ReadWrite',
    'offline_access',
    'openid',
    'profile',
    'email',
    'User.Read',
  ];

  // Application scopes (admin consent) used for Pattern-A room-mailbox flows.
  static readonly APPLICATION_SCOPES = [
    'https://graph.microsoft.com/.default',
  ];

  onModuleInit() {
    const get = (k: string, fallback?: string) => this.config.get<string>(k) ?? fallback ?? '';
    this.clientId = get('MICROSOFT_CLIENT_ID');
    this.clientSecret = get('MICROSOFT_CLIENT_SECRET');
    this.tenantId = get('MICROSOFT_TENANT_ID', 'common');
    this.redirectUri = get('MICROSOFT_REDIRECT_URI');
    this.webhookUrl = get('MICROSOFT_GRAPH_WEBHOOK_URL');
    this.webhookClientState = get('MICROSOFT_GRAPH_WEBHOOK_CLIENT_STATE');

    // The adapter is loaded eagerly even if env isn't fully wired (so unit
    // tests don't need OAuth creds). We log once so misconfigurations show
    // up early in real environments.
    if (!this.clientId || !this.clientSecret) {
      this.logger.warn(
        'OutlookSyncAdapter started without MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET. ' +
          'Calendar sync OAuth will fail until env is set.',
      );
      return;
    }

    const msalConfig: Configuration = {
      auth: {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        authority: `https://login.microsoftonline.com/${this.tenantId}`,
      },
    };
    this.msal = new ConfidentialClientApplication(msalConfig);
  }

  // ─── User-side OAuth ────────────────────────────────────────────────────

  connect(state: string): { authUrl: string; codeVerifier: string } {
    // PKCE: generate verifier + challenge so we don't depend on a server-side
    // session store. The verifier is returned to the caller, persisted with
    // the in-flight `state`, and re-passed to `finishConnect`.
    const codeVerifier = base64UrlEncode(randomBytes(64));
    const codeChallenge = base64UrlEncode(
      createHash('sha256').update(codeVerifier).digest(),
    );

    // Authorisation URL is built directly because msal-node's
    // getAuthCodeUrl expects an async call we don't need at this layer.
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: OutlookSyncAdapter.DELEGATED_SCOPES.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

    const authUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
    return { authUrl, codeVerifier };
  }

  async finishConnect(code: string, codeVerifier: string) {
    const result = await this.msal.acquireTokenByCode({
      code,
      scopes: OutlookSyncAdapter.DELEGATED_SCOPES,
      redirectUri: this.redirectUri,
      codeVerifier,
    });

    if (!result || !result.accessToken) {
      throw new Error('Microsoft Graph did not return an access token');
    }

    // msal-node exposes the refresh token through the in-memory cache.
    const refreshToken = await this.extractRefreshToken();
    if (!refreshToken) {
      throw new Error('Microsoft Graph did not issue a refresh token (offline_access scope missing?)');
    }

    // Resolve the user's primary calendar id.
    const graph = this.graphFor(result.accessToken);
    const cal = (await graph.api('/me/calendar').select('id').get()) as { id: string };
    const me = (await graph
      .api('/me')
      .select('userPrincipalName,mail')
      .get()) as { userPrincipalName: string; mail: string | null };

    return {
      accessToken: result.accessToken,
      refreshToken,
      expiresAt: result.expiresOn ?? new Date(Date.now() + 60 * 60 * 1000),
      externalCalendarId: cal.id,
      userPrincipalEmail: me.mail ?? me.userPrincipalName,
    };
  }

  /** Refreshes an access token using a stored refresh token. */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  }> {
    const result = await this.msal.acquireTokenByRefreshToken({
      refreshToken,
      scopes: OutlookSyncAdapter.DELEGATED_SCOPES,
    });
    if (!result?.accessToken) {
      throw new Error('Microsoft Graph refresh failed');
    }
    const newRefresh = (await this.extractRefreshToken()) ?? refreshToken;
    return {
      accessToken: result.accessToken,
      refreshToken: newRefresh,
      expiresAt: result.expiresOn ?? new Date(Date.now() + 60 * 60 * 1000),
    };
  }

  // msal-node has no public getter for refresh tokens — they live inside
  // the serialised in-memory cache. This is the documented escape hatch
  // (the `serialize()` JSON shape is described in the msal-node-extensions
  // distributed-cache plugin), but it IS an internal contract that can
  // change between minor versions. We harden against that here:
  //   - Look for any node under `RefreshToken` (any version)
  //   - Or `refreshTokens` (older / hypothetical future renames)
  //   - Walk values defensively so a renamed `secret` field doesn't
  //     silently return null. Logs (loud) instead of throwing so the
  //     caller can decide whether to fail-closed.
  // If MSAL ever exposes a public API for this, swap.
  private async extractRefreshToken(): Promise<string | null> {
    try {
      const cache = this.msal.getTokenCache();
      const raw = cache.serialize() ?? '{}';
      const blob = JSON.parse(raw) as Record<string, unknown>;
      const buckets = [blob.RefreshToken, blob.refreshTokens, blob.refresh_tokens]
        .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
      let latest: { secret: string; mtime: number } | null = null;
      for (const bucket of buckets) {
        for (const entry of Object.values(bucket)) {
          if (!entry || typeof entry !== 'object') continue;
          const e = entry as { secret?: unknown; last_modification_time?: unknown };
          const secret = typeof e.secret === 'string' ? e.secret : null;
          if (!secret) continue;
          // last_modification_time is a unix-second string in MSAL 1.x/2.x;
          // when missing, treat as just-issued (now).
          const mtime = Number(e.last_modification_time) || Date.now() / 1000;
          if (!latest || mtime > latest.mtime) latest = { secret, mtime };
        }
      }
      if (!latest) {
        this.logger.warn(
          'No refresh token found in MSAL cache — token shape may have changed in a library update',
        );
      }
      return latest?.secret ?? null;
    } catch (err) {
      this.logger.warn(`Failed to extract refresh token: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Outbound event push (user calendar) ────────────────────────────────

  async pushEvent(
    reservation: ReservationLite,
    link: CalendarSyncLinkLite,
    accessToken: string,
  ): Promise<PushResult> {
    const graph = this.graphFor(accessToken);
    const event = await graph
      .api(`/me/calendars/${link.external_calendar_id}/events`)
      .post(this.toGraphEventPayload(reservation));
    return {
      externalEventId: (event as { id: string }).id,
      etag: ((event as { '@odata.etag'?: string })['@odata.etag'] ?? null),
    };
  }

  async updateEvent(
    reservation: ReservationLite,
    link: CalendarSyncLinkLite,
    accessToken: string,
  ): Promise<PushResult> {
    if (!reservation.external_event_id) {
      return this.pushEvent(reservation, link, accessToken);
    }
    const graph = this.graphFor(accessToken);
    const event = await graph
      .api(`/me/calendars/${link.external_calendar_id}/events/${reservation.external_event_id}`)
      .patch(this.toGraphEventPayload(reservation));
    return {
      externalEventId: (event as { id: string }).id,
      etag: ((event as { '@odata.etag'?: string })['@odata.etag'] ?? null),
    };
  }

  async cancelEvent(
    reservation: ReservationLite,
    link: CalendarSyncLinkLite,
    accessToken: string,
  ): Promise<void> {
    if (!reservation.external_event_id) return;
    const graph = this.graphFor(accessToken);
    await graph
      .api(`/me/calendars/${link.external_calendar_id}/events/${reservation.external_event_id}`)
      .delete();
  }

  // ─── Inbound delta sync ────────────────────────────────────────────────

  async pullDelta(
    link: CalendarSyncLinkLite,
    accessToken: string,
    since?: string,
  ): Promise<DeltaResult> {
    const graph = this.graphFor(accessToken);
    const path = since
      ? `/me/calendars/${link.external_calendar_id}/events/delta?$deltatoken=${encodeURIComponent(since)}`
      : `/me/calendars/${link.external_calendar_id}/events/delta`;
    const res = (await graph.api(path).get()) as {
      value: GraphEvent[];
      '@odata.deltaLink'?: string;
      '@odata.nextLink'?: string;
    };
    const deltaLink = res['@odata.deltaLink'] ?? null;
    const deltaToken = deltaLink ? new URL(deltaLink).searchParams.get('$deltatoken') : null;
    return { events: res.value ?? [], deltaToken };
  }

  // ─── Webhooks (push subscriptions) ─────────────────────────────────────

  async subscribeWebhook(
    link: CalendarSyncLinkLite,
    accessToken: string,
  ): Promise<{ subscriptionId: string; expiresAt: Date }> {
    return this.createSubscription({
      resource: `/me/calendars/${link.external_calendar_id}/events`,
      accessToken,
    });
  }

  async renewWebhook(
    subscriptionId: string,
    accessToken: string,
  ): Promise<{ expiresAt: Date }> {
    const graph = this.graphFor(accessToken);
    // Graph allows max 3 days for /me/events subscriptions; we always renew to
    // the maximum so the cron can run hourly without thinking about cadence.
    const expiresAt = new Date(Date.now() + 3 * 24 * 3600 * 1000 - 60_000);
    await graph.api(`/subscriptions/${subscriptionId}`).patch({
      expirationDateTime: expiresAt.toISOString(),
    });
    return { expiresAt };
  }

  // ─── Room-mailbox flows (Pattern A) ────────────────────────────────────

  async configureRoomMailbox(space: SpaceLite): Promise<{ subscriptionId: string; expiresAt: Date }> {
    if (!space.external_calendar_id) {
      throw new Error(`Space ${space.id} has no external_calendar_id (room mailbox UPN)`);
    }
    const accessToken = await this.acquireAppToken();

    // 1. Force auto-accept off so Prequest gets first chance at every invite.
    //    The `mailboxSettings` endpoint accepts a partial calendar processing
    //    config: AutomateProcessing=AutoAccept|AutoUpdate|None. We set None.
    const graph = this.graphFor(accessToken);
    try {
      await graph
        .api(`/users/${encodeURIComponent(space.external_calendar_id)}/mailboxSettings`)
        .patch({
          // Outlook's room-mailbox auto-accept is governed by an Exchange
          // setting that isn't fully exposed via Graph; we still set the
          // mailbox-level flag we have, and the admin-onboarding doc covers
          // the Exchange Online portion (Set-CalendarProcessing
          // -AutomateProcessing None).
          automaticRepliesSetting: { status: 'disabled' },
        });
    } catch (err) {
      this.logger.warn(
        `Could not flip mailbox settings on ${space.external_calendar_id}: ${(err as Error).message}. ` +
          `Admin must run Set-CalendarProcessing -AutomateProcessing None manually.`,
      );
    }

    // 2. Subscribe to events on the room mailbox calendar.
    return this.createSubscription({
      resource: `/users/${encodeURIComponent(space.external_calendar_id)}/events`,
      accessToken,
    });
  }

  async acceptOnRoomCalendar(
    externalEventId: string,
    space: SpaceLite,
  ): Promise<{ etag: string | null }> {
    const accessToken = await this.acquireAppToken();
    const graph = this.graphFor(accessToken);
    if (!space.external_calendar_id) {
      throw new Error(`Space ${space.id} has no external_calendar_id`);
    }
    // accept doesn't return the event body, but a follow-up GET gives the etag.
    await graph
      .api(`/users/${encodeURIComponent(space.external_calendar_id)}/events/${externalEventId}/accept`)
      .post({ comment: 'Confirmed via Prequest', sendResponse: true });
    const ev = (await graph
      .api(`/users/${encodeURIComponent(space.external_calendar_id)}/events/${externalEventId}`)
      .select('id')
      .get()) as { '@odata.etag'?: string };
    return { etag: ev['@odata.etag'] ?? null };
  }

  async rejectOnRoomCalendar(
    externalEventId: string,
    space: SpaceLite,
    denialMessage: string,
  ): Promise<void> {
    const accessToken = await this.acquireAppToken();
    const graph = this.graphFor(accessToken);
    if (!space.external_calendar_id) {
      throw new Error(`Space ${space.id} has no external_calendar_id`);
    }
    await graph
      .api(`/users/${encodeURIComponent(space.external_calendar_id)}/events/${externalEventId}/decline`)
      .post({ comment: denialMessage, sendResponse: true });
  }

  async unconfigureRoomMailbox(space: SpaceLite): Promise<void> {
    if (!space.external_calendar_subscription_id) return;
    const accessToken = await this.acquireAppToken();
    const graph = this.graphFor(accessToken);
    try {
      await graph.api(`/subscriptions/${space.external_calendar_subscription_id}`).delete();
    } catch (err) {
      this.logger.warn(`Subscription delete failed: ${(err as Error).message}`);
    }
  }

  // ─── App-only token (for Pattern-A room mailbox) ───────────────────────

  private async acquireAppToken(): Promise<string> {
    const result = await this.msal.acquireTokenByClientCredential({
      scopes: OutlookSyncAdapter.APPLICATION_SCOPES,
    });
    if (!result?.accessToken) {
      throw new Error('Microsoft Graph app-only token acquisition failed');
    }
    return result.accessToken;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async createSubscription(opts: {
    resource: string;
    accessToken: string;
  }): Promise<{ subscriptionId: string; expiresAt: Date }> {
    if (!this.webhookUrl) {
      throw new Error('MICROSOFT_GRAPH_WEBHOOK_URL is not configured');
    }
    const graph = this.graphFor(opts.accessToken);
    const expiresAt = new Date(Date.now() + 3 * 24 * 3600 * 1000 - 60_000);
    const sub = (await graph.api('/subscriptions').post({
      changeType: 'created,updated,deleted',
      notificationUrl: this.webhookUrl,
      resource: opts.resource,
      expirationDateTime: expiresAt.toISOString(),
      clientState: this.webhookClientState,
    })) as { id: string };
    return { subscriptionId: sub.id, expiresAt };
  }

  private graphFor(accessToken: string): GraphClient {
    return GraphClient.init({
      authProvider: (done) => done(null, accessToken),
    });
  }

  private toGraphEventPayload(reservation: ReservationLite): Record<string, unknown> {
    const body = {
      subject: reservation.description ?? 'Prequest reservation',
      body: { contentType: 'text', content: reservation.description ?? '' },
      start: { dateTime: reservation.start_at, timeZone: 'UTC' },
      end: { dateTime: reservation.end_at, timeZone: 'UTC' },
      attendees: (reservation.attendee_emails ?? []).map((address) => ({
        emailAddress: { address, name: address },
        type: 'required',
      })),
      // Tag every Prequest-originated event so reconciler can ignore them
      // when scanning room calendars (avoids false-positive orphan_external).
      singleValueExtendedProperties: [
        {
          id: 'String {00020329-0000-0000-C000-000000000046} Name PrequestReservationId',
          value: reservation.id,
        },
      ],
    };
    return body;
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
