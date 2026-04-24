import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Pencil, Trash2, Shield, Copy } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { TableLoading, TableEmpty } from '@/components/table-states';

interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
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
  person_id?: string | null;
  person?: Person | null;
  role_assignments?: RoleAssignment[];
}

type RoleType = 'admin' | 'agent' | 'employee';

interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  active: boolean;
  type: RoleType;
}

const roleTypeLabels: Record<RoleType, string> = {
  admin: 'Admin',
  agent: 'Service Desk (Agent)',
  employee: 'Employee',
};

function countUsersWithRole(users: User[] | undefined, roleId: string): number {
  if (!users) return 0;
  let n = 0;
  for (const u of users) {
    if ((u.role_assignments ?? []).some((ra) => ra.role?.id === roleId)) n += 1;
  }
  return n;
}

interface Space {
  id: string;
  name: string;
  type: string;
}

const domains = ['fm', 'it', 'visitor', 'catering', 'security', 'all'];

export function UsersPage() {
  const { data: users, loading: usersLoading, refetch: refetchUsers } = useApi<User[]>('/users', []);
  const { data: roles, loading: rolesLoading } = useApi<Role[]>('/roles', []);
  const { data: allSpaces } = useApi<Space[]>('/spaces', []);
  const { data: persons } = useApi<Person[]>('/persons', []);
  const spaces = allSpaces?.filter(s => ['site', 'building'].includes(s.type)) ?? [];

  // Create user dialog
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [newUserPersonId, setNewUserPersonId] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserUsername, setNewUserUsername] = useState('');
  const [newUserStatus, setNewUserStatus] = useState('active');
  const [createUserError, setCreateUserError] = useState<string | null>(null);

  const linkedPersonIds = new Set(
    (users ?? []).map((u) => u.person_id ?? u.person?.id).filter(Boolean) as string[],
  );
  const availablePersons = (persons ?? []).filter((p) => !linkedPersonIds.has(p.id));

  const resetCreateUserForm = () => {
    setNewUserPersonId('');
    setNewUserEmail('');
    setNewUserUsername('');
    setNewUserStatus('active');
    setCreateUserError(null);
  };

  const handlePersonPick = (id: string) => {
    setNewUserPersonId(id);
    const p = availablePersons.find((x) => x.id === id);
    if (p?.email && !newUserEmail) setNewUserEmail(p.email);
  };

  const handleCreateUser = async () => {
    if (!newUserPersonId || !newUserEmail.trim()) return;
    try {
      setCreateUserError(null);
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({
          person_id: newUserPersonId,
          email: newUserEmail.trim(),
          username: newUserUsername.trim() || undefined,
          status: newUserStatus,
        }),
      });
      resetCreateUserForm();
      setCreateUserOpen(false);
      refetchUsers();
    } catch (err) {
      setCreateUserError(err instanceof Error ? err.message : 'Failed to create user');
    }
  };

  // Assign role dialog
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [assignUserId, setAssignUserId] = useState('');
  const [assignRoleId, setAssignRoleId] = useState('');
  const [assignDomains, setAssignDomains] = useState<string[]>([]);
  const [assignLocations, setAssignLocations] = useState<string[]>([]);
  const [assignTemporary, setAssignTemporary] = useState(false);
  const [assignStartsAt, setAssignStartsAt] = useState('');
  const [assignEndsAt, setAssignEndsAt] = useState('');

  const locationOptions = spaces;

  const openAssignRole = (userId: string) => {
    setAssignUserId(userId);
    setAssignRoleId('');
    setAssignDomains([]);
    setAssignLocations([]);
    setAssignTemporary(false);
    setAssignStartsAt('');
    setAssignEndsAt('');
    setAssignDialogOpen(true);
  };

  const handleAssignRole = async () => {
    if (!assignUserId || !assignRoleId) return;
    try {
      await apiFetch(`/users/${assignUserId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          role_id: assignRoleId,
          domain_scope: assignDomains.length > 0 ? assignDomains : null,
          location_scope: assignLocations.length > 0 ? assignLocations : null,
          starts_at:
            assignTemporary && assignStartsAt
              ? new Date(assignStartsAt).toISOString()
              : null,
          ends_at:
            assignTemporary && assignEndsAt
              ? new Date(assignEndsAt).toISOString()
              : null,
        }),
      });
      setAssignDialogOpen(false);
      refetchUsers();
      toast.success('Role assigned');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to assign role');
    }
  };

  const handleRemoveAssignment = async (assignmentId: string) => {
    try {
      await apiFetch(`/role-assignments/${assignmentId}`, { method: 'DELETE' });
      refetchUsers();
      toast.success('Role assignment removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove assignment');
    }
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
          <div className="flex justify-end mb-4">
            <Button
              className="gap-2"
              onClick={() => { resetCreateUserForm(); setCreateUserOpen(true); }}
            >
              <Plus className="h-4 w-4" /> Add User
            </Button>
          </div>
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
              {usersLoading && <TableLoading cols={5} />}
              {!usersLoading && (!users || users.length === 0) && <TableEmpty cols={5} message="No users found." />}
              {(users ?? []).map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    <Link
                      to={`/admin/users/${user.id}`}
                      className="hover:underline"
                    >
                      {getUserName(user)}
                    </Link>
                  </TableCell>
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
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 text-muted-foreground hover:text-destructive"
                            onClick={() => handleRemoveAssignment(ra.id)}
                            aria-label="Remove role assignment"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
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
            <Link
              to="/admin/users/roles/new"
              className={cn(buttonVariants({ variant: 'default' }), 'gap-2')}
            >
              <Plus className="h-4 w-4" /> Add Role
            </Link>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-[120px]">Type</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[90px]">Users</TableHead>
                <TableHead className="w-[110px]">Permissions</TableHead>
                <TableHead className="w-[80px]">Status</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rolesLoading && <TableLoading cols={7} />}
              {!rolesLoading && (!roles || roles.length === 0) && <TableEmpty cols={7} message="No roles yet." />}
              {(roles ?? []).map((role) => {
                const userCount = countUsersWithRole(users ?? undefined, role.id);
                const permCount = role.permissions?.length ?? 0;
                return (
                  <TableRow key={role.id}>
                    <TableCell className="font-medium">
                      <Link
                        to={`/admin/users/roles/${role.id}`}
                        className="hover:underline"
                      >
                        {role.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{roleTypeLabels[role.type] ?? role.type}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm truncate max-w-[280px]">{role.description ?? '---'}</TableCell>
                    <TableCell>
                      <Badge variant={userCount > 0 ? 'secondary' : 'outline'} className="text-xs">
                        {userCount}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">
                        {permCount === 0 ? 'none' : `${permCount} key${permCount === 1 ? '' : 's'}`}
                      </span>
                    </TableCell>
                    <TableCell><Badge variant={role.active ? 'default' : 'secondary'}>{role.active ? 'Active' : 'Inactive'}</Badge></TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          to={`/admin/users/roles/new?from=${role.id}`}
                          aria-label="Duplicate role"
                          title="Duplicate"
                          className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-8 w-8')}
                        >
                          <Copy className="h-4 w-4" />
                        </Link>
                        <Link
                          to={`/admin/users/roles/${role.id}`}
                          aria-label="Edit role"
                          title="Edit"
                          className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-8 w-8')}
                        >
                          <Pencil className="h-4 w-4" />
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>

      {/* Create user dialog */}
      <Dialog open={createUserOpen} onOpenChange={(open) => { setCreateUserOpen(open); if (!open) resetCreateUserForm(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
            <DialogDescription>
              Link a person to a platform account. If a Supabase Auth account already exists with the same email, it will be linked automatically.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-user-person">Person</FieldLabel>
              <Select value={newUserPersonId} onValueChange={(v) => handlePersonPick(v ?? '')}>
                <SelectTrigger id="new-user-person">
                  <SelectValue placeholder="Select person..." />
                </SelectTrigger>
                <SelectContent>
                  {availablePersons.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      All persons are already linked. Add one in People → Persons first.
                    </div>
                  )}
                  {availablePersons.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.first_name} {p.last_name}{p.email ? ` · ${p.email}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="new-user-email">Email</FieldLabel>
              <Input
                id="new-user-email"
                value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)}
                placeholder="user@company.com"
                type="email"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="new-user-username">
                Username <span className="text-muted-foreground font-normal">(optional)</span>
              </FieldLabel>
              <Input
                id="new-user-username"
                value={newUserUsername}
                onChange={(e) => setNewUserUsername(e.target.value)}
                placeholder="e.g. jsmith"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="new-user-status">Status</FieldLabel>
              <Select value={newUserStatus} onValueChange={(v) => setNewUserStatus(v ?? 'active')}>
                <SelectTrigger id="new-user-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {createUserError && <FieldError>{createUserError}</FieldError>}
          </FieldGroup>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateUserOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreateUser}
              disabled={!newUserPersonId || !newUserEmail.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign role dialog */}
      <Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign Role</DialogTitle>
            <DialogDescription>
              Scope a role to specific domains and locations. Leave scopes empty to grant everywhere.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="assign-user">User</FieldLabel>
              <Select value={assignUserId} onValueChange={(v) => setAssignUserId(v ?? '')}>
                <SelectTrigger id="assign-user"><SelectValue placeholder="Select user..." /></SelectTrigger>
                <SelectContent>
                  {(users ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>{getUserName(u)} ({u.email})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="assign-role">Role</FieldLabel>
              <Select value={assignRoleId} onValueChange={(v) => setAssignRoleId(v ?? '')}>
                <SelectTrigger id="assign-role"><SelectValue placeholder="Select role..." /></SelectTrigger>
                <SelectContent>
                  {(roles ?? []).map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <FieldSet>
              <FieldLegend variant="label">
                Domain Scope <span className="text-muted-foreground font-normal">(leave empty for all)</span>
              </FieldLegend>
              <FieldGroup data-slot="checkbox-group" className="grid grid-cols-3 gap-2">
                {domains.map((d) => (
                  <Field key={d} orientation="horizontal">
                    <Checkbox
                      id={`assign-domain-${d}`}
                      checked={assignDomains.includes(d)}
                      onCheckedChange={() => toggleDomain(d)}
                    />
                    <FieldLabel htmlFor={`assign-domain-${d}`} className="font-normal capitalize">
                      {d}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">
                Location Scope <span className="text-muted-foreground font-normal">(leave empty for all)</span>
              </FieldLegend>
              {locationOptions.length === 0 ? (
                <FieldDescription>No sites or buildings configured.</FieldDescription>
              ) : (
                <FieldGroup data-slot="checkbox-group">
                  {locationOptions.map((s) => (
                    <Field key={s.id} orientation="horizontal">
                      <Checkbox
                        id={`assign-loc-${s.id}`}
                        checked={assignLocations.includes(s.id)}
                        onCheckedChange={() => toggleLocation(s.id)}
                      />
                      <FieldLabel htmlFor={`assign-loc-${s.id}`} className="font-normal">
                        {s.name} ({s.type})
                      </FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
              )}
            </FieldSet>

            <FieldSet>
              <Field orientation="horizontal">
                <Checkbox
                  id="assign-temporary"
                  checked={assignTemporary}
                  onCheckedChange={(v) => setAssignTemporary(v === true)}
                />
                <FieldLabel htmlFor="assign-temporary" className="font-normal">
                  Temporary access
                  <FieldDescription>
                    Grant this role only for a specific time window (contractor,
                    on-call rotation, vacation cover).
                  </FieldDescription>
                </FieldLabel>
              </Field>
              {assignTemporary && (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="assign-starts-at">
                      Starts at{' '}
                      <span className="text-muted-foreground font-normal">
                        (optional — defaults to now)
                      </span>
                    </FieldLabel>
                    <Input
                      id="assign-starts-at"
                      type="datetime-local"
                      value={assignStartsAt}
                      onChange={(e) => setAssignStartsAt(e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="assign-ends-at">
                      Ends at{' '}
                      <span className="text-muted-foreground font-normal">
                        (optional — indefinite if empty)
                      </span>
                    </FieldLabel>
                    <Input
                      id="assign-ends-at"
                      type="datetime-local"
                      value={assignEndsAt}
                      onChange={(e) => setAssignEndsAt(e.target.value)}
                    />
                  </Field>
                </FieldGroup>
              )}
            </FieldSet>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAssignRole} disabled={!assignRoleId}>Assign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
