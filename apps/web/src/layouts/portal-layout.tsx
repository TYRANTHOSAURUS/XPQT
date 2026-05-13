import { Outlet } from 'react-router-dom';
import { PortalProvider, usePortal } from '@/providers/portal-provider';
import { PortalTopBar } from '@/components/portal/portal-top-bar';
import { PortalBottomTabs } from '@/components/portal/portal-bottom-tabs';
import { PortalFooter } from '@/components/portal/portal-footer';
import { PortalNoScopeBlocker } from '@/components/portal/portal-no-scope-blocker';
import { useAuth } from '@/providers/auth-provider';
import { useInboxSubscription } from '@/lib/realtime/inbox-subscription';

export function PortalLayout() {
  return (
    <PortalProvider>
      <PortalLayoutInner />
    </PortalProvider>
  );
}

function PortalLayoutInner() {
  const { data: portal, loading } = usePortal();
  const { appUser } = useAuth();
  // Inbox Realtime — see desk-layout for the rationale.
  useInboxSubscription({ tenantId: appUser?.tenant_id, userId: appUser?.id });

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <PortalTopBar />
      <main className="flex-1">
        {!loading && portal && !portal.can_submit ? <PortalNoScopeBlocker /> : <Outlet />}
      </main>
      <PortalFooter />
      <PortalBottomTabs />
    </div>
  );
}
