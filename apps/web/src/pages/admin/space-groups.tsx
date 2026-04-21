import { SpaceGroupsEditor } from '@/components/admin/routing-studio/space-groups-editor';
import { LegacyRoutingPageBanner } from '@/components/admin/routing-studio/legacy-page-banner';

export function SpaceGroupsPage() {
  return (
    <div>
      <LegacyRoutingPageBanner tab="coverage" />
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Space Groups</h1>
        <p className="text-muted-foreground mt-1">
          Group spaces with no common ancestor under one routing target (e.g. Buildings A, C, F share one FM team).
        </p>
      </div>
      <SpaceGroupsEditor />
    </div>
  );
}
