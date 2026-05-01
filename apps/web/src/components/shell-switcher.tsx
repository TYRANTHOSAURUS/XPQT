import { useNavigate, useLocation } from 'react-router-dom';
import { User, Headset, Settings, ConciergeBell } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { cn } from '@/lib/utils';

interface ShellItem {
  id: 'portal' | 'desk' | 'reception' | 'admin';
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  path: string;
  prefix: string;
  visible: boolean;
}

/**
 * Compact segmented pill in the top-right of every shell. Shows Portal /
 * Service Desk / Admin as icon buttons, gated by role. The current shell is
 * highlighted (background + shadow) and disabled. Clicking another shell
 * navigates to its index route.
 *
 * Returns null when the user only has access to one shell — no switcher
 * needed if there is nowhere to switch to.
 */
export function ShellSwitcher() {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasRole } = useAuth();

  const items: ShellItem[] = ([
    {
      id: 'portal' as const,
      label: 'Portal',
      description: 'Submit requests, book rooms',
      icon: User,
      path: '/portal',
      prefix: '/portal',
      visible: true,
    },
    {
      id: 'desk' as const,
      label: 'Service Desk',
      description: 'Triage and resolve tickets',
      icon: Headset,
      path: '/desk',
      prefix: '/desk',
      visible: hasRole('agent') || hasRole('admin'),
    },
    {
      id: 'reception' as const,
      label: 'Reception',
      description: 'Front desk — visitors today',
      icon: ConciergeBell,
      path: '/reception',
      prefix: '/reception',
      // Permission gate is server-side (`visitors.reception`); we surface
      // the switcher to anyone with agent privileges as a UX hint.
      visible: hasRole('agent') || hasRole('admin'),
    },
    {
      id: 'admin' as const,
      label: 'Admin',
      description: 'Configure the workspace',
      icon: Settings,
      path: '/admin',
      prefix: '/admin',
      visible: hasRole('admin'),
    },
  ] satisfies ShellItem[]).filter((i) => i.visible);

  if (items.length <= 1) return null;

  const current = items.find((i) => location.pathname.startsWith(i.prefix))?.id;

  return (
    <div
      role="group"
      aria-label="Switch shell"
      className="inline-flex items-center rounded-md border bg-muted/40 p-0.5"
    >
      {items.map((it) => {
        const isCurrent = it.id === current;
        const Icon = it.icon;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => !isCurrent && navigate(it.path)}
            disabled={isCurrent}
            aria-current={isCurrent ? 'page' : undefined}
            aria-label={it.label}
            title={`${it.label} — ${it.description}`}
            className={cn(
              'inline-flex h-7 items-center justify-center rounded-[5px] px-2 text-xs font-medium',
              'transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              isCurrent
                ? 'bg-background text-foreground shadow-sm cursor-default'
                : 'text-muted-foreground hover:bg-background/80 hover:text-foreground cursor-pointer',
            )}
            style={{ transitionTimingFunction: 'var(--ease-snap)', transitionDuration: '120ms' }}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
