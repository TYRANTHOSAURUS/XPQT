import { ReactNode, useEffect, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface InlineTextEditorProps {
  value: string;
  placeholder?: string;
  /** Rendering of the non-editing state. Defaults to the value as plain text. */
  renderView?: (value: string) => ReactNode;
  /** CSS classes applied to the <Textarea> in editing mode. */
  editorClassName?: string;
  /** CSS classes applied to the view wrapper. */
  viewClassName?: string;
  /** Single-line variant disables newlines and submits on Enter. */
  singleLine?: boolean;
  onSave: (next: string) => void;
  /** Disables editing entirely — renders view only. */
  disabled?: boolean;
}

/**
 * Click-to-edit text. Cmd/Ctrl+Enter saves, Esc cancels, blur saves.
 */
export function InlineTextEditor({
  value,
  placeholder = 'Empty',
  renderView,
  editorClassName,
  viewClassName,
  singleLine = false,
  onSave,
  disabled,
}: InlineTextEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      // Focus on next frame so the <Textarea> exists in the DOM.
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(node.value.length, node.value.length);
      });
    }
  }, [editing, value]);

  const commit = () => {
    const next = draft.trim();
    if (next !== value.trim()) onSave(next);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        className={cn(
          'cursor-text rounded-md px-2 py-1.5 -mx-2 transition-colors',
          !disabled && 'hover:bg-accent/30',
          viewClassName,
        )}
        onClick={() => { if (!disabled) setEditing(true); }}
      >
        {renderView
          ? renderView(value)
          : value
            ? <span>{value}</span>
            : <span className="text-muted-foreground">{placeholder}</span>}
      </div>
    );
  }

  return (
    <Textarea
      ref={textareaRef}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      rows={singleLine ? 1 : 3}
      className={cn('resize-none', editorClassName)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        } else if (e.key === 'Enter' && (singleLine || e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}
