/**
 * Reception building picker — toolbar dropdown OR prominent sidebar selector.
 *
 * Two visual variants:
 *
 *  - `variant="compact"` — h-9 select trigger sized for a toolbar row.
 *  - `variant="prominent"` — full-width, two-line, button-driven dropdown.
 *    Mirrors the NavUser shape (size="lg" feel: building name on top,
 *    sub-line below). Designed to live as the first sidebar group on the
 *    visitors workspace so the receptionist's currently-selected scope is
 *    always glanceable.
 *
 * Single-building tenants always see a read-only label (so it's obvious
 * where they're scoped), regardless of variant.
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
import { useReceptionBuilding } from './desk-building-context';
import { useSpaces } from '@/api/spaces';
import { cn } from '@/lib/utils';
import { useMemo } from 'react';
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
 * Concretely answers "where is this in the world" without requiring a
 * schema change. When backends grow a real address column, swap step 1.
 */
function resolveSubline(b: Space, byId: Map<string, Space>): string {
  const attrs = b.attributes as { address?: string; street?: string } | null | undefined;
  if (attrs?.address) return attrs.address;
  if (attrs?.street) return attrs.street;
  if (b.parent_id) {
    const parent = byId.get(b.parent_id);
    if (parent) return parent.name;
  }
  if (b.code) return b.code;
  return b.type === 'site' ? 'Site' : 'Building';
}

export function ReceptionBuildingPicker({ variant = 'compact' }: Props) {
  const { buildingId, buildings, setBuildingId, loading } = useReceptionBuilding();
  const { data: allSpaces } = useSpaces();
  const prominent = variant === 'prominent';

  // Map of every space (including non-buildings) so we can resolve the
  // immediate parent of a building → its name as a sub-line.
  const byId = useMemo<Map<string, Space>>(() => {
    const m = new Map<string, Space>();
    for (const s of allSpaces ?? []) m.set(s.id, s);
    return m;
  }, [allSpaces]);

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
  const subline = active ? resolveSubline(active, byId) : '';

  if (buildings.length === 1) {
    if (prominent) {
      return (
        <div className="flex w-full items-center gap-2.5 rounded-md border bg-muted/30 px-3 py-2.5">
          <Building className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 grid flex-1 text-left leading-tight">
            <span className="truncate text-sm font-medium">{active.name}</span>
            {subline && (
              <span className="truncate text-xs text-muted-foreground">{subline}</span>
            )}
          </div>
        </div>
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
  // (large two-line trigger). Compact stays a Select.
  if (prominent) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className={cn(
                'flex h-auto w-full items-center gap-2.5 rounded-md border bg-background px-3 py-2.5 text-left',
                'transition-colors hover:bg-accent/40 data-open:bg-accent/40',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
              aria-label="Switch building"
            />
          }
        >
          <Building className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 grid flex-1 text-left leading-tight">
            <span className="truncate text-sm font-medium">{active.name}</span>
            {subline && (
              <span className="truncate text-xs text-muted-foreground">{subline}</span>
            )}
          </div>
          <ChevronsUpDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="bottom"
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[16rem]"
        >
          {buildings.map((b) => {
            const sub = resolveSubline(b, byId);
            return (
              <DropdownMenuItem key={b.id} onSelect={() => setBuildingId(b.id)} className="gap-2.5">
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
