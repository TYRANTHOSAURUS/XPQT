import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Pencil } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  type: string;
  division: string | null;
  department: string | null;
  cost_center: string | null;
  manager_person_id: string | null;
  manager?: { id: string; first_name: string; last_name: string } | null;
  active: boolean;
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

function PersonSearch({
  value,
  onChange,
  excludeId,
}: {
  value: string;
  onChange: (id: string) => void;
  excludeId?: string | null;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!value) {
      setDisplayName('');
      return;
    }
    apiFetch<Person[]>('/persons').then((persons) => {
      const p = persons.find((x) => x.id === value);
      if (p) setDisplayName(`${p.first_name} ${p.last_name}`);
    }).catch(() => {});
  }, [value]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = (q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch<Person[]>(`/persons?search=${encodeURIComponent(q)}`);
        setResults(excludeId ? data.filter((p) => p.id !== excludeId) : data);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 300);
  };

  const handleSelect = (person: Person) => {
    onChange(person.id);
    setDisplayName(`${person.first_name} ${person.last_name}`);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const handleClear = () => {
    onChange('');
    setDisplayName('');
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      {value && displayName ? (
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm h-8 flex items-center">
            {displayName}
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleClear}>
            &times;
          </Button>
        </div>
      ) : (
        <Input
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search by name..."
          onFocus={() => { if (results.length > 0) setOpen(true); }}
        />
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-lg bg-popover shadow-md ring-1 ring-foreground/10 max-h-48 overflow-y-auto">
          {results.map((p) => (
            <button
              key={p.id}
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => handleSelect(p)}
            >
              {p.first_name} {p.last_name}
              {p.email && <span className="text-muted-foreground ml-2">{p.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const [division, setDivision] = useState('');
  const [department, setDepartment] = useState('');
  const [costCenter, setCostCenter] = useState('');
  const [managerId, setManagerId] = useState('');

  const resetForm = () => {
    setEditId(null);
    setFirstName('');
    setLastName('');
    setEmail('');
    setPhone('');
    setType('employee');
    setDivision('');
    setDepartment('');
    setCostCenter('');
    setManagerId('');
  };

  const handleSave = async () => {
    if (!firstName.trim() || !lastName.trim()) return;
    const body = {
      first_name: firstName,
      last_name: lastName,
      email: email || undefined,
      phone: phone || undefined,
      type,
      division: division || undefined,
      department: department || undefined,
      cost_center: costCenter || undefined,
      manager_person_id: managerId || undefined,
    };
    if (editId) {
      await apiFetch(`/persons/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiFetch('/persons', { method: 'POST', body: JSON.stringify(body) });
    }
    resetForm();
    setDialogOpen(false);
    refetch();
  };

  const openEdit = (person: Person) => {
    setEditId(person.id);
    setFirstName(person.first_name);
    setLastName(person.last_name);
    setEmail(person.email ?? '');
    setPhone(person.phone ?? '');
    setType(person.type);
    setDivision(person.division ?? '');
    setDepartment(person.department ?? '');
    setCostCenter(person.cost_center ?? '');
    setManagerId(person.manager_person_id ?? '');
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
            </DialogHeader>
            <div className="space-y-4 mt-2 max-h-[70vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>First Name</Label>
                  <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jane" />
                </div>
                <div className="space-y-2">
                  <Label>Last Name</Label>
                  <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Smith" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@company.com" />
                </div>
                <div className="space-y-2">
                  <Label>Phone</Label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 000 0000" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={type} onValueChange={(v) => setType(v ?? 'employee')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {personTypes.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-2">
                  <Label>Division</Label>
                  <Input value={division} onChange={(e) => setDivision(e.target.value)} placeholder="e.g. Engineering" />
                </div>
                <div className="space-y-2">
                  <Label>Department</Label>
                  <Input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. IT" />
                </div>
                <div className="space-y-2">
                  <Label>Cost Center</Label>
                  <Input value={costCenter} onChange={(e) => setCostCenter(e.target.value)} placeholder="e.g. CC-100" />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Manager</Label>
                <PersonSearch
                  value={managerId}
                  onChange={setManagerId}
                  excludeId={editId}
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={!firstName.trim() || !lastName.trim()}>
                  {editId ? 'Save' : 'Create'}
                </Button>
              </div>
            </div>
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
            <TableHead className="w-[120px]">Department</TableHead>
            <TableHead className="w-[120px]">Division</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No persons found.</TableCell></TableRow>
          )}
          {(data ?? []).map((person) => (
            <TableRow key={person.id}>
              <TableCell className="font-medium">{person.first_name} {person.last_name}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{person.email ?? '---'}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{person.phone ?? '---'}</TableCell>
              <TableCell>{getTypeBadge(person.type)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{person.department ?? '---'}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{person.division ?? '---'}</TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(person)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
