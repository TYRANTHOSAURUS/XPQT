import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { RoutingRulesEditor } from './routing-rules-editor';
import { DomainsEditor } from './domains-editor';
import { DomainFallbacksEditor } from './domain-fallbacks-editor';

/**
 * Advanced Overrides tab container.
 *
 * Routing rules on top (the primary exception-handling surface). Domain
 * registry and legacy domain_parents chains fold in as collapsed
 * sub-panels below — they're reference data that rules and policies
 * both read, but most admins won't touch them day-to-day.
 */
export function AdvancedOverridesTab() {
  return (
    <div className="flex flex-col gap-4">
      <RoutingRulesEditor compact />

      <section className="rounded-md border bg-muted/20">
        <header className="border-b px-3 py-2 text-xs uppercase text-muted-foreground">
          Domain configuration
        </header>
        <div className="flex flex-col">
          <LegacyPanel title="Domains registry" defaultOpen={false}>
            <DomainsEditor />
          </LegacyPanel>
          <LegacyPanel title="Domain fallback chains (legacy)" defaultOpen={false}>
            <DomainFallbacksEditor compact />
          </LegacyPanel>
        </div>
      </section>
    </div>
  );
}

function LegacyPanel({
  title, defaultOpen, children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
        <span className="font-medium">{title}</span>
      </button>
      {open && <div className="border-t bg-background px-3 py-3">{children}</div>}
    </div>
  );
}
