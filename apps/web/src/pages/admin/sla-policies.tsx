import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { SlaThresholdRow, isThresholdValid } from '@/components/admin/sla-threshold-row';

export type ThresholdTimerScope = 'response' | 'resolution' | 'both';
export type ThresholdAction = 'notify' | 'escalate';
export type ThresholdTargetType = 'user' | 'team' | 'manager_of_requester';

export interface EscalationThreshold {
  at_percent: number;
  timer_type: ThresholdTimerScope;
  action: ThresholdAction;
  target_type: ThresholdTargetType;
  target_id: string | null;
}

interface SlaPolicy {
  id: string;
  name: string;
  response_time_minutes: number | null;
  resolution_time_minutes: number | null;
  business_hours_calendar_id: string | null;
  pause_on_waiting_reasons: string[] | null;
  escalation_thresholds: EscalationThreshold[] | null;
  active: boolean;
}

interface BusinessHoursCalendar {
  id: string;
  name: string;
  time_zone: string;
}

function formatMinutes(mins: number | null): string {
  if (mins === null || mins === undefined) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const pauseReasonOptions = [
  { value: 'requester', label: 'Waiting on requester' },
  { value: 'vendor', label: 'Waiting on vendor' },
  { value: 'scheduled_work', label: 'Scheduled work' },
];

export function SlaPoliciesPage() {
  const { data, loading, refetch } = useApi<SlaPolicy[]>('/sla-policies', []);
  const { data: calendars } = useApi<BusinessHoursCalendar[]>('/business-hours', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [responseHours, setResponseHours] = useState('');
  const [resolutionHours, setResolutionHours] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [pauseReasons, setPauseReasons] = useState<string[]>(['requester', 'vendor', 'scheduled_work']);
  const [escalations, setEscalations] = useState<EscalationThreshold[]>([]);

  const resetForm = () => {
    setName('');
    setResponseHours('');
    setResolutionHours('');
    setCalendarId('');
    setPauseReasons(['requester', 'vendor', 'scheduled_work']);
    setEscalations([]);
    setEditId(null);
  };

  const togglePauseReason = (val: string) => {
    setPauseReasons((prev) => prev.includes(val) ? prev.filter((r) => r !== val) : [...prev, val]);
  };

  const addThreshold = () => {
    setEscalations((prev) => [
      ...prev,
      {
        at_percent: 100,
        timer_type: 'resolution',
        action: 'notify',
        target_type: 'user',
        target_id: null,
      },
    ]);
  };

  const updateThreshold = (index: number, next: EscalationThreshold) => {
    setEscalations((prev) => prev.map((t, i) => (i === index ? next : t)));
  };

  const removeThreshold = (index: number) => {
    setEscalations((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = {
      name,
      response_time_minutes: responseHours ? Math.round(parseFloat(responseHours) * 60) : null,
      resolution_time_minutes: resolutionHours ? Math.round(parseFloat(resolutionHours) * 60) : null,
      business_hours_calendar_id: calendarId || null,
      pause_on_waiting_reasons: pauseReasons,
      escalation_thresholds: escalations,
    };
    try {
      if (editId) {
        await apiFetch(`/sla-policies/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('SLA policy updated');
      } else {
        await apiFetch('/sla-policies', { method: 'POST', body: JSON.stringify(body) });
        toast.success('SLA policy created');
      }
      resetForm();
      setDialogOpen(false);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save SLA policy');
    }
  };

  const openEdit = (policy: SlaPolicy) => {
    setEditId(policy.id);
    setName(policy.name);
    setResponseHours(policy.response_time_minutes ? String(policy.response_time_minutes / 60) : '');
    setResolutionHours(policy.resolution_time_minutes ? String(policy.resolution_time_minutes / 60) : '');
    setCalendarId(policy.business_hours_calendar_id ?? '');
    setPauseReasons(policy.pause_on_waiting_reasons ?? []);
    setEscalations(policy.escalation_thresholds ?? []);
    setDialogOpen(true);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const getCalendarName = (id: string | null) => {
    if (!id || !calendars) return '—';
    return calendars.find((c) => c.id === id)?.name ?? '—';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SLA Policies</h1>
          <p className="text-muted-foreground mt-1">Define response and resolution time targets</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add SLA Policy
          </DialogTrigger>
          <DialogContent className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} SLA Policy</DialogTitle>
              <DialogDescription>Define response and resolution time targets for this policy.</DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-[70vh] pr-3">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="sla-name">Name</FieldLabel>
                <Input
                  id="sla-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Standard, High Priority, Critical..."
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="sla-response">Response target (hours)</FieldLabel>
                  <Input
                    id="sla-response"
                    type="number"
                    step="0.5"
                    value={responseHours}
                    onChange={(e) => setResponseHours(e.target.value)}
                    placeholder="e.g. 4"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sla-resolution">Resolution target (hours)</FieldLabel>
                  <Input
                    id="sla-resolution"
                    type="number"
                    step="0.5"
                    value={resolutionHours}
                    onChange={(e) => setResolutionHours(e.target.value)}
                    placeholder="e.g. 24"
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="sla-calendar">Business Hours Calendar</FieldLabel>
                <Select value={calendarId} onValueChange={(v) => setCalendarId(v ?? '')}>
                  <SelectTrigger id="sla-calendar"><SelectValue placeholder="None (always on)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None (always on)</SelectItem>
                    {(calendars ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name} ({c.time_zone})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <FieldSet>
                <FieldLegend variant="label">Pause conditions</FieldLegend>
                <FieldGroup data-slot="checkbox-group">
                  {pauseReasonOptions.map((opt) => (
                    <Field key={opt.value} orientation="horizontal">
                      <Checkbox
                        id={`sla-pause-${opt.value}`}
                        checked={pauseReasons.includes(opt.value)}
                        onCheckedChange={() => togglePauseReason(opt.value)}
                      />
                      <FieldLabel htmlFor={`sla-pause-${opt.value}`} className="font-normal">
                        {opt.label}
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>

              <FieldSet>
                <FieldLegend variant="label">Escalation Thresholds</FieldLegend>
                <FieldDescription>
                  Fire actions when an SLA timer reaches a percent of its target.
                </FieldDescription>
                {escalations.length === 0 ? (
                  <FieldDescription>
                    No thresholds yet. Click Add threshold to notify or reassign when a ticket nears or misses its SLA.
                  </FieldDescription>
                ) : (
                  <div className="space-y-2">
                    {escalations.map((t, i) => (
                      <SlaThresholdRow
                        key={i}
                        index={i}
                        value={t}
                        onChange={(next) => updateThreshold(i, next)}
                        onRemove={() => removeThreshold(i)}
                      />
                    ))}
                  </div>
                )}
                <Button variant="outline" size="sm" className="self-start mt-1" onClick={addThreshold}>
                  + Add threshold
                </Button>
              </FieldSet>
            </FieldGroup>
            </ScrollArea>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={handleSave}
                disabled={!name.trim() || !escalations.every(isThresholdValid)}
              >
                {editId ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[140px]">Response</TableHead>
            <TableHead className="w-[140px]">Resolution</TableHead>
            <TableHead className="w-[180px]">Calendar</TableHead>
            <TableHead className="w-[80px]">Escalations</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={6} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={6} message="No SLA policies yet." />}
          {(data ?? []).map((policy) => (
            <TableRow key={policy.id}>
              <TableCell className="font-medium">{policy.name}</TableCell>
              <TableCell>{formatMinutes(policy.response_time_minutes)}</TableCell>
              <TableCell>{formatMinutes(policy.resolution_time_minutes)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{getCalendarName(policy.business_hours_calendar_id)}</TableCell>
              <TableCell>
                {(policy.escalation_thresholds?.length ?? 0) > 0 ? (
                  <Badge variant="secondary">{policy.escalation_thresholds!.length}</Badge>
                ) : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(policy)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
