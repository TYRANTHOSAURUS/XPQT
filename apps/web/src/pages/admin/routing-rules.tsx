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

interface RoutingRule {
  id: string;
  name: string;
  priority: number;
  conditions: Array<{ field: string; operator: string; value: string }>;
  action_assign_team_id: string | null;
  active: boolean;
}

interface Team {
  id: string;
  name: string;
}

export function RoutingRulesPage() {
  const { data, loading, refetch } = useApi<RoutingRule[]>('/routing-rules', []);
  const { data: teams } = useApi<Team[]>('/teams', []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [condField, setCondField] = useState('domain');
  const [condValue, setCondValue] = useState('');
  const [assignTeamId, setAssignTeamId] = useState('');
  const [priority, setPriority] = useState('10');

  const handleCreate = async () => {
    if (!name.trim() || !assignTeamId) return;
    await apiFetch('/routing-rules', {
      method: 'POST',
      body: JSON.stringify({
        name,
        priority: parseInt(priority),
        conditions: condValue ? [{ field: condField, operator: 'equals', value: condValue }] : [],
        action_assign_team_id: assignTeamId,
      }),
    });
    setName('');
    setCondField('domain');
    setCondValue('');
    setAssignTeamId('');
    setPriority('10');
    setDialogOpen(false);
    refetch();
  };

  const getTeamName = (id: string | null) => {
    if (!id || !teams) return '—';
    return teams.find((t) => t.id === id)?.name ?? '—';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Routing Rules</h1>
          <p className="text-muted-foreground mt-1">Define how tickets are automatically assigned to teams</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button className="gap-2" />}>
            <Plus className="h-4 w-4" /> Add Rule
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Routing Rule</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. FM tickets to FM team..." />
              </div>
              <div className="space-y-2">
                <Label>Priority (higher = checked first)</Label>
                <Input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Condition</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Select value={condField} onValueChange={(v) => setCondField(v ?? 'domain')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="domain">Domain</SelectItem>
                      <SelectItem value="priority">Priority</SelectItem>
                      <SelectItem value="location_id">Location</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input value={condValue} onChange={(e) => setCondValue(e.target.value)} placeholder="equals..." />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Assign to Team</Label>
                <Select value={assignTeamId} onValueChange={(v) => setAssignTeamId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="Select team..." /></SelectTrigger>
                  <SelectContent>
                    {(teams ?? []).map((team) => (
                      <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={!name.trim() || !assignTeamId}>Create</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[60px]">Priority</TableHead>
            <TableHead>Name</TableHead>
            <TableHead className="w-[200px]">Condition</TableHead>
            <TableHead className="w-[180px]">Assign To</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No routing rules yet.</TableCell></TableRow>
          )}
          {(data ?? []).map((rule) => (
            <TableRow key={rule.id}>
              <TableCell className="font-mono">{rule.priority}</TableCell>
              <TableCell className="font-medium">{rule.name}</TableCell>
              <TableCell>
                {rule.conditions?.length > 0 ? (
                  <span className="text-sm">
                    {rule.conditions.map((c, i) => (
                      <Badge key={i} variant="outline" className="mr-1">{c.field} = {c.value}</Badge>
                    ))}
                  </span>
                ) : <span className="text-muted-foreground">Always match</span>}
              </TableCell>
              <TableCell>{getTeamName(rule.action_assign_team_id)}</TableCell>
              <TableCell><Badge variant={rule.active ? 'default' : 'secondary'}>{rule.active ? 'Active' : 'Off'}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
