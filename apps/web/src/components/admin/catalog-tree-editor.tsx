import { useMemo, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  ChevronRight,
  ChevronDown,
  GripVertical,
  Folder,
  FileText,
  Pencil,
  Trash2,
  Plus,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { toastError } from '@/lib/toast';

export interface CatalogRequestType {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  display_order: number;
  domain: string | null;
}

export interface CatalogCategoryNode {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  cover_source: 'image' | 'icon' | null;
  cover_image_url: string | null;
  display_order: number;
  parent_category_id: string | null;
  children: CatalogCategoryNode[];
  request_types: CatalogRequestType[];
}

export interface FlatItem {
  id: string;
  kind: 'category' | 'request_type';
  parentId: string | null;
  depth: number;
  name: string;
  description: string | null;
  icon: string | null;
  cover_source: 'image' | 'icon' | null;
  cover_image_url: string | null;
  hasChildren: boolean;
  collapsed: boolean;
}

const MAX_CATEGORY_DEPTH = 2;
const INDENT_PX = 24;

function depthOfSubtree(node: CatalogCategoryNode): number {
  if (node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(depthOfSubtree));
}

function flatten(
  tree: CatalogCategoryNode[],
  collapsed: Set<string>,
): FlatItem[] {
  const out: FlatItem[] = [];
  const walk = (node: CatalogCategoryNode, depth: number, parentId: string | null) => {
    const isCollapsed = collapsed.has(node.id);
    const hasChildren = node.children.length > 0 || node.request_types.length > 0;
    out.push({
      id: node.id,
      kind: 'category',
      parentId,
      depth,
      name: node.name,
      description: node.description,
      icon: node.icon,
      cover_source: node.cover_source,
      cover_image_url: node.cover_image_url,
      hasChildren,
      collapsed: isCollapsed,
    });
    if (isCollapsed) return;
    const sortedChildren = [...node.children].sort((a, b) => a.display_order - b.display_order);
    for (const child of sortedChildren) {
      walk(child, depth + 1, node.id);
    }
    const sortedTypes = [...node.request_types].sort((a, b) => a.display_order - b.display_order);
    for (const rt of sortedTypes) {
      out.push({
        id: rt.id,
        kind: 'request_type',
        parentId: node.id,
        depth: depth + 1,
        name: rt.name,
        description: rt.description,
        icon: rt.icon,
        cover_source: null,
        cover_image_url: null,
        hasChildren: false,
        collapsed: false,
      });
    }
  };
  const sortedRoots = [...tree].sort((a, b) => a.display_order - b.display_order);
  for (const root of sortedRoots) walk(root, 0, null);
  return out;
}

function findCategory(tree: CatalogCategoryNode[], id: string): CatalogCategoryNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const found = findCategory(n.children, id);
    if (found) return found;
  }
  return null;
}

interface RowProps {
  item: FlatItem;
  onToggleCollapse: (id: string) => void;
  onEdit?: (item: FlatItem) => void;
  onDelete?: (item: FlatItem) => void;
  onAddChild?: (categoryId: string) => void;
  isOverlay?: boolean;
  selected?: boolean;
}

function Row({ item, onToggleCollapse, onEdit, onDelete, onAddChild, isOverlay, selected }: RowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, data: { kind: item.kind, parentId: item.parentId } });

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    paddingLeft: item.depth * INDENT_PX + 8,
    opacity: isDragging && !isOverlay ? 0.4 : 1,
  };

  const Icon = item.kind === 'category' ? Folder : FileText;
  const iconColor = item.kind === 'category' ? 'text-muted-foreground' : 'text-blue-500';

  const isRequestType = item.kind === 'request_type';
  // Whole-row click opens the detail panel for request_types. Categories keep
  // the pencil affordance so the category form stays explicit.
  const rowClickable = isRequestType && onEdit;

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={rowClickable ? () => onEdit!(item) : undefined}
      role={rowClickable ? 'button' : undefined}
      tabIndex={rowClickable ? 0 : undefined}
      onKeyDown={rowClickable
        ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit!(item); } }
        : undefined}
      className={`group flex items-center gap-2 py-1.5 pr-2 rounded-md border ${
        rowClickable ? 'cursor-pointer' : ''
      } ${
        selected ? 'border-primary/40 bg-accent/60' : 'border-transparent hover:bg-accent/40'
      } ${isOverlay ? 'bg-background border-border shadow-lg' : ''}`}
    >
      <button
        type="button"
        className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground/60 hover:text-foreground cursor-grab active:cursor-grabbing"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        aria-label="Drag handle"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {item.kind === 'category' && item.hasChildren ? (
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(item.id); }}
          aria-label={item.collapsed ? 'Expand' : 'Collapse'}
        >
          {item.collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      ) : (
        <span className="w-4" />
      )}

      <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />

      {/* Name is the primary label; it never shrinks so the description
          (which is secondary context) yields first when the row narrows. */}
      <span className="font-medium text-sm shrink-0 truncate max-w-[60%]">
        {item.name}
      </span>

      {item.description && (
        <span className="text-xs text-muted-foreground truncate flex-1 min-w-0 hidden md:inline">
          — {item.description}
        </span>
      )}

      {isRequestType && (
        <Badge variant="secondary" className="ml-1 text-[10px] h-5">
          Request
        </Badge>
      )}

      <div className="ml-auto flex items-center gap-0.5">
        {item.kind === 'category' && onAddChild && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={(e) => { e.stopPropagation(); onAddChild(item.id); }}
                  />
                }
              >
                <Plus className="h-3.5 w-3.5" />
              </TooltipTrigger>
              <TooltipContent>Add child</TooltipContent>
            </Tooltip>
          </div>
        )}
        {item.kind === 'category' && onEdit && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={(e) => { e.stopPropagation(); onEdit(item); }}
                  />
                }
              >
                <Pencil className="h-3.5 w-3.5" />
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          </div>
        )}
        {item.kind === 'category' && onDelete && (
          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); onDelete(item); }}
                  />
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          </div>
        )}
        {isRequestType && (
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground" />
        )}
      </div>
    </div>
  );
}

interface CatalogTreeEditorProps {
  tree: CatalogCategoryNode[];
  onCategoryMove: (updates: Array<{ id: string; parent_category_id: string | null; display_order: number }>) => Promise<void>;
  onRequestTypeMove: (updates: Array<{ id: string; category_id: string; display_order: number }>) => Promise<void>;
  onEdit?: (item: FlatItem) => void;
  onDelete?: (item: FlatItem) => void;
  onAddChild?: (parentCategoryId: string | null) => void;
  selectedRequestTypeId?: string | null;
}

export function CatalogTreeEditor({
  tree,
  onCategoryMove,
  onRequestTypeMove,
  onEdit,
  onDelete,
  onAddChild,
  selectedRequestTypeId,
}: CatalogTreeEditorProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);

  const items = useMemo(() => flatten(tree, collapsed), [tree, collapsed]);
  const activeItem = items.find((i) => i.id === activeId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
    // Auto-collapse the dragged category's subtree for cleaner visuals during drag.
    const draggedId = String(event.active.id);
    const dragged = items.find((i) => i.id === draggedId);
    if (dragged?.kind === 'category' && !collapsed.has(dragged.id)) {
      setCollapsed((prev) => new Set(prev).add(dragged.id));
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const activeItem = items[oldIndex];
    const reorderedFlat = arrayMove(items, oldIndex, newIndex);

    // Determine new parent: the nearest category at lower-or-equal depth sitting above the new position.
    const newPos = reorderedFlat.findIndex((i) => i.id === active.id);
    let newParentId: string | null = null;
    for (let i = newPos - 1; i >= 0; i--) {
      const candidate = reorderedFlat[i];
      if (candidate.kind === 'category') {
        newParentId = candidate.id;
        break;
      }
    }

    if (activeItem.kind === 'request_type') {
      if (newParentId === null) {
        toastError("Couldn't move request type", {
          description: 'Request types must live under a category.',
        });
        return;
      }
      const siblingTypes = reorderedFlat.filter(
        (i) => i.kind === 'request_type' && i.parentId === newParentId,
      );
      const updates = siblingTypes.map((s, idx) => ({
        id: s.id,
        category_id: newParentId!,
        display_order: idx,
      }));
      try {
        await onRequestTypeMove(updates);
      } catch (err) {
        toastError("Couldn't move request type", { error: err });
      }
      return;
    }

    // Category move: validate depth cap (new depth + subtree depth must fit).
    const draggedNode = findCategory(tree, activeItem.id);
    const subtreeDepth = draggedNode ? depthOfSubtree(draggedNode) : 0;

    let newParentDepth = -1;
    if (newParentId) {
      const parentItem = reorderedFlat.find((i) => i.id === newParentId);
      if (parentItem) newParentDepth = parentItem.depth;
    }
    const newDepth = newParentDepth + 1;

    if (newDepth + subtreeDepth > MAX_CATEGORY_DEPTH) {
      toastError("Couldn't move category", {
        description: `The catalog hierarchy is capped at ${MAX_CATEGORY_DEPTH} levels.`,
      });
      return;
    }

    const siblingCategories = reorderedFlat.filter(
      (i) => i.kind === 'category' && i.parentId === newParentId,
    );
    const updates = siblingCategories.map((s, idx) => ({
      id: s.id,
      parent_category_id: newParentId,
      display_order: idx,
    }));

    try {
      await onCategoryMove(updates);
    } catch (err) {
      toastError("Couldn't move category", { error: err });
    }
  };

  return (
    <div className="border rounded-lg bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <span className="text-sm font-medium">Catalog hierarchy</span>
        {onAddChild && (
          <Button size="sm" variant="ghost" onClick={() => onAddChild(null)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add top-level
          </Button>
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <div className="p-1">
            {items.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No categories yet. Add one to start building your catalog.
              </div>
            )}
            {items.map((item) => (
              <Row
                key={item.id}
                item={item}
                onToggleCollapse={toggleCollapse}
                onEdit={onEdit}
                onDelete={onDelete}
                onAddChild={item.kind === 'category' ? (id) => onAddChild?.(id) : undefined}
                selected={item.kind === 'request_type' && item.id === selectedRequestTypeId}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay>
          {activeItem ? (
            <Row
              item={{ ...activeItem, depth: 0 }}
              onToggleCollapse={() => {}}
              isOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
