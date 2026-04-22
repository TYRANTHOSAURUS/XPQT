import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

type CommonProps = {
  /** Called with the new value when the input blurs or Enter is pressed, only if the value changed. */
  onCommit: (value: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
};

interface EditableTextProps extends CommonProps {
  value: string;
  /** Visual variant: 'input' looks like a normal input, 'title' renders large, borderless. */
  variant?: 'input' | 'title';
  /** If true, empty values are rejected and the field reverts to its last committed value. */
  required?: boolean;
}

/**
 * Auto-saving text input. Commits on blur or Enter.
 * Use variant="title" for the big inline-editable page titles (looks like plain text until focused).
 */
export function EditableText({
  value,
  onCommit,
  className,
  placeholder,
  disabled,
  variant = 'input',
  required = false,
}: EditableTextProps) {
  const [local, setLocal] = useState(value);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  const commit = () => {
    const v = local.trim();
    if (required && !v) {
      setLocal(value);
      return;
    }
    if (v !== value) onCommit(v);
  };

  const titleClasses =
    'border-0 bg-transparent px-1 py-0 h-auto text-2xl font-bold tracking-tight shadow-none ' +
    'focus-visible:ring-0 focus-visible:bg-muted/40 focus-visible:rounded-md';

  return (
    <Input
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(variant === 'title' && titleClasses, className)}
    />
  );
}

interface EditableDateProps extends CommonProps {
  value: string;
}

/** Auto-saving date input (ISO `yyyy-mm-dd`). Commits on blur. */
export function EditableDate({
  value,
  onCommit,
  className,
  placeholder,
  disabled,
}: EditableDateProps) {
  const [local, setLocal] = useState(value);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  return (
    <Input
      type="date"
      value={local}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => local !== value && onCommit(local)}
      className={className}
    />
  );
}

interface EditableNumberProps extends Omit<CommonProps, 'onCommit'> {
  value: number | null | string;
  onCommit: (value: number | null) => void;
  step?: string;
  /** If true, empty input commits `null` (nullable field). If false, reverts to previous value. */
  nullable?: boolean;
}

/** Auto-saving numeric input. Commits on blur or Enter. */
export function EditableNumber({
  value,
  onCommit,
  step = '0.01',
  nullable = false,
  className,
  placeholder,
  disabled,
}: EditableNumberProps) {
  const asString = value == null ? '' : String(value);
  const [local, setLocal] = useState(asString);

  useEffect(() => {
    setLocal(asString);
  }, [asString]);

  const commit = () => {
    if (local === '') {
      if (nullable && value !== null) onCommit(null);
      else setLocal(asString);
      return;
    }
    const n = Number(local);
    if (!Number.isFinite(n)) {
      setLocal(asString);
      return;
    }
    if (n !== Number(value)) onCommit(n);
  };

  return (
    <Input
      type="number"
      step={step}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
    />
  );
}
