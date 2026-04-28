import { useMemo } from 'react';
import {
  Sparkles,
  DollarSign,
  Clock,
  ShieldCheck,
  Users,
  CalendarOff,
  UserCheck,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ServiceRuleTemplate } from '@/api/service-rules';

const ICON_BY_KEY: Record<string, React.ComponentType<{ className?: string }>> = {
  cost_threshold_approval:    DollarSign,
  external_vendor_approval:   ShieldCheck,
  cost_center_owner_approval: UserCheck,
  per_item_lead_time:         Clock,
  min_attendee_for_item:      Users,
  item_blackout:              CalendarOff,
  role_restricted_item:       ShieldCheck,
};

const CATEGORY_TONE: Record<string, string> = {
  approval:     'text-amber-700 dark:text-amber-400',
  availability: 'text-blue-700 dark:text-blue-400',
  capacity:     'text-emerald-700 dark:text-emerald-400',
};

export interface ServiceRuleTemplateGridProps {
  templates: ServiceRuleTemplate[];
  onPick: (template: ServiceRuleTemplate) => void;
  pickedId?: string | null;
  className?: string;
}

/**
 * 7 starter-template cards (migration 00149). Used both on the empty
 * state of the index page and as the picker pane in the rule editor
 * dialog. Each card opens the editor at the parameter form for that
 * template. Mirrors apps/web/src/pages/admin/room-booking-rules/
 * components/rule-templates-grid.tsx for visual consistency.
 */
export function ServiceRuleTemplateGrid({
  templates,
  onPick,
  pickedId,
  className,
}: ServiceRuleTemplateGridProps) {
  const sorted = useMemo(
    () => [...templates].sort((a, b) => a.name.localeCompare(b.name)),
    [templates],
  );

  if (sorted.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" />
        Templates load from the API. None available right now.
      </div>
    );
  }

  return (
    <div className={cn('grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {sorted.map((tpl) => {
        const Icon = ICON_BY_KEY[tpl.template_key] ?? Layers;
        const tone = CATEGORY_TONE[tpl.category] ?? 'text-muted-foreground';
        const isPicked = tpl.id === pickedId;
        return (
          <button
            key={tpl.id}
            type="button"
            onClick={() => onPick(tpl)}
            className={cn(
              'group flex flex-col gap-2 rounded-lg border bg-card p-3 text-left',
              'transition-[background-color,border-color] duration-150',
              'hover:bg-muted/40 hover:border-foreground/20',
              'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              isPicked && 'border-primary/60 bg-primary/5 ring-1 ring-primary/30',
            )}
            style={{ transitionTimingFunction: 'var(--ease-smooth)' }}
            aria-pressed={isPicked}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors group-hover:text-foreground">
                <Icon className="size-4" />
              </div>
              <span className={cn('text-[10px] font-medium uppercase tracking-wide', tone)}>
                {tpl.category}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="text-sm font-medium">{tpl.name}</div>
              <div className="text-xs text-muted-foreground line-clamp-3">{tpl.description}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
