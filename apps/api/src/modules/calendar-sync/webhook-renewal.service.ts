import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { CalendarSyncService } from './calendar-sync.service';
import { OutlookSyncAdapter } from './outlook-sync.adapter';

/**
 * Microsoft Graph subscriptions max out at ~3 days for /events resources.
 * Both crons run hourly; they only act on subscriptions expiring in the next
 * hour. This means a missed run still has 2 hours of slack before the
 * subscription would actually expire.
 *
 * The two cron methods are deliberately separate so we can disable one half
 * (e.g. user-side renewals) independently without affecting the other.
 */
@Injectable()
export class WebhookRenewalService {
  private readonly logger = new Logger(WebhookRenewalService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly outlook: OutlookSyncAdapter,
    private readonly sync: CalendarSyncService,
  ) {}

  /** Renew per-user calendar webhook subscriptions (Pattern B + delta sync). */
  @Cron(CronExpression.EVERY_HOUR, { name: 'outlookWebhookRenew' })
  async renewUserSubscriptions() {
    const cutoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { data: links, error } = await this.supabase.admin
      .from('calendar_sync_links')
      .select('id, user_id, external_calendar_id, refresh_token_encrypted, webhook_subscription_id, webhook_expires_at')
      .eq('provider', 'outlook')
      .eq('sync_status', 'active')
      .not('webhook_subscription_id', 'is', null)
      .lt('webhook_expires_at', cutoff);
    if (error) {
      this.logger.error(`outlookWebhookRenew query failed: ${error.message}`);
      return;
    }
    for (const link of links ?? []) {
      try {
        const { accessToken } = await this.sync.refreshAndPersist(link.id as string);
        const result = await this.outlook.renewWebhook(
          link.webhook_subscription_id as string,
          accessToken,
        );
        await this.supabase.admin
          .from('calendar_sync_links')
          .update({ webhook_expires_at: result.expiresAt.toISOString() })
          .eq('id', link.id);
        this.logger.log(`Renewed user webhook ${link.webhook_subscription_id}`);
      } catch (err) {
        this.logger.warn(`User webhook renew failed (${link.id}): ${(err as Error).message}`);
        await this.sync.markLinkError(link.id as string, (err as Error).message);
      }
    }
  }

  /** Renew Pattern-A room mailbox webhook subscriptions. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'roomMailboxWebhookRenew' })
  async renewRoomSubscriptions() {
    const cutoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { data: spaces, error } = await this.supabase.admin
      .from('spaces')
      .select('id, name, external_calendar_id, external_calendar_subscription_id, external_calendar_subscription_expires_at')
      .eq('calendar_sync_mode', 'pattern_a')
      .not('external_calendar_subscription_id', 'is', null)
      .lt('external_calendar_subscription_expires_at', cutoff);
    if (error) {
      this.logger.error(`roomMailboxWebhookRenew query failed: ${error.message}`);
      return;
    }
    for (const space of spaces ?? []) {
      try {
        // Acquire app-only token to renew the room subscription.
        const dynamic = await import('@azure/msal-node');
        const clientId = process.env.MICROSOFT_CLIENT_ID;
        const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
        const tenantId = process.env.MICROSOFT_TENANT_ID ?? 'common';
        if (!clientId || !clientSecret) {
          this.logger.warn('No MICROSOFT credentials, skipping room subscription renew');
          continue;
        }
        const msal = new dynamic.ConfidentialClientApplication({
          auth: { clientId, clientSecret, authority: `https://login.microsoftonline.com/${tenantId}` },
        });
        const tok = await msal.acquireTokenByClientCredential({
          scopes: ['https://graph.microsoft.com/.default'],
        });
        if (!tok?.accessToken) throw new Error('app-only token acquisition returned empty');
        const result = await this.outlook.renewWebhook(
          space.external_calendar_subscription_id as string,
          tok.accessToken,
        );
        await this.supabase.admin
          .from('spaces')
          .update({
            external_calendar_subscription_expires_at: result.expiresAt.toISOString(),
          })
          .eq('id', space.id);
        this.logger.log(`Renewed room webhook ${space.external_calendar_subscription_id} for ${space.name}`);
      } catch (err) {
        this.logger.warn(`Room webhook renew failed (${space.id}): ${(err as Error).message}`);
      }
    }
  }
}
