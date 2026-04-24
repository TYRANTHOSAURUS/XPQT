import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { ArrowRightLeft, LogOut, User } from 'lucide-react';

export function PortalAccountMenu() {
  const navigate = useNavigate();
  const { user, person, signOut, hasRole } = useAuth();

  const showSwitchLink = hasRole('agent') || hasRole('admin');
  const initials = person?.first_name
    ? `${person.first_name[0] ?? ''}${person.last_name?.[0] ?? ''}`.toUpperCase()
    : (user?.email?.[0] ?? 'U').toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Account menu"
            className="size-8 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <Avatar className="size-8">
          <AvatarFallback className="bg-gradient-to-br from-indigo-500 to-pink-500 text-white text-xs font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate text-sm font-medium">
            {person?.first_name} {person?.last_name}
          </div>
          <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/portal/account')}>
          <User className="mr-2 size-4" />
          Account
        </DropdownMenuItem>
        {showSwitchLink && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('/desk')}>
              <ArrowRightLeft className="mr-2 size-4" />
              Switch to Service Desk
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut className="mr-2 size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
