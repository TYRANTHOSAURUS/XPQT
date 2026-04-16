import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface EscalationThreshold {
  at_percent: number;
  action: 'notify' | 'escalate';
  notify: string;
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
  const [newEscPercent, setNewEscPercent] = useState('80');
  const [newEscAction, setNewEscAction] = useState<'notify' | 'escalate'>('notify');
  const [newEscNotify, setNewEscNotify] = useState('');

  const resetForm = () => {
    setName('');
    setResponseHours('');
    setResolutionHours('');
    setCalendarId('');
    setPauseReasons(['requester', 'vendor', 'scheduled_work']);
    setEscalations([]);
    setNewEscPercent('80');
    setNewEscAction('notify');
    setNewEscNotify('');
    setEditId(null);
  };

  const togglePauseReason = (val: string) => {
    setPauseReasons((prev) => prev.includes(val) ? prev.filter((r) => r !== val) : [...prev, val]);
  };

  const addEscalation = () => {
    const pct = parseInt(newEscPercent);
    if (!pct || pct < 1 || pct > 200) return;
    setEscalations((prev) => [
      ...prev,
      { at_percent: pct, action: newEscAction, notify: newEscNotify },
    ].sort((a, b) => a.at_percent - b.at_percent));
    setNewEscPercent('80');
    setNewEscNotify('');
  };

  const removeEscalation = (idx: number) => {
    setEscalations((prev) => prev.filter((_, i) => i !== idx));
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
    if (editId) {
      await apiFetch(`/sla-policies/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiFetch('/sla-policies', { method: 'POST', body: JSON.stringify(body) });
    }
    resetForm();
    setDialogOpen(false);
    refetch();
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
            </DialogHeader>
            <div className="space-y-4 mt-2 max-h-[70vh] overflow-y-auto pr-1">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard, High Priority, Critical..." />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Response target (hours)</Label>
                  <Input type="number" step="0.5" value={responseHours} onChange={(e) => setResponseHours(e.target.value)} placeholder="e.g. 4" />
                </div>
                <div className="space-y-2">
                  <Label>Resolution target (hours)</Label>
                  <Input type="number" step="0.5" value={resolutionHours} onChange={(e) => setResolutionHours(e.target.value)} placeholder="e.g. 24" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Business Hours Calendar</Label>
                <Select value={calendarId} onValueChange={(v) => setCalendarId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="None (always on)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None (always on)</SelectItem>
                    {(calendars ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name} ({c.time_zone})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Pause conditions</Label>
                <div className="space-y-2">
                  {pauseReasonOptions.map((opt) => (
                    <div key={opt.value} className="flex items-center gap-2">
                      <Checkbox
                        checked={pauseReasons.includes(opt.value)}
                        onCheckedChange={() => togglePauseReason(opt.value)}
                      />
                      <Label className="font-normal">{opt.label}</Label>
                    </div>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label>Escalation Thresholds</Label>
                {escalations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No escalation thresholds.</p>
                ) : (
                  <div className="space-y-1">
                    {escalations.map((e, i) => (
                      <div key={i} className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/40 text-sm">
                        <span>At {e.at_percent}% → <span className="capitalize">{e.action}</span>{e.notify ? ` ${e.notify}` : ''}</span>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeEscalation(i)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-end pt-1">
                  <div className="space-y-1 w-20">
                    <Label className="text-xs">At %</Label>
                    <Input type="number" value={newEscPercent} onChange={(e) => setNewEscPercent(e.target.value)} className="h-8 text-sm" />
                  </div>
                  <div className="space-y-1 w-28">
                    <Label className="text-xs">Action</Label>
                    <Select value={newEscAction} onValueChange={(v) => setNewEscAction((v ?? 'notify') as 'notify' | 'escalate')}>
                      <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="notify">Notify</SelectItem>
                        <SelectItem value="escalate">Escalate</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1 flex-1">
                    <Label className="text-xs">Notify (email/name)</Label>
                    <Input value={newEscNotify} onChange={(e) => setNewEscNotify(e.target.value)} className="h-8 text-sm" placeholder="optional" />
                  </div>
                  <Button variant="outline" size="sm" onClick={addEscalation}>Add</Button>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={!name.trim()}>
                  {editId ? 'Save' : 'Create'}
                </Button>
              </div>
            </div>
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
          {loading && (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No SLA policies yet.</TableCell></TableRow>
          )}
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
