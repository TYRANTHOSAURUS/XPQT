import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

type FulfillmentStrategy = 'asset' | 'location' | 'fixed' | 'auto';

interface RequestType {
  id: string;
  name: string;
  domain: string;
  active: boolean;
  sla_policy?: { id: string; name: string } | null;
  catalog_category_id?: string | null;
  routing_rule_id?: string | null;
  fulfillment_strategy?: FulfillmentStrategy;
  requires_asset?: boolean;
  asset_required?: boolean;
  asset_type_filter?: string[];
  requires_location?: boolean;
  location_required?: boolean;
  default_team_id?: string | null;
  requires_approval?: boolean;
  approval_approver_team_id?: string | null;
  approval_approver_person_id?: string | null;
}

interface SlaPolicy {
  id: string;
  name: string;
}

interface Category {
  id: string;
  name: string;
}

interface RoutingRule {
  id: string;
  name: string;
}

interface Team {
  id: string;
  name: string;
}

const domains = ['it', 'fm', 'workplace', 'visitor', 'catering', 'security', 'general'];

export function RequestTypesPage() {
  const { data, loading, refetch } = useApi<RequestType[]>('/request-types', []);
  const { data: slas } = useApi<SlaPolicy[]>('/sla-policies', []);
  const { data: categories } = useApi<Category[]>('/service-catalog/categories', []);
  const { data: routingRules } = useApi<RoutingRule[]>('/routing-rules', []);
  const { data: teams } = useApi<Team[]>('/teams', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('general');
  const [slaPolicyId, setSlaPolicyId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [routingRuleId, setRoutingRuleId] = useState('');
  const [fulfillmentStrategy, setFulfillmentStrategy] = useState<FulfillmentStrategy>('fixed');
  const [requiresAsset, setRequiresAsset] = useState(false);
  const [assetRequired, setAssetRequired] = useState(false);
  const [requiresLocation, setRequiresLocation] = useState(false);
  const [locationRequired, setLocationRequired] = useState(false);
  const [defaultTeamId, setDefaultTeamId] = useState('');
  const [assetTypeFilter, setAssetTypeFilter] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [approvalApproverTeamId, setApprovalApproverTeamId] = useState('');

  const resetForm = () => {
    setName('');
    setDomain('general');
    setSlaPolicyId('');
    setCategoryId('');
    setRoutingRuleId('');
    setFulfillmentStrategy('fixed');
    setRequiresAsset(false);
    setAssetRequired(false);
    setRequiresLocation(false);
    setLocationRequired(false);
    setDefaultTeamId('');
    setAssetTypeFilter('');
    setRequiresApproval(false);
    setApprovalApproverTeamId('');
    setEditId(null);
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = {
      name,
      domain,
      sla_policy_id: slaPolicyId || undefined,
      catalog_category_id: categoryId || undefined,
      routing_rule_id: routingRuleId || undefined,
      fulfillment_strategy: fulfillmentStrategy,
      requires_asset: requiresAsset,
      asset_required: assetRequired,
      requires_location: requiresLocation,
      location_required: locationRequired,
      default_team_id: defaultTeamId || null,
      asset_type_filter: assetTypeFilter
        .split(',').map((s) => s.trim()).filter(Boolean),
      requires_approval: requiresApproval,
      approval_approver_team_id: requiresApproval ? (approvalApproverTeamId || null) : null,
    };
    if (editId) {
      await apiFetch(`/request-types/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiFetch('/request-types', { method: 'POST', body: JSON.stringify(body) });
    }
    resetForm();
    setDialogOpen(false);
    refetch();
  };

  const openEdit = (rt: RequestType) => {
    setEditId(rt.id);
    setName(rt.name);
    setDomain(rt.domain ?? 'general');
    setSlaPolicyId(rt.sla_policy?.id ?? '');
    setCategoryId(rt.catalog_category_id ?? '');
    setRoutingRuleId(rt.routing_rule_id ?? '');
    setFulfillmentStrategy(rt.fulfillment_strategy ?? 'fixed');
    setRequiresAsset(!!rt.requires_asset);
    setAssetRequired(!!rt.asset_required);
    setRequiresLocation(!!rt.requires_location);
    setLocationRequired(!!rt.location_required);
    setDefaultTeamId(rt.default_team_id ?? '');
    setAssetTypeFilter((rt.asset_type_filter ?? []).join(', '));
    setRequiresApproval(!!rt.requires_approval);
    setApprovalApproverTeamId(rt.approval_approver_team_id ?? '');
    setDialogOpen(true);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const getCategoryName = (id: string | null | undefined) => {
    if (!id || !categories) return '—';
    return categories.find((c) => c.id === id)?.name ?? '—';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Request Types</h1>
          <p className="text-muted-foreground mt-1">Define the types of requests employees can submit</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Request Type
          </DialogTrigger>
          <DialogContent className="sm:max-w-[560px] max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Request Type</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IT Incident, Cleaning Request..." />
              </div>
              <div className="space-y-2">
                <Label>Domain</Label>
                <Select value={domain} onValueChange={(v) => setDomain(v ?? 'general')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {domains.map((d) => (
                      <SelectItem key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Service Catalog Category</Label>
                <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {(categories ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Linked SLA Policy</Label>
                <Select value={slaPolicyId} onValueChange={(v) => setSlaPolicyId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {(slas ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Linked Routing Rule (override)</Label>
                <Select value={routingRuleId} onValueChange={(v) => setRoutingRuleId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {(routingRules ?? []).map((r) => (
                      <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* ── Fulfillment section ─────────────────────────── */}
              <div className="space-y-4 border-t pt-4">
                <div>
                  <h3 className="font-medium">Fulfillment</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    How tickets of this type get routed to a team.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Strategy</Label>
                  <Select
                    value={fulfillmentStrategy}
                    onValueChange={(v) => setFulfillmentStrategy((v ?? 'fixed') as FulfillmentStrategy)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Fixed team (no context needed)</SelectItem>
                      <SelectItem value="asset">Asset-based (e.g. elevator, printer)</SelectItem>
                      <SelectItem value="location">Location-based (e.g. cleaning)</SelectItem>
                      <SelectItem value="auto">Auto — try asset then location</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={requiresAsset}
                        onCheckedChange={(v) => {
                          setRequiresAsset(!!v);
                          if (!v) setAssetRequired(false);
                        }}
                      />
                      Show asset picker
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={assetRequired}
                        onCheckedChange={(v) => setAssetRequired(!!v)}
                        disabled={!requiresAsset}
                      />
                      Asset required
                    </label>
                  </div>
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={requiresLocation}
                        onCheckedChange={(v) => {
                          setRequiresLocation(!!v);
                          if (!v) setLocationRequired(false);
                        }}
                      />
                      Show location picker
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={locationRequired}
                        onCheckedChange={(v) => setLocationRequired(!!v)}
                        disabled={!requiresLocation}
                      />
                      Location required
                    </label>
                  </div>
                </div>

                {requiresAsset && (
                  <div className="space-y-2">
                    <Label>Asset type filter</Label>
                    <Input
                      value={assetTypeFilter}
                      onChange={(e) => setAssetTypeFilter(e.target.value)}
                      placeholder="Comma-separated asset type IDs (leave blank for any)"
                    />
                    <p className="text-xs text-muted-foreground">
                      Restricts the asset picker to assets of these types.
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label>Default fallback team</Label>
                  <Select value={defaultTeamId} onValueChange={(v) => setDefaultTeamId(v ?? '')}>
                    <SelectTrigger><SelectValue placeholder="None — leave unassigned" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">None</SelectItem>
                      {(teams ?? []).map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Used when the resolver chain finds no asset/location match.
                  </p>
                </div>
              </div>

              {/* ── Approval section ──────────────────────────── */}
              <div className="space-y-3 border-t pt-4">
                <div>
                  <h3 className="font-medium">Approval gate</h3>
                  <p className="text-xs text-muted-foreground mt-1">
                    Require a manager or team to approve the ticket before it starts routing.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={requiresApproval}
                    onCheckedChange={(v) => {
                      setRequiresApproval(!!v);
                      if (!v) setApprovalApproverTeamId('');
                    }}
                  />
                  Require approval before routing
                </label>
                {requiresApproval && (
                  <div className="space-y-2">
                    <Label>Approver team</Label>
                    <Select value={approvalApproverTeamId} onValueChange={(v) => setApprovalApproverTeamId(v ?? '')}>
                      <SelectTrigger><SelectValue placeholder="Pick a team…" /></SelectTrigger>
                      <SelectContent>
                        {(teams ?? []).map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Any member of the approver team may approve.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={!name.trim()}>
                  {editId ? 'Save' : 'Create'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[100px]">Domain</TableHead>
            <TableHead className="w-[110px]">Strategy</TableHead>
            <TableHead className="w-[130px]">Category</TableHead>
            <TableHead className="w-[130px]">SLA Policy</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No request types yet. Create one to get started.</TableCell></TableRow>
          )}
          {(data ?? []).map((rt) => (
            <TableRow key={rt.id}>
              <TableCell className="font-medium">{rt.name}</TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{rt.domain ?? 'general'}</Badge></TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{rt.fulfillment_strategy ?? 'fixed'}</Badge></TableCell>
              <TableCell className="text-muted-foreground text-sm">{getCategoryName(rt.catalog_category_id)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{rt.sla_policy?.name ?? '—'}</TableCell>
              <TableCell><Badge variant={rt.active ? 'default' : 'secondary'}>{rt.active ? 'Active' : 'Inactive'}</Badge></TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(rt)}>
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
