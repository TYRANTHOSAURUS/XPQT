import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RoutingSimulator } from '@/components/admin/routing-studio/simulator';
import { RoutingAuditTab } from '@/components/admin/routing-studio/audit-tab';
import { CoverageMatrix } from '@/components/admin/routing-studio/coverage-matrix';
import { DomainFallbacksEditor } from '@/components/admin/routing-studio/domain-fallbacks-editor';
import { SpaceGroupsEditor } from '@/components/admin/routing-studio/space-groups-editor';
import { RoutingRulesEditor } from '@/components/admin/routing-studio/routing-rules-editor';
import { LocationTeamsEditor } from '@/components/admin/routing-studio/location-teams-editor';
import { RoutingStudioOverview } from '@/components/admin/routing-studio/overview-tab';
import { ResolverPipelineStrip } from '@/components/admin/routing-studio/resolver-pipeline-strip';
import { CaseOwnershipEditor } from '@/components/admin/routing-studio/case-ownership-editor';
import { ChildDispatchEditor } from '@/components/admin/routing-studio/child-dispatch-editor';
import { VisibilityTab } from '@/components/admin/routing-studio/visibility-tab';
import { DomainsEditor } from '@/components/admin/routing-studio/domains-editor';

type TabId = 'overview' | 'simulator' | 'case-ownership' | 'child-dispatch' | 'visibility' | 'rules' | 'audit' | 'coverage' | 'mappings' | 'groups' | 'fallbacks' | 'domains';

const VALID_TABS: readonly TabId[] = [
  'overview', 'simulator', 'case-ownership', 'child-dispatch', 'visibility', 'rules', 'audit', 'coverage', 'mappings', 'groups', 'fallbacks', 'domains',
] as const;

function coerceTab(value: string | null): TabId {
  return (VALID_TABS as readonly string[]).includes(value ?? '')
    ? (value as TabId)
    : 'overview';
}

export function RoutingStudioPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = coerceTab(searchParams.get('tab'));
  const [tab, setTabState] = useState<TabId>(urlTab);

  useEffect(() => {
    if (urlTab !== tab) setTabState(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  const setTab = (next: TabId) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="flex flex-col gap-5 py-4">
      <div>
        <h1 className="text-2xl font-semibold">Routing Studio</h1>
        <p className="text-sm text-muted-foreground">
          One surface for how tickets get assigned. The resolver runs the steps below in order — first match wins.
        </p>
      </div>

      <ResolverPipelineStrip onTabClick={(t) => setTab(t)} />

      <Tabs value={tab} onValueChange={(v) => setTab(coerceTab(v))}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="simulator">Simulator</TabsTrigger>
          <TabsTrigger value="case-ownership">Case Ownership</TabsTrigger>
          <TabsTrigger value="child-dispatch">Child Dispatch</TabsTrigger>
          <TabsTrigger value="visibility">Visibility</TabsTrigger>
          <TabsTrigger value="rules">Advanced Overrides</TabsTrigger>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
          <TabsTrigger value="mappings">Mappings</TabsTrigger>
          <TabsTrigger value="groups">Groups</TabsTrigger>
          <TabsTrigger value="fallbacks">Fallbacks</TabsTrigger>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <RoutingStudioOverview onOpenTab={(t) => setTab(coerceTab(t))} />
        </TabsContent>

        <TabsContent value="simulator">
          <RoutingSimulator />
        </TabsContent>

        <TabsContent value="case-ownership">
          <CaseOwnershipEditor />
        </TabsContent>

        <TabsContent value="child-dispatch">
          <ChildDispatchEditor />
        </TabsContent>

        <TabsContent value="visibility">
          <VisibilityTab />
        </TabsContent>

        <TabsContent value="rules">
          <RoutingRulesEditor compact />
        </TabsContent>

        <TabsContent value="coverage">
          <CoverageMatrix />
        </TabsContent>

        <TabsContent value="mappings">
          <LocationTeamsEditor compact />
        </TabsContent>

        <TabsContent value="groups">
          <SpaceGroupsEditor compact />
        </TabsContent>

        <TabsContent value="fallbacks">
          <DomainFallbacksEditor compact />
        </TabsContent>

        <TabsContent value="domains">
          <DomainsEditor />
        </TabsContent>

        <TabsContent value="audit">
          <RoutingAuditTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
