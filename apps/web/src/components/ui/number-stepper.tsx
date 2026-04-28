import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NumberStepperProps {
  value: number;
  onChange: (next: number) => void;
  /** Inclusive lower bound. Defaults to 0. */
  min?: number;
  /** Inclusive upper bound. Defaults to 9999. */
  max?: number;
  /** Step amount for the +/- buttons and arrow keys. Defaults to 1. */
  step?: number;
  /** Visual size — `sm` for inline contexts, `md` (default) for primary controls, `lg` for hero or mobile-first. */
  size?: 'sm' | 'md' | 'lg';
  /** When true, the control renders disabled and ignores all input. */
  disabled?: boolean;
  /** Aria label for the whole stepper (the inner buttons + input also get derived labels). */
  'aria-label'?: string;
  /** Optional unit suffix shown after the number when not editing — e.g. "people", "items". */
  suffix?: ReactNode;
  /** Stable id for the central input so an external <FieldLabel htmlFor> can target it. */
  id?: string;
  className?: string;
  /** When the user blurs the number input, fire this — used by callers that
   *  debounce-save so the final value is committed cleanly. */
  onCommit?: (next: number) => void;
}

export interface NumberStepperHandle {
  focus: () => void;
}

/**
 * Modern number stepper. The center is a typeable `<input type="number">`
 * (tap to edit; arrow keys nudge by `step`); ± regions are buttons with
 * touch-friendly hit targets. The container is a single rounded element
 * with a soft border — no internal dividers, no chevron stack — and the
 * input field uses bare-numeric styling so it looks like a label until
 * focused.
 *
 * Designed to replace the older `QuantityStepper` pattern (separate +/-
 * buttons either side of a static span). Used by the service picker
 * (catalog rows), the booking detail (attendees), and any other surface
 * where the user nudges or types a small integer.
 */
export const NumberStepper = forwardRef<NumberStepperHandle, NumberStepperProps>(function NumberStepper(
  {
    value,
    onChange,
    min = 0,
    max = 9999,
    step = 1,
    size = 'md',
    disabled = false,
    'aria-label': ariaLabel,
    suffix,
    id,
    className,
    onCommit,
  },
  forwardedRef,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState<string>(String(value));
  const [isFocused, setIsFocused] = useState(false);

  // Mirror prop changes into the draft when the input isn't focused. This lets
  // an optimistic update from the server flow back into the rendered value
  // without yanking the cursor mid-edit.
  useEffect(() => {
    if (!isFocused) setDraft(String(value));
  }, [value, isFocused]);

  useImperativeHandle(forwardedRef, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  const clamp = useCallback((n: number) => Math.max(min, Math.min(max, n)), [min, max]);

  const decrement = () => {
    if (disabled) return;
    const next = clamp(value - step);
    if (next === value) return;
    onChange(next);
    onCommit?.(next);
  };

  const increment = () => {
    if (disabled) return;
    const next = clamp(value + step);
    if (next === value) return;
    onChange(next);
    onCommit?.(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      increment();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      decrement();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      inputRef.current?.blur();
    }
  };

  const onBlur = () => {
    setIsFocused(false);
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = clamp(Math.floor(parsed));
    setDraft(String(clamped));
    if (clamped !== value) {
      onChange(clamped);
    }
    onCommit?.(clamped);
  };

  const onInputChange = (raw: string) => {
    setDraft(raw);
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed !== value && parsed >= min && parsed <= max) {
      onChange(Math.floor(parsed));
    }
  };

  const sizes = {
    sm: { container: 'h-8', button: 'size-8', input: 'h-8 text-sm', suffix: 'text-xs' },
    md: { container: 'h-10', button: 'size-10', input: 'h-10 text-sm', suffix: 'text-xs' },
    lg: { container: 'h-12', button: 'size-12', input: 'h-12 text-base', suffix: 'text-sm' },
  } as const;
  const s = sizes[size];

  const atMin = value <= min;
  const atMax = value >= max;

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-disabled={disabled ? 'true' : undefined}
      className={cn(
        'group/stepper inline-flex shrink-0 items-stretch overflow-hidden rounded-md border bg-background transition-colors',
        'focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50',
        disabled && 'opacity-50',
        s.container,
        className,
      )}
    >
      <button
        type="button"
        aria-label="Decrease"
        disabled={disabled || atMin}
        onClick={decrement}
        className={cn(
          'flex shrink-0 items-center justify-center text-muted-foreground transition-colors',
          'hover:bg-muted hover:text-foreground',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
          'active:bg-muted active:translate-y-px',
          s.button,
        )}
      >
        <Minus className="size-3.5" />
      </button>
      <div className="flex flex-1 items-center justify-center gap-1.5 px-2">
        <input
          ref={inputRef}
          id={id}
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(e) => onInputChange(e.target.value)}
          onFocus={(e) => {
            setIsFocused(true);
            // Select on focus so the user can immediately type a fresh value.
            e.currentTarget.select();
          }}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          disabled={disabled}
          aria-label={ariaLabel ?? 'Value'}
          className={cn(
            'w-full min-w-0 bg-transparent text-center font-medium tabular-nums outline-none',
            '[appearance:textfield]',
            '[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
            s.input,
          )}
        />
        {suffix && (
          <span
            className={cn(
              'shrink-0 select-none whitespace-nowrap text-muted-foreground',
              s.suffix,
            )}
            aria-hidden
          >
            {suffix}
          </span>
        )}
      </div>
      <button
        type="button"
        aria-label="Increase"
        disabled={disabled || atMax}
        onClick={increment}
        className={cn(
          'flex shrink-0 items-center justify-center text-muted-foreground transition-colors',
          'hover:bg-muted hover:text-foreground',
          'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
          'active:bg-muted active:translate-y-px',
          s.button,
        )}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
});
