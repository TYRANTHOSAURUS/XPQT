import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { resolvePortalIcon } from '@/lib/portal-icons';

interface Props {
  iconName?: string | null;
  name: string;
  whatHappensNext?: string | null;
  backTo?: string;
  backLabel?: string;
}

export function PortalFormHeader({ iconName, name, whatHappensNext, backTo, backLabel }: Props) {
  const Icon = resolvePortalIcon(iconName);
  return (
    <header className="space-y-4">
      {backTo && (
        <Link to={backTo} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
          {backLabel ?? 'Back'}
        </Link>
      )}
      <div className="flex items-start gap-4 pb-5 border-b">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-balance">{name}</h1>
          {whatHappensNext && (
            <p className="mt-1.5 max-w-prose text-sm text-muted-foreground text-pretty">{whatHappensNext}</p>
          )}
        </div>
      </div>
    </header>
  );
}
