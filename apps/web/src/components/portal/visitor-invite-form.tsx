/**
 * VisitorInviteForm — host-facing invite form.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6.1
 *
 * Reused in two surfaces:
 *  - `mode='standalone'` — the full form on `/portal/visitors/invite`
 *    AND inside the +Invite dialog on `/desk/visitors`.
 *  - `mode='composer'`   — a slim variant inside the booking composer's
 *    "Visitors" section. Building / meeting room / time fields are hidden
 *    because the parent booking dictates them.
 *
 * Progressive disclosure for the 80% case (rebuild round, 2026-05-02):
 * the default visible field set is just the visitor's name, email, and
 * when they're expected. Phone, company, type, building, room, expected-
 * until, co-hosts, and notes all fold behind a "More options" expander.
 *
 * Smart defaults that do the work for hosts:
 *   - visitor_type_id  = first active "Guest" type (seeded default)
 *   - building_id      = host's persons.default_location_id (when set);
 *                        else first authorized building.
 *   - expected_at      = next round 30-minute boundary from now
 *   - expected_until   = expected_at + visitor_type's offset (auto, hidden)
 *
 * Form composition follows CLAUDE.md mandatory rules: every label+control
 * is a `<Field>`; no hand-rolled grid+gap; helper text via FieldDescription;
 * inline validation via FieldError.
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { InlineBanner } from '@/components/ui/inline-banner';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Send,
  Settings2,
  X,
} from 'lucide-react';
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
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { useQueryClient } from '@tanstack/react-query';

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
 *  shape minus the booking-derived fields (filled in by the wrapper).
 *
 *  Co-hosts carry both id + label so a re-opened draft renders human names
 *  instead of bare UUIDs (the picker only resolves labels at selection
 *  time; without persisting them we'd have to re-fetch each one). */
export interface CapturedVisitorValues {
  first_name: string;
  last_name?: string;
  email: string;
  phone?: string;
  company?: string;
  visitor_type_id: string;
  co_host_persons?: Array<{ id: string; label: string }>;
  notes_for_visitor?: string;
  notes_for_reception?: string;
}

export type VisitorInviteFormProps =
  | {
      mode: 'standalone';
      defaults?: VisitorInviteFormDefaults;
      onSuccess: (visitorId: string) => void;
      onCancel: () => void;
      submitLabel?: string;
      initial?: CapturedVisitorValues;
    }
  | {
      mode: 'composer';
      defaults?: VisitorInviteFormDefaults;
      onCapture: (values: CapturedVisitorValues) => void;
      onCancel: () => void;
      submitLabel?: string;
      initial?: CapturedVisitorValues;
    };

// ─── Helpers ───────────────────────────────────────────────────────────────

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

/** ISO → date-input value `YYYY-MM-DD` (local). */
function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** ISO → time-input value `HH:mm` (local). */
function isoToTimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

function combineDateTime(date: string, time: string): string {
  if (!date || !time) return '';
  const [yyyy, mm, dd] = date.split('-').map(Number);
  const [hh, mi] = time.split(':').map(Number);
  const d = new Date(yyyy, mm - 1, dd, hh, mi, 0, 0);
  return d.toISOString();
}

function localInputToIso(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

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

function isFallbackTypeId(id: string): boolean {
  return id.startsWith('__fallback_');
}

/** Read the host's default building from the React Query cache without
 *  forcing a subscription. The portal layout populates `['portal', 'me']`
 *  with a payload containing `default_location.id`. We peek at the
 *  cache so the form can boot with a sensible default without firing
 *  another network request. Outside the portal layout (e.g. inside the
 *  desk's invite dialog) the cache will be empty — that's fine, the
 *  caller passes `defaults.building_id` explicitly. */
function usePortalDefaultBuildingId(): string | undefined {
  const qc = useQueryClient();
  const data = qc.getQueryData(['portal', 'me']) as
    | { default_location?: { id?: string } | null }
    | undefined;
  return data?.default_location?.id;
}

// ─── Component ─────────────────────────────────────────────────────────────

export function VisitorInviteForm(props: VisitorInviteFormProps) {
  const { mode, defaults, onCancel } = props;
  const submitLabel =
    props.submitLabel ?? (mode === 'composer' ? 'Add to booking' : 'Send invite');
  const initial = 'initial' in props ? props.initial : undefined;

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

  const portalDefaultBuildingId = usePortalDefaultBuildingId();

  const createInvitation = useCreateInvitation();

  // ─── Form state ──────────────────────────────────────────────────────────

  const [firstName, setFirstName] = useState(initial?.first_name ?? '');
  const [lastName, setLastName] = useState(initial?.last_name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [company, setCompany] = useState(initial?.company ?? '');
  const [visitorTypeId, setVisitorTypeId] = useState<string>(initial?.visitor_type_id ?? '');
  const [expectedAt, setExpectedAt] = useState<string>(
    defaults?.expected_at ?? defaultExpectedAt(),
  );
  const [expectedUntil, setExpectedUntil] = useState<string>('');
  const [buildingId, setBuildingId] = useState<string>(
    defaults?.building_id ?? portalDefaultBuildingId ?? '',
  );
  const meetingRoomId = defaults?.meeting_room_id ?? '';
  const [coHosts, setCoHosts] = useState<Array<{ id: string; label: string }>>(
    initial?.co_host_persons ?? [],
  );
  const [coHostDraft, setCoHostDraft] = useState<string>('');
  const [coHostDraftPerson, setCoHostDraftPerson] = useState<Person | null>(null);
  const [notesForVisitor, setNotesForVisitor] = useState(initial?.notes_for_visitor ?? '');
  const [notesForReception, setNotesForReception] = useState(initial?.notes_for_reception ?? '');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Default the visitor type to "Guest" once types load.
  useEffect(() => {
    if (visitorTypeId) return;
    const guest = visitorTypes.find((t) => t.type_key === 'guest');
    if (guest) setVisitorTypeId(guest.id);
    else if (visitorTypes.length > 0) setVisitorTypeId(visitorTypes[0].id);
  }, [visitorTypes, visitorTypeId]);

  // Default the building if we couldn't read one from the portal cache.
  useEffect(() => {
    if (buildingId) return;
    if (buildings.length > 0) setBuildingId(buildings[0].id);
  }, [buildings, buildingId]);

  // Re-derive `expected_until` whenever expected_at OR visitor type
  // changes, but only if the user hasn't manually edited it.
  useEffect(() => {
    if (touched['expected_until']) return;
    if (!expectedAt || !visitorTypeId) return;
    const vt = visitorTypes.find((t) => t.id === visitorTypeId);
    const offsetMin = vt?.default_expected_until_offset_minutes ?? 60;
    setExpectedUntil(addMinutes(expectedAt, offsetMin));
  }, [expectedAt, visitorTypeId, visitorTypes, touched]);

  // ─── Validation ─────────────────────────────────────────────────────────

  const isFallback = visitorTypeId ? isFallbackTypeId(visitorTypeId) : false;
  const selectedType = visitorTypes.find((t) => t.id === visitorTypeId) ?? null;

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
    if (!canSubmit) {
      // If the More-options collapse is closed but the invalid field
      // lives inside it, expand it so the user can see the error.
      const inAdvanced =
        errors.visitor_type_id || errors.building_id || errors.expected_at;
      if (inAdvanced && !showAdvanced) setShowAdvanced(true);

      const firstInvalid = errors.first_name
        ? 'visitor-first-name'
        : errors.email
          ? 'visitor-email'
          : errors.expected_at
            ? 'visitor-when'
            : errors.visitor_type_id
              ? 'visitor-type'
              : errors.building_id
                ? 'visitor-building'
                : null;
      if (firstInvalid) {
        // Defer focus to the next tick so the collapse expand has time
        // to mount the field before we focus it.
        setTimeout(() => {
          const el = document.getElementById(firstInvalid);
          if (el instanceof HTMLElement) el.focus();
        }, 0);
      }
      return;
    }

    const coHostIds = coHosts.map((c) => c.id);
    const captured: CapturedVisitorValues = {
      first_name: firstName.trim(),
      last_name: lastName.trim() || undefined,
      email: email.trim(),
      phone: phone.trim() || undefined,
      company: company.trim() || undefined,
      visitor_type_id: visitorTypeId,
      co_host_persons: coHosts.length > 0 ? coHosts : undefined,
      notes_for_visitor: notesForVisitor.trim() || undefined,
      notes_for_reception: notesForReception.trim() || undefined,
    };

    if (mode === 'composer') {
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

    const { co_host_persons: _drop, ...capturedForApi } = captured;
    void _drop;
    const payload: CreateInvitationPayload = {
      ...capturedForApi,
      co_host_person_ids: coHostIds.length > 0 ? coHostIds : undefined,
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

  // Date + time atoms for the DateTimePicker. The picker takes its own
  // pair so we keep it as derived state.
  const expectedDate = isoToDateInput(expectedAt);
  const expectedTime = isoToTimeInput(expectedAt);

  const requiresApproval = Boolean(selectedType?.requires_approval);

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {isFallback && (
        <InlineBanner tone="warning" icon={AlertTriangle} role="status">
          Visitor types couldn't be loaded for your account. Ask your admin to
          enable visitor types for hosts, or send invites from an admin
          session in the meantime.
        </InlineBanner>
      )}

      <FieldGroup>
        {/* The 80% case — name, email, when. Everything else folds.
         *
         *  Two fully-labeled Field rows side-by-side instead of one Field
         *  with two inputs in a div — every input gets its own clickable
         *  label, fixing the "last name has no label" a11y miss. */}
        <FieldSet>
          <FieldLegend variant="label">Visitor name</FieldLegend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="visitor-first-name">First name</FieldLabel>
              <Input
                id="visitor-first-name"
                placeholder="e.g. Jane…"
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
                placeholder="e.g. Smith…"
                autoComplete="off"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </Field>
          </div>
        </FieldSet>

        <Field>
          <FieldLabel htmlFor="visitor-email">Email</FieldLabel>
          <Input
            id="visitor-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            aria-invalid={!!errors.email && touched.email}
          />
          {touched.email && errors.email && <FieldError>{errors.email}</FieldError>}
        </Field>

        {mode === 'standalone' && (
          <Field>
            <FieldLabel htmlFor="visitor-when">When</FieldLabel>
            <DateTimePicker
              id="visitor-when"
              date={expectedDate}
              time={expectedTime}
              onDateChange={(d) =>
                setExpectedAt(combineDateTime(d, expectedTime || '09:00'))
              }
              onTimeChange={(t) =>
                setExpectedAt(combineDateTime(expectedDate, t))
              }
            />
            {touched.expected_at && errors.expected_at && (
              <FieldError>{errors.expected_at}</FieldError>
            )}
          </Field>
        )}

        {/* Approval banner — only when the chosen visitor type requires it. */}
        {requiresApproval && (
          <InlineBanner tone="info" icon={AlertTriangle}>
            This visitor type requires manager approval before it's sent. The
            invite will sit in pending approval until your approver acts.
          </InlineBanner>
        )}

        {/* More options — phone / company / type / building / room /
            expected-until / co-hosts / notes. */}
        <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
          <CollapsibleTrigger
            render={
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              />
            }
          >
            <Settings2 className="size-3.5" aria-hidden />
            {showAdvanced ? 'Fewer options' : 'More options'}
            {showAdvanced ? (
              <ChevronUp className="size-3.5" aria-hidden />
            ) : (
              <ChevronDown className="size-3.5" aria-hidden />
            )}
          </CollapsibleTrigger>
          <CollapsibleContent
            className="overflow-hidden h-[var(--collapsible-panel-height)] [transition:height_220ms_var(--ease-smooth),opacity_220ms_var(--ease-smooth)] data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0"
          >
            <FieldSeparator className="my-4" />
            <FieldGroup>
              <FieldSet>
                <FieldLegend>Contact</FieldLegend>
                <Field>
                  <FieldLabel htmlFor="visitor-phone">Phone</FieldLabel>
                  <Input
                    id="visitor-phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="off"
                    spellCheck={false}
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
              </FieldSet>

              <FieldSeparator />

              <FieldSet>
                <FieldLegend>Visit</FieldLegend>
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
                      <SelectValue
                        placeholder={typesLoading ? 'Loading…' : 'Pick a visitor type'}
                      />
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

                {mode === 'standalone' && (
                  <>
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
                          <SelectValue
                            placeholder={spacesLoading ? 'Loading…' : 'Pick a building'}
                          />
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

                    <Field>
                      <FieldLabel htmlFor="visitor-expected-until">
                        Expected until
                      </FieldLabel>
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
                        Auto-derived from the visitor type. Override if you know
                        better.
                      </FieldDescription>
                    </Field>
                  </>
                )}
              </FieldSet>

              <FieldSeparator />

              <FieldSet>
                <FieldLegend>Other hosts</FieldLegend>
                <FieldDescription>
                  Add coworkers who should also be notified when the visitor
                  arrives.
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
                </Field>
              </FieldSet>

              <FieldSeparator />

              <FieldSet>
                <FieldLegend>Notes</FieldLegend>
                <Field>
                  <FieldLabel htmlFor="visitor-notes-visitor">
                    Notes for the visitor
                  </FieldLabel>
                  <Textarea
                    id="visitor-notes-visitor"
                    className="min-h-[80px]"
                    value={notesForVisitor}
                    onChange={(e) => setNotesForVisitor(e.target.value)}
                    placeholder="Anything they need to know — entrance, parking, who to ask for…"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="visitor-notes-reception">
                    Notes for reception
                  </FieldLabel>
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
          </CollapsibleContent>
        </Collapsible>
      </FieldGroup>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onCancel} disabled={createInvitation.isPending}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={!canSubmit}>
          <Send className="mr-2 size-4" aria-hidden />
          {createInvitation.isPending ? 'Sending…' : submitLabel}
        </Button>
      </div>
    </div>
  );
}
