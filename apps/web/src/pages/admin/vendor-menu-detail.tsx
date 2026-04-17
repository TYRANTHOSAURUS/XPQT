import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';
import { useApi } from '@/hooks/use-api';
import { SpaceSelect } from '@/components/space-select';
import { MenuItemsGrid, MenuItemRow } from '@/components/admin/menu-items-grid';
import { MENU_STATUS_VARIANT, MenuStatus, humanize } from '@/lib/menu-constants';
import { ServiceTypeSelect } from '@/components/service-type-select';
import { EditableText, EditableDate } from '@/components/editable-field';

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

  const { data: menu, refetch: refetchMenu, loading: menuLoading } = useApi<Menu>(
    `/catalog-menus/${id}`,
    [id],
  );
  const { data: items, refetch: refetchItems } = useApi<MenuItemRow[]>(
    `/catalog-menus/${id}/items`,
    [id],
  );
  const { data: vendors } = useApi<Vendor[]>('/vendors', []);

  const [duplicateOpen, setDuplicateOpen] = useState(false);

  if (menuLoading && !menu) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading menu...
      </div>
    );
  }
  if (!menu) {
    return (
      <div className="text-center py-20">
        <p className="text-muted-foreground mb-4">Menu not found.</p>
        <Button variant="outline" onClick={() => navigate('/admin/vendor-menus')}>
          Back to menus
        </Button>
      </div>
    );
  }

  const patch = async (body: Partial<Menu>) => {
    try {
      await apiFetch(`/catalog-menus/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      refetchMenu();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate('/admin/vendor-menus')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
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
        <div className="space-y-4 sticky top-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Properties
          </h2>

          <div className="grid gap-1.5">
            <Label className="text-xs">Vendor</Label>
            <Select
              value={menu.vendor_id}
              onValueChange={(v) => v && v !== menu.vendor_id && patch({ vendor_id: v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(vendors ?? []).filter((v) => v.active).map((v) => (
                  <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">Service type</Label>
            <ServiceTypeSelect
              value={menu.service_type}
              onChange={(v) => v && v !== menu.service_type && patch({ service_type: v })}
            />
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs">Building scope</Label>
            <SpaceSelect
              value={menu.space_id ?? ''}
              onChange={(v) => patch({ space_id: v || null })}
              typeFilter={['site', 'building']}
              emptyLabel="All buildings vendor serves"
              placeholder="All buildings vendor serves"
            />
            <p className="text-[11px] text-muted-foreground leading-snug">
              Building-specific menus override the vendor default for that building only.
            </p>
          </div>

          <Separator />

          <div className="grid gap-1.5">
            <Label className="text-xs">Status</Label>
            <Select
              value={menu.status}
              onValueChange={(v) => v && v !== menu.status && patch({ status: v as MenuStatus })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">Effective from</Label>
              <EditableDate
                value={menu.effective_from}
                onCommit={(v) => patch({ effective_from: v })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">Effective until</Label>
              <EditableDate
                value={menu.effective_until ?? ''}
                onCommit={(v) => patch({ effective_until: v || null })}
                placeholder="Open-ended"
              />
            </div>
          </div>

          <Separator />

          <div className="grid gap-1.5">
            <Label className="text-xs">Description</Label>
            <Textarea
              defaultValue={menu.description ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if ((v || null) !== menu.description) patch({ description: v || null });
              }}
              rows={3}
            />
          </div>
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
      toast.success('Menu duplicated');
      onDuplicated(created.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Duplicate failed');
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
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>New menu name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Effective from</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Effective until</Label>
              <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} placeholder="Open-ended" />
            </div>
          </div>
          <Separator />
          <div className="grid gap-1.5">
            <Label>Price adjustment (optional)</Label>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1">
                <Input type="number" step="0.1" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="% change" />
                <span className="text-[11px] text-muted-foreground">e.g. 5 = +5%, -2.5 = -2.5%</span>
              </div>
              <div className="grid gap-1">
                <Input type="number" step="0.01" value={flat} onChange={(e) => setFlat(e.target.value)} placeholder="flat € change" />
                <span className="text-[11px] text-muted-foreground">Applied after %</span>
              </div>
            </div>
          </div>
        </div>
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
