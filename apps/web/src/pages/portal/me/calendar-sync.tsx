import { Calendar, CheckCircle2, AlertCircle, RefreshCw, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import {
  useCalendarSyncMe,
  useStartConnect,
  useDisconnectCalendar,
  useForceResync,
} from '@/api/calendar-sync';

/**
 * /portal/me/calendar-sync
 *
 * Per spec §3.1 + §4.1: a single connection-management page. Status,
 * connect button, disconnect with confirm, force-resync, error state.
 *
 * Uses SettingsPageShell width="default" (640) — this is a one-decision
 * page (connect or disconnect) with a couple of operational rows.
 */
export function PortalCalendarSyncPage() {
  const { data: link, isLoading } = useCalendarSyncMe();
  const startConnect = useStartConnect();
  const disconnect = useDisconnectCalendar();
  const resync = useForceResync();

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const isConnected = link && link.sync_status !== 'disabled';
  const hasError = link?.sync_status === 'error';

  const onConnect = async () => {
    try {
      const { authUrl } = await startConnect.mutateAsync();
      // Send the user to Microsoft for consent. They come back to
      // /portal/calendar-sync/callback which finishes the exchange.
      window.location.href = authUrl;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start connection');
    }
  };

  const onDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      toast.success('Outlook disconnected');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Disconnect failed');
    } finally {
      setConfirmDisconnect(false);
    }
  };

  const onResync = async () => {
    try {
      const r = await resync.mutateAsync();
      toast.success(`Resync triggered — ${r.events_seen} events`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Resync failed');
    }
  };

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/portal/profile"
        title="Calendar sync"
        description="Keep your Prequest bookings in sync with your Outlook calendar."
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      ) : !isConnected ? (
        <NotConnectedState onConnect={onConnect} loading={startConnect.isPending} />
      ) : (
        <>
          {hasError && link?.last_error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
              <div className="flex items-start gap-2">
                <AlertCircle className="size-4 mt-0.5 text-destructive shrink-0" />
                <div className="flex flex-col gap-1">
                  <div className="font-medium text-destructive">Sync error</div>
                  <p className="text-muted-foreground">{link.last_error}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 w-fit gap-1.5"
                    onClick={onConnect}
                  >
                    Reconnect
                  </Button>
                </div>
              </div>
            </div>
          )}

          <SettingsGroup>
            <SettingsRow
              label="Status"
              description={
                hasError
                  ? 'Sync is currently failing — reconnect to fix.'
                  : 'Your Prequest bookings are mirrored to Outlook.'
              }
            >
              {hasError ? (
                <Badge variant="destructive">Error</Badge>
              ) : (
                <Badge variant="default" className="gap-1">
                  <CheckCircle2 className="size-3" /> Connected
                </Badge>
              )}
            </SettingsRow>
            <SettingsRow
              label="Connected calendar"
              description={link?.external_calendar_id ?? '—'}
            >
              <SettingsRowValue>Outlook</SettingsRowValue>
            </SettingsRow>
            <SettingsRow
              label="Last synced"
              description={
                link?.last_synced_at
                  ? formatRelativeTime(link.last_synced_at)
                  : 'Never'
              }
            >
              <SettingsRowValue>
                {link?.last_synced_at ? (
                  <time
                    dateTime={link.last_synced_at}
                    title={formatFullTimestamp(link.last_synced_at)}
                  >
                    {formatRelativeTime(link.last_synced_at)}
                  </time>
                ) : (
                  '—'
                )}
              </SettingsRowValue>
            </SettingsRow>
            <SettingsRow
              label="Live notifications"
              description={
                link?.webhook_expires_at
                  ? `Subscription renews automatically; expires ${formatRelativeTime(link.webhook_expires_at)}`
                  : 'Setting up…'
              }
            >
              {link?.webhook_subscription_id ? (
                <Badge variant="secondary">Active</Badge>
              ) : (
                <Badge variant="outline">Pending</Badge>
              )}
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title="Actions">
            <SettingsRow
              label="Force a resync"
              description="Pulls the latest events from Outlook now. Useful if something looks out of sync."
            >
              <Button
                variant="outline"
                size="sm"
                onClick={onResync}
                disabled={resync.isPending}
                className="gap-1.5"
              >
                <RefreshCw className={`size-3.5 ${resync.isPending ? 'animate-spin' : ''}`} />
                {resync.isPending ? 'Syncing…' : 'Resync now'}
              </Button>
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title="Danger zone">
            <SettingsRow
              label="Disconnect Outlook"
              description="Stops mirroring bookings to your calendar. Existing events stay on the calendar."
            >
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-destructive hover:text-destructive"
                onClick={() => setConfirmDisconnect(true)}
                disabled={disconnect.isPending}
              >
                <Unplug className="size-3.5" />
                Disconnect
              </Button>
            </SettingsRow>
          </SettingsGroup>
        </>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Outlook?"
        description="Your bookings will no longer mirror to your Outlook calendar. You can reconnect any time."
        confirmLabel="Disconnect"
        destructive
        onConfirm={onDisconnect}
      />
    </SettingsPageShell>
  );
}

function NotConnectedState({ onConnect, loading }: { onConnect: () => void; loading: boolean }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border bg-card px-6 py-12 text-center">
      <div className="rounded-full bg-muted p-3">
        <Calendar className="size-6 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="text-base font-medium">Connect your Outlook calendar</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          We'll mirror your Prequest room bookings to Outlook so they show up alongside
          your other meetings — and pick up changes you make in Outlook.
        </p>
      </div>
      <Button onClick={onConnect} disabled={loading} className="gap-1.5">
        {loading ? <Spinner className="size-3.5" /> : <Calendar className="size-4" />}
        {loading ? 'Redirecting…' : 'Connect Outlook'}
      </Button>
    </div>
  );
}
