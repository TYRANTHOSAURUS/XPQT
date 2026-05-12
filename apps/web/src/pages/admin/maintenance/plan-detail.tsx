import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { useAssets, useAssetTypes } from '@/api/assets';
import { useRequestTypes } from '@/api/request-types';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { toastRemoved, toastSaved } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import { describeRecurrence } from '@/lib/maintenance-recurrence';
import {
  maintenancePlanDetailOptions,
  useDeleteMaintenancePlan,
  useUpdateMaintenancePlan,
  type MaintenancePlan,
  type MaintenancePlanPriority,
  type MaintenancePlanUpdateBody,
  type RecurrenceUnit,
} from '@/api/maintenance-plans';
import { usePageQuery } from '@/lib/errors';

type SaveFn = (
  patch: MaintenancePlanUpdateBody,
  opts?: { silent?: boolean },
) => void;

export function MaintenancePlanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: plan, isLoading } = usePageQuery(
    maintenancePlanDetailOptions(id),
  );

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader backTo="/admin/maintenance/plans" title="Loading…" />
      </SettingsPageShell>
    );
  }

  if (!plan) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/maintenance/plans"
          title="Plan not found"
          description="This maintenance plan may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  return (
    <PlanDetailBody
      plan={plan}
      onDeleted={() => navigate('/admin/maintenance/plans')}
    />
  );
}

interface BodyProps {
  plan: MaintenancePlan;
  onDeleted: () => void;
}

function PlanDetailBody({ plan, onDeleted }: BodyProps) {
  const update = useUpdateMaintenancePlan(plan.id);

  const save: SaveFn = (patch, opts) => {
    update.mutate(patch, {
      onSuccess: () => toastSaved('Maintenance plan', { silent: opts?.silent }),
    });
  };

  const headerDescription = useTargetLabel(plan);

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/maintenance/plans"
        title={plan.name}
        description={`Auto-generated work orders for ${headerDescription}`}
        actions={
          <Badge variant={plan.active ? 'default' : 'secondary'}>
            {plan.active ? 'active' : 'inactive'}
          </Badge>
        }
      />

      <IdentityGroup plan={plan} save={save} />
      <TargetGroup plan={plan} save={save} />
      <ScheduleGroup plan={plan} save={save} />
      <TemplateGroup plan={plan} save={save} />
      <RoutingGroup plan={plan} save={save} />
      <OperationsGroup plan={plan} />
      <DangerGroup planId={plan.id} onDeleted={onDeleted} />
    </SettingsPageShell>
  );
}

function useTargetLabel(plan: MaintenancePlan): string {
  const { data: assets } = useAssets();
  const { data: assetTypes } = useAssetTypes();
  if (plan.asset_id) {
    const asset = (assets ?? []).find((a) => a.id === plan.asset_id);
    return asset?.name ?? 'this asset';
  }
  if (plan.asset_type_id) {
    const t = (assetTypes ?? []).find((a) => a.id === plan.asset_type_id);
    return t ? `every ${t.name} asset` : 'every asset of this type';
  }
  return 'an unconfigured target';
}

function IdentityGroup({ plan, save }: { plan: MaintenancePlan; save: SaveFn }) {
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? '');
  useEffect(() => setName(plan.name), [plan.name]);
  useEffect(() => setDescription(plan.description ?? ''), [plan.description]);

  useDebouncedSave(name, (v) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== plan.name) save({ name: trimmed }, { silent: true });
  });
  useDebouncedSave(description, (v) => {
    const nextValue = v.trim() ? v : null;
    if (nextValue !== (plan.description ?? null)) {
      save({ description: nextValue }, { silent: true });
    }
  });

  return (
    <SettingsGroup title="Identity">
      <SettingsRow label="Name" description="Shown in the plan list and on every generated WO's source channel.">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-[280px]"
          aria-label="Plan name"
        />
      </SettingsRow>
      <SettingsRow
        label="Description"
        description="Optional internal note about what this plan covers."
      >
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-[320px] min-h-[64px]"
          aria-label="Plan description"
        />
      </SettingsRow>
      <SettingsRow label="Active" description="When off, the generator skips this plan and no new WOs are created.">
        <Switch
          checked={plan.active}
          onCheckedChange={(next) => save({ active: next })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function TargetGroup({ plan, save }: { plan: MaintenancePlan; save: SaveFn }) {
  const [assetOpen, setAssetOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const { data: assets } = useAssets();
  const { data: assetTypes } = useAssetTypes();

  const assetLabel = plan.asset_id
    ? (assets ?? []).find((a) => a.id === plan.asset_id)?.name ?? 'Unknown asset'
    : 'None';
  const typeLabel = plan.asset_type_id
    ? (assetTypes ?? []).find((t) => t.id === plan.asset_type_id)?.name ?? 'Unknown type'
    : 'None';

  return (
    <SettingsGroup
      title="Target"
      description="Choose ONE — a specific asset generates a single WO per cycle; an asset type fans out to every active asset of that type."
    >
      <SettingsRow
        label="Specific asset"
        description={
          plan.asset_id
            ? 'A single WO per cycle for the selected asset.'
            : plan.asset_type_id
              ? 'Currently configured as a fan-out plan — pick an asset to switch.'
              : 'No specific asset selected.'
        }
        onClick={() => setAssetOpen(true)}
      >
        <SettingsRowValue>{assetLabel}</SettingsRowValue>
      </SettingsRow>
      <SettingsRow
        label="Asset type (fan-out)"
        description={
          plan.asset_type_id
            ? 'One WO per cycle for every active asset of this type.'
            : plan.asset_id
              ? 'Currently configured for a specific asset — pick a type to switch.'
              : 'No asset type selected.'
        }
        onClick={() => setTypeOpen(true)}
      >
        <SettingsRowValue>{typeLabel}</SettingsRowValue>
      </SettingsRow>

      <AssetPickerDialog
        open={assetOpen}
        onOpenChange={setAssetOpen}
        value={plan.asset_id}
        onSave={(nextId) => {
          save({ asset_id: nextId, asset_type_id: null });
          setAssetOpen(false);
        }}
      />
      <AssetTypePickerDialog
        open={typeOpen}
        onOpenChange={setTypeOpen}
        value={plan.asset_type_id}
        onSave={(nextId) => {
          save({ asset_type_id: nextId, asset_id: null });
          setTypeOpen(false);
        }}
      />
    </SettingsGroup>
  );
}

function ScheduleGroup({ plan, save }: { plan: MaintenancePlan; save: SaveFn }) {
  const [interval, setInterval] = useState<number>(plan.recurrence_interval);
  const [anchor, setAnchor] = useState<string>(plan.anchor_date);
  const [leadDays, setLeadDays] = useState<number>(plan.lead_days);
  useEffect(() => setInterval(plan.recurrence_interval), [plan.recurrence_interval]);
  useEffect(() => setAnchor(plan.anchor_date), [plan.anchor_date]);
  useEffect(() => setLeadDays(plan.lead_days), [plan.lead_days]);

  useDebouncedSave(interval, (v) => {
    if (Number.isInteger(v) && v > 0 && v !== plan.recurrence_interval) {
      save({ recurrence_interval: v }, { silent: true });
    }
  });
  useDebouncedSave(anchor, (v) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v !== plan.anchor_date) {
      save({ anchor_date: v }, { silent: true });
    }
  });
  useDebouncedSave(leadDays, (v) => {
    if (Number.isInteger(v) && v >= 0 && v <= 365 && v !== plan.lead_days) {
      save({ lead_days: v }, { silent: true });
    }
  });

  const preview = `${describeRecurrence(plan.recurrence_interval, plan.recurrence_unit)}, ${plan.lead_days} day${plan.lead_days === 1 ? '' : 's'} ahead of the planned start.`;

  return (
    <SettingsGroup title="Schedule">
      <SettingsRow label="Interval" description="How many units between cycles.">
        <Input
          type="number"
          min={1}
          value={interval}
          onChange={(e) => setInterval(Math.max(1, Number(e.target.value) || 1))}
          className="w-[110px]"
          aria-label="Recurrence interval"
        />
      </SettingsRow>
      <SettingsRow label="Unit" description="day / week / month / year.">
        <Select
          value={plan.recurrence_unit}
          onValueChange={(v) =>
            save({ recurrence_unit: v as RecurrenceUnit })
          }
        >
          <SelectTrigger className="w-[140px]" aria-label="Recurrence unit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="week">Week</SelectItem>
            <SelectItem value="month">Month</SelectItem>
            <SelectItem value="year">Year</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow label="Anchor date" description="First cycle (and the cadence reference).">
        <Input
          type="date"
          value={anchor}
          onChange={(e) => setAnchor(e.target.value)}
          className="w-[180px]"
          aria-label="Anchor date"
        />
      </SettingsRow>
      <SettingsRow
        label="Lead days"
        description="How many days ahead of the planned start the WO is generated."
      >
        <Input
          type="number"
          min={0}
          max={365}
          value={leadDays}
          onChange={(e) => setLeadDays(Math.max(0, Number(e.target.value) || 0))}
          className="w-[110px]"
          aria-label="Lead days"
        />
      </SettingsRow>
      <SettingsRow
        label="Preview"
        description={preview}
      >
        <SettingsRowValue>
          <time
            dateTime={plan.next_run_at}
            title={formatFullTimestamp(plan.next_run_at)}
            className="tabular-nums"
          >
            Next due {formatRelativeTime(plan.next_run_at)}
          </time>
        </SettingsRowValue>
      </SettingsRow>
    </SettingsGroup>
  );
}

function TemplateGroup({ plan, save }: { plan: MaintenancePlan; save: SaveFn }) {
  const [title, setTitle] = useState(plan.title_template);
  const [description, setDescription] = useState(plan.description_template ?? '');
  const [duration, setDuration] = useState<number>(plan.planned_duration_minutes ?? 60);
  useEffect(() => setTitle(plan.title_template), [plan.title_template]);
  useEffect(
    () => setDescription(plan.description_template ?? ''),
    [plan.description_template],
  );
  useEffect(
    () => setDuration(plan.planned_duration_minutes ?? 60),
    [plan.planned_duration_minutes],
  );

  useDebouncedSave(title, (v) => {
    const trimmed = v.trim();
    if (trimmed && trimmed !== plan.title_template) {
      save({ title_template: trimmed }, { silent: true });
    }
  });
  useDebouncedSave(description, (v) => {
    const next = v.trim() ? v : null;
    if (next !== (plan.description_template ?? null)) {
      save({ description_template: next }, { silent: true });
    }
  });
  useDebouncedSave(duration, (v) => {
    if (Number.isInteger(v) && v > 0 && v !== (plan.planned_duration_minutes ?? 60)) {
      save({ planned_duration_minutes: v }, { silent: true });
    }
  });

  const titlePreview = renderTitlePreview(plan, title);

  return (
    <SettingsGroup
      title="Work-order template"
      description="Template used for every generated WO. Use {{asset.name}} to interpolate the target asset's name."
    >
      <SettingsRow label="Title template" description="One short line. Required.">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-[320px]"
          aria-label="Title template"
        />
      </SettingsRow>
      <SettingsRow label="Title preview" description="What the next generated WO's title will look like.">
        <SettingsRowValue>{titlePreview}</SettingsRowValue>
      </SettingsRow>
      <SettingsRow
        label="Description template"
        description="Optional. Rendered onto the generated WO's description."
      >
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-[360px] min-h-[80px]"
          aria-label="Description template"
        />
      </SettingsRow>
      <SettingsRow label="Priority" description="Default priority on every generated WO.">
        <Select
          value={plan.priority}
          onValueChange={(v) => save({ priority: v as MaintenancePlanPriority })}
        >
          <SelectTrigger className="w-[160px]" aria-label="Priority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="normal">Normal</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      <SettingsRow
        label="Planned duration"
        description="Minutes blocked on the operator's schedule."
      >
        <Input
          type="number"
          min={1}
          value={duration}
          onChange={(e) => setDuration(Math.max(1, Number(e.target.value) || 60))}
          className="w-[110px]"
          aria-label="Planned duration"
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function renderTitlePreview(plan: MaintenancePlan, template: string): string {
  const placeholder = plan.asset_id
    ? '{asset name}'
    : plan.asset_type_id
      ? '{each asset of this type}'
      : '{asset name}';
  return template.replace(/\{\{\s*asset\.name\s*\}\}/g, placeholder);
}

function RoutingGroup({ plan, save }: { plan: MaintenancePlan; save: SaveFn }) {
  const { data: requestTypes } = useRequestTypes();
  const [rtOpen, setRtOpen] = useState(false);
  const rtLabel = (requestTypes ?? []).find((rt) => rt.id === plan.request_type_id)?.name ?? 'None';

  return (
    <SettingsGroup
      title="Routing"
      description="Where the generated work orders go. Routing rules + SLA branch from the request type."
    >
      <SettingsRow
        label="Request type"
        description="Drives team assignment, SLA, and workflow."
        onClick={() => setRtOpen(true)}
      >
        <SettingsRowValue>{rtLabel}</SettingsRowValue>
      </SettingsRow>

      <RequestTypePickerDialog
        open={rtOpen}
        onOpenChange={setRtOpen}
        value={plan.request_type_id}
        onSave={(nextId) => {
          if (nextId) save({ request_type_id: nextId });
          setRtOpen(false);
        }}
      />
    </SettingsGroup>
  );
}

function OperationsGroup({ plan }: { plan: MaintenancePlan }) {
  return (
    <SettingsGroup
      title="Operations"
      description="Recent activity. The generator runs nightly at 03:00 UTC."
    >
      <SettingsRow label="Next due" description="When the next generation cycle fires.">
        <SettingsRowValue>
          <time
            dateTime={plan.next_run_at}
            title={formatFullTimestamp(plan.next_run_at)}
            className="tabular-nums"
          >
            {formatRelativeTime(plan.next_run_at)}
          </time>
        </SettingsRowValue>
      </SettingsRow>
      <SettingsRow label="Last generated" description="When the generator last spawned a WO for this plan.">
        <SettingsRowValue>
          {plan.last_generated_at ? (
            <time
              dateTime={plan.last_generated_at}
              title={formatFullTimestamp(plan.last_generated_at)}
              className="tabular-nums"
            >
              {formatRelativeTime(plan.last_generated_at)}
            </time>
          ) : (
            '—'
          )}
        </SettingsRowValue>
      </SettingsRow>
      <SettingsRow
        label="Last completed"
        description="When a generated WO was last marked resolved."
      >
        <SettingsRowValue>
          {plan.last_completed_at ? (
            <time
              dateTime={plan.last_completed_at}
              title={formatFullTimestamp(plan.last_completed_at)}
              className="tabular-nums"
            >
              {formatRelativeTime(plan.last_completed_at)}
            </time>
          ) : (
            '—'
          )}
        </SettingsRowValue>
      </SettingsRow>
    </SettingsGroup>
  );
}

function DangerGroup({
  planId,
  onDeleted,
}: {
  planId: string;
  onDeleted: () => void;
}) {
  const del = useDeleteMaintenancePlan();
  const [open, setOpen] = useState(false);

  return (
    <SettingsGroup title="Danger zone">
      <SettingsRow
        label="Delete plan"
        description="If work orders reference this plan, it will be deactivated; otherwise permanently deleted."
      >
        <Button
          variant="outline"
          size="sm"
          className={cn(buttonVariants({ variant: 'destructive' }), 'h-8 px-3')}
          onClick={() => setOpen(true)}
        >
          Delete
        </Button>
      </SettingsRow>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete maintenance plan"
        description="If any work orders reference this plan, it will be deactivated (soft-deleted) so the audit chain is preserved. Otherwise it is permanently removed."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          const res = await del.mutateAsync(planId);
          toastRemoved('Maintenance plan', {
            verb: res.mode === 'soft' ? 'deactivated' : 'deleted',
          });
          onDeleted();
        }}
      />
    </SettingsGroup>
  );
}

interface AssetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null;
  onSave: (next: string | null) => void;
}

function AssetPickerDialog({ open, onOpenChange, value, onSave }: AssetPickerProps) {
  const { data: assets, isLoading } = useAssets();
  const [current, setCurrent] = useState<string>(value ?? '');
  useEffect(() => {
    if (open) setCurrent(value ?? '');
  }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Pick asset</DialogTitle>
          <DialogDescription>
            Switching to a specific asset clears the asset-type fan-out.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="mp-asset-pick">Asset</FieldLabel>
            <Select value={current} onValueChange={(v) => setCurrent(v ?? '')} disabled={isLoading}>
              <SelectTrigger id="mp-asset-pick">
                <SelectValue placeholder={isLoading ? 'Loading…' : 'Pick an asset…'} />
              </SelectTrigger>
              <SelectContent>
                {(assets ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Only one WO per cycle will be generated.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSave(current || null)} disabled={!current}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AssetTypePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null;
  onSave: (next: string | null) => void;
}

function AssetTypePickerDialog({
  open,
  onOpenChange,
  value,
  onSave,
}: AssetTypePickerProps) {
  const { data: assetTypes, isLoading } = useAssetTypes();
  const [current, setCurrent] = useState<string>(value ?? '');
  useEffect(() => {
    if (open) setCurrent(value ?? '');
  }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Pick asset type</DialogTitle>
          <DialogDescription>
            One WO per active asset of this type will be generated every cycle.
            Switching to an asset type clears the specific-asset selection.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="mp-type-pick">Asset type</FieldLabel>
            <Select value={current} onValueChange={(v) => setCurrent(v ?? '')} disabled={isLoading}>
              <SelectTrigger id="mp-type-pick">
                <SelectValue placeholder={isLoading ? 'Loading…' : 'Pick a type…'} />
              </SelectTrigger>
              <SelectContent>
                {(assetTypes ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSave(current || null)} disabled={!current}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RequestTypePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string | null;
  onSave: (next: string | null) => void;
}

function RequestTypePickerDialog({
  open,
  onOpenChange,
  value,
  onSave,
}: RequestTypePickerDialogProps) {
  const { data: requestTypes, isLoading } = useRequestTypes();
  const [current, setCurrent] = useState<string>(value ?? '');
  useEffect(() => {
    if (open) setCurrent(value ?? '');
  }, [open, value]);

  const sorted = useMemo(
    () =>
      (requestTypes ?? [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [requestTypes],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Pick request type</DialogTitle>
          <DialogDescription>
            Drives routing, SLA, and the workflow on every generated WO.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="mp-rt-pick">Request type</FieldLabel>
            <Select value={current} onValueChange={(v) => setCurrent(v ?? '')} disabled={isLoading}>
              <SelectTrigger id="mp-rt-pick">
                <SelectValue placeholder={isLoading ? 'Loading…' : 'Pick a request type…'} />
              </SelectTrigger>
              <SelectContent>
                {sorted.map((rt) => (
                  <SelectItem key={rt.id} value={rt.id}>
                    {rt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSave(current || null)} disabled={!current}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default MaintenancePlanDetailPage;
