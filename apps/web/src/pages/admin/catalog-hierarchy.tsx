import { useState } from 'react';
import {
  CatalogTreeEditor,
  CatalogCategoryNode,
  FlatItem,
} from '@/components/admin/catalog-tree-editor';
import { CatalogServicePanel } from '@/components/admin/catalog/catalog-service-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { Spinner } from '@/components/ui/spinner';

const iconOptions = [
  'Monitor', 'Wrench', 'MapPin', 'Users', 'Utensils', 'ShieldCheck',
  'CalendarDays', 'HelpCircle', 'Package', 'Printer', 'Key', 'Car',
];

interface CategoryFormState {
  id: string | null;
  parentId: string | null;
  name: string;
  description: string;
  icon: string;
}

const emptyForm: CategoryFormState = {
  id: null,
  parentId: null,
  name: '',
  description: '',
  icon: '',
};

export function CatalogHierarchyPage() {
  const { data: tree, loading, refetch } = useApi<CatalogCategoryNode[]>('/service-catalog/tree', []);

  const [form, setForm] = useState<CategoryFormState>(emptyForm);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedRtId, setSelectedRtId] = useState<string | null>(null);

  const openCreate = (parentId: string | null) => {
    setForm({ ...emptyForm, parentId });
    setDialogOpen(true);
  };

  const openEdit = (item: FlatItem) => {
    if (item.kind === 'request_type') {
      setSelectedRtId(item.id);
      return;
    }
    setForm({
      id: item.id,
      parentId: item.parentId,
      name: item.name,
      description: item.description ?? '',
      icon: item.icon ?? '',
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    const body = {
      name: form.name,
      description: form.description || undefined,
      icon: form.icon || undefined,
      parent_category_id: form.parentId ?? undefined,
    };
    try {
      if (form.id) {
        await apiFetch(`/service-catalog/categories/${form.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        toast.success('Category updated');
      } else {
        await apiFetch('/service-catalog/categories', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        toast.success('Category created');
      }
      setDialogOpen(false);
      setForm(emptyForm);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save category');
    }
  };

  const handleDelete = async (item: FlatItem) => {
    if (item.kind === 'request_type') {
      toast.info('Delete request types from the Request Types page.');
      return;
    }
    if (!confirm(`Delete category "${item.name}"? Its children and request types will be unparented.`)) {
      return;
    }
    try {
      await apiFetch(`/service-catalog/categories/${item.id}`, { method: 'DELETE' });
      toast.success('Category deleted');
      if (selectedRtId && !tree) setSelectedRtId(null);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete category');
    }
  };

  const handleCategoryMove = async (
    updates: Array<{ id: string; parent_category_id: string | null; display_order: number }>,
  ) => {
    await apiFetch('/service-catalog/categories/reorder', {
      method: 'POST',
      body: JSON.stringify({ updates }),
    });
    refetch();
  };

  const handleRequestTypeMove = async (
    updates: Array<{ id: string; category_id: string; display_order: number }>,
  ) => {
    await apiFetch('/service-catalog/request-types/move', {
      method: 'POST',
      body: JSON.stringify({ updates }),
    });
    refetch();
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Service Catalog</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Each request type is a service. Click one to configure coverage, audience, form, and fulfillment.
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex gap-4 items-stretch">
        {/* Tree column */}
        <div className="w-[960px] shrink-0 overflow-auto">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          )}
          {!loading && (
            <CatalogTreeEditor
              tree={tree ?? []}
              onCategoryMove={handleCategoryMove}
              onRequestTypeMove={handleRequestTypeMove}
              onEdit={openEdit}
              onDelete={handleDelete}
              onAddChild={openCreate}
              selectedRequestTypeId={selectedRtId}
            />
          )}
        </div>

        {/* Panel column */}
        <div className="flex-1 min-w-0 overflow-auto rounded-lg border bg-card p-4">
          <CatalogServicePanel
            requestTypeId={selectedRtId}
            onSaved={refetch}
            onClose={() => setSelectedRtId(null)}
          />
        </div>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setForm(emptyForm);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit' : 'Create'} Category</DialogTitle>
            <DialogDescription>
              {form.parentId ? 'Nested under the selected parent.' : 'Top-level catalog section.'}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="cat-name">Name</FieldLabel>
              <Input
                id="cat-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. IT Services, Facilities..."
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cat-description">Description</FieldLabel>
              <Textarea
                id="cat-description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Shown under the name in the portal"
                className="h-20 resize-none"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cat-icon">Icon</FieldLabel>
              <Select value={form.icon} onValueChange={(v) => setForm((f) => ({ ...f, icon: v ?? '' }))}>
                <SelectTrigger id="cat-icon"><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {iconOptions.map((i) => (
                    <SelectItem key={i} value={i}>{i}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={!form.name.trim()}>
              {form.id ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
