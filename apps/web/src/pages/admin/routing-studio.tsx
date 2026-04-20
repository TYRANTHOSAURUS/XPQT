import { RoutingSimulator } from '@/components/admin/routing-studio/simulator';

export function RoutingStudioPage() {
  return (
    <div className="flex flex-col gap-6 py-4">
      <div>
        <h1 className="text-2xl font-semibold">Routing Studio</h1>
        <p className="text-sm text-muted-foreground">
          Explore how routing rules, locations, assets, and fallbacks compose to assign tickets.
        </p>
      </div>

      <RoutingSimulator />
    </div>
  );
}
