import { Users, Presentation, Coffee, Crown, Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  /** Room metadata used to choose an appropriate visual identity. */
  capacity?: number | null;
  /** Optional smart-search keywords from spaces.default_search_keywords. */
  keywords?: readonly string[];
  /** Tailwind size class — h-N w-N. Defaults to 12 (48px). */
  className?: string;
}

/**
 * Visual identity for a room based on its size + keyword tags. Picks one of
 * five categories — huddle, team, board, lounge, generic — and renders a
 * subtle gradient tile with a Lucide icon. This is the visual anchor on
 * each result card; it stops every row from looking the same.
 */
export function RoomTypeIcon({ capacity, keywords = [], className }: Props) {
  const cat = categoryFor(capacity, keywords);
  const { Icon, gradient, ring } = STYLES[cat];

  return (
    <div
      role="presentation"
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-xl',
        gradient,
        ring,
        className ?? 'h-14 w-14',
      )}
    >
      <Icon className="h-5 w-5 text-foreground/80" strokeWidth={1.6} />
    </div>
  );
}

type Cat = 'huddle' | 'team' | 'board' | 'lounge' | 'generic';

function categoryFor(capacity: number | null | undefined, keywords: readonly string[]): Cat {
  const kws = new Set(keywords.map((k) => k.toLowerCase()));
  if (kws.has('board') || kws.has('executive')) return 'board';
  if (kws.has('lounge') || kws.has('cafe') || kws.has('coffee')) return 'lounge';
  if (kws.has('huddle') || kws.has('quick')) return 'huddle';
  if (kws.has('team-sync') || kws.has('planning') || kws.has('retro') || kws.has('demo') || kws.has('review')) return 'team';
  if (typeof capacity === 'number') {
    if (capacity <= 4) return 'huddle';
    if (capacity >= 12) return 'board';
  }
  return capacity == null ? 'generic' : 'team';
}

const STYLES: Record<Cat, { Icon: typeof Users; gradient: string; ring: string }> = {
  huddle: {
    Icon: Users,
    gradient: 'bg-gradient-to-br from-teal-100 to-emerald-50 dark:from-teal-950/40 dark:to-emerald-950/20',
    ring: 'ring-1 ring-teal-500/15',
  },
  team: {
    Icon: Presentation,
    gradient: 'bg-gradient-to-br from-sky-100 to-indigo-50 dark:from-sky-950/40 dark:to-indigo-950/20',
    ring: 'ring-1 ring-sky-500/15',
  },
  board: {
    Icon: Crown,
    gradient: 'bg-gradient-to-br from-amber-100 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/20',
    ring: 'ring-1 ring-amber-500/20',
  },
  lounge: {
    Icon: Coffee,
    gradient: 'bg-gradient-to-br from-rose-100 to-pink-50 dark:from-rose-950/40 dark:to-pink-950/20',
    ring: 'ring-1 ring-rose-500/15',
  },
  generic: {
    Icon: Building2,
    gradient: 'bg-gradient-to-br from-slate-100 to-slate-50 dark:from-slate-900/40 dark:to-slate-900/20',
    ring: 'ring-1 ring-slate-500/15',
  },
};
