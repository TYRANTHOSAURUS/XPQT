import { Field, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

export interface DescriptionRowProps {
  value: string;
  onChange: (next: string) => void;
}

/**
 * Free-text description. Borderless / transparent / no focus ring so it
 * reads as body copy under the title — same visual treatment as the
 * ticket-detail description editor
 * (`apps/web/src/components/desk/ticket-detail.tsx:742`). The visible
 * label is dropped (placeholder + visual hierarchy makes "Description"
 * redundant); a sr-only label is kept for a11y. Min-height 80px to
 * invite typing; lets `field-sizing-content` (Textarea default) grow it
 * naturally up to the modal's max-h.
 */
export function DescriptionRow({ value, onChange }: DescriptionRowProps) {
  return (
    <Field>
      <FieldLabel htmlFor="bcm-description" className="sr-only">
        Description
      </FieldLabel>
      <Textarea
        id="bcm-description"
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Add a description"
        className="min-h-[80px] resize-none border-transparent bg-transparent px-0 py-0 text-[15px] leading-relaxed shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-[15px]"
      />
    </Field>
  );
}
