import { useMemo } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { UserMenuContent } from '@/components/user-menu-content';

export function PortalAccountMenu() {
  const { user, person } = useAuth();

  const { initials, displayName, avatarUrl } = useMemo(() => {
    const ini = person?.first_name
      ? `${person.first_name[0] ?? ''}${person.last_name?.[0] ?? ''}`.toUpperCase()
      : (user?.email?.[0] ?? 'U').toUpperCase();
    const name = person ? `${person.first_name} ${person.last_name}` : user?.email ?? 'User';
    return { initials: ini, displayName: name, avatarUrl: person?.avatar_url ?? null };
  }, [person, user?.email]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Account menu for ${displayName}`}
            className="size-8 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <Avatar className="size-8">
          {avatarUrl && <AvatarImage src={avatarUrl} alt="" loading="lazy" />}
          <AvatarFallback className="bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-pink-500 text-white text-xs font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <UserMenuContent side="bottom" align="end" />
    </DropdownMenu>
  );
}
