import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Plus } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface SlaPolicy {
  id: string;
  name: string;
  response_time_minutes: number | null;
  resolution_time_minutes: number | null;
  active: boolean;
}

function formatMinutes(mins: number | null): string {
  if (!mins) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function SlaPoliciesPage() {
  const { data, loading, refetch } = useApi<SlaPolicy[]>('/sla-policies', []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [responseHours, setResponseHours] = useState('');
  const [resolutionHours, setResolutionHours] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) return;
    await apiFetch('/sla-policies', {
      method: 'POST',
      body: JSON.stringify({
        name,
        response_time_minutes: responseHours ? Math.round(parseFloat(responseHours) * 60) : null,
        resolution_time_minutes: resolutionHours ? Math.round(parseFloat(resolutionHours) * 60) : null,
      }),
    });
    setName('');
    setResponseHours('');
    setResolutionHours('');
    setDialogOpen(false);
    refetch();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SLA Policies</h1>
          <p className="text-muted-foreground mt-1">Define response and resolution time targets</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button className="gap-2" />}>
            <Plus className="h-4 w-4" /> Add SLA Policy
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create SLA Policy</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
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
            <TableHead className="w-[160px]">Response Target</TableHead>
            <TableHead className="w-[160px]">Resolution Target</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No SLA policies yet.</TableCell></TableRow>
          )}
          {(data ?? []).map((policy) => (
            <TableRow key={policy.id}>
              <TableCell className="font-medium">{policy.name}</TableCell>
              <TableCell>{formatMinutes(policy.response_time_minutes)}</TableCell>
              <TableCell>{formatMinutes(policy.resolution_time_minutes)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
