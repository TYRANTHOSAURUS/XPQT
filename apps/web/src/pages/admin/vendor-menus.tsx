import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
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
import { SpaceSelect } from '@/components/space-select';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { ServiceTypeSelect } from '@/components/service-type-select';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { MENU_STATUS_VARIANT, MenuStatus, humanize } from '@/lib/menu-constants';

interface Vendor { id: string; name: string; active: boolean }

interface Menu {
  id: string;
  vendor_id: string;
  space_id: string | null;
  service_type: string;
  name: string;
  effective_from: string;
  effective_until: string | null;
  status: MenuStatus;
  vendor?: { id: string; name: string } | null;
  space?: { id: string; name: string; type: string } | null;
}

export function VendorMenusPage() {
  const navigate = useNavigate();
  const { data: vendors } = useApi<Vendor[]>('/vendors', []);

  const [filterVendor, setFilterVendor] = useState('');
  const [filterService, setFilterService] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const listPath =
    '/catalog-menus' +
    (filterVendor || filterService || filterStatus
      ? '?' +
        [
          filterVendor && `vendor_id=${filterVendor}`,
          filterService && `service_type=${filterService}`,
          filterStatus && `status=${filterStatus}`,
        ]
          .filter(Boolean)
          .join('&')
      : '');
  const { data: menus, loading, refetch } = useApi<Menu[]>(
    listPath,
    [filterVendor, filterService, filterStatus],
  );

  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vendor Menus</h1>
          <p className="text-muted-foreground mt-1">
            Price sheets per vendor per building. Click a menu to edit.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={<Button className="gap-2" />}>
            <Plus className="h-4 w-4" /> New Menu
          </DialogTrigger>
          <CreateMenuDialog
            vendors={vendors ?? []}
            onCreated={(id) => {
              setCreateOpen(false);
              refetch();
              navigate(`/admin/vendor-menus/${id}`);
            }}
          />
        </Dialog>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <Select value={filterVendor} onValueChange={(v) => setFilterVendor(v ?? '')}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All vendors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All vendors</SelectItem>
            {(vendors ?? []).map((v) => (
              <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ServiceTypeSelect
          value={filterService}
          onChange={setFilterService}
          includeAll
          className="w-[200px]"
        />
        <Select value={filterStatus} onValueChange={(v) => setFilterStatus(v ?? '')}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[180px]">Vendor</TableHead>
            <TableHead className="w-[140px]">Service</TableHead>
            <TableHead className="w-[180px]">Building</TableHead>
            <TableHead className="w-[180px]">Window</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={6} />}
          {!loading && (!menus || menus.length === 0) && (
            <TableEmpty cols={6} message="No menus yet. Click New Menu to create one." />
          )}
          {(menus ?? []).map((m) => (
            <TableRow
              key={m.id}
              className="cursor-pointer hover:bg-muted/40"
              onClick={() => navigate(`/admin/vendor-menus/${m.id}`)}
            >
              <TableCell className="font-medium">{m.name}</TableCell>
              <TableCell className="text-sm">{m.vendor?.name ?? '—'}</TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">
                  {humanize(m.service_type)}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {m.space?.name ?? 'All (vendor default)'}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {m.effective_from} → {m.effective_until ?? '∞'}
              </TableCell>
              <TableCell>
                <Badge variant={MENU_STATUS_VARIANT[m.status]} className="capitalize">
                  {m.status}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Create dialog — only the required fields. After create, redirect to detail.
// -----------------------------------------------------------------------------
function CreateMenuDialog({
  vendors,
  onCreated,
}: {
  vendors: Vendor[];
  onCreated: (id: string) => void;
}) {
  const [vendorId, setVendorId] = useState('');
  const [serviceType, setServiceType] = useState<string>('catering');
  const [spaceId, setSpaceId] = useState('');
  const [name, setName] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!vendorId || !name || !effectiveFrom) return;
    setBusy(true);
    try {
      const created = await apiFetch<{ id: string }>('/catalog-menus', {
        method: 'POST',
        body: JSON.stringify({
          vendor_id: vendorId,
          space_id: spaceId || null,
          service_type: serviceType,
          name,
          effective_from: effectiveFrom,
          status: 'draft',
        }),
      });
      toast.success('Menu created');
      onCreated(created.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>New menu</DialogTitle>
        <DialogDescription>
          Minimal setup — you'll add items on the next screen.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label>Vendor</Label>
            <Select value={vendorId} onValueChange={(v) => setVendorId(v ?? '')}>
              <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
              <SelectContent>
                {vendors.filter((v) => v.active).map((v) => (
                  <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Service type</Label>
            <ServiceTypeSelect
              value={serviceType}
              onChange={(v) => setServiceType(v || 'catering')}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label>Menu name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Spring 2026 Lunch" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label>Effective from</Label>
            <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Building (optional)</Label>
            <SpaceSelect
              value={spaceId}
              onChange={setSpaceId}
              typeFilter={['site', 'building']}
              emptyLabel="All buildings"
              placeholder="All buildings"
            />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={busy || !vendorId || !name || !effectiveFrom}>
          Create & edit
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
