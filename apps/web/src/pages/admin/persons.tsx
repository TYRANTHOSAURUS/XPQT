import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
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
import {
  TableInspectorLayout, InspectorPanel,
} from '@/components/ui/table-inspector-layout';
import { Plus, UserPlus, Users, Search, ArrowUpRight } from 'lucide-react';
import { toast, toastCreated, toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { userStatusDotClass } from '@/lib/status-tone';
import { useQueryClient } from '@tanstack/react-query';
import { usePersons, personKeys, usePerson } from '@/api/persons';
import { useCostCenters } from '@/api/cost-centers';
import { apiFetch } from '@/lib/api';
import { PersonPicker } from '@/components/person-picker';
import { LocationCombobox } from '@/components/location-combobox';
import { OrgNodeCombobox } from '@/components/org-node-combobox';
import { FieldSeparator } from '@/components/ui/field';
import { PersonDetailBody, personHeadline } from './person-detail';

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

const typeDot: Record<string, string> = {
  employee: 'bg-blue-500',
  contractor: 'bg-violet-500',
  vendor_contact: 'bg-orange-500',
  temporary_worker: 'bg-cyan-500',
};


export function PersonsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('p');
  const typeFilter = searchParams.get('type') ?? 'all';
  const [search, setSearch] = useState('');

  const { data, isPending: loading } = usePersons(typeFilter) as { data: Person[] | undefined; isPending: boolean };
  const { data: costCenters } = useCostCenters({ active: true });
  const refetch = () => qc.invalidateQueries({ queryKey: personKeys.all });

  const setTypeFilter = (next: string) => {
    const sp = new URLSearchParams(searchParams);
    if (!next || next === 'all') sp.delete('type');
    else sp.set('type', next);
    setSearchParams(sp, { replace: true });
  };

  const selectPerson = (id: string | null) => {
    const sp = new URLSearchParams(searchParams);
    if (id) sp.set('p', id);
    else sp.delete('p');
    setSearchParams(sp, { replace: true });
  };

  const filteredPersons = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data ?? [];
    return (data ?? []).filter((p) => {
      const name = `${p.first_name} ${p.last_name}`.toLowerCase();
      return (
        name.includes(q) ||
        (p.email ?? '').toLowerCase().includes(q) ||
        (p.phone ?? '').toLowerCase().includes(q)
      );
    });
  }, [data, search]);

  const [dialogOpen, setDialogOpen] = useState(false);
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

  const handleCreate = async () => {
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
      const created = await apiFetch<{ id: string }>('/persons', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      resetForm();
      setDialogOpen(false);
      refetch();
      toastCreated('Person', { onView: () => selectPerson(created.id) });
    } catch (err) {
      toastError("Couldn't save person", { error: err });
    }
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const handleInvite = async (person: Person) => {
    if (!person.email) {
      toast.message('Add an email to invite this person', {
        description: 'Open the person, fill in their email, then try again.',
        action: { label: 'Open person', onClick: () => selectPerson(person.id) },
      });
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
      toast.success(`${person.first_name} can now sign in`, {
        description: 'Assign them a role on the Users page.',
        action: { label: 'Assign role', onClick: () => { window.location.href = '/admin/users'; } },
      });
      refetch();
    } catch (err) {
      toastError("Couldn't create account", { error: err, retry: () => handleInvite(person) });
    }
  };

  const isEmpty = !loading && (data?.length ?? 0) === 0;
  const hasSelection = Boolean(selectedId);

  const tableEl = (
    <PersonsTable
      persons={filteredPersons}
      loading={loading}
      isEmpty={isEmpty}
      selectedId={selectedId}
      onSelect={selectPerson}
      onAdd={openCreate}
      onInvite={handleInvite}
      hasSelection={hasSelection}
    />
  );

  const inspectorEl = hasSelection && selectedId ? (
    <InspectorPanel
      onClose={() => selectPerson(null)}
      onExpand={() => navigate(`/admin/persons/${selectedId}`)}
    >
      <PersonInspectorContent
        personId={selectedId}
        onDeactivated={() => selectPerson(null)}
      />
    </InspectorPanel>
  ) : null;

  return (
    <>
      <TableInspectorLayout
        header={
          <div className="flex shrink-0 items-start justify-between gap-4 border-b px-6 py-4">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">Persons</h1>
              <p className="text-xs text-muted-foreground max-w-2xl">
                Employee, contractor, and vendor contact records. Click a row to inspect; manage location
                grants and access on the detail page.
              </p>
            </div>
            <Button className="gap-1.5 shrink-0" onClick={openCreate}>
              <Plus className="size-4" /> Add person
            </Button>
          </div>
        }
        toolbar={
          <div className="flex shrink-0 items-center gap-3 border-b px-6 py-2.5">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, email, or phone…"
                className="h-8 pl-8"
              />
            </div>
            <Tabs value={typeFilter} onValueChange={setTypeFilter}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="employee">Employees</TabsTrigger>
                <TabsTrigger value="contractor">Contractors</TabsTrigger>
                <TabsTrigger value="vendor_contact">Vendors</TabsTrigger>
              </TabsList>
            </Tabs>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {filteredPersons.length} {filteredPersons.length === 1 ? 'person' : 'persons'}
            </span>
          </div>
        }
        list={tableEl}
        inspector={inspectorEl}
      />

      {/* Add person dialog. Editing happens inline via the inspector / detail page. */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-[540px]">
          <DialogHeader>
            <DialogTitle>Add Person</DialogTitle>
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
                <Select
                  value={costCenter || '__none__'}
                  onValueChange={(v) => setCostCenter(!v || v === '__none__' ? '' : v)}
                >
                  <SelectTrigger id="person-cost-center">
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
              </Field>

              <Field>
                <FieldLabel htmlFor="person-manager">Manager</FieldLabel>
                <PersonPicker
                  value={managerId}
                  onChange={setManagerId}
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
            </FieldGroup>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!firstName.trim() || !lastName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PersonsTable({
  persons,
  loading,
  isEmpty,
  selectedId,
  onSelect,
  onAdd,
  onInvite,
  hasSelection,
}: {
  persons: Person[];
  loading: boolean;
  isEmpty: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onInvite: (p: Person) => void;
  hasSelection: boolean;
}) {
  if (loading) {
    return (
      <div className="flex flex-col gap-2 px-6 py-6" aria-label="Loading persons">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <Users className="size-10 text-muted-foreground animate-in fade-in slide-in-from-bottom-2 duration-300 [animation-fill-mode:both]" />
        <div className="text-sm font-medium animate-in fade-in slide-in-from-bottom-2 duration-300 [animation-delay:60ms] [animation-fill-mode:both]">
          No persons yet
        </div>
        <p className="max-w-sm text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-2 duration-300 [animation-delay:120ms] [animation-fill-mode:both]">
          Add a person to start building your directory. You can invite them to the platform once they
          have an email on file.
        </p>
        <Button
          className="gap-1.5 animate-in fade-in slide-in-from-bottom-2 duration-300 [animation-delay:180ms] [animation-fill-mode:both]"
          onClick={onAdd}
        >
          <Plus className="size-4" />
          Add person
        </Button>
      </div>
    );
  }

  if (persons.length === 0) {
    return (
      <div className="px-6 py-10 text-center text-sm text-muted-foreground">
        No persons match the current filters.
      </div>
    );
  }

  const renderType = (t: string) => {
    const label = personTypes.find((x) => x.value === t)?.label ?? t;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs">
        <span
          className={cn(
            'size-1.5 rounded-full shrink-0',
            typeDot[t] ?? 'bg-muted-foreground/40',
          )}
          aria-hidden
        />
        <span>{label}</span>
      </span>
    );
  };

  return (
    <Table containerClassName="overflow-visible">
      <TableHeader className="bg-muted/30 sticky top-0 z-10 backdrop-blur-sm">
        <TableRow>
          <TableHead className="px-6">Name</TableHead>
          {!hasSelection && <TableHead className="w-[220px]">Email</TableHead>}
          {!hasSelection && <TableHead className="w-[140px]">Phone</TableHead>}
          <TableHead className="w-[140px]">Type</TableHead>
          {!hasSelection && <TableHead className="w-[200px]">Organisation</TableHead>}
          <TableHead className="w-[160px]">Platform access</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {persons.map((person) => {
          const orgNode = getPrimaryOrgNode(person);
          const linkedUser = getLinkedUser(person);
          const selected = selectedId === person.id;
          return (
            <TableRow
              key={person.id}
              data-selected={selected ? 'true' : undefined}
              onClick={() => onSelect(person.id)}
              className={cn(
                'cursor-pointer transition-colors duration-150 ease-[var(--ease-snap)]',
                selected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/40',
              )}
            >
              <TableCell
                className={cn(
                  'font-medium px-6 border-l-2 border-l-transparent transition-colors duration-150 ease-[var(--ease-snap)]',
                  selected && 'border-l-primary',
                )}
              >
                <div className="min-w-0">
                  <div className="truncate">
                    {person.first_name} {person.last_name}
                  </div>
                  {hasSelection && (person.email || person.phone) && (
                    <div className="text-xs text-muted-foreground truncate mt-0.5">
                      {person.email ?? person.phone}
                    </div>
                  )}
                </div>
              </TableCell>
              {!hasSelection && (
                <TableCell className="text-muted-foreground text-sm">{person.email ?? '—'}</TableCell>
              )}
              {!hasSelection && (
                <TableCell className="text-muted-foreground text-sm">{person.phone ?? '—'}</TableCell>
              )}
              <TableCell>{renderType(person.type)}</TableCell>
              {!hasSelection && (
                <TableCell className="text-muted-foreground text-sm">{orgNode?.name ?? '—'}</TableCell>
              )}
              <TableCell onClick={(e) => e.stopPropagation()}>
                {linkedUser ? (
                  <a
                    href={`/admin/users/${linkedUser.id}`}
                    className="group inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors duration-150 ease-[var(--ease-snap)]"
                    title="Open linked user"
                  >
                    <span
                      className={cn('size-1.5 rounded-full shrink-0', userStatusDotClass(linkedUser.status))}
                      aria-hidden
                    />
                    <span className="capitalize">{linkedUser.status}</span>
                    <ArrowUpRight
                      className="size-3 opacity-40 -translate-x-0.5 transition-all duration-150 ease-[var(--ease-snap)] group-hover:opacity-100 group-hover:translate-x-0 group-focus-visible:opacity-100 group-focus-visible:translate-x-0"
                      aria-hidden
                    />
                  </a>
                ) : person.email ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => onInvite(person)}
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
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Body of the inspector: identity heading + PersonDetailBody sections. Chrome
 * (close, expand, panel sizing, scroll wrapper) is provided by InspectorPanel.
 */
function PersonInspectorContent({
  personId,
  onDeactivated,
}: {
  personId: string;
  onDeactivated: () => void;
}) {
  const { data: person } = usePerson(personId);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div
      data-mounted={mounted ? '' : undefined}
      className={cn(
        'flex flex-col gap-8 px-6 pt-6 pb-10',
        'transition-[opacity,transform] duration-200 ease-[var(--ease-smooth)]',
        'opacity-0 translate-y-1',
        'data-[mounted]:opacity-100 data-[mounted]:translate-y-0',
      )}
    >
      {person && (
        <div className="flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-2xl font-semibold tracking-tight truncate">
              {personHeadline(person)}
            </h2>
            <Badge
              variant="outline"
              className="text-[10px] uppercase tracking-wider shrink-0 mt-1.5 gap-1.5"
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  userStatusDotClass(person.active ? 'active' : 'inactive'),
                )}
                aria-hidden
              />
              {person.active ? 'Active' : 'Inactive'}
            </Badge>
          </div>
          {person.email && (
            <p className="text-sm text-muted-foreground truncate">{person.email}</p>
          )}
        </div>
      )}
      <PersonDetailBody personId={personId} onDeactivated={onDeactivated} />
    </div>
  );
}
