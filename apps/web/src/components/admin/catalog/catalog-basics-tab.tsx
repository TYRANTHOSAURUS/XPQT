import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import { toastError, toastSaved } from '@/lib/toast';
import { apiFetch } from '@/lib/api';
import { useCatalogCategories } from '@/api/catalog';
import type { RequestTypeDetail } from './catalog-service-panel';

export function CatalogBasicsTab({
  detail,
  onSaved,
  onDelete,
  deleting,
}: {
  detail: RequestTypeDetail;
  onSaved: () => void;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const { data: categories } = useCatalogCategories();

  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description ?? '');
  const [icon, setIcon] = useState(detail.icon ?? '');
  const [kbLink, setKbLink] = useState(detail.kb_link ?? '');
  const [disruption, setDisruption] = useState(detail.disruption_banner ?? '');
  const [searchTerms, setSearchTerms] = useState((detail.search_terms ?? []).join(', '));
  const [active, setActive] = useState(detail.active);
  const [displayOrder, setDisplayOrder] = useState(detail.display_order);
  const [categoryIds, setCategoryIds] = useState<string[]>(detail.categories.map((c) => c.category_id));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(detail.name);
    setDescription(detail.description ?? '');
    setIcon(detail.icon ?? '');
    setKbLink(detail.kb_link ?? '');
    setDisruption(detail.disruption_banner ?? '');
    setSearchTerms((detail.search_terms ?? []).join(', '));
    setActive(detail.active);
    setDisplayOrder(detail.display_order);
    setCategoryIds(detail.categories.map((c) => c.category_id));
  }, [detail.id]);

  const toggleCategory = (id: string) => {
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch(`/request-types/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          icon: icon.trim() || null,
          kb_link: kbLink.trim() || null,
          disruption_banner: disruption.trim() || null,
          keywords: searchTerms.split(',').map((s) => s.trim()).filter(Boolean),
          display_order: Number.isFinite(displayOrder) ? displayOrder : 0,
          active,
        }),
      });
      await apiFetch(`/request-types/${detail.id}/categories`, {
        method: 'PUT',
        body: JSON.stringify({ category_ids: categoryIds }),
      });
      toastSaved('Service basics');
      onSaved();
    } catch (e) {
      toastError("Couldn't save service basics", { error: e, retry: save });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <div className="grid grid-cols-[1fr_180px] gap-3">
          <Field>
            <FieldLabel htmlFor="basics-name">Name</FieldLabel>
            <Input id="basics-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field orientation="horizontal" className="self-end pb-1">
            <Checkbox id="basics-active" checked={active} onCheckedChange={(v) => setActive(!!v)} />
            <FieldLabel htmlFor="basics-active" className="font-normal">
              Active in portal
            </FieldLabel>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="basics-key">Key</FieldLabel>
            <Input id="basics-key" value={detail.key} readOnly disabled className="font-mono text-xs" />
            <FieldDescription>Stable machine key. Created with the request type.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="basics-order">Display order</FieldLabel>
            <Input
              id="basics-order"
              type="number"
              value={displayOrder}
              onChange={(e) => setDisplayOrder(parseInt(e.target.value, 10) || 0)}
            />
            <FieldDescription>Lower numbers appear first on portal cards.</FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="basics-desc">Description</FieldLabel>
          <Textarea
            id="basics-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-[72px]"
          />
          <FieldDescription>Subtitle on the portal card.</FieldDescription>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="basics-icon">Icon</FieldLabel>
            <Input id="basics-icon" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="wrench" />
          </Field>
          <Field>
            <FieldLabel htmlFor="basics-kb">KB link</FieldLabel>
            <Input id="basics-kb" value={kbLink} onChange={(e) => setKbLink(e.target.value)} placeholder="https://…" />
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="basics-disruption">Disruption banner</FieldLabel>
          <Input
            id="basics-disruption"
            value={disruption}
            onChange={(e) => setDisruption(e.target.value)}
            placeholder="Shown inline on the portal card"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="basics-search">Search terms</FieldLabel>
          <Input
            id="basics-search"
            value={searchTerms}
            onChange={(e) => setSearchTerms(e.target.value)}
            placeholder="comma, separated, synonyms"
          />
        </Field>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend>Categories</FieldLegend>
          <FieldDescription>Multiple allowed.</FieldDescription>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {(categories ?? []).map((c) => {
              const on = categoryIds.includes(c.id);
              return (
                <Button
                  key={c.id}
                  type="button"
                  variant={on ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 rounded-full text-xs"
                  onClick={() => toggleCategory(c.id)}
                >
                  {c.name}
                </Button>
              );
            })}
            {(!categories || categories.length === 0) && (
              <span className="text-xs text-muted-foreground">No categories configured yet.</span>
            )}
          </div>
        </FieldSet>
      </FieldGroup>

      <div className="flex items-center justify-between border-t pt-3">
        {onDelete && detail.active ? (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
            disabled={deleting}
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            {deleting ? 'Deleting…' : 'Delete service'}
          </Button>
        ) : <span />}
        <Button onClick={save} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
