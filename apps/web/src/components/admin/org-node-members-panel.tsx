import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { PersonCombobox } from '@/components/person-combobox';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';

interface Member {
  id: string;
  person_id: string;
  is_primary: boolean;
  person: { id: string; first_name: string; last_name: string; email: string | null };
}

export function OrgNodeMembersPanel({ nodeId }: { nodeId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [addPersonId, setAddPersonId] = useState('');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await apiFetch<Member[]>(`/org-nodes/${nodeId}/members`);
      setMembers(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load members');
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => { void reload(); }, [reload]);

  const addMember = async () => {
    if (!addPersonId) return;
    setAdding(true);
    try {
      await apiFetch(`/org-nodes/${nodeId}/members`, {
        method: 'POST',
        body: JSON.stringify({ person_id: addPersonId, is_primary: true }),
      });
      setAddPersonId('');
      await reload();
      toast.success('Member added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setAdding(false);
    }
  };

  const removeMember = async (personId: string) => {
    try {
      await apiFetch(`/org-nodes/${nodeId}/members/${personId}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove member');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="add-member">Add a member</FieldLabel>
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <PersonCombobox value={addPersonId} onChange={setAddPersonId} />
            </div>
            <Button onClick={addMember} disabled={!addPersonId || adding} className="gap-1.5">
              <Plus className="size-4" />
              Add
            </Button>
          </div>
        </Field>
      </FieldGroup>

      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}
      {!loading && members.length === 0 && (
        <div className="text-sm text-muted-foreground">No members yet.</div>
      )}
      {members.length > 0 && (
        <ul className="flex flex-col gap-1">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 rounded-md border px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">
                  {m.person.first_name} {m.person.last_name}
                </div>
                {m.person.email && (
                  <div className="text-xs text-muted-foreground truncate">{m.person.email}</div>
                )}
              </div>
              {m.is_primary && <Badge variant="secondary">Primary</Badge>}
              <Button variant="ghost" size="icon" onClick={() => removeMember(m.person_id)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
