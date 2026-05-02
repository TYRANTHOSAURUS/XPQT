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

interface Props {
  row: RowT;
  selected: boolean;
  checked: boolean;
  /** Hold a persistent highlight while the row's context menu is open. */
  menuOpen?: boolean;
  onSelect: (id: string) => void;
  onToggleCheck: (id: string) => void;
}

/**
 * Linear-style visitor row — flex layout, hairline divider, no table
 * chrome. Mirrors `ticket-list-row.tsx` so the desk's two list pages
 * share the same row idiom.
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
}: Props) {
  const time = row.expected_at ? formatTimeShort(row.expected_at) : null;
  const host = formatPrimaryHost(row);
  const visitor = formatReceptionRowName(row);

  return (
    <div
      role="button"
      tabIndex={0}
      data-selected={selected ? 'true' : undefined}
      onClick={() => onSelect(row.visitor_id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(row.visitor_id);
        }
      }}
      className={`group flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
        selected
          ? 'bg-accent'
          : menuOpen
            ? 'bg-muted/50'
            : 'hover:bg-muted/30'
      }`}
      // contentVisibility skips render work for rows scrolled off-screen;
      // intrinsic size keeps the scrollbar stable.
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 52px',
        boxShadow: selected ? 'inset 2px 0 0 var(--primary)' : undefined,
      }}
    >
      <div className="w-4 shrink-0" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={checked} onCheckedChange={() => onToggleCheck(row.visitor_id)} />
      </div>

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
    </div>
  );
}

export const VisitorListRow = memo(VisitorListRowImpl);
