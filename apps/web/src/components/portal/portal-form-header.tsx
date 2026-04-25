import * as Icons from 'lucide-react';
import { Link } from 'react-router-dom';

interface Props {
  iconName?: string | null;
  name: string;
  whatHappensNext?: string | null;
  backTo?: string;
  backLabel?: string;
}

export function PortalFormHeader({ iconName, name, whatHappensNext, backTo, backLabel }: Props) {
  const Icon = iconName && (Icons as Record<string, unknown>)[iconName] as React.ComponentType<{ className?: string }> | undefined;
  return (
    <header className="space-y-4">
      {backTo && (
        <Link to={backTo} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <Icons.ArrowLeft className="size-3.5" />
          {backLabel ?? 'Back'}
        </Link>
      )}
      <div className="flex items-start gap-4 pb-5 border-b">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          {Icon ? <Icon className="size-5" /> : <Icons.HelpCircle className="size-5" />}
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">{name}</h1>
          {whatHappensNext && (
            <p className="mt-1.5 max-w-prose text-sm text-muted-foreground text-pretty">{whatHappensNext}</p>
          )}
        </div>
      </div>
    </header>
  );
}
