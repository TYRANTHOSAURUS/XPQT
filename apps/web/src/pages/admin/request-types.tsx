import { useState } from 'react';
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
import { Plus, Pencil } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface RequestType {
  id: string;
  name: string;
  domain: string;
  active: boolean;
  sla_policy?: { id: string; name: string } | null;
  catalog_category_id?: string | null;
  routing_rule_id?: string | null;
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

const domains = ['it', 'fm', 'workplace', 'visitor', 'catering', 'security', 'general'];

export function RequestTypesPage() {
  const { data, loading, refetch } = useApi<RequestType[]>('/request-types', []);
  const { data: slas } = useApi<SlaPolicy[]>('/sla-policies', []);
  const { data: categories } = useApi<Category[]>('/service-catalog/categories', []);
  const { data: routingRules } = useApi<RoutingRule[]>('/routing-rules', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('general');
  const [slaPolicyId, setSlaPolicyId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [routingRuleId, setRoutingRuleId] = useState('');

  const resetForm = () => {
    setName('');
    setDomain('general');
    setSlaPolicyId('');
    setCategoryId('');
    setRoutingRuleId('');
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

  const getRoutingRuleName = (id: string | null | undefined) => {
    if (!id || !routingRules) return '—';
    return routingRules.find((r) => r.id === id)?.name ?? '—';
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
          <DialogContent className="sm:max-w-[520px]">
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
            <TableHead className="w-[110px]">Domain</TableHead>
            <TableHead className="w-[150px]">Category</TableHead>
            <TableHead className="w-[150px]">SLA Policy</TableHead>
            <TableHead className="w-[150px]">Routing Rule</TableHead>
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
              <TableCell className="text-muted-foreground text-sm">{getCategoryName(rt.catalog_category_id)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{rt.sla_policy?.name ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{getRoutingRuleName(rt.routing_rule_id)}</TableCell>
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
