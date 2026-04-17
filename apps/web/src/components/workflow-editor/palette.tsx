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
