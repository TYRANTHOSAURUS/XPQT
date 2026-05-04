import { Field, FieldLabel } from '@/components/ui/field';
import { PersonPicker } from '@/components/person-picker';

export interface HostRowProps {
  hostPersonId: string | null;
  onHostChange: (id: string | null) => void;
  /**
   * Kept on the prop type so the modal can pass `mode` for future use
   * (e.g. host-validation rules that differ in operator mode). The
   * legacy "Booking for" picker that lived here in operator mode moved
   * to the modal header on 2026-05-04 — see booking-composer-modal.tsx.
   */
  mode: 'self' | 'operator';
}

/**
 * Host picker for the left pane. Single field — the requester ("Booking
 * for") is now in the modal header, not in the body, so operator mode
 * and self mode render the same row here.
 */
export function HostRow({
  hostPersonId,
  onHostChange,
}: HostRowProps) {
  return (
    <Field>
      <FieldLabel htmlFor="bcm-host" className="text-xs text-muted-foreground">
        Host
      </FieldLabel>
      <PersonPicker
        value={hostPersonId}
        onChange={(id) => onHostChange(id || null)}
        excludeId={null}
        placeholder="Meeting host"
      />
    </Field>
  );
}
