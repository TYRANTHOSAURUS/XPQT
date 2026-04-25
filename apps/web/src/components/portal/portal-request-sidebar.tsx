import { ReactNode } from 'react';
import { PortalSlaRing } from './portal-sla-ring';
import { cn } from '@/lib/utils';

interface SlaProps {
  progress: number;
  remainingLabel: string;
  breached?: boolean;
}

interface Props {
  status: { label: string; sla?: SlaProps };
  blocks: Array<{ label: string; value: ReactNode; description?: string }>;
  className?: string;
}

export function PortalRequestSidebar({ status, blocks, className }: Props) {
  return (
    <aside className={cn('space-y-4', className)}>
      <section>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">Status</div>
        <div className={cn(
          'flex items-center gap-3 rounded-xl border px-3 py-2.5',
          status.sla?.breached ? 'border-red-500/30 bg-red-500/5' :
            status.sla && status.sla.progress > 0.66 ? 'border-yellow-500/30 bg-yellow-500/5' :
            'border-emerald-500/30 bg-emerald-500/5',
        )}>
          {status.sla && (
            <PortalSlaRing progress={status.sla.progress} breached={status.sla.breached} />
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{status.label}</div>
            {status.sla && (
              <div className="text-[11px] text-muted-foreground">{status.sla.remainingLabel}</div>
            )}
          </div>
        </div>
      </section>

      {blocks.map((b) => (
        <section key={b.label}>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">{b.label}</div>
          <div className="text-sm">{b.value}</div>
          {b.description && <div className="text-xs text-muted-foreground mt-0.5">{b.description}</div>}
        </section>
      ))}
    </aside>
  );
}
