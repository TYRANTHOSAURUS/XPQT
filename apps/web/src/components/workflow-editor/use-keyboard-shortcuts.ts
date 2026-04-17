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
      const inField = !!target && ['INPUT', 'TEXTAREA'].includes(target.tagName);
      const mod = e.metaKey || e.ctrlKey;
      if (inField && !['s', 'Enter'].includes(e.key)) return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && !inField) { e.preventDefault(); del(); }
      else if (mod && e.key.toLowerCase() === 'c' && !inField) { e.preventDefault(); copy(); }
      else if (mod && e.key.toLowerCase() === 'v' && !inField) { e.preventDefault(); paste(); }
      else if (mod && e.key.toLowerCase() === 'd' && !inField) { e.preventDefault(); dup(); }
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
