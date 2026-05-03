import { VisitorsSection } from '@/components/booking-composer/sections/visitors-section';
import type { VisitorInviteFormDefaults } from '@/components/portal/visitor-invite-form';
import type { PendingVisitor } from '@/components/booking-composer/state';

export interface VisitorsRowProps {
  visitors: PendingVisitor[];
  bookingDefaults: VisitorInviteFormDefaults;
  disabled?: boolean;
  disabledReason?: string;
  onAdd: (visitor: PendingVisitor) => void;
  onUpdate: (visitor: PendingVisitor) => void;
  onRemove: (localId: string) => void;
}

/**
 * v1 visitors section on the redesign's left pane. Delegates fully to the
 * legacy `<VisitorsSection>` which already ships the visitor list, chip
 * presentation, "+ Add a visitor" affordance, and the VisitorInviteForm
 * Dialog. That component also owns the `disabledReason` display — no need
 * to duplicate it here.
 *
 * Per the spec, visitor host defaults to the booking host —
 * `<VisitorInviteForm>` already handles this via `bookingDefaults`.
 */
export function VisitorsRow({
  visitors,
  bookingDefaults,
  disabled,
  disabledReason,
  onAdd,
  onUpdate,
  onRemove,
}: VisitorsRowProps) {
  return (
    <VisitorsSection
      visitors={visitors}
      bookingDefaults={bookingDefaults}
      disabled={disabled}
      disabledReason={disabledReason}
      onAdd={onAdd}
      onUpdate={onUpdate}
      onRemove={onRemove}
    />
  );
}
