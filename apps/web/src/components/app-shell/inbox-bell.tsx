/**
 * Inbox bell — header affordance for the per-user notification feed.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step F.
 *
 * Behavior:
 *   - Renders a `Bell` icon button in the app-shell header.
 *   - Shows a small unread-count badge over the icon when `unread > 0`.
 *     Counts ≥ 1000 collapse to compact form (`1.5K`) via `formatCount`.
 *   - Click opens a `Popover` with the latest five rows.
 *   - Each row: `summary` + `formatRelativeTime(createdAt)` (full timestamp
 *     in the `title` for hover tooltip).
 *   - Footer: link to `/me/inbox` + "Mark all as read" button.
 *   - Tooltip on the trigger explains the ~30s outbox SLA so the user knows
 *     it might take a moment after an action.
 *
 * Mounted once per shell (desk-layout, admin-layout, portal-top-bar). The
 * Realtime subscription is mounted alongside it via `useInboxSubscription`
 * — see the layouts.
 */

import { Bell } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatCount, formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import { pickInboxCtaUrl } from '@/lib/inbox-cta-url';
import {
  useInbox,
  useInboxCount,
  useMarkAllInboxRead,
  useMarkInboxRead,
  type InboxItemDto,
} from '@/api/inbox';
import { useAuth } from '@/providers/auth-provider';

const POPOVER_PREVIEW_LIMIT = 5;

/**
 * Optional className lets layouts that wrap the bell in a container apply
 * sizing / spacing without forking the component.
 */
export function InboxBell({ className }: { className?: string }) {
  const { appUser } = useAuth();
  // Pre-auth or in a context without an actor — render nothing rather than
  // a broken trigger that would 401 on click.
  if (!appUser) return null;

  return <InboxBellInner className={className} />;
}

function InboxBellInner({ className }: { className?: string }) {
  const countQuery = useInboxCount();
  const listQuery = useInbox({ limit: POPOVER_PREVIEW_LIMIT });
  const markRead = useMarkInboxRead();
  const markAllRead = useMarkAllInboxRead();

  const unread = countQuery.data?.unread ?? 0;
  const items = listQuery.data?.items ?? [];

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={
              unread > 0
                ? `Inbox — ${unread} unread notification${unread === 1 ? '' : 's'}`
                : 'Inbox'
            }
            title="New notifications appear here within 30s"
            className={cn('relative size-9', className)}
          >
            <Bell className="size-4" />
            {unread > 0 && (
              <span
                aria-hidden
                className={cn(
                  'absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center',
                  'rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground',
                  'tabular-nums ring-2 ring-background',
                )}
              >
                {formatCount(unread)}
              </span>
            )}
          </Button>
        }
      />
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[360px] p-0"
      >
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/60">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Inbox</span>
            {unread > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatCount(unread)} unread
              </span>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => markAllRead.mutate()}
            disabled={unread === 0 || markAllRead.isPending}
          >
            Mark all as read
          </Button>
        </div>

        <div className="max-h-[360px] overflow-y-auto">
          {listQuery.isLoading ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">
              No notifications yet
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {items.map((item) => (
                <InboxBellRow
                  key={item.id}
                  item={item}
                  onMarkRead={(id) => markRead.mutate(id)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end px-3 py-2 border-t border-border/60">
          <Link
            to="/me/inbox"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            View all
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function InboxBellRow({
  item,
  onMarkRead,
}: {
  item: InboxItemDto;
  onMarkRead: (id: string) => void;
}) {
  const isUnread = item.readAt === null;
  const location = useLocation();
  const ctaUrl = pickInboxCtaUrl(item.payload, { pathname: location.pathname });
  return (
    <li
      className={cn(
        'flex items-start gap-2 px-3 py-2.5',
        isUnread && 'bg-primary/5',
      )}
    >
      <div className="flex-1 min-w-0">
        {ctaUrl ? (
          <Link
            to={ctaUrl}
            className="block text-sm leading-snug hover:underline"
            onClick={() => isUnread && onMarkRead(item.id)}
          >
            {item.summary}
          </Link>
        ) : (
          <button
            type="button"
            className="block text-left text-sm leading-snug hover:underline"
            onClick={() => isUnread && onMarkRead(item.id)}
          >
            {item.summary}
          </button>
        )}
        <time
          dateTime={item.createdAt}
          title={formatFullTimestamp(item.createdAt)}
          className="mt-0.5 block text-[11px] text-muted-foreground tabular-nums"
        >
          {formatRelativeTime(item.createdAt)}
        </time>
      </div>
      {isUnread && (
        <span
          aria-label="Unread"
          className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
        />
      )}
    </li>
  );
}

