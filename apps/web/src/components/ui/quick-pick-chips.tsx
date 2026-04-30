import { useId, useRef, type KeyboardEvent } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface QuickPickOption<T extends string | number> {
  value: T;
  label: string;
}

interface Props<T extends string | number> {
  /** id forwarded to the radiogroup so labels can `htmlFor=` it. */
  id?: string;
  ariaLabel?: string;
  value: T;
  /** Quick-select chips visible by default. */
  options: ReadonlyArray<QuickPickOption<T>>;
  /** Additional options revealed in an overflow popover. */
  more?: ReadonlyArray<QuickPickOption<T>>;
  onChange: (value: T) => void;
}

/**
 * Segmented radiogroup with overflow popover. Implements WAI-ARIA
 * roving tabindex + arrow-key navigation (Left/Right wrap, Home/End
 * jump). When the value isn't in the visible chip list it shows a
 * "selected from More" chip and surfaces the value.
 */
export function QuickPickChips<T extends string | number>({
  id,
  ariaLabel,
  value,
  options,
  more,
  onChange,
}: Props<T>) {
  const popoverId = useId();
  const groupRef = useRef<HTMLDivElement | null>(null);
  const isCustom = !options.some((o) => o.value === value);
  const customLabel = more?.find((o) => o.value === value)?.label ?? String(value);

  const focusByOffset = (delta: number) => {
    const root = groupRef.current;
    if (!root) return;
    const buttons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not([data-overflow-trigger])'),
    );
    if (buttons.length === 0) return;
    const activeIndex = buttons.findIndex((b) => b === document.activeElement);
    const startIndex = activeIndex === -1
      ? buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true')
      : activeIndex;
    const next = (startIndex + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
    const nextValue = buttons[next]?.dataset.value;
    if (nextValue != null) {
      const found = options.find((o) => String(o.value) === nextValue);
      if (found) onChange(found.value);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        focusByOffset(1);
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        focusByOffset(-1);
        return;
      case 'Home': {
        e.preventDefault();
        const root = groupRef.current;
        const buttons = root?.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not([data-overflow-trigger])');
        if (buttons && buttons.length > 0) {
          buttons[0].focus();
          const first = options[0];
          if (first) onChange(first.value);
        }
        return;
      }
      case 'End': {
        e.preventDefault();
        const root = groupRef.current;
        const buttons = root?.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not([data-overflow-trigger])');
        if (buttons && buttons.length > 0) {
          buttons[buttons.length - 1].focus();
          const last = options[options.length - 1];
          if (last) onChange(last.value);
        }
        return;
      }
    }
  };

  return (
    <div
      id={id}
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex h-9 items-center rounded-md border bg-background p-0.5 w-fit"
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-value={String(opt.value)}
            onClick={() => onChange(opt.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              'inline-flex h-8 min-w-[44px] items-center justify-center rounded-[5px] px-2.5 text-xs font-medium tabular-nums',
              'transition-colors active:translate-y-px',
              'focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              selected
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            style={{
              transitionDuration: '120ms',
              transitionTimingFunction: 'var(--ease-snap)',
            }}
          >
            {opt.label}
          </button>
        );
      })}
      {isCustom && (
        <button
          key={`custom-${String(value)}`}
          type="button"
          role="radio"
          aria-checked
          tabIndex={0}
          className="inline-flex h-8 min-w-[44px] items-center justify-center rounded-[5px] bg-foreground px-2.5 text-xs font-medium tabular-nums text-background"
        >
          {customLabel}
        </button>
      )}
      {more && more.length > 0 && (
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="More options"
                aria-haspopup="dialog"
                aria-controls={popoverId}
                data-overflow-trigger
                className={cn(
                  'ml-0.5 inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-xs text-muted-foreground',
                  'transition-colors hover:bg-muted hover:text-foreground active:translate-y-px',
                  'focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                )}
                style={{
                  transitionDuration: '120ms',
                  transitionTimingFunction: 'var(--ease-snap)',
                }}
              >
                <span aria-hidden className="text-[15px] leading-none">
                  …
                </span>
              </button>
            }
          />
          <PopoverContent id={popoverId} align="end" className="w-44 p-1.5">
            <div className="grid gap-0.5">
              {more.map((opt) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  onClick={() => onChange(opt.value)}
                  className={cn(
                    'flex h-8 items-center justify-between rounded-md px-2 text-xs',
                    'hover:bg-accent',
                    value === opt.value && 'bg-accent font-medium',
                  )}
                >
                  <span>{opt.label}</span>
                  {value === opt.value && (
                    <span className="text-[10px] text-muted-foreground">selected</span>
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
