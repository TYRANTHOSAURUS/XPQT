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
import { Plus, Pencil } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

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
  const { data, loading, refetch } = useApi<Space[]>('/spaces', []);
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
    if (editId) {
      await apiFetch(`/spaces/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiFetch('/spaces', { method: 'POST', body: JSON.stringify(body) });
    }
    resetForm();
    setDialogOpen(false);
    refetch();
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
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Locations & Spaces</h1>
          <p className="text-muted-foreground mt-1">Manage your sites, buildings, floors, rooms, and desks</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Space
          </DialogTrigger>
          <DialogContent className="sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Space</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={type} onValueChange={(v) => setType(v ?? 'room')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {spaceTypes.map((t) => (
                      <SelectItem key={t} value={t}>{t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Parent</Label>
                <Select value={parentId} onValueChange={(v) => setParentId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="None (top level)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None (top level)</SelectItem>
                    {parentOptions.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name} ({s.type})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Room 302" />
                </div>
                <div className="space-y-2">
                  <Label>Code</Label>
                  <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. AMS-A-302" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Capacity</Label>
                  <Input type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="0" />
                </div>
                <div className="flex items-center gap-2 pt-6">
                  <Checkbox checked={reservable} onCheckedChange={(c) => setReservable(c === true)} />
                  <Label>Reservable</Label>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Amenities</Label>
                <div className="grid grid-cols-2 gap-2">
                  {amenityOptions.map((opt) => (
                    <div key={opt.value} className="flex items-center gap-2">
                      <Checkbox
                        checked={amenities.includes(opt.value)}
                        onCheckedChange={() => toggleAmenity(opt.value)}
                      />
                      <Label className="font-normal cursor-pointer">{opt.label}</Label>
                    </div>
                  ))}
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
            <TableHead className="w-[120px]">Code</TableHead>
            <TableHead className="w-[120px]">Type</TableHead>
            <TableHead className="w-[80px]">Capacity</TableHead>
            <TableHead className="w-[100px]">Reservable</TableHead>
            <TableHead>Amenities</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && spaces.length === 0 && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No spaces yet. Start by adding a site.</TableCell></TableRow>
          )}
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
    </div>
  );
}
