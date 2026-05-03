import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { defaultTitle } from '../booking-draft';

export interface TitleInputProps {
  value: string;
  onChange: (next: string) => void;
  hostFirstName: string | null;
  roomName: string | null;
}

/**
 * The title input on the left pane. Placeholder updates live to
 * `"{Host first}'s {Room name} booking"` once both are known. Per the
 * spec, what-you-see-is-what-you-get — submitting blank uses the
 * placeholder string.
 */
export function TitleInput({
  value,
  onChange,
  hostFirstName,
  roomName,
}: TitleInputProps) {
  const placeholder = defaultTitle({ hostFirstName, roomName });
  return (
    <Field>
      <FieldLabel htmlFor="bcm-title" className="sr-only">
        Title
      </FieldLabel>
      <Input
        id="bcm-title"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 border-transparent bg-transparent px-2 text-base font-medium shadow-none focus-visible:border-ring"
      />
    </Field>
  );
}
