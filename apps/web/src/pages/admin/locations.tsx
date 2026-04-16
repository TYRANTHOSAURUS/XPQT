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
import { Plus } from 'lucide-react';
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
}

const spaceTypes = ['site', 'building', 'floor', 'room', 'desk', 'meeting_room', 'common_area', 'storage_room', 'technical_room', 'parking_space'];

export function LocationsPage() {
  const { data, loading, refetch } = useApi<Space[]>('/spaces', []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState('room');
  const [capacity, setCapacity] = useState('');
  const [reservable, setReservable] = useState(false);
  const [parentId, setParentId] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) return;
    await apiFetch('/spaces', {
      method: 'POST',
      body: JSON.stringify({
        name,
        code: code || undefined,
        type,
        capacity: capacity ? parseInt(capacity) : undefined,
        reservable,
        parent_id: parentId || undefined,
      }),
    });
    setName('');
    setCode('');
    setType('room');
    setCapacity('');
    setReservable(false);
    setParentId('');
    setDialogOpen(false);
    refetch();
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
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button className="gap-2" />}>
            <Plus className="h-4 w-4" /> Add Space
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Space</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={type} onValueChange={(v) => setType(v ?? 'room')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {spaceTypes.map((t) => (
                      <SelectItem key={t} value={t}>{t.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</SelectItem>
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
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={!name.trim()}>Create</Button>
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && spaces.length === 0 && (
            <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No spaces yet. Start by adding a site.</TableCell></TableRow>
          )}
          {spaces.map((space) => (
            <TableRow key={space.id}>
              <TableCell className="font-medium">{space.name}</TableCell>
              <TableCell className="text-muted-foreground">{space.code ?? '—'}</TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{space.type.replace('_', ' ')}</Badge></TableCell>
              <TableCell className="text-muted-foreground">{space.capacity ?? '—'}</TableCell>
              <TableCell>{space.reservable ? <Badge variant="default">Yes</Badge> : <span className="text-muted-foreground">No</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
