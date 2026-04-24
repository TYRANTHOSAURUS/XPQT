import { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import type { Space, SpaceTreeNode } from '@/api/spaces';
import { findNode } from '../space-tree/build-tree';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from '../space-type-icon';
import { SpaceChildrenBulkBar } from './space-children-bulk-bar';
import { allowedChildTypes } from '@prequest/shared';

interface Props {
  parent: Space;
  tree: SpaceTreeNode[];
  onSelectChild: (id: string) => void;
  onAddChild: () => void;
}

export function SpaceChildrenTable({ parent, tree, onSelectChild, onAddChild }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const node = useMemo(() => findNode(tree, parent.id), [tree, parent.id]);
  const children = node?.children ?? [];

  const canAdd = allowedChildTypes(parent.type).length > 0;

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAll = () => {
    if (selected.size === children.length) setSelected(new Set());
    else setSelected(new Set(children.map((c) => c.id)));
  };

  if (children.length === 0) {
    return (
      <div className="px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">No children yet.</p>
        {canAdd && (
          <Button className="mt-3" size="sm" onClick={onAddChild}>
            <Plus className="size-3.5" /> Add child
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Children ({children.length})</h3>
        {canAdd && (
          <Button size="sm" variant="outline" onClick={onAddChild}>
            <Plus className="size-3.5" /> Add child
          </Button>
        )}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40px]">
              <Checkbox
                checked={selected.size === children.length && children.length > 0}
                onCheckedChange={toggleAll}
                aria-label="Select all"
              />
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Code</TableHead>
            <TableHead>Capacity</TableHead>
            <TableHead>Reservable</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {children.map((c) => (
            <TableRow
              key={c.id}
              onClick={() => onSelectChild(c.id)}
              className="cursor-pointer"
            >
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} />
              </TableCell>
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  <SpaceTypeIcon type={c.type} />
                  {c.name}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">{SPACE_TYPE_LABELS[c.type]}</TableCell>
              <TableCell className="text-muted-foreground font-mono text-xs">{c.code ?? '—'}</TableCell>
              <TableCell className="text-muted-foreground">{c.capacity ?? '—'}</TableCell>
              <TableCell>
                {c.reservable ? <Badge variant="default">Yes</Badge> : <span className="text-muted-foreground">No</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <SpaceChildrenBulkBar
        selectedIds={Array.from(selected)}
        onClear={() => setSelected(new Set())}
      />
    </div>
  );
}
