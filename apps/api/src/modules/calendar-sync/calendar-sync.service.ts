import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { OutlookSyncAdapter } from './outlook-sync.adapter';
import { TokenEncryptionService } from './token-encryption.service';
import type {
  CalendarSyncLinkView,
  ConnectStartResponse,
  ConflictView,
  ResolveConflictBody,
  SyncHealthRoom,
} from './dto';

interface ActorRef {
  authUid: string;
  userId: string | null;
}

interface OAuthState {
  authUid: string;
  codeVerifier: string;
  createdAt: number;
}

/**
 * Top-level orchestrator. Wires the OutlookSyncAdapter, encryption, and the
 * persistence layer together.
 *
 * The OAuth state-machine is kept in-memory (small, short-lived). For a
 * multi-process deployment this will need to move to Redis — flagged in
 * the integration TODO at the bottom of the file.
 */
@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);

  // Short-lived OAuth state map. 10-minute TTL covers user-paced flows.
  private readonly oauthStates = new Map<string, OAuthState>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly outlook: OutlookSyncAdapter,
    private readonly tokens: TokenEncryptionService,
  ) {}

  // ─── User-side ─────────────────────────────────────────────────────────

  async getMyLink(authUid: string): Promise<CalendarSyncLinkView | null> {
    const { userId } = await this.resolveActor(authUid);
    const { data, error } = await this.supabase.admin
      .from('calendar_sync_links')
      .select(
        'id, user_id, provider, external_calendar_id, sync_status, last_synced_at, last_error, expires_at, webhook_subscription_id, webhook_expires_at',
      )
      .eq('user_id', userId)
      .eq('provider', 'outlook')
      .maybeSingle();
    if (error) throw error;
    return (data as CalendarSyncLinkView | null) ?? null;
  }

  async connect(authUid: string): Promise<ConnectStartResponse> {
    await this.resolveActor(authUid); // ensures the caller is in this tenant
    const state = randomToken(32);
    const { authUrl, codeVerifier } = this.outlook.connect(state);
    this.oauthStates.set(state, { authUid, codeVerifier, createdAt: Date.now() });
    this.gcOAuthStates();
    return { authUrl, state };
  }

  async finishConnect(authUid: string, code: string, state: string) {
    const stored = this.oauthStates.get(state);
    if (!stored) throw new BadRequestException('Unknown or expired OAuth state');
    if (stored.authUid !== authUid) {
      throw new ForbiddenException('OAuth state belongs to a different user');
    }
    this.oauthStates.delete(state);

    const { userId } = await this.resolveActor(authUid);
    const tokens = await this.outlook.finishConnect(code, stored.codeVerifier);
    const tenant = TenantContext.current();

    const access = await this.tokens.encrypt(tokens.accessToken);
    const refresh = await this.tokens.encrypt(tokens.refreshToken);

    const { data: link, error } = await this.supabase.admin
      .from('calendar_sync_links')
      .upsert(
        {
          tenant_id: tenant.id,
          user_id: userId,
          provider: 'outlook',
          access_token_encrypted: access,
          refresh_token_encrypted: refresh,
          expires_at: tokens.expiresAt.toISOString(),
          external_calendar_id: tokens.externalCalendarId,
          sync_status: 'active',
          last_synced_at: new Date().toISOString(),
          last_error: null,
        },
        { onConflict: 'user_id,provider' },
      )
      .select(
        'id, user_id, provider, external_calendar_id, sync_status, last_synced_at, last_error, expires_at, webhook_subscription_id, webhook_expires_at',
      )
      .single();
    if (error) throw error;

    // Subscribe to webhook so we don't have to poll for changes. Best-effort —
    // a failure here shouldn't break the connection itself; the renew cron
    // will try again later.
    try {
      const sub = await this.outlook.subscribeWebhook(
        { id: link.id, user_id: userId, provider: 'outlook', external_calendar_id: tokens.externalCalendarId },
        tokens.accessToken,
      );
      await this.supabase.admin
        .from('calendar_sync_links')
        .update({
          webhook_subscription_id: sub.subscriptionId,
          webhook_expires_at: sub.expiresAt.toISOString(),
        })
        .eq('id', link.id);
    } catch (err) {
      this.logger.warn(`Webhook subscription failed for link ${link.id}: ${(err as Error).message}`);
    }

    await this.audit('calendar_sync.connected', {
      user_id: userId,
      provider: 'outlook',
      principal_email: tokens.userPrincipalEmail,
    });

    return link as CalendarSyncLinkView;
  }

  async disconnect(authUid: string): Promise<{ ok: true }> {
    const { userId } = await this.resolveActor(authUid);
    const tenant = TenantContext.current();
    const { data: link } = await this.supabase.admin
      .from('calendar_sync_links')
      .select('id, refresh_token_encrypted, webhook_subscription_id')
      .eq('user_id', userId)
      .eq('provider', 'outlook')
      .maybeSingle();

    if (link?.webhook_subscription_id) {
      // Best-effort cleanup; we still delete the row even if Graph 404s.
      try {
        const accessToken = await this.refreshAccessToken(link.refresh_token_encrypted as string);
        await this.outlook.renewWebhook(link.webhook_subscription_id as string, accessToken).catch(() => undefined);
      } catch (err) {
        this.logger.warn(`Webhook cleanup failed: ${(err as Error).message}`);
      }
    }

    await this.supabase.admin
      .from('calendar_sync_links')
      .delete()
      .eq('user_id', userId)
      .eq('provider', 'outlook')
      .eq('tenant_id', tenant.id);

    await this.audit('calendar_sync.disconnected', { user_id: userId, provider: 'outlook' });
    return { ok: true };
  }

  async forceResync(authUid: string): Promise<{ ok: true; events_seen: number }> {
    const { userId } = await this.resolveActor(authUid);
    const { data: link, error } = await this.supabase.admin
      .from('calendar_sync_links')
      .select('id, external_calendar_id, refresh_token_encrypted')
      .eq('user_id', userId)
      .eq('provider', 'outlook')
      .maybeSingle();
    if (error) throw error;
    if (!link) throw new NotFoundException('No outlook calendar linked');

    const accessToken = await this.refreshAccessToken(link.refresh_token_encrypted as string);
    const delta = await this.outlook.pullDelta(
      { id: link.id as string, user_id: userId, provider: 'outlook', external_calendar_id: link.external_calendar_id as string },
      accessToken,
    );

    await this.supabase.admin
      .from('calendar_sync_links')
      .update({ last_synced_at: new Date().toISOString(), last_error: null, sync_status: 'active' })
      .eq('id', link.id);

    await this.audit('calendar_sync.force_resync', {
      user_id: userId,
      events_seen: delta.events.length,
    });
    return { ok: true, events_seen: delta.events.length };
  }

  // ─── Admin: sync health + conflicts ────────────────────────────────────

  async health(): Promise<{ rooms: SyncHealthRoom[]; counters: Record<string, number> }> {
    const tenant = TenantContext.current();

    const { data: spaces, error: spacesError } = await this.supabase.admin
      .from('spaces')
      .select(
        `id, name, calendar_sync_mode, external_calendar_id,
         external_calendar_subscription_id, external_calendar_subscription_expires_at,
         external_calendar_last_full_sync_at`,
      )
      .eq('tenant_id', tenant.id)
      .eq('reservable', true);
    if (spacesError) throw spacesError;

    const { data: openConflicts } = await this.supabase.admin
      .from('room_calendar_conflicts')
      .select('id, space_id, resolution_status')
      .eq('tenant_id', tenant.id)
      .eq('resolution_status', 'open');

    const openBySpace = new Map<string, number>();
    for (const c of (openConflicts ?? []) as Array<{ space_id: string }>) {
      openBySpace.set(c.space_id, (openBySpace.get(c.space_id) ?? 0) + 1);
    }

    // Counters across the tenant (for the header strip on /admin/calendar-sync).
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { count: interceptedCount } = await this.supabase.admin
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('event_type', 'calendar_sync.intercept_received')
      .gte('created_at', since);
    const { count: acceptedCount } = await this.supabase.admin
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('event_type', 'calendar_sync.intercept_accepted')
      .gte('created_at', since);
    const { count: deniedCount } = await this.supabase.admin
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('event_type', 'calendar_sync.intercept_denied')
      .gte('created_at', since);
    const { count: unresolvedCount } = await this.supabase.admin
      .from('room_calendar_conflicts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('resolution_status', 'open');

    const rooms: SyncHealthRoom[] = (spaces ?? []).map((s) => ({
      space_id: s.id as string,
      space_name: (s.name as string) ?? '',
      calendar_sync_mode: ((s.calendar_sync_mode as string) ?? 'pattern_b') as
        | 'pattern_a'
        | 'pattern_b',
      external_calendar_id: (s.external_calendar_id as string | null) ?? null,
      external_calendar_subscription_id:
        (s.external_calendar_subscription_id as string | null) ?? null,
      external_calendar_subscription_expires_at:
        (s.external_calendar_subscription_expires_at as string | null) ?? null,
      external_calendar_last_full_sync_at:
        (s.external_calendar_last_full_sync_at as string | null) ?? null,
      open_conflicts: openBySpace.get(s.id as string) ?? 0,
      // We surface tenant-wide counters at the top; per-room breakdown of the
      // last 30 days is a follow-up enhancement. For v1, leave the per-room
      // numbers as 0 unless we have audit_events scoped by entity_id=space_id.
      last_30d: { intercepted: 0, accepted: 0, denied: 0, unresolved: openBySpace.get(s.id as string) ?? 0 },
    }));

    return {
      rooms,
      counters: {
        intercepted_30d: interceptedCount ?? 0,
        accepted_30d: acceptedCount ?? 0,
        denied_30d: deniedCount ?? 0,
        unresolved_open: unresolvedCount ?? 0,
      },
    };
  }

  async listConflicts(filter: { status?: string; limit?: number }): Promise<ConflictView[]> {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('room_calendar_conflicts')
      .select(
        `id, space_id, detected_at, conflict_type, slot_id, external_event_id,
         external_event_payload, resolution_status, resolution_action, resolved_at, resolved_by,
         space:spaces(name)`,
      )
      .eq('tenant_id', tenant.id)
      .order('detected_at', { ascending: false })
      .limit(Math.min(filter.limit ?? 100, 500));
    if (filter.status) query = query.eq('resolution_status', filter.status);
    const { data, error } = await query;
    if (error) throw error;
    return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      space_id: row.space_id as string,
      space_name: ((row.space as { name?: string } | null)?.name) ?? null,
      detected_at: row.detected_at as string,
      conflict_type: row.conflict_type as ConflictView['conflict_type'],
      slot_id: (row.slot_id as string | null) ?? null,
      external_event_id: (row.external_event_id as string | null) ?? null,
      external_event_payload:
        (row.external_event_payload as Record<string, unknown> | null) ?? null,
      resolution_status: row.resolution_status as ConflictView['resolution_status'],
      resolution_action: (row.resolution_action as string | null) ?? null,
      resolved_at: (row.resolved_at as string | null) ?? null,
      resolved_by: (row.resolved_by as string | null) ?? null,
    }));
  }

  async resolveConflict(
    conflictId: string,
    body: ResolveConflictBody,
    actor: ActorRef,
  ): Promise<ConflictView> {
    const tenant = TenantContext.current();
    // Resolve the actor's user id if the controller didn't supply it.
    let resolvedUserId = actor.userId;
    if (!resolvedUserId && actor.authUid) {
      try {
        const r = await this.resolveActor(actor.authUid);
        resolvedUserId = r.userId;
      } catch {
        // fall through — resolved_by stays null, which is allowed by the schema
      }
    }
    const { data: conflict, error: cErr } = await this.supabase.admin
      .from('room_calendar_conflicts')
      .select('id, space_id, external_event_id, slot_id, resolution_status')
      .eq('id', conflictId)
      .eq('tenant_id', tenant.id)
      .single();
    if (cErr || !conflict) throw new NotFoundException('Conflict not found');
    if (conflict.resolution_status !== 'open') {
      throw new BadRequestException('Conflict is not open');
    }

    // The actual ext-system mutation happens on a best-effort basis here;
    // BookingFlowService.cancel/create wiring lands in Phase C.
    let action = body.action;
    try {
      const { data: space } = await this.supabase.admin
        .from('spaces')
        .select('id, name, external_calendar_id, external_calendar_subscription_id')
        .eq('id', conflict.space_id)
        .single();
      if (space && conflict.external_event_id && body.action === 'keep_internal') {
        await this.outlook.rejectOnRoomCalendar(
          conflict.external_event_id as string,
          {
            id: space.id,
            name: space.name,
            external_calendar_id: space.external_calendar_id,
            external_calendar_subscription_id: space.external_calendar_subscription_id,
          },
          body.note ?? 'Cancelled in Prequest',
        );
      }
      // keep_external / recreate flows hook into BookingFlowService (Phase C).
    } catch (err) {
      this.logger.warn(`Conflict resolution side-effect failed: ${(err as Error).message}`);
    }

    const { data: updated, error: uErr } = await this.supabase.admin
      .from('room_calendar_conflicts')
      .update({
        resolution_status:
          body.action === 'wont_fix' ? 'wont_fix' : 'admin_resolved',
        resolution_action: action,
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedUserId,
      })
      .eq('id', conflictId)
      .select(
        `id, space_id, detected_at, conflict_type, slot_id, external_event_id,
         external_event_payload, resolution_status, resolution_action, resolved_at, resolved_by,
         space:spaces(name)`,
      )
      .single();
    if (uErr) throw uErr;

    await this.audit('calendar_sync.conflict_resolved', {
      conflict_id: conflictId,
      action,
      note: body.note ?? null,
    });

    return {
      id: updated.id as string,
      space_id: updated.space_id as string,
      space_name: ((updated.space as { name?: string } | null)?.name) ?? null,
      detected_at: updated.detected_at as string,
      conflict_type: updated.conflict_type as ConflictView['conflict_type'],
      slot_id: (updated.slot_id as string | null) ?? null,
      external_event_id: (updated.external_event_id as string | null) ?? null,
      external_event_payload:
        (updated.external_event_payload as Record<string, unknown> | null) ?? null,
      resolution_status: updated.resolution_status as ConflictView['resolution_status'],
      resolution_action: (updated.resolution_action as string | null) ?? null,
      resolved_at: (updated.resolved_at as string | null) ?? null,
      resolved_by: (updated.resolved_by as string | null) ?? null,
    };
  }

  // ─── Internal helpers (also used by webhook + cron services) ───────────

  /**
   * Decrypts the stored refresh token and exchanges it for a fresh access
   * token. Updates the row's encrypted refresh token if Microsoft rotated it.
   */
  async refreshAccessToken(refreshTokenEncrypted: string): Promise<string> {
    const refresh = await this.tokens.decrypt(refreshTokenEncrypted);
    const result = await this.outlook.refreshAccessToken(refresh);
    return result.accessToken;
  }

  /**
   * Refresh-and-persist variant — updates the calendar_sync_links row with
   * any new tokens Microsoft handed back. Webhook + cron use this so the
   * next call doesn't need another refresh.
   */
  async refreshAndPersist(linkId: string): Promise<{ accessToken: string }> {
    const { data: row, error } = await this.supabase.admin
      .from('calendar_sync_links')
      .select('id, refresh_token_encrypted')
      .eq('id', linkId)
      .single();
    if (error || !row) throw new NotFoundException('Sync link not found');
    const refresh = await this.tokens.decrypt(row.refresh_token_encrypted as string);
    const result = await this.outlook.refreshAccessToken(refresh);
    const newRefresh = await this.tokens.encrypt(result.refreshToken);
    const newAccess = await this.tokens.encrypt(result.accessToken);
    await this.supabase.admin
      .from('calendar_sync_links')
      .update({
        access_token_encrypted: newAccess,
        refresh_token_encrypted: newRefresh,
        expires_at: result.expiresAt.toISOString(),
        last_synced_at: new Date().toISOString(),
        sync_status: 'active',
        last_error: null,
      })
      .eq('id', linkId);
    return { accessToken: result.accessToken };
  }

  async markLinkError(linkId: string, message: string): Promise<void> {
    await this.supabase.admin
      .from('calendar_sync_links')
      .update({
        sync_status: 'error',
        last_error: message,
      })
      .eq('id', linkId);
  }

  async getLinkByUser(userId: string) {
    const { data } = await this.supabase.admin
      .from('calendar_sync_links')
      .select('id, tenant_id, user_id, refresh_token_encrypted, external_calendar_id, webhook_subscription_id, webhook_expires_at')
      .eq('user_id', userId)
      .eq('provider', 'outlook')
      .maybeSingle();
    return data;
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────

  private async resolveActor(authUid: string): Promise<{ userId: string }> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ForbiddenException('No user in this tenant');
    return { userId: data.id as string };
  }

  private async audit(eventType: string, details: Record<string, unknown>) {
    try {
      const tenant = TenantContext.currentOrNull();
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenant?.id ?? null,
        event_type: eventType,
        entity_type: 'calendar_sync',
        details,
      });
    } catch (err) {
      this.logger.warn(`audit insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }

  private gcOAuthStates() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [state, entry] of this.oauthStates) {
      if (entry.createdAt < cutoff) this.oauthStates.delete(state);
    }
  }
}

function randomToken(bytes: number): string {
  return Buffer.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
  )
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}
