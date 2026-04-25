import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';

interface Props {
  to: string;
  label: string;
  matchExact?: boolean;
}

export function PortalNavLink({ to, label, matchExact }: Props) {
  return (
    <NavLink
      to={to}
      end={matchExact}
      className={({ isActive }) =>
        cn(
          'relative px-1 py-2 text-sm font-medium transition-colors',
          'text-muted-foreground hover:text-foreground',
          'focus-visible:outline-none focus-visible:text-foreground',
          isActive && 'text-foreground',
          isActive &&
            'after:absolute after:inset-x-0 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-foreground',
        )
      }
    >
      {label}
    </NavLink>
  );
}
