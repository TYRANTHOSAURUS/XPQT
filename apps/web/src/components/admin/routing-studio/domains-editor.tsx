import { useState } from 'react';
import { Plus, Trash2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { TableEmpty, TableLoading } from '@/components/table-states';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useDomainRegistry, routingKeys } from '@/api/routing';

interface Domain {
  id: string;
  tenant_id: string;
  key: string;
  display_name: string;
  parent_domain_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Domain registry editor (public.domains). Drives the v2 engine's
 * domain_id path — request_types.domain_id, location_teams.domain_id
 * and scoped policy rows (domain_ids match) all point here.
 *
 * Pairs with DomainFallbacksEditor (which edits the legacy
 * domain_parents table). During dual-run both coexist; once
 * routing_v2_mode is v2_only for a tenant, Artifact D step 9 drops the
 * free-text columns and the legacy fallbacks editor retires.
 */
export function DomainsEditor() {
  const qc = useQueryClient();
  const { data, isPending: loading } = useDomainRegistry() as { data: Domain[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: routingKeys.domainRegistry() });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [parentId, setParentId] = useState<string>('');

  function reset() {
    setEditId(null);
    setKey('');
    setDisplayName('');
    setParentId('');
  }

  function openCreate() {
    reset();
    setDialogOpen(true);
  }

  function openEdit(row: Domain) {
    setEditId(row.id);
    setKey(row.key);
    setDisplayName(row.display_name);
    setParentId(row.parent_domain_id ?? '');
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!key.trim()) { toast.error('Key required'); return; }
    if (!displayName.trim()) { toast.error('Display name required'); return; }
    try {
      if (editId) {
        await apiFetch(`/admin/routing/domains/${editId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            display_name: displayName.trim(),
            parent_domain_id: parentId || null,
          }),
        });
        toast.success(`Updated ${key}`);
      } else {
        await apiFetch('/admin/routing/domains', {
          method: 'POST',
          body: JSON.stringify({
            key: key.trim(),
            display_name: displayName.trim(),
            parent_domain_id: parentId || null,
          }),
        });
        toast.success(`Added ${key}`);
      }
      setDialogOpen(false);
      reset();
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save domain');
    }
  }

  async function handleToggleActive(row: Domain) {
    try {
      if (row.active) {
        if (!confirm(`Deactivate domain "${row.key}"? Rows pointing to it keep their references but it won't appear in new policy editors.`)) return;
        await apiFetch(`/admin/routing/domains/${row.id}`, { method: 'DELETE' });
        toast.success(`${row.key} deactivated`);
      } else {
        await apiFetch(`/admin/routing/domains/${row.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ active: true }),
        });
        toast.success(`${row.key} reactivated`);
      }
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle');
    }
  }

  const sorted = [...(data ?? [])].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.display_name.localeCompare(b.display_name);
  });
  const parentOptions = (data ?? []).filter((d) => d.active);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Canonical list of subject areas ({'fm'}, {'it'}, {'catering'} …). The v2 engine uses
          these ids for domain-based routing. Keys are lowercased and unique per tenant.
        </p>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) reset(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="size-4" /> Add domain
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit domain' : 'Add domain'}</DialogTitle>
              <DialogDescription>
                {editId
                  ? 'Keys are immutable — re-create the domain if you need a new key.'
                  : 'Keys are machine identifiers, lowercase, [a-z0-9_-]+.'}
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="domain-key">Key</FieldLabel>
                <Input
                  id="domain-key"
                  value={key}
                  onChange={(e) => setKey(e.target.value.toLowerCase())}
                  placeholder="e.g. doors"
                  disabled={!!editId}
                />
                <FieldDescription>
                  Must match <code>[a-z0-9_-]+</code>. Lowercased on save.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="domain-name">Display name</FieldLabel>
                <Input
                  id="domain-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Door Hardware"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="domain-parent">Parent domain (optional)</FieldLabel>
                <Select
                  value={parentId || '__none'}
                  onValueChange={(v) => setParentId(!v || v === '__none' ? '' : v)}
                >
                  <SelectTrigger id="domain-parent">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">None</SelectItem>
                    {parentOptions
                      .filter((p) => p.id !== editId)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.display_name} ({p.key})</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  If the specific domain doesn't match a team, the resolver walks up to the
                  parent. e.g. <code>doors → fm</code>.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave}>{editId ? 'Save' : 'Add'}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Display name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Parent</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[80px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && !data ? (
            <TableLoading cols={5} />
          ) : sorted.length === 0 ? (
            <TableEmpty cols={5} message="No domains yet. Add one, or run migration 00041 to backfill from existing free-text values." />
          ) : (
            sorted.map((row) => {
              const parent = (data ?? []).find((d) => d.id === row.parent_domain_id);
              return (
                <TableRow key={row.id} className={row.active ? '' : 'opacity-60'}>
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => openEdit(row)}
                    >
                      {row.display_name}
                    </button>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs">{row.key}</code>
                  </TableCell>
                  <TableCell>
                    {parent ? <span className="text-sm">{parent.display_name}</span> : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.active ? 'outline' : 'secondary'}>
                      {row.active ? 'active' : 'archived'}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      aria-label={row.active ? 'Deactivate' : 'Reactivate'}
                      onClick={() => handleToggleActive(row)}
                    >
                      {row.active ? <Trash2 className="size-4 text-destructive" /> : <RotateCcw className="size-4" />}
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
