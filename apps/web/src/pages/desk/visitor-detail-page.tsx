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
 *
 * The Assign-pass dialog is mounted directly here (not just on the split
 * view) so power users coming from the command palette can assign a pass
 * without round-tripping through the list page.
 */
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { VisitorDetail } from '@/components/desk/visitor-detail';
import { AssignPassDialog } from '@/components/desk/visitor-assign-pass-dialog';
import { useVisitorDetail } from '@/api/visitors';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';

// Filter params we round-trip when navigating back to /desk/visitors.
// Source of truth lives in `use-visitor-filters.ts` — keep this in sync
// when filters are added or renamed there. Read by buildBackTo.
const FILTER_PARAM_KEYS = [
  'view',
  'q',
  'status',
  'date',
  'building',
  'type',
  'host',
] as const;

// Internal hint we set when a palette / link wants to remember which
// view the user came from. Maps onto `?view=` on the way back so the
// list lands on the same preset.
const FROM_VIEW_KEY = 'from';

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

  // Preserve the FULL list URL state. Coming in from the palette only
  // gives us `?from=<view>` (the canonical entry hint); coming in from
  // the embedded "Open in full page" link round-trips every active
  // filter param so the back button restores the same filtered view.
  // No useMemo here — it's a cheap string concat and the closure for
  // onClose rebuilds either way.
  const backTo = buildBackTo(search);

  const [assignPassOpen, setAssignPassOpen] = useState(false);

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

  const visitorLabel =
    [visitor.first_name, visitor.last_name].filter(Boolean).join(' ').trim() ||
    'this visitor';

  return (
    <div className="h-full">
      <VisitorDetail
        visitorId={id}
        buildingId={buildingId}
        onClose={() => navigate(backTo)}
        // Mount the dialog inline so reception can assign a pass without
        // round-tripping through /desk/visitors?id=<id>. The dialog
        // itself short-circuits when buildingId is null (renders an
        // empty-passes state), so we don't need a separate guard here.
        onAssignPass={() => setAssignPassOpen(true)}
      />
      <AssignPassDialog
        open={assignPassOpen}
        onOpenChange={setAssignPassOpen}
        buildingId={buildingId}
        visitorId={id}
        visitorLabel={visitorLabel}
      />
    </div>
  );
}

/**
 * Construct the back-to-list URL from the current search params, preserving
 * every filter the user came in with. Two paths feed in:
 *
 *  - Palette / external link with `?from=<view>` — only the view is known;
 *    we map it to `?view=<view>` so the preset re-applies.
 *  - In-app "Open in full page" — the full filter set (`q`, `status`,
 *    `date`, `building`, `type`, `host`) is already on the URL; we copy
 *    each known key to the back URL.
 *
 * Unknown query params (e.g. `id=`) are dropped. The function is a pure
 * string-builder so no memo is needed at the call site.
 */
function buildBackTo(search: URLSearchParams): string {
  const next = new URLSearchParams();

  // `from` hint maps to a `view` param on the way back.
  const fromView = search.get(FROM_VIEW_KEY);
  if (fromView) next.set('view', fromView);

  // Copy every known filter key. If both `from` and `view` are present,
  // `view` wins (it's explicit URL state, not a one-shot hint).
  for (const key of FILTER_PARAM_KEYS) {
    const value = search.get(key);
    if (value !== null && value !== '') {
      next.set(key, value);
    }
  }

  const qs = next.toString();
  return qs ? `/desk/visitors?${qs}` : '/desk/visitors';
}
