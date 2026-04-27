import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { toastCreated, toastError, toastRemoved, toastUpdated } from '@/lib/toast';
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
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useTeams } from '@/api/teams';
import { useVendors } from '@/api/vendors';
import { useSpaces } from '@/api/spaces';
import { useLocationTeams, useSpaceGroups, routingKeys } from '@/api/routing';

interface LocationTeamRow {
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

interface Props { compact?: boolean }

export function LocationTeamsEditor({ compact = false }: Props) {
  const qc = useQueryClient();
  const { data, isPending: loading } = useLocationTeams() as { data: LocationTeamRow[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: routingKeys.all });
  const { data: spaces } = useSpaces() as { data: SpaceOption[] | undefined };
  const { data: groups } = useSpaceGroups() as { data: GroupOption[] | undefined };
  const { data: teams } = useTeams() as { data: TeamOption[] | undefined };
  const { data: vendors } = useVendors() as { data: VendorOption[] | undefined };

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

  const openEdit = (row: LocationTeamRow) => {
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

  const scopeValue = scopeTab === 'space' ? spaceId : groupId;
  const assigneeValue = assigneeTab === 'team' ? teamId : vendorId;
  const canSave = domain.trim().length > 0 && !!scopeValue && !!assigneeValue;

  async function handleSave() {
    if (!canSave) return;

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
        toastUpdated('Routing entry');
      } else {
        await apiFetch('/location-teams', { method: 'POST', body: JSON.stringify(body) });
        toastCreated('Routing entry');
      }
      setDialogOpen(false);
      reset();
      refetch();
    } catch (err) {
      toastError("Couldn't save routing entry", { error: err, retry: handleSave });
    }
  }

  async function handleDelete(row: LocationTeamRow) {
    if (!confirm(`Delete routing entry for domain "${row.domain}"?`)) return;
    try {
      await apiFetch(`/location-teams/${row.id}`, { method: 'DELETE' });
      toastRemoved('Routing entry', { verb: 'deleted' });
      refetch();
    } catch (err) {
      toastError("Couldn't delete routing entry", { error: err, retry: () => handleDelete(row) });
    }
  }

  const spaceOptions = useMemo(
    () => (spaces ?? []).map((s) => ({ id: s.id, label: s.name })),
    [spaces],
  );
  const groupOptions = useMemo(
    () => (groups ?? []).map((g) => ({ id: g.id, label: g.name })),
    [groups],
  );
  const teamOptions = useMemo(
    () => (teams ?? []).map((t) => ({ id: t.id, label: t.name })),
    [teams],
  );
  const vendorOptions = useMemo(
    () => (vendors ?? []).map((v) => ({ id: v.id, label: v.name })),
    [vendors],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {compact ? (
          <p className="text-sm text-muted-foreground">
            Raw list view of <code>location_teams</code> rows. Use Coverage for visual editing; this view supports group-scoped entries too.
          </p>
        ) : <span />}
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
              <Button onClick={handleSave} disabled={!canSave}>{editId ? 'Save' : 'Create'}</Button>
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
