import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useSpaces, spaceKeys } from '@/api/spaces';
import { apiFetch } from '@/lib/api';
import { TableLoading, TableEmpty } from '@/components/table-states';

interface Space {
  id: string;
  name: string;
  code: string | null;
  type: string;
  capacity: number | null;
  reservable: boolean;
  active: boolean;
  parent_id: string | null;
  amenities: string[] | null;
}

const spaceTypes = ['site', 'building', 'floor', 'room', 'desk', 'meeting_room', 'common_area', 'storage_room', 'technical_room', 'parking_space'];

const amenityOptions = [
  { value: 'projector', label: 'Projector' },
  { value: 'whiteboard', label: 'Whiteboard' },
  { value: 'video_conferencing', label: 'Video Conferencing' },
  { value: 'standing_desk', label: 'Standing Desk' },
  { value: 'dual_monitor', label: 'Dual Monitor' },
  { value: 'wheelchair_accessible', label: 'Wheelchair Accessible' },
];

export function LocationsPage() {
  const qc = useQueryClient();
  const { data, isPending: loading } = useSpaces() as { data: Space[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: spaceKeys.all });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState('room');
  const [capacity, setCapacity] = useState('');
  const [reservable, setReservable] = useState(false);
  const [parentId, setParentId] = useState('');
  const [amenities, setAmenities] = useState<string[]>([]);

  const resetForm = () => {
    setName('');
    setCode('');
    setType('room');
    setCapacity('');
    setReservable(false);
    setParentId('');
    setAmenities([]);
    setEditId(null);
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = {
      name,
      code: code || undefined,
      type,
      capacity: capacity ? parseInt(capacity) : undefined,
      reservable,
      parent_id: parentId || undefined,
      amenities: amenities.length > 0 ? amenities : undefined,
    };
    try {
      if (editId) {
        await apiFetch(`/spaces/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Space updated');
      } else {
        await apiFetch('/spaces', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Space created');
      }
      resetForm();
      setDialogOpen(false);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save space');
    }
  };

  const openEdit = (space: Space) => {
    setEditId(space.id);
    setName(space.name);
    setCode(space.code ?? '');
    setType(space.type);
    setCapacity(space.capacity?.toString() ?? '');
    setReservable(space.reservable);
    setParentId(space.parent_id ?? '');
    setAmenities(space.amenities ?? []);
    setDialogOpen(true);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const toggleAmenity = (value: string) => {
    setAmenities((prev) =>
      prev.includes(value) ? prev.filter((a) => a !== value) : [...prev, value]
    );
  };

  const spaces = data ?? [];
  const parentOptions = spaces.filter((s) => ['site', 'building', 'floor'].includes(s.type));

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        title="Locations"
        description="Sites, buildings, floors, rooms, and desks. Together they form the physical hierarchy tickets are routed through."
        actions={
          <Button className="gap-1.5" onClick={openCreate}>
            <Plus className="size-4" /> Add space
          </Button>
        }
      />

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Space</DialogTitle>
              <DialogDescription>Manage sites, buildings, floors, rooms, and desks.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="space-type">Type</FieldLabel>
                <Select value={type} onValueChange={(v) => setType(v ?? 'room')}>
                  <SelectTrigger id="space-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {spaceTypes.map((t) => (
                      <SelectItem key={t} value={t}>{t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="space-parent">Parent</FieldLabel>
                <Select value={parentId} onValueChange={(v) => setParentId(v ?? '')}>
                  <SelectTrigger id="space-parent"><SelectValue placeholder="None (top level)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None (top level)</SelectItem>
                    {parentOptions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name} ({s.type})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="space-name">Name</FieldLabel>
                  <Input
                    id="space-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Room 302"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="space-code">Code</FieldLabel>
                  <Input
                    id="space-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="e.g. AMS-A-302"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4 items-end">
                <Field>
                  <FieldLabel htmlFor="space-capacity">Capacity</FieldLabel>
                  <Input
                    id="space-capacity"
                    type="number"
                    value={capacity}
                    onChange={(e) => setCapacity(e.target.value)}
                    placeholder="0"
                  />
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="space-reservable"
                    checked={reservable}
                    onCheckedChange={(c) => setReservable(c === true)}
                  />
                  <FieldLabel htmlFor="space-reservable" className="font-normal">
                    Reservable
                  </FieldLabel>
                </Field>
              </div>

              <FieldSet>
                <FieldLegend variant="label">Amenities</FieldLegend>
                <FieldGroup data-slot="checkbox-group" className="grid grid-cols-2 gap-2">
                  {amenityOptions.map((opt) => (
                    <Field key={opt.value} orientation="horizontal">
                      <Checkbox
                        id={`space-amenity-${opt.value}`}
                        checked={amenities.includes(opt.value)}
                        onCheckedChange={() => toggleAmenity(opt.value)}
                      />
                      <FieldLabel htmlFor={`space-amenity-${opt.value}`} className="font-normal">
                        {opt.label}
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!name.trim()}>
                {editId ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[120px]">Code</TableHead>
            <TableHead className="w-[120px]">Type</TableHead>
            <TableHead className="w-[80px]">Capacity</TableHead>
            <TableHead className="w-[100px]">Reservable</TableHead>
            <TableHead>Amenities</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={7} />}
          {!loading && spaces.length === 0 && <TableEmpty cols={7} message="No spaces yet. Start by adding a site." />}
          {spaces.map((space) => (
            <TableRow key={space.id}>
              <TableCell className="font-medium">{space.name}</TableCell>
              <TableCell className="text-muted-foreground">{space.code ?? '—'}</TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{space.type.replace(/_/g, ' ')}</Badge></TableCell>
              <TableCell className="text-muted-foreground">{space.capacity ?? '—'}</TableCell>
              <TableCell>{space.reservable ? <Badge variant="default">Yes</Badge> : <span className="text-muted-foreground">No</span>}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {(space.amenities ?? []).map((a) => (
                    <Badge key={a} variant="secondary" className="text-xs capitalize">{a.replace(/_/g, ' ')}</Badge>
                  ))}
                  {(!space.amenities || space.amenities.length === 0) && <span className="text-muted-foreground text-sm">—</span>}
                </div>
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(space)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsPageShell>
  );
}
