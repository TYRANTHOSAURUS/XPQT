import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  children: ReactNode;
  className?: string;
  bleed?: boolean;
}

/**
 * Content wrapper for portal pages. 1600px ultra content container with
 * portal-appropriate padding. Full-bleed heroes break out with negative margins.
 */
export function PortalPage({ children, className, bleed }: Props) {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[1600px]',
        !bleed && 'px-3 md:px-4 lg:px-6',
        'pb-24 md:pb-10',
        className,
      )}
    >
      {children}
    </div>
  );
}
