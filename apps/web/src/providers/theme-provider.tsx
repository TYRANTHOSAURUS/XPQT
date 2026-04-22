import { useEffect, type ReactNode } from 'react';
import { hexToOklch, pickForeground } from '@/lib/color-utils';
import { useBranding } from '@/hooks/use-branding';

const STYLE_ID = 'tenant-theme';
const USER_OVERRIDE_KEY = 'pq.theme_mode';

function resolveThemeMode(tenantDefault: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  const userOverride = (() => {
    try {
      const v = localStorage.getItem(USER_OVERRIDE_KEY);
      return v === 'light' || v === 'dark' || v === 'system' ? v : null;
    } catch {
      return null;
    }
  })();
  const mode = userOverride ?? tenantDefault;
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

function injectStyle(primaryHex: string, accentHex: string) {
  const primary = hexToOklch(primaryHex);
  const accent = hexToOklch(accentHex);
  const primaryFg = pickForeground(primaryHex);
  const accentFg = pickForeground(accentHex);

  const css = `
    :root {
      --primary: ${primary};
      --primary-foreground: ${primaryFg};
      --accent: ${accent};
      --accent-foreground: ${accentFg};
      --ring: ${primary};
      --sidebar-primary: ${primary};
      --sidebar-primary-foreground: ${primaryFg};
    }
    .dark {
      --primary: ${primary};
      --primary-foreground: ${primaryFg};
      --accent: ${accent};
      --accent-foreground: ${accentFg};
      --ring: ${primary};
      --sidebar-primary: ${primary};
      --sidebar-primary-foreground: ${primaryFg};
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

function applyThemeClass(mode: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', mode === 'dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { branding } = useBranding();

  useEffect(() => {
    injectStyle(branding.primary_color, branding.accent_color);
    setFavicon(branding.favicon_url);
    applyThemeClass(resolveThemeMode(branding.theme_mode_default));
  }, [branding]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyThemeClass(resolveThemeMode(branding.theme_mode_default));
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [branding.theme_mode_default]);

  return <>{children}</>;
}
