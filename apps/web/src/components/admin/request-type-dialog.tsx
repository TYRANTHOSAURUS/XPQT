import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

type FulfillmentStrategy = 'asset' | 'location' | 'fixed' | 'auto';

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
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
}

interface SlaPolicy { id: string; name: string }
interface Category { id: string; name: string }
interface RoutingRule { id: string; name: string }
interface Team { id: string; name: string }

const domains = ['it', 'fm', 'workplace', 'visitor', 'catering', 'security', 'general'];

interface RequestTypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: string | null;
  defaultCategoryId?: string | null;
  onSaved: () => void;
}

export function RequestTypeDialog({
  open,
  onOpenChange,
  editingId,
  defaultCategoryId,
  onSaved,
}: RequestTypeDialogProps) {
  const { data: slas } = useApi<SlaPolicy[]>('/sla-policies', []);
  const { data: categories } = useApi<Category[]>('/service-catalog/categories', []);
  const { data: routingRules } = useApi<RoutingRule[]>('/routing-rules', []);
  const { data: teams } = useApi<Team[]>('/teams', []);

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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!editingId) {
      setName('');
      setDomain('general');
      setSlaPolicyId('');
      setCategoryId(defaultCategoryId ?? '');
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
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rt = await apiFetch<RequestType>(`/request-types/${editingId}`);
        if (cancelled) return;
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
      } catch (err) {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : 'Failed to load request type');
        onOpenChange(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, editingId, defaultCategoryId, onOpenChange]);

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
      asset_type_filter: assetTypeFilter.split(',').map((s) => s.trim()).filter(Boolean),
      requires_approval: requiresApproval,
      approval_approver_team_id: requiresApproval ? (approvalApproverTeamId || null) : null,
    };
    setSaving(true);
    try {
      if (editingId) {
        await apiFetch(`/request-types/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Request type updated');
      } else {
        await apiFetch('/request-types', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Request type created');
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save request type');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{editingId ? 'Edit' : 'Create'} Request Type</DialogTitle>
          <DialogDescription>Define the types of requests employees can submit.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IT Incident, Cleaning Request..." />
          </div>
          <div className="grid gap-1.5">
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
          <div className="grid gap-1.5">
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
          <div className="grid gap-1.5">
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
          <div className="grid gap-1.5">
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
          <div className="grid gap-3 border-t pt-4">
            <div>
              <h3 className="font-medium text-sm">Fulfillment</h3>
              <p className="text-xs text-muted-foreground mt-1">
                How tickets of this type get routed to a team.
              </p>
            </div>
            <div className="grid gap-1.5">
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
            {requiresAsset && (
              <div className="grid gap-1.5">
                <Label>Asset type filter</Label>
                <Input
                  value={assetTypeFilter}
                  onChange={(e) => setAssetTypeFilter(e.target.value)}
                  placeholder="Comma-separated asset type IDs (leave blank for any)"
                />
              </div>
            )}
            <div className="grid gap-1.5">
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

          {/* ── Approval section ────────────────────────────── */}
          <div className="grid gap-3 border-t pt-4">
            <div>
              <h3 className="font-medium text-sm">Approval gate</h3>
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
              <div className="grid gap-1.5">
                <Label>Approver team</Label>
                <Select value={approvalApproverTeamId} onValueChange={(v) => setApprovalApproverTeamId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="Pick a team…" /></SelectTrigger>
                  <SelectContent>
                    {(teams ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || saving}>
            {editingId ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
