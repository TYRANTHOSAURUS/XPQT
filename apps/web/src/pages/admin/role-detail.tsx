import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, ChevronRight, Search, Shield } from 'lucide-react';
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
  useCreateRole,
  useUpdateRole,
  useRoleAudit,
  type RoleType,
} from '@/api/roles';
import { RoleAuditFeed } from '@/components/admin/role-audit-feed';

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
  const createMut = useCreateRole();
  const updateMut = useUpdateRole(id ?? '');

  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [type, setType] = useState<RoleType>('agent');
  const [permissions, setPermissions] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [hasHydrated, setHasHydrated] = useState(false);

  // Hydrate local state from loaded role once. useEffect, not an inline
  // setter — inline sets during render race with user input if the query
  // resolves after the user starts typing.
  useEffect(() => {
    if (hasHydrated) return;
    if (!isNew && roleQuery.data) {
      const role = roleQuery.data;
      setName(role.name);
      setDescription(role.description ?? '');
      setType((role.type ?? 'agent') as RoleType);
      setPermissions(new Set((role.permissions ?? []).map(normalisePermission)));
      setHasHydrated(true);
    } else if (isNew && cloneFromId && cloneQuery.data) {
      const src = cloneQuery.data;
      setName(`${src.name} (copy)`);
      setDescription(src.description ?? '');
      setType((src.type ?? 'agent') as RoleType);
      setPermissions(new Set((src.permissions ?? []).map(normalisePermission)));
      setHasHydrated(true);
    } else if (isNew && !cloneFromId) {
      // Fresh create without a clone source — nothing to hydrate; mark done
      // so later query resolutions (e.g. a stray from=… appearing) never
      // clobber user input.
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

  const onSave = async () => {
    if (!name.trim()) {
      toast.error('Role name is required');
      return;
    }
    const body = {
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      type,
      permissions: sortedPermissions,
    };
    try {
      if (isNew) {
        const created = await createMut.mutateAsync(body);
        toast.success('Role created');
        navigate(`/admin/user-roles/${created.id}`);
      } else {
        await updateMut.mutateAsync(body);
        toast.success('Role saved');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      toast.error(message);
    }
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
            : 'Edit role details and the permissions it grants.'
        }
      />

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
          label: isNew ? 'Create role' : 'Save changes',
          onClick: onSave,
          loading: createMut.isPending || updateMut.isPending,
          disabled: !name.trim(),
        }}
        secondary={{ label: 'Cancel', href: '/admin/user-roles' }}
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
