/**
 * Reception building picker — toolbar dropdown OR prominent sidebar selector.
 *
 * Renders a Select that reads/writes the building from
 * `useReceptionBuilding()`. Two visual variants:
 *
 *  - `variant="compact"` (default) — h-9 select trigger sized for a
 *    toolbar row. Self-hides loading + no-buildings states inline.
 *
 *  - `variant="prominent"` — full-width, bigger trigger, label above. Designed
 *    to live as the first sidebar group on the visitors workspace so the
 *    receptionist's currently-selected scope is always glanceable.
 *
 * Single-building tenants always see a read-only label (so it's obvious where
 * they're scoped), regardless of variant.
 */
import { Building } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useReceptionBuilding } from './desk-building-context';
import { cn } from '@/lib/utils';

interface Props {
  variant?: 'compact' | 'prominent';
}

export function ReceptionBuildingPicker({ variant = 'compact' }: Props) {
  const { buildingId, buildings, setBuildingId, loading } = useReceptionBuilding();
  const prominent = variant === 'prominent';

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

  if (buildings.length === 1) {
    if (prominent) {
      return (
        <div className="flex items-center gap-2.5 rounded-md border bg-muted/30 px-3 py-2.5">
          <Building className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm font-medium">{buildings[0].name}</span>
        </div>
      );
    }
    return (
      <div className="inline-flex items-center gap-2 text-sm font-medium">
        <Building className="size-4 text-muted-foreground" aria-hidden />
        {buildings[0].name}
      </div>
    );
  }

  return (
    <Select
      value={buildingId ?? undefined}
      onValueChange={(v) => v && setBuildingId(v)}
    >
      <SelectTrigger
        className={cn(
          prominent
            ? 'h-10 w-full text-sm font-medium [&>span]:truncate'
            : 'h-9 min-w-[200px] text-sm',
        )}
      >
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
