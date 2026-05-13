/**
 * Full inbox page — the per-user notification feed in long form.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step F.
 *
 * Settings shell at width=`default` (640px) per CLAUDE.md — this is a
 * Linear-style focused list, not a dashboard. Header carries the title +
 * description + a "Mark all as read" action; body is a list of inbox rows
 * with cursor-driven infinite scroll via `useInboxInfinite`.
 *
 * Page-class errors (`not_found` / `permission` / `server` / `unknown`) are
 * thrown to the route's `RouteErrorBoundary` by `useInboxInfinite` so the
 * page replaces with the fallback rather than toasting on a broken list.
 */

import { Bell } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { cn } from '@/lib/utils';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import {
  useInboxCount,
  useInboxInfinite,
  useMarkAllInboxRead,
  useMarkInboxRead,
  type InboxItemDto,
} from '@/api/inbox';

export function InboxFullPage() {
  const infinite = useInboxInfinite();
  const countQuery = useInboxCount();
  const markRead = useMarkInboxRead();
  const markAllRead = useMarkAllInboxRead();

  const items: InboxItemDto[] = infinite.data?.pages.flatMap((p) => p.items) ?? [];
  const unread = countQuery.data?.unread ?? 0;
  const hasMore = infinite.hasNextPage;

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        title="Inbox"
        description="Your notifications. Approval requests and operational updates land here within 30 seconds."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => markAllRead.mutate()}
            disabled={unread === 0 || markAllRead.isPending}
          >
            Mark all as read
          </Button>
        }
      />

      {infinite.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="rounded-lg border bg-card divide-y divide-border/60 overflow-hidden">
          {items.map((item) => (
            <InboxPageRow
              key={item.id}
              item={item}
              onMarkRead={(id) => markRead.mutate(id)}
            />
          ))}
        </ul>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => infinite.fetchNextPage()}
            disabled={infinite.isFetchingNextPage}
          >
            {infinite.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </SettingsPageShell>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Bell className="size-5 text-muted-foreground" />
      </div>
      <div>
        <h2 className="text-base font-medium">No notifications yet</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-sm">
          When something needs your attention — an approval request, a status
          update — it will appear here.
        </p>
      </div>
    </div>
  );
}

function InboxPageRow({
  item,
  onMarkRead,
}: {
  item: InboxItemDto;
  onMarkRead: (id: string) => void;
}) {
  const isUnread = item.readAt === null;
  const ctaUrl = readApprovalCtaUrl(item.payload);

  const content = (
    <div className="flex items-start gap-3 px-4 py-3.5">
      {isUnread ? (
        <span
          aria-label="Unread"
          className="mt-2 size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : (
        <span aria-hidden className="mt-2 size-1.5 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            'text-sm leading-snug',
            isUnread ? 'font-medium text-foreground' : 'text-foreground/80',
          )}
        >
          {item.summary}
        </p>
        <time
          dateTime={item.createdAt}
          title={formatFullTimestamp(item.createdAt)}
          className="mt-0.5 block text-xs text-muted-foreground tabular-nums"
        >
          {formatRelativeTime(item.createdAt)}
        </time>
      </div>
    </div>
  );

  return (
    <li className={cn(isUnread && 'bg-primary/5')}>
      {ctaUrl ? (
        <Link
          to={ctaUrl}
          onClick={() => isUnread && onMarkRead(item.id)}
          className="block transition-colors hover:bg-muted/40"
        >
          {content}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => isUnread && onMarkRead(item.id)}
          className="w-full text-left transition-colors hover:bg-muted/40"
        >
          {content}
        </button>
      )}
    </li>
  );
}

function readApprovalCtaUrl(payload: Record<string, unknown>): string | null {
  const url = payload.approvalCtaUrl;
  if (typeof url !== 'string' || url.length === 0) return null;
  if (url.startsWith('/')) return url;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch {
    /* invalid URL — fall through */
  }
  return null;
}
