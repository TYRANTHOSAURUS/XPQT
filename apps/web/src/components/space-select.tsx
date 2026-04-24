import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSpaces } from '@/api/spaces';
export type { Space } from '@/api/spaces';

interface SpaceSelectProps {
  value: string;
  onChange: (id: string) => void;
  /** Restrict to specific space types (e.g. ['site', 'building']). Empty/omitted = no filter. */
  typeFilter?: string[];
  /** Placeholder shown when no value is selected. */
  placeholder?: string;
  /** Label for the empty option. Set to null to hide the empty option entirely. */
  emptyLabel?: string | null;
  /** Optional id for accessibility wiring. */
  id?: string;
  className?: string;
}

export function SpaceSelect({
  value,
  onChange,
  typeFilter,
  placeholder = 'Select a location...',
  emptyLabel = 'No location',
  id,
  className,
}: SpaceSelectProps) {
  const { data: spaces } = useSpaces();

  const options = (spaces ?? []).filter(
    (s) => !typeFilter || typeFilter.length === 0 || typeFilter.includes(s.type),
  );

  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? '')}>
      <SelectTrigger id={id} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {emptyLabel !== null && <SelectItem value="">{emptyLabel}</SelectItem>}
        {options.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name} ({s.type})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
