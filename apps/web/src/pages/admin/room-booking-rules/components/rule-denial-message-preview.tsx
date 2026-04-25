import { Mail } from 'lucide-react';
import type { RuleEffect } from '@/api/room-booking-rules';

interface RuleDenialMessagePreviewProps {
  effect: RuleEffect;
  message: string | null;
}

/**
 * Standalone "what the user sees" preview of a denial / approval-required
 * message. Doubles as the Outlook decline body preview for Pattern A
 * intercept-mode rooms.
 */
export function RuleDenialMessagePreview({ effect, message }: RuleDenialMessagePreviewProps) {
  if (effect === 'allow_override' || effect === 'warn') {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
        This effect doesn't surface a denial message — bookings go through.
      </div>
    );
  }

  const text =
    (message?.trim() || null) ??
    (effect === 'deny'
      ? 'Your booking was denied because it conflicts with a room policy.'
      : 'Your booking needs approval before it is confirmed.');

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border bg-card p-3">
        <div className="mb-1 text-xs font-medium text-muted-foreground">Portal toast</div>
        <p className="text-sm">{text}</p>
      </div>
      {effect === 'deny' && (
        <div className="rounded-md border bg-card p-3">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Mail className="size-3.5" /> Outlook decline body
          </div>
          <p className="text-sm whitespace-pre-line">{text}</p>
        </div>
      )}
    </div>
  );
}
