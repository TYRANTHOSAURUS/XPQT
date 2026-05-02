/**
 * Reception building picker — header dropdown.
 *
 * Renders a Select that reads/writes the building from
 * `useReceptionBuilding()`. When the user only has one building, we still
 * show the picker (read-only label) so it's obvious where they're scoped
 * to.
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

export function ReceptionBuildingPicker() {
  const { buildingId, buildings, setBuildingId, loading } = useReceptionBuilding();

  if (loading) {
    return (
      <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Building className="size-4" aria-hidden />
        Loading…
      </div>
    );
  }

  if (buildings.length === 0) {
    return (
      <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Building className="size-4" aria-hidden />
        No buildings in scope
      </div>
    );
  }

  if (buildings.length === 1) {
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
