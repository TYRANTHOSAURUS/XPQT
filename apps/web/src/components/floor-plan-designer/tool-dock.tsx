import { MousePointer2, Pentagon, Square, Circle, Image as ImageIcon, type LucideIcon } from 'lucide-react';
import type { ToolKind } from './types';

const TOOLS: { kind: ToolKind; label: string; shortcut: string; Icon: LucideIcon }[] = [
  { kind: 'select',         label: 'Select / move',         shortcut: 'V', Icon: MousePointer2 },
  { kind: 'draw-rectangle', label: 'Room (rectangle)',      shortcut: 'R', Icon: Square },
  { kind: 'draw-polygon',   label: 'Room (polygon)',        shortcut: 'P', Icon: Pentagon },
  { kind: 'stamp-seat',     label: 'Seat (single click)',   shortcut: 'S', Icon: Circle },
  { kind: 'image-upload',   label: 'Upload floor image',    shortcut: 'I', Icon: ImageIcon },
];

type Props = { activeTool: ToolKind; dispatch: React.Dispatch<any> };

export function ToolDock({ activeTool, dispatch }: Props) {
  return (
    <div className="flex items-center gap-1 border-b border-border bg-background px-3 py-2">
      {TOOLS.map((t) => (
        <button
          key={t.kind}
          title={`${t.label} (${t.shortcut})`}
          aria-label={t.label}
          onClick={() => dispatch({ type: 'set-tool', tool: t.kind })}
          className={`flex h-9 w-9 items-center justify-center rounded-md ${
            activeTool === t.kind ? 'bg-foreground text-background' : 'hover:bg-muted'
          }`}
        >
          <t.Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
