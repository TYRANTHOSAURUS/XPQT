import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Plus, Pencil } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { CriteriaSetDialog } from '@/components/admin/criteria-set-dialog';

interface CriteriaSet {
  id: string;
  name: string;
  description: string | null;
  expression: unknown;
  active: boolean;
  updated_at: string;
}

/**
 * Reusable employee-attribute predicates (live-doc §3.4a). Used to gate
 * audience rules, conditional form variants, and configured on-behalf
 * lists. A criteria set evaluates against a person's type / department /
 * division / cost_center / manager_person_id; see
 * apps/api/src/modules/config-engine/criteria-set.service.ts for the full
 * grammar + absent-attribute semantics.
 */
export function CriteriaSetsPage() {
  const { data, loading, refetch } = useApi<CriteriaSet[]>('/criteria-sets', []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const openCreate = () => { setEditingId(null); setDialogOpen(true); };
  const openEdit = (id: string) => { setEditingId(id); setDialogOpen(true); };

  const summary = (expr: unknown) => {
    if (!expr || typeof expr !== 'object') return '—';
    const keys = Object.keys(expr as Record<string, unknown>);
    if (keys.length === 0) return '—';
    return keys[0]; // top-level op: all_of / any_of / not / attr
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Criteria Sets</h1>
          <p className="text-muted-foreground mt-1">
            Reusable employee-attribute predicates. Bind them from audience rules, conditional form
            variants, or configured on-behalf lists on a request type.
          </p>
        </div>
        <Button className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Criteria Set
        </Button>
      </div>

      <CriteriaSetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingId={editingId}
        onSaved={refetch}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[140px]">Top-level op</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={5} />}
          {!loading && (!data || data.length === 0) && (
            <TableEmpty cols={5} message="No criteria sets yet. Create one to bind from audience or on-behalf rules." />
          )}
          {(data ?? []).map((cs) => (
            <TableRow key={cs.id}>
              <TableCell className="font-medium">{cs.name}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{cs.description ?? '—'}</TableCell>
              <TableCell>
                <Badge variant="outline" className="font-mono text-[10px]">{summary(cs.expression)}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant={cs.active ? 'default' : 'secondary'}>{cs.active ? 'Active' : 'Inactive'}</Badge>
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(cs.id)}>
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
