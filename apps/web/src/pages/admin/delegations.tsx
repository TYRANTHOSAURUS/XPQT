import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { Plus, Ban } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { PersonCombobox } from '@/components/person-combobox';
import { TableLoading, TableEmpty } from '@/components/table-states';

interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

interface DelegationUser {
  id: string;
  email: string;
  person: Person | null;
}

interface Delegation {
  id: string;
  delegator_user_id: string;
  delegate_user_id: string;
  starts_at: string;
  ends_at: string;
  active: boolean;
  delegator?: DelegationUser | null;
  delegate?: DelegationUser | null;
}

function getDelegationStatus(d: Delegation): 'active' | 'upcoming' | 'expired' {
  const now = new Date();
  const start = new Date(d.starts_at);
  const end = new Date(d.ends_at);
  if (!d.active) return 'expired';
  if (now < start) return 'upcoming';
  if (now > end) return 'expired';
  return 'active';
}

const statusVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  upcoming: 'outline',
  expired: 'secondary',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function getPersonName(p?: DelegationUser | null) {
  if (!p) return '---';
  if (p.person) return `${p.person.first_name} ${p.person.last_name}`;
  return p.email ?? '---';
}


export function DelegationsPage() {
  const { data, loading, refetch } = useApi<Delegation[]>('/delegations', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [delegatorId, setDelegatorId] = useState('');
  const [delegateId, setDelegateId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');

  const resetForm = () => {
    setDelegatorId('');
    setDelegateId('');
    setStartsAt('');
    setEndsAt('');
  };

  const handleCreate = async () => {
    if (!delegatorId || !delegateId || !startsAt || !endsAt) return;
    try {
      await apiFetch('/delegations', {
        method: 'POST',
        body: JSON.stringify({
          delegator_user_id: delegatorId,
          delegate_user_id: delegateId,
          starts_at: startsAt,
          ends_at: endsAt,
        }),
      });
      resetForm();
      setDialogOpen(false);
      refetch();
      toast.success('Delegation created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create delegation');
    }
  };

  const handleDeactivate = async (id: string) => {
    try {
      await apiFetch(`/delegations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: false }),
      });
      refetch();
      toast.success('Delegation deactivated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to deactivate delegation');
    }
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const sorted = [...(data ?? [])].sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime());

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Delegations</h1>
          <p className="text-muted-foreground mt-1">Manage approval delegations for out-of-office coverage</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Delegation
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create Delegation</DialogTitle>
              <DialogDescription>
                Cover approvals while someone is out of office. The delegate will act on behalf of the delegator during the selected period.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Delegator (who is away)</Label>
                <PersonCombobox value={delegatorId} onChange={setDelegatorId} placeholder="Search delegator..." />
              </div>
              <div className="grid gap-1.5">
                <Label>Delegate (who will approve)</Label>
                <PersonCombobox value={delegateId} onChange={setDelegateId} placeholder="Search delegate..." />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="delegation-starts">Starts At</Label>
                  <Input id="delegation-starts" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="delegation-ends">Ends At</Label>
                  <Input id="delegation-ends" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={handleCreate}
                disabled={!delegatorId || !delegateId || !startsAt || !endsAt || delegatorId === delegateId}
              >
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Delegator</TableHead>
            <TableHead>Delegate</TableHead>
            <TableHead className="w-[130px]">Starts</TableHead>
            <TableHead className="w-[130px]">Ends</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={6} />}
          {!loading && sorted.length === 0 && <TableEmpty cols={6} message="No delegations yet." />}
          {sorted.map((d) => {
            const status = getDelegationStatus(d);
            return (
              <TableRow key={d.id}>
                <TableCell className="font-medium">{getPersonName(d.delegator)}</TableCell>
                <TableCell className="font-medium">{getPersonName(d.delegate)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{formatDate(d.starts_at)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{formatDate(d.ends_at)}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant[status]} className="capitalize">{status}</Badge>
                </TableCell>
                <TableCell>
                  {status !== 'expired' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleDeactivate(d.id)}
                      title="Deactivate"
                    >
                      <Ban className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
