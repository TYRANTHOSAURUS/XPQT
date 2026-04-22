import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

interface SpaceSummary {
  id: string;
  name: string;
  type: string;
}

export interface AuthorizedLocation extends SpaceSummary {
  source: 'default' | 'grant';
  grant_id: string | null;
  granted_at: string | null;
  note: string | null;
}

export interface PortalMeResponse {
  person: { id: string; first_name: string; last_name: string; email: string | null };
  user: { id: string; email: string | null };
  default_location: SpaceSummary | null;
  authorized_locations: AuthorizedLocation[];
  current_location: SpaceSummary | null;
  role_scopes: Array<{
    role_name: string;
    domain_scope: string[] | null;
    location_scope: string[] | null;
  }>;
  can_submit: boolean;
}

interface PortalContextValue {
  data: PortalMeResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setCurrentLocation: (spaceId: string) => Promise<void>;
}

const PortalContext = createContext<PortalContextValue | undefined>(undefined);

export function PortalProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [data, setData] = useState<PortalMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const me = await apiFetch<PortalMeResponse>('/portal/me');
      setData(me);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load portal context');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    void refresh();
  }, [authLoading, refresh]);

  const setCurrentLocation = useCallback(
    async (spaceId: string) => {
      const updated = await apiFetch<PortalMeResponse>('/portal/me', {
        method: 'PATCH',
        body: JSON.stringify({ current_location_id: spaceId }),
      });
      setData(updated);
    },
    [],
  );

  const value = useMemo<PortalContextValue>(
    () => ({ data, loading, error, refresh, setCurrentLocation }),
    [data, loading, error, refresh, setCurrentLocation],
  );

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalContextValue {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error('usePortal must be used within a PortalProvider');
  return ctx;
}
