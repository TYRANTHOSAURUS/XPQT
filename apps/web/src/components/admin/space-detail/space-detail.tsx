import { useState, useMemo } from 'react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toastError, toastRemoved, toastSuccess } from '@/lib/toast';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import type { SpaceType } from '@prequest/shared';
import {
  useSpaceDetail, useSpaceTree, useDeleteSpace, useMoveSpace,
  type SpaceTreeNode,
} from '@/api/spaces';
import { findNode, pathTo } from '../space-tree/build-tree';
import { SpaceParentPicker } from '../space-parent-picker';
import { SpaceFormDialog } from '../space-form';
import { SpaceDetailHeader } from './space-detail-header';
import { SpaceMetadataStrip } from './space-metadata-strip';
import { SpaceChildrenTable } from './space-children-table';
import { SpaceDetailRootSummary } from './space-detail-root-summary';

interface Props {
  spaceId: string | null;
  onNavigate: (id: string | null) => void;
}

export function SpaceDetail({ spaceId, onNavigate }: Props) {
  const { data: tree = [] } = useSpaceTree();
  const { data: space, isLoading, isError } = useSpaceDetail(spaceId);
  const deleteMut = useDeleteSpace();
  const moveMut = useMoveSpace(spaceId ?? '');

  const [editOpen, setEditOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [createUnder, setCreateUnder] = useState<{ id: string; type: SpaceType } | null>(null);

  const descendantIds = useMemo(() => {
    if (!spaceId) return new Set<string>();
    const node = findNode(tree, spaceId);
    const ids = new Set<string>([spaceId]);
    const walk = (n: SpaceTreeNode | null) => {
      if (!n) return;
      for (const c of n.children) { ids.add(c.id); walk(c); }
    };
    walk(node);
    return ids;
  }, [tree, spaceId]);

  if (!spaceId) return <SpaceDetailRootSummary />;

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }

  if (isError || !space) {
    return (
      <div className="p-8">
        <h2 className="text-lg font-semibold mb-2">This space no longer exists</h2>
        <Button variant="outline" onClick={() => onNavigate(null)}>Back to overview</Button>
      </div>
    );
  }

  const handleArchive = async () => {
    if (!confirm(`Archive "${space.name}"? It will no longer appear in the tree.`)) return;
    try {
      await deleteMut.mutateAsync(space.id);
      toastRemoved(space.name, { verb: 'archived' });
      const path = pathTo(tree, space.id);
      const parent = path.at(-2)?.id ?? null;
      onNavigate(parent);
    } catch (err) {
      toastError(`Couldn't archive ${space.name}`, { error: err, retry: handleArchive });
    }
  };

  const handleMoveSubmit = async () => {
    try {
      await moveMut.mutateAsync({ parent_id: moveTarget });
      toastSuccess(`${space.name} moved`);
      setMoveOpen(false);
    } catch (err) {
      toastError(`Couldn't move ${space.name}`, { error: err, retry: handleMoveSubmit });
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <SpaceDetailHeader
        space={space}
        tree={tree}
        onNavigate={onNavigate}
        onEdit={() => setEditOpen(true)}
        onMove={() => { setMoveTarget(space.parent_id); setMoveOpen(true); }}
        onArchive={handleArchive}
      />
      <SpaceMetadataStrip space={space} />

      <Tabs defaultValue="children" className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="mx-6 mt-2 self-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="children">Children</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="px-6 py-4 text-sm text-muted-foreground">
          Created <time dateTime={space.created_at} title={formatFullTimestamp(space.created_at)}>{formatRelativeTime(space.created_at)}</time>. Last updated <time dateTime={space.updated_at} title={formatFullTimestamp(space.updated_at)}>{formatRelativeTime(space.updated_at)}</time>.
        </TabsContent>

        <TabsContent value="children" className="flex-1 overflow-auto">
          <SpaceChildrenTable
            parent={space}
            tree={tree}
            onSelectChild={(id) => onNavigate(id)}
            onAddChild={() => setCreateUnder({ id: space.id, type: space.type })}
          />
        </TabsContent>

        <TabsContent value="activity" className="px-6 py-8 text-sm text-muted-foreground">
          Activity feed coming soon. For now: last updated <time dateTime={space.updated_at} title={formatFullTimestamp(space.updated_at)}>{formatRelativeTime(space.updated_at)}</time>.
        </TabsContent>
      </Tabs>

      <SpaceFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        mode={{ kind: 'edit', space }}
      />

      {createUnder && (
        <SpaceFormDialog
          open={Boolean(createUnder)}
          onOpenChange={(o) => !o && setCreateUnder(null)}
          mode={{ kind: 'create', parentId: createUnder.id, parentType: createUnder.type }}
        />
      )}

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Move {space.name}</DialogTitle>
            <DialogDescription>Pick a new parent. Only types that can contain {space.type} are shown.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>New parent</FieldLabel>
              <SpaceParentPicker
                childType={space.type}
                value={moveTarget}
                onChange={setMoveTarget}
                excludeIds={descendantIds}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)}>Cancel</Button>
            <Button onClick={handleMoveSubmit} disabled={moveMut.isPending}>Move</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
