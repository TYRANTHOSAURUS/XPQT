import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toastCreated, toastError, toastSaved } from '@/lib/toast';
import { AlertTriangle, ChevronRight, Search, Shield, Users as UsersIcon, Info } from 'lucide-react';
import { expandGranted, normalisePermission, type ModuleMeta } from '@prequest/shared';
import {
  SettingsFooterActions,
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { usePermissionCatalog } from '@/api/permissions';
import {
  useRole,
  useRoles,
  useCreateRole,
  useUpdateRole,
  useRoleAudit,
  type RoleType,
} from '@/api/roles';
import { RoleAuditFeed } from '@/components/admin/role-audit-feed';
import { useUsers } from '@/api/users';

/**
 * Templates surfaced as chips at the top of the New Role page. Names match
 * the seed migration 00112 — if a tenant renamed one, the chip falls back
 * to whatever role name starts with this prefix.
 */
const TEMPLATE_ORDER = [
  'Tenant Admin',
  'IT Agent',
  'FM Agent',
  'Service Desk Lead',
  'Requester',
  'Auditor',
];

/**
 * Permissions that are useless without a paired prerequisite. Surfaces as
 * a soft warning below the picker — evaluator doesn't enforce it because
 * a future caller might pass the dependency at the scope level.
 */
const PREREQUISITES: Record<string, string[]> = {
  'tickets.close': ['tickets.read'],
  'tickets.reopen': ['tickets.read'],
  'tickets.assign': ['tickets.read'],
  'tickets.update': ['tickets.read'],
  'tickets.change_type': ['tickets.read', 'tickets.update'],
  'tickets.change_priority': ['tickets.read', 'tickets.update'],
  'tickets.change_location': ['tickets.read', 'tickets.update'],
  'tickets.comment': ['tickets.read'],
  'tickets.post_private_note': ['tickets.read'],
  'tickets.approve': ['tickets.read'],
  'tickets.escalate': ['tickets.read', 'tickets.assign'],
  'tickets.merge': ['tickets.read', 'tickets.update'],
  'tickets.delete': ['tickets.read'],
  'assets.transfer': ['assets.read', 'assets.update'],
  'assets.check_in': ['assets.read', 'assets.update'],
  'assets.check_out': ['assets.read', 'assets.update'],
  'assets.retire': ['assets.read'],
  'routing.simulate': ['routing.read'],
  'routing.publish': ['routing.read', 'routing.update'],
  'workflows.publish': ['workflows.read', 'workflows.update'],
  'workflows.test': ['workflows.read'],
  'sla.pause': ['sla.read'],
  'sla.resume': ['sla.read'],
};

function computeDependencyWarnings(selected: Set<string>): Array<{ key: string; missing: string[] }> {
  if (selected.has('*.*')) return [];
  const warnings: Array<{ key: string; missing: string[] }> = [];
  for (const key of selected) {
    const prereqs = PREREQUISITES[key];
    if (!prereqs) continue;
    const missing = prereqs.filter((p) => {
      if (selected.has(p)) return true;
      const [res, act] = p.split('.');
      if (selected.has(`${res}.*`)) return true;
      if (selected.has(`*.${act}`)) return true;
      return false;
    });
    const notMet = prereqs.filter((p) => !missing.includes(p));
    if (notMet.length > 0) warnings.push({ key, missing: notMet });
  }
  return warnings;
}

interface UserWithAssignments {
  id: string;
  email: string;
  status: string;
  person?: { id: string; first_name: string; last_name: string; email?: string | null } | null;
  role_assignments?: Array<{
    id: string;
    domain_scope: string[] | null;
    location_scope: string[] | null;
    role: { id: string } | null;
  }>;
}

type RoleTypeOption = { value: RoleType; label: string };
const ROLE_TYPE_OPTIONS: RoleTypeOption[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'agent', label: 'Service desk agent' },
  { value: 'employee', label: 'Employee' },
];

export function RoleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = !id || id === 'new';
  const cloneFromId = isNew ? searchParams.get('from') : null;

  const catalogQuery = usePermissionCatalog();
  const roleQuery = useRole(isNew ? undefined : id);
  const cloneQuery = useRole(cloneFromId ?? undefined);
  const auditQuery = useRoleAudit(isNew ? undefined : id);
  const rolesListQuery = useRoles();
  const { data: allUsers } = useUsers() as { data: UserWithAssignments[] | undefined };
  const createMut = useCreateRole();
  const updateMut = useUpdateRole(id ?? '');

  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [type, setType] = useState<RoleType>('agent');
  const [active, setActive] = useState<boolean>(true);
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [hasHydrated, setHasHydrated] = useState(false);
  // Original snapshot for dirty / diff detection. Only the permissions set
  // and basic metadata trigger a dirty flag; search does not.
  const [original, setOriginal] = useState<{
    name: string;
    description: string;
    type: RoleType;
    active: boolean;
    permissions: Set<string>;
  } | null>(null);

  // Hydrate local state from loaded role once. useEffect, not an inline
  // setter — inline sets during render race with user input if the query
  // resolves after the user starts typing.
  useEffect(() => {
    if (hasHydrated) return;
    const apply = (src: {
      name: string;
      description: string | null;
      type: RoleType | null;
      active?: boolean;
      permissions: string[];
    }, opts: { suffix?: string } = {}) => {
      const nextName = opts.suffix ? `${src.name}${opts.suffix}` : src.name;
      const nextDesc = src.description ?? '';
      const nextType = (src.type ?? 'agent') as RoleType;
      const nextActive = src.active ?? true;
      const nextPerms = new Set((src.permissions ?? []).map(normalisePermission));
      setName(nextName);
      setDescription(nextDesc);
      setType(nextType);
      setActive(nextActive);
      setPermissions(nextPerms);
      setOriginal(
        opts.suffix
          // A clone is "dirty from creation" so the admin sees what they're
          // about to create vs the source. Keep original empty so everything
          // reads as added.
          ? { name: '', description: '', type: 'agent', active: true, permissions: new Set() }
          : { name: nextName, description: nextDesc, type: nextType, active: nextActive, permissions: new Set(nextPerms) },
      );
      setHasHydrated(true);
    };
    if (!isNew && roleQuery.data) apply(roleQuery.data);
    else if (isNew && cloneFromId && cloneQuery.data) apply(cloneQuery.data, { suffix: ' (copy)' });
    else if (isNew && !cloneFromId) {
      setOriginal({ name: '', description: '', type: 'agent', active: true, permissions: new Set() });
      setHasHydrated(true);
    }
  }, [hasHydrated, isNew, cloneFromId, roleQuery.data, cloneQuery.data]);

  const catalog = catalogQuery.data?.catalog;
  const isLoading = catalogQuery.isLoading || (!isNew && roleQuery.isLoading);

  const hasFullWildcard = permissions.has('*.*');

  const togglePermission = (key: string, on: boolean) => {
    setPermissions((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const toggleResourceWildcard = (resource: string, on: boolean) => {
    setPermissions((prev) => {
      const next = new Set(prev);
      const wildcard = `${resource}.*`;
      if (on) {
        next.add(wildcard);
        // Dropping explicit per-action keys under this resource keeps the
        // stored array small and the preview accurate.
        for (const k of Array.from(next)) {
          if (k !== wildcard && k.startsWith(`${resource}.`)) next.delete(k);
        }
      } else {
        next.delete(wildcard);
      }
      return next;
    });
  };

  const toggleFullWildcard = (on: boolean) => {
    setPermissions((prev) => {
      if (on) return new Set(['*.*']);
      const next = new Set(prev);
      next.delete('*.*');
      return next;
    });
  };

  const filteredModules = useMemo(() => {
    if (!catalog) return [] as Array<{ resource: string; mod: ModuleMeta; relevant: string[] }>;
    const q = search.trim().toLowerCase();
    const entries = Object.entries(catalog) as Array<[string, ModuleMeta]>;
    if (!q) {
      return entries.map(([resource, mod]) => ({
        resource,
        mod,
        relevant: [
          ...Object.keys(mod.actions),
          ...(mod.overrides ? Object.keys(mod.overrides) : []),
        ],
      }));
    }
    const out: Array<{ resource: string; mod: ModuleMeta; relevant: string[] }> = [];
    for (const [resource, mod] of entries) {
      const matched: string[] = [];
      const addIf = (action: string, meta: { label: string; description?: string }) => {
        const haystack = `${resource} ${action} ${meta.label} ${meta.description ?? ''}`.toLowerCase();
        if (haystack.includes(q)) matched.push(action);
      };
      for (const [action, meta] of Object.entries(mod.actions)) addIf(action, meta);
      if (mod.overrides) {
        for (const [action, meta] of Object.entries(mod.overrides)) addIf(action, meta);
      }
      if (mod.label.toLowerCase().includes(q) || resource.toLowerCase().includes(q)) {
        matched.push(
          ...Object.keys(mod.actions),
          ...(mod.overrides ? Object.keys(mod.overrides) : []),
        );
      }
      if (matched.length > 0) {
        out.push({ resource, mod, relevant: [...new Set(matched)] });
      }
    }
    return out;
  }, [catalog, search]);

  const sortedPermissions = useMemo(
    () => Array.from(permissions).sort(),
    [permissions],
  );

  const expanded = useMemo(() => expandGranted(sortedPermissions), [sortedPermissions]);

  const hasDanger = useMemo(() => {
    if (!catalog) return false;
    for (const key of permissions) {
      if (key === '*.*') return true;
      const [resource, action] = key.split('.');
      const mod = catalog[resource];
      if (!mod) continue;
      if (action === '*') return Object.values(mod.actions).some((a) => a.danger)
        || Object.values(mod.overrides ?? {}).some((a) => a.danger);
      if (mod.actions[action]?.danger || mod.overrides?.[action]?.danger) return true;
    }
    return false;
  }, [catalog, permissions]);

  // Dirty detection + diff. Compares current vs `original` snapshot.
  const diff = useMemo(() => {
    if (!original) return { added: [] as string[], removed: [] as string[], fieldsChanged: [] as string[] };
    const added = Array.from(permissions).filter((p) => !original.permissions.has(p)).sort();
    const removed = Array.from(original.permissions).filter((p) => !permissions.has(p)).sort();
    const fieldsChanged: string[] = [];
    if (name.trim() !== original.name) fieldsChanged.push('name');
    if ((description.trim() || '') !== (original.description || '')) fieldsChanged.push('description');
    if (type !== original.type) fieldsChanged.push('type');
    if (active !== original.active) fieldsChanged.push('active');
    return { added, removed, fieldsChanged };
  }, [original, permissions, name, description, type, active]);

  const isDirty =
    diff.added.length > 0 ||
    diff.removed.length > 0 ||
    diff.fieldsChanged.length > 0;

  const dependencyWarnings = useMemo(() => computeDependencyWarnings(permissions), [permissions]);

  // Users currently holding this role (edit mode only).
  const usersHoldingRole = useMemo(() => {
    if (isNew || !id || !allUsers) return [] as UserWithAssignments[];
    return allUsers.filter((u) =>
      (u.role_assignments ?? []).some((ra) => ra.role?.id === id),
    );
  }, [isNew, id, allUsers]);

  // Templates surfaced for the New-Role empty state. Ordered by seed list;
  // only shown when no clone source and no hydration yet picked one up.
  const templateOptions = useMemo(() => {
    if (!rolesListQuery.data) return [] as Array<{ id: string; name: string; permCount: number }>;
    return TEMPLATE_ORDER.flatMap((tplName) => {
      const found = rolesListQuery.data.find((r) => r.name.toLowerCase() === tplName.toLowerCase());
      return found ? [{ id: found.id, name: found.name, permCount: (found.permissions ?? []).length }] : [];
    });
  }, [rolesListQuery.data]);

  const onSave = async () => {
    if (!name.trim()) return;
    if (hasDanger) {
      const ok = window.confirm(
        'This role includes destructive or scope-bypassing permissions. Confirm save?',
      );
      if (!ok) return;
    }
    const body = {
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      type,
      permissions: sortedPermissions,
      // active included when editing — the API currently accepts it on update;
      // creates default to active=true server-side.
      ...(isNew ? {} : { active }),
    };
    try {
      if (isNew) {
        const created = await createMut.mutateAsync(body);
        toastCreated('Role', { onView: () => navigate(`/admin/user-roles/${created.id}`) });
        navigate(`/admin/user-roles/${created.id}`);
      } else {
        await updateMut.mutateAsync(body);
        // Refresh the snapshot so "dirty" resets.
        setOriginal({
          name: name.trim(),
          description: description.trim(),
          type,
          active,
          permissions: new Set(permissions),
        });
        toastSaved('Role');
      }
    } catch (err) {
      toastError(isNew ? "Couldn't create role" : "Couldn't save role", { error: err, retry: onSave });
    }
  };

  const onDiscard = () => {
    if (!original) return;
    setName(original.name);
    setDescription(original.description);
    setType(original.type);
    setActive(original.active);
    setPermissions(new Set(original.permissions));
  };

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader title="Role" backTo="/admin/user-roles" />
        <Skeleton className="h-[600px] w-full" />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/user-roles"
        title={isNew ? 'New role' : name || 'Role'}
        description={
          isNew
            ? 'Group permissions and assign this role to users.'
            : `Edit role details and the permissions it grants. ${usersHoldingRole.length} ${usersHoldingRole.length === 1 ? 'user holds' : 'users hold'} this role.`
        }
        actions={
          !isNew ? (
            <Badge variant={active ? 'default' : 'secondary'}>
              {active ? 'Active' : 'Inactive'}
            </Badge>
          ) : null
        }
      />

      {/* Start-from-template chips — only on fresh-new pages with no clone. */}
      {isNew && !cloneFromId && templateOptions.length > 0 && (
        <div className="rounded-lg border bg-card p-4 flex flex-col gap-2">
          <div className="text-sm font-medium">Start from a template</div>
          <p className="text-xs text-muted-foreground">
            Clone one of the seeded templates to skip picking permissions one by
            one. You'll land on a pre-filled Copy with everything ready to tweak.
          </p>
          <div className="flex flex-wrap gap-2">
            {templateOptions.map((tpl) => (
              <Link
                key={tpl.id}
                to={`/admin/user-roles/new?from=${tpl.id}`}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs hover:bg-muted/60 transition-colors"
              >
                <Shield className="size-3" />
                {tpl.name}
                <Badge variant="outline" className="text-[10px]">{tpl.permCount}</Badge>
              </Link>
            ))}
            <button
              type="button"
              onClick={() => {
                // Explicitly commit to a blank start so the template row stops
                // stealing focus if the admin starts typing.
                setOriginal({ name: '', description: '', type: 'agent', active: true, permissions: new Set() });
              }}
              className="inline-flex items-center gap-2 rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted/40"
            >
              Blank role
            </button>
          </div>
        </div>
      )}

      {/* Impact banner — edit mode only, warns before unsaved batch commit. */}
      {!isNew && isDirty && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 flex items-center justify-between gap-4 text-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-600" />
            <span>
              <span className="font-medium">Unsaved changes.</span>{' '}
              {diff.added.length > 0 && <span>{diff.added.length} added</span>}
              {diff.added.length > 0 && (diff.removed.length > 0 || diff.fieldsChanged.length > 0) && ' · '}
              {diff.removed.length > 0 && <span>{diff.removed.length} removed</span>}
              {diff.removed.length > 0 && diff.fieldsChanged.length > 0 && ' · '}
              {diff.fieldsChanged.length > 0 && <span>{diff.fieldsChanged.join(', ')} edited</span>}
              {usersHoldingRole.length > 0 && (
                <span className="text-muted-foreground">
                  {' — will change access for '}
                  {usersHoldingRole.length} {usersHoldingRole.length === 1 ? 'user' : 'users'}
                  {' immediately on save.'}
                </span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={onDiscard}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Discard
          </button>
        </div>
      )}

      <SettingsSection title="Basics">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="role-name">Name</FieldLabel>
            <Input
              id="role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Service Desk Lead"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="role-description">Description</FieldLabel>
            <Input
              id="role-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this role is for and who should hold it"
            />
            <FieldDescription>
              Shown in pickers and in the user's role list. Keep it short and
              goal-oriented.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="role-type">Type</FieldLabel>
            <Select value={type} onValueChange={(v) => setType(v as RoleType)}>
              <SelectTrigger id="role-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Drives the default dashboard and top-nav for users holding this
              role.
            </FieldDescription>
          </Field>
          {!isNew && (
            <Field orientation="horizontal">
              <Switch
                id="role-active"
                checked={active}
                onCheckedChange={(v) => setActive(v === true)}
              />
              <div className="flex flex-col">
                <FieldLabel htmlFor="role-active" className="font-normal">
                  Active
                </FieldLabel>
                <FieldDescription>
                  When off, existing assignments are ignored by the permission
                  check — a safe way to freeze access without deleting the role.
                </FieldDescription>
              </div>
            </Field>
          )}
        </FieldGroup>
      </SettingsSection>

      <SettingsSection title="Permissions" density="tight">
        <div className="flex flex-col gap-4 min-w-0">
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search modules or actions"
                className="pl-8"
              />
            </div>
            <label
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer',
                hasFullWildcard
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-100'
                  : 'hover:bg-muted/60',
              )}
            >
              <Checkbox
                checked={hasFullWildcard}
                onCheckedChange={(v) => toggleFullWildcard(v === true)}
              />
              <Shield className="size-4" />
              Full admin (<code className="text-xs">*.*</code>)
            </label>
          </div>

          <div className="flex flex-col gap-3">
            {filteredModules.map(({ resource, mod, relevant }) => (
              <PermissionModuleCard
                key={resource}
                resource={resource}
                mod={mod}
                relevant={relevant}
                permissions={permissions}
                disabled={hasFullWildcard}
                onToggleAction={togglePermission}
                onToggleResourceWildcard={toggleResourceWildcard}
              />
            ))}
            {filteredModules.length === 0 && (
              <p className="text-sm text-muted-foreground px-1">
                No modules match "{search}".
              </p>
            )}
          </div>

          {dependencyWarnings.length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-100">
                <Info className="size-3.5" />
                Dependency hints
              </div>
              <p className="text-xs text-muted-foreground">
                These actions are granted but their prerequisite actions aren't.
                Users with this role may not be able to use them in practice.
              </p>
              <ul className="text-xs space-y-0.5">
                {dependencyWarnings.map((w) => (
                  <li key={w.key}>
                    <code className="text-[11px]">{w.key}</code>{' '}
                    <span className="text-muted-foreground">needs</span>{' '}
                    {w.missing.map((m, i) => (
                      <span key={m}>
                        <code className="text-[11px]">{m}</code>
                        {i < w.missing.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Preview">
        <div className="rounded-lg border bg-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              What this role will grant once saved.
            </div>
            <Badge variant="secondary">
              {sortedPermissions.length} {sortedPermissions.length === 1 ? 'key' : 'keys'} · grants {expanded.length}
            </Badge>
          </div>
          {hasDanger && (
            <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2 text-xs text-amber-900 dark:text-amber-100">
              <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
              <span>
                This role includes destructive or scope-bypassing permissions.
                Assign it carefully.
              </span>
            </div>
          )}
          {isDirty && (diff.added.length > 0 || diff.removed.length > 0) && (
            <>
              <Separator />
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-2">
                  Change on save
                </div>
                <div className="flex flex-wrap gap-1">
                  {diff.added.map((p) => (
                    <code
                      key={`+${p}`}
                      className="text-[11px] rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5"
                    >
                      + {p}
                    </code>
                  ))}
                  {diff.removed.map((p) => (
                    <code
                      key={`-${p}`}
                      className="text-[11px] rounded border border-destructive/40 bg-destructive/10 px-1.5 py-0.5"
                    >
                      − {p}
                    </code>
                  ))}
                </div>
              </div>
            </>
          )}
          <Separator />
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                Stored permissions
              </div>
              {sortedPermissions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No permissions selected.</p>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {sortedPermissions.map((p) => (
                    <code
                      key={p}
                      className={cn(
                        'text-[11px] rounded border px-1.5 py-0.5 bg-muted/50',
                        p === '*.*' || p.endsWith('_all') || p.startsWith('*.')
                          ? 'border-amber-500/40'
                          : 'border-transparent',
                      )}
                    >
                      {p}
                    </code>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-2">
                Effectively grants ({expanded.length})
              </div>
              {expanded.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing.</p>
              ) : (
                <div className="max-h-56 overflow-auto flex flex-col gap-0.5 pr-1">
                  {expanded.map((k) => (
                    <div key={k} className="text-[11px] text-muted-foreground font-mono">
                      {k}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </SettingsSection>

      {!isNew && (
        <SettingsSection
          title="Users holding this role"
          description={
            usersHoldingRole.length === 0
              ? undefined
              : `${usersHoldingRole.length} ${usersHoldingRole.length === 1 ? 'user' : 'users'} will be affected by changes here.`
          }
        >
          {usersHoldingRole.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No users hold this role yet. Assign it from a user's detail page.
            </p>
          ) : (
            <div className="rounded-lg border bg-card divide-y overflow-hidden">
              {usersHoldingRole.slice(0, 10).map((u) => {
                const ra = (u.role_assignments ?? []).find((a) => a.role?.id === id);
                const domains = ra?.domain_scope ?? [];
                const locs = ra?.location_scope ?? [];
                return (
                  <Link
                    key={u.id}
                    to={`/admin/users/${u.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/40"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <UsersIcon className="size-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm truncate">
                          {u.person
                            ? `${u.person.first_name} ${u.person.last_name}`
                            : u.email}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {u.email}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {domains.length > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          {domains.join(', ')}
                        </Badge>
                      )}
                      {locs.length > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          {locs.length} loc
                        </Badge>
                      )}
                      <Badge
                        variant={u.status === 'active' ? 'default' : 'secondary'}
                        className="text-[10px] capitalize"
                      >
                        {u.status}
                      </Badge>
                    </div>
                  </Link>
                );
              })}
              {usersHoldingRole.length > 10 && (
                <Link
                  to="/admin/users"
                  className="block px-4 py-2.5 text-xs text-muted-foreground hover:bg-muted/40 text-center"
                >
                  View all {usersHoldingRole.length} users →
                </Link>
              )}
            </div>
          )}
        </SettingsSection>
      )}

      {!isNew && (
        <SettingsSection title="Activity">
          <RoleAuditFeed
            events={auditQuery.data}
            loading={auditQuery.isLoading}
            hideTargetRole
            emptyLabel="No role changes yet."
          />
        </SettingsSection>
      )}

      <SettingsFooterActions
        primary={{
          label: isNew
            ? 'Create role'
            : isDirty
              ? `Save ${diff.added.length + diff.removed.length + diff.fieldsChanged.length} change${
                  diff.added.length + diff.removed.length + diff.fieldsChanged.length === 1 ? '' : 's'
                }`
              : 'Saved',
          onClick: onSave,
          loading: createMut.isPending || updateMut.isPending,
          disabled: !name.trim() || (!isNew && !isDirty),
        }}
        secondary={
          isNew
            ? { label: 'Cancel', href: '/admin/user-roles' }
            : isDirty
              ? { label: 'Discard', onClick: onDiscard }
              : { label: 'Back', href: '/admin/user-roles' }
        }
      />
    </SettingsPageShell>
  );
}

interface PermissionModuleCardProps {
  resource: string;
  mod: ModuleMeta;
  relevant: string[];
  permissions: Set<string>;
  disabled: boolean;
  onToggleAction: (key: string, on: boolean) => void;
  onToggleResourceWildcard: (resource: string, on: boolean) => void;
}

function PermissionModuleCard({
  resource,
  mod,
  relevant,
  permissions,
  disabled,
  onToggleAction,
  onToggleResourceWildcard,
}: PermissionModuleCardProps) {
  const [open, setOpen] = useState(true);
  const wildcard = `${resource}.*`;
  const hasWildcard = permissions.has(wildcard);
  const selectedCount = hasWildcard
    ? Object.keys(mod.actions).length + Object.keys(mod.overrides ?? {}).length
    : Array.from(permissions).filter((k) => k.startsWith(`${resource}.`)).length;
  const total =
    Object.keys(mod.actions).length + Object.keys(mod.overrides ?? {}).length;

  return (
    <FieldSet
      className={cn(
        'rounded-lg border bg-card transition-opacity',
        disabled && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight
            className={cn(
              'size-4 text-muted-foreground transition-transform shrink-0',
              open && 'rotate-90',
            )}
          />
          <div className="min-w-0">
            <FieldLegend className="text-sm font-medium">{mod.label}</FieldLegend>
            {mod.description && (
              <p className="text-xs text-muted-foreground truncate">
                {mod.description}
              </p>
            )}
          </div>
        </div>
        <Badge variant={selectedCount > 0 ? 'default' : 'secondary'}>
          {hasWildcard ? 'All actions' : `${selectedCount}/${total}`}
        </Badge>
      </button>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-3">
          <Field
            orientation="horizontal"
            className="rounded-md bg-muted/40 px-3 py-2"
          >
            <Checkbox
              id={`${resource}-wildcard`}
              checked={hasWildcard}
              onCheckedChange={(v) => onToggleResourceWildcard(resource, v === true)}
              disabled={disabled}
            />
            <div className="flex flex-col gap-0.5">
              <FieldLabel
                htmlFor={`${resource}-wildcard`}
                className="text-sm font-normal"
              >
                All actions in {mod.label} (<code className="text-xs">{wildcard}</code>)
              </FieldLabel>
              <span className="text-xs text-muted-foreground">
                Grants every current and future action in this module.
              </span>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            {Object.entries(mod.actions)
              .filter(([action]) => relevant.includes(action))
              .map(([action, meta]) => {
                const key = `${resource}.${action}`;
                const checked = hasWildcard || permissions.has(key);
                return (
                  <ActionRow
                    key={key}
                    permissionKey={key}
                    label={meta.label}
                    description={meta.description}
                    danger={!!meta.danger}
                    checked={checked}
                    disabled={disabled || hasWildcard}
                    onToggle={(v) => onToggleAction(key, v)}
                  />
                );
              })}
          </div>

          {mod.overrides && Object.keys(mod.overrides).length > 0 && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-100">
                <Shield className="size-3.5" />
                Overrides (bypass scope)
              </div>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(mod.overrides)
                  .filter(([action]) => relevant.includes(action))
                  .map(([action, meta]) => {
                    const key = `${resource}.${action}`;
                    const checked = hasWildcard || permissions.has(key);
                    return (
                      <ActionRow
                        key={key}
                        permissionKey={key}
                        label={meta.label}
                        description={meta.description}
                        danger
                        checked={checked}
                        disabled={disabled || hasWildcard}
                        onToggle={(v) => onToggleAction(key, v)}
                      />
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      )}
    </FieldSet>
  );
}

interface ActionRowProps {
  permissionKey: string;
  label: string;
  description?: string;
  danger: boolean;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}

function ActionRow({
  permissionKey,
  label,
  description,
  danger,
  checked,
  disabled,
  onToggle,
}: ActionRowProps) {
  return (
    <Field
      orientation="horizontal"
      className={cn(
        'rounded-md border px-3 py-2 items-start',
        checked && 'bg-muted/30 border-muted-foreground/20',
        danger && checked && 'border-amber-500/40 bg-amber-500/5',
      )}
    >
      <Checkbox
        id={permissionKey}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onToggle(v === true)}
      />
      <div className="flex flex-col gap-0.5 min-w-0">
        <FieldLabel
          htmlFor={permissionKey}
          className="text-sm font-normal flex items-center gap-1.5"
        >
          {label}
          {danger && <Shield className="size-3 text-amber-600" />}
        </FieldLabel>
        <code className="text-[10px] text-muted-foreground font-mono truncate">
          {permissionKey}
        </code>
        {description && (
          <span className="text-xs text-muted-foreground">{description}</span>
        )}
      </div>
    </Field>
  );
}
