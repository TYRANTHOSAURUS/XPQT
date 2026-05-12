import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SettingsRow, SettingsRowValue } from '@/components/ui/settings-row';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { polygonArea } from '@/components/floor-plan/lib/polygon-geometry';
import { apiFetch } from '@/lib/api';
import { withErrorHandling } from '@/lib/errors';
import type { DesignerState } from './types';
import type { RenderHint } from '@/api/floor-plans/types';
import type { Space } from '@/api/spaces';

type SpaceType = 'room' | 'meeting_room' | 'desk' | 'parking_space' | 'common_area' | 'storage_room' | 'technical_room';

const SPACE_TYPE_LABELS: Record<SpaceType, string> = {
  room: 'Room',
  meeting_room: 'Meeting room',
  desk: 'Desk',
  parking_space: 'Parking space',
  common_area: 'Common area',
  storage_room: 'Storage',
  technical_room: 'Technical room',
};

type Props = { floorSpaceId: string; state: DesignerState; dispatch: React.Dispatch<any> };

/** Fetch direct children of the floor space (rooms, desks, etc.) */
function useFloorChildren(floorSpaceId: string) {
  return useQuery({
    queryKey: ['spaces', floorSpaceId, 'children'],
    queryFn: ({ signal }) => apiFetch<Space[]>(`/spaces/${floorSpaceId}/children`, { signal }),
    staleTime: 30_000,
  });
}

export function PolygonInspector({ floorSpaceId, state, dispatch }: Props) {
  const idx = state.selectedPolygonIndex;
  const polygon = idx === null ? null : (state.polygons[idx] ?? null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  // Default the create-type by polygon size: small polygon (probably a stamped seat) → desk,
  // medium-to-large → meeting_room. The user can change it.
  const [createType, setCreateType] = useState<SpaceType>('meeting_room');
  const qc = useQueryClient();

  const { data: floorChildren = [] } = useFloorChildren(floorSpaceId);

  // Space IDs already linked to other polygons (exclude current polygon)
  const linkedSpaceIds = new Set(
    state.polygons
      .filter((_, i) => i !== idx)
      .map((p) => p.space_id)
      .filter(Boolean),
  );

  // Unlinked children available for selection
  const availableSpaces = floorChildren.filter((s) => !linkedSpaceIds.has(s.id));

  const createSpaceMutation = useMutation<Space, Error, { name: string; type: SpaceType }>({
    mutationFn: async (input) => {
      return apiFetch<Space>('/spaces', {
        method: 'POST',
        body: JSON.stringify({
          type: input.type,
          parent_id: floorSpaceId,
          name: input.name.trim(),
        }),
      });
    },
    onSuccess: (newSpace) => {
      qc.invalidateQueries({ queryKey: ['spaces', floorSpaceId, 'children'] });
      dispatch({ type: 'update-polygon', index: idx!, patch: { space_id: newSpace.id } });
      setCreateOpen(false);
      setCreateName('');
    },
    ...withErrorHandling({ actionTitle: "Couldn't create space" }),
  });

  if (polygon === null) {
    return (
      <div className="border-l border-border bg-background p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Selection</div>
        <p className="mt-3 text-sm text-muted-foreground">Click a polygon to edit its properties.</p>
      </div>
    );
  }

  const hint: RenderHint = polygon.render_hint ?? 'default';

  return (
    <div className="border-l border-border bg-background overflow-y-auto">
      <div className="p-4 pb-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">Selected polygon</div>
      </div>

      <FieldGroup className="p-4 pt-2">
        {/* B.9: Space picker */}
        <Field>
          <FieldLabel htmlFor="linked-space">Linked space</FieldLabel>
          <Select
            value={polygon.space_id || '__none__'}
            onValueChange={(val) => {
              const nextId = val === '__none__' ? '' : val;
              dispatch({ type: 'update-polygon', index: idx!, patch: { space_id: nextId } });
            }}
          >
            <SelectTrigger id="linked-space">
              <SelectValue placeholder="Not linked" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">
                <span className="text-muted-foreground">Not linked</span>
              </SelectItem>
              {availableSpaces.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
              {/* Include current linked space even if it's not in available (it's already linked here) */}
              {polygon.space_id &&
                !availableSpaces.find((s) => s.id === polygon.space_id) && (() => {
                  const current = floorChildren.find((s) => s.id === polygon.space_id);
                  return current ? (
                    <SelectItem key={current.id} value={current.id}>
                      {current.name}
                    </SelectItem>
                  ) : null;
                })()}
            </SelectContent>
          </Select>

          {/* Inline create-space affordance — always available so the admin can
              author a floor end-to-end without bouncing to /admin/locations.
              Persona: Facilities Admin's "clone, don't bounce" JTBD. */}
          {!createOpen ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-1.5 w-full text-xs"
              onClick={() => {
                setCreateOpen(true);
                // Suggest the polygon's likely type from its render hint
                if (polygon.render_hint === 'seat') setCreateType('desk');
                else if (polygon.render_hint === 'parking') setCreateType('parking_space');
                else setCreateType('meeting_room');
              }}
            >
              + Create new space here
            </Button>
          ) : (
            <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/30 p-2">
              <Field>
                <FieldLabel htmlFor="new-space-name">Name</FieldLabel>
                <Input
                  id="new-space-name"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="e.g. Aurora"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && createName.trim()) {
                      createSpaceMutation.mutate({ name: createName, type: createType });
                    } else if (e.key === 'Escape') {
                      setCreateOpen(false);
                      setCreateName('');
                    }
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-space-type">Type</FieldLabel>
                <Select value={createType} onValueChange={(v) => setCreateType(v as SpaceType)}>
                  <SelectTrigger id="new-space-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(SPACE_TYPE_LABELS).map(([v, label]) => (
                      <SelectItem key={v} value={v}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={!createName.trim() || createSpaceMutation.isPending}
                  onClick={() => createSpaceMutation.mutate({ name: createName, type: createType })}
                >
                  {createSpaceMutation.isPending ? 'Creating…' : 'Create + link'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setCreateOpen(false); setCreateName(''); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="render-hint">Render as</FieldLabel>
          <ToggleGroup
            id="render-hint"
            multiple={false}
            value={[hint]}
            onValueChange={(v: string[]) => {
              if (v[0]) {
                dispatch({
                  type: 'update-polygon',
                  index: idx!,
                  patch: { render_hint: v[0] as RenderHint },
                });
              }
            }}
            variant="outline"
          >
            <ToggleGroupItem value="default">Default</ToggleGroupItem>
            <ToggleGroupItem value="seat">Seat</ToggleGroupItem>
            <ToggleGroupItem value="parking">Parking</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      </FieldGroup>

      <div className="border-t border-border" />

      <SettingsRow label="Vertices">
        <SettingsRowValue>
          <span className="tabular-nums">{polygon.points.length}</span>
        </SettingsRowValue>
      </SettingsRow>
      <SettingsRow label="Area">
        <SettingsRowValue>
          <span className="tabular-nums">{polygonArea(polygon.points).toFixed(0)} px²</span>
        </SettingsRowValue>
      </SettingsRow>

      <div className="border-t border-border" />

      <div className="p-4">
        <Button variant="ghost" className="text-destructive" onClick={() => setConfirmOpen(true)}>
          Detach from floor plan
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">Polygon only — space record stays.</p>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Detach polygon?"
        description="The polygon will be removed from this floor plan. The space record stays."
        confirmLabel="Detach"
        destructive
        onConfirm={() => dispatch({ type: 'remove-polygon', index: idx! })}
      />
    </div>
  );
}
