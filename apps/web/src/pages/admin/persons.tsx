import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { PersonCombobox } from '@/components/person-combobox';
import { TableLoading, TableEmpty } from '@/components/table-states';

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
              <DialogDescription>Manage employee, contractor, and vendor contact records.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 max-h-[70vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-1.5">
                  <Label>First Name</Label>
                  <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Jane" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Last Name</Label>
                  <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Smith" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-1.5">
                  <Label>Email</Label>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@company.com" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Phone</Label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 000 0000" />
                </div>
              </div>
              <div className="grid gap-1.5">
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
                <div className="grid gap-1.5">
                  <Label>Division</Label>
                  <Input value={division} onChange={(e) => setDivision(e.target.value)} placeholder="e.g. Engineering" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Department</Label>
                  <Input value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. IT" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Cost Center</Label>
                  <Input value={costCenter} onChange={(e) => setCostCenter(e.target.value)} placeholder="e.g. CC-100" />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>Manager</Label>
                <PersonCombobox
                  value={managerId}
                  onChange={setManagerId}
                  excludeId={editId}
                  placeholder="Select manager..."
                />
              </div>
            </div>
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
            <TableHead className="w-[120px]">Department</TableHead>
            <TableHead className="w-[120px]">Division</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={7} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={7} message="No persons found." />}
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
