import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
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
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface DomainParent {
  id: string;
  domain: string;
  parent_domain: string;
}

export function DomainParentsPage() {
  const { data, loading, refetch } = useApi<DomainParent[]>('/domain-parents', []);
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
      toast.success('Domain parent added');
      setDialogOpen(false);
      reset();
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add');
    }
  }

  async function handleDelete(row: DomainParent) {
    if (!confirm(`Remove parent relationship "${row.domain} → ${row.parent_domain}"?`)) return;
    try {
      await apiFetch(`/domain-parents/${row.id}`, { method: 'DELETE' });
      toast.success('Relationship removed');
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Domain Hierarchy</h1>
          <p className="text-muted-foreground mt-1">
            Parent-domain fallback for cross-domain routing (e.g. "doors" → "fm" means doors requests fall back to fm teams when no doors team matches).
          </p>
        </div>
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
