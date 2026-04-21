import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RoutingSimulator } from '@/components/admin/routing-studio/simulator';
import { RoutingAuditTab } from '@/components/admin/routing-studio/audit-tab';
import { ResolverPipelineStrip } from '@/components/admin/routing-studio/resolver-pipeline-strip';
import { CaseOwnershipEditor } from '@/components/admin/routing-studio/case-ownership-editor';
import { VisibilityTab } from '@/components/admin/routing-studio/visibility-tab';
import { RoutingMap } from '@/components/admin/routing-studio/routing-map';
import { ChildDispatchTab } from '@/components/admin/routing-studio/child-dispatch-tab';
import { AdvancedOverridesTab } from '@/components/admin/routing-studio/advanced-overrides-tab';

/**
 * Routing Studio — seven top-level tabs matching Artifact C's target IA:
 *
 *   Routing Map · Case Ownership · Child Dispatch · Visibility ·
 *   Simulator · Advanced Overrides · Audit
 *
 * Removed from the v0 layout: Overview (empty state now lives in Routing
 * Map), Coverage (legacy matrix; merged into Child Dispatch sub-panel),
 * Mappings + Groups (ditto), Domains + Fallbacks (merged into Advanced
 * Overrides sub-panels). Old `?tab=` URLs redirect to the new tab they
 * live inside so bookmarks keep working.
 */

type TabId =
  | 'routing-map'
  | 'case-ownership'
  | 'child-dispatch'
  | 'visibility'
  | 'simulator'
  | 'rules'
  | 'audit';

const VALID_TABS: readonly TabId[] = [
  'routing-map',
  'case-ownership',
  'child-dispatch',
  'visibility',
  'simulator',
  'rules',
  'audit',
] as const;

// Old URLs land on the new tab that absorbs them.
const TAB_ALIASES: Record<string, TabId> = {
  overview: 'routing-map',
  coverage: 'child-dispatch',
  mappings: 'child-dispatch',
  groups: 'child-dispatch',
  fallbacks: 'rules',
  domains: 'rules',
};

function coerceTab(value: string | null): TabId {
  if (!value) return 'routing-map';
  if ((VALID_TABS as readonly string[]).includes(value)) return value as TabId;
  if (value in TAB_ALIASES) return TAB_ALIASES[value];
  return 'routing-map';
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

      <ResolverPipelineStrip onTabClick={(t) => setTab(coerceTab(t))} />

      <Tabs value={tab} onValueChange={(v) => setTab(coerceTab(v))}>
        <TabsList>
          <TabsTrigger value="routing-map">Routing Map</TabsTrigger>
          <TabsTrigger value="case-ownership">Case Ownership</TabsTrigger>
          <TabsTrigger value="child-dispatch">Child Dispatch</TabsTrigger>
          <TabsTrigger value="visibility">Visibility</TabsTrigger>
          <TabsTrigger value="simulator">Simulator</TabsTrigger>
          <TabsTrigger value="rules">Advanced Overrides</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="routing-map">
          <RoutingMap onOpenTab={(t) => setTab(coerceTab(t))} />
        </TabsContent>

        <TabsContent value="case-ownership">
          <CaseOwnershipEditor />
        </TabsContent>

        <TabsContent value="child-dispatch">
          <ChildDispatchTab />
        </TabsContent>

        <TabsContent value="visibility">
          <VisibilityTab />
        </TabsContent>

        <TabsContent value="simulator">
          <RoutingSimulator />
        </TabsContent>

        <TabsContent value="rules">
          <AdvancedOverridesTab />
        </TabsContent>

        <TabsContent value="audit">
          <RoutingAuditTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
