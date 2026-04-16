import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil, ChevronUp, ChevronDown } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface ServiceCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  display_order: number;
  parent_category_id: string | null;
  active: boolean;
}

const iconOptions = [
  'Monitor',
  'Wrench',
  'MapPin',
  'Users',
  'Utensils',
  'ShieldCheck',
  'CalendarDays',
  'HelpCircle',
  'Package',
  'Printer',
  'Key',
  'Car',
];

export function CatalogCategoriesPage() {
  const { data, loading, refetch } = useApi<ServiceCategory[]>('/service-catalog/categories', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [displayOrder, setDisplayOrder] = useState('0');
  const [parentId, setParentId] = useState('');

  const resetForm = () => {
    setEditId(null);
    setName('');
    setDescription('');
    setIcon('');
    setDisplayOrder('0');
    setParentId('');
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = {
      name,
      description: description || undefined,
      icon: icon || undefined,
      display_order: parseInt(displayOrder) || 0,
      parent_category_id: parentId || undefined,
    };
    if (editId) {
      await apiFetch(`/service-catalog/categories/${editId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await apiFetch('/service-catalog/categories', { method: 'POST', body: JSON.stringify(body) });
    }
    resetForm();
    setDialogOpen(false);
    refetch();
  };

  const openEdit = (cat: ServiceCategory) => {
    setEditId(cat.id);
    setName(cat.name);
    setDescription(cat.description ?? '');
    setIcon(cat.icon ?? '');
    setDisplayOrder(String(cat.display_order));
    setParentId(cat.parent_category_id ?? '');
    setDialogOpen(true);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const reorder = async (cat: ServiceCategory, dir: -1 | 1) => {
    const sorted = [...(data ?? [])].sort((a, b) => a.display_order - b.display_order);
    const idx = sorted.findIndex((c) => c.id === cat.id);
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    // Swap the items in the array
    const reordered = [...sorted];
    [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];

    // Reassign display_order sequentially to avoid duplicates
    const updates = reordered
      .map((c, i) => ({ id: c.id, display_order: i }))
      .filter((u) => {
        const original = sorted.find((c) => c.id === u.id);
        return original && original.display_order !== u.display_order;
      });

    await Promise.all(
      updates.map((u) =>
        apiFetch(`/service-catalog/categories/${u.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ display_order: u.display_order }),
        }),
      ),
    );
    refetch();
  };

  const sortedData = [...(data ?? [])].sort((a, b) => a.display_order - b.display_order);
  const parentOptions = (data ?? []).filter((c) => !c.parent_category_id && c.id !== editId);

  const getParentName = (id: string | null) => {
    if (!id || !data) return '—';
    return data.find((c) => c.id === id)?.name ?? '—';
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Catalog Categories</h1>
          <p className="text-muted-foreground mt-1">Organize request types into service catalog sections</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Category
          </DialogTrigger>
          <DialogContent className="sm:max-w-[480px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Category</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IT Services, Facilities, HR..." />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description shown in the portal..."
                  className="h-20 resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Icon</Label>
                  <Select value={icon} onValueChange={(v) => setIcon(v ?? '')}>
                    <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">None</SelectItem>
                      {iconOptions.map((i) => (
                        <SelectItem key={i} value={i}>{i}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Display Order</Label>
                  <Input type="number" value={displayOrder} onChange={(e) => setDisplayOrder(e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label>Parent Category</Label>
                <Select value={parentId} onValueChange={(v) => setParentId(v ?? '')}>
                  <SelectTrigger><SelectValue placeholder="None (top level)" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None (top level)</SelectItem>
                    {parentOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={!name.trim()}>
                  {editId ? 'Save' : 'Create'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[50px]">Order</TableHead>
            <TableHead>Name</TableHead>
            <TableHead className="w-[100px]">Icon</TableHead>
            <TableHead className="w-[160px]">Parent</TableHead>
            <TableHead className="w-[80px]">Status</TableHead>
            <TableHead className="w-[100px]">Reorder</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && sortedData.length === 0 && (
            <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">No categories yet.</TableCell></TableRow>
          )}
          {sortedData.map((cat, idx) => (
            <TableRow key={cat.id}>
              <TableCell className="text-muted-foreground text-sm font-mono">{cat.display_order}</TableCell>
              <TableCell>
                <div>
                  <p className="font-medium">{cat.name}</p>
                  {cat.description && <p className="text-xs text-muted-foreground truncate max-w-[240px]">{cat.description}</p>}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{cat.icon ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{getParentName(cat.parent_category_id)}</TableCell>
              <TableCell><Badge variant={cat.active ? 'default' : 'secondary'}>{cat.active ? 'Active' : 'Inactive'}</Badge></TableCell>
              <TableCell>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => reorder(cat, -1)} disabled={idx === 0}>
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => reorder(cat, 1)} disabled={idx === sortedData.length - 1}>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(cat)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
