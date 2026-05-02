/**
 * Reception building picker — toolbar dropdown OR prominent sidebar selector.
 *
 * Two visual variants:
 *
 *  - `variant="compact"` — h-9 select trigger sized for a toolbar row.
 *  - `variant="prominent"` — full-width, two-line, NavUser-shaped selector.
 *    Uses `SidebarMenu` + `SidebarMenuButton size="lg"` so it inherits the
 *    sidebar theming, focus-visible baseline, and collapsed-rail behaviour
 *    used by the user menu — keeping reception's "where am I scoped?"
 *    selector visually peer to the rest of the sidebar.
 *
 * Single-building tenants always see a read-only label (so it's obvious
 * where they're scoped), regardless of variant. The prominent variant
 * still uses `SidebarMenuButton` (disabled) so the visual rhythm matches
 * the multi-building case.
 */
import { Building, ChevronsUpDownIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useReceptionBuilding } from './desk-building-context';
import { useSpaces, resolveSpaceSubline, type Space } from '@/api/spaces';
import { cn } from '@/lib/utils';

interface Props {
  variant?: 'compact' | 'prominent';
}

export function ReceptionBuildingPicker({ variant = 'compact' }: Props) {
  const { buildingId, buildings, setBuildingId, loading } = useReceptionBuilding();
  // `error` lets us suppress the parent-name lookup gracefully — if the
  // spaces list failed, we still render the trigger (with the active
  // building name) so the user can switch buildings and use reception
  // even when the auxiliary lookup tipped over.
  const { data: allSpaces, isLoading: spacesLoading, error: spacesError } = useSpaces();
  const prominent = variant === 'prominent';

  // While allSpaces is still loading, pass `null` so resolveSpaceSubline
  // returns `null` for any building whose subline depends on the parent
  // lookup. Caller renders an empty subline slot in that window instead
  // of flipping from code → parent name once the list resolves.
  // On error we substitute `[]` so resolveSpaceSubline still produces
  // the best-effort fallback (code / type) without waiting forever.
  const spacesForSubline: Space[] | null = spacesError
    ? []
    : spacesLoading
      ? null
      : (allSpaces ?? []);
  const sublineErrorTitle = spacesError
    ? "Couldn't load building details"
    : undefined;

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'inline-flex items-center gap-2 text-sm text-muted-foreground',
          prominent && 'w-full px-3 py-2',
        )}
      >
        <Building className="size-4" aria-hidden />
        Loading…
      </div>
    );
  }

  if (buildings.length === 0) {
    return (
      <div
        className={cn(
          'inline-flex items-center gap-2 text-sm text-muted-foreground',
          prominent && 'w-full px-3 py-2',
        )}
      >
        <Building className="size-4" aria-hidden />
        No buildings in scope
      </div>
    );
  }

  const active = buildings.find((b) => b.id === buildingId) ?? buildings[0];
  const subline = active ? resolveSpaceSubline(active, spacesForSubline) : null;
  // Combined SR label so screen readers announce "Acme HQ, Amsterdam Campus"
  // as one phrase instead of two separately-located <span>s, and so the
  // disabled single-building variant communicates the same context.
  const combinedLabel = active
    ? subline
      ? `${active.name}, ${subline}`
      : active.name
    : '';

  if (buildings.length === 1) {
    if (prominent) {
      // Same SidebarMenuButton shape as the multi-building trigger but
      // disabled. Keeps visual rhythm consistent — the receptionist sees
      // the same "scope tile" whether there's one building or many.
      return (
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              disabled
              className="md:h-auto md:p-3"
              aria-label={`Scoped to ${combinedLabel}`}
              title={sublineErrorTitle}
            >
              <Building className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{active.name}</span>
                {subline && (
                  <span className="truncate text-xs text-muted-foreground">{subline}</span>
                )}
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      );
    }
    return (
      <div className="inline-flex items-center gap-2 text-sm font-medium">
        <Building className="size-4 text-muted-foreground" aria-hidden />
        {active.name}
      </div>
    );
  }

  // Multi-building: prominent uses a DropdownMenu with the NavUser shape
  // (SidebarMenuButton size="lg" two-line trigger). Compact stays a Select.
  if (prominent) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  size="lg"
                  // Combined "name, subline" so SR users hear both lines as
                  // one phrase. The decorative <span>s below are visual
                  // only; this aria-label is the source of truth.
                  aria-label={combinedLabel || 'Switch building'}
                  title={sublineErrorTitle}
                  className="md:h-auto md:p-3 data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
                />
              }
            >
              <Building className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{active.name}</span>
                {subline && (
                  <span className="truncate text-xs text-muted-foreground">{subline}</span>
                )}
              </div>
              <ChevronsUpDownIcon
                className="ml-auto size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              side="bottom"
              className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[16rem]"
            >
              {buildings.map((b) => {
                const sub = resolveSpaceSubline(b, spacesForSubline);
                const isActive = b.id === active.id;
                return (
                  <DropdownMenuItem
                    key={b.id}
                    onSelect={() => setBuildingId(b.id)}
                    className="gap-2.5"
                    // aria-current marks the row that matches the current
                    // scope so SR users can tell which building is selected
                    // without relying on visual styling.
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <Building className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 grid flex-1 leading-tight">
                      <span className="truncate text-sm">{b.name}</span>
                      {sub && (
                        <span className="truncate text-xs text-muted-foreground">{sub}</span>
                      )}
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <Select
      value={buildingId ?? undefined}
      onValueChange={(v) => v && setBuildingId(v)}
    >
      <SelectTrigger className="h-9 min-w-[200px] text-sm">
        <Building className="size-4 text-muted-foreground" aria-hidden />
        <SelectValue placeholder="Pick a building" />
      </SelectTrigger>
      <SelectContent>
        {buildings.map((b) => (
          <SelectItem key={b.id} value={b.id}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
