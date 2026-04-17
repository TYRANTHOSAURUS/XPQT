import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { SpaceSelect } from '@/components/space-select';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { ServiceTypeSelect } from '@/components/service-type-select';
import { humanize } from '@/lib/menu-constants';

interface Team {
  id: string;
  name: string;
}

interface Vendor {
  id: string;
  name: string;
  contact_email: string | null;
  contact_phone: string | null;
  website: string | null;
  notes: string | null;
  owning_team_id: string | null;
  owning_team?: Team | null;
  active: boolean;
}

interface ServiceArea {
  id: string;
  vendor_id: string;
  space_id: string;
  service_type: string;
  default_priority: number;
  active: boolean;
  space?: { id: string; name: string; type: string } | null;
}

export function VendorsPage() {
  const { data: vendors, loading, refetch } = useApi<Vendor[]>('/vendors', []);
  const { data: teams } = useApi<Team[]>('/teams', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  const [owningTeamId, setOwningTeamId] = useState('');
  const [active, setActive] = useState(true);

  // Service areas (only shown when editing)
  const [serviceAreas, setServiceAreas] = useState<ServiceArea[]>([]);
  const [areasLoading, setAreasLoading] = useState(false);
  const [newAreaSpaceId, setNewAreaSpaceId] = useState('');
  const [newAreaServiceType, setNewAreaServiceType] = useState<string>('catering');
  const [newAreaPriority, setNewAreaPriority] = useState('100');

  const resetForm = () => {
    setEditId(null);
    setName('');
    setEmail('');
    setPhone('');
    setWebsite('');
    setNotes('');
    setOwningTeamId('');
    setActive(true);
    setServiceAreas([]);
    setNewAreaSpaceId('');
    setNewAreaServiceType('catering');
    setNewAreaPriority('100');
  };

  const loadAreas = async (vendorId: string) => {
    setAreasLoading(true);
    try {
      const data = await apiFetch<ServiceArea[]>(`/vendors/${vendorId}/service-areas`);
      setServiceAreas(data);
    } catch {
      setServiceAreas([]);
    } finally {
      setAreasLoading(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = {
      name,
      contact_email: email || null,
      contact_phone: phone || null,
      website: website || null,
      notes: notes || null,
      owning_team_id: owningTeamId || null,
      active,
    };
    try {
      if (editId) {
        await apiFetch(`/vendors/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Vendor updated');
      } else {
        await apiFetch('/vendors', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Vendor created');
      }
      resetForm();
      setDialogOpen(false);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save vendor');
    }
  };

  const openEdit = async (vendor: Vendor) => {
    setEditId(vendor.id);
    setName(vendor.name);
    setEmail(vendor.contact_email ?? '');
    setPhone(vendor.contact_phone ?? '');
    setWebsite(vendor.website ?? '');
    setNotes(vendor.notes ?? '');
    setOwningTeamId(vendor.owning_team_id ?? '');
    setActive(vendor.active);
    setDialogOpen(true);
    await loadAreas(vendor.id);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const handleAddArea = async () => {
    if (!editId || !newAreaSpaceId) return;
    try {
      await apiFetch(`/vendors/${editId}/service-areas`, {
        method: 'POST',
        body: JSON.stringify({
          space_id: newAreaSpaceId,
          service_type: newAreaServiceType,
          default_priority: Number(newAreaPriority) || 100,
        }),
      });
      toast.success('Service area added');
      setNewAreaSpaceId('');
      setNewAreaPriority('100');
      await loadAreas(editId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add service area');
    }
  };

  const handleRemoveArea = async (areaId: string) => {
    if (!editId) return;
    try {
      await apiFetch(`/vendors/${editId}/service-areas/${areaId}`, { method: 'DELETE' });
      toast.success('Service area removed');
      await loadAreas(editId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove service area');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Vendors</h1>
          <p className="text-muted-foreground mt-1">
            External parties that fulfill catering, AV, supplies, and other services.
          </p>
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}
        >
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Vendor
          </DialogTrigger>
          <DialogContent className="sm:max-w-[620px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Vendor</DialogTitle>
              <DialogDescription>
                Define the vendor and the buildings they serve. Menus are managed separately.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 max-h-[70vh] overflow-auto">
              <div className="grid gap-1.5">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Compass Catering, Riedel AV Rentals"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label>Contact email</Label>
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
                </div>
                <div className="grid gap-1.5">
                  <Label>Contact phone</Label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>Website</Label>
                <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://..." />
              </div>
              <div className="grid gap-1.5">
                <Label>Owning internal team</Label>
                <Select value={owningTeamId} onValueChange={(v) => setOwningTeamId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="None — unassigned" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Unassigned</SelectItem>
                    {(teams ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Internal team that owns this vendor relationship (comms, contracts, escalations).
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label>Notes</Label>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>
              <div className="grid gap-1.5">
                <Label>Status</Label>
                <Select value={active ? 'active' : 'inactive'} onValueChange={(v) => setActive(v === 'active')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {editId && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <div>
                      <Label className="text-sm font-medium">Service areas</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Which buildings this vendor serves, for which service type.
                      </p>
                    </div>
                    {areasLoading ? (
                      <p className="text-sm text-muted-foreground">Loading...</p>
                    ) : serviceAreas.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No service areas yet.</p>
                    ) : (
                      <div className="space-y-1">
                        {serviceAreas.map((area) => (
                          <div
                            key={area.id}
                            className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/40 text-sm"
                          >
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="capitalize">
                                {humanize(area.service_type)}
                              </Badge>
                              <span>{area.space?.name ?? area.space_id}</span>
                              <span className="text-xs text-muted-foreground">
                                · priority {area.default_priority}
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleRemoveArea(area.id)}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-[1fr_160px_80px_auto] gap-2 items-end">
                      <div className="grid gap-1">
                        <Label className="text-xs">Building</Label>
                        <SpaceSelect
                          value={newAreaSpaceId}
                          onChange={setNewAreaSpaceId}
                          typeFilter={['site', 'building']}
                          emptyLabel={null}
                          placeholder="Select..."
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label className="text-xs">Service type</Label>
                        <ServiceTypeSelect
                          value={newAreaServiceType}
                          onChange={(v) => setNewAreaServiceType(v || 'catering')}
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label className="text-xs">Priority</Label>
                        <Input
                          type="number"
                          value={newAreaPriority}
                          onChange={(e) => setNewAreaPriority(e.target.value)}
                        />
                      </div>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleAddArea}
                        disabled={!newAreaSpaceId}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!name.trim()}>
                {editId ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[200px]">Owning team</TableHead>
            <TableHead className="w-[220px]">Contact</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={5} />}
          {!loading && (!vendors || vendors.length === 0) && (
            <TableEmpty cols={5} message="No vendors yet." />
          )}
          {(vendors ?? []).map((v) => (
            <TableRow key={v.id}>
              <TableCell className="font-medium">{v.name}</TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {v.owning_team?.name ?? '—'}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">
                {v.contact_email || v.contact_phone || '—'}
              </TableCell>
              <TableCell>
                <Badge variant={v.active ? 'default' : 'secondary'}>
                  {v.active ? 'Active' : 'Inactive'}
                </Badge>
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(v)}>
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
