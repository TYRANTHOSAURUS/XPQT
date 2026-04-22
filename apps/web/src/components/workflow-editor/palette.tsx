import { NODE_TYPE_LIST } from './node-types';
import { useGraphStore } from './graph-store';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function Palette({ disabled }: { disabled?: boolean }) {
  const addNode = useGraphStore((s) => s.addNode);

  return (
    <aside className="w-[160px] border-r bg-muted/30 p-3 overflow-auto shrink-0">
      <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Palette</div>
      <div className="flex flex-col gap-1">
        {NODE_TYPE_LIST.map((m) => {
          const Icon = m.icon;
          return (
            <Tooltip key={m.type}>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => addNode(m.type)}
                    className="justify-start gap-2 h-8"
                  />
                }
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="text-xs">{m.label}</span>
              </TooltipTrigger>
              <TooltipContent side="right">{m.description}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </aside>
  );
}
