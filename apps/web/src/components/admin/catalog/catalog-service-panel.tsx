import { useEffect, useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, MousePointerClick } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { CatalogBasicsTab } from './catalog-basics-tab';
import { CatalogCoverageTab } from './catalog-coverage-tab';
import { CatalogAudienceTab } from './catalog-audience-tab';
import { CatalogFormTab } from './catalog-form-tab';
import { CatalogFulfillmentTab } from './catalog-fulfillment-tab';

export interface ServiceItemDetail {
  id: string;
  key: string;
  name: string;
  description: string | null;
  icon: string | null;
  search_terms: string[] | null;
  kb_link: string | null;
  disruption_banner: string | null;
  on_behalf_policy: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
  fulfillment_type_id: string;
  display_order: number;
  active: boolean;
  categories: Array<{ id: string; category_id: string; display_order: number }>;
  offerings: Array<{
    id: string;
    scope_kind: 'tenant' | 'space' | 'space_group';
    space_id: string | null;
    space_group_id: string | null;
    inherit_to_descendants: boolean;
    starts_at: string | null;
    ends_at: string | null;
    active: boolean;
  }>;
  criteria: Array<{
    id: string;
    criteria_set_id: string;
    mode: 'visible_allow' | 'visible_deny' | 'request_allow' | 'request_deny';
    active: boolean;
  }>;
  form_variants: Array<{
    id: string;
    criteria_set_id: string | null;
    form_schema_id: string;
    priority: number;
    active: boolean;
  }>;
  on_behalf_rules: Array<{ id: string; role: 'actor' | 'target'; criteria_set_id: string }>;
}

interface Props {
  requestTypeId: string | null;
  onSaved: () => void;
  onClose: () => void;
}

export function CatalogServicePanel({ requestTypeId, onSaved, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceItemDetail | null>(null);
  const [activeTab, setActiveTab] = useState('basics');

  useEffect(() => {
    if (!requestTypeId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    setError(null);
    setDetail(null);
    setActiveTab('basics');
    apiFetch<ServiceItemDetail>(`/admin/service-items/by-request-type/${requestTypeId}`)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [requestTypeId]);

  const reload = async () => {
    if (!detail) return;
    try {
      const fresh = await apiFetch<ServiceItemDetail>(`/admin/service-items/${detail.id}`);
      setDetail(fresh);
      onSaved();
    } catch {
      // toast already surfaced by child
    }
  };

  if (!requestTypeId) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <div className="flex flex-col items-center gap-2 max-w-xs text-center">
          <MousePointerClick className="size-5 opacity-50" />
          <p>Select a request type from the tree to view its configuration.</p>
        </div>
      </div>
    );
  }

  if (loading && !detail) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>Failed to load</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!detail) return null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold truncate">{detail.name}</h2>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <span className="font-mono truncate">{detail.key}</span>
            {!detail.active && <Badge variant="secondary" className="text-[10px]">Inactive</Badge>}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="basics">Basics</TabsTrigger>
          <TabsTrigger value="coverage">
            Coverage
            {detail.offerings.filter((o) => o.active).length > 0 && (
              <Badge variant="secondary" className="ml-2 text-[10px]">
                {detail.offerings.filter((o) => o.active).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="audience">
            Audience
            {detail.criteria.filter((c) => c.active).length > 0 && (
              <Badge variant="secondary" className="ml-2 text-[10px]">
                {detail.criteria.filter((c) => c.active).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="form">
            Form
            {detail.form_variants.filter((v) => v.active).length > 0 && (
              <Badge variant="secondary" className="ml-2 text-[10px]">
                {detail.form_variants.filter((v) => v.active).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="fulfillment">Fulfillment</TabsTrigger>
        </TabsList>

        <TabsContent value="basics" className="mt-4">
          <CatalogBasicsTab detail={detail} onSaved={reload} />
        </TabsContent>
        <TabsContent value="coverage" className="mt-4">
          <CatalogCoverageTab detail={detail} onSaved={reload} />
        </TabsContent>
        <TabsContent value="audience" className="mt-4">
          <CatalogAudienceTab detail={detail} onSaved={reload} />
        </TabsContent>
        <TabsContent value="form" className="mt-4">
          <CatalogFormTab detail={detail} onSaved={reload} />
        </TabsContent>
        <TabsContent value="fulfillment" className="mt-4">
          <CatalogFulfillmentTab detail={detail} onSaved={reload} requestTypeId={requestTypeId!} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
