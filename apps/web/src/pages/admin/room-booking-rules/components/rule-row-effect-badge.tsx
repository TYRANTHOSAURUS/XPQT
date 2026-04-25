import { Ban, ShieldCheck, AlertTriangle, KeyRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { RuleEffect } from '@/api/room-booking-rules';

interface RuleRowEffectBadgeProps {
  effect: RuleEffect;
  className?: string;
}

const EFFECT_META: Record<
  RuleEffect,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: string }
> = {
  deny: {
    label: 'Deny',
    icon: Ban,
    tone: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/30',
  },
  require_approval: {
    label: 'Approval',
    icon: ShieldCheck,
    tone: 'bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  },
  warn: {
    label: 'Warn',
    icon: AlertTriangle,
    tone: 'bg-yellow-50 text-yellow-800 ring-1 ring-inset ring-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-300 dark:ring-yellow-500/30',
  },
  allow_override: {
    label: 'Allow override',
    icon: KeyRound,
    tone: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  },
};

/**
 * Pill summarising a rule's `effect`. Reused by the rules index, the desk
 * scheduler conflict UI, and the simulation result panel.
 */
export function RuleRowEffectBadge({ effect, className }: RuleRowEffectBadgeProps) {
  const meta = EFFECT_META[effect];
  const Icon = meta.icon;
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-6 gap-1 border-0 px-2 font-medium',
        meta.tone,
        className,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </Badge>
  );
}
