import { ArrowLeft } from 'lucide-react';
import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type RightPanelView = 'summary' | 'picker:room' | 'picker:catering' | 'picker:av';

export type RightPanelPickerKind = 'room' | 'catering' | 'av';

export interface RightPanelPickerSlots {
  room?: ReactNode;
  catering?: ReactNode;
  av?: ReactNode;
}

export interface RightPanelPickerTitles {
  room: string;
  catering: string;
  av: string;
}

export interface RightPanelProps {
  summary: ReactNode;
  picker: RightPanelPickerSlots;
  view: RightPanelView;
  onViewChange: (next: RightPanelView) => void;
  pickerTitles: RightPanelPickerTitles;
}

function pickerKindFromView(view: RightPanelView): RightPanelPickerKind | null {
  switch (view) {
    case 'picker:room':
      return 'room';
    case 'picker:catering':
      return 'catering';
    case 'picker:av':
      return 'av';
    default:
      return null;
  }
}

/**
 * View-state machine for the booking-composer right pane.
 *
 * Two slots — summary and picker — sit side-by-side inside an
 * overflow-hidden track that translates -100% when a picker view is
 * active. Together they animate as a single unit (true slide, not a
 * crossfade). Reduced-motion is handled globally in apps/web/src/index.css.
 *
 * Only the active picker's children are mounted; the slot div is always
 * rendered to keep the side-by-side layout stable.
 */
export function RightPanel({
  summary,
  picker,
  view,
  onViewChange,
  pickerTitles,
}: RightPanelProps) {
  const kind = pickerKindFromView(view);
  const isPicker = kind !== null;
  const activePickerNode = kind ? picker[kind] : null;
  const activePickerTitle = kind ? pickerTitles[kind] : '';

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div
        className={cn(
          'flex h-full w-full transition-transform duration-[200ms]',
          isPicker ? '-translate-x-full' : 'translate-x-0',
        )}
        style={{ transitionTimingFunction: 'var(--ease-smooth)' }}
      >
        <div
          className="flex h-full w-full shrink-0 flex-col overflow-y-auto"
          aria-hidden={isPicker}
        >
          {summary}
        </div>
        <div
          className="flex h-full w-full shrink-0 flex-col"
          aria-hidden={!isPicker}
        >
          {isPicker && (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => onViewChange('summary')}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm',
                    'text-muted-foreground transition-colors hover:text-foreground',
                  )}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                  <span>Back</span>
                </button>
                <h3 className="text-sm font-medium text-foreground">{activePickerTitle}</h3>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{activePickerNode}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
