import type {
  CriteriaAttr,
  CriteriaLeaf,
  CriteriaListLeaf,
  CriteriaNode,
  CriteriaOp,
  CriteriaScalarLeaf,
  ListOp,
  ScalarOp,
} from '@/api/criteria-sets';

export const ATTR_OPTIONS: Array<{ value: CriteriaAttr; label: string; hint: string }> = [
  { value: 'type', label: 'Person type', hint: 'employee · contractor · vendor_user' },
  { value: 'cost_center', label: 'Cost center', hint: 'Cost-center code on the person record' },
  { value: 'manager_person_id', label: 'Manager', hint: 'UUID of the manager person' },
  { value: 'org_node_id', label: 'Org node (id)', hint: 'UUID of the person\'s primary org node' },
  { value: 'org_node_code', label: 'Org node (code)', hint: 'Short code of the org node, e.g. ENG, HR' },
  { value: 'org_node_name', label: 'Org node (name)', hint: 'Display name of the org node' },
];

export const OP_OPTIONS: Array<{ value: CriteriaOp; label: string; shape: 'scalar' | 'list' }> = [
  { value: 'eq', label: 'is', shape: 'scalar' },
  { value: 'neq', label: 'is not', shape: 'scalar' },
  { value: 'in', label: 'is any of', shape: 'list' },
  { value: 'not_in', label: 'is none of', shape: 'list' },
];

export const MAX_DEPTH = 3;

export function isLeaf(node: CriteriaNode): node is CriteriaLeaf {
  return 'attr' in node && 'op' in node;
}

export function isScalarLeaf(leaf: CriteriaLeaf): leaf is CriteriaScalarLeaf {
  return leaf.op === 'eq' || leaf.op === 'neq';
}

export function isListLeaf(leaf: CriteriaLeaf): leaf is CriteriaListLeaf {
  return leaf.op === 'in' || leaf.op === 'not_in';
}

export function attrLabel(attr: CriteriaAttr): string {
  return ATTR_OPTIONS.find((o) => o.value === attr)?.label ?? attr;
}

export function opLabel(op: CriteriaOp): string {
  return OP_OPTIONS.find((o) => o.value === op)?.label ?? op;
}

export function opShape(op: CriteriaOp): 'scalar' | 'list' {
  return OP_OPTIONS.find((o) => o.value === op)?.shape ?? 'scalar';
}

/**
 * Flip a leaf between scalar and list op shapes, resetting the value/values
 * field so the stored shape always matches the op. Preserves any payload we
 * can reuse (scalar value → first entry of a new values array, and vice
 * versa) so the admin doesn't have to retype common single-value inputs.
 */
export function retypeLeafOp(leaf: CriteriaLeaf, nextOp: CriteriaOp): CriteriaLeaf {
  if (opShape(nextOp) === opShape(leaf.op)) {
    return { ...leaf, op: nextOp } as CriteriaLeaf;
  }
  if (isScalarLeaf(leaf) && (nextOp === 'in' || nextOp === 'not_in')) {
    return {
      attr: leaf.attr,
      op: nextOp,
      values: leaf.value ? [leaf.value] : [],
    };
  }
  if (isListLeaf(leaf) && (nextOp === 'eq' || nextOp === 'neq')) {
    return {
      attr: leaf.attr,
      op: nextOp,
      value: leaf.values[0] ?? '',
    };
  }
  return leaf;
}

/**
 * Produce a single-line human description of a criteria expression, used on
 * the list page row and the detail page's Expression summary. Recurses with
 * parentheses for non-trivial sub-trees.
 */
export function describeExpression(node: CriteriaNode, depth = 0): string {
  if (isLeaf(node)) {
    return `${attrLabel(node.attr)} ${opLabel(node.op)} ${formatLeafValue(node)}`;
  }
  if ('all_of' in node) {
    const parts = node.all_of.map((c) => describeExpression(c, depth + 1));
    const joined = parts.join(' AND ');
    return depth === 0 ? joined : `(${joined})`;
  }
  if ('any_of' in node) {
    const parts = node.any_of.map((c) => describeExpression(c, depth + 1));
    const joined = parts.join(' OR ');
    return depth === 0 ? joined : `(${joined})`;
  }
  return `NOT ${describeExpression(node.not, depth + 1)}`;
}

function formatLeafValue(leaf: CriteriaLeaf): string {
  if (isListLeaf(leaf)) {
    if (leaf.values.length === 0) return '(empty)';
    return leaf.values.join(', ');
  }
  return leaf.value === '' ? '(empty)' : leaf.value;
}

/** Count total leaves in an expression (for the detail page stats row). */
export function countLeaves(node: CriteriaNode): number {
  if (isLeaf(node)) return 1;
  if ('all_of' in node) return node.all_of.reduce((sum, c) => sum + countLeaves(c), 0);
  if ('any_of' in node) return node.any_of.reduce((sum, c) => sum + countLeaves(c), 0);
  return countLeaves(node.not);
}

/** Max nesting depth of composites in an expression (0 = single leaf). */
export function expressionDepth(node: CriteriaNode): number {
  if (isLeaf(node)) return 0;
  if ('all_of' in node) return 1 + Math.max(0, ...node.all_of.map(expressionDepth));
  if ('any_of' in node) return 1 + Math.max(0, ...node.any_of.map(expressionDepth));
  return 1 + expressionDepth(node.not);
}

export function emptyScalarLeaf(attr: CriteriaAttr = 'type'): CriteriaScalarLeaf {
  return { attr, op: 'eq', value: '' };
}

/** Does a leaf look authorable enough to save? */
export function leafIsValid(leaf: CriteriaLeaf): boolean {
  if (isListLeaf(leaf)) return leaf.values.length > 0 && leaf.values.every((v) => v !== '');
  return leaf.value !== '';
}

/** Walk the tree and return the first validation problem, or null if OK. */
export function validateExpression(node: CriteriaNode): string | null {
  if (expressionDepth(node) > MAX_DEPTH) {
    return `Expression nesting exceeds max depth ${MAX_DEPTH}.`;
  }
  return walk(node);
}

function walk(node: CriteriaNode): string | null {
  if (isLeaf(node)) {
    if (!leafIsValid(node)) return `Fill in the value for "${attrLabel(node.attr)}".`;
    return null;
  }
  if ('all_of' in node) {
    if (node.all_of.length === 0) return 'An "All of" group must have at least one condition.';
    for (const c of node.all_of) {
      const err = walk(c);
      if (err) return err;
    }
    return null;
  }
  if ('any_of' in node) {
    if (node.any_of.length === 0) return 'An "Any of" group must have at least one condition.';
    for (const c of node.any_of) {
      const err = walk(c);
      if (err) return err;
    }
    return null;
  }
  return walk(node.not);
}

/**
 * Re-export the specific leaf constructors so `ScalarOp`/`ListOp` don't leak
 * into callers that only need a starting point.
 */
export type { ScalarOp, ListOp };
