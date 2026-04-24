import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { SpaceTreeNode } from '@/api/spaces';
import { pathTo } from './build-tree';

export interface SpaceTreeState {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  expandedIds: Set<string>;
  toggleExpanded: (id: string) => void;
  expandPath: (ids: string[]) => void;
  collapseAllDeep: () => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  mode: 'tree' | 'flat';
  setMode: (m: 'tree' | 'flat') => void;
}

const INITIAL_EXPANDED_TYPES = new Set(['site', 'building']);

export function useSpaceTreeState(tree: SpaceTreeNode[]): SpaceTreeState {
  const { spaceId } = useParams<{ spaceId?: string }>();
  const navigate = useNavigate();

  const setSelectedId = useCallback((id: string | null) => {
    navigate(id ? `/admin/locations/${id}` : '/admin/locations', { replace: false });
  }, [navigate]);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [mode, setMode] = useState<'tree' | 'flat'>('tree');

  // Seed: expand all site + building nodes once, the first time the tree loads.
  useEffect(() => {
    if (tree.length === 0 || expandedIds.size > 0) return;
    const seed = new Set<string>();
    const walk = (nodes: SpaceTreeNode[]) => {
      for (const n of nodes) {
        if (INITIAL_EXPANDED_TYPES.has(n.type)) seed.add(n.id);
        walk(n.children);
      }
    };
    walk(tree);
    setExpandedIds(seed);
  }, [tree, expandedIds.size]);

  // When selectedId changes from URL, auto-expand the path to it.
  useEffect(() => {
    if (!spaceId || tree.length === 0) return;
    const path = pathTo(tree, spaceId);
    if (path.length === 0) return;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const n of path) if (n.id !== spaceId) next.add(n.id);
      return next;
    });
  }, [spaceId, tree]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const expandPath = useCallback((ids: string[]) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const collapseAllDeep = useCallback(() => {
    setExpandedIds(new Set());
  }, []);

  return useMemo(() => ({
    selectedId: spaceId ?? null,
    setSelectedId,
    expandedIds,
    toggleExpanded,
    expandPath,
    collapseAllDeep,
    searchQuery,
    setSearchQuery,
    mode,
    setMode,
  }), [spaceId, setSelectedId, expandedIds, toggleExpanded, expandPath, collapseAllDeep, searchQuery, mode]);
}
