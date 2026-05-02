/**
 * /desk/visitors/:id — full-route mirror of the split-view visitor detail
 * panel. Mirrors `ticket-detail-page.tsx`: a thin wrapper that mounts the
 * shared `<VisitorDetail>` component with navigation wired to "back to
 * the list view".
 *
 * The same component renders in the split view on /desk/visitors and on
 * the dedicated route here, so any property-row improvement to the panel
 * shows up in both surfaces.
 *
 * Loading + not-found are rendered with the explicit `SettingsPageShell`
 * skeleton so the back affordance is always visible — the split-view
 * shell isn't there to give context, and silently mounting an empty
 * `<VisitorDetail>` for a missing/unreachable id was indistinguishable
 * from "still loading" forever.
 */
import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { VisitorDetail } from '@/components/desk/visitor-detail';
import { useVisitorDetail } from '@/api/visitors';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';

export function DeskVisitorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [search] = useSearchParams();

  // Mark-arrived / mark-left mutations need the building scope. On the
  // split-view page we already know the building from the toolbar; on the
  // standalone route we resolve it from the visitor record itself so the
  // actions stay live without forcing the user to pick a building first.
  const { data: visitor, error, isLoading } = useVisitorDetail(id ?? null);
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
      <SettingsPageShell width="default">
        <SettingsPageHeader title="Visitor not found" backTo={backTo} />
        <div className="px-6 py-4 text-sm text-muted-foreground">
          No visitor id was provided in the URL.
        </div>
      </SettingsPageShell>
    );
  }

  if (isLoading) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader title="Visitor" backTo={backTo} />
        <div
          role="status"
          aria-live="polite"
          className="px-6 py-4 text-sm text-muted-foreground"
        >
          Loading visitor…
        </div>
      </SettingsPageShell>
    );
  }

  // Error or missing record — explicit not-found state so reception isn't
  // staring at an empty panel wondering whether it's still loading.
  if (error || !visitor) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader title="Visitor not found" backTo={backTo} />
        <div className="px-6 py-4 text-sm text-muted-foreground">
          This visitor couldn&rsquo;t be loaded. They may have been removed,
          or your access was revoked.
        </div>
      </SettingsPageShell>
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
