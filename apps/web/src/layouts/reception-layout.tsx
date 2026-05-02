/**
 * /reception/* shell.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.1
 *
 * A focused workspace, not a general management surface — reception staff
 * spend an entire shift inside it. We don't use the desk sidebar because
 * the rush UX needs every horizontal pixel for the search input + the
 * today-view list. Instead: a slim top bar with the building selector +
 * tabs + workspace switcher, and a content area below.
 *
 * Children read the current building via `useReceptionBuilding()`. The
 * provider wraps the whole shell so every page (today / passes /
 * yesterday / daglijst) is reactively scoped.
 *
 * Print mode: when the user prints `/reception/daglijst`, the top bar is
 * hidden via the `print:hidden` utility — see daglijst.tsx for the page-
 * level print stylesheet.
 */
import { NavLink, Outlet } from 'react-router-dom';
import { ConciergeBell, Printer, type LucideIcon } from 'lucide-react';
import { ShellSwitcher } from '@/components/shell-switcher';
import { ReceptionBuildingPicker } from '@/components/desk/desk-building-picker';
import { ReceptionBuildingProvider } from '@/components/desk/desk-building-context';
import { cn } from '@/lib/utils';

interface ReceptionTab {
  to: string;
  label: string;
  icon?: LucideIcon;
}

const tabs: ReceptionTab[] = [
  { to: '/reception/today', label: 'Today' },
  { to: '/reception/passes', label: 'Passes' },
  { to: '/reception/yesterday', label: "Yesterday's loose ends" },
  { to: '/reception/daglijst', label: 'Print daglijst', icon: Printer },
];

export function ReceptionLayout() {
  return (
    <ReceptionBuildingProvider>
      <div className="min-h-screen bg-background flex flex-col">
        <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur print:hidden">
          <div className="flex h-14 items-center gap-4 px-6">
            <div className="flex items-center gap-2 font-medium">
              <ConciergeBell className="size-5 text-muted-foreground" aria-hidden />
              Reception
            </div>
            <ReceptionBuildingPicker />
            <nav className="ml-4 flex items-center gap-1" aria-label="Reception">
              {tabs.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  className={({ isActive }) =>
                    cn(
                      'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium',
                      'transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                      isActive
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )
                  }
                  style={{
                    transitionTimingFunction: 'var(--ease-snap)',
                    transitionDuration: '120ms',
                  }}
                >
                  {t.icon && <t.icon className="size-3.5" aria-hidden />}
                  {t.label}
                </NavLink>
              ))}
            </nav>
            <div className="ml-auto">
              <ShellSwitcher />
            </div>
          </div>
        </header>
        <main className="flex-1 min-h-0">
          <Outlet />
        </main>
      </div>
    </ReceptionBuildingProvider>
  );
}
