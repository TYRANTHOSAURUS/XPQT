import { Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBundleTemplates, type BundleTemplate } from '@/api/bundle-templates';

interface Props {
  selectedId: string | null;
  onSelect: (template: BundleTemplate | null) => void;
  className?: string;
}

/**
 * Chip row above the criteria bar on /portal/rooms. Each chip is a
 * `bundle_templates` row marked `active=true`. Picking one calls back with
 * the template; the parent applies the template's room criteria + default
 * duration to the picker state and stages services for the booking-confirm
 * dialog.
 *
 * Empty list: render nothing — admins haven't created any templates yet.
 * Loading: render nothing too; the chip row is purely an affordance, no
 * skeleton needed.
 */
export function BundleTemplatePicker({ selectedId, onSelect, className }: Props) {
  const { data, isLoading } = useBundleTemplates({ active: true });

  if (isLoading || !data || data.length === 0) return null;

  return (
    <div
      className={`mb-4 flex flex-wrap items-center gap-2 ${className ?? ''}`}
      role="region"
      aria-label="Bundle templates"
    >
      <span className="text-xs uppercase tracking-wider text-muted-foreground">
        Quick start
      </span>
      {data.map((template) => {
        const selected = template.id === selectedId;
        const services = template.payload?.services?.length ?? 0;
        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onSelect(selected ? null : template)}
            className={chipClass(selected)}
            aria-pressed={selected}
            title={template.description ?? template.name}
          >
            <Sparkles className="size-3" />
            <span className="font-medium">{template.name}</span>
            {services > 0 && (
              <span className="text-[10px] tabular-nums text-muted-foreground">
                · {services} service{services === 1 ? '' : 's'}
              </span>
            )}
          </button>
        );
      })}
      {selectedId && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={() => onSelect(null)}
        >
          <X className="size-3" /> Clear
        </Button>
      )}
    </div>
  );
}

function chipClass(selected: boolean): string {
  const base =
    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors';
  if (selected) {
    return `${base} border-primary bg-primary/10 text-primary`;
  }
  return `${base} border-input bg-card hover:bg-accent/40`;
}
