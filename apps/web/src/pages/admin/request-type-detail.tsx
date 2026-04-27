import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toastError, toastRemoved } from '@/lib/toast';
import { Trash2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useRequestType,
  useUpsertRequestType,
  requestTypeKeys,
} from '@/api/request-types';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { apiFetch } from '@/lib/api';

export function RequestTypeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: requestType, isLoading } = useRequestType(id);
  const upsert = useUpsertRequestType();

  const del = useMutation<unknown, Error, string>({
    mutationFn: (rtId) => apiFetch(`/request-types/${rtId}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: requestTypeKeys.all }),
  });

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [active, setActive] = useState(true);
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [requiresAsset, setRequiresAsset] = useState(false);
  const [requiresLocation, setRequiresLocation] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const rtId = requestType?.id;
  useEffect(() => {
    if (!requestType) return;
    setName(requestType.name ?? '');
    setDomain(requestType.domain ?? '');
    setActive(requestType.active ?? true);
    setRequiresApproval(requestType.requires_approval ?? false);
    setRequiresAsset(requestType.requires_asset ?? requestType.asset_required ?? false);
    setRequiresLocation(requestType.requires_location ?? requestType.location_required ?? false);
  }, [rtId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (patch: Partial<Parameters<typeof upsert.mutate>[0]['payload']>) => {
    if (!requestType) return;
    upsert.mutate({
      id: requestType.id,
      payload: { name: requestType.name, domain: requestType.domain, ...patch },
    });
  };

  useEffect(() => {
    if (upsert.error) {
      toastError("Couldn't save request type", { error: upsert.error });
    }
  }, [upsert.error]);

  useDebouncedSave(name, (v) => {
    if (!requestType || v === requestType.name) return;
    upsert.mutate({
      id: requestType.id,
      payload: { name: v, domain: requestType.domain },
    });
  });
  useDebouncedSave(domain, (v) => {
    if (!requestType || v === (requestType.domain ?? '')) return;
    upsert.mutate({
      id: requestType.id,
      payload: { name: requestType.name, domain: v || null },
    });
  });

  const headline = useMemo(() => requestType?.name ?? 'Loading…', [requestType]);

  if (!id) return null;

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/request-types"
          title="Loading…"
          description="Fetching request type details"
        />
      </SettingsPageShell>
    );
  }

  if (!requestType) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/request-types"
          title="Not found"
          description={`No request type with id ${id} in this tenant.`}
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/request-types"
        title={headline}
        description={`Domain: ${requestType.domain ?? '—'}`}
        actions={
          <Badge variant={active ? 'default' : 'outline'} className="text-[10px] uppercase tracking-wider">
            {active ? 'Active' : 'Inactive'}
          </Badge>
        }
      />

      <SettingsGroup title="Identity">
        <SettingsRow label="Name">
          <SettingsRowValue>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 w-72"
              aria-label="Request type name"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Domain" description="e.g. fm, it, av, security, catering.">
          <SettingsRowValue>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="h-8 w-48 font-mono"
              aria-label="Domain"
            />
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

      <SettingsGroup title="Requirements" description="What requesters must provide on submit.">
        <SettingsRow label="Requires asset" description="Submitter must pick an asset.">
          <SettingsRowValue>
            <Switch
              checked={requiresAsset}
              onCheckedChange={(v) => {
                setRequiresAsset(v);
                save({ requires_asset: v, asset_required: v });
              }}
              aria-label="Requires asset"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Requires location" description="Submitter must pick a location.">
          <SettingsRowValue>
            <Switch
              checked={requiresLocation}
              onCheckedChange={(v) => {
                setRequiresLocation(v);
                save({ requires_location: v, location_required: v });
              }}
              aria-label="Requires location"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Requires approval" description="Adds an approval gate before fulfillment.">
          <SettingsRowValue>
            <Switch
              checked={requiresApproval}
              onCheckedChange={(v) => {
                setRequiresApproval(v);
                save({ requires_approval: v });
              }}
              aria-label="Requires approval"
            />
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Advanced"
        description="Form schema variants, routing rules, and SLA bindings live in the dedicated UIs (Catalog, Routing Studio, SLA Policies)."
      >
        <SettingsRow label="Catalog hierarchy">
          <SettingsRowValue>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/admin/catalog-hierarchy')}
            >
              Open catalog →
            </Button>
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Routing rules">
          <SettingsRowValue>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(`/admin/routing-studio?request_type=${requestType.id}`)}
            >
              Open routing →
            </Button>
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label="Delete request type"
          description="Existing tickets keep their reference but no new submissions will route through this type."
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
        description="This cannot be undone. Tickets that referenced this type keep their historical link but can no longer be created under it."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await del.mutateAsync(requestType.id);
          toastRemoved(headline, { verb: 'deleted' });
          setConfirmDelete(false);
          navigate('/admin/request-types');
        }}
      />
    </SettingsPageShell>
  );
}
