import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, UserCog, Shield, Search } from 'lucide-react';
import { toastCreated } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
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
  TableInspectorLayout, InspectorPanel,
} from '@/components/ui/table-inspector-layout';
import { useQueryClient } from '@tanstack/react-query';
import { useUsers, userKeys } from '@/api/users';
import { usePersons } from '@/api/persons';
import { apiFetch } from '@/lib/api';
import { userStatusDotClass } from '@/lib/status-tone';
import { PersonAvatar } from '@/components/person-avatar';
import { UserDetailBody, userDisplayName } from './user-detail';

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
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('u');

  const { data: users, isPending: usersLoading } = useUsers() as { data: User[] | undefined; isPending: boolean };
  const refetchUsers = () => qc.invalidateQueries({ queryKey: userKeys.all });
  const { data: persons } = usePersons() as { data: Person[] | undefined };

  const [search, setSearch] = useState('');

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

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users ?? [];
    return (users ?? []).filter((u) => {
      const name = u.person ? `${u.person.first_name} ${u.person.last_name}` : '';
      return (
        u.email.toLowerCase().includes(q) ||
        name.toLowerCase().includes(q)
      );
    });
  }, [users, search]);

  const selectUser = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('u', id);
    else next.delete('u');
    setSearchParams(next, { replace: true });
  };

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
      toastCreated('User');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create user');
    }
  };

  const isEmpty = !usersLoading && (users?.length ?? 0) === 0;
  const hasSelection = Boolean(selectedId);

  const tableEl = (
    <UsersTable
      users={filteredUsers}
      loading={usersLoading}
      isEmpty={isEmpty}
      selectedId={selectedId}
      onSelect={selectUser}
      onAdd={() => { resetCreate(); setCreateOpen(true); }}
      hasSelection={hasSelection}
    />
  );

  const inspectorEl = hasSelection && selectedId ? (
    <InspectorPanel
      onClose={() => selectUser(null)}
      onExpand={() => navigate(`/admin/users/${selectedId}`)}
    >
      <UserInspectorContent userId={selectedId} />
    </InspectorPanel>
  ) : null;

  return (
    <>
      <TableInspectorLayout
        header={
          <div className="flex shrink-0 items-start justify-between gap-4 border-b px-6 py-4">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">Users</h1>
              <p className="text-xs text-muted-foreground max-w-2xl">
                Platform accounts linked to a person. Click a row to inspect; manage roles on the detail page.
              </p>
            </div>
            <Button className="gap-1.5 shrink-0" onClick={() => { resetCreate(); setCreateOpen(true); }}>
              <Plus className="size-4" />
              Add user
            </Button>
          </div>
        }
        toolbar={
          <div className="flex shrink-0 items-center gap-3 border-b px-6 py-2.5">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="h-8 pl-8"
              />
            </div>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {filteredUsers.length} {filteredUsers.length === 1 ? 'user' : 'users'}
            </span>
          </div>
        }
        list={tableEl}
        inspector={inspectorEl}
      />

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
    </>
  );
}

function UsersTable({
  users,
  loading,
  isEmpty,
  selectedId,
  onSelect,
  onAdd,
  hasSelection,
}: {
  users: User[];
  loading: boolean;
  isEmpty: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  hasSelection: boolean;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 px-6 py-6" aria-label="Loading users">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <UserCog className="size-10 text-muted-foreground animate-in fade-in slide-in-from-bottom-2 duration-300 [animation-fill-mode:both]" />
        <div className="text-sm font-medium animate-in fade-in slide-in-from-bottom-2 duration-300 [animation-delay:60ms] [animation-fill-mode:both]">
          No users yet
        </div>
        <p className="max-w-sm text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-2 duration-300 [animation-delay:120ms] [animation-fill-mode:both]">
          Add a user to give a person access to the platform. Assign user roles from the user's
          detail page after creation.
        </p>
        <Button
          className="gap-1.5 animate-in fade-in slide-in-from-bottom-2 duration-300 [animation-delay:180ms] [animation-fill-mode:both]"
          onClick={onAdd}
        >
          <Plus className="size-4" />
          Add user
        </Button>
      </div>
    );
  }

  if (users.length === 0) {
    return (
      <div className="px-6 py-10 text-center text-sm text-muted-foreground">
        No users match the current search.
      </div>
    );
  }

  return (
    <Table containerClassName="overflow-visible">
      <TableHeader className="bg-muted/30 sticky top-0 z-10 backdrop-blur-sm">
        <TableRow>
          <TableHead className="px-6">Name</TableHead>
          {!hasSelection && <TableHead className="w-[260px]">Email</TableHead>}
          <TableHead className="w-[110px]">Status</TableHead>
          {!hasSelection && <TableHead>Roles</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => {
          const selected = selectedId === user.id;
          return (
            <TableRow
              key={user.id}
              data-selected={selected ? 'true' : undefined}
              onClick={() => onSelect(user.id)}
              className={cn(
                'cursor-pointer transition-colors duration-150 ease-[var(--ease-snap)]',
                selected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/40',
              )}
            >
              <TableCell
                className={cn(
                  'font-medium px-6 border-l-2 border-l-transparent transition-colors duration-150 ease-[var(--ease-snap)]',
                  selected && 'border-l-primary',
                )}
              >
                <div className="min-w-0">
                  <div className="truncate">
                    {user.person ? `${user.person.first_name} ${user.person.last_name}` : user.email}
                  </div>
                  {hasSelection && user.person && (
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {user.email}
                    </div>
                  )}
                </div>
              </TableCell>
              {!hasSelection && (
                <TableCell className="text-muted-foreground text-sm">{user.email}</TableCell>
              )}
              <TableCell>
                <span className="inline-flex items-center gap-1.5 text-xs">
                  <span
                    className={cn('size-1.5 rounded-full shrink-0', userStatusDotClass(user.status))}
                    aria-hidden
                  />
                  <span className="capitalize">{user.status}</span>
                </span>
              </TableCell>
              {!hasSelection && (
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
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Body of the inspector: identity heading + UserDetailBody sections. Chrome
 * (close, expand, panel sizing, scroll wrapper) is provided by InspectorPanel.
 */
function UserInspectorContent({ userId }: { userId: string }) {
  const { data: users } = useUsers() as { data: User[] | undefined };
  const headerUser = users?.find((u) => u.id === userId);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div
      data-mounted={mounted ? '' : undefined}
      className={cn(
        'flex flex-col gap-8 px-6 pt-6 pb-10 max-w-3xl mx-auto w-full',
        'transition-[opacity,transform] duration-200 ease-[var(--ease-smooth)]',
        'opacity-0 translate-y-1',
        'data-[mounted]:opacity-100 data-[mounted]:translate-y-0',
      )}
    >
      {headerUser && (
        <div className="flex items-center gap-3">
          <PersonAvatar
            person={headerUser.person ?? { email: headerUser.email }}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-2xl font-semibold tracking-tight truncate">
                {userDisplayName(headerUser)}
              </h2>
              <Badge
                variant="outline"
                className="text-[10px] uppercase tracking-wider shrink-0 mt-1.5 gap-1.5"
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full transition-colors duration-200 ease-[var(--ease-smooth)]',
                    userStatusDotClass(headerUser.status),
                  )}
                  aria-hidden
                />
                {headerUser.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground truncate">{headerUser.email}</p>
          </div>
        </div>
      )}
      <UserDetailBody userId={userId} />
    </div>
  );
}
