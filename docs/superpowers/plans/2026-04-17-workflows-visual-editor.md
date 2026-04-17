# Workflows Visual Editor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder on `/admin/workflows` with a canvas-based visual workflow editor, plus a runtime viewer showing live instance state, an execution-history timeline, and a dry-run simulator.

**Architecture:** React Flow + dagre auto-layout canvas in a new `components/workflow-editor/` module, backed by a Zustand store. Backend adds a `WorkflowValidatorService`, a `WorkflowSimulatorService`, dry-run mode on the engine, event emission to a new `workflow_instance_events` table, and three new endpoints (`unpublish`, `clone`, `simulate`). All 10 engine-supported node types become first-class.

**Tech Stack:** React 19, Vite, TypeScript, Tailwind v4, shadcn/ui, **reactflow@11**, **dagre@0.8**, **zustand@4** (new). NestJS 11, Supabase (Postgres + RLS), Jest (new config).

**Design reference:** `docs/superpowers/specs/2026-04-17-workflows-visual-editor-design.md`

**Phased delivery** — the plan is grouped into three phases, each independently mergeable:
- **Phase A** (Tasks 1–17): Editor core — frontend editor + backend validator/lifecycle
- **Phase B** (Tasks 18–23): Execution history + runtime viewer
- **Phase C** (Tasks 24–27): Dry-run simulator

---

## Pre-flight: Codebase conventions you must follow

- **Frontend HTTP:** The repo uses `apiFetch<T>(path, options)` from `@/lib/api` plus the hook `useApi<T>(path, deps)` from `@/hooks/use-api`. It does **not** use React Query — do not add it.
- **Frontend UI:** Use existing shadcn components in `apps/web/src/components/ui/*`. Install any missing ones with `npx shadcn@latest add <name>` (run from repo root — **not** `apps/web`).
- **Component reuse:** Project convention (`CLAUDE.md`) — extract shared components into `apps/web/src/components/`, don't duplicate JSX across pages.
- **Backend:** NestJS modules with `SupabaseService` via `this.supabase.admin` and `TenantContext.current()` for tenant isolation. Follow the patterns in `apps/api/src/modules/workflow/workflow.service.ts`.
- **Migrations:** Never run `pnpm db:push` or remote psql **without user confirmation**. Local `pnpm db:reset` is safe. See `CLAUDE.md` "Supabase: remote vs local".
- **Commits:** Don't include "Co-Authored-By: Claude" or any Claude/AI mention. Use imperative, lowercase subject.

---

# Phase A — Editor Core

## Task 1: Install dependencies

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml` (generated)

- [ ] **Step 1: Install**

```bash
cd /Users/x/Desktop/XPQT
pnpm --filter @prequest/web add reactflow@^11.11.0 dagre@^0.8.5 zustand@^4.5.0
pnpm --filter @prequest/web add -D @types/dagre@^0.7.52
```

- [ ] **Step 2: Verify**

```bash
cd /Users/x/Desktop/XPQT/apps/web && grep -E "reactflow|dagre|zustand" package.json
```
Expected: three matches under `dependencies`, one under `devDependencies`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml
git commit -m "deps(web): add reactflow, dagre, zustand for workflow editor"
```

---

## Task 2: Create workflow-editor module scaffolding

**Files:**
- Create: `apps/web/src/components/workflow-editor/types.ts`
- Create: `apps/web/src/components/workflow-editor/node-types/index.ts`

- [ ] **Step 1: Create `types.ts`**

```ts
// apps/web/src/components/workflow-editor/types.ts
export type NodeType =
  | 'trigger' | 'end' | 'assign' | 'approval' | 'notification'
  | 'condition' | 'update_ticket' | 'create_child_tasks' | 'wait_for' | 'timer';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  config: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  entity_type: string;
  version: number;
  status: 'draft' | 'published';
  graph_definition: WorkflowGraph;
  created_at: string;
  published_at: string | null;
}

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeIndex?: number;
}
```

- [ ] **Step 2: Create `node-types/index.ts` (registry of all 10 types)**

```ts
// apps/web/src/components/workflow-editor/node-types/index.ts
import {
  Play, Square, UserPlus, CheckSquare, Bell, GitBranch,
  Edit3, ListTree, Pause, Clock,
} from 'lucide-react';
import type { NodeType } from '../types';

export interface NodeTypeMeta {
  type: NodeType;
  label: string;
  description: string;
  icon: typeof Play;
  colorClass: string;        // Tailwind border / bg class
  defaultConfig: Record<string, unknown>;
  outgoingEdges: 'single' | 'none' | 'condition' | 'approval';
}

export const NODE_TYPES: Record<NodeType, NodeTypeMeta> = {
  trigger: {
    type: 'trigger', label: 'Trigger', description: 'Workflow start',
    icon: Play, colorClass: 'border-emerald-500 bg-emerald-50',
    defaultConfig: {}, outgoingEdges: 'single',
  },
  end: {
    type: 'end', label: 'End', description: 'Workflow complete',
    icon: Square, colorClass: 'border-zinc-400 bg-zinc-50',
    defaultConfig: {}, outgoingEdges: 'none',
  },
  assign: {
    type: 'assign', label: 'Assign', description: 'Assign ticket to team or user',
    icon: UserPlus, colorClass: 'border-blue-500 bg-blue-50',
    defaultConfig: { team_id: null, user_id: null }, outgoingEdges: 'single',
  },
  approval: {
    type: 'approval', label: 'Approval', description: 'Request approval (pauses workflow)',
    icon: CheckSquare, colorClass: 'border-violet-500 bg-violet-50',
    defaultConfig: { approver_person_id: null, approver_team_id: null },
    outgoingEdges: 'approval',
  },
  notification: {
    type: 'notification', label: 'Notify', description: 'Send notification',
    icon: Bell, colorClass: 'border-cyan-500 bg-cyan-50',
    defaultConfig: { notification_type: 'workflow_notification', subject: '', body: '' },
    outgoingEdges: 'single',
  },
  condition: {
    type: 'condition', label: 'Condition', description: 'Branch on ticket field',
    icon: GitBranch, colorClass: 'border-amber-500 bg-amber-50',
    defaultConfig: { field: '', operator: 'equals', value: '' },
    outgoingEdges: 'condition',
  },
  update_ticket: {
    type: 'update_ticket', label: 'Update Ticket', description: 'Set ticket fields',
    icon: Edit3, colorClass: 'border-indigo-500 bg-indigo-50',
    defaultConfig: { fields: {} }, outgoingEdges: 'single',
  },
  create_child_tasks: {
    type: 'create_child_tasks', label: 'Create Child Tasks', description: 'Spawn sub-tickets',
    icon: ListTree, colorClass: 'border-fuchsia-500 bg-fuchsia-50',
    defaultConfig: { tasks: [] }, outgoingEdges: 'single',
  },
  wait_for: {
    type: 'wait_for', label: 'Wait For', description: 'Pause until signal (child tasks, status, event)',
    icon: Pause, colorClass: 'border-orange-500 bg-orange-50',
    defaultConfig: { wait_type: 'child_tasks' }, outgoingEdges: 'single',
  },
  timer: {
    type: 'timer', label: 'Timer', description: 'Pause for N minutes',
    icon: Clock, colorClass: 'border-rose-500 bg-rose-50',
    defaultConfig: { delay_minutes: 60 }, outgoingEdges: 'single',
  },
};

export const NODE_TYPE_LIST: NodeTypeMeta[] = Object.values(NODE_TYPES);
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/workflow-editor/
git commit -m "feat(workflow-editor): scaffold types and node-type registry"
```

---

## Task 3: Graph utilities (id, layout, validation)

**Files:**
- Create: `apps/web/src/components/workflow-editor/graph-utils.ts`
- Create: `apps/web/src/components/workflow-editor/layout.ts`
- Create: `apps/web/src/components/workflow-editor/validation.ts`

- [ ] **Step 1: Create `graph-utils.ts`**

```ts
// apps/web/src/components/workflow-editor/graph-utils.ts
import type { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeType } from './types';
import { NODE_TYPES } from './node-types';

let idCounter = 0;
export function generateNodeId(type: NodeType): string {
  idCounter++;
  return `n_${type}_${Date.now().toString(36)}_${idCounter}`;
}

export function emptyGraph(): WorkflowGraph {
  const trigger: WorkflowNode = {
    id: generateNodeId('trigger'),
    type: 'trigger',
    config: {},
  };
  const end: WorkflowNode = {
    id: generateNodeId('end'),
    type: 'end',
    config: {},
  };
  return {
    nodes: [trigger, end],
    edges: [{ from: trigger.id, to: end.id }],
  };
}

export function createNode(type: NodeType): WorkflowNode {
  return {
    id: generateNodeId(type),
    type,
    config: { ...NODE_TYPES[type].defaultConfig },
  };
}

export function cloneGraph(g: WorkflowGraph): WorkflowGraph {
  return JSON.parse(JSON.stringify(g));
}

export function regenerateIds(g: WorkflowGraph): WorkflowGraph {
  const idMap = new Map<string, string>();
  const nodes: WorkflowNode[] = g.nodes.map((n) => {
    const newId = generateNodeId(n.type);
    idMap.set(n.id, newId);
    return { ...n, id: newId };
  });
  const edges: WorkflowEdge[] = g.edges.map((e) => ({
    ...e,
    from: idMap.get(e.from) ?? e.from,
    to: idMap.get(e.to) ?? e.to,
  }));
  return { nodes, edges };
}
```

- [ ] **Step 2: Create `layout.ts`**

```ts
// apps/web/src/components/workflow-editor/layout.ts
import dagre from 'dagre';
import type { Node, Edge } from 'reactflow';

const NODE_WIDTH = 200;
const NODE_HEIGHT = 80;

export function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 80 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      ...n,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
      targetPosition: 'left' as const,
      sourcePosition: 'right' as const,
    };
  });
}
```

- [ ] **Step 3: Create `validation.ts`**

```ts
// apps/web/src/components/workflow-editor/validation.ts
import type { WorkflowGraph, ValidationError, WorkflowNode } from './types';

export function validate(graph: WorkflowGraph): ValidationError[] {
  const errors: ValidationError[] = [];
  const { nodes, edges } = graph;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) errors.push({ code: 'NO_TRIGGER', message: 'Workflow must have a trigger node' });
  if (triggers.length > 1) errors.push({ code: 'MULTIPLE_TRIGGERS', message: 'Workflow must have exactly one trigger' });

  const ends = nodes.filter((n) => n.type === 'end');
  if (ends.length === 0) errors.push({ code: 'NO_END', message: 'Workflow must have at least one end node' });

  // Dangling edges
  edges.forEach((e, i) => {
    if (!nodeById.has(e.from)) errors.push({ code: 'DANGLING_EDGE_FROM', message: `Edge references unknown node ${e.from}`, edgeIndex: i });
    if (!nodeById.has(e.to)) errors.push({ code: 'DANGLING_EDGE_TO', message: `Edge references unknown node ${e.to}`, edgeIndex: i });
  });

  // Outgoing edge presence + branch labels
  for (const n of nodes) {
    const out = edges.filter((e) => e.from === n.id);
    if (n.type !== 'end' && out.length === 0) {
      errors.push({ code: 'NO_OUTGOING', message: `Node "${n.type}" has no outgoing edge`, nodeId: n.id });
    }
    if (n.type === 'condition') {
      const hasTrue = out.some((e) => e.condition === 'true');
      const hasFalse = out.some((e) => e.condition === 'false');
      if (!hasTrue) errors.push({ code: 'MISSING_TRUE_EDGE', message: 'Condition needs a "true" branch', nodeId: n.id });
      if (!hasFalse) errors.push({ code: 'MISSING_FALSE_EDGE', message: 'Condition needs a "false" branch', nodeId: n.id });
    }
    if (n.type === 'approval') {
      const hasApproved = out.some((e) => e.condition === 'approved');
      const hasRejected = out.some((e) => e.condition === 'rejected');
      if (!hasApproved) errors.push({ code: 'MISSING_APPROVED_EDGE', message: 'Approval needs an "approved" branch', nodeId: n.id });
      if (!hasRejected) errors.push({ code: 'MISSING_REJECTED_EDGE', message: 'Approval needs a "rejected" branch', nodeId: n.id });
    }
  }

  // Reachability + config rules
  if (triggers.length === 1) {
    const reachable = bfs(triggers[0].id, edges);
    for (const n of nodes) {
      if (!reachable.has(n.id) && n.type !== 'trigger') {
        errors.push({ code: 'UNREACHABLE', message: `Node "${n.type}" is not reachable from trigger`, nodeId: n.id });
      }
    }
  }

  for (const n of nodes) errors.push(...validateNodeConfig(n));

  return errors;
}

function bfs(startId: string, edges: Array<{ from: string; to: string }>): Set<string> {
  const seen = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.from === cur && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

function validateNodeConfig(n: WorkflowNode): ValidationError[] {
  const errs: ValidationError[] = [];
  const c = n.config as Record<string, unknown>;
  const req = (code: string, message: string, ok: boolean) => {
    if (!ok) errs.push({ code, message, nodeId: n.id });
  };

  switch (n.type) {
    case 'assign':
      req('ASSIGN_TARGET', 'Assign requires a team or user', !!(c.team_id || c.user_id));
      break;
    case 'approval':
      req('APPROVAL_APPROVER', 'Approval requires an approver (person or team)', !!(c.approver_person_id || c.approver_team_id));
      break;
    case 'notification':
      req('NOTIFY_SUBJECT', 'Notification requires subject', typeof c.subject === 'string' && c.subject.trim().length > 0);
      req('NOTIFY_BODY', 'Notification requires body', typeof c.body === 'string' && c.body.trim().length > 0);
      break;
    case 'condition':
      req('COND_FIELD', 'Condition requires a field', typeof c.field === 'string' && c.field.length > 0);
      req('COND_OP', 'Condition requires an operator', ['equals','not_equals','in'].includes(c.operator as string));
      break;
    case 'update_ticket':
      req('UPDATE_FIELDS', 'Update Ticket requires at least one field', typeof c.fields === 'object' && c.fields !== null && Object.keys(c.fields).length > 0);
      break;
    case 'create_child_tasks': {
      const tasks = c.tasks as Array<{ title?: string }> | undefined;
      req('CHILD_TASKS_NONEMPTY', 'Create Child Tasks requires at least one task', Array.isArray(tasks) && tasks.length > 0 && tasks.every((t) => typeof t.title === 'string' && t.title.trim().length > 0));
      break;
    }
    case 'wait_for':
      req('WAIT_TYPE', 'Wait For requires a wait_type', ['child_tasks','status','event'].includes(c.wait_type as string));
      break;
    case 'timer':
      req('TIMER_DELAY', 'Timer requires delay_minutes > 0', typeof c.delay_minutes === 'number' && c.delay_minutes > 0);
      break;
  }
  return errs;
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/workflow-editor/
git commit -m "feat(workflow-editor): add graph utils, dagre layout, client validation"
```

---

## Task 4: Zustand graph store with undo/redo and clipboard

**Files:**
- Create: `apps/web/src/components/workflow-editor/graph-store.ts`

- [ ] **Step 1: Create the store**

```ts
// apps/web/src/components/workflow-editor/graph-store.ts
import { create } from 'zustand';
import type { WorkflowGraph, WorkflowNode, WorkflowEdge, NodeType } from './types';
import { createNode, regenerateIds } from './graph-utils';

interface Snapshot {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

interface GraphState {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedIds: string[];
  dirty: boolean;
  past: Snapshot[];
  future: Snapshot[];
  clipboard: Snapshot | null;

  setGraph: (g: WorkflowGraph) => void;
  toJSON: () => WorkflowGraph;

  setSelection: (ids: string[]) => void;
  addNode: (type: NodeType) => void;
  updateNodeConfig: (id: string, patch: Record<string, unknown>) => void;
  renameNode: (id: string, label: string) => void;
  deleteSelection: () => void;
  connect: (from: string, to: string, condition?: string) => void;
  disconnect: (fromId: string, toId: string, condition?: string) => void;

  copySelection: () => void;
  paste: () => void;
  duplicateSelection: () => void;

  undo: () => void;
  redo: () => void;
  markSaved: () => void;
}

const MAX_HISTORY = 50;

function snapshot(s: GraphState): Snapshot {
  return { nodes: JSON.parse(JSON.stringify(s.nodes)), edges: JSON.parse(JSON.stringify(s.edges)) };
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedIds: [],
  dirty: false,
  past: [],
  future: [],
  clipboard: null,

  setGraph: (g) => set({ nodes: g.nodes, edges: g.edges, past: [], future: [], dirty: false, selectedIds: [] }),

  toJSON: () => ({ nodes: get().nodes, edges: get().edges }),

  setSelection: (ids) => set({ selectedIds: ids }),

  addNode: (type) => {
    const snap = snapshot(get());
    const node = createNode(type);
    set({
      nodes: [...get().nodes, node],
      selectedIds: [node.id],
      dirty: true,
      past: [...get().past.slice(-MAX_HISTORY + 1), snap],
      future: [],
    });
  },

  updateNodeConfig: (id, patch) => {
    const snap = snapshot(get());
    set({
      nodes: get().nodes.map((n) => n.id === id ? { ...n, config: { ...n.config, ...patch } } : n),
      dirty: true,
      past: [...get().past.slice(-MAX_HISTORY + 1), snap],
      future: [],
    });
  },

  renameNode: (id, label) => {
    const snap = snapshot(get());
    set({
      nodes: get().nodes.map((n) => n.id === id ? { ...n, config: { ...n.config, label } } : n),
      dirty: true,
      past: [...get().past.slice(-MAX_HISTORY + 1), snap],
      future: [],
    });
  },

  deleteSelection: () => {
    const sel = new Set(get().selectedIds);
    if (sel.size === 0) return;
    const snap = snapshot(get());
    set({
      nodes: get().nodes.filter((n) => !sel.has(n.id)),
      edges: get().edges.filter((e) => !sel.has(e.from) && !sel.has(e.to)),
      selectedIds: [],
      dirty: true,
      past: [...get().past.slice(-MAX_HISTORY + 1), snap],
      future: [],
    });
  },

  connect: (from, to, condition) => {
    if (from === to) return;
    const exists = get().edges.some((e) => e.from === from && e.to === to && e.condition === condition);
    if (exists) return;
    const snap = snapshot(get());
    set({
      edges: [...get().edges, { from, to, condition }],
      dirty: true,
      past: [...get().past.slice(-MAX_HISTORY + 1), snap],
      future: [],
    });
  },

  disconnect: (from, to, condition) => {
    const snap = snapshot(get());
    set({
      edges: get().edges.filter((e) => !(e.from === from && e.to === to && e.condition === condition)),
      dirty: true,
      past: [...get().past.slice(-MAX_HISTORY + 1), snap],
      future: [],
    });
  },

  copySelection: () => {
    const sel = new Set(get().selectedIds);
    if (sel.size === 0) return;
    const nodes = get().nodes.filter((n) => sel.has(n.id));
    const edges = get().edges.filter((e) => sel.has(e.from) && sel.has(e.to));
    set({ clipboard: { nodes, edges } });
  },

  paste: () => {
    const cb = get().clipboard;
    if (!cb) return;
    const regen = regenerateIds({ nodes: cb.nodes, edges: cb.edges });
    const snap = snapshot(get());
    set({
      nodes: [...get().nodes, ...regen.nodes],
      edges: [...get().edges, ...regen.edges],
      selectedIds: regen.nodes.map((n) => n.id),
      dirty: true,
      past: [...get().past.slice(-MAX_HISTORY + 1), snap],
      future: [],
    });
  },

  duplicateSelection: () => {
    get().copySelection();
    get().paste();
  },

  undo: () => {
    const past = get().past;
    if (past.length === 0) return;
    const prev = past[past.length - 1];
    const cur = snapshot(get());
    set({ nodes: prev.nodes, edges: prev.edges, past: past.slice(0, -1), future: [cur, ...get().future], dirty: true, selectedIds: [] });
  },

  redo: () => {
    const future = get().future;
    if (future.length === 0) return;
    const next = future[0];
    const cur = snapshot(get());
    set({ nodes: next.nodes, edges: next.edges, past: [...get().past, cur], future: future.slice(1), dirty: true, selectedIds: [] });
  },

  markSaved: () => set({ dirty: false }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/workflow-editor/graph-store.ts
git commit -m "feat(workflow-editor): add zustand graph store with undo/redo and clipboard"
```

---

## Task 5: Custom React Flow node component

**Files:**
- Create: `apps/web/src/components/workflow-editor/workflow-node.tsx`

- [ ] **Step 1: Write the node component**

```tsx
// apps/web/src/components/workflow-editor/workflow-node.tsx
import { Handle, Position, type NodeProps } from 'reactflow';
import { NODE_TYPES } from './node-types';
import type { NodeType, WorkflowNode } from './types';
import { cn } from '@/lib/utils';

interface NodeData {
  node: WorkflowNode;
  invalid?: boolean;
  summary?: string;
  runtime?: 'visited' | 'current' | 'upcoming';
}

export function WorkflowNodeCard({ data, selected }: NodeProps<NodeData>) {
  const meta = NODE_TYPES[data.node.type as NodeType];
  const Icon = meta.icon;
  const showTrueFalse = data.node.type === 'condition';
  const showApprovedRejected = data.node.type === 'approval';
  const isEnd = data.node.type === 'end';

  return (
    <div
      className={cn(
        'rounded-lg border-2 bg-white shadow-sm w-[200px] transition-all',
        meta.colorClass,
        selected && 'ring-2 ring-offset-2 ring-zinc-900',
        data.invalid && 'border-red-500',
        data.runtime === 'current' && 'ring-2 ring-offset-2 ring-emerald-500 animate-pulse',
        data.runtime === 'visited' && 'opacity-80',
        data.runtime === 'upcoming' && 'opacity-40',
      )}
    >
      <Handle type="target" position={Position.Left} className={cn(data.node.type === 'trigger' && 'opacity-0 pointer-events-none')} />
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" />
          <span className="font-medium text-sm">{(data.node.config.label as string) || meta.label}</span>
        </div>
        {data.summary && <div className="text-xs text-muted-foreground mt-1 truncate">{data.summary}</div>}
      </div>
      {!isEnd && !showTrueFalse && !showApprovedRejected && (
        <Handle type="source" position={Position.Right} />
      )}
      {showTrueFalse && (
        <>
          <Handle id="true" type="source" position={Position.Right} style={{ top: '35%' }} />
          <Handle id="false" type="source" position={Position.Right} style={{ top: '65%' }} />
          <div className="absolute -right-10 top-[30%] text-[10px] text-emerald-600 font-medium">true</div>
          <div className="absolute -right-10 top-[60%] text-[10px] text-red-600 font-medium">false</div>
        </>
      )}
      {showApprovedRejected && (
        <>
          <Handle id="approved" type="source" position={Position.Right} style={{ top: '35%' }} />
          <Handle id="rejected" type="source" position={Position.Right} style={{ top: '65%' }} />
          <div className="absolute -right-14 top-[30%] text-[10px] text-emerald-600 font-medium">approved</div>
          <div className="absolute -right-14 top-[60%] text-[10px] text-red-600 font-medium">rejected</div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/workflow-editor/workflow-node.tsx
git commit -m "feat(workflow-editor): add workflow node card component"
```

---

## Task 6: Canvas component (React Flow wrapper)

**Files:**
- Create: `apps/web/src/components/workflow-editor/canvas.tsx`
- Modify: `apps/web/src/main.tsx` (or `apps/web/src/index.css`) to import React Flow styles

- [ ] **Step 1: Confirm React Flow styles location**

React Flow requires `reactflow/dist/style.css`. Check where the project imports global CSS:

```bash
grep -rn "index.css\|globals.css" /Users/x/Desktop/XPQT/apps/web/src/main.tsx /Users/x/Desktop/XPQT/apps/web/src/index.css 2>/dev/null | head
```

Add the import at the **top** of `apps/web/src/index.css`:

```css
@import "reactflow/dist/style.css";
```

If `index.css` doesn't exist, add the import in `apps/web/src/main.tsx` just after existing CSS imports.

- [ ] **Step 2: Write canvas component**

```tsx
// apps/web/src/components/workflow-editor/canvas.tsx
import { useMemo, useCallback } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap,
  type Node, type Edge, type Connection, type NodeTypes,
} from 'reactflow';
import { useGraphStore } from './graph-store';
import { applyDagreLayout } from './layout';
import { validate } from './validation';
import { WorkflowNodeCard } from './workflow-node';
import { summarizeNode } from './node-summary';

const nodeTypes: NodeTypes = { workflow: WorkflowNodeCard };

export interface CanvasProps {
  readOnly?: boolean;
  runtime?: Record<string, 'visited' | 'current' | 'upcoming'>;
}

export function Canvas({ readOnly = false, runtime }: CanvasProps) {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const selectedIds = useGraphStore((s) => s.selectedIds);
  const setSelection = useGraphStore((s) => s.setSelection);
  const connect = useGraphStore((s) => s.connect);
  const disconnect = useGraphStore((s) => s.disconnect);

  const validationErrors = useMemo(() => validate({ nodes, edges }), [nodes, edges]);
  const invalidIds = useMemo(() => new Set(validationErrors.map((e) => e.nodeId).filter(Boolean) as string[]), [validationErrors]);

  const rfNodes: Node[] = useMemo(() => {
    const raw: Node[] = nodes.map((n) => ({
      id: n.id,
      type: 'workflow',
      position: n.position ?? { x: 0, y: 0 },
      data: {
        node: n,
        invalid: invalidIds.has(n.id),
        summary: summarizeNode(n),
        runtime: runtime?.[n.id],
      },
      selected: selectedIds.includes(n.id),
    }));
    return applyDagreLayout(
      raw,
      edges.map((e, i) => ({ id: `e_${i}`, source: e.from, target: e.to })),
    );
  }, [nodes, edges, invalidIds, selectedIds, runtime]);

  const rfEdges: Edge[] = useMemo(
    () => edges.map((e, i) => ({
      id: `e_${i}_${e.from}_${e.to}_${e.condition ?? 'default'}`,
      source: e.from,
      target: e.to,
      sourceHandle: e.condition && ['true', 'false', 'approved', 'rejected'].includes(e.condition) ? e.condition : undefined,
      label: e.condition && !['true', 'false', 'approved', 'rejected'].includes(e.condition) ? e.condition : undefined,
      animated: runtime?.[e.from] === 'visited' && runtime?.[e.to] !== 'upcoming',
      style: { stroke: e.condition === 'false' || e.condition === 'rejected' ? '#ef4444' : e.condition === 'true' || e.condition === 'approved' ? '#10b981' : '#888' },
    })),
    [edges, runtime],
  );

  const handleConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    connect(c.source, c.target, c.sourceHandle ?? undefined);
  }, [connect]);

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onConnect={handleConnect}
      onEdgesDelete={(es) => es.forEach((e) => disconnect(e.source, e.target, e.sourceHandle ?? undefined))}
      onSelectionChange={({ nodes: selNodes }) => setSelection(selNodes.map((n) => n.id))}
      nodesDraggable={false}
      nodesConnectable={!readOnly}
      elementsSelectable={!readOnly}
      edgesUpdatable={!readOnly}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={16} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
```

- [ ] **Step 3: Create `node-summary.ts` helper**

```ts
// apps/web/src/components/workflow-editor/node-summary.ts
import type { WorkflowNode } from './types';

export function summarizeNode(n: WorkflowNode): string {
  const c = n.config as Record<string, unknown>;
  switch (n.type) {
    case 'assign': {
      const t = c.team_id ? 'team' : c.user_id ? 'user' : null;
      return t ? `Assign to ${t}` : 'Unassigned';
    }
    case 'approval': return c.approver_person_id || c.approver_team_id ? 'Approver set' : 'No approver';
    case 'notification': return (c.subject as string) || 'No subject';
    case 'condition': return c.field ? `${c.field} ${c.operator} ${JSON.stringify(c.value)}` : 'Unconfigured';
    case 'update_ticket': return `Update ${Object.keys((c.fields as object) || {}).length} field(s)`;
    case 'create_child_tasks': return `${((c.tasks as unknown[]) || []).length} task(s)`;
    case 'wait_for': return `Wait for ${c.wait_type ?? '—'}`;
    case 'timer': return `Delay ${c.delay_minutes ?? 0} min`;
    default: return '';
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/workflow-editor/ apps/web/src/index.css
git commit -m "feat(workflow-editor): canvas with react flow + auto-layout"
```

---

## Task 7: Palette component

**Files:**
- Create: `apps/web/src/components/workflow-editor/palette.tsx`

- [ ] **Step 1: Write the palette**

```tsx
// apps/web/src/components/workflow-editor/palette.tsx
import { NODE_TYPE_LIST } from './node-types';
import { useGraphStore } from './graph-store';
import { Button } from '@/components/ui/button';

export function Palette({ disabled }: { disabled?: boolean }) {
  const addNode = useGraphStore((s) => s.addNode);

  return (
    <aside className="w-[160px] border-r bg-muted/30 p-3 overflow-auto shrink-0">
      <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Palette</div>
      <div className="flex flex-col gap-1">
        {NODE_TYPE_LIST.map((m) => {
          const Icon = m.icon;
          return (
            <Button
              key={m.type}
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => addNode(m.type)}
              className="justify-start gap-2 h-8"
              title={m.description}
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="text-xs">{m.label}</span>
            </Button>
          );
        })}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/workflow-editor/palette.tsx
git commit -m "feat(workflow-editor): palette with 10 node types"
```

---

## Task 8: Inspector forms (all 10 node types)

**Files:**
- Create: `apps/web/src/components/workflow-editor/inspector.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/trigger-form.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/end-form.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/assign-form.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/approval-form.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/notification-form.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/condition-form.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/update-ticket-form.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/create-child-tasks-form.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/wait-for-form.tsx`
- Create: `apps/web/src/components/workflow-editor/inspector-forms/timer-form.tsx`

- [ ] **Step 1: Inspector switcher**

```tsx
// apps/web/src/components/workflow-editor/inspector.tsx
import { useGraphStore } from './graph-store';
import type { WorkflowNode } from './types';
import { NODE_TYPES } from './node-types';
import { TriggerForm } from './inspector-forms/trigger-form';
import { EndForm } from './inspector-forms/end-form';
import { AssignForm } from './inspector-forms/assign-form';
import { ApprovalForm } from './inspector-forms/approval-form';
import { NotificationForm } from './inspector-forms/notification-form';
import { ConditionForm } from './inspector-forms/condition-form';
import { UpdateTicketForm } from './inspector-forms/update-ticket-form';
import { CreateChildTasksForm } from './inspector-forms/create-child-tasks-form';
import { WaitForForm } from './inspector-forms/wait-for-form';
import { TimerForm } from './inspector-forms/timer-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function Inspector({ readOnly = false }: { readOnly?: boolean }) {
  const selectedIds = useGraphStore((s) => s.selectedIds);
  const nodes = useGraphStore((s) => s.nodes);
  const renameNode = useGraphStore((s) => s.renameNode);

  const selected: WorkflowNode | null = selectedIds.length === 1
    ? nodes.find((n) => n.id === selectedIds[0]) ?? null
    : null;

  if (!selected) {
    return (
      <aside className="w-[300px] border-l bg-muted/30 p-4 overflow-auto shrink-0">
        <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Inspector</div>
        <p className="text-sm text-muted-foreground">
          {selectedIds.length > 1 ? `${selectedIds.length} nodes selected` : 'Select a node to edit its configuration.'}
        </p>
      </aside>
    );
  }

  const meta = NODE_TYPES[selected.type];

  return (
    <aside className="w-[300px] border-l bg-muted/30 p-4 overflow-auto shrink-0">
      <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Inspector</div>
      <div className="flex items-center gap-2 mb-3">
        <meta.icon className="h-4 w-4" />
        <div className="font-semibold">{meta.label}</div>
      </div>

      <div className="grid gap-1.5 mb-3">
        <Label className="text-xs">Label (optional)</Label>
        <Input
          value={(selected.config.label as string) ?? ''}
          onChange={(e) => renameNode(selected.id, e.target.value)}
          placeholder={meta.label}
          disabled={readOnly}
        />
      </div>

      <FormFor node={selected} readOnly={readOnly} />
    </aside>
  );
}

function FormFor({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  switch (node.type) {
    case 'trigger': return <TriggerForm node={node} readOnly={readOnly} />;
    case 'end': return <EndForm node={node} readOnly={readOnly} />;
    case 'assign': return <AssignForm node={node} readOnly={readOnly} />;
    case 'approval': return <ApprovalForm node={node} readOnly={readOnly} />;
    case 'notification': return <NotificationForm node={node} readOnly={readOnly} />;
    case 'condition': return <ConditionForm node={node} readOnly={readOnly} />;
    case 'update_ticket': return <UpdateTicketForm node={node} readOnly={readOnly} />;
    case 'create_child_tasks': return <CreateChildTasksForm node={node} readOnly={readOnly} />;
    case 'wait_for': return <WaitForForm node={node} readOnly={readOnly} />;
    case 'timer': return <TimerForm node={node} readOnly={readOnly} />;
  }
}
```

- [ ] **Step 2: Create trigger-form.tsx and end-form.tsx**

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/trigger-form.tsx
import type { WorkflowNode } from '../types';
export function TriggerForm(_: { node: WorkflowNode; readOnly: boolean }) {
  return <p className="text-xs text-muted-foreground">The trigger marks where the workflow starts. No additional config.</p>;
}
```

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/end-form.tsx
import type { WorkflowNode } from '../types';
export function EndForm(_: { node: WorkflowNode; readOnly: boolean }) {
  return <p className="text-xs text-muted-foreground">When the workflow reaches this node, it completes.</p>;
}
```

- [ ] **Step 3: Create assign-form.tsx**

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/assign-form.tsx
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { useApi } from '@/hooks/use-api';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Team { id: string; name: string }
interface User { id: string; email: string; full_name?: string }

export function AssignForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: users } = useApi<User[]>('/users', []);
  const c = node.config as { team_id?: string | null; user_id?: string | null };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">Team</Label>
        <Select
          value={c.team_id ?? ''}
          onValueChange={(v) => update(node.id, { team_id: v || null, user_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(teams ?? []).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Or user</Label>
        <Select
          value={c.user_id ?? ''}
          onValueChange={(v) => update(node.id, { user_id: v || null, team_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(users ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.full_name ?? u.email}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">Pick one or the other.</p>
    </div>
  );
}
```

- [ ] **Step 4: Create approval-form.tsx**

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/approval-form.tsx
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { useApi } from '@/hooks/use-api';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Team { id: string; name: string }
interface Person { id: string; full_name: string; email?: string }

export function ApprovalForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: persons } = useApi<Person[]>('/persons', []);
  const c = node.config as { approver_person_id?: string | null; approver_team_id?: string | null };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">Approver person</Label>
        <Select
          value={c.approver_person_id ?? ''}
          onValueChange={(v) => update(node.id, { approver_person_id: v || null, approver_team_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(persons ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Or approver team</Label>
        <Select
          value={c.approver_team_id ?? ''}
          onValueChange={(v) => update(node.id, { approver_team_id: v || null, approver_person_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(teams ?? []).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">Node pauses the workflow until the approver decides. Outgoing edges must be labeled "approved" and "rejected".</p>
    </div>
  );
}
```

- [ ] **Step 5: Create notification-form.tsx**

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/notification-form.tsx
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export function NotificationForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { subject?: string; body?: string; notification_type?: string };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">Type</Label>
        <Input value={c.notification_type ?? ''} onChange={(e) => update(node.id, { notification_type: e.target.value })} disabled={readOnly} />
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Subject</Label>
        <Input value={c.subject ?? ''} onChange={(e) => update(node.id, { subject: e.target.value })} disabled={readOnly} />
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Body</Label>
        <Textarea value={c.body ?? ''} onChange={(e) => update(node.id, { body: e.target.value })} rows={4} disabled={readOnly} />
      </div>
    </div>
  );
}
```

If `textarea` component doesn't exist in `components/ui/`, install it: `npx shadcn@latest add textarea` (from repo root).

- [ ] **Step 6: Create condition-form.tsx**

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/condition-form.tsx
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const TICKET_FIELDS = ['priority', 'status', 'status_category', 'interaction_mode', 'source_channel'] as const;

export function ConditionForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { field?: string; operator?: string; value?: unknown };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">Ticket field</Label>
        <Select value={c.field ?? ''} onValueChange={(v) => update(node.id, { field: v })} disabled={readOnly}>
          <SelectTrigger><SelectValue placeholder="Select field" /></SelectTrigger>
          <SelectContent>
            {TICKET_FIELDS.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Operator</Label>
        <Select value={c.operator ?? 'equals'} onValueChange={(v) => update(node.id, { operator: v })} disabled={readOnly}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="equals">equals</SelectItem>
            <SelectItem value="not_equals">not equals</SelectItem>
            <SelectItem value="in">in (comma-separated)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Value</Label>
        <Input
          value={Array.isArray(c.value) ? (c.value as string[]).join(',') : String(c.value ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            update(node.id, { value: c.operator === 'in' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v });
          }}
          disabled={readOnly}
        />
      </div>
      <p className="text-xs text-muted-foreground">Requires "true" and "false" outgoing edges.</p>
    </div>
  );
}
```

- [ ] **Step 7: Create update-ticket-form.tsx, create-child-tasks-form.tsx, wait-for-form.tsx, timer-form.tsx**

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/update-ticket-form.tsx
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function UpdateTicketForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const fields = (node.config as { fields?: Record<string, unknown> }).fields ?? {};
  const text = JSON.stringify(fields, null, 2);
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">Fields (JSON)</Label>
      <Textarea
        value={text}
        onChange={(e) => {
          try { update(node.id, { fields: JSON.parse(e.target.value) }); } catch { /* wait for valid JSON */ }
        }}
        rows={6}
        className="font-mono text-xs"
        disabled={readOnly}
      />
      <p className="text-xs text-muted-foreground">e.g. {"{"}"status": "in_progress", "priority": "high"{"}"}</p>
    </div>
  );
}
```

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/create-child-tasks-form.tsx
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, Trash2 } from 'lucide-react';

interface Task { title: string; description?: string; priority?: string }

export function CreateChildTasksForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const tasks = ((node.config as { tasks?: Task[] }).tasks ?? []) as Task[];

  const setTasks = (t: Task[]) => update(node.id, { tasks: t });

  return (
    <div className="grid gap-3">
      <Label className="text-xs">Child tasks</Label>
      {tasks.map((t, i) => (
        <div key={i} className="grid gap-1 border rounded p-2">
          <Input
            value={t.title ?? ''}
            placeholder="Title"
            onChange={(e) => setTasks(tasks.map((x, j) => j === i ? { ...x, title: e.target.value } : x))}
            disabled={readOnly}
          />
          <Input
            value={t.description ?? ''}
            placeholder="Description (optional)"
            onChange={(e) => setTasks(tasks.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
            disabled={readOnly}
          />
          <Button variant="ghost" size="sm" onClick={() => setTasks(tasks.filter((_, j) => j !== i))} disabled={readOnly}>
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => setTasks([...tasks, { title: '' }])} disabled={readOnly}>
        <Plus className="h-3.5 w-3.5" /> Add task
      </Button>
    </div>
  );
}
```

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/wait-for-form.tsx
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function WaitForForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { wait_type?: string };
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">Wait type</Label>
      <Select value={c.wait_type ?? 'child_tasks'} onValueChange={(v) => update(node.id, { wait_type: v })} disabled={readOnly}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="child_tasks">Child tasks complete</SelectItem>
          <SelectItem value="status">Status change</SelectItem>
          <SelectItem value="event">External event</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
```

```tsx
// apps/web/src/components/workflow-editor/inspector-forms/timer-form.tsx
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

export function TimerForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { delay_minutes?: number };
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">Delay (minutes)</Label>
      <Input
        type="number"
        min={1}
        value={c.delay_minutes ?? 60}
        onChange={(e) => update(node.id, { delay_minutes: Number(e.target.value) })}
        disabled={readOnly}
      />
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/workflow-editor/inspector.tsx apps/web/src/components/workflow-editor/inspector-forms/
git commit -m "feat(workflow-editor): inspector with forms for all 10 node types"
```

---

## Task 9: Toolbar component + keyboard shortcuts

**Files:**
- Create: `apps/web/src/components/workflow-editor/toolbar.tsx`
- Create: `apps/web/src/components/workflow-editor/use-keyboard-shortcuts.ts`

- [ ] **Step 1: Keyboard hook**

```ts
// apps/web/src/components/workflow-editor/use-keyboard-shortcuts.ts
import { useEffect } from 'react';
import { useGraphStore } from './graph-store';

export function useKeyboardShortcuts(params: { onSave: () => void; onPublish: () => void; enabled: boolean }) {
  const del = useGraphStore((s) => s.deleteSelection);
  const copy = useGraphStore((s) => s.copySelection);
  const paste = useGraphStore((s) => s.paste);
  const dup = useGraphStore((s) => s.duplicateSelection);
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const clearSel = useGraphStore((s) => s.setSelection);

  useEffect(() => {
    if (!params.enabled) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = target && ['INPUT', 'TEXTAREA'].includes(target.tagName);
      const mod = e.metaKey || e.ctrlKey;
      if (inField && !['s', 'Enter'].includes(e.key)) return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && !inField) { e.preventDefault(); del(); }
      else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(); }
      else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); dup(); }
      else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (mod && e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); params.onSave(); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); params.onPublish(); }
      else if (e.key === 'Escape') { clearSel([]); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [params.enabled, params.onSave, params.onPublish, del, copy, paste, dup, undo, redo, clearSel]);
}
```

- [ ] **Step 2: Toolbar**

```tsx
// apps/web/src/components/workflow-editor/toolbar.tsx
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Undo2, Redo2, Save, Send, RotateCcw, FlaskConical, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useGraphStore } from './graph-store';
import { validate } from './validation';

interface ToolbarProps {
  name: string;
  status: 'draft' | 'published';
  saving: boolean;
  onSave: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onSimulate: () => void;
  onValidate: () => void;
}

export function Toolbar({ name, status, saving, onSave, onPublish, onUnpublish, onSimulate, onValidate }: ToolbarProps) {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const dirty = useGraphStore((s) => s.dirty);
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const past = useGraphStore((s) => s.past);
  const future = useGraphStore((s) => s.future);

  const errors = validate({ nodes, edges });
  const valid = errors.length === 0;
  const readOnly = status === 'published';

  return (
    <div className="flex items-center gap-2 border-b px-4 py-2 bg-background">
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{name}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <Badge variant={status === 'published' ? 'default' : 'secondary'} className="capitalize text-[10px]">{status}</Badge>
          {dirty && <span className="text-[10px] text-amber-600">● unsaved</span>}
          {valid ? (
            <span className="text-[10px] text-emerald-600 flex items-center gap-0.5"><CheckCircle2 className="h-3 w-3" /> valid</span>
          ) : (
            <button onClick={onValidate} className="text-[10px] text-red-600 flex items-center gap-0.5 hover:underline">
              <AlertTriangle className="h-3 w-3" /> {errors.length} issue(s)
            </button>
          )}
        </div>
      </div>

      <Button variant="ghost" size="sm" onClick={undo} disabled={past.length === 0 || readOnly} title="Undo (⌘Z)"><Undo2 className="h-4 w-4" /></Button>
      <Button variant="ghost" size="sm" onClick={redo} disabled={future.length === 0 || readOnly} title="Redo (⌘⇧Z)"><Redo2 className="h-4 w-4" /></Button>

      <Button variant="outline" size="sm" onClick={onSimulate} className="gap-1.5">
        <FlaskConical className="h-3.5 w-3.5" /> Simulate
      </Button>

      {status === 'draft' ? (
        <>
          <Button variant="outline" size="sm" onClick={onSave} disabled={saving || !dirty} className="gap-1.5">
            <Save className="h-3.5 w-3.5" /> {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" onClick={onPublish} disabled={saving || !valid} className="gap-1.5">
            <Send className="h-3.5 w-3.5" /> Publish
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={onUnpublish} className="gap-1.5">
          <RotateCcw className="h-3.5 w-3.5" /> Unpublish
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/workflow-editor/toolbar.tsx apps/web/src/components/workflow-editor/use-keyboard-shortcuts.ts
git commit -m "feat(workflow-editor): toolbar and keyboard shortcuts"
```

---

## Task 10: Backend — WorkflowValidatorService (TDD)

**Files:**
- Create: `apps/api/jest.config.js`
- Create: `apps/api/src/modules/workflow/workflow-validator.service.ts`
- Create: `apps/api/src/modules/workflow/workflow-validator.service.spec.ts`

- [ ] **Step 1: Bootstrap Jest config**

```js
// apps/api/jest.config.js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json' }] },
};
```

- [ ] **Step 2: Write the failing tests**

```ts
// apps/api/src/modules/workflow/workflow-validator.service.spec.ts
import { WorkflowValidatorService } from './workflow-validator.service';

describe('WorkflowValidatorService', () => {
  const svc = new WorkflowValidatorService();

  const mkNode = (id: string, type: string, config: object = {}) => ({ id, type, config });

  it('errors when no trigger', () => {
    const res = svc.validate({ nodes: [mkNode('e', 'end')], edges: [] });
    expect(res.ok).toBe(false);
    expect(res.errors.find((e) => e.code === 'NO_TRIGGER')).toBeDefined();
  });

  it('errors when no end', () => {
    const res = svc.validate({ nodes: [mkNode('t', 'trigger')], edges: [] });
    expect(res.errors.find((e) => e.code === 'NO_END')).toBeDefined();
  });

  it('errors on dangling edges', () => {
    const res = svc.validate({
      nodes: [mkNode('t', 'trigger'), mkNode('e', 'end')],
      edges: [{ from: 't', to: 'ghost' }],
    });
    expect(res.errors.find((e) => e.code === 'DANGLING_EDGE_TO')).toBeDefined();
  });

  it('errors on unreachable node', () => {
    const res = svc.validate({
      nodes: [mkNode('t', 'trigger'), mkNode('x', 'assign', { team_id: 'team1' }), mkNode('e', 'end')],
      edges: [{ from: 't', to: 'e' }],
    });
    expect(res.errors.find((e) => e.code === 'UNREACHABLE')).toBeDefined();
  });

  it('requires true and false edges on condition nodes', () => {
    const res = svc.validate({
      nodes: [
        mkNode('t', 'trigger'),
        mkNode('c', 'condition', { field: 'priority', operator: 'equals', value: 'high' }),
        mkNode('e', 'end'),
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'e', condition: 'true' }],
    });
    expect(res.errors.find((e) => e.code === 'MISSING_FALSE_EDGE')).toBeDefined();
  });

  it('passes a minimal valid graph', () => {
    const res = svc.validate({
      nodes: [
        mkNode('t', 'trigger'),
        mkNode('a', 'assign', { team_id: 'team1' }),
        mkNode('e', 'end'),
      ],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'e' }],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('errors on assign without team or user', () => {
    const res = svc.validate({
      nodes: [mkNode('t', 'trigger'), mkNode('a', 'assign', {}), mkNode('e', 'end')],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'e' }],
    });
    expect(res.errors.find((e) => e.code === 'ASSIGN_TARGET')).toBeDefined();
  });

  it('errors on timer with delay_minutes = 0', () => {
    const res = svc.validate({
      nodes: [
        mkNode('t', 'trigger'),
        mkNode('tm', 'timer', { delay_minutes: 0 }),
        mkNode('e', 'end'),
      ],
      edges: [{ from: 't', to: 'tm' }, { from: 'tm', to: 'e' }],
    });
    expect(res.errors.find((e) => e.code === 'TIMER_DELAY')).toBeDefined();
  });
});
```

- [ ] **Step 3: Run — confirm it fails**

```bash
cd /Users/x/Desktop/XPQT/apps/api && pnpm test -- --testPathPattern workflow-validator
```
Expected: Cannot find module `./workflow-validator.service` → fail.

- [ ] **Step 4: Write the service (same rule set as client, on the server)**

```ts
// apps/api/src/modules/workflow/workflow-validator.service.ts
import { Injectable } from '@nestjs/common';

export interface ValidationError { code: string; message: string; nodeId?: string; edgeIndex?: number }
export interface ValidationResult { ok: boolean; errors: ValidationError[] }
interface Node { id: string; type: string; config: Record<string, unknown> }
interface Edge { from: string; to: string; condition?: string }
interface Graph { nodes: Node[]; edges: Edge[] }

@Injectable()
export class WorkflowValidatorService {
  validate(g: Graph): ValidationResult {
    const errors: ValidationError[] = [];
    const nodeById = new Map(g.nodes.map((n) => [n.id, n]));

    const triggers = g.nodes.filter((n) => n.type === 'trigger');
    if (triggers.length === 0) errors.push({ code: 'NO_TRIGGER', message: 'Workflow must have a trigger node' });
    if (triggers.length > 1) errors.push({ code: 'MULTIPLE_TRIGGERS', message: 'Workflow must have exactly one trigger' });
    if (g.nodes.filter((n) => n.type === 'end').length === 0) errors.push({ code: 'NO_END', message: 'Workflow must have at least one end node' });

    g.edges.forEach((e, i) => {
      if (!nodeById.has(e.from)) errors.push({ code: 'DANGLING_EDGE_FROM', message: `Edge references unknown node ${e.from}`, edgeIndex: i });
      if (!nodeById.has(e.to)) errors.push({ code: 'DANGLING_EDGE_TO', message: `Edge references unknown node ${e.to}`, edgeIndex: i });
    });

    for (const n of g.nodes) {
      const out = g.edges.filter((e) => e.from === n.id);
      if (n.type !== 'end' && out.length === 0) errors.push({ code: 'NO_OUTGOING', message: `Node "${n.type}" has no outgoing edge`, nodeId: n.id });
      if (n.type === 'condition') {
        if (!out.some((e) => e.condition === 'true')) errors.push({ code: 'MISSING_TRUE_EDGE', message: 'Condition needs a "true" branch', nodeId: n.id });
        if (!out.some((e) => e.condition === 'false')) errors.push({ code: 'MISSING_FALSE_EDGE', message: 'Condition needs a "false" branch', nodeId: n.id });
      }
      if (n.type === 'approval') {
        if (!out.some((e) => e.condition === 'approved')) errors.push({ code: 'MISSING_APPROVED_EDGE', message: 'Approval needs an "approved" branch', nodeId: n.id });
        if (!out.some((e) => e.condition === 'rejected')) errors.push({ code: 'MISSING_REJECTED_EDGE', message: 'Approval needs a "rejected" branch', nodeId: n.id });
      }
      errors.push(...this.validateNodeConfig(n));
    }

    if (triggers.length === 1) {
      const reachable = this.bfs(triggers[0].id, g.edges);
      for (const n of g.nodes) {
        if (n.type !== 'trigger' && !reachable.has(n.id)) {
          errors.push({ code: 'UNREACHABLE', message: `Node "${n.type}" is not reachable from trigger`, nodeId: n.id });
        }
      }
    }

    return { ok: errors.length === 0, errors };
  }

  private bfs(start: string, edges: Edge[]): Set<string> {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of edges) if (e.from === cur && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
    return seen;
  }

  private validateNodeConfig(n: Node): ValidationError[] {
    const errs: ValidationError[] = [];
    const c = n.config;
    const req = (code: string, msg: string, ok: boolean) => { if (!ok) errs.push({ code, message: msg, nodeId: n.id }); };
    switch (n.type) {
      case 'assign': req('ASSIGN_TARGET', 'Assign requires a team or user', !!(c.team_id || c.user_id)); break;
      case 'approval': req('APPROVAL_APPROVER', 'Approval requires an approver', !!(c.approver_person_id || c.approver_team_id)); break;
      case 'notification':
        req('NOTIFY_SUBJECT', 'Notification requires subject', typeof c.subject === 'string' && (c.subject as string).trim().length > 0);
        req('NOTIFY_BODY', 'Notification requires body', typeof c.body === 'string' && (c.body as string).trim().length > 0);
        break;
      case 'condition':
        req('COND_FIELD', 'Condition requires a field', typeof c.field === 'string' && (c.field as string).length > 0);
        req('COND_OP', 'Condition requires an operator', ['equals','not_equals','in'].includes(c.operator as string));
        break;
      case 'update_ticket':
        req('UPDATE_FIELDS', 'Update Ticket requires fields', typeof c.fields === 'object' && c.fields !== null && Object.keys(c.fields as object).length > 0);
        break;
      case 'create_child_tasks': {
        const tasks = c.tasks as Array<{ title?: string }> | undefined;
        req('CHILD_TASKS_NONEMPTY', 'Create Child Tasks requires at least one task with a title',
          Array.isArray(tasks) && tasks.length > 0 && tasks.every((t) => typeof t.title === 'string' && t.title.trim().length > 0));
        break;
      }
      case 'wait_for':
        req('WAIT_TYPE', 'Wait For requires a wait_type', ['child_tasks','status','event'].includes(c.wait_type as string));
        break;
      case 'timer':
        req('TIMER_DELAY', 'Timer requires delay_minutes > 0', typeof c.delay_minutes === 'number' && (c.delay_minutes as number) > 0);
        break;
    }
    return errs;
  }
}
```

- [ ] **Step 5: Run tests — all pass**

```bash
cd /Users/x/Desktop/XPQT/apps/api && pnpm test -- --testPathPattern workflow-validator
```
Expected: 8 passing.

- [ ] **Step 6: Commit**

```bash
git add apps/api/jest.config.js apps/api/src/modules/workflow/workflow-validator.service.ts apps/api/src/modules/workflow/workflow-validator.service.spec.ts
git commit -m "feat(workflow): add validator service with tests"
```

---

## Task 11: Backend — WorkflowService: unpublish + clone, publish with validation

**Files:**
- Modify: `apps/api/src/modules/workflow/workflow.service.ts`
- Modify: `apps/api/src/modules/workflow/workflow.controller.ts`
- Modify: `apps/api/src/modules/workflow/workflow.module.ts`

- [ ] **Step 1: Wire validator into module**

```ts
// apps/api/src/modules/workflow/workflow.module.ts
import { Module } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowValidatorService } from './workflow-validator.service';
import { WorkflowController } from './workflow.controller';

@Module({
  providers: [WorkflowService, WorkflowEngineService, WorkflowValidatorService],
  controllers: [WorkflowController],
  exports: [WorkflowService, WorkflowEngineService, WorkflowValidatorService],
})
export class WorkflowModule {}
```

- [ ] **Step 2: Extend `WorkflowService`**

Modify `apps/api/src/modules/workflow/workflow.service.ts`:

1. Inject validator:
```ts
constructor(
  private readonly supabase: SupabaseService,
  private readonly validator: WorkflowValidatorService,
) {}
```
Add import: `import { WorkflowValidatorService } from './workflow-validator.service';`

2. Replace `publish` with:
```ts
async publish(id: string) {
  const tenant = TenantContext.current();
  const wf = await this.getById(id);
  const result = this.validator.validate(wf.graph_definition as { nodes: unknown[]; edges: unknown[] } as never);
  if (!result.ok) {
    throw new BadRequestException({ message: 'Workflow is invalid', errors: result.errors });
  }
  const { data, error } = await this.supabase.admin
    .from('workflow_definitions')
    .update({ status: 'published', published_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
```
Add import: `import { BadRequestException, NotFoundException, Injectable } from '@nestjs/common';`

3. Add `unpublish`:
```ts
async unpublish(id: string) {
  const tenant = TenantContext.current();
  const { data, error } = await this.supabase.admin
    .from('workflow_definitions')
    .update({ status: 'draft', published_at: null })
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
```

4. Add `clone`:
```ts
async clone(id: string, name?: string) {
  const tenant = TenantContext.current();
  const original = await this.getById(id);
  const newGraph = this.regenerateNodeIds(original.graph_definition);
  const { data, error } = await this.supabase.admin
    .from('workflow_definitions')
    .insert({
      tenant_id: tenant.id,
      name: name ?? `${original.name} (copy)`,
      entity_type: original.entity_type,
      graph_definition: newGraph,
      status: 'draft',
      version: 1,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

private regenerateNodeIds(graph: { nodes: { id: string }[]; edges: { from: string; to: string; condition?: string }[] }) {
  const idMap = new Map<string, string>();
  const nodes = graph.nodes.map((n) => {
    const newId = `n_${Math.random().toString(36).slice(2, 10)}`;
    idMap.set(n.id, newId);
    return { ...n, id: newId };
  });
  const edges = graph.edges.map((e) => ({ ...e, from: idMap.get(e.from) ?? e.from, to: idMap.get(e.to) ?? e.to }));
  return { nodes, edges };
}
```

- [ ] **Step 3: Add controller endpoints**

Modify `apps/api/src/modules/workflow/workflow.controller.ts`, add to the existing controller class:

```ts
@Post(':id/unpublish')
async unpublish(@Param('id') id: string) {
  return this.workflowService.unpublish(id);
}

@Post(':id/clone')
async clone(@Param('id') id: string, @Body() dto?: { name?: string }) {
  return this.workflowService.clone(id, dto?.name);
}
```

- [ ] **Step 4: Smoke test**

```bash
cd /Users/x/Desktop/XPQT/apps/api && pnpm test
cd /Users/x/Desktop/XPQT && pnpm dev:api &    # background
sleep 4
curl -s -X POST http://localhost:3000/api/workflows/{existing-id}/unpublish -H "Authorization: Bearer <token>"  # substitute real id/token
kill %1 2>/dev/null || true
```
(Manual step — run in your own terminal with real tokens.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/workflow/
git commit -m "feat(workflow): unpublish + clone endpoints, publish validates"
```

---

## Task 12: Frontend — workflow API hooks

**Files:**
- Create: `apps/web/src/hooks/use-workflow.ts`

- [ ] **Step 1: Create**

```ts
// apps/web/src/hooks/use-workflow.ts
import { useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { useApi } from './use-api';
import type { WorkflowDefinition, WorkflowGraph } from '@/components/workflow-editor/types';

export function useWorkflow(id: string) {
  return useApi<WorkflowDefinition>(`/workflows/${id}`, [id]);
}

export function useWorkflowMutations(id: string) {
  const saveGraph = useCallback(async (graph: WorkflowGraph) => {
    return apiFetch<WorkflowDefinition>(`/workflows/${id}/graph`, {
      method: 'PATCH',
      body: JSON.stringify({ graph_definition: graph }),
    });
  }, [id]);

  const publish = useCallback(async () => {
    return apiFetch<WorkflowDefinition>(`/workflows/${id}/publish`, { method: 'POST' });
  }, [id]);

  const unpublish = useCallback(async () => {
    return apiFetch<WorkflowDefinition>(`/workflows/${id}/unpublish`, { method: 'POST' });
  }, [id]);

  const clone = useCallback(async (name?: string) => {
    return apiFetch<WorkflowDefinition>(`/workflows/${id}/clone`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }, [id]);

  const simulate = useCallback(async (ticket: Record<string, unknown>) => {
    return apiFetch<{
      path: string[];
      events: Array<{ event_type: string; node_id?: string; node_type?: string; decision?: string; payload?: Record<string, unknown> }>;
      terminated: boolean;
      stoppedAt?: { node_id: string; node_type: string; reason: string };
      errors?: string[];
    }>(`/workflows/${id}/simulate`, { method: 'POST', body: JSON.stringify({ ticket }) });
  }, [id]);

  return { saveGraph, publish, unpublish, clone, simulate };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/hooks/use-workflow.ts
git commit -m "feat(web): workflow API hooks"
```

---

## Task 13: Workflow editor page

**Files:**
- Create: `apps/web/src/pages/admin/workflow-editor.tsx`

- [ ] **Step 1: Write the page**

```tsx
// apps/web/src/pages/admin/workflow-editor.tsx
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ReactFlowProvider } from 'reactflow';
import { toast } from 'sonner';
import { useWorkflow, useWorkflowMutations } from '@/hooks/use-workflow';
import { useGraphStore } from '@/components/workflow-editor/graph-store';
import { Canvas } from '@/components/workflow-editor/canvas';
import { Palette } from '@/components/workflow-editor/palette';
import { Inspector } from '@/components/workflow-editor/inspector';
import { Toolbar } from '@/components/workflow-editor/toolbar';
import { useKeyboardShortcuts } from '@/components/workflow-editor/use-keyboard-shortcuts';
import { validate } from '@/components/workflow-editor/validation';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function WorkflowEditorPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: wf, loading, refetch } = useWorkflow(id);
  const { saveGraph, publish, unpublish } = useWorkflowMutations(id);

  const setGraph = useGraphStore((s) => s.setGraph);
  const toJSON = useGraphStore((s) => s.toJSON);
  const markSaved = useGraphStore((s) => s.markSaved);
  const reset = useGraphStore((s) => s.reset ?? (() => {}));

  const [saving, setSaving] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);

  useEffect(() => {
    if (wf) setGraph(wf.graph_definition ?? { nodes: [], edges: [] });
  }, [wf, setGraph]);

  const readOnly = wf?.status === 'published';

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveGraph(toJSON());
      markSaved();
      toast.success('Saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    const errs = validate(toJSON());
    if (errs.length > 0) { setErrorsOpen(true); return; }
    setSaving(true);
    try {
      await saveGraph(toJSON());
      await publish();
      toast.success('Published');
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setSaving(false);
    }
  };

  const handleUnpublish = async () => {
    if (!confirm('Unpublishing will flip this workflow back to draft. Running instances will keep working on the current graph but future edits will apply to them on their next advance. Continue?')) return;
    try {
      await unpublish();
      toast.success('Unpublished');
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Unpublish failed');
    }
  };

  useKeyboardShortcuts({ onSave: handleSave, onPublish: handlePublish, enabled: !readOnly });

  const errors = useMemo(() => validate(toJSON()), [toJSON]);  // re-derives on render; cheap for small graphs

  if (loading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!wf) return <div className="p-6">Not found. <Button variant="link" onClick={() => navigate('/admin/workflow-templates')}>Back</Button></div>;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <Toolbar
        name={wf.name}
        status={wf.status}
        saving={saving}
        onSave={handleSave}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
        onSimulate={() => toast.message('Simulate — wired in Phase C')}
        onValidate={() => setErrorsOpen(true)}
      />
      <div className="flex-1 min-h-0 flex">
        {!readOnly && <Palette />}
        <div className="flex-1 min-w-0">
          <ReactFlowProvider>
            <Canvas readOnly={readOnly} />
          </ReactFlowProvider>
        </div>
        <Inspector readOnly={readOnly} />
      </div>

      <Dialog open={errorsOpen} onOpenChange={setErrorsOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Validation</DialogTitle></DialogHeader>
          {errors.length === 0 ? (
            <p className="text-sm text-emerald-600">No issues.</p>
          ) : (
            <ul className="text-sm space-y-1 max-h-80 overflow-auto">
              {errors.map((e, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-red-600 font-mono text-xs">{e.code}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button onClick={() => setErrorsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

Note: `reset` is referenced defensively with `??`. The store doesn't currently export it — safe to remove if unused. Leave as-is; TypeScript will flag if the property truly doesn't exist and that's fine to fix inline.

Alternative: drop the `reset` line entirely — it was only in the original spec and isn't needed for the page.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/pages/admin/workflow-editor.tsx
git commit -m "feat(web): workflow editor page"
```

---

## Task 14: Wire routes and update workflow list page

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/pages/admin/workflow-templates.tsx`

- [ ] **Step 1: Add route**

In `apps/web/src/App.tsx`, add the import:

```tsx
import { WorkflowEditorPage } from '@/pages/admin/workflow-editor';
```

Add the route inside the `/admin` block, right after the existing `workflow-templates` route:

```tsx
<Route path="workflow-templates/:id" element={<WorkflowEditorPage />} />
```

- [ ] **Step 2: Update list page to add Edit / Clone actions**

Modify `apps/web/src/pages/admin/workflow-templates.tsx`:

1. Add imports:
```tsx
import { Link } from 'react-router-dom';
import { Pencil, Copy } from 'lucide-react';
```

2. Add clone handler inside the component body:
```tsx
const handleClone = async (id: string) => {
  try {
    const newWf = await apiFetch<{ id: string }>(`/workflows/${id}/clone`, { method: 'POST', body: JSON.stringify({}) });
    toast.success('Cloned');
    refetch();
    window.location.href = `/admin/workflow-templates/${newWf.id}`;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Clone failed');
  }
};
```

3. Remove the "Visual workflow builder coming in Phase 3." banner block entirely.

4. Add action buttons to the last `<TableCell>` of each row, before the Publish button:

```tsx
<div className="flex items-center gap-1">
  <Button asChild variant="outline" size="sm" className="gap-1.5 h-7">
    <Link to={`/admin/workflow-templates/${wf.id}`}>
      <Pencil className="h-3.5 w-3.5" /> {wf.status === 'draft' ? 'Edit' : 'View'}
    </Link>
  </Button>
  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => handleClone(wf.id)} title="Clone">
    <Copy className="h-3.5 w-3.5" />
  </Button>
  {wf.status === 'draft' && (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5 h-7"
      onClick={() => handlePublish(wf.id)}
      disabled={publishing === wf.id}
    >
      <Send className="h-3.5 w-3.5" />
      {publishing === wf.id ? 'Publishing...' : 'Publish'}
    </Button>
  )}
</div>
```

- [ ] **Step 3: Install `shadcn` asChild support if missing**

Most shadcn Button setups include `asChild`. If compilation fails on `<Button asChild>`, the project's Button doesn't support `asChild`; replace that block with:

```tsx
<Button variant="outline" size="sm" className="gap-1.5 h-7" onClick={() => window.location.assign(`/admin/workflow-templates/${wf.id}`)}>
  <Pencil className="h-3.5 w-3.5" /> {wf.status === 'draft' ? 'Edit' : 'View'}
</Button>
```

- [ ] **Step 4: Manual smoke**

```bash
cd /Users/x/Desktop/XPQT && pnpm dev
```
Open `/admin/workflow-templates`, click Edit on a draft, verify editor loads, add nodes from palette, connect them, save, publish. Verify validation dialog blocks publish on an invalid graph.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/pages/admin/workflow-templates.tsx
git commit -m "feat(web): wire workflow editor route and list page actions"
```

---

## Task 15: Phase A checkpoint — full smoke

- [ ] **Step 1: Run the app**

```bash
cd /Users/x/Desktop/XPQT && pnpm dev
```

- [ ] **Step 2: Verify end-to-end**

1. Navigate to `/admin/workflow-templates`, create a new workflow via the dialog.
2. Click **Edit** on the new row — editor opens with the seed trigger→end graph.
3. From palette: Add Assign. Connect trigger → Assign → End (remove the old trigger→end edge first via clicking + Delete).
4. Configure Assign to a team in the inspector.
5. Save — toolbar "● unsaved" disappears.
6. Add a Condition node. Verify the editor shows two output handles labeled "true"/"false".
7. Connect Condition → End on true branch. Publish — should fail with "needs false branch".
8. Add another End, connect false branch, Publish — should succeed.
9. Back on list page, click **Clone** → navigates to a new draft.
10. On the published workflow, enter editor — it's read-only with "Unpublish" button. Click it — now editable again.

Any failure → fix inline, don't skip.

---

# Phase B — Execution History + Runtime Viewer

## Task 16: Migration — workflow_instance_events

**Files:**
- Create: `supabase/migrations/00026_workflow_instance_events.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/00026_workflow_instance_events.sql
create table public.workflow_instance_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  workflow_instance_id uuid not null references public.workflow_instances(id) on delete cascade,
  event_type text not null check (event_type in (
    'node_entered', 'node_exited', 'decision_made',
    'instance_started', 'instance_completed', 'instance_failed',
    'instance_waiting', 'instance_resumed'
  )),
  node_id text,
  node_type text,
  decision text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.workflow_instance_events enable row level security;

create policy "tenant_isolation" on public.workflow_instance_events
  using (tenant_id = public.current_tenant_id());

create index idx_wie_instance_time
  on public.workflow_instance_events (workflow_instance_id, created_at);
create index idx_wie_tenant on public.workflow_instance_events (tenant_id);
```

- [ ] **Step 2: Apply locally (safe)**

```bash
cd /Users/x/Desktop/XPQT && pnpm db:reset
```
Expected: applies all migrations including 00026 with no errors.

- [ ] **Step 3: Ask user before pushing to remote**

> "Migration `00026_workflow_instance_events.sql` applies cleanly locally. Ready to push to the remote Supabase project with `pnpm db:push`? (The running dev app talks to the remote DB — without this, engine event writes will 500.)"

Wait for user approval. Do **not** run `pnpm db:push` without it. If `pnpm db:push` fails due to CLI auth issues, fall back to the psql path documented in `CLAUDE.md`.

- [ ] **Step 4: After push — notify PostgREST**

```bash
PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "NOTIFY pgrst, 'reload schema';"
```
(User provides the password.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00026_workflow_instance_events.sql
git commit -m "db: add workflow_instance_events table"
```

---

## Task 17: Engine instrumentation — emit events

**Files:**
- Modify: `apps/api/src/modules/workflow/workflow-engine.service.ts`

- [ ] **Step 1: Add event emission helper to the engine**

In `workflow-engine.service.ts`, add this private method inside the class:

```ts
private async emit(
  instanceId: string,
  event_type: string,
  fields: { node_id?: string; node_type?: string; decision?: string; payload?: Record<string, unknown> } = {},
) {
  const tenant = TenantContext.current();
  await this.supabase.admin.from('workflow_instance_events').insert({
    tenant_id: tenant.id,
    workflow_instance_id: instanceId,
    event_type,
    node_id: fields.node_id ?? null,
    node_type: fields.node_type ?? null,
    decision: fields.decision ?? null,
    payload: fields.payload ?? {},
  });
}
```

- [ ] **Step 2: Emit events at the right points**

Modify the engine methods:

- In `startForTicket`, after creating the instance: `await this.emit(instance.id, 'instance_started', { node_id: triggerNode.id, node_type: 'trigger' });`
- In `executeNode`, at the top before the `switch`: `await this.emit(instanceId, 'node_entered', { node_id: node.id, node_type: node.type });`
- In `executeNode`'s `case 'condition'`, after computing `result`: `await this.emit(instanceId, 'decision_made', { node_id: node.id, node_type: 'condition', decision: result });`
- In `executeNode`'s `case 'approval'`, after the insert and the status update: `await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'approval', payload: { waiting_for: 'approval' } });`
- In `executeNode`'s `case 'wait_for'`: `await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'wait_for', payload: { wait_type: node.config.wait_type } });`
- In `executeNode`'s `case 'timer'`: `await this.emit(instanceId, 'instance_waiting', { node_id: node.id, node_type: 'timer', payload: { resume_at: resumeAt.toISOString() } });`
- In `executeNode`'s `case 'end'`: `await this.emit(instanceId, 'instance_completed', { node_id: node.id, node_type: 'end' });`
- In `resume`, after marking active: `await this.emit(instanceId, 'instance_resumed', { payload: { edge_condition: edgeCondition } });`

Each emission is best-effort — if the events table is missing (migration not pushed), the engine must still function. Wrap each `.emit(...)` call in a `try { … } catch { /* ignore */ }` **block** — or wrap inside `emit` itself:

```ts
private async emit(...) {
  try {
    // insert
  } catch {
    // events are best-effort
  }
}
```

Put the try/catch inside `emit` (single point of failure tolerance). Makes the call sites clean.

- [ ] **Step 3: Smoke test**

Start the app, run a workflow against a real ticket, inspect `workflow_instance_events` in Supabase — rows should appear.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/workflow/workflow-engine.service.ts
git commit -m "feat(workflow-engine): emit execution events"
```

---

## Task 18: Backend — instance events endpoint

**Files:**
- Modify: `apps/api/src/modules/workflow/workflow.service.ts`
- Modify: `apps/api/src/modules/workflow/workflow.controller.ts`

- [ ] **Step 1: Add `listInstanceEvents`**

In `workflow.service.ts`:

```ts
async listInstanceEvents(instanceId: string) {
  const tenant = TenantContext.current();
  const { data, error } = await this.supabase.admin
    .from('workflow_instance_events')
    .select('*')
    .eq('workflow_instance_id', instanceId)
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

async getInstance(instanceId: string) {
  const tenant = TenantContext.current();
  const { data, error } = await this.supabase.admin
    .from('workflow_instances')
    .select('*, definition:workflow_definitions(*)')
    .eq('id', instanceId)
    .eq('tenant_id', tenant.id)
    .single();
  if (error || !data) throw new NotFoundException('Instance not found');
  return data;
}
```

- [ ] **Step 2: Add controller endpoints**

In `workflow.controller.ts`:

```ts
@Get('instances/:id')
async getInstance(@Param('id') id: string) {
  return this.workflowService.getInstance(id);
}

@Get('instances/:id/events')
async listEvents(@Param('id') id: string) {
  return this.workflowService.listInstanceEvents(id);
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/workflow/
git commit -m "feat(workflow): instance + events endpoints"
```

---

## Task 19: Frontend — history timeline + runtime viewer

**Files:**
- Create: `apps/web/src/components/workflow-editor/history-timeline.tsx`
- Create: `apps/web/src/components/workflow-editor/runtime-viewer.tsx`
- Create: `apps/web/src/pages/admin/workflow-instance.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Timeline component**

```tsx
// apps/web/src/components/workflow-editor/history-timeline.tsx
import { ArrowRight, CheckCircle, Pause, Play, AlertCircle, GitBranch } from 'lucide-react';

export interface InstanceEvent {
  id: string;
  event_type: string;
  node_id: string | null;
  node_type: string | null;
  decision: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

const iconFor = (type: string) => {
  switch (type) {
    case 'instance_started': return Play;
    case 'instance_completed': return CheckCircle;
    case 'instance_waiting': return Pause;
    case 'instance_resumed': return Play;
    case 'instance_failed': return AlertCircle;
    case 'decision_made': return GitBranch;
    default: return ArrowRight;
  }
};

export function HistoryTimeline({ events }: { events: InstanceEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-muted-foreground">No events yet.</p>;

  return (
    <ol className="space-y-2">
      {events.map((e) => {
        const Icon = iconFor(e.event_type);
        return (
          <li key={e.id} className="flex items-start gap-2 text-sm">
            <Icon className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{labelFor(e)}</span>
                <time className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleTimeString()}</time>
              </div>
              {e.decision && <div className="text-xs text-muted-foreground">Decision: {e.decision}</div>}
              {e.payload && Object.keys(e.payload).length > 0 && (
                <pre className="text-[11px] text-muted-foreground mt-0.5 font-mono">{JSON.stringify(e.payload)}</pre>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function labelFor(e: InstanceEvent): string {
  if (e.event_type === 'instance_started') return 'Workflow started';
  if (e.event_type === 'instance_completed') return 'Workflow completed';
  if (e.event_type === 'instance_failed') return 'Workflow failed';
  if (e.event_type === 'instance_waiting') return `Waiting at ${e.node_type ?? '—'}`;
  if (e.event_type === 'instance_resumed') return 'Resumed';
  if (e.event_type === 'decision_made') return `Decision at ${e.node_type ?? '—'}`;
  if (e.event_type === 'node_entered') return `Entered ${e.node_type ?? '—'}`;
  if (e.event_type === 'node_exited') return `Exited ${e.node_type ?? '—'}`;
  return e.event_type;
}
```

- [ ] **Step 2: Runtime viewer**

```tsx
// apps/web/src/components/workflow-editor/runtime-viewer.tsx
import { useEffect, useMemo } from 'react';
import { ReactFlowProvider } from 'reactflow';
import { Canvas } from './canvas';
import { useGraphStore } from './graph-store';
import type { WorkflowGraph } from './types';
import type { InstanceEvent } from './history-timeline';

export interface RuntimeViewerProps {
  graph: WorkflowGraph;
  events: InstanceEvent[];
  currentNodeId: string | null;
}

export function RuntimeViewer({ graph, events, currentNodeId }: RuntimeViewerProps) {
  const setGraph = useGraphStore((s) => s.setGraph);

  useEffect(() => { setGraph(graph); }, [graph, setGraph]);

  const runtime = useMemo(() => {
    const visited = new Set<string>();
    for (const e of events) if (e.event_type === 'node_entered' && e.node_id) visited.add(e.node_id);
    const map: Record<string, 'visited' | 'current' | 'upcoming'> = {};
    for (const n of graph.nodes) {
      if (n.id === currentNodeId) map[n.id] = 'current';
      else if (visited.has(n.id)) map[n.id] = 'visited';
      else map[n.id] = 'upcoming';
    }
    return map;
  }, [events, currentNodeId, graph.nodes]);

  return (
    <ReactFlowProvider>
      <Canvas readOnly runtime={runtime} />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 3: Instance page**

```tsx
// apps/web/src/pages/admin/workflow-instance.tsx
import { useParams, Link } from 'react-router-dom';
import { useApi } from '@/hooks/use-api';
import { RuntimeViewer } from '@/components/workflow-editor/runtime-viewer';
import { HistoryTimeline, type InstanceEvent } from '@/components/workflow-editor/history-timeline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Instance {
  id: string;
  status: string;
  current_node_id: string | null;
  definition: { id: string; name: string; graph_definition: { nodes: []; edges: [] } };
  started_at: string;
  completed_at: string | null;
}

export function WorkflowInstancePage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data: instance, loading: l1 } = useApi<Instance>(`/workflows/instances/${id}`, [id]);
  const { data: events } = useApi<InstanceEvent[]>(`/workflows/instances/${id}/events`, [id]);

  if (l1 || !instance) return <div className="p-6 text-muted-foreground">Loading…</div>;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="border-b px-4 py-2 flex items-center gap-3">
        <Button variant="link" size="sm" asChild><Link to={`/admin/workflow-templates/${instance.definition.id}`}>← Definition</Link></Button>
        <div className="font-semibold">{instance.definition.name}</div>
        <Badge variant="outline" className="capitalize">{instance.status}</Badge>
      </div>
      <div className="flex-1 grid grid-cols-[1fr_320px] min-h-0">
        <div className="min-w-0">
          <RuntimeViewer
            graph={instance.definition.graph_definition as { nodes: []; edges: [] } as never}
            events={events ?? []}
            currentNodeId={instance.current_node_id}
          />
        </div>
        <aside className="border-l p-4 overflow-auto">
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Timeline</div>
          <HistoryTimeline events={events ?? []} />
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add route**

In `apps/web/src/App.tsx`, inside the `/admin` block:

```tsx
<Route path="workflow-templates/instances/:id" element={<WorkflowInstancePage />} />
```

And import: `import { WorkflowInstancePage } from '@/pages/admin/workflow-instance';`

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/workflow-editor/history-timeline.tsx apps/web/src/components/workflow-editor/runtime-viewer.tsx apps/web/src/pages/admin/workflow-instance.tsx apps/web/src/App.tsx
git commit -m "feat(web): runtime viewer + history timeline for workflow instances"
```

---

## Task 20: Embed workflow viewer in ticket detail

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

- [ ] **Step 1: Find the tabs section in `ticket-detail.tsx`**

```bash
grep -n "TabsTrigger\|TabsList" /Users/x/Desktop/XPQT/apps/web/src/components/desk/ticket-detail.tsx | head -20
```

The file uses shadcn Tabs. Identify the tabs pattern then add a new tab conditionally on whether the ticket has a workflow instance.

- [ ] **Step 2: Add the tab**

Near the other `TabsTrigger` elements, add:

```tsx
{workflowInstanceId && <TabsTrigger value="workflow">Workflow</TabsTrigger>}
```

And near the other `TabsContent` elements:

```tsx
{workflowInstanceId && (
  <TabsContent value="workflow">
    <WorkflowInstanceEmbed instanceId={workflowInstanceId} />
  </TabsContent>
)}
```

Fetch the instance id via a new `useApi` call at the top of the component:

```tsx
const { data: instances } = useApi<Array<{ id: string }>>(`/workflows/instances/ticket/${ticketId}`, [ticketId]);
const workflowInstanceId = instances?.[0]?.id;
```

- [ ] **Step 3: Write `WorkflowInstanceEmbed`**

Create `apps/web/src/components/workflow-editor/workflow-instance-embed.tsx`:

```tsx
import { useApi } from '@/hooks/use-api';
import { RuntimeViewer } from './runtime-viewer';
import { HistoryTimeline, type InstanceEvent } from './history-timeline';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';

interface Instance {
  id: string;
  status: string;
  current_node_id: string | null;
  definition: { id: string; name: string; graph_definition: { nodes: []; edges: [] } };
}

export function WorkflowInstanceEmbed({ instanceId }: { instanceId: string }) {
  const { data: instance, loading } = useApi<Instance>(`/workflows/instances/${instanceId}`, [instanceId]);
  const { data: events } = useApi<InstanceEvent[]>(`/workflows/instances/${instanceId}/events`, [instanceId]);

  if (loading || !instance) return <div className="p-4 text-muted-foreground text-sm">Loading workflow…</div>;

  return (
    <div className="grid grid-cols-[1fr_280px] gap-4 h-[500px]">
      <div className="min-w-0 rounded-md border overflow-hidden">
        <RuntimeViewer
          graph={instance.definition.graph_definition as { nodes: []; edges: [] } as never}
          events={events ?? []}
          currentNodeId={instance.current_node_id}
        />
      </div>
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">{instance.definition.name}</span>
          <Link to={`/admin/workflow-templates/instances/${instance.id}`} className="text-xs text-muted-foreground hover:underline flex items-center gap-0.5">
            Open <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
        <HistoryTimeline events={events ?? []} />
      </div>
    </div>
  );
}
```

Import it in `ticket-detail.tsx`: `import { WorkflowInstanceEmbed } from '@/components/workflow-editor/workflow-instance-embed';`

- [ ] **Step 4: Manual smoke**

Run `pnpm dev`, open a ticket with a running workflow, verify the Workflow tab renders the viewer + timeline.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx apps/web/src/components/workflow-editor/workflow-instance-embed.tsx
git commit -m "feat(desk): embed workflow runtime viewer in ticket detail"
```

---

## Task 21: Phase B checkpoint

- [ ] **Step 1: End-to-end verification**

1. Run workflow against a ticket via `POST /workflows/:id/start/:ticketId`.
2. Open `/admin/workflow-templates/instances/<instance-id>` — canvas shows current node highlighted, timeline on right.
3. Resume approval via the approvals UI — runtime viewer updates on reload.
4. Open the ticket's detail drawer — Workflow tab shows the same.

---

# Phase C — Dry-run Simulator

## Task 22: Refactor engine to accept a run context with dryRun

**Files:**
- Modify: `apps/api/src/modules/workflow/workflow-engine.service.ts`

This refactor is invasive; do it in small edits.

- [ ] **Step 1: Add `WorkflowRunContext` type at top of file**

```ts
interface WorkflowRunContext {
  dryRun: boolean;
  simulatedTicket?: Record<string, unknown>;
  events: Array<{
    event_type: string;
    node_id?: string;
    node_type?: string;
    decision?: string;
    payload?: Record<string, unknown>;
  }>;
  path: string[];
  stoppedAt?: { node_id: string; node_type: string; reason: string };
}
```

- [ ] **Step 2: Thread context through `advance` and `executeNode`**

Change signatures:
- `advance(instanceId: string, graph: WorkflowGraph, fromNodeId: string, ticketId: string, edgeCondition?: string, ctx?: WorkflowRunContext)`
- `executeNode(instanceId: string, graph: WorkflowGraph, node: WorkflowNode, ticketId: string, ctx?: WorkflowRunContext)`

Pass `ctx` in every recursive call (in `advance` after picking next node, and from `startForTicket`).

Default `ctx` to `{ dryRun: false, events: [], path: [] }` when not provided.

- [ ] **Step 3: Replace `emit` with context-aware version**

```ts
private async emit(
  instanceId: string,
  event_type: string,
  fields: { node_id?: string; node_type?: string; decision?: string; payload?: Record<string, unknown> } = {},
  ctx?: WorkflowRunContext,
) {
  if (ctx?.dryRun) {
    ctx.events.push({ event_type, ...fields });
    return;
  }
  try {
    const tenant = TenantContext.current();
    await this.supabase.admin.from('workflow_instance_events').insert({
      tenant_id: tenant.id,
      workflow_instance_id: instanceId,
      event_type,
      node_id: fields.node_id ?? null,
      node_type: fields.node_type ?? null,
      decision: fields.decision ?? null,
      payload: fields.payload ?? {},
    });
  } catch { /* best-effort */ }
}
```

Pass `ctx` to each existing `emit()` call site.

- [ ] **Step 4: Guard all DB writes behind `!ctx?.dryRun`**

In each case of `executeNode`, wrap write operations:

- `assign` → `if (!ctx?.dryRun && (teamId || userId)) await this.supabase...` — in dryRun, skip writes; still `advance`.
- `update_ticket` → `if (!ctx?.dryRun) await this.supabase...`
- `notification` → `if (!ctx?.dryRun) await this.supabase.admin.from('notifications').insert(...)`
- `condition` — when dryRun, read `ctx.simulatedTicket` instead of querying DB:
  ```ts
  const ticket = ctx?.dryRun
    ? ctx.simulatedTicket as Record<string, unknown> | undefined
    : (await this.supabase.admin.from('tickets').select('*').eq('id', ticketId).single()).data;
  ```
- `create_child_tasks` → skip writes in dryRun but emit an event: `await this.emit(instanceId, 'dry_run_would_create_tasks', { node_id: node.id, payload: { count: tasks?.length } }, ctx);`
- `approval`, `wait_for`, `timer` → in dryRun, push `stoppedAt` on ctx and return without inserting rows or updating the instance:
  ```ts
  if (ctx?.dryRun) {
    ctx.stoppedAt = { node_id: node.id, node_type: node.type, reason: node.type };
    return;
  }
  ```
- `end` → in dryRun, don't update the instance row.

- [ ] **Step 5: Track path**

At the top of `executeNode`, after the first `emit('node_entered')`:

```ts
if (ctx) ctx.path.push(node.id);
```

- [ ] **Step 6: Smoke — run existing non-dry flow still works**

```bash
cd /Users/x/Desktop/XPQT/apps/api && pnpm build
```
Start the app, run a real workflow — should behave identically to before.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/workflow/workflow-engine.service.ts
git commit -m "refactor(workflow-engine): thread run context, add dryRun mode"
```

---

## Task 23: WorkflowSimulatorService + simulate endpoint

**Files:**
- Create: `apps/api/src/modules/workflow/workflow-simulator.service.ts`
- Modify: `apps/api/src/modules/workflow/workflow.module.ts`
- Modify: `apps/api/src/modules/workflow/workflow.controller.ts`

- [ ] **Step 1: Simulator service**

```ts
// apps/api/src/modules/workflow/workflow-simulator.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { WorkflowEngineService } from './workflow-engine.service';

@Injectable()
export class WorkflowSimulatorService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly engine: WorkflowEngineService,
  ) {}

  async simulate(workflowId: string, simulatedTicket: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { data: definition } = await this.supabase.admin
      .from('workflow_definitions')
      .select('*')
      .eq('id', workflowId)
      .eq('tenant_id', tenant.id)
      .single();
    if (!definition) throw new NotFoundException('Workflow not found');

    const graph = definition.graph_definition as { nodes: Array<{ id: string; type: string }>; edges: [] };
    const trigger = graph.nodes.find((n) => n.type === 'trigger');
    if (!trigger) return { path: [], events: [], terminated: false, errors: ['NO_TRIGGER'] };

    const ctx = { dryRun: true, simulatedTicket, events: [], path: [] as string[], stoppedAt: undefined };
    // Reuse engine: invoke advance from the trigger with a synthetic instance id.
    await (this.engine as unknown as { advance: (a: string, b: unknown, c: string, d: string, e?: string, f?: unknown) => Promise<void> })
      .advance('dry-run', graph, trigger.id, 'dry-run', undefined, ctx);

    return {
      path: ctx.path,
      events: ctx.events,
      terminated: !ctx.stoppedAt && ctx.events.some((e: { event_type: string }) => e.event_type === 'instance_completed'),
      stoppedAt: ctx.stoppedAt,
    };
  }
}
```

- [ ] **Step 2: Register in module**

```ts
// workflow.module.ts — add to providers, imports, exports
import { WorkflowSimulatorService } from './workflow-simulator.service';
// ...
providers: [WorkflowService, WorkflowEngineService, WorkflowValidatorService, WorkflowSimulatorService],
exports:   [WorkflowService, WorkflowEngineService, WorkflowValidatorService, WorkflowSimulatorService],
```

- [ ] **Step 3: Controller endpoint**

In `workflow.controller.ts`:

```ts
import { WorkflowSimulatorService } from './workflow-simulator.service';
// ...
constructor(
  private readonly workflowService: WorkflowService,
  private readonly engineService: WorkflowEngineService,
  private readonly simulatorService: WorkflowSimulatorService,
) {}

@Post(':id/simulate')
async simulate(@Param('id') id: string, @Body() dto: { ticket: Record<string, unknown> }) {
  return this.simulatorService.simulate(id, dto.ticket ?? {});
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/workflow/
git commit -m "feat(workflow): simulator service + endpoint"
```

---

## Task 24: Simulate panel in editor

**Files:**
- Create: `apps/web/src/components/workflow-editor/simulate-panel.tsx`
- Modify: `apps/web/src/pages/admin/workflow-editor.tsx`

- [ ] **Step 1: Simulate panel**

```tsx
// apps/web/src/components/workflow-editor/simulate-panel.tsx
import { useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { HistoryTimeline, type InstanceEvent } from './history-timeline';
import { useGraphStore } from './graph-store';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRun: (ticket: Record<string, unknown>) => Promise<{
    path: string[];
    events: Array<{ event_type: string; node_id?: string; node_type?: string; decision?: string; payload?: Record<string, unknown> }>;
    terminated: boolean;
    stoppedAt?: { node_id: string; node_type: string; reason: string };
  }>;
}

export function SimulatePanel({ open, onOpenChange, onRun }: Props) {
  const nodes = useGraphStore((s) => s.nodes);

  const fields = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.type === 'condition') {
      const f = (n.config as { field?: string }).field;
      if (f) set.add(f);
    }
    return Array.from(set);
  }, [nodes]);

  const [ticket, setTicket] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Awaited<ReturnType<typeof onRun>> | null>(null);
  const [running, setRunning] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    try {
      setResult(await onRun(ticket));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[480px] sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle>Simulate workflow</SheetTitle>
        </SheetHeader>
        <div className="grid gap-3 py-4">
          {fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">This workflow has no condition nodes; simulation will follow the default path.</p>
          ) : (
            fields.map((f) => (
              <div key={f} className="grid gap-1.5">
                <Label className="text-xs">{f}</Label>
                <Input
                  value={ticket[f] ?? ''}
                  onChange={(e) => setTicket({ ...ticket, [f]: e.target.value })}
                  placeholder={`ticket.${f}`}
                />
              </div>
            ))
          )}
          <Button onClick={handleRun} disabled={running}>{running ? 'Running…' : 'Run simulation'}</Button>
        </div>

        {result && (
          <div className="mt-4 border-t pt-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold">Result</span>
              {result.terminated
                ? <span className="text-xs text-emerald-600">Reached end</span>
                : result.stoppedAt
                  ? <span className="text-xs text-amber-600">Stopped at {result.stoppedAt.node_type}</span>
                  : <span className="text-xs text-muted-foreground">Incomplete</span>
              }
            </div>
            <p className="text-xs text-muted-foreground mb-2">Path: {result.path.length} node(s)</p>
            <HistoryTimeline events={result.events.map((e, i) => ({ ...e, id: String(i), created_at: new Date().toISOString(), decision: e.decision ?? null, node_id: e.node_id ?? null, node_type: e.node_type ?? null, payload: e.payload ?? {} })) as InstanceEvent[]} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

If `sheet` component isn't installed: `npx shadcn@latest add sheet` (from repo root).

- [ ] **Step 2: Wire into editor page**

In `apps/web/src/pages/admin/workflow-editor.tsx`:

1. Add import:
```tsx
import { SimulatePanel } from '@/components/workflow-editor/simulate-panel';
```

2. Add state:
```tsx
const [simOpen, setSimOpen] = useState(false);
```

3. Destructure `simulate` from mutations:
```tsx
const { saveGraph, publish, unpublish, simulate } = useWorkflowMutations(id);
```

4. Replace `onSimulate={() => toast.message('Simulate — wired in Phase C')}` with `onSimulate={() => setSimOpen(true)}`.

5. Render the panel at the end of the return JSX:
```tsx
<SimulatePanel open={simOpen} onOpenChange={setSimOpen} onRun={async (ticket) => {
  await saveGraph(toJSON());      // ensure latest graph on server
  markSaved();
  return simulate(ticket);
}} />
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/workflow-editor/simulate-panel.tsx apps/web/src/pages/admin/workflow-editor.tsx
git commit -m "feat(workflow-editor): simulate panel with dry-run path preview"
```

---

## Task 25: Phase C checkpoint + final verification

- [ ] **Step 1: End-to-end — edit + publish + simulate**

1. Open an existing workflow in the editor.
2. Click Simulate. Fill in condition fields. Run.
3. Verify the result panel shows the path and events, and the stopping point if an approval is on the path.
4. Change a condition value, re-run, verify the path differs.

- [ ] **Step 2: Regression — published workflow still executes**

Start a real workflow against a ticket, verify events still land in `workflow_instance_events`, and the runtime viewer reflects current state.

- [ ] **Step 3: Final commit pass / cleanup**

```bash
cd /Users/x/Desktop/XPQT && git status
```
If any untracked files left from the work, review and commit or delete.

---

# Self-review notes

This plan was checked against `docs/superpowers/specs/2026-04-17-workflows-visual-editor-design.md` before saving. Mapping of spec sections to tasks:

- §6.1–6.3 graph JSON shape → Task 2 (types), Task 4 (store serializes to this shape), Task 10 (server trusts this shape)
- §6.4 new migration → Task 16
- §7.1 validator → Task 10 (TDD'd)
- §7.2 unpublish/clone/listInstanceEvents → Tasks 11, 18
- §7.3 event emission + dryRun → Tasks 17, 22
- §7.4 simulator service → Task 23
- §7.5 controller endpoints → Tasks 11, 18, 23
- §8 frontend architecture & file layout → Tasks 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14
- §9 UI design (layout, node visual, inspector, validation UX, shortcuts) → Tasks 5, 6, 7, 8, 9, 13
- §10 lifecycle → Tasks 11, 13, 14
- §11 runtime viewer → Task 19
- §12 execution history → Tasks 16, 17, 18, 19, 20
- §13 simulate → Tasks 22, 23, 24
- §14 clone → Task 11 (backend), Task 14 (UI action)
- §15 testing approach → Task 10 covers the validator; other tests deferred per pragmatic scope (engine dry-run covered by Task 25 E2E smoke)
- §16 phased delivery → directly maps to Phase A / B / C groupings above
- §18 file list → matches all Create/Modify headers

Known plan deferrals vs spec:
- Full Vitest frontend test suite (spec §15) — not set up in this repo. The validator's logic is covered server-side (Task 10). Adding a Vitest harness would be a separate plan.
- Condition operator `in` supports comma-separated entry in `condition-form.tsx`; richer array input UX is non-goal.
- `reset()` method referenced in editor page defensively (`s.reset ?? (() => {})`) — store doesn't export it; remove that line if TypeScript flags it (noted inline in Task 13 Step 1).
