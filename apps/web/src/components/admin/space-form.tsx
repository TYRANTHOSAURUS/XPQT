import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet, FieldSeparator } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { toastCreated, toastError, toastUpdated } from '@/lib/toast';
import type { SpaceType } from '@prequest/shared';
import { useCreateSpace, useUpdateSpace, type Space } from '@/api/spaces';
import { SpaceTypePicker } from './space-type-picker';
import { SpaceParentPicker } from './space-parent-picker';
import { SPACE_TYPE_LABELS } from './space-type-icon';

const amenityOptions = [
  { value: 'projector', label: 'Projector' },
  { value: 'whiteboard', label: 'Whiteboard' },
  { value: 'video_conferencing', label: 'Video Conferencing' },
  { value: 'standing_desk', label: 'Standing Desk' },
  { value: 'dual_monitor', label: 'Dual Monitor' },
  { value: 'wheelchair_accessible', label: 'Wheelchair Accessible' },
];

type Mode =
  | { kind: 'create'; parentType: SpaceType | null; parentId: string | null }
  | { kind: 'edit'; space: Space };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
}

export function SpaceFormDialog({ open, onOpenChange, mode }: Props) {
  const [type, setType] = useState<SpaceType | ''>('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [capacity, setCapacity] = useState('');
  const [reservable, setReservable] = useState(false);
  const [amenities, setAmenities] = useState<string[]>([]);

  const createMut = useCreateSpace();
  const updateMut = useUpdateSpace(mode.kind === 'edit' ? mode.space.id : '');

  useEffect(() => {
    if (!open) return;
    if (mode.kind === 'create') {
      setType('');
      setParentId(mode.parentId);
      setName('');
      setCode('');
      setCapacity('');
      setReservable(false);
      setAmenities([]);
    } else {
      setType(mode.space.type);
      setParentId(mode.space.parent_id);
      setName(mode.space.name);
      setCode(mode.space.code ?? '');
      setCapacity(mode.space.capacity?.toString() ?? '');
      setReservable(mode.space.reservable);
      setAmenities(mode.space.amenities ?? []);
    }
  }, [mode, open]);

  const toggleAmenity = (value: string) =>
    setAmenities((prev) =>
      prev.includes(value) ? prev.filter((a) => a !== value) : [...prev, value],
    );

  const handleSave = async () => {
    if (!name.trim() || !type) return;
    try {
      if (mode.kind === 'create') {
        await createMut.mutateAsync({
          parent_id: parentId,
          type,
          name: name.trim(),
          code: code.trim() || undefined,
          capacity: capacity ? parseInt(capacity, 10) : undefined,
          reservable,
          amenities: amenities.length > 0 ? amenities : undefined,
        });
        toastCreated('Space');
      } else {
        await updateMut.mutateAsync({
          name: name.trim(),
          code: code.trim() || undefined,
          capacity: capacity ? parseInt(capacity, 10) : null,
          reservable,
          amenities,
        });
        toastUpdated('Space');
      }
      onOpenChange(false);
    } catch (err) {
      toastError("Couldn't save space", { error: err, retry: handleSave });
    }
  };

  const isEdit = mode.kind === 'edit';
  const parentTypeForTypePicker: SpaceType | null =
    mode.kind === 'create' ? mode.parentType : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit space' : 'New space'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? `Editing ${SPACE_TYPE_LABELS[(mode as { kind: 'edit'; space: Space }).space.type]} — use "Move" to change the parent.`
              : 'Sites, buildings, wings, floors, rooms, desks and more.'}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          {!isEdit && (
            <Field>
              <FieldLabel htmlFor="space-type">Type</FieldLabel>
              <SpaceTypePicker
                id="space-type"
                parentType={parentTypeForTypePicker}
                value={type}
                onChange={setType}
              />
            </Field>
          )}

          {!isEdit && (
            <Field>
              <FieldLabel>Parent</FieldLabel>
              <SpaceParentPicker
                childType={(type || 'site') as SpaceType}
                value={parentId}
                onChange={setParentId}
              />
            </Field>
          )}

          <FieldSeparator />

          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="space-name">Name</FieldLabel>
              <Input
                id="space-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Room 302"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="space-code">Code</FieldLabel>
              <Input
                id="space-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. AMS-A-302"
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4 items-end">
            <Field>
              <FieldLabel htmlFor="space-capacity">Capacity</FieldLabel>
              <Input
                id="space-capacity"
                type="number"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                placeholder="0"
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="space-reservable"
                checked={reservable}
                onCheckedChange={(c) => setReservable(c === true)}
              />
              <FieldLabel htmlFor="space-reservable" className="font-normal">
                Reservable
              </FieldLabel>
            </Field>
          </div>

          <FieldSet>
            <FieldLegend variant="label">Amenities</FieldLegend>
            <FieldGroup data-slot="checkbox-group" className="grid grid-cols-2 gap-2">
              {amenityOptions.map((opt) => (
                <Field key={opt.value} orientation="horizontal">
                  <Checkbox
                    id={`space-amenity-${opt.value}`}
                    checked={amenities.includes(opt.value)}
                    onCheckedChange={() => toggleAmenity(opt.value)}
                  />
                  <FieldLabel
                    htmlFor={`space-amenity-${opt.value}`}
                    className="font-normal"
                  >
                    {opt.label}
                  </FieldLabel>
                </Field>
              ))}
            </FieldGroup>
          </FieldSet>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!name.trim() || !type || createMut.isPending || updateMut.isPending}
          >
            {isEdit ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
