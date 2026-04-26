import { SearchIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCommandPalette } from './command-palette';

interface SearchTriggerProps {
  /**
   * Visual variant.
   *
   * - `icon`: 32px icon-only button (mobile, narrow rails).
   * - `pill`: small rounded chip with "Search…" label (default — secondary headers).
   * - `bar`: wide input-look bar with placeholder + ⌘K hint (primary nav).
   */
  variant?: 'icon' | 'pill' | 'bar';
  /** Override placeholder for the bar variant. */
  placeholder?: string;
  className?: string;
}

const DEFAULT_BAR_PLACEHOLDER = 'Search tickets, people, rooms…';

/**
 * Discoverable button for the global ⌘K palette.
 *
 * Mount the `bar` variant in primary shell headers — it reads like a real
 * input field with a ⌘K kbd hint, so users discover the feature by sight.
 * The narrower `pill` and icon-only `icon` variants stay around for sidebars
 * and mobile bottom-nav.
 */
export function SearchTrigger({
  variant = 'pill',
  placeholder,
  className,
}: SearchTriggerProps) {
  const { setOpen } = useCommandPalette();
  const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  const kbd = isMac ? '⌘K' : 'Ctrl+K';

  if (variant === 'icon') {
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label={`Open search (${kbd})`}
        className={cn('size-8', className)}
      >
        <SearchIcon className="size-4" />
      </Button>
    );
  }

  if (variant === 'bar') {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open search (${kbd})`}
        className={cn(
          // Sized to feel like a real input. Min-w keeps it discoverable on
          // all but the narrowest viewports; max-w prevents it from
          // dominating wide layouts.
          'group inline-flex h-9 w-full min-w-0 max-w-md items-center gap-2.5 rounded-lg border border-input/40 bg-input/30 px-3 text-left text-sm text-muted-foreground',
          'transition-colors hover:bg-input/50 hover:text-foreground hover:border-input/60',
          'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:border-ring',
          className,
        )}
      >
        <SearchIcon className="size-4 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" />
        <span className="flex-1 truncate text-[13px]">
          {placeholder ?? DEFAULT_BAR_PLACEHOLDER}
        </span>
        <kbd className="hidden sm:inline-flex h-5 select-none items-center gap-px rounded border bg-muted/60 px-1.5 font-mono text-[10px] font-medium tracking-tight text-muted-foreground/80">
          {kbd}
        </kbd>
      </button>
    );
  }

  // pill (default)
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={`Open search (${kbd})`}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-md border border-input/30 bg-input/30 px-2 text-sm text-muted-foreground',
        'transition-colors hover:bg-input/60 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
    >
      <SearchIcon className="size-3.5" />
      <span className="hidden md:inline">Search…</span>
      <kbd className="ml-1 hidden md:inline rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-tight text-muted-foreground/80">
        {kbd}
      </kbd>
    </button>
  );
}
