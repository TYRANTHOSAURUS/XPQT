/**
 * /portal/visitors/expected — host's "my upcoming visitors" page.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §2, §6
 *
 * Lists visitors where the actor is one of the hosts (primary or co-host)
 * and the visit is still pending or in-progress. Grouped by date bucket
 * (Today / Tomorrow / This week / Later).
 *
 * Each row exposes a small action menu (View details / Copy reference)
 * plus a click-to-open detail dialog. Cancel + Resend are intentionally
 * not wired yet — the backend doesn't have a host-side cancel/resend
 * endpoint (slice tracked in docs/follow-ups/visitors-v1-polish.md).
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarPlus,
  Copy,
  MoreHorizontal,
  PanelRightOpen,
  UserPlus,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  formatVisitorName,
  useMyExpectedVisitors,
  useVisitorDetail,
  type ExpectedVisitor,
} from '@/api/visitors';
import { VisitorStatusBadge } from '@/components/visitors/visitor-status-badge';
import {
  formatRelativeTime,
  formatTimeShort,
  formatFullTimestamp,
} from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
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
  const [openId, setOpenId] = useState<string | null>(null);

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
        description="View your upcoming visitor invitations."
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
                  <VisitorRow
                    key={v.visitor_id}
                    visitor={v}
                    onOpen={() => setOpenId(v.visitor_id)}
                  />
                ))}
              </ul>
            </SettingsSection>
          ))}
        </div>
      )}

      {openId && (
        <VisitorDetailDialog
          visitorId={openId}
          onOpenChange={(open) => !open && setOpenId(null)}
        />
      )}
    </SettingsPageShell>
  );
}

interface VisitorRowProps {
  visitor: ExpectedVisitor;
  onOpen: () => void;
}

function VisitorRow({ visitor, onOpen }: VisitorRowProps) {
  const time = visitor.expected_at ? formatTimeShort(visitor.expected_at) : null;
  const fullTs = visitor.expected_at ? formatFullTimestamp(visitor.expected_at) : null;
  const relative = visitor.expected_at ? formatRelativeTime(visitor.expected_at) : null;

  const handleCopyReference = async () => {
    try {
      await navigator.clipboard.writeText(visitor.visitor_id);
      toastSuccess('Reference copied');
    } catch {
      toastError("Couldn’t copy to clipboard", {
        description: 'Your browser blocked clipboard access.',
      });
    }
  };

  return (
    <li className="group flex items-center justify-between gap-4 border-b py-3 last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:text-primary"
      >
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
      </button>
      <div className="flex items-center gap-2">
        <VisitorStatusBadge status={visitor.status} className="text-[11px]" />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-7 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
                aria-label={`Actions for ${formatVisitorName(visitor)}`}
              />
            }
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}>
              <PanelRightOpen /> View details
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleCopyReference}>
              <Copy /> Copy reference
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              Cancel — coming soon
            </DropdownMenuItem>
            <DropdownMenuItem disabled>
              Resend email — coming soon
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

interface VisitorDetailDialogProps {
  visitorId: string;
  onOpenChange: (open: boolean) => void;
}

function VisitorDetailDialog({ visitorId, onOpenChange }: VisitorDetailDialogProps) {
  const { data: visitor, isLoading, isError } = useVisitorDetail(visitorId);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {visitor
              ? [visitor.first_name, visitor.last_name].filter(Boolean).join(' ').trim() ||
                'Visitor'
              : 'Visitor'}
          </DialogTitle>
          <DialogDescription>
            {visitor?.company ?? 'Read-only view of your invitation.'}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        )}

        {isError && !isLoading && (
          <p className="text-sm text-destructive">
            Couldn’t load this visitor. Try refreshing.
          </p>
        )}

        {!isLoading && !isError && visitor && (
          <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="col-span-2">
              <VisitorStatusBadge status={visitor.status} />
            </dd>

            {visitor.email && (
              <>
                <dt className="text-muted-foreground">Email</dt>
                <dd className="col-span-2 truncate">{visitor.email}</dd>
              </>
            )}

            {visitor.phone && (
              <>
                <dt className="text-muted-foreground">Phone</dt>
                <dd className="col-span-2">{visitor.phone}</dd>
              </>
            )}

            {visitor.expected_at && (
              <>
                <dt className="text-muted-foreground">Expected</dt>
                <dd className="col-span-2 tabular-nums">
                  {formatFullTimestamp(visitor.expected_at)}
                </dd>
              </>
            )}

            {visitor.expected_until && (
              <>
                <dt className="text-muted-foreground">Until</dt>
                <dd className="col-span-2 tabular-nums">
                  {formatFullTimestamp(visitor.expected_until)}
                </dd>
              </>
            )}

            {visitor.notes_for_visitor && (
              <>
                <dt className="text-muted-foreground self-start">Their notes</dt>
                <dd className="col-span-2 whitespace-pre-wrap">
                  {visitor.notes_for_visitor}
                </dd>
              </>
            )}
          </dl>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
