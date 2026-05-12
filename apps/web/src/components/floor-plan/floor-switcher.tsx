import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useBuildingFloors } from '@/api/floor-plans/hooks';

type Props = {
  buildingId: string;
  selectedFloorId: string;
  onFloorChange: (id: string) => void;
  /** 0..1 per floor. Populated by the parent page from availability data. */
  occupancyByFloorId: Record<string, number>;
  /** When undefined or length ≤ 1, the building pill is hidden. */
  buildings?: Array<{ id: string; name: string }>;
  selectedBuildingId?: string;
  onBuildingChange?: (id: string) => void;
};

function OccupancyBar({ occupancy }: { occupancy: number }) {
  // Color: green → amber → red
  const color =
    occupancy < 0.5
      ? `hsl(142 ${Math.round(60 + (0 - 60) * occupancy * 2)}% ${Math.round(45 + (55 - 45) * occupancy * 2)}%)`
      : `hsl(${Math.round(38 - (38 - 0) * (occupancy - 0.5) * 2)} 90% 50%)`;

  return (
    <div className="w-full h-1 rounded-full overflow-hidden bg-muted mt-0.5">
      <div
        className="h-full rounded-full transition-all duration-300"
        style={{ width: `${Math.round(occupancy * 100)}%`, backgroundColor: color }}
      />
    </div>
  );
}

function FloorPill({
  label,
  isSelected,
  hasPublishedPlan,
  occupancy,
  onClick,
}: {
  label: string;
  isSelected: boolean;
  hasPublishedPlan: boolean;
  occupancy: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-center justify-center min-w-[2.75rem] px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
        isSelected
          ? 'bg-foreground text-background'
          : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
        !hasPublishedPlan && 'border border-dashed border-muted-foreground/40 opacity-60',
      )}
    >
      <span>{label}</span>
      <OccupancyBar occupancy={occupancy} />
    </button>
  );
}

export function FloorSwitcher({
  buildingId,
  selectedFloorId,
  onFloorChange,
  occupancyByFloorId,
  buildings,
  selectedBuildingId,
  onBuildingChange,
}: Props) {
  const { data: floors = [], isLoading } = useBuildingFloors(buildingId);

  const showBuildingPicker =
    buildings && buildings.length > 1 && selectedBuildingId && onBuildingChange;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Building selector — only when multiple buildings are provided */}
      {showBuildingPicker && (
        <Select
          value={selectedBuildingId}
          onValueChange={(val: string | null) => { if (val) onBuildingChange!(val); }}
        >
          <SelectTrigger className="h-8 text-xs w-auto min-w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {buildings!.map((b) => (
              <SelectItem key={b.id} value={b.id} className="text-xs">
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Floor pills */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {isLoading && (
          <span className="text-xs text-muted-foreground px-2">Loading floors…</span>
        )}
        {floors.map((floor) => {
          // Display label: code if available, otherwise first char of name
          const label = floor.code?.trim() || floor.name.charAt(0).toUpperCase();
          return (
            <FloorPill
              key={floor.id}
              label={label}
              isSelected={floor.id === selectedFloorId}
              // We don't know from this component whether a plan is published;
              // show all floors as solid — parent can pass a filtered list if needed.
              hasPublishedPlan={true}
              occupancy={occupancyByFloorId[floor.id] ?? 0}
              onClick={() => onFloorChange(floor.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
