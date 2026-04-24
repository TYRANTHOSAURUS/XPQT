import { Search, ListTree, List } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

interface Props {
  value: string;
  onChange: (v: string) => void;
  mode: 'tree' | 'flat';
  onModeChange: (m: 'tree' | 'flat') => void;
}

export function SpaceTreeSearch({ value, onChange, mode, onModeChange }: Props) {
  return (
    <div className="flex items-center gap-2 p-2 border-b">
      <div className="relative flex-1">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" aria-hidden />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search name or code…"
          className="h-8 pl-7 text-sm"
        />
      </div>
      <ToggleGroup
        value={[mode]}
        onValueChange={(v) => {
          const next = v[0];
          if (next === 'tree' || next === 'flat') onModeChange(next);
        }}
        variant="outline"
        className="h-8"
      >
        <ToggleGroupItem value="tree" aria-label="Tree view"><ListTree className="size-3.5" /></ToggleGroupItem>
        <ToggleGroupItem value="flat" aria-label="Flat list view"><List className="size-3.5" /></ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
