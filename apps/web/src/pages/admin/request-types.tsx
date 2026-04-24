import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Plus, Pencil } from 'lucide-react';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { RequestTypeDialog } from '@/components/admin/request-type-dialog';
import { requestTypeKeys, useRequestTypes } from '@/api/request-types';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';

export function RequestTypesPage() {
  const qc = useQueryClient();
  const { data, isPending: loading } = useRequestTypes();
  const refetch = () => qc.invalidateQueries({ queryKey: requestTypeKeys.all });

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

  const formatGranularity = (g: string | null | undefined) => {
    if (!g) return 'Any';
    return g.replace('_', ' ');
  };

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        title="Request types"
        description="Fulfilment configuration for each requestable service. Portal-facing fields (categories, coverage, audience, form variants) live under /admin/catalog-hierarchy."
        actions={
          <Button className="gap-1.5" onClick={openCreate}>
            <Plus className="size-4" /> Add request type
          </Button>
        }
      />

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
            <TableHead className="w-[130px]">SLA Policy</TableHead>
            <TableHead className="w-[140px]">Location depth</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={7} />}
          {!loading && (!data || data.length === 0) && (
            <TableEmpty cols={7} message="No request types yet. Create one to get started." />
          )}
          {(data ?? []).map((rt) => (
            <TableRow key={rt.id}>
              <TableCell className="font-medium">
                {rt.name}
                {rt.requires_approval && <Badge variant="outline" className="ml-2 text-xs">approval</Badge>}
              </TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{rt.domain ?? 'general'}</Badge></TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{rt.fulfillment_strategy ?? 'fixed'}</Badge></TableCell>
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
    </SettingsPageShell>
  );
}
