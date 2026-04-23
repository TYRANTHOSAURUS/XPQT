import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useGraphStore } from './graph-store';
import { NODE_TYPE_LIST } from './node-types';
import { cn } from '@/lib/utils';
import {
  Trash2, Copy, Files, Undo2, Redo2, Plus, ChevronRight, SlidersHorizontal,
} from 'lucide-react';

type MenuMode = 'node' | 'pane';

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  mode: MenuMode;
}

const initial: MenuState = { open: false, x: 0, y: 0, mode: 'pane' };

/**
 * Hook that returns React Flow context-menu handlers and the menu portal.
 * Usage:
 *   const { paneHandler, nodeHandler, menu } = useEditorContextMenu({ disabled });
 *   return <div>... <ReactFlow onPaneContextMenu={paneHandler} onNodeContextMenu={nodeHandler} /> {menu} </div>;
 */
export function useEditorContextMenu({ disabled }: { disabled?: boolean }) {
  const [state, setState] = useState<MenuState>(initial);
  const setSelection = useGraphStore((s) => s.setSelection);

  const paneHandler = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    setState({ open: true, mode: 'pane', x: e.clientX, y: e.clientY });
  }, [disabled]);

  const nodeHandler = useCallback((e: React.MouseEvent, node: { id: string }) => {
    if (disabled) return;
    e.preventDefault();
    setSelection([node.id]);
    setState({ open: true, mode: 'node', x: e.clientX, y: e.clientY });
  }, [disabled, setSelection]);

  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);

  const menu = state.open && !disabled
    ? <ContextFloat state={state} onClose={close} />
    : null;

  return { paneHandler, nodeHandler, menu };
}

function ContextFloat({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const root = document.body;
  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 min-w-[200px] rounded-md border bg-popover text-popover-foreground shadow-md p-1 text-sm"
      style={{ left: state.x, top: state.y }}
    >
      {state.mode === 'node' ? <NodeItems onClose={onClose} /> : <PaneItems onClose={onClose} />}
    </div>,
    root,
  );
}

function PaneItems({ onClose }: { onClose: () => void }) {
  const addNode = useGraphStore((s) => s.addNode);
  const paste = useGraphStore((s) => s.paste);
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const past = useGraphStore((s) => s.past);
  const future = useGraphStore((s) => s.future);
  const clipboard = useGraphStore((s) => s.clipboard);
  const [subOpen, setSubOpen] = useState(false);

  return (
    <>
      <div
        className="relative"
        onMouseEnter={() => setSubOpen(true)}
        onMouseLeave={() => setSubOpen(false)}
      >
        <MenuRow icon={<Plus className="h-3.5 w-3.5" />} right={<ChevronRight className="h-3.5 w-3.5 opacity-60" />}>
          Add node
        </MenuRow>
        {subOpen && (
          <div className="absolute left-full top-0 ml-1 min-w-[200px] rounded-md border bg-popover shadow-md p-1">
            {NODE_TYPE_LIST.map((m) => {
              const Icon = m.icon;
              return (
                <MenuRow
                  key={m.type}
                  icon={<Icon className="h-3.5 w-3.5" />}
                  onClick={() => { addNode(m.type); onClose(); }}
                >
                  {m.label}
                </MenuRow>
              );
            })}
          </div>
        )}
      </div>
      <Separator />
      <MenuRow
        icon={<Files className="h-3.5 w-3.5" />}
        disabled={!clipboard}
        onClick={() => { paste(); onClose(); }}
        shortcut="⌘V"
      >
        Paste
      </MenuRow>
      <Separator />
      <MenuRow
        icon={<Undo2 className="h-3.5 w-3.5" />}
        disabled={past.length === 0}
        onClick={() => { undo(); onClose(); }}
        shortcut="⌘Z"
      >
        Undo
      </MenuRow>
      <MenuRow
        icon={<Redo2 className="h-3.5 w-3.5" />}
        disabled={future.length === 0}
        onClick={() => { redo(); onClose(); }}
        shortcut="⌘⇧Z"
      >
        Redo
      </MenuRow>
    </>
  );
}

function NodeItems({ onClose }: { onClose: () => void }) {
  const selectedIds = useGraphStore((s) => s.selectedIds);
  const setSelection = useGraphStore((s) => s.setSelection);
  const copy = useGraphStore((s) => s.copySelection);
  const duplicate = useGraphStore((s) => s.duplicateSelection);
  const del = useGraphStore((s) => s.deleteSelection);

  const inspect = () => {
    // Re-assert selection so the inspector panel reflects this node.
    if (selectedIds.length > 0) setSelection([...selectedIds]);
    onClose();
    // Focus the first editable field in the inspector panel for fast keyboard editing.
    requestAnimationFrame(() => {
      const first = document.querySelector<HTMLElement>('aside [id^="inspector-"]');
      first?.focus();
    });
  };

  return (
    <>
      <MenuRow icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={inspect}>
        Inspect
      </MenuRow>
      <Separator />
      <MenuRow icon={<Copy className="h-3.5 w-3.5" />} onClick={() => { copy(); onClose(); }} shortcut="⌘C">
        Copy
      </MenuRow>
      <MenuRow icon={<Files className="h-3.5 w-3.5" />} onClick={() => { duplicate(); onClose(); }} shortcut="⌘D">
        Duplicate
      </MenuRow>
      <Separator />
      <MenuRow
        icon={<Trash2 className="h-3.5 w-3.5" />}
        onClick={() => { del(); onClose(); }}
        shortcut="Del"
        tone="danger"
      >
        Delete
      </MenuRow>
    </>
  );
}

function MenuRow({
  icon, children, right, shortcut, disabled, onClick, tone,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  right?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onClick?: () => void;
  tone?: 'danger';
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left',
        'hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground',
        'disabled:opacity-50 disabled:pointer-events-none',
        tone === 'danger' && 'text-red-600 hover:text-red-600 focus:text-red-600',
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="flex-1 min-w-0">{children}</span>
      {shortcut && <span className="text-xs text-muted-foreground ml-auto">{shortcut}</span>}
      {right}
    </button>
  );
}

function Separator() {
  return <div className="my-1 h-px bg-border" />;
}
