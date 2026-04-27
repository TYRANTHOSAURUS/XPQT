import { ArrowDownUp, ChevronLeft, ChevronRight, Search, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  ToggleGroup, ToggleGroupItem,
} from '@/components/ui/toggle-group';
import { PersonPicker } from '@/components/person-picker';
import { useSpaceTree, type SpaceTreeNode } from '@/api/spaces';
import type { SchedulerSort, SchedulerWindowState } from '../hooks/use-scheduler-window';

interface Props {
  state: SchedulerWindowState;
  update: <K extends keyof SchedulerWindowState>(key: K, value: SchedulerWindowState[K]) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  visibleDateLabel: string;
  /** Counts for the "X of Y" filter chip. */
  visibleCount: number;
  totalCount: number;
  /** Reset every filter (building/floor/type/search/amenities) at once. */
  onClearFilters: () => void;
}

const SORT_OPTIONS: Array<{ value: SchedulerSort; label: string }> = [
  { value: 'name', label: 'Name (A→Z)' },
  { value: 'capacity_asc', label: 'Capacity (low→high)' },
  { value: 'capacity_desc', label: 'Capacity (high→low)' },
  { value: 'status', label: 'Status (available first)' },
];

const ROOM_TYPE_AMENITIES = [
  { id: '', label: 'Any type' },
  { id: 'whiteboard', label: 'Whiteboard rooms' },
  { id: 'video_conference', label: 'Video rooms' },
  { id: 'phone_conf', label: 'Phone booths' },
  { id: 'projector', label: 'Projector rooms' },
  { id: 'display', label: 'Display rooms' },
] as const;

/**
 * Top bar over the scheduler grid. Building / floor / room-type filters,
 * a search box, the date paginator + Today button, the view-mode toggle,
 * and the persistent "Booking for: <person>" picker that drives rule
 * tagging across the grid.
 */
export function SchedulerToolbar({
  state, update, onPrev, onNext, onToday, visibleDateLabel,
  visibleCount, totalCount, onClearFilters,
}: Props) {
  const tree = useSpaceTree();
  const buildings = useBuildingsFromTree(tree.data);
  const floors = useFloorsForBuilding(tree.data, state.buildingId);

  const filtersActive = !!(
    state.buildingId ||
    state.floorId ||
    state.roomTypeFilter ||
    state.search.trim() ||
    state.amenities.length > 0 ||
    state.statusView !== 'all'
  );

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b bg-background px-4 py-2.5">
      {/* Date paginator */}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" onClick={onPrev} aria-label="Previous">
          <ChevronLeft className="size-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={onToday} className="h-8">
          Today
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onNext} aria-label="Next">
          <ChevronRight className="size-4" />
        </Button>
        <div className="ml-2 min-w-[8ch] text-sm font-medium tabular-nums">
          {visibleDateLabel}
        </div>
      </div>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* View mode */}
      <ToggleGroup
        value={[state.viewMode]}
        onValueChange={(v) => {
          const next = v[0];
          if (next === 'day' || next === 'week') update('viewMode', next);
        }}
        size="sm"
      >
        <ToggleGroupItem value="day" className="h-8 px-3 text-xs">Day</ToggleGroupItem>
        <ToggleGroupItem value="week" className="h-8 px-3 text-xs">Week</ToggleGroupItem>
      </ToggleGroup>

      <div className="mx-1 h-6 w-px bg-border" />

      {/* Building filter */}
      <Select
        value={state.buildingId ?? 'any'}
        onValueChange={(v) => {
          update('buildingId', v === 'any' ? null : v);
          update('floorId', null);
        }}
      >
        <SelectTrigger size="sm" className="h-8 w-[160px]">
          <SelectValue placeholder="Any building" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any building</SelectItem>
          {buildings.map((b) => (
            <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Floor filter (only meaningful when a building is picked) */}
      <Select
        value={state.floorId ?? 'any'}
        onValueChange={(v) => update('floorId', v === 'any' ? null : v)}
        disabled={floors.length === 0}
      >
        <SelectTrigger size="sm" className="h-8 w-[130px]">
          <SelectValue placeholder="Any floor" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any floor</SelectItem>
          {floors.map((f) => (
            <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Room type filter (approximated via amenity in v1) */}
      <Select
        value={state.roomTypeFilter ?? ''}
        onValueChange={(v) => update('roomTypeFilter', v === '' ? null : v)}
      >
        <SelectTrigger size="sm" className="h-8 w-[150px]">
          <SelectValue placeholder="Any type" />
        </SelectTrigger>
        <SelectContent>
          {ROOM_TYPE_AMENITIES.map((opt) => (
            <SelectItem key={opt.id || 'any'} value={opt.id}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={state.search}
          onChange={(e) => update('search', e.target.value)}
          placeholder="Search rooms…"
          className="h-8 w-[180px] pl-7 text-sm"
        />
      </div>

      {/* Sort */}
      <Select
        value={state.sort}
        onValueChange={(v) => update('sort', v as SchedulerSort)}
      >
        <SelectTrigger size="sm" className="h-8 w-[170px]">
          <ArrowDownUp className="size-3.5 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Result count + clear filters. Only renders when filters are
          active so the toolbar isn't visually cluttered in the default
          state. */}
      {filtersActive && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {visibleCount} of {totalCount}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={onClearFilters}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
            Clear filters
          </Button>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <div
          className="flex h-8 items-center gap-1.5 rounded-md border bg-muted/40 pl-2 pr-1"
          aria-label="Booking on behalf of"
        >
          <Users className="size-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Booking for</span>
          <div className="min-w-[180px]">
            <PersonPicker
              value={state.bookForPersonId}
              onChange={(id) => update('bookForPersonId', id || null)}
              placeholder="Yourself"
              clearLabel="Book as myself"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function useBuildingsFromTree(tree: SpaceTreeNode[] | undefined): Array<{ id: string; name: string }> {
  if (!tree) return [];
  const out: Array<{ id: string; name: string }> = [];
  const walk = (node: SpaceTreeNode) => {
    if (node.type === 'building') out.push({ id: node.id, name: node.name });
    for (const c of node.children ?? []) walk(c);
  };
  for (const n of tree) walk(n);
  return out;
}

function useFloorsForBuilding(
  tree: SpaceTreeNode[] | undefined,
  buildingId: string | null,
): Array<{ id: string; name: string }> {
  if (!tree || !buildingId) return [];
  const out: Array<{ id: string; name: string }> = [];
  const findBuilding = (node: SpaceTreeNode): SpaceTreeNode | null => {
    if (node.id === buildingId) return node;
    for (const c of node.children ?? []) {
      const hit = findBuilding(c);
      if (hit) return hit;
    }
    return null;
  };
  for (const n of tree) {
    const b = findBuilding(n);
    if (b) {
      for (const f of b.children ?? []) {
        if (f.type === 'floor') out.push({ id: f.id, name: f.name });
      }
      break;
    }
  }
  return out;
}
