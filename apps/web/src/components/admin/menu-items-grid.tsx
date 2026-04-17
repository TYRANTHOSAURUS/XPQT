import { useMemo, useState } from 'react';
import { Percent, Trash2, Plus, Clipboard, X, Euro } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  InputGroup, InputGroupAddon, InputGroupInput,
} from '@/components/ui/input-group';
import { apiFetch } from '@/lib/api';
import { UNITS, humanize } from '@/lib/menu-constants';
import { CatalogItemCombobox, CatalogItem } from '@/components/catalog-item-combobox';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EditableNumber } from '@/components/editable-field';

export interface MenuItemRow {
  id: string;
  menu_id: string;
  catalog_item_id: string;
  price: number | string;
  unit: string;
  minimum_quantity: number | null;
  maximum_quantity: number | null;
  lead_time_hours: number | null;
  active: boolean;
  catalog_item?: { id: string; name: string; category: string; subcategory: string | null } | null;
}

interface Props {
  menuId: string;
  items: MenuItemRow[];
  onChange: () => void;
}

export function MenuItemsGrid({ menuId, items, onChange }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPct, setBulkPct] = useState('');
  const [bulkFlat, setBulkFlat] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(items.map((i) => i.id)) : new Set());
  };
  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const updateItem = async (itemId: string, patch: Partial<MenuItemRow>) => {
    try {
      await apiFetch(`/catalog-menus/${menuId}/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update item');
    }
  };

  const removeItem = async (itemId: string) => {
    try {
      await apiFetch(`/catalog-menus/${menuId}/items/${itemId}`, { method: 'DELETE' });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(itemId);
        return next;
      });
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove item');
    }
  };

  const applyBulk = async () => {
    const pct = bulkPct ? Number(bulkPct) : 0;
    const flat = bulkFlat ? Number(bulkFlat) : 0;
    if (!pct && !flat) {
      toast.error('Enter a % or flat amount');
      return;
    }
    try {
      await apiFetch(`/catalog-menus/${menuId}/items/bulk-update`, {
        method: 'POST',
        body: JSON.stringify({
          item_ids: Array.from(selected),
          price_adjustment_percent: pct || null,
          price_adjustment_flat: flat || null,
        }),
      });
      toast.success(`Updated ${selected.size} item${selected.size === 1 ? '' : 's'}`);
      setBulkPct('');
      setBulkFlat('');
      setSelected(new Set());
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk update failed');
    }
  };

  const bulkDelete = async () => {
    if (!selected.size) return;
    try {
      await apiFetch(`/catalog-menus/${menuId}/items/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ item_ids: Array.from(selected) }),
      });
      toast.success(`Removed ${selected.size} item${selected.size === 1 ? '' : 's'}`);
      setSelected(new Set());
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk delete failed');
    }
  };

  const addItem = async (catalogItem: CatalogItem) => {
    try {
      await apiFetch(`/catalog-menus/${menuId}/items`, {
        method: 'POST',
        body: JSON.stringify({
          catalog_item_id: catalogItem.id,
          price: 0,
          unit: catalogItem.unit || 'per_item',
        }),
      });
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add item');
    }
  };

  const existingIds = useMemo(() => items.map((i) => i.catalog_item_id), [items]);

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Items</span>
          <Badge variant="outline">{items.length}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPasteOpen(true)}>
            <Clipboard className="h-4 w-4 mr-1.5" /> Paste from sheet
          </Button>
          <AddItemInline excludeIds={existingIds} onAdd={addItem} />
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-md border bg-muted/40">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <InputGroup className="w-24">
            <InputGroupAddon>
              <Percent className="h-3.5 w-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              type="number"
              step="0.1"
              value={bulkPct}
              onChange={(e) => setBulkPct(e.target.value)}
              placeholder="%"
            />
          </InputGroup>
          <InputGroup className="w-28">
            <InputGroupAddon>
              <Euro className="h-3.5 w-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              type="number"
              step="0.01"
              value={bulkFlat}
              onChange={(e) => setBulkFlat(e.target.value)}
              placeholder="flat"
            />
          </InputGroup>
          <Button size="sm" onClick={applyBulk} disabled={!bulkPct && !bulkFlat}>
            Apply
          </Button>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={() => setConfirmDeleteOpen(true)}>
            <Trash2 className="h-4 w-4 mr-1.5" /> Remove
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Grid — using shadcn Table */}
      <div className="rounded-md border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[36px]">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  onCheckedChange={(v) => toggleAll(v === true)}
                  aria-label="Select all"
                />
              </TableHead>
              <TableHead>Item</TableHead>
              <TableHead className="w-[110px]">Price</TableHead>
              <TableHead className="w-[130px]">Unit</TableHead>
              <TableHead className="w-[110px]">Lead time</TableHead>
              <TableHead className="w-[80px]">Active</TableHead>
              <TableHead className="w-[44px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="text-center py-10 text-sm text-muted-foreground">
                  No items yet. Add one above or paste a list from a spreadsheet.
                </TableCell>
              </TableRow>
            )}
            {items.map((item) => (
              <GridRow
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                onToggle={(v) => toggleOne(item.id, v)}
                onUpdate={(patch) => updateItem(item.id, patch)}
                onRemove={() => removeItem(item.id)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <PasteItemsDialog
        open={pasteOpen}
        onOpenChange={setPasteOpen}
        menuId={menuId}
        existingIds={existingIds}
        onImported={() => {
          setPasteOpen(false);
          onChange();
        }}
      />

      <ConfirmDialog
        open={confirmDeleteOpen}
        onOpenChange={setConfirmDeleteOpen}
        title={`Remove ${selected.size} item${selected.size === 1 ? '' : 's'}?`}
        description="These items will be removed from this menu. Orders that already used them keep their historical pricing."
        confirmLabel="Remove"
        destructive
        onConfirm={bulkDelete}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Row
// -----------------------------------------------------------------------------
function GridRow({
  item,
  selected,
  onToggle,
  onUpdate,
  onRemove,
}: {
  item: MenuItemRow;
  selected: boolean;
  onToggle: (v: boolean) => void;
  onUpdate: (patch: Partial<MenuItemRow>) => void;
  onRemove: () => void;
}) {
  return (
    <TableRow className={selected ? 'bg-accent/30' : undefined}>
      <TableCell>
        <Checkbox checked={selected} onCheckedChange={(v) => onToggle(v === true)} />
      </TableCell>
      <TableCell className="min-w-0 pr-2">
        <div className="font-medium truncate">{item.catalog_item?.name ?? item.catalog_item_id}</div>
        {item.catalog_item?.category && (
          <div className="text-xs text-muted-foreground capitalize">
            {humanize(item.catalog_item.category)}
            {item.catalog_item.subcategory && ` · ${item.catalog_item.subcategory}`}
          </div>
        )}
      </TableCell>
      <TableCell>
        <EditableNumber
          value={item.price}
          onCommit={(n) => n != null && onUpdate({ price: n })}
          className="h-8"
        />
      </TableCell>
      <TableCell>
        <Select value={item.unit} onValueChange={(v) => v && v !== item.unit && onUpdate({ unit: v })}>
          <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {UNITS.map((u) => (
              <SelectItem key={u} value={u} className="capitalize">{humanize(u)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <EditableNumber
          value={item.lead_time_hours}
          onCommit={(n) => onUpdate({ lead_time_hours: n })}
          step="1"
          nullable
          placeholder="hrs"
          className="h-8"
        />
      </TableCell>
      <TableCell>
        <Switch checked={item.active} onCheckedChange={(v) => onUpdate({ active: v })} />
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRemove} aria-label="Remove">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

// -----------------------------------------------------------------------------
// Inline "add item" via combobox — no price field, defaults to 0 so user can fill in the grid
// -----------------------------------------------------------------------------
function AddItemInline({
  excludeIds,
  onAdd,
}: {
  excludeIds: string[];
  onAdd: (item: CatalogItem) => void;
}) {
  const [value, setValue] = useState('');

  return (
    <div className="w-[260px]">
      <CatalogItemCombobox
        value={value}
        excludeIds={excludeIds}
        placeholder="+ Add item..."
        onChange={(_, item) => {
          if (!item) return;
          onAdd(item);
          setValue('');
        }}
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Paste-from-spreadsheet dialog
// Supports TSV or CSV where columns are:  name, price [, unit] [, lead_time_hours]
// -----------------------------------------------------------------------------
function PasteItemsDialog({
  open,
  onOpenChange,
  menuId,
  existingIds,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  menuId: string;
  existingIds: string[];
  onImported: () => void;
}) {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);

  const parsedPreview = useMemo(() => parseRows(raw), [raw]);

  const handleImport = async () => {
    if (!parsedPreview.length) return;
    setBusy(true);
    try {
      const catalogItems = await apiFetch<CatalogItem[]>('/catalog-items');
      const byName = new Map(catalogItems.map((c) => [c.name.toLowerCase(), c]));

      const toCreate: { name: string; row: ParsedRow; catalogItem: CatalogItem }[] = [];
      const skipped: { name: string; reason: string }[] = [];

      for (const row of parsedPreview) {
        const ci = byName.get(row.name.toLowerCase());
        if (!ci) {
          skipped.push({ name: row.name, reason: 'not in catalog' });
          continue;
        }
        if (existingIds.includes(ci.id)) {
          skipped.push({ name: row.name, reason: 'already on menu' });
          continue;
        }
        toCreate.push({ name: row.name, row, catalogItem: ci });
      }

      let created = 0;
      for (const { row, catalogItem } of toCreate) {
        try {
          await apiFetch(`/catalog-menus/${menuId}/items`, {
            method: 'POST',
            body: JSON.stringify({
              catalog_item_id: catalogItem.id,
              price: row.price,
              unit: row.unit ?? catalogItem.unit ?? 'per_item',
              lead_time_hours: row.lead_time ?? null,
            }),
          });
          created++;
        } catch {
          skipped.push({ name: row.name, reason: 'insert failed' });
        }
      }

      if (created) toast.success(`Imported ${created} item${created === 1 ? '' : 's'}`);
      if (skipped.length) {
        toast.warning(
          `Skipped ${skipped.length}: ${skipped.slice(0, 3).map((s) => `${s.name} (${s.reason})`).join(', ')}${skipped.length > 3 ? '…' : ''}`,
        );
      }
      setRaw('');
      onImported();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle>Paste items from spreadsheet</DialogTitle>
          <DialogDescription>
            One item per line. Columns tab- or comma-separated:
            {' '}<code className="text-xs">name</code>,{' '}<code className="text-xs">price</code>,
            {' '}<code className="text-xs">unit</code>{' '}(optional),
            {' '}<code className="text-xs">lead_time_hours</code>{' '}(optional).
            Names are matched against the catalog.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label className="text-xs">Paste here</Label>
          <Textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={6}
            className="font-mono text-xs"
            placeholder={'Can of Cola\t2.50\nCappuccino\t3.75\tper_item\t24\nPastry Box (12 pcs)\t32\tflat_rate\t48'}
          />
          {parsedPreview.length > 0 && (
            <div className="rounded-md border p-2 text-xs">
              <div className="font-medium mb-1">Preview ({parsedPreview.length} rows)</div>
              <div className="max-h-40 overflow-auto">
                {parsedPreview.map((r, i) => (
                  <div key={i} className="grid grid-cols-[1fr_80px_80px_80px] gap-2 py-0.5">
                    <span className="truncate">{r.name}</span>
                    <span className="text-right">{r.price.toFixed(2)}</span>
                    <span className="text-muted-foreground">{r.unit ?? '—'}</span>
                    <span className="text-muted-foreground">{r.lead_time ?? '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleImport} disabled={busy || !parsedPreview.length}>
            <Plus className="h-4 w-4 mr-1.5" /> Import {parsedPreview.length || ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ParsedRow {
  name: string;
  price: number;
  unit?: string;
  lead_time?: number;
}

function parseRows(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\t|,(?=\s*[^,])/).map((p) => p.trim());
    if (parts.length < 2) continue;
    const [name, priceStr, unit, leadStr] = parts;
    const price = Number(priceStr.replace(/[^0-9.\-]/g, ''));
    if (!name || !Number.isFinite(price)) continue;
    rows.push({
      name,
      price,
      unit: unit && UNITS.includes(unit as (typeof UNITS)[number]) ? unit : undefined,
      lead_time: leadStr ? Number(leadStr) || undefined : undefined,
    });
  }
  return rows;
}

