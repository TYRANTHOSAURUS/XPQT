import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
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
import { Plus, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { PersonCombobox } from '@/components/person-combobox';
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
}

function getPrimaryOrgNode(person: Person): { id: string; name: string; code: string | null } | null {
  const memberships = person.primary_membership ?? [];
  const primary = memberships.find((m) => m.is_primary);
  if (!primary) return null;
  const node = Array.isArray(primary.org_node) ? primary.org_node[0] : primary.org_node;
  return node ?? null;
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
  const [typeFilter, setTypeFilter] = useState('all');
  const filterPath = typeFilter !== 'all' ? `/persons?type=${typeFilter}` : '/persons';
  const { data, loading, refetch } = useApi<Person[]>(filterPath, [typeFilter]);

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
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Persons</h1>
          <p className="text-muted-foreground mt-1">Manage employee, contractor, and vendor contact records</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Person
          </DialogTrigger>
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
                <PersonCombobox
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
      </div>

      <Tabs value={typeFilter} onValueChange={setTypeFilter} className="mb-6">
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
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={6} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={6} message="No persons found." />}
          {(data ?? []).map((person) => {
            const orgNode = getPrimaryOrgNode(person);
            return (
              <TableRow key={person.id}>
                <TableCell className="font-medium">{person.first_name} {person.last_name}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{person.email ?? '---'}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{person.phone ?? '---'}</TableCell>
                <TableCell>{getTypeBadge(person.type)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{orgNode?.name ?? '---'}</TableCell>
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
    </div>
  );
}
