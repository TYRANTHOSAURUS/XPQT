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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { VendorFulfillmentSection } from '@/components/admin/vendor-fulfillment-section';
import {
  useVendor,
  useUpsertVendor,
  useDeleteVendor,
} from '@/api/vendors';
import { useTeams } from '@/api/teams';
import { useDebouncedSave } from '@/hooks/use-debounced-save';

export function VendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: vendor, isLoading } = useVendor(id);
  const { data: teams } = useTeams();
  const upsert = useUpsertVendor();
  const del = useDeleteVendor();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  const [owningTeamId, setOwningTeamId] = useState<string | null>(null);
  const [active, setActive] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const vendorId = vendor?.id;
  useEffect(() => {
    if (!vendor) return;
    setName(vendor.name ?? '');
    setEmail(vendor.contact_email ?? '');
    setPhone(vendor.contact_phone ?? '');
    setWebsite(vendor.website ?? '');
    setNotes(vendor.notes ?? '');
    setOwningTeamId(vendor.owning_team_id ?? null);
    setActive(vendor.active ?? true);
  }, [vendorId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (payload: Partial<NonNullable<Parameters<typeof upsert.mutate>[0]['payload']>>) => {
    if (!vendor) return;
    upsert.mutate({ id: vendor.id, payload: { name: vendor.name, ...payload } });
  };

  useEffect(() => {
    if (upsert.error) {
      toastError("Couldn't save vendor", { error: upsert.error });
    }
  }, [upsert.error]);

  useDebouncedSave(name, (v) => {
    if (!vendor || v === vendor.name) return;
    upsert.mutate({ id: vendor.id, payload: { name: v } });
  });
  useDebouncedSave(email, (v) => {
    if (!vendor || v === (vendor.contact_email ?? '')) return;
    save({ contact_email: v || null });
  });
  useDebouncedSave(phone, (v) => {
    if (!vendor || v === (vendor.contact_phone ?? '')) return;
    save({ contact_phone: v || null });
  });
  useDebouncedSave(website, (v) => {
    if (!vendor || v === (vendor.website ?? '')) return;
    save({ website: v || null });
  });
  useDebouncedSave(notes, (v) => {
    if (!vendor || v === (vendor.notes ?? '')) return;
    save({ notes: v || null });
  });

  const headline = useMemo(() => vendor?.name ?? 'Loading…', [vendor]);

  if (!id) return null;

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader backTo="/admin/vendors" title="Loading…" description="Fetching vendor details" />
      </SettingsPageShell>
    );
  }

  if (!vendor) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/vendors"
          title="Not found"
          description={`No vendor with id ${id} in this tenant.`}
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/vendors"
        title={headline}
        description={vendor.contact_email ?? 'External supplier that receives dispatched work.'}
        actions={
          <Badge variant={active ? 'default' : 'outline'} className="text-[10px] uppercase tracking-wider">
            {active ? 'Active' : 'Inactive'}
          </Badge>
        }
      />

      <SettingsGroup title="Identity" description="Display name and contact channels.">
        <SettingsRow label="Name">
          <SettingsRowValue>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-72" aria-label="Vendor name" />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Contact email">
          <SettingsRowValue>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-8 w-72"
              aria-label="Contact email"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Contact phone">
          <SettingsRowValue>
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="h-8 w-56"
              aria-label="Contact phone"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow label="Website">
          <SettingsRowValue>
            <Input
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="h-8 w-80"
              placeholder="https://…"
              aria-label="Website"
            />
          </SettingsRowValue>
        </SettingsRow>
        <SettingsRow
          label="Owning team"
          description="Internal team that runs the vendor relationship."
        >
          <SettingsRowValue>
            <Select
              value={owningTeamId ?? '__none__'}
              onValueChange={(v) => {
                const next = v === '__none__' ? null : v;
                setOwningTeamId(next);
                save({ owning_team_id: next });
              }}
            >
              <SelectTrigger className="h-8 w-56">
                <SelectValue placeholder="Pick a team…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No owner</SelectItem>
                {(teams ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
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

      <SettingsGroup title="Notes" description="Internal context for the relationship.">
        <div className="px-4 py-3">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="Service tier, escalation contact, contract dates…"
            aria-label="Vendor notes"
          />
        </div>
      </SettingsGroup>

      <VendorFulfillmentSection vendor={vendor} />

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label="Delete vendor"
          description="Removes this vendor record. Tickets and assets that referenced it keep their historical link."
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
        description="This cannot be undone. Existing dispatch records keep their reference but the vendor row is removed."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await del.mutateAsync(vendor.id);
          toastRemoved(headline, { verb: 'deleted' });
          setConfirmDelete(false);
          navigate('/admin/vendors');
        }}
      />
    </SettingsPageShell>
  );
}
