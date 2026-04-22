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
  form_schema_id?: string | null;
  fulfillment_strategy?: 'asset' | 'location' | 'fixed' | 'auto';
  location_granularity?: string | null;
  requires_approval?: boolean;
}

interface Category { id: string; name: string }

export function RequestTypesPage() {
  const { data, loading, refetch } = useApi<RequestType[]>('/request-types', []);
  const { data: categories } = useApi<Category[]>('/service-catalog/categories', []);
  const { data: formSchemas } = useApi<{ id: string; display_name: string }[]>('/config-entities?type=form_schema', []);

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

  const getFormSchemaName = (id: string | null | undefined) => {
    if (!id || !formSchemas) return '—';
    return formSchemas.find((s) => s.id === id)?.display_name ?? '—';
  };

  const formatGranularity = (g: string | null | undefined) => {
    if (!g) return 'Any';
    return g.replace('_', ' ');
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
            <TableHead className="w-[100px]">Domain</TableHead>
            <TableHead className="w-[110px]">Strategy</TableHead>
            <TableHead className="w-[130px]">Category</TableHead>
            <TableHead className="w-[150px]">Form</TableHead>
            <TableHead className="w-[130px]">SLA Policy</TableHead>
            <TableHead className="w-[140px]">Location depth</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={9} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={9} message="No request types yet. Create one to get started." />}
          {(data ?? []).map((rt) => (
            <TableRow key={rt.id}>
              <TableCell className="font-medium">
                {rt.name}
                {rt.requires_approval && <Badge variant="outline" className="ml-2 text-xs">approval</Badge>}
              </TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{rt.domain ?? 'general'}</Badge></TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{rt.fulfillment_strategy ?? 'fixed'}</Badge></TableCell>
              <TableCell className="text-muted-foreground text-sm">{getCategoryName(rt.catalog_category_id)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{getFormSchemaName(rt.form_schema_id)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{rt.sla_policy?.name ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground text-sm capitalize">{formatGranularity(rt.location_granularity)}</TableCell>
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
