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
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Pencil, Trash2, Shield } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface Person {
  id: string;
  first_name: string;
  last_name: string;
}

interface RoleAssignment {
  id: string;
  domain_scope: string[] | null;
  location_scope: string[] | null;
  role: { id: string; name: string } | null;
}

interface User {
  id: string;
  email: string;
  status: string;
  person?: Person | null;
  role_assignments?: RoleAssignment[];
}

interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  active: boolean;
}

interface Space {
  id: string;
  name: string;
  type: string;
}

const domains = ['fm', 'it', 'visitor', 'catering', 'security', 'all'];

export function UsersPage() {
  const { data: users, loading: usersLoading, refetch: refetchUsers } = useApi<User[]>('/users', []);
  const { data: roles, loading: rolesLoading, refetch: refetchRoles } = useApi<Role[]>('/roles', []);
  const { data: allSpaces } = useApi<Space[]>('/spaces', []);
  const spaces = allSpaces?.filter(s => ['site', 'building'].includes(s.type)) ?? [];

  // Role dialog
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [editRoleId, setEditRoleId] = useState<string | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleDesc, setRoleDesc] = useState('');

  // Assign role dialog
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignUserId, setAssignUserId] = useState('');
  const [assignRoleId, setAssignRoleId] = useState('');
  const [assignDomains, setAssignDomains] = useState<string[]>([]);
  const [assignLocations, setAssignLocations] = useState<string[]>([]);

  const locationOptions = spaces;

  const resetRoleForm = () => {
    setEditRoleId(null);
    setRoleName('');
    setRoleDesc('');
  };

  const handleSaveRole = async () => {
    if (!roleName.trim()) return;
    if (editRoleId) {
      await apiFetch(`/roles/${editRoleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: roleName, description: roleDesc }),
      });
    } else {
      await apiFetch('/roles', {
        method: 'POST',
        body: JSON.stringify({ name: roleName, description: roleDesc }),
      });
    }
    resetRoleForm();
    setRoleDialogOpen(false);
    refetchRoles();
  };

  const openEditRole = (role: Role) => {
    setEditRoleId(role.id);
    setRoleName(role.name);
    setRoleDesc(role.description ?? '');
    setRoleDialogOpen(true);
  };

  const openAssignRole = (userId: string) => {
    setAssignUserId(userId);
    setAssignRoleId('');
    setAssignDomains([]);
    setAssignLocations([]);
    setAssignDialogOpen(true);
  };

  const handleAssignRole = async () => {
    if (!assignUserId || !assignRoleId) return;
    await apiFetch(`/users/${assignUserId}/roles`, {
      method: 'POST',
      body: JSON.stringify({
        role_id: assignRoleId,
        domain_scope: assignDomains.length > 0 ? assignDomains : null,
        location_scope: assignLocations.length > 0 ? assignLocations : null,
      }),
    });
    setAssignDialogOpen(false);
    refetchUsers();
  };

  const handleRemoveAssignment = async (assignmentId: string) => {
    await apiFetch(`/role-assignments/${assignmentId}`, { method: 'DELETE' });
    refetchUsers();
  };

  const toggleDomain = (d: string) =>
    setAssignDomains((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);

  const toggleLocation = (id: string) =>
    setAssignLocations((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const getUserName = (user: User) => {
    if (user.person) return `${user.person.first_name} ${user.person.last_name}`;
    return user.email;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Users & Roles</h1>
          <p className="text-muted-foreground mt-1">Manage platform users and their role assignments</p>
        </div>
      </div>

      <Tabs defaultValue="users">
        <TabsList className="mb-6">
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-[220px]">Email</TableHead>
                <TableHead className="w-[80px]">Status</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {usersLoading && (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              )}
              {!usersLoading && (!users || users.length === 0) && (
                <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No users found.</TableCell></TableRow>
              )}
              {(users ?? []).map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{getUserName(user)}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{user.email}</TableCell>
                  <TableCell>
                    <Badge variant={user.status === 'active' ? 'default' : 'secondary'} className="capitalize">{user.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(user.role_assignments ?? []).map((ra) => (
                        <div key={ra.id} className="flex items-center gap-1">
                          <Badge variant="outline" className="text-xs gap-1">
                            <Shield className="h-2.5 w-2.5" />
                            {ra.role?.name ?? 'Unknown'}
                            {ra.domain_scope && ra.domain_scope.length > 0 && (
                              <span className="text-muted-foreground">({ra.domain_scope.join(', ')})</span>
                            )}
                          </Badge>
                          <button
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => handleRemoveAssignment(ra.id)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openAssignRole(user.id)}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        <TabsContent value="roles">
          <div className="flex justify-end mb-4">
            <Button
              className="gap-2"
              onClick={() => { resetRoleForm(); setRoleDialogOpen(true); }}
            >
              <Plus className="h-4 w-4" /> Add Role
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[80px]">Status</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rolesLoading && (
                <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
              )}
              {!rolesLoading && (!roles || roles.length === 0) && (
                <TableRow><TableCell colSpan={4} className="text-center py-8 text-muted-foreground">No roles yet.</TableCell></TableRow>
              )}
              {(roles ?? []).map((role) => (
                <TableRow key={role.id}>
                  <TableCell className="font-medium">{role.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{role.description ?? '---'}</TableCell>
                  <TableCell><Badge variant={role.active ? 'default' : 'secondary'}>{role.active ? 'Active' : 'Inactive'}</Badge></TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditRole(role)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>

      {/* Role create/edit dialog */}
      <Dialog open={roleDialogOpen} onOpenChange={(open) => { setRoleDialogOpen(open); if (!open) resetRoleForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editRoleId ? 'Edit' : 'Create'} Role</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={roleName} onChange={(e) => setRoleName(e.target.value)} placeholder="e.g. Admin, Agent, Approver..." />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={roleDesc} onChange={(e) => setRoleDesc(e.target.value)} placeholder="Optional description..." />
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setRoleDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSaveRole} disabled={!roleName.trim()}>
                {editRoleId ? 'Save' : 'Create'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Assign role dialog */}
      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>Assign Role</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-2">
              <Label>User</Label>
              <Select value={assignUserId} onValueChange={(v) => setAssignUserId(v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Select user..." /></SelectTrigger>
                <SelectContent>
                  {(users ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>{getUserName(u)} ({u.email})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={assignRoleId} onValueChange={(v) => setAssignRoleId(v ?? '')}>
                <SelectTrigger><SelectValue placeholder="Select role..." /></SelectTrigger>
                <SelectContent>
                  {(roles ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Domain Scope <span className="text-muted-foreground font-normal">(leave empty for all)</span></Label>
              <div className="grid grid-cols-3 gap-2">
                {domains.map((d) => (
                  <div key={d} className="flex items-center gap-1.5">
                    <Checkbox
                      checked={assignDomains.includes(d)}
                      onCheckedChange={() => toggleDomain(d)}
                    />
                    <Label className="font-normal capitalize text-sm">{d}</Label>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Location Scope <span className="text-muted-foreground font-normal">(leave empty for all)</span></Label>
              <div className="space-y-1.5">
                {locationOptions.map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5">
                    <Checkbox
                      checked={assignLocations.includes(s.id)}
                      onCheckedChange={() => toggleLocation(s.id)}
                    />
                    <Label className="font-normal text-sm">{s.name} ({s.type})</Label>
                  </div>
                ))}
                {locationOptions.length === 0 && <p className="text-sm text-muted-foreground">No sites or buildings configured.</p>}
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setAssignDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleAssignRole} disabled={!assignRoleId}>Assign</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
