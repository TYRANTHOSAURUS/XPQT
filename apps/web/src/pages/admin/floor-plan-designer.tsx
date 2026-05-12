import { useParams } from 'react-router-dom';
import { FloorPlanDesigner } from '@/components/floor-plan-designer/floor-plan-designer';
import { useSpaceDetail } from '@/api/spaces/queries';

/**
 * Admin page: floor plan designer for a single floor.
 *
 * Shell-exempt per CLAUDE.md — the designer claims the full viewport with its
 * own topbar, tool dock, and inspector panels. Do NOT wrap in SettingsPageShell.
 */
export function FloorPlanDesignerPage() {
  const { floorSpaceId } = useParams<{ floorSpaceId: string }>();

  // Fetch the floor name so the topbar label is meaningful.
  // Falls back to 'Floor' if the request is still loading or returns empty.
  const { data: space } = useSpaceDetail(floorSpaceId);
  const floorName = space?.name ?? 'Floor';

  if (!floorSpaceId) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Invalid floor ID.
      </div>
    );
  }

  return (
    <FloorPlanDesigner
      floorSpaceId={floorSpaceId}
      floorName={floorName}
      backTo="/admin/floor-plans"
    />
  );
}
