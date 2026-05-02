/**
 * Reception "current building" context.
 *
 * Reception staff usually work at a single building. The whole workspace
 * scopes its data on `building_id`, so we lift the selection into a
 * context provider that:
 *
 *   - reads the URL param `?building=<id>` first (so deep-links work),
 *   - falls back to localStorage (`reception:building` — sticky across
 *     sessions),
 *   - falls back to the first building the user has access to.
 *
 * Setting the building writes both back: URL via React Router navigation
 * (so the location bar reflects the choice) AND localStorage (so a fresh
 * tab keeps the same building without forcing the user to re-pick).
 *
 * The context returns `null` for `buildingId` while spaces are loading;
 * pages render a skeleton + helpful empty state until a building is
 * resolved.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSpaces } from '@/api/spaces';
import type { Space } from '@/api/spaces';

const STORAGE_KEY = 'reception:building';

interface ReceptionBuildingContextValue {
  /** Resolved current building id. Null while spaces load or when the
   *  user has no buildings in scope. */
  buildingId: string | null;
  /** All buildings the user can pick from. Empty while loading. */
  buildings: Space[];
  /** Set the active building. Updates URL + localStorage. */
  setBuildingId: (id: string) => void;
  /** True until spaces have loaded once. Pages should show a skeleton. */
  loading: boolean;
}

const ReceptionBuildingContext = createContext<ReceptionBuildingContextValue | null>(
  null,
);

export function ReceptionBuildingProvider({ children }: { children: ReactNode }) {
  const { data: spaces, isLoading } = useSpaces();
  const location = useLocation();
  const navigate = useNavigate();

  const buildings = useMemo<Space[]>(
    () =>
      (spaces ?? [])
        .filter((s) => s.type === 'building' || s.type === 'site')
        .filter((s) => s.active),
    [spaces],
  );

  // Read URL param `building` first.
  const urlBuilding = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('building');
  }, [location.search]);

  // Resolve effective building id with priority: URL → localStorage → first.
  const buildingId = useMemo<string | null>(() => {
    if (urlBuilding && buildings.some((b) => b.id === urlBuilding)) {
      return urlBuilding;
    }
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && buildings.some((b) => b.id === stored)) return stored;
    }
    return buildings[0]?.id ?? null;
  }, [urlBuilding, buildings]);

  // Persist the resolved building so a page reload keeps the same context
  // even if the URL didn't have the param.
  useEffect(() => {
    if (buildingId && typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, buildingId);
    }
  }, [buildingId]);

  const setBuildingId = useCallback(
    (id: string) => {
      // Update URL by replacing (not pushing) so back-button doesn't get
      // polluted with a stack of building swaps.
      const params = new URLSearchParams(location.search);
      params.set('building', id);
      navigate(`${location.pathname}?${params.toString()}`, { replace: true });
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, id);
      }
    },
    [location.pathname, location.search, navigate],
  );

  const value = useMemo<ReceptionBuildingContextValue>(
    () => ({ buildingId, buildings, setBuildingId, loading: isLoading }),
    [buildingId, buildings, setBuildingId, isLoading],
  );

  return (
    <ReceptionBuildingContext.Provider value={value}>
      {children}
    </ReceptionBuildingContext.Provider>
  );
}

export function useReceptionBuilding(): ReceptionBuildingContextValue {
  const ctx = useContext(ReceptionBuildingContext);
  if (!ctx) {
    throw new Error(
      'useReceptionBuilding must be used inside <ReceptionBuildingProvider>',
    );
  }
  return ctx;
}
