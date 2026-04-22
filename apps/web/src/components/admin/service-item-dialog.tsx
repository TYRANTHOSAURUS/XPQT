import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator, FieldSet, FieldLegend,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { LocationCombobox } from '@/components/location-combobox';

interface FulfillmentType { id: string; name: string; domain: string | null }
interface Category { id: string; name: string }

interface Offering {
  scope_kind: 'tenant' | 'space' | 'space_group';
  space_id?: string | null;
  space_group_id?: string | null;
  inherit_to_descendants?: boolean;
  active?: boolean;
  space?: { id: string; name: string; type: string } | null;
}

interface ServiceItemDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  search_terms: string[] | null;
  kb_link: string | null;
  disruption_banner: string | null;
  on_behalf_policy: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
  fulfillment_type_id: string;
  display_order: number;
  active: boolean;
  categories: Array<{ id: string; category_id: string; display_order: number }>;
  offerings: Array<Offering & { id: string }>;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: string | null;
  onSaved: () => void;
  fulfillmentTypes: FulfillmentType[];
  categories: Category[];
}

const onBehalfOptions: Array<{ value: ServiceItemDetail['on_behalf_policy']; label: string }> = [
  { value: 'self_only', label: 'Self only' },
  { value: 'any_person', label: 'Any person in tenant' },
  { value: 'direct_reports', label: 'Direct reports' },
  { value: 'configured_list', label: 'Configured list (criteria-based)' },
];

export function ServiceItemDialog({
  open, onOpenChange, editingId, onSaved, fulfillmentTypes, categories,
}: Props) {
  const [activeTab, setActiveTab] = useState('portal');
  // Portal-tab state
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [kbLink, setKbLink] = useState('');
  const [disruption, setDisruption] = useState('');
  const [onBehalfPolicy, setOnBehalfPolicy] = useState<ServiceItemDetail['on_behalf_policy']>('self_only');
  const [fulfillmentTypeId, setFulfillmentTypeId] = useState('');
  const [displayOrder, setDisplayOrder] = useState(0);
  const [active, setActive] = useState(true);
  const [searchTermsInput, setSearchTermsInput] = useState('');
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  // Coverage-tab state
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName(''); setKey(''); setDescription(''); setIcon(''); setKbLink(''); setDisruption('');
    setOnBehalfPolicy('self_only'); setFulfillmentTypeId(''); setDisplayOrder(0); setActive(true);
    setSearchTermsInput(''); setCategoryIds([]); setOfferings([]); setActiveTab('portal');
  };

  useEffect(() => {
    if (!open) return;
    if (!editingId) { reset(); return; }
    let cancelled = false;
    (async () => {
      try {
        const item = await apiFetch<ServiceItemDetail>(`/admin/service-items/${editingId}`);
        if (cancelled) return;
        setKey(item.key);
        setName(item.name);
        setDescription(item.description ?? '');
        setIcon(item.icon ?? '');
        setKbLink(item.kb_link ?? '');
        setDisruption(item.disruption_banner ?? '');
        setOnBehalfPolicy(item.on_behalf_policy);
        setFulfillmentTypeId(item.fulfillment_type_id);
        setDisplayOrder(item.display_order);
        setActive(item.active);
        setSearchTermsInput((item.search_terms ?? []).join(', '));
        setCategoryIds((item.categories ?? []).map((c) => c.category_id));
        setOfferings((item.offerings ?? []).map((o) => ({
          scope_kind: o.scope_kind,
          space_id: o.space_id ?? null,
          space_group_id: o.space_group_id ?? null,
          inherit_to_descendants: o.inherit_to_descendants ?? true,
          active: o.active ?? true,
        })));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load');
        onOpenChange(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, editingId, onOpenChange]);

  const addOffering = (kind: 'tenant' | 'space' | 'space_group') => {
    setOfferings((prev) => [...prev, {
      scope_kind: kind,
      space_id: null,
      space_group_id: null,
      inherit_to_descendants: true,
      active: true,
    }]);
  };

  const updateOffering = (i: number, patch: Partial<Offering>) => {
    setOfferings((prev) => prev.map((o, idx) => idx === i ? { ...o, ...patch } : o));
  };

  const removeOffering = (i: number) => {
    setOfferings((prev) => prev.filter((_, idx) => idx !== i));
  };

  const handleSave = async () => {
    if (!name.trim() || !key.trim() || !fulfillmentTypeId) {
      toast.error('Name, key, and fulfillment type are required');
      return;
    }
    setSaving(true);
    try {
      const body = {
        key: key.trim(),
        name: name.trim(),
        description: description.trim() || null,
        icon: icon.trim() || null,
        kb_link: kbLink.trim() || null,
        disruption_banner: disruption.trim() || null,
        on_behalf_policy: onBehalfPolicy,
        fulfillment_type_id: fulfillmentTypeId,
        display_order: displayOrder,
        active,
        search_terms: searchTermsInput.split(',').map((s) => s.trim()).filter(Boolean),
      };

      let savedId: string;
      if (editingId) {
        const res = await apiFetch<{ id: string }>(`/admin/service-items/${editingId}`, {
          method: 'PATCH', body: JSON.stringify(body),
        });
        savedId = res.id;
      } else {
        const res = await apiFetch<{ id: string }>('/admin/service-items', {
          method: 'POST', body: JSON.stringify(body),
        });
        savedId = res.id;
      }

      await apiFetch(`/admin/service-items/${savedId}/categories`, {
        method: 'PUT', body: JSON.stringify({ category_ids: categoryIds }),
      });

      await apiFetch(`/admin/service-items/${savedId}/offerings`, {
        method: 'PUT', body: JSON.stringify({
          offerings: offerings.filter((o) => {
            if (o.scope_kind === 'space') return !!o.space_id;
            if (o.scope_kind === 'space_group') return !!o.space_group_id;
            return true;
          }),
        }),
      });

      toast.success(editingId ? 'Service item saved' : 'Service item created');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleCategory = (id: string) => {
    setCategoryIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle>{editingId ? 'Edit' : 'Create'} Service Item</DialogTitle>
          <DialogDescription>
            Portal-facing card. Define what employees see, where it's offered, and which internal fulfillment handles it.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="portal">Portal</TabsTrigger>
            <TabsTrigger value="coverage">
              Coverage
              {offerings.length > 0 && (
                <Badge variant="outline" className="ml-2 text-[10px]">{offerings.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="fulfillment">Fulfillment</TabsTrigger>
          </TabsList>

          <ScrollArea className="max-h-[60vh] pr-3 mt-3">
            <TabsContent value="portal" className="mt-0">
              <FieldGroup>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="si-name">Name</FieldLabel>
                    <Input id="si-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Fix a broken toilet" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="si-key">Key</FieldLabel>
                    <Input id="si-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="fix-broken-toilet" />
                    <FieldDescription>Stable machine key — URL-safe, unique per tenant.</FieldDescription>
                  </Field>
                </div>

                <Field>
                  <FieldLabel htmlFor="si-desc">Description</FieldLabel>
                  <Textarea id="si-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short subtitle for the portal card" className="min-h-[80px]" />
                </Field>

                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel htmlFor="si-icon">Icon (lucide name)</FieldLabel>
                    <Input id="si-icon" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="wrench" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="si-order">Display order</FieldLabel>
                    <Input id="si-order" type="number" value={displayOrder} onChange={(e) => setDisplayOrder(parseInt(e.target.value, 10) || 0)} />
                  </Field>
                </div>

                <Field>
                  <FieldLabel htmlFor="si-kb">KB link</FieldLabel>
                  <Input id="si-kb" value={kbLink} onChange={(e) => setKbLink(e.target.value)} placeholder="https://kb.company.com/..." />
                </Field>

                <Field>
                  <FieldLabel htmlFor="si-disruption">Disruption banner</FieldLabel>
                  <Input id="si-disruption" value={disruption} onChange={(e) => setDisruption(e.target.value)} placeholder="Shown inline if this service is degraded" />
                </Field>

                <Field>
                  <FieldLabel htmlFor="si-search">Search terms</FieldLabel>
                  <Input id="si-search" value={searchTermsInput} onChange={(e) => setSearchTermsInput(e.target.value)} placeholder="comma, separated, tokens" />
                </Field>

                <FieldSeparator />

                <FieldSet>
                  <FieldLegend>Categories</FieldLegend>
                  <FieldDescription>Where this card appears in the portal catalog. Multiple allowed.</FieldDescription>
                  <div className="flex flex-wrap gap-2">
                    {(categories ?? []).map((c) => (
                      <Badge
                        key={c.id}
                        variant={categoryIds.includes(c.id) ? 'default' : 'outline'}
                        className="cursor-pointer"
                        onClick={() => toggleCategory(c.id)}
                      >
                        {c.name}
                      </Badge>
                    ))}
                    {(!categories || categories.length === 0) && (
                      <span className="text-xs text-muted-foreground">No categories configured.</span>
                    )}
                  </div>
                </FieldSet>

                <Field orientation="horizontal">
                  <Checkbox id="si-active" checked={active} onCheckedChange={(v) => setActive(!!v)} />
                  <FieldLabel htmlFor="si-active" className="font-normal">Active — visible in the portal</FieldLabel>
                </Field>
              </FieldGroup>
            </TabsContent>

            <TabsContent value="coverage" className="mt-0 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Where this service is offered. Multiple offerings combine with OR.
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => addOffering('tenant')}>+ Tenant-wide</Button>
                  <Button size="sm" variant="outline" onClick={() => addOffering('space')}>+ Space</Button>
                </div>
              </div>
              {offerings.length === 0 && (
                <div className="text-center py-6 text-sm text-muted-foreground border border-dashed rounded-md">
                  No coverage configured. This service will not appear in any portal.
                </div>
              )}
              <div className="space-y-2">
                {offerings.map((o, i) => (
                  <div key={i} className="flex items-start gap-2 border rounded-md p-3">
                    <div className="flex-1 space-y-2">
                      <Badge variant="outline" className="capitalize">{o.scope_kind.replace('_', ' ')}</Badge>
                      {o.scope_kind === 'space' && (
                        <LocationCombobox
                          value={o.space_id ?? null}
                          onChange={(v) => updateOffering(i, { space_id: v })}
                          typesFilter={['site', 'building']}
                          placeholder="Pick a site or building…"
                          activeOnly
                        />
                      )}
                      {o.scope_kind === 'space' && (
                        <Field orientation="horizontal">
                          <Checkbox
                            id={`inherit-${i}`}
                            checked={o.inherit_to_descendants ?? true}
                            onCheckedChange={(v) => updateOffering(i, { inherit_to_descendants: !!v })}
                          />
                          <FieldLabel htmlFor={`inherit-${i}`} className="font-normal text-xs">
                            Inherit to descendants (floors/rooms inside)
                          </FieldLabel>
                        </Field>
                      )}
                    </div>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => removeOffering(i)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="fulfillment" className="mt-0">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="si-fulfillment">Fulfillment type</FieldLabel>
                  <Select value={fulfillmentTypeId} onValueChange={(v) => setFulfillmentTypeId(v ?? '')}>
                    <SelectTrigger id="si-fulfillment"><SelectValue placeholder="Pick a fulfillment type…" /></SelectTrigger>
                    <SelectContent>
                      {(fulfillmentTypes ?? []).map((ft) => (
                        <SelectItem key={ft.id} value={ft.id}>
                          {ft.name}{ft.domain ? ` — ${ft.domain}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Drives SLA, workflow, and routing domain. Multiple service items can share a fulfillment type.
                  </FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="si-onbehalf">On-behalf-of policy</FieldLabel>
                  <Select value={onBehalfPolicy} onValueChange={(v) => setOnBehalfPolicy(v as ServiceItemDetail['on_behalf_policy'])}>
                    <SelectTrigger id="si-onbehalf"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {onBehalfOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Who may submit on behalf of another person. "Configured list" requires criteria binding (not yet in this UI).
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </TabsContent>
          </ScrollArea>
        </Tabs>

        <DialogFooter className="mt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim() || !key.trim() || !fulfillmentTypeId}>
            {saving ? 'Saving…' : (editingId ? 'Save' : 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
