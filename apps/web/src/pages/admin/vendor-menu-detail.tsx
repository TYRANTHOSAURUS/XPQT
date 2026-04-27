import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Copy } from 'lucide-react';
import { toastError, toastSuccess } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';
import { useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { useVendors } from '@/api/vendors';
import { SpaceSelect } from '@/components/space-select';
import { MenuItemsGrid, MenuItemRow } from '@/components/admin/menu-items-grid';
import { MENU_STATUS_VARIANT, MenuStatus, humanize } from '@/lib/menu-constants';
import { ServiceTypeSelect } from '@/components/service-type-select';
import { EditableText, EditableDate } from '@/components/editable-field';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

interface Vendor { id: string; name: string; active: boolean }
interface Menu {
  id: string;
  vendor_id: string;
  space_id: string | null;
  service_type: string;
  name: string;
  description: string | null;
  effective_from: string;
  effective_until: string | null;
  status: MenuStatus;
  vendor?: { id: string; name: string } | null;
  space?: { id: string; name: string } | null;
}

export function VendorMenuDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const qc = useQueryClient();
  const { data: menu, isPending: menuLoading } = useQuery(queryOptions({
    queryKey: ['catalog-menus', 'detail', id] as const,
    queryFn: ({ signal }) => apiFetch<Menu>(`/catalog-menus/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  }));
  const refetchMenu = () => qc.invalidateQueries({ queryKey: ['catalog-menus', 'detail', id] });
  const { data: items } = useQuery(queryOptions({
    queryKey: ['catalog-menus', 'items', id] as const,
    queryFn: ({ signal }) => apiFetch<MenuItemRow[]>(`/catalog-menus/${id}/items`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  }));
  const refetchItems = () => qc.invalidateQueries({ queryKey: ['catalog-menus', 'items', id] });
  const { data: vendors } = useVendors() as { data: Vendor[] | undefined };

  const [duplicateOpen, setDuplicateOpen] = useState(false);

  if (menuLoading && !menu) {
    return (
      <div>
        <Skeleton className="h-5 w-48 mb-4" />
        <div className="flex items-center gap-3 mb-6">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="ml-auto h-8 w-24" />
        </div>
        <div className="grid grid-cols-[320px_1fr] gap-6 items-start">
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }
  if (!menu) {
    return (
      <EmptyState
        size="hero"
        title="Menu not found"
        description="This menu may have been deleted or you don't have access to it."
        action={
          <Button variant="outline" onClick={() => navigate('/admin/vendor-menus')}>
            Back to menus
          </Button>
        }
      />
    );
  }

  const patch = async (body: Partial<Menu>) => {
    try {
      await apiFetch(`/catalog-menus/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      refetchMenu();
    } catch (err) {
      toastError("Couldn't save menu", { error: err, retry: () => patch(body) });
    }
  };

  return (
    <div>
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/admin/vendor-menus" />}>Vendor Menus</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{menu.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="flex-1 min-w-0">
          <EditableText
            value={menu.name}
            variant="title"
            required
            onCommit={(v) => patch({ name: v })}
          />
          <div className="flex items-center gap-2 mt-1">
            <Badge variant={MENU_STATUS_VARIANT[menu.status]} className="capitalize">
              {menu.status}
            </Badge>
            {menu.vendor && (
              <span className="text-sm text-muted-foreground">· {menu.vendor.name}</span>
            )}
            <Badge variant="outline" className="capitalize">
              {humanize(menu.service_type)}
            </Badge>
          </div>
        </div>
        <Button variant="outline" onClick={() => setDuplicateOpen(true)}>
          <Copy className="h-4 w-4 mr-1.5" /> Duplicate
        </Button>
      </div>

      <div className="grid grid-cols-[320px_1fr] gap-6 items-start">
        {/* Metadata panel */}
        <div className="sticky top-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
            Properties
          </h2>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="menu-vendor" className="text-xs">Vendor</FieldLabel>
              <Select
                value={menu.vendor_id}
                onValueChange={(v) => v && v !== menu.vendor_id && patch({ vendor_id: v })}
              >
                <SelectTrigger id="menu-vendor"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(vendors ?? []).filter((v) => v.active).map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="menu-service-type" className="text-xs">Service type</FieldLabel>
              <ServiceTypeSelect
                value={menu.service_type}
                onChange={(v) => v && v !== menu.service_type && patch({ service_type: v })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="menu-building-scope" className="text-xs">Building scope</FieldLabel>
              <SpaceSelect
                value={menu.space_id ?? ''}
                onChange={(v) => patch({ space_id: v || null })}
                typeFilter={['site', 'building']}
                emptyLabel="All buildings vendor serves"
                placeholder="All buildings vendor serves"
              />
              <FieldDescription>
                Building-specific menus override the vendor default for that building only.
              </FieldDescription>
            </Field>

            <FieldSeparator />

            <Field>
              <FieldLabel htmlFor="menu-status" className="text-xs">Status</FieldLabel>
              <Select
                value={menu.status}
                onValueChange={(v) => v && v !== menu.status && patch({ status: v as MenuStatus })}
              >
                <SelectTrigger id="menu-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="menu-effective-from" className="text-xs">Effective from</FieldLabel>
                <EditableDate
                  value={menu.effective_from}
                  onCommit={(v) => patch({ effective_from: v })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="menu-effective-until" className="text-xs">Effective until</FieldLabel>
                <EditableDate
                  value={menu.effective_until ?? ''}
                  onCommit={(v) => patch({ effective_until: v || null })}
                  placeholder="Open-ended"
                />
              </Field>
            </div>

            <FieldSeparator />

            <Field>
              <FieldLabel htmlFor="menu-description" className="text-xs">Description</FieldLabel>
              <Textarea
                id="menu-description"
                defaultValue={menu.description ?? ''}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if ((v || null) !== menu.description) patch({ description: v || null });
                }}
                rows={3}
              />
            </Field>
          </FieldGroup>
        </div>

        {/* Items grid */}
        <div className="min-w-0">
          <MenuItemsGrid
            menuId={menu.id}
            items={items ?? []}
            onChange={refetchItems}
          />
        </div>
      </div>

      <DuplicateMenuDialog
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
        menu={menu}
        onDuplicated={(newId) => {
          setDuplicateOpen(false);
          navigate(`/admin/vendor-menus/${newId}`);
        }}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Duplicate dialog — creates a new menu with optional price adjustment
// -----------------------------------------------------------------------------
function DuplicateMenuDialog({
  open,
  onOpenChange,
  menu,
  onDuplicated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  menu: Menu;
  onDuplicated: (newId: string) => void;
}) {
  const [name, setName] = useState(`${menu.name} (copy)`);
  const [from, setFrom] = useState(() => {
    // Default to one year after source effective_from, as a seasonal-rollover hint
    const d = new Date(menu.effective_from);
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [until, setUntil] = useState(() => {
    if (!menu.effective_until) return '';
    const d = new Date(menu.effective_until);
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  });
  const [pct, setPct] = useState('');
  const [flat, setFlat] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName(`${menu.name} (copy)`);
      setPct('');
      setFlat('');
    }
  }, [open, menu.id, menu.name]);

  const submit = async () => {
    if (!from) return;
    setBusy(true);
    try {
      const created = await apiFetch<{ id: string }>(`/catalog-menus/${menu.id}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          effective_from: from,
          effective_until: until || null,
          price_adjustment_percent: pct ? Number(pct) : null,
          price_adjustment_flat: flat ? Number(flat) : null,
          status: 'draft',
        }),
      });
      toastSuccess('Menu duplicated', {
        action: { label: 'Open', onClick: () => onDuplicated(created.id) },
      });
      onDuplicated(created.id);
    } catch (err) {
      toastError("Couldn't duplicate menu", { error: err });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate menu</DialogTitle>
          <DialogDescription>
            Creates a new draft menu with the same vendor, building, service type, and items.
            Optional price adjustment applies to every copied item.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="dup-menu-name">New menu name</FieldLabel>
            <Input id="dup-menu-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="dup-menu-from">Effective from</FieldLabel>
              <Input
                id="dup-menu-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="dup-menu-until">Effective until</FieldLabel>
              <Input
                id="dup-menu-until"
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                placeholder="Open-ended"
              />
            </Field>
          </div>

          <FieldSeparator />

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="dup-menu-pct">Price adjustment %</FieldLabel>
              <Input
                id="dup-menu-pct"
                type="number"
                step="0.1"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                placeholder="% change"
              />
              <FieldDescription>e.g. 5 = +5%, -2.5 = -2.5%</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="dup-menu-flat">Flat price adjustment</FieldLabel>
              <Input
                id="dup-menu-flat"
                type="number"
                step="0.01"
                value={flat}
                onChange={(e) => setFlat(e.target.value)}
                placeholder="flat € change"
              />
              <FieldDescription>Applied after %</FieldDescription>
            </Field>
          </div>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !from}>
            <Copy className="h-4 w-4 mr-1.5" /> Create copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
