import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
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
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import { CatalogItemCombobox } from '@/components/catalog-item-combobox';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import {
  useBundleTemplate,
  useDeleteBundleTemplate,
  useUpdateBundleTemplate,
} from '@/api/bundle-templates';
import type { BundleTemplatePayload } from '@/api/bundle-templates';
import { useCostCenters } from '@/api/cost-centers';
import { toastError, toastRemoved } from '@/lib/toast';

interface ServiceLineDraft {
  catalog_item_id: string;
  quantity?: number;
  quantity_per_attendee?: number;
  service_window_offset_minutes?: number;
  menu_id?: string | null;
}

/**
 * /admin/bundle-templates/:id — auto-saving detail page.
 *
 * Sections:
 *   - Identity: name, description, active
 *   - Defaults: duration in minutes, default cost center
 *   - Services: list editor — add/remove rows with catalog_item + quantity
 *     + per-attendee + offset minutes
 *   - Danger zone: delete
 *
 * The payload jsonb is rebuilt and persisted whenever any of these change.
 * Text inputs debounce; selects + switches save on change.
 */
export function BundleTemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useBundleTemplate(id ?? '');
  const update = useUpdateBundleTemplate();
  const remove = useDeleteBundleTemplate();
  const { data: costCenters } = useCostCenters({ active: true });

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Local state — re-seeded from server on row change.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [defaultDuration, setDefaultDuration] = useState<string>('');
  const [services, setServices] = useState<ServiceLineDraft[]>([]);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setDescription(data.description ?? '');
    setDefaultDuration(
      data.payload?.default_duration_minutes != null
        ? String(data.payload.default_duration_minutes)
        : '',
    );
    setServices(
      (data.payload?.services ?? []).map((s) => ({
        catalog_item_id: s.catalog_item_id,
        quantity: s.quantity,
        quantity_per_attendee: s.quantity_per_attendee,
        service_window_offset_minutes: s.service_window_offset_minutes,
        menu_id: s.menu_id ?? null,
      })),
    );
  }, [data?.id, data?.name, data?.description, data?.payload]);

  const persist = (
    patch: {
      name?: string;
      description?: string | null;
      active?: boolean;
      payload?: BundleTemplatePayload;
    },
  ) => {
    if (!id) return;
    update.mutate(
      { id, patch },
      {
        onError: (err: unknown) => {
          toastError("Couldn't save template", { error: err });
        },
      },
    );
  };

  const persistPayload = (next: Partial<BundleTemplatePayload>) => {
    if (!data) return;
    persist({
      payload: {
        ...(data.payload ?? {}),
        ...next,
      },
    });
  };

  // Text-input debounce
  useDebouncedSave(name, (next) => {
    if (data && next !== data.name && next.trim().length > 0) persist({ name: next.trim() });
  });
  useDebouncedSave(description, (next) => {
    if (!data) return;
    const normalised = next.trim() || null;
    if (normalised !== (data.description ?? null)) persist({ description: normalised });
  });
  useDebouncedSave(defaultDuration, (next) => {
    if (!data) return;
    const parsed = next.trim().length > 0 ? Math.max(0, Math.floor(Number(next))) : undefined;
    const current = data.payload?.default_duration_minutes;
    if (parsed === current) return;
    persistPayload({ default_duration_minutes: parsed });
  });

  if (isLoading) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader backTo="/admin/bundle-templates" title="Loading…" />
      </SettingsPageShell>
    );
  }

  if (!data) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader
          backTo="/admin/bundle-templates"
          title="Not found"
          description="This template may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  const updateService = (idx: number, patch: Partial<ServiceLineDraft>) => {
    const next = services.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    setServices(next);
    persistPayload({ services: next.filter((s) => s.catalog_item_id) });
  };
  const addService = () => {
    const next = [...services, { catalog_item_id: '', quantity: 1 }];
    setServices(next);
    // Don't persist yet — wait until catalog_item_id is picked.
  };
  const removeService = (idx: number) => {
    const next = services.filter((_, i) => i !== idx);
    setServices(next);
    persistPayload({ services: next });
  };

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin/bundle-templates"
        title={data.name}
        description={data.description ?? 'Bundle template'}
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
        <SettingsRow label="Name" description="Shown to users as the chip label.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 max-w-xs"
          />
        </SettingsRow>
        <SettingsRow label="Description" description="Subtext under the chip; optional.">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="—"
            className="h-8 max-w-md"
          />
        </SettingsRow>
        <SettingsRow
          label="Active"
          description="Inactive templates stay assignable to existing bundles but disappear from the chip row."
        >
          <Switch
            checked={data.active}
            onCheckedChange={(checked) => persist({ active: checked })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Defaults">
        <SettingsRow
          label="Default duration"
          description="Pre-fills the meeting window. Leave empty to use the picker default."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              step={15}
              value={defaultDuration}
              onChange={(e) => setDefaultDuration(e.target.value)}
              className="h-8 w-20 text-center tabular-nums"
            />
            <span className="text-xs text-muted-foreground">minutes</span>
          </div>
        </SettingsRow>
        <SettingsRow
          label="Default cost center"
          description="Bundle inherits this when the requester picks the template; user can change it."
        >
          <SettingsRowValue>
            <Select
              value={data.payload?.default_cost_center_id ?? '__none__'}
              onValueChange={(value) =>
                persistPayload({
                  default_cost_center_id: value === '__none__' ? null : value,
                })
              }
            >
              <SelectTrigger className="h-8 w-[240px]">
                <SelectValue placeholder="No default cost center" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No default</SelectItem>
                {(costCenters ?? []).map((cc) => (
                  <SelectItem key={cc.id} value={cc.id}>
                    <span className="font-mono text-xs tabular-nums">{cc.code}</span>
                    <span className="ml-2 text-muted-foreground">{cc.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRowValue>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title="Services"
        description="Service lines pre-filled when the template is picked. Window offset is signed minutes from start_at (negative = before)."
      >
        <div className="px-4 py-3 space-y-2">
          {services.length === 0 ? (
            <p className="text-xs text-muted-foreground">No services. Add a line below.</p>
          ) : (
            <ul className="space-y-2">
              {services.map((line, idx) => (
                <li
                  key={idx}
                  className="flex items-center gap-2 rounded-md border bg-background px-2 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <CatalogItemCombobox
                      value={line.catalog_item_id}
                      onChange={(catalogItemId) =>
                        updateService(idx, { catalog_item_id: catalogItemId })
                      }
                      placeholder="Pick item…"
                    />
                  </div>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="qty"
                    aria-label="Quantity"
                    value={line.quantity ?? ''}
                    onChange={(e) =>
                      updateService(idx, {
                        quantity: e.target.value ? Math.max(0, Math.floor(Number(e.target.value))) : undefined,
                      })
                    }
                    className="h-8 w-16 text-center tabular-nums"
                  />
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="per attendee"
                    aria-label="Per-attendee multiplier"
                    value={line.quantity_per_attendee ?? ''}
                    onChange={(e) =>
                      updateService(idx, {
                        quantity_per_attendee: e.target.value
                          ? Math.max(0, Math.floor(Number(e.target.value)))
                          : undefined,
                      })
                    }
                    className="h-8 w-24 text-center tabular-nums"
                  />
                  <Input
                    type="number"
                    step={5}
                    placeholder="offset min"
                    aria-label="Service-window offset in minutes"
                    value={line.service_window_offset_minutes ?? ''}
                    onChange={(e) =>
                      updateService(idx, {
                        service_window_offset_minutes:
                          e.target.value === '' ? undefined : Math.floor(Number(e.target.value)),
                      })
                    }
                    className="h-8 w-24 text-center tabular-nums"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => removeService(idx)}
                    aria-label="Remove line"
                  >
                    <X className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="outline" size="sm" onClick={addService} className="gap-1.5">
              <Plus className="size-3.5" /> Add service line
            </Button>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Danger zone">
        <SettingsRow
          label="Delete template"
          description="Existing bundles keep their template_id reference (resolved as null in reports). This cannot be undone."
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
        title={`Delete bundle template "${data.name}"?`}
        description="The chip will disappear from the room picker. Existing bundles using this template stay alive but lose the back-reference."
        confirmLabel="Delete template"
        destructive
        onConfirm={async () => {
          if (!id) return;
          try {
            await remove.mutateAsync(id);
            toastRemoved('Bundle template');
            navigate('/admin/bundle-templates');
          } catch (err) {
            toastError("Couldn't delete bundle template", { error: err });
          }
        }}
      />
    </SettingsPageShell>
  );
}
