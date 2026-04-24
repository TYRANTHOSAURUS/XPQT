import { Badge } from '@/components/ui/badge';

/**
 * Shared source-tag vocabulary for the coverage matrix + drill-down drawer.
 * Keeps the label ↔ style ↔ semantics mapping in one place so the two
 * surfaces can't drift. See docs/service-catalog-live.md §8.
 */

export type SourceTag =
  | 'override'              // a scope override wins
  | 'override_unassigned'   // override with handler_kind='none' (explicit unassign)
  | 'default'               // request-type-level default fills in
  | 'routing'               // resolver walks rules → asset → location-team → RT default
  | 'none';                 // nothing set at any tier

export interface DimensionValue {
  id: string | null;
  name: string | null;
  source: SourceTag;
}

const BADGE_STYLES: Record<SourceTag, string> = {
  override:
    'bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/30',
  override_unassigned:
    'bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/30',
  default: 'bg-muted text-muted-foreground border-border',
  routing: 'bg-background text-muted-foreground border-dashed',
  none: 'bg-background text-muted-foreground border-dashed',
};

const BADGE_LABELS: Record<SourceTag, string> = {
  override: 'override',
  override_unassigned: 'override · unassigned',
  default: 'default',
  routing: 'routing',
  none: '—',
};

/**
 * Compact inline badge used inside matrix cells. The `fallbackForNone` prop
 * lets callers customize the 'none' label per-dimension (e.g. executor SLA's
 * "team / vendor default", or child_dispatch's "not configured").
 */
export function SourceBadge({
  source,
  fallbackForNone,
}: {
  source: SourceTag;
  fallbackForNone?: string;
}) {
  const label = source === 'none' && fallbackForNone ? fallbackForNone : BADGE_LABELS[source];
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] border ${BADGE_STYLES[source]}`}
    >
      {label}
    </span>
  );
}

/**
 * Outline-variant badge used by the drill-down drawer where the context is
 * already spacious and a softer visual is preferred over the matrix's
 * color-coded chip.
 */
export function SourceLabel({
  source,
  fallbackForNone,
}: {
  source: SourceTag;
  fallbackForNone?: string;
}) {
  const map: Record<SourceTag, string> = {
    override: 'override',
    override_unassigned: 'override · unassigned',
    default: 'request-type default',
    routing: 'routing chain',
    none: fallbackForNone ?? 'not set',
  };
  return (
    <Badge variant="outline" className="text-[10px] font-normal">
      {map[source]}
    </Badge>
  );
}

/**
 * Two-line matrix cell: value on top, source badge below. Used in every
 * matrix dimension except Handler (which has its own layout because it
 * can show "Unassigned" as a special kind).
 */
export function DimensionCell({
  v,
  noneLabel = 'not set',
  sourceNoneLabel,
}: {
  v: DimensionValue;
  noneLabel?: string;
  sourceNoneLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={v.id ? '' : 'text-muted-foreground italic text-xs'}>
        {v.name ?? (v.id ? v.id.slice(0, 8) : noneLabel)}
      </span>
      <SourceBadge source={v.source} fallbackForNone={sourceNoneLabel} />
    </div>
  );
}
