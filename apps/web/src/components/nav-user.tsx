import { PersonAvatar } from '@/components/person-avatar';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { ChevronsUpDownIcon } from 'lucide-react';
import { useAuth } from '@/providers/auth-provider';
import { UserMenuContent } from '@/components/user-menu-content';

export function NavUser() {
  const { isMobile } = useSidebar();
  const { user, person } = useAuth();

  const displayName = person ? `${person.first_name} ${person.last_name}` : user?.email ?? 'User';
  const displayEmail = user?.email ?? '';
  const avatarPerson = person
    ? { first_name: person.first_name, last_name: person.last_name, email: user?.email }
    : { email: user?.email };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="md:h-8 md:p-0 data-open:bg-sidebar-accent data-open:text-sidebar-accent-foreground"
              />
            }
          >
            <PersonAvatar person={avatarPerson} alt={displayName} className="rounded-lg" />
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              <span className="truncate text-xs">{displayEmail}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <UserMenuContent side={isMobile ? 'bottom' : 'right'} align="end" />
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
