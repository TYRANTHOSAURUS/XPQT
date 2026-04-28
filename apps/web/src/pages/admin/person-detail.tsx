import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus } from 'lucide-react';
import { toastCreated, toastError, toastRemoved } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PersonAvatar } from '@/components/person-avatar';
import { PersonPicker } from '@/components/person-picker';
import { LocationCombobox } from '@/components/location-combobox';
import { OrgNodeCombobox } from '@/components/org-node-combobox';
import { PersonLocationGrantsPanel } from '@/components/admin/person-location-grants-panel';
import { PersonActivityFeed } from '@/components/admin/person-activity-feed';
import { DsrActionsCard } from '@/components/admin/dsr-actions-card';
import {
  usePerson,
  useUpdatePerson,
  personFullName,
  personKeys,
  type Person,
  type PersonLinkedUser,
} from '@/api/persons';
import { useCostCenters } from '@/api/cost-centers';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { apiFetch } from '@/lib/api';
import { supabase } from '@/lib/supabase';

const PERSON_TYPES: Array<{ value: string; label: string }> = [
  { value: 'employee', label: 'Employee' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'vendor_contact', label: 'Vendor contact' },
  { value: 'visitor', label: 'Visitor' },
  { value: 'temporary_worker', label: 'Temporary worker' },
];

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ACCEPTED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function getPrimaryOrgNode(
  person: Person,
): { id: string; name: string; code: string | null } | null {
  const memberships = person.primary_membership ?? [];
  const primary = memberships.find((m) => m.is_primary);
  if (!primary) return null;
  const node = Array.isArray(primary.org_node) ? primary.org_node[0] : primary.org_node;
  return node ?? null;
}

export function getLinkedUser(person: Person): PersonLinkedUser | null {
  const u = person.user;
  if (!u) return null;
  return Array.isArray(u) ? u[0] ?? null : u;
}

async function uploadAvatar(personId: string, tenantId: string, file: File): Promise<string> {
  if (file.size > MAX_AVATAR_BYTES) throw new Error('Avatar must be 2 MB or smaller');
  if (!ACCEPTED_AVATAR_TYPES.includes(file.type))
    throw new Error('Avatar must be JPEG, PNG, or WebP');
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
  const path = `${tenantId}/${personId}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('avatars')
    .upload(path, file, { upsert: true, cacheControl: '3600', contentType: file.type });
  if (uploadErr) throw uploadErr;
  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}

// ---------------------------------------------------------------------------
// AvatarUploadRow
// ---------------------------------------------------------------------------

function AvatarUploadRow({
  person,
  onUploaded,
  onRemoved,
}: {
  person: Person;
  onUploaded: (url: string) => void;
  onRemoved: () => void;
}) {
  const [uploading, setUploading] = useState(false);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!person.tenant_id) {
      toastError("Couldn't upload avatar", {
        error: new Error('person has no tenant id'),
      });
      e.target.value = '';
      return;
    }
    setUploading(true);
    try {
      const url = await uploadAvatar(person.id, person.tenant_id, file);
      onUploaded(url);
    } catch (err) {
      toastError("Couldn't upload avatar", { error: err as Error });
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div className="flex items-center gap-3">
      <PersonAvatar person={person} size="lg" />
      <label
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'cursor-pointer')}
      >
        {uploading ? 'Uploading…' : person.avatar_url ? 'Replace' : 'Upload'}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={handleFile}
          disabled={uploading}
        />
      </label>
      {person.avatar_url && (
        <Button variant="ghost" size="sm" onClick={onRemoved} disabled={uploading}>
          Remove
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LinkedUserControl
// ---------------------------------------------------------------------------

function LinkedUserControl({ person }: { person: Person }) {
  const qc = useQueryClient();
  const linked = getLinkedUser(person);
  const [inviting, setInviting] = useState(false);

  if (linked) {
    return (
      <div className="flex items-center gap-2">
        <Badge
          variant={linked.status === 'active' ? 'default' : 'secondary'}
          className="text-[10px] capitalize"
        >
          {linked.status}
        </Badge>
        <Link
          to={`/admin/users/${linked.id}`}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        >
          Open user
        </Link>
      </div>
    );
  }

  if (!person.email) {
    return (
      <span className="text-xs text-muted-foreground">
        Add an email above to invite this person.
      </span>
    );
  }

  const handleInvite = async () => {
    setInviting(true);
    try {
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({ person_id: person.id, email: person.email, status: 'active' }),
      });
      qc.invalidateQueries({ queryKey: personKeys.detail(person.id) });
      toastCreated('User account');
    } catch (err) {
      toastError("Couldn't create account", { error: err as Error, retry: handleInvite });
    } finally {
      setInviting(false);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleInvite} disabled={inviting}>
      <UserPlus className="size-4" />
      {inviting ? 'Inviting…' : 'Invite as user'}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// PersonDetailBody — exported so persons.tsx split-view inspector can reuse it
// ---------------------------------------------------------------------------

export function PersonDetailBody({ personId }: { personId: string }) {
  const { data: person, isLoading } = usePerson(personId);
  const { data: costCenters } = useCostCenters({ active: true });
  const update = useUpdatePerson(personId);
  const navigate = useNavigate();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [costCenter, setCostCenter] = useState('');
  const [type, setType] = useState<string>('employee');
  const [active, setActive] = useState(true);
  const [primaryOrgNodeId, setPrimaryOrgNodeId] = useState<string | null>(null);
  const [defaultLocationId, setDefaultLocationId] = useState<string | null>(null);
  const [managerId, setManagerId] = useState('');
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  // Hydrate from server response on first load + when the id changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!person) return;
    setFirstName(person.first_name ?? '');
    setLastName(person.last_name ?? '');
    setEmail(person.email ?? '');
    setPhone(person.phone ?? '');
    setCostCenter(person.cost_center ?? '');
    setType((person.type as string) ?? 'employee');
    setActive(person.active ?? true);
    setDefaultLocationId(person.default_location_id ?? null);
    setManagerId(person.manager_person_id ?? '');
    setPrimaryOrgNodeId(getPrimaryOrgNode(person)?.id ?? null);
  }, [person?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Surface PATCH failures as toasts so silent save errors stop being silent.
  useEffect(() => {
    if (update.error) toastError("Couldn't save changes", { error: update.error });
  }, [update.error]);

  useDebouncedSave(firstName, (v) => {
    if (!person || v === person.first_name) return;
    update.mutate({ first_name: v });
  });
  useDebouncedSave(lastName, (v) => {
    if (!person || v === person.last_name) return;
    update.mutate({ last_name: v });
  });
  useDebouncedSave(email, (v) => {
    if (!person || v === (person.email ?? '')) return;
    update.mutate({ email: v || null });
  });
  useDebouncedSave(phone, (v) => {
    if (!person || v === (person.phone ?? '')) return;
    update.mutate({ phone: v || null });
  });

  if (isLoading) return <Skeleton className="h-96" />;
  if (!person) {
    return (
      <p className="text-sm text-muted-foreground">
        This person doesn't exist or you don't have access.
      </p>
    );
  }

  return (
    <>
      {/* ------------------------------------------------------------------ */}
      {/* Identity                                                             */}
      {/* ------------------------------------------------------------------ */}
      <SettingsGroup title="Identity" description="Display name, contact details, and avatar.">
        <SettingsRow
          label="Avatar"
          description="Shown across the app where this person appears."
        >
          <SettingsRowValue>
            <AvatarUploadRow
              person={person}
              onUploaded={(url) => update.mutate({ avatar_url: url })}
              onRemoved={() => update.mutate({ avatar_url: null })}
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="First name">
          <SettingsRowValue>
            <Input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="h-8 w-56"
              aria-label="First name"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Last name">
          <SettingsRowValue>
            <Input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="h-8 w-56"
              aria-label="Last name"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Email" description="Primary contact and login identifier.">
          <SettingsRowValue>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-8 w-72"
              aria-label="Email"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Phone">
          <SettingsRowValue>
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="h-8 w-56"
              aria-label="Phone"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Type" description="What kind of person this record represents.">
          <SettingsRowValue>
            <Select
              value={type}
              onValueChange={(v) => {
                if (!v) return;
                setType(v);
                update.mutate({ type: v });
              }}
            >
              <SelectTrigger className="h-8 w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERSON_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow
          label="Cost center"
          description="Internal accounting tag, optional. Pick from the catalog managed under Admin · Cost centers."
        >
          <SettingsRowValue>
            <Select
              value={costCenter || '__none__'}
              onValueChange={(v) => {
                const next = !v || v === '__none__' ? '' : v;
                setCostCenter(next);
                if (next === (person.cost_center ?? '')) return;
                update.mutate({ cost_center: next || null });
              }}
            >
              <SelectTrigger className="h-8 w-72" aria-label="Cost center">
                <SelectValue placeholder="No cost center" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No cost center</SelectItem>
                {(costCenters ?? []).map((cc) => (
                  <SelectItem key={cc.id} value={cc.code}>
                    <span className="font-mono text-xs tabular-nums">{cc.code}</span>
                    <span className="ml-2 text-muted-foreground">{cc.name}</span>
                  </SelectItem>
                ))}
                {costCenter &&
                  !(costCenters ?? []).some((cc) => cc.code === costCenter) && (
                    <SelectItem value={costCenter}>
                      <span className="font-mono text-xs tabular-nums">{costCenter}</span>
                      <span className="ml-2 text-muted-foreground">(not in catalog)</span>
                    </SelectItem>
                  )}
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow
          label="Active"
          description="Inactive people are hidden from pickers and cannot submit requests."
        >
          <SettingsRowValue>
            <Switch
              checked={active}
              onCheckedChange={(v) => {
                setActive(v);
                update.mutate({ active: v });
              }}
              aria-label="Active"
            />
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      {/* ------------------------------------------------------------------ */}
      {/* Organisation & access                                                */}
      {/* ------------------------------------------------------------------ */}
      <SettingsGroup
        title="Organisation & access"
        description="Where this person sits in the org tree, their default work location, manager, and platform account."
      >
        <SettingsRow
          label="Primary organisation"
          description="The person's primary node in the org tree. Inherits the node's location grants in the portal."
        >
          <SettingsRowValue>
            <OrgNodeCombobox
              value={primaryOrgNodeId}
              onChange={(v) => {
                setPrimaryOrgNodeId(v);
                update.mutate({ primary_org_node_id: v });
              }}
              placeholder="No organisation"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow
          label="Default work location"
          description="Sets the portal's default site/building for new requests. Sites and buildings only."
        >
          <SettingsRowValue>
            <LocationCombobox
              value={defaultLocationId}
              onChange={(v) => {
                setDefaultLocationId(v);
                update.mutate({ default_location_id: v });
              }}
              typesFilter={['site', 'building']}
              activeOnly
              placeholder="None"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Manager">
          <SettingsRowValue>
            <PersonPicker
              value={managerId}
              onChange={(v) => {
                setManagerId(v);
                update.mutate({ manager_person_id: v || null });
              }}
              excludeId={personId}
              placeholder="No manager"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow
          label="Linked user account"
          description="Whether this person can sign in to the platform."
        >
          <SettingsRowValue>
            <LinkedUserControl person={person} />
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      {/* ------------------------------------------------------------------ */}
      {/* Location grants                                                       */}
      {/* ------------------------------------------------------------------ */}
      <SettingsSection
        title="Location grants"
        description="Every location this person can submit requests for — default + grants + org inheritance."
      >
        <PersonLocationGrantsPanel personId={personId} />
      </SettingsSection>

      {/* ------------------------------------------------------------------ */}
      {/* Activity                                                              */}
      {/* ------------------------------------------------------------------ */}
      <SettingsSection
        title="Activity"
        description="Recent tickets, bookings, and audit events for this person."
      >
        <PersonActivityFeed personId={personId} limit={20} />
      </SettingsSection>

      {/* ------------------------------------------------------------------ */}
      {/* Danger zone                                                           */}
      {/* ------------------------------------------------------------------ */}
      <SettingsGroup title="Danger zone">
        <SettingsRow
          label="Deactivate person"
          description="Hides this person from pickers and prevents new requests under their name. Existing tickets keep the historical reference."
        >
          <SettingsRowValue>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDeactivate(true)}
              disabled={!active}
            >
              <Trash2 className="size-4" />
              Deactivate
            </Button>
          </SettingsRowValue>
        </SettingsRow>
        <DsrActionsCard
          personId={personId}
          subjectName={personFullName(person) || person.email || 'this person'}
        />
      </SettingsGroup>

      <ConfirmDialog
        open={confirmDeactivate}
        onOpenChange={setConfirmDeactivate}
        title={`Deactivate ${personFullName(person)}?`}
        description="They will be hidden from request submission and assignment. You can reactivate later."
        confirmLabel="Deactivate"
        destructive
        onConfirm={async () => {
          await update.mutateAsync({ active: false });
          setActive(false);
          setConfirmDeactivate(false);
          toastRemoved(personFullName(person), { verb: 'deactivated' });
          navigate('/admin/persons');
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// PersonDetailPage — thin route shell
// ---------------------------------------------------------------------------

export function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: person, isLoading } = usePerson(id);

  if (!id) return null;

  const headline = !person
    ? isLoading
      ? 'Loading…'
      : 'Not found'
    : personFullName(person) || person.email || 'Unnamed person';

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/persons"
        title={headline}
        description={person?.email ?? 'Person profile and access scope.'}
        actions={
          person ? (
            <div className="flex items-center gap-2">
              <PersonAvatar person={person} size="default" />
              <Badge
                variant={person.active ? 'default' : 'outline'}
                className="text-[10px] uppercase tracking-wider"
              >
                {person.active ? 'Active' : 'Inactive'}
              </Badge>
            </div>
          ) : null
        }
      />
      <PersonDetailBody personId={id} />
    </SettingsPageShell>
  );
}
