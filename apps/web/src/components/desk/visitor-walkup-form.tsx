/**
 * Walk-up quick-add form, inline on `/reception/today`.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7.4
 *
 * Sized for the 9am rush:
 *   - Minimal field set (first name + host + visitor type) is all that's
 *     required; everything else is optional and folded behind a "More
 *     details" toggle.
 *   - Submit clears + refocuses the first input — batch-entry mode for
 *     reception staff processing one walk-up after another.
 *   - Backdated arrival via a small native time input (HH:mm) — defaults
 *     to "now" but reception can correct ("walked in at 09:15, logged at
 *     09:42").
 *
 * NOT a modal — renders inline above the visitor list so reception's
 * focus never leaves the today-view.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PersonPicker } from '@/components/person-picker';
import { useVisitorTypes, DEFAULT_VISITOR_TYPES } from '@/api/visitors';
import {
  useQuickAddWalkup,
  type QuickAddWalkupPayload,
} from '@/api/visitors/reception';
import { toastError, toastCreated } from '@/lib/toast';

interface WalkupFormProps {
  buildingId: string;
  onClose: () => void;
}

/** "Now" formatted as HH:mm for the time input default. */
function nowLocalTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Combine an HH:mm input with today's date into an ISO timestamp. */
function localTimeToIso(hhmm: string): string | undefined {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return undefined;
  const [hh, mi] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(hh, mi, 0, 0);
  return d.toISOString();
}

export function WalkupForm({ buildingId, onClose }: WalkupFormProps) {
  const { data: visitorTypesRaw, isLoading: typesLoading } = useVisitorTypes();
  const visitorTypes = visitorTypesRaw ?? DEFAULT_VISITOR_TYPES;
  // Walk-ups are blocked on types where allow_walk_up=false or
  // requires_approval=true (per spec §7.4 / Q3 lock D). Filter the picker
  // so reception never sees an option that the backend will reject.
  const walkupTypes = visitorTypes.filter(
    (t) => (t.allow_walk_up ?? true) && !(t.requires_approval ?? false),
  );

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [company, setCompany] = useState('');
  const [hostId, setHostId] = useState('');
  const [visitorTypeId, setVisitorTypeId] = useState('');
  const [arrivedAt, setArrivedAt] = useState(nowLocalTime());
  const [showMore, setShowMore] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const focusFirstInput = () => {
    const el = document.getElementById('walkup-first-name');
    if (el instanceof HTMLInputElement) el.focus();
  };

  const quickAdd = useQuickAddWalkup(buildingId);

  // Default to "Guest" once types load.
  useEffect(() => {
    if (visitorTypeId) return;
    const guest = walkupTypes.find((t) => t.type_key === 'guest');
    if (guest) setVisitorTypeId(guest.id);
    else if (walkupTypes.length > 0) setVisitorTypeId(walkupTypes[0].id);
  }, [walkupTypes, visitorTypeId]);

  // Autofocus the first name input on mount so reception can start typing.
  useEffect(() => {
    focusFirstInput();
  }, []);

  const errors: Record<string, string> = {};
  if (!firstName.trim()) errors.first_name = 'First name is required.';
  if (!hostId) errors.host = 'Pick the host.';
  if (!visitorTypeId) errors.visitor_type_id = 'Pick a visitor type.';
  // The fallback ids (`__fallback_*`) come from a non-admin host's degraded
  // type list — they will 400 on submit, so block client-side too.
  if (visitorTypeId.startsWith('__fallback_')) {
    errors.visitor_type_id =
      "Visitor types couldn't be loaded — ask an admin to grant /admin/visitors/types access.";
  }

  const canSubmit = Object.keys(errors).length === 0 && !quickAdd.isPending;

  const handleSubmit = async () => {
    setTouched({
      first_name: true,
      host: true,
      visitor_type_id: true,
    });
    if (!canSubmit) {
      // Focus the first invalid field so the receptionist's eyes (and
      // the screen reader) land on the actual problem instead of just
      // seeing the submit button stay disabled.
      const firstInvalid = errors.first_name
        ? 'walkup-first-name'
        : errors.host
          ? null // PersonPicker doesn't expose a stable id; the error message under the field carries the cue.
          : errors.visitor_type_id
            ? 'walkup-type'
            : null;
      if (firstInvalid) {
        const el = document.getElementById(firstInvalid);
        if (el instanceof HTMLElement) el.focus();
      }
      return;
    }

    const payload: QuickAddWalkupPayload = {
      first_name: firstName.trim(),
      last_name: lastName.trim() || undefined,
      company: company.trim() || undefined,
      visitor_type_id: visitorTypeId,
      primary_host_person_id: hostId,
      arrived_at: localTimeToIso(arrivedAt),
    };

    try {
      await quickAdd.mutateAsync(payload);
      toastCreated('Walk-up visitor');
      // Batch-entry: keep the form open, clear name fields, refocus first.
      setFirstName('');
      setLastName('');
      setCompany('');
      setHostId('');
      setArrivedAt(nowLocalTime());
      setTouched({});
      focusFirstInput();
    } catch (err) {
      toastError("Couldn't add the walk-up", { error: err, retry: handleSubmit });
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-medium">Add walk-up visitor</div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label="Close walk-up form"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      {/* Override FieldGroup's default vertical flex with a 2-up grid on
           wider viewports — the walk-up rush UX wants a tight pair of
           columns rather than a tall stack. FieldGroup accepts className
           for exactly this case (per the shadcn Field primitive). */}
      <FieldGroup className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="walkup-first-name">First name</FieldLabel>
          <Input
            id="walkup-first-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, first_name: true }))}
            autoComplete="off"
            aria-invalid={!!errors.first_name && touched.first_name}
          />
          {touched.first_name && errors.first_name && (
            <FieldError>{errors.first_name}</FieldError>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="walkup-last-name">Last name</FieldLabel>
          <Input
            id="walkup-last-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="walkup-host">Host</FieldLabel>
          <PersonPicker
            value={hostId}
            onChange={(id) => {
              setHostId(id);
              setTouched((t) => ({ ...t, host: true }));
            }}
            placeholder="Search by name or email…"
          />
          {touched.host && errors.host && <FieldError>{errors.host}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor="walkup-type">Visitor type</FieldLabel>
          <Select
            value={visitorTypeId}
            onValueChange={(v) => {
              setVisitorTypeId(v ?? '');
              setTouched((t) => ({ ...t, visitor_type_id: true }));
            }}
            disabled={typesLoading}
          >
            <SelectTrigger id="walkup-type">
              <SelectValue
                placeholder={typesLoading ? 'Loading…' : 'Pick a visitor type'}
              />
            </SelectTrigger>
            <SelectContent>
              {walkupTypes.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.display_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {touched.visitor_type_id && errors.visitor_type_id && (
            <FieldError>{errors.visitor_type_id}</FieldError>
          )}
        </Field>

        {showMore && (
          <>
            <Field>
              <FieldLabel htmlFor="walkup-company">Company</FieldLabel>
              <Input
                id="walkup-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="walkup-arrived">Actually arrived at</FieldLabel>
              <Input
                id="walkup-arrived"
                type="time"
                value={arrivedAt}
                onChange={(e) => setArrivedAt(e.target.value)}
                step={60}
              />
              <FieldDescription>
                Defaults to now. Backdate if they walked in earlier.
              </FieldDescription>
            </Field>
          </>
        )}
      </FieldGroup>

      <div className="mt-4 flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowMore((v) => !v)}
        >
          {showMore ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          {showMore ? 'Less' : 'More details'}
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} disabled={quickAdd.isPending}>
            Done
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {quickAdd.isPending ? 'Adding…' : 'Add walk-up'}
          </Button>
        </div>
      </div>
    </div>
  );
}
