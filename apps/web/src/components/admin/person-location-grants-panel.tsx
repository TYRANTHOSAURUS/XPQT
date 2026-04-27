import { useCallback, useEffect, useState } from 'react';
import { MapPin, Plus, Trash2, Home, Users } from 'lucide-react';
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
import { toastError, toastRemoved, toastSuccess } from '@/lib/toast';

type AuthSource = 'default' | 'grant' | 'org_grant';
interface EffectiveAuth {
  source: AuthSource;
  space: { id: string; name: string; type: string };
  grant_id: string | null;
  granted_at: string | null;
  note: string | null;
  org_node: { id: string; name: string } | null;
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
  const [effective, setEffective] = useState<EffectiveAuth[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addSpaceId, setAddSpaceId] = useState<string | null>(null);
  const [addNote, setAddNote] = useState('');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const eff = await apiFetch<EffectiveAuth[]>(`/persons/${personId}/effective-authorization`);
      setEffective(eff);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load authorization');
      setEffective([]);
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onAdd = async () => {
    if (!addSpaceId) return;
    setAdding(true);
    try {
      await apiFetch(`/persons/${personId}/location-grants`, {
        method: 'POST',
        body: JSON.stringify({ space_id: addSpaceId, note: addNote || undefined }),
      });
      setAddSpaceId(null);
      setAddNote('');
      toastSuccess('Grant added');
      await reload();
    } catch (e) {
      toastError("Couldn't add grant", { error: e, retry: onAdd });
    } finally {
      setAdding(false);
    }
  };

  const onRemove = async (grantId: string) => {
    try {
      await apiFetch(`/persons/${personId}/location-grants/${grantId}`, { method: 'DELETE' });
      toastRemoved('Grant', { verb: 'revoked' });
      await reload();
    } catch (e) {
      toastError("Couldn't revoke grant", { error: e, retry: () => onRemove(grantId) });
    }
  };

  return (
    <FieldGroup>
      <div>
        <h3 className="text-sm font-medium mb-1">Effective portal authorization</h3>
        <p className="text-xs text-muted-foreground">
          Every location this person can submit requests for, with the reason
          they're authorized: their default work location, an explicit grant,
          or a grant inherited through an org membership.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Couldn't load authorization</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!loading && effective.length === 0 && !error && (
        <p className="text-sm text-muted-foreground">
          No authorized locations. Set a default work location or add a grant below.
        </p>
      )}

      {effective.length > 0 && (
        <div className="flex flex-col divide-y border rounded-md">
          {effective.map((row, i) => {
            const Icon = row.source === 'default' ? Home : row.source === 'org_grant' ? Users : MapPin;
            return (
              <div key={`${row.source}-${row.space.id}-${row.grant_id ?? i}`} className="flex items-start gap-3 p-3">
                <Icon className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{row.space.name}</span>
                    <Badge variant="outline" className="text-xs capitalize">{row.space.type}</Badge>
                    {row.source === 'default' && (
                      <Badge variant="secondary" className="text-[10px]">default</Badge>
                    )}
                    {row.source === 'grant' && (
                      <Badge variant="secondary" className="text-[10px]">grant</Badge>
                    )}
                    {row.source === 'org_grant' && (
                      <Badge variant="secondary" className="text-[10px]">via org</Badge>
                    )}
                  </div>
                  {row.source === 'default' && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Set as the person's default work location.
                    </p>
                  )}
                  {row.source === 'org_grant' && row.org_node && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Inherited from org node <span className="font-medium">{row.org_node.name}</span>.
                    </p>
                  )}
                  {row.source === 'grant' && row.note && (
                    <p className="text-xs text-muted-foreground mt-0.5">{row.note}</p>
                  )}
                  {row.source === 'grant' && row.granted_at && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Granted {new Date(row.granted_at).toLocaleDateString()/* design-check:allow — legacy; migrate to formatFullTimestamp */}
                    </p>
                  )}
                </div>
                {row.source === 'grant' && row.grant_id && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => void onRemove(row.grant_id!)}
                    title="Revoke grant"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            );
          })}
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
