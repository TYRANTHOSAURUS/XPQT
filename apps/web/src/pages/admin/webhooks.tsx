import { Link } from 'react-router-dom';
import { Plus, Webhook as WebhookIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { useWebhooks, type Webhook } from '@/api/webhooks';

export function WebhooksPage() {
  const { data, isLoading } = useWebhooks();

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        title="Webhooks"
        description="Public endpoints that create tickets and start workflows when an external system POSTs a payload."
        actions={
          <Link
            to="/admin/webhooks/new"
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
          >
            <Plus className="size-4" />
            New webhook
          </Link>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!isLoading && data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead className="w-[180px]">Last used</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((wh: Webhook) => (
              <TableRow key={wh.id}>
                <TableCell className="font-medium">
                  <Link
                    to={`/admin/webhooks/${wh.id}`}
                    className="hover:underline underline-offset-2"
                  >
                    {wh.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant={wh.active ? 'default' : 'secondary'}>
                    {wh.active ? 'active' : 'disabled'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {wh.last_used_at ? (
                    <time
                      dateTime={wh.last_used_at}
                      title={formatFullTimestamp(wh.last_used_at)}
                    >
                      {formatRelativeTime(wh.last_used_at)}
                    </time>
                  ) : (
                    '—'
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <WebhookIcon className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No webhooks yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create a webhook to let an external system post payloads into Prequest. Each
            webhook maps payloads to a request type and fires routing + workflow on every event.
          </p>
          <Link
            to="/admin/webhooks/new"
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
          >
            <Plus className="size-4" />
            New webhook
          </Link>
        </div>
      )}
    </SettingsPageShell>
  );
}
