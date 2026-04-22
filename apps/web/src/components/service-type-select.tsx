import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SERVICE_TYPES, humanize } from '@/lib/menu-constants';

interface ServiceTypeSelectProps {
  value: string;
  onChange: (value: string) => void;
  /** If true, adds an "All service types" option with empty value. */
  includeAll?: boolean;
  allLabel?: string;
  className?: string;
}

/** Reusable Select bound to the canonical SERVICE_TYPES list. */
export function ServiceTypeSelect({
  value,
  onChange,
  includeAll = false,
  allLabel = 'All service types',
  className,
}: ServiceTypeSelectProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? '')}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={includeAll ? allLabel : 'Select service...'} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && <SelectItem value="">{allLabel}</SelectItem>}
        {SERVICE_TYPES.map((s) => (
          <SelectItem key={s} value={s} className="capitalize">
            {humanize(s)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
