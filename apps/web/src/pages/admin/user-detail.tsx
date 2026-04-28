import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { Shield, AlertTriangle, Clock, MapPin, Building2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import { SettingsGroup, SettingsRow, SettingsRowValue } from '@/components/ui/settings-row';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useEffectivePermissions,
  type EffectivePermissionsModule,
  type EffectivePermissionGrant,
} from '@/api/permissions';
import { useUserAudit } from '@/api/roles';
import { useUpdateUser, useSendPasswordReset } from '@/api/users';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { RoleAuditFeed } from '@/components/admin/role-audit-feed';
import { UserSignInHistory } from '@/components/admin/user-sign-in-history';
import { DsrActionsCard } from '@/components/admin/dsr-actions-card';
import { PersonPicker } from '@/components/person-picker';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toastSuccess, toastError } from '@/lib/toast';

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

export interface UserDetail {
  id: string;
  email: string;
  username: string | null;
  status: string;
  last_login_at: string | null;
  person_id: string | null;
  person?: PersonShort | null;
  role_assignments?: RoleAssignment[];
}

const userDetailKey = (id: string) => ['users', 'detail', id] as const;

export function userDetailOptions(id: string | undefined) {
  return queryOptions({
    queryKey: userDetailKey(id ?? ''),
    queryFn: ({ signal }) => apiFetch<UserDetail>(`/users/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function userDisplayName(user: Pick<UserDetail, 'email' | 'person'>): string {
  return user.person
    ? `${user.person.first_name} ${user.person.last_name}`
    : user.email;
}

/**
 * Body sections for the user detail view. Used by both the dedicated route
 * (UserDetailPage) and the inspector panel on /admin/users.
 */
export function UserDetailBody({ userId }: { userId: string }) {
  const userQuery = useQuery(userDetailOptions(userId));
  const effectiveQuery = useEffectivePermissions(userId);
  const auditQuery = useUserAudit(userId);
  const update = useUpdateUser(userId);
  const sendReset = useSendPasswordReset();

  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const user = userQuery.data;
  const effective = effectiveQuery.data;

  if (userQuery.isLoading) {
    return <Skeleton className="h-96" />;
  }

  if (!user) {
    return (
      <p className="text-sm text-muted-foreground">
        This user doesn't exist or you don't have access.
      </p>
    );
  }

  const personId = user.person_id ?? user.person?.id ?? null;
  const subjectName = user.person
    ? `${user.person.first_name} ${user.person.last_name}`
    : user.email;

  return (
    <>
      <SettingsGroup title="Identity" description="Login email is fixed; everything else can be edited.">
        <SettingsRow label="Email" description="Authentication identifier; change via Supabase Auth.">
          <SettingsRowValue>
            <span className="text-sm text-muted-foreground">{user.email}</span>
          </SettingsRowValue>
        </SettingsRow>
        <UsernameRow user={user} onChange={(v) => update.mutate({ username: v || null })} />
        <SettingsRow label="Status">
          <SettingsRowValue>
            <Select
              value={user.status}
              onValueChange={(v) => {
                if (v) update.mutate({ status: v });
              }}
            >
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Linked person" description="The person record this account represents.">
          <SettingsRowValue>
            <PersonPicker
              value={personId ?? ''}
              onChange={(v) => update.mutate({ person_id: v || null })}
              placeholder="No linked person"
            />
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Sign-in" description="Recent sign-ins and account recovery.">
        <SettingsRow label="Last sign-in">
          <SettingsRowValue>
            {user.last_login_at ? (
              <time
                className="tabular-nums text-sm"
                dateTime={user.last_login_at}
                title={formatFullTimestamp(user.last_login_at)}
              >
                {formatRelativeTime(user.last_login_at)}
              </time>
            ) : (
              <span className="text-sm text-muted-foreground">Never</span>
            )}
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Recent sign-ins" description="Last 10 successful sign-ins.">
          <div className="px-3 py-2 w-full">
            <UserSignInHistory userId={userId} limit={10} />
          </div>
        </SettingsRow>
        <SettingsRow
          label="Send password reset"
          description="Triggers Supabase Auth recovery email to the user's address."
        >
          <SettingsRowValue>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmReset(true)}
              disabled={sendReset.isPending}
            >
              {sendReset.isPending ? 'Sending…' : 'Send reset email'}
            </Button>
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

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

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label={user.status === 'suspended' ? 'Reactivate account' : 'Suspend account'}
          description="Suspended accounts cannot sign in. Existing sessions are not revoked."
        >
          <SettingsRowValue>
            <Button
              variant={user.status === 'suspended' ? 'outline' : 'destructive'}
              size="sm"
              onClick={() => setConfirmSuspend(true)}
            >
              {user.status === 'suspended' ? 'Reactivate' : 'Suspend'}
            </Button>
          </SettingsRowValue>
        </SettingsRow>
        <DsrActionsCard personId={personId} subjectName={subjectName} />
      </SettingsGroup>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={`Send password reset to ${user.email}?`}
        description="The user will receive a recovery link via email."
        confirmLabel="Send reset email"
        onConfirm={async () => {
          try {
            await sendReset.mutateAsync({ userId });
            toastSuccess('Reset email sent', { description: user.email });
          } catch (err) {
            toastError("Couldn't send reset email", {
              error: err,
              retry: () => sendReset.mutate({ userId }),
            });
          }
        }}
      />

      <ConfirmDialog
        open={confirmSuspend}
        onOpenChange={setConfirmSuspend}
        title={
          user.status === 'suspended'
            ? `Reactivate ${subjectName}?`
            : `Suspend ${subjectName}?`
        }
        description={
          user.status === 'suspended'
            ? 'They can sign in again immediately.'
            : 'They will be blocked from signing in. Existing sessions stay valid until they expire.'
        }
        confirmLabel={user.status === 'suspended' ? 'Reactivate' : 'Suspend'}
        destructive={user.status !== 'suspended'}
        onConfirm={async () => {
          await update.mutateAsync({
            status: user.status === 'suspended' ? 'active' : 'suspended',
          });
        }}
      />
    </>
  );
}

function UsernameRow({
  user,
  onChange,
}: {
  user: UserDetail;
  onChange: (v: string) => void;
}) {
  const [value, setValue] = useState(user.username ?? '');
  // Re-sync when the underlying user changes (different id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setValue(user.username ?? ''); }, [user.id]);
  useDebouncedSave(value, (v) => {
    if (v === (user.username ?? '')) return;
    onChange(v);
  });
  return (
    <SettingsRow label="Username" description="Optional handle. Doesn't affect login.">
      <SettingsRowValue>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 w-56"
          placeholder="None"
          aria-label="Username"
        />
      </SettingsRowValue>
    </SettingsRow>
  );
}

export function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const userQuery = useQuery(userDetailOptions(id));
  const user = userQuery.data;

  if (userQuery.isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader title="User" backTo="/admin/users" />
        <Skeleton className="h-96" />
      </SettingsPageShell>
    );
  }

  if (!user || !id) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader title="User not found" backTo="/admin/users" />
        <p className="text-sm text-muted-foreground">
          This user doesn't exist or you don't have access.
        </p>
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/users"
        title={userDisplayName(user)}
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
      <UserDetailBody userId={id} />
    </SettingsPageShell>
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
  return formatFullTimestamp(iso);
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
