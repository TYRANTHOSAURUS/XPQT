import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useServiceRuleTemplates,
  useCreateServiceRuleFromTemplate,
  type ServiceRuleTemplate,
  type ServiceRuleTargetKind,
} from '@/api/service-rules';
import { ServiceRuleTemplateGrid } from './service-rule-template-grid';
import {
  ServiceRuleTemplateParamsForm,
  type TemplateParamValues,
} from './service-rule-template-params-form';
import { toastCreated, toastError } from '@/lib/toast';

const TARGET_KIND_OPTIONS: Array<{ value: ServiceRuleTargetKind; label: string; help: string }> = [
  { value: 'tenant',           label: 'Tenant-wide',  help: 'Applies to every order in this tenant.' },
  { value: 'menu',             label: 'Specific menu', help: 'Applies only when the order is from a particular menu.' },
  { value: 'catalog_item',     label: 'Specific item', help: 'Applies only when a particular catalog item is ordered.' },
  { value: 'catalog_category', label: 'Item category', help: 'Applies to every item in a category (e.g. "premium catering").' },
];

export interface ServiceRuleTemplateDialogProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Called with the created rule's id so the caller can navigate. */
  onCreated?: (ruleId: string) => void;
}

/**
 * Sprint 1B — template-driven create dialog. Two-pane layout:
 *  - Left:  template grid (7 starters from migration 00149).
 *  - Right: per-template parameter form + scope picker + custom name.
 *
 * Submit calls POST /admin/booking-services/rules/from-template which
 * compiles the template's `applies_when_template` against the supplied
 * params, applies effect_default + approval_config_template, and inserts.
 *
 * Replaces the prior "set template's raw applies_when as starting point
 * and let the admin edit JSON manually" UX which left placeholders
 * unresolved on save.
 */
export function ServiceRuleTemplateDialog({
  open,
  onOpenChange,
  onCreated,
}: ServiceRuleTemplateDialogProps) {
  const { data: templates } = useServiceRuleTemplates();
  const create = useCreateServiceRuleFromTemplate();

  const [chosen, setChosen] = useState<ServiceRuleTemplate | null>(null);
  const [params, setParams] = useState<TemplateParamValues>({});
  const [name, setName] = useState('');
  const [targetKind, setTargetKind] = useState<ServiceRuleTargetKind>('tenant');
  const [targetId, setTargetId] = useState<string>('');

  /* Reset state every time the dialog opens. */
  useEffect(() => {
    if (!open) return;
    setChosen(null);
    setParams({});
    setName('');
    setTargetKind('tenant');
    setTargetId('');
  }, [open]);

  /* When a template is picked, seed params with defaults + name with
     the template's name (admin can override before save). */
  const handlePick = (tpl: ServiceRuleTemplate) => {
    setChosen(tpl);
    const seeded: TemplateParamValues = {};
    for (const spec of tpl.param_specs ?? []) {
      if (spec.default !== undefined) seeded[spec.key] = spec.default;
    }
    setParams(seeded);
    setName(tpl.name);
  };

  const canSave = useMemo(() => {
    if (!chosen) return false;
    if (!name.trim()) return false;
    if (targetKind !== 'tenant' && !targetId.trim()) return false;
    /* Required-param presence check. The backend validates this too,
       but failing fast on the client gives instant feedback. */
    for (const spec of chosen.param_specs ?? []) {
      if ((spec as { required?: boolean }).required === false) continue;
      const v = params[spec.key];
      if (v === undefined || v === null) return false;
      if (typeof v === 'string' && v.trim() === '') return false;
      if (Array.isArray(v) && v.length === 0) return false;
    }
    return true;
  }, [chosen, name, targetKind, targetId, params]);

  const handleCreate = async () => {
    if (!chosen) return;
    try {
      const r = await create.mutateAsync({
        template_key: chosen.template_key,
        params,
        target_kind: targetKind,
        target_id: targetKind === 'tenant' ? null : targetId.trim(),
        name: name.trim() || undefined,
        priority: 100,
        active: false,            // start inactive — admin reviews + activates explicitly
      });
      toastCreated('Service rule', {
        onView: () => onCreated?.(r.id),
      });
      onOpenChange(false);
    } catch (err) {
      toastError("Couldn't create service rule", { error: err });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[860px]">
        <DialogHeader>
          <DialogTitle>New service rule</DialogTitle>
          <DialogDescription>
            Pick a template and fill in its parameters. The rule starts inactive so it doesn't fire while
            you review the compiled predicate.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          <div className="flex flex-col gap-2 lg:max-h-[480px] lg:overflow-auto lg:pr-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Choose a template
            </div>
            <ServiceRuleTemplateGrid
              templates={templates ?? []}
              onPick={handlePick}
              pickedId={chosen?.id ?? null}
              className="!grid-cols-1"
            />
          </div>
          <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
            {chosen ? (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="rule-name">Rule name</FieldLabel>
                  <Input
                    id="rule-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={chosen.name}
                  />
                  <FieldDescription>Shown in the rule list and audit events.</FieldDescription>
                </Field>

                <Field>
                  <FieldLabel htmlFor="rule-scope">Scope</FieldLabel>
                  <Select
                    value={targetKind}
                    onValueChange={(v) => v && setTargetKind(v as ServiceRuleTargetKind)}
                  >
                    <SelectTrigger id="rule-scope">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TARGET_KIND_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {TARGET_KIND_OPTIONS.find((o) => o.value === targetKind)?.help}
                  </FieldDescription>
                </Field>

                {targetKind !== 'tenant' && (
                  <Field>
                    <FieldLabel htmlFor="rule-target-id">
                      {targetKind === 'menu' ? 'Menu id' : targetKind === 'catalog_item' ? 'Catalog item id' : 'Category id'}
                    </FieldLabel>
                    <Input
                      id="rule-target-id"
                      value={targetId}
                      onChange={(e) => setTargetId(e.target.value)}
                      placeholder="UUID"
                    />
                    <FieldDescription>
                      Free-text UUID for v1; Sprint 2 swaps in EntityPicker.
                    </FieldDescription>
                  </Field>
                )}

                <ServiceRuleTemplateParamsForm
                  template={chosen}
                  values={params}
                  onChange={setParams}
                />
              </FieldGroup>
            ) : (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
                <Sparkles className="size-6" />
                Pick a template on the left to see its parameters.
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!canSave || create.isPending}
          >
            {create.isPending ? 'Creating…' : 'Create rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
