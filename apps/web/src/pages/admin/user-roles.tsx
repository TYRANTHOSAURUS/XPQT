import { Link } from 'react-router-dom';
import { Plus, Shield, Copy, Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { cn } from '@/lib/utils';
import { useApi } from '@/hooks/use-api';

type RoleType = 'admin' | 'agent' | 'employee';

interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  active: boolean;
  type: RoleType;
}

interface RoleAssignment {
  id: string;
  role: { id: string; name: string } | null;
}

interface UserWithAssignments {
  id: string;
  role_assignments?: RoleAssignment[];
}

const roleTypeLabels: Record<RoleType, string> = {
  admin: 'Admin',
  agent: 'Service desk',
  employee: 'Employee',
};

function countUsersWithRole(users: UserWithAssignments[] | null, roleId: string): number {
  if (!users) return 0;
  let n = 0;
  for (const u of users) {
    if ((u.role_assignments ?? []).some((ra) => ra.role?.id === roleId)) n += 1;
  }
  return n;
}

export function UserRolesPage() {
  const { data: roles, loading: rolesLoading } = useApi<Role[]>('/roles', []);
  const { data: users } = useApi<UserWithAssignments[]>('/users', []);

  const isEmpty = !rolesLoading && (roles?.length ?? 0) === 0;

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        title="User roles"
        description="Permission bundles you can attach to a user. Scope a role by domain and location at assignment time — one role, many scoped uses."
        actions={
          <Link
            to="/admin/user-roles/new"
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
          >
            <Plus className="size-4" />
            New role
          </Link>
        }
      />

      {rolesLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!rolesLoading && roles && roles.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="w-[140px]">Type</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-[80px]">Users</TableHead>
              <TableHead className="w-[110px]">Permissions</TableHead>
              <TableHead className="w-[90px]">Status</TableHead>
              <TableHead className="w-[70px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => {
              const userCount = countUsersWithRole(users ?? null, role.id);
              const permCount = role.permissions?.length ?? 0;
              return (
                <TableRow key={role.id}>
                  <TableCell className="font-medium">
                    <Link
                      to={`/admin/user-roles/${role.id}`}
                      className="hover:underline underline-offset-2"
                    >
                      {role.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {roleTypeLabels[role.type] ?? role.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm truncate max-w-[360px]">
                    {role.description ?? '—'}
                  </TableCell>
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
                  <TableCell>
                    <Badge variant={role.active ? 'default' : 'secondary'}>
                      {role.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        to={`/admin/user-roles/new?from=${role.id}`}
                        aria-label="Duplicate role"
                        title="Duplicate"
                        className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'h-8 w-8')}
                      >
                        <Copy className="h-4 w-4" />
                      </Link>
                      <Link
                        to={`/admin/user-roles/${role.id}`}
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
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Shield className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No roles yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create a role to group permissions, then assign it to users from the Users list.
            Clone an existing role to start from a template.
          </p>
          <Link
            to="/admin/user-roles/new"
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
          >
            <Plus className="size-4" />
            New role
          </Link>
        </div>
      )}
    </SettingsPageShell>
  );
}
