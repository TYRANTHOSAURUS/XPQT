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
import { supabase } from '@/lib/supabase';

export interface Branding {
  logo_light_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  primary_color: string;
  accent_color: string;
  theme_mode_default: 'light' | 'dark' | 'system';
}

const DEFAULT_BRANDING: Branding = {
  logo_light_url: null,
  logo_dark_url: null,
  favicon_url: null,
  primary_color: '#2563eb',
  accent_color: '#7c3aed',
  theme_mode_default: 'light',
};

interface BrandingContextValue {
  branding: Branding;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  updateBranding: (
    dto: Pick<Branding, 'primary_color' | 'accent_color' | 'theme_mode_default'>,
  ) => Promise<void>;
  uploadLogo: (kind: 'light' | 'dark' | 'favicon', file: File) => Promise<void>;
  removeLogo: (kind: 'light' | 'dark' | 'favicon') => Promise<void>;
}

const BrandingContext = createContext<BrandingContextValue | undefined>(undefined);

const STORAGE_KEY = 'pq.branding';

function readCached(): Branding | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Branding) : null;
  } catch {
    return null;
  }
}

function writeCached(b: Branding): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    /* ignore quota */
  }
}

async function multipart(path: string, form: FormData): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return fetch(`/api${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(
    () => readCached() ?? DEFAULT_BRANDING,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<Branding>('/tenants/current/branding');
      setBranding(data);
      writeCached(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load branding');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const updateBranding = useCallback(
    async (dto: Pick<Branding, 'primary_color' | 'accent_color' | 'theme_mode_default'>) => {
      const next = await apiFetch<Branding>('/tenants/branding', {
        method: 'PUT',
        body: JSON.stringify(dto),
      });
      setBranding(next);
      writeCached(next);
    },
    [],
  );

  const uploadLogo = useCallback(
    async (kind: 'light' | 'dark' | 'favicon', file: File) => {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind);
      const res = await multipart('/tenants/branding/logo', form);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Upload failed (${res.status})`);
      }
      const next = (await res.json()) as Branding;
      setBranding(next);
      writeCached(next);
    },
    [],
  );

  const removeLogo = useCallback(async (kind: 'light' | 'dark' | 'favicon') => {
    const next = await apiFetch<Branding>(`/tenants/branding/logo/${kind}`, {
      method: 'DELETE',
    });
    setBranding(next);
    writeCached(next);
  }, []);

  const value = useMemo(
    () => ({ branding, loading, error, refetch, updateBranding, uploadLogo, removeLogo }),
    [branding, loading, error, refetch, updateBranding, uploadLogo, removeLogo],
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (!ctx) throw new Error('useBranding must be used within a BrandingProvider');
  return ctx;
}
