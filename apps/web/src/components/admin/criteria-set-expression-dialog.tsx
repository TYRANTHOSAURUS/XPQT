import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Minus, Play, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
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
import { cn } from '@/lib/utils';
import type {
  CriteriaAttr,
  CriteriaLeaf,
  CriteriaNode,
  CriteriaOp,
  CriteriaPreviewResult,
} from '@/api/criteria-sets';
import { usePreviewCriteriaExpression } from '@/api/criteria-sets';
import {
  ATTR_OPTIONS,
  MAX_DEPTH,
  OP_OPTIONS,
  countLeaves,
  emptyScalarLeaf,
  expressionDepth,
  isLeaf,
  isListLeaf,
  retypeLeafOp,
  validateExpression,
} from '@/components/admin/criteria-set-expression';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: CriteriaNode;
  onSave: (next: CriteriaNode) => void;
  saving?: boolean;
}

/**
 * Ensure the working expression is always a composite at the root. If a caller
 * passes a bare leaf (seeded storage), wrap it in `any_of` so the builder can
 * render its "Add condition" controls uniformly. Saving re-unwraps one-child
 * `all_of` / `any_of` roots so we don't bloat storage.
 */
function ensureComposite(node: CriteriaNode): CriteriaNode {
  if (isLeaf(node)) return { any_of: [node] };
  return node;
}

function simplifyForSave(node: CriteriaNode): CriteriaNode {
  if ('all_of' in node && node.all_of.length === 1 && isLeaf(node.all_of[0])) {
    return node.all_of[0];
  }
  if ('any_of' in node && node.any_of.length === 1 && isLeaf(node.any_of[0])) {
    return node.any_of[0];
  }
  return node;
}

export function CriteriaSetExpressionDialog({ open, onOpenChange, value, onSave, saving }: Props) {
  const [node, setNode] = useState<CriteriaNode>(ensureComposite(value));
  const preview = usePreviewCriteriaExpression();
  const [previewResult, setPreviewResult] = useState<CriteriaPreviewResult | null>(null);

  useEffect(() => {
    if (open) {
      setNode(ensureComposite(value));
      setPreviewResult(null);
    }
  }, [open, value]);

  const validationError = useMemo(() => validateExpression(node), [node]);
  const depth = useMemo(() => expressionDepth(node), [node]);
  const leaves = useMemo(() => countLeaves(node), [node]);

  const handlePreview = () => {
    if (validationError) {
      toast.error(validationError);
      return;
    }
    preview.mutate(simplifyForSave(node), {
      onSuccess: (res) => setPreviewResult(res),
      onError: (err) => toast.error(err.message || 'Preview failed'),
    });
  };

  const handleSave = () => {
    if (validationError) {
      toast.error(validationError);
      return;
    }
    onSave(simplifyForSave(node));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[720px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit expression</DialogTitle>
          <DialogDescription>
            Build the rule that decides who matches this criteria set. Nest up to {MAX_DEPTH} levels of
            groups. Use <strong>All of</strong> for AND and <strong>Any of</strong> for OR.
          </DialogDescription>
        </DialogHeader>

        <NodeEditor node={node} onChange={setNode} depth={0} onRemove={undefined} />

        <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span>{leaves} {leaves === 1 ? 'condition' : 'conditions'}</span>
            <span>·</span>
            <span>Depth {depth} / {MAX_DEPTH}</span>
            {validationError && (
              <span className="flex items-center gap-1 text-amber-700">
                <AlertTriangle className="size-3.5" />
                {validationError}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handlePreview}
            disabled={preview.isPending || !!validationError}
            className="gap-1"
          >
            <Play className="size-3" />
            {preview.isPending ? 'Previewing…' : 'Preview matches'}
          </Button>
        </div>

        {previewResult && (
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
            <Check className="mt-0.5 size-3.5 text-emerald-600" />
            <div className="flex flex-col gap-1">
              <span>
                <span className="font-medium text-foreground">{previewResult.count}</span>
                {' '}matching {previewResult.count === 1 ? 'person' : 'persons'}
              </span>
              {previewResult.sample.length > 0 && (
                <span className="text-muted-foreground">
                  {previewResult.sample
                    .map((p) => `${p.first_name} ${p.last_name}`.trim() || p.id)
                    .join(', ')}
                  {previewResult.count > previewResult.sample.length && '…'}
                </span>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || !!validationError}>
            {saving ? 'Saving…' : 'Save expression'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Recursive editor                                                           */
/* -------------------------------------------------------------------------- */

interface NodeEditorProps {
  node: CriteriaNode;
  onChange: (next: CriteriaNode) => void;
  onRemove?: () => void;
  depth: number;
}

function NodeEditor({ node, onChange, onRemove, depth }: NodeEditorProps) {
  if (isLeaf(node)) {
    return <LeafRow leaf={node} onChange={onChange} onRemove={onRemove} />;
  }
  if ('not' in node) {
    return <NotWrapper node={node} onChange={onChange} onRemove={onRemove} depth={depth} />;
  }
  return <GroupEditor node={node} onChange={onChange} onRemove={onRemove} depth={depth} />;
}

/* -------------------------------------------------------------------------- */
/* Group (all_of / any_of)                                                    */
/* -------------------------------------------------------------------------- */

interface GroupEditorProps {
  node: { all_of: CriteriaNode[] } | { any_of: CriteriaNode[] };
  onChange: (next: CriteriaNode) => void;
  onRemove?: () => void;
  depth: number;
}

function GroupEditor({ node, onChange, onRemove, depth }: GroupEditorProps) {
  const kind: 'all_of' | 'any_of' = 'all_of' in node ? 'all_of' : 'any_of';
  const children = 'all_of' in node ? node.all_of : node.any_of;

  const replaceChildren = (next: CriteriaNode[]) =>
    onChange(kind === 'all_of' ? { all_of: next } : { any_of: next });

  const updateChild = (idx: number, next: CriteriaNode) =>
    replaceChildren(children.map((c, i) => (i === idx ? next : c)));

  const removeChild = (idx: number) =>
    replaceChildren(children.filter((_, i) => i !== idx));

  const addLeaf = () => replaceChildren([...children, emptyScalarLeaf()]);

  const addGroup = () =>
    replaceChildren([...children, { all_of: [emptyScalarLeaf()] }]);

  const switchKind = (nextKind: 'all_of' | 'any_of' | 'not') => {
    if (nextKind === 'not') {
      const inner = children.length === 1 ? children[0] : { any_of: children };
      onChange({ not: inner });
      return;
    }
    onChange(nextKind === 'all_of' ? { all_of: children } : { any_of: children });
  };

  const canAddGroup = depth + 1 <= MAX_DEPTH;

  return (
    <div
      className={cn(
        'rounded-md border bg-card flex flex-col gap-3 p-3',
        depth > 0 && 'bg-muted/30',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Select value={kind} onValueChange={(v) => switchKind(v as 'all_of' | 'any_of' | 'not')}>
            <SelectTrigger className="h-7 w-[110px] text-xs font-medium">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all_of">All of</SelectItem>
              <SelectItem value="any_of">Any of</SelectItem>
              <SelectItem value="not">Not</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">
            {kind === 'all_of' ? 'all conditions must match' : 'at least one condition must match'}
          </span>
        </div>
        {onRemove && (
          <Button variant="ghost" size="sm" className="size-7 p-0" onClick={onRemove}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {children.map((child, idx) => (
          <NodeEditor
            key={idx}
            node={child}
            onChange={(next) => updateChild(idx, next)}
            onRemove={children.length > 1 ? () => removeChild(idx) : undefined}
            depth={depth + 1}
          />
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" className="gap-1 text-xs" onClick={addLeaf}>
          <Plus className="size-3.5" />
          Add condition
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 text-xs"
          onClick={addGroup}
          disabled={!canAddGroup}
          title={canAddGroup ? undefined : `Max nesting depth is ${MAX_DEPTH}`}
        >
          <Plus className="size-3.5" />
          Add group
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* NOT wrapper                                                                */
/* -------------------------------------------------------------------------- */

interface NotWrapperProps {
  node: { not: CriteriaNode };
  onChange: (next: CriteriaNode) => void;
  onRemove?: () => void;
  depth: number;
}

function NotWrapper({ node, onChange, onRemove, depth }: NotWrapperProps) {
  return (
    <div className="rounded-md border border-dashed bg-card flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Minus className="size-3.5 text-muted-foreground" />
          Not — the condition below must NOT match
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onChange(node.not)}
            title="Remove the NOT and keep its child"
          >
            Un-negate
          </Button>
          {onRemove && (
            <Button variant="ghost" size="sm" className="size-7 p-0" onClick={onRemove}>
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      <NodeEditor
        node={node.not}
        onChange={(next) => onChange({ not: next })}
        depth={depth + 1}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Leaf row                                                                   */
/* -------------------------------------------------------------------------- */

interface LeafRowProps {
  leaf: CriteriaLeaf;
  onChange: (next: CriteriaNode) => void;
  onRemove?: () => void;
}

function LeafRow({ leaf, onChange, onRemove }: LeafRowProps) {
  const handleAttrChange = (next: CriteriaAttr) =>
    onChange({ ...leaf, attr: next } as CriteriaLeaf);

  const handleOpChange = (nextOp: CriteriaOp) =>
    onChange(retypeLeafOp(leaf, nextOp));

  return (
    <div className="flex items-start gap-2 rounded-md border bg-background p-2">
      <Select value={leaf.attr} onValueChange={(v) => handleAttrChange(v as CriteriaAttr)}>
        <SelectTrigger className="h-8 w-[180px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ATTR_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={leaf.op} onValueChange={(v) => handleOpChange(v as CriteriaOp)}>
        <SelectTrigger className="h-8 w-[120px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OP_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex-1 min-w-0">
        {isListLeaf(leaf) ? (
          <ChipInput
            values={leaf.values}
            onChange={(next) => onChange({ ...leaf, values: next })}
            placeholder={placeholderFor(leaf.attr)}
          />
        ) : (
          <Input
            className="h-8 text-xs"
            value={leaf.value}
            onChange={(e) => onChange({ ...leaf, value: e.target.value })}
            placeholder={placeholderFor(leaf.attr)}
          />
        )}
      </div>

      {onRemove && (
        <Button variant="ghost" size="sm" className="size-8 p-0" onClick={onRemove}>
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

function placeholderFor(attr: CriteriaAttr): string {
  switch (attr) {
    case 'type':
      return 'employee';
    case 'cost_center':
      return 'CC-100';
    case 'manager_person_id':
      return 'person UUID';
    case 'org_node_id':
      return 'org node UUID';
    case 'org_node_code':
      return 'ENG';
    case 'org_node_name':
      return 'Engineering';
  }
}

/* -------------------------------------------------------------------------- */
/* ChipInput — multi-value editor for in / not_in                              */
/* -------------------------------------------------------------------------- */

interface ChipInputProps {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

function ChipInput({ values, onChange, placeholder }: ChipInputProps) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const v = draft.trim();
    if (!v) return;
    if (values.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...values, v]);
    setDraft('');
  };

  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border bg-background px-1.5 py-1 min-h-8">
      {values.map((v) => (
        <Badge key={v} variant="secondary" className="gap-1 pl-2 pr-1 text-xs font-normal">
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="rounded hover:bg-foreground/10 p-0.5"
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        className="flex-1 min-w-[80px] bg-transparent text-xs outline-none placeholder:text-muted-foreground px-1"
        value={draft}
        placeholder={values.length === 0 ? placeholder : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && !draft && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
