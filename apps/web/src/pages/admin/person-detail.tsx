import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toastError, toastRemoved } from '@/lib/toast';
import { Trash2 } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PersonLocationGrantsPanel } from '@/components/admin/person-location-grants-panel';
import { PersonAvatar } from '@/components/person-avatar';
import { SaveIndicator } from '@/components/save-indicator';
import { usePerson, useUpdatePerson, personFullName, type Person } from '@/api/persons';
import { useCostCenters } from '@/api/cost-centers';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { userStatusDotClass } from '@/lib/status-tone';
import { cn } from '@/lib/utils';

const PERSON_TYPES: Array<{ value: string; label: string }> = [
  { value: 'employee', label: 'Employee' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'vendor_contact', label: 'Vendor contact' },
  { value: 'visitor', label: 'Visitor' },
  { value: 'temporary_worker', label: 'Temporary worker' },
];

export function personHeadline(person: Pick<Person, 'first_name' | 'last_name' | 'full_name' | 'email'>): string {
  return personFullName(person) || person.email || 'Unnamed person';
}

/**
 * Body sections for the person detail view. Shared by the dedicated route
 * (PersonDetailPage) and the inspector panel on /admin/persons. Renders
 * Identity rows + Location grants + Danger zone — no shell or header chrome.
 */
export function PersonDetailBody({
  personId,
  onDeactivated,
}: {
  personId: string;
  onDeactivated?: () => void;
}) {
  const { data: person, isLoading } = usePerson(personId);
  const { data: costCenters } = useCostCenters({ active: true });
  const update = useUpdatePerson(personId);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [costCenter, setCostCenter] = useState('');
  const [type, setType] = useState<string>('employee');
  const [active, setActive] = useState(true);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  // Hydrate local state from server response. Subsequent edits go through
  // useDebouncedSave; we only sync from server on first load + id change.
  const loadedId = person?.id;
  useEffect(() => {
    if (!person) return;
    setFirstName(person.first_name ?? '');
    setLastName(person.last_name ?? '');
    setEmail(person.email ?? '');
    setPhone(person.phone ?? '');
    setCostCenter(person.cost_center ?? '');
    setType((person.type as string) ?? 'employee');
    setActive(person.active ?? true);
  }, [loadedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Surface PATCH failures as toasts so silent save errors stop being silent.
  useEffect(() => {
    if (update.error) {
      toastError("Couldn't save changes", { error: update.error });
    }
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

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (!person) {
    return <p className="text-sm text-muted-foreground">Person not found.</p>;
  }

  const headline = personHeadline(person);

  const matchedCostCenter = (costCenters ?? []).find((cc) => cc.code === costCenter);

  return (
    <>
      <div className="flex justify-end min-h-5">
        <SaveIndicator
          isPending={update.isPending}
          submittedAt={update.submittedAt}
          isSuccess={update.isSuccess}
        />
      </div>
      <SettingsGroup title="Identity">
        <SettingsRow label="First name">
          <SettingsRowValue>
            <Input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="h-8 w-80"
              aria-label="First name"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Last name">
          <SettingsRowValue>
            <Input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="h-8 w-80"
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
              className="h-8 w-80"
              aria-label="Email"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label={<>Phone <span className="text-muted-foreground font-normal">(optional)</span></>}>
          <SettingsRowValue>
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="h-8 w-80"
              aria-label="Phone"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Type">
          <SettingsRowValue>
            <Select
              value={type}
              onValueChange={(v) => {
                if (!v) return;
                setType(v);
                update.mutate({ type: v });
              }}
            >
              <SelectTrigger className="h-8 w-80">
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
          label={<>Cost center <span className="text-muted-foreground font-normal">(optional)</span></>}
          description="Pick from the catalog managed under Admin · Cost centers."
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
              <SelectTrigger className="h-8 w-80" aria-label="Cost center">
                {costCenter ? (
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs tabular-nums shrink-0">{costCenter}</span>
                    {matchedCostCenter ? (
                      <span className="text-muted-foreground truncate">{matchedCostCenter.name}</span>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 text-amber-900 dark:text-amber-100 text-[10px] uppercase tracking-wider shrink-0"
                      >
                        Not in catalog
                      </Badge>
                    )}
                  </span>
                ) : (
                  <SelectValue placeholder="No cost center" />
                )}
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No cost center</SelectItem>
                {(costCenters ?? []).map((cc) => (
                  <SelectItem key={cc.id} value={cc.code}>
                    <span className="font-mono text-xs tabular-nums">{cc.code}</span>
                    <span className="ml-2 text-muted-foreground">{cc.name}</span>
                  </SelectItem>
                ))}
                {costCenter && !matchedCostCenter && (
                  <SelectItem value={costCenter}>
                    <span className="font-mono text-xs tabular-nums">{costCenter}</span>
                    <Badge
                      variant="outline"
                      className="ml-2 border-amber-500/40 text-amber-900 dark:text-amber-100 text-[10px] uppercase tracking-wider"
                    >
                      Not in catalog
                    </Badge>
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

      <SettingsSection
        title="Location grants"
        description="Default work location, explicit grants, and grants inherited through org memberships."
      >
        <PersonLocationGrantsPanel personId={person.id} />
      </SettingsSection>

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
      </SettingsGroup>

      <ConfirmDialog
        open={confirmDeactivate}
        onOpenChange={setConfirmDeactivate}
        title={`Deactivate ${headline}?`}
        description="They will be hidden from request submission and assignment. You can reactivate them later from this page."
        confirmLabel="Deactivate"
        destructive
        onConfirm={async () => {
          await update.mutateAsync({ active: false });
          setActive(false);
          setConfirmDeactivate(false);
          toastRemoved(headline, { verb: 'deactivated' });
          onDeactivated?.();
        }}
      />
    </>
  );
}

export function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: person, isLoading } = usePerson(id);

  const headline = useMemo(() => {
    if (!person) return 'Loading…';
    return personHeadline(person);
  }, [person]);

  if (!id) return null;

  if (isLoading) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader
          backTo="/admin/persons"
          title="Loading…"
          description="Fetching person details"
        />
      </SettingsPageShell>
    );
  }

  if (!person) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader
          backTo="/admin/persons"
          title="Not found"
          description={`No person with id ${id} in this tenant.`}
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        backTo="/admin/persons"
        title={headline}
        description={person.email ?? 'Person profile and access scope.'}
        leadingMedia={<PersonAvatar person={person} size="lg" />}
        actions={
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-wider gap-1.5"
          >
            <span
              className={cn(
                'size-1.5 rounded-full transition-colors duration-200 ease-[var(--ease-smooth)]',
                userStatusDotClass(person.active ? 'active' : 'inactive'),
              )}
              aria-hidden
            />
            {person.active ? 'Active' : 'Inactive'}
          </Badge>
        }
      />
      <PersonDetailBody
        personId={id}
        onDeactivated={() => navigate('/admin/persons')}
      />
    </SettingsPageShell>
  );
}
