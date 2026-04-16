import { useNavigate } from 'react-router-dom';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Search,
  Wrench,
  Monitor,
  Users,
  CalendarDays,
  ShieldCheck,
  HelpCircle,
  Utensils,
  MapPin,
} from 'lucide-react';
import { useState } from 'react';

const categories = [
  { id: 'it', name: 'IT Support', description: 'Hardware, software, access, and account issues', icon: Monitor, color: 'text-blue-500' },
  { id: 'fm', name: 'Facilities', description: 'Maintenance, repairs, cleaning, and building issues', icon: Wrench, color: 'text-orange-500' },
  { id: 'workplace', name: 'Workplace Services', description: 'Room booking issues, parking, furniture, and moves', icon: MapPin, color: 'text-green-500' },
  { id: 'visitor', name: 'Visitors', description: 'Register a visitor, request access, and badges', icon: Users, color: 'text-purple-500' },
  { id: 'catering', name: 'Catering & Orders', description: 'Food, drinks, equipment, and supplies', icon: Utensils, color: 'text-pink-500' },
  { id: 'security', name: 'Access & Security', description: 'Keys, badges, access requests, and security incidents', icon: ShieldCheck, color: 'text-red-500' },
  { id: 'booking', name: 'Reservations', description: 'Book rooms, desks, and workspaces', icon: CalendarDays, color: 'text-teal-500' },
  { id: 'general', name: 'General', description: 'Questions, feedback, and other requests', icon: HelpCircle, color: 'text-gray-500' },
];

export function PortalHome() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');

  const filtered = searchQuery
    ? categories.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.description.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : categories;

  return (
    <div>
      {/* Hero */}
      <div className="text-center mb-10">
        <h1 className="text-3xl font-bold tracking-tight">How can we help you?</h1>
        <p className="text-muted-foreground mt-2">Submit a request, book a room, or find the service you need</p>

        <div className="relative max-w-lg mx-auto mt-6">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            placeholder="Search for a service..."
            className="pl-12 h-12 text-base"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {/* Service catalog grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {filtered.map((category) => (
          <Card
            key={category.id}
            className="cursor-pointer transition-colors hover:bg-accent/50"
            onClick={() => navigate(`/portal/catalog/${category.id}`)}
          >
            <CardHeader>
              <div className={`mb-2 ${category.color}`}>
                <category.icon className="h-6 w-6" />
              </div>
              <CardTitle className="text-base">{category.name}</CardTitle>
              <CardDescription>{category.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
