import { CalendarIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useSpaces, type Space } from '@/api/spaces';
import { formatShortDate } from '@/lib/format';
import { isoDaysAgo, todayIso } from '../format';

interface FilterValue {
  from: string;
  to: string;
  buildingId: string | null;
}

interface Props {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
}

const PRESETS: Array<{ id: '7d' | '30d' | '90d'; label: string; days: number }> = [
  { id: '7d',  label: 'Last 7 days',  days: 7  },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
];

function detectPreset(value: FilterValue): '7d' | '30d' | '90d' | 'custom' {
  if (value.to !== todayIso()) return 'custom';
  for (const p of PRESETS) {
    if (value.from === isoDaysAgo(p.days)) return p.id;
  }
  return 'custom';
}

export function BookingsFilterBar({ value, onChange }: Props) {
  const { data: spaces } = useSpaces();
  const buildings: Space[] = (spaces ?? []).filter((s) => s.type === 'building');
  const preset = detectPreset(value);

  const fromDate = new Date(value.from + 'T00:00:00');
  const toDate   = new Date(value.to   + 'T00:00:00');

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        multiple={false}
        value={preset === 'custom' ? [] : [preset]}
        onValueChange={(v) => {
          const id = v[0] as '7d' | '30d' | '90d' | undefined;
          if (!id) return;
          const days = PRESETS.find((p) => p.id === id)!.days;
          onChange({ ...value, from: isoDaysAgo(days), to: todayIso() });
        }}
        variant="outline"
        size="sm"
      >
        {PRESETS.map((p) => (
          <ToggleGroupItem key={p.id} value={p.id} aria-label={p.label}>
            {p.label.replace('Last ', '')}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Popover>
        <PopoverTrigger
          render={
            <Button variant="outline" size="sm" className="gap-2">
              <CalendarIcon className="size-4" />
              {formatShortDate(fromDate)}
              {' – '}
              {formatShortDate(toDate)}
            </Button>
          }
        />
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            selected={{ from: fromDate, to: toDate }}
            onSelect={(range) => {
              if (range?.from && range?.to) {
                onChange({
                  ...value,
                  from: range.from.toISOString().slice(0, 10),
                  to:   range.to.toISOString().slice(0, 10),
                });
              }
            }}
            numberOfMonths={2}
          />
        </PopoverContent>
      </Popover>

      <Select
        value={value.buildingId ?? '__all'}
        onValueChange={(v) => onChange({ ...value, buildingId: v === '__all' ? null : v })}
      >
        <SelectTrigger size="sm" className="w-[180px]">
          <SelectValue placeholder="All buildings" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All buildings</SelectItem>
          {buildings.map((b) => (
            <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
