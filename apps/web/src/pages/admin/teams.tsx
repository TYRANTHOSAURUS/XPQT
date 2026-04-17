import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil, X, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { SpaceSelect } from '@/components/space-select';
import { TableLoading, TableEmpty } from '@/components/table-states';

interface Team {
  id: string;
  name: string;
  domain_scope: string | null;
  location_scope: string | null;
  active: boolean;
}

interface Space {
  id: string;
  name: string;
  type: string;
}

interface User {
  id: string;
  email: string;
  person?: { id: string; first_name: string; last_name: string } | null;
}

interface TeamMember {
  id: string;
  user_id: string;
  user?: User | null;
}

const domains = ['fm', 'it', 'visitor', 'catering', 'security', 'all'];

export function TeamsPage() {
  const { data, loading, refetch } = useApi<Team[]>('/teams', []);
  const { data: spaces } = useApi<Space[]>('/spaces', []);
  const { data: users } = useApi<User[]>('/users', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [domainScope, setDomainScope] = useState('all');
  const [locationScope, setLocationScope] = useState('');

  // Members sub-section (only shown when editing)
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addUserId, setAddUserId] = useState('');

  const resetForm = () => {
    setName('');
    setDomainScope('all');
    setLocationScope('');
    setEditId(null);
    setMembers([]);
    setAddUserId('');
  };

  const loadMembers = async (teamId: string) => {
    setMembersLoading(true);
    try {
      const data = await apiFetch<TeamMember[]>(`/teams/${teamId}/members`);
      setMembers(data);
    } catch {
      setMembers([]);
    } finally {
      setMembersLoading(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = {
      name,
      domain_scope: domainScope === 'all' ? null : domainScope,
      location_scope: locationScope || null,
    };
    try {
      if (editId) {
        await apiFetch(`/teams/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Team updated');
      } else {
        await apiFetch('/teams', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Team created');
      }
      resetForm();
      setDialogOpen(false);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save team');
    }
  };

  const openEdit = async (team: Team) => {
    setEditId(team.id);
    setName(team.name);
    setDomainScope(team.domain_scope ?? 'all');
    setLocationScope(team.location_scope ?? '');
    setDialogOpen(true);
    await loadMembers(team.id);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const handleAddMember = async () => {
    if (!editId || !addUserId) return;
    try {
      await apiFetch(`/teams/${editId}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_id: addUserId }),
      });
      toast.success('Member added');
      setAddUserId('');
      await loadMembers(editId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add member');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!editId) return;
    try {
      await apiFetch(`/teams/${editId}/members/${userId}`, { method: 'DELETE' });
      toast.success('Member removed');
      await loadMembers(editId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  const getMemberName = (member: TeamMember) => {
    const p = member.user?.person;
    if (p) return `${p.first_name} ${p.last_name}`;
    return member.user?.email ?? member.user_id;
  };

  const getLocationName = (id: string | null) => {
    if (!id || !spaces) return '—';
    return spaces.find((s) => s.id === id)?.name ?? '—';
  };

  const existingMemberUserIds = new Set(members.map((m) => m.user_id));
  const availableUsers = (users ?? []).filter((u) => !existingMemberUserIds.has(u.id));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Teams</h1>
          <p className="text-muted-foreground mt-1">Manage assignment groups for ticket routing</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Team
          </DialogTrigger>
          <DialogContent className="sm:max-w-[520px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Team</DialogTitle>
              <DialogDescription>Manage assignment groups and members for ticket routing.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. FM Team Amsterdam, IT Service Desk..." />
              </div>
              <div className="grid gap-1.5">
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
              <div className="grid gap-1.5">
                <Label>Location Scope</Label>
                <SpaceSelect
                  value={locationScope}
                  onChange={setLocationScope}
                  typeFilter={['site', 'building']}
                  placeholder="All locations"
                  emptyLabel="All locations"
                />
              </div>

              {editId && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <Label className="text-sm font-medium">Team Members</Label>
                    {membersLoading ? (
                      <p className="text-sm text-muted-foreground">Loading members...</p>
                    ) : members.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No members yet.</p>
                    ) : (
                      <div className="space-y-1">
                        {members.map((member) => (
                          <div key={member.id} className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/40 text-sm">
                            <span>{getMemberName(member)}</span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleRemoveMember(member.user_id)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Select value={addUserId} onValueChange={(v) => setAddUserId(v ?? '')}>
                        <SelectTrigger className="flex-1"><SelectValue placeholder="Add member..." /></SelectTrigger>
                        <SelectContent>
                          {availableUsers.map((u) => (
                            <SelectItem key={u.id} value={u.id}>
                              {u.person ? `${u.person.first_name} ${u.person.last_name}` : u.email}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button variant="outline" size="icon" onClick={handleAddMember} disabled={!addUserId}>
                        <UserPlus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
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
            <TableHead className="w-[140px]">Domain</TableHead>
            <TableHead className="w-[180px]">Location</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={5} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={5} message="No teams yet." />}
          {(data ?? []).map((team) => (
            <TableRow key={team.id}>
              <TableCell className="font-medium">{team.name}</TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{team.domain_scope ?? 'All'}</Badge></TableCell>
              <TableCell className="text-muted-foreground text-sm">{getLocationName(team.location_scope)}</TableCell>
              <TableCell><Badge variant={team.active ? 'default' : 'secondary'}>{team.active ? 'Active' : 'Inactive'}</Badge></TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(team)}>
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
