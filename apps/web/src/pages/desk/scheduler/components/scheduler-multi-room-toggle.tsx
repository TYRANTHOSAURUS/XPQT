import { Layers, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  selectedSpaceIds: string[];
  onClear: () => void;
  onBookAll: () => void;
}

/**
 * Floating action bar that appears when the operator shift-clicks cells
 * on multiple rooms at the same time slot. Per spec §4.4: "shift-click
 * multiple cells → 'Book all selected as multi-room' → atomic."
 *
 * Backend `useMultiRoomBooking` currently 501s; we surface that via a
 * disabled state + tooltip ("Multi-room atomic create ships in Phase G").
 */
export function SchedulerMultiRoomToggle({ selectedSpaceIds, onClear, onBookAll }: Props) {
  if (selectedSpaceIds.length === 0) return null;

  return (
    <div
      className="pointer-events-auto fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-xl border bg-popover px-3 py-2 text-sm ring-1 ring-foreground/10 shadow-lg"
      style={{ transition: 'transform 200ms var(--ease-spring)' }}
    >
      <Layers className="size-4 text-muted-foreground" />
      <span className="font-medium">{selectedSpaceIds.length}</span>
      <span className="text-muted-foreground">rooms selected</span>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="sm" disabled onClick={onBookAll}>
              Book all as multi-room
            </Button>
          }
        />
        <TooltipContent>Multi-room atomic create ships in Phase G.</TooltipContent>
      </Tooltip>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClear}
        aria-label="Clear selection"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
