import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ChildDispatchEditor } from './child-dispatch-editor';
import { LocationTeamsEditor } from './location-teams-editor';
import { SpaceGroupsEditor } from './space-groups-editor';
import { CoverageMatrix } from './coverage-matrix';

/**
 * Child Dispatch tab container.
 *
 * Primary editor on top (policy-based child dispatch). Legacy location
 * tooling folds in below as collapsed sub-panels — `Mappings`,
 * `Groups`, `Coverage` used to be first-class tabs but they're
 * implementation mechanisms, not admin mental models (per Artifact C).
 *
 * Keeps them available because `execution_routing='by_location'` in
 * ChildDispatchPolicy reads from location_teams (populated by the
 * Mappings + Groups tools here). Once enough tenants are on v2_only and
 * legacy location_teams retires, these sub-panels come out.
 */
export function ChildDispatchTab() {
  return (
    <div className="flex flex-col gap-4">
      <ChildDispatchEditor />

      <section className="rounded-md border bg-muted/20">
        <header className="border-b px-3 py-2 text-xs uppercase text-muted-foreground">
          Location coverage (legacy inputs)
        </header>
        <div className="flex flex-col">
          <LegacyPanel title="Location mappings" defaultOpen={false}>
            <LocationTeamsEditor compact />
          </LegacyPanel>
          <LegacyPanel title="Space groups" defaultOpen={false}>
            <SpaceGroupsEditor compact />
          </LegacyPanel>
          <LegacyPanel title="Coverage matrix" defaultOpen={false}>
            <CoverageMatrix />
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
