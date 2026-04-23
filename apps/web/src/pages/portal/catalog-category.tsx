import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ArrowLeft, Plus, FolderOpen, ChevronRight } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/lib/api';
import { usePortal } from '@/providers/portal-provider';
import { useApi } from '@/hooks/use-api';

interface CatalogRequestType {
  id: string;
  name: string;
  description: string | null;
}

interface CatalogCategory {
  id: string;
  name: string;
  icon: string | null;
  parent_category_id: string | null;
  request_types: CatalogRequestType[];
}

interface PortalCatalogResponse {
  selected_location: { id: string; name: string; type: string };
  categories: CatalogCategory[];
}

interface DbCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  parent_category_id: string | null;
}

export function CatalogCategoryPage() {
  const navigate = useNavigate();
  const { categoryId } = useParams();
  const { data: portal } = usePortal();
  const { data: dbCategories } = useApi<DbCategory[]>('/service-catalog/categories', []);

  const currentLocation = portal?.current_location ?? null;
  const [catalog, setCatalog] = useState<PortalCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!currentLocation) return;
    setLoading(true);
    apiFetch<PortalCatalogResponse>(`/portal/catalog?location_id=${encodeURIComponent(currentLocation.id)}`)
      .then(setCatalog)
      .catch(() => setCatalog(null))
      .finally(() => setLoading(false));
  }, [currentLocation?.id]);

  const { category, directItems, subcategories } = useMemo(() => {
    if (!catalog || !categoryId || !dbCategories) {
      return { category: null, directItems: [] as CatalogRequestType[], subcategories: [] as DbCategory[] };
    }
    const visibleIds = new Set(catalog.categories.map((c) => c.id));
    const cat = catalog.categories.find((c) => c.id === categoryId) ?? null;
    const meta = dbCategories.find((c) => c.id === categoryId) ?? null;
    const children = dbCategories
      .filter((c) => c.parent_category_id === categoryId && visibleIds.has(c.id));
    return {
      category: cat ? { ...cat, description: meta?.description ?? null } : null,
      directItems: cat?.request_types ?? [],
      subcategories: children,
    };
  }, [catalog, dbCategories, categoryId]);

  const parentCategory = useMemo(() => {
    if (!category?.parent_category_id || !dbCategories) return null;
    return dbCategories.find((c) => c.id === category.parent_category_id) ?? null;
  }, [category, dbCategories]);

  const nothingToShow = !loading && subcategories.length === 0 && directItems.length === 0;

  return (
    <div>
      <Button
        variant="ghost"
        className="mb-4 -ml-2"
        onClick={() => navigate(parentCategory ? `/portal/catalog/${parentCategory.id}` : '/portal')}
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        {parentCategory ? `Back to ${parentCategory.name}` : 'Back to catalog'}
      </Button>

      <h1 className="text-2xl font-bold tracking-tight mb-2">{category?.name ?? 'Services'}</h1>
      <p className="text-muted-foreground mb-8">
        {currentLocation
          ? <>Showing services for <span className="font-medium">{currentLocation.name}</span></>
          : 'Select the type of request you\'d like to submit'}
      </p>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      )}

      {subcategories.length > 0 && (
        <>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">Subcategories</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {subcategories.map((sub) => (
              <Card
                key={sub.id}
                className="cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() => navigate(`/portal/catalog/${sub.id}`)}
              >
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <FolderOpen className="h-5 w-5 text-muted-foreground" />
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardTitle className="text-base mt-2">{sub.name}</CardTitle>
                  {sub.description && <CardDescription>{sub.description}</CardDescription>}
                </CardHeader>
              </Card>
            ))}
          </div>
        </>
      )}

      {directItems.length > 0 && (
        <>
          {subcategories.length > 0 && (
            <h2 className="text-sm font-medium text-muted-foreground mb-3">Services</h2>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {directItems.map((rt) => (
              <Card
                key={rt.id}
                className="cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() => navigate(`/portal/submit?type=${rt.id}`)}
              >
                <CardHeader>
                  <CardTitle className="text-base">{rt.name}</CardTitle>
                  <CardDescription>{rt.description ?? `Submit a ${rt.name.toLowerCase()} request`}</CardDescription>
                </CardHeader>
              </Card>
            ))}

            <Card
              className="cursor-pointer transition-colors hover:bg-accent/50 border-dashed"
              onClick={() => navigate(`/portal/submit`)}
            >
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Plus className="h-4 w-4" /> Other
                </CardTitle>
                <CardDescription>Can't find what you need? Submit a general request</CardDescription>
              </CardHeader>
            </Card>
          </div>
        </>
      )}

      {nothingToShow && (
        <div className="text-center py-12">
          <p className="text-muted-foreground mb-4">
            No services available in this category at your selected location.
          </p>
          <Button onClick={() => navigate(`/portal/submit`)}>
            <Plus className="h-4 w-4 mr-2" /> Submit a General Request
          </Button>
        </div>
      )}
    </div>
  );
}
