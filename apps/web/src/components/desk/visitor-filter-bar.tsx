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
import { useSpaces } from '@/api/spaces';
import { useVisitorTypes, visitorStatusLabel, type VisitorStatus } from '@/api/visitors';
import { Calendar } from '@/components/ui/calendar';
import {
  type VisitorRawFilters,
  visitorDateLabel,
} from '@/pages/desk/use-visitor-filters';

const STATUS_OPTIONS: VisitorStatus[] = [
  'expected',
  'arrived',
  'in_meeting',
  'pending_approval',
  'checked_out',
  'no_show',
  'cancelled',
];

const STATUS_DOT: Record<VisitorStatus, string> = {
  pending_approval: 'bg-amber-500',
  expected: 'bg-blue-500',
  arrived: 'bg-emerald-500',
  in_meeting: 'bg-emerald-500',
  checked_out: 'bg-muted-foreground/40',
  no_show: 'bg-rose-500',
  cancelled: 'bg-muted-foreground/40',
};

interface FilterChipProps {
  label: string;
  valueSummary?: string | null;
  onClear?: () => void;
  children: ReactNode;
  popoverClassName?: string;
}

/**
 * Mirrors the ticket FilterChip — collapsed shows "+ Label", active
 * shows "Label · summary" with a click-to-clear "×". Same visual rules
 * so the desk surfaces feel like one app.
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

type PatchFn = (
  next: Partial<Record<keyof VisitorRawFilters | 'type', string | string[] | null>>,
) => void;

function StatusChip({ raw, patch }: { raw: VisitorRawFilters; patch: PatchFn }) {
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
        ? visitorStatusLabel(raw.status[0] as VisitorStatus)
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
        labelFor={(id) => visitorStatusLabel(id as VisitorStatus)}
        leadingFor={(id) => (
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              STATUS_DOT[id as VisitorStatus] ?? 'bg-muted-foreground/30',
            )}
          />
        )}
      />
    </FilterChip>
  );
}

function BuildingChip({ raw, patch }: { raw: VisitorRawFilters; patch: PatchFn }) {
  const { data: spaces } = useSpaces();
  const buildings = useMemo(
    () =>
      (spaces ?? []).filter(
        (s) => (s.type === 'building' || s.type === 'site') && s.active !== false,
      ),
    [spaces],
  );
  const options = useMemo(
    () => buildings.map((b) => ({ id: b.id, label: b.name })),
    [buildings],
  );

  const selectedLabel = useMemo(() => {
    if (!raw.building) return null;
    const hit = buildings.find((b) => b.id === raw.building);
    return hit?.name ?? 'Selected';
  }, [raw.building, buildings]);

  return (
    <FilterChip
      label="Building"
      valueSummary={selectedLabel}
      onClear={() => patch({ building: null })}
    >
      <SingleOptionList
        options={options}
        selected={raw.building}
        onSelect={(id) => patch({ building: id })}
        searchPlaceholder="Search buildings…"
      />
    </FilterChip>
  );
}

function VisitorTypeChip({ raw, patch }: { raw: VisitorRawFilters; patch: PatchFn }) {
  const { data: types } = useVisitorTypes();
  const options = useMemo(
    () => (types ?? []).filter((t) => t.active !== false).map((t) => ({ id: t.id, label: t.display_name })),
    [types],
  );

  const selectedLabel = useMemo(() => {
    if (!raw.visitorType) return null;
    const hit = (types ?? []).find((t) => t.id === raw.visitorType);
    return hit?.display_name ?? 'Selected';
  }, [raw.visitorType, types]);

  return (
    <FilterChip
      label="Visitor type"
      valueSummary={selectedLabel}
      onClear={() => patch({ type: null })}
    >
      <SingleOptionList
        options={options}
        selected={raw.visitorType}
        onSelect={(id) => patch({ type: id })}
        searchPlaceholder="Search types…"
      />
    </FilterChip>
  );
}

function DateChip({ raw, patch }: { raw: VisitorRawFilters; patch: PatchFn }) {
  const [open, setOpen] = useState(false);
  const isActive = Boolean(raw.date);
  const summary = visitorDateLabel(raw.date);

  const selected = useMemo(() => {
    if (!raw.date) return undefined;
    if (raw.date === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
    if (raw.date === 'tomorrow') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() + 1);
      return d;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw.date)) {
      const [yyyy, mm, dd] = raw.date.split('-').map(Number);
      return new Date(yyyy, mm - 1, dd);
    }
    return undefined;
  }, [raw.date]);

  const onPick = (d: Date | undefined) => {
    if (!d) return;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    patch({ date: `${yyyy}-${mm}-${dd}` });
    setOpen(false);
  };

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
            {isActive ? 'Date' : '+ Date'}
          </span>
          {isActive && summary && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="truncate max-w-[140px]">{summary}</span>
            </>
          )}
          {!isActive && <ChevronDownIcon className="h-3 w-3 opacity-60" />}
        </PopoverTrigger>
        {isActive && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              patch({ date: null });
            }}
            aria-label="Clear date"
            className="flex items-center justify-center border-l border-primary/30 px-1.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <XIcon className="h-3 w-3" />
          </button>
        )}
      </div>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex flex-col gap-1 p-2">
          <button
            type="button"
            className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            onClick={() => {
              patch({ date: 'today' });
              setOpen(false);
            }}
          >
            Today
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            onClick={() => {
              patch({ date: 'tomorrow' });
              setOpen(false);
            }}
          >
            Tomorrow
          </button>
        </div>
        <div className="border-t">
          <Calendar mode="single" selected={selected} onSelect={onPick} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface VisitorFilterBarProps {
  raw: VisitorRawFilters;
  patch: PatchFn;
  activeCount: number;
  onClearAll: () => void;
}

export function VisitorFilterBar({ raw, patch, activeCount, onClearAll }: VisitorFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
      <DateChip raw={raw} patch={patch} />
      <StatusChip raw={raw} patch={patch} />
      <BuildingChip raw={raw} patch={patch} />
      <VisitorTypeChip raw={raw} patch={patch} />
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
