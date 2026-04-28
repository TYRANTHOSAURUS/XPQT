import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { hexToOklch, pickForeground } from '@/lib/color-utils';
import { useBranding, type Branding } from '@/hooks/use-branding';

const STYLE_ID = 'tenant-theme';
const USER_OVERRIDE_KEY = 'pq.theme_mode';
const RESOLVED_CACHE_KEY = 'pq.theme_resolved';
const HEX_RE = /^#[0-9a-f]{6}$/i;

type ThemeMode = 'light' | 'dark' | 'system';
type ResolvedTheme = 'light' | 'dark';

interface ThemeContextValue {
  /** User-facing choice. 'system' is the default surface when no override is stored. */
  theme: ThemeMode;
  /** Concrete light/dark currently applied to the document. */
  resolvedTheme: ResolvedTheme;
  setTheme: (next: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function safeHex(value: string | null): string | null {
  return value && HEX_RE.test(value) ? value : null;
}

function readStoredMode(): ThemeMode | null {
  try {
    const v = localStorage.getItem(USER_OVERRIDE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  } catch {
    return null;
  }
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Belt-and-braces guard: even though the API validates hex on write, this is the
// last hop before raw interpolation into a global <style>. A malformed value
// (manual DB edit, future seed) gets dropped here rather than allowing CSS injection.
function buildSurfaceBlock(opts: {
  bg: string | null;
  sidebar: string | null;
}): string {
  const lines: string[] = [];

  const bg = safeHex(opts.bg);
  if (bg) {
    const fg = pickForeground(bg);
    lines.push(`--background: ${bg};`);
    lines.push(`--foreground: ${fg};`);
    lines.push(`--border: color-mix(in oklch, ${bg} 88%, ${fg} 12%);`);
  }

  const sidebar = safeHex(opts.sidebar);
  if (sidebar) {
    const fg = pickForeground(sidebar);
    lines.push(`--sidebar: ${sidebar};`);
    lines.push(`--sidebar-foreground: ${fg};`);
    lines.push(`--sidebar-accent: color-mix(in oklch, ${sidebar} 92%, ${fg} 8%);`);
    lines.push(`--sidebar-accent-foreground: ${fg};`);
    lines.push(`--sidebar-border: color-mix(in oklch, ${sidebar} 90%, ${fg} 10%);`);
  }

  return lines.join('\n      ');
}

function injectStyle(branding: Branding) {
  const primary = hexToOklch(branding.primary_color);
  const accent = hexToOklch(branding.accent_color);
  const primaryFg = pickForeground(branding.primary_color);
  const accentFg = pickForeground(branding.accent_color);

  const lightSurfaces = buildSurfaceBlock({
    bg: branding.background_light,
    sidebar: branding.sidebar_light,
  });
  const darkSurfaces = buildSurfaceBlock({
    bg: branding.background_dark,
    sidebar: branding.sidebar_dark,
  });

  const css = `
    :root {
      --primary: ${primary};
      --primary-foreground: ${primaryFg};
      --accent: ${accent};
      --accent-foreground: ${accentFg};
      --ring: ${primary};
      --sidebar-primary: ${primary};
      --sidebar-primary-foreground: ${primaryFg};
      ${lightSurfaces}
    }
    .dark {
      --primary: ${primary};
      --primary-foreground: ${primaryFg};
      --accent: ${accent};
      --accent-foreground: ${accentFg};
      --ring: ${primary};
      --sidebar-primary: ${primary};
      --sidebar-primary-foreground: ${primaryFg};
      ${darkSurfaces}
    }
  `;

  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

function setFavicon(url: string | null) {
  const fallback = '/assets/prequest-icon-color.svg';
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = url ?? fallback;
}

function applyThemeClass(mode: ResolvedTheme) {
  const de = document.documentElement;
  de.classList.toggle('dark', mode === 'dark');
  de.style.colorScheme = mode;
  // Cache for the inline pre-paint script in index.html so subsequent loads
  // paint the right scheme before React mounts.
  try {
    localStorage.setItem(RESOLVED_CACHE_KEY, mode);
  } catch {
    // localStorage unavailable (private mode, quota) — accept a one-load flash
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { branding } = useBranding();
  const tenantDefault = branding.theme_mode_default;

  // null = user has not made an explicit choice; resolution falls to tenant default.
  const [stored, setStored] = useState<ThemeMode | null>(() => readStoredMode());

  const setTheme = useCallback((next: ThemeMode) => {
    setStored(next);
    try {
      localStorage.setItem(USER_OVERRIDE_KEY, next);
    } catch {
      // localStorage unavailable — change still applies for the session
    }
  }, []);

  const resolvedTheme = useMemo<ResolvedTheme>(() => {
    const effective = stored ?? tenantDefault;
    if (effective === 'light' || effective === 'dark') return effective;
    return getSystemTheme();
  }, [stored, tenantDefault]);

  useEffect(() => {
    injectStyle(branding);
    setFavicon(branding.favicon_url);
  }, [branding]);

  useEffect(() => {
    applyThemeClass(resolvedTheme);
  }, [resolvedTheme]);

  // Track OS preference only when we're actually following it.
  useEffect(() => {
    const followsOs = (stored ?? tenantDefault) === 'system';
    if (!followsOs) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeClass(media.matches ? 'dark' : 'light');
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [stored, tenantDefault]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: stored ?? 'system',
      resolvedTheme,
      setTheme,
    }),
    [stored, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}
