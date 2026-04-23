import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { useWebhookEvents, useWebhooks } from '@/api/webhooks';

export function WebhookEventsPage() {
  const { id } = useParams<{ id: string }>();
  const { data: webhooks } = useWebhooks();
  const webhook = useMemo(() => webhooks?.find((w) => w.id === id), [webhooks, id]);
  const { data: events, isLoading, refetch } = useWebhookEvents(id ?? '');
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const openEvent = events?.find((e) => e.id === openEventId) ?? null;

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo={id ? `/admin/webhooks/${id}` : '/admin/webhooks'}
        title={webhook ? `${webhook.name} · Events` : 'Events'}
        description="Last 30 days of inbound events. Payload and headers preserved for triage."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Refresh
          </Button>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!isLoading && (events?.length ?? 0) === 0 && (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No events recorded yet.
        </div>
      )}

      {!isLoading && events && events.length > 0 && (
        <div className="flex flex-col divide-y">
          {events.map((ev) => (
            <button
              key={ev.id}
              onClick={() => setOpenEventId(ev.id)}
              className="flex items-center justify-between gap-3 py-3 text-left hover:bg-muted/40 px-2 -mx-2 rounded-md transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Badge
                  variant={
                    ev.status === 'accepted'
                      ? 'default'
                      : ev.status === 'deduplicated'
                      ? 'secondary'
                      : 'destructive'
                  }
                >
                  {ev.status}
                </Badge>
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-mono truncate">
                    {ev.external_system ?? '—'} / {ev.external_id ?? '—'}
                  </span>
                  {ev.error_message && (
                    <span className="text-xs text-red-600 truncate">{ev.error_message}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-muted-foreground">HTTP {ev.http_status}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(ev.received_at).toLocaleString()}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <Dialog open={!!openEvent} onOpenChange={(next) => !next && setOpenEventId(null)}>
        <DialogContent className="sm:max-w-[720px]">
          <DialogHeader>
            <DialogTitle>
              {openEvent ? `Event · ${openEvent.status}` : 'Event'}
            </DialogTitle>
            <DialogDescription>
              {openEvent
                ? `Received ${new Date(openEvent.received_at).toLocaleString()} — HTTP ${openEvent.http_status}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {openEvent && (
            <div className="flex flex-col gap-3">
              {openEvent.error_message && (
                <div className="text-sm text-red-600">{openEvent.error_message}</div>
              )}
              <div className="rounded-md bg-muted p-3">
                <div className="text-xs font-medium text-muted-foreground mb-1">Headers</div>
                <pre className="font-mono text-[10px] overflow-x-auto">
                  {JSON.stringify(openEvent.headers ?? {}, null, 2)}
                </pre>
              </div>
              <div className="rounded-md bg-muted p-3">
                <div className="text-xs font-medium text-muted-foreground mb-1">Payload</div>
                <pre className="font-mono text-[10px] overflow-x-auto max-h-[400px]">
                  {JSON.stringify(openEvent.payload, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </SettingsPageShell>
  );
}
