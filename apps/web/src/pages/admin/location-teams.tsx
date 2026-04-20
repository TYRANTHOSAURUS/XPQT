import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { EntityPicker } from '@/components/desk/editors/entity-picker';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface LocationTeam {
  id: string;
  space_id: string | null;
  space_group_id: string | null;
  domain: string;
  team_id: string | null;
  vendor_id: string | null;
  space: { id: string; name: string } | null;
  space_group: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  vendor: { id: string; name: string } | null;
}

interface SpaceOption { id: string; name: string }
interface GroupOption { id: string; name: string }
interface TeamOption { id: string; name: string }
interface VendorOption { id: string; name: string }

type ScopeTab = 'space' | 'group';
type AssigneeTab = 'team' | 'vendor';

export function LocationTeamsPage() {
  const { data, loading, refetch } = useApi<LocationTeam[]>('/location-teams', []);
  const { data: spaces } = useApi<SpaceOption[]>('/spaces', []);
  const { data: groups } = useApi<GroupOption[]>('/space-groups', []);
  const { data: teams } = useApi<TeamOption[]>('/teams', []);
  const { data: vendors } = useApi<VendorOption[]>('/vendors', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [scopeTab, setScopeTab] = useState<ScopeTab>('space');
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [assigneeTab, setAssigneeTab] = useState<AssigneeTab>('team');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);

  const reset = () => {
    setEditId(null); setScopeTab('space'); setSpaceId(null); setGroupId(null);
    setDomain(''); setAssigneeTab('team'); setTeamId(null); setVendorId(null);
  };

  const openCreate = () => { reset(); setDialogOpen(true); };

  const openEdit = (row: LocationTeam) => {
    setEditId(row.id);
    setScopeTab(row.space_group_id ? 'group' : 'space');
    setSpaceId(row.space_id);
    setGroupId(row.space_group_id);
    setDomain(row.domain);
    setAssigneeTab(row.vendor_id ? 'vendor' : 'team');
    setTeamId(row.team_id);
    setVendorId(row.vendor_id);
    setDialogOpen(true);
  };

  function onScopeTabChange(next: string) {
    const t = next as ScopeTab;
    setScopeTab(t);
    if (t === 'space') setGroupId(null); else setSpaceId(null);
  }

  function onAssigneeTabChange(next: string) {
    const t = next as AssigneeTab;
    setAssigneeTab(t);
    if (t === 'team') setVendorId(null); else setTeamId(null);
  }

  async function handleSave() {
    if (!domain.trim()) { toast.error('Domain is required'); return; }
    const scopeValue = scopeTab === 'space' ? spaceId : groupId;
    if (!scopeValue) { toast.error('Pick a space or space group'); return; }
    const assigneeValue = assigneeTab === 'team' ? teamId : vendorId;
    if (!assigneeValue) { toast.error('Pick a team or vendor'); return; }

    const body = {
      space_id: scopeTab === 'space' ? spaceId : null,
      space_group_id: scopeTab === 'group' ? groupId : null,
      domain: domain.trim(),
      team_id: assigneeTab === 'team' ? teamId : null,
      vendor_id: assigneeTab === 'vendor' ? vendorId : null,
    };

    try {
      if (editId) {
        await apiFetch(`/location-teams/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Routing entry updated');
      } else {
        await apiFetch('/location-teams', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Routing entry created');
      }
      setDialogOpen(false);
      reset();
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    }
  }

  async function handleDelete(row: LocationTeam) {
    if (!confirm(`Delete routing entry for domain "${row.domain}"?`)) return;
    try {
      await apiFetch(`/location-teams/${row.id}`, { method: 'DELETE' });
      toast.success('Routing entry deleted');
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  const spaceOptions = (spaces ?? []).map((s) => ({ id: s.id, label: s.name }));
  const groupOptions = (groups ?? []).map((g) => ({ id: g.id, label: g.name }));
  const teamOptions = (teams ?? []).map((t) => ({ id: t.id, label: t.name }));
  const vendorOptions = (vendors ?? []).map((v) => ({ id: v.id, label: v.name }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Location Teams</h1>
          <p className="text-muted-foreground mt-1">
            Map a space (or space group) + domain to the team or vendor that handles it.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) reset(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Entry
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Location Team</DialogTitle>
              <DialogDescription>Assign a team or vendor to handle a given domain at a space or space group.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel>Scope</FieldLabel>
                <Tabs value={scopeTab} onValueChange={onScopeTabChange}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="space">Space</TabsTrigger>
                    <TabsTrigger value="group">Space Group</TabsTrigger>
                  </TabsList>
                  <TabsContent value="space" className="pt-2">
                    <EntityPicker value={spaceId} options={spaceOptions} placeholder="space" onChange={(o) => setSpaceId(o?.id ?? null)} />
                  </TabsContent>
                  <TabsContent value="group" className="pt-2">
                    <EntityPicker value={groupId} options={groupOptions} placeholder="group" onChange={(o) => setGroupId(o?.id ?? null)} />
                  </TabsContent>
                </Tabs>
              </Field>
              <Field>
                <FieldLabel htmlFor="lt-domain">Domain</FieldLabel>
                <Input id="lt-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. fm, it, doors" />
                <FieldDescription>Must match the request type's domain value.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>Assignee</FieldLabel>
                <Tabs value={assigneeTab} onValueChange={onAssigneeTabChange}>
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="team">Team</TabsTrigger>
                    <TabsTrigger value="vendor">Vendor</TabsTrigger>
                  </TabsList>
                  <TabsContent value="team" className="pt-2">
                    <EntityPicker value={teamId} options={teamOptions} placeholder="team" onChange={(o) => setTeamId(o?.id ?? null)} />
                  </TabsContent>
                  <TabsContent value="vendor" className="pt-2">
                    <EntityPicker value={vendorId} options={vendorOptions} placeholder="vendor" onChange={(o) => setVendorId(o?.id ?? null)} />
                  </TabsContent>
                </Tabs>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave}>{editId ? 'Save' : 'Create'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scope</TableHead>
            <TableHead>Domain</TableHead>
            <TableHead>Assignee</TableHead>
            <TableHead className="w-[120px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={4} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={4} message="No location-team entries yet." />}
          {(data ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                {row.space ? (
                  <span className="flex items-center gap-1.5"><Badge variant="outline">Space</Badge> {row.space.name}</span>
                ) : row.space_group ? (
                  <span className="flex items-center gap-1.5"><Badge variant="secondary">Group</Badge> {row.space_group.name}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="font-mono">{row.domain}</TableCell>
              <TableCell>
                {row.team ? (
                  <span className="flex items-center gap-1.5"><Badge variant="outline">Team</Badge> {row.team.name}</span>
                ) : row.vendor ? (
                  <span className="flex items-center gap-1.5"><Badge variant="secondary">Vendor</Badge> {row.vendor.name}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(row)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(row)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
