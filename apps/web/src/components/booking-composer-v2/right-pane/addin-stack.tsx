import { useState, type ReactNode } from 'react';

export type AddinKey = 'room' | 'catering' | 'av_equipment';

export interface AddinStackProps {
  children: (args: {
    expanded: AddinKey | null;
    setExpanded: (key: AddinKey | null) => void;
  }) => ReactNode;
}

/**
 * Renders cards as siblings; enforces single-expand-at-a-time per spec.
 * Render-prop API gives child cards control over their own expand state
 * without prop-drilling from the modal.
 */
export function AddinStack({ children }: AddinStackProps) {
  const [expanded, setExpanded] = useState<AddinKey | null>(null);
  return (
    <div className="flex flex-col gap-2">
      {children({ expanded, setExpanded })}
    </div>
  );
}
