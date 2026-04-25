import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRoomBookingRuleTemplates } from '@/api/room-booking-rules';
import type {
  RuleEffect,
  RulePredicate,
  RuleTemplate,
} from '@/api/room-booking-rules';
import { RuleTemplatesGrid } from './rule-templates-grid';
import {
  RuleTemplateParamsForm,
  type TemplateParamValues,
} from './rule-template-params-form';
import { RuleRawPredicateEditor } from './rule-raw-predicate-editor';
import { describePredicate } from './predicate-describe';
import { RuleRowEffectBadge } from './rule-row-effect-badge';

export interface RuleTemplateEditorResult {
  /** When set, the rule should be re-saved via /from-template (creates a new rule from scratch). */
  fromTemplate?: {
    template_id: string;
    params: Record<string, unknown>;
  };
  /** Always set — the compiled predicate the dialog is committing. */
  applies_when: RulePredicate;
  /** Suggested effect from the chosen template (admin can override). */
  suggested_effect?: RuleEffect;
  /** Suggested denial message (only when the template surfaces one). */
  suggested_denial_message?: string | null;
  /** Suggested rule name (used by the create flow only). */
  suggested_name?: string;
}

interface RuleTemplateEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing predicate, used as the starting state for the raw editor. */
  initialPredicate?: RulePredicate;
  /**
   * Existing template_id + params. When the dialog opens with these set, it
   * starts on the Template tab pre-populated; admin can change template,
   * tweak params, or switch to raw.
   */
  initialTemplate?: { template_id: string; params: TemplateParamValues } | null;
  /** Saving an existing rule: locks the suggested-name behaviour. */
  mode: 'edit' | 'create';
  onSave: (result: RuleTemplateEditorResult) => void;
}

/**
 * The "When this applies" editor. Two-tab layout:
 *  - Template — the recommended path; pick from 12 starters and fill params
 *  - Raw predicate — JSON escape hatch for the rare unsupported case
 *
 * Footer buttons: Cancel + Save. The dialog owns its own draft state; the
 * caller only sees the committed result on Save.
 */
export function RuleTemplateEditorDialog({
  open,
  onOpenChange,
  initialPredicate,
  initialTemplate,
  mode,
  onSave,
}: RuleTemplateEditorDialogProps) {
  const { data: templates } = useRoomBookingRuleTemplates();
  const [tab, setTab] = useState<'template' | 'raw'>(initialTemplate ? 'template' : 'raw');
  const [chosen, setChosen] = useState<RuleTemplate | null>(null);
  const [params, setParams] = useState<TemplateParamValues>({});
  const [rawPredicate, setRawPredicate] = useState<RulePredicate>(
    initialPredicate ?? { fn: 'has_permission', args: ['rooms.book'] },
  );
  const [rawValid, setRawValid] = useState(true);

  // Reset state every time the dialog opens with a fresh prop set.
  useEffect(() => {
    if (!open) return;
    setRawPredicate(initialPredicate ?? { fn: 'has_permission', args: ['rooms.book'] });
    setRawValid(true);
    if (initialTemplate && templates) {
      const tpl = templates.find((t) => t.id === initialTemplate.template_id);
      if (tpl) {
        setChosen(tpl);
        setParams(initialTemplate.params ?? {});
        setTab('template');
        return;
      }
    }
    setChosen(null);
    setParams({});
    // No template hint → start on the tab the rule was actually authored on.
    setTab(initialTemplate ? 'template' : initialPredicate ? 'raw' : 'template');
  }, [open, initialPredicate, initialTemplate, templates]);

  const canSaveTemplate = useMemo(() => {
    if (!chosen) return false;
    return chosen.paramSpecs.every((spec) => {
      if (!spec.required) return true;
      const v = params[spec.key];
      if (v === undefined || v === null) return false;
      if (typeof v === 'string' && v.trim() === '') return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    });
  }, [chosen, params]);

  const handleSave = () => {
    if (tab === 'template' && chosen) {
      onSave({
        fromTemplate: { template_id: chosen.id, params },
        // The raw applies_when is server-compiled; we send a placeholder that the
        // caller will replace by hitting /from-template. We still surface the
        // suggested effect/name/denial for the create flow to seed.
        applies_when: rawPredicate,
        suggested_effect: chosen.effect_hint,
      });
      return;
    }
    if (tab === 'raw' && rawValid) {
      onSave({ applies_when: rawPredicate });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[860px]">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New rule' : 'When this applies'}</DialogTitle>
          <DialogDescription>
            Pick a template and fill in its parameters. Switch to the raw predicate tab for cases the
            templates don't cover.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'template' | 'raw')}>
          <TabsList>
            <TabsTrigger value="template">
              <Sparkles className="size-3.5" /> Template
            </TabsTrigger>
            <TabsTrigger value="raw">
              <Wrench className="size-3.5" /> Raw predicate
            </TabsTrigger>
          </TabsList>

          <TabsContent value="template" className="mt-4">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
              <div className="flex flex-col gap-2 lg:max-h-[420px] lg:overflow-auto lg:pr-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Choose a template
                </div>
                <RuleTemplatesGrid
                  templates={templates ?? []}
                  onPick={(tpl) => {
                    setChosen(tpl);
                    setParams(seedDefaultParams(tpl));
                  }}
                  className="!grid-cols-1"
                />
              </div>
              <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
                {chosen ? (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-col gap-0.5">
                        <div className="text-sm font-medium">{chosen.label}</div>
                        <div className="text-xs text-muted-foreground">{chosen.description}</div>
                      </div>
                      <RuleRowEffectBadge effect={chosen.effect_hint} />
                    </div>
                    <RuleTemplateParamsForm
                      template={chosen}
                      values={params}
                      onChange={setParams}
                    />
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
                    <Sparkles className="size-6" />
                    Pick a template on the left to see its parameters.
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="raw" className="mt-4">
            <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
              <div className="flex flex-col gap-1">
                <div className="text-sm font-medium">Compiles to</div>
                <code className="chip rounded-md border bg-muted/40 px-2 py-1 text-xs">
                  {describePredicate(rawPredicate)}
                </code>
              </div>
              <RuleRawPredicateEditor
                value={rawPredicate}
                onChange={(next, valid) => {
                  setRawPredicate(next);
                  setRawValid(valid);
                }}
              />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={tab === 'template' ? !canSaveTemplate : !rawValid}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function seedDefaultParams(template: RuleTemplate): TemplateParamValues {
  const out: TemplateParamValues = {};
  for (const spec of template.paramSpecs) {
    if (spec.default !== undefined) out[spec.key] = spec.default;
  }
  return out;
}
