import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { PersonAvatar } from '@/components/person-avatar';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil, X, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useTeams, teamKeys } from '@/api/teams';
import { useSpaces } from '@/api/spaces';
import { useUsers } from '@/api/users';
import { useSlaPolicies } from '@/api/sla-policies';
import { apiFetch } from '@/lib/api';
import { SpaceSelect } from '@/components/space-select';
import { OrgNodeCombobox } from '@/components/org-node-combobox';
import { TableLoading, TableEmpty } from '@/components/table-states';

interface Team {
  id: string;
  name: string;
  domain_scope: string | null;
  location_scope: string | null;
  active: boolean;
  default_sla_policy_id: string | null;
  org_node_id: string | null;
  org_node?: { id: string; name: string; code: string | null } | { id: string; name: string; code: string | null }[] | null;
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
  const qc = useQueryClient();
  const { data, isPending: loading } = useTeams() as { data: Team[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: teamKeys.all });
  const { data: spaces } = useSpaces() as { data: Space[] | undefined };
  const { data: users } = useUsers() as { data: User[] | undefined };
  const { data: slaPolicies } = useSlaPolicies() as { data: Array<{ id: string; name: string }> | undefined };

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [domainScope, setDomainScope] = useState('all');
  const [locationScope, setLocationScope] = useState('');
  const [defaultSlaPolicyId, setDefaultSlaPolicyId] = useState<string>('');
  const [orgNodeId, setOrgNodeId] = useState<string | null>(null);

  // Members sub-section (only shown when editing)
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [addUserId, setAddUserId] = useState('');

  const resetForm = () => {
    setName('');
    setDomainScope('all');
    setLocationScope('');
    setDefaultSlaPolicyId('');
    setOrgNodeId(null);
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
      default_sla_policy_id: defaultSlaPolicyId || null,
      org_node_id: orgNodeId,
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
    setDefaultSlaPolicyId(team.default_sla_policy_id ?? '');
    setOrgNodeId(team.org_node_id ?? null);
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
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="team-name">Name</FieldLabel>
                <Input
                  id="team-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. FM Team Amsterdam, IT Service Desk..."
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="team-domain-scope">Domain Scope</FieldLabel>
                <Select value={domainScope} onValueChange={(v) => setDomainScope(v ?? 'all')}>
                  <SelectTrigger id="team-domain-scope"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {domains.map((d) => (
                      <SelectItem key={d} value={d}>{d === 'all' ? 'All domains' : d.charAt(0).toUpperCase() + d.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="team-location-scope">Location Scope</FieldLabel>
                <SpaceSelect
                  value={locationScope}
                  onChange={setLocationScope}
                  typeFilter={['site', 'building']}
                  placeholder="All locations"
                  emptyLabel="All locations"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="team-org-node">Organisation</FieldLabel>
                <OrgNodeCombobox
                  value={orgNodeId}
                  onChange={setOrgNodeId}
                  placeholder="Optional — attach to an organisation"
                />
                <FieldDescription>
                  Categorise this team under an organisation. Does not grant team members the organisation's locations.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="team-default-sla">Default SLA policy</FieldLabel>
                <Select value={defaultSlaPolicyId} onValueChange={(v) => setDefaultSlaPolicyId(v ?? '')}>
                  <SelectTrigger id="team-default-sla"><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {(slaPolicies ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Falls back to this when a sub-issue is dispatched to this team (or to a user on this team) without an explicit SLA pick.
                </FieldDescription>
              </Field>

              {editId && (
                <>
                  <FieldSeparator />
                  <FieldSet>
                    <FieldLegend variant="label">Team Members</FieldLegend>
                    {membersLoading ? (
                      <FieldDescription>Loading members...</FieldDescription>
                    ) : members.length === 0 ? (
                      <FieldDescription>No members yet.</FieldDescription>
                    ) : (
                      <div className="space-y-1">
                        {members.map((member) => (
                          <div key={member.id} className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/40 text-sm">
                            <div className="flex items-center gap-2 min-w-0">
                              <PersonAvatar
                                size="sm"
                                person={{
                                  first_name: member.user?.person?.first_name,
                                  last_name: member.user?.person?.last_name,
                                  email: member.user?.email,
                                }}
                              />
                              <span className="truncate">{getMemberName(member)}</span>
                            </div>
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
                  </FieldSet>
                </>
              )}
            </FieldGroup>
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
