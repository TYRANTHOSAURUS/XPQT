import { memo, useEffect, useRef, useState } from 'react';
import { Clock, Download, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/format';

interface ActivityAttachment {
  name: string;
  url?: string;
  path?: string;
  size: number;
  type: string;
}

interface Activity {
  id: string;
  activity_type: string;
  visibility: string;
  content: string;
  attachments?: ActivityAttachment[];
  author?: { first_name: string; last_name: string };
  metadata: Record<string, unknown> | null;
  created_at: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function isImageAttachment(attachment: ActivityAttachment): boolean {
  if (attachment.type?.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(attachment.name);
}

/**
 * Memoized activity feed. Pulled out of `TicketDetail` so typing in the
 * comment composer (which updates `commentText` state on every keystroke)
 * doesn't re-render the entire 50+ activity list. With `memo`, the feed only
 * re-renders when the activities array reference changes — and React Query
 * keeps that reference stable across unrelated cache invalidations.
 */
export const TicketActivityFeed = memo(function TicketActivityFeed({
  activities,
}: {
  activities: Activity[];
}) {
  // Track which activity ids we've already rendered. Anything new in a
  // subsequent render gets the desk-flash highlight (1.1s background wash
  // that fades to transparent). The first render (mount) doesn't flash —
  // it relies on the desk-stagger entry instead.
  //
  // `flashingIds` is component state (not a ref) so React keeps the class
  // applied across the full animation window — a ref alone would clear
  // the class on the next render and cut the keyframe short.
  const seenIdsRef = useRef<Set<string> | null>(null);
  const [flashingIds, setFlashingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (seenIdsRef.current === null) {
      seenIdsRef.current = new Set(activities.map((a) => a.id));
      return;
    }
    const fresh: string[] = [];
    for (const a of activities) {
      if (!seenIdsRef.current.has(a.id)) {
        fresh.push(a.id);
        seenIdsRef.current.add(a.id);
      }
    }
    if (fresh.length === 0) return;
    setFlashingIds((prev) => {
      const next = new Set(prev);
      for (const id of fresh) next.add(id);
      return next;
    });
    // Animation is 1.1s; give 100ms buffer so the keyframe definitely
    // completes before the class disappears.
    const handle = window.setTimeout(() => {
      setFlashingIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        for (const id of fresh) next.delete(id);
        return next;
      });
    }, 1200);
    return () => window.clearTimeout(handle);
  }, [activities]);

  return (
    <div className="desk-stagger space-y-6">
      {activities.map((activity) => {
        const isNew = flashingIds.has(activity.id);
        if (activity.visibility === 'system') {
          const eventText =
            ((activity.metadata as Record<string, unknown> | null)?.event as string | undefined)
            ?? activity.content;
          const who = activity.author
            ? `${activity.author.first_name ?? ''} ${activity.author.last_name ?? ''}`.trim() || 'System'
            : 'System';
          return (
            <div
              key={activity.id}
              className={cn(
                'flex items-center gap-2 rounded text-xs text-muted-foreground',
                isNew && 'desk-flash -mx-1 px-1',
              )}
            >
              <Clock className="h-3 w-3 shrink-0" />
              <span className="text-foreground/80 font-medium shrink-0">{who}</span>
              <span className="truncate">{eventText}</span>
              <span className="shrink-0">· {formatRelativeTime(activity.created_at)}</span>
            </div>
          );
        }
        return (
          <div
            key={activity.id}
            className={cn('flex gap-4 rounded', isNew && 'desk-flash -mx-2 px-2 py-1')}
          >
            <div className="shrink-0 mt-0.5">
              <div
                className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold ${
                  activity.visibility === 'internal'
                    ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                    : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                }`}
              >
                {activity.author?.first_name?.[0] ?? '?'}
              </div>
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              <div className="flex items-center gap-2">
                {activity.author ? (
                  <span className="text-sm font-medium">
                    {activity.author.first_name} {activity.author.last_name}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">System</span>
                )}
                {activity.visibility === 'internal' && (
                  <span className="text-[11px] text-yellow-600 dark:text-yellow-400">internal</span>
                )}
                <span className="text-xs text-muted-foreground">{formatRelativeTime(activity.created_at)}</span>
              </div>
              {(activity.content || (activity.attachments?.length ?? 0) > 0) ? (
                <div className="mt-2 overflow-hidden rounded-lg border border-border/70 bg-card/80">
                  {activity.content && (
                    <div className="px-4 py-3">
                      <p className="text-[15px] leading-relaxed text-foreground/85 whitespace-pre-wrap">
                        {activity.content}
                      </p>
                    </div>
                  )}
                  {activity.attachments && activity.attachments.length > 0 && (
                    <div className={cn('grid gap-2 p-2', activity.content && 'border-t border-border/60')}>
                      {activity.attachments.map((attachment) => {
                        const key = `${activity.id}-${attachment.path ?? attachment.url ?? attachment.name}`;
                        const imageAttachment = isImageAttachment(attachment) && attachment.url;

                        if (imageAttachment) {
                          return (
                            <a
                              key={key}
                              href={attachment.url}
                              target="_blank"
                              rel="noreferrer"
                              className="group overflow-hidden rounded-lg border border-border/70 bg-muted/20 transition-colors hover:bg-muted/40"
                            >
                              <img
                                src={attachment.url}
                                alt={attachment.name}
                                loading="lazy"
                                decoding="async"
                                className="max-h-80 w-full bg-muted/40 object-cover"
                              />
                              <div className="flex items-center justify-between gap-3 px-3 py-2">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-medium">{attachment.name}</div>
                                  <div className="text-xs text-muted-foreground">{formatFileSize(attachment.size)}</div>
                                </div>
                                <Download className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                              </div>
                            </a>
                          );
                        }

                        const attachmentContent = (
                          <>
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                              <FileText className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{attachment.name}</div>
                              <div className="text-xs text-muted-foreground">{formatFileSize(attachment.size)}</div>
                            </div>
                            {attachment.url && <Download className="h-4 w-4 shrink-0 text-muted-foreground" />}
                          </>
                        );

                        return attachment.url ? (
                          <a
                            key={key}
                            href={attachment.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 transition-colors hover:bg-muted/40"
                          >
                            {attachmentContent}
                          </a>
                        ) : (
                          <div
                            key={key}
                            className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
                          >
                            {attachmentContent}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
});
