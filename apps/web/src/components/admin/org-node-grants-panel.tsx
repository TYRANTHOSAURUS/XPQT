import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { LocationCombobox } from '@/components/location-combobox';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';

interface Grant {
  id: string;
  space_id: string;
  granted_at: string;
  note: string | null;
  space: { id: string; name: string; type: string };
}

export function OrgNodeGrantsPanel({ nodeId }: { nodeId: string }) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(false);
  const [addSpaceId, setAddSpaceId] = useState<string | null>(null);
  const [addNote, setAddNote] = useState('');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<Grant[]>(`/org-nodes/${nodeId}/location-grants`);
      setGrants(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load grants');
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => { void reload(); }, [reload]);

  const add = async () => {
    if (!addSpaceId) return;
    setAdding(true);
    try {
      await apiFetch(`/org-nodes/${nodeId}/location-grants`, {
        method: 'POST',
        body: JSON.stringify({ space_id: addSpaceId, note: addNote.trim() || undefined }),
      });
      setAddSpaceId(null);
      setAddNote('');
      await reload();
      toast.success('Location granted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add grant');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await apiFetch(`/org-nodes/${nodeId}/location-grants/${id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove grant');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="grant-space">Add location grant</FieldLabel>
          <LocationCombobox
            value={addSpaceId}
            onChange={setAddSpaceId}
            typesFilter={['site', 'building']}
            activeOnly
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="grant-note">Note (optional)</FieldLabel>
          <Input
            id="grant-note"
            value={addNote}
            onChange={(e) => setAddNote(e.target.value)}
            placeholder="e.g. Includes annex floors"
          />
        </Field>
        <div className="flex justify-end">
          <Button onClick={add} disabled={!addSpaceId || adding} className="gap-1.5">
            <Plus className="size-4" />
            Grant access
          </Button>
        </div>
      </FieldGroup>

      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {!loading && grants.length === 0 && (
        <div className="text-sm text-muted-foreground">No location grants yet.</div>
      )}
      {grants.length > 0 && (
        <ul className="flex flex-col gap-1">
          {grants.map((g) => (
            <li key={g.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
              <MapPin className="size-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{g.space.name}</div>
                {g.note && <div className="text-xs text-muted-foreground truncate">{g.note}</div>}
              </div>
              <Button variant="ghost" size="icon" onClick={() => remove(g.id)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
