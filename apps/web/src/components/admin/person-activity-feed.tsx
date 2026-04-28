import { Link } from 'react-router-dom';
import { Ticket, Calendar, Activity as ActivityIcon } from 'lucide-react';
import { usePersonActivity, type PersonActivityItem } from '@/api/persons';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

export function PersonActivityFeed({ personId, limit = 20 }: { personId: string; limit?: number }) {
  const { data, isLoading, error } = usePersonActivity(personId, limit);

  if (isLoading) return <Skeleton className="h-48" />;
  if (error) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't load activity.{' '}
        <button className="underline" onClick={() => window.location.reload()}>
          Retry
        </button>
      </p>
    );
  }
  if (!data || data.length === 0) {
    return <p className="text-sm text-muted-foreground">No recent activity for this person.</p>;
  }

  return (
    <ul className="flex flex-col divide-y rounded-md border">
      {data.map((item) => (
        <li key={`${item.kind}-${item.id}`} className="px-3 py-2.5">
          <ActivityRow item={item} />
        </li>
      ))}
    </ul>
  );
}

function ActivityRow({ item }: { item: PersonActivityItem }) {
  if (item.kind === 'ticket') {
    return (
      <Link to={`/desk/tickets/${item.id}`} className="flex items-center gap-3 group">
        <Ticket className="size-4 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate group-hover:underline">{item.title}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] capitalize">
              {item.status}
            </Badge>
            <time
              className="tabular-nums"
              dateTime={item.created_at}
              title={formatFullTimestamp(item.created_at)}
            >
              {formatRelativeTime(item.created_at)}
            </time>
          </div>
        </div>
      </Link>
    );
  }

  if (item.kind === 'booking') {
    return (
      <Link to={`/desk/bookings?b=${item.id}`} className="flex items-center gap-3 group">
        <Calendar className="size-4 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate group-hover:underline">{item.space_name}</div>
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] capitalize">
              {item.status}
            </Badge>
            <time
              className="tabular-nums"
              dateTime={item.starts_at}
              title={formatFullTimestamp(item.starts_at)}
            >
              {formatRelativeTime(item.starts_at)}
            </time>
          </div>
        </div>
      </Link>
    );
  }

  // audit — no link, no source page
  return (
    <div className="flex items-center gap-3">
      <ActivityIcon className="size-4 text-muted-foreground shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          {humanizeAuditEvent(item.event_type)}
          {item.actor_name && (
            <span className="text-muted-foreground"> by {item.actor_name}</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          <time
            className="tabular-nums"
            dateTime={item.created_at}
            title={formatFullTimestamp(item.created_at)}
          >
            {formatRelativeTime(item.created_at)}
          </time>
        </div>
      </div>
    </div>
  );
}

function humanizeAuditEvent(eventType: string): string {
  return eventType.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
