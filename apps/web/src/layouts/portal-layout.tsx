import { Outlet } from 'react-router-dom';
import { PortalProvider, usePortal } from '@/providers/portal-provider';
import { PortalTopBar } from '@/components/portal/portal-top-bar';
import { PortalBottomTabs } from '@/components/portal/portal-bottom-tabs';
import { PortalNoScopeBlocker } from '@/components/portal/portal-no-scope-blocker';

export function PortalLayout() {
  return (
    <PortalProvider>
      <PortalLayoutInner />
    </PortalProvider>
  );
}

function PortalLayoutInner() {
  const { data: portal, loading } = usePortal();

  return (
    <div className="min-h-screen bg-background">
      <PortalTopBar />
      <main>
        {!loading && portal && !portal.can_submit ? <PortalNoScopeBlocker /> : <Outlet />}
      </main>
      <PortalBottomTabs />
    </div>
  );
}
