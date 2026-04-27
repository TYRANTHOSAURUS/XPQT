import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toastError, toastRemoved } from '@/lib/toast';
import { Trash2 } from 'lucide-react';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useAsset,
  useAssetTypes,
  useUpsertAsset,
  useDeleteAsset,
} from '@/api/assets';
import { useDebouncedSave } from '@/hooks/use-debounced-save';

const ASSET_ROLES: Array<{ value: 'fixed' | 'personal' | 'pooled'; label: string }> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'personal', label: 'Personal' },
  { value: 'pooled', label: 'Pooled' },
];

const ASSET_STATUSES = [
  { value: 'available', label: 'Available' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'in_maintenance', label: 'In maintenance' },
  { value: 'retired', label: 'Retired' },
  { value: 'disposed', label: 'Disposed' },
];

export function AssetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: asset, isLoading } = useAsset(id);
  const { data: types } = useAssetTypes();
  const upsert = useUpsertAsset();
  const del = useDeleteAsset();

  const [name, setName] = useState('');
  const [tag, setTag] = useState('');
  const [serial, setSerial] = useState('');
  const [role, setRole] = useState<'fixed' | 'personal' | 'pooled'>('fixed');
  const [status, setStatus] = useState('available');
  const [typeId, setTypeId] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const assetId = asset?.id;
  useEffect(() => {
    if (!asset) return;
    setName(asset.name ?? '');
    setTag(asset.tag ?? '');
    setSerial(asset.serial_number ?? '');
    setRole((asset.asset_role as 'fixed' | 'personal' | 'pooled') ?? 'fixed');
    setStatus(asset.status ?? 'available');
    setTypeId(asset.asset_type_id ?? null);
    setActive(asset.active ?? true);
  }, [assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Partial save helper — `name` is required by UpsertAssetPayload, so we
  // always include the current asset name and overlay the patch on top.
  const save = (patch: Partial<Omit<Parameters<typeof upsert.mutate>[0]['payload'], 'name'>>) => {
    if (!asset) return;
    upsert.mutate({ id: asset.id, payload: { ...patch, name: asset.name } });
  };

  useEffect(() => {
    if (upsert.error) {
      toastError("Couldn't save asset", { error: upsert.error });
    }
  }, [upsert.error]);

  useDebouncedSave(name, (v) => {
    if (!asset || v === asset.name) return;
    upsert.mutate({ id: asset.id, payload: { name: v } });
  });
  useDebouncedSave(tag, (v) => {
    if (!asset || v === (asset.tag ?? '')) return;
    save({ tag: v || null });
  });
  useDebouncedSave(serial, (v) => {
    if (!asset || v === (asset.serial_number ?? '')) return;
    save({ serial_number: v || null });
  });

  const headline = useMemo(() => asset?.name ?? 'Loading…', [asset]);

  if (!id) return null;

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/assets"
          title="Loading…"
          description="Fetching asset details"
        />
      </SettingsPageShell>
    );
  }

  if (!asset) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/assets"
          title="Not found"
          description={`No asset with id ${id} in this tenant.`}
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/assets"
        title={headline}
        description={
          asset.asset_type?.name
            ? `${asset.asset_type.name}${asset.tag ? ` · ${asset.tag}` : ''}`
            : 'Tracked equipment.'
        }
        actions={
          <Badge variant={active ? 'default' : 'outline'} className="text-[10px] uppercase tracking-wider">
            {status.replace(/_/g, ' ')}
          </Badge>
        }
      />

      <SettingsGroup title="Identity" description="Name, tag, and lifecycle.">
        <SettingsRow label="Name">
          <SettingsRowValue>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 w-72"
              aria-label="Asset name"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Asset tag" description="Sticker / barcode reference.">
          <SettingsRowValue>
            <Input
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              className="h-8 w-48 font-mono"
              aria-label="Asset tag"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Serial number">
          <SettingsRowValue>
            <Input
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              className="h-8 w-56 font-mono"
              aria-label="Serial number"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Type" description="Asset type for routing and lifecycle defaults.">
          <SettingsRowValue>
            <Select
              value={typeId ?? '__none__'}
              onValueChange={(v) => {
                if (!v) return;
                const next = v === '__none__' ? null : v;
                setTypeId(next);
                save({ asset_type_id: next });
              }}
            >
              <SelectTrigger className="h-8 w-56">
                <SelectValue placeholder="Pick a type…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No type</SelectItem>
                {(types ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Role">
          <SettingsRowValue>
            <Select
              value={role}
              onValueChange={(v) => {
                const next = v as 'fixed' | 'personal' | 'pooled';
                setRole(next);
                save({ asset_role: next });
              }}
            >
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Status">
          <SettingsRowValue>
            <Select
              value={status}
              onValueChange={(v) => {
                if (!v) return;
                setStatus(v);
                save({ status: v });
              }}
            >
              <SelectTrigger className="h-8 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSET_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Active">
          <SettingsRowValue>
            <Switch
              checked={active}
              onCheckedChange={(v) => {
                setActive(v);
                save({ active: v });
              }}
              aria-label="Active"
            />
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Assignment" description="Where this asset lives and who currently holds it.">
        <SettingsRow label="Assigned space">
          <SettingsRowValue>
            <span className="text-sm text-muted-foreground">
              {asset.assigned_space?.name ?? 'Unassigned'}
            </span>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Assigned person">
          <SettingsRowValue>
            <span className="text-sm text-muted-foreground">
              {asset.assigned_person
                ? `${asset.assigned_person.first_name} ${asset.assigned_person.last_name}`
                : 'Unassigned'}
            </span>
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label="Delete asset"
          description="Permanently removes this asset record. Tickets that referenced it keep their historical link."
        >
          <SettingsRowValue>
            <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-4" />
              Delete
            </Button>
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${headline}?`}
        description="This cannot be undone. Existing tickets keep their reference but the asset row is removed."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await del.mutateAsync(asset.id);
          toastRemoved(headline, { verb: 'deleted' });
          setConfirmDelete(false);
          navigate('/admin/assets');
        }}
      />
    </SettingsPageShell>
  );
}
