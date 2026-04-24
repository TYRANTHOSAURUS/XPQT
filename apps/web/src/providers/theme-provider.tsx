import { useEffect, type ReactNode } from 'react';
import { hexToOklch, pickForeground } from '@/lib/color-utils';
import { useBranding, type Branding } from '@/hooks/use-branding';

const STYLE_ID = 'tenant-theme';
const USER_OVERRIDE_KEY = 'pq.theme_mode';
const HEX_RE = /^#[0-9a-f]{6}$/i;

function safeHex(value: string | null): string | null {
  return value && HEX_RE.test(value) ? value : null;
}

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

function applyThemeClass(mode: 'light' | 'dark') {
  document.documentElement.classList.toggle('dark', mode === 'dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { branding } = useBranding();

  useEffect(() => {
    injectStyle(branding);
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
