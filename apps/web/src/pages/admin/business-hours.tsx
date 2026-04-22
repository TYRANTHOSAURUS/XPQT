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
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { TableLoading, TableEmpty } from '@/components/table-states';

type DayKey = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

interface DayHours {
  start: string;
  end: string;
}

type WorkingHours = Record<DayKey, DayHours | null>;

interface Holiday {
  date: string;
  name: string;
  recurring: boolean;
}

interface BusinessHoursCalendar {
  id: string;
  name: string;
  time_zone: string;
  working_hours: WorkingHours;
  holidays: Holiday[];
  active: boolean;
}

const DAYS: { key: DayKey; label: string }[] = [
  { key: 'monday', label: 'Mon' },
  { key: 'tuesday', label: 'Tue' },
  { key: 'wednesday', label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday', label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
  { key: 'sunday', label: 'Sun' },
];

const TIMEZONES = [
  'UTC',
  'Europe/Amsterdam',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Tokyo',
];

const defaultWorkingHours = (): WorkingHours => ({
  monday: { start: '08:00', end: '17:00' },
  tuesday: { start: '08:00', end: '17:00' },
  wednesday: { start: '08:00', end: '17:00' },
  thursday: { start: '08:00', end: '17:00' },
  friday: { start: '08:00', end: '17:00' },
  saturday: null,
  sunday: null,
});

export function BusinessHoursPage() {
  const { data, loading, refetch } = useApi<BusinessHoursCalendar[]>('/business-hours', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [workingHours, setWorkingHours] = useState<WorkingHours>(defaultWorkingHours());
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [newHolidayDate, setNewHolidayDate] = useState('');
  const [newHolidayName, setNewHolidayName] = useState('');
  const [newHolidayRecurring, setNewHolidayRecurring] = useState(false);

  const resetForm = () => {
    setEditId(null);
    setName('');
    setTimezone('UTC');
    setWorkingHours(defaultWorkingHours());
    setHolidays([]);
    setNewHolidayDate('');
    setNewHolidayName('');
    setNewHolidayRecurring(false);
  };

  const toggleDay = (day: DayKey) => {
    setWorkingHours((prev) => ({
      ...prev,
      [day]: prev[day] ? null : { start: '08:00', end: '17:00' },
    }));
  };

  const updateDayTime = (day: DayKey, field: 'start' | 'end', value: string) => {
    setWorkingHours((prev) => ({
      ...prev,
      [day]: prev[day] ? { ...prev[day]!, [field]: value } : null,
    }));
  };

  const addHoliday = () => {
    if (!newHolidayDate || !newHolidayName.trim()) return;
    setHolidays((prev) => [...prev, { date: newHolidayDate, name: newHolidayName, recurring: newHolidayRecurring }]);
    setNewHolidayDate('');
    setNewHolidayName('');
    setNewHolidayRecurring(false);
  };

  const removeHoliday = (idx: number) => {
    setHolidays((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = { name, time_zone: timezone, working_hours: workingHours, holidays };
    try {
      if (editId) {
        await apiFetch(`/business-hours/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Calendar updated');
      } else {
        await apiFetch('/business-hours', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Calendar created');
      }
      resetForm();
      setDialogOpen(false);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save calendar');
    }
  };

  const openEdit = (cal: BusinessHoursCalendar) => {
    setEditId(cal.id);
    setName(cal.name);
    setTimezone(cal.time_zone);
    setWorkingHours(cal.working_hours ?? defaultWorkingHours());
    setHolidays(cal.holidays ?? []);
    setDialogOpen(true);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const getActiveDays = (wh: WorkingHours) =>
    DAYS.filter((d) => wh[d.key] !== null).map((d) => d.label).join(', ');

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Business Hours</h1>
          <p className="text-muted-foreground mt-1">Define working hours calendars used by SLA policies</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Calendar
          </DialogTrigger>
          <DialogContent className="sm:max-w-[580px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Business Hours Calendar</DialogTitle>
              <DialogDescription>Define working hours and holidays used by SLA policies.</DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-[72vh] pr-3">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bh-name">Name</FieldLabel>
                <Input
                  id="bh-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Standard Office Hours"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="bh-timezone">Timezone</FieldLabel>
                <Select value={timezone} onValueChange={(v) => setTimezone(v ?? 'UTC')}>
                  <SelectTrigger id="bh-timezone"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <FieldSet>
                <FieldLegend variant="label">Working Hours</FieldLegend>
                <div className="space-y-2">
                  {DAYS.map(({ key, label }) => {
                    const dayData = workingHours[key];
                    const isClosed = dayData === null;
                    return (
                      <div key={key} className="grid grid-cols-[80px_1fr_auto] items-center gap-3">
                        <FieldLabel
                          htmlFor={`bh-day-${key}-start`}
                          className={`text-sm ${isClosed ? 'text-muted-foreground' : ''}`}
                        >
                          {label}
                        </FieldLabel>
                        {isClosed ? (
                          <span className="text-sm text-muted-foreground">Closed</span>
                        ) : (
                          <div className="flex items-center gap-2">
                            <Input
                              id={`bh-day-${key}-start`}
                              type="time"
                              value={dayData.start}
                              onChange={(e) => updateDayTime(key, 'start', e.target.value)}
                              className="h-8 w-28 text-sm"
                            />
                            <span className="text-muted-foreground text-sm">to</span>
                            <Input
                              id={`bh-day-${key}-end`}
                              type="time"
                              value={dayData.end}
                              onChange={(e) => updateDayTime(key, 'end', e.target.value)}
                              className="h-8 w-28 text-sm"
                            />
                          </div>
                        )}
                        <Field orientation="horizontal">
                          <Checkbox
                            id={`bh-day-${key}-closed`}
                            checked={isClosed}
                            onCheckedChange={() => toggleDay(key)}
                          />
                          <FieldLabel
                            htmlFor={`bh-day-${key}-closed`}
                            className="text-xs font-normal text-muted-foreground"
                          >
                            Closed
                          </FieldLabel>
                        </Field>
                      </div>
                    );
                  })}
                </div>
              </FieldSet>

              <FieldSet>
                <FieldLegend variant="label">Holidays</FieldLegend>
                {holidays.length === 0 ? (
                  <FieldDescription>No holidays added.</FieldDescription>
                ) : (
                  <div className="space-y-1">
                    {holidays.map((h, i) => (
                      <div key={i} className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/40 text-sm">
                        <span>{h.date} — {h.name}{h.recurring ? ' (yearly)' : ''}</span>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeHoliday(i)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 items-end">
                  <Field className="w-36">
                    <FieldLabel htmlFor="bh-holiday-date" className="text-xs">Date</FieldLabel>
                    <Input
                      id="bh-holiday-date"
                      type="date"
                      value={newHolidayDate}
                      onChange={(e) => setNewHolidayDate(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </Field>
                  <Field className="flex-1">
                    <FieldLabel htmlFor="bh-holiday-name" className="text-xs">Name</FieldLabel>
                    <Input
                      id="bh-holiday-name"
                      value={newHolidayName}
                      onChange={(e) => setNewHolidayName(e.target.value)}
                      className="h-8 text-sm"
                      placeholder="e.g. New Year's Day"
                    />
                  </Field>
                  <Field orientation="horizontal" className="pb-1">
                    <Checkbox
                      id="bh-holiday-recurring"
                      checked={newHolidayRecurring}
                      onCheckedChange={(c) => setNewHolidayRecurring(c === true)}
                    />
                    <FieldLabel htmlFor="bh-holiday-recurring" className="text-xs font-normal">
                      Recurring
                    </FieldLabel>
                  </Field>
                  <Button variant="outline" size="sm" onClick={addHoliday}>Add</Button>
                </div>
              </FieldSet>
            </FieldGroup>
            </ScrollArea>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!name.trim()}>
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
            <TableHead className="w-[180px]">Timezone</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={4} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={4} message="No calendars yet." />}
          {(data ?? []).map((cal) => (
            <TableRow key={cal.id}>
              <TableCell>
                <div>
                  <p className="font-medium">{cal.name}</p>
                  <p className="text-xs text-muted-foreground">{getActiveDays(cal.working_hours)}</p>
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{cal.time_zone}</TableCell>
              <TableCell>
                <Badge variant={cal.active ? 'default' : 'secondary'}>{cal.active ? 'Active' : 'Inactive'}</Badge>
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(cal)}>
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
