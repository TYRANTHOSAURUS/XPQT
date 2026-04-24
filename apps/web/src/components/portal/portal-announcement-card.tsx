import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { usePortal } from '@/providers/portal-provider';
import { formatRelativeTime } from '@/lib/format';

const DISMISS_KEY_PREFIX = 'portal.announcement.dismissed:';

export function PortalAnnouncementCard() {
  const { data: portal } = usePortal();
  const ann = portal?.announcement ?? null;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!ann) return;
    setDismissed(localStorage.getItem(DISMISS_KEY_PREFIX + ann.id) === '1');
  }, [ann?.id]);

  if (!ann || dismissed) return null;

  const onDismiss = () => {
    localStorage.setItem(DISMISS_KEY_PREFIX + ann.id, '1');
    setDismissed(true);
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="text-sm font-semibold">{ann.title}</div>
          <div className="mt-1 text-xs text-muted-foreground">{ann.body}</div>
          <div className="mt-2 text-[11px] text-muted-foreground">{formatRelativeTime(ann.published_at)}</div>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
