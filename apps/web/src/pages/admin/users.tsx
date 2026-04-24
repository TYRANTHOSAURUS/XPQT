import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, UserCog, Shield } from 'lucide-react';
import { toast } from 'sonner';
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
  Field, FieldError, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

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

export function UsersPage() {
  const { data: users, loading: usersLoading, refetch: refetchUsers } = useApi<User[]>('/users', []);
  const { data: persons } = useApi<Person[]>('/persons', []);

  const [createOpen, setCreateOpen] = useState(false);
  const [newUserPersonId, setNewUserPersonId] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserUsername, setNewUserUsername] = useState('');
  const [newUserStatus, setNewUserStatus] = useState('active');
  const [createError, setCreateError] = useState<string | null>(null);

  const linkedPersonIds = new Set(
    (users ?? []).map((u) => u.person_id ?? u.person?.id).filter(Boolean) as string[],
  );
  const availablePersons = (persons ?? []).filter((p) => !linkedPersonIds.has(p.id));

  const resetCreate = () => {
    setNewUserPersonId('');
    setNewUserEmail('');
    setNewUserUsername('');
    setNewUserStatus('active');
    setCreateError(null);
  };

  const handlePersonPick = (id: string) => {
    setNewUserPersonId(id);
    const p = availablePersons.find((x) => x.id === id);
    if (p?.email && !newUserEmail) setNewUserEmail(p.email);
  };

  const handleCreate = async () => {
    if (!newUserPersonId || !newUserEmail.trim()) return;
    try {
      setCreateError(null);
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({
          person_id: newUserPersonId,
          email: newUserEmail.trim(),
          username: newUserUsername.trim() || undefined,
          status: newUserStatus,
        }),
      });
      resetCreate();
      setCreateOpen(false);
      refetchUsers();
      toast.success('User created');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create user');
    }
  };

  const isEmpty = !usersLoading && (users?.length ?? 0) === 0;

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin"
        title="Users"
        description="Platform accounts linked to a person. Use this list to see who can sign in; manage what each user can do by assigning roles on their detail page."
        actions={
          <Button className="gap-1.5" onClick={() => { resetCreate(); setCreateOpen(true); }}>
            <Plus className="size-4" />
            Add user
          </Button>
        }
      />

      {usersLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!usersLoading && users && users.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-[240px]">Email</TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead>Roles</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">
                  <Link
                    to={`/admin/users/${user.id}`}
                    className="hover:underline underline-offset-2"
                  >
                    {user.person ? `${user.person.first_name} ${user.person.last_name}` : user.email}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{user.email}</TableCell>
                <TableCell>
                  <Badge variant={user.status === 'active' ? 'default' : 'secondary'} className="capitalize">
                    {user.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {(user.role_assignments ?? []).length === 0 ? (
                    <span className="text-xs text-muted-foreground">None</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {(user.role_assignments ?? []).map((ra) => (
                        <Badge key={ra.id} variant="outline" className="text-xs gap-1">
                          <Shield className="size-2.5" />
                          {ra.role?.name ?? 'Unknown'}
                          {ra.domain_scope && ra.domain_scope.length > 0 && (
                            <span className="text-muted-foreground">({ra.domain_scope.join(', ')})</span>
                          )}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <UserCog className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No users yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Add a user to give a person access to the platform. Assign user roles from the user's
            detail page after creation.
          </p>
          <Button className="gap-1.5" onClick={() => { resetCreate(); setCreateOpen(true); }}>
            <Plus className="size-4" />
            Add user
          </Button>
        </div>
      )}

      {/* Add user dialog — keeps the user on this page; complex scoping happens on the detail page. */}
      <Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open) resetCreate(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              Link a person to a platform account. If a Supabase Auth account already exists for the
              same email, it is linked automatically.
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
            {createError && <FieldError>{createError}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newUserPersonId || !newUserEmail.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageShell>
  );
}
