/**
 * /desk/visitors/:id — full-route mirror of the split-view visitor detail
 * panel. Mirrors `ticket-detail-page.tsx`: a thin wrapper that mounts the
 * shared `<VisitorDetail>` component with navigation wired to "back to
 * the list view".
 *
 * The same component renders in the split view on /desk/visitors and on
 * the dedicated route here, so any property-row improvement to the panel
 * shows up in both surfaces.
 */
import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { VisitorDetail } from '@/components/desk/visitor-detail';
import { useVisitorDetail } from '@/api/visitors';

export function DeskVisitorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [search] = useSearchParams();

  // Mark-arrived / mark-left mutations need the building scope. On the
  // split-view page we already know the building from the toolbar; on the
  // standalone route we resolve it from the visitor record itself so the
  // actions stay live without forcing the user to pick a building first.
  const { data: visitor } = useVisitorDetail(id ?? null);
  const buildingId = visitor?.building_id ?? null;

  const backTo = useMemo(() => {
    // Preserve any list filters the user came from (?view, ?status, …) so
    // closing the full-route page returns them to the same view they
    // expanded out of.
    const view = search.get('from');
    return view ? `/desk/visitors?view=${encodeURIComponent(view)}` : '/desk/visitors';
  }, [search]);

  if (!id) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Visitor not found.
      </div>
    );
  }

  return (
    <div className="h-full">
      <VisitorDetail
        visitorId={id}
        buildingId={buildingId}
        onClose={() => navigate(backTo)}
        onAssignPass={() => {
          // Standalone route doesn't host the AssignPassDialog (which
          // lives on the list page). Send the user to the list view's
          // detail-with-pass-dialog instead — they can re-assign there.
          navigate(`/desk/visitors?id=${id}`);
        }}
      />
    </div>
  );
}
