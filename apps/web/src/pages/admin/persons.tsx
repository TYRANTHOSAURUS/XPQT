import { useState } from 'react';
import { Link } from 'react-router-dom';
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
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Pencil, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { usePersons, personKeys } from '@/api/persons';
import { apiFetch } from '@/lib/api';
import { PersonPicker } from '@/components/person-picker';
import { LocationCombobox } from '@/components/location-combobox';
import { OrgNodeCombobox } from '@/components/org-node-combobox';
import { PersonLocationGrantsPanel } from '@/components/admin/person-location-grants-panel';
import { FieldSeparator } from '@/components/ui/field';
import { TableLoading, TableEmpty } from '@/components/table-states';

interface PrimaryMembership {
  org_node_id: string;
  is_primary: boolean;
  org_node: { id: string; name: string; code: string | null } | { id: string; name: string; code: string | null }[] | null;
}

interface PersonLinkedUser {
  id: string;
  email: string;
  status: string;
}

interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  type: string;
  cost_center: string | null;
  manager_person_id: string | null;
  manager?: { id: string; first_name: string; last_name: string } | null;
  default_location_id: string | null;
  active: boolean;
  primary_membership?: PrimaryMembership[] | null;
  user?: PersonLinkedUser[] | PersonLinkedUser | null;
}

function getPrimaryOrgNode(person: Person): { id: string; name: string; code: string | null } | null {
  const memberships = person.primary_membership ?? [];
  const primary = memberships.find((m) => m.is_primary);
  if (!primary) return null;
  const node = Array.isArray(primary.org_node) ? primary.org_node[0] : primary.org_node;
  return node ?? null;
}

function getLinkedUser(person: Person): PersonLinkedUser | null {
  // Supabase returns a one-to-one reverse FK as an array when the column
  // has no unique constraint. Normalise to a single value.
  const u = person.user;
  if (!u) return null;
  return Array.isArray(u) ? u[0] ?? null : u;
}

const personTypes = [
  { value: 'employee', label: 'Employee' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'vendor_contact', label: 'Vendor Contact' },
  { value: 'temporary_worker', label: 'Temporary Worker' },
];

const typeColors: Record<string, 'default' | 'secondary' | 'outline'> = {
  employee: 'default',
  contractor: 'secondary',
  vendor_contact: 'outline',
  temporary_worker: 'outline',
};


export function PersonsPage() {
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState('all');
  const { data, isPending: loading } = usePersons(typeFilter) as { data: Person[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: personKeys.all });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState('employee');
  const [costCenter, setCostCenter] = useState('');
  const [managerId, setManagerId] = useState('');
  const [defaultLocationId, setDefaultLocationId] = useState<string | null>(null);
  const [primaryOrgNodeId, setPrimaryOrgNodeId] = useState<string | null>(null);

  const resetForm = () => {
    setEditId(null);
    setFirstName('');
    setLastName('');
    setEmail('');
    setPhone('');
    setType('employee');
    setCostCenter('');
    setManagerId('');
    setDefaultLocationId(null);
    setPrimaryOrgNodeId(null);
  };

  const handleSave = async () => {
    if (!firstName.trim() || !lastName.trim()) return;
    const body = {
      first_name: firstName,
      last_name: lastName,
      email: email || undefined,
      phone: phone || undefined,
      type,
      cost_center: costCenter || undefined,
      manager_person_id: managerId || undefined,
      default_location_id: defaultLocationId,
      primary_org_node_id: primaryOrgNodeId,
    };
    try {
      if (editId) {
        await apiFetch(`/persons/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Person updated');
      } else {
        await apiFetch('/persons', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Person created');
      }
      resetForm();
      setDialogOpen(false);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save person');
    }
  };

  const handleInvite = async (person: Person) => {
    if (!person.email) {
      toast.error('Add an email to this person before inviting.');
      return;
    }
    if (!window.confirm(
      `Create a platform account for ${person.first_name} ${person.last_name} at ${person.email}?`,
    )) {
      return;
    }
    try {
      await apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify({
          person_id: person.id,
          email: person.email,
          status: 'active',
        }),
      });
      toast.success(`${person.first_name} can now sign in. Assign them a role on the Users page.`);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create account');
    }
  };

  const openEdit = (person: Person) => {
    setEditId(person.id);
    setFirstName(person.first_name);
    setLastName(person.last_name);
    setEmail(person.email ?? '');
    setPhone(person.phone ?? '');
    setType(person.type);
    setCostCenter(person.cost_center ?? '');
    setManagerId(person.manager_person_id ?? '');
    setDefaultLocationId(person.default_location_id ?? null);
    setPrimaryOrgNodeId(getPrimaryOrgNode(person)?.id ?? null);
    setDialogOpen(true);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const getTypeBadge = (t: string) => {
    const label = personTypes.find((x) => x.value === t)?.label ?? t;
    const variant = typeColors[t] ?? 'outline';
    return <Badge variant={variant} className="capitalize text-xs">{label}</Badge>;
  };

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        title="Persons"
        description="Employee, contractor, and vendor contact records. Invite a person to the platform from here to create a linked user account."
        actions={
          <Button className="gap-1.5" onClick={openCreate}>
            <Plus className="size-4" /> Add person
          </Button>
        }
      />

      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-[540px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Add'} Person</DialogTitle>
              <DialogDescription>Manage employee, contractor, and vendor contact records.</DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-[70vh] pr-3">
            <FieldGroup>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="person-first-name">First Name</FieldLabel>
                  <Input
                    id="person-first-name"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Jane"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="person-last-name">Last Name</FieldLabel>
                  <Input
                    id="person-last-name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Smith"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="person-email">Email</FieldLabel>
                  <Input
                    id="person-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="jane@company.com"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="person-phone">Phone</FieldLabel>
                  <Input
                    id="person-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 555 000 0000"
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="person-type">Type</FieldLabel>
                <Select value={type} onValueChange={(v) => setType(v ?? 'employee')}>
                  <SelectTrigger id="person-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {personTypes.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="person-org">Organisation</FieldLabel>
                <OrgNodeCombobox
                  value={primaryOrgNodeId}
                  onChange={setPrimaryOrgNodeId}
                  placeholder="Select organisation…"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The person's primary node in the org tree. Inherits the node's location grants in the portal.
                </p>
              </Field>

              <Field>
                <FieldLabel htmlFor="person-cost-center">Cost Center</FieldLabel>
                <Input
                  id="person-cost-center"
                  value={costCenter}
                  onChange={(e) => setCostCenter(e.target.value)}
                  placeholder="e.g. CC-100"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="person-manager">Manager</FieldLabel>
                <PersonPicker
                  value={managerId}
                  onChange={setManagerId}
                  excludeId={editId}
                  placeholder="Select manager..."
                />
              </Field>

              <FieldSeparator />

              <Field>
                <FieldLabel>Default work location</FieldLabel>
                <LocationCombobox
                  value={defaultLocationId}
                  onChange={setDefaultLocationId}
                  typesFilter={['site', 'building']}
                  placeholder="Pick a site or building…"
                  activeOnly
                />
                <p className="text-xs text-muted-foreground mt-1">
                  The portal defaults to this location for submissions. Only sites and buildings are allowed; floor/room-level defaults aren't supported.
                </p>
              </Field>

              {editId && (
                <>
                  <FieldSeparator />
                  <PersonLocationGrantsPanel personId={editId} />
                </>
              )}
            </FieldGroup>
            </ScrollArea>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!firstName.trim() || !lastName.trim()}>
                {editId ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
      </Dialog>

      <Tabs value={typeFilter} onValueChange={setTypeFilter} className="mb-2">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="employee">Employees</TabsTrigger>
          <TabsTrigger value="contractor">Contractors</TabsTrigger>
          <TabsTrigger value="vendor_contact">Vendors</TabsTrigger>
        </TabsList>
      </Tabs>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[200px]">Email</TableHead>
            <TableHead className="w-[130px]">Phone</TableHead>
            <TableHead className="w-[120px]">Type</TableHead>
            <TableHead className="w-[200px]">Organisation</TableHead>
            <TableHead className="w-[160px]">Platform access</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={7} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={7} message="No persons found." />}
          {(data ?? []).map((person) => {
            const orgNode = getPrimaryOrgNode(person);
            const linkedUser = getLinkedUser(person);
            return (
              <TableRow key={person.id}>
                <TableCell className="font-medium">
                  <Link to={`/admin/persons/${person.id}`} className="hover:underline">
                    {person.first_name} {person.last_name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{person.email ?? '---'}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{person.phone ?? '---'}</TableCell>
                <TableCell>{getTypeBadge(person.type)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{orgNode?.name ?? '---'}</TableCell>
                <TableCell>
                  {linkedUser ? (
                    <a
                      href={`/admin/users/${linkedUser.id}`}
                      className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                    >
                      <Badge
                        variant={linkedUser.status === 'active' ? 'default' : 'secondary'}
                        className="text-[10px] capitalize"
                      >
                        {linkedUser.status}
                      </Badge>
                      View user
                    </a>
                  ) : person.email ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => handleInvite(person)}
                    >
                      <UserPlus className="h-3 w-3" />
                      Invite
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground" title="Add an email first">
                      No email
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(person)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </SettingsPageShell>
  );
}
