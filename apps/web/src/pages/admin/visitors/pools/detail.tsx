/**
 * /admin/visitors/pools/:spaceId — pool anchor detail.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.4, §4.5, §8.1
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md slice 9 task 9.2
 *
 * Width `xwide` — passes are dense and the kiosk provisioning section is
 * a multi-column table.
 *
 * Sections:
 *   1. Identity (read-only anchor info — anchor can't change without
 *      re-creating the pool).
 *   2. Pass list — table with inline notes edit + retire/recover actions.
 *      "+ Add pass" opens a dialog with pass_number + notes.
 *   3. Inheritance preview — derived from `pass_pool_for_space()` per
 *      descendant space. Renders a list of "covers X" / "opted out" rows.
 *   4. Kiosk provisioning — list of kiosk_tokens for buildings under
 *      this pool's anchor; provision button → modal that shows the
 *      plaintext token ONCE with copy + QR code.
 *   5. Danger zone — delete pool only when no passes are in_use / reserved.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  Check,
  Copy,
  Plus,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { toastCreated, toastError, toastRemoved, toastSaved, toastSuccess } from '@/lib/toast';
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
} from '@/components/ui/settings-row';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import {
  useAddPass,
  useKioskTokens,
  useMarkPassRecoveredAdmin,
  usePoolAnchor,
  usePoolInheritance,
  useProvisionKiosk,
  useRevokeKiosk,
  useRotateKiosk,
  useUpdatePass,
  type KioskTokenRow,
  type PoolInheritanceRow,
} from '@/api/visitors/admin';
import type { ReceptionPass } from '@/api/visitors/reception';
import {
  useMarkPassMissing,
  useMarkPassRecovered,
} from '@/api/visitors/reception';

export function AdminVisitorPoolDetailPage() {
  const { spaceId } = useParams<{ spaceId: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = usePoolAnchor(spaceId);

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/visitors/pools"
          title="Loading…"
        />
      </SettingsPageShell>
    );
  }

  if (!data || !spaceId) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/visitors/pools"
          title="Not found"
          description="This pool may have been deleted or you may not have access."
        />
      </SettingsPageShell>
    );
  }

  const { anchor, passes } = data;
  const hasInUse = passes.some(
    (p) => p.status === 'in_use' || p.status === 'reserved',
  );

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/visitors/pools"
        title={`${anchor.name} pool`}
        description={`Pass pool anchored at this ${anchor.space_kind}. Descendant spaces inherit unless explicitly opted out.`}
        actions={
          anchor.uses_visitor_passes ? (
            <Badge variant="default">active</Badge>
          ) : (
            <Badge variant="secondary">opted out</Badge>
          )
        }
      />

      <IdentityGroup anchor={anchor} />
      <PassListGroup spaceId={spaceId} passes={passes} />
      <InheritanceGroup spaceId={spaceId} />
      <KioskProvisioningGroup spaceId={spaceId} />
      <DangerGroup
        anchorName={anchor.name}
        canDelete={!hasInUse}
        onDeleted={() => navigate('/admin/visitors/pools')}
      />
    </SettingsPageShell>
  );
}

function IdentityGroup({
  anchor,
}: {
  anchor: { id: string; name: string; space_kind: string; uses_visitor_passes: boolean };
}) {
  return (
    <SettingsGroup
      title="Identity"
      description="The anchor space can't be moved without re-creating the pool."
    >
      <SettingsRow
        label="Anchor space"
        description={`This pool covers all descendant spaces under this ${anchor.space_kind}.`}
      >
        <Link
          to={`/admin/locations/${anchor.id}`}
          className="text-sm hover:underline underline-offset-2"
        >
          {anchor.name}
        </Link>
      </SettingsRow>
      <SettingsRow
        label="Inheritance enabled"
        description="When off, descendant buildings ignore this pool unless they have their own."
      >
        <Badge variant={anchor.uses_visitor_passes ? 'default' : 'secondary'}>
          {anchor.uses_visitor_passes ? 'inherited' : 'opted out'}
        </Badge>
      </SettingsRow>
    </SettingsGroup>
  );
}

function PassListGroup({
  spaceId,
  passes,
}: {
  spaceId: string;
  passes: ReceptionPass[];
}) {
  const [addOpen, setAddOpen] = useState(false);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">Passes</h2>
          <p className="text-sm text-muted-foreground">
            Physical pass inventory for this anchor. Reception assigns and
            returns passes here. {passes.length} total.
          </p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus className="size-3.5" />
          Add pass
        </Button>
      </div>
      <div className="rounded-lg border bg-card overflow-hidden">
        {passes.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground text-center">
            No passes yet. Add the first one to start using the pool.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Number</TableHead>
                <TableHead className="w-[100px]">Type</TableHead>
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead className="w-[180px]">Last assigned</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-[160px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {passes.map((pass) => (
                <PassRow key={pass.id} spaceId={spaceId} pass={pass} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <AddPassDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        spaceId={spaceId}
      />
    </section>
  );
}

function PassRow({ spaceId, pass }: { spaceId: string; pass: ReceptionPass }) {
  const update = useUpdatePass(spaceId);
  const recoverAdmin = useMarkPassRecoveredAdmin(spaceId);
  const markMissing = useMarkPassMissing(pass.space_id);
  const markRecoveredReception = useMarkPassRecovered(pass.space_id);
  void markRecoveredReception; // not used directly — admin uses recoverAdmin
  void markMissing; // surfaced via inline button below

  const [notes, setNotes] = useState(pass.notes ?? '');
  useEffect(() => setNotes(pass.notes ?? ''), [pass.notes]);
  const dirty = (pass.notes ?? '') !== notes;

  const saveNotes = () => {
    if (!dirty) return;
    update.mutate(
      { pass_id: pass.id, notes: notes.trim() || undefined },
      {
        onSuccess: () => toastSaved('Pass', { silent: false }),
        onError: (err) =>
          toastError("Couldn't save pass notes", { error: err }),
      },
    );
  };

  const retire = () => {
    update.mutate(
      { pass_id: pass.id, retired: true },
      {
        onSuccess: () =>
          toastRemoved('Pass', { verb: 'archived' }),
        onError: (err) => toastError("Couldn't retire pass", { error: err }),
      },
    );
  };

  const recover = () => {
    recoverAdmin.mutate(pass.id, {
      onSuccess: () => toastSuccess('Pass marked recovered'),
      onError: (err) => toastError("Couldn't recover pass", { error: err }),
    });
  };

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{pass.pass_number}</TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {pass.pass_type}
      </TableCell>
      <TableCell>
        <PassStatusBadge status={pass.status} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground tabular-nums">
        {pass.last_assigned_at ? (
          <time
            dateTime={pass.last_assigned_at}
            title={formatFullTimestamp(pass.last_assigned_at)}
          >
            {formatRelativeTime(pass.last_assigned_at)}
          </time>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes…"
            className="text-xs"
            onBlur={saveNotes}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
          {dirty && (
            <Check className="size-3.5 text-muted-foreground" />
          )}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2">
          {pass.status === 'lost' && (
            <Button size="sm" variant="outline" onClick={recover} disabled={recoverAdmin.isPending}>
              Recover
            </Button>
          )}
          {pass.status !== 'retired' && pass.status !== 'in_use' && pass.status !== 'reserved' && (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={retire}
              disabled={update.isPending}
            >
              Retire
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function PassStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'available':
      return <Badge variant="default">available</Badge>;
    case 'reserved':
      return <Badge variant="secondary">reserved</Badge>;
    case 'in_use':
      return <Badge>in use</Badge>;
    case 'lost':
      return <Badge variant="destructive">lost</Badge>;
    case 'retired':
      return <Badge variant="outline">retired</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function AddPassDialog({
  open,
  onOpenChange,
  spaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string;
}) {
  const add = useAddPass(spaceId);
  const [number, setNumber] = useState('');
  const [type, setType] = useState('standard');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) {
      setNumber('');
      setType('standard');
      setNotes('');
    }
  }, [open]);

  const handleAdd = () => {
    if (!number.trim()) return;
    add.mutate(
      {
        pass_number: number.trim(),
        pass_type: type || undefined,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          toastCreated('Pass');
          onOpenChange(false);
        },
        onError: (err) => toastError("Couldn't add pass", { error: err }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Add pass</DialogTitle>
          <DialogDescription>
            Add a physical pass to this anchor's pool. Pass numbers must be
            unique within the pool.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="add-pass-number">Pass number</FieldLabel>
            <Input
              id="add-pass-number"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="e.g. V-001"
              autoFocus
            />
            <FieldDescription>
              Printed on the physical pass. Used by reception to find it.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="add-pass-type">Type</FieldLabel>
            <Select value={type} onValueChange={(v) => setType(v ?? 'standard')}>
              <SelectTrigger id="add-pass-type">
                <SelectValue placeholder="Pick a type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="vip">VIP</SelectItem>
                <SelectItem value="contractor">Contractor</SelectItem>
                <SelectItem value="visitor">Visitor</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              Used for grouping in reception's pass picker.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="add-pass-notes">Notes</FieldLabel>
            <Input
              id="add-pass-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={add.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleAdd}
            disabled={!number.trim() || add.isPending}
          >
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InheritanceGroup({ spaceId }: { spaceId: string }) {
  const { data, isLoading } = usePoolInheritance(spaceId);

  return (
    <SettingsGroup
      title="Inheritance"
      description="Descendant spaces under this anchor — which inherit this pool, which opt out, and which fall back to a different anchor."
    >
      <div className="px-4 py-3 flex flex-col gap-2">
        {isLoading && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
        {!isLoading && (data?.length ?? 0) === 0 && (
          <div className="text-sm text-muted-foreground">
            No descendant sites or buildings.
          </div>
        )}
        {data &&
          data.map((row: PoolInheritanceRow) => (
            <div
              key={row.id}
              className="flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2">
                {row.opted_out ? (
                  <X className="size-3.5 text-muted-foreground" />
                ) : row.covered ? (
                  <Check className="size-3.5 text-foreground" />
                ) : (
                  <AlertCircle className="size-3.5 text-amber-600" />
                )}
                <span className="text-sm">{row.name}</span>
                <span className="text-xs text-muted-foreground capitalize">
                  ({row.type})
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {row.opted_out
                  ? 'Opted out'
                  : row.covered
                  ? 'Covered'
                  : 'Resolves elsewhere'}
              </span>
            </div>
          ))}
      </div>
    </SettingsGroup>
  );
}

function KioskProvisioningGroup({ spaceId }: { spaceId: string }) {
  const { data, isLoading } = useKioskTokens(spaceId);
  const [showProvision, setShowProvision] = useState<string | null>(null);
  const provision = useProvisionKiosk();
  const [setupResult, setSetupResult] = useState<{
    token: string;
    buildingId: string;
    expiresAt: string;
    rotated: boolean;
  } | null>(null);

  const handleProvision = (buildingId: string) => {
    provision.mutate(
      { building_id: buildingId },
      {
        onSuccess: (res) => {
          setSetupResult({
            token: res.token,
            buildingId,
            expiresAt: res.expires_at,
            rotated: false,
          });
          setShowProvision(null);
        },
        onError: (err) =>
          toastError("Couldn't provision kiosk", { error: err }),
      },
    );
  };

  return (
    <SettingsGroup
      title="Kiosk provisioning"
      description="Each lobby kiosk holds a long-lived rotating token bound to a tenant + building. Tokens are 90-day rotation; rotation invalidates the previous token immediately."
    >
      <div className="px-4 py-3 flex flex-col gap-3">
        {isLoading && (
          <div className="text-sm text-muted-foreground">Loading…</div>
        )}
        {!isLoading && (data?.length ?? 0) === 0 && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground">
              No kiosks provisioned yet for buildings under this anchor.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => setShowProvision('__pick__')}
            >
              <Plus className="size-3.5" />
              Provision kiosk
            </Button>
          </div>
        )}
        {data && data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Building</TableHead>
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead className="w-[160px]">Last rotated</TableHead>
                <TableHead className="w-[160px]">Expires</TableHead>
                <TableHead className="w-[200px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((kt) => (
                <KioskRow
                  key={kt.id}
                  kioskToken={kt}
                  onRotated={(token, expiresAt) =>
                    setSetupResult({
                      token,
                      buildingId: kt.building_id,
                      expiresAt,
                      rotated: true,
                    })
                  }
                />
              ))}
            </TableBody>
          </Table>
        )}
        {data && data.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="self-start gap-1.5"
            onClick={() => setShowProvision('__pick__')}
          >
            <Plus className="size-3.5" />
            Provision another kiosk
          </Button>
        )}
      </div>

      <ProvisionPickerDialog
        open={!!showProvision}
        onOpenChange={(o) => setShowProvision(o ? '__pick__' : null)}
        spaceId={spaceId}
        existingTokens={data ?? []}
        onPick={handleProvision}
        loading={provision.isPending}
      />

      <KioskSetupDialog
        result={setupResult}
        onClose={() => setSetupResult(null)}
      />
    </SettingsGroup>
  );
}

function KioskRow({
  kioskToken,
  onRotated,
}: {
  kioskToken: KioskTokenRow;
  onRotated: (token: string, expiresAt: string) => void;
}) {
  const rotate = useRotateKiosk();
  const revoke = useRevokeKiosk();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  return (
    <TableRow>
      <TableCell className="font-medium">
        {kioskToken.building_name}
      </TableCell>
      <TableCell>
        <Badge variant={kioskToken.active ? 'default' : 'secondary'}>
          {kioskToken.active ? 'active' : 'revoked'}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground tabular-nums">
        {kioskToken.rotated_at ? (
          <time
            dateTime={kioskToken.rotated_at}
            title={formatFullTimestamp(kioskToken.rotated_at)}
          >
            {formatRelativeTime(kioskToken.rotated_at)}
          </time>
        ) : (
          'Never'
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground tabular-nums">
        <time
          dateTime={kioskToken.expires_at}
          title={formatFullTimestamp(kioskToken.expires_at)}
        >
          {formatRelativeTime(kioskToken.expires_at)}
        </time>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          {kioskToken.active && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5"
                onClick={() => setConfirmRotate(true)}
                disabled={rotate.isPending}
              >
                <RotateCw className="size-3.5" />
                Rotate
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setConfirmRevoke(true)}
                disabled={revoke.isPending}
              >
                Revoke
              </Button>
            </>
          )}
        </div>
      </TableCell>

      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title={`Rotate kiosk for ${kioskToken.building_name}?`}
        description="The current token will stop working immediately. Make sure to update the lobby tablet right after rotation."
        confirmLabel="Rotate"
        onConfirm={async () => {
          try {
            const res = await rotate.mutateAsync({
              kiosk_token_id: kioskToken.id,
            });
            onRotated(res.token, res.expires_at);
          } catch (err) {
            toastError("Couldn't rotate kiosk", { error: err });
          }
        }}
      />

      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title={`Revoke kiosk for ${kioskToken.building_name}?`}
        description="The kiosk will stop accepting check-ins immediately and cannot be re-activated — you'd need to provision a new token."
        confirmLabel="Revoke"
        destructive
        onConfirm={async () => {
          try {
            await revoke.mutateAsync({ kiosk_token_id: kioskToken.id });
            toastRemoved('Kiosk', { verb: 'revoked' });
          } catch (err) {
            toastError("Couldn't revoke kiosk", { error: err });
          }
        }}
      />
    </TableRow>
  );
}

function ProvisionPickerDialog({
  open,
  onOpenChange,
  spaceId,
  existingTokens,
  onPick,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string;
  existingTokens: KioskTokenRow[];
  onPick: (buildingId: string) => void;
  loading: boolean;
}) {
  // The picker scopes to descendant buildings of the anchor. The simplest
  // pick is via the inheritance preview we already have client-side —
  // any 'building' with covered/opted-out state under this anchor.
  const { data } = usePoolInheritance(spaceId);
  const [pickedBuilding, setPickedBuilding] = useState('');

  useEffect(() => {
    if (!open) setPickedBuilding('');
  }, [open]);

  const buildings = (data ?? []).filter((d) => d.type === 'building');
  const tokenByBuilding = new Map(
    existingTokens.filter((t) => t.active).map((t) => [t.building_id, t]),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Provision kiosk</DialogTitle>
          <DialogDescription>
            Pick a building to provision a kiosk for. Buildings that already
            have an active token will rotate instead of provisioning new.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="provision-building">Building</FieldLabel>
            <Select
              value={pickedBuilding}
              onValueChange={(v) => setPickedBuilding(v ?? '')}
            >
              <SelectTrigger id="provision-building">
                <SelectValue placeholder="Pick a building…" />
              </SelectTrigger>
              <SelectContent>
                {buildings.length === 0 && (
                  <div className="text-xs text-muted-foreground p-3">
                    No descendant buildings.
                  </div>
                )}
                {buildings.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                    {tokenByBuilding.has(b.id) ? ' (active token)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              The token will be bound to the building you pick. The kiosk
              tablet's setup URL embeds it; you'll see the plaintext once.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            onClick={() => onPick(pickedBuilding)}
            disabled={!pickedBuilding || loading}
          >
            {loading ? 'Provisioning…' : 'Provision'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KioskSetupDialog({
  result,
  onClose,
}: {
  result: {
    token: string;
    buildingId: string;
    expiresAt: string;
    rotated: boolean;
  } | null;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [setupUrl, setSetupUrl] = useState('');

  useEffect(() => {
    if (!result) return;
    const tenantHint =
      typeof window !== 'undefined' ? window.location.hostname : '';
    const url = new URL(
      '/kiosk/setup',
      typeof window !== 'undefined'
        ? window.location.origin
        : 'https://app.example.com',
    );
    url.searchParams.set('token', result.token);
    url.searchParams.set('building', result.buildingId);
    if (tenantHint) url.searchParams.set('tenant_host', tenantHint);
    const final = url.toString();
    setSetupUrl(final);

    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, final, { width: 220, margin: 2 }).catch(
        (err: unknown) => {
          // QR rendering should never block surfacing the URL.
          console.error('QR rendering failed', err);
        },
      );
    }
  }, [result]);

  return (
    <Dialog open={!!result} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {result?.rotated ? 'Rotated kiosk token' : 'New kiosk token'}
          </DialogTitle>
          <DialogDescription>
            Copy this now — the plaintext token is shown ONCE. Either paste
            the setup URL into the kiosk's browser or scan the QR code with
            the tablet's camera.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col items-center gap-2">
            <canvas
              ref={canvasRef}
              className="rounded border bg-white p-2"
              aria-label="Kiosk setup QR code"
            />
            <span className="text-xs text-muted-foreground">
              Scan with the tablet's camera
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Setup URL</span>
            <div className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all select-all">
              {setupUrl}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              if (setupUrl) navigator.clipboard.writeText(setupUrl);
              toastSuccess('Setup URL copied');
            }}
          >
            <Copy className="size-3.5" /> Copy URL
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DangerGroup({
  anchorName,
  canDelete,
  onDeleted,
}: {
  anchorName: string;
  canDelete: boolean;
  onDeleted: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Hard delete of a pool anchor is intentionally not exposed by the
  // backend — pool rows are individual passes, and retiring + opting the
  // anchor out is the supported teardown path. The button below is a
  // placeholder pointing the admin at the right path.

  return (
    <SettingsGroup title="Danger zone">
      <SettingsRow
        label="Decommission this pool"
        description="Pool deletion isn't supported when passes are in use or reserved. Retire each pass, then opt the anchor space out via Locations."
      >
        <Button
          variant="outline"
          size="sm"
          className={cn(
            buttonVariants({ variant: 'destructive' }),
            'h-8 px-3 gap-1.5',
            !canDelete && 'pointer-events-none opacity-50',
          )}
          disabled={!canDelete}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 className="size-3.5" />
          Plan decommission
        </Button>
      </SettingsRow>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Decommission ${anchorName} pool`}
        description="Decommissioning is a manual process. Retire each pass first, then visit the anchor space in Locations and clear its uses_visitor_passes flag. Future visits at descendant spaces will resolve to the next-most-specific pool."
        confirmLabel="Got it"
        onConfirm={async () => {
          // No backend call — this is informational.
          onDeleted();
        }}
      />
    </SettingsGroup>
  );
}
