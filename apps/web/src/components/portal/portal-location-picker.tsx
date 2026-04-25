import { Building2, MapPin, ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePortal, type AuthorizedLocation } from '@/providers/portal-provider';

interface PortalLocationPickerProps {
  /** When true, render a tighter chip suitable for mobile. */
  compact?: boolean;
}

/**
 * Portal header chip: "[📍 Amsterdam HQ ▾]". Lists the person's authorized
 * scope roots (default + grants). Switching persists via PATCH /portal/me.
 */
export function PortalLocationPicker({ compact }: PortalLocationPickerProps = {}) {
  const { data } = usePortal();
  const [busy, setBusy] = useState(false);

  if (!data || !data.can_submit || !data.current_location) return null;

  return (
    <PortalLocationSwitcher
      busy={busy}
      onBusyChange={setBusy}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 rounded-md px-2 text-[13px] font-medium text-foreground/80 hover:bg-foreground/[0.04] hover:text-foreground"
          disabled={busy}
        >
          <MapPin className="h-3.5 w-3.5 opacity-70" />
          <span className={compact ? 'truncate max-w-[8rem]' : 'truncate max-w-[12rem]'}>
            {data.current_location.name}
          </span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      }
    />
  );
}

interface PortalLocationSwitcherProps {
  trigger: ReactNode;
  busy?: boolean;
  onBusyChange?: (busy: boolean) => void;
  align?: 'start' | 'center' | 'end';
}

/**
 * Shared dropdown content for switching the portal's current location.
 * Render any element via `trigger` — chip button, inline link, etc.
 */
export function PortalLocationSwitcher({
  trigger,
  busy: busyProp,
  onBusyChange,
  align = 'end',
}: PortalLocationSwitcherProps) {
  const { data, setCurrentLocation } = usePortal();
  const [internalBusy, setInternalBusy] = useState(false);
  const busy = busyProp ?? internalBusy;
  const setBusy = onBusyChange ?? setInternalBusy;

  if (!data || !data.can_submit || !data.current_location) return null;

  const defaults = data.authorized_locations.filter((l) => l.source === 'default');
  const grants = data.authorized_locations.filter((l) => l.source === 'grant');

  const handle = async (spaceId: string) => {
    if (spaceId === data.current_location?.id) return;
    setBusy(true);
    try {
      await setCurrentLocation(spaceId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to switch location');
    } finally {
      setBusy(false);
    }
  };

  const renderItem = (loc: AuthorizedLocation, Icon: typeof Building2) => (
    <DropdownMenuItem
      key={loc.id}
      onClick={() => void handle(loc.id)}
      disabled={busy}
      className="flex items-start gap-2"
    >
      <Icon className="h-4 w-4 mt-0.5" />
      <div className="flex flex-col flex-1">
        <span>{loc.name}</span>
        <span className="text-xs text-muted-foreground capitalize">{loc.type}</span>
      </div>
      {loc.id === data.current_location?.id && (
        <span className="text-xs text-muted-foreground">Current</span>
      )}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger as React.ReactElement} />
      <DropdownMenuContent align={align} className="min-w-[260px]">
        {defaults.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Your work location
            </DropdownMenuLabel>
            {defaults.map((loc) => renderItem(loc, Building2))}
          </DropdownMenuGroup>
        )}
        {grants.length > 0 && (
          <>
            {defaults.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Other authorized locations
              </DropdownMenuLabel>
              {grants.map((loc) => renderItem(loc, MapPin))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
