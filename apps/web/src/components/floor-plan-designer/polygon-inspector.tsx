import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SettingsRow, SettingsRowValue } from '@/components/ui/settings-row';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { polygonArea } from '@/components/floor-plan/lib/polygon-geometry';
import { apiFetch } from '@/lib/api';
import { withErrorHandling } from '@/lib/errors';
import type { DesignerState } from './types';
import type { RenderHint } from '@/api/floor-plans/types';
import type { Space } from '@/api/spaces';

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

  const createDeskMutation = useMutation<Space, Error, void>({
    mutationFn: async () => {
      // Determine next desk sequence number based on existing desks on this floor
      const deskCount = floorChildren.filter((s) => s.type === 'desk').length;
      return apiFetch<Space>('/spaces', {
        method: 'POST',
        body: JSON.stringify({
          type: 'desk',
          parent_id: floorSpaceId,
          name: `Desk ${deskCount + 1}`,
        }),
      });
    },
    onSuccess: (newSpace) => {
      qc.invalidateQueries({ queryKey: ['spaces', floorSpaceId, 'children'] });
      dispatch({ type: 'update-polygon', index: idx!, patch: { space_id: newSpace.id } });
    },
    ...withErrorHandling({ actionTitle: "Couldn't create desk" }),
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
  const isUnlinked = !polygon.space_id;
  // Show create-desk button if unlinked and no unlinked desk exists on this floor
  const unlinkedDesks = availableSpaces.filter((s) => s.type === 'desk');
  const showCreateDesk = isUnlinked && unlinkedDesks.length === 0;

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

          {/* B.9.b: Inline create-desk affordance */}
          {showCreateDesk && (
            <Button
              variant="outline"
              size="sm"
              className="mt-1.5 w-full text-xs"
              disabled={createDeskMutation.isPending}
              onClick={() => createDeskMutation.mutate()}
            >
              {createDeskMutation.isPending ? 'Creating…' : 'Create new desk and link'}
            </Button>
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
