import { useId, useMemo, useState } from 'react';
import { Play, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSpaces } from '@/api/spaces';
import { usePersons } from '@/api/persons';
import {
  useCreateRoomBookingScenario,
  useRoomBookingScenarios,
  useRunRoomBookingScenario,
  useSimulateRoomBookingRule,
  type BookingScenario,
  type SimulationResult,
} from '@/api/room-booking-rules';
import { cn } from '@/lib/utils';

interface RuleTestScenarioPanelProps {
  ruleId: string;
}

/**
 * Saved-scenario picker + Run + ad-hoc scenario builder. Shows the simulation
 * result (final outcome + per-rule trace + denial messages) inline.
 *
 * Two run paths:
 *  - Saved scenario → POST /room-booking-simulation-scenarios/:id/run
 *  - Ad-hoc scenario → POST /room-booking-rules/simulate (with current rule + scenario)
 */
export function RuleTestScenarioPanel({ ruleId: _ruleId }: RuleTestScenarioPanelProps) {
  const { data: scenarios } = useRoomBookingScenarios();
  const [selectedId, setSelectedId] = useState<string>('');
  const [adhoc, setAdhoc] = useState<BookingScenario>(() => ({
    requester_person_id: '',
    space_id: '',
    start_at: defaultStart(),
    end_at: defaultEnd(),
    attendee_count: 4,
  }));
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);

  const runSaved = useRunRoomBookingScenario();
  const simulate = useSimulateRoomBookingRule();

  const selectedScenario = useMemo(
    () => (scenarios ?? []).find((s) => s.id === selectedId) ?? null,
    [scenarios, selectedId],
  );

  const handleRunSaved = () => {
    if (!selectedScenario) return;
    runSaved.mutate(selectedScenario.id, {
      onSuccess: (res) => setResult(res),
      onError: (err) => toast.error(err.message || 'Run failed'),
    });
  };

  const handleRunAdhoc = () => {
    simulate.mutate(
      { scenario: adhoc },
      {
        onSuccess: (res) => setResult(res),
        onError: (err) => toast.error(err.message || 'Run failed'),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <SavedScenarioRow
        scenarios={scenarios ?? []}
        value={selectedId}
        onChange={setSelectedId}
        onRun={handleRunSaved}
        running={runSaved.isPending}
      />

      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Ad-hoc scenario
        </div>
        <AdhocScenarioForm value={adhoc} onChange={setAdhoc} />
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => setSaveOpen(true)}
            disabled={!isAdhocValid(adhoc)}
          >
            <Save className="size-3.5" /> Save scenario
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={handleRunAdhoc}
            disabled={!isAdhocValid(adhoc) || simulate.isPending}
          >
            <Play className="size-3.5" />
            {simulate.isPending ? 'Running…' : 'Run'}
          </Button>
        </div>
      </div>

      {result && <SimulationResultPanel result={result} />}

      <SaveScenarioDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        scenario={adhoc}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Saved-scenario picker row                                                  */
/* -------------------------------------------------------------------------- */

interface SavedScenarioRowProps {
  scenarios: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  onRun: () => void;
  running: boolean;
}

function SavedScenarioRow({ scenarios, value, onChange, onRun, running }: SavedScenarioRowProps) {
  const id = useId();
  const empty = scenarios.length === 0;
  return (
    <div className="flex items-end gap-3">
      <Field className="flex-1">
        <FieldLabel htmlFor={id}>Saved scenario</FieldLabel>
        <Select<string>
          value={value}
          onValueChange={(v) => onChange(v ?? '')}
          disabled={empty}
        >
          <SelectTrigger id={id} className="w-full max-w-md">
            <SelectValue placeholder={empty ? 'No scenarios saved yet.' : 'Pick a scenario…'} />
          </SelectTrigger>
          <SelectContent>
            {scenarios.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          Reusable test scenarios. Save the ad-hoc scenario below to add to this list.
        </FieldDescription>
      </Field>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={onRun}
        disabled={!value || running}
      >
        <Play className="size-3.5" />
        {running ? 'Running…' : 'Run'}
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Ad-hoc scenario form                                                       */
/* -------------------------------------------------------------------------- */

interface AdhocScenarioFormProps {
  value: BookingScenario;
  onChange: (next: BookingScenario) => void;
}

function AdhocScenarioForm({ value, onChange }: AdhocScenarioFormProps) {
  const requesterId = useId();
  const spaceId = useId();
  const startId = useId();
  const endId = useId();
  const attendeeId = useId();

  const { data: persons } = usePersons();
  const { data: spaces } = useSpaces();

  const sortedPersons = useMemo(
    () => [...(persons ?? [])].sort((a, b) => personName(a).localeCompare(personName(b))),
    [persons],
  );
  const rooms = useMemo(
    () => (spaces ?? []).filter((s) => s.type === 'room' && s.active).sort((a, b) => a.name.localeCompare(b.name)),
    [spaces],
  );

  return (
    <FieldGroup>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={requesterId}>Requester</FieldLabel>
          <Select<string>
            value={value.requester_person_id}
            onValueChange={(v) => onChange({ ...value, requester_person_id: v ?? '' })}
          >
            <SelectTrigger id={requesterId} className="w-full">
              <SelectValue placeholder="Pick a person…" />
            </SelectTrigger>
            <SelectContent>
              {sortedPersons.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {personName(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={spaceId}>Room</FieldLabel>
          <Select<string>
            value={value.space_id}
            onValueChange={(v) => onChange({ ...value, space_id: v ?? '' })}
          >
            <SelectTrigger id={spaceId} className="w-full">
              <SelectValue placeholder="Pick a room…" />
            </SelectTrigger>
            <SelectContent>
              {rooms.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor={startId}>Start</FieldLabel>
          <Input
            id={startId}
            type="datetime-local"
            value={toLocalInput(value.start_at)}
            onChange={(e) => onChange({ ...value, start_at: fromLocalInput(e.target.value) })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={endId}>End</FieldLabel>
          <Input
            id={endId}
            type="datetime-local"
            value={toLocalInput(value.end_at)}
            onChange={(e) => onChange({ ...value, end_at: fromLocalInput(e.target.value) })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={attendeeId}>Attendees</FieldLabel>
          <Input
            id={attendeeId}
            type="number"
            min={0}
            inputMode="numeric"
            value={value.attendee_count ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value);
              onChange({ ...value, attendee_count: Number.isFinite(n) ? n : null });
            }}
            className="w-[140px]"
          />
        </Field>
      </div>
    </FieldGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* Result panel                                                               */
/* -------------------------------------------------------------------------- */

function SimulationResultPanel({ result }: { result: SimulationResult }) {
  const tone =
    result.final_outcome === 'allow'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
      : result.final_outcome === 'deny'
        ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
        : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300';

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-card p-3">
      <div className={cn('flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm', tone)}>
        <span className="font-medium">Outcome: {labelOutcome(result.final_outcome)}</span>
        <Badge variant="outline" className="bg-background/50">
          {result.rule_evaluations.filter((r) => r.fired).length} of{' '}
          {result.rule_evaluations.length} rules fired
        </Badge>
      </div>

      {result.explain_text && (
        <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-line">
          {result.explain_text}
        </div>
      )}

      {result.denial_messages.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Denial messages
          </div>
          <ul className="flex flex-col gap-1">
            {result.denial_messages.map((m, i) => (
              <li key={i} className="rounded-md border bg-background p-2 text-sm">
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.rule_evaluations.length > 0 && (
        <div className="flex flex-col rounded-md border bg-background overflow-hidden">
          <div className="border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Per-rule trace
          </div>
          <ul className="flex flex-col divide-y">
            {result.rule_evaluations.map((row, i) => (
              <li
                key={`${row.rule_id ?? 'inline'}-${i}`}
                className="flex items-start justify-between gap-3 px-3 py-2"
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium">{row.rule_name}</span>
                  {row.reason && (
                    <span className="text-xs text-muted-foreground">{row.reason}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={row.fired ? 'default' : 'secondary'} className="h-5 px-1.5 text-[10px]">
                    {row.fired ? 'fired' : 'skipped'}
                  </Badge>
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                    {row.effect}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Save scenario dialog                                                        */
/* -------------------------------------------------------------------------- */

function SaveScenarioDialog({
  open,
  onOpenChange,
  scenario,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  scenario: BookingScenario;
}) {
  const nameId = useId();
  const descId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useCreateRoomBookingScenario();

  const reset = () => {
    setName('');
    setDescription('');
  };

  const handleSave = () => {
    create.mutate(
      { name: name.trim(), description: description.trim() || null, scenario },
      {
        onSuccess: () => {
          toast.success('Scenario saved');
          reset();
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message || 'Save failed'),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Save scenario</DialogTitle>
          <DialogDescription>
            Reuse this scenario across rules. The full booking input is captured — including the
            requester, room, time window, and attendee count.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            <Input
              id={nameId}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Off-hours booking by exec"
              autoFocus
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={descId}>Description</FieldLabel>
            <Input
              id={descId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || create.isPending}>
            {create.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* utils                                                                       */
/* -------------------------------------------------------------------------- */

function labelOutcome(outcome: string): string {
  switch (outcome) {
    case 'allow':
      return 'Allowed';
    case 'deny':
      return 'Denied';
    case 'require_approval':
      return 'Requires approval';
    default:
      return outcome;
  }
}

function isAdhocValid(s: BookingScenario): boolean {
  return Boolean(s.requester_person_id && s.space_id && s.start_at && s.end_at);
}

function defaultStart(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d.toISOString();
}

function defaultEnd(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 2);
  return d.toISOString();
}

/** Convert ISO to value for `<input type="datetime-local" />`. */
function toLocalInput(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 16);
}

function fromLocalInput(local: string): string {
  if (!local) return '';
  return new Date(local).toISOString();
}

interface PersonLike {
  id: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

function personName(p: PersonLike): string {
  const full = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
  return full || p.email || p.id;
}
