import { ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  ResizableHandle, ResizablePanel, ResizablePanelGroup,
} from '@/components/ui/resizable';

/**
 * Page-level layout for admin "list + inspector" surfaces (Linear / Supabase
 * style). Renders a full-bleed shell inside the AdminLayout that escapes the
 * default `px-6 pb-6` outlet padding, then stacks: optional header strip,
 * optional toolbar strip, and a body that is either a single scroll area
 * (when `inspector` is omitted) or a horizontally resizable split-pane
 * (when `inspector` is provided).
 *
 * ## Why `absolute inset-0` inside each panel?
 *
 * The AdminLayout's outlet wrapper has `pb-6 overflow-auto`. `h-full` inside
 * resolves against the wrapper's *content box* (excluding padding) — but the
 * `react-resizable-panels` Panel renders with inline `overflow: hidden`. The
 * net effect: any `h-full` chain through the panels comes up 24px short, and
 * the bottom of inspector content is clipped below the Panel's edge — making
 * scroll containers report "at the bottom" before the user has reached the
 * actual end of content.
 *
 * `absolute inset-0` on the Panel's child resolves against the Panel's laid-
 * out box (its border-box, not its content-box), capturing the full Panel
 * area regardless of any ancestor padding shenanigans. Each Panel is marked
 * `position: relative` so the absolute child anchors there.
 *
 * Callers don't need to know any of this — just pass `list` and `inspector`.
 */
interface TableInspectorLayoutProps {
  /** Title + description + page-level actions strip. Full-bleed above the body. */
  header?: React.ReactNode;
  /** Search / filters / count strip. Full-bleed, sits between header and body. */
  toolbar?: React.ReactNode;
  /** Left panel content. Always rendered. Receives its own scroll container. */
  list: React.ReactNode;
  /**
   * Right panel content. When provided, the body becomes a resizable split-pane.
   * When null/undefined, the list expands to full width. The inspector content
   * is given a bordered absolute-inset-0 container — typically you'll wrap your
   * content in {@link InspectorPanel} which handles the icon toolbar + scroll.
   */
  inspector?: React.ReactNode;
  /** Default split as [list%, inspector%]. Defaults to [55, 45]. */
  defaultSizes?: [number, number];
  /** Minimum sizes as [list%, inspector%]. Defaults to [30, 30]. */
  minSizes?: [number, number];
  className?: string;
}

export function TableInspectorLayout({
  header,
  toolbar,
  list,
  inspector,
  defaultSizes = [55, 45],
  minSizes = [30, 30],
  className,
}: TableInspectorLayoutProps) {
  const hasInspector = Boolean(inspector);

  return (
    <div
      className={cn(
        '-mx-6 -mb-6 flex h-full min-h-0 flex-col overflow-hidden',
        className,
      )}
    >
      {header}
      {toolbar}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {hasInspector ? (
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel
              defaultSize={defaultSizes[0]}
              minSize={minSizes[0]}
              className="relative"
            >
              <div className="absolute inset-0 overflow-auto overscroll-contain">
                {list}
              </div>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              defaultSize={defaultSizes[1]}
              minSize={minSizes[1]}
              className="relative"
            >
              <div className="absolute inset-0">{inspector}</div>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="relative h-full w-full">
            <div className="absolute inset-0 overflow-auto overscroll-contain">
              {list}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Standard chrome for the right-pane inspector: a thin icon toolbar (with
 * optional close / expand actions) above a scrollable body. Renders inside
 * the absolute-inset-0 container that {@link TableInspectorLayout} sets up,
 * so it fills its Panel cleanly and its body can scroll its full content.
 *
 * Pass any heading + sections as children — they're rendered inside the
 * scroll container with no enforced wrapper, so callers control padding /
 * vertical rhythm. A common pattern:
 *
 * ```tsx
 * <InspectorPanel onClose={...} onExpand={...}>
 *   <div className="flex flex-col gap-8 px-6 pt-6 pb-10">
 *     <PageHeading user={user} />
 *     <UserDetailBody userId={userId} />
 *   </div>
 * </InspectorPanel>
 * ```
 */
interface InspectorPanelProps {
  /** Closes the inspector. Renders an X icon button when provided. */
  onClose?: () => void;
  /** Navigates to the full detail page. Renders an external-link icon when provided. */
  onExpand?: () => void;
  /**
   * Optional left-aligned toolbar content (e.g., a tiny breadcrumb or
   * meta indicator). Most callers leave this empty and put the identity
   * in the scrolling body.
   */
  toolbarLeft?: React.ReactNode;
  children: React.ReactNode;
}

export function InspectorPanel({
  onClose,
  onExpand,
  toolbarLeft,
  children,
}: InspectorPanelProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden border-l bg-background">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1 text-xs text-muted-foreground">{toolbarLeft}</div>
        <div className="flex shrink-0 items-center gap-1">
          {onExpand && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              onClick={onExpand}
              aria-label="Open full page"
              title="Open full page"
            >
              <ExternalLink className="size-3.5" />
            </Button>
          )}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              onClick={onClose}
              aria-label="Close"
              title="Close"
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
        {children}
      </div>
    </div>
  );
}
