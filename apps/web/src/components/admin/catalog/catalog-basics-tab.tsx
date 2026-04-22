import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { useApi } from '@/hooks/use-api';
import type { ServiceItemDetail } from './catalog-service-sheet';

interface Category { id: string; name: string }

export function CatalogBasicsTab({ detail, onSaved }: { detail: ServiceItemDetail; onSaved: () => void }) {
  const { data: categories } = useApi<Category[]>('/service-catalog/categories', []);

  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description ?? '');
  const [icon, setIcon] = useState(detail.icon ?? '');
  const [kbLink, setKbLink] = useState(detail.kb_link ?? '');
  const [disruption, setDisruption] = useState(detail.disruption_banner ?? '');
  const [searchTerms, setSearchTerms] = useState((detail.search_terms ?? []).join(', '));
  const [active, setActive] = useState(detail.active);
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
    setCategoryIds(detail.categories.map((c) => c.category_id));
  }, [detail.id]);

  const toggleCategory = (id: string) => {
    setCategoryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch(`/admin/service-items/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          icon: icon.trim() || null,
          kb_link: kbLink.trim() || null,
          disruption_banner: disruption.trim() || null,
          search_terms: searchTerms.split(',').map((s) => s.trim()).filter(Boolean),
          active,
        }),
      });
      await apiFetch(`/admin/service-items/${detail.id}/categories`, {
        method: 'PUT',
        body: JSON.stringify({ category_ids: categoryIds }),
      });
      toast.success('Saved');
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <FieldGroup>
        <div className="grid grid-cols-[1fr_auto] gap-3 items-start">
          <Field>
            <FieldLabel htmlFor="basics-name">Name</FieldLabel>
            <Input id="basics-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field orientation="horizontal" className="pt-7">
            <Checkbox id="basics-active" checked={active} onCheckedChange={(v) => setActive(!!v)} />
            <FieldLabel htmlFor="basics-active" className="font-normal whitespace-nowrap">
              Portal-active
            </FieldLabel>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="basics-desc">Description</FieldLabel>
          <Textarea
            id="basics-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-[72px] resize-none"
          />
          <FieldDescription>Shown as the subtitle on the portal card.</FieldDescription>
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
          <FieldDescription>Multiple allowed. The card appears under every selected category.</FieldDescription>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {(categories ?? []).map((c) => {
              const active = categoryIds.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleCategory(c.id)}
                  className={`
                    inline-flex items-center rounded-full px-3 py-1 text-xs font-medium
                    ring-1 transition-all
                    ${active
                      ? 'bg-primary/10 text-primary ring-primary/30 shadow-sm'
                      : 'bg-muted/30 text-muted-foreground ring-border hover:bg-muted/50 hover:text-foreground'
                    }
                  `}
                >
                  {c.name}
                </button>
              );
            })}
            {(!categories || categories.length === 0) && (
              <span className="text-xs text-muted-foreground">No categories configured yet.</span>
            )}
          </div>
        </FieldSet>
      </FieldGroup>

      <div className="flex items-center justify-between pt-2 border-t">
        <Badge variant="outline" className="text-[10px] font-mono">{detail.key}</Badge>
        <Button onClick={save} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
