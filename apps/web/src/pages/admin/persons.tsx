import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, UserCog, Search } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
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
  Field, FieldError, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  TableInspectorLayout, InspectorPanel,
} from '@/components/ui/table-inspector-layout';
import { PersonAvatar } from '@/components/person-avatar';
import {
  usePersons, usePerson, personKeys, personFullName, type Person,
} from '@/api/persons';
import { apiFetch } from '@/lib/api';
import { toastCreated } from '@/lib/toast';
import { PersonDetailBody, getPrimaryOrgNode, getLinkedUser } from './person-detail';

const PERSON_TYPES: Array<{ value: string; label: string }> = [
  { value: 'employee', label: 'Employee' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'vendor_contact', label: 'Vendor contact' },
  { value: 'visitor', label: 'Visitor' },
  { value: 'temporary_worker', label: 'Temporary worker' },
];

const TYPE_BADGE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  employee: 'default',
  contractor: 'secondary',
  vendor_contact: 'outline',
  visitor: 'outline',
  temporary_worker: 'outline',
};

export function PersonsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('p');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const { data: people, isPending: loading } = usePersons(typeFilter) as {
    data: Person[] | undefined; isPending: boolean;
  };
  const refetch = () => qc.invalidateQueries({ queryKey: personKeys.all });

  const [createOpen, setCreateOpen] = useState(false);
  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newType, setNewType] = useState('employee');
  const [createError, setCreateError] = useState<string | null>(null);

  const filteredPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people ?? [];
    return (people ?? []).filter((p) => {
      const name = `${p.first_name} ${p.last_name}`.toLowerCase();
      return name.includes(q) || (p.email ?? '').toLowerCase().includes(q);
    });
  }, [people, search]);

  const selectPerson = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('p', id);
    else next.delete('p');
    setSearchParams(next, { replace: true });
  };

  const resetCreate = () => {
    setNewFirstName('');
    setNewLastName('');
    setNewEmail('');
    setNewType('employee');
    setCreateError(null);
  };

  const handleCreate = async () => {
    if (!newFirstName.trim() || !newLastName.trim()) return;
    try {
      setCreateError(null);
      const created = await apiFetch<{ id: string }>('/persons', {
        method: 'POST',
        body: JSON.stringify({
          first_name: newFirstName.trim(),
          last_name: newLastName.trim(),
          email: newEmail.trim() || undefined,
          type: newType,
        }),
      });
      resetCreate();
      setCreateOpen(false);
      refetch();
      toastCreated('Person', { onView: () => selectPerson(created.id) });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create person');
    }
  };

  const isEmpty = !loading && (people?.length ?? 0) === 0;
  const hasSelection = Boolean(selectedId);

  return (
    <>
      <TableInspectorLayout
        header={
          <div className="flex shrink-0 items-start justify-between gap-4 border-b px-6 py-4">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">People</h1>
              <p className="text-xs text-muted-foreground max-w-2xl">
                Employees, contractors, vendor contacts, and visitors. Click a row to inspect; edit on the detail page.
              </p>
            </div>
            <Button className="gap-1.5 shrink-0" onClick={() => { resetCreate(); setCreateOpen(true); }}>
              <Plus className="size-4" />
              Add person
            </Button>
          </div>
        }
        toolbar={
          <div className="flex shrink-0 items-center gap-3 border-b px-6 py-2.5">
            <Tabs value={typeFilter} onValueChange={setTypeFilter}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="employee">Employees</TabsTrigger>
                <TabsTrigger value="contractor">Contractors</TabsTrigger>
                <TabsTrigger value="vendor_contact">Vendors</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email…"
                className="h-8 pl-8"
              />
            </div>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {filteredPeople.length} {filteredPeople.length === 1 ? 'person' : 'people'}
            </span>
          </div>
        }
        list={
          <PersonsTable
            people={filteredPeople}
            loading={loading}
            isEmpty={isEmpty}
            selectedId={selectedId}
            onSelect={selectPerson}
            onAdd={() => { resetCreate(); setCreateOpen(true); }}
            hasSelection={hasSelection}
          />
        }
        inspector={
          hasSelection && selectedId ? (
            <InspectorPanel
              onClose={() => selectPerson(null)}
              onExpand={() => navigate(`/admin/persons/${selectedId}`)}
            >
              <PersonInspectorContent personId={selectedId} />
            </InspectorPanel>
          ) : null
        }
      />

      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) resetCreate(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add person</DialogTitle>
            <DialogDescription>
              Create a person record. Org, location, manager, and avatar are configured on the detail page.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="new-person-first">First name</FieldLabel>
                <Input
                  id="new-person-first"
                  value={newFirstName}
                  onChange={(e) => setNewFirstName(e.target.value)}
                  placeholder="Jane"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="new-person-last">Last name</FieldLabel>
                <Input
                  id="new-person-last"
                  value={newLastName}
                  onChange={(e) => setNewLastName(e.target.value)}
                  placeholder="Smith"
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="new-person-email">
                Email <span className="text-muted-foreground font-normal">(optional)</span>
              </FieldLabel>
              <Input
                id="new-person-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="jane@company.com"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-person-type">Type</FieldLabel>
              <Select value={newType} onValueChange={(v) => setNewType(v ?? 'employee')}>
                <SelectTrigger id="new-person-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PERSON_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {createError && <FieldError>{createError}</FieldError>}
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newFirstName.trim() || !newLastName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PersonsTable({
  people,
  loading,
  isEmpty,
  selectedId,
  onSelect,
  onAdd,
  hasSelection,
}: {
  people: Person[];
  loading: boolean;
  isEmpty: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  hasSelection: boolean;
}) {
  if (loading) {
    return <div className="px-6 py-6 text-sm text-muted-foreground">Loading…</div>;
  }

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <UserCog className="size-10 text-muted-foreground" />
        <div className="text-sm font-medium">No people yet</div>
        <p className="max-w-sm text-sm text-muted-foreground">
          Add your first person to start routing requests and assigning ownership.
        </p>
        <Button className="gap-1.5" onClick={onAdd}>
          <Plus className="size-4" />
          Add person
        </Button>
      </div>
    );
  }

  if (people.length === 0) {
    return (
      <div className="px-6 py-10 text-center text-sm text-muted-foreground">
        No people match the current search.
      </div>
    );
  }

  return (
    <Table containerClassName="overflow-visible">
      <TableHeader className="bg-muted/30 sticky top-0 z-10 backdrop-blur-sm">
        <TableRow>
          <TableHead className="px-6">Name</TableHead>
          {!hasSelection && <TableHead className="w-[220px]">Email</TableHead>}
          <TableHead className="w-[120px]">Type</TableHead>
          {!hasSelection && <TableHead>Organisation</TableHead>}
          {!hasSelection && <TableHead className="w-[160px]">Platform access</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {people.map((person) => {
          const selected = selectedId === person.id;
          const orgNode = getPrimaryOrgNode(person);
          const linkedUser = getLinkedUser(person);
          return (
            <TableRow
              key={person.id}
              data-selected={selected ? 'true' : undefined}
              onClick={() => onSelect(person.id)}
              className={cn(
                'cursor-pointer transition-colors',
                selected ? 'bg-primary/10 hover:bg-primary/15' : 'hover:bg-muted/40',
              )}
            >
              <TableCell
                className={cn(
                  'font-medium px-6',
                  selected && 'border-l-2 border-l-primary pl-[22px]',
                )}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <PersonAvatar person={person} size="sm" />
                  <div className="min-w-0">
                    <div className="truncate">{person.first_name} {person.last_name}</div>
                    {hasSelection && (
                      <div className="text-xs text-muted-foreground truncate mt-0.5">
                        {person.email ?? '—'}
                      </div>
                    )}
                  </div>
                </div>
              </TableCell>
              {!hasSelection && (
                <TableCell className="text-muted-foreground text-sm">{person.email ?? '—'}</TableCell>
              )}
              <TableCell>
                <Badge
                  variant={TYPE_BADGE_VARIANT[person.type ?? ''] ?? 'outline'}
                  className="capitalize text-xs"
                >
                  {PERSON_TYPES.find((t) => t.value === person.type)?.label ?? person.type}
                </Badge>
              </TableCell>
              {!hasSelection && (
                <TableCell className="text-muted-foreground text-sm">{orgNode?.name ?? '—'}</TableCell>
              )}
              {!hasSelection && (
                <TableCell>
                  {linkedUser ? (
                    <Badge
                      variant={linkedUser.status === 'active' ? 'default' : 'secondary'}
                      className="text-[10px] capitalize"
                    >
                      {linkedUser.status}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">No account</span>
                  )}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function PersonInspectorContent({ personId }: { personId: string }) {
  const { data: person } = usePerson(personId);
  return (
    <div className="flex flex-col gap-8 px-6 pt-6 pb-10">
      {person && (
        <div className="flex items-start gap-3">
          <PersonAvatar person={person} size="lg" />
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-2xl font-semibold tracking-tight truncate">
                {personFullName(person) || person.email || 'Unnamed person'}
              </h2>
              <Badge
                variant={person.active ? 'default' : 'outline'}
                className="capitalize shrink-0 mt-1.5"
              >
                {person.active ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            {person.email && (
              <p className="text-sm text-muted-foreground truncate">{person.email}</p>
            )}
          </div>
        </div>
      )}
      <PersonDetailBody personId={personId} />
    </div>
  );
}
