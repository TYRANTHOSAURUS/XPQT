import { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Shield, AlertTriangle, Clock, MapPin, Building2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { buttonVariants } from '@/components/ui/button';
import {
  useEffectivePermissions,
  type EffectivePermissionsModule,
  type EffectivePermissionGrant,
} from '@/api/permissions';
import { useUserAudit } from '@/api/roles';
import { RoleAuditFeed } from '@/components/admin/role-audit-feed';

interface PersonShort {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  type?: string | null;
}

interface RoleAssignment {
  id: string;
  domain_scope: string[] | null;
  location_scope: string[] | null;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
  role: { id: string; name: string; type: string | null } | null;
}

interface User {
  id: string;
  email: string;
  username: string | null;
  status: string;
  person_id: string | null;
  person?: PersonShort | null;
  role_assignments?: RoleAssignment[];
}

const userDetailKey = (id: string) => ['users', 'detail', id] as const;

function userDetailOptions(id: string | undefined) {
  return queryOptions({
    queryKey: userDetailKey(id ?? ''),
    queryFn: ({ signal }) => apiFetch<User>(`/users/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const userQuery = useQuery(userDetailOptions(id));
  const effectiveQuery = useEffectivePermissions(id);
  const auditQuery = useUserAudit(id);

  const user = userQuery.data;
  const effective = effectiveQuery.data;

  if (userQuery.isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader title="User" backTo="/admin/users" />
        <Skeleton className="h-96" />
      </SettingsPageShell>
    );
  }

  if (!user) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader title="User not found" backTo="/admin/users" />
        <p className="text-sm text-muted-foreground">
          This user doesn't exist or you don't have access.
        </p>
      </SettingsPageShell>
    );
  }

  const displayName = user.person
    ? `${user.person.first_name} ${user.person.last_name}`
    : user.email;

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/users"
        title={displayName}
        description={user.email}
        actions={
          user.person ? (
            <Link
              to={`/admin/persons?highlight=${user.person.id}`}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              View person
            </Link>
          ) : null
        }
      />

      <SettingsSection title="Identity">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <Field label="Email" value={user.email} />
          <Field label="Username" value={user.username ?? '—'} />
          <Field
            label="Status"
            value={
              <Badge
                variant={user.status === 'active' ? 'default' : 'secondary'}
                className="capitalize"
              >
                {user.status}
              </Badge>
            }
          />
          <Field
            label="Linked person"
            value={
              user.person
                ? `${user.person.first_name} ${user.person.last_name}${
                    user.person.type ? ` · ${user.person.type}` : ''
                  }`
                : 'None'
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Roles">
        <RolesList assignments={user.role_assignments ?? []} />
      </SettingsSection>

      <SettingsSection title="Effective permissions" density="tight">
        <EffectivePermissionsPanel
          loading={effectiveQuery.isLoading}
          modules={effective?.modules ?? []}
        />
      </SettingsSection>

      <SettingsSection title="Activity">
        <RoleAuditFeed
          events={auditQuery.data}
          loading={auditQuery.isLoading}
          hideTargetUser
          emptyLabel="No role changes for this user yet."
        />
      </SettingsSection>
    </SettingsPageShell>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function RolesList({ assignments }: { assignments: RoleAssignment[] }) {
  if (assignments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No roles assigned. This user has no platform permissions beyond
        participating in their own tickets.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {assignments.map((ra) => (
        <div
          key={ra.id}
          className="flex items-center justify-between gap-4 rounded-md border px-3 py-2"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Shield className="size-4 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {ra.role?.name ?? 'Unknown role'}
              </div>
              <div className="text-xs text-muted-foreground flex items-center gap-3 flex-wrap">
                {ra.domain_scope && ra.domain_scope.length > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Building2 className="size-3" />
                    {ra.domain_scope.join(', ')}
                  </span>
                )}
                {ra.location_scope && ra.location_scope.length > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3" />
                    {ra.location_scope.length} location
                    {ra.location_scope.length === 1 ? '' : 's'}
                  </span>
                )}
                {(ra.starts_at || ra.ends_at) && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3" />
                    {formatBounds(ra.starts_at, ra.ends_at)}
                  </span>
                )}
                {(!ra.domain_scope || ra.domain_scope.length === 0) &&
                  (!ra.location_scope || ra.location_scope.length === 0) &&
                  !ra.starts_at &&
                  !ra.ends_at && <span>Unrestricted, indefinite</span>}
              </div>
            </div>
          </div>
          <Badge variant={ra.active ? 'default' : 'secondary'} className="text-xs">
            {ra.active ? 'Active' : 'Inactive'}
          </Badge>
        </div>
      ))}
    </div>
  );
}

function formatBounds(startsAt: string | null, endsAt: string | null): string {
  const now = Date.now();
  const pending = startsAt && Date.parse(startsAt) > now;
  const expired = endsAt && Date.parse(endsAt) <= now;
  if (expired) return 'Expired';
  if (pending) return `Starts ${fmt(startsAt)}`;
  if (endsAt) return `Until ${fmt(endsAt)}`;
  if (startsAt) return `Since ${fmt(startsAt)}`;
  return '';
}

function fmt(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function EffectivePermissionsPanel({
  loading,
  modules,
}: {
  loading: boolean;
  modules: EffectivePermissionsModule[];
}) {
  const totalPermissions = useMemo(
    () => modules.reduce((sum, m) => sum + m.permissions.length, 0),
    [modules],
  );
  const hasOverrides = useMemo(
    () => modules.some((m) => m.permissions.some((p) => p.is_override)),
    [modules],
  );

  if (loading) return <Skeleton className="h-64" />;

  if (totalPermissions === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This user has no effective permissions. They can still participate in
        tickets they requested, are assigned to, or watch.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 text-sm">
        <Badge variant="secondary">
          {totalPermissions} effective permission
          {totalPermissions === 1 ? '' : 's'}
        </Badge>
        {hasOverrides && (
          <div className="inline-flex items-center gap-1.5 text-xs text-amber-900 dark:text-amber-100">
            <AlertTriangle className="size-3.5" />
            Includes overrides that bypass ticket scope
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3">
        {modules.map((mod) => (
          <div key={mod.module} className="rounded-lg border bg-card">
            <div className="px-4 py-3 border-b">
              <h3 className="text-sm font-medium">{mod.label}</h3>
              <p className="text-xs text-muted-foreground">
                {mod.permissions.length} permission
                {mod.permissions.length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="divide-y">
              {mod.permissions.map((perm) => (
                <div key={perm.key} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0 flex items-center gap-2">
                      <span className="text-sm">{perm.label}</span>
                      <code className="text-[10px] text-muted-foreground font-mono">
                        {perm.key}
                      </code>
                      {perm.is_override && (
                        <Badge
                          variant="outline"
                          className="text-[10px] gap-1 border-amber-500/40 text-amber-900 dark:text-amber-100"
                        >
                          <Shield className="size-2.5" />
                          Override
                        </Badge>
                      )}
                    </div>
                  </div>
                  <GrantList grants={perm.grants} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GrantList({ grants }: { grants: EffectivePermissionGrant[] }) {
  if (grants.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {grants.map((g, idx) => (
        <div
          key={`${g.assignment_id}-${idx}`}
          className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
        >
          <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5">
            <span className="text-foreground/80">{g.role_name}</span>
            <Separator orientation="vertical" className="h-3" />
            <span className="text-[10px] font-mono">{g.raw_token}</span>
            {g.domain_scope.length > 0 && (
              <>
                <Separator orientation="vertical" className="h-3" />
                <Building2 className="size-2.5" />
                <span>{g.domain_scope.join(', ')}</span>
              </>
            )}
            {g.location_scope.length > 0 && (
              <>
                <Separator orientation="vertical" className="h-3" />
                <MapPin className="size-2.5" />
                <span>{g.location_scope.length}</span>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
