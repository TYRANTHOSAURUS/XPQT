import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { Paperclip } from 'lucide-react';

export interface ThreadEvent {
  id: string;
  kind: 'message' | 'system';
  authorName?: string | null;
  authorRole?: 'requester' | 'assignee' | 'system';
  authorAvatarUrl?: string | null;
  body: string;
  createdAt: string;
}

interface Props {
  events: ThreadEvent[];
  onReply?: (body: string) => Promise<void>;
}

export function PortalRequestThread({ events, onReply }: Props) {
  const [reply, setReply] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!reply.trim() || !onReply) return;
    setSubmitting(true);
    try {
      await onReply(reply.trim());
      setReply('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-1">
      <ol className="space-y-2">
        {events.map((evt) => (
          <li key={evt.id} className={evt.kind === 'system' ? 'pl-11 py-1.5 text-xs text-muted-foreground' : 'flex items-start gap-3'}>
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
                    {evt.authorRole && <span className="ml-2 text-muted-foreground capitalize">{evt.authorRole}</span>}
                    <time className="ml-2 text-muted-foreground" dateTime={evt.createdAt} title={formatFullTimestamp(evt.createdAt)}>
                      {formatRelativeTime(evt.createdAt)}
                    </time>
                  </div>
                  <div className="mt-1.5 rounded-lg border bg-card px-3 py-2 text-sm whitespace-pre-wrap">
                    {evt.body}
                  </div>
                </div>
              </>
            ) : (
              <span>· {evt.body}<time className="ml-2 opacity-70" dateTime={evt.createdAt}>{formatRelativeTime(evt.createdAt)}</time></span>
            )}
          </li>
        ))}
      </ol>
      {onReply && (
        <div className="mt-4 rounded-lg border bg-card">
          <Textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Write a reply…"
            className="min-h-[72px] border-0 focus-visible:ring-0"
            disabled={submitting}
          />
          <div className="flex items-center justify-end gap-2 px-2 py-2 border-t">
            <Button variant="ghost" size="sm" disabled>
              <Paperclip className="size-3.5 mr-1" />
              Attach
            </Button>
            <Button size="sm" onClick={submit} disabled={!reply.trim() || submitting}>
              {submitting ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
