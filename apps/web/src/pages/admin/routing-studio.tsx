import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { RoutingSimulator } from '@/components/admin/routing-studio/simulator';
import { RoutingAuditTab } from '@/components/admin/routing-studio/audit-tab';
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

  const setTab = (next: TabId, extraParams?: Record<string, string>) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    // Clear any rt=… param when switching manually; deep-links set it
    // via extraParams. Without this, a stale rt sticks across tab clicks.
    params.delete('rt');
    if (extraParams) {
      for (const [key, value] of Object.entries(extraParams)) {
        if (value) params.set(key, value);
      }
    }
    setSearchParams(params, { replace: true });
  };

  const openTabWithRt = (next: TabId, rtId: string) => setTab(next, { rt: rtId });
  const initialRtId = searchParams.get('rt') ?? null;

  return (
    <SettingsPageShell width="full">
      <SettingsPageHeader
        title="Routing Studio"
        description="One surface for how tickets get assigned. The resolver runs the steps below in order — first match wins."
      />

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
          <RoutingMap
            onOpenTab={(t) => setTab(coerceTab(t))}
            onOpenForRequestType={openTabWithRt}
          />
        </TabsContent>

        <TabsContent value="case-ownership">
          <CaseOwnershipEditor initialRequestTypeId={tab === 'case-ownership' ? initialRtId : null} />
        </TabsContent>

        <TabsContent value="child-dispatch">
          <ChildDispatchTab initialRequestTypeId={tab === 'child-dispatch' ? initialRtId : null} />
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
    </SettingsPageShell>
  );
}
