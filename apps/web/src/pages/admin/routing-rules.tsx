import { RoutingRulesEditor } from '@/components/admin/routing-studio/routing-rules-editor';
import { LegacyRoutingPageBanner } from '@/components/admin/routing-studio/legacy-page-banner';

export function RoutingRulesPage() {
  return (
    <div>
      <LegacyRoutingPageBanner tab="simulator" />
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Routing Rules</h1>
        <p className="text-muted-foreground mt-1">Define how tickets are automatically assigned to teams</p>
      </div>
      <RoutingRulesEditor />
    </div>
  );
}
