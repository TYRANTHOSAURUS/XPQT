import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { features } from '@/lib/features';

/**
 * Shown at the top of the legacy routing admin pages when the Routing Studio
 * flag is on. Points users at the unified surface without hard-redirecting —
 * the legacy pages still own the full CRUD editors until their Studio
 * counterparts land.
 */
export function LegacyRoutingPageBanner({ tab }: { tab: 'simulator' | 'audit' | 'coverage' }) {
  if (!features.routingStudio) return null;
  return (
    <div className="mb-4 flex items-center gap-3 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm">
      <Compass className="size-4 text-muted-foreground" />
      <span className="text-muted-foreground">
        This page is being unified under the new Routing Studio.
      </span>
      <Link
        to={`/admin/routing-studio?tab=${tab}`}
        className="ml-auto font-medium text-primary hover:underline"
      >
        Open Routing Studio →
      </Link>
    </div>
  );
}
