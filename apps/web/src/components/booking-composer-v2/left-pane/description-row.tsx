import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

export interface DescriptionRowProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Free-text description. 2–3 visible rows, `resize-none`, capped at
 * `max-h` so the modal doesn't grow unboundedly.
 */
export function DescriptionRow({ value, onChange }: DescriptionRowProps) {
  return (
    <Field>
      <FieldLabel htmlFor="bcm-description" className="text-xs text-muted-foreground">
        Description
      </FieldLabel>
      <Textarea
        id="bcm-description"
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Add agenda, links, or context"
        className="min-h-[64px] max-h-[160px] resize-none text-sm"
      />
    </Field>
  );
}
