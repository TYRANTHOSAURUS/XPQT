import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toastError } from '@/lib/toast';
import { useUpdateSpace, type Space } from '@/api/spaces';

interface Props { space: Space }

export function SpaceMetadataStrip({ space }: Props) {
  const update = useUpdateSpace(space.id);
  const [capacityDraft, setCapacityDraft] = useState<string>(space.capacity?.toString() ?? '');
  const [capacityError, setCapacityError] = useState<string | null>(null);

  const saveCapacity = async () => {
    const next = capacityDraft ? Number.parseInt(capacityDraft, 10) : null;
    if (capacityDraft && Number.isNaN(next)) {
      setCapacityError('Must be a number');
      return;
    }
    setCapacityError(null);
    if (next === space.capacity) return;
    try {
      await update.mutateAsync({ capacity: next });
    } catch (err) {
      toastError("Couldn't save capacity", { error: err });
      setCapacityDraft(space.capacity?.toString() ?? '');
    }
  };

  const toggleReservable = async (v: boolean) => {
    try {
      await update.mutateAsync({ reservable: v });
    } catch (err) {
      toastError("Couldn't update reservable", { error: err, retry: () => toggleReservable(v) });
    }
  };

  return (
    <div className="px-6 py-4 border-b flex items-center gap-6 flex-wrap text-sm">
      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Capacity</span>
        <Input
          type="number"
          value={capacityDraft}
          onChange={(e) => setCapacityDraft(e.target.value)}
          onBlur={saveCapacity}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="h-7 w-20"
        />
        {capacityError && <span className="text-xs text-destructive">{capacityError}</span>}
      </label>

      <label className="flex items-center gap-2">
        <span className="text-muted-foreground">Reservable</span>
        <Switch
          checked={space.reservable}
          onCheckedChange={toggleReservable}
          disabled={update.isPending}
          aria-label="Reservable"
        />
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-muted-foreground">Amenities</span>
        {(space.amenities ?? []).length === 0 && <span className="text-muted-foreground">—</span>}
        {(space.amenities ?? []).map((a) => (
          <Badge key={a} variant="secondary" className="capitalize">{a.replace(/_/g, ' ')}</Badge>
        ))}
      </div>
    </div>
  );
}
