import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, ListFilter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useTeams } from '@/api/teams';
import { statusConfig } from '@/components/desk/ticket-row-cells';

const TENANT_TIME_ZONE = 'Europe/Amsterdam';

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: TENANT_TIME_ZONE,
});

const ZONE_LABEL_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: TENANT_TIME_ZONE,
  timeZoneName: 'short',
  hour: '2-digit',
});

const STATUS_OPTIONS = [
  { value: 'new', label: statusConfig.new.label },
  { value: 'assigned', label: statusConfig.assigned.label },
  { value: 'in_progress', label: statusConfig.in_progress.label },
  { value: 'waiting', label: statusConfig.waiting.label },
  { value: 'resolved', label: statusConfig.resolved.label },
  { value: 'closed', label: statusConfig.closed.label },
];

interface Props {
  anchorDate: string;
  status: string[];
  teamId: string | null;
  railCollapsed: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onStatusChange: (next: string[]) => void;
  onTeamChange: (next: string | null) => void;
  onToggleRail: () => void;
}

export function PlanningToolbar({
  anchorDate,
  status,
  teamId,
  railCollapsed,
  onPrev,
  onNext,
  onToday,
  onStatusChange,
  onTeamChange,
  onToggleRail,
}: Props) {
  const teamsQuery = useTeams();
  const dateLabel = formatAnchorLabel(anchorDate);

  const statusSummary =
    status.length === 0
      ? 'All statuses'
      : status.length === STATUS_OPTIONS.length
        ? 'All statuses'
        : status.length === 1
          ? STATUS_OPTIONS.find((s) => s.value === status[0])?.label ?? status[0]
          : `${status.length} statuses`;

  const selectedTeamName = teamId
    ? teamsQuery.data?.find((t) => t.id === teamId)?.name ?? 'Team'
    : 'All teams';

  const toggleStatus = (value: string) => {
    if (status.includes(value)) {
      onStatusChange(status.filter((s) => s !== value));
    } else {
      onStatusChange([...status, value]);
    }
  };

  return (
    <div className="flex h-12 items-center gap-2 border-b px-3">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onToggleRail}
        aria-label={railCollapsed ? 'Show unscheduled rail' : 'Hide unscheduled rail'}
      >
        {railCollapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
      </Button>

      <div className="ml-1 flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={onPrev} aria-label="Previous day">
          <ChevronLeft className="size-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={onToday}>
          Today
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} aria-label="Next day">
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div className="ml-3 text-sm font-medium tabular-nums">
        {dateLabel}
        <span className="ml-2 text-xs text-muted-foreground">· {extractZoneAbbr()}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="gap-1.5">
                <ListFilter className="size-3.5" />
                {statusSummary}
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Statuses</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {STATUS_OPTIONS.map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt.value}
                checked={status.includes(opt.value)}
                onCheckedChange={() => toggleStatus(opt.value)}
              >
                <span className={cn('mr-2 inline-block size-2 rounded-full', statusConfig[opt.value]?.dotColor)} />
                {opt.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="gap-1.5">
                {selectedTeamName}
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-auto">
            <DropdownMenuLabel>Team</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={teamId ?? '__all__'}
              onValueChange={(v) => onTeamChange(v === '__all__' ? null : v)}
            >
              <DropdownMenuRadioItem value="__all__">All teams</DropdownMenuRadioItem>
              {(teamsQuery.data ?? []).map((team) => (
                <DropdownMenuRadioItem key={team.id} value={team.id}>
                  {team.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function formatAnchorLabel(anchorDate: string): string {
  // Anchor is a `yyyy-MM-dd` local date string. Compose noon-of-day so
  // DST transitions don't shift the displayed date label.
  const d = new Date(`${anchorDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return anchorDate;
  return DATE_LABEL_FORMATTER.format(d);
}

function extractZoneAbbr(): string {
  // The `timeZoneName: 'short'` part on the formatter resolves to
  // "CET" / "CEST" depending on DST. Pull it out of `formatToParts`.
  try {
    const parts = ZONE_LABEL_FORMATTER.formatToParts(new Date());
    const zone = parts.find((p) => p.type === 'timeZoneName');
    return zone?.value ?? 'CET';
  } catch {
    return 'CET';
  }
}
