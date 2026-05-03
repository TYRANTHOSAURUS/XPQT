import { Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { PersonPicker } from '@/components/person-picker';

export interface HostRowProps {
  requesterPersonId: string | null;
  onRequesterChange: (id: string | null) => void;
  hostPersonId: string | null;
  onHostChange: (id: string | null) => void;
  mode: 'self' | 'operator';
}

/**
 * Host + (operator) Booking-for picker. In `self` mode we just show the
 * host (defaulted to caller in the modal shell). In `operator` mode we
 * additionally surface the requester picker, mirroring the legacy
 * composer's "Booking for" field.
 */
export function HostRow({
  requesterPersonId,
  onRequesterChange,
  hostPersonId,
  onHostChange,
  mode,
}: HostRowProps) {
  return (
    <>
      {mode === 'operator' && (
        <Field>
          <FieldLabel htmlFor="bcm-requester" className="text-xs text-muted-foreground">
            Booking for
          </FieldLabel>
          <PersonPicker
            value={requesterPersonId}
            onChange={(id) => onRequesterChange(id || null)}
            excludeId={null}
            placeholder="Pick a person…"
          />
          <FieldDescription>
            Their cost center, rule universe, and calendar are used.
          </FieldDescription>
        </Field>
      )}
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
    </>
  );
}
