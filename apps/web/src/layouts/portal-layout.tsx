import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Home, Ticket, CalendarDays, UserPlus, ShoppingCart, Bell, Settings, LogOut } from 'lucide-react';

const navItems = [
  { label: 'Home', path: '/portal', icon: Home },
  { label: 'My Requests', path: '/portal/my-requests', icon: Ticket },
  { label: 'Book a Room', path: '/portal/book', icon: CalendarDays },
  { label: 'Invite Visitor', path: '/portal/visitors', icon: UserPlus },
  { label: 'Order', path: '/portal/order', icon: ShoppingCart },
];

export function PortalLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-6 flex h-16 items-center gap-8">
          {/* Logo */}
          <button onClick={() => navigate('/portal')} className="flex items-center gap-3 shrink-0">
            <img src="/assets/prequest-icon-color.svg" alt="Prequest" className="h-8 w-8" />
            <span className="text-lg font-semibold">Prequest</span>
          </button>

          {/* Nav */}
          <nav className="flex items-center gap-1">
            {navItems.map((item) => {
              const isActive = item.path === '/portal'
                ? location.pathname === '/portal'
                : location.pathname.startsWith(item.path);
              return (
                <Button
                  key={item.path}
                  variant={isActive ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => navigate(item.path)}
                  className="gap-2"
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Button>
              );
            })}
          </nav>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-3">
            <Button variant="ghost" size="icon" className="relative">
              <Bell className="h-4 w-4" />
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" className="rounded-full" />}
              >
                <Avatar className="h-8 w-8">
                  <AvatarFallback>JD</AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => navigate('/portal/my-requests')}>
                  <Ticket className="h-4 w-4 mr-2" /> My Requests
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Settings className="h-4 w-4 mr-2" /> Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <LogOut className="h-4 w-4 mr-2" /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
