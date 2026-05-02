import { memo } from 'react';
import { KeyRound } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { VisitorStatusBadge } from '@/components/visitors/visitor-status-badge';
import {
  formatPrimaryHost,
  formatReceptionRowName,
  type ReceptionVisitorRow as RowT,
} from '@/api/visitors/reception';
import { formatTimeShort } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Props {
  row: RowT;
  selected: boolean;
  checked: boolean;
  /** Hold a persistent highlight while the row's context menu is open. */
  menuOpen?: boolean;
  onSelect: (id: string) => void;
  onToggleCheck: (id: string) => void;
  /** Enter (no modifier) on the row triggers a status-aware primary action
   *  resolved by the parent (mark arrived / open checkout dialog). The
   *  row only forwards the keystroke; the parent decides what it means. */
  onPrimaryAction?: (row: RowT) => void;
}

/**
 * Linear-style visitor row — flex layout, hairline divider, no table
 * chrome. Mirrors `ticket-list-row.tsx` so the desk's two list pages
 * share the same row idiom.
 *
 * Semantics:
 *   - Click       → open detail panel (via `onSelect`).
 *   - Space       → open detail panel (matches click).
 *   - Enter       → status-aware primary action via `onPrimaryAction`,
 *                   falling back to `onSelect` if the parent didn't
 *                   provide one.
 *   - Cmd/Ctrl+Enter → open detail panel regardless of status.
 *
 * The checkbox is rendered as a sibling, not a child of the row button —
 * an interactive element nested inside a `<button>` is invalid HTML and
 * breaks keyboard semantics. The row stays a single visual unit through
 * its containing `<div>` wrapper.
 *
 * Wrapped in `memo` because the desk-lens query refetches every 30s
 * and a parent re-render shouldn't cascade through 50+ visible rows.
 */
function VisitorListRowImpl({
  row,
  selected,
  checked,
  menuOpen,
  onSelect,
  onToggleCheck,
  onPrimaryAction,
}: Props) {
  const time = row.expected_at ? formatTimeShort(row.expected_at) : null;
  const host = formatPrimaryHost(row);
  const visitor = formatReceptionRowName(row);

  return (
    <div
      data-selected={selected ? 'true' : undefined}
      className={cn(
        'group relative flex items-stretch transition-colors',
        selected
          ? 'bg-accent'
          : menuOpen
            ? 'bg-muted/50'
            : 'hover:bg-muted/30',
      )}
      // contentVisibility skips render work for rows scrolled off-screen;
      // intrinsic size keeps the scrollbar stable.
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 52px',
        boxShadow: selected ? 'inset 2px 0 0 var(--primary)' : undefined,
      }}
    >
      {/* Checkbox sits outside the row button so it doesn't nest an
          interactive element inside another. The flex parent keeps both
          elements visually flush. */}
      <div className="flex w-7 shrink-0 items-center pl-3">
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggleCheck(row.visitor_id)}
          aria-label={`Select ${visitor}`}
        />
      </div>

      <button
        type="button"
        onClick={() => onSelect(row.visitor_id)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter → always open detail.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSelect(row.visitor_id);
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            if (onPrimaryAction) onPrimaryAction(row);
            else onSelect(row.visitor_id);
            return;
          }
          // Space defaults to "open detail" — matches click and the
          // browser default for activating a button.
          if (e.key === ' ') {
            e.preventDefault();
            onSelect(row.visitor_id);
          }
        }}
        className="flex flex-1 items-center gap-3 px-3 py-2 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
          {time ?? '—'}
        </span>

        <div className="flex-1 min-w-0">
          <div className="truncate text-sm">{visitor}</div>
          <div className="truncate text-xs text-muted-foreground">
            {host ? <>Host: {host}</> : <span className="italic">No host</span>}
          </div>
        </div>

        <div className="hidden w-24 shrink-0 text-xs text-muted-foreground sm:block">
          {row.pass_number ? (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <KeyRound className="size-3" aria-hidden /> #{row.pass_number}
            </span>
          ) : (
            <span className="text-muted-foreground/60">—</span>
          )}
        </div>

        <VisitorStatusBadge status={row.status} />
      </button>
    </div>
  );
}

export const VisitorListRow = memo(VisitorListRowImpl);
