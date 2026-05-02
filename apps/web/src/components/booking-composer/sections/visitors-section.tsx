/**
 * Visitors section for the booking composer.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6.2
 *
 * Shows pending visitor invitations attached to the booking-in-progress.
 * Visitors are NOT POSTed at click-time — they're queued in the composer's
 * local state and flushed by the wrapper after the booking lands so the
 * invitation can carry the canonical `booking_id` (00278:41) back for
 * cascade-on-cancel.
 *
 * Hidden by the parent composer when the booking has no building anchor
 * (visitors need a building) or when the user lacks `visitors:invite`.
 *
 * The "+ Add" affordance opens VisitorInviteForm in `composer` mode inside
 * a Dialog — keeps the parent composer's main state intact while the user
 * fills the visitor details.
 */
import { useState } from 'react';
import { Plus, UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  FieldDescription,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  VisitorInviteForm,
  type CapturedVisitorValues,
  type VisitorInviteFormDefaults,
} from '@/components/portal/visitor-invite-form';
import type { PendingVisitor } from '../state';

export interface VisitorsSectionProps {
  visitors: PendingVisitor[];
  /** Inherited from the parent booking — drives the form defaults so the
   *  composer-mode form doesn't ask the user to re-enter time / building. */
  bookingDefaults: VisitorInviteFormDefaults;
  /** Disabled until the booking has a building (visitors need a building
   *  anchor). The parent composer also hides this section entirely when
   *  the user lacks the visitors:invite permission. */
  disabled?: boolean;
  disabledReason?: string;
  onAdd: (visitor: PendingVisitor) => void;
  onUpdate: (visitor: PendingVisitor) => void;
  onRemove: (localId: string) => void;
}

/** Local-only id for a pending visitor before the composer flushes it to
 *  the backend (which then assigns the real UUID). Using crypto.randomUUID
 *  avoids collisions when two composers are open in the same tab —
 *  important because React keys + local-state lookups depend on these. */
function nextLocalId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pv_${crypto.randomUUID()}`;
  }
  // Fallback for very old browsers — composer usage requires modern UAs
  // anyway; this only protects against test/SSR paths without crypto.
  return `pv_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function capturedFromPending(p: PendingVisitor): CapturedVisitorValues {
  return {
    first_name: p.first_name,
    last_name: p.last_name,
    email: p.email,
    phone: p.phone,
    company: p.company,
    visitor_type_id: p.visitor_type_id,
    co_host_persons: p.co_host_persons,
    notes_for_visitor: p.notes_for_visitor,
    notes_for_reception: p.notes_for_reception,
  };
}

export function VisitorsSection({
  visitors,
  bookingDefaults,
  disabled,
  disabledReason,
  onAdd,
  onUpdate,
  onRemove,
}: VisitorsSectionProps) {
  const [editing, setEditing] = useState<PendingVisitor | null>(null);
  const [open, setOpen] = useState(false);

  const handleOpenForAdd = () => {
    setEditing(null);
    setOpen(true);
  };

  const handleOpenForEdit = (v: PendingVisitor) => {
    setEditing(v);
    setOpen(true);
  };

  return (
    <>
      <FieldSet>
        <FieldLegend variant="label">Visitors</FieldLegend>
        <FieldDescription>
          Pre-register people coming for this meeting so reception expects
          them.
        </FieldDescription>

        {visitors.length > 0 && (
          <ul className="flex flex-col divide-y rounded-md border bg-card">
            {visitors.map((v) => (
              <li
                key={v.local_id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => handleOpenForEdit(v)}
                  className="flex min-w-0 flex-1 flex-col items-start text-left transition-colors hover:text-primary"
                >
                  <span className="text-sm font-medium truncate">
                    {[v.first_name, v.last_name].filter(Boolean).join(' ')}
                    {v.company ? ` (${v.company})` : ''}
                  </span>
                  <span className="text-xs text-muted-foreground truncate">
                    {v.email}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(v.local_id)}
                  aria-label={`Remove visitor ${v.first_name}`}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleOpenForAdd}
          disabled={disabled}
          className="self-start"
        >
          {visitors.length === 0 ? (
            <>
              <UserPlus className="size-4 mr-2" aria-hidden />
              Add a visitor
            </>
          ) : (
            <>
              <Plus className="size-4 mr-2" aria-hidden />
              Add another
            </>
          )}
        </Button>
        {disabled && disabledReason && (
          <FieldDescription>{disabledReason}</FieldDescription>
        )}
      </FieldSet>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit visitor' : 'Add a visitor'}</DialogTitle>
            <DialogDescription>
              The booking's date, time, and building are inherited.
            </DialogDescription>
          </DialogHeader>
          <VisitorInviteForm
            mode="composer"
            defaults={bookingDefaults}
            submitLabel={editing ? 'Save visitor' : 'Add to booking'}
            initial={editing ? capturedFromPending(editing) : undefined}
            onCapture={(values: CapturedVisitorValues) => {
              const local: PendingVisitor = {
                local_id: editing?.local_id ?? nextLocalId(),
                ...values,
              };
              if (editing) onUpdate(local);
              else onAdd(local);
              setOpen(false);
              setEditing(null);
            }}
            onCancel={() => {
              setOpen(false);
              setEditing(null);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
