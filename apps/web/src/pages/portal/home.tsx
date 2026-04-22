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
  FolderOpen,
  ChevronRight,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { usePortal } from '@/providers/portal-provider';

interface CatalogCategory {
  id: string;
  name: string;
  description: string;
  icon: string;
  display_order: number;
  parent_category_id: string | null;
}

interface CatalogServiceItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  search_terms: string[] | null;
}

interface CatalogCategoryV2 {
  id: string;
  name: string;
  icon: string | null;
  parent_category_id: string | null;
  service_items: CatalogServiceItem[];
}

interface PortalCatalogResponse {
  selected_location: { id: string; name: string; type: string };
  categories: CatalogCategoryV2[];
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
  const { data: portal } = usePortal();
  const currentLocation = portal?.current_location ?? null;

  const [catalog, setCatalog] = useState<PortalCatalogResponse | null>(null);
  useEffect(() => {
    if (!currentLocation) { setCatalog(null); return; }
    apiFetch<PortalCatalogResponse>(`/portal/catalog?location_id=${encodeURIComponent(currentLocation.id)}`)
      .then(setCatalog)
      .catch(() => setCatalog(null));
  }, [currentLocation?.id]);

  // Roll visibility up so a parent with only-child items stays visible.
  const visibleCategoryIds = useMemo(() => {
    if (!catalog) return null;
    const byId = new Map(catalog.categories.map((c) => [c.id, c]));
    const visible = new Set<string>();
    const walkUp = (id: string) => {
      let cur: string | null | undefined = id;
      while (cur) {
        if (visible.has(cur)) return;
        visible.add(cur);
        cur = byId.get(cur)?.parent_category_id ?? null;
      }
    };
    for (const c of catalog.categories) walkUp(c.id);
    return visible;
  }, [catalog]);

  const topLevelCategories = useMemo(() => {
    const source = (dbCategories ?? [])
      .filter((c) => !c.parent_category_id)
      .map((cat) => ({
        ...cat,
        IconComponent: iconMap[cat.icon] ?? HelpCircle,
        color: colorMap[cat.icon] ?? 'text-gray-500',
      }));
    if (!visibleCategoryIds) return source;
    return source.filter((c) => visibleCategoryIds.has(c.id));
  }, [dbCategories, visibleCategoryIds]);

  const trimmedQuery = searchQuery.trim().toLowerCase();

  // Search across the full tree + all visible service items, so results
  // include deeply-nested categories and individual leaf services.
  const searchResults = useMemo(() => {
    if (!trimmedQuery) return null;
    const q = trimmedQuery;

    const matchesText = (...fields: Array<string | null | undefined>) =>
      fields.some((f) => (f ?? '').toLowerCase().includes(q));

    const matchedCategories = (dbCategories ?? [])
      .filter((c) => !visibleCategoryIds || visibleCategoryIds.has(c.id))
      .filter((c) => matchesText(c.name, c.description))
      .map((c) => ({
        ...c,
        IconComponent: iconMap[c.icon] ?? FolderOpen,
        color: colorMap[c.icon] ?? 'text-gray-500',
      }));

    type ServiceHit = CatalogServiceItem & { categoryName: string | null };
    const matchedServices: ServiceHit[] = [];
    const seen = new Set<string>();
    for (const cat of catalog?.categories ?? []) {
      for (const item of cat.service_items) {
        if (seen.has(item.id)) continue;
        const terms = (item.search_terms ?? []).join(' ');
        if (matchesText(item.name, item.description, item.key, terms)) {
          seen.add(item.id);
          matchedServices.push({ ...item, categoryName: cat.name });
        }
      }
    }

    return { categories: matchedCategories, services: matchedServices };
  }, [trimmedQuery, dbCategories, catalog, visibleCategoryIds]);

  return (
    <div>
      {/* Hero */}
      <div className="text-center mb-10">
        <h1 className="text-3xl font-bold tracking-tight">How can we help you?</h1>
        <p className="text-muted-foreground mt-2">Submit a request, book a room, or find the service you need</p>

        <div className="relative max-w-lg mx-auto mt-6">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
          <Input
            placeholder="Search services, categories, or keywords..."
            className="pl-12 h-12 text-base"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {loading && (
        <div className="text-center py-12 text-muted-foreground">Loading services...</div>
      )}

      {/* Default view: top-level categories */}
      {!searchResults && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {topLevelCategories.map((category) => (
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

          {!loading && topLevelCategories.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              No service categories configured yet
            </div>
          )}
        </>
      )}

      {/* Search results: flat list of matching categories + services */}
      {searchResults && (
        <>
          {searchResults.categories.length > 0 && (
            <div className="mb-8">
              <h2 className="text-sm font-medium text-muted-foreground mb-3">Categories</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {searchResults.categories.map((c) => (
                  <Card
                    key={c.id}
                    className="cursor-pointer transition-colors hover:bg-accent/50"
                    onClick={() => navigate(`/portal/catalog/${c.id}`)}
                  >
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div className={c.color}>
                          <c.IconComponent className="h-5 w-5" />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <CardTitle className="text-base mt-2">{c.name}</CardTitle>
                      {c.description && <CardDescription>{c.description}</CardDescription>}
                    </CardHeader>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {searchResults.services.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-3">Services</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {searchResults.services.map((s) => (
                  <Card
                    key={s.id}
                    className="cursor-pointer transition-colors hover:bg-accent/50"
                    onClick={() => navigate(`/portal/submit?type=${s.id}`)}
                  >
                    <CardHeader>
                      <CardTitle className="text-base">{s.name}</CardTitle>
                      <CardDescription>
                        {s.description ?? `Submit a ${s.name.toLowerCase()} request`}
                        {s.categoryName && (
                          <span className="block mt-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                            in {s.categoryName}
                          </span>
                        )}
                      </CardDescription>
                    </CardHeader>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {searchResults.categories.length === 0 && searchResults.services.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              No services or categories match "{searchQuery}"
            </div>
          )}
        </>
      )}
    </div>
  );
}
