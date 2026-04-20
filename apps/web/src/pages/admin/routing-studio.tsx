import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RoutingSimulator } from '@/components/admin/routing-studio/simulator';
import { RoutingAuditTab } from '@/components/admin/routing-studio/audit-tab';

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
          <TabsTrigger value="coverage" disabled>
            Coverage <span className="ml-1 text-xs text-muted-foreground">(soon)</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="simulator">
          <RoutingSimulator />
        </TabsContent>

        <TabsContent value="audit">
          <RoutingAuditTab />
        </TabsContent>

        <TabsContent value="coverage">
          {/* Placeholder until C3 lands */}
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            Coverage matrix ships in the next checkpoint.
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
