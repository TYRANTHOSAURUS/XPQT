import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangleIcon,
  ArrowDownAZIcon,
  ArrowDownNarrowWideIcon,
  ArrowUpDownIcon,
  ArrowUpWideNarrowIcon,
  BanIcon,
  Building2Icon,
  CalendarRangeIcon,
  CircleCheckIcon,
  HourglassIcon,
  LayersIcon,
  ListIcon,
} from 'lucide-react';
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useSpaceTree, type SpaceTreeNode } from '@/api/spaces';

/**
 * Scheduler sidebar (second panel of the desk sidebar). The desk
 * sidebar already shows page nav on the icon rail; this fills the
 * previously-empty content panel for `/desk/scheduler` with three
 * scheduling-relevant blocks:
 *
 *   - Status views (Available / Requires approval / Restricted /
 *     Warnings) — a quick filter on `rule_outcome.effect`. Most
 *     useful when "Booking for: <person>" is set in the toolbar; the
 *     section header surfaces that hint.
 *   - Buildings — flat list of buildings drawn from the spaces tree.
 *     Click navigates with `?building=<id>` so deep links work.
 *   - Sort — mirrors the toolbar's sort. Two surfaces, same state, so
 *     operators can land on either one.
 *
 * All clicks navigate via `useNavigate` + `useSearchParams` so
 * scheduler state stays the URL's authority. The page reacts via the
 * URL → state effect in `useSchedulerWindow`.
 */
export function SchedulerSidebarPanel() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tree = useSpaceTree();
  const buildings = useMemo(() => collectBuildings(tree.data), [tree.data]);

  const activeStatus = params.get('status') ?? 'all';
  const activeBuilding = params.get('building');
  const activeSort = params.get('sort') ?? 'name';

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value == null || value === '') next.delete(key);
    else next.set(key, value);
    // Clear floor when building changes — the previously-selected
    // floor would otherwise apply to a different building.
    if (key === 'building') next.delete('floor');
    navigate({ pathname: '/desk/scheduler', search: `?${next.toString()}` }, { replace: true });
  };

  return (
    <>
      <SidebarHeader className="gap-3.5 border-b p-4">
        <div className="flex items-center gap-2">
          <CalendarRangeIcon className="size-4 text-muted-foreground" />
          <div className="text-base font-medium text-foreground">Scheduler</div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Views</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {STATUS_VIEWS.map((view) => (
                <SidebarMenuItem key={view.id}>
                  <SidebarMenuButton
                    className="text-sm"
                    isActive={activeStatus === view.id}
                    onClick={() => setParam('status', view.id === 'all' ? null : view.id)}
                  >
                    <view.icon className="size-4" />
                    <span>{view.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Buildings</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  className="text-sm"
                  isActive={!activeBuilding}
                  onClick={() => setParam('building', null)}
                >
                  <ListIcon className="size-4" />
                  <span>All buildings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {buildings.map((b) => (
                <SidebarMenuItem key={b.id}>
                  <SidebarMenuButton
                    className="text-sm"
                    isActive={activeBuilding === b.id}
                    onClick={() => setParam('building', b.id)}
                  >
                    <Building2Icon className="size-4" />
                    <span className="truncate">{b.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {buildings.length === 0 && tree.isPending && (
                <div className="px-3 py-1.5 text-xs text-muted-foreground">Loading…</div>
              )}
              {buildings.length === 0 && !tree.isPending && (
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  No buildings yet
                </div>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Sort</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {SORT_OPTIONS.map((opt) => (
                <SidebarMenuItem key={opt.id}>
                  <SidebarMenuButton
                    className="text-sm"
                    isActive={activeSort === opt.id}
                    onClick={() => setParam('sort', opt.id)}
                  >
                    <opt.icon className="size-4" />
                    <span>{opt.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}

const STATUS_VIEWS: Array<{
  id: 'all' | 'available' | 'requires_approval' | 'restricted' | 'warning';
  label: string;
  icon: typeof CircleCheckIcon;
}> = [
  { id: 'all', label: 'All rooms', icon: LayersIcon },
  { id: 'available', label: 'Available', icon: CircleCheckIcon },
  { id: 'requires_approval', label: 'Requires approval', icon: HourglassIcon },
  { id: 'warning', label: 'Warnings', icon: AlertTriangleIcon },
  { id: 'restricted', label: 'Restricted', icon: BanIcon },
];

const SORT_OPTIONS: Array<{
  id: 'name' | 'capacity_asc' | 'capacity_desc' | 'status';
  label: string;
  icon: typeof ArrowDownAZIcon;
}> = [
  { id: 'name', label: 'Name (A→Z)', icon: ArrowDownAZIcon },
  { id: 'capacity_asc', label: 'Capacity ↑', icon: ArrowUpWideNarrowIcon },
  { id: 'capacity_desc', label: 'Capacity ↓', icon: ArrowDownNarrowWideIcon },
  { id: 'status', label: 'Status', icon: ArrowUpDownIcon },
];

function collectBuildings(tree: SpaceTreeNode[] | undefined): Array<{ id: string; name: string }> {
  if (!tree) return [];
  const out: Array<{ id: string; name: string }> = [];
  const walk = (node: SpaceTreeNode) => {
    if (node.type === 'building') out.push({ id: node.id, name: node.name });
    for (const c of node.children ?? []) walk(c);
  };
  for (const n of tree) walk(n);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
