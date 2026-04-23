import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RequestTypePicker } from '@/components/request-type-picker';
import type { RequestTypeRule, RequestTypeRuleCondition } from '@/api/webhooks';

type Operator = 'equals' | 'in' | 'exists';

interface WebhookRulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: RequestTypeRule[];
  onSave: (rules: RequestTypeRule[]) => void;
  saving?: boolean;
}

function emptyCondition(): RequestTypeRuleCondition {
  return { path: '', operator: 'equals', value: '' };
}

function emptyRule(): RequestTypeRule {
  return { when: [emptyCondition()], request_type_id: '' };
}

export function WebhookRulesDialog({ open, onOpenChange, value, onSave, saving }: WebhookRulesDialogProps) {
  const [rules, setRules] = useState<RequestTypeRule[]>(value);

  useEffect(() => { if (open) setRules(value); }, [open, value]);

  const updateRule = (idx: number, patch: Partial<RequestTypeRule>) =>
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const updateCondition = (ruleIdx: number, condIdx: number, patch: Partial<RequestTypeRuleCondition>) =>
    setRules((prev) =>
      prev.map((r, i) =>
        i !== ruleIdx ? r : { ...r, when: r.when.map((c, j) => (j === condIdx ? { ...c, ...patch } : c)) },
      ),
    );

  const addRule = () => setRules((prev) => [...prev, emptyRule()]);
  const removeRule = (idx: number) => setRules((prev) => prev.filter((_, i) => i !== idx));
  const addCondition = (ruleIdx: number) =>
    setRules((prev) => prev.map((r, i) => (i === ruleIdx ? { ...r, when: [...r.when, emptyCondition()] } : r)));
  const removeCondition = (ruleIdx: number, condIdx: number) =>
    setRules((prev) =>
      prev.map((r, i) => (i !== ruleIdx ? r : { ...r, when: r.when.filter((_, j) => j !== condIdx) })),
    );

  const canSave = rules.every((r) => r.request_type_id && r.when.length > 0 && r.when.every((c) => c.path));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Request type rules</DialogTitle>
          <DialogDescription>
            First matching rule wins. Each rule tests the payload against one or more conditions
            and maps to a request type.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {rules.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No rules yet. The default request type will be used for every payload.
            </p>
          )}

          {rules.map((rule, ruleIdx) => (
            <div key={ruleIdx} className="rounded-md border bg-card p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-muted-foreground">Rule {ruleIdx + 1}</div>
                <Button variant="ghost" size="sm" onClick={() => removeRule(ruleIdx)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>

              <div className="flex flex-col gap-2">
                <div className="text-xs font-medium">When all conditions match</div>
                {rule.when.map((cond, condIdx) => (
                  <ConditionRow
                    key={condIdx}
                    condition={cond}
                    onChange={(patch) => updateCondition(ruleIdx, condIdx, patch)}
                    onRemove={rule.when.length > 1 ? () => removeCondition(ruleIdx, condIdx) : undefined}
                  />
                ))}
                <Button variant="ghost" size="sm" className="self-start gap-1" onClick={() => addCondition(ruleIdx)}>
                  <Plus className="size-3.5" />
                  Add condition
                </Button>
              </div>

              <div className="flex flex-col gap-2">
                <div className="text-xs font-medium">Then route to</div>
                <RequestTypePicker
                  value={rule.request_type_id}
                  onChange={(id) => updateRule(ruleIdx, { request_type_id: id })}
                  placeholder="Select a request type…"
                />
              </div>
            </div>
          ))}

          <Button variant="outline" onClick={addRule} className="self-start gap-1.5">
            <Plus className="size-4" />
            Add rule
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => onSave(rules)} disabled={!canSave || saving}>
            {saving ? 'Saving…' : 'Save rules'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConditionRowProps {
  condition: RequestTypeRuleCondition;
  onChange: (patch: Partial<RequestTypeRuleCondition>) => void;
  onRemove?: () => void;
}

function ConditionRow({ condition, onChange, onRemove }: ConditionRowProps) {
  const op = condition.operator as Operator;

  return (
    <div className="flex items-start gap-2">
      <Input
        placeholder="$.severity"
        className="font-mono text-xs flex-1"
        value={condition.path}
        onChange={(e) => onChange({ path: e.target.value })}
      />
      <Select
        value={op}
        onValueChange={(next) => onChange({ operator: next as Operator, value: next === 'exists' ? undefined : condition.value })}
      >
        <SelectTrigger className="w-[110px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="equals">equals</SelectItem>
          <SelectItem value="in">in</SelectItem>
          <SelectItem value="exists">exists</SelectItem>
        </SelectContent>
      </Select>
      {op !== 'exists' && (
        <Input
          placeholder={op === 'in' ? 'a, b, c' : 'value'}
          className="font-mono text-xs flex-1"
          value={Array.isArray(condition.value) ? condition.value.join(', ') : String(condition.value ?? '')}
          onChange={(e) => {
            const raw = e.target.value;
            onChange({ value: op === 'in' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw });
          }}
        />
      )}
      {onRemove && (
        <Button variant="ghost" size="sm" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
