import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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

interface RequestType {
  id: string;
  name: string;
  domain: string;
  active: boolean;
  sla_policy?: { name: string } | null;
}

const domains = ['it', 'fm', 'workplace', 'visitor', 'catering', 'security', 'general'];

export function RequestTypesPage() {
  const { data, loading, refetch } = useApi<RequestType[]>('/request-types', []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('general');

  const handleSave = async () => {
    if (!name.trim()) return;
    if (editId) {
      await apiFetch(`/request-types/${editId}`, { method: 'PATCH', body: JSON.stringify({ name, domain }) });
    } else {
      await apiFetch('/request-types', { method: 'POST', body: JSON.stringify({ name, domain }) });
    }
    setName('');
    setDomain('general');
    setEditId(null);
    setDialogOpen(false);
    refetch();
  };

  const openEdit = (rt: RequestType) => {
    setEditId(rt.id);
    setName(rt.name);
    setDomain(rt.domain ?? 'general');
    setDialogOpen(true);
  };

  const openCreate = () => {
    setEditId(null);
    setName('');
    setDomain('general');
    setDialogOpen(true);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Request Types</h1>
          <p className="text-muted-foreground mt-1">Define the types of requests employees can submit</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Request Type
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Request Type</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IT Incident, Cleaning Request..." />
              </div>
              <div className="space-y-2">
                <Label>Domain</Label>
                <Select value={domain} onValueChange={(v) => setDomain(v ?? 'general')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {domains.map((d) => (
                      <SelectItem key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            <TableHead className="w-[120px]">Domain</TableHead>
            <TableHead className="w-[120px]">SLA Policy</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No request types yet. Create one to get started.</TableCell></TableRow>
          )}
          {(data ?? []).map((rt) => (
            <TableRow key={rt.id}>
              <TableCell className="font-medium">{rt.name}</TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{rt.domain ?? 'general'}</Badge></TableCell>
              <TableCell className="text-muted-foreground">{rt.sla_policy?.name ?? '—'}</TableCell>
              <TableCell><Badge variant={rt.active ? 'default' : 'secondary'}>{rt.active ? 'Active' : 'Inactive'}</Badge></TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(rt)}>
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
