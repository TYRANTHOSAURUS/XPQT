import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { useApi } from '@/hooks/use-api';

interface Team { id: string; name: string }
interface Vendor { id: string; name: string }

type AssigneeKind = 'team' | 'vendor' | 'unset';

export interface SetHandlerInput {
  space_id: string;
  space_name: string;
  domain: string;
  current_handler_kind: 'team' | 'vendor' | null;
  current_handler_id: string | null;
  current_handler_name: string | null;
  resolved_via: 'location_team' | 'space_group' | 'rt_default' | null;
}

interface Props {
  serviceItemId: string;
  input: SetHandlerInput | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function SetHandlerDialog({ serviceItemId, input, open, onOpenChange, onSaved }: Props) {
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: vendors } = useApi<Vendor[]>('/vendors', []);

  const [kind, setKind] = useState<AssigneeKind>('team');
  const [targetId, setTargetId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!input) return;
    if (input.current_handler_kind === 'team' && input.current_handler_id) {
      setKind('team');
      setTargetId(input.current_handler_id);
    } else if (input.current_handler_kind === 'vendor' && input.current_handler_id) {
      setKind('vendor');
      setTargetId(input.current_handler_id);
    } else {
      setKind('team');
      setTargetId('');
    }
  }, [input]);

  const options = useMemo(() => {
    if (kind === 'team') return (teams ?? []).map((t) => ({ id: t.id, name: t.name }));
    if (kind === 'vendor') return (vendors ?? []).map((v) => ({ id: v.id, name: v.name }));
    return [];
  }, [kind, teams, vendors]);

  const canSave = kind === 'unset' || !!targetId;

  const handleSave = async () => {
    if (!input) return;
    setSaving(true);
    try {
      await apiFetch(`/admin/service-items/${serviceItemId}/handler-at`, {
        method: 'PUT',
        body: JSON.stringify({
          space_id: input.space_id,
          assignee: kind === 'unset' ? null : { kind, id: targetId },
        }),
      });
      toast.success('Handler updated');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const inherited = input?.resolved_via && input.resolved_via !== 'location_team';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {input ? `${input.space_name} · ${input.domain}` : 'Set handler'}
          </DialogTitle>
          <DialogDescription>
            Assigns the team or vendor that handles this service at this location.
            {inherited && (
              <span className="block text-amber-600 dark:text-amber-400 mt-1">
                Currently resolving via {input!.resolved_via === 'rt_default' ? 'request-type default' : 'space group'};
                saving here adds a direct override for this location.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="handler-kind">Assignee type</FieldLabel>
            <Select value={kind} onValueChange={(v) => { setKind((v ?? 'team') as AssigneeKind); setTargetId(''); }}>
              <SelectTrigger id="handler-kind"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="team">Team</SelectItem>
                <SelectItem value="vendor">Vendor</SelectItem>
                <SelectItem value="unset">Unset (remove override)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {kind !== 'unset' && (
            <Field>
              <FieldLabel htmlFor="handler-target">{kind === 'team' ? 'Team' : 'Vendor'}</FieldLabel>
              <Select value={targetId} onValueChange={(v) => setTargetId(v ?? '')}>
                <SelectTrigger id="handler-target">
                  <SelectValue placeholder={`Select a ${kind}…`} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Descendants (floors/rooms) inherit this unless they have their own row.
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
