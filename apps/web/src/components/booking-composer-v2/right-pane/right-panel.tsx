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
 * View-state machine for the booking-composer right pane (desktop only).
 *
 * Two slots — summary and picker — sit side-by-side inside an
 * overflow-hidden track that translates -100% when a picker view is
 * active. Together they animate as a single unit (true slide, not a
 * crossfade). Reduced-motion is handled globally in apps/web/src/index.css.
 *
 * Only the active picker's children are mounted; the slot div is always
 * rendered to keep the side-by-side layout stable.
 *
 * **C3 a11y fix (/full-review v4):** the hidden slot is gated with
 * `inert` rather than `aria-hidden`. The prior pattern marked the
 * off-screen slot `aria-hidden={true}` but its descendants (the
 * SummaryCard empty-state buttons) stayed focusable — a Tab from the
 * footer could land on a control inside a region screen readers had
 * been told to ignore (WCAG 2.2 1.3.1 + 4.1.2). `inert` blocks focus
 * AND announces the subtree as hidden, in one attribute.
 *
 * Mobile uses a different layout — the modal renders the summary cards
 * and pickers directly without this component (see
 * booking-composer-modal.tsx). Keeping this component desktop-only lets
 * the slide animation stay simple; on mobile the same panelView state
 * drives a screen-swap rather than a side-by-side translate.
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
          inert={isPicker}
        >
          {summary}
        </div>
        <div
          className="flex h-full w-full shrink-0 flex-col"
          inert={!isPicker}
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
