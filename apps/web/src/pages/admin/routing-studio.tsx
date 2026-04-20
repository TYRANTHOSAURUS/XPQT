import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RoutingSimulator } from '@/components/admin/routing-studio/simulator';
import { RoutingAuditTab } from '@/components/admin/routing-studio/audit-tab';
import { CoverageMatrix } from '@/components/admin/routing-studio/coverage-matrix';

type TabId = 'simulator' | 'audit' | 'coverage';

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
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="coverage">Coverage</TabsTrigger>
        </TabsList>

        <TabsContent value="simulator">
          <RoutingSimulator />
        </TabsContent>

        <TabsContent value="audit">
          <RoutingAuditTab />
        </TabsContent>

        <TabsContent value="coverage">
          <CoverageMatrix />
        </TabsContent>
      </Tabs>
    </div>
  );
}
