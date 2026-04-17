import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { ArrowLeft, Plus } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { Spinner } from '@/components/ui/spinner';

interface RequestType {
  id: string;
  name: string;
  domain: string;
}

interface CatalogCategory {
  id: string;
  name: string;
  description: string;
}

export function CatalogCategoryPage() {
  const navigate = useNavigate();
  const { categoryId } = useParams();

  // Fetch category details
  const { data: categories } = useApi<CatalogCategory[]>('/service-catalog/categories', []);
  const category = categories?.find((c) => c.id === categoryId);

  // Fetch request types linked to this category
  const { data: requestTypes, loading } = useApi<RequestType[]>(
    categoryId ? `/service-catalog/categories/${categoryId}/request-types` : '',
    [categoryId],
  );

  return (
    <div>
      <Button variant="ghost" className="mb-4 -ml-2" onClick={() => navigate('/portal')}>
        <ArrowLeft className="h-4 w-4 mr-2" /> Back to catalog
      </Button>

      <h1 className="text-2xl font-bold tracking-tight mb-2">{category?.name ?? 'Services'}</h1>
      <p className="text-muted-foreground mb-8">Select the type of request you'd like to submit</p>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      )}

      {!loading && (!requestTypes || requestTypes.length === 0) && (
        <div className="text-center py-12">
          <p className="text-muted-foreground mb-4">No specific request types configured for this category yet.</p>
          <Button onClick={() => navigate(`/portal/submit`)}>
            <Plus className="h-4 w-4 mr-2" /> Submit a General Request
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {(requestTypes ?? []).map((rt) => (
          <Card
            key={rt.id}
            className="cursor-pointer transition-colors hover:bg-accent/50"
            onClick={() => navigate(`/portal/submit?type=${rt.id}`)}
          >
            <CardHeader>
              <CardTitle className="text-base">{rt.name}</CardTitle>
              <CardDescription>Submit a {rt.name.toLowerCase()} request</CardDescription>
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
    </div>
  );
}
