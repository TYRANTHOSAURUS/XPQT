import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toastError, toastRemoved } from '@/lib/toast';
import { Trash2 } from 'lucide-react';
import {
  SettingsPageHeader,
  SettingsPageShell,
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
import { usePerson, useUpdatePerson, personFullName } from '@/api/persons';
import { useDebouncedSave } from '@/hooks/use-debounced-save';

const PERSON_TYPES: Array<{ value: string; label: string }> = [
  { value: 'employee', label: 'Employee' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'vendor_contact', label: 'Vendor contact' },
  { value: 'visitor', label: 'Visitor' },
  { value: 'temporary_worker', label: 'Temporary worker' },
];

export function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: person, isLoading } = usePerson(id);
  const update = useUpdatePerson(id);

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
  const personId = person?.id;
  useEffect(() => {
    if (!person) return;
    setFirstName(person.first_name ?? '');
    setLastName(person.last_name ?? '');
    setEmail(person.email ?? '');
    setPhone(person.phone ?? '');
    setCostCenter(person.cost_center ?? '');
    setType((person.type as string) ?? 'employee');
    setActive(person.active ?? true);
  }, [personId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  useDebouncedSave(costCenter, (v) => {
    if (!person || v === (person.cost_center ?? '')) return;
    update.mutate({ cost_center: v || null });
  });

  const headline = useMemo(() => {
    if (!person) return 'Loading…';
    return personFullName(person) || person.email || 'Unnamed person';
  }, [person]);

  if (!id) return null;

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
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
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/persons"
          title="Not found"
          description={`No person with id ${id} in this tenant.`}
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/persons"
        title={headline}
        description={person.email ?? 'Person profile and access scope.'}
        actions={
          <Badge variant={active ? 'default' : 'outline'} className="text-[10px] uppercase tracking-wider">
            {active ? 'Active' : 'Inactive'}
          </Badge>
        }
      />

      <SettingsGroup title="Identity" description="Display name and contact details.">
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
        <SettingsRow label="Cost center" description="Internal accounting tag, optional.">
          <SettingsRowValue>
            <Input
              value={costCenter}
              onChange={(e) => setCostCenter(e.target.value)}
              className="h-8 w-56"
              aria-label="Cost center"
            />
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

      <SettingsGroup
        title="Location grants"
        description="Locations this person can submit requests for, beyond their default location."
      >
        <PersonLocationGrantsPanel personId={person.id} />
      </SettingsGroup>

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
          navigate('/admin/persons');
        }}
      />
    </SettingsPageShell>
  );
}
