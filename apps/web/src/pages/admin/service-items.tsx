import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Plus, Pencil, Power } from 'lucide-react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { ServiceItemDialog } from '@/components/admin/service-item-dialog';

interface ServiceItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  on_behalf_policy: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
  fulfillment_type_id: string;
  display_order: number;
  active: boolean;
  categories: Array<{ category_id: string }>;
  offerings: Array<{ id: string; scope_kind: 'tenant' | 'space' | 'space_group'; active: boolean }>;
}

interface FulfillmentType { id: string; name: string; domain: string | null }
interface Category { id: string; name: string }

export function ServiceItemsPage() {
  const { data, loading, refetch } = useApi<ServiceItem[]>('/admin/service-items', []);
  const { data: fulfillmentTypes } = useApi<FulfillmentType[]>('/request-types', []);
  const { data: categories } = useApi<Category[]>('/service-catalog/categories', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const ftByIdMap = useMemo(() => {
    return new Map((fulfillmentTypes ?? []).map((f) => [f.id, f]));
  }, [fulfillmentTypes]);
  const catByIdMap = useMemo(() => {
    return new Map((categories ?? []).map((c) => [c.id, c]));
  }, [categories]);

  const openEdit = (id: string) => { setEditId(id); setDialogOpen(true); };
  const openCreate = () => { setEditId(null); setDialogOpen(true); };

  const toggleActive = async (item: ServiceItem) => {
    try {
      await apiFetch(`/admin/service-items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !item.active }),
      });
      toast.success(item.active ? 'Deactivated' : 'Activated');
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Service Catalog</h1>
          <p className="text-muted-foreground mt-1">
            Portal-facing service cards. Each one has coverage (where it's offered), audience rules, and a fulfillment type.
          </p>
        </div>
        <Button className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Service Item
        </Button>
      </div>

      <ServiceItemDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingId={editId}
        onSaved={refetch}
        fulfillmentTypes={fulfillmentTypes ?? []}
        categories={categories ?? []}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[180px]">Key</TableHead>
            <TableHead className="w-[180px]">Fulfillment</TableHead>
            <TableHead className="w-[180px]">Categories</TableHead>
            <TableHead className="w-[140px]">Coverage</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead className="w-[100px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={7} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={7} message="No service items yet — existing Request Types have been backfilled; you can edit them here." />}
          {(data ?? []).map((item) => {
            const ft = ftByIdMap.get(item.fulfillment_type_id);
            const cats = item.categories.map((c) => catByIdMap.get(c.category_id)?.name ?? '—').filter(Boolean);
            const activeOfferings = item.offerings.filter((o) => o.active);
            return (
              <TableRow key={item.id}>
                <TableCell className="font-medium">
                  {item.name}
                  {item.description && (
                    <div className="text-xs text-muted-foreground line-clamp-1">{item.description}</div>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs font-mono">{item.key}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {ft?.name ?? '—'}
                  {ft?.domain && (
                    <Badge variant="outline" className="ml-2 text-[10px] capitalize">{ft.domain}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {cats.length === 0 ? '—' : cats.join(', ')}
                </TableCell>
                <TableCell>
                  {activeOfferings.length === 0 ? (
                    <Badge variant="outline" className="text-amber-600 border-amber-600/40">No coverage</Badge>
                  ) : (
                    <Badge variant="outline">
                      {activeOfferings.length} {activeOfferings.length === 1 ? 'offering' : 'offerings'}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={item.active ? 'default' : 'secondary'}>
                    {item.active ? 'Active' : 'Inactive'}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(item.id)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleActive(item)} title={item.active ? 'Deactivate' : 'Activate'}>
                      <Power className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
