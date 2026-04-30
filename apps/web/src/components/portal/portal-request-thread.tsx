import { useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

export interface ThreadEvent {
  id: string;
  kind: 'message' | 'system';
  authorName?: string | null;
  authorRole?: 'requester' | 'assignee' | 'system';
  authorAvatarUrl?: string | null;
  body: string;
  createdAt: string;
}

interface ThreadProps {
  events: ThreadEvent[];
}

/**
 * Read-only timeline of thread events. Pure — no internal state, no
 * mutations. Pair with `PortalRequestReplyComposer` on surfaces that
 * need a reply box.
 */
export function PortalRequestThread({ events }: ThreadProps) {
  return (
    <ol className="space-y-2" aria-live="polite">
      {events.map((evt) => (
        <li
          key={evt.id}
          className={
            evt.kind === 'system'
              ? 'pl-11 py-1.5 text-xs text-muted-foreground'
              : 'flex items-start gap-3'
          }
        >
          {evt.kind === 'message' ? (
            <>
              <Avatar className="size-8 mt-0.5">
                <AvatarImage src={evt.authorAvatarUrl ?? undefined} alt="" />
                <AvatarFallback className="bg-gradient-to-br from-blue-500 to-violet-600 text-white text-[10px] font-semibold">
                  {(evt.authorName ?? '?').slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="text-xs">
                  <span className="font-semibold">{evt.authorName ?? 'Unknown'}</span>
                  {evt.authorRole && (
                    <span className="ml-2 text-muted-foreground capitalize">{evt.authorRole}</span>
                  )}
                  <time
                    className="ml-2 text-muted-foreground"
                    dateTime={evt.createdAt}
                    title={formatFullTimestamp(evt.createdAt)}
                  >
                    {formatRelativeTime(evt.createdAt)}
                  </time>
                </div>
                <div className="mt-1.5 rounded-lg border bg-card px-3 py-2 text-sm whitespace-pre-wrap">
                  {evt.body}
                </div>
              </div>
            </>
          ) : (
            <span>
              <span aria-hidden>· </span>
              {evt.body}
              <time className="ml-2 opacity-70" dateTime={evt.createdAt}>
                {formatRelativeTime(evt.createdAt)}
              </time>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

interface ComposerProps {
  /**
   * Send the reply. The composer awaits and clears its input only on
   * success — re-throw inside the handler (or let the mutation throw)
   * to preserve the user's text on failure.
   */
  onSubmit: (body: string) => Promise<void>;
}

/**
 * Reply composer used below the thread on `/portal/requests/:id`.
 * Implements ⌘/Ctrl+Enter submit. Preserves the user's draft on send
 * failure — the previous coupling with the parent's try/catch silently
 * cleared the textarea even when the network call failed.
 */
/**
 * "⌘ Enter" on Mac-class platforms, "Ctrl Enter" elsewhere. Detected from
 * the UA at module scope so the hint stays a constant string and matches
 * the actual keyboard combo the handler accepts.
 */
const SEND_HINT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)
    ? '⌘ Enter to send'
    : 'Ctrl Enter to send';

export function PortalRequestReplyComposer({ onSubmit }: ComposerProps) {
  const [reply, setReply] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const body = reply.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(body);
      setReply('');
    } catch {
      // Keep the draft so the user can retry. The parent / mutation owns
      // the user-visible error toast.
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="mt-4 rounded-lg border bg-card focus-within:ring-3 focus-within:ring-ring/30 transition-shadow">
      <Textarea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Write a reply…"
        aria-label="Reply"
        className="min-h-[72px] border-0 focus-visible:ring-0 resize-none"
        disabled={submitting}
      />
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t">
        <span className="hidden sm:inline text-[11px] text-muted-foreground">
          {SEND_HINT}
        </span>
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={!reply.trim() || submitting}
          className="ml-auto"
        >
          {submitting ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  );
}
