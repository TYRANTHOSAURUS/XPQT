import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toastError, toastRemoved, toastSuccess } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useDomainParents, routingKeys } from '@/api/routing';

interface DomainParent {
  id: string;
  domain: string;
  parent_domain: string;
}

interface Props {
  /**
   * When true, renders a compact heading-less layout suitable for embedding in a tab.
   * The legacy page uses the default (false) layout which has no heading either but
   * sits under a page-level H1. Kept as a prop for future divergence.
   */
  compact?: boolean;
}

export function DomainFallbacksEditor({ compact = false }: Props) {
  const qc = useQueryClient();
  const { data, isPending: loading } = useDomainParents() as { data: DomainParent[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: routingKeys.domainParents() });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [domain, setDomain] = useState('');
  const [parentDomain, setParentDomain] = useState('');

  const reset = () => { setDomain(''); setParentDomain(''); };
  const openCreate = () => { reset(); setDialogOpen(true); };

  async function handleCreate() {
    if (!domain.trim() || !parentDomain.trim()) return;
    try {
      await apiFetch('/domain-parents', {
        method: 'POST',
        body: JSON.stringify({ domain: domain.trim(), parent_domain: parentDomain.trim() }),
      });
      toastSuccess('Domain parent added');
      setDialogOpen(false);
      reset();
      refetch();
    } catch (err) {
      toastError("Couldn't add domain parent", { error: err, retry: handleCreate });
    }
  }

  async function handleDelete(row: DomainParent) {
    if (!confirm(`Remove parent relationship "${row.domain} → ${row.parent_domain}"?`)) return;
    try {
      await apiFetch(`/domain-parents/${row.id}`, { method: 'DELETE' });
      toastRemoved('Relationship');
      refetch();
    } catch (err) {
      toastError("Couldn't remove relationship", { error: err, retry: () => handleDelete(row) });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {compact ? (
          <p className="text-sm text-muted-foreground">
            Parent-domain fallback chain — e.g. <code>doors → fm</code> means doors requests fall back to fm teams when no doors-specific team matches.
          </p>
        ) : <span />}
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) reset(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Relationship
          </DialogTrigger>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Add Domain Parent</DialogTitle>
              <DialogDescription>Define a fallback domain when routing can't find an exact match.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="dp-domain">Domain</FieldLabel>
                <Input id="dp-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. doors" />
                <FieldDescription>The specific domain (child).</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="dp-parent">Parent Domain</FieldLabel>
                <Input id="dp-parent" value={parentDomain} onChange={(e) => setParentDomain(e.target.value)} placeholder="e.g. fm" />
                <FieldDescription>The broader domain this falls back to.</FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!domain.trim() || !parentDomain.trim()}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Domain</TableHead>
            <TableHead>Parent Domain</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={3} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={3} message="No parent-domain relationships yet." />}
          {(data ?? []).map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono">{row.domain}</TableCell>
              <TableCell className="font-mono text-muted-foreground">→ {row.parent_domain}</TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(row)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
