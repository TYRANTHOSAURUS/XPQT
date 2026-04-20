import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RoutingSimulator } from '@/components/admin/routing-studio/simulator';
import { RoutingAuditTab } from '@/components/admin/routing-studio/audit-tab';
import { CoverageMatrix } from '@/components/admin/routing-studio/coverage-matrix';
import { DomainFallbacksEditor } from '@/components/admin/routing-studio/domain-fallbacks-editor';
import { SpaceGroupsEditor } from '@/components/admin/routing-studio/space-groups-editor';
import { RoutingRulesEditor } from '@/components/admin/routing-studio/routing-rules-editor';

type TabId = 'simulator' | 'rules' | 'audit' | 'coverage' | 'groups' | 'fallbacks';

export function RoutingStudioPage() {
  const [tab, setTab] = useState<TabId>('simulator');

  return (
    <div className="flex flex-col gap-6 py-4">
      <div>
        <h1 className="text-2xl font-semibold">Routing Studio</h1>
        <p className="text-sm text-muted-foreground">
          Explore how routing rules, locations, assets, and fallbacks compose to assign tickets.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab((v ?? 'simulator') as TabId)}>
        <TabsList>
          <TabsTrigger value="simulator">Simulator</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
          <TabsTrigger value="groups">Groups</TabsTrigger>
          <TabsTrigger value="fallbacks">Fallbacks</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="simulator">
          <RoutingSimulator />
        </TabsContent>

        <TabsContent value="rules">
          <RoutingRulesEditor compact />
        </TabsContent>

        <TabsContent value="audit">
          <RoutingAuditTab />
        </TabsContent>

        <TabsContent value="coverage">
          <CoverageMatrix />
        </TabsContent>

        <TabsContent value="groups">
          <SpaceGroupsEditor compact />
        </TabsContent>

        <TabsContent value="fallbacks">
          <DomainFallbacksEditor compact />
        </TabsContent>
      </Tabs>
    </div>
  );
}
