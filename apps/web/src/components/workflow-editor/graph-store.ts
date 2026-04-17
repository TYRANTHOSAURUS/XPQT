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
