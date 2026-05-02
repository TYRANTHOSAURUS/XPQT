/**
 * /portal/visitors/expected — host's "my upcoming visitors" page.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §2, §6
 *
 * Lists visitors where the actor is one of the hosts (primary or co-host)
 * and the visit is still pending or in-progress. Grouped by date bucket
 * (Today / Tomorrow / This week / Later).
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { CalendarPlus, UserPlus } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import {
  formatVisitorName,
  useMyExpectedVisitors,
  type ExpectedVisitor,
} from '@/api/visitors';
import { VisitorStatusBadge } from '@/components/visitors/visitor-status-badge';
import { formatRelativeTime, formatTimeShort, formatFullTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

interface DateBucket {
  key: 'today' | 'tomorrow' | 'this_week' | 'later' | 'undated';
  title: string;
  visitors: ExpectedVisitor[];
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function classifyBucket(now: Date, ts: string | null): DateBucket['key'] {
  if (!ts) return 'undated';
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return 'undated';
  const today = startOfDay(now);
  const tomorrow = startOfDay(new Date(today.getTime() + 24 * 60 * 60 * 1000));
  const weekEnd = startOfDay(new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000));
  const tDay = startOfDay(t);
  if (tDay.getTime() === today.getTime()) return 'today';
  if (tDay.getTime() === tomorrow.getTime()) return 'tomorrow';
  if (tDay.getTime() < weekEnd.getTime()) return 'this_week';
  return 'later';
}

function bucketTitle(key: DateBucket['key']): string {
  switch (key) {
    case 'today':
      return 'Today';
    case 'tomorrow':
      return 'Tomorrow';
    case 'this_week':
      return 'This week';
    case 'later':
      return 'Later';
    case 'undated':
      return 'Without a date';
  }
}


export function PortalVisitorsExpectedPage() {
  const { data, isLoading, isError } = useMyExpectedVisitors();

  const buckets = useMemo<DateBucket[]>(() => {
    if (!data) return [];
    const now = new Date();
    const groups: Record<DateBucket['key'], ExpectedVisitor[]> = {
      today: [],
      tomorrow: [],
      this_week: [],
      later: [],
      undated: [],
    };
    for (const v of data) {
      groups[classifyBucket(now, v.expected_at)].push(v);
    }
    const order: DateBucket['key'][] = ['today', 'tomorrow', 'this_week', 'later', 'undated'];
    return order
      .map((k) => ({ key: k, title: bucketTitle(k), visitors: groups[k] }))
      .filter((b) => b.visitors.length > 0);
  }, [data]);

  const total = data?.length ?? 0;

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        title="My visitors"
        description="View and manage your upcoming visitor invitations."
        actions={
          <Link
            to="/portal/visitors/invite"
            className={cn(buttonVariants({ size: 'sm' }), 'gap-1.5')}
          >
            <UserPlus className="size-4" aria-hidden />
            New invitation
          </Link>
        }
      />

      {isLoading && (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {isError && !isLoading && (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t load your visitors. Try refreshing.
        </p>
      )}

      {!isLoading && !isError && total === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <CalendarPlus className="size-10 text-muted-foreground" aria-hidden />
          <div>
            <h2 className="text-base font-medium">No upcoming visitors</h2>
            <p className="text-sm text-muted-foreground">
              Invite someone and they’ll show up here.
            </p>
          </div>
          <Link
            to="/portal/visitors/invite"
            className={cn(buttonVariants({ size: 'sm' }))}
          >
            Invite a visitor
          </Link>
        </div>
      )}

      {!isLoading && !isError && total > 0 && (
        <div className="flex flex-col gap-6">
          {buckets.map((b) => (
            <SettingsSection key={b.key} title={b.title} bordered density="tight">
              <ul className="flex flex-col">
                {b.visitors.map((v) => (
                  <VisitorRow key={v.visitor_id} visitor={v} />
                ))}
              </ul>
            </SettingsSection>
          ))}
        </div>
      )}
    </SettingsPageShell>
  );
}

interface VisitorRowProps {
  visitor: ExpectedVisitor;
}

function VisitorRow({ visitor }: VisitorRowProps) {
  const time = visitor.expected_at ? formatTimeShort(visitor.expected_at) : null;
  const fullTs = visitor.expected_at ? formatFullTimestamp(visitor.expected_at) : null;
  const relative = visitor.expected_at ? formatRelativeTime(visitor.expected_at) : null;
  return (
    <li className="flex items-center justify-between gap-4 border-b py-3 last:border-b-0">
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-sm font-medium truncate">
          {formatVisitorName(visitor)}
        </span>
        {time && (
          <time
            dateTime={visitor.expected_at ?? undefined}
            title={fullTs ?? undefined}
            className="text-xs text-muted-foreground tabular-nums"
          >
            {time}
            {relative ? ` · ${relative}` : ''}
          </time>
        )}
      </div>
      <VisitorStatusBadge status={visitor.status} className="text-[11px]" />
    </li>
  );
}
