import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { apiFetch } from '@/lib/api';

interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  avatar_url?: string | null;
}

export type RoleType = 'admin' | 'agent' | 'employee';

interface AppUser {
  id: string;
  person_id: string;
  roles: { name: string; type: RoleType }[];
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  person: Person | null;
  appUser: AppUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  hasRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUserData = useCallback(async (currentUser: User | null) => {
    if (!currentUser) {
      setPerson(null);
      setAppUser(null);
      return;
    }

    try {
      // Single-hop resolution via auth_uid. Backend joins the person row and
      // role_assignments in one query, so we don't depend on persons-by-email
      // search to find roles.
      type MeResponse = {
        id: string;
        person_id: string;
        person: Person | null;
        role_assignments?: { role?: { name?: string; type?: string } | null }[];
      } | null;
      const me = await apiFetch<MeResponse>('/users/me');
      if (!me) {
        setPerson(null);
        setAppUser(null);
        return;
      }

      setPerson(me.person ?? null);
      setAppUser({
        id: me.id,
        person_id: me.person_id,
        roles: (me.role_assignments ?? [])
          .map((ra) => ra.role)
          .filter((r): r is { name: string; type: string } => Boolean(r?.name))
          .map((r) => ({
            name: r.name,
            type: (r.type === 'admin' || r.type === 'agent' ? r.type : 'employee') as RoleType,
          })),
      });
    } catch {
      // Auth valid but no public.users row (or API down) — fall through unauth.
      setPerson(null);
      setAppUser(null);
    }
  }, []);

  useEffect(() => {
    // Check existing session on mount
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      fetchUserData(s?.user ?? null).finally(() => setLoading(false));
    });

    // Listen for auth state changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      fetchUserData(s?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, [fetchUserData]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<{ error: string | null }> => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return { error: error.message };
      return { error: null };
    },
    [],
  );

  const signUp = useCallback(
    async (email: string, password: string): Promise<{ error: string | null }> => {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) return { error: error.message };
      return { error: null };
    },
    [],
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setPerson(null);
    setAppUser(null);
  }, []);

  const hasRole = useCallback(
    (role: string): boolean => {
      if (!appUser?.roles) return false;
      // `role` is a role type: 'admin' | 'agent' | 'employee'.
      // Admin is a superset of agent for access gating.
      if (role === 'agent') return appUser.roles.some((r) => r.type === 'agent' || r.type === 'admin');
      return appUser.roles.some((r) => r.type === role);
    },
    [appUser],
  );

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      session,
      person,
      appUser,
      loading,
      signIn,
      signUp,
      signOut,
      hasRole,
    }),
    [user, session, person, appUser, loading, signIn, signUp, signOut, hasRole],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
