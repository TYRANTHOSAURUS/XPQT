import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import {
  SERVICE_CATEGORIES,
  SERVICE_CATEGORY_LABELS,
  useServiceRoutings,
  useCreateServiceRouting,
  useUpdateServiceRouting,
  useDeleteServiceRouting,
  type ServiceCategory,
  type ServiceRoutingRow,
} from '@/api/service-routing';
import { useSpaces } from '@/api/spaces';
import { useTeams } from '@/api/teams';
import { useSlaPolicies } from '@/api/sla-policies';
import {
  toastCreated,
  toastError,
  toastRemoved,
  toastUpdated,
} from '@/lib/toast';

/**
 * /admin/service-routing — index page.
 *
 * The matrix that powers the booking-origin work-order auto-creation flow.
 * Each row says: "for this service category at this location (or tenant-
 * wide), route the internal setup task to this team with this lead time
 * and this SLA policy." Used by the resolve_setup_routing SQL function
 * (00194) when a service rule fires with requires_internal_setup.
 *
 * See docs/assignments-routing-fulfillment.md §25 for the end-to-end flow.
 */
export function ServiceRoutingPage() {
  const { data, isLoading } = useServiceRoutings();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ServiceRoutingRow | null>(null);
  const [deleting, setDeleting] = useState<ServiceRoutingRow | null>(null);

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin"
        title="Service routing"
        description="Where booking-origin internal setup work goes — per service category, per location, with lead time and SLA. Triggered when a service rule on an order line says it requires internal setup."
        actions={
          <Button onClick={() => setCreating(true)} className="gap-1.5">
            <Plus className="size-4" /> New rule
          </Button>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {isEmpty && <EmptyState onCreate={() => setCreating(true)} />}

      {!isLoading && data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">Location</TableHead>
              <TableHead className="w-[180px]">Service</TableHead>
              <TableHead>Internal team</TableHead>
              <TableHead className="w-[110px] text-right">Lead time</TableHead>
              <TableHead className="w-[100px] text-right">Active</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <RoutingRow
                key={row.id}
                row={row}
                onEdit={() => setEditing(row)}
                onDelete={() => setDeleting(row)}
              />
            ))}
          </TableBody>
        </Table>
      )}

      <UpsertDialog
        open={creating}
        onOpenChange={setCreating}
        existingRow={null}
        existingRows={data ?? []}
      />
      <UpsertDialog
        open={editing !== null}
        onOpenChange={(next) => {
          if (!next) setEditing(null);
        }}
        existingRow={editing}
        existingRows={data ?? []}
      />
      {deleting && (
        <DeleteRowDialog row={deleting} onClose={() => setDeleting(null)} />
      )}
    </SettingsPageShell>
  );
}

function RoutingRow({
  row,
  onEdit,
  onDelete,
}: {
  row: ServiceRoutingRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { data: spaces } = useSpaces();
  const { data: teams } = useTeams();
  const space = spaces?.find((s) => s.id === row.location_id);
  const team = teams?.find((t) => t.id === row.internal_team_id);

  return (
    <TableRow>
      <TableCell className="font-medium">
        {row.location_id === null ? (
          <Badge variant="outline" className="font-normal">Tenant default</Badge>
        ) : (
          space?.name ?? <span className="text-muted-foreground">(deleted location)</span>
        )}
      </TableCell>
      <TableCell>{SERVICE_CATEGORY_LABELS[row.service_category]}</TableCell>
      <TableCell>
        {team ? (
          team.name
        ) : (
          <span className="text-muted-foreground italic">No team — handoff disabled</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-sm">
        {row.default_lead_time_minutes} min
      </TableCell>
      <TableCell className="text-right">
        <Badge
          variant="outline"
          className={cn(
            'h-5 border-transparent text-[10px] font-medium',
            row.active
              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {row.active ? 'Active' : 'Inactive'}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={onEdit}
            aria-label="Edit routing rule"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onDelete}
            aria-label="Delete routing rule"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-16 text-center">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">No routing rules yet</h3>
        <p className="max-w-sm text-xs text-muted-foreground">
          Add a rule for each (location, service category) combo that needs
          an internal setup task. Tenant-wide defaults work for small tenants;
          larger tenants override per building.
        </p>
      </div>
      <Button onClick={onCreate} size="sm" className="gap-1.5">
        <Plus className="size-3.5" /> New rule
      </Button>
    </div>
  );
}

function UpsertDialog({
  open,
  onOpenChange,
  existingRow,
  existingRows,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  existingRow: ServiceRoutingRow | null;
  existingRows: ServiceRoutingRow[];
}) {
  const isEdit = existingRow !== null;
  const create = useCreateServiceRouting();
  const update = useUpdateServiceRouting();
  const { data: spaces } = useSpaces();
  const { data: teams } = useTeams();
  const { data: slaPolicies } = useSlaPolicies();

  // Spaces eligible as "locations" — buildings/sites/floors. Skip rooms +
  // desks (too granular for routing) and inactive spaces.
  const locationOptions = useMemo(() => {
    if (!spaces) return [];
    const includedTypes = new Set(['site', 'building', 'floor', 'zone']);
    return spaces
      .filter((s) => s.active && includedTypes.has(s.type))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [spaces]);

  const [locationId, setLocationId] = useState<string | null>(
    existingRow?.location_id ?? null,
  );
  const [category, setCategory] = useState<ServiceCategory>(
    existingRow?.service_category ?? 'catering',
  );
  const [teamId, setTeamId] = useState<string | null>(
    existingRow?.internal_team_id ?? null,
  );
  const [leadMinutes, setLeadMinutes] = useState<string>(
    String(existingRow?.default_lead_time_minutes ?? 30),
  );
  const [slaId, setSlaId] = useState<string | null>(
    existingRow?.sla_policy_id ?? null,
  );
  const [active, setActive] = useState(existingRow?.active ?? true);
  const [error, setError] = useState<string | null>(null);

  // Reset form on open/close.
  const handleOpen = (next: boolean) => {
    if (!next) {
      setError(null);
      if (!isEdit) {
        setLocationId(null);
        setCategory('catering');
        setTeamId(null);
        setLeadMinutes('30');
        setSlaId(null);
        setActive(true);
      }
    }
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    setError(null);
    const lead = parseInt(leadMinutes, 10);
    if (!Number.isFinite(lead) || lead < 0 || lead > 1440) {
      setError('Lead time must be a non-negative number up to 1440 minutes (24h).');
      return;
    }
    // Pre-flight: warn on duplicate (server enforces too, but a friendlier UX
    // catches it client-side before the round trip).
    if (!isEdit) {
      const dup = existingRows.find(
        (r) => r.location_id === locationId && r.service_category === category,
      );
      if (dup) {
        setError(
          locationId
            ? 'A rule for this location and service category already exists. Edit it instead.'
            : 'A tenant-default rule for this service category already exists. Edit it instead.',
        );
        return;
      }
    }
    try {
      if (isEdit && existingRow) {
        await update.mutateAsync({
          id: existingRow.id,
          patch: {
            internal_team_id: teamId,
            default_lead_time_minutes: lead,
            sla_policy_id: slaId,
            active,
          },
        });
        toastUpdated('Routing rule');
      } else {
        await create.mutateAsync({
          location_id: locationId,
          service_category: category,
          internal_team_id: teamId,
          default_lead_time_minutes: lead,
          sla_policy_id: slaId,
          active,
        });
        toastCreated('Routing rule');
      }
      handleOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      setError(message);
      toastError(isEdit ? "Couldn't update routing rule" : "Couldn't create routing rule", {
        error: err,
      });
    }
  };

  const isPending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit routing rule' : 'New routing rule'}</DialogTitle>
          <DialogDescription>
            Internal setup work orders triggered by service rules with
            requires_internal_setup will be routed using this matrix.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="sr-location">Location</FieldLabel>
            <Select
              value={locationId ?? '__tenant_default__'}
              onValueChange={(v) => setLocationId(v === '__tenant_default__' ? null : v)}
              disabled={isEdit}
            >
              <SelectTrigger id="sr-location">
                <SelectValue placeholder="Select location" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__tenant_default__">Tenant default</SelectItem>
                {locationOptions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {isEdit
                ? 'Location is part of the routing key. To change it, delete this rule and add a new one.'
                : 'Pick "Tenant default" for a fallback that applies to any location without a specific override.'}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="sr-category">Service category</FieldLabel>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as ServiceCategory)}
              disabled={isEdit}
            >
              <SelectTrigger id="sr-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {SERVICE_CATEGORY_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isEdit && (
              <FieldDescription>
                Service category is part of the routing key. To change it, delete this rule
                and add a new one.
              </FieldDescription>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="sr-team">Internal team</FieldLabel>
            <Select
              value={teamId ?? '__none__'}
              onValueChange={(v) => setTeamId(v === '__none__' ? null : v)}
            >
              <SelectTrigger id="sr-team">
                <SelectValue placeholder="No team — handoff disabled" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No team — handoff disabled</SelectItem>
                {teams?.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Setting "No team" disables auto-creation for this combo without removing
              the rule — useful when a service rule says setup is needed but you don't
              want a work order spawned at this location.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="sr-lead">Lead time (minutes)</FieldLabel>
            <Input
              id="sr-lead"
              type="number"
              min={0}
              max={1440}
              value={leadMinutes}
              onChange={(e) => setLeadMinutes(e.target.value)}
            />
            <FieldDescription>
              Work order due-date = service window start − this lead time. A service
              rule can override this for high-touch cases.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="sr-sla">SLA policy</FieldLabel>
            <Select
              value={slaId ?? '__none__'}
              onValueChange={(v) => setSlaId(v === '__none__' ? null : v)}
            >
              <SelectTrigger id="sr-sla">
                <SelectValue placeholder="No SLA" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No SLA</SelectItem>
                {slaPolicies?.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Optional. Today the work order's due-date is set directly from lead time;
              SLA policy is informational on the ticket.
            </FieldDescription>
          </Field>

          <Field orientation="horizontal">
            <Input
              id="sr-active"
              type="checkbox"
              className="size-4"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <FieldLabel htmlFor="sr-active" className="font-normal">
              Active
            </FieldLabel>
          </Field>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending}>
            {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRowDialog({
  row,
  onClose,
}: {
  row: ServiceRoutingRow;
  onClose: () => void;
}) {
  const remove = useDeleteServiceRouting();
  const { data: spaces } = useSpaces();
  const space = spaces?.find((s) => s.id === row.location_id);
  const label = `${space?.name ?? 'Tenant default'} → ${SERVICE_CATEGORY_LABELS[row.service_category]}`;

  return (
    <ConfirmDialog
      open={true}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Delete routing rule?"
      description={`The rule "${label}" will be removed. Future order lines matching it will fall back to the next-most-specific rule (or tenant default), or skip auto-creation entirely if no fallback exists.`}
      confirmLabel="Delete rule"
      destructive
      onConfirm={async () => {
        try {
          await remove.mutateAsync(row.id);
          toastRemoved('Routing rule', { verb: 'deleted' });
          onClose();
        } catch (err) {
          toastError("Couldn't delete routing rule", { error: err });
        }
      }}
    />
  );
}
