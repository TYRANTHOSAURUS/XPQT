import { Card, CardContent } from '@/components/ui/card';
import { useSpaceTree, type SpaceTreeNode } from '@/api/spaces';
import { type SpaceType } from '@prequest/shared';
import { SPACE_TYPE_LABELS, SpaceTypeIcon } from '../space-type-icon';

function walk(tree: SpaceTreeNode[], cb: (type: SpaceType) => void) {
  for (const n of tree) {
    cb(n.type);
    walk(n.children, cb);
  }
}

export function SpaceDetailRootSummary() {
  const { data: tree = [] } = useSpaceTree();
  const counts = new Map<SpaceType, number>();
  walk(tree, (t) => counts.set(t, (counts.get(t) ?? 0) + 1));

  const summary: SpaceType[] = ['site', 'building', 'floor', 'room', 'meeting_room', 'desk'];

  return (
    <div className="p-8">
      <h2 className="text-lg font-semibold mb-4">Spaces overview</h2>
      <div className="grid grid-cols-3 gap-3 max-w-2xl">
        {summary.map((t) => (
          <Card key={t}>
            <CardContent className="p-4 flex items-center gap-3">
              <SpaceTypeIcon type={t} className="size-6" />
              <div>
                <div className="text-2xl font-semibold tabular-nums">{counts.get(t) ?? 0}</div>
                <div className="text-xs text-muted-foreground">{SPACE_TYPE_LABELS[t]}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-6 text-sm text-muted-foreground">Select a space in the tree to see its details.</p>
    </div>
  );
}
