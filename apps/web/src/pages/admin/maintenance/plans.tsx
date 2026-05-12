import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Wrench } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { useAssets, useAssetTypes } from '@/api/assets';
import { useRequestTypes } from '@/api/request-types';
import {
  maintenancePlansListOptions,
  useCreateMaintenancePlan,
  type MaintenancePlan,
  type RecurrenceUnit,
} from '@/api/maintenance-plans';
import { describeRecurrence } from '@/lib/maintenance-recurrence';
import { usePageQuery } from '@/lib/errors';

export function MaintenancePlansPage() {
  const { data, isLoading } = usePageQuery(maintenancePlansListOptions());
  const [createOpen, setCreateOpen] = useState(false);

  const rows = data?.rows ?? [];
  const isEmpty = !isLoading && rows.length === 0;

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin"
        title="Maintenance plans"
        description="Preventive-maintenance plans that auto-generate work orders on a recurring schedule."
        actions={
          <Button className="gap-1.5" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New plan
          </Button>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!isLoading && rows.length > 0 && <PlansTable rows={rows} />}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Wrench className="size-10 text-muted-foreground" />
          <div className="text-sm font-medium">No maintenance plans yet</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            A maintenance plan turns a recurring schedule into work orders — monthly HVAC
            filter swaps, quarterly fire-extinguisher checks, annual lift inspections.
          </p>
          <Button
            className={cn(buttonVariants({ variant: 'default' }), 'gap-1.5')}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" />
            Create your first plan
          </Button>
        </div>
      )}

      <CreateMaintenancePlanDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </SettingsPageShell>
  );
}

function PlansTable({ rows }: { rows: MaintenancePlan[] }) {
  const { data: assets } = useAssets();
  const { data: assetTypes } = useAssetTypes();
  const { data: requestTypes } = useRequestTypes();

  const assetById = useMemo(() => {
    const map = new Map<string, string>();
    (assets ?? []).forEach((a) => map.set(a.id, a.name));
    return map;
  }, [assets]);

  const assetTypeById = useMemo(() => {
    const map = new Map<string, string>();
    (assetTypes ?? []).forEach((t) => map.set(t.id, t.name));
    return map;
  }, [assetTypes]);

  const requestTypeById = useMemo(() => {
    const map = new Map<string, string>();
    (requestTypes ?? []).forEach((rt) => map.set(rt.id, rt.name));
    return map;
  }, [requestTypes]);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Target</TableHead>
          <TableHead>Request type</TableHead>
          <TableHead>Recurrence</TableHead>
          <TableHead className="tabular-nums">Next due</TableHead>
          <TableHead className="w-[100px]">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((plan) => {
          const target = plan.asset_id
            ? assetById.get(plan.asset_id) ?? 'Unknown asset'
            : plan.asset_type_id
              ? `All ${assetTypeById.get(plan.asset_type_id) ?? 'assets'}`
              : '—';
          const rtName = requestTypeById.get(plan.request_type_id) ?? '—';
          return (
            <TableRow key={plan.id}>
              <TableCell className="font-medium">
                <Link
                  to={`/admin/maintenance/plans/${plan.id}`}
                  className="hover:underline underline-offset-2"
                >
                  {plan.name}
                </Link>
                {plan.description && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {plan.description}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {target}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {rtName}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {describeRecurrence(plan.recurrence_interval, plan.recurrence_unit)}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground tabular-nums">
                <time
                  dateTime={plan.next_run_at}
                  title={formatFullTimestamp(plan.next_run_at)}
                >
                  {formatRelativeTime(plan.next_run_at)}
                </time>
              </TableCell>
              <TableCell>
                <Badge variant={plan.active ? 'default' : 'secondary'}>
                  {plan.active ? 'active' : 'inactive'}
                </Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

interface CreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Minimal create dialog. Captures the bare minimum the backend requires
 * (name + request type + recurrence + anchor + a target). The rest is
 * configured on the detail page via the auto-save SettingsRow surface.
 *
 * We pre-fill title_template to "{{asset.name}} maintenance" so the user
 * doesn't have to draft template prose to satisfy the NOT NULL DB column.
 */
function CreateMaintenancePlanDialog({ open, onOpenChange }: CreateProps) {
  const create = useCreateMaintenancePlan();
  const navigate = useNavigate();
  const { data: assets } = useAssets();
  const { data: assetTypes } = useAssetTypes();
  const { data: requestTypes } = useRequestTypes();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetKind, setTargetKind] = useState<'asset' | 'asset_type'>('asset_type');
  const [assetId, setAssetId] = useState<string>('');
  const [assetTypeId, setAssetTypeId] = useState<string>('');
  const [requestTypeId, setRequestTypeId] = useState<string>('');
  const [recurrenceInterval, setRecurrenceInterval] = useState<number>(1);
  const [recurrenceUnit, setRecurrenceUnit] = useState<RecurrenceUnit>('month');
  const [anchorDate, setAnchorDate] = useState<string>(() => todayIso());

  const reset = () => {
    setName('');
    setDescription('');
    setTargetKind('asset_type');
    setAssetId('');
    setAssetTypeId('');
    setRequestTypeId('');
    setRecurrenceInterval(1);
    setRecurrenceUnit('month');
    setAnchorDate(todayIso());
  };

  const canSubmit =
    name.trim().length > 0 &&
    requestTypeId.length > 0 &&
    ((targetKind === 'asset' && assetId.length > 0) ||
      (targetKind === 'asset_type' && assetTypeId.length > 0)) &&
    Number.isInteger(recurrenceInterval) &&
    recurrenceInterval > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(anchorDate);

  const handleCreate = () => {
    if (!canSubmit) return;
    create.mutate(
      {
        name: name.trim(),
        description: description.trim() || null,
        asset_id: targetKind === 'asset' ? assetId : null,
        asset_type_id: targetKind === 'asset_type' ? assetTypeId : null,
        request_type_id: requestTypeId,
        title_template: '{{asset.name}} maintenance',
        recurrence_interval: recurrenceInterval,
        recurrence_unit: recurrenceUnit,
        anchor_date: anchorDate,
        active: true,
      },
      {
        onSuccess: (plan) => {
          reset();
          onOpenChange(false);
          navigate(`/admin/maintenance/plans/${plan.id}`);
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>New maintenance plan</DialogTitle>
          <DialogDescription>
            Give the plan a name and pick what it maintains. You'll tune the schedule and
            work-order template on the next screen.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="mp-create-name">Name</FieldLabel>
            <Input
              id="mp-create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Monthly HVAC filter swap"
              autoFocus
            />
            <FieldDescription>Shown in the plan list and on every generated WO's source channel.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="mp-create-desc">Description</FieldLabel>
            <Input
              id="mp-create-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional admin-facing note"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="mp-create-target-kind">Target</FieldLabel>
            <Select
              value={targetKind}
              onValueChange={(v) => {
                setTargetKind(v as 'asset' | 'asset_type');
                setAssetId('');
                setAssetTypeId('');
              }}
            >
              <SelectTrigger id="mp-create-target-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asset_type">Asset type (fan-out)</SelectItem>
                <SelectItem value="asset">Specific asset</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              Asset type generates one work order per asset of that type. Specific asset
              generates a single WO per cycle.
            </FieldDescription>
          </Field>
          {targetKind === 'asset' && (
            <Field>
              <FieldLabel htmlFor="mp-create-asset">Asset</FieldLabel>
              <Select value={assetId} onValueChange={(v) => setAssetId(v ?? '')}>
                <SelectTrigger id="mp-create-asset">
                  <SelectValue placeholder="Pick an asset…" />
                </SelectTrigger>
                <SelectContent>
                  {(assets ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {targetKind === 'asset_type' && (
            <Field>
              <FieldLabel htmlFor="mp-create-asset-type">Asset type</FieldLabel>
              <Select value={assetTypeId} onValueChange={(v) => setAssetTypeId(v ?? '')}>
                <SelectTrigger id="mp-create-asset-type">
                  <SelectValue placeholder="Pick an asset type…" />
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
          )}
          <Field>
            <FieldLabel htmlFor="mp-create-rt">Request type</FieldLabel>
            <Select value={requestTypeId} onValueChange={(v) => setRequestTypeId(v ?? '')}>
              <SelectTrigger id="mp-create-rt">
                <SelectValue placeholder="Pick a request type…" />
              </SelectTrigger>
              <SelectContent>
                {(requestTypes ?? []).map((rt) => (
                  <SelectItem key={rt.id} value={rt.id}>
                    {rt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Drives routing and SLA for every generated WO.</FieldDescription>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field>
              <FieldLabel htmlFor="mp-create-interval">Every</FieldLabel>
              <Input
                id="mp-create-interval"
                type="number"
                min={1}
                value={recurrenceInterval}
                onChange={(e) => setRecurrenceInterval(Math.max(1, Number(e.target.value) || 1))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="mp-create-unit">Unit</FieldLabel>
              <Select
                value={recurrenceUnit}
                onValueChange={(v) => setRecurrenceUnit(v as RecurrenceUnit)}
              >
                <SelectTrigger id="mp-create-unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Day</SelectItem>
                  <SelectItem value="week">Week</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                  <SelectItem value="year">Year</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="mp-create-anchor">Anchor date</FieldLabel>
              <Input
                id="mp-create-anchor"
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
              />
            </Field>
          </div>
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canSubmit || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function todayIso(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default MaintenancePlansPage;
