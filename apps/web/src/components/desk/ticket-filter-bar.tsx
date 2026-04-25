import { useMemo, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { statusConfig, priorityConfig, PriorityIcon } from './ticket-row-cells';
import { useTeams } from '@/api/teams';
import { useUsers, userLabel } from '@/api/users';
import {
  usePersons,
  usePersonsSearch,
  usePerson,
  personFullName,
  type Person,
} from '@/api/persons';
import { useSpaceTree } from '@/api/spaces';
import type { SpaceTreeNode } from '@/api/spaces/types';
import type { RawFilters } from '@/pages/desk/use-ticket-filters';

const STATUS_OPTIONS = [
  'new',
  'assigned',
  'in_progress',
  'waiting',
  'pending_approval',
  'resolved',
  'closed',
];

const PRIORITY_OPTIONS = ['critical', 'urgent', 'high', 'medium', 'low'];

interface FilterChipProps {
  label: string;
  valueSummary?: string | null;
  onClear?: () => void;
  children: ReactNode;
  popoverClassName?: string;
}

/**
 * One filter slot. Collapsed state shows "+ Label" (ghost). Active state
 * shows "Label · <summary>" with a click-to-clear X glyph on the right.
 * Clicking the chip body opens the popover to edit.
 */
function FilterChip({ label, valueSummary, onClear, children, popoverClassName }: FilterChipProps) {
  const [open, setOpen] = useState(false);
  const isActive = Boolean(valueSummary);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'inline-flex items-stretch rounded-md border text-xs transition-colors',
          isActive
            ? 'border-primary/40 bg-primary/5 text-foreground'
            : 'border-dashed border-border text-muted-foreground hover:border-solid hover:text-foreground',
        )}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex items-center gap-1.5 px-2 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          }
        >
          <span className={cn('font-medium', !isActive && 'font-normal')}>
            {isActive ? label : `+ ${label}`}
          </span>
          {isActive && valueSummary && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="truncate max-w-[180px]">{valueSummary}</span>
            </>
          )}
          {!isActive && <ChevronDownIcon className="h-3 w-3 opacity-60" />}
        </PopoverTrigger>
        {isActive && onClear && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            aria-label={`Clear ${label}`}
            className="flex items-center justify-center border-l border-primary/30 px-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon className="h-3 w-3" />
          </button>
        )}
      </div>
      <PopoverContent className={cn('p-0 min-w-[240px]', popoverClassName)} align="start">
        {children}
      </PopoverContent>
    </Popover>
  );
}

function MultiOptionList({
  options,
  selected,
  onToggle,
  labelFor,
  leadingFor,
  searchPlaceholder,
}: {
  options: string[];
  selected: string[];
  onToggle: (id: string) => void;
  labelFor: (id: string) => string;
  leadingFor?: (id: string) => ReactNode;
  searchPlaceholder: string;
}) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  return (
    <Command>
      <CommandInput placeholder={searchPlaceholder} />
      <CommandList>
        <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
          No matches.
        </CommandEmpty>
        <CommandGroup>
          {options.map((id) => {
            const checked = selectedSet.has(id);
            return (
              <CommandItem key={id} value={labelFor(id)} onSelect={() => onToggle(id)}>
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-input',
                    checked && 'bg-primary border-primary text-primary-foreground',
                  )}
                >
                  {checked && <CheckIcon className="h-3 w-3" />}
                </span>
                {leadingFor?.(id)}
                <span className="flex-1 truncate">{labelFor(id)}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function SingleOptionList({
  options,
  selected,
  onSelect,
  searchPlaceholder,
}: {
  options: Array<{ id: string; label: string; sublabel?: string; leading?: ReactNode }>;
  selected: string | null;
  onSelect: (id: string) => void;
  searchPlaceholder: string;
}) {
  return (
    <Command>
      <CommandInput placeholder={searchPlaceholder} />
      <CommandList>
        <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
          No matches.
        </CommandEmpty>
        <CommandGroup>
          {options.map((opt) => {
            const checked = selected === opt.id;
            return (
              <CommandItem
                key={opt.id}
                value={`${opt.label} ${opt.sublabel ?? ''}`}
                onSelect={() => onSelect(opt.id)}
                className="py-2"
              >
                {opt.leading}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{opt.label}</span>
                  {opt.sublabel && (
                    <span className="truncate text-xs text-muted-foreground">{opt.sublabel}</span>
                  )}
                </div>
                {checked && <CheckIcon className="h-4 w-4 text-foreground" />}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function StatusChip({ raw, patch }: { raw: RawFilters; patch: PatchFn }) {
  const toggle = (id: string) => {
    const next = raw.status.includes(id)
      ? raw.status.filter((s) => s !== id)
      : [...raw.status, id];
    patch({ status: next });
  };
  const summary =
    raw.status.length === 0
      ? null
      : raw.status.length === 1
      ? statusConfig[raw.status[0]]?.label ?? raw.status[0]
      : `${raw.status.length} values`;

  return (
    <FilterChip
      label="Status"
      valueSummary={summary}
      onClear={() => patch({ status: null })}
    >
      <MultiOptionList
        options={STATUS_OPTIONS}
        selected={raw.status}
        onToggle={toggle}
        searchPlaceholder="Filter status…"
        labelFor={(id) => statusConfig[id]?.label ?? id}
        leadingFor={(id) => (
          <span
            className={cn('h-2 w-2 shrink-0 rounded-full', statusConfig[id]?.dotColor ?? 'bg-muted-foreground/30')}
          />
        )}
      />
    </FilterChip>
  );
}

function PriorityChip({ raw, patch }: { raw: RawFilters; patch: PatchFn }) {
  const toggle = (id: string) => {
    const next = raw.priority.includes(id)
      ? raw.priority.filter((s) => s !== id)
      : [...raw.priority, id];
    patch({ priority: next });
  };
  const summary =
    raw.priority.length === 0
      ? null
      : raw.priority.length === 1
      ? priorityConfig[raw.priority[0]]?.label ?? raw.priority[0]
      : `${raw.priority.length} values`;

  return (
    <FilterChip
      label="Priority"
      valueSummary={summary}
      onClear={() => patch({ priority: null })}
    >
      <MultiOptionList
        options={PRIORITY_OPTIONS}
        selected={raw.priority}
        onToggle={toggle}
        searchPlaceholder="Filter priority…"
        labelFor={(id) => priorityConfig[id]?.label ?? id}
        leadingFor={(id) => (
          <span className="inline-flex h-4 w-4 items-center justify-center">
            <PriorityIcon priority={id} iconClassName="h-3.5 w-3.5" />
          </span>
        )}
      />
    </FilterChip>
  );
}

function AssigneeChip({
  raw,
  patch,
  currentUserId,
}: {
  raw: RawFilters;
  patch: PatchFn;
  currentUserId: string | null;
}) {
  const { data: users } = useUsers();
  const options = useMemo(() => {
    const specials: Array<{ id: string; label: string; sublabel?: string }> = [];
    if (currentUserId) specials.push({ id: 'me', label: 'Assigned to me' });
    specials.push({ id: 'unassigned', label: 'Unassigned' });
    const list = (users ?? []).map((u) => ({
      id: u.id,
      label: userLabel(u),
      sublabel: u.email,
    }));
    return [...specials, ...list];
  }, [users, currentUserId]);

  const selectedLabel = useMemo(() => {
    if (!raw.assignee) return null;
    if (raw.assignee === 'me') return 'Me';
    if (raw.assignee === 'unassigned') return 'Unassigned';
    const hit = users?.find((u) => u.id === raw.assignee);
    return hit ? userLabel(hit) : 'Selected';
  }, [raw.assignee, users]);

  return (
    <FilterChip
      label="Assignee"
      valueSummary={selectedLabel}
      onClear={() => patch({ assignee: null })}
      popoverClassName="min-w-[260px]"
    >
      <SingleOptionList
        options={options}
        selected={raw.assignee}
        onSelect={(id) => patch({ assignee: id })}
        searchPlaceholder="Search people…"
      />
    </FilterChip>
  );
}

function TeamChip({ raw, patch }: { raw: RawFilters; patch: PatchFn }) {
  const { data: teams } = useTeams();
  const options = useMemo(
    () => [
      { id: 'unassigned', label: 'No team' },
      ...(teams ?? []).map((t) => ({ id: t.id, label: t.name })),
    ],
    [teams],
  );
  const selectedLabel = useMemo(() => {
    if (!raw.team) return null;
    if (raw.team === 'unassigned') return 'No team';
    const hit = teams?.find((t) => t.id === raw.team);
    return hit?.name ?? 'Selected';
  }, [raw.team, teams]);

  return (
    <FilterChip
      label="Team"
      valueSummary={selectedLabel}
      onClear={() => patch({ team: null })}
    >
      <SingleOptionList
        options={options}
        selected={raw.team}
        onSelect={(id) => patch({ team: id })}
        searchPlaceholder="Search teams…"
      />
    </FilterChip>
  );
}

function RequesterChip({ raw, patch }: { raw: RawFilters; patch: PatchFn }) {
  const [query, setQuery] = useState('');
  const searchActive = query.trim().length >= 2;
  const browse = usePersons();
  const search = usePersonsSearch(searchActive ? query.trim() : '');
  const selected = usePerson(raw.requester && !searchActive ? raw.requester : null);

  const results: Person[] = searchActive ? search.data ?? [] : browse.data ?? [];
  const options = results.map((p) => ({
    id: p.id,
    label: personFullName(p),
    sublabel: p.email ?? undefined,
  }));

  const selectedLabel = useMemo(() => {
    if (!raw.requester) return null;
    const hit =
      (browse.data ?? []).find((p) => p.id === raw.requester) ??
      (search.data ?? []).find((p) => p.id === raw.requester) ??
      selected.data ??
      null;
    return hit ? personFullName(hit) : 'Selected';
  }, [raw.requester, browse.data, search.data, selected.data]);

  return (
    <FilterChip
      label="Requester"
      valueSummary={selectedLabel}
      onClear={() => patch({ requester: null })}
      popoverClassName="min-w-[300px]"
    >
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search by name or email…" value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
            {searchActive ? 'No people found.' : 'Type to search for more.'}
          </CommandEmpty>
          <CommandGroup>
            {options.map((opt) => {
              const checked = raw.requester === opt.id;
              return (
                <CommandItem
                  key={opt.id}
                  value={`${opt.label} ${opt.sublabel ?? ''}`}
                  onSelect={() => patch({ requester: opt.id })}
                  className="py-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{opt.label}</span>
                    {opt.sublabel && (
                      <span className="truncate text-xs text-muted-foreground">{opt.sublabel}</span>
                    )}
                  </div>
                  {checked && <CheckIcon className="h-4 w-4 text-foreground" />}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </FilterChip>
  );
}

function flattenSpaces(nodes: SpaceTreeNode[], path: string[] = []): Array<{ id: string; label: string; sublabel: string }> {
  const out: Array<{ id: string; label: string; sublabel: string }> = [];
  for (const node of nodes) {
    const nextPath = [...path, node.name];
    out.push({
      id: node.id,
      label: node.name,
      sublabel: path.length ? path.join(' › ') : node.type,
    });
    if (node.children?.length) out.push(...flattenSpaces(node.children, nextPath));
  }
  return out;
}

function LocationChip({ raw, patch }: { raw: RawFilters; patch: PatchFn }) {
  const { data: tree } = useSpaceTree();
  const options = useMemo(() => (tree ? flattenSpaces(tree) : []), [tree]);
  const selectedLabel = useMemo(() => {
    if (!raw.location) return null;
    const hit = options.find((o) => o.id === raw.location);
    return hit?.label ?? 'Selected';
  }, [raw.location, options]);

  return (
    <FilterChip
      label="Location"
      valueSummary={selectedLabel}
      onClear={() => patch({ location: null })}
      popoverClassName="min-w-[300px] max-h-[360px]"
    >
      <SingleOptionList
        options={options}
        selected={raw.location}
        onSelect={(id) => patch({ location: id })}
        searchPlaceholder="Search locations…"
      />
    </FilterChip>
  );
}

function SlaChip({ raw, patch }: { raw: RawFilters; patch: PatchFn }) {
  const options = [
    { id: 'at_risk', label: 'SLA at risk' },
    { id: 'breached', label: 'SLA breached' },
  ];
  const selectedLabel = options.find((o) => o.id === raw.sla)?.label ?? null;
  return (
    <FilterChip
      label="SLA"
      valueSummary={selectedLabel}
      onClear={() => patch({ sla: null })}
    >
      <SingleOptionList
        options={options}
        selected={raw.sla}
        onSelect={(id) => patch({ sla: id })}
        searchPlaceholder="Filter SLA…"
      />
    </FilterChip>
  );
}

function KindChip({ raw, patch }: { raw: RawFilters; patch: PatchFn }) {
  const options = [
    { id: 'case', label: 'Cases' },
    { id: 'work_order', label: 'Work orders' },
  ];
  const selectedLabel = options.find((o) => o.id === raw.kind)?.label ?? null;
  return (
    <FilterChip
      label="Type"
      valueSummary={selectedLabel}
      onClear={() => patch({ kind: null })}
    >
      <SingleOptionList
        options={options}
        selected={raw.kind}
        onSelect={(id) => patch({ kind: id })}
        searchPlaceholder="Filter type…"
      />
    </FilterChip>
  );
}

type PatchFn = (next: Partial<Record<keyof RawFilters, string | string[] | null>>) => void;

export interface TicketFilterBarProps {
  raw: RawFilters;
  patch: PatchFn;
  currentUserId: string | null;
  activeCount: number;
  onClearAll: () => void;
}

export function TicketFilterBar({
  raw,
  patch,
  currentUserId,
  activeCount,
  onClearAll,
}: TicketFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
      <StatusChip raw={raw} patch={patch} />
      <PriorityChip raw={raw} patch={patch} />
      <AssigneeChip raw={raw} patch={patch} currentUserId={currentUserId} />
      <TeamChip raw={raw} patch={patch} />
      <RequesterChip raw={raw} patch={patch} />
      <LocationChip raw={raw} patch={patch} />
      <SlaChip raw={raw} patch={patch} />
      <KindChip raw={raw} patch={patch} />
      {activeCount > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearAll}
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
        >
          <XIcon className="h-3 w-3" />
          Clear all
        </Button>
      )}
    </div>
  );
}
