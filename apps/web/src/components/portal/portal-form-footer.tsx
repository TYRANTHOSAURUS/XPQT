import { Button } from '@/components/ui/button';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  slaHint?: string | null;
  onCancel?: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  submitting?: boolean;
  disabled?: boolean;
  className?: string;
}

export function PortalFormFooter({ slaHint, onCancel, onSubmit, submitLabel, cancelLabel, submitting, disabled, className }: Props) {
  return (
    <footer className={cn('sticky bottom-0 z-50 -mx-4 md:-mx-6 lg:-mx-8 mt-10 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85', className)}>
      <div className="mx-auto max-w-[920px] px-4 md:px-6 lg:px-8 py-3 flex items-center justify-between gap-3">
        {slaHint ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5" />
            <span>{slaHint}</span>
          </div>
        ) : <span aria-hidden />}
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
              {cancelLabel ?? 'Cancel'}
            </Button>
          )}
          {onSubmit && (
            <Button size="sm" onClick={onSubmit} disabled={submitting || disabled}>
              {submitting ? 'Submitting…' : (submitLabel ?? 'Submit request')}
            </Button>
          )}
        </div>
      </div>
    </footer>
  );
}
