import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { allowedChildTypes, type SpaceType } from '@prequest/shared';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from './space-type-icon';

interface SpaceTypePickerProps {
  /** The parent's type, or `null` for tenant root. Constrains the options. */
  parentType: SpaceType | null;
  value: SpaceType | '';
  onChange: (type: SpaceType) => void;
  id?: string;
  disabled?: boolean;
}

export function SpaceTypePicker({ parentType, value, onChange, id, disabled }: SpaceTypePickerProps) {
  const options = allowedChildTypes(parentType);
  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => v && onChange(v as SpaceType)}
      disabled={disabled || options.length === 0}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder={options.length === 0 ? 'No child types allowed' : 'Select a type'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((t) => (
          <SelectItem key={t} value={t}>
            <div className="flex items-center gap-2">
              <SpaceTypeIcon type={t} />
              <span>{SPACE_TYPE_LABELS[t]}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
