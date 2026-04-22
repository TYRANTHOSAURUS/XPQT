import { useCallback, useEffect, useState } from 'react';
import { MapPin, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { LocationCombobox } from '@/components/location-combobox';
import { toast } from 'sonner';

interface Grant {
  id: string;
  space_id: string;
  granted_by_user_id: string | null;
  granted_at: string;
  note: string | null;
  space: { id: string; name: string; type: string };
}

interface Props {
  personId: string;
}

/**
 * Lists + adds + removes location grants for a person. Used inside the
 * person admin dialog. Backed by GET/POST/DELETE
 * /persons/:id/location-grants. Guarded server-side by people:manage.
 */
export function PersonLocationGrantsPanel({ personId }: Props) {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addSpaceId, setAddSpaceId] = useState<string | null>(null);
  const [addNote, setAddNote] = useState('');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await apiFetch<Grant[]>(`/persons/${personId}/location-grants`);
      setGrants(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load grants');
      setGrants([]);
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onAdd = async () => {
    if (!addSpaceId) {
      toast.error('Pick a site or building to grant');
      return;
    }
    setAdding(true);
    try {
      await apiFetch(`/persons/${personId}/location-grants`, {
        method: 'POST',
        body: JSON.stringify({ space_id: addSpaceId, note: addNote || undefined }),
      });
      setAddSpaceId(null);
      setAddNote('');
      toast.success('Grant added');
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add grant');
    } finally {
      setAdding(false);
    }
  };

  const onRemove = async (grantId: string) => {
    try {
      await apiFetch(`/persons/${personId}/location-grants/${grantId}`, { method: 'DELETE' });
      toast.success('Grant revoked');
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to revoke grant');
    }
  };

  return (
    <FieldGroup>
      <div>
        <h3 className="text-sm font-medium mb-1">Location grants</h3>
        <p className="text-xs text-muted-foreground">
          Extra sites or buildings this person can submit portal requests for. Their default
          work location is always authorized; add grants only for additional locations.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn't load grants</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!loading && grants.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">No grants yet.</p>
      )}

      {grants.length > 0 && (
        <div className="flex flex-col divide-y border rounded-md">
          {grants.map((g) => (
            <div key={g.id} className="flex items-start gap-3 p-3">
              <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{g.space.name}</span>
                  <Badge variant="outline" className="text-xs capitalize">
                    {g.space.type}
                  </Badge>
                </div>
                {g.note && <p className="text-xs text-muted-foreground mt-0.5">{g.note}</p>}
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Granted {new Date(g.granted_at).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => void onRemove(g.id)}
                title="Revoke grant"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <FieldSeparator />

      <Field>
        <FieldLabel>Add a grant</FieldLabel>
        <div className="flex flex-col gap-2">
          <LocationCombobox
            value={addSpaceId}
            onChange={setAddSpaceId}
            typesFilter={['site', 'building']}
            placeholder="Select a site or building…"
            activeOnly
          />
          <Input
            value={addNote}
            onChange={(e) => setAddNote(e.target.value)}
            placeholder="Note (optional) — e.g. regional manager coverage"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              onClick={() => void onAdd()}
              disabled={adding || !addSpaceId}
              className="gap-1"
            >
              <Plus className="h-4 w-4" /> Add grant
            </Button>
          </div>
        </div>
        <FieldDescription>
          Grants must target a site or building. Descendants are authorized automatically.
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
