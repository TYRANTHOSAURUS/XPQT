import { LocationTeamsEditor } from '@/components/admin/routing-studio/location-teams-editor';
import { LegacyRoutingPageBanner } from '@/components/admin/routing-studio/legacy-page-banner';

export function LocationTeamsPage() {
  return (
    <div>
      <LegacyRoutingPageBanner tab="mappings" />
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Location Teams</h1>
        <p className="text-muted-foreground mt-1">
          Map a space (or space group) + domain to the team or vendor that handles it.
        </p>
      </div>
      <LocationTeamsEditor />
    </div>
  );
}
