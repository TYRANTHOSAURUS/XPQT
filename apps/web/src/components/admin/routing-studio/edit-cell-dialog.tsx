import { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toastError, toastUpdated } from '@/lib/toast';
import { apiFetch } from '@/lib/api';
import { useTeams } from '@/api/teams';
import { useVendors } from '@/api/vendors';

type AssigneeKind = 'team' | 'vendor' | 'unset';

export interface EditCellInput {
  space_id: string;
  space_name: string;
  domain: string;
  current_target_kind: 'team' | 'vendor' | null;
  current_target_id: string | null;
  current_target_name: string | null;
  /**
   * If true, the current resolution is inherited (parent / group / fallback) rather
   * than a direct row for this cell. Surfaces a hint in the dialog.
   */
  is_inherited: boolean;
}

interface Props {
  input: EditCellInput | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function EditCellDialog({ input, open, onOpenChange, onSaved }: Props) {
  const { data: teams } = useTeams();
  const { data: vendors } = useVendors();

  const [kind, setKind] = useState<AssigneeKind>('team');
  const [targetId, setTargetId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  // Reset form state when input changes.
  useEffect(() => {
    if (!input) return;
    if (input.current_target_kind === 'team' && input.current_target_id) {
      setKind('team');
      setTargetId(input.current_target_id);
    } else if (input.current_target_kind === 'vendor' && input.current_target_id) {
      setKind('vendor');
      setTargetId(input.current_target_id);
    } else {
      setKind('team');
      setTargetId('');
    }
  }, [input]);

  const optionList = useMemo(() => {
    if (kind === 'team') return (teams ?? []).map((t) => ({ id: t.id, name: t.name }));
    if (kind === 'vendor') return (vendors ?? []).map((v) => ({ id: v.id, name: v.name }));
    return [];
  }, [kind, teams, vendors]);

  const canSave = kind === 'unset' || !!targetId;

  const handleSave = async () => {
    if (!input) return;
    setSaving(true);
    try {
      await apiFetch('/routing/studio/coverage/cell', {
        method: 'PUT',
        body: JSON.stringify({
          space_id: input.space_id,
          domain: input.domain,
          assignee: kind === 'unset' ? null : { kind, id: targetId },
        }),
      });
      toastUpdated('Coverage');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toastError("Couldn't update coverage", { error: e, retry: handleSave });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {input ? `${input.space_name} · ${input.domain}` : 'Edit coverage'}
          </DialogTitle>
          <DialogDescription>
            Sets a direct <code>location_teams</code> row for this cell.
            {input?.is_inherited && (
              <span className="block text-amber-600 dark:text-amber-400">
                Currently resolving via inheritance; this will override with an explicit row.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="cell-kind">Assignee type</FieldLabel>
            <Select value={kind} onValueChange={(v) => { setKind((v ?? 'team') as AssigneeKind); setTargetId(''); }}>
              <SelectTrigger id="cell-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="team">Team</SelectItem>
                <SelectItem value="vendor">Vendor</SelectItem>
                <SelectItem value="unset">Unset (remove row)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {kind !== 'unset' && (
            <Field>
              <FieldLabel htmlFor="cell-target">{kind === 'team' ? 'Team' : 'Vendor'}</FieldLabel>
              <Select value={targetId} onValueChange={(v) => setTargetId(v ?? '')}>
                <SelectTrigger id="cell-target">
                  <SelectValue placeholder={`Select a ${kind}…`} />
                </SelectTrigger>
                <SelectContent>
                  {optionList.map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Creates a direct row; children in the location hierarchy will inherit this unless they have their own override.
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
