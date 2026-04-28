import { useNavigate, useLocation } from 'react-router-dom';
import { PersonAvatar } from '@/components/person-avatar';
import {
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowRightLeftIcon,
  BadgeCheckIcon,
  BellIcon,
  HeadsetIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
} from 'lucide-react';
import { useTheme } from '@/providers/theme-provider';
import { useAuth } from '@/providers/auth-provider';

interface Props {
  /** Where the dropdown opens relative to the trigger. Defaults to 'bottom'. */
  side?: 'bottom' | 'right' | 'top' | 'left';
  /** Default 'end' aligns to the trigger's right edge. */
  align?: 'start' | 'center' | 'end';
  /** Default min-w-56. Override if needed. */
  className?: string;
}

/**
 * Shared dropdown body for the user/account menu.
 *
 * Used by:
 *   - NavUser (sidebar in /desk and /admin) — sidebar-flavored trigger.
 *   - PortalAccountMenu (top-right in /portal) — avatar-button trigger.
 *
 * Contents are identical across both: identity label, Account/Notifications/
 * Settings, Theme submenu (light/dark/system), role-aware Switch-to links
 * for each shell the user does NOT currently sit in, and Log out.
 */
export function UserMenuContent({ side = 'bottom', align = 'end', className }: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, setTheme } = useTheme();
  const { user, person, hasRole, signOut } = useAuth();

  const displayName = person ? `${person.first_name} ${person.last_name}` : user?.email ?? 'User';
  const displayEmail = user?.email ?? '';
  const avatarPerson = person
    ? {
        first_name: person.first_name,
        last_name: person.last_name,
        email: user?.email,
        avatar_url: person.avatar_url,
      }
    : { email: user?.email };

  const onPortal = location.pathname.startsWith('/portal');
  const onDesk = location.pathname.startsWith('/desk');
  const onAdmin = location.pathname.startsWith('/admin');

  // Account / Notifications / Settings destinations are shell-aware. Today
  // only the Portal has a profile page; in the other shells the items stay
  // disabled rather than going to a 404.
  const accountHref = onPortal
    ? '/portal/profile'
    : onAdmin
      ? '/admin'
      : '/desk';

  const canSeeDesk = hasRole('agent') || hasRole('admin');
  const canSeeAdmin = hasRole('admin');

  const handleSignOut = async () => {
    await signOut();
    navigate('/login', { replace: true });
  };

  return (
    <DropdownMenuContent
      className={className ?? 'min-w-56 rounded-lg'}
      side={side}
      align={align}
      sideOffset={4}
    >
      <DropdownMenuGroup>
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
            <PersonAvatar person={avatarPerson} alt={displayName} className="rounded-lg" />
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              <span className="truncate text-xs text-muted-foreground">{displayEmail}</span>
            </div>
          </div>
        </DropdownMenuLabel>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => navigate(accountHref)}>
          <BadgeCheckIcon />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <BellIcon />
          Notifications
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <PaletteIcon />
          Theme
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={() => setTheme('light')}>
            <SunIcon />
            Light
            {theme === 'light' && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme('dark')}>
            <MoonIcon />
            Dark
            {theme === 'dark' && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme('system')}>
            <MonitorIcon />
            System
            {theme === 'system' && <span className="ml-auto text-xs">✓</span>}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      {!onPortal && (
        <DropdownMenuItem onClick={() => navigate('/portal')}>
          <UserIcon />
          Switch to Portal
        </DropdownMenuItem>
      )}
      {!onDesk && canSeeDesk && (
        <DropdownMenuItem onClick={() => navigate('/desk')}>
          <HeadsetIcon />
          Switch to Service Desk
        </DropdownMenuItem>
      )}
      {!onAdmin && canSeeAdmin && (
        <DropdownMenuItem onClick={() => navigate('/admin')}>
          <ArrowRightLeftIcon />
          Switch to Admin
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={handleSignOut}>
        <LogOutIcon />
        Log out
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
