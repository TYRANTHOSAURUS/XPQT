import { cn } from '@/lib/utils';

export interface FieldChipsOption<T extends string = string> {
  value: T;
  label: string;
}

interface SingleProps<T extends string> {
  options: FieldChipsOption<T>[];
  value: T | null;
  onChange: (next: T) => void;
  multi?: false;
  className?: string;
}

interface MultiProps<T extends string> {
  options: FieldChipsOption<T>[];
  value: T[];
  onChange: (next: T[]) => void;
  multi: true;
  className?: string;
}

export function FieldChips<T extends string>(props: SingleProps<T> | MultiProps<T>) {
  const { options, className } = props;
  const isSelected = (v: T) =>
    props.multi ? props.value.includes(v) : props.value === v;

  const onClick = (v: T) => {
    if (props.multi) {
      const next = props.value.includes(v)
        ? props.value.filter((x) => x !== v)
        : [...props.value, v];
      props.onChange(next);
    } else {
      props.onChange(v);
    }
  };

  return (
    <div
      className={cn('flex flex-wrap gap-1.5', className)}
      role={props.multi ? 'group' : 'radiogroup'}
    >
      {options.map((opt) => {
        const selected = isSelected(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            role={props.multi ? 'checkbox' : 'radio'}
            aria-checked={selected}
            onClick={() => onClick(opt.value)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              selected
                ? 'bg-foreground text-background border-foreground'
                : 'bg-transparent text-muted-foreground border-border hover:text-foreground hover:bg-muted/40',
            )}
            style={{
              transitionTimingFunction: 'var(--ease-snap)',
              transitionDuration: '120ms',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
