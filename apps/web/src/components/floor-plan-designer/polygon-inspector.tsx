import { useState } from 'react';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SettingsRow, SettingsRowValue } from '@/components/ui/settings-row';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { polygonArea } from '@/components/floor-plan/lib/polygon-geometry';
import type { DesignerState } from './types';
import type { RenderHint } from '@/api/floor-plans/types';

type Props = { floorSpaceId: string; state: DesignerState; dispatch: React.Dispatch<any> };

export function PolygonInspector({ state, dispatch }: Props) {
  const idx = state.selectedPolygonIndex;
  const polygon = idx === null ? null : (state.polygons[idx] ?? null);
  const [confirmOpen, setConfirmOpen] = useState(false);

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
