import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
} from '@/components/ui/field';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Plus, Ban } from 'lucide-react';
import { toastCreated, toastError, toastRemoved } from '@/lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import { useDelegations, delegationKeys } from '@/api/delegations';
import { apiFetch } from '@/lib/api';
import { UserPicker } from '@/components/user-picker';
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
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); // design-check:allow — legacy; migrate to formatFullTimestamp
}

function getPersonName(p?: DelegationUser | null) {
  if (!p) return '---';
  if (p.person) return `${p.person.first_name} ${p.person.last_name}`;
  return p.email ?? '---';
}


export function DelegationsPage() {
  const qc = useQueryClient();
  const { data, isPending: loading } = useDelegations() as { data: Delegation[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: delegationKeys.all });

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
      toastCreated('Delegation');
    } catch (err) {
      toastError("Couldn't create delegation", { error: err, retry: handleCreate });
    }
  };

  const handleDeactivate = async (id: string) => {
    try {
      await apiFetch(`/delegations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: false }),
      });
      refetch();
      toastRemoved('Delegation', {
        verb: 'deactivated',
        onUndo: () => {
          void apiFetch(`/delegations/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ active: true }),
          }).then(refetch);
        },
      });
    } catch (err) {
      toastError("Couldn't deactivate delegation", { error: err, retry: () => handleDeactivate(id) });
    }
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const sorted = [...(data ?? [])].sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime());

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        title="Delegations"
        description="Approval delegations for out-of-office coverage. The delegate acts on behalf of the delegator during the window."
        actions={
          <Button className="gap-1.5" onClick={openCreate}>
            <Plus className="size-4" /> Add delegation
          </Button>
        }
      />

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create Delegation</DialogTitle>
              <DialogDescription>
                Cover approvals while someone is out of office. The delegate will act on behalf of the delegator during the selected period.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="delegation-delegator">Delegator (who is away)</FieldLabel>
                <UserPicker
                  value={delegatorId}
                  onChange={setDelegatorId}
                  placeholder="Search delegator..."
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="delegation-delegate">Delegate (who will approve)</FieldLabel>
                <UserPicker
                  value={delegateId}
                  onChange={setDelegateId}
                  placeholder="Search delegate..."
                  excludeId={delegatorId || null}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="delegation-starts">Starts At</FieldLabel>
                  <Input
                    id="delegation-starts"
                    type="date"
                    value={startsAt}
                    onChange={(e) => setStartsAt(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="delegation-ends">Ends At</FieldLabel>
                  <Input
                    id="delegation-ends"
                    type="date"
                    value={endsAt}
                    onChange={(e) => setEndsAt(e.target.value)}
                  />
                </Field>
              </div>
            </FieldGroup>
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
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => handleDeactivate(d.id)}
                          />
                        }
                      >
                        <Ban className="h-4 w-4" />
                      </TooltipTrigger>
                      <TooltipContent>Deactivate</TooltipContent>
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SettingsPageShell>
  );
}
