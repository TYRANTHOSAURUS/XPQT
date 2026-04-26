import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { PersonPicker } from '@/components/person-picker';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import {
  useCostCenter,
  useDeleteCostCenter,
  useUpdateCostCenter,
} from '@/api/cost-centers';
import { toastError, toastRemoved } from '@/lib/toast';

/**
 * /admin/cost-centers/:id — auto-saving detail page.
 *
 * Each row commits independently (Linear-style "list of decisions"):
 *   - text inputs debounce-save (silent — the input value IS the receipt)
 *   - switches save on toggle
 *   - person picker saves on selection
 *   - delete is its own destructive group
 *
 * Code conflicts (23505 from the partial-unique index) surface as a toast
 * with the server's friendly message.
 */
export function CostCenterDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useCostCenter(id ?? '');
  const update = useUpdateCostCenter();
  const remove = useDeleteCostCenter();

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Local edit state — re-seeded whenever the server row changes.
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!data) return;
    setCode(data.code);
    setName(data.name);
    setDescription(data.description ?? '');
  }, [data?.id, data?.code, data?.name, data?.description]);

  const persist = (
    patch: {
      code?: string;
      name?: string;
      description?: string | null;
      default_approver_person_id?: string | null;
      active?: boolean;
    },
  ) => {
    if (!id) return;
    update.mutate(
      { id, patch },
      {
        onError: (err: unknown) => {
          toastError("Couldn't save cost center", { error: err });
        },
      },
    );
  };

  // Debounce text inputs. Switch + person-picker save synchronously.
  useDebouncedSave(code, (next) => {
    if (data && next !== data.code && next.trim().length > 0) persist({ code: next.trim() });
  });
  useDebouncedSave(name, (next) => {
    if (data && next !== data.name && next.trim().length > 0) persist({ name: next.trim() });
  });
  useDebouncedSave(description, (next) => {
    if (!data) return;
    const normalised = next.trim() || null;
    if (normalised !== (data.description ?? null)) persist({ description: normalised });
  });

  if (isLoading) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader backTo="/admin/cost-centers" title="Loading…" />
      </SettingsPageShell>
    );
  }

  if (!data) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader
          backTo="/admin/cost-centers"
          title="Not found"
          description="This cost center may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/cost-centers"
        title={data.name}
        description={data.description ?? `Code: ${data.code}`}
        actions={
          <Badge
            variant="outline"
            className={
              data.active
                ? 'h-5 border-transparent bg-emerald-500/15 text-[10px] font-medium text-emerald-700 dark:text-emerald-400'
                : 'h-5 border-transparent bg-muted text-[10px] font-medium text-muted-foreground'
            }
          >
            {data.active ? 'Active' : 'Inactive'}
          </Badge>
        }
      />

      <SettingsGroup title="Identity">
        <SettingsRow
          label="Code"
          description="Short, stable identifier used in reports and on the bundle. Unique per tenant."
        >
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={32}
            className="h-8 max-w-[180px] font-mono text-xs tabular-nums"
          />
        </SettingsRow>
        <SettingsRow label="Name" description="Display name shown to admins.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 max-w-xs"
          />
        </SettingsRow>
        <SettingsRow label="Description" description="Optional context for admins.">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="—"
            className="h-8 max-w-md"
          />
        </SettingsRow>
        <SettingsRow
          label="Active"
          description="Inactive cost centers stay assignable to existing bundles but disappear from the picker."
        >
          <Switch
            checked={data.active}
            onCheckedChange={(checked) => persist({ active: checked })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Approval routing"
        description="When a service rule routes to cost_center.default_approver, this person receives the approval row."
      >
        <SettingsRow
          label="Default approver"
          description="Optional. Leave empty to skip cost-center-driven approvals."
        >
          <SettingsRowValue>
            <PersonPicker
              value={data.default_approver_person_id}
              onChange={(personId) => persist({ default_approver_person_id: personId || null })}
              placeholder="No default approver"
              clearLabel="Clear approver"
            />
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label="Delete cost center"
          description="Existing bundles keep their reference (resolved as cost_center_unknown). This cannot be undone."
        >
          <Button
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setConfirmingDelete(true)}
            disabled={remove.isPending}
          >
            <Trash2 className="mr-1.5 size-3.5" /> Delete
          </Button>
        </SettingsRow>
      </SettingsGroup>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={`Delete cost center "${data.name}"?`}
        description="Bundles still tagged with this cost center will surface as 'cost_center_unknown' in reports. This cannot be undone."
        confirmLabel="Delete cost center"
        destructive
        onConfirm={async () => {
          if (!id) return;
          try {
            await remove.mutateAsync(id);
            toastRemoved('Cost center');
            navigate('/admin/cost-centers');
          } catch (err) {
            toastError("Couldn't delete cost center", { error: err });
          }
        }}
      />
    </SettingsPageShell>
  );
}
