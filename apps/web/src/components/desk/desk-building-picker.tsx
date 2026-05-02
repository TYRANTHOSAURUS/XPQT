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
import { useSpaces } from '@/api/spaces';
import { cn } from '@/lib/utils';
import type { Space } from '@/api/spaces/types';

interface Props {
  variant?: 'compact' | 'prominent';
}

/**
 * Resolve a sub-label for a building/site. We don't have a structured
 * `address` field on `spaces`, so we fall back through the most useful
 * context the data model gives us:
 *
 *   1. `attributes.address` (free-form jsonb attribute, if the tenant set it)
 *   2. Parent space name (e.g. "Amsterdam Campus" for a building under it)
 *   3. The building's code (e.g. "AMS-HQ")
 *   4. The space type label ("Building" / "Site")
 *
 * The parent-space lookup needs the full `spaces` list; we accept it as
 * an arg so the caller can pass `null` while the list is still loading.
 * Returning `null` in that window prevents the sub-line from flipping
 * from `code` → parent name once spaces resolve, which would re-shape
 * the trigger height mid-render.
 *
 * Concretely answers "where is this in the world" without requiring a
 * schema change. When backends grow a real address column, swap step 1.
 */
function resolveSubline(b: Space, allSpaces: Space[] | null): string | null {
  const attrs = b.attributes as { address?: string; street?: string } | null | undefined;
  if (attrs?.address) return attrs.address;
  if (attrs?.street) return attrs.street;
  // Lazy parent lookup — only scans `allSpaces` when we actually need
  // the parent. With at most ~N buildings rendered, this is N lookups
  // over a list of size M, vs. building an M-entry Map up-front for
  // every render. M can be 1k–10k tenant-wide; N is typically <10.
  if (b.parent_id) {
    if (!allSpaces) return null;
    const parent = allSpaces.find((s) => s.id === b.parent_id);
    if (parent) return parent.name;
  }
  if (b.code) return b.code;
  return b.type === 'site' ? 'Site' : 'Building';
}

export function ReceptionBuildingPicker({ variant = 'compact' }: Props) {
  const { buildingId, buildings, setBuildingId, loading } = useReceptionBuilding();
  const { data: allSpaces, isLoading: spacesLoading } = useSpaces();
  const prominent = variant === 'prominent';

  // While allSpaces is still loading, pass `null` so resolveSubline returns
  // `null` for any building whose subline depends on the parent lookup.
  // Caller renders an empty subline slot in that window instead of
  // flipping from code → parent name once the list resolves.
  const spacesForSubline: Space[] | null = spacesLoading ? null : (allSpaces ?? []);

  if (loading) {
    return (
      <div
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
  const subline = active ? resolveSubline(active, spacesForSubline) : null;

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
              aria-label={`Scoped to ${active.name}`}
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
                  aria-label="Switch building"
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
                const sub = resolveSubline(b, spacesForSubline);
                return (
                  <DropdownMenuItem
                    key={b.id}
                    onSelect={() => setBuildingId(b.id)}
                    className="gap-2.5"
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
