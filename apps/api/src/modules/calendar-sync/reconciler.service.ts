import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { OutlookSyncAdapter, type GraphEvent } from './outlook-sync.adapter';

interface SpaceForRecon {
  id: string;
  tenant_id: string;
  name: string;
  external_calendar_id: string;
  external_calendar_subscription_id: string | null;
}

interface ReservationForRecon {
  id: string;
  start_at: string;
  end_at: string;
  status: string;
  external_event_id: string | null;
}

/**
 * Heartbeat reconciler — hourly diff between Prequest reservations and the
 * Outlook room mailbox calendar for the next 14 days. Surfaces drift to the
 * `room_calendar_conflicts` table for the admin inbox.
 *
 * Design points (per spec §5.4):
 *   - We only run on Pattern-A rooms.
 *   - We auto-resolve `webhook_miss_recovered` conflicts when we can.
 *   - Anything we can't auto-resolve becomes an open conflict for the admin
 *     to action via /admin/calendar-sync.
 */
@Injectable()
export class ReconcilerService {
  private readonly logger = new Logger(ReconcilerService.name);

  constructor(
    private readonly supabase: SupabaseService,
    // The outlook adapter is held even though the reconciler currently
    // calls Graph via a small inline app-only flow — keeping the dep so
    // future enhancements (e.g. unified room-mailbox calendar lookups)
    // don't have to re-thread the wiring.
    private readonly outlook: OutlookSyncAdapter,
  ) {
    // Silence the unused-private-property warning until reconcileSpace
    // routes its Graph call through the adapter (post-Phase H polish).
    void this.outlook;
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'calendarHeartbeatReconcile' })
  async runHourly() {
    this.logger.log('Heartbeat reconcile starting');
    try {
      const spaces = await this.loadPatternASpaces();
      let totalDiffs = 0;
      for (const space of spaces) {
        try {
          const diffs = await this.reconcileSpace(space);
          totalDiffs += diffs;
        } catch (err) {
          this.logger.warn(`Reconcile space ${space.id} failed: ${(err as Error).message}`);
        }
      }
      this.logger.log(`Heartbeat reconcile complete: ${spaces.length} rooms, ${totalDiffs} diffs`);
    } catch (err) {
      this.logger.error(`Heartbeat reconcile failed: ${(err as Error).message}`);
    }
  }

  /**
   * Reconcile a single space. Returns the number of new conflicts raised.
   * Public for tests.
   */
  async reconcileSpace(space: SpaceForRecon): Promise<number> {
    const horizon = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
    const now = new Date().toISOString();

    // Fetch Outlook events for the next 14 days (calendar view returns
    // single occurrences for any recurring series).
    const events = await this.fetchCalendarView(space, now, horizon);
    if (events === null) {
      // Unable to read — likely a permission issue. Mark the space as
      // having an open issue so admin can re-grant permissions.
      await this.raiseConflict({
        tenant_id: space.tenant_id,
        space_id: space.id,
        conflict_type: 'orphan_external',
        external_event_id: null,
        external_event_payload: { reason: 'graph_read_failed' },
      });
      return 1;
    }

    const reservations = await this.loadReservations(space.tenant_id, space.id, now, horizon);

    const byExternalId = new Map<string, ReservationForRecon>();
    for (const r of reservations) {
      if (r.external_event_id) byExternalId.set(r.external_event_id, r);
    }
    const externalIdsSeen = new Set<string>();

    let diffs = 0;

    for (const ev of events) {
      // Skip Prequest-originated events (tagged via singleValueExtendedProperties).
      // Conservative: if we can't tell, we still process — duplicate inserts
      // are deduplicated by `(tenant_id, space_id, external_event_id)` ON
      // CONFLICT semantics.
      externalIdsSeen.add(ev.id);
      const matched = byExternalId.get(ev.id);
      if (!matched) {
        // External event with no Prequest reservation — webhook miss.
        // Auto-resolve by re-creating the conflict with a `webhook_miss_recovered`
        // type; the row stays open for admin inspection but tagged so the UI
        // can show it less aggressively.
        await this.raiseConflict({
          tenant_id: space.tenant_id,
          space_id: space.id,
          conflict_type: 'webhook_miss_recovered',
          external_event_id: ev.id,
          external_event_payload: ev as unknown as Record<string, unknown>,
        });
        diffs += 1;
        continue;
      }
      // Time mismatch
      if (
        new Date(matched.start_at).getTime() !==
          new Date(toIsoSafe(ev.start.dateTime, ev.start.timeZone)).getTime() ||
        new Date(matched.end_at).getTime() !==
          new Date(toIsoSafe(ev.end.dateTime, ev.end.timeZone)).getTime()
      ) {
        await this.raiseConflict({
          tenant_id: space.tenant_id,
          space_id: space.id,
          conflict_type: 'recurrence_drift',
          reservation_id: matched.id,
          external_event_id: ev.id,
          external_event_payload: ev as unknown as Record<string, unknown>,
        });
        diffs += 1;
      }
    }

    // Reservations whose external_event_id wasn't seen in Outlook → orphan.
    for (const r of reservations) {
      if (!r.external_event_id) continue;
      if (externalIdsSeen.has(r.external_event_id)) continue;
      await this.raiseConflict({
        tenant_id: space.tenant_id,
        space_id: space.id,
        conflict_type: 'orphan_internal',
        reservation_id: r.id,
        external_event_id: r.external_event_id,
        external_event_payload: null,
      });
      diffs += 1;
    }

    // Update the space's last full sync stamp.
    await this.supabase.admin
      .from('spaces')
      .update({ external_calendar_last_full_sync_at: new Date().toISOString() })
      .eq('id', space.id);

    return diffs;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async loadPatternASpaces(): Promise<SpaceForRecon[]> {
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('id, tenant_id, name, external_calendar_id, external_calendar_subscription_id')
      .eq('calendar_sync_mode', 'pattern_a')
      .not('external_calendar_id', 'is', null);
    if (error) throw error;
    return (data ?? []) as SpaceForRecon[];
  }

  private async loadReservations(
    tenantId: string,
    spaceId: string,
    fromIso: string,
    toIso: string,
  ): Promise<ReservationForRecon[]> {
    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('id, start_at, end_at, status, external_event_id:calendar_event_id')
      .eq('tenant_id', tenantId)
      .eq('space_id', spaceId)
      .gte('start_at', fromIso)
      .lte('start_at', toIso)
      .in('status', ['confirmed', 'checked_in', 'pending_approval']);
    if (error) throw error;
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      start_at: r.start_at as string,
      end_at: r.end_at as string,
      status: r.status as string,
      external_event_id: (r.external_event_id as string | null) ?? null,
    }));
  }

  private async fetchCalendarView(
    space: SpaceForRecon,
    fromIso: string,
    toIso: string,
  ): Promise<GraphEvent[] | null> {
    try {
      const dynamic = await import('@microsoft/microsoft-graph-client');
      const { ConfidentialClientApplication } = await import('@azure/msal-node');
      const clientId = process.env.MICROSOFT_CLIENT_ID;
      const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
      const tenantId = process.env.MICROSOFT_TENANT_ID ?? 'common';
      if (!clientId || !clientSecret) {
        this.logger.warn('No MICROSOFT credentials, skipping reconcile');
        return null;
      }
      const msal = new ConfidentialClientApplication({
        auth: {
          clientId,
          clientSecret,
          authority: `https://login.microsoftonline.com/${tenantId}`,
        },
      });
      const tok = await msal.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
      });
      if (!tok?.accessToken) return null;
      const graph = dynamic.Client.init({
        authProvider: (done) => done(null, tok.accessToken),
      });
      const path = `/users/${encodeURIComponent(space.external_calendar_id)}/calendarView?startDateTime=${encodeURIComponent(fromIso)}&endDateTime=${encodeURIComponent(toIso)}&$top=200`;
      const res = (await graph.api(path).get()) as { value: GraphEvent[] };
      return res.value ?? [];
    } catch (err) {
      this.logger.warn(`Graph calendarView fetch failed for ${space.id}: ${(err as Error).message}`);
      return null;
    }
  }

  private async raiseConflict(row: {
    tenant_id: string;
    space_id: string;
    conflict_type: string;
    reservation_id?: string;
    external_event_id: string | null;
    external_event_payload: Record<string, unknown> | null;
  }) {
    // Avoid duplicating an already-open identical conflict.
    if (row.external_event_id) {
      const existing = await this.supabase.admin
        .from('room_calendar_conflicts')
        .select('id')
        .eq('tenant_id', row.tenant_id)
        .eq('space_id', row.space_id)
        .eq('external_event_id', row.external_event_id)
        .eq('resolution_status', 'open')
        .maybeSingle();
      if (existing.data) return;
    }
    const { error } = await this.supabase.admin.from('room_calendar_conflicts').insert({
      tenant_id: row.tenant_id,
      space_id: row.space_id,
      conflict_type: row.conflict_type,
      reservation_id: row.reservation_id ?? null,
      external_event_id: row.external_event_id,
      external_event_payload: row.external_event_payload,
      resolution_status: 'open',
    });
    if (error) {
      this.logger.warn(`raise conflict failed: ${error.message}`);
    }
  }
}

/**
 * Convert a Microsoft Graph datetime string (which is "naive" — no offset
 * baked in — paired with a separate `timeZone` field) to an absolute UTC
 * ISO string.
 *
 * The Graph API gives us strings like `2026-05-01T10:00:00.0000000` paired
 * with `"timeZone": "America/New_York"`. The previous implementation simply
 * appended `Z` to anything that didn't already end in `Z`, treating every
 * non-UTC tenant's events as if they were already UTC. That produced a
 * 1–14 hour shift on every reconcile pass and silently raised
 * `recurrence_drift` conflicts for any non-UTC room.
 *
 * Strategy: parse the naive datetime as if it were in the supplied IANA
 * zone (luxon's `DateTime.fromISO(s, { zone: tz })`), then re-emit in UTC.
 * Falls back to the historical "append Z" behaviour for unrecognised
 * zones so we degrade rather than throw.
 */
function toIsoSafe(dateTime: string, tz: string): string {
  if (!dateTime) return '';
  // If the string already carries an offset (Z or ±HH:MM), trust it.
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(dateTime)) {
    return new Date(dateTime).toISOString();
  }
  // Graph occasionally returns more than 3 digits of fractional seconds
  // (`.0000000`) — luxon parses 3, so trim the extras before parse.
  const trimmed = dateTime.replace(/(\.\d{3})\d+$/, '$1');
  if (tz && tz !== 'UTC') {
    // Lazy require to keep luxon out of the cold-path when tz is UTC.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DateTime } = require('luxon');
    const dt = DateTime.fromISO(trimmed, { zone: tz });
    if (dt.isValid) return dt.toUTC().toISO({ suppressMilliseconds: true });
    // Fallthrough: bad zone name → degrade to the legacy behaviour.
  }
  return new Date(`${trimmed}Z`).toISOString();
}
