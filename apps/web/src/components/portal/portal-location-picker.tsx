import { Building2, MapPin, ChevronDown } from 'lucide-react';
import { useState } from 'react';
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
import { usePortal } from '@/providers/portal-provider';

/**
 * Portal header control: "Submitting for: [Amsterdam HQ ▾]".
 * Lists the person's authorized scope roots (default + grants).
 * Switching persists server-side via PATCH /portal/me.
 */
export function PortalLocationPicker() {
  const { data, setCurrentLocation } = usePortal();
  const [busy, setBusy] = useState(false);

  if (!data || !data.can_submit || !data.current_location) return null;

  const defaults = data.authorized_locations.filter((l) => l.source === 'default');
  const grants = data.authorized_locations.filter((l) => l.source === 'grant');

  const onSelect = async (spaceId: string) => {
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" className="gap-2 h-8" disabled={busy} />}
      >
        <MapPin className="h-4 w-4" />
        <span className="hidden sm:inline text-muted-foreground">Submitting for:</span>
        <span className="font-medium">{data.current_location.name}</span>
        <ChevronDown className="h-3 w-3 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[260px]">
        {defaults.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Your work location
            </DropdownMenuLabel>
            {defaults.map((loc) => (
              <DropdownMenuItem
                key={loc.id}
                onSelect={() => void onSelect(loc.id)}
                className="flex items-start gap-2"
              >
                <Building2 className="h-4 w-4 mt-0.5" />
                <div className="flex flex-col flex-1">
                  <span>{loc.name}</span>
                  <span className="text-xs text-muted-foreground capitalize">{loc.type}</span>
                </div>
                {loc.id === data.current_location?.id && (
                  <span className="text-xs text-muted-foreground">Current</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {grants.length > 0 && (
          <>
            {defaults.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Other authorized locations
              </DropdownMenuLabel>
              {grants.map((loc) => (
                <DropdownMenuItem
                  key={loc.id}
                  onSelect={() => void onSelect(loc.id)}
                  className="flex items-start gap-2"
                >
                  <MapPin className="h-4 w-4 mt-0.5" />
                  <div className="flex flex-col flex-1">
                    <span>{loc.name}</span>
                    <span className="text-xs text-muted-foreground capitalize">{loc.type}</span>
                  </div>
                  {loc.id === data.current_location?.id && (
                    <span className="text-xs text-muted-foreground">Current</span>
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
