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

interface AssetType {
  id: string;
  name: string;
}

interface Person {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

interface Space {
  id: string;
  name: string;
  type: string;
}

interface Asset {
  id: string;
  name: string;
  asset_type_id: string;
  asset_role: 'fixed' | 'personal' | 'pooled';
  tag: string | null;
  serial_number: string | null;
  status: string;
  lifecycle_state: string;
  purchase_date: string | null;
  assigned_person?: Person | null;
  assigned_space?: Space | null;
  asset_type?: AssetType | null;
}

const assetRoles = ['fixed', 'personal', 'pooled'];
const statusOptions = ['available', 'assigned', 'in_maintenance', 'retired'];
const lifecycleOptions = ['procured', 'active', 'maintenance', 'retired', 'disposed'];

const statusVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  available: 'default',
  assigned: 'secondary',
  in_maintenance: 'outline',
  retired: 'destructive',
};

const roleVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
  fixed: 'default',
  personal: 'secondary',
  pooled: 'outline',
};

function PersonPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
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
        setResults(data);
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
          placeholder="Search persons..."
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

function SpacePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { data: spaces } = useApi<Space[]>('/spaces', []);

  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? '')}>
      <SelectTrigger><SelectValue placeholder="No location" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="">No location</SelectItem>
        {(spaces ?? []).map((s) => (
          <SelectItem key={s.id} value={s.id}>{s.name} ({s.type})</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AssetsPage() {
  const [roleFilter, setRoleFilter] = useState('all');
  const queryParams = new URLSearchParams();
  if (roleFilter !== 'all') queryParams.set('asset_role', roleFilter);
  const query = queryParams.toString();

  const { data, loading, refetch } = useApi<Asset[]>(`/assets${query ? `?${query}` : ''}`, [roleFilter]);
  const { data: assetTypes } = useApi<AssetType[]>('/asset-types', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [assetTypeId, setAssetTypeId] = useState('');
  const [assetRole, setAssetRole] = useState('fixed');
  const [tag, setTag] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [status, setStatus] = useState('available');
  const [lifecycleState, setLifecycleState] = useState('active');
  const [assignedPersonId, setAssignedPersonId] = useState('');
  const [assignedSpaceId, setAssignedSpaceId] = useState('');
  const [purchaseDate, setPurchaseDate] = useState('');

  const resetForm = () => {
    setEditId(null);
    setName('');
    setAssetTypeId('');
    setAssetRole('fixed');
    setTag('');
    setSerialNumber('');
    setStatus('available');
    setLifecycleState('active');
    setAssignedPersonId('');
    setAssignedSpaceId('');
    setPurchaseDate('');
  };

  const handleSave = async () => {
    if (!name.trim() || !assetTypeId) return;
    const body = {
      name,
      asset_type_id: assetTypeId,
      asset_role: assetRole,
      tag: tag || undefined,
      serial_number: serialNumber || undefined,
      status,
      lifecycle_state: lifecycleState,
      assigned_person_id: assignedPersonId || undefined,
      assigned_space_id: assignedSpaceId || undefined,
      purchase_date: purchaseDate || undefined,
    };
    if (editId) {
      await apiFetch(`/assets/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiFetch('/assets', { method: 'POST', body: JSON.stringify(body) });
    }
    resetForm();
    setDialogOpen(false);
    refetch();
  };

  const openEdit = (asset: Asset) => {
    setEditId(asset.id);
    setName(asset.name);
    setAssetTypeId(asset.asset_type_id);
    setAssetRole(asset.asset_role);
    setTag(asset.tag ?? '');
    setSerialNumber(asset.serial_number ?? '');
    setStatus(asset.status);
    setLifecycleState(asset.lifecycle_state);
    setAssignedPersonId(asset.assigned_person?.id ?? '');
    setAssignedSpaceId(asset.assigned_space?.id ?? '');
    setPurchaseDate(asset.purchase_date ?? '');
    setDialogOpen(true);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const getAssignedTo = (asset: Asset) => {
    if (asset.assigned_person) {
      return `${asset.assigned_person.first_name} ${asset.assigned_person.last_name}`;
    }
    if (asset.assigned_space) {
      return asset.assigned_space.name;
    }
    return '---';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Asset Registry</h1>
          <p className="text-muted-foreground mt-1">Track fixed, personal, and pooled assets across your organization</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Asset
          </DialogTrigger>
          <DialogContent className="sm:max-w-[540px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Add'} Asset</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2 max-h-[70vh] overflow-y-auto pr-1">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. MacBook Pro 14-inch" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Asset Type</Label>
                  <Select value={assetTypeId} onValueChange={(v) => setAssetTypeId(v ?? '')}>
                    <SelectTrigger><SelectValue placeholder="Select type..." /></SelectTrigger>
                    <SelectContent>
                      {(assetTypes ?? []).map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Select value={assetRole} onValueChange={(v) => setAssetRole(v ?? 'fixed')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {assetRoles.map((r) => (
                        <SelectItem key={r} value={r} className="capitalize">{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Tag</Label>
                  <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Asset tag" />
                </div>
                <div className="space-y-2">
                  <Label>Serial Number</Label>
                  <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="SN123..." />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={status} onValueChange={(v) => setStatus(v ?? 'available')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {statusOptions.map((s) => (
                        <SelectItem key={s} value={s} className="capitalize">{s.replace('_', ' ')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Lifecycle State</Label>
                  <Select value={lifecycleState} onValueChange={(v) => setLifecycleState(v ?? 'active')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {lifecycleOptions.map((s) => (
                        <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Assigned To (Person)</Label>
                <PersonPicker value={assignedPersonId} onChange={setAssignedPersonId} />
              </div>
              <div className="space-y-2">
                <Label>Assigned Location</Label>
                <SpacePicker value={assignedSpaceId} onChange={setAssignedSpaceId} />
              </div>
              <div className="space-y-2">
                <Label>Purchase Date</Label>
                <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={!name.trim() || !assetTypeId}>
                  {editId ? 'Save' : 'Create'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs value={roleFilter} onValueChange={setRoleFilter} className="mb-6">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="fixed">Fixed</TabsTrigger>
          <TabsTrigger value="personal">Personal</TabsTrigger>
          <TabsTrigger value="pooled">Pooled</TabsTrigger>
        </TabsList>
      </Tabs>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[120px]">Type</TableHead>
            <TableHead className="w-[90px]">Role</TableHead>
            <TableHead className="w-[130px]">Serial Number</TableHead>
            <TableHead className="w-[110px]">Status</TableHead>
            <TableHead className="w-[160px]">Assigned To</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No assets found.</TableCell></TableRow>
          )}
          {(data ?? []).map((asset) => (
            <TableRow key={asset.id}>
              <TableCell className="font-medium">{asset.name}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{asset.asset_type?.name ?? '---'}</TableCell>
              <TableCell><Badge variant={roleVariant[asset.asset_role] ?? 'outline'} className="capitalize text-xs">{asset.asset_role}</Badge></TableCell>
              <TableCell className="text-muted-foreground text-sm font-mono">{asset.serial_number ?? '---'}</TableCell>
              <TableCell>
                <Badge variant={statusVariant[asset.status] ?? 'outline'} className="capitalize text-xs">
                  {asset.status.replace('_', ' ')}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{getAssignedTo(asset)}</TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(asset)}>
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
