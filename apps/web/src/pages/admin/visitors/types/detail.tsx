/**
 * /admin/visitors/types/:id — visitor type detail with auto-save SettingsRow.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.2, §11
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 9 task 9.1
 *
 * Save mode: auto-save. Each row is an independent decision; saving one
 *   doesn't imply saving the rest. Text inputs use `useDebouncedSave`;
 *   switches save immediately on change.
 *
 * v2-only fields (`requires_id_scan`, `requires_nda`, `requires_photo`)
 * are surfaced as switches but rendered with a disabled-look + a tooltip
 * pointing to the kiosk identity capture roadmap. Per the brief, they
 * ARE wired (the column exists since slice 1) but unused at runtime.
 *
 * Danger zone uses DELETE → soft-delete (active=false) per the backend
 * comment in admin.controller.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { toastError, toastRemoved, toastSaved } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
} from '@/components/ui/settings-row';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { cn } from '@/lib/utils';
import {
  useAdminVisitorTypes,
  useDeleteVisitorType,
  useUpdateVisitorType,
} from '@/api/visitors/admin';
import type { VisitorType } from '@/api/visitors';

export function AdminVisitorTypeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: types, isLoading } = useAdminVisitorTypes();
  const visitorType = useMemo(
    () => (id ? types?.find((t) => t.id === id) : undefined),
    [types, id],
  );

  if (isLoading) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader backTo="/admin/visitors/types" title="Loading…" />
      </SettingsPageShell>
    );
  }

  if (!visitorType || !id) {
    return (
      <SettingsPageShell>
        <SettingsPageHeader
          backTo="/admin/visitors/types"
          title="Not found"
          description="This visitor type may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  return (
    <DetailBody
      visitorType={visitorType}
      onDeleted={() => navigate('/admin/visitors/types')}
    />
  );
}

interface DetailBodyProps {
  visitorType: VisitorType;
  onDeleted: () => void;
}

function DetailBody({ visitorType, onDeleted }: DetailBodyProps) {
  const update = useUpdateVisitorType(visitorType.id);

  const save = (
    patch: Record<string, unknown>,
    opts: { silent?: boolean } = {},
  ) => {
    update.mutate(patch, {
      onSuccess: () => toastSaved('Visitor type', { silent: opts.silent }),
      onError: (err) =>
        toastError("Couldn't save visitor type", {
          error: err,
          retry: () => save(patch, opts),
        }),
    });
  };

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin/visitors/types"
        title={visitorType.display_name}
        description="What this visitor type's rules and defaults are. Bound to every invite that uses it."
        actions={
          <Badge variant={visitorType.active ? 'default' : 'secondary'}>
            {visitorType.active ? 'active' : 'inactive'}
          </Badge>
        }
      />

      <IdentityGroup visitorType={visitorType} save={save} />
      <ConfigGroup visitorType={visitorType} save={save} />
      <V2Group visitorType={visitorType} save={save} />
      <DangerGroup
        visitorTypeId={visitorType.id}
        displayName={visitorType.display_name}
        onDeleted={onDeleted}
      />
    </SettingsPageShell>
  );
}

function IdentityGroup({
  visitorType,
  save,
}: {
  visitorType: VisitorType;
  save: (patch: Record<string, unknown>, opts?: { silent?: boolean }) => void;
}) {
  const [displayName, setDisplayName] = useState(visitorType.display_name);
  const [description, setDescription] = useState(
    visitorType.description ?? '',
  );

  useEffect(() => setDisplayName(visitorType.display_name), [
    visitorType.display_name,
  ]);
  useEffect(() => setDescription(visitorType.description ?? ''), [
    visitorType.description,
  ]);

  useDebouncedSave(displayName, (v) => {
    if (v.trim() && v.trim() !== visitorType.display_name) {
      save({ display_name: v.trim() }, { silent: true });
    }
  });
  useDebouncedSave(description, (v) => {
    const next = v.trim();
    if (next !== (visitorType.description ?? '')) {
      save({ description: next || undefined }, { silent: true });
    }
  });

  return (
    <SettingsGroup title="Identity">
      <SettingsRow
        label="Display name"
        description="Shown to hosts in the invite form's type dropdown."
      >
        <Input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-[240px]"
        />
      </SettingsRow>
      <SettingsRow
        label="Type key"
        description="Stable identifier used in API payloads and audit logs. Cannot be changed."
      >
        <code className="chip text-xs">{visitorType.type_key}</code>
      </SettingsRow>
      <SettingsRow
        label="Description"
        description="Optional admin-facing note. Not shown to hosts or visitors."
      >
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-[280px]"
        />
      </SettingsRow>
      <SettingsRow
        label="Active"
        description="When off, this type is hidden from invite forms and the kiosk. Existing visits keep the association."
      >
        <Switch
          checked={visitorType.active ?? true}
          onCheckedChange={(next) => save({ active: next })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

function ConfigGroup({
  visitorType,
  save,
}: {
  visitorType: VisitorType;
  save: (patch: Record<string, unknown>, opts?: { silent?: boolean }) => void;
}) {
  const [until, setUntil] = useState(
    visitorType.default_expected_until_offset_minutes ?? 240,
  );
  useEffect(
    () =>
      setUntil(visitorType.default_expected_until_offset_minutes ?? 240),
    [visitorType.default_expected_until_offset_minutes],
  );
  useDebouncedSave(until, (v) => {
    const n = Number(v);
    if (
      !Number.isNaN(n) &&
      n !== (visitorType.default_expected_until_offset_minutes ?? 240) &&
      n >= 15 &&
      n <= 24 * 60
    ) {
      save(
        { default_expected_until_offset_minutes: n },
        { silent: true },
      );
    }
  });

  return (
    <SettingsGroup
      title="Per-type config"
      description="Approval, walk-up, and default visit length for this type."
    >
      <SettingsRow
        label="Requires approval"
        description="When on, invitations of this type wait in pending_approval until an approver acts. Walk-ups of this type are denied."
      >
        <Switch
          checked={visitorType.requires_approval ?? false}
          onCheckedChange={(next) => save({ requires_approval: next })}
        />
      </SettingsRow>
      <SettingsRow
        label="Allow walk-up"
        description="When off, only pre-invited visitors of this type can be checked in. Reception's quick-add walk-up form blocks the type."
      >
        <Switch
          checked={visitorType.allow_walk_up ?? true}
          onCheckedChange={(next) => save({ allow_walk_up: next })}
        />
      </SettingsRow>
      <SettingsRow
        label="Default visit length"
        description="Auto-fills the invite form's `expected_until` to this many minutes after `expected_at`. Hosts can override per invite."
      >
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={15}
            max={1440}
            step={15}
            className="w-[100px]"
            value={until}
            onChange={(e) => setUntil(Number(e.target.value))}
          />
          <span className="text-xs text-muted-foreground">minutes</span>
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}

function V2Group({
  visitorType,
  save,
}: {
  visitorType: VisitorType;
  save: (patch: Record<string, unknown>, opts?: { silent?: boolean }) => void;
}) {
  // These are present-but-unused. The columns exist since slice 1 but no
  // runtime path consumes them yet. We render them so admins can pre-config
  // their tenants before the kiosk-identity pipeline ships.
  const v2 = visitorType as VisitorType & {
    requires_id_scan?: boolean;
    requires_nda?: boolean;
    requires_photo?: boolean;
  };

  return (
    <TooltipProvider delay={150}>
      <SettingsGroup
        title="Identity capture (preview)"
        description="Per-type identity capture rules. Available when the kiosk identity pipeline ships — not enforced today."
      >
        <V2Row
          label="Requires ID scan"
          description="Visitor must scan a government ID at the kiosk before check-in completes."
          checked={v2.requires_id_scan ?? false}
          onChange={(next) => save({ requires_id_scan: next })}
        />
        <V2Row
          label="Requires NDA"
          description="Visitor must accept a tenant-supplied NDA on the kiosk before check-in completes."
          checked={v2.requires_nda ?? false}
          onChange={(next) => save({ requires_nda: next })}
        />
        <V2Row
          label="Requires photo"
          description="Kiosk captures and stores a photo at check-in. Tied to the visitor record + auto-purged per retention policy."
          checked={v2.requires_photo ?? false}
          onChange={(next) => save({ requires_photo: next })}
        />
      </SettingsGroup>
    </TooltipProvider>
  );
}

function V2Row({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <SettingsRow label={label} description={description}>
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="opacity-60">
              <Switch checked={checked} onCheckedChange={onChange} />
            </div>
          }
        />
        <TooltipContent>
          Available when the kiosk identity capture ships.
        </TooltipContent>
      </Tooltip>
    </SettingsRow>
  );
}

function DangerGroup({
  visitorTypeId,
  displayName,
  onDeleted,
}: {
  visitorTypeId: string;
  displayName: string;
  onDeleted: () => void;
}) {
  const del = useDeleteVisitorType();
  const [open, setOpen] = useState(false);

  return (
    <SettingsGroup title="Danger zone">
      <SettingsRow
        label="Delete this visitor type"
        description="Hides the type from invite forms and the kiosk. Existing visitors with this type stay associated. Type cannot be deleted hard."
      >
        <Button
          variant="outline"
          size="sm"
          className={cn(buttonVariants({ variant: 'destructive' }), 'h-8 px-3 gap-1.5')}
          onClick={() => setOpen(true)}
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </SettingsRow>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${displayName}?`}
        description="This visitor type will be hidden from invite forms and the kiosk. Existing visitors with this type stay associated and historical reporting still resolves their type."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          try {
            await del.mutateAsync(visitorTypeId);
            toastRemoved('Visitor type', { verb: 'deleted' });
            onDeleted();
          } catch (err) {
            toastError("Couldn't delete visitor type", { error: err });
          }
        }}
      />
    </SettingsGroup>
  );
}
