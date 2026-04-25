import { useMemo } from 'react';
import {
  Building2,
  Clock,
  Hourglass,
  KeyRound,
  ShieldCheck,
  Sparkles,
  Timer,
  Users,
  UserCheck,
  UsersRound,
  AlertTriangle,
  Layers,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RuleTemplate } from '@/api/room-booking-rules';
import { RuleRowEffectBadge } from './rule-row-effect-badge';

interface RuleTemplatesGridProps {
  templates: RuleTemplate[];
  onPick: (template: RuleTemplate) => void;
  className?: string;
}

const ICON_BY_ID: Record<string, React.ComponentType<{ className?: string }>> = {
  restrict_to_roles: ShieldCheck,
  restrict_to_org_subtree: Building2,
  off_hours_need_approval: Clock,
  min_lead_time: Timer,
  max_lead_time: Hourglass,
  max_duration: Hourglass,
  capacity_tolerance: Users,
  long_bookings_need_manager_approval: UserCheck,
  high_capacity_needs_vp_approval: UsersRound,
  capacity_floor: Users,
  soft_over_capacity_warning: AlertTriangle,
  service_desk_override_allow: KeyRound,
};

/**
 * 12 starter-template cards. Used both on the empty state of the index page
 * and as the picker pane in the rule editor dialog. Each card opens the
 * editor dialog at the parameter form for that template.
 */
export function RuleTemplatesGrid({ templates, onPick, className }: RuleTemplatesGridProps) {
  const sorted = useMemo(() => [...templates].sort((a, b) => a.label.localeCompare(b.label)), [templates]);

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
        const Icon = ICON_BY_ID[tpl.id] ?? Layers;
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
            )}
            style={{ transitionTimingFunction: 'var(--ease-smooth)' }}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground transition-colors group-hover:text-foreground">
                <Icon className="size-4" />
              </div>
              <RuleRowEffectBadge effect={tpl.effect_hint} className="shrink-0" />
            </div>
            <div className="flex flex-col gap-0.5">
              <div className="text-sm font-medium leading-tight">{tpl.label}</div>
              <div className="text-xs text-muted-foreground">{tpl.description}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
