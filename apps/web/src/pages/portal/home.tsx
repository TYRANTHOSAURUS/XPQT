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
  Package,
  Printer,
  Key,
  Car,
} from 'lucide-react';
import { useState } from 'react';
import { useApi } from '@/hooks/use-api';

interface CatalogCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  display_order: number;
}

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  Monitor, Wrench, MapPin, Users, CalendarDays, ShieldCheck, HelpCircle,
  Utensils, Package, Printer, Key, Car,
};

const colorMap: Record<string, string> = {
  Monitor: 'text-blue-500',
  Wrench: 'text-orange-500',
  MapPin: 'text-green-500',
  Users: 'text-purple-500',
  Utensils: 'text-pink-500',
  ShieldCheck: 'text-red-500',
  CalendarDays: 'text-teal-500',
  HelpCircle: 'text-gray-500',
  Package: 'text-amber-500',
  Printer: 'text-cyan-500',
  Key: 'text-yellow-500',
  Car: 'text-emerald-500',
};

export function PortalHome() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const { data: dbCategories, loading } = useApi<CatalogCategory[]>('/service-catalog/categories', []);

  const categories = (dbCategories ?? []).map((cat) => ({
    ...cat,
    IconComponent: iconMap[cat.icon] ?? HelpCircle,
    color: colorMap[cat.icon] ?? 'text-gray-500',
  }));

  const filtered = searchQuery
    ? categories.filter((c) =>
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.description ?? '').toLowerCase().includes(searchQuery.toLowerCase())
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
      {loading && (
        <div className="text-center py-12 text-muted-foreground">Loading services...</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {filtered.map((category) => (
          <Card
            key={category.id}
            className="cursor-pointer transition-colors hover:bg-accent/50"
            onClick={() => navigate(`/portal/catalog/${category.id}`)}
          >
            <CardHeader>
              <div className={`mb-2 ${category.color}`}>
                <category.IconComponent className="h-6 w-6" />
              </div>
              <CardTitle className="text-base">{category.name}</CardTitle>
              <CardDescription>{category.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      {!loading && filtered.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          {searchQuery ? 'No services match your search' : 'No service categories configured yet'}
        </div>
      )}
    </div>
  );
}
