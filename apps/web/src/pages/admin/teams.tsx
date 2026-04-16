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
import { Plus } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface Team {
  id: string;
  name: string;
  domain_scope: string | null;
  active: boolean;
}

const domains = ['fm', 'it', 'visitor', 'catering', 'security', 'all'];

export function TeamsPage() {
  const { data, loading, refetch } = useApi<Team[]>('/teams', []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [domainScope, setDomainScope] = useState('all');

  const handleCreate = async () => {
    if (!name.trim()) return;
    await apiFetch('/teams', {
      method: 'POST',
      body: JSON.stringify({ name, domain_scope: domainScope === 'all' ? null : domainScope }),
    });
    setName('');
    setDomainScope('all');
    setDialogOpen(false);
    refetch();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Teams</h1>
          <p className="text-muted-foreground mt-1">Manage assignment groups for ticket routing</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button className="gap-2" />}>
            <Plus className="h-4 w-4" /> Add Team
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Team</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. FM Team Amsterdam, IT Service Desk..." />
              </div>
              <div className="space-y-2">
                <Label>Domain Scope</Label>
                <Select value={domainScope} onValueChange={(v) => setDomainScope(v ?? 'all')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {domains.map((d) => (
                      <SelectItem key={d} value={d}>{d === 'all' ? 'All domains' : d.charAt(0).toUpperCase() + d.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            <TableHead className="w-[140px]">Domain</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={3} className="text-center py-8 text-muted-foreground">No teams yet.</TableCell></TableRow>
          )}
          {(data ?? []).map((team) => (
            <TableRow key={team.id}>
              <TableCell className="font-medium">{team.name}</TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{team.domain_scope ?? 'All'}</Badge></TableCell>
              <TableCell><Badge variant={team.active ? 'default' : 'secondary'}>{team.active ? 'Active' : 'Inactive'}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
