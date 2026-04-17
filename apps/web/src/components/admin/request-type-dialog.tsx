import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  sla_policy?: { id: string; name: string } | null;
  catalog_category_id?: string | null;
  routing_rule_id?: string | null;
}

interface SlaPolicy { id: string; name: string }
interface Category { id: string; name: string }
interface RoutingRule { id: string; name: string }

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

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('general');
  const [slaPolicyId, setSlaPolicyId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [routingRuleId, setRoutingRuleId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!editingId) {
      setName('');
      setDomain('general');
      setSlaPolicyId('');
      setCategoryId(defaultCategoryId ?? '');
      setRoutingRuleId('');
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
            <Label>Linked Routing Rule</Label>
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
