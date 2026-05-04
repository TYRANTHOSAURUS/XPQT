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
 *
 * Visual styling mirrors the canonical ticket-detail title editor
 * (`apps/web/src/components/desk/ticket-detail.tsx:716`): borderless,
 * transparent, no focus ring, h1-sized typography. The input owns the
 * left pane's visual hierarchy — make it look like the page title, not
 * a form control.
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
        className="h-auto border-transparent bg-transparent px-0 py-0 text-2xl font-semibold leading-tight tracking-tight shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-2xl"
      />
    </Field>
  );
}
