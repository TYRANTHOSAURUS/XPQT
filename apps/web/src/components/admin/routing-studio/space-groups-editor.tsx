import { useState } from 'react';
import { Plus, Pencil, Trash2, X } from 'lucide-react';
import { toastCreated, toastError, toastRemoved, toastUpdated } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { EntityPicker } from '@/components/desk/editors/entity-picker';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useSpaces, spaceKeys } from '@/api/spaces';
import { useSpaceGroups, routingKeys } from '@/api/routing';

interface SpaceOption { id: string; name: string; type?: string }
interface GroupMember { space_id: string; space: { id: string; name: string; type?: string } | null }
interface SpaceGroupWithMembers {
  id: string;
  name: string;
  description: string | null;
  members: GroupMember[];
}

interface Props { compact?: boolean }

export function SpaceGroupsEditor({ compact = false }: Props) {
  const qc = useQueryClient();
  const { data, isPending: loading } = useSpaceGroups() as { data: SpaceGroupWithMembers[] | undefined; isPending: boolean };
  const refetch = () => Promise.all([
    qc.invalidateQueries({ queryKey: routingKeys.spaceGroups() }),
    qc.invalidateQueries({ queryKey: spaceKeys.all }),
  ]);
  const { data: spaces } = useSpaces() as { data: SpaceOption[] | undefined };
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [pickerValue, setPickerValue] = useState<string | null>(null);

  const resetForm = () => {
    setEditId(null); setName(''); setDescription(''); setMemberIds([]); setPickerValue(null);
  };
  const openCreate = () => { resetForm(); setDialogOpen(true); };

  const openEdit = (group: SpaceGroupWithMembers) => {
    setEditId(group.id);
    setName(group.name);
    setDescription(group.description ?? '');
    setMemberIds(group.members.map((m) => m.space_id));
    setPickerValue(null);
    setDialogOpen(true);
  };

  async function saveGroup(): Promise<string | null> {
    if (!name.trim()) return null;
    const body = { name: name.trim(), description: description.trim() || null };
    try {
      if (editId) {
        await apiFetch(`/space-groups/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
        return editId;
      }
      const created = await apiFetch<{ id: string }>('/space-groups', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return created.id;
    } catch (err) {
      toastError("Couldn't save group", { error: err });
      return null;
    }
  }

  async function syncMembers(groupId: string, originalIds: string[], nextIds: string[]) {
    const toAdd = nextIds.filter((id) => !originalIds.includes(id));
    const toRemove = originalIds.filter((id) => !nextIds.includes(id));
    await Promise.all([
      ...toAdd.map((space_id) =>
        apiFetch(`/space-groups/${groupId}/members`, {
          method: 'POST',
          body: JSON.stringify({ space_id }),
        })
      ),
      ...toRemove.map((space_id) =>
        apiFetch(`/space-groups/${groupId}/members/${space_id}`, { method: 'DELETE' })
      ),
    ]);
  }

  async function handleSave() {
    const id = await saveGroup();
    if (!id) return;
    const original = data?.find((g) => g.id === id)?.members.map((m) => m.space_id) ?? [];
    try {
      await syncMembers(id, original, memberIds);
      if (editId) {
        toastUpdated('Group');
      } else {
        toastCreated('Group');
      }
      setDialogOpen(false);
      resetForm();
      refetch();
    } catch (err) {
      toastError("Couldn't sync group members", { error: err, retry: handleSave });
    }
  }

  async function handleDelete(group: SpaceGroupWithMembers) {
    if (!confirm(`Delete space group "${group.name}"? Any location_teams rows using it will be removed.`)) return;
    try {
      await apiFetch(`/space-groups/${group.id}`, { method: 'DELETE' });
      toastRemoved(group.name, { verb: 'deleted' });
      refetch();
    } catch (err) {
      toastError("Couldn't delete group", { error: err, retry: () => handleDelete(group) });
    }
  }

  const spaceOptions = (spaces ?? []).map((s) => ({ id: s.id, label: s.name, sublabel: s.type ?? null }));
  const availableOptions = spaceOptions.filter((opt) => !memberIds.includes(opt.id));
  const memberLabels = memberIds.map((id) => ({
    id,
    name: spaceOptions.find((o) => o.id === id)?.label ?? id,
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {compact ? (
          <p className="text-sm text-muted-foreground">
            Group spaces with no common ancestor under one routing target (e.g. Buildings A, C, F share one FM team).
          </p>
        ) : <span />}
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Group
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Space Group</DialogTitle>
              <DialogDescription>A set of spaces treated as one scope in location-based routing.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="sg-name">Name</FieldLabel>
                <Input id="sg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. East Campus FM" />
              </Field>
              <Field>
                <FieldLabel htmlFor="sg-description">Description</FieldLabel>
                <Textarea id="sg-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
              </Field>
              <Field>
                <FieldLabel>Member spaces</FieldLabel>
                <EntityPicker
                  value={pickerValue}
                  options={availableOptions}
                  placeholder="space"
                  onChange={(opt) => {
                    if (opt) {
                      setMemberIds((prev) => [...prev, opt.id]);
                      setPickerValue(null);
                    }
                  }}
                />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {memberLabels.length === 0 && (
                    <span className="text-xs text-muted-foreground">No spaces yet.</span>
                  )}
                  {memberLabels.map((m) => (
                    <Badge key={m.id} variant="secondary" className="gap-1">
                      {m.name}
                      <button
                        type="button"
                        className="ml-0.5 hover:text-destructive"
                        onClick={() => setMemberIds((prev) => prev.filter((id) => id !== m.id))}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <FieldDescription>Pick spaces one at a time. Changes save when you click Save.</FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!name.trim()}>
                {editId ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[80px]">Members</TableHead>
            <TableHead className="w-[120px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={4} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={4} message="No space groups yet." />}
          {(data ?? []).map((group) => (
            <TableRow key={group.id}>
              <TableCell className="font-medium">{group.name}</TableCell>
              <TableCell className="text-muted-foreground">{group.description ?? '—'}</TableCell>
              <TableCell className="font-mono">{group.members.length}</TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => handleDelete(group)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
