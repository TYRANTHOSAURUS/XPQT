import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Plus, Pencil } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { RequestTypeDialog } from '@/components/admin/request-type-dialog';

interface RequestType {
  id: string;
  name: string;
  domain: string;
  active: boolean;
  sla_policy?: { id: string; name: string } | null;
  catalog_category_id?: string | null;
  routing_rule_id?: string | null;
}

interface Category { id: string; name: string }
interface RoutingRule { id: string; name: string }

export function RequestTypesPage() {
  const { data, loading, refetch } = useApi<RequestType[]>('/request-types', []);
  const { data: categories } = useApi<Category[]>('/service-catalog/categories', []);
  const { data: routingRules } = useApi<RoutingRule[]>('/routing-rules', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const openEdit = (id: string) => {
    setEditId(id);
    setDialogOpen(true);
  };

  const openCreate = () => {
    setEditId(null);
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
        <Button className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Request Type
        </Button>
      </div>

      <RequestTypeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingId={editId}
        onSaved={refetch}
      />

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
          {loading && <TableLoading cols={7} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={7} message="No request types yet. Create one to get started." />}
          {(data ?? []).map((rt) => (
            <TableRow key={rt.id}>
              <TableCell className="font-medium">{rt.name}</TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{rt.domain ?? 'general'}</Badge></TableCell>
              <TableCell className="text-muted-foreground text-sm">{getCategoryName(rt.catalog_category_id)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{rt.sla_policy?.name ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{getRoutingRuleName(rt.routing_rule_id)}</TableCell>
              <TableCell><Badge variant={rt.active ? 'default' : 'secondary'}>{rt.active ? 'Active' : 'Inactive'}</Badge></TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(rt.id)}>
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
