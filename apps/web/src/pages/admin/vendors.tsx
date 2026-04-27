import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Plus, Pencil, X } from 'lucide-react';
import { toastCreated, toastError, toastRemoved, toastSuccess, toastUpdated } from '@/lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import { useVendors, vendorKeys } from '@/api/vendors';
import { useTeams } from '@/api/teams';
import { useSlaPolicies } from '@/api/sla-policies';
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
  default_sla_policy_id: string | null;
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
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: vendors, isPending: loading } = useVendors() as { data: Vendor[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: vendorKeys.all });
  const { data: teams } = useTeams() as { data: Team[] | undefined };
  const { data: slaPolicies } = useSlaPolicies() as { data: Array<{ id: string; name: string }> | undefined };

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  const [owningTeamId, setOwningTeamId] = useState('');
  const [active, setActive] = useState(true);
  const [defaultSlaPolicyId, setDefaultSlaPolicyId] = useState<string>('');

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
    setDefaultSlaPolicyId('');
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
      default_sla_policy_id: defaultSlaPolicyId || null,
    };
    try {
      let savedId = editId;
      if (editId) {
        await apiFetch(`/vendors/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toastUpdated('Vendor');
      } else {
        const created = await apiFetch<{ id: string }>('/vendors', { method: 'POST', body: JSON.stringify(body) });
        savedId = created.id;
        toastCreated('Vendor', { onView: () => savedId && navigate(`/admin/vendors/${savedId}`) });
      }
      resetForm();
      setDialogOpen(false);
      refetch();
    } catch (err) {
      toastError("Couldn't save vendor", { error: err, retry: handleSave });
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
    setDefaultSlaPolicyId(vendor.default_sla_policy_id ?? '');
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
      toastSuccess('Service area added');
      setNewAreaSpaceId('');
      setNewAreaPriority('100');
      await loadAreas(editId);
    } catch (err) {
      toastError("Couldn't add service area", { error: err, retry: handleAddArea });
    }
  };

  const handleRemoveArea = async (areaId: string) => {
    if (!editId) return;
    const restoredArea = serviceAreas.find((a) => a.id === areaId);
    try {
      await apiFetch(`/vendors/${editId}/service-areas/${areaId}`, { method: 'DELETE' });
      toastRemoved('Service area', {
        onUndo: restoredArea
          ? () => {
              void apiFetch(`/vendors/${editId}/service-areas`, {
                method: 'POST',
                body: JSON.stringify({
                  space_id: restoredArea.space_id,
                  service_type: restoredArea.service_type,
                  default_priority: restoredArea.default_priority,
                }),
              }).then(() => loadAreas(editId));
            }
          : undefined,
      });
      await loadAreas(editId);
    } catch (err) {
      toastError("Couldn't remove service area", { error: err, retry: () => handleRemoveArea(areaId) });
    }
  };

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        title="Vendors"
        description="External parties that fulfil catering, AV, supplies, and other services. Each vendor serves specific buildings."
        actions={
          <Button className="gap-1.5" onClick={openCreate}>
            <Plus className="size-4" /> Add vendor
          </Button>
        }
      />

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}
      >
        <DialogContent className="sm:max-w-[620px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Vendor</DialogTitle>
              <DialogDescription>
                Define the vendor and the buildings they serve. Menus are managed separately.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup className="max-h-[70vh] overflow-auto">
              <Field>
                <FieldLabel htmlFor="vendor-name">Name</FieldLabel>
                <Input
                  id="vendor-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Compass Catering, Riedel AV Rentals"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel htmlFor="vendor-email">Contact email</FieldLabel>
                  <Input
                    id="vendor-email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="vendor-phone">Contact phone</FieldLabel>
                  <Input
                    id="vendor-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="vendor-website">Website</FieldLabel>
                <Input
                  id="vendor-website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://..."
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="vendor-team">Owning internal team</FieldLabel>
                <Select value={owningTeamId} onValueChange={(v) => setOwningTeamId(v ?? '')}>
                  <SelectTrigger id="vendor-team"><SelectValue placeholder="None — unassigned" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Unassigned</SelectItem>
                    {(teams ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Internal team that owns this vendor relationship (comms, contracts, escalations).
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="vendor-notes">Notes</FieldLabel>
                <Textarea
                  id="vendor-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                />
              </Field>

              <Field orientation="horizontal">
                <Switch
                  id="vendor-status"
                  checked={active}
                  onCheckedChange={(v) => setActive(v === true)}
                />
                <FieldLabel htmlFor="vendor-status" className="font-normal">
                  Active
                </FieldLabel>
              </Field>

              <Field>
                <FieldLabel htmlFor="vendor-default-sla">Default SLA policy</FieldLabel>
                <Select value={defaultSlaPolicyId} onValueChange={(v) => setDefaultSlaPolicyId(v ?? '')}>
                  <SelectTrigger id="vendor-default-sla"><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {(slaPolicies ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Falls back to this when a sub-issue is dispatched to this vendor without an explicit SLA pick.
                </FieldDescription>
              </Field>

              {editId && (
                <>
                  <FieldSeparator />
                  <FieldSet>
                    <FieldLegend variant="label">Service areas</FieldLegend>
                    <FieldDescription>
                      Which buildings this vendor serves, for which service type.
                    </FieldDescription>
                    {areasLoading ? (
                      <FieldDescription>Loading...</FieldDescription>
                    ) : serviceAreas.length === 0 ? (
                      <FieldDescription>No service areas yet.</FieldDescription>
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
                      <Field>
                        <FieldLabel htmlFor="vendor-area-building" className="text-xs">Building</FieldLabel>
                        <SpaceSelect
                          value={newAreaSpaceId}
                          onChange={setNewAreaSpaceId}
                          typeFilter={['site', 'building']}
                          emptyLabel={null}
                          placeholder="Select..."
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="vendor-area-service-type" className="text-xs">Service type</FieldLabel>
                        <ServiceTypeSelect
                          value={newAreaServiceType}
                          onChange={(v) => setNewAreaServiceType(v || 'catering')}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="vendor-area-priority" className="text-xs">Priority</FieldLabel>
                        <Input
                          id="vendor-area-priority"
                          type="number"
                          value={newAreaPriority}
                          onChange={(e) => setNewAreaPriority(e.target.value)}
                        />
                      </Field>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleAddArea}
                        disabled={!newAreaSpaceId}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  </FieldSet>
                </>
              )}
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!name.trim()}>
                {editId ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
        </DialogContent>
      </Dialog>

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
              <TableCell className="font-medium">
                <Link to={`/admin/vendors/${v.id}`} className="hover:underline">
                  {v.name}
                </Link>
              </TableCell>
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
    </SettingsPageShell>
  );
}
