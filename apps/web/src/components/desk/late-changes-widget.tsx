import { useState } from 'react';
import { PhoneCall, Check, Clock, AlertTriangle } from 'lucide-react';
import { usePostCutoffList, useConfirmPhoned, type PostCutoffGroup } from '@/api/post-cutoff';
import { Button } from '@/components/ui/button';
import { toastError, toastSuccess } from '@/lib/toast';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

/**
 * Desk-side "Today's late changes" widget — daily-list spec §10.
 *
 * Renders post-cutoff order_line_item edits grouped by vendor. Each
 * vendor card shows a phone CTA + per-line summary; "Confirm phoned"
 * stamps the line so it disappears from the widget. The DB trigger
 * re-flags any subsequent edit, so a fresh edit reopens the loop.
 *
 * Hidden when there's nothing pending so it doesn't take up real
 * estate on calm days.
 */
export function LateChangesWidget() {
  const { data, isLoading } = usePostCutoffList();

  if (isLoading) return null;
  const groups = data ?? [];
  if (groups.length === 0) return null;

  const totalLines = groups.reduce((sum, g) => sum + g.line_count, 0);

  return (
    <section
      className="mb-4 rounded-xl border border-amber-300/60 bg-amber-50/60 dark:bg-amber-950/20 dark:border-amber-700/30"
      aria-label="Late changes that need vendor follow-up"
    >
      <header className="flex items-center gap-3 border-b border-amber-300/60 dark:border-amber-700/30 px-4 py-3">
        <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
        <h2 className="text-sm font-semibold">
          Today's late changes — call these vendors
        </h2>
        <span
          className="ml-auto rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:text-amber-200 tabular-nums"
        >
          {totalLines} {totalLines === 1 ? 'line' : 'lines'} · {groups.length} {groups.length === 1 ? 'vendor' : 'vendors'}
        </span>
      </header>
      <ul className="divide-y divide-amber-300/40 dark:divide-amber-700/20">
        {groups.map((g) => (
          <VendorCard key={g.vendor_id ?? g.vendor_name} group={g} />
        ))}
      </ul>
    </section>
  );
}

function VendorCard({ group }: { group: PostCutoffGroup }) {
  const [confirmingAll, setConfirmingAll] = useState(false);
  const confirmPhoned = useConfirmPhoned();

  const handleConfirm = async (lineId: string) => {
    try {
      await confirmPhoned.mutateAsync({ lineId });
    } catch (err) {
      toastError("Couldn't mark as phoned", { error: err });
    }
  };

  const handleConfirmAll = async () => {
    setConfirmingAll(true);
    try {
      for (const line of group.lines) {
        await confirmPhoned.mutateAsync({ lineId: line.line_id });
      }
      toastSuccess(`${group.vendor_name} marked as phoned`);
    } catch (err) {
      toastError("Couldn't mark all as phoned", { error: err });
    } finally {
      setConfirmingAll(false);
    }
  };

  return (
    <li className="px-4 py-3">
      <header className="flex items-center gap-3">
        <PhoneCall className="size-4 text-muted-foreground" aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm">{group.vendor_name}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {group.vendor_phone}
          </div>
        </div>
        {group.line_count > 1 ? (
          <Button
            variant="outline"
            size="sm"
            disabled={confirmingAll}
            onClick={handleConfirmAll}
          >
            <Check className="size-3.5" />
            Confirm all phoned
          </Button>
        ) : null}
      </header>
      <ul className="mt-2 space-y-1.5">
        {group.lines.map((line) => (
          <li
            key={line.line_id}
            className="flex items-start gap-3 rounded-md bg-white/60 dark:bg-black/10 px-3 py-2 text-xs"
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-foreground">
                Order #{line.order_id.slice(0, 8)} · {line.catalog_item_name} ×{line.quantity}
              </div>
              <div className="mt-0.5 text-muted-foreground">
                {line.room_name}
                {line.requester_first_name ? ` · ${line.requester_first_name}` : ''}
                {line.service_window_start_at ? (
                  <>
                    {' · '}
                    <time
                      dateTime={line.service_window_start_at}
                      title={formatFullTimestamp(line.service_window_start_at)}
                    >
                      <Clock className="inline size-3 -mt-0.5" aria-hidden />{' '}
                      {formatRelativeTime(line.service_window_start_at)}
                    </time>
                  </>
                ) : null}
                {line.dietary_notes ? ` · diet: ${line.dietary_notes}` : ''}
                {line.requester_notes ? ` · note: ${line.requester_notes}` : ''}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleConfirm(line.line_id)}
              disabled={confirmPhoned.isPending}
              className="text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              <Check className="size-3.5" />
              Phoned
            </Button>
          </li>
        ))}
      </ul>
    </li>
  );
}
