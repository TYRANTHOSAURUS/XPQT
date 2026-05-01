/**
 * VisitorInviteForm — host-facing invite form.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6.1
 *
 * Reused in two surfaces:
 *  - `mode='standalone'` — the full form on `/portal/visitors/invite`.
 *  - `mode='composer'`   — a slim variant inside the booking composer's
 *    "Visitors" section. Building / meeting room / time fields are hidden
 *    because the parent booking dictates them.
 *
 * Form composition follows CLAUDE.md mandatory rules: every label+control
 * is a `<Field>`; no hand-rolled grid+gap; helper text via FieldDescription;
 * inline validation via FieldError.
 *
 * Submission goes through the React Query mutation in `@/api/visitors`,
 * which invalidates the host's expected list on success.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { InlineBanner } from '@/components/ui/inline-banner';
import { AlertTriangle, Send, X } from 'lucide-react';
import {
  DEFAULT_VISITOR_TYPES,
  useCreateInvitation,
  useVisitorTypes,
  type CreateInvitationPayload,
  type VisitorType,
} from '@/api/visitors';
import { useSpaces } from '@/api/spaces';
import { PersonPicker, type Person } from '@/components/person-picker';
import { toastError } from '@/lib/toast';

// ─── Props ─────────────────────────────────────────────────────────────────

export interface VisitorInviteFormDefaults {
  expected_at?: string;
  expected_until?: string;
  building_id?: string;
  meeting_room_id?: string | null;
  booking_bundle_id?: string;
  reservation_id?: string;
}

/** Captured-only payload the composer's queue keeps locally before flushing
 *  to the backend after the booking lands. Mirrors the standalone request
 *  shape minus the booking-derived fields (filled in by the wrapper). */
export interface CapturedVisitorValues {
  first_name: string;
  last_name?: string;
  email: string;
  phone?: string;
  company?: string;
  visitor_type_id: string;
  co_host_person_ids?: string[];
  notes_for_visitor?: string;
  notes_for_reception?: string;
}

export type VisitorInviteFormProps =
  | {
      /** Full form on /portal/visitors/invite. Submits via React Query
       *  mutation; the caller is told only the new visitor_id on success. */
      mode: 'standalone';
      defaults?: VisitorInviteFormDefaults;
      onSuccess: (visitorId: string) => void;
      onCancel: () => void;
      submitLabel?: string;
      /** Optional initial values when re-opening for edit (rare in
       *  standalone). */
      initial?: CapturedVisitorValues;
    }
  | {
      /** Composer-mode: time + building + meeting-room are derived from
       *  the parent booking; the form does NOT submit a network request
       *  — it returns the captured values via `onCapture` so the composer
       *  can flush after the booking lands. */
      mode: 'composer';
      defaults?: VisitorInviteFormDefaults;
      onCapture: (values: CapturedVisitorValues) => void;
      onCancel: () => void;
      submitLabel?: string;
      initial?: CapturedVisitorValues;
    };

// ─── Helpers ───────────────────────────────────────────────────────────────

/** "Next round 30 minutes from now + 1 hour duration" — the spec's default. */
function defaultExpectedAt(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  const add = 30 - (d.getMinutes() % 30);
  d.setMinutes(d.getMinutes() + (add === 0 ? 30 : add));
  return d.toISOString();
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/** Convert an ISO string to the `value` format the native datetime-local
 *  input expects (`YYYY-MM-DDTHH:mm`, local time). */
function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function localInputToIso(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function isFallbackTypeId(id: string): boolean {
  return id.startsWith('__fallback_');
}

// ─── Component ─────────────────────────────────────────────────────────────

export function VisitorInviteForm(props: VisitorInviteFormProps) {
  const { mode, defaults, onCancel } = props;
  const submitLabel = props.submitLabel ?? (mode === 'composer' ? 'Add to booking' : 'Send invite');
  const initial = 'initial' in props ? props.initial : undefined;

  // Server data — visitor types + spaces (filtered to buildings client-side
  // so we don't need a new admin endpoint).
  const { data: visitorTypesRaw, isLoading: typesLoading } = useVisitorTypes();
  const { data: spaces, isLoading: spacesLoading } = useSpaces();

  const visitorTypes = useMemo<VisitorType[]>(
    () => visitorTypesRaw ?? DEFAULT_VISITOR_TYPES,
    [visitorTypesRaw],
  );
  const buildings = useMemo(
    () => (spaces ?? []).filter((s) => s.type === 'building' || s.type === 'site'),
    [spaces],
  );

  const createInvitation = useCreateInvitation();

  // ─── Form state ──────────────────────────────────────────────────────────

  const [firstName, setFirstName] = useState(initial?.first_name ?? '');
  const [lastName, setLastName] = useState(initial?.last_name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [company, setCompany] = useState(initial?.company ?? '');
  const [visitorTypeId, setVisitorTypeId] = useState<string>(initial?.visitor_type_id ?? '');
  const [expectedAt, setExpectedAt] = useState<string>(defaults?.expected_at ?? defaultExpectedAt());
  const [expectedUntil, setExpectedUntil] = useState<string>('');
  const [buildingId, setBuildingId] = useState<string>(defaults?.building_id ?? '');
  // v1: meeting room is auto-inherited from the parent booking in composer
  // mode and not asked for in standalone mode (the freeform UUID input was
  // user-hostile). v2 will reintroduce a proper room picker bound to the
  // selected building.
  const meetingRoomId = defaults?.meeting_room_id ?? '';
  // Co-hosts are kept locally as {id, label} so the chips can render the
  // person's name without re-querying. We project to ids on submit because
  // the API contract is `co_host_person_ids: string[]`.
  const [coHosts, setCoHosts] = useState<Array<{ id: string; label: string }>>(
    initial?.co_host_person_ids?.map((id) => ({ id, label: id })) ?? [],
  );
  const [coHostDraft, setCoHostDraft] = useState<string>('');
  const [coHostDraftPerson, setCoHostDraftPerson] = useState<Person | null>(null);
  const [notesForVisitor, setNotesForVisitor] = useState(initial?.notes_for_visitor ?? '');
  const [notesForReception, setNotesForReception] = useState(initial?.notes_for_reception ?? '');
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Default the visitor type to "Guest" once types load.
  useEffect(() => {
    if (visitorTypeId) return;
    const guest = visitorTypes.find((t) => t.type_key === 'guest');
    if (guest) setVisitorTypeId(guest.id);
    else if (visitorTypes.length > 0) setVisitorTypeId(visitorTypes[0].id);
  }, [visitorTypes, visitorTypeId]);

  // Re-derive `expected_until` whenever expected_at OR visitor type changes,
  // but only if the user hasn't manually edited it. Keep this as one ref-less
  // derivation — touch tracking via the `touched` map signals whether to
  // overwrite.
  useEffect(() => {
    if (touched['expected_until']) return;
    if (!expectedAt || !visitorTypeId) return;
    const vt = visitorTypes.find((t) => t.id === visitorTypeId);
    const offsetMin = vt?.default_expected_until_offset_minutes ?? 60;
    setExpectedUntil(addMinutes(expectedAt, offsetMin));
  }, [expectedAt, visitorTypeId, visitorTypes, touched]);

  // ─── Validation ─────────────────────────────────────────────────────────

  const isFallback = visitorTypeId ? isFallbackTypeId(visitorTypeId) : false;

  const errors = useMemo(() => {
    const e: Record<string, string> = {};
    if (!firstName.trim()) e.first_name = 'First name is required.';
    if (!email.trim()) e.email = 'Email is required.';
    else if (!/.+@.+\..+/.test(email)) e.email = 'Enter a valid email address.';
    if (!visitorTypeId) e.visitor_type_id = 'Pick a visitor type.';
    else if (isFallback) {
      e.visitor_type_id =
        "Visitor types couldn't be loaded — ask your admin to share access to /admin/visitors/types.";
    }
    if (mode === 'standalone') {
      if (!expectedAt) e.expected_at = 'Pick an expected arrival time.';
      if (!buildingId) e.building_id = 'Pick a building.';
    }
    return e;
  }, [firstName, email, visitorTypeId, expectedAt, buildingId, mode, isFallback]);

  const canSubmit =
    Object.keys(errors).length === 0 && !createInvitation.isPending;

  // ─── Submit ─────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    setTouched({
      first_name: true,
      email: true,
      visitor_type_id: true,
      expected_at: true,
      expected_until: true,
      building_id: true,
    });
    if (!canSubmit) return;

    const coHostIds = coHosts.map((c) => c.id);
    const captured: CapturedVisitorValues = {
      first_name: firstName.trim(),
      last_name: lastName.trim() || undefined,
      email: email.trim(),
      phone: phone.trim() || undefined,
      company: company.trim() || undefined,
      visitor_type_id: visitorTypeId,
      co_host_person_ids: coHostIds.length > 0 ? coHostIds : undefined,
      notes_for_visitor: notesForVisitor.trim() || undefined,
      notes_for_reception: notesForReception.trim() || undefined,
    };

    if (mode === 'composer') {
      // Queue-only — no network. Composer flushes after the booking lands.
      props.onCapture(captured);
      return;
    }

    const finalBuildingId = buildingId;
    const finalExpectedAt = expectedAt;
    const finalExpectedUntil = expectedUntil;
    const finalMeetingRoom = meetingRoomId;

    if (!finalBuildingId || !finalExpectedAt) {
      toastError("Couldn't send the invite", {
        description: 'Pick a building and an expected arrival time first.',
      });
      return;
    }

    const payload: CreateInvitationPayload = {
      ...captured,
      expected_at: finalExpectedAt,
      expected_until: finalExpectedUntil || undefined,
      building_id: finalBuildingId,
      meeting_room_id: finalMeetingRoom || undefined,
      booking_bundle_id: defaults?.booking_bundle_id,
      reservation_id: defaults?.reservation_id,
    };

    try {
      const res = await createInvitation.mutateAsync(payload);
      props.onSuccess(res.visitor_id);
    } catch (err) {
      // Cross-building scope (403) and 422 validation get surfaced as toasts
      // — field-level errors live in the form already. The retry button
      // re-runs the same submission.
      const status = (err as { status?: number })?.status;
      if (status === 403) {
        toastError("You don't have access to invite at this building", {
          description: 'Contact your admin to extend your location grants.',
        });
      } else {
        toastError("Couldn't send the invite", { error: err, retry: handleSubmit });
      }
    }
  };

  const handleAddCoHost = () => {
    if (!coHostDraft || coHosts.some((c) => c.id === coHostDraft)) return;
    const label = coHostDraftPerson
      ? `${coHostDraftPerson.first_name ?? ''} ${coHostDraftPerson.last_name ?? ''}`.trim() ||
        coHostDraftPerson.email ||
        coHostDraft
      : coHostDraft;
    setCoHosts((prev) => [...prev, { id: coHostDraft, label }]);
    setCoHostDraft('');
    setCoHostDraftPerson(null);
  };

  const handleRemoveCoHost = (id: string) => {
    setCoHosts((prev) => prev.filter((p) => p.id !== id));
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6">
      {isFallback && (
        <InlineBanner tone="warning" icon={AlertTriangle} role="status">
          Visitor types couldn't be loaded for your account. Ask your admin to
          enable visitor types for hosts, or send invites from an admin
          session in the meantime.
        </InlineBanner>
      )}

      <FieldGroup>
        <FieldSet>
          <FieldLegend>Visitor</FieldLegend>
          <FieldDescription>
            Who's coming. We'll email this person an invite with the meeting
            details.
          </FieldDescription>

          <Field>
            <FieldLabel htmlFor="visitor-first-name">First name</FieldLabel>
            <Input
              id="visitor-first-name"
              autoComplete="off"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, first_name: true }))}
              aria-invalid={!!errors.first_name && touched.first_name}
            />
            {touched.first_name && errors.first_name && (
              <FieldError>{errors.first_name}</FieldError>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="visitor-last-name">Last name</FieldLabel>
            <Input
              id="visitor-last-name"
              autoComplete="off"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="visitor-email">Email</FieldLabel>
            <Input
              id="visitor-email"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              aria-invalid={!!errors.email && touched.email}
            />
            <FieldDescription>
              The visitor receives the invite at this address.
            </FieldDescription>
            {touched.email && errors.email && <FieldError>{errors.email}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="visitor-phone">Phone</FieldLabel>
            <Input
              id="visitor-phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="visitor-company">Company</FieldLabel>
            <Input
              id="visitor-company"
              autoComplete="off"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="visitor-type">Visitor type</FieldLabel>
            <Select
              value={visitorTypeId}
              onValueChange={(v) => {
                setVisitorTypeId(v ?? '');
                setTouched((t) => ({ ...t, visitor_type_id: true }));
              }}
              disabled={typesLoading}
            >
              <SelectTrigger id="visitor-type">
                <SelectValue placeholder={typesLoading ? 'Loading…' : 'Pick a visitor type'} />
              </SelectTrigger>
              <SelectContent>
                {visitorTypes.map((t) => (
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
        </FieldSet>

        {mode === 'standalone' && (
          <>
            <FieldSeparator />
            <FieldSet>
              <FieldLegend>When &amp; where</FieldLegend>
              <FieldDescription>
                Reception uses this to expect the visitor and direct them to
                the right place.
              </FieldDescription>

              <Field>
                <FieldLabel htmlFor="visitor-expected-at">Expected at</FieldLabel>
                <Input
                  id="visitor-expected-at"
                  type="datetime-local"
                  value={isoToLocalInput(expectedAt)}
                  onChange={(e) => {
                    const iso = localInputToIso(e.target.value);
                    if (iso) setExpectedAt(iso);
                  }}
                  onBlur={() => setTouched((t) => ({ ...t, expected_at: true }))}
                  aria-invalid={!!errors.expected_at && touched.expected_at}
                />
                {touched.expected_at && errors.expected_at && (
                  <FieldError>{errors.expected_at}</FieldError>
                )}
              </Field>

              <Field>
                <FieldLabel htmlFor="visitor-expected-until">Expected until</FieldLabel>
                <Input
                  id="visitor-expected-until"
                  type="datetime-local"
                  value={isoToLocalInput(expectedUntil)}
                  onChange={(e) => {
                    const iso = localInputToIso(e.target.value);
                    if (iso) {
                      setExpectedUntil(iso);
                      setTouched((t) => ({ ...t, expected_until: true }));
                    }
                  }}
                />
                <FieldDescription>
                  Defaults to the visitor type's typical visit length.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="visitor-building">Building</FieldLabel>
                <Select
                  value={buildingId}
                  onValueChange={(v) => {
                    setBuildingId(v ?? '');
                    setTouched((t) => ({ ...t, building_id: true }));
                  }}
                  disabled={spacesLoading}
                >
                  <SelectTrigger id="visitor-building">
                    <SelectValue placeholder={spacesLoading ? 'Loading…' : 'Pick a building'} />
                  </SelectTrigger>
                  <SelectContent>
                    {buildings.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  You can only pick buildings you have access to invite at.
                </FieldDescription>
                {touched.building_id && errors.building_id && (
                  <FieldError>{errors.building_id}</FieldError>
                )}
              </Field>

              {/* v1: meeting room is intentionally not a freeform input here.
                   In composer mode the room is auto-inherited from the
                   parent booking via `defaults.meeting_room_id`. v2 will
                   bring a proper room picker for standalone invites; until
                   then reception directs the visitor on arrival. */}
            </FieldSet>
          </>
        )}

        <FieldSeparator />

        <FieldSet>
          <FieldLegend>Other hosts</FieldLegend>
          <FieldDescription>
            Add coworkers who should also be notified when the visitor arrives.
          </FieldDescription>

          {coHosts.length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Selected co-hosts">
              {coHosts.map((c) => (
                <li
                  key={c.id}
                  className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-xs"
                >
                  <span>{c.label}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveCoHost(c.id)}
                    aria-label={`Remove co-host ${c.label}`}
                    className="-mr-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <Field>
            <FieldLabel htmlFor="visitor-co-host">Add a co-host</FieldLabel>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <PersonPicker
                  value={coHostDraft}
                  onChange={setCoHostDraft}
                  onSelect={(p) => setCoHostDraftPerson(p)}
                  placeholder="Search by name or email…"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddCoHost}
                disabled={!coHostDraft || coHosts.some((c) => c.id === coHostDraft)}
              >
                Add
              </Button>
            </div>
            <FieldDescription>
              Up to 20 co-hosts. Each gets the same arrival notification you do.
            </FieldDescription>
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend>Notes</FieldLegend>
          <FieldDescription>
            Optional. Notes for the visitor go in the email; notes for
            reception are only seen by reception staff.
          </FieldDescription>

          <Field>
            <FieldLabel htmlFor="visitor-notes-visitor">Notes for the visitor</FieldLabel>
            <Textarea
              id="visitor-notes-visitor"
              className="min-h-[80px]"
              value={notesForVisitor}
              onChange={(e) => setNotesForVisitor(e.target.value)}
              placeholder="Anything they need to know — entrance, parking, who to ask for…"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="visitor-notes-reception">Notes for reception</FieldLabel>
            <Textarea
              id="visitor-notes-reception"
              className="min-h-[80px]"
              value={notesForReception}
              onChange={(e) => setNotesForReception(e.target.value)}
              placeholder="Internal note for the front desk."
            />
          </Field>
        </FieldSet>
      </FieldGroup>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel} disabled={createInvitation.isPending}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          <Send className="size-4 mr-2" aria-hidden />
          {createInvitation.isPending ? 'Sending…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
